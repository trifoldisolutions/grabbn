// server/middleware/adminAuth.js
// Admin-tier authorization middleware.
// Must always be stacked AFTER anonymousAuth (which populates req.user).
//
// Usage:
//   router.use(anonymousAuth, requireModerator);           // moderator + superadmin
//   router.use(anonymousAuth, requireSuperadmin);          // superadmin only
//   router.patch('/...', requireSuperadmin, handler);      // per-route override

/**
 * Allows moderators and superadmins through.
 * Rejects anonymous users, regular users, and unauthenticated requests.
 */
export function requireModerator(req, res, next) {
    if (
        !req.user ||
        req.user.isAnonymous ||
        !['moderator', 'superadmin'].includes(req.user.role)
    ) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}

/**
 * Blocks admin accounts (moderator / superadmin) from accessing the regular
 * user-facing frontend. Redirects them to the admin panel instead.
 * Apply as: app.use('/v2', requireNonAdmin)
 */
export function requireNonAdmin(req, res, next) {
    if (
        req.user &&
        !req.user.isAnonymous &&
        ['moderator', 'superadmin'].includes(req.user.role)
    ) {
        return res.redirect('/admin');
    }
    next();
}

/**
 * Allows superadmins only.
 * Use this for privileged actions: role changes, financial controls, system tools.
 */
export function requireSuperadmin(req, res, next) {
    if (
        !req.user ||
        req.user.isAnonymous ||
        req.user.role !== 'superadmin'
    ) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}
