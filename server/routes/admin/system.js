// server/routes/admin/system.js
// System tools — health check, broadcast notifications, job triggers.
// All routes are superadmin only.
import express from 'express';
import mongoose from 'mongoose';

const router = express.Router();

// ── GET /api/admin/system/health ──────────────────────────────────────────────
// Ping MongoDB, Stripe, and Resend — return status of each.
router.get('/health', async (req, res) => {
    const health = {
        mongodb: 'unknown',
        stripe:  'unknown',
        resend:  'unknown',
        checkedAt: new Date().toISOString()
    };

    // MongoDB
    try {
        health.mongodb = mongoose.connection.readyState === 1 ? 'ok' : 'degraded';
    } catch {
        health.mongodb = 'error';
    }

    // Stripe
    try {
        const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);
        await stripe.balance.retrieve();
        health.stripe = 'ok';
    } catch {
        health.stripe = 'error';
    }

    // Resend — lightweight check (just verify the API key is set)
    health.resend = process.env.RESEND_API_KEY ? 'ok' : 'not_configured';

    const allOk = Object.values(health).every(v => v === 'ok' || typeof v !== 'string' || v === health.checkedAt);
    res.status(allOk ? 200 : 207).json(health);
});

// ── POST /api/admin/system/notify ─────────────────────────────────────────────
// Broadcast a notification to all registered users (or a filtered segment).
// Body: { message: String, targetCountry?: String }
router.post('/notify', async (req, res) => {
    try {
        const { message, targetCountry } = req.body;
        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ error: '`message` string is required' });
        }

        const { default: User }         = await import('../../models/user.js');
        const { default: Notification } = await import('../../models/notification.js').catch(() => ({ default: null }));

        if (!Notification) {
            return res.status(501).json({ error: 'Notification model not available' });
        }

        const filter = { isAnonymous: false };
        if (targetCountry) filter.country = targetCountry.toUpperCase();

        const users = await User.find(filter).select('_id').lean();
        const userIds = users.map(u => u._id);

        const notifications = userIds.map(userId => ({
            userId,
            type:    'admin_broadcast',
            message: message.trim(),
            data:    { fromAdmin: true }
        }));

        await Notification.insertMany(notifications);

        console.log(`[admin] broadcast sent to ${userIds.length} users by adminId=${req.user._id}`);
        res.json({ message: 'Broadcast sent', recipientCount: userIds.length });
    } catch (err) {
        console.error('[admin/system/notify]', err);
        res.status(500).json({ error: 'Failed to send broadcast' });
    }
});

// ── GET /api/admin/system/jobs ────────────────────────────────────────────────
// Return the status of known background jobs (last run, next scheduled).
// Jobs track their own state in a simple in-memory or DB store.
router.get('/jobs', async (req, res) => {
    // Placeholder — wire up to actual job scheduler state once jobs
    // are refactored to persist their run timestamps.
    const jobs = [
        { name: 'buildExploreScores',  lastRun: null, status: 'unknown' },
        { name: 'buildRepositories',   lastRun: null, status: 'unknown' }
    ];

    res.json({ jobs });
});

// ── POST /api/admin/system/jobs/:jobName/run ──────────────────────────────────
// Manually trigger a background job by name.
router.post('/jobs/:jobName/run', async (req, res) => {
    const { jobName } = req.params;

    const allowedJobs = {
        buildExploreScores: () => import('../../jobs/buildExploreScores.js'),
        buildRepositories:  () => import('../../jobs/buildRepositories.js')
    };

    if (!allowedJobs[jobName]) {
        return res.status(400).json({ error: `Unknown job. Allowed: ${Object.keys(allowedJobs).join(', ')}` });
    }

    try {
        console.log(`[admin] manual job trigger: job=${jobName} by adminId=${req.user._id}`);
        // Fire and forget — respond immediately, job runs in background
        allowedJobs[jobName]().then(mod => {
            const fn = mod.default || mod[jobName];
            if (typeof fn === 'function') fn().catch(e => console.error(`[admin/jobs/${jobName}]`, e));
        });

        res.json({ message: `Job "${jobName}" triggered`, startedAt: new Date().toISOString() });
    } catch (err) {
        console.error('[admin/system/jobs/run]', err);
        res.status(500).json({ error: 'Failed to trigger job' });
    }
});

export default router;
