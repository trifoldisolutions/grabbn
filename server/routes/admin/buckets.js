// server/routes/admin/buckets.js
// Bucket & content management — browse all buckets, take down, feature, delete.
// Accessible by moderators and superadmins.
// exploreScore override is locked to superadmin only.
import express from 'express';
import mongoose from 'mongoose';
import Bucket from '../../models/bucket.js';
import { requireSuperadmin } from '../../middleware/adminAuth.js';

const router = express.Router();

// ── GET /api/admin/buckets ────────────────────────────────────────────────────
// List all buckets (any visibility) with filters + sorting.
// Query params: owner (userId), visibility, topic, isPaywalled,
//               sort (views|rating|exploreScore|createdAt), page, limit
router.get('/', async (req, res) => {
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
router.get('/:bucketId', async (req, res) => {
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
router.patch('/:bucketId/visibility', async (req, res) => {
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
router.patch('/:bucketId/feature', async (req, res) => {
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
router.patch('/:bucketId/explore-score', requireSuperadmin, async (req, res) => {
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
router.delete('/:bucketId', async (req, res) => {
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

export default router;
