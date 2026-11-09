// JSON API, mounted at /api. The webhooks and the bookmarklet session are mounted earlier, in server.js, for their own reasons.
import cors from 'cors';
import crypto, { createHash } from 'crypto';
import express from 'express';
import mongoose from 'mongoose';
import { Resend } from 'resend';
import Stripe from 'stripe';
import { CASHOUT_MIN, CREDITS_PER_DOLLAR, PLATFORM_CUT_RATIO, TOPUP_PACKAGES } from '../config/config.js';
import Block from '../models/block.js';
import Bucket from '../models/bucket.js';
import BucketAccess from '../models/bucketAccess.js';
import BucketComment from '../models/bucketComment.js';
import BucketRating from '../models/bucketRating.js';
import BucketShare from '../models/bucketShare.js';
import BucketSkip from '../models/bucketSkip.js';
import BucketView from '../models/bucketView.js';
import CommentAgreement from '../models/commentAgreement.js';
import CommentReport from '../models/commentReport.js';
import Conversation from '../models/conversation.js';
import DirectMessage from '../models/directMessage.js';
import FaqItem, { FAQ_CATEGORY_LABELS } from '../models/faqItem.js';
import FeedImpression from '../models/feedImpression.js';
import Link from '../models/link.js';
import LinkClick from '../models/linkClick.js';
import Notification from '../models/notification.js';
import PartnerApplication from '../models/partnerApplication.js';
import RegisteredLink from '../models/registeredLink.js';
import Report from '../models/report.js';
import Repository from '../models/repository.js';
import RepoSkip from '../models/repoSkip.js';
import Subscription from '../models/subscription.js';
import TopicScore from '../models/topicScore.js';
import Transaction from '../models/transaction.js';
import User from '../models/user.js';
import UserDocument from '../models/userDocument.js';
import UserRepo from '../models/userRepo.js';
import { anonymousAuth, requireAuth, requireVerification } from '../middleware/anonymousAuth.js';
import { maybeSendNotificationEmail, sendAccountDeletedEmail, sendAccountDeletionEmail, sendAccountSuspendedEmail, sendDataExportEmail, sendOtpEmail, sendPasswordResetEmail } from '../services/email.js';
import { fetchBucketSnapshot, parseAndResolveEntities } from '../services/entityParser.js';
import { FILTER_PUBLIC } from '../services/filters.js';
import { deleteR2Images, fetchAndStoreImage, uploadFileToR2, uploadImageToR2 } from '../services/r2.js';
import { validateLinks } from '../services/urlSafety.js';
import { pushNotification, wsClients } from '../services/ws.js';
import { bucketVisibility, enrichReposWithBucketThumbnails, trackBucketView } from '../services/buckets.js';
import { awardTopupCredits, getAccountTier, utcDateString } from '../services/credits.js';
import { ALLOWED_LINK_IMG_MIME, domainMatches, extractOG, fetchSheinProduct, fetchViaScraperAPI, hostnameFromUrl, isCloudflareChallengeHtml, isGenericTitle, needsRender, normalizeMetaUrl, resolveBestImage, resolveUrl, sheinTitleOnlyMeta, slugTitleFromUrl } from '../services/linkMeta.js';
import { _categoriesJson } from '../services/categories.js';

const router = express.Router();

// =============================================================================
// Bookmarklet session, mounted before the global CORS middleware
// =============================================================================

// Registered ahead of CORS so any origin can call it: the bookmarklet runs on arbitrary third-party sites.
export const popupSessionRouter = express.Router();

const popupSessions = new Map();

popupSessionRouter.options('/popup-session', cors({ origin: '*' }));

popupSessionRouter.post('/popup-session',
    cors({ origin: '*', methods: ['POST', 'OPTIONS'] }),
    express.json({ limit: '2mb' }),
    async (req, res) => {
        const { links, sourceUrl, maxPage, currentPage, pagesCollected, anon } = req.body;
        if (!Array.isArray(links)) {
            return res.status(400).json({ error: 'links is required' });
        }

        const token =
            Math.random().toString(36).slice(2, 10) +
            Math.random().toString(36).slice(2, 10);
        popupSessions.set(token, {
            links: links.slice(0, 2000),
            sourceUrl: String(sourceUrl || '').slice(0, 2000),
            maxPage: Math.min(Math.max(Number(maxPage) || 1, 1), 50), // cap at 50
            currentPage: Math.max(Number(currentPage) || 1, 1),
            pagesCollected: Math.max(Number(pagesCollected) || 1, 1),
            createdAt: Date.now(),
            anonymousId: typeof anon === 'string' && anon.length > 0 ? anon : null,
        });
        setTimeout(() => popupSessions.delete(token), 600_000); // 10-min TTL
        res.json({ token });
    }
);

popupSessionRouter.get('/popup-session', (req, res) => {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).json({ error: 'token required' });
    const session = popupSessions.get(token);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });
    popupSessions.delete(token); // one-time use
    res.json(session);
});

// =============================================================================
// Auth, mounted at /api/auth
// =============================================================================

const authRouter = express.Router();

// ── Multi-account helpers ─────────────────────────────────────────────────────

const ACCTS_KEY   = '_accts';
const ADDING_KEY  = '_adding';
const MAX_ACCOUNTS = 5;

function getLinkedIds(req) {
    const raw = req.cookies?.[ACCTS_KEY] || '';
    return raw ? raw.split(',').filter(Boolean) : [];
}

function setLinkedCookie(res, ids) {
    if (!ids.length) {
        res.clearCookie(ACCTS_KEY);
    } else {
        res.cookie(ACCTS_KEY, ids.join(','), {
            maxAge: 30 * 24 * 60 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax',
        });
    }
}

// ========== VALIDATION HELPERS ==========

function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function validateUsername(username) {
    if (!username || typeof username !== 'string') {
        return { valid: false, message: 'Username is required' };
    }
    
    const trimmed = username.trim();
    
    if (trimmed.length < 2 || trimmed.length > 26) {
        return { valid: false, message: 'Username must be between 2 and 26 characters' };
    }
    
    // Only alphanumeric characters
    const usernameRegex = /^[a-zA-Z0-9]+$/;
    if (!usernameRegex.test(trimmed)) {
        return { valid: false, message: 'Username can only contain letters and numbers (no special characters)' };
    }
    
    return { valid: true, username: trimmed };
}

function validatePassword(password) {
    if (!password || typeof password !== 'string') {
        return { valid: false, message: 'Password is required' };
    }
    
    // Check minimum length
    if (password.length < 8) {
        return { valid: false, message: 'Password must be at least 8 characters long' };
    }
    
    // Count character types
    const lowercaseCount = (password.match(/[a-z]/g) || []).length;
    const uppercaseCount = (password.match(/[A-Z]/g) || []).length;
    const digitCount = (password.match(/[0-9]/g) || []).length;
    const specialCharCount = (password.match(/[^a-zA-Z0-9]/g) || []).length;
    
    // Check requirements
    if (lowercaseCount < 2) {
        return { valid: false, message: 'Password must contain at least 2 lowercase letters' };
    }
    
    if (uppercaseCount < 2) {
        return { valid: false, message: 'Password must contain at least 2 uppercase letters' };
    }
    
    if (digitCount < 2) {
        return { valid: false, message: 'Password must contain at least 2 digits' };
    }
    
    if (specialCharCount < 2) {
        return { valid: false, message: 'Password must contain at least 2 special characters' };
    }
    
    return { valid: true };
}

// ========== ROLE HELPERS ==========

function buildRoleFilter(isAdmin) {
    return isAdmin ? { role: { $in: ['moderator', 'superadmin'] } } : { role: 'user' };
}

// ========== OTP HELPER ==========

async function generateAndSendOtp(user) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedCode = crypto.createHash('sha256').update(code).digest('hex');
    user.otpCode = hashedCode;
    user.otpExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
    user.otpSentAt = new Date();
    await user.save();
    await sendOtpEmail(user.email, code);
}

// ========== EMAIL VERIFICATION GATE ==========

const TWO_HOURS_MS   = 2  * 60 * 60 * 1000;
const SEVENTY_HRS_MS = 70 * 60 * 60 * 1000;

// Returns true if a 403 response was sent (caller should return early).
// Deletes the account if 70h suspension window has expired.
async function applyVerificationGate(user, res) {
    if (user.isEmailVerified) return false;

    const now = Date.now();

    if (user.accountSuspendedAt) {
        if (now - user.accountSuspendedAt.getTime() > SEVENTY_HRS_MS) {
            // Account has expired — delete and notify
            const email = user.email;
            await Bucket.deleteMany({ userId: user._id });
            await User.findByIdAndDelete(user._id);
            await sendAccountDeletedEmail(email);
            res.clearCookie('anonymousId');
            return res.status(403).json({
                code: 'ACCOUNT_DELETED',
                error: 'Your account has been permanently deleted because your email was not verified. Please sign up again.'
            }), true;
        }
        // Still within 70h — account is suspended but not yet deleted
        return res.status(403).json({
            code: 'ACCOUNT_SUSPENDED',
            email: user.email,
            error: 'Your account is suspended. Please verify your email address to regain access.'
        }), true;
    }

    // Check if 2h grace period has elapsed since account creation
    if (now - new Date(user.createdAt).getTime() > TWO_HOURS_MS) {
        user.accountSuspendedAt = new Date();
        await user.save();
        await sendAccountSuspendedEmail(user.email);
        return res.status(403).json({
            code: 'ACCOUNT_SUSPENDED',
            email: user.email,
            error: 'Your account has been suspended because your email was not verified within 2 hours. You have 70 hours to verify before your account is deleted.'
        }), true;
    }

    // Within 2h grace period
    return res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        email: user.email,
        error: 'Please verify your email to continue. Check your inbox for the verification code sent at signup.'
    }), true;
}

// ========== GOOGLE OAUTH HELPERS ==========

async function generateGoogleUsername(email, name) {
    let base = (email.split('@')[0] || name || 'user')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 20);
    if (base.length < 2) base = 'user' + base;
    let candidate = base;
    while (await User.findOne({ username: candidate })) {
        candidate = base.slice(0, 16) + Math.floor(1000 + Math.random() * 9000);
    }
    return candidate;
}

function getBaseUrl(req) {
    return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// ========== ROUTES ==========

// Initiate Google OAuth
authRouter.get('/google', (req, res) => {
    if (req.user && !req.user.isAnonymous) {
        return res.redirect('/');
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
        return res.redirect('/login?error=google_not_configured');
    }

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('_goauth_state', state, {
        maxAge: 10 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax'
    });

    const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: `${getBaseUrl(req)}/api/auth/google/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'online',
        prompt: 'select_account'
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Google OAuth callback
authRouter.get('/google/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error || !code || !state) {
        return res.redirect('/login?error=google_cancelled');
    }

    const savedState = req.cookies._goauth_state;
    res.clearCookie('_goauth_state');
    if (!savedState || savedState !== state) {
        return res.redirect('/login?error=google_failed');
    }

    try {
        const redirectUri = `${getBaseUrl(req)}/api/auth/google/callback`;

        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            console.error('Google token exchange failed:', tokenData);
            return res.redirect('/login?error=google_failed');
        }

        // Get profile
        const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const profile = await profileRes.json();
        const { id: googleId, email, name, given_name, picture } = profile;

        if (!googleId || !email) {
            return res.redirect('/login?error=google_failed');
        }

        const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

        const setCookieAndRedirect = (user) => {
            res.cookie('anonymousId', user.anonymousId, {
                maxAge: 30 * 24 * 60 * 60 * 1000,
                httpOnly: true,
                sameSite: 'lax'
            });
            res.redirect('/showroom');
        };

        const reactivateIfNeeded = async (user) => {
            if (!user.deletedAt) return true;
            if (Date.now() - user.deletedAt.getTime() > NINETY_DAYS_MS) {
                return res.redirect('/login?error=account_closed'), false;
            }
            await User.updateOne({ _id: user._id }, { $unset: { deletedAt: '' } });
            return true;
        };

        // Case 1: existing Google account
        const existingGoogle = await User.findOne({ googleId });
        if (existingGoogle) {
            if (!await reactivateIfNeeded(existingGoogle)) return;
            return setCookieAndRedirect(existingGoogle);
        }

        // Case 2: email matches an existing standard user account → link (Google OAuth is standard-only)
        const existingEmail = await User.findOne({ email: email.toLowerCase(), isAnonymous: false, role: 'user' });
        if (existingEmail) {
            if (!await reactivateIfNeeded(existingEmail)) return;
            existingEmail.googleId = googleId;
            await existingEmail.save();
            return setCookieAndRedirect(existingEmail);
        }

        // Case 3: convert the current anonymous session
        if (req.user && req.user.isAnonymous) {
            const username = await generateGoogleUsername(email, given_name || name);
            req.user.email = email.toLowerCase();
            req.user.username = username;
            req.user.googleId = googleId;
            req.user.isAnonymous = false;
            req.user.isEmailVerified = true;
            if (picture) req.user.avatar = picture;
            if (name) req.user.displayName = name.slice(0, 30);
            await req.user.save();
            return setCookieAndRedirect(req.user);
        }

        // Case 4: no anonymous session (rare) — create a fresh user
        const username = await generateGoogleUsername(email, given_name || name);
        const newUser = new User({
            anonymousId: crypto.randomUUID(),
            email: email.toLowerCase(),
            username,
            googleId,
            isAnonymous: false,
            isEmailVerified: true,
            displayName: name ? name.slice(0, 30) : '',
            avatar: picture || ''
        });
        await newUser.save();
        return setCookieAndRedirect(newUser);

    } catch (err) {
        console.error('Google OAuth callback error:', err);
        res.redirect('/login?error=google_failed');
    }
});

// Signup - Convert anonymous user or create new registered user
authRouter.post('/signup', async (req, res) => {
    try {
        const { email, password, username, newsletter } = req.body;

        // Validation
        if (!email || !password || !username) {
            return res.status(400).json({ error: 'Email, username, and password are required' });
        }

        // Email format validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Username validation (2-26 chars, alphanumeric only)
        if (username.length < 2 || username.length > 26) {
            return res.status(400).json({ error: 'Username must be between 2 and 26 characters' });
        }
        const usernameRegex = /^[a-zA-Z0-9]+$/;
        if (!usernameRegex.test(username)) {
            return res.status(400).json({ error: 'Username can only contain letters and numbers' });
        }

        // Password strength validation
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const lowercaseCount = (password.match(/[a-z]/g) || []).length;
        const uppercaseCount = (password.match(/[A-Z]/g) || []).length;
        const digitCount = (password.match(/[0-9]/g) || []).length;
        const specialCharCount = (password.match(/[^a-zA-Z0-9]/g) || []).length;

        if (lowercaseCount < 2) {
            return res.status(400).json({ error: 'Password must contain at least 2 lowercase letters' });
        }
        if (uppercaseCount < 2) {
            return res.status(400).json({ error: 'Password must contain at least 2 uppercase letters' });
        }
        if (digitCount < 2) {
            return res.status(400).json({ error: 'Password must contain at least 2 digits' });
        }
        if (specialCharCount < 2) {
            return res.status(400).json({ error: 'Password must contain at least 2 special characters' });
        }

        // Check if email already exists among standard users (admins share a separate namespace)
        const existingEmailUser = await User.findOne({ email: email.toLowerCase(), role: 'user' });
        if (existingEmailUser && !existingEmailUser.isAnonymous) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        // Check if username already exists
        const existingUsernameUser = await User.findOne({ username });
        if (existingUsernameUser && !existingUsernameUser.isAnonymous) {
            return res.status(409).json({ error: 'Username already taken' });
        }

        let user;

        // Check if user has an anonymous session
        if (req.user && req.user.isAnonymous) {
            console.log('Converting anonymous user:', req.user.anonymousId);

            if (newsletter === true) {
                req.user.newsletterSubscribed = true;
            }

            // Convert the current anonymous user to registered
            user = await req.user.convertToRegistered(
                email.toLowerCase(),
                password,
                username
            );
            
            console.log('User converted:', user.email, 'isAnonymous:', user.isAnonymous);
            
            // Refresh cookie with longer expiry
            res.cookie('anonymousId', user.anonymousId, {
                maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
                httpOnly: true,
                sameSite: 'lax',
                // secure: true // Enable in production with HTTPS
            });
        } else {
            // No anonymous session found - this shouldn't happen in your app
            console.warn('No anonymous session found during signup');
            return res.status(400).json({ 
                error: 'No session found. Please refresh the page and try again.' 
            });
        }

        // Generate OTP and send email
        await generateAndSendOtp(user);

        res.status(201).json({ requiresOtp: true, email: user.email });
    } catch (error) {
        console.error('Signup error:', error);
        
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            if (field === 'email') {
                return res.status(409).json({ error: 'Email already registered' });
            } else if (field === 'username') {
                return res.status(409).json({ error: 'Username already taken' });
            }
        }
        
        res.status(500).json({ error: 'Signup failed. Please try again.' });
    }
});

// Login
authRouter.post('/login', async (req, res) => {
    try {
        const { email, password, isAdmin = false } = req.body;

        // Validation
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        if (!validateEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Find user by email within the correct role namespace
        const user = await User.findOne({ email: email.toLowerCase(), ...buildRoleFilter(isAdmin) }).select('+password');

        if (!user) {
            return res.status(401).json({ error: "Invalid email or password. Can't log in? Try resetting your password or signing up." });
        }

        // Check if account is anonymous (shouldn't have password)
        if (user.isAnonymous) {
            return res.status(401).json({ error: 'Account not registered. Please sign up first.' });
        }

        // Block Google-only accounts from password login
        if (!user.password) {
            return res.status(401).json({ error: 'This account uses Google sign-in. Please use "Continue with Google" to log in.' });
        }

        // Verify password
        const isPasswordValid = await user.comparePassword(password);

        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Reactivate account if within 90-day deletion window
        if (user.deletedAt) {
            const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
            if (Date.now() - user.deletedAt.getTime() > NINETY_DAYS_MS) {
                return res.status(403).json({
                    code: 'ACCOUNT_CLOSED',
                    error: 'This account has been permanently closed. You can sign up again with a new account.'
                });
            }
            await User.updateOne({ _id: user._id }, { $unset: { deletedAt: '' } });
            user.deletedAt = null;
        }

        // Block unverified accounts — applies suspension/deletion logic lazily
        if (await applyVerificationGate(user, res)) return;

        // Generate OTP and send email
        await generateAndSendOtp(user);

        res.json({ requiresOtp: true, email: user.email });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// Verify OTP (completes login or signup)
authRouter.post('/verify-otp', async (req, res) => {
    try {
        const { email, code, isAdmin = false } = req.body;

        if (!email || !code) {
            return res.status(400).json({ error: 'Email and code are required' });
        }

        if (!/^\d{6}$/.test(code)) {
            return res.status(400).json({ error: 'Code must be 6 digits' });
        }

        const hashedCode = crypto.createHash('sha256').update(code).digest('hex');

        const user = await User.findOne({
            email: email.toLowerCase(),
            isAnonymous: false,
            otpCode: hashedCode,
            otpExpires: { $gt: Date.now() },
            ...buildRoleFilter(isAdmin),
        }).select('+otpCode +otpExpires +otpSentAt');

        if (!user) {
            return res.status(400).json({ error: 'Invalid or expired code. Please try again.' });
        }

        // Clear OTP fields and mark email as verified
        user.otpCode = undefined;
        user.otpExpires = undefined;
        user.otpSentAt = undefined;
        user.isEmailVerified = true;
        await user.save();

        // Handle add-account flow: carry forward the previous session into _accts
        const addingId = req.cookies?.[ADDING_KEY];
        if (addingId && addingId !== user.anonymousId) {
            const existing = getLinkedIds(req);
            const merged = [...new Set([addingId, ...existing])].slice(0, MAX_ACCOUNTS - 1);
            setLinkedCookie(res, merged);
            res.clearCookie(ADDING_KEY);
        }

        // Set session cookie
        res.cookie('anonymousId', user.anonymousId, {
            maxAge: 30 * 24 * 60 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax',
            // secure: true // Enable in production with HTTPS
        });

        res.json({
            success: true,
            anonymousId: user.anonymousId,
            addedAccount: !!(addingId && addingId !== user.anonymousId),
            user: {
                id: user._id,
                email: user.email,
                username: user.username,
                isAnonymous: false,
                scrapingLimit: user.scrapingLimit
            }
        });
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
});

// Resend OTP
authRouter.post('/resend-otp', async (req, res) => {
    try {
        const { email, isAdmin = false } = req.body;

        if (!email || !validateEmail(email)) {
            return res.status(400).json({ error: 'A valid email is required' });
        }

        const user = await User.findOne({ email: email.toLowerCase(), isAnonymous: false, ...buildRoleFilter(isAdmin) })
            .select('+otpSentAt');

        // Always return success to prevent email enumeration
        if (!user) {
            return res.json({ success: true });
        }

        // Rate limit: 60 seconds between resends
        if (user.otpSentAt && Date.now() - user.otpSentAt.getTime() < 60 * 1000) {
            const secondsLeft = Math.ceil((60 * 1000 - (Date.now() - user.otpSentAt.getTime())) / 1000);
            return res.status(429).json({ error: `Please wait ${secondsLeft}s before resending` });
        }

        await generateAndSendOtp(user);

        res.json({ success: true });
    } catch (error) {
        console.error('Resend OTP error:', error);
        res.status(500).json({ error: 'Failed to resend code. Please try again.' });
    }
});

// Logout
authRouter.post('/logout', requireAuth, (req, res) => {
    try {
        const linked = getLinkedIds(req);
        if (linked.length) {
            // Switch to the next linked account instead of dropping to anonymous
            const [next, ...rest] = linked;
            res.cookie('anonymousId', next, {
                maxAge: 30 * 24 * 60 * 60 * 1000,
                httpOnly: true,
                sameSite: 'lax',
            });
            setLinkedCookie(res, rest);
            return res.json({ success: true, switched: true });
        }

        res.clearCookie('anonymousId');
        res.json({ success: true, switched: false });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Logout failed' });
    }
});

// Check authentication status
authRouter.get('/status', async (req, res) => {
    try {
        if (!req.user) {
            return res.json({
                authenticated: false,
                isAnonymous: true
            });
        }

        res.json({
            authenticated: !req.user.isAnonymous,
            isAnonymous: req.user.isAnonymous,
            user: req.user.isAnonymous ? null : {
                id: req.user._id,
                email: req.user.email,
                username: req.user.username,
                scrapingLimit: req.user.scrapingLimit,
                isEmailVerified: req.user.isEmailVerified,
                accountSuspendedAt: req.user.accountSuspendedAt,
                createdAt: req.user.createdAt
            }
        });
    } catch (error) {
        console.error('Auth status check error:', error);
        res.status(500).json({ error: 'Failed to check authentication status' });
    }
});

// Forgot password - send reset email
authRouter.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email || !validateEmail(email)) {
            return res.status(400).json({ error: 'A valid email address is required' });
        }

        // Always return success to prevent email enumeration
        const successMsg = 'If an account with that email exists, a reset link has been sent.';

        const { isAdmin = false } = req.body;
        const user = await User.findOne({ email: email.toLowerCase(), isAnonymous: false, ...buildRoleFilter(isAdmin) });
        if (!user) {
            return res.json({ success: true, message: successMsg });
        }

        // Generate token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

        user.resetPasswordToken = hashedToken;
        user.resetPasswordExpires = Date.now() + 60 * 60 * 1000; // 1 hour
        await user.save();

        // Build reset URL
        const protocol = req.protocol;
        const host = req.get('host');
        const resetUrl = `${protocol}://${host}/v2/reset-password?token=${rawToken}`;

        await sendPasswordResetEmail(user.email, resetUrl);

        res.json({ success: true, message: successMsg });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Something went wrong. Please try again later.' });
    }
});

// Reset password - validate token and update password
authRouter.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;

        if (!token || !password) {
            return res.status(400).json({ error: 'Token and new password are required' });
        }

        // Validate password strength
        const passwordCheck = validatePassword(password);
        if (!passwordCheck.valid) {
            return res.status(400).json({ error: passwordCheck.message });
        }

        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        const user = await User.findOne({
            resetPasswordToken: hashedToken,
            resetPasswordExpires: { $gt: Date.now() }
        }).select('+resetPasswordToken +resetPasswordExpires');

        if (!user) {
            return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
        }

        user.password = password; // Hashed by pre-save hook
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        user.passwordChangedAt = new Date();
        await user.save();

        res.json({ success: true, message: 'Password has been reset successfully.' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Something went wrong. Please try again later.' });
    }
});

// ── Multi-account management ─────────────────────────────────────────────────

// GET /api/auth/accounts — list all currently linked accounts
authRouter.get('/accounts', async (req, res) => {
    try {
        const activeId  = req.cookies?.anonymousId;
        const linkedIds = getLinkedIds(req);
        const allIds    = [...new Set([activeId, ...linkedIds].filter(Boolean))];

        if (!allIds.length) return res.json({ accounts: [] });

        const users = await User.find({ anonymousId: { $in: allIds }, isAnonymous: false })
            .select('anonymousId username displayName avatar');

        const accounts = allIds.map(id => {
            const u = users.find(u => u.anonymousId === id);
            if (!u) return null;
            return {
                anonymousId: id,
                username:    u.username,
                displayName: u.displayName || '',
                avatar:      u.avatar || '',
                isActive:    id === activeId,
            };
        }).filter(Boolean);

        res.json({ accounts });
    } catch (err) {
        console.error('List accounts error:', err);
        res.status(500).json({ error: 'Failed to load accounts' });
    }
});

// POST /api/auth/accounts/switch — make a linked account active
authRouter.post('/accounts/switch', async (req, res) => {
    try {
        const { anonymousId: targetId } = req.body;
        if (!targetId) return res.status(400).json({ error: 'anonymousId is required' });

        const activeId  = req.cookies?.anonymousId;
        const linkedIds = getLinkedIds(req);

        if (!linkedIds.includes(targetId)) {
            return res.status(400).json({ error: 'Account not in linked list' });
        }

        const target = await User.findOne({ anonymousId: targetId, isAnonymous: false });
        if (!target) return res.status(404).json({ error: 'Account not found' });

        const newLinked = linkedIds.filter(id => id !== targetId);
        if (activeId) newLinked.push(activeId);

        res.cookie('anonymousId', targetId, {
            maxAge: 30 * 24 * 60 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax',
        });
        setLinkedCookie(res, newLinked);

        res.json({ success: true });
    } catch (err) {
        console.error('Switch account error:', err);
        res.status(500).json({ error: 'Failed to switch account' });
    }
});

// DELETE /api/auth/accounts/remove — remove a non-active linked account
authRouter.delete('/accounts/remove', async (req, res) => {
    try {
        const { anonymousId: targetId } = req.body;
        if (!targetId) return res.status(400).json({ error: 'anonymousId is required' });

        const activeId  = req.cookies?.anonymousId;
        if (targetId === activeId) {
            return res.status(400).json({ error: 'Switch to another account before removing this one' });
        }

        const linkedIds = getLinkedIds(req);
        if (!linkedIds.includes(targetId)) {
            return res.status(400).json({ error: 'Account not in linked list' });
        }

        setLinkedCookie(res, linkedIds.filter(id => id !== targetId));
        res.json({ success: true });
    } catch (err) {
        console.error('Remove account error:', err);
        res.status(500).json({ error: 'Failed to remove account' });
    }
});

// POST /api/auth/accounts/begin-add — set up _adding cookie and return login URL
authRouter.post('/accounts/begin-add', requireAuth, (req, res) => {
    try {
        const activeId  = req.cookies?.anonymousId;
        const linkedIds = getLinkedIds(req);
        if (1 + linkedIds.length >= MAX_ACCOUNTS) {
            return res.status(400).json({ error: `You can have at most ${MAX_ACCOUNTS} accounts logged in at once` });
        }

        res.cookie(ADDING_KEY, activeId, {
            maxAge: 10 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax',
        });

        res.json({ url: '/login?addAccount=1' });
    } catch (err) {
        console.error('Begin add account error:', err);
        res.status(500).json({ error: 'Failed to start account add flow' });
    }
});

// Delete account — registered users only
authRouter.delete('/account', requireAuth, async (req, res) => {
    try {
        if (req.user.isAnonymous) {
            return res.status(403).json({ error: 'Anonymous accounts cannot be deleted.' });
        }

        const userId = req.user._id;

        // Delete all buckets belonging to this user
        await Bucket.deleteMany({ userId });

        // Delete the user document
        await User.findByIdAndDelete(userId);

        // Clear session cookie
        res.clearCookie('anonymousId');

        res.json({ success: true, message: 'Account deleted successfully.' });
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ error: 'Failed to delete account. Please try again.' });
    }
});

router.use('/auth', authRouter);

// =============================================================================
// Credits, mounted at /api/credits
// =============================================================================

const creditsRouter = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// GET /api/credits/balance
creditsRouter.get('/balance', requireAuth, async (req, res) => {
    try {
        res.json({ credits: req.user.credits ?? 0 });
    } catch (error) {
        console.error('Error fetching credits balance:', error);
        res.status(500).json({ error: 'Failed to fetch credits balance' });
    }
});

// GET /api/credits/verify?session_id=cs_xxx  — called on return from Stripe checkout
creditsRouter.get('/verify', requireAuth, async (req, res) => {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status !== 'paid') {
            return res.status(402).json({ error: 'Payment not completed' });
        }
        if (session.metadata?.userId !== req.user._id.toString()) {
            return res.status(403).json({ error: 'Session does not belong to this user' });
        }

        const credits = parseInt(session.metadata?.credits, 10);
        if (!credits || isNaN(credits)) {
            return res.status(400).json({ error: 'Invalid session metadata' });
        }

        try {
            await awardTopupCredits(req.user._id, credits, session.payment_intent);
        } catch (err) {
            if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
            throw err;
        }

        const user = await User.findById(req.user._id);
        res.json({ credits: user.credits ?? 0 });
    } catch (err) {
        console.error('Error verifying Stripe session:', err);
        res.status(500).json({ error: 'Failed to verify payment' });
    }
});

// POST /api/credits/topup
creditsRouter.post('/topup', requireAuth, async (req, res) => {
    try {
        if (req.user.isAnonymous) {
            return res.status(403).json({ error: 'Sign in to purchase credits' });
        }

        const { credits } = req.body;
        if (!Number.isInteger(credits) || credits < 800 || credits > 50000) {
            return res.status(400).json({ error: 'GTK must be a whole number between 800 and 50,000' });
        }

        // R1 — per-transaction cap based on account age tier
        const tier = getAccountTier(req.user);
        if (credits > tier.topupCap) {
            return res.status(403).json({
                error: `Purchase exceeds your account tier limit of ${tier.topupCap} credits ($${(tier.topupCap / 100).toFixed(2)}) per transaction`
            });
        }

        // Preset packages use their defined price; custom amounts use 1 credit = 1 cent
        const pkg = TOPUP_PACKAGES.find(p => p.credits === credits);
        const priceCents = pkg ? pkg.priceCents : credits;

        const origin = `${req.protocol}://${req.get('host')}`;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `${credits} GTK`,
                            description: `Add ${credits} GTK to your Grabbn account`
                        },
                        unit_amount: priceCents
                    },
                    quantity: 1
                }
            ],
            mode: 'payment',
            metadata: {
                userId: req.user._id.toString(),
                credits: String(credits)
            },
            success_url: `${origin}/?credits_success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/?credits_cancelled=true`
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating Stripe checkout session:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// POST /api/credits/unlock/:bucketId
creditsRouter.post('/unlock/:bucketId', requireAuth, async (req, res) => {
    try {
        if (req.user.isAnonymous) {
            return res.status(403).json({ error: 'Sign in to unlock buckets' });
        }

        const { bucketId } = req.params;
        const bucket = await Bucket.findById(bucketId);

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }
        const vis = bucket.visibility || (bucket.isPublic ? 'public' : 'private');
        if (vis === 'private') {
            return res.status(403).json({ error: 'Bucket is not accessible' });
        }
        if (!bucket.isPaywalled) {
            return res.status(400).json({ error: 'Bucket is not paywalled' });
        }

        // Owner always has access — no charge
        if (bucket.userId.equals(req.user._id)) {
            return res.json({ success: true, alreadyOwner: true });
        }

        // Idempotency check — already unlocked
        const existingAccess = await BucketAccess.findOne({
            userId: req.user._id,
            bucketId: bucket._id
        });
        if (existingAccess) {
            return res.json({ success: true, alreadyUnlocked: true });
        }

        // Load full user doc so we can read/write fraud fields
        const viewer = await User.findById(req.user._id);

        // Pending credits release — lazily convert once hold period has passed
        if (viewer.pendingCredits > 0 && viewer.pendingCreditsUntil && viewer.pendingCreditsUntil <= new Date()) {
            viewer.credits = (viewer.credits ?? 0) + viewer.pendingCredits;
            viewer.pendingCredits = 0;
            viewer.pendingCreditsUntil = null;
            await viewer.save();
        }

        // R2 — daily unlock spend cap
        const tier = getAccountTier(viewer);
        const todayUtc = utcDateString();
        if (viewer.dailyUnlockResetDate === null || utcDateString(viewer.dailyUnlockResetDate) !== todayUtc) {
            viewer.dailyUnlockSpend = 0;
            viewer.dailyUnlockResetDate = new Date();
        }
        if (tier.dailyUnlockCap !== Infinity && viewer.dailyUnlockSpend + bucket.price > tier.dailyUnlockCap) {
            return res.status(403).json({
                error: `Daily unlock limit of ${tier.dailyUnlockCap} credits ($${(tier.dailyUnlockCap / 100).toFixed(2)}) reached for your account tier`
            });
        }

        // Check sufficient credits (pendingCredits excluded — not yet spendable)
        if ((viewer.credits ?? 0) < bucket.price) {
            return res.status(402).json({
                error: 'Insufficient credits',
                required: bucket.price,
                available: viewer.credits ?? 0
            });
        }

        const platformCut = Math.floor(bucket.price * PLATFORM_CUT_RATIO);
        const curatorEarns = bucket.price - platformCut;

        // Atomic operations
        await Promise.all([
            // Debit viewer
            User.findByIdAndUpdate(req.user._id, { $inc: { credits: -bucket.price } }),
            // Credit curator
            User.findByIdAndUpdate(bucket.userId, { $inc: { credits: curatorEarns } }),
            // Grant access
            BucketAccess.create({ userId: req.user._id, bucketId: bucket._id }),
            // Log transactions
            Transaction.create([
                { userId: req.user._id, type: 'unlock', amount: -bucket.price, relatedBucketId: bucket._id },
                { userId: bucket.userId, type: 'earn', amount: curatorEarns, relatedBucketId: bucket._id },
                { userId: bucket.userId, type: 'platform_fee', amount: platformCut, relatedBucketId: bucket._id }
            ])
        ]);

        // Track daily unlock spend for R2
        viewer.dailyUnlockSpend += bucket.price;
        await viewer.save();

        // Notify the curator that their bucket was purchased (no buyer identity — privacy)
        const _buData = { bucketId: bucket._id, bucketName: bucket.name, creditsEarned: curatorEarns };
        User.findById(bucket.userId).select('notificationPrefs').lean()
          .then(owner => {
              if (owner?.notificationPrefs?.bucket_unlocked === false) return null;
              return Notification.create({ userId: bucket.userId, type: 'bucket_unlocked', data: _buData });
          })
          .then(n => {
              if (!n) return;
              pushNotification(bucket.userId, { type: 'new_notification', notification: n });
              maybeSendNotificationEmail(bucket.userId, 'bucket_unlocked', _buData).catch(() => {});
          })
          .catch(err => console.error('[notif] bucket_unlocked:', err));

        res.json({ success: true });
    } catch (error) {
        console.error('Error unlocking bucket:', error);
        res.status(500).json({ error: 'Failed to unlock bucket' });
    }
});

