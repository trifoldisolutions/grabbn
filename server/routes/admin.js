// server/routes/admin.js
// Root admin router — all sub-routers are mounted here.
// Every route under /api/admin/* requires at minimum moderator role.
// Individual sub-routers apply requireSuperadmin where needed.
import express from 'express';
import { requireSuperadmin } from '../middleware/adminAuth.js';
import { adminSessionAuth, requireAdminSession } from '../middleware/adminSessionAuth.js';

import usersRouter     from './admin/users.js';
import reportsRouter   from './admin/reports.js';
import bucketsRouter   from './admin/buckets.js';
import partnersRouter  from './admin/partners.js';
import analyticsRouter from './admin/analytics.js';
import systemRouter    from './admin/system.js';
import auditRouter     from './admin/audit.js';
import faqRouter       from './admin/faq.js';

const router = express.Router();

// ── Guard: resolve admin session, then require admin role ─────────────────────
router.use(adminSessionAuth, requireAdminSession);

// ── Sub-routers ───────────────────────────────────────────────────────────────
router.use('/users',     usersRouter);
router.use('/reports',   reportsRouter);
router.use('/buckets',   bucketsRouter);
router.use('/partners',  requireSuperadmin, partnersRouter); // partners: superadmin only
router.use('/analytics', analyticsRouter);
router.use('/faq',       faqRouter);
router.use('/system',    requireSuperadmin, systemRouter);   // system:   superadmin only
router.use('/audit',     requireSuperadmin, auditRouter);    // audit:    superadmin only

// ── GET /api/admin/me ─────────────────────────────────────────────────────────
// Returns the current admin's identity — useful for the UI to know the role.
router.get('/me', (req, res) => {
    const { _id, email, username, role } = req.user;
    res.json({ _id, email, username, role });
});

export default router;
