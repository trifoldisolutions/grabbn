import express from 'express';
import UserDocument       from '../models/userDocument.js';
import { uploadImageToR2 } from '../utils/r2.js';

const router = express.Router();

const ALLOWED_TYPES = new Set(['gov-id', 'selfie']);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB base64

function requireUser(req, res, next) {
    if (!req.user || req.user.isAnonymous) return res.status(401).json({ error: 'Sign in to manage documents' });
    next();
}

// ── GET /api/documents ────────────────────────────────────────────────────────
// Returns upload status for each document type (no file content).
router.get('/', requireUser, async (req, res) => {
    try {
        const docs = await UserDocument
            .find({ userId: req.user._id })
            .select('type uploadedAt')
            .lean();

        const map = {};
        for (const d of docs) map[d.type] = { uploadedAt: d.uploadedAt };

        res.json({
            'gov-id': map['gov-id'] ?? null,
            'selfie': map['selfie'] ?? null,
        });
    } catch (err) {
        console.error('[documents/get]', err);
        res.status(500).json({ error: 'Failed to fetch document status' });
    }
});

// ── POST /api/documents ───────────────────────────────────────────────────────
// Upload or replace a verification document.
// Body: { type: 'gov-id'|'selfie', dataUrl: 'data:image/...' }
router.post('/', requireUser, async (req, res) => {
    try {
        const { type, dataUrl } = req.body;

        if (!ALLOWED_TYPES.has(type)) {
            return res.status(400).json({ error: 'Invalid document type' });
        }
        if (!dataUrl || typeof dataUrl !== 'string') {
            return res.status(400).json({ error: 'No file provided' });
        }
        if (dataUrl.length > MAX_FILE_SIZE) {
            return res.status(400).json({ error: 'File too large — max 5 MB' });
        }

        const match = dataUrl.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
        if (!match) return res.status(400).json({ error: 'Invalid image format' });

        const [, mimeType, b64] = match;
        const buffer = Buffer.from(b64, 'base64');
        const fileRef = await uploadImageToR2(buffer, mimeType, 'partners/docs');

        await UserDocument.findOneAndUpdate(
            { userId: req.user._id, type },
            { fileRef, uploadedAt: new Date() },
            { upsert: true, new: true }
        );

        res.json({ ok: true, uploadedAt: new Date() });
    } catch (err) {
        console.error('[documents/post]', err);
        res.status(500).json({ error: 'Failed to upload document' });
    }
});

export default router;
