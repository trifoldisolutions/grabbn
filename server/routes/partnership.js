// server/routes/partnership.js
// Public-facing partnership application routes.
// All routes require a logged-in, non-anonymous, verified user.
import express from 'express';
import PartnerApplication from '../models/partnerApplication.js';
import Bucket             from '../models/bucket.js';
import Subscription       from '../models/subscription.js';
import User               from '../models/user.js';
import { uploadImageToR2 } from '../utils/r2.js';

const router = express.Router();

// ── Middleware: must be a verified, non-anonymous user ────────────────────────
function requireVerifiedUser(req, res, next) {
    const u = req.user;
    if (!u || u.isAnonymous) return res.status(401).json({ error: 'Sign in to apply' });
    if (!u.isEmailVerified)  return res.status(403).json({ error: 'Verify your email before applying' });
    next();
}

// ── GET /api/partnership/status ───────────────────────────────────────────────
// Returns the current user's application status (or null if never applied).
router.get('/status', requireVerifiedUser, async (req, res) => {
    try {
        // Partners: fetch their approved application (to get the correct tier).
        // Non-partners: fetch their latest application (any status) to surface pending/rejected state.
        const query = req.user.isPartner
            ? { userId: req.user._id, status: 'approved' }
            : { userId: req.user._id };

        const app = await PartnerApplication
            .findOne(query)
            .sort({ submittedAt: -1 })
            .select('status tier submittedAt reviewedAt rejectionReason')
            .lean();

        res.json({ isPartner: req.user.isPartner, application: app ?? null });
    } catch (err) {
        console.error('[partnership/status]', err);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// ── GET /api/partnership/eligibility ─────────────────────────────────────────
// Computes the applicant's eligibility against Junior and Pro thresholds.
// Returns gate checks (hard blocks) and per-stat values for both tiers.
router.get('/eligibility', requireVerifiedUser, async (req, res) => {
    try {
        const user   = req.user;
        const userId = user._id;
        const now    = new Date();

        // ── Phase A: hard gates ────────────────────────────────────────────────
        const emailVerified      = !!user.isEmailVerified;
        const accountStanding    = !user.accountSuspendedAt;
        const notAlreadyPartner  = !user.isPartner;
        const pendingApp         = await PartnerApplication.findOne({ userId, status: 'pending' }).lean();
        const noActiveApplication = !pendingApp;

        // ── Account age ────────────────────────────────────────────────────────
        const accountAgeDays   = Math.floor((now - new Date(user.createdAt)) / 86400000);
        const accountAgeMonths = accountAgeDays / 30.44;

        // ── Public buckets (load once, compute everything from this set) ───────
        const publicBuckets = await Bucket
            .find({ userId, isPublic: true, isDraft: { $ne: true } })
            .select('links createdAt grabbedBy')
            .lean();

        const totalPublicBuckets = publicBuckets.length;

        // ── Grab count ─────────────────────────────────────────────────────────
        const grabCount = publicBuckets.reduce(
            (sum, b) => sum + (b.grabbedBy?.length ?? 0), 0
        );

        // ── Subscriber count ───────────────────────────────────────────────────
        const subscriberCount = await Subscription.countDocuments({ followeeId: userId });

        // ── Enforcement record ─────────────────────────────────────────────────
        // No dedicated violations model yet — accountSuspendedAt is used as proxy.
        const daysSinceLastViolation = user.accountSuspendedAt
            ? Math.floor((now - new Date(user.accountSuspendedAt)) / 86400000)
            : null; // null = no violations on record

        // ── Qualifying buckets ─────────────────────────────────────────────────
        // A bucket qualifies for a tier when:
        //   1. It has been public for at least minAgeDays
        //   2. It has at least minLinks non-archived links each with >= minClicks clicks
        function countQualifyingBuckets(minAgeDays, minLinks, minClicks) {
            const ageCutoff = new Date(now - minAgeDays * 86400000);
            return publicBuckets.filter(b => {
                if (new Date(b.createdAt) > ageCutoff) return false;
                const qualLinks = (b.links ?? []).filter(
                    l => !l.isArchived && (l.clickCount ?? 0) >= minClicks
                );
                return qualLinks.length >= minLinks;
            }).length;
        }

        const juniorQualifyingBuckets = countQualifyingBuckets(90,  3,  250);
        const proQualifyingBuckets    = countQualifyingBuckets(180, 10, 1000);

        // ── Per-tier pass/fail ─────────────────────────────────────────────────
        const juniorEnforcementOk = daysSinceLastViolation === null || daysSinceLastViolation >= 60;
        const proEnforcementOk    = daysSinceLastViolation === null || daysSinceLastViolation >= 180;

        const gatesPass = emailVerified && accountStanding && notAlreadyPartner && noActiveApplication;

        const juniorPasses = gatesPass
            && Math.floor(accountAgeMonths) >= 3
            && juniorQualifyingBuckets >= 5
            && subscriberCount >= 1000
            && grabCount >= 5000
            && juniorEnforcementOk;

        const proPasses = gatesPass
            && Math.floor(accountAgeMonths) >= 12
            && proQualifyingBuckets >= 15
            && subscriberCount >= 10000
            && grabCount >= 50000
            && proEnforcementOk;

        res.json({
            gates: {
                emailVerified,
                accountStanding,
                notAlreadyPartner,
                noActiveApplication,
            },
            stats: {
                accountAgeMonths: Math.floor(accountAgeMonths),
                accountAgeDays,
                totalPublicBuckets,
                subscriberCount,
                grabCount,
                daysSinceLastViolation,
            },
            junior: {
                qualifyingBuckets: juniorQualifyingBuckets,
                passes: juniorPasses,
            },
            pro: {
                qualifyingBuckets: proQualifyingBuckets,
                passes: proPasses,
            },
        });
    } catch (err) {
        console.error('[partnership/eligibility]', err);
        res.status(500).json({ error: 'Failed to check eligibility' });
    }
});

// ── POST /api/partnership/apply ───────────────────────────────────────────────
// Submit a new partner application.
// Body: { pitch, idFileRef, selfieFileRef, tier, claimedAccounts? }
router.post('/apply', requireVerifiedUser, async (req, res) => {
    try {
        const userId = req.user._id;

        // Already a partner
        if (req.user.isPartner) {
            return res.status(409).json({ error: 'You are already a partner' });
        }

        // Block duplicate pending applications
        const existing = await PartnerApplication.findOne({ userId, status: 'pending' });
        if (existing) {
            return res.status(409).json({ error: 'You already have a pending application' });
        }

        const { pitch, idFileRef, selfieFileRef, tier, claimedAccounts, usResidentConfirmed, ageConfirmed } = req.body;

        if (!['junior', 'pro'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier — must be junior or pro' });
        }
        if (!pitch || typeof pitch !== 'string' || pitch.trim().length < 100) {
            return res.status(400).json({ error: 'Pitch must be at least 100 characters' });
        }
        if (!idFileRef || !selfieFileRef) {
            return res.status(400).json({ error: 'ID photo and selfie are required' });
        }
        if (!usResidentConfirmed) {
            return res.status(400).json({ error: 'US residency confirmation is required' });
        }
        if (!ageConfirmed) {
            return res.status(400).json({ error: 'Age confirmation (18+) is required' });
        }

        // Basic size guard — base64 images shouldn't be massive
        const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB encoded
        if (idFileRef.length > MAX_FILE_SIZE || selfieFileRef.length > MAX_FILE_SIZE) {
            return res.status(400).json({ error: 'File too large (max 5 MB each)' });
        }

        // Upload partner files to R2 instead of storing raw base64 in MongoDB
        function decodeBase64File(dataUri) {
            const match = dataUri.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
            if (!match) throw new Error('Invalid image format');
            return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
        }
        const idFile    = decodeBase64File(idFileRef);
        const selfieFile = decodeBase64File(selfieFileRef);
        const [idUrl, selfieUrl] = await Promise.all([
            uploadImageToR2(idFile.buffer,    idFile.mimeType,    'partners'),
            uploadImageToR2(selfieFile.buffer, selfieFile.mimeType, 'partners'),
        ]);

        // Validate claimed accounts structure if provided
        let accounts = [];
        if (Array.isArray(claimedAccounts)) {
            accounts = claimedAccounts.slice(0, 10).map(a => ({
                email:          String(a.email  || '').slice(0, 256),
                phone:          String(a.phone  || '').slice(0, 64),
                bucketOwnerIds: Array.isArray(a.bucketOwnerIds)
                    ? a.bucketOwnerIds.slice(0, 3).map(id => String(id).slice(0, 64))
                    : []
            }));
        }

        const application = await PartnerApplication.create({
            userId,
            tier,
            pitch:               pitch.trim().slice(0, 4000),
            idFileRef:           idUrl,
            selfieFileRef:       selfieUrl,
            claimedAccounts:     accounts,
            usResidentConfirmed: !!usResidentConfirmed,
            ageConfirmed:        !!ageConfirmed,
        });

        res.status(201).json({ message: 'Application submitted', applicationId: application._id });
    } catch (err) {
        console.error('[partnership/apply]', err);
        res.status(500).json({ error: 'Failed to submit application' });
    }
});

export default router;
