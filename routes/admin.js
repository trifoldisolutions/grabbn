// Admin section: its pages, mounted at /admin, and its API, mounted at /api/admin.
import crypto from 'crypto';
import express from 'express';
import mongoose from 'mongoose';
import Bucket from '../models/bucket.js';
import FaqItem, { FAQ_CATEGORIES, FAQ_CATEGORY_LABELS } from '../models/faqItem.js';
import PartnerApplication from '../models/partnerApplication.js';
import User from '../models/user.js';
import { requireSuperadmin } from '../middleware/adminAuth.js';
import { ADMIN_COOKIE, ADMIN_SESSION_MS, adminSessionAuth, createAdminSession, deleteAdminSession, requireAdminSession } from '../middleware/adminSessionAuth.js';
import { sendOtpEmail, sendPartnerApprovedEmail, sendPartnerRejectedEmail, sendPasswordResetEmail } from '../services/email.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Admin panel — server-rendered EJS pages at /admin/*
// Protected by adminPage() below: only a valid _gadmin session opens these
// ---------------------------------------------------------------------------

// Convenience: resolve the _gadmin session cookie then role check, pass `admin`
// to the template. For page routes we render a convincing 404 instead of
// returning a 403 JSON so the existence of the admin panel isn't revealed.
function adminPage(minRole = 'moderator') {
    const allowedRoles = minRole === 'superadmin' ? ['superadmin'] : ['moderator', 'superadmin'];
    return [
        adminSessionAuth,
        (req, res, next) => {
            if (!req.user || req.user.isAnonymous || !allowedRoles.includes(req.user.role)) {
                return res.status(404).render('admin/not-found');
            }
            res.locals.admin = req.user;
            next();
        }
    ];
}

// /admin/login  →  standalone login page (no auth guard — publicly accessible)
// If already logged in as admin (_gadmin cookie), redirect straight to panel.
router.get('/login', adminSessionAuth, (req, res) => {
    if (req.user && !req.user.isAnonymous && ['moderator', 'superadmin'].includes(req.user.role)) {
        return res.redirect('/admin');
    }
    res.render('admin/login');
});

// /admin/reset-password  →  standalone password reset page (no auth guard)
router.get('/reset-password', (req, res) => {
    res.render('admin/reset-password', { token: req.query.token || '' });
});

// /admin  →  redirect to overview (users for now)
router.get('/', adminPage(), (req, res) => res.redirect('/admin/users'));

// /admin/users  →  user list
router.get('/users', adminPage(), (req, res) => {
    res.render('admin/users', { admin: req.user });
});

// /admin/users/:userId  →  user detail
router.get('/users/:userId', adminPage(), async (req, res) => {
    try {
        const { default: User } = await import('../models/user.js');
        const viewUser = await User.findById(req.params.userId)
            .select('-password -otpCode -otpExpires -otpSentAt -resetPasswordToken -resetPasswordExpires')
            .lean();
        if (!viewUser) return res.status(404).send('User not found');
        res.render('admin/user-detail', { admin: req.user, viewUser });
    } catch (err) {
        console.error('[admin/users/:id page]', err);
        res.status(500).send('Server error');
    }
});

