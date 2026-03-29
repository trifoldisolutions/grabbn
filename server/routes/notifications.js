// server/routes/notifications.js
import express from 'express';
import mongoose from 'mongoose';
import Notification from '../models/notification.js';
import Bucket from '../models/bucket.js';
import { anonymousAuth, requireAuth } from '../middleware/anonymousAuth.js';

const router = express.Router();

// All notification routes require a real (non-anonymous) account
router.use(anonymousAuth, requireAuth, (req, res, next) => {
    if (req.user.isAnonymous) return res.status(403).json({ error: 'Forbidden' });
    next();
});

// ── GET /api/notifications ────────────────────────────────────────────────────
// Returns paginated notifications for the current user, newest first.
// Query params: page (default 1), limit (default 20, max 50)
router.get('/', async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip  = (page - 1) * limit;

        const [notifications, total] = await Promise.all([
            Notification.find({ userId: req.user._id })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Notification.countDocuments({ userId: req.user._id }),
        ]);

        // Attach bucket thumbnails in one batch query — keeps notification
        // documents lean while still giving the frontend what it needs to render.
        const bucketIds = notifications
            .map(n => n.data?.bucketId || n.data?.sourceBucketId)
            .filter(Boolean);

        if (bucketIds.length) {
            const buckets = await Bucket.find({ _id: { $in: bucketIds } })
                .select('thumbnail')
                .lean();
            const thumbMap = Object.fromEntries(buckets.map(b => [String(b._id), b.thumbnail || '']));

            for (const n of notifications) {
                const id = n.data?.bucketId || n.data?.sourceBucketId;
                if (id) n.data.bucketThumbnail = thumbMap[String(id)] || '';
            }
        }

        res.json({
            notifications,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
        });
    } catch (err) {
        console.error('[notifications] GET /:', err);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// ── GET /api/notifications/unread-count ──────────────────────────────────────
router.get('/unread-count', async (req, res) => {
    try {
        const count = await Notification.countDocuments({
            userId: req.user._id,
            read: false,
        });
        res.json({ count });
    } catch (err) {
        console.error('[notifications] GET /unread-count:', err);
        res.status(500).json({ error: 'Failed to fetch unread count' });
    }
});

// ── POST /api/notifications/read ─────────────────────────────────────────────
// Body: { ids: ['...', '...'] }  — mark specific notifications as read
//       {}                       — mark ALL as read
router.post('/read', async (req, res) => {
    try {
        const { ids } = req.body;

        const filter = { userId: req.user._id, read: false };

        if (Array.isArray(ids) && ids.length > 0) {
            const objectIds = ids
                .filter(id => mongoose.Types.ObjectId.isValid(id))
                .map(id => new mongoose.Types.ObjectId(id));

            if (objectIds.length === 0) {
                return res.status(400).json({ error: 'No valid notification IDs provided' });
            }

            filter._id = { $in: objectIds };
        }

        const result = await Notification.updateMany(filter, { $set: { read: true } });
        res.json({ updated: result.modifiedCount });
    } catch (err) {
        console.error('[notifications] POST /read:', err);
        res.status(500).json({ error: 'Failed to mark notifications as read' });
    }
});

export default router;
