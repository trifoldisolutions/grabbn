// server/routes/bucketShare.js
import express from 'express';
import Bucket from '../models/bucket.js';

const router = express.Router();

// Serve bucket thumbnail as actual image (must come BEFORE redirect route)
router.get('/bucket/:bucketId/thumbnail.jpg', async (req, res) => {
    try {
        const { bucketId } = req.params;

        const bucket = await Bucket.findById(bucketId);

        if (!bucket) {
            return res.status(404).send('Thumbnail not found');
        }

        // Use bucket thumbnail, or fall back to first link image
        const rawImage = bucket.thumbnail || bucket.links?.find(l => l.image)?.image || null;

        if (!rawImage) {
            return res.status(404).send('Thumbnail not found');
        }

        // New: R2 URL — redirect directly to CDN
        if (rawImage.startsWith('http')) {
            return res.redirect(302, rawImage);
        }

        // Legacy: base64 data URI stored in MongoDB — decode and serve
        const mimeMatch = rawImage.match(/^data:(image\/\w+);base64,/);
        const base64Data = mimeMatch
            ? rawImage.slice(mimeMatch[0].length)
            : rawImage;
        const imageBuffer = Buffer.from(base64Data, 'base64');

        res.set('Content-Type', mimeMatch ? mimeMatch[1] : 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=31536000');
        res.send(imageBuffer);
    } catch (error) {
        console.error('Error serving thumbnail:', error);
        res.status(500).send('Error loading thumbnail');
    }
});

// Redirect old share links to the main bucket page
router.get('/bucket/:bucketId', (req, res) => {
    res.redirect(301, `/v2/b/${req.params.bucketId}`);
});

export default router;
