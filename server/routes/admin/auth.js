// server/routes/admin/auth.js
// Admin-specific authentication — issues a separate _gadmin session cookie
// that is completely independent of the regular-user anonymousId cookie.
// Mounted at /api/admin/auth (before the requireAdminSession guard).

import express      from 'express';
import crypto       from 'crypto';
import User         from '../../models/user.js';
import { sendOtpEmail, sendPasswordResetEmail } from '../../utils/email.js';
import { ADMIN_COOKIE } from '../../middleware/adminSessionAuth.js';

const router     = express.Router();
const ADMIN_ROLES = ['moderator', 'superadmin'];
const isProd      = process.env.NODE_ENV === 'production';

// ── OTP helper (mirrors the one in auth.js) ───────────────────────────────────
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
router.post('/login', async (req, res) => {
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
router.post('/verify-otp', async (req, res) => {
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
        res.cookie(ADMIN_COOKIE, user._id.toString(), {
            maxAge:   8 * 60 * 60 * 1000, // 8-hour admin session
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
router.post('/resend-otp', async (req, res) => {
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
router.post('/forgot-password', async (req, res) => {
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
router.post('/reset-password', async (req, res) => {
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
// Clears only the admin cookie — regular user session is untouched.
router.post('/logout', (req, res) => {
    res.clearCookie(ADMIN_COOKIE);
    res.json({ success: true });
});

export default router;
