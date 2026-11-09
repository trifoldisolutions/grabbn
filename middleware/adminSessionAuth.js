// middleware/adminSessionAuth.js
//
// Reads the admin-only session cookie (_gadmin) and, if it holds a valid session
// token, sets req.user to the admin's User document. This runs AFTER the global
// anonymousAuth (which sets req.user to the regular-user session) and always
// replaces that identity, so admin routes only ever see an admin session: a
// regular-user session never opens the admin panel, even on an admin account.
//
// The two cookies are completely independent:
//   anonymousId → regular user session (regular frontend)
//   _gadmin     → admin session (admin panel only): a random token, stored hashed

import crypto from 'crypto';
import User from '../models/user.js';
import AdminSession from '../models/adminSession.js';

export const ADMIN_COOKIE = '_gadmin';
export const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000; // 8-hour admin session
const ADMIN_ROLES = ['moderator', 'superadmin'];

// String(): cookie-parser turns a "j:" cookie into an object
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Starts an admin session and returns its raw token, for the _gadmin cookie.
 */
export async function createAdminSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await AdminSession.create({
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + ADMIN_SESSION_MS),
    });
    return token;
}

/**
 * Ends the admin session a raw token belongs to, so a copy of it stops working too.
 */
export async function deleteAdminSession(token) {
    await AdminSession.deleteOne({ tokenHash: hashToken(token) });
}

/**
 * Replaces req.user with the admin User document if the _gadmin cookie holds a
 * live session and the account holds an admin role, and with null otherwise.
 * Safe to call on every admin route — silently noops if cookie is absent/stale.
 */
export async function adminSessionAuth(req, res, next) {
    req.user = null;

    const token = req.cookies?.[ADMIN_COOKIE];
    if (!token) return next();

    try {
        const session = await AdminSession.findOne({
            tokenHash: hashToken(token),
            expiresAt: { $gt: new Date() },
        }).lean();
        const user = session && await User.findById(session.userId).lean();
        // All password changes set passwordChangedAt, so they all end older sessions
        const passwordChanged = user?.passwordChangedAt && user.passwordChangedAt > session.createdAt;

        if (user && !user.isAnonymous && ADMIN_ROLES.includes(user.role) && !passwordChanged) {
            req.user = user;
        } else {
            // Cookie is stale, account was demoted or its password changed — end the session
            if (session) await AdminSession.deleteOne({ _id: session._id });
            res.clearCookie(ADMIN_COOKIE);
        }
    } catch {
        // DB error — req.user stays null, guard below will reject
    }

    next();
}

/**
 * Rejects requests where the resolved req.user is not an admin.
 * Returns 403 for API calls, redirects to /admin/login for page requests.
 */
export function requireAdminSession(req, res, next) {
    const u = req.user;
    if (!u || u.isAnonymous || !ADMIN_ROLES.includes(u.role)) {
        if (req.originalUrl.startsWith('/api/')) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        return res.redirect('/admin/login');
    }
    next();
}
