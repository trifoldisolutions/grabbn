// server/routes/admin/partners.js
// Partner program management — applications queue, approve/reject, revoke.
// All routes are superadmin only (guard applied in admin.js).
import express from 'express';
import mongoose from 'mongoose';
import User from '../../models/user.js';
import PartnerApplication from '../../models/partnerApplication.js';
import { sendPartnerApprovedEmail, sendPartnerRejectedEmail } from '../../utils/email.js';

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

// ── GET /api/admin/partners/applications ─────────────────────────────────────
// List partner applications. Supports ?status=pending|approved|rejected
router.get('/applications', async (req, res) => {
    try {
        const { status = 'pending', page = 1, limit = 30 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const filter = status ? { status } : {};

        const [applications, total] = await Promise.all([
            PartnerApplication.find(filter)
                .populate('userId', 'email username isEmailVerified createdAt country')
                .sort({ submittedAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            PartnerApplication.countDocuments(filter)
        ]);

        res.json({
            applications,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (err) {
        console.error('[admin/partners/applications GET]', err);
        res.status(500).json({ error: 'Failed to fetch applications' });
    }
});

// ── GET /api/admin/partners/applications/:appId ───────────────────────────────
// Get a single application with full detail (including ID/selfie files).
router.get('/applications/:appId', async (req, res) => {
    try {
        const { appId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(appId)) {
            return res.status(400).json({ error: 'Invalid application ID' });
        }

        const application = await PartnerApplication.findById(appId)
            .populate('userId', 'email username isEmailVerified createdAt country isPartner')
            .lean();

        if (!application) return res.status(404).json({ error: 'Application not found' });

        res.json({ application });
    } catch (err) {
        console.error('[admin/partners/applications/:id GET]', err);
        res.status(500).json({ error: 'Failed to fetch application' });
    }
});

// ── PATCH /api/admin/partners/applications/:appId/approve ────────────────────
// Approve an application — grants partner status and emails the user.
router.patch('/applications/:appId/approve', async (req, res) => {
    try {
        const { appId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(appId)) {
            return res.status(400).json({ error: 'Invalid application ID' });
        }

        const application = await PartnerApplication.findById(appId).populate('userId', 'email isPartner');
        if (!application) return res.status(404).json({ error: 'Application not found' });
        if (application.status !== 'pending') {
            return res.status(409).json({ error: 'Application is no longer pending' });
        }

        application.status     = 'approved';
        application.reviewedAt = new Date();
        application.reviewedBy = req.user._id;
        await application.save();

        await User.findByIdAndUpdate(application.userId._id, { isPartner: true });

        try { await sendPartnerApprovedEmail(application.userId.email); } catch (e) {
            console.error('[admin/partners] approve email failed:', e.message);
        }

        console.log(`[admin] partner application approved: appId=${appId} userId=${application.userId._id} by adminId=${req.user._id}`);
        res.json({ message: 'Application approved, partner status granted' });
    } catch (err) {
        console.error('[admin/partners/applications/:id/approve]', err);
        res.status(500).json({ error: 'Failed to approve application' });
    }
});

// ── PATCH /api/admin/partners/applications/:appId/reject ─────────────────────
// Reject an application. Body: { reason? }
router.patch('/applications/:appId/reject', async (req, res) => {
    try {
        const { appId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(appId)) {
            return res.status(400).json({ error: 'Invalid application ID' });
        }

        const { reason = '' } = req.body;

        const application = await PartnerApplication.findById(appId).populate('userId', 'email');
        if (!application) return res.status(404).json({ error: 'Application not found' });
        if (application.status !== 'pending') {
            return res.status(409).json({ error: 'Application is no longer pending' });
        }

        application.status          = 'rejected';
        application.reviewedAt      = new Date();
        application.reviewedBy      = req.user._id;
        application.rejectionReason = String(reason).slice(0, 1000);
        await application.save();

        try { await sendPartnerRejectedEmail(application.userId.email, reason); } catch (e) {
            console.error('[admin/partners] reject email failed:', e.message);
        }

        console.log(`[admin] partner application rejected: appId=${appId} by adminId=${req.user._id}`);
        res.json({ message: 'Application rejected' });
    } catch (err) {
        console.error('[admin/partners/applications/:id/reject]', err);
        res.status(500).json({ error: 'Failed to reject application' });
    }
});

// ── PATCH /api/admin/partners/:userId/grant ──────────────────────────────────
// Grant partner status directly (bypass application). Emails the user.
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

        try { await sendPartnerApprovedEmail(user.email); } catch (e) {
            console.error('[admin/partners] grant email failed:', e.message);
        }

        console.log(`[admin] partner granted: userId=${userId} by adminId=${req.user._id}`);
        res.json({ message: 'Partner status granted', user });
    } catch (err) {
        console.error('[admin/partners/:id/grant]', err);
        res.status(500).json({ error: 'Failed to grant partner status' });
    }
});

// ── PATCH /api/admin/partners/:userId/revoke ─────────────────────────────────
// Revoke partner status. Emails the user. Body: optional { reason: String }
router.patch('/:userId/revoke', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        const { reason = '' } = req.body;

        const user = await User.findByIdAndUpdate(
            userId,
            { isPartner: false },
            { new: true }
        ).select('email username isPartner');

        if (!user) return res.status(404).json({ error: 'User not found' });

        try { await sendPartnerRejectedEmail(user.email, reason || 'Partner privilege has been revoked.'); } catch (e) {
            console.error('[admin/partners] revoke email failed:', e.message);
        }

        console.log(`[admin] partner revoked: userId=${userId} by adminId=${req.user._id}`);
        res.json({ message: 'Partner status revoked', user });
    } catch (err) {
        console.error('[admin/partners/:id/revoke]', err);
        res.status(500).json({ error: 'Failed to revoke partner status' });
    }
});

export default router;