// GET /api/credits/summary — balance + 7-day earned/spent totals
creditsRouter.get('/summary', requireAuth, async (req, res) => {
    try {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [earned, spent] = await Promise.all([
            Transaction.aggregate([
                { $match: { userId: req.user._id, type: 'earn', createdAt: { $gte: since } } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            Transaction.aggregate([
                { $match: { userId: req.user._id, type: 'unlock', createdAt: { $gte: since } } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ])
        ]);
        res.json({
            balance:             req.user.credits ?? 0,
            pendingCredits:      req.user.pendingCredits ?? 0,
            pendingCreditsUntil: req.user.pendingCreditsUntil ?? null,
            earned7d:            earned[0]?.total ?? 0,
            spent7d:             spent[0]?.total ?? 0,
        });
    } catch (error) {
        console.error('Error fetching credit summary:', error);
        res.status(500).json({ error: 'Failed to fetch credit summary' });
    }
});

// GET /api/credits/chart?period=7d|30d|90d|ytd|lifetime — aggregates for charting
creditsRouter.get('/chart', requireAuth, async (req, res) => {
    try {
        const VALID  = ['7d', '30d', '90d', 'ytd', 'lifetime'];
        const period = VALID.includes(req.query.period) ? req.query.period : '7d';
        const now    = new Date();

        // ── Month-bucket helper (ytd / lifetime) ──────────────────────────────
        if (period === 'ytd' || period === 'lifetime') {
            let since;

            if (period === 'ytd') {
                since = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
            } else {
                // earliest transaction for this user, fallback to account start of year
                const first = await Transaction.findOne({ userId: req.user._id }).sort({ createdAt: 1 }).lean();
                since = first
                    ? new Date(Date.UTC(new Date(first.createdAt).getUTCFullYear(), new Date(first.createdAt).getUTCMonth(), 1))
                    : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
            }

            const txs = await Transaction.find({
                userId: req.user._id,
                type:   { $in: ['topup', 'earn', 'unlock', 'cashout'] },
                createdAt: { $gte: since }
            }).lean();

            // Build month buckets from since → current month
            const buckets = [];
            let cur = new Date(since);
            while (cur.getUTCFullYear() < now.getUTCFullYear() ||
                   (cur.getUTCFullYear() === now.getUTCFullYear() && cur.getUTCMonth() <= now.getUTCMonth())) {
                buckets.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() });
                cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
            }

            const earned = new Array(buckets.length).fill(0);
            const spent  = new Array(buckets.length).fill(0);
            const multiYear = buckets[0].year !== buckets[buckets.length - 1].year;
            const labels = buckets.map(b => {
                const d = new Date(Date.UTC(b.year, b.month, 1));
                return multiYear
                    ? d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
                    : d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
            });

            for (const tx of txs) {
                const d   = new Date(tx.createdAt);
                const idx = buckets.findIndex(b => b.year === d.getUTCFullYear() && b.month === d.getUTCMonth());
                if (idx === -1) continue;
                if (tx.type === 'topup' || tx.type === 'earn') earned[idx] += tx.amount;
                else spent[idx] += Math.abs(tx.amount);
            }

            return res.json({
                labels,
                earned,
                spent,
                totalEarned: earned.reduce((a, b) => a + b, 0),
                totalSpent:  spent.reduce((a, b) => a + b, 0),
            });
        }

        // ── Day/week buckets (7d / 30d / 90d) ────────────────────────────────
        const days      = period === '90d' ? 90 : period === '30d' ? 30 : 7;
        const step      = days === 90 ? 7 : 1;
        const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const since      = new Date(todayStart.getTime() - days * 86400000);

        const txs = await Transaction.find({
            userId: req.user._id,
            type:   { $in: ['topup', 'earn', 'unlock', 'cashout'] },
            createdAt: { $gte: since }
        }).lean();

        const bucketCount = Math.ceil(days / step);
        const earned      = new Array(bucketCount).fill(0);
        const spent       = new Array(bucketCount).fill(0);
        const labels      = [];

        for (let i = 0; i < bucketCount; i++) {
            const d = new Date(since.getTime() + i * step * 86400000);
            labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }));
        }

        for (const tx of txs) {
            const offset = Math.floor((new Date(tx.createdAt).getTime() - since.getTime()) / (step * 86400000));
            const idx    = Math.min(Math.max(offset, 0), bucketCount - 1);
            if (tx.type === 'topup' || tx.type === 'earn') earned[idx] += tx.amount;
            else spent[idx] += Math.abs(tx.amount);
        }

        res.json({
            labels,
            earned,
            spent,
            totalEarned: earned.reduce((a, b) => a + b, 0),
            totalSpent:  spent.reduce((a, b) => a + b, 0),
        });
    } catch (err) {
        console.error('Error fetching chart data:', err);
        res.status(500).json({ error: 'Failed to fetch chart data' });
    }
});

// GET /api/credits/export — download full transaction history as CSV
creditsRouter.get('/export', requireAuth, async (req, res) => {
    try {
        const transactions = await Transaction.find({
            userId: req.user._id,
            type: { $ne: 'platform_fee' }
        })
        .sort({ createdAt: -1 })
        .populate('relatedBucketId', 'name')
        .lean();

        const LABELS = {
            topup:   'Credit purchase',
            unlock:  'Bucket unlock',
            earn:    'Earnings',
            cashout: 'Cash out'
        };

        const header = ['Date (UTC)', 'Transaction Type', 'GTK', 'USD Equivalent', 'Related Bucket'].join(',');
        const rows = transactions.map(t => {
            const bucket = t.relatedBucketId?.name
                ? '"' + t.relatedBucketId.name.replace(/"/g, '""') + '"'
                : '';
            return [
                new Date(t.createdAt).toISOString(),
                LABELS[t.type] || t.type,
                t.amount,
                (Math.abs(t.amount) / 100).toFixed(2),
                bucket
            ].join(',');
        });

        const csv = [header, ...rows].join('\r\n');
        const filename = `grabbn-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (error) {
        console.error('Error exporting transactions:', error);
        res.status(500).json({ error: 'Failed to export transactions' });
    }
});

// GET /api/credits/history?page=1  (add ?all=true to skip pagination)
creditsRouter.get('/history', requireAuth, async (req, res) => {
    try {
        if (req.query.all === 'true') {
            const transactions = await Transaction.find({ userId: req.user._id, type: { $ne: 'platform_fee' } })
                .sort({ createdAt: -1 })
                .populate('relatedBucketId', 'name')
                .lean();
            return res.json({ transactions, total: transactions.length, page: 1, pages: 1 });
        }

        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = 20;
        const skip = (page - 1) * limit;

        const [transactions, total] = await Promise.all([
            Transaction.find({ userId: req.user._id, type: { $ne: 'platform_fee' } })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('relatedBucketId', 'name')
                .lean(),
            Transaction.countDocuments({ userId: req.user._id, type: { $ne: 'platform_fee' } })
        ]);

        res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
    } catch (error) {
        console.error('Error fetching transaction history:', error);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

// DELETE /api/credits/history/:id — soft-remove a transaction from user history view
creditsRouter.delete('/history/:id', requireAuth, async (req, res) => {
    try {
        const tx = await Transaction.findOne({ _id: req.params.id, userId: req.user._id });
        if (!tx) return res.status(404).json({ error: 'Transaction not found' });
        await Transaction.deleteOne({ _id: tx._id });
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting transaction:', error);
        res.status(500).json({ error: 'Failed to delete transaction' });
    }
});

router.use('/credits', creditsRouter);

// =============================================================================
// Stripe Connect, mounted at /api/connect
// =============================================================================

const connectRouter = express.Router();

// GET /api/connect/status
connectRouter.get('/status', requireAuth, async (req, res) => {
    try {
        res.json({
            stripeAccountStatus: req.user.stripeAccountStatus ?? 'none',
            credits: req.user.credits ?? 0
        });
    } catch (error) {
        console.error('Error fetching connect status:', error);
        res.status(500).json({ error: 'Failed to fetch connect status' });
    }
});

// POST /api/connect/onboard
connectRouter.post('/onboard', requireAuth, async (req, res) => {
    try {
        if (req.user.isAnonymous) {
            return res.status(403).json({ error: 'Sign in to connect a bank account' });
        }

        const origin = `${req.protocol}://${req.get('host')}`;
        let accountId = req.user.stripeAccountId;

        // Create a new Express account if one doesn't exist yet
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: 'express',
                metadata: { userId: req.user._id.toString() }
            });
            accountId = account.id;
            await User.findByIdAndUpdate(req.user._id, {
                stripeAccountId: accountId,
                stripeAccountStatus: 'pending'
            });
        }

        // Generate (or resume) the onboarding link
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${origin}/api/connect/return?userId=${req.user._id}&refresh=true`,
            return_url: `${origin}/api/connect/return?userId=${req.user._id}`,
            type: 'account_onboarding'
        });

        res.json({ url: accountLink.url });
    } catch (error) {
        console.error('Error creating Stripe Connect onboarding link:', error);
        res.status(500).json({ error: 'Failed to start onboarding' });
    }
});

// GET /api/connect/return  — Stripe redirects here after onboarding
// No session cookie available in this redirect, so userId is passed via query param
connectRouter.get('/return', async (req, res) => {
    const { userId, refresh } = req.query;
    const origin = `${req.protocol}://${req.get('host')}`;

    if (!userId) {
        return res.redirect(`${origin}/?connect_pending=true`);
    }

    try {
        const user = await User.findById(userId);
        if (!user || !user.stripeAccountId) {
            return res.redirect(`${origin}/?connect_pending=true`);
        }

        // If Stripe sent us back due to a refresh (link expired), regenerate the link
        if (refresh === 'true') {
            const accountLink = await stripe.accountLinks.create({
                account: user.stripeAccountId,
                refresh_url: `${origin}/api/connect/return?userId=${userId}&refresh=true`,
                return_url: `${origin}/api/connect/return?userId=${userId}`,
                type: 'account_onboarding'
            });
            return res.redirect(accountLink.url);
        }

        // Check if onboarding completed successfully
        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        if (account.charges_enabled) {
            await User.findByIdAndUpdate(userId, { stripeAccountStatus: 'active' });
            return res.redirect(`${origin}/?connect_success=true`);
        } else {
            return res.redirect(`${origin}/?connect_pending=true`);
        }
    } catch (error) {
        console.error('Error handling Stripe Connect return:', error);
        return res.redirect(`${origin}/?connect_pending=true`);
    }
});

// POST /api/connect/cashout
connectRouter.post('/cashout', requireAuth, async (req, res) => {
    try {
        if (req.user.isAnonymous) {
            return res.status(403).json({ error: 'Sign in to cash out' });
        }
        if (req.user.stripeAccountStatus !== 'active') {
            return res.status(403).json({ error: 'Connect a bank account before cashing out' });
        }

        const credits = req.user.credits ?? 0;
        if (credits < CASHOUT_MIN) {
            return res.status(402).json({
                error: `Minimum cashout is ${CASHOUT_MIN} credits ($${(CASHOUT_MIN / CREDITS_PER_DOLLAR).toFixed(2)})`,
                required: CASHOUT_MIN,
                available: credits
            });
        }

        const centsToTransfer = Math.floor(credits / CREDITS_PER_DOLLAR * 100);

        // Debit credits first
        await User.findByIdAndUpdate(req.user._id, { $inc: { credits: -credits } });

        let transfer;
        try {
            transfer = await stripe.transfers.create({
                amount: centsToTransfer,
                currency: 'usd',
                destination: req.user.stripeAccountId
            });
        } catch (stripeError) {
            // Stripe failed — refund the credits immediately
            await User.findByIdAndUpdate(req.user._id, { $inc: { credits: credits } });
            console.error('Stripe transfer failed:', stripeError);
            return res.status(502).json({ error: 'Transfer failed. Your credits were not deducted.' });
        }

        // Log the cashout transaction
        await Transaction.create({
            userId: req.user._id,
            type: 'cashout',
            amount: -credits,
            stripePaymentIntentId: transfer.id
        });

        res.json({ success: true, transferred: centsToTransfer });
    } catch (error) {
        console.error('Error processing cashout:', error);
        res.status(500).json({ error: 'Failed to process cashout' });
    }
});

router.use('/connect', connectRouter);

// =============================================================================
// Notifications, mounted at /api/notifications
// =============================================================================

const notificationsRouter = express.Router();

// All notification routes require a real (non-anonymous) account
notificationsRouter.use(anonymousAuth, requireAuth, (req, res, next) => {
    if (req.user.isAnonymous) return res.status(403).json({ error: 'Forbidden' });
    next();
});

// Builds the base filter for a user's visible notifications,
// excluding anything created before their last "clear all".
function visibleFilter(user) {
    const filter = { userId: user._id };
    if (user.notificationsClearedAt) {
        filter.createdAt = { $gt: user.notificationsClearedAt };
    }
    return filter;
}

// ── GET /api/notifications ────────────────────────────────────────────────────
// Returns paginated notifications for the current user, newest first.
// Query params: page (default 1), limit (default 20, max 50)
notificationsRouter.get('/', async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip  = (page - 1) * limit;

        const filter = visibleFilter(req.user);

        const [notifications, total] = await Promise.all([
            Notification.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Notification.countDocuments(filter),
        ]);

        // Attach bucket thumbnails in one batch query — keeps notification
        // documents lean while still giving the frontend what it needs to render.
        const bucketIds = notifications
            .map(n => n.data?.bucketId || n.data?.sourceBucketId)
            .filter(Boolean);

        if (bucketIds.length) {
            const buckets = await Bucket.find({ _id: { $in: bucketIds } })
                .select('thumbnail')
                .lean();
            const thumbMap = Object.fromEntries(buckets.map(b => [String(b._id), b.thumbnail || '']));

            for (const n of notifications) {
                const id = n.data?.bucketId || n.data?.sourceBucketId;
                if (id) n.data.bucketThumbnail = thumbMap[String(id)] || '';
            }
        }

        res.json({
            notifications,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
        });
    } catch (err) {
        console.error('[notifications] GET /:', err);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// ── GET /api/notifications/unread-count ──────────────────────────────────────
notificationsRouter.get('/unread-count', async (req, res) => {
    try {
        const filter = { ...visibleFilter(req.user), seen: false };
        const count  = await Notification.countDocuments(filter);
        res.json({ count });
    } catch (err) {
        console.error('[notifications] GET /unread-count:', err);
        res.status(500).json({ error: 'Failed to fetch unread count' });
    }
});

// ── POST /api/notifications/seen ─────────────────────────────────────────────
// Called when the modal is opened — marks all visible notifications as seen.
// This removes the orchid bg on the next modal open. Dot stays until /read.
notificationsRouter.post('/seen', async (req, res) => {
    try {
        const filter = { ...visibleFilter(req.user), seen: false };
        await Notification.updateMany(filter, { $set: { seen: true } });
        res.json({ ok: true });
    } catch (err) {
        console.error('[notifications] POST /seen:', err);
        res.status(500).json({ error: 'Failed to mark notifications as seen' });
    }
});

// ── POST /api/notifications/read ─────────────────────────────────────────────
// Body: { ids: ['...', '...'] }  — mark specific notifications as read
//       {}                       — mark ALL as read
notificationsRouter.post('/read', async (req, res) => {
    try {
        const { ids } = req.body;

        const filter = { userId: req.user._id, read: false };

        if (Array.isArray(ids) && ids.length > 0) {
            const objectIds = ids
                .filter(id => mongoose.Types.ObjectId.isValid(id))
                .map(id => new mongoose.Types.ObjectId(id));

            if (objectIds.length === 0) {
                return res.status(400).json({ error: 'No valid notification IDs provided' });
            }

            filter._id = { $in: objectIds };
        }

        // read: true also implies seen: true
        const result = await Notification.updateMany(filter, { $set: { read: true, seen: true } });
        res.json({ updated: result.modifiedCount });
    } catch (err) {
        console.error('[notifications] POST /read:', err);
        res.status(500).json({ error: 'Failed to mark notifications as read' });
    }
});

// ── POST /api/notifications/clear ────────────────────────────────────────────
// Sets notificationsClearedAt to now — notifications created before this
// timestamp are excluded from all future queries for this user.
notificationsRouter.post('/clear', async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.user._id, { notificationsClearedAt: new Date() });
        res.json({ ok: true });
    } catch (err) {
        console.error('[notifications] POST /clear:', err);
        res.status(500).json({ error: 'Failed to clear notifications' });
    }
});

router.use('/notifications', notificationsRouter);

// =============================================================================
// Bucket comments, mounted at /api/buckets/:id/comments
// =============================================================================

// mergeParams: true is required so `:id` from the parent mount
// (/api/buckets/:id/comments) is visible inside this router.
const bucketCommentsRouter = express.Router({ mergeParams: true });

// All routes go through anonymousAuth so req.user is always populated
bucketCommentsRouter.use(anonymousAuth);

// ── Guards ───────────────────────────────────────────────────────────────────

function requireRegistered(req, res, next) {
    if (!req.user || req.user.isAnonymous) {
        return res.status(401).json({ error: 'Login required' });
    }
    next();
}

// Send in-app @mention notifications (fire-and-forget — never throws).
async function sendMentionNotifications(comment, bucket, commenter) {
    try {
        const mentions = (comment.entities || []).filter(e => e.type === 'mention');
        if (!mentions.length) return;

        for (const entity of mentions) {
            // Skip self-mention
            if (commenter.username && entity.value.toLowerCase() === commenter.username.toLowerCase()) continue;

            const mentioned = await User.findOne({ username: entity.value }).select('_id notificationPrefs').lean();
            if (!mentioned) continue;
            if (mentioned.notificationPrefs?.comment_mention === false) continue;

            const _cmData = { commentId: comment._id, bucketId: bucket._id, bucketName: bucket.name, commenterUsername: commenter.username || '', commenterAvatar: commenter.avatar || '', snippet: comment.body.slice(0, 100) };
            await Notification.create({ userId: mentioned._id, type: 'comment_mention', data: _cmData });
            pushNotification(String(mentioned._id), { type: 'new_notification' });
            maybeSendNotificationEmail(mentioned._id, 'comment_mention', _cmData).catch(() => {});
        }
    } catch (err) {
        console.error('[bucketComments] sendMentionNotifications error:', err);
    }
}

// Notify bucket owners when their bucket is tagged in a comment (fire-and-forget — never throws).
async function sendBucketTagNotifications(comment, commenter) {
    try {
        const refs = (comment.entities || []).filter(e => e.type === 'bucket_ref');
        if (!refs.length) return;

        // De-dupe by bucket ID in case the same bucket is tagged multiple times
        const seen = new Set();
        for (const entity of refs) {
            if (seen.has(entity.value)) continue;
            seen.add(entity.value);

            const taggedBucket = await Bucket.findById(entity.value)
                .select('_id name userId')
                .lean();
            if (!taggedBucket) continue;

            // Skip if commenter is the bucket owner (no self-notification)
            if (taggedBucket.userId.equals(commenter._id)) continue;

            const bucketOwner = await User.findById(taggedBucket.userId).select('notificationPrefs').lean();
            if (bucketOwner?.notificationPrefs?.bucket_tagged === false) continue;

            await Notification.create({
                userId: taggedBucket.userId,
                type:   'bucket_tagged',
                data:   {
                    commentId:         comment._id,
                    bucketId:          taggedBucket._id,
                    bucketName:        taggedBucket.name,
                    commenterUsername: commenter.username || '',
                    commenterAvatar:   commenter.avatar   || '',
                    snippet:           comment.body.slice(0, 100),
                },
            });

            pushNotification(String(taggedBucket.userId), { type: 'new_notification' });
        }
    } catch (err) {
        console.error('[bucketComments] sendBucketTagNotifications error:', err);
    }
}

// Notify the parent comment author when someone replies (fire-and-forget — never throws).
async function sendReplyNotification(replyComment, parentCommentId, bucket, replier) {
    try {
        if (!parentCommentId) return;
        const parent = await BucketComment.findById(parentCommentId).select('userId username').lean();
        if (!parent) return;
        // Skip self-reply
        if (parent.userId.equals(replier._id)) return;

        const parentUser = await User.findById(parent.userId).select('notificationPrefs').lean();
        if (parentUser?.notificationPrefs?.comment_reply === false) return;

        const _crData = { commentId: replyComment._id, bucketId: bucket._id, bucketName: bucket.name, replierUsername: replier.username || '', replierAvatar: replier.avatar || '', snippet: replyComment.body.slice(0, 100) };
        await Notification.create({ userId: parent.userId, type: 'comment_reply', data: _crData });
        pushNotification(String(parent.userId), { type: 'new_notification' });
        maybeSendNotificationEmail(parent.userId, 'comment_reply', _crData).catch(() => {});
    } catch (err) {
        console.error('[bucketComments] sendReplyNotification error:', err);
    }
}

// Notify comment author when someone agrees with their comment (fire-and-forget — never throws).
async function sendAgreementNotification(comment, bucket, agreer) {
    try {
        // Skip self-agree (shouldn't happen, but guard anyway)
        if (comment.userId.equals(agreer._id)) return;

        const commenter = await User.findById(comment.userId).select('notificationPrefs').lean();
        if (commenter?.notificationPrefs?.comment_agreed === false) return;

        await Notification.create({
            userId: comment.userId,
            type:   'comment_agreed',
            data:   {
                commentId:     comment._id,
                bucketId:      bucket._id,
                bucketName:    bucket.name,
                agreerUsername: agreer.username || '',
                agreerAvatar:   agreer.avatar   || '',
                snippet:        comment.body.slice(0, 100),
            },
        });
        pushNotification(String(comment.userId), { type: 'new_notification' });
    } catch (err) {
        console.error('[bucketComments] sendAgreementNotification error:', err);
    }
}

// ── GET / — Paginated comment list ───────────────────────────────────────────
bucketCommentsRouter.get('/', async (req, res) => {
    try {
        const { id: bucketId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(bucketId)) {
            return res.status(400).json({ error: 'Invalid bucket ID' });
        }

        const bucket = await Bucket.findById(bucketId).select('_id').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        const isAnon = !req.user || req.user.isAnonymous;
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = isAnon ? 3 : Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip   = isAnon ? 0 : (page - 1) * limit;

        const filter = { bucketId, deletedAt: null };

        // Exclude comments from users who have blocked the viewer
        if (!isAnon) {
            const blocks = await Block.find({ blockedId: req.user._id }).select('blockerId').lean();
            if (blocks.length) {
                filter.userId = { $nin: blocks.map(b => b.blockerId) };
            }
        }

        const [comments, total] = await Promise.all([
            BucketComment.find(filter)
                .sort({ isPinned: -1, agreementCount: -1, createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            BucketComment.countDocuments(filter),
        ]);

        // Batch-fetch which comments the current user has agreed on
        let agreedSet = new Set();
        if (!isAnon && comments.length) {
            const ids = comments.map(c => c._id);
            const agreements = await CommentAgreement.find({
                commentId: { $in: ids },
                userId:    req.user._id,
            }).select('commentId').lean();
            agreedSet = new Set(agreements.map(a => String(a.commentId)));
        }

        // Batch-fetch current avatars + filter private accounts in one query
        const commenterIds = [...new Set(comments.map(c => String(c.userId)))];
        let privateSet = new Set();
        let avatarMap  = new Map();
        if (commenterIds.length) {
            const users = await User.find({ _id: { $in: commenterIds } })
                .select('_id avatar privacy')
                .lean();
            for (const u of users) {
                if (['private', 'unlisted'].includes(u.privacy?.accountVisibility)) privateSet.add(String(u._id));
                avatarMap.set(String(u._id), u.avatar || '');
            }
        }

        const annotated = comments
            .filter(c => !privateSet.has(String(c.userId)))
            .map(c => ({
                ...c,
                avatar:     avatarMap.get(String(c.userId)) ?? c.avatar,
                userAgreed: agreedSet.has(String(c._id)),
            }));

        return res.json({
            comments:          annotated,
            total,
            page,
            hasMore:           isAnon ? false : skip + comments.length < total,
            truncatedForAnon:  isAnon && total > 3,
        });
    } catch (err) {
        console.error('[bucketComments] GET /:', err);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// ── POST / — Create comment ───────────────────────────────────────────────────
bucketCommentsRouter.post('/', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { id: bucketId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(bucketId)) {
            return res.status(400).json({ error: 'Invalid bucket ID' });
        }

        if (req.user.privacy?.accountVisibility === 'private')
            return res.status(403).json({ error: 'Private accounts cannot post comments' });

        const bucket = await Bucket.findById(bucketId).select('_id name userId allowComments').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        // Gate: must have clicked at least 2 links in this bucket, unless owner
        const isOwner = bucket.userId.equals(req.user._id);

        // Enforce comment permission
        if (!isOwner) {
            const perm = bucket.allowComments;
            if (perm === false || perm === 'no_one') {
                return res.status(403).json({ error: 'Comments are disabled on this bucket.' });
            }
            if (perm === 'followers') {
                const sub = await Subscription.findOne({ followerId: req.user._id, followeeId: bucket.userId }).lean();
                if (!sub) return res.status(403).json({ error: 'Only followers can comment on this bucket.' });
            }
            if (perm === 'followees') {
                const sub = await Subscription.findOne({ followerId: bucket.userId, followeeId: req.user._id }).lean();
                if (!sub) return res.status(403).json({ error: 'Only people this curator follows can comment.' });
            }
        }
        if (!isOwner) {
            const clickCount = await LinkClick.countDocuments({ bucketId: bucket._id, userId: req.user._id });
            if (clickCount < 2) {
                return res.status(403).json({
                    code:  'NEED_MORE_CLICKS',
                    error: 'Open at least 2 links to unlock commenting',
                });
            }
        }

        // Rate limit: 1 comment per minute
        const ONE_MIN = 60 * 1000;
        if (req.user.lastCommentAt && Date.now() - new Date(req.user.lastCommentAt).getTime() < ONE_MIN) {
            return res.status(429).json({ error: 'Please wait a moment before posting again' });
        }

        // Validate body
        const body = (req.body.body || '').trim();
        if (!body)          return res.status(400).json({ error: 'Comment cannot be empty' });
        if (body.length > 250) return res.status(400).json({ error: 'Comment too long (max 250 characters)' });

        // Validate parentCommentId (if replying)
        let parentCommentId = null;
        if (req.body.parentCommentId) {
            if (!mongoose.Types.ObjectId.isValid(req.body.parentCommentId)) {
                return res.status(400).json({ error: 'Invalid parent comment ID' });
            }
            const parent = await BucketComment.findOne({
                _id:       req.body.parentCommentId,
                bucketId,
                deletedAt: null,
            }).select('_id').lean();
            if (!parent) return res.status(400).json({ error: 'Parent comment not found' });
            parentCommentId = parent._id;
        }

        // Parse + resolve entity references from the body
        const entities    = await parseAndResolveEntities(body, req.user._id);
        const editLockedAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

        const comment = await BucketComment.create({
            bucketId,
            userId:   req.user._id,
            username: req.user.username || '',
            avatar:   req.user.avatar   || '',
            body,
            parentCommentId,
            entities,
            editLockedAt,
        });

        // Update rate-limit timestamp (fire-and-forget)
        User.findByIdAndUpdate(req.user._id, { lastCommentAt: new Date() }).catch(() => {});

        // Send notifications (fire-and-forget)
        sendMentionNotifications(comment, bucket, req.user).catch(() => {});
        sendBucketTagNotifications(comment, req.user).catch(() => {});
        sendReplyNotification(comment, parentCommentId, bucket, req.user).catch(() => {});

        return res.status(201).json({ comment: { ...comment.toObject(), userAgreed: false } });
    } catch (err) {
        console.error('[bucketComments] POST /:', err);
        res.status(500).json({ error: 'Failed to post comment' });
    }
});

// ── PATCH /:commentId — Edit comment ─────────────────────────────────────────
bucketCommentsRouter.patch('/:commentId', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { commentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }

        const comment = await BucketComment.findById(commentId);
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });
        if (!comment.userId.equals(req.user._id)) return res.status(403).json({ error: 'Forbidden' });
        if (comment.isEdited)                      return res.status(409).json({ error: 'Comment has already been edited once' });
        if (new Date() > comment.editLockedAt)     return res.status(403).json({ error: 'Edit window has expired (48 hours)' });

        const body = (req.body.body || '').trim();
        if (!body)             return res.status(400).json({ error: 'Comment cannot be empty' });
        if (body.length > 250) return res.status(400).json({ error: 'Comment too long (max 250 characters)' });

        const entities = await parseAndResolveEntities(body, req.user._id);

        const updated = await BucketComment.findByIdAndUpdate(
            commentId,
            { body, entities, isEdited: true, editedAt: new Date() },
            { new: true }
        );

        // Send mention + bucket-tag notifications for edited comment (fire-and-forget)
        const { id: bucketId } = req.params;
        const editBucket = await Bucket.findById(bucketId).select('_id name').lean();
        if (editBucket) {
            sendMentionNotifications(updated, editBucket, req.user).catch(() => {});
            sendBucketTagNotifications(updated, req.user).catch(() => {});
        }

        return res.json({ comment: updated });
    } catch (err) {
        console.error('[bucketComments] PATCH /:commentId:', err);
        res.status(500).json({ error: 'Failed to edit comment' });
    }
});

// ── DELETE /:commentId — Soft delete ─────────────────────────────────────────
bucketCommentsRouter.delete('/:commentId', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { id: bucketId, commentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }

        const comment = await BucketComment.findById(commentId);
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });

        const isOwn = comment.userId.equals(req.user._id);
        if (!isOwn) {
            const bucket = await Bucket.findById(bucketId).select('userId').lean();
            if (!bucket || !bucket.userId.equals(req.user._id)) {
                return res.status(403).json({ error: 'Forbidden' });
            }
        }

        await BucketComment.findByIdAndUpdate(commentId, { deletedAt: new Date() }, { timestamps: false });
        return res.json({ ok: true });
    } catch (err) {
        console.error('[bucketComments] DELETE /:commentId:', err);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

// ── POST /:commentId/agree — Toggle agreement ─────────────────────────────────
bucketCommentsRouter.post('/:commentId/agree', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { commentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }

        const comment = await BucketComment.findById(commentId).select('_id userId body deletedAt bucketId').lean();
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });

        const existing = await CommentAgreement.findOne({ commentId, userId: req.user._id });
        if (existing) {
            await Promise.all([
                CommentAgreement.deleteOne({ _id: existing._id }),
                BucketComment.findByIdAndUpdate(commentId, { $inc: { agreementCount: -1 } }, { timestamps: false }),
            ]);
            return res.json({ agreed: false });
        } else {
            await Promise.all([
                CommentAgreement.create({ commentId, userId: req.user._id }),
                BucketComment.findByIdAndUpdate(commentId, { $inc: { agreementCount: 1 } }, { timestamps: false }),
            ]);
            // Notify comment author (fire-and-forget)
            Bucket.findById(comment.bucketId).select('_id name').lean().then(b => {
                if (b) sendAgreementNotification(comment, b, req.user).catch(() => {});
            }).catch(() => {});
            return res.json({ agreed: true });
        }
    } catch (err) {
        console.error('[bucketComments] POST /:commentId/agree:', err);
        res.status(500).json({ error: 'Failed to toggle agreement' });
    }
});

// ── PATCH /:commentId/pin — Curator pin toggle ────────────────────────────────
bucketCommentsRouter.patch('/:commentId/pin', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { id: bucketId, commentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }

        const bucket = await Bucket.findById(bucketId).select('userId').lean();
        if (!bucket || !bucket.userId.equals(req.user._id)) {
            return res.status(403).json({ error: 'Only the curator can pin comments' });
        }

        const comment = await BucketComment.findById(commentId);
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });

        comment.isPinned = !comment.isPinned;
        await comment.save();

        return res.json({ isPinned: comment.isPinned });
    } catch (err) {
        console.error('[bucketComments] PATCH /:commentId/pin:', err);
        res.status(500).json({ error: 'Failed to toggle pin' });
    }
});

// ── POST /:commentId/report ───────────────────────────────────────────────────
bucketCommentsRouter.post('/:commentId/report', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { commentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }

        const comment = await BucketComment.findById(commentId).select('_id userId deletedAt').lean();
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });
        if (comment.userId.equals(req.user._id)) {
            return res.status(400).json({ error: 'Cannot report your own comment' });
        }

        const validReasons = ['spam', 'harassment', 'inappropriate', 'other'];
        const { reason } = req.body;
        if (!reason || !validReasons.includes(reason)) {
            return res.status(400).json({ error: 'Invalid reason' });
        }

        await CommentReport.create({ commentId, reporterId: req.user._id, reason });
        return res.json({ success: true });
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'Already reported' });
        console.error('[bucketComments] POST /:commentId/report:', err);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// ── POST /:commentId/refresh-entity — Refresh a bucket_ref snapshot ───────────
