// server/routes/auth.js
import express from 'express';
import crypto from 'crypto';
import User from '../models/user.js';
import Bucket from '../models/bucket.js';
import { requireAuth } from '../middleware/anonymousAuth.js';
import { sendPasswordResetEmail, sendOtpEmail, sendAccountSuspendedEmail, sendAccountDeletedEmail } from '../utils/email.js';

const router = express.Router();

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
router.get('/google', (req, res) => {
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
router.get('/google/callback', async (req, res) => {
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
router.post('/signup', async (req, res) => {
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
router.post('/login', async (req, res) => {
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
router.post('/verify-otp', async (req, res) => {
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
router.post('/resend-otp', async (req, res) => {
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
router.post('/logout', requireAuth, (req, res) => {
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
router.get('/status', async (req, res) => {
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
router.post('/forgot-password', async (req, res) => {
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
router.post('/reset-password', async (req, res) => {
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
router.get('/accounts', async (req, res) => {
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
router.post('/accounts/switch', async (req, res) => {
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
router.delete('/accounts/remove', async (req, res) => {
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
router.post('/accounts/begin-add', requireAuth, (req, res) => {
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
router.delete('/account', requireAuth, async (req, res) => {
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

export default router;