import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from './server/models/user.js';
import Bucket from './server/models/bucket.js';
import Report from './server/models/report.js';
import BucketAccess from './server/models/bucketAccess.js';
import { anonymousAuth, requireAuth, requireVerification } from './server/middleware/anonymousAuth.js';
import LinkClick from './server/models/linkClick.js';
import Repository from './server/models/repository.js';
import Subscription from './server/models/subscription.js';
import { buildRepositories } from './server/jobs/buildRepositories.js';
import bucketShareRouter from './server/routes/bucketShare.js';
import authRouter from './server/routes/auth.js';
import creditsRouter, { handleWebhook } from './server/routes/credits.js';
import connectRouter, { handleConnectWebhook } from './server/routes/stripeConnect.js';

dotenv.config();

// ---------------------------------------------------------------------------
// Visibility helpers — handle both new docs (visibility string) and old docs
// (isPublic boolean) so the migration is seamless.
// ---------------------------------------------------------------------------

// Derives the effective visibility string from a bucket document.
function bucketVisibility(bucket) {
  if (bucket.visibility) return bucket.visibility;
  return bucket.isPublic ? 'public' : 'private';
}

// MongoDB filter that matches "publicly discoverable" buckets (public only).
const FILTER_PUBLIC = {
  $or: [
    { visibility: 'public' },
    { visibility: { $exists: false }, isPublic: true },
  ]
};

// MongoDB filter that matches "link-accessible" buckets (public + unlisted).
const FILTER_ACCESSIBLE = {
  $or: [
    { visibility: { $in: ['public', 'unlisted'] } },
    { visibility: { $exists: false }, isPublic: true },
  ]
};

// Required for ES modules (__dirname equivalent)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------------------------------------------------------------------------
// Popup-session — registered BEFORE the global CORS middleware so we can
// allow any origin (bookmarklet runs on arbitrary third-party sites).
// Auth is cookie-independent: the bookmarklet embeds a per-user bookmarkletToken
// (fetched server-side when "Get bookmarklet" is opened) and sends it in the
// request body so the server can identify the user without any cookies.
// ---------------------------------------------------------------------------
const popupSessions = new Map();

app.options('/api/popup-session', cors({ origin: '*' }));

app.post('/api/popup-session',
    cors({ origin: '*', methods: ['POST', 'OPTIONS'] }),
    express.json({ limit: '2mb' }),
    async (req, res) => {
        const { links, sourceUrl, maxPage, currentPage, pagesCollected, bkt } = req.body;
        if (!Array.isArray(links)) {
            return res.status(400).json({ error: 'links is required' });
        }

        // Resolve the user via the bookmarklet token embedded in the code.
        // This is completely cookie-independent and works in all browsers.
        let anonymousId = null;
        if (bkt) {
            try {
                const user = await User.findOne({ bookmarkletToken: bkt });
                if (user) anonymousId = user.anonymousId;
            } catch { /* non-fatal */ }
        }

        const token =
            Math.random().toString(36).slice(2, 10) +
            Math.random().toString(36).slice(2, 10);
        popupSessions.set(token, {
            links: links.slice(0, 2000),
            sourceUrl: String(sourceUrl || '').slice(0, 2000),
            maxPage: Math.min(Math.max(Number(maxPage) || 1, 1), 50), // cap at 50
            currentPage: Math.max(Number(currentPage) || 1, 1),
            pagesCollected: Math.max(Number(pagesCollected) || 1, 1),
            createdAt: Date.now(),
            anonymousId,
        });
        setTimeout(() => popupSessions.delete(token), 600_000); // 10-min TTL
        res.json({ token });
    }
);

app.get('/api/popup-session', (req, res) => {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).json({ error: 'token required' });
    const session = popupSessions.get(token);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });
    popupSessions.delete(token); // one-time use
    res.json(session);
});

// ---------------------------------------------------------------------------
// Global CORS for all other routes (restricted origins in production)
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = process.env.NODE_ENV === 'production'
    ? ['https://grabbn.com', 'https://www.grabbn.com', 'https://app.grabbn.com']
    : true;

app.set('trust proxy', 1); // trust first proxy (nginx/reverse proxy) so req.ip resolves correctly

app.use(cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Anonymous-Id']
}));

// Stripe webhooks — must be registered BEFORE express.json() to receive raw body
app.post('/api/credits/webhook', express.raw({ type: 'application/json' }), handleWebhook);
app.post('/api/connect/webhook', express.raw({ type: 'application/json' }), handleConnectWebhook);

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Apply anonymous auth to all routes (must be before auth router)
app.use(anonymousAuth);

// ── EJS helper: route external image URLs through the proxy ─────────────────
// Base64 data URLs and relative paths pass through unchanged; anything that
// starts with http/https is proxied so CDN hotlink blocks / Varnish errors on
// external sites never reach the end user.
app.use((req, res, next) => {
    res.locals.imgSrc = (url) => {
        if (!url) return '';
        if (url.startsWith('data:') || url.startsWith('/')) return url;
        return '/api/img-proxy?url=' + encodeURIComponent(url);
    };
    next();
});

app.use('/api/auth', authRouter);
app.use('/api/credits', creditsRouter);
app.use('/api/connect', connectRouter);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// ── Image proxy ─────────────────────────────────────────────────────────────
// Fetches external link thumbnail URLs server-side so that CDN hotlink
// protection / Varnish restrictions on the source site don't affect the user.
// Usage: /api/img-proxy?url=https://cdn.example.com/img/abc
const ALLOWED_IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
app.get('/api/img-proxy', async (req, res) => {
    const raw = req.query.url;
    if (!raw) return res.status(400).end();

    let target;
    try {
        target = new URL(raw);
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('bad protocol');
    } catch {
        return res.status(400).end();
    }

    // Block requests back to our own origin to prevent SSRF loops
    const selfHostnames = ['localhost', '127.0.0.1', 'grabbn.com', 'app.grabbn.com'];
    if (selfHostnames.includes(target.hostname)) return res.status(403).end();

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const upstream = await fetch(target.href, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Grabbn/1.0)',
                // Deliberately omit Referer so hotlink-protected CDNs don't block us
            },
            redirect: 'follow',
        });
        clearTimeout(timer);

        const type = (upstream.headers.get('content-type') || '').split(';')[0].trim();
        if (!upstream.ok || !ALLOWED_IMG_TYPES.has(type)) return res.status(502).end();

        res.set('Content-Type', type);
        res.set('Cache-Control', 'public, max-age=86400'); // cache 24 h on CDN / browser
        res.set('X-Content-Type-Options', 'nosniff');
        upstream.body.pipe(res);
    } catch {
        res.status(502).end();
    }
});