// The client sends the entityIndex (position in comment.entities array).
// We re-fetch the bucket and update the stored snapshot.
bucketCommentsRouter.post('/:commentId/refresh-entity', requireRegistered, async (req, res) => {
    try {
        const { commentId }  = req.params;
        const { entityIndex } = req.body;

        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }
        if (typeof entityIndex !== 'number' || entityIndex < 0) {
            return res.status(400).json({ error: 'Invalid entity index' });
        }

        const comment = await BucketComment.findById(commentId);
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });

        const entity = comment.entities[entityIndex];
        if (!entity || entity.type !== 'bucket_ref') {
            return res.status(400).json({ error: 'Entity is not a bucket reference' });
        }

        const snapshot = await fetchBucketSnapshot(entity.value);
        comment.entities[entityIndex].snapshot = snapshot;
        comment.markModified('entities'); // required for Mixed-array mutation
        await comment.save();

        return res.json({ snapshot });
    } catch (err) {
        console.error('[bucketComments] POST /:commentId/refresh-entity:', err);
        res.status(500).json({ error: 'Failed to refresh entity' });
    }
});

router.use('/buckets/:id/comments', bucketCommentsRouter);

// =============================================================================
// Direct messages, mounted at /api/dm
// =============================================================================

const dmRouter = express.Router();
dmRouter.use(anonymousAuth);

// Rate limit: 1 message per 3 seconds per user (in-memory, resets on restart)
const lastMessageTime = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

// Returns true if targetUserId has blocked viewerId
async function isBlockedBy(viewerId, targetUserId) {
    return !!(await Block.exists({ blockerId: targetUserId, blockedId: viewerId }));
}

// Normalise participant pair to a canonical sorted array for dedup index
function sortedParticipants(a, b) {
    return [a, b].map(String).sort();
}

// ── GET /api/dm/can-message/:userId ─────────────────────────────────────────
dmRouter.get('/can-message/:userId', requireRegistered, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) return res.json({ allowed: false });

        const target = await User.findById(userId).select('privacy isAnonymous category').lean();
        if (!target || target.isAnonymous) return res.json({ allowed: false });

        const senderId = req.user._id;
        const rawWcm = target.privacy?.whoCanMessage;
        const wcm = Array.isArray(rawWcm) ? rawWcm : (rawWcm ? [rawWcm] : ['everyone']);

        if (wcm.includes('no_one')) return res.json({ allowed: false });
        if (wcm.includes('everyone')) return res.json({ allowed: true });

        const sender = await User.findById(senderId).select('category').lean();
        const [pif, pfm, sc] = await Promise.all([
            wcm.includes('people_i_follow')      ? Subscription.exists({ followerId: target._id, followeeId: senderId }) : false,
            wcm.includes('people_who_follow_me') ? Subscription.exists({ followerId: senderId,   followeeId: target._id }) : false,
            wcm.includes('same_category')        ? Promise.resolve(!!(sender?.category && sender.category === target.category)) : false,
        ]);
        return res.json({ allowed: !!(pif || pfm || sc) });
    } catch (err) {
        console.error('[dm] GET /can-message:', err);
        res.json({ allowed: true });
    }
});

// ── GET /api/dm/conversations — inbox list ───────────────────────────────────
dmRouter.get('/conversations', requireRegistered, async (req, res) => {
    try {
        const userId = req.user._id;

        // Find all conversations the user is part of
        const conversations = await Conversation.find({ participants: userId })
            .sort({ lastMessageAt: -1 })
            .limit(50)
            .lean();

        if (!conversations.length) return res.json({ conversations: [] });

        // One-time backfill: conversations created before lastMessageSenderId was added
        // have the field as null. Run a single aggregate to resolve them all at once,
        // then write the result back so this only ever happens once per conversation.
        const needsBackfill = conversations.filter(c => !c.lastMessageSenderId && c.lastMessagePreview);
        if (needsBackfill.length) {
            const lastSenders = await DirectMessage.aggregate([
                { $match: { conversationId: { $in: needsBackfill.map(c => c._id) } } },
                { $sort:  { createdAt: -1 } },
                { $group: { _id: '$conversationId', senderId: { $first: '$senderId' } } },
            ]);
            const senderMap = new Map(lastSenders.map(r => [String(r._id), r.senderId]));
            // Apply to in-memory result so this response is already correct
            for (const c of conversations) {
                if (!c.lastMessageSenderId && senderMap.has(String(c._id))) {
                    c.lastMessageSenderId = senderMap.get(String(c._id));
                }
            }
            // Persist asynchronously — fire-and-forget, runs once per affected conv
            const bulkOps = lastSenders.map(r => ({
                updateOne: {
                    filter: { _id: r._id, lastMessageSenderId: null },
                    update: { $set: { lastMessageSenderId: r.senderId } },
                },
            }));
            if (bulkOps.length) Conversation.bulkWrite(bulkOps, { timestamps: false }).catch(() => {});
        }

        // Collect other participant IDs
        const otherIds = conversations.map(c =>
            c.participants.find(p => String(p) !== String(userId))
        ).filter(Boolean);

        // Who has blocked us?
        const blockedByOthers = await Block.find({
            blockerId: { $in: otherIds },
            blockedId: userId,
        }).select('blockerId').lean();
        const blockedBySet = new Set(blockedByOthers.map(b => String(b.blockerId)));

        const otherUsers = await User.find({ _id: { $in: otherIds } })
            .select('username avatar anonymousId')
            .lean();
        const userMap = new Map(otherUsers.map(u => [String(u._id), u]));

        const result = conversations
            .filter(c => {
                const otherId = c.participants.find(p => String(p) !== String(userId));
                return !blockedBySet.has(String(otherId));
            })
            .map(c => {
                const otherId = c.participants.find(p => String(p) !== String(userId));
                const other   = userMap.get(String(otherId)) || {};
                return {
                    _id:                c._id,
                    otherUser: {
                        _id:         otherId,
                        username:    other.username    || 'Unknown',
                        avatar:      other.avatar      || null,
                        anonymousId: other.anonymousId || null,
                    },
                    lastMessageAt:       c.lastMessageAt,
                    lastMessagePreview:  c.lastMessagePreview,
                    lastMessageSenderId: c.lastMessageSenderId ? String(c.lastMessageSenderId) : null,
                    unreadCount:         c.unreadCounts?.get?.(String(userId))    ?? (c.unreadCounts?.[String(userId)]    ?? 0),
                    otherUnreadCount:    c.unreadCounts?.get?.(String(otherId))   ?? (c.unreadCounts?.[String(otherId)]   ?? 0),
                    hasContext:          !!c.contextCommentId,
                    isMuted:             (c.mutedBy || []).some(id => String(id) === String(userId)),
                    pinnedMessage:       c.pinnedMessage?.messageId ? {
                        messageId:      String(c.pinnedMessage.messageId),
                        body:           c.pinnedMessage.body || '',
                        senderUsername: c.pinnedMessage.senderUsername || '',
                        senderAvatar:   c.pinnedMessage.senderAvatar   || null,
                    } : null,
                };
            });

        return res.json({ conversations: result });
    } catch (err) {
        console.error('[dm] GET /conversations:', err);
        res.status(500).json({ error: 'Failed to fetch conversations' });
    }
});

// ── GET /api/dm/:conversationId/messages — paginated messages ────────────────
dmRouter.get('/:conversationId/messages', requireRegistered, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(400).json({ error: 'Invalid conversation ID' });
        }

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

        const isParticipant = conversation.participants.some(p => String(p) === String(req.user._id));
        if (!isParticipant) return res.status(403).json({ error: 'Forbidden' });

        const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit) || 30));
        const before = req.query.before; // ISO date — load messages older than this

        const filter = { conversationId };
        if (before) filter.createdAt = { $lt: new Date(before) };

        const messages = await DirectMessage.find(filter)
            .sort({ createdAt: -1 })
            .limit(limit + 1)
            .lean();

        const hasMore = messages.length > limit;
        return res.json({
            messages: messages.slice(0, limit).reverse(), // oldest first
            hasMore,
        });
    } catch (err) {
        console.error('[dm] GET /:conversationId/messages:', err);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// ── POST /api/dm/send — send a message ──────────────────────────────────────
dmRouter.post('/send', requireRegistered, requireVerification, async (req, res) => {
    try {
        const senderId = req.user._id;
        const { recipientId, body, contextCommentId } = req.body;

        // Validate recipient
        if (!recipientId || !mongoose.Types.ObjectId.isValid(recipientId)) {
            return res.status(400).json({ error: 'Invalid recipient' });
        }
        if (String(senderId) === String(recipientId)) {
            return res.status(400).json({ error: 'Cannot message yourself' });
        }

        if (req.user.privacy?.accountVisibility === 'private')
            return res.status(403).json({ error: 'Private accounts cannot send messages' });

        const recipient = await User.findById(recipientId).select('_id username avatar isAnonymous privacy category').lean();
        if (!recipient || recipient.isAnonymous) {
            return res.status(404).json({ error: 'Recipient not found' });
        }

        if (recipient.privacy?.accountVisibility === 'private')
            return res.status(403).json({ error: 'This account is private' });

        // Block check: has recipient blocked sender?
        if (await isBlockedBy(senderId, recipientId)) {
            return res.status(403).json({ error: 'Unable to send message' });
        }

        // Messaging preference check
        const rawWcm = recipient.privacy?.whoCanMessage;
        const wcm = Array.isArray(rawWcm) ? rawWcm : (rawWcm ? [rawWcm] : ['everyone']);

        if (wcm.includes('no_one')) {
            return res.status(403).json({ error: 'This user is not accepting messages' });
        }
        if (!wcm.includes('everyone')) {
            const sender = await User.findById(senderId).select('category').lean();
            const checks = await Promise.all([
                wcm.includes('people_i_follow')      ? Subscription.exists({ followerId: recipientId, followeeId: senderId }) : false,
                wcm.includes('people_who_follow_me') ? Subscription.exists({ followerId: senderId, followeeId: recipientId }) : false,
                wcm.includes('same_category')        ? Promise.resolve(!!(sender?.category && sender.category === recipient.category)) : false,
            ]);
            if (!checks.some(Boolean))
                return res.status(403).json({ error: 'This user has restricted who can message them' });
        }

        // Validate body
        const text = (body || '').trim();
        if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
        if (text.length > 350) return res.status(400).json({ error: 'Message too long (max 350 characters)' });

        // Rate limit: 1 message per 3 seconds
        const now = Date.now();
        const last = lastMessageTime.get(String(senderId)) || 0;
        if (now - last < 3000) {
            return res.status(429).json({ error: 'Please wait a moment before sending again' });
        }
        lastMessageTime.set(String(senderId), now);

        // Find or create conversation
        const participantPair = sortedParticipants(senderId, recipientId);
        let conversation = await Conversation.findOne({ participants: { $all: participantPair, $size: 2 } });

        let isNewConversation = false;
        if (!conversation) {
            isNewConversation = true;
            const conversationData = {
                participants: participantPair,
                lastMessageAt: new Date(),
                lastMessagePreview: text.slice(0, 60),
                lastMessageSenderId: senderId,
                unreadCounts: { [String(recipientId)]: 1, [String(senderId)]: 0 },
            };

            // Attach comment context if provided and this is the first message
            if (contextCommentId && mongoose.Types.ObjectId.isValid(contextCommentId)) {
                const comment = await BucketComment.findById(contextCommentId)
                    .select('body userId username bucketId deletedAt')
                    .populate('bucketId', 'name')
                    .lean();
                if (comment && !comment.deletedAt) {
                    conversationData.contextCommentId       = comment._id;
                    conversationData.contextCommentBody     = comment.body.slice(0, 250);
                    conversationData.contextCommentUsername = comment.username || '';
                    conversationData.contextCommentBucketId = comment.bucketId?._id || null;
                    conversationData.contextCommentBucketName = comment.bucketId?.name || null;
                }
            }

            conversation = await Conversation.create(conversationData);
        } else {
            // Update existing conversation
            const currentUnread = conversation.unreadCounts?.get?.(String(recipientId))
                ?? (conversation.unreadCounts?.[String(recipientId)] ?? 0);
            await Conversation.findByIdAndUpdate(conversation._id, {
                lastMessageAt:       new Date(),
                lastMessagePreview:  text.slice(0, 60),
                lastMessageSenderId: senderId,
                [`unreadCounts.${String(recipientId)}`]: currentUnread + 1,
            }, { timestamps: false });
        }

        // Parse entities
        const entities = await parseAndResolveEntities(text, senderId);

        // Save message
        const message = await DirectMessage.create({
            conversationId: conversation._id,
            senderId,
            body: text,
            entities,
        });

        // Push real-time to recipient
        pushNotification(String(recipientId), {
            type:           'new_dm',
            conversationId: String(conversation._id),
            senderUsername: req.user.username || '',
            senderAvatar:   req.user.avatar   || null,
            preview:        text.slice(0, 60),
            messageId:      String(message._id),
        });

        // Push back to sender (multi-tab sync)
        pushNotification(String(senderId), {
            type:           'dm_sent',
            conversationId: String(conversation._id),
            messageId:      String(message._id),
        });

        // Persist notification only if recipient hasn't muted this conversation
        const isMutedByRecipient = (conversation.mutedBy || []).some(id => String(id) === String(recipientId));
        if (!isMutedByRecipient) {
            const _dmData = { conversationId: String(conversation._id), senderUsername: req.user.username || '', senderAvatar: req.user.avatar || null, preview: text.slice(0, 60) };
            User.findById(recipientId).select('notificationPrefs').lean()
                .then(recipient => {
                    if (recipient?.notificationPrefs?.new_dm === false) return;
                    return Notification.create({ userId: recipientId, type: 'new_dm', data: _dmData })
                        .then(() => maybeSendNotificationEmail(recipientId, 'new_dm', _dmData));
                })
                .catch(() => {});
        }

        return res.status(201).json({
            message: {
                _id:            message._id,
                conversationId: conversation._id,
                senderId,
                body:           message.body,
                entities:       message.entities,
                createdAt:      message.createdAt,
                readAt:         message.readAt || null,
            },
            conversationId: conversation._id,
            isNewConversation,
        });
    } catch (err) {
        console.error('[dm] POST /send:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// ── POST /api/dm/:conversationId/read — mark conversation as read ────────────
dmRouter.post('/:conversationId/read', requireRegistered, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(400).json({ error: 'Invalid conversation ID' });
        }

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

        const isParticipant = conversation.participants.some(p => String(p) === String(req.user._id));
        if (!isParticipant) return res.status(403).json({ error: 'Forbidden' });

        await Conversation.findByIdAndUpdate(conversationId, {
            [`unreadCounts.${String(req.user._id)}`]: 0,
        }, { timestamps: false });

        // Mark all unread messages in this conversation as read
        const readAt = new Date();
        await DirectMessage.updateMany(
            { conversationId, senderId: { $ne: req.user._id }, readAt: null },
            { readAt }
        );

        // Notify the sender in real-time that their messages were read
        const senderId = conversation.participants.find(p => String(p) !== String(req.user._id));
        if (senderId) {
            pushNotification(String(senderId), {
                type:           'dm_read',
                conversationId: String(conversationId),
                readAt:         readAt.toISOString(),
            });
        }

        return res.json({ ok: true });
    } catch (err) {
        console.error('[dm] POST /:conversationId/read:', err);
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// ── POST /api/dm/read-all — mark all conversations as read ───────────────────
dmRouter.post('/read-all', requireRegistered, async (req, res) => {
    try {
        const userId = String(req.user._id);
        await Conversation.updateMany(
            { participants: req.user._id },
            { $set: { [`unreadCounts.${userId}`]: 0 } },
            { timestamps: false }
        );
        return res.json({ ok: true });
    } catch (err) {
        console.error('[dm] POST /read-all:', err);
        res.status(500).json({ error: 'Failed to mark all as read' });
    }
});

// ── GET /api/dm/unread-count — total unread DMs for nav badge ────────────────
dmRouter.get('/unread-count', requireRegistered, async (req, res) => {
    try {
        const userId = String(req.user._id);
        const conversations = await Conversation.find({ participants: req.user._id })
            .select('unreadCounts participants')
            .lean();

        // Filter out conversations where the other person has blocked us
        const otherIds = conversations.map(c =>
            c.participants.find(p => String(p) !== userId)
        ).filter(Boolean);

        const blockedByOthers = await Block.find({
            blockerId: { $in: otherIds },
            blockedId: req.user._id,
        }).select('blockerId').lean();
        const blockedBySet = new Set(blockedByOthers.map(b => String(b.blockerId)));

        const total = conversations.reduce((sum, c) => {
            const otherId = c.participants.find(p => String(p) !== userId);
            if (blockedBySet.has(String(otherId))) return sum;
            const count = c.unreadCounts?.get?.(userId) ?? (c.unreadCounts?.[userId] ?? 0);
            return sum + count;
        }, 0);

        return res.json({ unread: total });
    } catch (err) {
        console.error('[dm] GET /unread-count:', err);
        res.json({ unread: 0 });
    }
});

// ── POST /api/dm/:conversationId/mute — mute conversation ────────────────────
dmRouter.post('/:conversationId/mute', requireRegistered, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(conversationId)) return res.status(400).json({ error: 'Invalid ID' });

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).json({ error: 'Not found' });
        if (!conversation.participants.some(p => String(p) === String(req.user._id))) return res.status(403).json({ error: 'Forbidden' });

        await Conversation.findByIdAndUpdate(conversationId,
            { $addToSet: { mutedBy: req.user._id } },
            { timestamps: false }
        );
        return res.json({ ok: true, muted: true });
    } catch (err) {
        console.error('[dm] POST /:conversationId/mute:', err);
        res.status(500).json({ error: 'Failed to mute' });
    }
});

// ── DELETE /api/dm/:conversationId/mute — unmute conversation ─────────────────
dmRouter.delete('/:conversationId/mute', requireRegistered, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(conversationId)) return res.status(400).json({ error: 'Invalid ID' });

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).json({ error: 'Not found' });
        if (!conversation.participants.some(p => String(p) === String(req.user._id))) return res.status(403).json({ error: 'Forbidden' });

        await Conversation.findByIdAndUpdate(conversationId,
            { $pull: { mutedBy: req.user._id } },
            { timestamps: false }
        );
        return res.json({ ok: true, muted: false });
    } catch (err) {
        console.error('[dm] DELETE /:conversationId/mute:', err);
        res.status(500).json({ error: 'Failed to unmute' });
    }
});

// ── POST /api/dm/:conversationId/pin — pin a message ─────────────────────────
dmRouter.post('/:conversationId/pin', requireRegistered, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { messageId } = req.body;

        if (!mongoose.Types.ObjectId.isValid(conversationId) || !mongoose.Types.ObjectId.isValid(messageId)) {
            return res.status(400).json({ error: 'Invalid ID' });
        }

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

        const isParticipant = conversation.participants.some(p => String(p) === String(req.user._id));
        if (!isParticipant) return res.status(403).json({ error: 'Forbidden' });

        const message = await DirectMessage.findById(messageId).lean();
        if (!message) return res.status(404).json({ error: 'Message not found' });

        const sender = await User.findById(message.senderId).select('username avatar').lean();

        const pinnedMessage = {
            messageId:      message._id,
            body:           message.body.slice(0, 200),
            senderUsername: sender?.username || '',
            senderAvatar:   sender?.avatar   || null,
        };

        await Conversation.findByIdAndUpdate(conversationId, { pinnedMessage }, { timestamps: false });

        const payload = {
            type:           'dm_pinned',
            conversationId: String(conversationId),
            pinnedMessage:  { ...pinnedMessage, messageId: String(pinnedMessage.messageId) },
        };
        for (const pid of conversation.participants) pushNotification(String(pid), payload);

        return res.json({ ok: true, pinnedMessage: payload.pinnedMessage });
    } catch (err) {
        console.error('[dm] POST /:conversationId/pin:', err);
        res.status(500).json({ error: 'Failed to pin message' });
    }
});

// ── DELETE /api/dm/:conversationId/pin — unpin ────────────────────────────────
dmRouter.delete('/:conversationId/pin', requireRegistered, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(400).json({ error: 'Invalid ID' });
        }

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

        const isParticipant = conversation.participants.some(p => String(p) === String(req.user._id));
        if (!isParticipant) return res.status(403).json({ error: 'Forbidden' });

        await Conversation.findByIdAndUpdate(conversationId,
            { $unset: { 'pinnedMessage.messageId': '', 'pinnedMessage.body': '', 'pinnedMessage.senderUsername': '', 'pinnedMessage.senderAvatar': '' } },
            { timestamps: false }
        );

        const payload = { type: 'dm_unpinned', conversationId: String(conversationId) };
        for (const pid of conversation.participants) pushNotification(String(pid), payload);

        return res.json({ ok: true });
    } catch (err) {
        console.error('[dm] DELETE /:conversationId/pin:', err);
        res.status(500).json({ error: 'Failed to unpin message' });
    }
});

