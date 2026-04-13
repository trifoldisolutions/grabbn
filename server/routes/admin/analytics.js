// server/routes/admin/analytics.js
// Platform analytics — overview, content stats, revenue.
// Overview and content: moderator+. Revenue and explore: superadmin only.
import express from 'express';
import User from '../../models/user.js';
import Bucket from '../../models/bucket.js';
import { requireSuperadmin } from '../../middleware/adminAuth.js';

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a date N days ago from now (start of that UTC day). */
function daysAgo(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

// ── GET /api/admin/analytics/overview ────────────────────────────────────────
// Signups and bucket creation grouped by day for the last 30 days.
// Moderator+.
router.get('/overview', async (req, res) => {
    try {
        const since = daysAgo(30);

        const [usersByDay, bucketsByDay, totalUsers, totalBuckets] = await Promise.all([
            User.aggregate([
                { $match: { isAnonymous: false, createdAt: { $gte: since } } },
                { $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    count: { $sum: 1 }
                }},
                { $sort: { _id: 1 } }
            ]),
            Bucket.aggregate([
                { $match: { createdAt: { $gte: since } } },
                { $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    count: { $sum: 1 }
                }},
                { $sort: { _id: 1 } }
            ]),
            User.countDocuments({ isAnonymous: false }),
            Bucket.countDocuments()
        ]);

        res.json({
            totals: { users: totalUsers, buckets: totalBuckets },
            series: { usersByDay, bucketsByDay }
        });
    } catch (err) {
        console.error('[admin/analytics/overview]', err);
        res.status(500).json({ error: 'Failed to fetch overview analytics' });
    }
});

// ── GET /api/admin/analytics/content ─────────────────────────────────────────
// Top buckets by views, top topics by bucket count. Moderator+.
router.get('/content', async (req, res) => {
    try {
        const [topBuckets, topTopics] = await Promise.all([
            Bucket.find({ visibility: 'public' })
                .select('name userId viewCount shareCount topic createdAt')
                .populate('userId', 'email username')
                .sort({ viewCount: -1 })
                .limit(20)
                .lean(),
            Bucket.aggregate([
                { $match: { visibility: 'public', topic: { $ne: null } } },
                { $group: { _id: '$topic', bucketCount: { $sum: 1 }, totalViews: { $sum: '$viewCount' } } },
                { $sort: { bucketCount: -1 } },
                { $limit: 15 }
            ])
        ]);

        res.json({ topBuckets, topTopics });
    } catch (err) {
        console.error('[admin/analytics/content]', err);
        res.status(500).json({ error: 'Failed to fetch content analytics' });
    }
});

// ── GET /api/admin/analytics/revenue ─────────────────────────────────────────
// Credits purchased, paywall payments, partner payouts. Superadmin only.
router.get('/revenue', requireSuperadmin, async (req, res) => {
    try {
        // Lazy import Transaction model
        const { default: Transaction } = await import('../../models/transaction.js').catch(() => ({ default: null }));
        if (!Transaction) {
            return res.status(501).json({ error: 'Transaction model not available' });
        }

        const since = daysAgo(30);

        const revenueByDay = await Transaction.aggregate([
            { $match: { createdAt: { $gte: since } } },
            { $group: {
                _id: {
                    date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    type: '$type'
                },
                total: { $sum: '$amount' },
                count: { $sum: 1 }
            }},
            { $sort: { '_id.date': 1 } }
        ]);

        res.json({ revenueByDay });
    } catch (err) {
        console.error('[admin/analytics/revenue]', err);
        res.status(500).json({ error: 'Failed to fetch revenue analytics' });
    }
});

// ── GET /api/admin/analytics/explore ─────────────────────────────────────────
// Explore feed impressions, skips, clicks by topic. Superadmin only.
router.get('/explore', requireSuperadmin, async (req, res) => {
    try {
        const { default: FeedImpression } = await import('../../models/feedImpression.js').catch(() => ({ default: null }));
        if (!FeedImpression) {
            return res.status(501).json({ error: 'FeedImpression model not available' });
        }

        const since = daysAgo(30);

        const impressionsByTopic = await FeedImpression.aggregate([
            { $match: { createdAt: { $gte: since } } },
            { $group: {
                _id: '$topic',
                impressions: { $sum: 1 },
                clicks:      { $sum: { $cond: ['$clicked', 1, 0] } },
                skips:       { $sum: { $cond: ['$skipped', 1, 0] } }
            }},
            { $sort: { impressions: -1 } },
            { $limit: 20 }
        ]);

        res.json({ impressionsByTopic });
    } catch (err) {
        console.error('[admin/analytics/explore]', err);
        res.status(500).json({ error: 'Failed to fetch explore analytics' });
    }
});

export default router;
