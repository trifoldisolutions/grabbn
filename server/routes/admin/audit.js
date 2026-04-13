// server/routes/admin/audit.js
// Audit log — read-only view of all privileged admin actions.
// Superadmin only.
import express from 'express';

const router = express.Router();

// ── GET /api/admin/audit ──────────────────────────────────────────────────────
// Paginated audit log with filters.
// Query params: adminId, action, targetType (user|bucket|report|...), page, limit
router.get('/', async (req, res) => {
    try {
        const { default: AdminAuditLog } = await import('../../models/adminAuditLog.js').catch(() => ({ default: null }));
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

export default router;