// /admin/partners/applications — application queue list
router.get('/partners/applications', adminPage('superadmin'), async (req, res) => {
    try {
        const status       = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
        const page         = Math.max(1, parseInt(req.query.page) || 1);
        const limit        = 30;
        const skip         = (page - 1) * limit;

        const [applications, total, pendingCount] = await Promise.all([
            PartnerApplication.find({ status })
                .populate('userId', 'email username isEmailVerified createdAt country')
                .sort({ submittedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            PartnerApplication.countDocuments({ status }),
            PartnerApplication.countDocuments({ status: 'pending' })
        ]);

        res.render('admin/partner-applications', {
            admin: req.user,
            applications,
            status,
            pendingCount,
            pagination: { total, page, pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        console.error('[admin/partners/applications page]', err);
        res.status(500).send('Server error');
    }
});

// /admin/partners/applications/:appId — single application review
router.get('/partners/applications/:appId', adminPage('superadmin'), async (req, res) => {
    try {
        const { appId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(appId)) return res.status(404).render('admin/not-found');

        const application = await PartnerApplication.findById(appId)
            .populate('userId', 'email username isEmailVerified createdAt country isPartner')
            .lean();

        if (!application) return res.status(404).render('admin/not-found');

        res.render('admin/partner-application-detail', { admin: req.user, application });
    } catch (err) {
        console.error('[admin/partners/applications/:id page]', err);
        res.status(500).send('Server error');
    }
});

// /admin/faq — FAQ management
router.get('/faq', adminPage(), (req, res) => {
    res.render('admin/faq', { admin: req.user });
});

// /admin/reports — moderation queue
router.get('/reports', adminPage(), (req, res) => {
    res.render('admin/reports', { admin: req.user });
});

// /admin/buckets — bucket management
router.get('/buckets', adminPage(), (req, res) => {
    res.render('admin/buckets', { admin: req.user });
});

// /admin/analytics — platform analytics
router.get('/analytics', adminPage(), (req, res) => {
    res.render('admin/analytics', { admin: req.user });
});

// /admin/system — health, broadcast, jobs (superadmin only)
router.get('/system', adminPage('superadmin'), (req, res) => {
    res.render('admin/system', { admin: req.user });
});

// /admin/audit — audit log (superadmin only)
router.get('/audit', adminPage('superadmin'), (req, res) => {
    res.render('admin/audit', { admin: req.user });
});

// =============================================================================
// Admin API, mounted at /api/admin
// =============================================================================

export const adminApiRouter = express.Router();

// =============================================================================
// Admin API: auth
// =============================================================================

// Admin-specific authentication — issues a separate _gadmin session cookie
// that is completely independent of the regular-user anonymousId cookie.
// Mounted at /api/admin/auth (before the requireAdminSession guard).
const adminAuthRouter     = express.Router();
const ADMIN_ROLES = ['moderator', 'superadmin'];
const isProd      = process.env.NODE_ENV === 'production';

// ── OTP helper (mirrors the one in routes/api.js) ───────────────────────────────────
async function generateAndSendOtp(user) {
    const code       = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedCode = crypto.createHash('sha256').update(code).digest('hex');
    user.otpCode    = hashedCode;
    user.otpExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
    user.otpSentAt  = new Date();
    await user.save();
    await sendOtpEmail(user.email, code);
}

// ── POST /api/admin/auth/login ────────────────────────────────────────────────
// Step 1: validate credentials, confirm admin role, send OTP.
adminAuthRouter.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

        // Intentionally vague error to prevent user enumeration
        if (!user || user.isAnonymous) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const valid = await user.comparePassword(password);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        // Reject non-admin accounts at this stage so the login page can show
        // a clear message rather than sending a useless OTP.
        if (!ADMIN_ROLES.includes(user.role)) {
            return res.status(403).json({ error: 'This account does not have admin access.' });
        }

        await generateAndSendOtp(user);
        res.json({ requiresOtp: true, email: user.email });
    } catch (err) {
        console.error('[admin/auth] login error:', err);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// ── POST /api/admin/auth/verify-otp ──────────────────────────────────────────
// Step 2: verify OTP, set _gadmin cookie (does NOT touch anonymousId).
adminAuthRouter.post('/verify-otp', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) {
            return res.status(400).json({ error: 'Email and code are required.' });
        }
        if (!/^\d{6}$/.test(code)) {
            return res.status(400).json({ error: 'Code must be 6 digits.' });
        }

        const hashedCode = crypto.createHash('sha256').update(code).digest('hex');
        const user = await User.findOne({
            email:      email.toLowerCase(),
            isAnonymous: false,
            otpCode:    hashedCode,
            otpExpires: { $gt: Date.now() }
        }).select('+otpCode +otpExpires +otpSentAt');

        if (!user) {
            return res.status(400).json({ error: 'Invalid or expired code. Please try again.' });
        }

        if (!ADMIN_ROLES.includes(user.role)) {
            return res.status(403).json({ error: 'This account does not have admin access.' });
        }

        // Clear OTP fields
        user.otpCode    = undefined;
        user.otpExpires = undefined;
        user.otpSentAt  = undefined;
        await user.save();

        // Set admin-only session cookie — completely separate from anonymousId
        const sessionToken = await createAdminSession(user._id);
        res.cookie(ADMIN_COOKIE, sessionToken, {
            maxAge:   ADMIN_SESSION_MS,
            httpOnly: true,
            sameSite: isProd ? 'none' : 'lax',
            secure:   isProd,
        });

        res.json({ success: true });
    } catch (err) {
        console.error('[admin/auth] verify-otp error:', err);
        res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
});

// ── POST /api/admin/auth/resend-otp ──────────────────────────────────────────
adminAuthRouter.post('/resend-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.json({ success: true }); // silent for enumeration safety

        const user = await User.findOne({
            email: email.toLowerCase(), isAnonymous: false
        }).select('+otpSentAt');

        if (!user || !ADMIN_ROLES.includes(user.role)) return res.json({ success: true });

        if (user.otpSentAt && Date.now() - user.otpSentAt.getTime() < 60_000) {
            const secs = Math.ceil((60_000 - (Date.now() - user.otpSentAt.getTime())) / 1000);
            return res.status(429).json({ error: `Please wait ${secs}s before resending.` });
        }

        await generateAndSendOtp(user);
        res.json({ success: true });
    } catch (err) {
        console.error('[admin/auth] resend-otp error:', err);
        res.status(500).json({ error: 'Failed to resend code.' });
    }
});

// ── POST /api/admin/auth/forgot-password ─────────────────────────────────────
adminAuthRouter.post('/forgot-password', async (req, res) => {
    const successMsg = 'If that email belongs to an admin account, a reset link has been sent.';
    try {
        const { email } = req.body;
        if (!email) return res.json({ success: true, message: successMsg });

        const user = await User.findOne({ email: email.toLowerCase(), isAnonymous: false })
            .select('+resetPasswordToken +resetPasswordExpires');

        if (!user || !ADMIN_ROLES.includes(user.role)) {
            return res.json({ success: true, message: successMsg });
        }

        const rawToken    = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

        user.resetPasswordToken   = hashedToken;
        user.resetPasswordExpires = Date.now() + 60 * 60 * 1000; // 1 hour
        await user.save();

        const protocol = req.protocol;
        const host     = req.get('host');
        const resetUrl = `${protocol}://${host}/admin/reset-password?token=${rawToken}`;

        await sendPasswordResetEmail(user.email, resetUrl);

        res.json({ success: true, message: successMsg });
    } catch (err) {
        console.error('[admin/auth] forgot-password error:', err);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// ── POST /api/admin/auth/reset-password ──────────────────────────────────────
adminAuthRouter.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) {
            return res.status(400).json({ error: 'Token and new password are required.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
        const user = await User.findOne({
            resetPasswordToken:   hashedToken,
            resetPasswordExpires: { $gt: Date.now() },
        }).select('+resetPasswordToken +resetPasswordExpires');

        if (!user || !ADMIN_ROLES.includes(user.role)) {
            return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
        }

        user.password             = password; // hashed by pre-save hook
        user.resetPasswordToken   = undefined;
        user.resetPasswordExpires = undefined;
        user.passwordChangedAt    = new Date();
        await user.save();

        res.json({ success: true });
    } catch (err) {
        console.error('[admin/auth] reset-password error:', err);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// ── POST /api/admin/auth/logout ───────────────────────────────────────────────
// Ends the admin session and clears its cookie — regular user session is untouched.
adminAuthRouter.post('/logout', async (req, res) => {
    try {
        const token = req.cookies?.[ADMIN_COOKIE];
        if (token) await deleteAdminSession(token);
    } catch (err) {
        console.error('[admin/auth] logout error:', err);
    }
    res.clearCookie(ADMIN_COOKIE);
    res.json({ success: true });
});

// =============================================================================
// Admin API: users
// =============================================================================

// User management routes — accessible by moderators and superadmins.
// Certain destructive/privileged actions are locked to superadmin only.
const usersRouter = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

// ── GET /api/admin/users ─────────────────────────────────────────────────────
// List users with pagination and filters.
// Query params: email, username, role, isEmailVerified, isPartner, flagged,
//               suspended (bool), country, page, limit
usersRouter.get('/', async (req, res) => {
    try {
        const {
            email, username, role, isEmailVerified, isPartner,
            flagged, suspended, country,
            page = 1, limit = 30
        } = req.query;

        const filter = {};
        if (email)           filter.email       = { $regex: email, $options: 'i' };
        if (username)        filter.username    = { $regex: username, $options: 'i' };
        if (role)            filter.role        = role;
        if (isEmailVerified !== undefined) filter.isEmailVerified = isEmailVerified === 'true';
        if (isPartner !== undefined)       filter.isPartner       = isPartner === 'true';
        if (flagged !== undefined)         filter.flagged         = flagged === 'true';
        if (suspended === 'true')          filter.accountSuspendedAt = { $ne: null };
        if (suspended === 'false')         filter.accountSuspendedAt = null;
        if (country)         filter.country     = country.toUpperCase();

        // Exclude anonymous users from admin user list
        filter.isAnonymous = false;

        const skip = (Number(page) - 1) * Number(limit);

        const [users, total] = await Promise.all([
            User.find(filter)
                .select('email username role isEmailVerified isPartner flagged accountSuspendedAt credits country createdAt lastActive')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            User.countDocuments(filter)
        ]);

        res.json({
            users,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (err) {
        console.error('[admin/users GET]', err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ── GET /api/admin/users/:userId ─────────────────────────────────────────────
// Single user detail view.
usersRouter.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const user = await User.findById(userId)
            .select('-password -otpCode -otpExpires -otpSentAt -resetPasswordToken -resetPasswordExpires')
            .lean();

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ user });
    } catch (err) {
        console.error('[admin/users/:id GET]', err);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// ── PATCH /api/admin/users/:userId/suspend ───────────────────────────────────
// Suspend or unsuspend a user. Moderator+.
// Body: { suspend: true | false }
usersRouter.patch('/:userId/suspend', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const { suspend } = req.body;
        if (typeof suspend !== 'boolean') return res.status(400).json({ error: '`suspend` (boolean) is required' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'superadmin') return res.status(403).json({ error: 'Cannot suspend a superadmin' });

        user.accountSuspendedAt = suspend ? new Date() : null;
        await user.save();

        res.json({ message: suspend ? 'User suspended' : 'User unsuspended', userId });
    } catch (err) {
        console.error('[admin/users/:id/suspend]', err);
        res.status(500).json({ error: 'Failed to update suspension status' });
    }
});

// ── PATCH /api/admin/users/:userId/verify ────────────────────────────────────
// Force-verify a user's email. Moderator+.
usersRouter.patch('/:userId/verify', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const user = await User.findByIdAndUpdate(
            userId,
            { isEmailVerified: true, accountSuspendedAt: null },
            { new: true }
        ).select('email isEmailVerified');

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ message: 'Email verified', user });
    } catch (err) {
        console.error('[admin/users/:id/verify]', err);
        res.status(500).json({ error: 'Failed to verify email' });
    }
});

// ── PATCH /api/admin/users/:userId/role ─────────────────────────────────────
// Change a user's role. Superadmin only.
// Body: { role: 'user' | 'moderator' | 'superadmin' }
usersRouter.patch('/:userId/role', requireSuperadmin, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const { role } = req.body;
        const validRoles = ['user', 'moderator', 'superadmin'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
        }

        // Prevent self-demotion
        if (String(req.user._id) === String(userId) && role !== 'superadmin') {
            return res.status(400).json({ error: 'You cannot demote yourself' });
        }

        const user = await User.findByIdAndUpdate(userId, { role }, { new: true }).select('email role');
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ message: 'Role updated', user });
    } catch (err) {
        console.error('[admin/users/:id/role]', err);
        res.status(500).json({ error: 'Failed to update role' });
    }
});

// ── PATCH /api/admin/users/:userId/credits ───────────────────────────────────
// Adjust credits balance. Superadmin only.
// Body: { adjustment: Number (positive to add, negative to subtract), reason: String }
usersRouter.patch('/:userId/credits', requireSuperadmin, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const { adjustment, reason } = req.body;
        if (typeof adjustment !== 'number' || adjustment === 0) {
            return res.status(400).json({ error: '`adjustment` must be a non-zero number' });
        }
        if (!reason || typeof reason !== 'string') {
            return res.status(400).json({ error: '`reason` string is required for audit purposes' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const newBalance = Math.max(0, user.credits + adjustment);
        user.credits = newBalance;
        await user.save();

        console.log(`[admin] credits adjusted: userId=${userId} adjustment=${adjustment} reason="${reason}" by adminId=${req.user._id}`);

        res.json({ message: 'Credits adjusted', userId, adjustment, newBalance });
    } catch (err) {
        console.error('[admin/users/:id/credits]', err);
        res.status(500).json({ error: 'Failed to adjust credits' });
    }
});

// ── DELETE /api/admin/users/:userId ─────────────────────────────────────────
// Hard-delete a user immediately, bypassing the 70-hour suspension window.
// Superadmin only.
usersRouter.delete('/:userId', requireSuperadmin, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        // Prevent self-deletion
        if (String(req.user._id) === String(userId)) {
            return res.status(400).json({ error: 'You cannot delete your own account via admin panel' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'superadmin') return res.status(403).json({ error: 'Cannot delete a superadmin' });

        await User.findByIdAndDelete(userId);

        console.log(`[admin] user hard-deleted: userId=${userId} by adminId=${req.user._id}`);

        res.json({ message: 'User deleted', userId });
    } catch (err) {
        console.error('[admin/users/:id DELETE]', err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// =============================================================================
// Admin API: reports
// =============================================================================

// Content moderation — reports queue for buckets and comments.
// Accessible by moderators and superadmins.
const reportsRouter = express.Router();

// ── Lazy model imports ────────────────────────────────────────────────────────
// Imported inline to avoid circular dependency issues at boot.
async function getModels() {
    const { default: Report }        = await import('../models/report.js').catch(() => ({ default: null }));
    const { default: Bucket }        = await import('../models/bucket.js');
    const { default: BucketComment } = await import('../models/bucketComment.js');
    const { default: User }          = await import('../models/user.js');
    return { Report, Bucket, BucketComment, User };
}

// ── GET /api/admin/reports ────────────────────────────────────────────────────
// Paginated list of reports.
// Query params: type (bucket|comment), status (pending|reviewed|actioned), page, limit
reportsRouter.get('/', async (req, res) => {
    try {
        const { Bucket, BucketComment } = await getModels();
        const { type, status = 'pending', page = 1, limit = 20 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);

        // Reports are stored as embedded arrays on Bucket and BucketComment.
        // We aggregate across both unless a type filter is applied.
        const results = [];

        if (!type || type === 'bucket') {
            const buckets = await Bucket.aggregate([
                { $match: { 'reports.0': { $exists: true } } },
                { $unwind: '$reports' },
                { $addFields: { reportType: 'bucket' } },
                { $sort: { 'reports.createdAt': -1 } },
                { $skip: skip },
                { $limit: Number(limit) }
            ]);
            results.push(...buckets);
        }

        if (!type || type === 'comment') {
            const comments = await BucketComment.aggregate([
                { $match: { 'reports.0': { $exists: true } } },
                { $unwind: '$reports' },
                { $addFields: { reportType: 'comment' } },
                { $sort: { 'reports.createdAt': -1 } },
                { $skip: skip },
                { $limit: Number(limit) }
            ]);
            results.push(...comments);
        }

        res.json({ reports: results, page: Number(page), limit: Number(limit) });
    } catch (err) {
        console.error('[admin/reports GET]', err);
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});

// ── PATCH /api/admin/reports/:type/:contentId/dismiss ────────────────────────
// Dismiss all reports on a piece of content — no action taken.
// :type = 'bucket' | 'comment'
reportsRouter.patch('/:type/:contentId/dismiss', async (req, res) => {
    try {
        const { type, contentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const { Bucket, BucketComment } = await getModels();
        const Model = type === 'bucket' ? Bucket : type === 'comment' ? BucketComment : null;
        if (!Model) return res.status(400).json({ error: 'type must be bucket or comment' });

        await Model.findByIdAndUpdate(contentId, { $set: { reports: [] } });

        console.log(`[admin] report dismissed: type=${type} contentId=${contentId} by adminId=${req.user._id}`);
        res.json({ message: 'Reports dismissed' });
    } catch (err) {
        console.error('[admin/reports dismiss]', err);
        res.status(500).json({ error: 'Failed to dismiss reports' });
    }
});

// ── PATCH /api/admin/reports/:type/:contentId/remove ─────────────────────────
// Remove the reported content (soft delete / hide).
reportsRouter.patch('/:type/:contentId/remove', async (req, res) => {
    try {
        const { type, contentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const { Bucket, BucketComment } = await getModels();

        if (type === 'bucket') {
            await Bucket.findByIdAndUpdate(contentId, { visibility: 'private', reports: [] });
        } else if (type === 'comment') {
            await BucketComment.findByIdAndDelete(contentId);
        } else {
            return res.status(400).json({ error: 'type must be bucket or comment' });
        }

        console.log(`[admin] content removed: type=${type} contentId=${contentId} by adminId=${req.user._id}`);
        res.json({ message: 'Content removed' });
    } catch (err) {
        console.error('[admin/reports remove]', err);
        res.status(500).json({ error: 'Failed to remove content' });
    }
});

// ── PATCH /api/admin/reports/:type/:contentId/ban ────────────────────────────
// Remove the reported content AND suspend the content owner.
reportsRouter.patch('/:type/:contentId/ban', async (req, res) => {
    try {
        const { type, contentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const { Bucket, BucketComment, User } = await getModels();
        let ownerId;

        if (type === 'bucket') {
            const bucket = await Bucket.findByIdAndUpdate(
                contentId,
                { visibility: 'private', reports: [] },
                { new: true }
            ).select('userId');
            if (!bucket) return res.status(404).json({ error: 'Bucket not found' });
            ownerId = bucket.userId;
        } else if (type === 'comment') {
            const comment = await BucketComment.findById(contentId).select('userId');
            if (!comment) return res.status(404).json({ error: 'Comment not found' });
            ownerId = comment.userId;
            await BucketComment.findByIdAndDelete(contentId);
        } else {
            return res.status(400).json({ error: 'type must be bucket or comment' });
        }

        if (ownerId) {
            const owner = await User.findById(ownerId);
            if (owner && owner.role === 'user') {
                owner.accountSuspendedAt = new Date();
                await owner.save();
            }
        }

        console.log(`[admin] content removed + user banned: type=${type} contentId=${contentId} ownerId=${ownerId} by adminId=${req.user._id}`);
        res.json({ message: 'Content removed and user suspended', ownerId });
    } catch (err) {
        console.error('[admin/reports ban]', err);
        res.status(500).json({ error: 'Failed to remove content and ban user' });
    }
});

// =============================================================================
// Admin API: buckets
// =============================================================================

// Bucket & content management — browse all buckets, take down, feature, delete.
// Accessible by moderators and superadmins.
// exploreScore override is locked to superadmin only.
const bucketsRouter = express.Router();

// ── GET /api/admin/buckets ────────────────────────────────────────────────────
// List all buckets (any visibility) with filters + sorting.
// Query params: owner (userId), visibility, topic, isPaywalled,
//               sort (views|rating|exploreScore|createdAt), page, limit
bucketsRouter.get('/', async (req, res) => {
    try {
        const {
            owner, visibility, topic, isPaywalled,
            sort = 'createdAt', page = 1, limit = 30
        } = req.query;

        const filter = {};
        if (owner && mongoose.Types.ObjectId.isValid(owner)) filter.userId = owner;
        if (visibility) filter.visibility = visibility;
        if (topic)      filter.topic      = { $regex: topic, $options: 'i' };
        if (isPaywalled !== undefined) filter['paywall.enabled'] = isPaywalled === 'true';

        const sortMap = {
            views:        { viewCount: -1 },
            rating:       { 'rating.average': -1 },
            exploreScore: { exploreScore: -1 },
            createdAt:    { createdAt: -1 }
        };
        const sortOrder = sortMap[sort] || sortMap.createdAt;

        const skip = (Number(page) - 1) * Number(limit);

        const [buckets, total] = await Promise.all([
            Bucket.find(filter)
                .select('name userId visibility topic viewCount shareCount exploreScore isPaywalled createdAt')
                .populate('userId', 'email username')
                .sort(sortOrder)
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            Bucket.countDocuments(filter)
        ]);

        res.json({
            buckets,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (err) {
        console.error('[admin/buckets GET]', err);
        res.status(500).json({ error: 'Failed to fetch buckets' });
    }
});

// ── GET /api/admin/buckets/:bucketId ─────────────────────────────────────────
// Full bucket detail.
bucketsRouter.get('/:bucketId', async (req, res) => {
    try {
        const { bucketId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(bucketId)) {
            return res.status(400).json({ error: 'Invalid bucket ID' });
        }

        const bucket = await Bucket.findById(bucketId)
            .populate('userId', 'email username role')
            .lean();

        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        res.json({ bucket });
    } catch (err) {
        console.error('[admin/buckets/:id GET]', err);
        res.status(500).json({ error: 'Failed to fetch bucket' });
    }
});

// ── PATCH /api/admin/buckets/:bucketId/visibility ────────────────────────────
// Force-set bucket visibility. Moderator+.
// Body: { visibility: 'public' | 'unlisted' | 'private' }
bucketsRouter.patch('/:bucketId/visibility', async (req, res) => {
    try {
        const { bucketId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(bucketId)) {
            return res.status(400).json({ error: 'Invalid bucket ID' });
        }

        const { visibility } = req.body;
        const validVisibilities = ['public', 'unlisted', 'private'];
        if (!validVisibilities.includes(visibility)) {
            return res.status(400).json({ error: `visibility must be one of: ${validVisibilities.join(', ')}` });
        }

        const bucket = await Bucket.findByIdAndUpdate(
            bucketId,
            { visibility },
            { new: true }
        ).select('name visibility');

        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        console.log(`[admin] bucket visibility changed: bucketId=${bucketId} visibility=${visibility} by adminId=${req.user._id}`);
        res.json({ message: 'Visibility updated', bucket });
    } catch (err) {
        console.error('[admin/buckets/:id/visibility]', err);
        res.status(500).json({ error: 'Failed to update visibility' });
    }
});

// ── PATCH /api/admin/buckets/:bucketId/feature ───────────────────────────────
// Add or remove a bucket from the Showroom (featured flag). Moderator+.
// Body: { featured: true | false }
bucketsRouter.patch('/:bucketId/feature', async (req, res) => {
    try {
        const { bucketId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(bucketId)) {
            return res.status(400).json({ error: 'Invalid bucket ID' });
        }

        const { featured } = req.body;
        if (typeof featured !== 'boolean') {
            return res.status(400).json({ error: '`featured` (boolean) is required' });
        }

        const bucket = await Bucket.findByIdAndUpdate(
            bucketId,
            { featured },
            { new: true }
        ).select('name featured');

        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        console.log(`[admin] bucket featured=${featured}: bucketId=${bucketId} by adminId=${req.user._id}`);
        res.json({ message: featured ? 'Bucket featured in Showroom' : 'Bucket removed from Showroom', bucket });
    } catch (err) {
        console.error('[admin/buckets/:id/feature]', err);
        res.status(500).json({ error: 'Failed to update featured status' });
    }
});

// ── PATCH /api/admin/buckets/:bucketId/explore-score ─────────────────────────
// Manually override a bucket's explore score. Superadmin only.
// Body: { exploreScore: Number }
bucketsRouter.patch('/:bucketId/explore-score', requireSuperadmin, async (req, res) => {
    try {
        const { bucketId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(bucketId)) {
            return res.status(400).json({ error: 'Invalid bucket ID' });
        }

        const { exploreScore } = req.body;
        if (typeof exploreScore !== 'number') {
            return res.status(400).json({ error: '`exploreScore` (number) is required' });
        }

        const bucket = await Bucket.findByIdAndUpdate(
            bucketId,
            { exploreScore },
            { new: true }
        ).select('name exploreScore');

        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        console.log(`[admin] exploreScore overridden: bucketId=${bucketId} score=${exploreScore} by adminId=${req.user._id}`);
        res.json({ message: 'Explore score updated', bucket });
    } catch (err) {
        console.error('[admin/buckets/:id/explore-score]', err);
        res.status(500).json({ error: 'Failed to update explore score' });
    }
});

// ── DELETE /api/admin/buckets/:bucketId ──────────────────────────────────────
// Hard-delete a bucket. Moderator+.
bucketsRouter.delete('/:bucketId', async (req, res) => {
    try {
        const { bucketId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(bucketId)) {
            return res.status(400).json({ error: 'Invalid bucket ID' });
        }

        const bucket = await Bucket.findByIdAndDelete(bucketId);
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        console.log(`[admin] bucket hard-deleted: bucketId=${bucketId} by adminId=${req.user._id}`);
        res.json({ message: 'Bucket deleted', bucketId });
    } catch (err) {
        console.error('[admin/buckets/:id DELETE]', err);
        res.status(500).json({ error: 'Failed to delete bucket' });
    }
});

// =============================================================================
// Admin API: partners
// =============================================================================

// Partner program management — applications queue, approve/reject, revoke.
// All routes are superadmin only (guard applied in admin.js).
const partnersRouter = express.Router();

// ── GET /api/admin/partners ───────────────────────────────────────────────────
// List all current partners.
partnersRouter.get('/', async (req, res) => {
    try {
        const { page = 1, limit = 30 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);

        const [partners, total] = await Promise.all([
            User.find({ isPartner: true, isAnonymous: false })
                .select('email username stripeAccountId stripeAccountStatus createdAt lastActive country')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            User.countDocuments({ isPartner: true, isAnonymous: false })
        ]);

        res.json({
            partners,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (err) {
        console.error('[admin/partners GET]', err);
        res.status(500).json({ error: 'Failed to fetch partners' });
    }
});

// ── GET /api/admin/partners/applications ─────────────────────────────────────
// List partner applications. Supports ?status=pending|approved|rejected
partnersRouter.get('/applications', async (req, res) => {
    try {
        const { status = 'pending', page = 1, limit = 30 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const filter = status ? { status } : {};

        const [applications, total] = await Promise.all([
            PartnerApplication.find(filter)
                .populate('userId', 'email username isEmailVerified createdAt country')
                .sort({ submittedAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            PartnerApplication.countDocuments(filter)
        ]);

        res.json({
            applications,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (err) {
        console.error('[admin/partners/applications GET]', err);
        res.status(500).json({ error: 'Failed to fetch applications' });
    }
});

// ── GET /api/admin/partners/applications/:appId ───────────────────────────────
// Get a single application with full detail (including ID/selfie files).
partnersRouter.get('/applications/:appId', async (req, res) => {
    try {
        const { appId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(appId)) {
            return res.status(400).json({ error: 'Invalid application ID' });
        }

        const application = await PartnerApplication.findById(appId)
            .populate('userId', 'email username isEmailVerified createdAt country isPartner')
            .lean();

        if (!application) return res.status(404).json({ error: 'Application not found' });

        res.json({ application });
    } catch (err) {
        console.error('[admin/partners/applications/:id GET]', err);
        res.status(500).json({ error: 'Failed to fetch application' });
    }
});

// ── PATCH /api/admin/partners/applications/:appId/approve ────────────────────
// Approve an application — grants partner status and emails the user.
partnersRouter.patch('/applications/:appId/approve', async (req, res) => {
    try {
        const { appId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(appId)) {
            return res.status(400).json({ error: 'Invalid application ID' });
        }

        const application = await PartnerApplication.findById(appId).populate('userId', 'email isPartner');
        if (!application) return res.status(404).json({ error: 'Application not found' });
        if (application.status !== 'pending') {
            return res.status(409).json({ error: 'Application is no longer pending' });
        }

        application.status     = 'approved';
        application.reviewedAt = new Date();
        application.reviewedBy = req.user._id;
        await application.save();

        await User.findByIdAndUpdate(application.userId._id, { isPartner: true });

        try { await sendPartnerApprovedEmail(application.userId.email); } catch (e) {
            console.error('[admin/partners] approve email failed:', e.message);
        }

        console.log(`[admin] partner application approved: appId=${appId} userId=${application.userId._id} by adminId=${req.user._id}`);
        res.json({ message: 'Application approved, partner status granted' });
    } catch (err) {
        console.error('[admin/partners/applications/:id/approve]', err);
        res.status(500).json({ error: 'Failed to approve application' });
    }
});

// ── PATCH /api/admin/partners/applications/:appId/reject ─────────────────────
// Reject an application. Body: { reason? }
partnersRouter.patch('/applications/:appId/reject', async (req, res) => {
    try {
        const { appId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(appId)) {
            return res.status(400).json({ error: 'Invalid application ID' });
        }

        const { reason = '' } = req.body;

        const application = await PartnerApplication.findById(appId).populate('userId', 'email');
        if (!application) return res.status(404).json({ error: 'Application not found' });
        if (application.status !== 'pending') {
            return res.status(409).json({ error: 'Application is no longer pending' });
        }

        application.status          = 'rejected';
        application.reviewedAt      = new Date();
        application.reviewedBy      = req.user._id;
        application.rejectionReason = String(reason).slice(0, 1000);
        await application.save();

        try { await sendPartnerRejectedEmail(application.userId.email, reason); } catch (e) {
            console.error('[admin/partners] reject email failed:', e.message);
        }

        console.log(`[admin] partner application rejected: appId=${appId} by adminId=${req.user._id}`);
        res.json({ message: 'Application rejected' });
    } catch (err) {
        console.error('[admin/partners/applications/:id/reject]', err);
        res.status(500).json({ error: 'Failed to reject application' });
    }
});

// ── PATCH /api/admin/partners/:userId/grant ──────────────────────────────────
// Grant partner status directly (bypass application). Emails the user.
// Body: optional { note: String }
partnersRouter.patch('/:userId/grant', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        const user = await User.findByIdAndUpdate(
            userId,
            { isPartner: true },
            { new: true }
        ).select('email username isPartner');

        if (!user) return res.status(404).json({ error: 'User not found' });

        try { await sendPartnerApprovedEmail(user.email); } catch (e) {
            console.error('[admin/partners] grant email failed:', e.message);
        }

        console.log(`[admin] partner granted: userId=${userId} by adminId=${req.user._id}`);
        res.json({ message: 'Partner status granted', user });
    } catch (err) {
        console.error('[admin/partners/:id/grant]', err);
        res.status(500).json({ error: 'Failed to grant partner status' });
    }
});

// ── PATCH /api/admin/partners/:userId/revoke ─────────────────────────────────
// Revoke partner status. Emails the user. Body: optional { reason: String }
partnersRouter.patch('/:userId/revoke', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        const { reason = '' } = req.body;

        const user = await User.findByIdAndUpdate(
            userId,
            { isPartner: false },
            { new: true }
        ).select('email username isPartner');

        if (!user) return res.status(404).json({ error: 'User not found' });

        try { await sendPartnerRejectedEmail(user.email, reason || 'Partner privilege has been revoked.'); } catch (e) {
            console.error('[admin/partners] revoke email failed:', e.message);
        }

        console.log(`[admin] partner revoked: userId=${userId} by adminId=${req.user._id}`);
        res.json({ message: 'Partner status revoked', user });
    } catch (err) {
        console.error('[admin/partners/:id/revoke]', err);
        res.status(500).json({ error: 'Failed to revoke partner status' });
    }
});

// =============================================================================
// Admin API: analytics
// =============================================================================

// Platform analytics — overview, content stats, revenue.
// Overview and content: moderator+. Revenue and explore: superadmin only.
const analyticsRouter = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a date N days ago from now (start of that UTC day). */
function daysAgo(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

// ── GET /api/admin/analytics/overview ────────────────────────────────────────
// Signups and bucket creation grouped by day for the last 30 days.
// Moderator+.
analyticsRouter.get('/overview', async (req, res) => {
    try {
        const since = daysAgo(30);

        const [usersByDay, bucketsByDay, totalUsers, totalBuckets] = await Promise.all([
            User.aggregate([
                { $match: { isAnonymous: false, createdAt: { $gte: since } } },
                { $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    count: { $sum: 1 }
                }},
                { $sort: { _id: 1 } }
            ]),
            Bucket.aggregate([
                { $match: { createdAt: { $gte: since } } },
                { $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    count: { $sum: 1 }
                }},
                { $sort: { _id: 1 } }
            ]),
            User.countDocuments({ isAnonymous: false }),
            Bucket.countDocuments()
        ]);

        res.json({
            totals: { users: totalUsers, buckets: totalBuckets },
            series: { usersByDay, bucketsByDay }
        });
    } catch (err) {
        console.error('[admin/analytics/overview]', err);
        res.status(500).json({ error: 'Failed to fetch overview analytics' });
    }
});

// ── GET /api/admin/analytics/content ─────────────────────────────────────────
// Top buckets by views, top topics by bucket count. Moderator+.
analyticsRouter.get('/content', async (req, res) => {
    try {
        const [topBuckets, topTopics] = await Promise.all([
            Bucket.find({ visibility: 'public' })
                .select('name userId viewCount shareCount topic createdAt')
                .populate('userId', 'email username')
                .sort({ viewCount: -1 })
                .limit(20)
                .lean(),
            Bucket.aggregate([
                { $match: { visibility: 'public', topic: { $ne: null } } },
                { $group: { _id: '$topic', bucketCount: { $sum: 1 }, totalViews: { $sum: '$viewCount' } } },
                { $sort: { bucketCount: -1 } },
                { $limit: 15 }
            ])
        ]);

        res.json({ topBuckets, topTopics });
    } catch (err) {
        console.error('[admin/analytics/content]', err);
        res.status(500).json({ error: 'Failed to fetch content analytics' });
    }
});

// ── GET /api/admin/analytics/revenue ─────────────────────────────────────────
// Credits purchased, paywall payments, partner payouts. Superadmin only.
analyticsRouter.get('/revenue', requireSuperadmin, async (req, res) => {
    try {
        // Lazy import Transaction model
        const { default: Transaction } = await import('../models/transaction.js').catch(() => ({ default: null }));
        if (!Transaction) {
            return res.status(501).json({ error: 'Transaction model not available' });
        }

        const since = daysAgo(30);

        const revenueByDay = await Transaction.aggregate([
            { $match: { createdAt: { $gte: since } } },
            { $group: {
                _id: {
                    date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    type: '$type'
                },
                total: { $sum: '$amount' },
                count: { $sum: 1 }
            }},
            { $sort: { '_id.date': 1 } }
        ]);

        res.json({ revenueByDay });
    } catch (err) {
        console.error('[admin/analytics/revenue]', err);
        res.status(500).json({ error: 'Failed to fetch revenue analytics' });
    }
});

// ── GET /api/admin/analytics/explore ─────────────────────────────────────────
// Explore feed impressions, skips, clicks by topic. Superadmin only.
analyticsRouter.get('/explore', requireSuperadmin, async (req, res) => {
    try {
        const { default: FeedImpression } = await import('../models/feedImpression.js').catch(() => ({ default: null }));
        if (!FeedImpression) {
            return res.status(501).json({ error: 'FeedImpression model not available' });
        }

        const since = daysAgo(30);

        const impressionsByTopic = await FeedImpression.aggregate([
            { $match: { createdAt: { $gte: since } } },
            { $group: {
                _id: '$topic',
                impressions: { $sum: 1 },
                clicks:      { $sum: { $cond: ['$clicked', 1, 0] } },
                skips:       { $sum: { $cond: ['$skipped', 1, 0] } }
            }},
            { $sort: { impressions: -1 } },
            { $limit: 20 }
        ]);

        res.json({ impressionsByTopic });
    } catch (err) {
        console.error('[admin/analytics/explore]', err);
        res.status(500).json({ error: 'Failed to fetch explore analytics' });
    }
});

// =============================================================================
// Admin API: faq
// =============================================================================

const adminFaqRouter = express.Router();

// GET /api/admin/faq?status=pending|published|rejected|all
adminFaqRouter.get('/', async (req, res) => {
    try {
        const { status = 'all' } = req.query;
        const filter = status !== 'all' ? { status } : {};

        const items = await FaqItem.find(filter)
            .populate('submittedBy', 'username email')
            .sort({ createdAt: -1 })
            .lean();

        res.json({ items, categories: FAQ_CATEGORY_LABELS });
    } catch (err) {
        console.error('[admin/faq]', err);
        res.status(500).json({ error: 'Failed to fetch FAQ items' });
    }
});

// POST /api/admin/faq — create an admin-written FAQ item (published immediately)
adminFaqRouter.post('/', async (req, res) => {
    const { question, answer, category, order = 0 } = req.body;

    if (!question || !answer || !category) {
        return res.status(400).json({ error: 'question, answer, and category are required' });
    }
    if (!FAQ_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'Invalid category' });
    }

    try {
        const item = await FaqItem.create({
            question:    question.trim(),
            answer:      answer.trim(),
            category,
            source:      'admin',
            status:      'published',
            order:       Number(order) || 0,
            publishedAt: new Date(),
        });

        res.json({ ok: true, item });
    } catch (err) {
        console.error('[admin/faq/create]', err);
        res.status(500).json({ error: 'Failed to create FAQ item' });
    }
});

// PUT /api/admin/faq/:id — update question, answer, category, status, or order
adminFaqRouter.put('/:id', async (req, res) => {
    const { question, answer, category, status, order } = req.body;

    if (category !== undefined && !FAQ_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'Invalid category' });
    }

    try {
        const item = await FaqItem.findById(req.params.id);
        if (!item) return res.status(404).json({ error: 'Not found' });

        if (question  !== undefined) item.question  = question.trim();
        if (answer    !== undefined) item.answer    = answer.trim();
        if (category  !== undefined) item.category  = category;
        if (order     !== undefined) item.order     = Number(order) || 0;

        if (status === 'published' && item.status !== 'published') {
            item.status      = 'published';
            item.publishedAt = new Date();
        } else if (status === 'rejected' || status === 'pending') {
            item.status = status;
        }

        await item.save();
        res.json({ ok: true, item });
    } catch (err) {
        console.error('[admin/faq/update]', err);
        res.status(500).json({ error: 'Failed to update FAQ item' });
    }
});

// DELETE /api/admin/faq/:id
adminFaqRouter.delete('/:id', async (req, res) => {
    try {
        await FaqItem.findByIdAndDelete(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[admin/faq/delete]', err);
        res.status(500).json({ error: 'Failed to delete FAQ item' });
    }
});

// =============================================================================
// Admin API: system
// =============================================================================

// System tools — health check, broadcast notifications, job triggers.
// All routes are superadmin only.
const systemRouter = express.Router();

// ── GET /api/admin/system/health ──────────────────────────────────────────────
// Ping MongoDB, Stripe, and Resend — return status of each.
systemRouter.get('/health', async (req, res) => {
    const health = {
        mongodb: 'unknown',
        stripe:  'unknown',
        resend:  'unknown',
        checkedAt: new Date().toISOString()
    };

    // MongoDB
    try {
        health.mongodb = mongoose.connection.readyState === 1 ? 'ok' : 'degraded';
    } catch {
        health.mongodb = 'error';
    }

    // Stripe
    try {
        const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);
        await stripe.balance.retrieve();
        health.stripe = 'ok';
    } catch {
        health.stripe = 'error';
    }

    // Resend — lightweight check (just verify the API key is set)
    health.resend = process.env.RESEND_API_KEY ? 'ok' : 'not_configured';

    const allOk = Object.values(health).every(v => v === 'ok' || typeof v !== 'string' || v === health.checkedAt);
    res.status(allOk ? 200 : 207).json(health);
});

// ── POST /api/admin/system/notify ─────────────────────────────────────────────
// Broadcast a notification to all registered users (or a filtered segment).
// Body: { message: String, targetCountry?: String }
systemRouter.post('/notify', async (req, res) => {
    try {
        const { message, targetCountry } = req.body;
        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ error: '`message` string is required' });
        }

        const { default: User }         = await import('../models/user.js');
        const { default: Notification } = await import('../models/notification.js').catch(() => ({ default: null }));

        if (!Notification) {
            return res.status(501).json({ error: 'Notification model not available' });
        }

        const filter = { isAnonymous: false };
        if (targetCountry) filter.country = targetCountry.toUpperCase();

        const users = await User.find(filter).select('_id').lean();
        const userIds = users.map(u => u._id);

        const notifications = userIds.map(userId => ({
            userId,
            type:    'admin_broadcast',
            message: message.trim(),
            data:    { fromAdmin: true }
        }));

        await Notification.insertMany(notifications);

        console.log(`[admin] broadcast sent to ${userIds.length} users by adminId=${req.user._id}`);
        res.json({ message: 'Broadcast sent', recipientCount: userIds.length });
    } catch (err) {
        console.error('[admin/system/notify]', err);
        res.status(500).json({ error: 'Failed to send broadcast' });
    }
});

// ── GET /api/admin/system/jobs ────────────────────────────────────────────────
// Return the status of known background jobs (last run, next scheduled).
// Jobs track their own state in a simple in-memory or DB store.
systemRouter.get('/jobs', async (req, res) => {
    // Placeholder — wire up to actual job scheduler state once jobs
    // are refactored to persist their run timestamps.
    const jobs = [
        { name: 'buildExploreScores',  lastRun: null, status: 'unknown' },
        { name: 'buildRepositories',   lastRun: null, status: 'unknown' }
    ];

    res.json({ jobs });
});

// ── POST /api/admin/system/jobs/:jobName/run ──────────────────────────────────
// Manually trigger a background job by name.
systemRouter.post('/jobs/:jobName/run', async (req, res) => {
    const { jobName } = req.params;

    const allowedJobs = {
        buildExploreScores: () => import('../services/jobs/buildExploreScores.js'),
        buildRepositories:  () => import('../services/jobs/buildRepositories.js')
    };

    if (!allowedJobs[jobName]) {
        return res.status(400).json({ error: `Unknown job. Allowed: ${Object.keys(allowedJobs).join(', ')}` });
    }

    try {
        console.log(`[admin] manual job trigger: job=${jobName} by adminId=${req.user._id}`);
        // Fire and forget — respond immediately, job runs in background
        allowedJobs[jobName]().then(mod => {
            const fn = mod.default || mod[jobName];
            if (typeof fn === 'function') fn().catch(e => console.error(`[admin/jobs/${jobName}]`, e));
        });

        res.json({ message: `Job "${jobName}" triggered`, startedAt: new Date().toISOString() });
    } catch (err) {
        console.error('[admin/system/jobs/run]', err);
        res.status(500).json({ error: 'Failed to trigger job' });
    }
});

// =============================================================================
// Admin API: audit
// =============================================================================

// Audit log — read-only view of all privileged admin actions.
// Superadmin only.
const auditRouter = express.Router();

// ── GET /api/admin/audit ──────────────────────────────────────────────────────
// Paginated audit log with filters.
// Query params: adminId, action, targetType (user|bucket|report|...), page, limit
auditRouter.get('/', async (req, res) => {
    try {
        const { default: AdminAuditLog } = await import('../models/adminAuditLog.js').catch(() => ({ default: null }));
        if (!AdminAuditLog) {
            return res.status(501).json({ error: 'Audit log model not available' });
        }

        const { adminId, action, targetType, page = 1, limit = 50 } = req.query;

        const filter = {};
        if (adminId)    filter.adminUserId = adminId;
        if (action)     filter.action      = action;
        if (targetType) filter.targetType  = targetType;

        const skip = (Number(page) - 1) * Number(limit);

        const [logs, total] = await Promise.all([
            AdminAuditLog.find(filter)
                .populate('adminUserId', 'email username role')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            AdminAuditLog.countDocuments(filter)
        ]);

        res.json({
            logs,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (err) {
        console.error('[admin/audit GET]', err);
        res.status(500).json({ error: 'Failed to fetch audit log' });
    }
});

// =============================================================================
// Admin API: mounts, in their original order
// =============================================================================

// Before the guard below: logging in can't need a session.
adminApiRouter.use('/auth', adminAuthRouter);

// Every other route under /api/admin requires at minimum moderator role.
// Individual sub-routers apply requireSuperadmin where needed.
// ── Guard: resolve admin session, then require admin role ─────────────────────
adminApiRouter.use(adminSessionAuth, requireAdminSession);

// ── Sub-routers ───────────────────────────────────────────────────────────────
adminApiRouter.use('/users',     usersRouter);
adminApiRouter.use('/reports',   reportsRouter);
adminApiRouter.use('/buckets',   bucketsRouter);
adminApiRouter.use('/partners',  requireSuperadmin, partnersRouter); // partners: superadmin only
adminApiRouter.use('/analytics', analyticsRouter);
adminApiRouter.use('/faq',       adminFaqRouter);
adminApiRouter.use('/system',    requireSuperadmin, systemRouter);   // system:   superadmin only
adminApiRouter.use('/audit',     requireSuperadmin, auditRouter);    // audit:    superadmin only

// ── GET /api/admin/me ─────────────────────────────────────────────────────────
// Returns the current admin's identity — useful for the UI to know the role.
adminApiRouter.get('/me', (req, res) => {
    const { _id, email, username, role } = req.user;
    res.json({ _id, email, username, role });
});


router.routes = [
  { method: 'GET', path: '/login', label: 'Admin login page' },
  { method: 'GET', path: '/reset-password', label: 'Admin password reset page' },
  { method: 'GET', path: '/', label: 'Admin: redirects to users' },
  { method: 'GET', path: '/users', label: 'Admin users page' },
  { method: 'GET', path: '/users/:userId', label: 'Admin user detail page' },
  { method: 'GET', path: '/partners/applications', label: 'Admin partner applications page' },
  { method: 'GET', path: '/partners/applications/:appId', label: 'Admin partner application page' },
  { method: 'GET', path: '/faq', label: 'Admin FAQ page' },
  { method: 'GET', path: '/reports', label: 'Admin reports page' },
  { method: 'GET', path: '/buckets', label: 'Admin buckets page' },
  { method: 'GET', path: '/analytics', label: 'Admin analytics page' },
  { method: 'GET', path: '/system', label: 'Admin system page' },
  { method: 'GET', path: '/audit', label: 'Admin audit page' },
];

adminApiRouter.routes = [
  { method: 'POST', path: '/auth/login', label: 'Admin login: check password, email a code' },
  { method: 'POST', path: '/auth/verify-otp', label: 'Admin login: verify the code, start a session' },
  { method: 'POST', path: '/auth/resend-otp', label: 'Admin login: resend the code' },
  { method: 'POST', path: '/auth/forgot-password', label: 'Admin: email a password reset link' },
  { method: 'POST', path: '/auth/reset-password', label: 'Admin: set a new password' },
  { method: 'POST', path: '/auth/logout', label: 'Admin: end the session' },
  { method: 'GET', path: '/users', label: 'Admin: list users' },
  { method: 'GET', path: '/users/:userId', label: 'Admin: one user' },
  { method: 'PATCH', path: '/users/:userId/suspend', label: 'Admin: suspend or restore a user' },
  { method: 'PATCH', path: '/users/:userId/verify', label: 'Admin: mark a user verified' },
  { method: 'PATCH', path: '/users/:userId/role', label: 'Admin: change a user role (superadmin)' },
  { method: 'PATCH', path: '/users/:userId/credits', label: 'Admin: adjust a user balance (superadmin)' },
  { method: 'DELETE', path: '/users/:userId', label: 'Admin: delete a user (superadmin)' },
  { method: 'GET', path: '/reports', label: 'Admin: list reports' },
  { method: 'PATCH', path: '/reports/:type/:contentId/dismiss', label: 'Admin: dismiss a report' },
  { method: 'PATCH', path: '/reports/:type/:contentId/remove', label: 'Admin: remove reported content' },
  { method: 'PATCH', path: '/reports/:type/:contentId/ban', label: 'Admin: ban the reported user' },
  { method: 'GET', path: '/buckets', label: 'Admin: list buckets' },
  { method: 'GET', path: '/buckets/:bucketId', label: 'Admin: one bucket' },
  { method: 'PATCH', path: '/buckets/:bucketId/visibility', label: 'Admin: change bucket visibility' },
  { method: 'PATCH', path: '/buckets/:bucketId/feature', label: 'Admin: feature a bucket' },
  { method: 'PATCH', path: '/buckets/:bucketId/explore-score', label: 'Admin: set a bucket explore score (superadmin)' },
  { method: 'DELETE', path: '/buckets/:bucketId', label: 'Admin: delete a bucket' },
  { method: 'GET', path: '/partners', label: 'Admin: list partners (superadmin)' },
  { method: 'GET', path: '/partners/applications', label: 'Admin: list partner applications (superadmin)' },
  { method: 'GET', path: '/partners/applications/:appId', label: 'Admin: one partner application (superadmin)' },
  { method: 'PATCH', path: '/partners/applications/:appId/approve', label: 'Admin: approve a partner application (superadmin)' },
  { method: 'PATCH', path: '/partners/applications/:appId/reject', label: 'Admin: reject a partner application (superadmin)' },
  { method: 'PATCH', path: '/partners/:userId/grant', label: 'Admin: grant partner status (superadmin)' },
  { method: 'PATCH', path: '/partners/:userId/revoke', label: 'Admin: revoke partner status (superadmin)' },
  { method: 'GET', path: '/analytics/overview', label: 'Admin: analytics overview' },
  { method: 'GET', path: '/analytics/content', label: 'Admin: content analytics' },
  { method: 'GET', path: '/analytics/revenue', label: 'Admin: revenue analytics (superadmin)' },
  { method: 'GET', path: '/analytics/explore', label: 'Admin: explore analytics (superadmin)' },
  { method: 'GET', path: '/faq', label: 'Admin: list FAQ items' },
  { method: 'POST', path: '/faq', label: 'Admin: add a FAQ item' },
  { method: 'PUT', path: '/faq/:id', label: 'Admin: edit a FAQ item' },
  { method: 'DELETE', path: '/faq/:id', label: 'Admin: delete a FAQ item' },
  { method: 'GET', path: '/system/health', label: 'Admin: system health (superadmin)' },
  { method: 'POST', path: '/system/notify', label: 'Admin: broadcast a notification (superadmin)' },
  { method: 'GET', path: '/system/jobs', label: 'Admin: list scheduled jobs (superadmin)' },
  { method: 'POST', path: '/system/jobs/:jobName/run', label: 'Admin: run a job now (superadmin)' },
  { method: 'GET', path: '/audit', label: 'Admin: audit log (superadmin)' },
  { method: 'GET', path: '/me', label: 'Admin: current admin identity' },
];

export default router;