// ── DELETE /api/dm/message/:messageId — delete own message ───────────────────
dmRouter.delete('/message/:messageId', requireRegistered, async (req, res) => {
    try {
        const { messageId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(messageId)) {
            return res.status(400).json({ error: 'Invalid message ID' });
        }

        const message = await DirectMessage.findById(messageId).lean();
        if (!message) return res.status(404).json({ error: 'Message not found' });

        // Only the sender can delete their own message
        if (String(message.senderId) !== String(req.user._id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await DirectMessage.deleteOne({ _id: messageId });

        // If this was the last message, clear the preview on the conversation
        const lastMsg = await DirectMessage.findOne({ conversationId: message.conversationId })
            .sort({ createdAt: -1 }).lean();

        const conversation = await Conversation.findByIdAndUpdate(message.conversationId, {
            lastMessagePreview:  lastMsg ? lastMsg.body.slice(0, 60) : '',
            lastMessageAt:       lastMsg ? lastMsg.createdAt : null,
            lastMessageSenderId: lastMsg ? lastMsg.senderId : null,
        }, { timestamps: false, new: false }).lean();

        // Push real-time deletion event to both participants
        const payload = {
            type:           'dm_deleted',
            messageId:      String(messageId),
            conversationId: String(message.conversationId),
        };
        if (conversation) {
            for (const participantId of conversation.participants) {
                pushNotification(String(participantId), payload);
            }
        }

        return res.json({ ok: true });
    } catch (err) {
        console.error('[dm] DELETE /message/:messageId:', err);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

router.use('/dm', dmRouter);

// =============================================================================
// Blocks, mounted at /api/users
// =============================================================================

const blockRouter = express.Router();
blockRouter.use(anonymousAuth);

// POST /api/users/:userId/block — block a user
blockRouter.post('/:userId/block', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        if (userId === String(req.user._id)) {
            return res.status(400).json({ error: 'Cannot block yourself' });
        }

        const target = await User.findById(userId).select('_id').lean();
        if (!target) return res.status(404).json({ error: 'User not found' });

        await Block.create({ blockerId: req.user._id, blockedId: userId });
        return res.json({ blocked: true });
    } catch (err) {
        if (err.code === 11000) return res.json({ blocked: true }); // already blocked
        console.error('[block] POST block:', err);
        res.status(500).json({ error: 'Failed to block user' });
    }
});

// DELETE /api/users/:userId/block — unblock a user
blockRouter.delete('/:userId/block', requireRegistered, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        await Block.deleteOne({ blockerId: req.user._id, blockedId: userId });
        return res.json({ blocked: false });
    } catch (err) {
        console.error('[block] DELETE block:', err);
        res.status(500).json({ error: 'Failed to unblock user' });
    }
});

// GET /api/users/blocked — list users I have blocked
blockRouter.get('/blocked', requireRegistered, async (req, res) => {
    try {
        const blocks = await Block.find({ blockerId: req.user._id })
            .sort({ createdAt: -1 })
            .lean();

        if (!blocks.length) return res.json({ users: [] });

        const users = await User.find({ _id: { $in: blocks.map(b => b.blockedId) } })
            .select('username avatar anonymousId')
            .lean();

        const userMap = new Map(users.map(u => [String(u._id), u]));
        return res.json({
            users: blocks.map(b => {
                const u = userMap.get(String(b.blockedId));
                return u ? { userId: String(b.blockedId), username: u.username, avatar: u.avatar || null, blockedAt: b.createdAt } : null;
            }).filter(Boolean),
        });
    } catch (err) {
        console.error('[block] GET blocked:', err);
        res.status(500).json({ error: 'Failed to fetch blocked users' });
    }
});

router.use('/users', blockRouter);

// =============================================================================
// Partner program, mounted at /api/partnership
// =============================================================================

// Public-facing partnership application routes.
// All routes require a logged-in, non-anonymous, verified user.
const partnershipRouter = express.Router();

// ── Middleware: must be a verified, non-anonymous user ────────────────────────
function requireVerifiedUser(req, res, next) {
    const u = req.user;
    if (!u || u.isAnonymous) return res.status(401).json({ error: 'Sign in to apply' });
    if (!u.isEmailVerified)  return res.status(403).json({ error: 'Verify your email before applying' });
    next();
}

// ── GET /api/partnership/status ───────────────────────────────────────────────
// Returns the current user's application status (or null if never applied).
partnershipRouter.get('/status', requireVerifiedUser, async (req, res) => {
    try {
        // Partners: fetch their approved application (to get the correct tier).
        // Non-partners: fetch their latest application (any status) to surface pending/rejected state.
        const query = req.user.isPartner
            ? { userId: req.user._id, status: 'approved' }
            : { userId: req.user._id };

        const app = await PartnerApplication
            .findOne(query)
            .sort({ submittedAt: -1 })
            .select('status tier submittedAt reviewedAt rejectionReason')
            .lean();

        res.json({ isPartner: req.user.isPartner, application: app ?? null });
    } catch (err) {
        console.error('[partnership/status]', err);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// ── GET /api/partnership/eligibility ─────────────────────────────────────────
// Computes the applicant's eligibility against Junior and Pro thresholds.
// Returns gate checks (hard blocks) and per-stat values for both tiers.
partnershipRouter.get('/eligibility', requireVerifiedUser, async (req, res) => {
    try {
        const user   = req.user;
        const userId = user._id;
        const now    = new Date();

        // ── Phase A: hard gates ────────────────────────────────────────────────
        const emailVerified      = !!user.isEmailVerified;
        const accountStanding    = !user.accountSuspendedAt;
        const notAlreadyPartner  = !user.isPartner;
        const pendingApp         = await PartnerApplication.findOne({ userId, status: 'pending' }).lean();
        const noActiveApplication = !pendingApp;

        // ── Account age ────────────────────────────────────────────────────────
        const accountAgeDays   = Math.floor((now - new Date(user.createdAt)) / 86400000);
        const accountAgeMonths = accountAgeDays / 30.44;

        // ── Public buckets (load once, compute everything from this set) ───────
        const publicBuckets = await Bucket
            .find({ userId, isPublic: true, isDraft: { $ne: true } })
            .select('links createdAt grabbedBy')
            .lean();

        const totalPublicBuckets = publicBuckets.length;

        // ── Grab count ─────────────────────────────────────────────────────────
        const grabCount = publicBuckets.reduce(
            (sum, b) => sum + (b.grabbedBy?.length ?? 0), 0
        );

        // ── Subscriber count ───────────────────────────────────────────────────
        const subscriberCount = await Subscription.countDocuments({ followeeId: userId });

        // ── Enforcement record ─────────────────────────────────────────────────
        // No dedicated violations model yet — accountSuspendedAt is used as proxy.
        const daysSinceLastViolation = user.accountSuspendedAt
            ? Math.floor((now - new Date(user.accountSuspendedAt)) / 86400000)
            : null; // null = no violations on record

        // ── Qualifying buckets ─────────────────────────────────────────────────
        // A bucket qualifies for a tier when:
        //   1. It has been public for at least minAgeDays
        //   2. It has at least minLinks non-archived links each with >= minClicks clicks
        function countQualifyingBuckets(minAgeDays, minLinks, minClicks) {
            const ageCutoff = new Date(now - minAgeDays * 86400000);
            return publicBuckets.filter(b => {
                if (new Date(b.createdAt) > ageCutoff) return false;
                const qualLinks = (b.links ?? []).filter(
                    l => !l.isArchived && (l.clickCount ?? 0) >= minClicks
                );
                return qualLinks.length >= minLinks;
            }).length;
        }

        const juniorQualifyingBuckets = countQualifyingBuckets(90,  3,  250);
        const proQualifyingBuckets    = countQualifyingBuckets(180, 10, 1000);

        // ── Per-tier pass/fail ─────────────────────────────────────────────────
        const juniorEnforcementOk = daysSinceLastViolation === null || daysSinceLastViolation >= 60;
        const proEnforcementOk    = daysSinceLastViolation === null || daysSinceLastViolation >= 180;

        const gatesPass = emailVerified && accountStanding && notAlreadyPartner && noActiveApplication;

        const juniorPasses = gatesPass
            && Math.floor(accountAgeMonths) >= 3
            && juniorQualifyingBuckets >= 5
            && subscriberCount >= 1000
            && grabCount >= 5000
            && juniorEnforcementOk;

        const proPasses = gatesPass
            && Math.floor(accountAgeMonths) >= 12
            && proQualifyingBuckets >= 15
            && subscriberCount >= 10000
            && grabCount >= 50000
            && proEnforcementOk;

        res.json({
            gates: {
                emailVerified,
                accountStanding,
                notAlreadyPartner,
                noActiveApplication,
            },
            stats: {
                accountAgeMonths: Math.floor(accountAgeMonths),
                accountAgeDays,
                totalPublicBuckets,
                subscriberCount,
                grabCount,
                daysSinceLastViolation,
            },
            junior: {
                qualifyingBuckets: juniorQualifyingBuckets,
                passes: juniorPasses,
            },
            pro: {
                qualifyingBuckets: proQualifyingBuckets,
                passes: proPasses,
            },
        });
    } catch (err) {
        console.error('[partnership/eligibility]', err);
        res.status(500).json({ error: 'Failed to check eligibility' });
    }
});

// ── POST /api/partnership/apply ───────────────────────────────────────────────
// Submit a new partner application.
// Body: { pitch, idFileRef, selfieFileRef, tier, claimedAccounts? }
partnershipRouter.post('/apply', requireVerifiedUser, async (req, res) => {
    try {
        const userId = req.user._id;

        // Already a partner
        if (req.user.isPartner) {
            return res.status(409).json({ error: 'You are already a partner' });
        }

        // Block duplicate pending applications
        const existing = await PartnerApplication.findOne({ userId, status: 'pending' });
        if (existing) {
            return res.status(409).json({ error: 'You already have a pending application' });
        }

        const { pitch, idFileRef, selfieFileRef, tier, claimedAccounts, usResidentConfirmed, ageConfirmed } = req.body;

        if (!['junior', 'pro'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier — must be junior or pro' });
        }
        if (!pitch || typeof pitch !== 'string' || pitch.trim().length < 100) {
            return res.status(400).json({ error: 'Pitch must be at least 100 characters' });
        }
        if (!idFileRef || !selfieFileRef) {
            return res.status(400).json({ error: 'ID photo and selfie are required' });
        }
        if (!usResidentConfirmed) {
            return res.status(400).json({ error: 'US residency confirmation is required' });
        }
        if (!ageConfirmed) {
            return res.status(400).json({ error: 'Age confirmation (18+) is required' });
        }

        // Basic size guard — base64 images shouldn't be massive
        const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB encoded
        if (idFileRef.length > MAX_FILE_SIZE || selfieFileRef.length > MAX_FILE_SIZE) {
            return res.status(400).json({ error: 'File too large (max 5 MB each)' });
        }

        // Upload partner files to R2 instead of storing raw base64 in MongoDB
        function decodeBase64File(dataUri) {
            const match = dataUri.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
            if (!match) throw new Error('Invalid image format');
            return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
        }
        const idFile    = decodeBase64File(idFileRef);
        const selfieFile = decodeBase64File(selfieFileRef);
        const [idUrl, selfieUrl] = await Promise.all([
            uploadImageToR2(idFile.buffer,    idFile.mimeType,    'partners'),
            uploadImageToR2(selfieFile.buffer, selfieFile.mimeType, 'partners'),
        ]);

        // Validate claimed accounts structure if provided
        let accounts = [];
        if (Array.isArray(claimedAccounts)) {
            accounts = claimedAccounts.slice(0, 10).map(a => ({
                email:          String(a.email  || '').slice(0, 256),
                phone:          String(a.phone  || '').slice(0, 64),
                bucketOwnerIds: Array.isArray(a.bucketOwnerIds)
                    ? a.bucketOwnerIds.slice(0, 3).map(id => String(id).slice(0, 64))
                    : []
            }));
        }

        const application = await PartnerApplication.create({
            userId,
            tier,
            pitch:               pitch.trim().slice(0, 4000),
            idFileRef:           idUrl,
            selfieFileRef:       selfieUrl,
            claimedAccounts:     accounts,
            usResidentConfirmed: !!usResidentConfirmed,
            ageConfirmed:        !!ageConfirmed,
        });

        res.status(201).json({ message: 'Application submitted', applicationId: application._id });
    } catch (err) {
        console.error('[partnership/apply]', err);
        res.status(500).json({ error: 'Failed to submit application' });
    }
});

router.use('/partnership', partnershipRouter);

// =============================================================================
// Documents, mounted at /api/documents
// =============================================================================

const documentsRouter = express.Router();

const ALLOWED_TYPES = new Set(['gov-id', 'selfie']);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB base64

function requireUser(req, res, next) {
    if (!req.user || req.user.isAnonymous) return res.status(401).json({ error: 'Sign in to manage documents' });
    next();
}

// ── GET /api/documents ────────────────────────────────────────────────────────
// Returns upload status for each document type (no file content).
documentsRouter.get('/', requireUser, async (req, res) => {
    try {
        const docs = await UserDocument
            .find({ userId: req.user._id })
            .select('type uploadedAt')
            .lean();

        const map = {};
        for (const d of docs) map[d.type] = { uploadedAt: d.uploadedAt };

        res.json({
            'gov-id': map['gov-id'] ?? null,
            'selfie': map['selfie'] ?? null,
        });
    } catch (err) {
        console.error('[documents/get]', err);
        res.status(500).json({ error: 'Failed to fetch document status' });
    }
});

// ── POST /api/documents ───────────────────────────────────────────────────────
// Upload or replace a verification document.
// Body: { type: 'gov-id'|'selfie', dataUrl: 'data:image/...' }
documentsRouter.post('/', requireUser, async (req, res) => {
    try {
        const { type, dataUrl } = req.body;

        if (!ALLOWED_TYPES.has(type)) {
            return res.status(400).json({ error: 'Invalid document type' });
        }
        if (!dataUrl || typeof dataUrl !== 'string') {
            return res.status(400).json({ error: 'No file provided' });
        }
        if (dataUrl.length > MAX_FILE_SIZE) {
            return res.status(400).json({ error: 'File too large — max 5 MB' });
        }

        const match = dataUrl.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
        if (!match) return res.status(400).json({ error: 'Invalid image format' });

        const [, mimeType, b64] = match;
        const buffer = Buffer.from(b64, 'base64');
        const fileRef = await uploadImageToR2(buffer, mimeType, 'partners/docs');

        await UserDocument.findOneAndUpdate(
            { userId: req.user._id, type },
            { fileRef, uploadedAt: new Date() },
            { upsert: true, new: true }
        );

        res.json({ ok: true, uploadedAt: new Date() });
    } catch (err) {
        console.error('[documents/post]', err);
        res.status(500).json({ error: 'Failed to upload document' });
    }
});

router.use('/documents', documentsRouter);

// =============================================================================
// FAQ, mounted at /api/faq
// =============================================================================

const faqRouter = express.Router();

// GET /api/faq — published items grouped by category
faqRouter.get('/', async (req, res) => {
    try {
        const items = await FaqItem.find({ status: 'published' })
            .sort({ order: 1, publishedAt: 1 })
            .lean();

        const grouped = {};
        for (const item of items) {
            const cat = item.category || 'uncategorized';
            if (!grouped[cat]) {
                grouped[cat] = {
                    slug:  cat,
                    label: FAQ_CATEGORY_LABELS[cat] || cat,
                    items: [],
                };
            }
            grouped[cat].items.push({ _id: item._id, question: item.question, answer: item.answer });
        }

        res.json({ grouped });
    } catch (err) {
        console.error('[faq]', err);
        res.status(500).json({ error: 'Failed to fetch FAQ' });
    }
});

// GET /api/faq/pending — recent unanswered user submissions (public)
faqRouter.get('/pending', async (req, res) => {
    try {
        const questions = await FaqItem.find({ source: 'user', status: 'pending' })
            .sort({ createdAt: -1 })
            .limit(10)
            .select('question createdAt')
            .lean();

        res.json({ questions });
    } catch (err) {
        console.error('[faq/pending]', err);
        res.status(500).json({ error: 'Failed to fetch questions' });
    }
});

// POST /api/faq/questions — submit a question (logged-in, non-anonymous users only)
faqRouter.post('/questions', async (req, res) => {
    const user = req.user;
    if (!user || user.isAnonymous) {
        return res.status(401).json({ error: 'Sign in to submit a question' });
    }

    const { question } = req.body;
    if (!question || typeof question !== 'string' || !question.trim()) {
        return res.status(400).json({ error: 'Question is required' });
    }
    const trimmed = question.trim();
    if (trimmed.length > 500) {
        return res.status(400).json({ error: 'Question must be 500 characters or fewer' });
    }

    try {
        const item = await FaqItem.create({
            question:    trimmed,
            source:      'user',
            submittedBy: user._id,
            status:      'pending',
        });

        res.json({ ok: true, id: item._id });
    } catch (err) {
        console.error('[faq/questions]', err);
        res.status(500).json({ error: 'Failed to submit question' });
    }
});

router.use('/faq', faqRouter);

// =============================================================================
// Contact form, mounted at /api/contact
// =============================================================================

const contactRouter = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

const VALID_INTENTS    = new Set(['support', 'brand', 'feedback', 'other']);
const VALID_CONTACT_CATEGORIES = new Set(['account', 'content', 'bug', 'billing', 'safety', 'other']);
const VALID_FT         = new Set(['feature', 'bug', 'general']);
const MAX_ATTACH_BYTES = 5 * 1024 * 1024;
const MAX_ATTACH_COUNT = 5;

function stripTags(html) {
    return String(html).replace(/<[^>]*>/g, '');
}

contactRouter.post('/', async (req, res) => {
    try {
        const {
            intent, name, email, message,
            category, subject,
            company, website,
            feedbackType,
            organization,
            attachments: rawAttachments,
        } = req.body;

        if (!VALID_INTENTS.has(intent)) return res.status(400).json({ error: 'Invalid intent' });

        const msgHtml = typeof message === 'string' ? message.trim() : '';
        const msgText = stripTags(msgHtml).trim();
        if (msgText.length < 10)   return res.status(400).json({ error: 'Message must be at least 10 characters' });
        if (msgText.length > 5000) return res.status(400).json({ error: 'Message too long (max 5 000 characters)' });

        const user       = req.user;
        const isLoggedIn = user && !user.isAnonymous;

        const fromEmail = isLoggedIn
            ? user.email
            : (typeof email === 'string' ? email.trim().toLowerCase() : '');
        const fromName = isLoggedIn
            ? (user.username || user.email)
            : (typeof name === 'string' && name.trim() ? name.trim() : 'Anonymous');

        if (!fromEmail || !fromEmail.includes('@') || fromEmail.length > 256) {
            return res.status(400).json({ error: 'A valid email address is required' });
        }

        // ── Attachments ───────────────────────────────────────────────────────
        const attachments = [];
        if (Array.isArray(rawAttachments)) {
            for (const a of rawAttachments.slice(0, MAX_ATTACH_COUNT)) {
                if (!a.filename || !a.data || typeof a.data !== 'string') continue;
                const buf = Buffer.from(a.data, 'base64');
                if (buf.byteLength > MAX_ATTACH_BYTES) continue;
                attachments.push({ filename: String(a.filename).slice(0, 255), content: buf });
            }
        }

        const intentLabels = {
            support:  'Support',
            brand:    'Brand inquiry',
            feedback: 'Feedback',
            other:    'Press / Other',
        };
        const ftLabels  = { feature: 'Feature request', bug: 'Bug report', general: 'General feedback' };
        const catLabels = {
            account: 'Account & verification',
            content: 'Content & buckets',
            bug:     'Technical bug',
            billing: 'Billing & GTK',
            safety:  'Safety & moderation',
            other:   'Other',
        };

        const subjectLine = typeof subject === 'string' && subject.trim()
            ? subject.trim().slice(0, 80)
            : msgText.slice(0, 60);
        const emailSubject = `[Grabbn Contact] [${intentLabels[intent]}] ${subjectLine}`;

        const rows = [
            ['Intent', intentLabels[intent]],
            ['From',   `${fromName} &lt;${fromEmail}&gt;`],
        ];
        if (isLoggedIn) rows.push(['User ID', String(user._id)]);
        if (intent === 'support') {
            if (category && VALID_CONTACT_CATEGORIES.has(category)) rows.push(['Category', catLabels[category]]);
            if (subject && typeof subject === 'string' && subject.trim()) rows.push(['Subject', subject.trim().slice(0, 200)]);
        }
        if (intent === 'brand') {
            if (company && typeof company === 'string' && company.trim()) rows.push(['Company', company.trim().slice(0, 200)]);
            if (website && typeof website === 'string' && website.trim()) rows.push(['Website', website.trim().slice(0, 500)]);
        }
        if (intent === 'feedback' && feedbackType && VALID_FT.has(feedbackType)) {
            rows.push(['Type', ftLabels[feedbackType]]);
        }
        if (intent === 'other' && organization && typeof organization === 'string' && organization.trim()) {
            rows.push(['Organization', organization.trim().slice(0, 200)]);
        }
        if (attachments.length) {
            rows.push(['Attachments', attachments.map(a => a.filename).join(', ')]);
        }

        const rowsHtml = rows.map(([k, v]) =>
            `<tr>
                <td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top;white-space:nowrap;font-weight:600;">${k}</td>
                <td style="padding:4px 0;color:#1f2937;">${v}</td>
            </tr>`
        ).join('');

        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
    <h2 style="color:#1f2937;margin-bottom:20px;">New contact form submission</h2>
    <table style="border-collapse:collapse;margin-bottom:24px;">${rowsHtml}</table>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px;color:#374151;line-height:1.7;">
        ${msgHtml}
    </div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
    <p style="color:#9ca3af;font-size:12px;">Grabbn Contact Form</p>
</div>`;

        const to = process.env.SUPPORT_EMAIL || process.env.RESEND_FROM;
        await resend.emails.send({
            from:        process.env.RESEND_FROM,
            to,
            replyTo:     fromEmail,
            subject:     emailSubject,
            html,
            ...(attachments.length ? { attachments } : {}),
        });

        res.json({ ok: true });
    } catch (err) {
        console.error('[contact]', err);
        res.status(500).json({ error: 'Failed to send your message. Please try again.' });
    }
});

router.use('/contact', contactRouter);

// =============================================================================
// The other API routes, in their original order
// =============================================================================

// Online presence — checks wsClients for an active connection
router.get('/users/:userId/online-status', anonymousAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        const u = await User.findById(userId).select('lastActive privacy').lean();
        if (!u) return res.json({ online: false, lastSeenAt: null });
        if (u.privacy?.showActivityStatus === false) return res.json({ hidden: true });
        const connections = wsClients.get(String(userId));
        const online = !!(connections && connections.size > 0);
        const lastSeenAt = online ? null : (u.lastActive ?? null);
        return res.json({ online, lastSeenAt });
    } catch (err) {
        console.error('[online-status]', err);
        res.json({ online: false, lastSeenAt: null });
    }
});

// ── Image proxy ─────────────────────────────────────────────────────────────
// Fetches external link thumbnail URLs server-side so that CDN hotlink
// protection / Varnish restrictions on the source site don't affect the user.
// Usage: /api/img-proxy?url=https://cdn.example.com/img/abc
const ALLOWED_IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
router.get('/img-proxy', async (req, res) => {
    const raw = req.query.url;
    if (!raw) return res.status(400).end();

    let target;
    try {
        target = new URL(raw);
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('bad protocol');
    } catch {
        return res.status(400).end();
    }

    // Block requests back to our own origin to prevent SSRF loops
    const selfHostnames = ['localhost', '127.0.0.1', 'grabbn.com', 'app.grabbn.com'];
    if (selfHostnames.includes(target.hostname)) return res.status(403).end();

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const upstream = await fetch(target.href, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Grabbn/1.0)',
                // Deliberately omit Referer so hotlink-protected CDNs don't block us
            },
            redirect: 'follow',
        });
        clearTimeout(timer);

        const type = (upstream.headers.get('content-type') || '').split(';')[0].trim();
        if (!upstream.ok || !ALLOWED_IMG_TYPES.has(type)) return res.status(502).end();

        res.set('Content-Type', type);
        res.set('Cache-Control', 'public, max-age=86400'); // cache 24 h on CDN / browser
        res.set('X-Content-Type-Options', 'nosniff');
        upstream.body.pipe(res);
    } catch {
        res.status(502).end();
    }
});

// ====================
// API ENDPOINTS
// ====================

router.get('/auth/anon-id', requireAuth, (req, res) => {
    res.json({ id: req.user.anonymousId });
});

const META_DAILY_LIMIT = 50;
const META_FETCH_COST  = 2; // GTK per extra fetch

// Per-minute sliding window (hidden, alert only)
const _metaMinuteMap = new Map();
function metaMinuteCheck(userId) {
    const now = Date.now();
    const timestamps = (_metaMinuteMap.get(userId) || []).filter(t => now - t < 60_000);
    if (timestamps.length >= 20) return false;
    timestamps.push(now);
    _metaMinuteMap.set(userId, timestamps);
    return true;
}

// Daily counter with optional bonus quota (calendar day, UTC) — persisted in DB.
async function metaDailyCheck(userId) {
    const today = new Date().toISOString().slice(0, 10);
    const user = await User.findOneAndUpdate(
        { _id: userId, $or: [{ metaFetchDate: { $ne: today } }, { metaFetchDate: null }] },
        { $set: { metaFetchDate: today, metaFetchCount: 0, metaFetchBonus: 0 } },
        { new: false }
    );
    // If the update matched, the doc was reset — now atomically increment
    // Otherwise the doc already has today's date; just increment
    const updated = await User.findOneAndUpdate(
        { _id: userId, metaFetchDate: today, $expr: { $lt: ['$metaFetchCount', { $add: [{ $ifNull: ['$metaFetchLimit', META_DAILY_LIMIT] }, '$metaFetchBonus'] }] } },
        { $inc: { metaFetchCount: 1 } },
        { new: true, projection: { metaFetchCount: 1, metaFetchBonus: 1, metaFetchLimit: 1 } }
    );
    if (!updated) {
        const cur = await User.findById(userId, { metaFetchCount: 1, metaFetchBonus: 1, metaFetchLimit: 1 });
        const used  = cur?.metaFetchCount ?? 0;
        const base  = cur?.metaFetchLimit ?? META_DAILY_LIMIT;
        const limit = base + (cur?.metaFetchBonus ?? 0);
        return { ok: false, used, limit };
    }
    const base  = updated.metaFetchLimit ?? META_DAILY_LIMIT;
    const limit = base + updated.metaFetchBonus;
    return { ok: true, used: updated.metaFetchCount, limit };
}

async function metaDailyAddBonus(userId, fetches) {
    const today = new Date().toISOString().slice(0, 10);
    await User.updateOne(
        { _id: userId, $or: [{ metaFetchDate: { $ne: today } }, { metaFetchDate: null }] },
        { $set: { metaFetchDate: today, metaFetchCount: 0, metaFetchBonus: 0 } }
    );
    const updated = await User.findOneAndUpdate(
        { _id: userId },
        { $inc: { metaFetchBonus: fetches } },
        { new: true, projection: { metaFetchCount: 1, metaFetchBonus: 1, metaFetchLimit: 1 } }
    );
    const base = updated.metaFetchLimit ?? META_DAILY_LIMIT;
    return { limit: base + updated.metaFetchBonus, used: updated.metaFetchCount };
}

// Scrape OG/meta tags from a URL — returns { title, image } for link auto-fill.
router.get('/meta', requireAuth, async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!metaMinuteCheck(String(req.user._id))) return res.status(429).json({ error: 'rate_minute' });
    const daily = await metaDailyCheck(String(req.user._id));
    if (!daily.ok) return res.status(429).json({ error: 'rate_daily', used: daily.used, limit: daily.limit });

    const usage = { used: daily.used, limit: daily.limit };
    const normalizedUrl = normalizeMetaUrl(url);

    // JS-rendered domains: use ScraperAPI (rendered HTML).
    if (needsRender(normalizedUrl)) {
        const resolvedUrl = await resolveUrl(normalizedUrl);
        console.log('[meta] normalized URL:', normalizedUrl);
        console.log('[meta] needsRender — resolved:', resolvedUrl);

        // Shein: try internal product API first. If it fails, return slug title + no image —
        // Shein: try internal API first, then Zyte (CF-bypass renderer), then slug title fallback.
        const isShein = domainMatches(hostnameFromUrl(normalizedUrl), ['shein.com']);
        if (isShein) {
            const sheinData = await fetchSheinProduct(resolvedUrl);
            const imgOpts = { referer: resolvedUrl, minBytes: 5120 };

            if (sheinData?.images?.length) {
                const title = sheinData.title || slugTitleFromUrl(resolvedUrl) || null;
                const { image: normalizedImage, candidates } = await resolveBestImage(sheinData.images, imgOpts);
                if (normalizedImage) console.log('[meta] Shein API image resolved');
                return res.json({ title, image: normalizedImage, images: candidates.slice(0, 8), usage });
            }

            console.log('[meta] Shein: product images unavailable via server-side scraping � returning title only');
            return res.json(sheinTitleOnlyMeta(
                resolvedUrl,
                usage,
                sheinData?.title || null,
                { imageAttemptsSkipped: true }
            ));
        }

        try {
            const html = await fetchViaScraperAPI(resolvedUrl);
            console.log('[meta] ScraperAPI html length:', html ? html.length : 'null');
            if (html && !isCloudflareChallengeHtml(html)) {
                const { title, image, allImages } = extractOG(html, resolvedUrl);
                console.log('[meta] extractOG raw ->', { title, image, candidateCount: allImages.length });
                const imgOpts = { referer: resolvedUrl, minBytes: 5120 };
                const { image: normalizedImage, candidates } = await resolveBestImage(allImages.length ? allImages : [image], imgOpts);
                console.log('[meta] normalizedImage ->', normalizedImage ? normalizedImage.slice(0, 60) : null);
                const images = candidates.slice(0, 8);
                const resolvedTitle = !isGenericTitle(title) ? title : null;
                return res.json({ title: resolvedTitle || (isGenericTitle(title) ? null : title), image: normalizedImage, images, usage });
            }
        } catch (e) { console.error('[meta] ScraperAPI threw:', e.message); }
        return res.json({ title: slugTitleFromUrl(normalizedUrl) || null, image: null, images: [], usage });
    }

    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 10000);
        const upstream = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
            },
            redirect: 'follow',
        });
        if (!upstream.ok) return res.json({ title: null, image: null, images: [], usage });
        const html = await upstream.text();
        const { title, image, allImages } = extractOG(html, normalizedUrl);
        const { image: normalizedImage, candidates } = await resolveBestImage(allImages.length ? allImages : [image], {
            referer: normalizedUrl,
            minBytes: 2048,
        });

        res.json({ title: title || null, image: normalizedImage, images: candidates.slice(0, 8), usage });
    } catch {
        res.json({ title: null, image: null, images: [], usage });
    }
});

// Proxy an image URL through the server (auth required) — used by the image picker.
// Returns raw image binary so it can be used directly as <img src="/api/img-proxy?url=...">.
router.get('/img-proxy', requireAuth, async (req, res) => {
    const { url, referer } = req.query;
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).end();
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 10000);
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': referer ? 'cross-site' : 'none',
        };
        if (referer) { headers['Referer'] = referer; try { headers['Origin'] = new URL(referer).origin; } catch {} }
        const upstream = await fetch(url, { signal: ctrl.signal, headers, redirect: 'follow' });
        if (!upstream.ok) return res.status(502).end();
        const type = (upstream.headers.get('content-type') || '').split(';')[0].trim();
        if (!ALLOWED_LINK_IMG_MIME.has(type)) return res.status(422).end();
        const buf = await upstream.arrayBuffer();
        res.set('Content-Type', type);
        res.set('Cache-Control', 'private, max-age=300');
        res.send(Buffer.from(buf));
    } catch {
        res.status(502).end();
    }
});

// Purchase extra daily meta fetches with GTK credits (2 GTK each).
router.get('/meta/usage', requireAuth, async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const doc   = await User.findById(req.user._id, { metaFetchDate: 1, metaFetchCount: 1, metaFetchBonus: 1, metaFetchLimit: 1 });
    const used  = (doc?.metaFetchDate === today ? (doc.metaFetchCount ?? 0) : 0);
    const base  = doc?.metaFetchLimit ?? META_DAILY_LIMIT;
    const limit = base + (doc?.metaFetchDate === today ? (doc.metaFetchBonus ?? 0) : 0);
    res.json({ used, limit });
});

router.post('/meta/topup', requireAuth, async (req, res) => {
    const fetches = parseInt(req.body?.fetches);
    if (!Number.isInteger(fetches) || fetches <= 0 || fetches > 500) {
        return res.status(400).json({ error: 'Invalid fetch count' });
    }
    const cost = fetches * META_FETCH_COST;
    const user = await User.findOneAndUpdate(
        { _id: req.user._id, credits: { $gte: cost } },
        { $inc: { credits: -cost } },
        { new: true }
    );
    if (!user) return res.status(402).json({ error: 'Insufficient balance' });
    const { limit, used } = await metaDailyAddBonus(String(req.user._id), fetches);
    res.json({ credits: user.credits, usage: { used, limit } });
});

// Get user info (for debugging/testing)
router.get('/user', requireAuth, requireVerification, (req, res) => {
    res.json({
        anonymousId: req.user.anonymousId,
        isAnonymous: req.user.isAnonymous,
        createdAt: req.user.createdAt,
        lastActive: req.user.lastActive
    });
});

router.post('/user/export', requireAuth, requireVerification, async (req, res) => {
    if (req.user.isAnonymous) return res.status(403).json({ error: 'Account required' });
    if (!req.user.email) return res.status(400).json({ error: 'No email address on file' });

    const EXPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const EXPORT_LIMIT = 2;
    const history = (req.user.preferences?.get?.('exportHistory') || [])
        .map(d => new Date(d).getTime())
        .filter(t => Date.now() - t < EXPORT_WINDOW_MS);
    if (history.length >= EXPORT_LIMIT) {
        return res.status(429).json({ error: 'You can request up to 2 exports per 7 days' });
    }

    history.push(Date.now());
    await User.updateOne({ _id: req.user._id }, { $set: { 'preferences.exportHistory': history } });
    res.json({ ok: true });

    // Background — no await
    (async () => {
        try {
            const userId = req.user._id;
            const [
                buckets, grabs, following, followers,
                comments, ratings, views, shares,
                linkClicks, notifications, reports,
                blocks, blocked, conversations, transactions,
            ] = await Promise.all([
                Bucket.find({ userId }).lean(),
                BucketAccess.find({ userId }).populate('bucketId', 'name description hashtags createdAt').lean(),
                Subscription.find({ followerId: userId }).populate('followeeId', 'username displayName').lean(),
                Subscription.find({ followeeId: userId }).populate('followerId', 'username displayName').lean(),
                BucketComment.find({ userId, deletedAt: null }).populate('bucketId', 'name').lean(),
                BucketRating.find({ userId }).populate('bucketId', 'name').lean(),
                BucketView.find({ userId }).populate('bucketId', 'name').lean(),
                BucketShare.find({ userId }).populate('bucketId', 'name').lean(),
                LinkClick.find({ userId }).lean(),
                Notification.find({ userId }).lean(),
                Report.find({ reporterId: userId }).lean(),
                Block.find({ blockerId: userId }).populate('blockedId', 'username').lean(),
                Block.find({ blockedId: userId }).populate('blockerId', 'username').lean(),
                Conversation.find({ participants: userId }).populate('participants', 'username displayName').lean(),
                Transaction.find({ userId }).lean(),
            ]);

            const convIds = conversations.map(c => c._id);
            const messages = await DirectMessage.find({ conversationId: { $in: convIds }, senderId: userId }).lean();
            const messagesByConv = {};
            for (const m of messages) {
                const key = m.conversationId.toString();
                (messagesByConv[key] = messagesByConv[key] || []).push({ body: m.body, sentAt: m.createdAt });
            }

            const payload = {
                exportedAt: new Date().toISOString(),
                account: {
                    username:     req.user.username,
                    email:        req.user.email,
                    displayName:  req.user.displayName,
                    bio:          req.user.bio,
                    website:      req.user.website,
                    socialLinks:  req.user.socialLinks,
                    category:     req.user.category,
                    language:     req.user.language,
                    credits:      req.user.credits,
                    privacy:      req.user.privacy,
                    createdAt:    req.user.createdAt,
                },
                buckets: buckets.map(b => ({
                    name:        b.name,
                    description: b.description,
                    hashtags:    b.hashtags,
                    visibility:  b.visibility,
                    links:       b.links.map(l => ({ href: l.href, text: l.text, addedAt: l.addedAt })),
                    createdAt:   b.createdAt,
                })),
                grabs: grabs
                    .filter(g => g.bucketId)
                    .map(g => ({
                        bucketName:  g.bucketId.name,
                        description: g.bucketId.description,
                        hashtags:    g.bucketId.hashtags,
                        grabbedAt:   g.grantedAt,
                    })),
                following: following
                    .filter(s => s.followeeId)
                    .map(s => ({ username: s.followeeId.username, displayName: s.followeeId.displayName })),
                followers: followers
                    .filter(s => s.followerId)
                    .map(s => ({ username: s.followerId.username, displayName: s.followerId.displayName })),
                comments: comments
                    .filter(c => c.bucketId)
                    .map(c => ({ bucketName: c.bucketId.name, body: c.body, createdAt: c.createdAt, isEdited: c.isEdited })),
                ratings: ratings
                    .filter(r => r.bucketId)
                    .map(r => ({ bucketName: r.bucketId.name, stars: r.stars, createdAt: r.createdAt })),
                bucketViews: views
                    .filter(v => v.bucketId)
                    .map(v => ({ bucketName: v.bucketId.name, viewedAt: v.createdAt })),
                bucketShares: shares
                    .filter(s => s.bucketId)
                    .map(s => ({ bucketName: s.bucketId.name, sharedAt: s.createdAt })),
                linkClicks: linkClicks.map(c => ({ href: c.href, domain: c.domain, clickedAt: c.createdAt })),
                notifications: notifications.map(n => ({ type: n.type, data: n.data, read: n.read, createdAt: n.createdAt })),
                reports: reports.map(r => ({ reason: r.reason, detail: r.detail, status: r.status, createdAt: r.createdAt })),
                blocks: blocks
                    .filter(b => b.blockedId)
                    .map(b => ({ username: b.blockedId.username, blockedAt: b.createdAt })),
                blockedBy: blocked
                    .filter(b => b.blockerId)
                    .map(b => ({ username: b.blockerId.username })),
                transactions: transactions.map(t => ({ type: t.type, amount: t.amount, createdAt: t.createdAt })),
                directMessages: conversations
                    .map(c => {
                        const other = c.participants.find(p => p._id.toString() !== userId.toString());
                        return {
                            with:     other?.username ?? 'unknown',
                            messages: messagesByConv[c._id.toString()] || [],
                        };
                    }),
            };

            const buffer = Buffer.from(JSON.stringify(payload, null, 2));
            const key = `exports/${req.user._id}-${Date.now()}.json`;
            const url = await uploadFileToR2(buffer, key, 'application/json');
            await sendDataExportEmail(req.user.email, url);
        } catch (err) {
            console.error('[export] failed for user', req.user._id, err.message);
        }
    })();
});

// Cascade-erase all personal data for a user. Called by both the GDPR erasure
// and full account deletion routes.
async function eraseUserData(userId) {
    const convs = await Conversation.find({ participants: userId }, '_id').lean();
    const convIds = convs.map(c => c._id);

    await Promise.all([
        // Content
        Bucket.deleteMany({ userId }),
        Link.deleteMany({ userId }),
        BucketAccess.deleteMany({ userId }),
        // Social
        Subscription.deleteMany({ $or: [{ followerId: userId }, { followeeId: userId }] }),
        Block.deleteMany({ $or: [{ blockerId: userId }, { blockedId: userId }] }),
        // Comments & agreements
        BucketComment.updateMany({ userId }, { $set: { deletedAt: new Date(), body: '[deleted]', username: '', avatar: '' } }),
        CommentAgreement.deleteMany({ userId }),
        // Messaging
        DirectMessage.deleteMany({ conversationId: { $in: convIds } }),
        Conversation.deleteMany({ participants: userId }),
        // Notifications
        Notification.deleteMany({ userId }),
        // Activity / analytics
        BucketView.deleteMany({ userId }),
        BucketSkip.deleteMany({ userId }),
        BucketRating.deleteMany({ userId }),
        BucketShare.deleteMany({ userId }),
        FeedImpression.deleteMany({ userId }),
        LinkClick.deleteMany({ userId }),
        UserRepo.deleteMany({ userId }),
        RepoSkip.deleteMany({ userId }),
        // Admin / misc
        Report.deleteMany({ reporterId: userId }),
        PartnerApplication.deleteMany({ userId }),
    ]);
}

// DELETE /api/user/data — GDPR right to erasure.
// Deletes all personal data and content then anonymises the account shell.
// The user document is kept but stripped of all PII so it cannot be linked back.
router.delete('/user/data', requireAuth, async (req, res) => {
    if (req.user.isAnonymous) return res.status(403).json({ error: 'Account required' });
    const { confirm } = req.body;
    if (confirm !== 'DELETE') return res.status(400).json({ error: 'Confirmation required' });

    try {
        await eraseUserData(req.user._id);

        await User.updateOne({ _id: req.user._id }, {
            $set: {
                isAnonymous:   true,
                email:         undefined,
                googleId:      undefined,
                password:      undefined,
                username:      undefined,
                displayName:   '',
                bio:           '',
                avatar:        '',
                website:       '',
                socialLinks:   [],
                preferences:   {},
                credits:       0,
            },
            $unset: {
                email: '', googleId: '', password: '', username: '',
                resetPasswordToken: '', resetPasswordExpires: '',
                otpCode: '', otpExpires: '', otpSentAt: '',
            },
        });

        res.clearCookie('sessionId');
        res.clearCookie('_accts');
        res.json({ ok: true });
    } catch (err) {
        console.error('[delete-data] error:', err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

// DELETE /api/user/account — soft-delete with 90-day reactivation window.
// Data is preserved until the user explicitly requests erasure (GDPR).
router.delete('/user/account', requireAuth, async (req, res) => {
    if (req.user.isAnonymous) return res.status(403).json({ error: 'Account required' });
    const { confirm } = req.body;
    if (confirm !== 'DELETE') return res.status(400).json({ error: 'Confirmation required' });

    try {
        const email = req.user.email;
        await User.updateOne({ _id: req.user._id }, { $set: { deletedAt: new Date() } });

        res.clearCookie('sessionId');
        res.clearCookie('_accts');
        res.json({ ok: true });

        // Send final email in background
        sendAccountDeletionEmail(email).catch(err =>
            console.error('[delete-account] email failed:', err.message)
        );
    } catch (err) {
        console.error('[delete-account] error:', err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

router.patch('/user/settings', requireAuth, requireVerification, async (req, res) => {
    try {
        const { isMatureGated, showActivityStatus, showGrabbedBuckets, whoCanMessage, accountVisibility, allowComments, allowGrabs, newsletterSubscribed } = req.body;
        const update = {};
        if (isMatureGated !== undefined) update.isMatureGated = !!isMatureGated;
        if (showActivityStatus  !== undefined) update['privacy.showActivityStatus']  = !!showActivityStatus;
        if (showGrabbedBuckets !== undefined) update['privacy.showGrabbedBuckets'] = !!showGrabbedBuckets;
        if (whoCanMessage !== undefined) {
            const VALID_WCM = new Set(['no_one', 'people_i_follow', 'people_who_follow_me', 'same_category', 'everyone']);
            const values = Array.isArray(whoCanMessage) ? whoCanMessage : [whoCanMessage];
            if (!values.length || values.some(v => !VALID_WCM.has(v)))
                return res.status(400).json({ error: 'Invalid whoCanMessage value' });
            update['privacy.whoCanMessage'] = values;
        }
        if (accountVisibility !== undefined) {
            if (!['public', 'unlisted', 'private'].includes(accountVisibility))
                return res.status(400).json({ error: 'Invalid accountVisibility value' });
            update['privacy.accountVisibility'] = accountVisibility;
        }
        if (allowComments        !== undefined) {
            const COMMENT_PERMS = ['everyone', 'followers', 'followees', 'no_one'];
            update['commentDefaults.allowComments'] = COMMENT_PERMS.includes(allowComments) ? allowComments : 'everyone';
        }
        if (allowGrabs           !== undefined) {
            update['commentDefaults.allowGrabs'] = COMMENT_PERMS.includes(allowGrabs) ? allowGrabs : 'everyone';
        }
        if (newsletterSubscribed !== undefined) update.newsletterSubscribed = !!newsletterSubscribed;
        if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No valid fields provided' });
        await User.findByIdAndUpdate(req.user._id, update);
        res.json({ ok: true });
    } catch (err) {
        console.error('Settings update error:', err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// Get all buckets for current user (NO Singletons returned)
router.get('/buckets', requireAuth, requireVerification, async (req, res) => {
    try {
        const buckets = await Bucket.find({ userId: req.user._id })
            .select('name')
            .sort({ order: 1, createdAt: 1 })
            .lean();

        const bucketNames = buckets.map(b => b.name);
        res.json(bucketNames);
    } catch (error) {
        console.error('Error fetching buckets:', error);
        res.status(500).json({ error: 'Failed to fetch buckets' });
    }
});

// ── GET /api/buckets/mine ─────────────────────────────────────────────────────
// Returns the current user's buckets with enough info to render the clone modal.
router.get('/buckets/mine', requireAuth, requireVerification, async (req, res) => {
    try {
        const buckets = await Bucket.find({ userId: req.user._id })
            .select('name thumbnail links')
            .sort({ order: 1, createdAt: 1 })
            .lean();

        res.json(buckets.map(b => ({
            _id:          String(b._id),
            name:         b.name,
            thumbnail:    b.thumbnail || null,
            linkCount:    (b.links || []).length,
        })));
    } catch (err) {
        console.error('Error fetching user buckets:', err);
        res.status(500).json({ error: 'Failed to fetch buckets' });
    }
});

// Fan-out a grabbed_bucket_updated notification to all grabbers of a bucket.
// Dedup: skips grabbers who already received this notification for this bucket today.
async function fanOutGrabbedBucketUpdated(bucket, curatorUsername) {
    try {
        const grabberIds = (bucket.grabbedBy || []).map(g => g.userId);
        if (!grabberIds.length) return;

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const alreadyNotified = await Notification.find({
            userId:               { $in: grabberIds },
            type:                 'grabbed_bucket_updated',
            'data.sourceBucketId': bucket._id,
            createdAt:            { $gte: oneDayAgo },
        }).select('userId').lean();

        const notifiedSet = new Set(alreadyNotified.map(n => String(n.userId)));
        const eligible    = grabberIds.filter(id => !notifiedSet.has(String(id)));
        if (!eligible.length) return;

        const opted = await User.find({
            _id: { $in: eligible },
            'notificationPrefs.grabbed_bucket_updated': { $ne: false },
        }).select('_id').lean();
        const toNotify = opted.map(u => u._id);
        if (!toNotify.length) return;

        const docs = await Notification.insertMany(
            toNotify.map(userId => ({
                userId,
                type: 'grabbed_bucket_updated',
                data: {
                    curatorId:      bucket.userId,
                    curatorUsername,
                    sourceBucketId: bucket._id,
                    bucketName:     bucket.name,
                },
            })),
            { ordered: false }
        );
        for (const n of docs) pushNotification(n.userId, { type: 'new_notification', notification: n });
    } catch (err) {
        console.error('[notif] grabbed_bucket_updated fan-out:', err);
    }
}

// Fan-out a new_bucket_published notification to all followers of a curator
async function fanOutNewBucketPublished(curatorId, curatorUsername, bucketId, bucketName) {
    try {
        const followers = await Subscription.find({ followeeId: curatorId }).select('followerId').lean();
        if (!followers.length) return;

        const allFollowerIds = followers.map(f => f.followerId);
        const opted = await User.find({
            _id: { $in: allFollowerIds },
            'notificationPrefs.new_bucket_published': { $ne: false },
        }).select('_id').lean();
        const filteredIds = opted.map(u => u._id);
        if (!filteredIds.length) return;

        const emailData = { curatorId, curatorUsername, bucketId, bucketName };
        const docs = await Notification.insertMany(
            filteredIds.map(userId => ({
                userId,
                type:   'new_bucket_published',
                data:   emailData,
            })),
            { ordered: false }
        );
        for (const n of docs) {
            pushNotification(n.userId, { type: 'new_notification', notification: n });
            maybeSendNotificationEmail(n.userId, 'new_bucket_published', emailData).catch(() => {});
        }
    } catch (err) {
        console.error('[notif] new_bucket_published fan-out:', err);
    }
}

// Create a new bucket
router.post('/buckets', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name, description, tags, visibility, monetized, price, mature, allowComments, allowGrabs, sourceUrl, thumbnail, links, draft, repoIds } = req.body;

        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Bucket name is required' });
        }

        // Prevent creating 'Singletons' as a real bucket
        if (name === 'Singletons') {
            return res.status(400).json({ error: 'Singletons is a reserved name' });
        }

        // Check if bucket already exists for this user
        const existing = await Bucket.findOne({
            userId: req.user._id,
            name
        });

        if (existing) {
            return res.status(409).json({ error: 'Bucket already exists' });
        }

        if (Array.isArray(links) && links.length > 0) {
            if (links.length > 256) return res.status(400).json({ error: 'A bucket cannot have more than 256 links' });
            const urls = links.map(l => l.url || '');
            const uniqueUrls = new Set(urls.map(u => u.toLowerCase()));
            if (uniqueUrls.size !== urls.length) return res.status(400).json({ error: 'A bucket cannot contain duplicate links' });
            const { ok, blocked } = await validateLinks(urls);
            if (!ok) return res.status(400).json({ error: 'One or more links were rejected for safety reasons', blocked });
        }

        // Validate repoIds belong to this user
        let resolvedRepoIds = [];
        if (Array.isArray(repoIds) && repoIds.length > 0) {
            const validIds = repoIds.filter(id => mongoose.Types.ObjectId.isValid(id));
            const repos = await UserRepo.find({ _id: { $in: validIds }, userId: req.user._id }).select('_id');
            resolvedRepoIds = repos.map(r => r._id);
        }

        const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'private';

        // Create bucket first so we have its ID for scoped R2 paths
        const bucket = await Bucket.create({
            userId:      req.user._id,
            name,
            description: String(description || '').slice(0, 256),
            hashtags:    Array.isArray(tags) ? tags.slice(0, 8) : [],
            visibility:  vis,
            isPublic:    vis === 'public',
            isPaywalled: !!monetized,
            price:       Number(price) || 0,
            mature:        !!mature,
            allowComments: ['everyone', 'followers', 'followees', 'no_one'].includes(allowComments) ? allowComments : 'everyone',
            allowGrabs:    ['everyone', 'followers', 'followees', 'no_one'].includes(allowGrabs)    ? allowGrabs    : 'everyone',
            sourceUrl:     sourceUrl || '',
            isDraft:       draft !== false,
            repoIds:       resolvedRepoIds,
        });

        const bucketId = String(bucket._id);
        const resolvedLinks = Array.isArray(links) ? await Promise.all(links.map(async l => ({
            href:     l.url   || '',
            text:     l.title || '',
            isFree:   !l.monetized,
            isPinned: !!l.pinned,
            image:    await fetchAndStoreImage(l.thumb || null, { folder: `buckets/${bucketId}/links` }) ?? l.thumb ?? null,
        }))) : [];

        const resolvedThumb = await fetchAndStoreImage(thumbnail || null, { folder: `buckets/${bucketId}/thumbnail` }) || '';
        const effectiveThumb = resolvedThumb || resolvedLinks.find(l => l.image)?.image || '';

        bucket.links     = resolvedLinks;
        bucket.thumbnail = effectiveThumb;

        if (['public', 'unlisted'].includes(vis) && resolvedLinks.length < 3) {
            await Bucket.deleteOne({ _id: bucket._id });
            return res.status(400).json({ error: 'A bucket must have at least 3 links to be made public or unlisted.' });
        }

        await bucket.save();

        if (vis === 'public' && !bucket.isDraft) {
            fanOutNewBucketPublished(req.user._id, req.user.username || '', bucket._id, bucket.name);
        }

        res.status(201).json({ _id: bucket._id, name: bucket.name });
    } catch (error) {
        console.error('Error creating bucket:', error);
        res.status(500).json({ error: 'Failed to create bucket' });
    }
});

// Update bucket name
router.put('/buckets/:oldName', requireAuth, requireVerification, async (req, res) => {
    try {
        const { oldName } = req.params;
        const { newName } = req.body;

        if (!newName || typeof newName !== 'string') {
            return res.status(400).json({ error: 'New bucket name is required' });
        }

        if (oldName === 'Singletons' || newName === 'Singletons') {
            return res.status(403).json({ error: 'Cannot use Singletons as a bucket name' });
        }

        const existing = await Bucket.findOne({ userId: req.user._id, name: oldName });
        if (!existing) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        existing.name = newName;
        await existing.save();

        res.json({ name: existing.name });
    } catch (error) {
        console.error('Error updating bucket:', error);
        res.status(500).json({ error: 'Failed to update bucket' });
    }
});

// Full bucket update (used by profile edit modal)
router.patch('/buckets/:id/full', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name, description, tags, visibility, monetized, price, mature, allowComments, allowGrabs, sourceUrl, thumbnail, links, isDraft, repoIds, removeRepoId, addRepoIds } = req.body;

        // Fetch current state to detect meaningful changes before building the update
        const current = await Bucket.findOne({ _id: req.params.id, userId: req.user._id });
        if (!current) return res.status(404).json({ error: 'Bucket not found' });

        const update = {};
        if (name        !== undefined) update.name        = name;
        if (description !== undefined) update.description = String(description || '').slice(0, 256);
        if (tags        !== undefined) update.hashtags    = Array.isArray(tags) ? tags.slice(0, 8) : [];
        if (mature         !== undefined) update.mature         = !!mature;
        if (allowComments  !== undefined) update.allowComments  = ['everyone', 'followers', 'followees', 'no_one'].includes(allowComments) ? allowComments : 'everyone';
        if (allowGrabs     !== undefined) update.allowGrabs     = ['everyone', 'followers', 'followees', 'no_one'].includes(allowGrabs)    ? allowGrabs    : 'everyone';
        if (repoIds !== undefined) {
            if (!Array.isArray(repoIds) || repoIds.length === 0) {
                update.repoIds = [];
            } else {
                const validIds = repoIds.filter(id => mongoose.Types.ObjectId.isValid(id));
                const repos = await UserRepo.find({ _id: { $in: validIds }, userId: req.user._id }).select('_id');
                update.repoIds = repos.map(r => r._id);
            }
        }
        if (removeRepoId && mongoose.Types.ObjectId.isValid(removeRepoId)) {
            update.repoIds = (current.repoIds || []).filter(id => String(id) !== String(removeRepoId));
        }
        if (Array.isArray(addRepoIds) && addRepoIds.length > 0) {
            const validIds = addRepoIds.filter(id => mongoose.Types.ObjectId.isValid(id));
            const repos = await UserRepo.find({ _id: { $in: validIds }, userId: req.user._id }).select('_id');
            const newIds = repos.map(r => String(r._id));
            const existingIds = (current.repoIds || []).map(id => String(id));
            update.repoIds = [...new Set([...existingIds, ...newIds])];
        }
        if (visibility !== undefined) {
            if (current.isDraft && isDraft !== false) {
                return res.status(403).json({ error: 'Publish the bucket before changing its visibility.' });
            }
            const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'private';
            if (['public', 'unlisted'].includes(vis)) {
                const effectiveLinkCount = update.links ? update.links.length : current.links.length;
                if (effectiveLinkCount < 3) {
                    return res.status(400).json({ error: 'A bucket must have at least 3 links to be made public or unlisted.' });
                }
            }
            update.visibility = vis;
            update.isPublic   = vis === 'public';
        }
        if (monetized   !== undefined) update.isPaywalled = !!monetized;
        if (price       !== undefined) update.price       = Number(price) || 0;
        if (sourceUrl   !== undefined) update.sourceUrl   = sourceUrl || '';
        const bId = String(req.params.id);
        if (thumbnail   !== undefined) update.thumbnail   = await fetchAndStoreImage(thumbnail || null, { folder: `buckets/${bId}/thumbnail` }) || '';
        if (links       !== undefined) {
            if (links.length > 256) return res.status(400).json({ error: 'A bucket cannot have more than 256 links' });
            if (links.length > 0) {
                const urls = links.map(l => l.url || '');
                const uniqueUrls = new Set(urls.map(u => u.toLowerCase()));
                if (uniqueUrls.size !== urls.length) return res.status(400).json({ error: 'A bucket cannot contain duplicate links' });
                const { ok, blocked } = await validateLinks(urls);
                if (!ok) return res.status(400).json({ error: 'One or more links were rejected for safety reasons', blocked });
            }
            update.links = await Promise.all(links.map(async l => ({
                href:       l.url   || '',
                text:       l.title || '',
                isFree:     !l.monetized,
                isPinned:   !!l.pinned,
                isArchived: !!l.archived,
                // Fall back to the original URL if base64 conversion fails — never wipe a thumbnail
                image:      await fetchAndStoreImage(l.thumb || null, { folder: `buckets/${bId}/links` }) ?? l.thumb ?? null,
            })));
        }

        if (isDraft !== undefined) update.isDraft = !!isDraft;

        // Auto-set thumbnail from first link image if still empty after update
        if (!update.thumbnail && update.links) {
            const firstWithImage = update.links.find(l => l.image);
            if (firstWithImage) update.thumbnail = firstWithImage.image;
        }

        // Only bump updatedAt for meaningful content/audience/monetization changes.
        // Cosmetic changes (description, thumbnail, tags, sourceUrl, mature) do not count.
        let meaningfulChange = false;
        // Separate flag: only link/monetization changes notify grabbers (stricter subset).
        let notifyGrabbers = false;
        if (name !== undefined && name !== current.name) meaningfulChange = true;
        if (visibility !== undefined) {
            const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'private';
            if (vis !== current.visibility) meaningfulChange = true;
        }
        if (monetized !== undefined && !!monetized !== current.isPaywalled) { meaningfulChange = true; notifyGrabbers = true; }
        if (price !== undefined && (Number(price) || 0) !== current.price)  { meaningfulChange = true; notifyGrabbers = true; }
        if (isDraft !== undefined && !!isDraft !== current.isDraft) meaningfulChange = true;
        if (links !== undefined) {
            if (links.length !== current.links.length) {
                meaningfulChange = true; notifyGrabbers = true;
            } else {
                const incomingHrefs = links.map(l => l.url || '').sort().join(',');
                const currentHrefs  = current.links.map(l => l.href).sort().join(',');
                if (incomingHrefs !== currentHrefs) {
                    meaningfulChange = true; notifyGrabbers = true;
                } else {
                    // Same links — check if per-link monetization changed
                    const currentFreeMap = Object.fromEntries(current.links.map(l => [l.href, l.isFree]));
                    for (const l of links) {
                        if (currentFreeMap[l.url || ''] !== !l.monetized) { meaningfulChange = true; notifyGrabbers = true; break; }
                    }
                }
            }
        }

        // Track real content changes (new links, link hrefs changed) as meaningful activity
        // so the explore score activity decay uses an honest signal rather than any edit.
        if (notifyGrabbers) update.lastMeaningfulActivityAt = new Date();

        const bucket = await Bucket.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id },
            update,
            { new: true, timestamps: meaningfulChange }
        );

        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        // Fire new_bucket_published if this update transitions the bucket into public+non-draft
        const wasPublished   = bucketVisibility(current) === 'public' && !current.isDraft;
        const isNowPublished = bucketVisibility(bucket)  === 'public' && !bucket.isDraft;
        if (!wasPublished && isNowPublished) {
            fanOutNewBucketPublished(req.user._id, req.user.username || '', bucket._id, bucket.name);
        }

        // Notify grabbers of content/monetization changes (only if bucket is already public)
        if (notifyGrabbers && isNowPublished) {
            fanOutGrabbedBucketUpdated(bucket, req.user.username || '');
        }

        res.json({ name: bucket.name });
    } catch (error) {
        console.error('Error updating bucket:', error);
        res.status(500).json({ error: 'Failed to update bucket' });
    }
});

// ── User Repos ────────────────────────────────────────────────────────────────

// List all repos for the current user (with per-repo bucket counts + first thumbnail)
router.get('/repos', requireAuth, async (req, res) => {
    try {
        const [repos, counts, thumbs] = await Promise.all([
            UserRepo.find({ userId: req.user._id }).sort({ name: 1 }).lean(),
            Bucket.aggregate([
                { $match: { userId: req.user._id, repoIds: { $exists: true, $ne: [] } } },
                { $unwind: '$repoIds' },
                { $group: { _id: '$repoIds', count: { $sum: 1 } } },
            ]),
            // First non-empty thumbnail per repo (oldest bucket first)
            Bucket.aggregate([
                { $match: { userId: req.user._id, repoIds: { $exists: true, $ne: [] }, thumbnail: { $nin: [null, ''] } } },
                { $sort: { createdAt: 1 } },
                { $unwind: '$repoIds' },
                { $group: { _id: '$repoIds', thumb: { $first: '$thumbnail' } } },
            ]),
        ]);
        const countMap = Object.fromEntries(counts.map(c => [c._id.toString(), c.count]));
        const thumbMap = Object.fromEntries(thumbs.map(t => [t._id.toString(), t.thumb]));
        res.json(repos.map(r => ({
            ...r,
            bucketCount: countMap[r._id.toString()] ?? 0,
            thumb:       thumbMap[r._id.toString()] ?? null,
        })));
    } catch (err) {
        console.error('Error fetching repos:', err);
        res.status(500).json({ error: 'Failed to fetch repos' });
    }
});

// Create a new repo
router.post('/repos', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Repo name is required' });
        }
        const trimmed = name.trim().slice(0, 80);
        const existing = await UserRepo.findOne({ userId: req.user._id, name: trimmed });
        if (existing) return res.status(409).json({ error: 'You already have a repo with that name' });
        const repo = await UserRepo.create({
            userId:      req.user._id,
            name:        trimmed,
            description: String(description || '').slice(0, 256),
        });
        res.status(201).json(repo);
    } catch (err) {
        console.error('Error creating repo:', err);
        res.status(500).json({ error: 'Failed to create repo' });
    }
});

// Rename / update a repo
router.patch('/repos/:id', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name, description } = req.body;
        const update = {};
        if (name !== undefined) {
            const trimmed = String(name).trim().slice(0, 80);
            if (!trimmed) return res.status(400).json({ error: 'Repo name cannot be empty' });
            const conflict = await UserRepo.findOne({ userId: req.user._id, name: trimmed, _id: { $ne: req.params.id } });
            if (conflict) return res.status(409).json({ error: 'You already have a repo with that name' });
            update.name = trimmed;
        }
        if (description !== undefined) update.description = String(description).slice(0, 256);
        const repo = await UserRepo.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id },
            update,
            { new: true }
        );
        if (!repo) return res.status(404).json({ error: 'Repo not found' });
        res.json(repo);
    } catch (err) {
        console.error('Error updating repo:', err);
        res.status(500).json({ error: 'Failed to update repo' });
    }
});

// Delete a repo — its buckets are unassigned, not deleted
router.delete('/repos/:id', requireAuth, async (req, res) => {
    try {
        const repo = await UserRepo.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
        if (!repo) return res.status(404).json({ error: 'Repo not found' });
        await Bucket.updateMany({ userId: req.user._id, repoIds: repo._id }, { $pull: { repoIds: repo._id } });
        res.json({ ok: true });
    } catch (err) {
        console.error('Error deleting repo:', err);
        res.status(500).json({ error: 'Failed to delete repo' });
    }
});

// ── Bucket helpers ────────────────────────────────────────────────────────────

// Get bucket ID by name for sharing
router.get('/buckets/:name/id', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;

        const bucket = await Bucket.findOne({
            userId: req.user._id,
            name
        });

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        res.json({ bucketId: bucket._id.toString(), name: bucket.name, isDraft: !!bucket.isDraft });
    } catch (error) {
        console.error('Error fetching bucket ID:', error);
        res.status(500).json({ error: 'Failed to fetch bucket ID' });
    }
});

// Unarchive a single bucket by ID
router.patch('/buckets/:id/unarchive', requireAuth, requireVerification, async (req, res) => {
    try {
        const bucket = await Bucket.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id },
            { isArchived: false },
            { new: true }
        );
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error unarchiving bucket:', err);
        res.status(500).json({ error: 'Failed to unarchive bucket' });
    }
});

// Bulk archive buckets by ID
router.patch('/buckets/bulk/archive', requireAuth, requireVerification, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
        await Bucket.updateMany({ _id: { $in: ids }, userId: req.user._id }, { isArchived: true });
        res.json({ success: true });
    } catch (err) {
        console.error('Error archiving buckets:', err);
        res.status(500).json({ error: 'Failed to archive buckets' });
    }
});

// Bulk delete buckets by ID
router.delete('/buckets/bulk', requireAuth, requireVerification, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
        const buckets = await Bucket.find({ _id: { $in: ids }, userId: req.user._id }).select('thumbnail links.image');
        await Bucket.deleteMany({ _id: { $in: ids }, userId: req.user._id });
        const imageUrls = buckets.flatMap(b => [b.thumbnail, ...b.links.map(l => l.image)]).filter(Boolean);
        if (imageUrls.length) await deleteR2Images(imageUrls);
        res.json({ success: true });
    } catch (err) {
        console.error('Error bulk deleting buckets:', err);
        res.status(500).json({ error: 'Failed to delete buckets' });
    }
});

// Delete all draft buckets for the current user (called when opening a fresh new-bucket modal)
router.delete('/buckets/drafts', requireAuth, async (req, res) => {
    try {
        const drafts = await Bucket.find({ userId: req.user._id, isDraft: true }).select('thumbnail links.image');
        await Bucket.deleteMany({ userId: req.user._id, isDraft: true });
        const imageUrls = drafts.flatMap(b => [b.thumbnail, ...b.links.map(l => l.image)]).filter(Boolean);
        await deleteR2Images(imageUrls);
        res.json({ ok: true });
    } catch (error) {
        console.error('Error deleting drafts:', error);
        res.status(500).json({ error: 'Failed to delete drafts' });
    }
});

// Delete a bucket (and all its links)
router.delete('/buckets/:name', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;

        if (name === 'Singletons') {
            return res.status(403).json({ error: 'Cannot delete Singletons' });
        }

        const bucket = await Bucket.findOneAndDelete({
            userId: req.user._id,
            name
        });

        if (bucket) {
            const imageUrls = [bucket.thumbnail, ...bucket.links.map(l => l.image)].filter(Boolean);
            await deleteR2Images(imageUrls);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting bucket:', error);
        res.status(500).json({ error: 'Failed to delete bucket' });
    }
});

// Delete a specific link from a bucket
router.delete('/buckets/:name/links', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { href } = req.body;

        if (!href) {
            return res.status(400).json({ error: 'Link href is required' });
        }

        if (name === 'Singletons') {
            return res.status(403).json({ error: 'Cannot delete from Singletons bucket' });
        }

        // Find the bucket
        const bucket = await Bucket.findOne({
            userId: req.user._id,
            name
        });

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        // Remove the link with matching href
        const initialLength = bucket.links.length;
        const removedLink = bucket.links.find(link => link.href === href);
        bucket.links = bucket.links.filter(link => link.href !== href);

        if (bucket.links.length === initialLength) {
            return res.status(404).json({ error: 'Link not found in bucket' });
        }

        // Save the updated bucket
        await bucket.save();

        if (removedLink?.image) await deleteR2Images([removedLink.image]);

        res.json({
            success: true,
            message: 'Link deleted successfully',
            remainingLinks: bucket.links.length
        });
    } catch (error) {
        console.error('Error deleting link from bucket:', error);
        res.status(500).json({ error: 'Failed to delete link' });
    }
});

// Toggle isFree flag on an individual link within a bucket
router.patch('/buckets/:name/links/free', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { href, isFree } = req.body;

        if (!href) {
            return res.status(400).json({ error: 'Link href is required' });
        }
        if (typeof isFree !== 'boolean') {
            return res.status(400).json({ error: 'isFree must be a boolean' });
        }

        const bucket = await Bucket.findOne({ userId: req.user._id, name });
        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        const link = bucket.links.find(l => l.href === href);
        if (!link) {
            return res.status(404).json({ error: 'Link not found in bucket' });
        }

        link.isFree = isFree;
        await bucket.save({ timestamps: false });

        res.json({ success: true, href, isFree });
    } catch (error) {
        console.error('Error updating link free status:', error);
        res.status(500).json({ error: 'Failed to update link free status' });
    }
});

// Update bucket thumbnail
router.put('/buckets/:name/thumbnail', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { thumbnail } = req.body;

        const bucketDoc = await Bucket.findOne({ userId: req.user._id, name }).select('_id');
        if (!bucketDoc) return res.status(404).json({ error: 'Bucket not found' });

        const storedThumbnail = await fetchAndStoreImage(thumbnail || null, { folder: `buckets/${bucketDoc._id}/thumbnail` }) || '';
        const bucket = await Bucket.findByIdAndUpdate(
            bucketDoc._id,
            { thumbnail: storedThumbnail },
            { new: true, timestamps: false }
        );

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        res.json({ success: true, thumbnail: bucket.thumbnail });
    } catch (error) {
        console.error('Error updating thumbnail:', error);
        res.status(500).json({ error: 'Failed to update thumbnail' });
    }
});

// Get bucket thumbnail
router.get('/buckets/:name/thumbnail', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;

        const bucket = await Bucket.findOne({
            userId: req.user._id,
            name
        });

        if (!bucket || !bucket.thumbnail) {
            return res.status(404).json({ error: 'Thumbnail not found' });
        }

        res.json({ thumbnail: bucket.thumbnail });
    } catch (error) {
        console.error('Error fetching thumbnail:', error);
        res.status(500).json({ error: 'Failed to fetch thumbnail' });
    }
});

// Get bucket metadata by name
router.get('/buckets/:name/metadata', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;

        const bucket = await Bucket.findOne({
            userId: req.user._id,
            name
        }).populate('userId', 'username anonymousId');

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        res.json({
            name: bucket.name,
            visibility: bucketVisibility(bucket),
            isPublic: bucket.isPublic,
            isPaywalled: bucket.isPaywalled || false,
            price: bucket.price || 0,
            createdAt: bucket.createdAt,
            updatedAt: bucket.updatedAt,
            linkCount: bucket.links.length,
            grabCount: bucket.grabbedBy?.length ?? 0,
            viewCount: bucket.viewCount || 0,
            shareCount: bucket.shareCount || 0,
            curator: {
                username: bucket.userId.username,
                userId: bucket.userId.anonymousId
            },
        });
    } catch (error) {
        console.error('Error fetching bucket metadata:', error);
        res.status(500).json({ error: 'Failed to fetch bucket metadata' });
    }
});

// Set bucket paywall flag and price
router.post('/buckets/:name/paywall', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { isPaywalled, price } = req.body;

        if (name === 'Singletons') {
            return res.status(403).json({ error: 'Singletons bucket cannot be paywalled' });
        }

        if (typeof isPaywalled !== 'boolean') {
            return res.status(400).json({ error: 'isPaywalled must be a boolean' });
        }

        if (isPaywalled) {
            if (!Number.isInteger(price) || price < 1) {
                return res.status(400).json({ error: 'price must be an integer ≥ 1' });
            }
        }

        const bucket = await Bucket.findOne({ userId: req.user._id, name });

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        bucket.isPaywalled = isPaywalled;
        if (isPaywalled) bucket.price = price;
        await bucket.save();

        res.json({ name: bucket.name, isPaywalled: bucket.isPaywalled, price: bucket.price });
    } catch (error) {
        console.error('Error updating bucket paywall:', error);
        res.status(500).json({ error: 'Failed to update bucket paywall' });
    }
});

// Update bucket visibility (public / unlisted / private)
router.patch('/buckets/:name/visibility', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { visibility } = req.body;

        if (name === 'Singletons') {
            return res.status(403).json({ error: 'Singletons bucket cannot be made public' });
        }

        if (!['public', 'unlisted', 'private'].includes(visibility)) {
            return res.status(400).json({ error: 'visibility must be "public", "unlisted", or "private"' });
        }

        const currentBucket = await Bucket.findOne({ userId: req.user._id, name });
        if (!currentBucket) return res.status(404).json({ error: 'Bucket not found' });
        if (currentBucket.isDraft) {
            return res.status(403).json({ error: 'Publish the bucket before changing its visibility.' });
        }
        if (['public', 'unlisted'].includes(visibility) && currentBucket.links.length < 3) {
            return res.status(400).json({ error: 'A bucket must have at least 3 links to be made public or unlisted.' });
        }

        // new: false → returns the OLD doc so we can detect the publish transition
        const oldBucket = await Bucket.findOneAndUpdate(
            { userId: req.user._id, name },
            { visibility, isPublic: visibility === 'public' },
        );

        if (!oldBucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        const wasPublished = bucketVisibility(oldBucket) === 'public' && !oldBucket.isDraft;
        const isNowPublished = visibility === 'public' && !oldBucket.isDraft;
        if (!wasPublished && isNowPublished) {
            fanOutNewBucketPublished(req.user._id, req.user.username || '', oldBucket._id, oldBucket.name);
        }

        res.json({ name: oldBucket.name, visibility, isPublic: visibility === 'public' });
    } catch (error) {
        console.error('Error updating bucket visibility:', error);
        res.status(500).json({ error: 'Failed to update bucket visibility' });
    }
});

// Lookup a bucket by name, share URL, or ObjectId
router.get('/buckets/snapshots', anonymousAuth, async (req, res) => {
    try {
        const ids = (req.query.ids || '').split(',')
            .map(s => s.trim())
            .filter(id => mongoose.Types.ObjectId.isValid(id))
            .slice(0, 50); // cap to avoid abuse
        if (!ids.length) return res.json({});
        const buckets = await Bucket.find({ _id: { $in: ids } })
            .select('name ratingSum ratingCount grabbedBy')
            .lean();
        const result = {};
        for (const b of buckets) {
            const ratingAvg = b.ratingCount > 0
                ? Math.round((b.ratingSum / b.ratingCount) * 10) / 10
                : null;
            result[String(b._id)] = {
                name:      b.name,
                ratingAvg,
                grabCount: b.grabbedBy?.length ?? 0,
            };
        }
        return res.json(result);
    } catch (err) {
        console.error('[snapshots]', err);
        res.status(500).json({ error: 'Failed' });
    }
});

router.get('/buckets/lookup', requireAuth, requireVerification, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q) {
            return res.status(400).json({ error: 'Query parameter "q" is required' });
        }

        const PAGE_SIZE = 25;
        const skip = Math.max(0, parseInt(req.query.skip) || 0);

        let buckets = [];
        let hasMore = false;

        // 1. Share URL — extract the 24-char hex ID
        const shareMatch = q.match(/\/share\/bucket\/([a-f0-9]{24})/i);
        if (shareMatch) {
            const bucket = await Bucket.findById(shareMatch[1]).populate('userId', 'username anonymousId');
            if (bucket) {
                const isOwner = bucket.userId._id.equals(req.user._id);
                if (isOwner || bucketVisibility(bucket) !== 'private') buckets = [bucket];
            }
        }

        // 2. Raw ObjectId
        if (!buckets.length && /^[a-f0-9]{24}$/i.test(q)) {
            const bucket = await Bucket.findById(q).populate('userId', 'username anonymousId');
            if (bucket) {
                const isOwner = bucket.userId._id.equals(req.user._id);
                if (isOwner || bucketVisibility(bucket) !== 'private') buckets = [bucket];
            }
        }

        // 3. Name search — only publicly discoverable buckets (public, not unlisted)
        if (!buckets.length) {
            const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            buckets = await Bucket.find({
                name: new RegExp(escaped, 'i'),
                $or: [{ userId: req.user._id }, ...FILTER_PUBLIC.$or]
            }).skip(skip).limit(PAGE_SIZE + 1).populate('userId', 'username anonymousId');

            if (buckets.length > PAGE_SIZE) {
                hasMore = true;
                buckets = buckets.slice(0, PAGE_SIZE);
            }
        }

        if (!buckets.length) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        const grabCounts = buckets.map(bucket => bucket.grabbedBy?.length ?? 0);

        const formattedBuckets = await Promise.all(buckets.map(async (bucket, i) => {
            const isOwner = bucket.userId._id.equals(req.user._id);
            let links = bucket.links;
            let hasAccess = isOwner;
            let hiddenCount = 0;
            const totalLinkCount = bucket.links.length;

            if (bucket.isPaywalled && !isOwner) {
                const access = await BucketAccess.findOne({ userId: req.user._id, bucketId: bucket._id });
                hasAccess = !!access;
                if (!hasAccess) {
                    const freeLinks = bucket.links.filter(l => l.isFree);
                    hiddenCount = bucket.links.length - freeLinks.length;
                    links = freeLinks;
                }
            }

            return {
                _id: bucket._id,
                name: bucket.name,
                visibility: bucketVisibility(bucket),
                isPublic: bucket.isPublic,
                isPaywalled: bucket.isPaywalled || false,
                price: bucket.price || 0,
                hasAccess,
                hiddenCount,
                totalLinkCount,
                links,
                sourceUrl: bucket.sourceUrl,
                thumbnail: bucket.thumbnail,
                createdAt: bucket.createdAt,
                updatedAt: bucket.updatedAt,
                grabCount: grabCounts[i],
                viewCount: bucket.viewCount || 0,
                shareCount: bucket.shareCount || 0,
                curator: {
                    username: bucket.userId.username,
                    userId: bucket.userId.anonymousId
                },
                isOwner
            };
        }));

        res.json({ hasMore, buckets: formattedBuckets });
    } catch (error) {
        console.error('Error looking up bucket:', error);
        res.status(500).json({ error: 'Failed to lookup bucket' });
    }
});

// Save a bucket to the current user's grabbed collection
router.post('/buckets/grab', requireAuth, requireVerification, async (req, res) => {
    try {
        const { sourceBucketId } = req.body;

        if (!sourceBucketId) {
            return res.status(400).json({ error: 'sourceBucketId is required' });
        }

        const bucket = await Bucket.findById(sourceBucketId).select('+topic allowGrabs').populate('userId', 'username anonymousId');
        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        // Only public buckets can be grabbed
        if (bucketVisibility(bucket) !== 'public') {
            return res.status(403).json({ error: 'Only public buckets can be grabbed' });
        }

        // Enforce grab permission
        const isOwner = bucket.userId._id.equals(req.user._id);
        if (!isOwner) {
            const grabPerm = bucket.allowGrabs;
            const normalizedGrabPerm = (grabPerm === false || grabPerm === 'false') ? 'no_one'
                : (grabPerm === true || grabPerm === 'true' || !grabPerm) ? 'everyone'
                : grabPerm;
            if (normalizedGrabPerm === 'no_one') {
                return res.status(403).json({ error: 'The curator has disabled grabs on this bucket.' });
            }
            if (normalizedGrabPerm === 'followers') {
                const isSub = await Subscription.exists({ followerId: req.user._id, followeeId: bucket.userId._id });
                if (!isSub) return res.status(403).json({ error: 'Only followers can grab this bucket.' });
            }
            if (normalizedGrabPerm === 'followees') {
                const isSub = await Subscription.exists({ followerId: bucket.userId._id, followeeId: req.user._id });
                if (!isSub) return res.status(403).json({ error: 'Only people this curator follows can grab this bucket.' });
            }
        }

        // Paywalled buckets require the user to have unlocked them first
        if (bucket.isPaywalled) {
            if (!isOwner) {
                const access = await BucketAccess.findOne({ userId: req.user._id, bucketId: bucket._id });
                if (!access) {
                    return res.status(403).json({ error: 'Unlock this bucket before grabbing it' });
                }
            }
        }

        // Check if already grabbed
        const alreadyGrabbed = bucket.grabbedBy?.some(g => g.userId.toString() === req.user._id.toString());
        if (alreadyGrabbed) {
            return res.status(409).json({ error: 'You already have this bucket in your collection' });
        }

        await Bucket.findByIdAndUpdate(bucket._id, {
            $push: { grabbedBy: { userId: req.user._id, username: req.user.username || '', avatar: req.user.avatar || '', grabbedAt: new Date() } }
        }, { timestamps: false });

        addGuestPoints(req.user, bucket.topic ?? null, GUEST_PTS.grab);

        // Notify the curator (skip self-grabs)
        if (!bucket.userId._id.equals(req.user._id)) {
            const _bgData = { grabberId: req.user._id, grabberUsername: req.user.username || '', bucketId: bucket._id, bucketName: bucket.name };
            User.findById(bucket.userId._id).select('notificationPrefs').lean()
              .then(owner => {
                  if (owner?.notificationPrefs?.bucket_grabbed === false) return null;
                  return Notification.create({ userId: bucket.userId._id, type: 'bucket_grabbed', data: _bgData });
              })
              .then(n => {
                  if (!n) return;
                  pushNotification(bucket.userId._id, { type: 'new_notification', notification: n });
                  maybeSendNotificationEmail(bucket.userId._id, 'bucket_grabbed', _bgData).catch(() => {});
              })
              .catch(err => console.error('[notif] bucket_grabbed:', err));
        }

        res.status(201).json({ bucket: { _id: bucket._id, name: bucket.name } });
    } catch (error) {
        console.error('Error grabbing bucket:', error);
        res.status(500).json({ error: 'Failed to grab bucket' });
    }
});

// Remove a bucket from the current user's grabbed collection
router.delete('/buckets/grab/:sourceBucketId', requireAuth, requireVerification, async (req, res) => {
    try {
        const { sourceBucketId } = req.params;

        await Bucket.findByIdAndUpdate(sourceBucketId, {
            $pull: { grabbedBy: { userId: req.user._id } }
        }, { timestamps: false });

        res.json({ success: true });
    } catch (error) {
        console.error('Error ungrabbing bucket:', error);
        res.status(500).json({ error: 'Failed to ungrab bucket' });
    }
});

// Record a view for a bucket
router.post('/buckets/:id/view', requireAuth, requireVerification, async (req, res) => {
    try {
        const bucket = await Bucket.findById(req.params.id).select('_id userId topic').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        if (!bucket.userId.equals(req.user._id)) {
            await trackBucketView(bucket._id, req.user._id, null);
            addGuestPoints(req.user, bucket.topic ?? null, GUEST_PTS.pageVisit);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error recording view:', error);
        res.status(500).json({ error: 'Failed to record view' });
    }
});

// Record a share for a bucket — counts once per user per bucket, forever.
// The unique index on BucketShare makes duplicate inserts fail silently (race-condition-safe).
router.post('/buckets/:id/share', requireAuth, requireVerification, async (req, res) => {
    try {
        const bucket = await Bucket.findById(req.params.id).select('_id userId topic').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        if (bucket.userId.equals(req.user._id)) {
            return res.json({ success: true }); // owner sharing their own bucket doesn't count
        }

        try {
            await BucketShare.create({ bucketId: bucket._id, userId: req.user._id });
            await Bucket.findByIdAndUpdate(bucket._id, { $inc: { shareCount: 1 } }, { timestamps: false });
            addGuestPoints(req.user, bucket.topic ?? null, GUEST_PTS.share);
        } catch (err) {
            if (err.code !== 11000) throw err; // 11000 = duplicate key — user already shared, skip silently
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error recording share:', error);
        res.status(500).json({ error: 'Failed to record share' });
    }
});

// Not interested in a bucket.
// Tracks per-user skips (for feed filtering) and increments skipCount (for score penalty).
// Trust & safety categories also file a soft report in the background.
router.post('/buckets/:id/not-interested', async (req, res) => {
    try {
        const { category, reason } = req.body;

        const validCategories = ['not-relevant', 'low-quality', 'trust-safety', 'already-in-feed'];
        if (!category || !validCategories.includes(category)) {
            return res.status(400).json({ error: 'Invalid category' });
        }

        const bucket = await Bucket.findById(req.params.id).select('_id userId').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        const userId = (req.user && !req.user.isAnonymous) ? req.user._id : null;
        const ip     = req.ip;

        // Deduplicate: one skip per user/IP per bucket
        const existingSkip = userId
            ? await BucketSkip.exists({ bucketId: bucket._id, userId })
            : await BucketSkip.exists({ bucketId: bucket._id, ip });

        if (!existingSkip) {
            await BucketSkip.create({ bucketId: bucket._id, userId, ip: userId ? null : ip, category, reason: reason || null });
            await Bucket.findByIdAndUpdate(bucket._id, { $inc: { skipCount: 1 } }, { timestamps: false });
        }

        // Trust & safety reasons also file a soft report (fire-and-forget)
        if (category === 'trust-safety' && userId) {
            const reportReason = reason === 'spam' ? 'spam' : 'inappropriate';
            Report.create({ bucketId: bucket._id, userId, reason: reportReason, detail: `via not-interested: ${reason || ''}` }).catch(() => {});
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error recording not-interested:', error);
        res.status(500).json({ error: 'Failed to record' });
    }
});

// Rate a bucket (1–3 stars)
// Gate: user must have grabbed the bucket AND clicked at least 2 links from it.
router.post('/buckets/:bucketId/rate', requireAuth, requireVerification, async (req, res) => {
    try {
        const { bucketId } = req.params;
        const stars = Number(req.body.stars);

        if (![1, 2, 3].includes(stars)) {
            return res.status(400).json({ error: 'stars must be 1, 2, or 3' });
        }

        // Must have grabbed the bucket
        const ratedBucket = await Bucket.findById(bucketId).select('grabbedBy').lean();
        const grabbed = ratedBucket?.grabbedBy?.some(g => g.userId.toString() === req.user._id.toString());
        if (!grabbed) {
            return res.status(403).json({ error: 'Grab this bucket before rating it' });
        }

        // Must have clicked at least 2 links from it
        const clickCount = await LinkClick.countDocuments({ bucketId, userId: req.user._id });
        if (clickCount < 2) {
            return res.status(403).json({ error: 'Explore at least 2 links before rating' });
        }

        // Upsert: adjust ratingSum by the delta if re-rating
        const existing = await BucketRating.findOne({ bucketId, userId: req.user._id }).select('stars').lean();
        if (existing) {
            const delta = stars - existing.stars;
            await Promise.all([
                BucketRating.updateOne({ bucketId, userId: req.user._id }, { $set: { stars } }),
                Bucket.findByIdAndUpdate(bucketId, { $inc: { ratingSum: delta } }, { timestamps: false })
            ]);
        } else {
            await Promise.all([
                BucketRating.create({ bucketId, userId: req.user._id, stars }),
                Bucket.findByIdAndUpdate(bucketId, { $inc: { ratingSum: stars, ratingCount: 1 } }, { timestamps: false })
            ]);
        }

        res.json({ ok: true, stars });
    } catch (err) {
        console.error('Error rating bucket:', err);
        res.status(500).json({ error: 'Failed to save rating' });
    }
});

// Report a bucket
router.post('/buckets/:id/report', requireAuth, requireVerification, async (req, res) => {
    try {
        const { reason, detail } = req.body;
        const validReasons = ['spam', 'malicious', 'inappropriate', 'copyright', 'mature_content', 'other'];

        if (!reason || !validReasons.includes(reason)) {
            return res.status(400).json({ error: 'Invalid report reason' });
        }

        const bucket = await Bucket.findById(req.params.id);
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        if (bucket.userId.equals(req.user._id)) {
            return res.status(403).json({ error: 'Cannot report your own bucket' });
        }

        await Report.create({
            reporterId: req.user._id,
            bucketId: req.params.id,
            reason,
            detail: detail ? String(detail).slice(0, 500) : ''
        });

        res.json({ success: true });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ error: 'You have already reported this bucket' });
        }
        console.error('Error reporting bucket:', error);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// Report a user
router.post('/users/:userId/report', requireAuth, requireVerification, async (req, res) => {
    try {
        const { reason, detail } = req.body;
        const validReasons = ['spam', 'malicious', 'inappropriate', 'harassment', 'other'];
        if (!reason || !validReasons.includes(reason))
            return res.status(400).json({ error: 'Invalid report reason' });

        if (!mongoose.Types.ObjectId.isValid(req.params.userId))
            return res.status(400).json({ error: 'Invalid user ID' });

        const target = await User.findById(req.params.userId);
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (target._id.equals(req.user._id))
            return res.status(403).json({ error: 'Cannot report yourself' });

        await Report.create({
            reporterId:     req.user._id,
            reportedUserId: target._id,
            reason,
            detail: detail ? String(detail).slice(0, 500) : '',
        });

        res.json({ success: true });
    } catch (err) {
        if (err.code === 11000)
            return res.status(409).json({ error: 'You have already reported this user' });
        console.error('Error reporting user:', err);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// Return paginated link data for a single owned bucket (used by the edit modal)
router.get('/buckets/:id/edit', requireAuth, requireVerification, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id))
            return res.status(400).json({ error: 'Invalid bucket id' });
        const b = await Bucket.findOne({ _id: req.params.id, userId: req.user._id })
            .select('name description thumbnail visibility isPublic isPaywalled price links._id viewCount shareCount grabbedBy sourceUrl hashtags mature isDraft allowComments allowGrabs repoIds bucketOwningId')
            .lean();
        if (!b) return res.status(404).json({ error: 'Bucket not found' });
        res.json({
            _id:            String(b._id),
            name:           b.name,
            description:    b.description || '',
            thumbnail:      b.thumbnail   || null,
            visibility:     b.visibility  || (b.isPublic ? 'public' : 'private'),
            isPublic:       b.isPublic,
            isPaywalled:    b.isPaywalled || false,
            price:          b.price       || 0,
            hashtags:       b.hashtags    || [],
            mature:         !!b.mature,
            isDraft:        !!b.isDraft,
            allowComments:  b.allowComments  || 'everyone',
            allowGrabs:     b.allowGrabs     || 'everyone',
            sourceUrl:      b.sourceUrl      || '',
            repoIds:        (b.repoIds || []).map(String),
            bucketOwningId: b.bucketOwningId || null,
            viewCount:      b.viewCount      || 0,
            shareCount:     b.shareCount     || 0,
            grabbedBy:      b.grabbedBy      || [],
            links:          b.links          || [],
        });
    } catch (err) {
        console.error('Error fetching bucket for edit:', err);
        res.status(500).json({ error: 'Failed to fetch bucket' });
    }
});

router.get('/buckets/:id/links', requireAuth, requireVerification, async (req, res) => {
    try {
        const skip  = Math.max(0, parseInt(req.query.skip)  || 0);
        const limit = Math.min(256, Math.max(1, parseInt(req.query.limit) || 256));
        const [result] = await Bucket.aggregate([
            { $match: { _id: new mongoose.Types.ObjectId(req.params.id), userId: req.user._id } },
            { $project: { total: { $size: '$links' }, links: { $slice: ['$links', skip, limit] } } },
        ]);
        if (!result) return res.status(404).json({ error: 'Not found' });
        const links = result.links || [];
        res.json({ links, total: result.total || 0, hasMore: skip + links.length < result.total });
    } catch (err) {
        console.error('Error fetching bucket links:', err);
        res.status(500).json({ error: 'Failed to fetch links' });
    }
});

// Get all links for current user
router.get('/links', requireAuth, requireVerification, async (req, res) => {
    try {
        const buckets = await Bucket.find({ userId: req.user._id })
            .select('name sourceUrl links.href links.text links.image links.duration links.isFree links.clickCount links.isPinned')
            .lean();

        const linksMap = new Map();
        buckets.forEach(bucket => {
            (bucket.links || []).forEach(link => {
                const key = link.href;
                if (!linksMap.has(key)) {
                    linksMap.set(key, {
                        href: link.href,
                        text: link.text,
                        image: link.image || null,
                        duration: link.duration,
                        isFree: link.isFree || false,
                        clickCount: link.clickCount || 0,
                        isPinned: link.isPinned || false,
                        sourceUrl: bucket.sourceUrl || '',
                        buckets: [bucket.name],
                    });
                } else {
                    linksMap.get(key).buckets.push(bucket.name);
                }
            });
        });

        res.json(Array.from(linksMap.values()));
    } catch (error) {
        console.error('Error fetching links:', error);
        res.status(500).json({ error: 'Failed to fetch links' });
    }
});

// Check which hrefs already exist in any of the user's buckets
router.post('/links/check-duplicates', requireAuth, requireVerification, async (req, res) => {
    try {
        const { hrefs } = req.body;
        if (!Array.isArray(hrefs) || hrefs.length === 0) {
            return res.status(400).json({ error: 'hrefs array is required' });
        }

        const buckets = await Bucket.find(
            { userId: req.user._id, 'links.href': { $in: hrefs } },
            'name links.href'
        ).lean();

        const duplicates = {};
        for (const href of hrefs) {
            const inBuckets = buckets
                .filter(b => b.links.some(l => l.href === href))
                .map(b => b.name);
            if (inBuckets.length > 0) duplicates[href] = inBuckets;
        }

        return res.json({ duplicates });
    } catch (err) {
        console.error('check-duplicates error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Add links to bucket(s)
router.post('/links', requireAuth, requireVerification, async (req, res) => {
    try {
        const { links, buckets = [] } = req.body;

        if (!Array.isArray(links) || links.length === 0) {
            return res.status(400).json({ error: 'Links array is required' });
        }

        const { ok, blocked } = await validateLinks(links.map(l => l.href || ''));
        if (!ok) return res.status(400).json({ error: 'One or more links were rejected for safety reasons', blocked });

        if (buckets.length === 0) {
            return res.status(400).json({ error: 'At least one bucket is required' });
        }

        // Block links that are registered and monetized by another user
        const hrefs = links.map(l => l.href);
        const existingRegs = await RegisteredLink.find({ url: { $in: hrefs } }).lean();
        const regMap = new Map(existingRegs.map(r => [r.url, r]));

        const blockedByRegistration = [];
        const allowedLinks = [];

        for (const link of links) {
            const reg = regMap.get(link.href);
            if (!reg || reg.registeredBy.toString() === req.user._id.toString()) {
                allowedLinks.push(link);
            } else {
                const isMonetized = await Bucket.exists({
                    userId: reg.registeredBy,
                    isPaywalled: true,
                    'links.href': link.href
                });
                if (isMonetized) {
                    blockedByRegistration.push({ href: link.href, registrantUsername: reg.registrantUsername });
                } else {
                    allowedLinks.push(link);
                }
            }
        }

        if (blockedByRegistration.length > 0 && allowedLinks.length === 0) {
            return res.status(403).json({
                error: 'These links are registered and monetized by another creator',
                blockedByRegistration
            });
        }

        // Filter out 'Singletons' from buckets
        // const realBuckets = buckets.filter(b => b !== 'Singletons');

        const realBuckets = buckets;

        // if (realBuckets.length === 0) {
        //     return res.status(400).json({ error: 'Cannot add to Singletons bucket' });
        // }

        const results = [];

        for (const bucketName of realBuckets) {
            // Find or create bucket
            let bucket = await Bucket.findOne({
                userId: req.user._id,
                name: bucketName
            });

            if (!bucket) {
                bucket = await Bucket.create({
                    userId: req.user._id,
                    name: bucketName,
                    links: []
                });
            }

            // Convert all new link images to base64 in parallel (avoids hotlink failures later)
            const newLinks = await Promise.all(
                allowedLinks
                    .filter(link => !bucket.links.some(l => l.href === link.href))
                    .map(async link => ({
                        href:     link.href,
                        text:     link.text || '',
                        duration: link.duration || '',
                        image:    await fetchAndStoreImage(link.image || null, { folder: `buckets/${bucket._id}/links` }) ?? (link.image?.startsWith('http') ? link.image : null),
                    }))
            );
            if (newLinks.length > 0) {
                if (bucket.links.length + newLinks.length > 256) {
                    results.push({ bucket: bucketName, error: 'Bucket is at the 256-link limit' });
                    continue;
                }
                bucket.links.push(...newLinks);
                bucket.lastMeaningfulActivityAt = new Date();
            }

            // Auto-set bucket thumbnail from first link image if not already set
            if (!bucket.thumbnail) {
                const firstWithImage = bucket.links.find(l => l.image);
                if (firstWithImage) bucket.thumbnail = firstWithImage.image;
            }

            // Update sourceUrl if provided
            if (allowedLinks[0]?.sourceUrl && !bucket.sourceUrl) {
                bucket.sourceUrl = allowedLinks[0].sourceUrl;
            }

            await bucket.save({ timestamps: newLinks.length > 0 });
            results.push(bucket);
        }

        const response = { results };
        if (blockedByRegistration.length > 0) response.blockedByRegistration = blockedByRegistration;
        res.status(201).json(response);
    } catch (error) {
        console.error('Error adding links:', error);
        res.status(500).json({ error: 'Failed to add links' });
    }
});

// Get registration status for a set of URLs (current user only)
router.get('/registered-links', requireAuth, async (req, res) => {
    try {
        const hrefs = String(req.query.hrefs || '').split(',').map(s => s.trim()).filter(Boolean);
        if (hrefs.length === 0) return res.json({ registeredByMe: [] });
        const regs = await RegisteredLink.find({ url: { $in: hrefs }, registeredBy: req.user._id }).select('url').lean();
        res.json({ registeredByMe: regs.map(r => r.url) });
    } catch (error) {
        console.error('Error fetching registered links:', error);
        res.status(500).json({ error: 'Failed to fetch registered links' });
    }
});

// Register a link — intentional ownership claim
router.post('/registered-links', requireAuth, requireVerification, async (req, res) => {
    try {
        const { href } = req.body;
        if (!href) return res.status(400).json({ error: 'href is required' });

        const ownsLink = await Bucket.exists({ userId: req.user._id, 'links.href': href });
        if (!ownsLink) return res.status(403).json({ error: 'You can only register links that are in one of your buckets' });

        const existing = await RegisteredLink.findOne({ url: href }).lean();
        if (existing) {
            if (existing.registeredBy.toString() === req.user._id.toString()) {
                return res.status(409).json({ error: 'You have already registered this link' });
            }
            return res.status(409).json({ error: 'This link is already registered by another user', registrantUsername: existing.registrantUsername });
        }

        const reg = await RegisteredLink.create({
            url:                href,
            registeredBy:       req.user._id,
            registrantUsername: req.user.username
        });
        res.status(201).json({ url: reg.url, registrantUsername: reg.registrantUsername, status: reg.status });
    } catch (error) {
        console.error('Error registering link:', error);
        res.status(500).json({ error: 'Failed to register link' });
    }
});

// Drop a link registration
router.delete('/registered-links', requireAuth, requireVerification, async (req, res) => {
    try {
        const { href } = req.body;
        if (!href) return res.status(400).json({ error: 'href is required' });

        const reg = await RegisteredLink.findOne({ url: href });
        if (!reg) return res.status(404).json({ error: 'This link is not registered' });
        if (reg.registeredBy.toString() !== req.user._id.toString()) {
            return res.status(403).json({ error: 'You can only drop registrations you own' });
        }
        if (reg.status === 'disputed') {
            return res.status(403).json({ error: 'Cannot drop a registration while it is under review' });
        }

        await reg.deleteOne();
        res.json({ success: true });
    } catch (error) {
        console.error('Error dropping link registration:', error);
        res.status(500).json({ error: 'Failed to drop registration' });
    }
});

// Clear all links (delete all buckets)
router.delete('/links', requireAuth, requireVerification, async (req, res) => {
    try {
        const buckets = await Bucket.find({ userId: req.user._id }).select('thumbnail links.image');
        await Bucket.deleteMany({ userId: req.user._id });
        const imageUrls = buckets.flatMap(b => [b.thumbnail, ...b.links.map(l => l.image)]).filter(Boolean);
        await deleteR2Images(imageUrls);
        res.json({ success: true });
    } catch (error) {
        console.error('Error clearing links:', error);
        res.status(500).json({ error: 'Failed to clear links' });
    }
});

// ---------------------------------------------------------------------------
// Link click tracking — fire-and-forget, always returns 204
// ---------------------------------------------------------------------------
router.post('/links/click', async (req, res) => {
    res.sendStatus(204); // respond immediately, don't block the user
    try {
        const { href, bucketId } = req.body;
        if (!href || !bucketId) return;

        let domain;
        try { domain = new URL(href).hostname; } catch { return; }

        const [, bucket] = await Promise.all([
            LinkClick.create({ href, domain, bucketId, userId: req.user?._id ?? null }),
            Bucket.findOneAndUpdate(
                { _id: bucketId, 'links.href': href },
                { $inc: { 'links.$.clickCount': 1 } },
                { timestamps: false, new: false, select: 'topic' }
            ),
        ]);

        addGuestPoints(req.user, bucket?.topic ?? null, GUEST_PTS.linkClick);
    } catch (err) {
        console.error('LinkClick record error:', err);
    }
});

// ---------------------------------------------------------------------------
// Guest session point tracking
// ---------------------------------------------------------------------------
// Point weights
const GUEST_PTS = { grab: 4, share: 5, pageVisit: 1, linkClick: 0.5 };
const WARM_THRESHOLD    = 10;   // points needed to transition to warm start
const ACTIVE_CAP_MIN    = 360;  // 6 hours of combined active time — reset if exceeded without warmth
const IDLE_CUTOFF_MIN   = 30;   // gaps longer than this aren't counted as active time

/**
 * Fire-and-forget — update a user's guest recommendation session after any engagement event.
 * @param {Object} user     - req.user (may be anonymous or registered)
 * @param {string} topic    - domain topic of the bucket they engaged with (may be null)
 * @param {number} pts      - point weight for this action
 */
async function addGuestPoints(user, topic, pts) {
    if (!user?._id) return;
    try {
        const now  = new Date();
        const u    = await User.findById(user._id).select('guestSession').lean();
        if (!u) return;

        const gs = u.guestSession || {};

        // Compute elapsed active time since last event (ignore idle gaps > IDLE_CUTOFF_MIN)
        let deltaMinutes = 0;
        if (gs.lastActiveAt) {
            const idleMinutes = (now - new Date(gs.lastActiveAt)) / 60000;
            if (idleMinutes < IDLE_CUTOFF_MIN) deltaMinutes = idleMinutes;
        }

        const newPoints       = (gs.points       || 0) + pts;
        const newActiveMinutes = (gs.activeMinutes || 0) + deltaMinutes;

        // If the 6h active budget is exhausted without reaching warm, reset the session
        if (!gs.warmStart && newActiveMinutes > ACTIVE_CAP_MIN && newPoints < WARM_THRESHOLD) {
            await User.updateOne({ _id: user._id }, {
                $set: {
                    'guestSession.points':           0,
                    'guestSession.activeMinutes':    0,
                    'guestSession.topicEngagements': [],
                    'guestSession.inferredTopic':    null,
                    'guestSession.lastActiveAt':     now,
                    'guestSession.warmStart':        false
                }
            });
            return;
        }

        // Update per-topic engagement tally
        const engagements = [...(gs.topicEngagements || [])];
        if (topic) {
            const entry = engagements.find(e => e.domain === topic);
            if (entry) entry.pts += pts;
            else engagements.push({ domain: topic, pts });
        }

        // inferredTopic = domain with most accumulated pts
        const inferredTopic = engagements.length
            ? engagements.reduce((best, e) => e.pts > best.pts ? e : best).domain
            : (gs.inferredTopic || null);

        const warmStart = gs.warmStart || newPoints >= WARM_THRESHOLD;

        await User.updateOne({ _id: user._id }, {
            $set: {
                'guestSession.points':           newPoints,
                'guestSession.activeMinutes':    newActiveMinutes,
                'guestSession.topicEngagements': engagements,
                'guestSession.inferredTopic':    inferredTopic,
                'guestSession.lastActiveAt':     now,
                'guestSession.warmStart':        warmStart
            }
        });
    } catch (err) {
        console.error('[guestSession] update error:', err);
    }
}

// ---------------------------------------------------------------------------
// V2 API — showroom feed (personalized for logged-in users, public fallback)
// ---------------------------------------------------------------------------
router.get('/showroom', anonymousAuth, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip  = (page - 1) * limit;

        let buckets;
        let isPersonalized = false;

        const muteFilter = {};
        if (req.user?._id && !req.user.isAnonymous) {
            const mt = req.user.mutedTags   || [];
            const mp = req.user.mutedTopics || [];
            if (mt.length) muteFilter.hashtags = { $nin: mt };
            if (mp.length) muteFilter.topic    = { $nin: mp };
        }

        if (req.user?._id && !req.user.isAnonymous) {
            // Resolve followed curator IDs
            const subs = await Subscription.find({ followerId: req.user._id }).select('followeeId').lean();
            const followedIds = subs.map(s => s.followeeId);

            // Find grabbed buckets and when the user grabbed them, to surface updates since then
            const grabbedBuckets = await Bucket.find({
                'grabbedBy.userId': req.user._id
            }).select('_id grabbedBy').lean();
            // Only surface a grabbed bucket if it was updated after the user grabbed it
            const updatedGrabbedConditions = grabbedBuckets.map(b => {
                const entry = b.grabbedBy.find(g => g.userId.toString() === req.user._id.toString());
                return { _id: b._id, updatedAt: { $gt: entry?.grabbedAt || new Date(0) } };
            });

            if (followedIds.length > 0 || updatedGrabbedConditions.length > 0) {
                isPersonalized = true;
                const orClauses = [];
                if (followedIds.length > 0)              orClauses.push({ userId: { $in: followedIds } });
                if (updatedGrabbedConditions.length > 0) orClauses.push(...updatedGrabbedConditions);
                buckets = await Bucket.find({
                    $or: orClauses,
                    ...FILTER_PUBLIC,
                    isDraft: { $ne: true },
                    name:    { $ne: 'Singletons' },
                    ...muteFilter
                })
                    .sort({ updatedAt: -1 })
                    .skip(skip)
                    .limit(limit + 1)
                    .populate('userId', 'username anonymousId avatar')
                    .select('name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags');
            }
        }

        // Topic-based feed for anonymous/guest users
        if (!isPersonalized && req.user?.isAnonymous) {
            isPersonalized = true;
            const gs            = req.user.guestSession || {};
            const BUCKET_SELECT = 'name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags topic';
            const BASE_FILTER   = { ...FILTER_PUBLIC, isDraft: { $ne: true }, name: { $ne: 'Singletons' } };

            if (gs.warmStart && gs.inferredTopic) {
                // Warm start — user has revealed a topic preference.
                // Reserve 1 slot per page for a discovery bucket from the second-best topic.
                const mainLimit = limit - 1;
                const secondTopic = await TopicScore.findOne({ domain: { $ne: gs.inferredTopic } })
                    .sort({ score: -1 }).lean();

                const [mainBuckets, discoveryBucket] = await Promise.all([
                    Bucket.find({ topic: gs.inferredTopic, ...BASE_FILTER })
                        .sort({ exploreScore: -1 })
                        .skip(skip)
                        .limit(mainLimit + 1)
                        .populate('userId', 'username anonymousId avatar')
                        .select(BUCKET_SELECT),
                    secondTopic
                        ? Bucket.findOne({ topic: secondTopic.domain, ...BASE_FILTER })
                            .sort({ exploreScore: -1 })
                            .skip(skip % 10) // gentle variety across pages
                            .populate('userId', 'username anonymousId avatar')
                            .select(BUCKET_SELECT)
                        : Promise.resolve(null)
                ]);

                const hasMoreMain = mainBuckets.length > mainLimit;
                const mainItems   = hasMoreMain ? mainBuckets.slice(0, mainLimit) : mainBuckets;
                buckets = discoveryBucket ? [...mainItems, discoveryBucket] : mainItems;
                // Reuse hasMore from main stream
                buckets._hasMore = hasMoreMain;
            } else {
                // Cold start — show the best performing topic this week
                const bestTopic = await TopicScore.findOne({ bucketCount: { $gte: 3 } })
                    .sort({ score: -1 }).lean();

                if (bestTopic) {
                    buckets = await Bucket.find({ topic: bestTopic.domain, ...BASE_FILTER })
                        .sort({ exploreScore: -1 })
                        .skip(skip)
                        .limit(limit + 1)
                        .populate('userId', 'username anonymousId avatar')
                        .select(BUCKET_SELECT);
                }

                // Fallback if no topic scores exist yet — sort by exploreScore globally
                if (!buckets || buckets.length === 0) {
                    buckets = await Bucket.find(BASE_FILTER)
                        .sort({ exploreScore: -1 })
                        .skip(skip)
                        .limit(limit + 1)
                        .populate('userId', 'username anonymousId avatar')
                        .select(BUCKET_SELECT);
                }
            }
        }

        // Fallback for logged-in users with no follows/grabs yet
        if (!isPersonalized) {
            buckets = await Bucket.find({ ...FILTER_PUBLIC, isDraft: { $ne: true }, name: { $ne: 'Singletons' }, ...muteFilter })
                .sort({ exploreScore: -1 })
                .skip(skip)
                .limit(limit + 1)
                .populate('userId', 'username anonymousId avatar')
                .select('name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags');
        }

        // Warm-start path sets _hasMore on the array itself to avoid over-slicing
        // the mixed main+discovery result. All other paths use the +1 sentinel trick.
        const hasMore = buckets._hasMore ?? (buckets.length > limit);
        const items   = buckets._hasMore  ? buckets : (hasMore ? buckets.slice(0, limit) : buckets);

        // Build grabbed set for current user
        let grabbedSet = new Set();
        if (req.user?._id && !req.user.isAnonymous) {
            const grabs = await Bucket.find({
                _id:               { $in: items.map(b => b._id) },
                'grabbedBy.userId': req.user._id
            }).select('_id').lean();
            grabs.forEach(g => grabbedSet.add(String(g._id)));
        }

        // Build follow set for current user
        const curatorIds = [...new Set(items.map(b => b.userId?._id).filter(Boolean))];
        let followedSet = new Set();
        if (req.user?._id && !req.user.isAnonymous) {
            const subs = await Subscription.find({
                followerId: req.user._id,
                followeeId: { $in: curatorIds },
            }).select('followeeId').lean();
            subs.forEach(s => followedSet.add(String(s.followeeId)));
        }

        const bucketCounts = await Bucket.aggregate([
            { $match: { userId: { $in: curatorIds }, ...FILTER_PUBLIC, name: { $ne: 'Singletons' } } },
            { $group: { _id: '$userId', count: { $sum: 1 } } }
        ]);
        const bucketCountMap = Object.fromEntries(bucketCounts.map(r => [String(r._id), r.count]));

        res.json({
            hasMore,
            buckets: items.map(b => ({
                _id:         b._id,
                name:        b.name,
                thumbnail:   b.thumbnail || b.links.find(l => l.image)?.image || '',
                linkCount:   b.links.length,
                isPaywalled: b.isPaywalled || false,
                price:       b.price || 0,
                viewCount:   b.viewCount   || 0,
                shareCount:  b.shareCount  || 0,
                ratingSum:   b.ratingSum   || 0,
                ratingCount: b.ratingCount || 0,
                createdAt:   b.createdAt,
                updatedAt:   b.updatedAt,
                description: b.description || '',
                hashtags:    b.hashtags    || [],
                isGrabbed:   grabbedSet.has(String(b._id)),
                grabCount:   (b.grabbedBy || []).length,
                grabbers:    (b.grabbedBy || [])
                    .slice(-4)
                    .map(g => ({ username: g.username || '?', avatar: g.avatar || '' })),
                curator: {
                    username:    b.userId?.username    || 'Unknown',
                    userId:      b.userId?.anonymousId || '',
                    avatar:      b.userId?.avatar      || '',
                    bucketCount: bucketCountMap[String(b.userId?._id)] || 0,
                    isFollowing: followedSet.has(String(b.userId?._id))
                }
            }))
        });
    } catch (err) {
        console.error('Showroom feed error:', err);
        res.status(500).json({ error: 'Failed to load showroom' });
    }
});

// ---------------------------------------------------------------------------
// Subscriptions — follow / unfollow a curator
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// V2 API — explore feed (scored + personalized, paginated)
// ---------------------------------------------------------------------------
router.get('/explore', anonymousAuth, async (req, res) => {
    try {
        const limit      = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip       = Math.max(0, parseInt(req.query.skip)  || 0);
        const excludeIds = (req.query.excludeIds || '').split(',').filter(Boolean).slice(0, 200);

        // Phase 1: fetch candidates sorted by pre-computed exploreScore
        const exploreMuteFilter = {};
        if (req.user?._id && !req.user.isAnonymous) {
            const mt = req.user.mutedTags   || [];
            const mp = req.user.mutedTopics || [];
            if (mt.length) exploreMuteFilter.hashtags = { $nin: mt };
            if (mp.length) exploreMuteFilter.topic    = { $nin: mp };
        }

        const candidates = await Bucket.find({
            ...FILTER_PUBLIC,
            isDraft:     { $ne: true },
            isPaywalled: { $ne: true },
            name:        { $ne: 'Singletons' },
            thumbnail:   { $exists: true, $ne: '' },
            ...exploreMuteFilter
        })
            .sort({ exploreScore: -1 })
            .skip(skip)
            .limit(limit * 5)
            .populate('userId', 'username anonymousId avatar privacy')
            .select('name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags exploreScore')
            .lean();

        // Strip buckets from private/unlisted accounts before further processing
        const visibleCandidates = candidates.filter(b => !['private', 'unlisted'].includes(b.userId?.privacy?.accountVisibility));

        // Phase 2: filter out buckets already shown to this user in the last 2h,
        // and buckets the user has explicitly skipped (never show again).
        const impressionFilter = req.user?._id
            ? { userId: req.user._id }
            : req.user?.anonymousId
                ? { anonymousId: req.user.anonymousId }
                : null;

        const clientExcluded = new Set(excludeIds.map(String));

        let unseenCandidates = visibleCandidates;
        if (impressionFilter) {
            const [seen, skipped] = await Promise.all([
                FeedImpression.find(impressionFilter).select('bucketId').lean(),
                req.user?._id
                    ? BucketSkip.find({ userId: req.user._id }).select('bucketId').lean()
                    : Promise.resolve([])
            ]);
            const seenIds    = new Set(seen.map(i => String(i.bucketId)));
            const skippedIds = new Set(skipped.map(s => String(s.bucketId)));
            unseenCandidates = visibleCandidates.filter(b =>
                !seenIds.has(String(b._id)) && !skippedIds.has(String(b._id)) && !clientExcluded.has(String(b._id))
            );
        } else if (clientExcluded.size) {
            unseenCandidates = visibleCandidates.filter(b => !clientExcluded.has(String(b._id)));
        }

        // Phase 3: personalize for authenticated non-anonymous users
        let scored = unseenCandidates;

        if (req.user?._id && !req.user.isAnonymous) {
            // Signal A: hashtag overlap with grabbed buckets
            const grabbedBuckets = await Bucket.find({
                'grabbedBy.userId': req.user._id
            }).select('hashtags').lean();
            const userHashtags = new Set(grabbedBuckets.flatMap(b => b.hashtags || []));

            // Signal B: domain affinity — domains clicked in the last 30 days
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const domainClicks = await LinkClick.aggregate([
                { $match: { userId: req.user._id, createdAt: { $gte: thirtyDaysAgo } } },
                { $group: { _id: '$domain', clicks: { $sum: 1 } } }
            ]);
            const domainAffinityMap = Object.fromEntries(domainClicks.map(d => [d._id, d.clicks]));

            // Signal C: social proximity — followed curator IDs
            const subs = await Subscription.find({ followerId: req.user._id }).select('followeeId').lean();
            const followedIds = new Set(subs.map(s => String(s.followeeId)));

            scored = candidates.map(b => {
                let score = b.exploreScore || 0;

                // Signal A: hashtag overlap ×1.5 per matching tag
                const tagOverlap = (b.hashtags || []).filter(t => userHashtags.has(t)).length;
                score *= 1 + (tagOverlap * 0.5);

                // Signal B: domain affinity +0.4 per recent click on matching domain
                const bucketDomains = (b.links || []).map(l => {
                    try { return new URL(l.href).hostname; } catch { return null; }
                }).filter(Boolean);
                const affinityBoost = bucketDomains.reduce((acc, d) => acc + (domainAffinityMap[d] || 0) * 0.4, 0);
                score += affinityBoost;

                // Signal C: social proximity ×1.3 if grabbed by someone you follow
                const grabbedByFollowed = (b.grabbedBy || []).some(g => followedIds.has(String(g.userId)));
                if (grabbedByFollowed) score *= 1.3;

                return { ...b, _personalizedScore: score };
            });

            scored.sort((a, b) => (b._personalizedScore || 0) - (a._personalizedScore || 0));
        }

        // Phase 4: jitter — shift rankings between refreshes
        const JITTER = 0.35;
        scored = scored
            .map(b => ({
                ...b,
                _jitteredScore: (b._personalizedScore ?? b.exploreScore ?? 0) * (1 - JITTER + Math.random() * JITTER * 2)
            }))
            .sort((a, b) => b._jitteredScore - a._jitteredScore);

        // Phase 5: diversity caps — prevent feed from being dominated by one curator or topic
        const MAX_PER_CURATOR = 2;
        const MAX_PER_TOPIC   = 3;
        const curatorCount = {};
        const topicCount   = {};
        const diverse = [];
        for (const b of scored) {
            const curatorKey = String(b.userId?._id || b.userId);
            const topicKey   = b.topic || '__none__';
            if ((curatorCount[curatorKey] || 0) >= MAX_PER_CURATOR) continue;
            if (topicKey !== '__none__' && (topicCount[topicKey] || 0) >= MAX_PER_TOPIC) continue;
            diverse.push(b);
            curatorCount[curatorKey] = (curatorCount[curatorKey] || 0) + 1;
            topicCount[topicKey]     = (topicCount[topicKey]     || 0) + 1;
            if (diverse.length >= limit + 1) break;
        }

        const items   = diverse.slice(0, limit);
        const hasMore = diverse.length > limit;

        // Build grabbed set for current user
        let grabbedSet = new Set();
        if (req.user?._id && !req.user.isAnonymous) {
            const grabs = await Bucket.find({
                _id:               { $in: items.map(b => b._id) },
                'grabbedBy.userId': req.user._id
            }).select('_id').lean();
            grabs.forEach(g => grabbedSet.add(String(g._id)));
        }

        // Build follow set for current user
        const curatorIds = [...new Set(items.map(b => b.userId?._id).filter(Boolean))];
        let followedSet = new Set();
        if (req.user?._id && !req.user.isAnonymous) {
            const subs = await Subscription.find({
                followerId: req.user._id,
                followeeId: { $in: curatorIds }
            }).select('followeeId').lean();
            subs.forEach(s => followedSet.add(String(s.followeeId)));
        }

        // Bucket counts per curator
        const bucketCounts = await Bucket.aggregate([
            { $match: { userId: { $in: curatorIds }, ...FILTER_PUBLIC, name: { $ne: 'Singletons' } } },
            { $group: { _id: '$userId', count: { $sum: 1 } } }
        ]);
        const bucketCountMap = Object.fromEntries(bucketCounts.map(r => [String(r._id), r.count]));

        res.json({
            hasMore,
            buckets: items.map(b => ({
                _id:         b._id,
                name:        b.name,
                thumbnail:   b.thumbnail || (b.links || []).find(l => l.image)?.image || '',
                linkCount:   (b.links || []).length,
                isPaywalled: b.isPaywalled || false,
                price:       b.price || 0,
                viewCount:   b.viewCount   || 0,
                shareCount:  b.shareCount  || 0,
                ratingSum:   b.ratingSum   || 0,
                ratingCount: b.ratingCount || 0,
                createdAt:   b.createdAt,
                updatedAt:   b.updatedAt,
                description: b.description || '',
                hashtags:    b.hashtags    || [],
                isGrabbed:   grabbedSet.has(String(b._id)),
                grabCount:   (b.grabbedBy || []).length,
                grabbers:    (b.grabbedBy || [])
                    .slice(-4)
                    .map(g => ({ username: g.username || '?', avatar: g.avatar || '' })),
                curator: {
                    username:    b.userId?.username    || 'Unknown',
                    userId:      b.userId?.anonymousId || '',
                    avatar:      b.userId?.avatar      || '',
                    bucketCount: bucketCountMap[String(b.userId?._id)] || 0,
                    isFollowing: followedSet.has(String(b.userId?._id))
                }
            }))
        });

        // Record impressions for returned buckets (fire-and-forget, don't block response)
        if (impressionFilter && items.length) {
            const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours
            FeedImpression.insertMany(
                items.map(b => ({ ...impressionFilter, bucketId: b._id, expiresAt })),
                { ordered: false }
            ).catch(() => {}); // swallow errors — impressions are best-effort
        }
    } catch (err) {
        console.error('Explore feed error:', err);
        res.status(500).json({ error: 'Failed to load explore feed' });
    }
});

// ---------------------------------------------------------------------------
// V2 API — named explore rows (promoted / paywalled / new / revisit)
// ---------------------------------------------------------------------------

const EXPLORE_ROW_SELECT = 'name thumbnail links isPaywalled isPromoted price viewCount shareCount ratingSum ratingCount createdAt userId grabbedBy';

function parseExcludeIds(raw) {
    return (raw || '').split(',').filter(Boolean).slice(0, 200);
}

function formatExploreRow(buckets, grabbedSet) {
    return buckets.map(b => ({
        _id:         b._id,
        name:        b.name,
        thumbnail:   b.thumbnail || (b.links || []).find(l => l.image)?.image || '',
        linkCount:   (b.links || []).length,
        isPaywalled: b.isPaywalled || false,
        isPromoted:  b.isPromoted  || false,
        price:       b.price       || 0,
        viewCount:   b.viewCount   || 0,
        shareCount:  b.shareCount  || 0,
        ratingSum:   b.ratingSum   || 0,
        ratingCount: b.ratingCount || 0,
        isGrabbed:   grabbedSet.has(String(b._id)),
        grabCount:   (b.grabbedBy || []).length,
        grabbers:    (b.grabbedBy || []).slice(-4).map(g => ({ username: g.username || '?', avatar: g.avatar || '' })),
        curator: {
            username: b.userId?.username    || 'Unknown',
            userId:   b.userId?.anonymousId || '',
            avatar:   b.userId?.avatar      || '',
            bucketCount: 0,
            isFollowing: false
        }
    }));
}

async function buildGrabbedSet(buckets, userId) {
    if (!userId || !buckets.length) return new Set();
    const grabs = await Bucket.find({
        _id: { $in: buckets.map(b => b._id) },
        'grabbedBy.userId': userId
    }).select('_id').lean();
    return new Set(grabs.map(g => String(g._id)));
}

// Promoted row
router.get('/explore/promoted', anonymousAuth, async (req, res) => {
    try {
        const excludeIds = parseExcludeIds(req.query.excludeIds);
        const buckets = await Bucket.find({
            ...FILTER_PUBLIC,
            isPromoted: true,
            isDraft:    { $ne: true },
            thumbnail:  { $exists: true, $ne: '' },
            ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {})
        })
            .sort({ exploreScore: -1 })
            .limit(9)
            .populate('userId', 'username anonymousId avatar privacy')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const visibleBuckets = buckets.filter(b => !['private', 'unlisted'].includes(b.userId?.privacy?.accountVisibility));
        const grabbedSet = await buildGrabbedSet(visibleBuckets, req.user?._id);
        res.json({ buckets: formatExploreRow(visibleBuckets, grabbedSet) });
    } catch (err) {
        console.error('Explore promoted row error:', err);
        res.status(500).json({ error: 'Failed to load promoted row' });
    }
});

// Paywalled row — excludes promoted buckets to avoid overlap
router.get('/explore/paywalled', anonymousAuth, async (req, res) => {
    try {
        const excludeIds = parseExcludeIds(req.query.excludeIds);
        const buckets = await Bucket.find({
            ...FILTER_PUBLIC,
            isPaywalled: true,
            isPromoted:  { $ne: true },
            isDraft:     { $ne: true },
            thumbnail:   { $exists: true, $ne: '' },
            ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {})
        })
            .sort({ exploreScore: -1 })
            .limit(9)
            .populate('userId', 'username anonymousId avatar privacy')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const visibleBuckets = buckets.filter(b => !['private', 'unlisted'].includes(b.userId?.privacy?.accountVisibility));
        const grabbedSet = await buildGrabbedSet(visibleBuckets, req.user?._id);
        res.json({ buckets: formatExploreRow(visibleBuckets, grabbedSet) });
    } catch (err) {
        console.error('Explore paywalled row error:', err);
        res.status(500).json({ error: 'Failed to load paywalled row' });
    }
});

// New row — sorted by creation date
router.get('/explore/new', anonymousAuth, async (req, res) => {
    try {
        const excludeIds = parseExcludeIds(req.query.excludeIds);
        const buckets = await Bucket.find({
            ...FILTER_PUBLIC,
            isDraft:   { $ne: true },
            thumbnail: { $exists: true, $ne: '' },
            ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {})
        })
            .sort({ createdAt: -1 })
            .limit(9)
            .populate('userId', 'username anonymousId avatar privacy')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const visibleBuckets = buckets.filter(b => !['private', 'unlisted'].includes(b.userId?.privacy?.accountVisibility));
        const grabbedSet = await buildGrabbedSet(visibleBuckets, req.user?._id);
        res.json({ buckets: formatExploreRow(visibleBuckets, grabbedSet) });
    } catch (err) {
        console.error('Explore new row error:', err);
        res.status(500).json({ error: 'Failed to load new row' });
    }
});

// Revisit row — buckets the user viewed but never grabbed (logged-in only)
router.get('/explore/revisit', anonymousAuth, async (req, res) => {
    try {
        if (!req.user?._id || req.user.isAnonymous) return res.json({ buckets: [] });

        const excludeIds = parseExcludeIds(req.query.excludeIds);
        const views      = await BucketView.find({ userId: req.user._id }).select('bucketId').lean();
        const viewedIds  = views.map(v => v.bucketId);
        if (!viewedIds.length) return res.json({ buckets: [] });

        const buckets = await Bucket.find({
            ...FILTER_PUBLIC,
            _id:                { $in: viewedIds, ...(excludeIds.length ? { $nin: excludeIds } : {}) },
            'grabbedBy.userId': { $ne: req.user._id },
            isDraft:            { $ne: true },
            thumbnail:          { $exists: true, $ne: '' }
        })
            .sort({ exploreScore: -1 })
            .limit(9)
            .populate('userId', 'username anonymousId avatar')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const grabbedSet = await buildGrabbedSet(buckets, req.user._id);
        res.json({ buckets: formatExploreRow(buckets, grabbedSet) });
    } catch (err) {
        console.error('Explore revisit row error:', err);
        res.status(500).json({ error: 'Failed to load revisit row' });
    }
});

// Subscribe to a curator (identified by their anonymousId)
router.post('/users/:anonymousId/subscribe', requireAuth, requireVerification, async (req, res) => {
    try {
        if (req.user.privacy?.accountVisibility === 'private')
            return res.status(403).json({ error: 'Private accounts cannot follow others' });

        const curator = await User.findOne({ anonymousId: req.params.anonymousId });
        if (!curator) return res.status(404).json({ error: 'Curator not found' });
        if (curator._id.equals(req.user._id)) return res.status(400).json({ error: 'Cannot subscribe to yourself' });
        if (curator.privacy?.accountVisibility === 'private')
            return res.status(403).json({ error: 'Cannot follow a private account' });

        await Subscription.create({ followerId: req.user._id, followeeId: curator._id });

        // Delete any previous follow notification from this same person before inserting a fresh one
        if (curator.notificationPrefs?.new_follower !== false) {
            const _nfData = { followerId: req.user._id, followerAnonymousId: req.user.anonymousId || '', followerUsername: req.user.username || '', followerAvatar: req.user.avatar || '' };
            Notification.findOneAndDelete({ userId: curator._id, type: 'new_follower', 'data.followerId': req.user._id })
                .then(() => Notification.create({ userId: curator._id, type: 'new_follower', data: _nfData }))
                .then(n => {
                    pushNotification(curator._id, { type: 'new_notification', notification: n });
                    maybeSendNotificationEmail(curator._id, 'new_follower', _nfData).catch(() => {});
                })
                .catch(err => console.error('[notif] new_follower:', err));
        }

        res.status(201).json({ success: true });
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'Already subscribed' });
        console.error('Subscribe error:', err);
        res.status(500).json({ error: 'Failed to subscribe' });
    }
});

// Unsubscribe from a curator
router.delete('/users/:anonymousId/subscribe', requireAuth, requireVerification, async (req, res) => {
    try {
        const curator = await User.findOne({ anonymousId: req.params.anonymousId });
        if (!curator) return res.status(404).json({ error: 'Curator not found' });

        await Subscription.findOneAndDelete({ followerId: req.user._id, followeeId: curator._id });
        res.json({ success: true });
    } catch (err) {
        console.error('Unsubscribe error:', err);
        res.status(500).json({ error: 'Failed to unsubscribe' });
    }
});

// Get subscription status + follower count for a curator
router.get('/users/:anonymousId/subscribe', requireAuth, requireVerification, async (req, res) => {
    try {
        const curator = await User.findOne({ anonymousId: req.params.anonymousId });
        if (!curator) return res.status(404).json({ error: 'Curator not found' });

        const [isSubscribed, followerCount] = await Promise.all([
            Subscription.exists({ followerId: req.user._id, followeeId: curator._id }),
            Subscription.countDocuments({ followeeId: curator._id })
        ]);

        res.json({ isSubscribed: !!isSubscribed, followerCount });
    } catch (err) {
        console.error('Subscription status error:', err);
        res.status(500).json({ error: 'Failed to fetch subscription status' });
    }
});

router.get('/repositories', anonymousAuth, async (req, res) => {
    try {
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip  = Math.max(0, parseInt(req.query.skip)  || 0);

        // Fetch full cache — personalization is done in JS, not at DB query level
        const allRepos = await Repository.find().lean();

        // ── Anonymous users: pure global popularity ──────────────────────────
        if (!req.user || req.user.isAnonymous) {
            allRepos.sort((a, b) => b.totalClicks - a.totalClicks);
            const page    = allRepos.slice(skip, skip + limit + 1);
            const hasMore = page.length > limit;
            const items   = hasMore ? page.slice(0, limit) : page;
            await enrichReposWithBucketThumbnails(items);
            return res.json({ hasMore, repositories: items });
        }

        // ── Logged-in users: personalised scoring ────────────────────────────
        const userId = req.user._id;
        const cutoff = new Date(Date.now() - 90 * 86_400_000); // 90-day window

        // Run all lookups in parallel
        const [domainClicks, subscriptions, userBuckets, skippedRepos] = await Promise.all([
            // Signal 1 — direct affinity: domains this user has clicked recently
            LinkClick.aggregate([
                { $match: { userId, createdAt: { $gte: cutoff } } },
                { $group: { _id: '$domain', count: { $sum: 1 } } }
            ]),
            // Signal 2 — subscription: curators this user follows
            Subscription.find({ followerId: userId }).select('followeeId').lean(),
            // Signal 3 — tag affinity: hashtags on the user's own public buckets
            Bucket.find({ userId, isDraft: false }).select('hashtags').lean(),
            // Signal 4 — skipped repos: never show these again
            RepoSkip.find({ userId }).select('domain tag').lean()
        ]);

        // domain → click count  (direct affinity map)
        const affinityMap   = Object.fromEntries(domainClicks.map(d => [d._id, d.count]));
        // set of subscribed curator _id strings (for O(1) lookup)
        const subscribedIds = new Set(subscriptions.map(s => String(s.followeeId)));
        // set of hashtags the user has used across their own buckets
        const userTags      = new Set(userBuckets.flatMap(b => b.hashtags || []));
        // set of "domain::tag" pairs the user dismissed
        const skippedKeys   = new Set(skippedRepos.map(s => `${s.domain}::${s.tag}`));

        // Score every non-skipped repo
        const hasPreferences = affinityMap.size > 0 || userTags.size > 0 || subscribedIds.size > 0;

        const relevant  = [];
        const popular   = [];

        for (const repo of allRepos) {
            if (skippedKeys.has(`${repo.domain}::${repo.tag}`)) continue;

            const affinityScore     = (affinityMap[repo.domain] || 0) * 3;
            const tagScore          = userTags.has(repo.tag) ? 4 : 0;
            const subLinkCount      = repo.topLinks.filter(
                l => l.curatorId && subscribedIds.has(String(l.curatorId))
            ).length;
            const subscriptionScore = subLinkCount * 5;
            const popularityScore   = Math.log(repo.totalClicks + 1) * 0.5;
            const totalScore        = affinityScore + tagScore + subscriptionScore + popularityScore;

            const scored = { ...repo, _score: totalScore };

            // If user has preferences, only show repos with at least one matching signal.
            // If no preferences yet, everything goes into "relevant" (sorted by popularity).
            if (!hasPreferences || affinityScore > 0 || tagScore > 0 || subscriptionScore > 0) {
                relevant.push(scored);
            } else {
                popular.push(scored);
            }
        }

        relevant.sort((a, b) => b._score - a._score);
        popular.sort((a, b) => b._score - a._score);

        // Merge: relevant first, then popular repos as padding
        const scored = [...relevant, ...popular];

        const page    = scored.slice(skip, skip + limit + 1);
        const hasMore = page.length > limit;
        const items   = (hasMore ? page.slice(0, limit) : page)
            .map(({ _score, ...repo }) => repo); // strip internal field before sending

        await enrichReposWithBucketThumbnails(items);
        res.json({ hasMore, repositories: items });
    } catch (err) {
        console.error('Repositories endpoint error:', err);
        res.status(500).json({ error: 'Failed to load repositories' });
    }
});

// ---------------------------------------------------------------------------
// V2 API — single repository detail by domain + tag
// ---------------------------------------------------------------------------
router.get('/repositories/:domain/:tag', anonymousAuth, async (req, res) => {
    try {
        const { domain, tag } = req.params;

        // Escape domain for use in a regex (dots etc.)
        const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const domainPattern = new RegExp(`^https?://(www\\.)?${escapedDomain}`, 'i');

        const [repo, topBuckets] = await Promise.all([
            Repository.findOne({ domain, tag }).lean(),
            // Buckets tagged with `tag` that contain at least one link from `domain`
            Bucket.find({
                hashtags:      tag,
                visibility:    'public',
                isDraft:       false,
                'links.href':  domainPattern
            })
            .sort({ exploreScore: -1 })
            .limit(12)
            .select('_id name description thumbnail links grabbedBy viewCount userId')
            .populate('userId', 'username avatar')
            .lean()
        ]);

        if (!repo)                       return res.status(404).json({ error: 'Repository not found' });
        if (topBuckets.length < 1)       return res.status(404).json({ error: 'Repository not found' });
        res.json({ ...repo, topBuckets });
    } catch (err) {
        console.error('Repository detail error:', err);
        res.status(500).json({ error: 'Failed to load repository' });
    }
});

// ---------------------------------------------------------------------------
// V2 API — mark a (domain, tag) repo as not interested
// ---------------------------------------------------------------------------
router.post('/repositories/:domain/:tag/not-interested', anonymousAuth, async (req, res) => {
    try {
        const { domain, tag } = req.params;
        const userId = req.user && !req.user.isAnonymous ? req.user._id : null;
        const ip     = userId ? null : (req.headers['x-forwarded-for'] || req.ip);

        await RepoSkip.updateOne(
            { domain, tag, ...(userId ? { userId } : { ip }) },
            { $setOnInsert: { domain, tag, userId, ip } },
            { upsert: true }
        );

        res.json({ ok: true });
    } catch (err) {
        console.error('Repo not-interested error:', err);
        res.status(500).json({ error: 'Failed to record skip' });
    }
});

const USERNAME_LIMITS = [
    { count: 2, windowMs: 24 * 60 * 60 * 1000,      label: 'daily'   },
    { count: 3, windowMs: 7  * 24 * 60 * 60 * 1000, label: 'weekly'  },
    { count: 4, windowMs: 30 * 24 * 60 * 60 * 1000, label: 'monthly' },
];

// Returns { blocked: true, availableAt: Date } or { blocked: false }
function checkUsernameRateLimit(user) {
    const now = Date.now();
    const log = (user.usernameChangeLog || []).map(d => new Date(d).getTime());
    for (const { count, windowMs } of USERNAME_LIMITS) {
        const inWindow = log.filter(t => now - t < windowMs).sort((a, b) => a - b);
        if (inWindow.length >= count) {
            return { blocked: true, availableAt: new Date(inWindow[0] + windowMs) };
        }
    }
    return { blocked: false };
}

const EMAIL_CHANGE_LIFETIME_LIMIT = 3;
const EMAIL_LIMITS = [
    { count: 1, windowMs: 24 * 60 * 60 * 1000,      label: 'daily'   },
    { count: 2, windowMs: 7  * 24 * 60 * 60 * 1000, label: 'weekly'  },
    { count: 3, windowMs: 30 * 24 * 60 * 60 * 1000, label: 'monthly' },
];
const EMAIL_REUSE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function checkEmailRateLimit(user) {
    const now = Date.now();
    const log = (user.emailChangeLog || []).map(d => new Date(d).getTime());
    for (const { count, windowMs } of EMAIL_LIMITS) {
        const inWindow = log.filter(t => now - t < windowMs).sort((a, b) => a - b);
        if (inWindow.length >= count) {
            return { blocked: true, availableAt: new Date(inWindow[0] + windowMs) };
        }
    }
    return { blocked: false };
}


// PATCH /api/user/username
router.patch('/user/username', requireAuth, async (req, res) => {
    try {
        const { username } = req.body;
        if (!username?.trim()) return res.status(400).json({ error: 'Username is required' });
        const trimmed = username.trim();
        if (trimmed.length < 3 || trimmed.length > 20) return res.status(400).json({ error: 'Username must be 3–20 characters' });
        if (!/^[a-zA-Z0-9]+$/.test(trimmed)) return res.status(400).json({ error: 'Username may only contain letters and numbers' });
        if (trimmed.toLowerCase() === req.user.username?.toLowerCase()) return res.status(400).json({ error: 'This is already your username' });
        const rateLimit = checkUsernameRateLimit(req.user);
        if (rateLimit.blocked) {
            const formatted = rateLimit.availableAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            return res.status(429).json({ error: `You've hit a username change limit. Try again on ${formatted}.` });
        }
        const isAdmin = ['moderator', 'superadmin'].includes(req.user.role);
        const roleFilter = isAdmin ? { role: { $in: ['moderator', 'superadmin'] } } : { role: 'user' };
        const taken = await User.findOne({ username: new RegExp(`^${trimmed}$`, 'i'), _id: { $ne: req.user._id }, ...roleFilter });
        if (taken) return res.status(409).json({ error: 'This username is already taken' });
        const now = new Date();
        const pruned = (req.user.usernameChangeLog || []).filter(d => now - new Date(d).getTime() < 30 * 24 * 60 * 60 * 1000);
        pruned.push(now);
        await User.findByIdAndUpdate(req.user._id, { username: trimmed, usernameChangeLog: pruned });
        res.json({ ok: true, username: trimmed });
    } catch (err) {
        console.error('Username update error:', err);
        res.status(500).json({ error: 'Failed to update username' });
    }
});

// PATCH /api/user/password
router.patch('/user/password', requireAuth, requireVerification, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required' });
        const user = await User.findById(req.user._id).select('+password');
        if (!user) return res.status(404).json({ error: 'User not found' });
        const valid = await user.comparePassword(currentPassword);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        if ((newPassword.match(/[a-z]/g) || []).length < 2) return res.status(400).json({ error: 'Password must contain at least 2 lowercase letters' });
        if ((newPassword.match(/[A-Z]/g) || []).length < 2) return res.status(400).json({ error: 'Password must contain at least 2 uppercase letters' });
        if ((newPassword.match(/[0-9]/g) || []).length < 2) return res.status(400).json({ error: 'Password must contain at least 2 digits' });
        if ((newPassword.match(/[^a-zA-Z0-9]/g) || []).length < 2) return res.status(400).json({ error: 'Password must contain at least 2 special characters' });
        user.password = newPassword;
        user.passwordChangedAt = new Date();
        await user.save();
        res.json({ ok: true });
    } catch (err) {
        console.error('Password update error:', err);
        res.status(500).json({ error: 'Failed to update password' });
    }
});

// PATCH /api/user/bio
router.patch('/user/bio', requireAuth, async (req, res) => {
    try {
        const bio = (req.body.bio ?? '').trim();
        if (bio.length > 128) return res.status(400).json({ error: 'Bio must be 128 characters or fewer' });
        await User.findByIdAndUpdate(req.user._id, { bio });
        res.json({ ok: true, bio });
    } catch (err) {
        console.error('Bio update error:', err);
        res.status(500).json({ error: 'Failed to update bio' });
    }
});

// PATCH /api/user/display-name
router.patch('/user/display-name', requireAuth, async (req, res) => {
    try {
        const raw = (req.body.displayName ?? '').trim();
        if (raw === '') {
            await User.findByIdAndUpdate(req.user._id, { displayName: '' });
            return res.json({ ok: true, displayName: '' });
        }
        if (!/^[a-zA-Z ]+$/.test(raw)) return res.status(400).json({ error: 'Display name may only contain letters' });
        if (raw.length > 30) return res.status(400).json({ error: 'Display name may not exceed 30 characters' });
        const displayName = raw.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
        await User.findByIdAndUpdate(req.user._id, { displayName });
        res.json({ ok: true, displayName });
    } catch (err) {
        console.error('Display name update error:', err);
        res.status(500).json({ error: 'Failed to update display name' });
    }
});

// PATCH /api/user/language
const VALID_LANGUAGES = new Set([
    'en','es','fr','de','pt','it','nl','ru','ja','zh','ko','ar','hi','tr','pl','sv','no','da','fi','id',
]);
router.patch('/user/language', requireAuth, async (req, res) => {
    try {
        const language = (req.body.language ?? '').trim();
        if (!VALID_LANGUAGES.has(language)) return res.status(400).json({ error: 'Invalid language' });
        await User.findByIdAndUpdate(req.user._id, { language });
        res.json({ ok: true, language });
    } catch (err) {
        console.error('Language update error:', err);
        res.status(500).json({ error: 'Failed to update language' });
    }
});
// PATCH /api/user/category
const VALID_CATEGORIES = new Set(['', ..._categoriesJson.categories.map(c => c.value), ..._categoriesJson.adultCategories.map(c => c.value)]);
const ADULT_CATEGORIES = new Set(_categoriesJson.adultCategories.map(c => c.value));

// POST /api/user/muted-tags — add a single muted tag
const MUTED_TAG_RE = /^[a-z0-9_-]{1,30}$/;
router.post('/user/muted-tags', requireAuth, requireVerification, async (req, res) => {
    try {
        const raw = (req.body.tag ?? '').trim().toLowerCase().replace(/^#+/, '');
        if (!MUTED_TAG_RE.test(raw)) return res.status(400).json({ error: 'Invalid tag. Use letters, numbers, - and _ only (max 30 chars).' });
        const user = await User.findById(req.user._id).select('mutedTags');
        if ((user.mutedTags || []).length >= 50) return res.status(400).json({ error: 'You can mute up to 50 tags.' });
        if ((user.mutedTags || []).includes(raw)) return res.json({ ok: true, tag: raw });
        await User.findByIdAndUpdate(req.user._id, { $addToSet: { mutedTags: raw } });
        res.json({ ok: true, tag: raw });
    } catch (err) {
        console.error('Muted tags add error:', err);
        res.status(500).json({ error: 'Failed to mute tag' });
    }
});

// DELETE /api/user/muted-tags/:tag — remove a single muted tag
router.delete('/user/muted-tags/:tag', requireAuth, requireVerification, async (req, res) => {
    try {
        const tag = (req.params.tag ?? '').trim().toLowerCase().replace(/^#+/, '');
        await User.findByIdAndUpdate(req.user._id, { $pull: { mutedTags: tag } });
        res.json({ ok: true });
    } catch (err) {
        console.error('Muted tags remove error:', err);
        res.status(500).json({ error: 'Failed to unmute tag' });
    }
});

// PATCH /api/user/muted-topics — replace the full muted-topics list
router.patch('/user/muted-topics', requireAuth, requireVerification, async (req, res) => {
    try {
        const topics = Array.isArray(req.body.topics) ? req.body.topics : [];
        const invalid = topics.filter(t => !VALID_CATEGORIES.has(t) || t === '');
        if (invalid.length) return res.status(400).json({ error: 'Invalid topic value(s)' });
        await User.findByIdAndUpdate(req.user._id, { mutedTopics: topics });
        res.json({ ok: true });
    } catch (err) {
        console.error('Muted topics update error:', err);
        res.status(500).json({ error: 'Failed to update muted topics' });
    }
});
router.patch('/user/category', requireAuth, async (req, res) => {
    try {
        const category = (req.body.category ?? '').trim();
        if (!VALID_CATEGORIES.has(category)) return res.status(400).json({ error: 'Invalid category' });
        if (ADULT_CATEGORIES.has(category) && req.user.isMatureGated) return res.status(403).json({ error: 'Disable the mature filter to select an adult category' });
        await User.findByIdAndUpdate(req.user._id, { category });
        res.json({ ok: true, category });
    } catch (err) {
        console.error('Category update error:', err);
        res.status(500).json({ error: 'Failed to update category' });
    }
});

// PATCH /api/user/links
const URL_SHORTENER_HOSTS = new Set([
    'bit.ly','tinyurl.com','t.co','ow.ly','goo.gl','buff.ly','short.link','tiny.cc',
    'is.gd','v.gd','rb.gy','cutt.ly','shorturl.at','clck.ru','rebrand.ly','bl.ink',
    'lnkd.in','snip.ly','soo.gd','adf.ly','bit.do','tr.im','cli.gs','yfrog.com',
    'migre.me','ff.im','url4.eu','twitthis.com','su.pr','twurl.nl','youtu.be',
]);
const PLATFORM_DOMAINS = {
    twitter:   ['twitter.com','x.com'],
    github:    ['github.com'],
    instagram: ['instagram.com'],
    linkedin:  ['linkedin.com'],
    youtube:   ['youtube.com','youtu.be'],
    tiktok:    ['tiktok.com'],
    facebook:  ['facebook.com','fb.com'],
    discord:   ['discord.gg','discord.com'],
    twitch:    ['twitch.tv'],
    bluesky:   ['bsky.app','bsky.social'],
    other:     null,
    // adult — only available when isMatureGated is false
    onlyfans:  ['onlyfans.com'],
    fansly:    ['fansly.com'],
    fanvue:    ['fanvue.com'],
    pornhub:   ['pornhub.com'],
};
const ADULT_PLATFORMS = new Set(['onlyfans','fansly','fanvue','pornhub']);
function validateLinkUrl(url, platform = null) {
    if (!url) return null; // empty is allowed
    let u;
    try { u = new URL(url); } catch { return 'Enter a valid URL.'; }
    if (u.protocol !== 'https:') return 'Links must use HTTPS.';
    const host = u.hostname.replace(/^www\./, '');
    if (URL_SHORTENER_HOSTS.has(host)) return 'URL shorteners are not allowed.';
    if (platform && platform !== 'other') {
        const allowed = PLATFORM_DOMAINS[platform];
        if (allowed) {
            const match = allowed.some(d => host === d || host.endsWith('.' + d));
            if (!match) return `Must be a valid ${platform} link (${allowed.join(' or ')}).`;
        }
    }
    return null;
}
router.patch('/user/links', requireAuth, async (req, res) => {
    try {
        const website     = (req.body.website ?? '').trim();
        const rawSocials  = Array.isArray(req.body.socialLinks) ? req.body.socialLinks : [];
        const websiteErr  = validateLinkUrl(website);
        if (websiteErr) return res.status(400).json({ error: websiteErr });
        if (rawSocials.length > 3) return res.status(400).json({ error: 'Max 3 social links' });
        const socialLinks = [];
        for (const s of rawSocials) {
            const platform = (s.platform ?? '').trim();
            const url      = (s.url ?? '').trim();
            if (!PLATFORM_DOMAINS.hasOwnProperty(platform)) return res.status(400).json({ error: 'Invalid platform' });
            if (ADULT_PLATFORMS.has(platform) && req.user.isMatureGated !== false) return res.status(403).json({ error: 'Disable the mature content filter to add this platform' });
            const urlErr = validateLinkUrl(url, platform);
            if (urlErr) return res.status(400).json({ error: urlErr });
            socialLinks.push({ platform, url });
        }
        await User.findByIdAndUpdate(req.user._id, { website, socialLinks });
        res.json({ ok: true, website, socialLinks });
    } catch (err) {
        console.error('Links update error:', err);
        res.status(500).json({ error: 'Failed to update links' });
    }
});

// PATCH /api/user/avatar
const ALLOWED_AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB decoded
router.patch('/user/avatar', requireAuth, async (req, res) => {
    try {
        const { avatar } = req.body;
        if (!avatar || typeof avatar !== 'string') return res.status(400).json({ error: 'No image provided' });
        const match = avatar.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
        if (!match) return res.status(400).json({ error: 'Invalid image format' });
        const [, mimeType, b64] = match;
        if (!ALLOWED_AVATAR_MIME.has(mimeType)) return res.status(400).json({ error: 'Unsupported image type' });
        const buffer = Buffer.from(b64, 'base64');
        if (buffer.byteLength > MAX_AVATAR_BYTES) return res.status(400).json({ error: 'Image must be under 2 MB' });
        const oldAvatar = req.user.avatar;
        const url = await uploadImageToR2(buffer, mimeType, 'users/avatars');
        await User.findByIdAndUpdate(req.user._id, { avatar: url });
        if (oldAvatar) deleteR2Images([oldAvatar]).catch(() => {});
        res.json({ ok: true, avatar: url });
    } catch (err) {
        console.error('Avatar update error:', err);
        res.status(500).json({ error: 'Failed to update avatar' });
    }
});

// POST /api/user/avatar — alias for the PATCH handler (accepts same base64 body)
router.post('/user/avatar', requireAuth, async (req, res) => {
    try {
        const { avatar } = req.body;
        if (!avatar || typeof avatar !== 'string') return res.status(400).json({ error: 'No image provided' });
        const match = avatar.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
        if (!match) return res.status(400).json({ error: 'Invalid image format' });
        const [, mimeType, b64] = match;
        if (!ALLOWED_AVATAR_MIME.has(mimeType)) return res.status(400).json({ error: 'Unsupported image type' });
        const buffer = Buffer.from(b64, 'base64');
        if (buffer.byteLength > MAX_AVATAR_BYTES) return res.status(400).json({ error: 'Image must be under 2 MB' });
        const oldAvatar = req.user.avatar;
        const url = await uploadImageToR2(buffer, mimeType, 'users/avatars');
        await User.findByIdAndUpdate(req.user._id, { avatar: url });
        if (oldAvatar) deleteR2Images([oldAvatar]).catch(() => {});
        res.json({ ok: true, avatar: url });
    } catch (err) {
        console.error('Avatar upload error:', err);
        res.status(500).json({ error: 'Failed to upload avatar' });
    }
});

// PATCH /api/user/profile — consolidated profile update (username)
router.patch('/user/profile', requireAuth, async (req, res) => {
    try {
        const { username } = req.body;
        if (!username?.trim()) return res.status(400).json({ error: 'Username is required' });
        const trimmed = username.trim();
        if (trimmed.length < 3 || trimmed.length > 20) return res.status(400).json({ error: 'Username must be 3–20 characters' });
        if (!/^[a-zA-Z0-9]+$/.test(trimmed)) return res.status(400).json({ error: 'Username may only contain letters and numbers' });
        if (trimmed.toLowerCase() === req.user.username?.toLowerCase()) return res.status(400).json({ error: 'This is already your username' });
        const rateLimit = checkUsernameRateLimit(req.user);
        if (rateLimit.blocked) {
            const formatted = rateLimit.availableAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            return res.status(429).json({ error: `You've hit a username change limit. Try again on ${formatted}.` });
        }
        const isAdmin = ['moderator', 'superadmin'].includes(req.user.role);
        const roleFilter = isAdmin ? { role: { $in: ['moderator', 'superadmin'] } } : { role: 'user' };
        const taken = await User.findOne({ username: new RegExp(`^${trimmed}$`, 'i'), _id: { $ne: req.user._id }, ...roleFilter });
        if (taken) return res.status(409).json({ error: 'This username is already taken' });
        const now = new Date();
        const pruned = (req.user.usernameChangeLog || []).filter(d => now - new Date(d).getTime() < 30 * 24 * 60 * 60 * 1000);
        pruned.push(now);
        await User.findByIdAndUpdate(req.user._id, { username: trimmed, usernameChangeLog: pruned });
        res.json({ ok: true, username: trimmed });
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// PATCH /api/user/email — request email change (stores pendingEmail, sends OTP to new address)
router.patch('/user/email', requireAuth, async (req, res) => {
    try {
        const { newEmail, currentPassword } = req.body;
        if (!newEmail || !currentPassword) return res.status(400).json({ error: 'New email and current password are required' });
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(newEmail)) return res.status(400).json({ error: 'Invalid email format' });
        const normalized = newEmail.toLowerCase().trim();
        if (normalized === req.user.email) return res.status(400).json({ error: 'This is already your email address' });
        if ((req.user.emailChangeLog || []).length >= EMAIL_CHANGE_LIFETIME_LIMIT) {
            return res.status(403).json({ error: 'You have reached the lifetime limit of 3 email changes.' });
        }
        const rateLimit = checkEmailRateLimit(req.user);
        if (rateLimit.blocked) {
            const formatted = rateLimit.availableAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            return res.status(429).json({ error: `You've hit an email change limit. Try again on ${formatted}.` });
        }
        const normalizedHash = createHash('sha256').update(normalized).digest('hex');
        const recentHistory = (req.user.emailHistory || []).filter(e => Date.now() - new Date(e.changedAt).getTime() < EMAIL_REUSE_WINDOW_MS);
        if (recentHistory.some(e => e.hash === normalizedHash)) {
            return res.status(409).json({ error: 'You cannot reuse a recent email address within 90 days.' });
        }
        const user = await User.findById(req.user._id).select('+password +pendingEmailOtpSentAt');
        if (!user) return res.status(404).json({ error: 'User not found' });
        const valid = await user.comparePassword(currentPassword);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        const isAdmin = ['moderator', 'superadmin'].includes(req.user.role);
        const roleFilter = isAdmin ? { role: { $in: ['moderator', 'superadmin'] } } : { role: 'user' };
        const taken = await User.findOne({ email: normalized, _id: { $ne: req.user._id }, ...roleFilter });
        if (taken) return res.status(409).json({ error: 'Email is already in use' });
        if (user.pendingEmailOtpSentAt && Date.now() - new Date(user.pendingEmailOtpSentAt).getTime() < 60_000) {
            return res.status(429).json({ error: 'Please wait a minute before requesting another code' });
        }
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        user.pendingEmail = normalized;
        user.pendingEmailOtp = createHash('sha256').update(code).digest('hex');
        user.pendingEmailOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
        user.pendingEmailOtpSentAt = new Date();
        await user.save();
        await sendOtpEmail(normalized, code);
        res.json({ ok: true });
    } catch (err) {
        console.error('Email update error:', err);
        res.status(500).json({ error: 'Failed to update email' });
    }
});

// POST /api/user/email/verify — verify OTP and commit the email change
router.post('/user/email/verify', requireAuth, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Verification code is required' });
        const hashedCode = createHash('sha256').update(code.trim()).digest('hex');
        const user = await User.findById(req.user._id).select('+pendingEmailOtp +pendingEmailOtpExpires');
        if (!user?.pendingEmail) return res.status(400).json({ error: 'No pending email change found' });
        if (!user.pendingEmailOtp || user.pendingEmailOtp !== hashedCode) return res.status(400).json({ error: 'Invalid or expired code. Please try again.' });
        if (!user.pendingEmailOtpExpires || user.pendingEmailOtpExpires < new Date()) return res.status(400).json({ error: 'Invalid or expired code. Please try again.' });
        const newEmail = user.pendingEmail;
        const oldEmailHash = createHash('sha256').update(user.email).digest('hex');
        const now = new Date();
        // Record old email in history (prune entries older than reuse window)
        const pruned = (user.emailHistory || []).filter(e => Date.now() - new Date(e.changedAt).getTime() < EMAIL_REUSE_WINDOW_MS);
        pruned.push({ hash: oldEmailHash, changedAt: now });
        user.emailHistory = pruned;
        user.emailChangeLog = [...(user.emailChangeLog || []), now];
        user.email = newEmail;
        user.isEmailVerified = true;
        user.pendingEmail = null;
        user.pendingEmailOtp = undefined;
        user.pendingEmailOtpExpires = undefined;
        user.pendingEmailOtpSentAt = undefined;
        await user.save();
        res.json({ ok: true, email: newEmail });
    } catch (err) {
        console.error('Email verify error:', err);
        res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
});

// POST /api/user/email/resend — resend OTP to pending email
router.post('/user/email/resend', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('+pendingEmailOtp +pendingEmailOtpExpires +pendingEmailOtpSentAt');
        if (!user?.pendingEmail) return res.status(400).json({ error: 'No pending email change' });
        if (user.pendingEmailOtpSentAt && Date.now() - new Date(user.pendingEmailOtpSentAt).getTime() < 60_000) {
            return res.status(429).json({ error: 'Please wait a minute before requesting another code' });
        }
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        user.pendingEmailOtp = createHash('sha256').update(code).digest('hex');
        user.pendingEmailOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
        user.pendingEmailOtpSentAt = new Date();
        await user.save();
        await sendOtpEmail(user.pendingEmail, code);
        res.json({ ok: true });
    } catch (err) {
        console.error('Email resend error:', err);
        res.status(500).json({ error: 'Failed to resend code' });
    }
});

// PATCH /api/user/email-notification-prefs — per-type email notification toggles
const VALID_EMAIL_NOTIF_TYPES = new Set([
    'new_follower', 'bucket_grabbed', 'bucket_unlocked', 'new_bucket_published',
    'grabbed_bucket_updated', 'comment_mention', 'comment_reply', 'comment_agreed',
    'bucket_tagged', 'new_dm',
]);
router.patch('/user/email-notification-prefs', requireAuth, requireVerification, async (req, res) => {
    try {
        const prefs = req.body;
        if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
            return res.status(400).json({ error: 'Prefs must be an object' });
        }
        const update = {};
        for (const [key, val] of Object.entries(prefs)) {
            if (!VALID_EMAIL_NOTIF_TYPES.has(key)) return res.status(400).json({ error: `Unknown notification type: ${key}` });
            if (typeof val !== 'boolean') return res.status(400).json({ error: `Value for ${key} must be a boolean` });
            update[`emailNotificationPrefs.${key}`] = val;
        }
        if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No valid fields provided' });
        await User.findByIdAndUpdate(req.user._id, { $set: update });
        res.json({ ok: true });
    } catch (err) {
        console.error('Email notification prefs update error:', err);
        res.status(500).json({ error: 'Failed to update email notification preferences' });
    }
});

// PATCH /api/user/notification-prefs — per-type notification toggles
const VALID_NOTIF_TYPES = new Set([
    'new_follower', 'bucket_grabbed', 'bucket_unlocked', 'new_bucket_published',
    'grabbed_bucket_updated', 'comment_mention', 'bucket_tagged', 'comment_reply',
    'comment_agreed', 'new_dm',
]);
router.patch('/user/notification-prefs', requireAuth, requireVerification, async (req, res) => {
    try {
        const prefs = req.body;
        if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
            return res.status(400).json({ error: 'Prefs must be an object' });
        }
        const update = {};
        for (const [key, val] of Object.entries(prefs)) {
            if (!VALID_NOTIF_TYPES.has(key)) return res.status(400).json({ error: `Unknown notification type: ${key}` });
            if (typeof val !== 'boolean') return res.status(400).json({ error: `Value for ${key} must be a boolean` });
            update[`notificationPrefs.${key}`] = val;
        }
        if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No valid fields provided' });
        await User.findByIdAndUpdate(req.user._id, { $set: update });
        res.json({ ok: true });
    } catch (err) {
        console.error('Notification prefs update error:', err);
        res.status(500).json({ error: 'Failed to update notification preferences' });
    }
});

// GET /api/user/export — download user data as JSON
router.get('/user/export', requireAuth, requireVerification, async (req, res) => {
    try {
        const userId = req.user._id;
        const [user, buckets, grabbedBuckets] = await Promise.all([
            User.findById(userId).select(
                'username email avatar bio website socialLinks category isMatureGated newsletterSubscribed notificationPrefs createdAt'
            ).lean(),
            Bucket.find({ userId }).select('name description tags visibility monetized price mature isDraft links createdAt updatedAt').lean(),
            Bucket.find({ 'grabbedBy.userId': userId }).select('name _id').lean(),
        ]);
        res.setHeader('Content-Disposition', 'attachment; filename="grabbn-export.json"');
        res.json({
            exportedAt: new Date().toISOString(),
            profile: user,
            buckets: buckets.map(b => ({
                name: b.name,
                description: b.description,
                tags: b.tags,
                visibility: b.visibility,
                monetized: b.monetized,
                price: b.price,
                mature: b.mature,
                isDraft: b.isDraft,
                linkCount: (b.links || []).length,
                createdAt: b.createdAt,
                updatedAt: b.updatedAt,
            })),
            grabbed: grabbedBuckets.map(b => ({ id: b._id, name: b.name })),
        });
    } catch (err) {
        console.error('Export error:', err);
        res.status(500).json({ error: 'Failed to export data' });
    }
});

// ── Search: JSON pagination API ──────────────────────────────────────────────
router.get('/search', anonymousAuth, async (req, res) => {
    const q    = (req.query.q    || '').trim();
    const type = (req.query.type || '').toLowerCase(); // people | buckets | repos
    const skip = Math.max(0, parseInt(req.query.skip) || 0);

    if (!q || !['people', 'buckets', 'repos'].includes(type)) {
        return res.json({ items: [], hasMore: false });
    }

    const BUCKET_SELECT = 'name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags isDraft visibility isPublic';
    const U_LIMIT = 6, B_LIMIT = 9, R_LIMIT = 3;

    try {
        // Direct-lookup queries don't paginate
        if (q.match(/\/share\/bucket\/([a-f0-9]{24})/i) ||
            q.match(/\/@([A-Za-z0-9_.-]+)(?:[/?]|$)/)  ||
            /^[a-f0-9]{24}$/i.test(q)) {
            return res.json({ items: [], hasMore: false });
        }

        const searchTerm = q.startsWith('@') ? q.slice(1) : q;
        const escaped    = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // ── People ────────────────────────────────────────────────────────────
        if (type === 'people') {
            // Build exclusion set: users who have blocked the viewer
            let blockedByIds = [];
            if (req.user && !req.user.isAnonymous) {
                const blocks = await Block.find({ blockedId: req.user._id }).select('blockerId').lean();
                blockedByIds = blocks.map(b => b.blockerId);
            }

            const userFilter = {
                username:   new RegExp(escaped, 'i'),
                isAnonymous: false,
                'privacy.accountVisibility': { $nin: ['private', 'unlisted'] },
            };
            if (blockedByIds.length) userFilter._id = { $nin: blockedByIds };

            const found  = await User.find(userFilter)
                .skip(skip).limit(U_LIMIT + 1).lean();
            const hasMore = found.length > U_LIMIT;
            const users   = found.slice(0, U_LIMIT);

            const bucketCounts = await Promise.all(users.map(u =>
                Bucket.countDocuments({ userId: u._id, isDraft: { $ne: true }, $or: FILTER_PUBLIC.$or })
            ));
            let followedIds = new Set();
            if (req.user?._id && !req.user.isAnonymous && users.length) {
                const subs = await Subscription.find({
                    followerId: req.user._id,
                    followeeId: { $in: users.map(u => u._id) },
                }).select('followeeId').lean();
                subs.forEach(s => followedIds.add(String(s.followeeId)));
            }
            return res.json({
                hasMore,
                items: users.map((u, i) => ({
                    username:    u.username,
                    avatar:      u.avatar    || null,
                    anonymousId: u.anonymousId,
                    bucketCount: bucketCounts[i],
                    isFollowing: followedIds.has(String(u._id)),
                    isSelf:      !!(req.user && !req.user.isAnonymous &&
                                    req.user._id.toString() === u._id.toString()),
                })),
            });
        }

        // ── Buckets ───────────────────────────────────────────────────────────
        if (type === 'buckets') {
            // Exclude buckets from users who have blocked the viewer
            let blockedByUserIds = [];
            if (req.user && !req.user.isAnonymous) {
                const blocks = await Block.find({ blockedId: req.user._id }).select('blockerId').lean();
                blockedByUserIds = blocks.map(b => b.blockerId);
            }

            const bucketFilter = {
                name:    new RegExp(escaped, 'i'),
                isDraft: { $ne: true },
                $or:     FILTER_PUBLIC.$or,
            };
            if (blockedByUserIds.length) bucketFilter.userId = { $nin: blockedByUserIds };
            if (req.user && !req.user.isAnonymous) {
                const mt = req.user.mutedTags   || [];
                const mp = req.user.mutedTopics || [];
                if (mt.length) bucketFilter.hashtags = { $nin: mt };
                if (mp.length) bucketFilter.topic    = { $nin: mp };
            }

            const found = await Bucket.find(bucketFilter)
            .select(BUCKET_SELECT)
            .skip(skip).limit(B_LIMIT + 1)
            .populate('userId', 'username anonymousId avatar privacy')
            .lean();

            const visible = found.filter(b => !['private', 'unlisted'].includes(b.userId?.privacy?.accountVisibility));
            const hasMore = visible.length > B_LIMIT;
            const buckets = visible.slice(0, B_LIMIT);

            const grabCounts = buckets.map(b => b.grabbedBy?.length ?? 0);
            let grabbedSet = new Set();
            if (req.user?._id && !req.user.isAnonymous && buckets.length) {
                const grabs = await Bucket.find({
                    _id:               { $in: buckets.map(b => b._id) },
                    'grabbedBy.userId': req.user._id,
                }).select('_id').lean();
                grabs.forEach(g => grabbedSet.add(String(g._id)));
            }
            let followedIds = new Set();
            if (req.user?._id && !req.user.isAnonymous) {
                const ids = buckets.map(b => b.userId?._id).filter(Boolean);
                if (ids.length) {
                    const subs = await Subscription.find({
                        followerId: req.user._id,
                        followeeId: { $in: ids },
                    }).select('followeeId').lean();
                    subs.forEach(s => followedIds.add(String(s.followeeId)));
                }
            }
            return res.json({
                hasMore,
                items: buckets.map((b, i) => ({
                    _id:         b._id,
                    name:        b.name,
                    thumbnail:   b.thumbnail || b.links?.find(l => l.image)?.image || '',
                    linkCount:   b.links?.length || 0,
                    isPaywalled: b.isPaywalled  || false,
                    price:       b.price        || 0,
                    viewCount:   b.viewCount    || 0,
                    shareCount:  b.shareCount   || 0,
                    createdAt:   b.createdAt,
                    updatedAt:   b.updatedAt,
                    description: b.description  || '',
                    hashtags:    b.hashtags     || [],
                    isGrabbed:   grabbedSet.has(String(b._id)),
                    grabCount:   grabCounts[i],
                    grabbers:    (b.grabbedBy || []).filter(g => g.avatar).slice(-4)
                                    .map(g => ({ username: g.username || '?', avatar: g.avatar })),
                    curator: {
                        username:    b.userId?.username    || 'Unknown',
                        userId:      b.userId?.anonymousId || '',
                        avatar:      b.userId?.avatar      || '',
                        isFollowing: followedIds.has(String(b.userId?._id)),
                    },
                })),
            });
        }

        // ── Repos ─────────────────────────────────────────────────────────────
        if (type === 'repos') {
            const sidebarTerm = q.replace(/^[@#]/, '').replace(/^https?:\/\/[^/]*\//, '').trim();
            const sEsc        = sidebarTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const found       = await Repository.find({ domain: new RegExp(sEsc, 'i') })
                .sort({ totalClicks: -1 }).skip(skip).limit(R_LIMIT + 1).lean();
            const hasMore = found.length > R_LIMIT;
            const repoItems = found.slice(0, R_LIMIT).map(r => ({
                domain:      r.domain,
                tag:         r.tag,
                bucketCount: r.bucketCount || 0,
            }));
            await enrichReposWithBucketThumbnails(repoItems);
            return res.json({ hasMore, items: repoItems });
        }

        return res.json({ items: [], hasMore: false });

    } catch (err) {
        console.error('Search API error:', err);
        return res.json({ items: [], hasMore: false });
    }
});

// Bucket recommendations — returns similar public buckets sorted by exploreScore.
// Matching strategy (in order of preference):
//   1. Shared hashtags (any overlap)
//   2. Same topic (domain / derived topic)
// The current bucket and its curator's other buckets are excluded.
router.get('/buckets/:id/recommendations', anonymousAuth, async (req, res) => {
    try {
        const bucket = await Bucket.findById(req.params.id)
            .select('userId topic hashtags')
            .lean();
        if (!bucket) return res.json({ buckets: [] });

        const BASE_FILTER = { ...FILTER_PUBLIC, isDraft: { $ne: true }, name: { $ne: 'Singletons' } };
        const exclude = { _id: { $ne: bucket._id }, userId: { $ne: bucket.userId } };

        // Build OR conditions: hashtag overlap first, topic fallback
        const orConditions = [];
        if (bucket.hashtags?.length > 0) {
            orConditions.push({ hashtags: { $in: bucket.hashtags } });
        }
        if (bucket.topic) {
            orConditions.push({ topic: bucket.topic });
        }

        let recs = [];
        if (orConditions.length > 0) {
            recs = await Bucket.find({ ...BASE_FILTER, ...exclude, $or: orConditions })
                .sort({ exploreScore: -1 })
                .limit(3)
                .populate('userId', 'username avatar anonymousId')
                .select('name thumbnail links grabbedBy hashtags topic userId viewCount shareCount isPaywalled price')
                .lean();
        }

        res.json({
            buckets: recs.map(b => ({
                _id:         b._id,
                name:        b.name,
                thumbnail:   b.thumbnail || (b.links || []).find(l => l.image)?.image || '',
                linkCount:   (b.links || []).length,
                grabCount:   (b.grabbedBy || []).length,
                viewCount:   b.viewCount   || 0,
                shareCount:  b.shareCount  || 0,
                isPaywalled: b.isPaywalled || false,
                price:       b.price       || 0,
                hashtags:    b.hashtags    || [],
                topic:       b.topic       || null,
                curator: {
                    username: b.userId?.username    || 'Unknown',
                    avatar:   b.userId?.avatar      || '',
                    userId:   b.userId?.anonymousId || ''
                }
            }))
        });
    } catch (err) {
        console.error('Recommendations error:', err);
        res.json({ buckets: [] });
    }
});


popupSessionRouter.routes = [
  { method: 'OPTIONS', path: '/popup-session', label: 'Bookmarklet session, CORS preflight' },
  { method: 'POST', path: '/popup-session', label: 'Bookmarklet: store collected links, return a token' },
  { method: 'GET', path: '/popup-session', label: 'Bookmarklet: fetch collected links by token, once' },
];

router.routes = [
  { method: 'GET', path: '/auth/google', label: 'Start Google sign-in' },
  { method: 'GET', path: '/auth/google/callback', label: 'Google sign-in callback' },
  { method: 'POST', path: '/auth/signup', label: 'Sign up' },
  { method: 'POST', path: '/auth/login', label: 'Log in' },
  { method: 'POST', path: '/auth/verify-otp', label: 'Verify an email code' },
  { method: 'POST', path: '/auth/resend-otp', label: 'Resend an email code' },
  { method: 'POST', path: '/auth/logout', label: 'Log out' },
  { method: 'GET', path: '/auth/status', label: 'Current sign-in status' },
  { method: 'POST', path: '/auth/forgot-password', label: 'Email a password reset link' },
  { method: 'POST', path: '/auth/reset-password', label: 'Set a new password from a reset link' },
  { method: 'GET', path: '/auth/accounts', label: 'Accounts linked on this browser' },
  { method: 'POST', path: '/auth/accounts/switch', label: 'Switch to a linked account' },
  { method: 'DELETE', path: '/auth/accounts/remove', label: 'Remove a linked account from this browser' },
  { method: 'POST', path: '/auth/accounts/begin-add', label: 'Start adding another account' },
  { method: 'DELETE', path: '/auth/account', label: 'Delete the signed-in account' },
  { method: 'GET', path: '/credits/balance', label: 'Credit balance' },
  { method: 'GET', path: '/credits/verify', label: 'Confirm a finished top-up' },
  { method: 'POST', path: '/credits/topup', label: 'Start a top-up with Stripe' },
  { method: 'POST', path: '/credits/unlock/:bucketId', label: 'Unlock a paywalled bucket' },
  { method: 'GET', path: '/credits/summary', label: 'Transactions summary' },
  { method: 'GET', path: '/credits/chart', label: 'Transactions chart data' },
  { method: 'GET', path: '/credits/export', label: 'Export transactions as CSV' },
  { method: 'GET', path: '/credits/history', label: 'Transaction history' },
  { method: 'DELETE', path: '/credits/history/:id', label: 'Remove a transaction from history' },
  { method: 'GET', path: '/connect/status', label: 'Stripe Connect status' },
  { method: 'POST', path: '/connect/onboard', label: 'Start Stripe Connect onboarding' },
  { method: 'GET', path: '/connect/return', label: 'Stripe Connect onboarding return' },
  { method: 'POST', path: '/connect/cashout', label: 'Cash out earnings' },
  { method: 'GET', path: '/notifications', label: 'List notifications' },
  { method: 'GET', path: '/notifications/unread-count', label: 'Unread notification count' },
  { method: 'POST', path: '/notifications/seen', label: 'Mark notifications seen' },
  { method: 'POST', path: '/notifications/read', label: 'Mark notifications read' },
  { method: 'POST', path: '/notifications/clear', label: 'Clear notifications' },
  { method: 'GET', path: '/buckets/:id/comments', label: 'List a bucket comments' },
  { method: 'POST', path: '/buckets/:id/comments', label: 'Add a comment' },
  { method: 'PATCH', path: '/buckets/:id/comments/:commentId', label: 'Edit a comment' },
  { method: 'DELETE', path: '/buckets/:id/comments/:commentId', label: 'Delete a comment' },
  { method: 'POST', path: '/buckets/:id/comments/:commentId/agree', label: 'Agree with a comment' },
  { method: 'PATCH', path: '/buckets/:id/comments/:commentId/pin', label: 'Pin a comment' },
  { method: 'POST', path: '/buckets/:id/comments/:commentId/report', label: 'Report a comment' },
  { method: 'POST', path: '/buckets/:id/comments/:commentId/refresh-entity', label: 'Refresh a comment mention or link preview' },
  { method: 'GET', path: '/dm/can-message/:userId', label: 'Can this user be messaged' },
  { method: 'GET', path: '/dm/conversations', label: 'List conversations' },
  { method: 'GET', path: '/dm/:conversationId/messages', label: 'Messages in a conversation' },
  { method: 'POST', path: '/dm/send', label: 'Send a direct message' },
  { method: 'POST', path: '/dm/:conversationId/read', label: 'Mark a conversation read' },
  { method: 'POST', path: '/dm/read-all', label: 'Mark all conversations read' },
  { method: 'GET', path: '/dm/unread-count', label: 'Unread message count' },
  { method: 'POST', path: '/dm/:conversationId/mute', label: 'Mute a conversation' },
  { method: 'DELETE', path: '/dm/:conversationId/mute', label: 'Unmute a conversation' },
  { method: 'POST', path: '/dm/:conversationId/pin', label: 'Pin a message' },
  { method: 'DELETE', path: '/dm/:conversationId/pin', label: 'Unpin a message' },
  { method: 'DELETE', path: '/dm/message/:messageId', label: 'Delete a message' },
  { method: 'POST', path: '/users/:userId/block', label: 'Block a user' },
  { method: 'DELETE', path: '/users/:userId/block', label: 'Unblock a user' },
  { method: 'GET', path: '/users/blocked', label: 'List blocked users' },
  { method: 'GET', path: '/partnership/status', label: 'Partner application status' },
  { method: 'GET', path: '/partnership/eligibility', label: 'Partner eligibility' },
  { method: 'POST', path: '/partnership/apply', label: 'Apply to the partner program' },
  { method: 'GET', path: '/documents', label: 'List uploaded documents' },
  { method: 'POST', path: '/documents', label: 'Upload a document' },
  { method: 'GET', path: '/faq', label: 'Published FAQ items' },
  { method: 'GET', path: '/faq/pending', label: 'Questions waiting for an answer' },
  { method: 'POST', path: '/faq/questions', label: 'Submit a question' },
  { method: 'POST', path: '/contact', label: 'Send the contact form' },
  { method: 'GET', path: '/users/:userId/online-status', label: 'Online status and last seen' },
  { method: 'GET', path: '/img-proxy', label: 'Image proxy for external thumbnails' },
  { method: 'GET', path: '/auth/anon-id', label: 'Session id for the browser extension' },
  { method: 'GET', path: '/meta', label: 'Fetch a page title and image for a link' },
  { method: 'GET', path: '/img-proxy', label: 'Image proxy, signed-in version: never reached, the one above answers first' },
  { method: 'GET', path: '/meta/usage', label: 'Link preview usage today' },
  { method: 'POST', path: '/meta/topup', label: 'Buy more link previews' },
  { method: 'GET', path: '/user', label: 'Signed-in user' },
  { method: 'POST', path: '/user/export', label: 'Email a data export' },
  { method: 'DELETE', path: '/user/data', label: 'Erase the user data' },
  { method: 'DELETE', path: '/user/account', label: 'Delete the account, with a 90-day restore window' },
  { method: 'PATCH', path: '/user/settings', label: 'Update privacy and content settings' },
  { method: 'GET', path: '/buckets', label: 'List the user buckets' },
  { method: 'GET', path: '/buckets/mine', label: 'The user buckets, for pickers' },
  { method: 'POST', path: '/buckets', label: 'Create a bucket' },
  { method: 'PUT', path: '/buckets/:oldName', label: 'Rename a bucket' },
  { method: 'PATCH', path: '/buckets/:id/full', label: 'Edit a bucket' },
  { method: 'GET', path: '/repos', label: 'List the user repos' },
  { method: 'POST', path: '/repos', label: 'Create a repo' },
  { method: 'PATCH', path: '/repos/:id', label: 'Edit a repo' },
  { method: 'DELETE', path: '/repos/:id', label: 'Delete a repo' },
  { method: 'GET', path: '/buckets/:name/id', label: 'Bucket id from its name' },
  { method: 'PATCH', path: '/buckets/:id/unarchive', label: 'Restore an archived bucket' },
  { method: 'PATCH', path: '/buckets/bulk/archive', label: 'Archive several buckets' },
  { method: 'DELETE', path: '/buckets/bulk', label: 'Delete several buckets' },
  { method: 'DELETE', path: '/buckets/drafts', label: 'Delete draft buckets' },
  { method: 'DELETE', path: '/buckets/:name', label: 'Delete a bucket' },
  { method: 'DELETE', path: '/buckets/:name/links', label: 'Remove a link from a bucket' },
  { method: 'PATCH', path: '/buckets/:name/links/free', label: 'Mark a link free or paid' },
  { method: 'PUT', path: '/buckets/:name/thumbnail', label: 'Set a bucket thumbnail' },
  { method: 'GET', path: '/buckets/:name/thumbnail', label: 'Get a bucket thumbnail' },
  { method: 'GET', path: '/buckets/:name/metadata', label: 'Bucket details' },
  { method: 'POST', path: '/buckets/:name/paywall', label: 'Set a bucket paywall' },
  { method: 'PATCH', path: '/buckets/:name/visibility', label: 'Change a bucket visibility' },
  { method: 'GET', path: '/buckets/snapshots', label: 'Bucket previews for mentions' },
  { method: 'GET', path: '/buckets/lookup', label: 'Find a bucket from a link or name' },
  { method: 'POST', path: '/buckets/grab', label: 'Grab a bucket' },
  { method: 'DELETE', path: '/buckets/grab/:sourceBucketId', label: 'Remove a grabbed bucket' },
  { method: 'POST', path: '/buckets/:id/view', label: 'Record a bucket view' },
  { method: 'POST', path: '/buckets/:id/share', label: 'Record a bucket share' },
  { method: 'POST', path: '/buckets/:id/not-interested', label: 'Hide a bucket from the feed' },
  { method: 'POST', path: '/buckets/:bucketId/rate', label: 'Rate a bucket' },
  { method: 'POST', path: '/buckets/:id/report', label: 'Report a bucket' },
  { method: 'POST', path: '/users/:userId/report', label: 'Report a user' },
  { method: 'GET', path: '/buckets/:id/edit', label: 'Bucket data for the editor' },
  { method: 'GET', path: '/buckets/:id/links', label: 'Links in a bucket' },
  { method: 'GET', path: '/links', label: 'List the user links' },
  { method: 'POST', path: '/links/check-duplicates', label: 'Check links for duplicates in the user buckets' },
  { method: 'POST', path: '/links', label: 'Save links' },
  { method: 'GET', path: '/registered-links', label: 'List registered links' },
  { method: 'POST', path: '/registered-links', label: 'Register a link' },
  { method: 'DELETE', path: '/registered-links', label: 'Unregister a link' },
  { method: 'DELETE', path: '/links', label: 'Delete links' },
  { method: 'POST', path: '/links/click', label: 'Record a link click' },
  { method: 'GET', path: '/showroom', label: 'Show Room feed' },
  { method: 'GET', path: '/explore', label: 'Explore feed' },
  { method: 'GET', path: '/explore/promoted', label: 'Explore: promoted row' },
  { method: 'GET', path: '/explore/paywalled', label: 'Explore: paywalled row' },
  { method: 'GET', path: '/explore/new', label: 'Explore: new row' },
  { method: 'GET', path: '/explore/revisit', label: 'Explore: revisit row' },
  { method: 'POST', path: '/users/:anonymousId/subscribe', label: 'Follow a user' },
  { method: 'DELETE', path: '/users/:anonymousId/subscribe', label: 'Unfollow a user' },
  { method: 'GET', path: '/users/:anonymousId/subscribe', label: 'Is this user followed' },
  { method: 'GET', path: '/repositories', label: 'List repositories' },
  { method: 'GET', path: '/repositories/:domain/:tag', label: 'One repository' },
  { method: 'POST', path: '/repositories/:domain/:tag/not-interested', label: 'Hide a repository from the feed' },
  { method: 'PATCH', path: '/user/username', label: 'Change username' },
  { method: 'PATCH', path: '/user/password', label: 'Change password' },
  { method: 'PATCH', path: '/user/bio', label: 'Change bio' },
  { method: 'PATCH', path: '/user/display-name', label: 'Change display name' },
  { method: 'PATCH', path: '/user/language', label: 'Change language' },
  { method: 'POST', path: '/user/muted-tags', label: 'Mute a tag' },
  { method: 'DELETE', path: '/user/muted-tags/:tag', label: 'Unmute a tag' },
  { method: 'PATCH', path: '/user/muted-topics', label: 'Replace muted topics' },
  { method: 'PATCH', path: '/user/category', label: 'Change category' },
  { method: 'PATCH', path: '/user/links', label: 'Change website and social links' },
  { method: 'PATCH', path: '/user/avatar', label: 'Change avatar' },
  { method: 'POST', path: '/user/avatar', label: 'Change avatar (same as PATCH)' },
  { method: 'PATCH', path: '/user/profile', label: 'Update profile' },
  { method: 'PATCH', path: '/user/email', label: 'Request an email change' },
  { method: 'POST', path: '/user/email/verify', label: 'Confirm an email change' },
  { method: 'POST', path: '/user/email/resend', label: 'Resend the email change code' },
  { method: 'PATCH', path: '/user/email-notification-prefs', label: 'Email notification settings' },
  { method: 'PATCH', path: '/user/notification-prefs', label: 'Notification settings' },
  { method: 'GET', path: '/user/export', label: 'Download a data export' },
  { method: 'GET', path: '/search', label: 'Search, more results' },
  { method: 'GET', path: '/buckets/:id/recommendations', label: 'Similar buckets' },
];

export default router;
