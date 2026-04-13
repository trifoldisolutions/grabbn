// server/middleware/adminSessionAuth.js
//
// Reads the admin-only session cookie (_gadmin) and, if valid, overrides
// req.user with the admin's User document. This runs AFTER the global
// anonymousAuth (which sets req.user to the regular-user session) so that
// admin routes always see the admin identity, never the regular-user identity.
//
// The two cookies are completely independent:
//   anonymousId → regular user session (regular frontend)
//   _gadmin     → admin session (admin panel only)

import User from '../models/user.js';

export const ADMIN_COOKIE = '_gadmin';
const ADMIN_ROLES = ['moderator', 'superadmin'];

/**
 * Reads _gadmin cookie and overrides req.user with the admin User document
 * if the cookie is valid and the account holds an admin role.
 * Safe to call on every admin route — silently noops if cookie is absent/stale.
 */
export async function adminSessionAuth(req, res, next) {
    const adminId = req.cookies?.[ADMIN_COOKIE];
    if (!adminId) return next();

    try {
        const user = await User.findById(adminId).lean();

        if (user && !user.isAnonymous && ADMIN_ROLES.includes(user.role)) {
            req.user = user; // override the regular-user session for this request
        } else {
            // Cookie is stale or account was demoted — clear it
            res.clearCookie(ADMIN_COOKIE);
        }
    } catch {
        // DB error — leave req.user as-is, guard below will reject
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
