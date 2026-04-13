// server/routes/admin/reports.js
// Content moderation — reports queue for buckets and comments.
// Accessible by moderators and superadmins.
import express from 'express';
import mongoose from 'mongoose';

const router = express.Router();

// ── Lazy model imports ────────────────────────────────────────────────────────
// Imported inline to avoid circular dependency issues at boot.
async function getModels() {
    const { default: Report }        = await import('../../models/report.js').catch(() => ({ default: null }));
    const { default: Bucket }        = await import('../../models/bucket.js');
    const { default: BucketComment } = await import('../../models/bucketComment.js');
    const { default: User }          = await import('../../models/user.js');
    return { Report, Bucket, BucketComment, User };
}

// ── GET /api/admin/reports ────────────────────────────────────────────────────
// Paginated list of reports.
// Query params: type (bucket|comment), status (pending|reviewed|actioned), page, limit
router.get('/', async (req, res) => {
    try {
        const { Bucket, BucketComment } = await getModels();
        const { type, status = 'pending', page = 1, limit = 20 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);

        // Reports are stored as embedded arrays on Bucket and BucketComment.
        // We aggregate across both unless a type filter is applied.
        const results = [];

        if (!type || type === 'bucket') {
            const buckets = await Bucket.aggregate([
                { $match: { 'reports.0': { $exists: true } } },
                { $unwind: '$reports' },
                { $addFields: { reportType: 'bucket' } },
                { $sort: { 'reports.createdAt': -1 } },
                { $skip: skip },
                { $limit: Number(limit) }
            ]);
            results.push(...buckets);
        }

        if (!type || type === 'comment') {
            const comments = await BucketComment.aggregate([
                { $match: { 'reports.0': { $exists: true } } },
                { $unwind: '$reports' },
                { $addFields: { reportType: 'comment' } },
                { $sort: { 'reports.createdAt': -1 } },
                { $skip: skip },
                { $limit: Number(limit) }
            ]);
            results.push(...comments);
        }

        res.json({ reports: results, page: Number(page), limit: Number(limit) });
    } catch (err) {
        console.error('[admin/reports GET]', err);
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});

// ── PATCH /api/admin/reports/:type/:contentId/dismiss ────────────────────────
// Dismiss all reports on a piece of content — no action taken.
// :type = 'bucket' | 'comment'
router.patch('/:type/:contentId/dismiss', async (req, res) => {
    try {
        const { type, contentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const { Bucket, BucketComment } = await getModels();
        const Model = type === 'bucket' ? Bucket : type === 'comment' ? BucketComment : null;
        if (!Model) return res.status(400).json({ error: 'type must be bucket or comment' });

        await Model.findByIdAndUpdate(contentId, { $set: { reports: [] } });

        console.log(`[admin] report dismissed: type=${type} contentId=${contentId} by adminId=${req.user._id}`);
        res.json({ message: 'Reports dismissed' });
    } catch (err) {
        console.error('[admin/reports dismiss]', err);
        res.status(500).json({ error: 'Failed to dismiss reports' });
    }
});

// ── PATCH /api/admin/reports/:type/:contentId/remove ─────────────────────────
// Remove the reported content (soft delete / hide).
router.patch('/:type/:contentId/remove', async (req, res) => {
    try {
        const { type, contentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const { Bucket, BucketComment } = await getModels();

        if (type === 'bucket') {
            await Bucket.findByIdAndUpdate(contentId, { visibility: 'private', reports: [] });
        } else if (type === 'comment') {
            await BucketComment.findByIdAndDelete(contentId);
        } else {
            return res.status(400).json({ error: 'type must be bucket or comment' });
        }

        console.log(`[admin] content removed: type=${type} contentId=${contentId} by adminId=${req.user._id}`);
        res.json({ message: 'Content removed' });
    } catch (err) {
        console.error('[admin/reports remove]', err);
        res.status(500).json({ error: 'Failed to remove content' });
    }
});

// ── PATCH /api/admin/reports/:type/:contentId/ban ────────────────────────────
// Remove the reported content AND suspend the content owner.
router.patch('/:type/:contentId/ban', async (req, res) => {
    try {
        const { type, contentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const { Bucket, BucketComment, User } = await getModels();
        let ownerId;

        if (type === 'bucket') {
            const bucket = await Bucket.findByIdAndUpdate(
                contentId,
                { visibility: 'private', reports: [] },
                { new: true }
            ).select('userId');
            if (!bucket) return res.status(404).json({ error: 'Bucket not found' });
            ownerId = bucket.userId;
        } else if (type === 'comment') {
            const comment = await BucketComment.findById(contentId).select('userId');
            if (!comment) return res.status(404).json({ error: 'Comment not found' });
            ownerId = comment.userId;
            await BucketComment.findByIdAndDelete(contentId);
        } else {
            return res.status(400).json({ error: 'type must be bucket or comment' });
        }

        if (ownerId) {
            const owner = await User.findById(ownerId);
            if (owner && owner.role === 'user') {
                owner.accountSuspendedAt = new Date();
                await owner.save();
            }
        }

        console.log(`[admin] content removed + user banned: type=${type} contentId=${contentId} ownerId=${ownerId} by adminId=${req.user._id}`);
        res.json({ message: 'Content removed and user suspended', ownerId });
    } catch (err) {
        console.error('[admin/reports ban]', err);
        res.status(500).json({ error: 'Failed to remove content and ban user' });
    }
});

export default router;