app.use('/share', bucketShareRouter);

// Route root based on hostname:
//   grabbn.com / www.grabbn.com  → landing page
//   app.grabbn.com               → the app
app.get('/', (req, res) => {
    const host = req.hostname; // excludes port
    if (host === 'app.grabbn.com') {
        res.redirect('/v2');
    } else {
        res.sendFile(path.join(__dirname, 'public', 'landing.html'));
    }
});

// Mongo connection
async function connectMongo() {
    const uri = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB || 'grabbn';
    if (!uri) {
        throw new Error('MONGODB_URI is not set in .env');
    }
    await mongoose.connect(uri, { dbName });
    console.log(`MongoDB connected to database: ${dbName}`);
}

// ====================
// HELPERS
// ====================

/**
 * Downloads an external image URL server-side and returns a base64 data URL.
 *   - Already-base64 (data:) or relative (/) strings pass through unchanged.
 *   - Returns null if the fetch fails, the MIME type isn't an image,
 *     or the file is larger than MAX_LINK_IMG_BYTES (avoids bloating Mongo docs).
 */
const MAX_LINK_IMG_BYTES = 800 * 1024; // 800 KB raw → ~1.1 MB as base64
const ALLOWED_LINK_IMG_MIME = new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']);

async function fetchImageAsBase64(url) {
    if (!url) return null;
    if (url.startsWith('data:') || url.startsWith('/')) return url;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const upstream = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Grabbn/1.0)' },
            redirect: 'follow',
        });
        clearTimeout(timer);
        if (!upstream.ok) return null;
        const type = (upstream.headers.get('content-type') || '').split(';')[0].trim();
        if (!ALLOWED_LINK_IMG_MIME.has(type)) return null;
        const buf = await upstream.arrayBuffer();
        if (buf.byteLength > MAX_LINK_IMG_BYTES) return null; // too large, skip
        return `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
    } catch {
        return null;
    }
}

// ====================
// API ENDPOINTS
// ====================

// Return (and lazily generate) a per-user bookmarklet token.
// Called from the "Get bookmarklet" modal; cookies always work here because
// it is a same-origin request from app.grabbn.com.
app.get('/api/auth/bookmarklet-token', requireAuth, async (req, res) => {
    try {
        let { bookmarkletToken } = req.user;
        if (!bookmarkletToken) {
            const { randomUUID } = await import('crypto');
            bookmarkletToken = randomUUID();
            req.user.bookmarkletToken = bookmarkletToken;
            await req.user.save();
        }
        res.json({ token: bookmarkletToken });
    } catch (err) {
        console.error('bookmarklet-token error:', err);
        res.status(500).json({ error: 'Failed to generate token' });
    }
});

// Get user info (for debugging/testing)
app.get('/api/user', requireAuth, requireVerification, (req, res) => {
    res.json({
        anonymousId: req.user.anonymousId,
        isAnonymous: req.user.isAnonymous,
        createdAt: req.user.createdAt,
        lastActive: req.user.lastActive
    });
});

// Get all buckets for current user (NO Singletons returned)
app.get('/api/buckets', requireAuth, requireVerification, async (req, res) => {
    try {
        const buckets = await Bucket.find({ userId: req.user._id })
            .sort({ order: 1, createdAt: 1 });

        // Return bucket names only (for dropdown)
        const bucketNames = buckets.map(b => b.name);
        res.json(bucketNames);
    } catch (error) {
        console.error('Error fetching buckets:', error);
        res.status(500).json({ error: 'Failed to fetch buckets' });
    }
});

// Create a new bucket
app.post('/api/buckets', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name, description, tags, visibility, monetized, price, mature, sourceUrl, thumbnail, links } = req.body;

        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Bucket name is required' });
        }

        // Prevent creating 'Singletons' as a real bucket
        if (name === 'Singletons') {
            return res.status(400).json({ error: 'Singletons is a reserved name' });
        }

        // Check if bucket already exists for this user
        const existing = await Bucket.findOne({
            userId: req.user._id,
            name
        });

        if (existing) {
            return res.status(409).json({ error: 'Bucket already exists' });
        }

        const resolvedLinks = Array.isArray(links) ? await Promise.all(links.map(async l => ({
            href:   l.url   || '',
            text:   l.title || '',
            isFree: !l.monetized,
            image:  await fetchImageAsBase64(l.thumb || null) ?? l.thumb ?? null,
        }))) : [];

        const resolvedThumb = await fetchImageAsBase64(thumbnail || null) || '';

        // Auto-set thumbnail from first link image if no explicit thumbnail provided
        const effectiveThumb = resolvedThumb || resolvedLinks.find(l => l.image)?.image || '';

        const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'private';
        const bucket = await Bucket.create({
            userId:      req.user._id,
            name,
            description: String(description || '').slice(0, 256),
            hashtags:    Array.isArray(tags) ? tags.slice(0, 8) : [],
            visibility:  vis,
            isPublic:    vis === 'public',
            isPaywalled: !!monetized,
            price:       Number(price) || 0,
            mature:      !!mature,
            sourceUrl:   sourceUrl || '',
            thumbnail:   effectiveThumb,
            links:       resolvedLinks,
        });

        res.status(201).json({ name: bucket.name });
    } catch (error) {
        console.error('Error creating bucket:', error);
        res.status(500).json({ error: 'Failed to create bucket' });
    }
});

// Update bucket name
app.put('/api/buckets/:oldName', requireAuth, requireVerification, async (req, res) => {
    try {
        const { oldName } = req.params;
        const { newName } = req.body;

        if (!newName || typeof newName !== 'string') {
            return res.status(400).json({ error: 'New bucket name is required' });
        }

        if (oldName === 'Singletons' || newName === 'Singletons') {
            return res.status(403).json({ error: 'Cannot use Singletons as a bucket name' });
        }

        const bucket = await Bucket.findOneAndUpdate(
            { userId: req.user._id, name: oldName },
            { name: newName },
            { new: true }
        );

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        res.json({ name: bucket.name });
    } catch (error) {
        console.error('Error updating bucket:', error);
        res.status(500).json({ error: 'Failed to update bucket' });
    }
});

// Full bucket update (used by profile edit modal)
app.patch('/api/buckets/:id/full', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name, description, tags, visibility, monetized, price, mature, sourceUrl, thumbnail, links } = req.body;

        const update = {};
        if (name        !== undefined) update.name        = name;
        if (description !== undefined) update.description = String(description || '').slice(0, 256);
        if (tags        !== undefined) update.hashtags    = Array.isArray(tags) ? tags.slice(0, 8) : [];
        if (mature      !== undefined) update.mature      = !!mature;
        if (visibility !== undefined) {
            const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'private';
            update.visibility = vis;
            update.isPublic   = vis === 'public';
        }
        if (monetized   !== undefined) update.isPaywalled = !!monetized;
        if (price       !== undefined) update.price       = Number(price) || 0;
        if (sourceUrl   !== undefined) update.sourceUrl   = sourceUrl || '';
        if (thumbnail   !== undefined) update.thumbnail   = await fetchImageAsBase64(thumbnail || null) || '';
        if (links       !== undefined) {
            update.links = await Promise.all(links.map(async l => ({
                href:    l.url   || '',
                text:    l.title || '',
                isFree:  !l.monetized,
                // Fall back to the original URL if base64 conversion fails — never wipe a thumbnail
                image:   await fetchImageAsBase64(l.thumb || null) ?? l.thumb ?? null,
            })));
        }

        // Auto-set thumbnail from first link image if still empty after update
        if (!update.thumbnail && update.links) {
            const firstWithImage = update.links.find(l => l.image);
            if (firstWithImage) update.thumbnail = firstWithImage.image;
        }

        const bucket = await Bucket.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id },
            update,
            { new: true }
        );

        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });
        res.json({ name: bucket.name });
    } catch (error) {
        console.error('Error updating bucket:', error);
        res.status(500).json({ error: 'Failed to update bucket' });
    }
});

// Get bucket ID by name for sharing
app.get('/api/buckets/:name/id', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;

        const bucket = await Bucket.findOne({
            userId: req.user._id,
            name
        });

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        res.json({ bucketId: bucket._id.toString(), name: bucket.name });
    } catch (error) {
        console.error('Error fetching bucket ID:', error);
        res.status(500).json({ error: 'Failed to fetch bucket ID' });
    }
});

// Delete a bucket (and all its links)
app.delete('/api/buckets/:name', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;

        if (name === 'Singletons') {
            return res.status(403).json({ error: 'Cannot delete Singletons' });
        }

        await Bucket.findOneAndDelete({
            userId: req.user._id,
            name
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting bucket:', error);
        res.status(500).json({ error: 'Failed to delete bucket' });
    }
});

// Delete a specific link from a bucket
app.delete('/api/buckets/:name/links', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { href } = req.body;

        if (!href) {
            return res.status(400).json({ error: 'Link href is required' });
        }

        if (name === 'Singletons') {
            return res.status(403).json({ error: 'Cannot delete from Singletons bucket' });
        }

        // Find the bucket
        const bucket = await Bucket.findOne({
            userId: req.user._id,
            name
        });

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        // Remove the link with matching href
        const initialLength = bucket.links.length;
        bucket.links = bucket.links.filter(link => link.href !== href);

        if (bucket.links.length === initialLength) {
            return res.status(404).json({ error: 'Link not found in bucket' });
        }

        // Save the updated bucket
        await bucket.save();

        res.json({
            success: true,
            message: 'Link deleted successfully',
            remainingLinks: bucket.links.length
        });
    } catch (error) {
        console.error('Error deleting link from bucket:', error);
        res.status(500).json({ error: 'Failed to delete link' });
    }
});

// Toggle isFree flag on an individual link within a bucket
app.patch('/api/buckets/:name/links/free', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { href, isFree } = req.body;

        if (!href) {
            return res.status(400).json({ error: 'Link href is required' });
        }
        if (typeof isFree !== 'boolean') {
            return res.status(400).json({ error: 'isFree must be a boolean' });
        }

        const bucket = await Bucket.findOne({ userId: req.user._id, name });
        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        const link = bucket.links.find(l => l.href === href);
        if (!link) {
            return res.status(404).json({ error: 'Link not found in bucket' });
        }

        link.isFree = isFree;
        await bucket.save();

        res.json({ success: true, href, isFree });
    } catch (error) {
        console.error('Error updating link free status:', error);
        res.status(500).json({ error: 'Failed to update link free status' });
    }
});

// Update bucket thumbnail
app.put('/api/buckets/:name/thumbnail', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { thumbnail } = req.body;

        const bucket = await Bucket.findOneAndUpdate(
            { userId: req.user._id, name },
            { thumbnail },
            { new: true }
        );

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        res.json({ success: true, thumbnail: bucket.thumbnail });
    } catch (error) {
        console.error('Error updating thumbnail:', error);
        res.status(500).json({ error: 'Failed to update thumbnail' });
    }
});

// Get bucket thumbnail
app.get('/api/buckets/:name/thumbnail', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;

        const bucket = await Bucket.findOne({
            userId: req.user._id,
            name
        });

        if (!bucket || !bucket.thumbnail) {
            return res.status(404).json({ error: 'Thumbnail not found' });
        }

        res.json({ thumbnail: bucket.thumbnail });
    } catch (error) {
        console.error('Error fetching thumbnail:', error);
        res.status(500).json({ error: 'Failed to fetch thumbnail' });
    }
});

// Get bucket metadata by name
app.get('/api/buckets/:name/metadata', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;

        const bucket = await Bucket.findOne({
            userId: req.user._id,
            name
        }).populate('userId', 'username anonymousId');

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        // Count how many times this bucket has been grabbed
        const grabCount = await Bucket.countDocuments({
            $or: [
                { sourceBucketId: bucket._id },
                { originalBucketId: bucket._id }
            ]
        });

        res.json({
            name: bucket.name,
            visibility: bucketVisibility(bucket),
            isPublic: bucket.isPublic,
            isPaywalled: bucket.isPaywalled || false,
            price: bucket.price || 0,
            createdAt: bucket.createdAt,
            updatedAt: bucket.updatedAt,
            linkCount: bucket.links.length,
            grabCount,
            viewCount: bucket.viewCount || 0,
            shareCount: bucket.shareCount || 0,
            curator: {
                username: bucket.userId.username,
                userId: bucket.userId.anonymousId
            },
            ...(bucket.originalCuratorId && {
                originalCurator: {
                    username: bucket.originalCuratorName,
                    userId: bucket.originalCuratorId
                },
                originalBucketId: bucket.originalBucketId || bucket.sourceBucketId
            })
        });
    } catch (error) {
        console.error('Error fetching bucket metadata:', error);
        res.status(500).json({ error: 'Failed to fetch bucket metadata' });
    }
});

// Set bucket paywall flag and price
app.post('/api/buckets/:name/paywall', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { isPaywalled, price } = req.body;

        if (name === 'Singletons') {
            return res.status(403).json({ error: 'Singletons bucket cannot be paywalled' });
        }

        if (typeof isPaywalled !== 'boolean') {
            return res.status(400).json({ error: 'isPaywalled must be a boolean' });
        }

        if (isPaywalled) {
            if (!Number.isInteger(price) || price < 1) {
                return res.status(400).json({ error: 'price must be an integer ≥ 1' });
            }
        }

        const bucket = await Bucket.findOne({ userId: req.user._id, name });

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        bucket.isPaywalled = isPaywalled;
        if (isPaywalled) bucket.price = price;
        await bucket.save();

        res.json({ name: bucket.name, isPaywalled: bucket.isPaywalled, price: bucket.price });
    } catch (error) {
        console.error('Error updating bucket paywall:', error);
        res.status(500).json({ error: 'Failed to update bucket paywall' });
    }
});

// Update bucket visibility (public / unlisted / private)
app.patch('/api/buckets/:name/visibility', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { visibility } = req.body;

        if (name === 'Singletons') {
            return res.status(403).json({ error: 'Singletons bucket cannot be made public' });
        }

        if (!['public', 'unlisted', 'private'].includes(visibility)) {
            return res.status(400).json({ error: 'visibility must be "public", "unlisted", or "private"' });
        }

        const bucket = await Bucket.findOneAndUpdate(
            { userId: req.user._id, name },
            { visibility, isPublic: visibility === 'public' },
            { new: true }
        );

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        res.json({ name: bucket.name, visibility: bucket.visibility, isPublic: bucket.isPublic });
    } catch (error) {
        console.error('Error updating bucket visibility:', error);
        res.status(500).json({ error: 'Failed to update bucket visibility' });
    }
});

// Lookup a bucket by name, share URL, or ObjectId
app.get('/api/buckets/lookup', requireAuth, requireVerification, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q) {
            return res.status(400).json({ error: 'Query parameter "q" is required' });
        }

        const PAGE_SIZE = 25;
        const skip = Math.max(0, parseInt(req.query.skip) || 0);

        let buckets = [];
        let hasMore = false;

        // 1. Share URL — extract the 24-char hex ID
        const shareMatch = q.match(/\/share\/bucket\/([a-f0-9]{24})/i);
        if (shareMatch) {
            const bucket = await Bucket.findById(shareMatch[1]).populate('userId', 'username anonymousId');
            if (bucket) {
                const isOwner = bucket.userId._id.equals(req.user._id);
                if (isOwner || bucketVisibility(bucket) !== 'private') buckets = [bucket];
            }
        }

        // 2. Raw ObjectId
        if (!buckets.length && /^[a-f0-9]{24}$/i.test(q)) {
            const bucket = await Bucket.findById(q).populate('userId', 'username anonymousId');
            if (bucket) {
                const isOwner = bucket.userId._id.equals(req.user._id);
                if (isOwner || bucketVisibility(bucket) !== 'private') buckets = [bucket];
            }
        }

        // 3. Name search — only publicly discoverable buckets (public, not unlisted)
        if (!buckets.length) {
            const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            buckets = await Bucket.find({
                name: new RegExp(escaped, 'i'),
                $or: [{ userId: req.user._id }, ...FILTER_PUBLIC.$or]
            }).skip(skip).limit(PAGE_SIZE + 1).populate('userId', 'username anonymousId');

            if (buckets.length > PAGE_SIZE) {
                hasMore = true;
                buckets = buckets.slice(0, PAGE_SIZE);
            }
        }

        if (!buckets.length) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        // Fetch grab counts for all buckets in parallel
        const grabCounts = await Promise.all(
            buckets.map(bucket => Bucket.countDocuments({
                $or: [
                    { sourceBucketId: bucket._id },
                    { originalBucketId: bucket._id }
                ]
            }))
        );

        const formattedBuckets = await Promise.all(buckets.map(async (bucket, i) => {
            const isOwner = bucket.userId._id.equals(req.user._id);
            let links = bucket.links;
            let hasAccess = isOwner;
            let hiddenCount = 0;
            const totalLinkCount = bucket.links.length;

            if (bucket.isPaywalled && !isOwner) {
                const access = await BucketAccess.findOne({ userId: req.user._id, bucketId: bucket._id });
                hasAccess = !!access;
                if (!hasAccess) {
                    const freeLinks = bucket.links.filter(l => l.isFree);
                    hiddenCount = bucket.links.length - freeLinks.length;
                    links = freeLinks;
                }
            }

            return {
                _id: bucket._id,
                name: bucket.name,
                visibility: bucketVisibility(bucket),
                isPublic: bucket.isPublic,
                isPaywalled: bucket.isPaywalled || false,
                price: bucket.price || 0,
                hasAccess,
                hiddenCount,
                totalLinkCount,
                links,
                sourceUrl: bucket.sourceUrl,
                thumbnail: bucket.thumbnail,
                createdAt: bucket.createdAt,
                updatedAt: bucket.updatedAt,
                grabCount: grabCounts[i],
                viewCount: bucket.viewCount || 0,
                shareCount: bucket.shareCount || 0,
                curator: {
                    username: bucket.userId.username,
                    userId: bucket.userId.anonymousId
                },
                ...(bucket.originalCuratorId && {
                    originalCurator: {
                        username: bucket.originalCuratorName,
                        userId: bucket.originalCuratorId
                    },
                    originalBucketId: bucket.originalBucketId || bucket.sourceBucketId
                }),
                isOwner
            };
        }));

        res.json({ hasMore, buckets: formattedBuckets });
    } catch (error) {
        console.error('Error looking up bucket:', error);
        res.status(500).json({ error: 'Failed to lookup bucket' });
    }
});

// Grab (clone) a bucket into the current user's collection
app.post('/api/buckets/grab', requireAuth, requireVerification, async (req, res) => {
    try {
        const { sourceBucketId } = req.body;

        if (!sourceBucketId) {
            return res.status(400).json({ error: 'sourceBucketId is required' });
        }

        // Check if user already grabbed this bucket
        const existing = await Bucket.findOne({
            userId: req.user._id,
            sourceBucketId
        });

        if (existing) {
            return res.status(409).json({ error: 'You already have this bucket in your collection' });
        }

        // Fetch the source bucket (with owner info for curator attribution)
        const source = await Bucket.findById(sourceBucketId).populate('userId', 'username anonymousId');
        if (!source) {
            return res.status(404).json({ error: 'Source bucket not found' });
        }

        // Only public buckets can be grabbed (unlisted and private cannot)
        if (bucketVisibility(source) !== 'public') {
            return res.status(403).json({ error: 'Only public buckets can be grabbed' });
        }

        // Paywalled buckets require the user to have unlocked them first
        if (source.isPaywalled) {
            const isOwner = source.userId._id.equals(req.user._id);
            if (!isOwner) {
                const access = await BucketAccess.findOne({ userId: req.user._id, bucketId: source._id });
                if (!access) {
                    return res.status(403).json({ error: 'Unlock this bucket before grabbing it' });
                }
            }
        }

        // Resolve the original curator — walk to the root creator
        let curatorId, curatorName;
        if (source.originalCuratorId) {
            // Source was itself a grab — propagate the root creator
            curatorId = source.originalCuratorId;
            curatorName = source.originalCuratorName;
        } else {
            // Source IS the original — snapshot its owner
            curatorId = source.userId._id;
            const anonId = source.userId.anonymousId || '';
            curatorName = source.userId.username
                || (anonId.length > 8 ? `${anonId.substring(0, 4)}...${anonId.substring(anonId.length - 4)}` : anonId || 'Unknown');
        }

        // Clone into user's collection
        const cloned = await Bucket.create({
            userId: req.user._id,
            name: source.name,
            links: source.links.map(l => ({
                href: l.href,
                text: l.text || '',
                duration: l.duration || ''
            })),
            sourceUrl: source.sourceUrl || '',
            thumbnail: source.thumbnail || '',
            sourceBucketId: source._id,
            originalCuratorId: curatorId,
            originalCuratorName: curatorName,
            originalBucketId: source.originalBucketId || source._id
        });

        // Track grabber on the root (original) bucket
        const rootBucketId = source.originalBucketId || source._id;
        await Bucket.findByIdAndUpdate(rootBucketId, {
            $push: { grabbedBy: { userId: req.user._id, username: req.user.username || '', avatar: req.user.avatar || '' } }
        });

        res.status(201).json({ bucket: cloned });
    } catch (error) {
        // Handle duplicate name (same user already has a bucket with this name)
        if (error.code === 11000) {
            return res.status(409).json({ error: 'A bucket with this name already exists in your collection' });
        }
        console.error('Error grabbing bucket:', error);
        res.status(500).json({ error: 'Failed to grab bucket' });
    }
});

// Ungrab (remove a previously grabbed clone of a bucket)
app.delete('/api/buckets/grab/:sourceBucketId', requireAuth, requireVerification, async (req, res) => {
    try {
        const { sourceBucketId } = req.params;

        const cloned = await Bucket.findOneAndDelete({
            userId: req.user._id,
            $or: [
                { sourceBucketId:   sourceBucketId },
                { originalBucketId: sourceBucketId }
            ]
        });

        if (!cloned) {
            // Already gone — treat as success so client stays in ungrabbed state
            return res.json({ success: true });
        }

        // Remove grabber from the root bucket's grabbedBy list
        const rootBucketId = cloned.originalBucketId || cloned.sourceBucketId;
        if (rootBucketId) {
            await Bucket.findByIdAndUpdate(rootBucketId, {
                $pull: { grabbedBy: { userId: req.user._id } }
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error ungrabbing bucket:', error);
        res.status(500).json({ error: 'Failed to ungrab bucket' });
    }
});

// Record a view for a bucket (only counts if new viewer or bucket was modified since last view)
app.post('/api/buckets/:id/view', requireAuth, requireVerification, async (req, res) => {
    try {
        const bucket = await Bucket.findById(req.params.id);
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        const existing = bucket.viewedBy.find(v => v.userId.equals(req.user._id));

        if (!existing) {
            // New viewer
            await Bucket.findByIdAndUpdate(req.params.id, {
                $push: { viewedBy: { userId: req.user._id, lastViewedVersion: bucket.updatedAt } },
                $inc: { viewCount: 1 }
            });
        } else if (existing.lastViewedVersion < bucket.updatedAt) {
            // Returning viewer, but bucket was modified since last view
            await Bucket.updateOne(
                { _id: req.params.id, 'viewedBy.userId': req.user._id },
                {
                    $set: { 'viewedBy.$.lastViewedVersion': bucket.updatedAt },
                    $inc: { viewCount: 1 }
                }
            );
        }
        // else: same user, no changes since last view — skip

        res.json({ success: true });
    } catch (error) {
        console.error('Error recording view:', error);
        res.status(500).json({ error: 'Failed to record view' });
    }
});

// Record a share for a bucket (only counts if new sharer or bucket was modified since last share)
app.post('/api/buckets/:id/share', requireAuth, requireVerification, async (req, res) => {
    try {
        const bucket = await Bucket.findById(req.params.id);
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        const existing = bucket.sharedBy.find(v => v.userId.equals(req.user._id));

        if (!existing) {
            // New sharer
            await Bucket.findByIdAndUpdate(req.params.id, {
                $push: { sharedBy: { userId: req.user._id, lastSharedVersion: bucket.updatedAt } },
                $inc: { shareCount: 1 }
            });
        } else if (existing.lastSharedVersion < bucket.updatedAt) {
            // Returning sharer, but bucket was modified since last share
            await Bucket.updateOne(
                { _id: req.params.id, 'sharedBy.userId': req.user._id },
                {
                    $set: { 'sharedBy.$.lastSharedVersion': bucket.updatedAt },
                    $inc: { shareCount: 1 }
                }
            );
        }
        // else: same user, no changes since last share — skip

        res.json({ success: true });
    } catch (error) {
        console.error('Error recording share:', error);
        res.status(500).json({ error: 'Failed to record share' });
    }
});

// Report a bucket
app.post('/api/buckets/:id/report', requireAuth, requireVerification, async (req, res) => {
    try {
        const { reason, detail } = req.body;
        const validReasons = ['spam', 'malicious', 'inappropriate', 'copyright', 'other'];

        if (!reason || !validReasons.includes(reason)) {
            return res.status(400).json({ error: 'Invalid report reason' });
        }

        const bucket = await Bucket.findById(req.params.id);
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        if (bucket.userId.equals(req.user._id)) {
            return res.status(403).json({ error: 'Cannot report your own bucket' });
        }

        await Report.create({
            reporterId: req.user._id,
            bucketId: req.params.id,
            reason,
            detail: detail ? String(detail).slice(0, 500) : ''
        });

        res.json({ success: true });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ error: 'You have already reported this bucket' });
        }
        console.error('Error reporting bucket:', error);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// Get all links for current user
app.get('/api/links', requireAuth, requireVerification, async (req, res) => {
    try {
        const buckets = await Bucket.find({ userId: req.user._id });

        // Flatten all links from all buckets
        const linksMap = new Map();

        buckets.forEach(bucket => {
            bucket.links.forEach(link => {
                const key = link.href;
                if (!linksMap.has(key)) {
                    linksMap.set(key, {
                        href: link.href,
                        text: link.text,
                        duration: link.duration,
                        image: link.image || null,
                        isFree: link.isFree || false,
                        sourceUrl: bucket.sourceUrl || '',
                        buckets: [bucket.name]
                    });
                } else {
                    // Link exists in multiple buckets
                    linksMap.get(key).buckets.push(bucket.name);
                }
            });
        });

        const links = Array.from(linksMap.values());
        res.json(links);
    } catch (error) {
        console.error('Error fetching links:', error);
        res.status(500).json({ error: 'Failed to fetch links' });
    }
});

// Add links to bucket(s)
app.post('/api/links', requireAuth, requireVerification, async (req, res) => {
    try {
        const { links, buckets = [] } = req.body;

        if (!Array.isArray(links) || links.length === 0) {
            return res.status(400).json({ error: 'Links array is required' });
        }

        if (buckets.length === 0) {
            return res.status(400).json({ error: 'At least one bucket is required' });
        }

        // Filter out 'Singletons' from buckets
        // const realBuckets = buckets.filter(b => b !== 'Singletons');

        const realBuckets = buckets;

        // if (realBuckets.length === 0) {
        //     return res.status(400).json({ error: 'Cannot add to Singletons bucket' });
        // }

        const results = [];

        for (const bucketName of realBuckets) {
            // Find or create bucket
            let bucket = await Bucket.findOne({
                userId: req.user._id,
                name: bucketName
            });

            if (!bucket) {
                bucket = await Bucket.create({
                    userId: req.user._id,
                    name: bucketName,
                    links: []
                });
            }

            // Convert all new link images to base64 in parallel (avoids hotlink failures later)
            const newLinks = await Promise.all(
                links
                    .filter(link => !bucket.links.some(l => l.href === link.href))
                    .map(async link => ({
                        href:     link.href,
                        text:     link.text || '',
                        duration: link.duration || '',
                        image:    await fetchImageAsBase64(link.image || null) ?? link.image ?? null,
                    }))
            );
            bucket.links.push(...newLinks);

            // Auto-set bucket thumbnail from first link image if not already set
            if (!bucket.thumbnail) {
                const firstWithImage = bucket.links.find(l => l.image);
                if (firstWithImage) bucket.thumbnail = firstWithImage.image;
            }

            // Update sourceUrl if provided
            if (links[0]?.sourceUrl && !bucket.sourceUrl) {
                bucket.sourceUrl = links[0].sourceUrl;
            }

            await bucket.save();
            results.push(bucket);
        }

        res.status(201).json(results);
    } catch (error) {
        console.error('Error adding links:', error);
        res.status(500).json({ error: 'Failed to add links' });
    }
});

// Clear all links (delete all buckets)
app.delete('/api/links', requireAuth, requireVerification, async (req, res) => {
    try {
        await Bucket.deleteMany({ userId: req.user._id });
        res.json({ success: true });
    } catch (error) {
        console.error('Error clearing links:', error);
        res.status(500).json({ error: 'Failed to clear links' });
    }
});

// ---------------------------------------------------------------------------
// Link click tracking — fire-and-forget, always returns 204
// ---------------------------------------------------------------------------
app.post('/api/links/click', async (req, res) => {
    res.sendStatus(204); // respond immediately, don't block the user
    try {
        const { href, bucketId } = req.body;
        if (!href || !bucketId) return;

        let domain;
        try { domain = new URL(href).hostname; } catch { return; }

        await Promise.all([
            LinkClick.create({ href, domain, bucketId, userId: req.user?._id ?? null }),
            Bucket.updateOne(
                { _id: bucketId, 'links.href': href },
                { $inc: { 'links.$.clickCount': 1 } }
            ),
        ]);
    } catch (err) {
        console.error('LinkClick record error:', err);
    }
});

// ---------------------------------------------------------------------------
// V2 API — showroom feed (public buckets, paginated)
// ---------------------------------------------------------------------------
app.get('/api/v2/showroom', anonymousAuth, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip  = (page - 1) * limit;

        const buckets = await Bucket.find({ ...FILTER_PUBLIC, name: { $ne: 'Singletons' } })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit + 1)
            .populate('userId', 'username anonymousId avatar')
            .select('name thumbnail links isPaywalled price viewCount shareCount createdAt updatedAt userId grabbedBy description hashtags');

        const hasMore = buckets.length > limit;
        const items   = hasMore ? buckets.slice(0, limit) : buckets;

        // Build a set of bucket IDs the current user has already grabbed
        let grabbedSet = new Set();
        if (req.user?._id) {
            const grabs = await Bucket.find({
                userId:         req.user._id,
                sourceBucketId: { $in: items.map(b => b._id) }
            }).select('sourceBucketId').lean();
            grabs.forEach(g => grabbedSet.add(String(g.sourceBucketId)));
        }

        // Build a public bucket count per curator in one aggregation
        const curatorIds = [...new Set(items.map(b => b.userId?._id).filter(Boolean))];
        const bucketCounts = await Bucket.aggregate([
            { $match: { userId: { $in: curatorIds }, ...FILTER_PUBLIC, name: { $ne: 'Singletons' } } },
            { $group: { _id: '$userId', count: { $sum: 1 } } }
        ]);
        const bucketCountMap = Object.fromEntries(bucketCounts.map(r => [String(r._id), r.count]));

        res.json({
            hasMore,
            buckets: items.map(b => ({
                _id:        b._id,
                name:       b.name,
                thumbnail:  b.thumbnail || b.links.find(l => l.image)?.image || '',
                linkCount:  b.links.length,
                isPaywalled: b.isPaywalled || false,
                price:      b.price || 0,
                viewCount:  b.viewCount  || 0,
                shareCount:  b.shareCount || 0,
                createdAt:   b.createdAt,
                updatedAt:   b.updatedAt,
                description: b.description || '',
                hashtags:    b.hashtags    || [],
                isGrabbed:   grabbedSet.has(String(b._id)),
                grabCount:  (b.grabbedBy || []).length,
                grabbers:   (b.grabbedBy || [])
                    .filter(g => g.avatar)
                    .slice(-4)
                    .map(g => ({ username: g.username || '?', avatar: g.avatar })),
                curator: {
                    username:    b.userId?.username    || 'Unknown',
                    userId:      b.userId?.anonymousId || '',
                    avatar:      b.userId?.avatar      || '',
                    bucketCount: bucketCountMap[String(b.userId?._id)] || 0
                }
            }))
        });
    } catch (err) {
        console.error('Showroom feed error:', err);
        res.status(500).json({ error: 'Failed to load showroom' });
    }
});

// ---------------------------------------------------------------------------
// Subscriptions — follow / unfollow a curator
// ---------------------------------------------------------------------------

// Subscribe to a curator (identified by their anonymousId)
app.post('/api/users/:anonymousId/subscribe', requireAuth, requireVerification, async (req, res) => {
    try {
        const curator = await User.findOne({ anonymousId: req.params.anonymousId });
        if (!curator) return res.status(404).json({ error: 'Curator not found' });
        if (curator._id.equals(req.user._id)) return res.status(400).json({ error: 'Cannot subscribe to yourself' });

        await Subscription.create({ followerId: req.user._id, followeeId: curator._id });
        res.status(201).json({ success: true });
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'Already subscribed' });
        console.error('Subscribe error:', err);
        res.status(500).json({ error: 'Failed to subscribe' });
    }
});

// Unsubscribe from a curator
app.delete('/api/users/:anonymousId/subscribe', requireAuth, requireVerification, async (req, res) => {
    try {
        const curator = await User.findOne({ anonymousId: req.params.anonymousId });
        if (!curator) return res.status(404).json({ error: 'Curator not found' });

        await Subscription.findOneAndDelete({ followerId: req.user._id, followeeId: curator._id });
        res.json({ success: true });
    } catch (err) {
        console.error('Unsubscribe error:', err);
        res.status(500).json({ error: 'Failed to unsubscribe' });
    }
});

// Get subscription status + follower count for a curator
app.get('/api/users/:anonymousId/subscribe', requireAuth, requireVerification, async (req, res) => {
    try {
        const curator = await User.findOne({ anonymousId: req.params.anonymousId });
        if (!curator) return res.status(404).json({ error: 'Curator not found' });

        const [isSubscribed, followerCount] = await Promise.all([
            Subscription.exists({ followerId: req.user._id, followeeId: curator._id }),
            Subscription.countDocuments({ followeeId: curator._id })
        ]);

        res.json({ isSubscribed: !!isSubscribed, followerCount });
    } catch (err) {
        console.error('Subscription status error:', err);
        res.status(500).json({ error: 'Failed to fetch subscription status' });
    }
});

// ---------------------------------------------------------------------------
// V2 API — repositories (pre-computed cache, rebuilt hourly)
// ---------------------------------------------------------------------------
app.get('/api/v2/repositories', anonymousAuth, async (req, res) => {
    try {
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip  = Math.max(0, parseInt(req.query.skip)  || 0);

        // Fetch full cache — personalization is done in JS, not at DB query level
        const allRepos = await Repository.find().lean();

        // ── Anonymous users: pure global popularity ──────────────────────────
        if (!req.user || req.user.isAnonymous) {
            allRepos.sort((a, b) => b.totalClicks - a.totalClicks);
            const page    = allRepos.slice(skip, skip + limit + 1);
            const hasMore = page.length > limit;
            return res.json({ hasMore, repositories: hasMore ? page.slice(0, limit) : page });
        }

        // ── Logged-in users: personalised scoring ────────────────────────────
        const userId = req.user._id;
        const cutoff = new Date(Date.now() - 90 * 86_400_000); // 90-day window

        // Run both lookups in parallel
        const [domainClicks, subscriptions] = await Promise.all([
            // Signal 1 — direct affinity: domains this user has clicked recently
            LinkClick.aggregate([
                { $match: { userId, createdAt: { $gte: cutoff } } },
                { $group: { _id: '$domain', count: { $sum: 1 } } }
            ]),
            // Signal 2 — subscription: curators this user follows
            Subscription.find({ followerId: userId }).select('followeeId').lean()
        ]);

        // domain  → click count  (direct affinity map)
        const affinityMap   = Object.fromEntries(domainClicks.map(d => [d._id, d.count]));
        // set of subscribed curator _id strings (for O(1) lookup)
        const subscribedIds = new Set(subscriptions.map(s => String(s.followeeId)));

        // Score every repo and attach an internal rank value
        const scored = allRepos.map(repo => {
            // How many times has this user clicked links in this domain?
            const affinityScore = (affinityMap[repo.domain] || 0) * 3;

            // How many of the top links were curated by someone this user subscribes to?
            const subLinkCount  = repo.topLinks.filter(
                l => l.curatorId && subscribedIds.has(String(l.curatorId))
            ).length;
            const subscriptionScore = subLinkCount * 5; // subscription is the strongest signal

            // Global popularity as a tiebreaker (log-dampened so viral repos don't dominate)
            const popularityScore = Math.log(repo.totalClicks + 1) * 0.5;

            return { ...repo, _score: affinityScore + subscriptionScore + popularityScore };
        });

        scored.sort((a, b) => b._score - a._score);

        const page    = scored.slice(skip, skip + limit + 1);
        const hasMore = page.length > limit;
        const items   = (hasMore ? page.slice(0, limit) : page)
            .map(({ _score, ...repo }) => repo); // strip internal field before sending

        res.json({ hasMore, repositories: items });
    } catch (err) {
        console.error('Repositories endpoint error:', err);
        res.status(500).json({ error: 'Failed to load repositories' });
    }
});

// ---------------------------------------------------------------------------
// V2 API — single repository detail by domain
// ---------------------------------------------------------------------------
app.get('/api/v2/repositories/:domain', anonymousAuth, async (req, res) => {
    try {
        const repo = await Repository.findOne({ domain: req.params.domain }).lean();
        if (!repo) return res.status(404).json({ error: 'Repository not found' });
        res.json(repo);
    } catch (err) {
        console.error('Repository detail error:', err);
        res.status(500).json({ error: 'Failed to load repository' });
    }
});

// ---------------------------------------------------------------------------
// V2 routes — server-rendered with EJS
// ---------------------------------------------------------------------------
const v2Pages = [
    { path: '/v2',              view: 'v2/showroom',     title: 'Show Room',    page: 'home'         },
    { path: '/v2/showroom',     view: 'v2/showroom',     title: 'Show Room',    page: 'home'         },
    { path: '/v2/explore',      view: 'v2/explore',      title: 'Explore',      page: 'explore'      },
    { path: '/v2/transactions', view: 'v2/transactions', title: 'Transactions', page: 'transactions' },
    { path: '/v2/settings',     view: 'v2/settings',     title: 'Settings',     page: 'settings'     },
    { path: '/v2/docs',         view: 'v2/docs',         title: 'Docs',         page: 'docs'         },
    { path: '/v2/faq',          view: 'v2/faq',          title: 'FAQ',          page: 'faq'          },
    { path: '/v2/contact',      view: 'v2/contact',      title: 'Contact',      page: 'contact'      },
];

for (const { path: routePath, view, title, page } of v2Pages) {
    app.get(routePath, anonymousAuth, (req, res) => {
        res.render(view, { title, page, user: req.user ?? null });
    });
}

// Profile page — redirect /v2/profile to the logged-in user's @username route
app.get('/v2/profile', anonymousAuth, requireAuth, (req, res) => {
    const username = req.user?.username;
    if (username) return res.redirect(`/v2/@${username}`);
    res.redirect('/v2');
});

// Profile page — /v2/@:username  (public — anyone can view)
app.get('/v2/@:username', anonymousAuth, async (req, res) => {
    // Who is being viewed
    const profileUser = await User.findOne({ username: req.params.username, isAnonymous: false }).lean();
    if (!profileUser) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null }).catch(() => res.status(404).send('User not found'));

    // Is the logged-in user the owner of this profile?
    const viewer  = req.user ?? null;
    const isOwner = !!(viewer && !viewer.isAnonymous && viewer._id.toString() === profileUser._id.toString());

    const addDisplayThumb = (b) => ({
        ...b,
        _id: b._id.toString(),
        displayThumb: b.thumbnail || b.links?.find(l => l.image)?.image || null,
    });

    // Owners see all their buckets; visitors only see public ones (not unlisted)
    const bucketFilter = isOwner
        ? { userId: profileUser._id }
        : { userId: profileUser._id, ...FILTER_PUBLIC };

    const [allBuckets, subscriberCount, followingCount] = await Promise.all([
        Bucket.find(bucketFilter)
            .select('name description thumbnail visibility isPublic isPaywalled price links viewCount shareCount grabbedBy sourceBucketId sourceUrl originalCuratorName hashtags mature createdAt updatedAt')
            .sort({ order: 1, createdAt: -1 })
            .lean(),
        Subscription.countDocuments({ followeeId: profileUser._id }),
        Subscription.countDocuments({ followerId: profileUser._id }),
    ]);

    const ownBuckets     = allBuckets.filter(b => !b.sourceBucketId).map(addDisplayThumb);
    // Grabbed tab is only shown to the owner
    const grabbedBuckets = isOwner ? allBuckets.filter(b => b.sourceBucketId).map(addDisplayThumb) : [];
    const totalViews     = ownBuckets.reduce((sum, b) => sum + (b.viewCount       ?? 0), 0);
    const totalGrabs     = ownBuckets.reduce((sum, b) => sum + (b.grabbedBy?.length ?? 0), 0);
    const memberSince    = new Date(profileUser.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    res.render('v2/profile', {
        title:       `@${profileUser.username}`,
        page:        'profile',
        user:        viewer,          // logged-in user → used by topbar/sidebar
        profileUser,                  // the user whose profile this is
        isOwner,
        ownBuckets,
        grabbedBuckets,
        totalViews,
        totalGrabs,
        subscriberCount,
        followingCount,
        memberSince,
    });
});

// Dynamic repository page — domain comes from the URL
app.get('/v2/repository/:domain', anonymousAuth, (req, res) => {
    const domain = req.params.domain;
    res.render('v2/repository', { title: domain, page: 'repository', user: req.user ?? null, domain });
});

// Bucket view page — /v2/:bucketId  (accessible to anyone)
app.get('/v2/:bucketId', anonymousAuth, async (req, res) => {
    try {
        const { bucketId } = req.params;
        const bucket = await Bucket.findById(bucketId).lean();
        if (!bucket) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null });

        const curator = await User.findById(bucket.userId).select('username avatar anonymousId').lean();
        const curatorName        = curator?.username    || 'Anonymous';
        const curatorAvatar      = curator?.avatar      || null;
        const curatorAnonymousId = curator?.anonymousId || null;

        // Thumbnail: use raw stored value (data URL or URL) directly, fall back to first link image
        const thumbnailUrl = bucket.thumbnail || bucket.links?.find(l => l.image)?.image || null;
        const shareBaseUrl = `${req.protocol}://${req.get('host')}`;

        const vis = bucketVisibility(bucket);

        // Private buckets are owner-only
        const isOwner = !!(req.user && !req.user.isAnonymous && bucket.userId.toString() === req.user._id.toString());
        if (vis === 'private' && !isOwner) {
            return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        // Paywall access check
        const hasAccess = isOwner
            || !bucket.isPaywalled
            || (!req.user.isAnonymous && !!(await BucketAccess.findOne({ userId: req.user._id, bucketId: bucket._id })));

        // Check follow + grab state (non-owners only)
        const isFollowing = !isOwner && req.user && !req.user.isAnonymous && curatorAnonymousId
            ? !!(await Subscription.exists({ followerId: req.user._id, followeeId: curator._id }))
            : false;

        const hasGrabbed = !isOwner && req.user && !req.user.isAnonymous
            ? !!(await Bucket.findOne({ userId: req.user._id, sourceBucketId: bucket._id }).select('_id').lean())
            : false;

        // Track view (fire-and-forget, skip owner)
        if (!isOwner) {
            if (req.user) {
                const existing = bucket.viewedBy?.find(v => v.userId.toString() === req.user._id.toString());
                if (!existing) {
                    Bucket.findByIdAndUpdate(bucketId, {
                        $push: { viewedBy: { userId: req.user._id, lastViewedVersion: bucket.updatedAt } },
                        $inc: { viewCount: 1 }
                    }).catch(() => {});
                } else if (existing.lastViewedVersion < bucket.updatedAt) {
                    Bucket.updateOne(
                        { _id: bucketId, 'viewedBy.userId': req.user._id },
                        { $set: { 'viewedBy.$.lastViewedVersion': bucket.updatedAt }, $inc: { viewCount: 1 } }
                    ).catch(() => {});
                }
            } else {
                Bucket.findByIdAndUpdate(bucketId, { $inc: { viewCount: 1 } }).catch(() => {});
            }
        }

        res.render('v2/bucket', {
            title: bucket.name,
            page: '',
            user: req.user ?? null,
            bucket,
            bucketId,
            curatorName,
            curatorAvatar,
            curatorAnonymousId,
            isFollowing,
            thumbnailUrl,
            shareBaseUrl,
            isOwner,
            hasAccess,
            hasGrabbed,
            isUnlisted: vis === 'unlisted',
        });
    } catch (err) {
        console.error('Error loading bucket view:', err);
        res.status(500).send('Error loading bucket');
    }
});

// Start the server
connectMongo()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
            console.log(`Scraping endpoint: http://localhost:${PORT}/scrape?url=YOUR_URL`);
            console.log(`Frontend available at http://localhost:${PORT}`);
        });

        // Run the repository build immediately, then every hour
        const REPO_REBUILD_INTERVAL = 60 * 60 * 1000; // 1 hour
        buildRepositories().catch(err => console.error('[repos] Initial build failed:', err));
        setInterval(() => {
            buildRepositories().catch(err => console.error('[repos] Scheduled build failed:', err));
        }, REPO_REBUILD_INTERVAL);
    })
    .catch(err => {
        console.error('Failed to connect to MongoDB:', err.message);
        process.exit(1);
    });