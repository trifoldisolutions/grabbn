// server/routes/admin/partners.js
// Partner program management — applications queue, approve/reject, revoke.
// All routes are superadmin only.
import express from 'express';
import mongoose from 'mongoose';
import User from '../../models/user.js';

const router = express.Router();

// ── GET /api/admin/partners ───────────────────────────────────────────────────
// List all current partners.
router.get('/', async (req, res) => {
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

// ── PATCH /api/admin/partners/:userId/grant ──────────────────────────────────
// Grant partner status to a user.
// Body: optional { note: String }
router.patch('/:userId/grant', async (req, res) => {
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

        console.log(`[admin] partner granted: userId=${userId} by adminId=${req.user._id}`);
        res.json({ message: 'Partner status granted', user });
    } catch (err) {
        console.error('[admin/partners/:id/grant]', err);
        res.status(500).json({ error: 'Failed to grant partner status' });
    }
});

// ── PATCH /api/admin/partners/:userId/revoke ─────────────────────────────────
// Revoke partner status from a user.
// Body: optional { reason: String }
router.patch('/:userId/revoke', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        const user = await User.findByIdAndUpdate(
            userId,
            { isPartner: false },
            { new: true }
        ).select('email username isPartner');

        if (!user) return res.status(404).json({ error: 'User not found' });

        console.log(`[admin] partner revoked: userId=${userId} by adminId=${req.user._id}`);
        res.json({ message: 'Partner status revoked', user });
    } catch (err) {
        console.error('[admin/partners/:id/revoke]', err);
        res.status(500).json({ error: 'Failed to revoke partner status' });
    }
});

export default router;
