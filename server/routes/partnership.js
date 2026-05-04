// server/routes/partnership.js
// Public-facing partnership application routes.
// All routes require a logged-in, non-anonymous, verified user.
import express from 'express';
import PartnerApplication from '../models/partnerApplication.js';
import User from '../models/user.js';
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
        const app = await PartnerApplication
            .findOne({ userId: req.user._id })
            .sort({ submittedAt: -1 })
            .select('status submittedAt reviewedAt rejectionReason')
            .lean();

        res.json({ isPartner: req.user.isPartner, application: app ?? null });
    } catch (err) {
        console.error('[partnership/status]', err);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// ── POST /api/partnership/apply ───────────────────────────────────────────────
// Submit a new partner application.
// Body: { pitch, idFileRef, selfieFileRef, claimedAccounts? }
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

        const { pitch, idFileRef, selfieFileRef, claimedAccounts } = req.body;

        if (!pitch || typeof pitch !== 'string' || pitch.trim().length < 10) {
            return res.status(400).json({ error: 'Pitch must be at least 10 characters' });
        }
        if (!idFileRef || !selfieFileRef) {
            return res.status(400).json({ error: 'ID photo and selfie are required' });
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
        const idFile = decodeBase64File(idFileRef);
        const selfieFile = decodeBase64File(selfieFileRef);
        const [idUrl, selfieUrl] = await Promise.all([
            uploadImageToR2(idFile.buffer, idFile.mimeType, 'partners'),
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
            pitch:           pitch.trim().slice(0, 4000),
            idFileRef:       idUrl,
            selfieFileRef:   selfieUrl,
            claimedAccounts: accounts,
        });

        res.status(201).json({ message: 'Application submitted', applicationId: application._id });
    } catch (err) {
        console.error('[partnership/apply]', err);
        res.status(500).json({ error: 'Failed to submit application' });
    }
});

export default router;
