// server/routes/block.js
import express from 'express';
import mongoose from 'mongoose';
import Block from '../models/block.js';
import User from '../models/user.js';
import { anonymousAuth, requireVerification } from '../middleware/anonymousAuth.js';

const router = express.Router();
router.use(anonymousAuth);

function requireRegistered(req, res, next) {
    if (!req.user || req.user.isAnonymous) {
        return res.status(401).json({ error: 'Login required' });
    }
    next();
}

// POST /api/users/:userId/block — block a user
router.post('/:userId/block', requireRegistered, requireVerification, async (req, res) => {
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
router.delete('/:userId/block', requireRegistered, async (req, res) => {
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
router.get('/blocked', requireRegistered, async (req, res) => {
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

export default router;
