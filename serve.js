import http from 'http';
import { WebSocketServer } from 'ws';
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
import notificationsRouter from './server/routes/notifications.js';
import Notification from './server/models/notification.js';
import BucketView from './server/models/bucketView.js';
import BucketShare from './server/models/bucketShare.js';
import { wsClients, pushNotification } from './server/ws.js';

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


const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------------------------------------------------------------------------
// WebSocket — one persistent connection per logged-in user.
// Client registry lives in server/ws.js to avoid circular imports.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
    const params = new URL(req.url, 'http://x').searchParams;
    const userId = params.get('userId');
    if (!userId) { ws.close(); return; }

    if (!wsClients.has(userId)) wsClients.set(userId, new Set());
    wsClients.get(userId).add(ws);

    ws.on('close', () => {
        const set = wsClients.get(userId);
        if (set) { set.delete(ws); if (!set.size) wsClients.delete(userId); }
    });

    ws.on('error', () => ws.terminate());
});

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
app.use('/api/notifications', notificationsRouter);

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

// Fan-out a grabbed_bucket_updated notification to all grabbers of a bucket.
// Dedup: skips grabbers who already received this notification for this bucket today.
async function fanOutGrabbedBucketUpdated(bucket, curatorUsername) {
    try {
        const grabberIds = (bucket.grabbedBy || []).map(g => g.userId);
        if (!grabberIds.length) return;

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const alreadyNotified = await Notification.find({
            userId:               { $in: grabberIds },
            type:                 'grabbed_bucket_updated',
            'data.sourceBucketId': bucket._id,
            createdAt:            { $gte: oneDayAgo },
        }).select('userId').lean();

        const notifiedSet = new Set(alreadyNotified.map(n => String(n.userId)));
        const toNotify    = grabberIds.filter(id => !notifiedSet.has(String(id)));
        if (!toNotify.length) return;

        const docs = await Notification.insertMany(
            toNotify.map(userId => ({
                userId,
                type: 'grabbed_bucket_updated',
                data: {
                    curatorId:      bucket.userId,
                    curatorUsername,
                    sourceBucketId: bucket._id,
                    bucketName:     bucket.name,
                },
            })),
            { ordered: false }
        );
        for (const n of docs) pushNotification(n.userId, { type: 'new_notification', notification: n });
    } catch (err) {
        console.error('[notif] grabbed_bucket_updated fan-out:', err);
    }
}

// Fan-out a new_bucket_published notification to all followers of a curator
async function fanOutNewBucketPublished(curatorId, curatorUsername, bucketId, bucketName) {
    try {
        const followers = await Subscription.find({ followeeId: curatorId }).select('followerId').lean();
        if (!followers.length) return;
        const docs = await Notification.insertMany(
            followers.map(f => ({
                userId: f.followerId,
                type:   'new_bucket_published',
                data:   { curatorId, curatorUsername, bucketId, bucketName },
            })),
            { ordered: false }
        );
        for (const n of docs) pushNotification(n.userId, { type: 'new_notification', notification: n });
    } catch (err) {
        console.error('[notif] new_bucket_published fan-out:', err);
    }
}

// Create a new bucket
app.post('/api/buckets', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name, description, tags, visibility, monetized, price, mature, sourceUrl, thumbnail, links, draft } = req.body;

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
            href:     l.url   || '',
            text:     l.title || '',
            isFree:   !l.monetized,
            isPinned: !!l.pinned,
            image:    await fetchImageAsBase64(l.thumb || null) ?? l.thumb ?? null,
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
            isDraft:     !!draft,
        });

        if (vis === 'public' && !bucket.isDraft) {
            fanOutNewBucketPublished(req.user._id, req.user.username || '', bucket._id, bucket.name);
        }

        res.status(201).json({ _id: bucket._id, name: bucket.name });
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
        const { name, description, tags, visibility, monetized, price, mature, sourceUrl, thumbnail, links, isDraft } = req.body;

        // Fetch current state to detect meaningful changes before building the update
        const current = await Bucket.findOne({ _id: req.params.id, userId: req.user._id });
        if (!current) return res.status(404).json({ error: 'Bucket not found' });

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
                href:     l.url   || '',
                text:     l.title || '',
                isFree:   !l.monetized,
                isPinned: !!l.pinned,
                // Fall back to the original URL if base64 conversion fails — never wipe a thumbnail
                image:    await fetchImageAsBase64(l.thumb || null) ?? l.thumb ?? null,
            })));
        }

        if (isDraft !== undefined) update.isDraft = !!isDraft;

        // Auto-set thumbnail from first link image if still empty after update
        if (!update.thumbnail && update.links) {
            const firstWithImage = update.links.find(l => l.image);
            if (firstWithImage) update.thumbnail = firstWithImage.image;
        }

        // Only bump updatedAt for meaningful content/audience/monetization changes.
        // Cosmetic changes (description, thumbnail, tags, sourceUrl, mature) do not count.
        let meaningfulChange = false;
        // Separate flag: only link/monetization changes notify grabbers (stricter subset).
        let notifyGrabbers = false;
        if (name !== undefined && name !== current.name) meaningfulChange = true;
        if (visibility !== undefined) {
            const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'private';
            if (vis !== current.visibility) meaningfulChange = true;
        }
        if (monetized !== undefined && !!monetized !== current.isPaywalled) { meaningfulChange = true; notifyGrabbers = true; }
        if (price !== undefined && (Number(price) || 0) !== current.price)  { meaningfulChange = true; notifyGrabbers = true; }
        if (isDraft !== undefined && !!isDraft !== current.isDraft) meaningfulChange = true;
        if (links !== undefined) {
            if (links.length !== current.links.length) {
                meaningfulChange = true; notifyGrabbers = true;
            } else {
                const incomingHrefs = links.map(l => l.url || '').sort().join(',');
                const currentHrefs  = current.links.map(l => l.href).sort().join(',');
                if (incomingHrefs !== currentHrefs) {
                    meaningfulChange = true; notifyGrabbers = true;
                } else {
                    // Same links — check if per-link monetization changed
                    const currentFreeMap = Object.fromEntries(current.links.map(l => [l.href, l.isFree]));
                    for (const l of links) {
                        if (currentFreeMap[l.url || ''] !== !l.monetized) { meaningfulChange = true; notifyGrabbers = true; break; }
                    }
                }
            }
        }

        const bucket = await Bucket.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id },
            update,
            { new: true, timestamps: meaningfulChange }
        );

        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        // Fire new_bucket_published if this update transitions the bucket into public+non-draft
        const wasPublished   = bucketVisibility(current) === 'public' && !current.isDraft;
        const isNowPublished = bucketVisibility(bucket)  === 'public' && !bucket.isDraft;
        if (!wasPublished && isNowPublished) {
            fanOutNewBucketPublished(req.user._id, req.user.username || '', bucket._id, bucket.name);
        }

        // Notify grabbers of content/monetization changes (only if bucket is already public)
        if (notifyGrabbers && isNowPublished) {
            fanOutGrabbedBucketUpdated(bucket, req.user.username || '');
        }

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

        res.json({ bucketId: bucket._id.toString(), name: bucket.name, isDraft: !!bucket.isDraft });
    } catch (error) {
        console.error('Error fetching bucket ID:', error);
        res.status(500).json({ error: 'Failed to fetch bucket ID' });
    }
});

// Delete all draft buckets for the current user (called when opening a fresh new-bucket modal)
app.delete('/api/buckets/drafts', requireAuth, async (req, res) => {
    try {
        await Bucket.deleteMany({ userId: req.user._id, isDraft: true });
        res.json({ ok: true });
    } catch (error) {
        console.error('Error deleting drafts:', error);
        res.status(500).json({ error: 'Failed to delete drafts' });
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
            { new: true, timestamps: false }
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

        // new: false → returns the OLD doc so we can detect the publish transition
        const oldBucket = await Bucket.findOneAndUpdate(
            { userId: req.user._id, name },
            { visibility, isPublic: visibility === 'public' },
        );

        if (!oldBucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        const wasPublished = bucketVisibility(oldBucket) === 'public' && !oldBucket.isDraft;
        const isNowPublished = visibility === 'public' && !oldBucket.isDraft;
        if (!wasPublished && isNowPublished) {
            fanOutNewBucketPublished(req.user._id, req.user.username || '', oldBucket._id, oldBucket.name);
        }

        res.json({ name: oldBucket.name, visibility, isPublic: visibility === 'public' });
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

        // Track grabber on the root (original) bucket — no timestamps: grabbing doesn't constitute a content update
        const rootBucketId = source.originalBucketId || source._id;
        await Bucket.findByIdAndUpdate(rootBucketId, {
            $push: { grabbedBy: { userId: req.user._id, username: req.user.username || '', avatar: req.user.avatar || '' } }
        }, { timestamps: false });

        // Notify the original curator (skip self-grabs)
        if (!curatorId.equals(req.user._id)) {
            Notification.create({
                userId: curatorId,
                type: 'bucket_grabbed',
                data: {
                    grabberId:       req.user._id,
                    grabberUsername: req.user.username || '',
                    bucketId:        source._id,
                    bucketName:      source.name,
                },
            }).then(n => pushNotification(curatorId, { type: 'new_notification', notification: n }))
              .catch(err => console.error('[notif] bucket_grabbed:', err));
        }

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

        // Remove grabber from the root bucket's grabbedBy list — no timestamps: ungrabbing doesn't constitute a content update
        const rootBucketId = cloned.originalBucketId || cloned.sourceBucketId;
        if (rootBucketId) {
            await Bucket.findByIdAndUpdate(rootBucketId, {
                $pull: { grabbedBy: { userId: req.user._id } }
            }, { timestamps: false });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error ungrabbing bucket:', error);
        res.status(500).json({ error: 'Failed to ungrab bucket' });
    }
});

// Increment viewCount for a bucket, deduplicating by userId (logged-in) or IP (anon, 6h window).
// isOwner check must be done by the caller before invoking this.
async function trackBucketView(bucketId, userId, ip) {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    if (userId) {
        const exists = await BucketView.exists({ bucketId, userId });
        if (!exists) {
            await BucketView.create({ bucketId, userId, ip: null, expiresAt: null });
            await Bucket.findByIdAndUpdate(bucketId, { $inc: { viewCount: 1 } }, { timestamps: false });
        }
    } else {
        const exists = await BucketView.exists({ bucketId, ip });
        if (!exists) {
            await BucketView.create({ bucketId, userId: null, ip, expiresAt: new Date(Date.now() + SIX_HOURS_MS) });
            await Bucket.findByIdAndUpdate(bucketId, { $inc: { viewCount: 1 } }, { timestamps: false });
        }
    }
}

// Record a view for a bucket
app.post('/api/buckets/:id/view', requireAuth, requireVerification, async (req, res) => {
    try {
        const bucket = await Bucket.findById(req.params.id).select('_id userId').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        if (!bucket.userId.equals(req.user._id)) {
            await trackBucketView(bucket._id, req.user._id, null);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error recording view:', error);
        res.status(500).json({ error: 'Failed to record view' });
    }
});

// Record a share for a bucket — counts once per user per bucket, forever.
// The unique index on BucketShare makes duplicate inserts fail silently (race-condition-safe).
app.post('/api/buckets/:id/share', requireAuth, requireVerification, async (req, res) => {
    try {
        const bucket = await Bucket.findById(req.params.id).select('_id userId').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        if (bucket.userId.equals(req.user._id)) {
            return res.json({ success: true }); // owner sharing their own bucket doesn't count
        }

        try {
            await BucketShare.create({ bucketId: bucket._id, userId: req.user._id });
            await Bucket.findByIdAndUpdate(bucket._id, { $inc: { shareCount: 1 } }, { timestamps: false });
        } catch (err) {
            if (err.code !== 11000) throw err; // 11000 = duplicate key — user already shared, skip silently
        }

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
                { $inc: { 'links.$.clickCount': 1 } },
                { timestamps: false }
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

        // Build a set of curator IDs the current user already follows
        let followedSet = new Set();
        if (req.user?._id && !req.user.isAnonymous) {
            const subs = await Subscription.find({
                followerId: req.user._id,
                followeeId: { $in: curatorIds },
            }).select('followeeId').lean();
            subs.forEach(s => followedSet.add(String(s.followeeId)));
        }
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
                    bucketCount: bucketCountMap[String(b.userId?._id)] || 0,
                    isFollowing: followedSet.has(String(b.userId?._id))
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

        // Delete any previous follow notification from this same person before inserting a fresh one
        Notification.findOneAndDelete({ userId: curator._id, type: 'new_follower', 'data.followerId': req.user._id })
            .then(() => Notification.create({
                userId: curator._id,
                type: 'new_follower',
                data: {
                    followerId:          req.user._id,
                    followerAnonymousId: req.user.anonymousId || '',
                    followerUsername:    req.user.username || '',
                    followerAvatar:      req.user.avatar   || '',
                },
            }))
            .then(n => pushNotification(curator._id, { type: 'new_notification', notification: n }))
            .catch(err => console.error('[notif] new_follower:', err));

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

// ── Search: JSON pagination API ──────────────────────────────────────────────
app.get('/api/v2/search', anonymousAuth, async (req, res) => {
    const q    = (req.query.q    || '').trim();
    const type = (req.query.type || '').toLowerCase(); // people | buckets | repos
    const skip = Math.max(0, parseInt(req.query.skip) || 0);

    if (!q || !['people', 'buckets', 'repos'].includes(type)) {
        return res.json({ items: [], hasMore: false });
    }

    const BUCKET_SELECT = 'name thumbnail links isPaywalled price viewCount shareCount createdAt updatedAt userId grabbedBy description hashtags isDraft visibility isPublic';
    const U_LIMIT = 6, B_LIMIT = 9, R_LIMIT = 3;

    try {
        // Direct-lookup queries don't paginate
        if (q.match(/\/share\/bucket\/([a-f0-9]{24})/i) ||
            q.match(/\/@([A-Za-z0-9_.-]+)(?:[/?]|$)/)  ||
            /^[a-f0-9]{24}$/i.test(q)) {
            return res.json({ items: [], hasMore: false });
        }

        const searchTerm = q.startsWith('@') ? q.slice(1) : q;
        const escaped    = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // ── People ────────────────────────────────────────────────────────────
        if (type === 'people') {
            const found  = await User.find({ username: new RegExp(escaped, 'i'), isAnonymous: false })
                .skip(skip).limit(U_LIMIT + 1).lean();
            const hasMore = found.length > U_LIMIT;
            const users   = found.slice(0, U_LIMIT);

            const bucketCounts = await Promise.all(users.map(u =>
                Bucket.countDocuments({ userId: u._id, isDraft: { $ne: true }, $or: FILTER_PUBLIC.$or })
            ));
            let followedIds = new Set();
            if (req.user?._id && !req.user.isAnonymous && users.length) {
                const subs = await Subscription.find({
                    followerId: req.user._id,
                    followeeId: { $in: users.map(u => u._id) },
                }).select('followeeId').lean();
                subs.forEach(s => followedIds.add(String(s.followeeId)));
            }
            return res.json({
                hasMore,
                items: users.map((u, i) => ({
                    username:    u.username,
                    avatar:      u.avatar    || null,
                    anonymousId: u.anonymousId,
                    bucketCount: bucketCounts[i],
                    isFollowing: followedIds.has(String(u._id)),
                    isSelf:      !!(req.user && !req.user.isAnonymous &&
                                    req.user._id.toString() === u._id.toString()),
                })),
            });
        }

        // ── Buckets ───────────────────────────────────────────────────────────
        if (type === 'buckets') {
            const found = await Bucket.find({
                name:    new RegExp(escaped, 'i'),
                isDraft: { $ne: true },
                $or:     FILTER_PUBLIC.$or,
            })
            .select(BUCKET_SELECT)
            .skip(skip).limit(B_LIMIT + 1)
            .populate('userId', 'username anonymousId avatar')
            .lean();

            const hasMore = found.length > B_LIMIT;
            const buckets = found.slice(0, B_LIMIT);

            const grabCounts = await Promise.all(buckets.map(b =>
                Bucket.countDocuments({ $or: [{ sourceBucketId: b._id }, { originalBucketId: b._id }] })
            ));
            let grabbedSet = new Set();
            if (req.user?._id && buckets.length) {
                const grabs = await Bucket.find({
                    userId:         req.user._id,
                    sourceBucketId: { $in: buckets.map(b => b._id) },
                }).select('sourceBucketId').lean();
                grabs.forEach(g => grabbedSet.add(String(g.sourceBucketId)));
            }
            let followedIds = new Set();
            if (req.user?._id && !req.user.isAnonymous) {
                const ids = buckets.map(b => b.userId?._id).filter(Boolean);
                if (ids.length) {
                    const subs = await Subscription.find({
                        followerId: req.user._id,
                        followeeId: { $in: ids },
                    }).select('followeeId').lean();
                    subs.forEach(s => followedIds.add(String(s.followeeId)));
                }
            }
            return res.json({
                hasMore,
                items: buckets.map((b, i) => ({
                    _id:         b._id,
                    name:        b.name,
                    thumbnail:   b.thumbnail || b.links?.find(l => l.image)?.image || '',
                    linkCount:   b.links?.length || 0,
                    isPaywalled: b.isPaywalled  || false,
                    price:       b.price        || 0,
                    viewCount:   b.viewCount    || 0,
                    shareCount:  b.shareCount   || 0,
                    createdAt:   b.createdAt,
                    updatedAt:   b.updatedAt,
                    description: b.description  || '',
                    hashtags:    b.hashtags     || [],
                    isGrabbed:   grabbedSet.has(String(b._id)),
                    grabCount:   grabCounts[i],
                    grabbers:    (b.grabbedBy || []).filter(g => g.avatar).slice(-4)
                                    .map(g => ({ username: g.username || '?', avatar: g.avatar })),
                    curator: {
                        username:    b.userId?.username    || 'Unknown',
                        userId:      b.userId?.anonymousId || '',
                        avatar:      b.userId?.avatar      || '',
                        isFollowing: followedIds.has(String(b.userId?._id)),
                    },
                })),
            });
        }

        // ── Repos ─────────────────────────────────────────────────────────────
        if (type === 'repos') {
            const sidebarTerm = q.replace(/^[@#]/, '').replace(/^https?:\/\/[^/]*\//, '').trim();
            const sEsc        = sidebarTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const found       = await Repository.find({ domain: new RegExp(sEsc, 'i') })
                .sort({ totalClicks: -1 }).skip(skip).limit(R_LIMIT + 1).lean();
            const hasMore = found.length > R_LIMIT;
            return res.json({
                hasMore,
                items: found.slice(0, R_LIMIT).map(r => ({
                    domain:      r.domain,
                    bucketCount: r.bucketCount || 0,
                    topLinks:    (r.topLinks || []).slice(0, 4).map(l => ({ image: l.image || '' })),
                })),
            });
        }

        return res.json({ items: [], hasMore: false });

    } catch (err) {
        console.error('Search API error:', err);
        return res.json({ items: [], hasMore: false });
    }
});

// Search page — /v2/search?q=<query>[&type=people|buckets|repos]
app.get('/v2/search', anonymousAuth, async (req, res) => {
    const q          = (req.query.q    || '').trim();
    const searchType = (req.query.type || '').toLowerCase(); // '' | 'people' | 'buckets' | 'repos'
    if (!q) return res.redirect('/v2/explore');

    const BUCKET_SELECT = 'name thumbnail links isPaywalled price viewCount shareCount createdAt updatedAt userId grabbedBy description hashtags isDraft visibility isPublic';
    const U_LIMIT = 6, B_LIMIT = 9, R_LIMIT = 3, T_LIMIT = 18;

    let users   = [];
    let buckets = [];
    let hasMoreUsers   = false;
    let hasMoreBuckets = false;
    let hasMoreRepos   = false;

    try {
        // 1. Bucket share URL  →  /share/bucket/{id}
        const shareMatch = q.match(/\/share\/bucket\/([a-f0-9]{24})/i);

        // 2. Profile URL  →  /@username  or  /v2/@username
        const profileUrlMatch = q.match(/\/@([A-Za-z0-9_.-]+)(?:[/?]|$)/);

        // 3. Raw 24-char hex ObjectId
        const isObjectId = /^[a-f0-9]{24}$/i.test(q);

        // 4. @username shorthand
        const usernameAt = q.startsWith('@') ? q.slice(1) : null;

        if (shareMatch) {
            const bucket = await Bucket.findById(shareMatch[1])
                .select(BUCKET_SELECT)
                .populate('userId', 'username anonymousId avatar')
                .lean();
            if (bucket && bucketVisibility(bucket) === 'public' && !bucket.isDraft) {
                buckets = [bucket];
            }

        } else if (profileUrlMatch) {
            const found = await User.findOne({ username: profileUrlMatch[1], isAnonymous: false }).lean();
            if (found) users = [found];

        } else if (isObjectId) {
            const [bucket, userByAnonId] = await Promise.all([
                Bucket.findById(q)
                    .select(BUCKET_SELECT)
                    .populate('userId', 'username anonymousId avatar')
                    .lean(),
                User.findOne({ anonymousId: q, isAnonymous: false }).lean(),
            ]);
            if (bucket && bucketVisibility(bucket) === 'public' && !bucket.isDraft) buckets = [bucket];
            if (userByAnonId) users = [userByAnonId];

        } else {
            const searchTerm = usernameAt || q;
            const escaped    = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // In type-specific mode, skip irrelevant fetches
            const skipBuckets = !!(usernameAt || searchType === 'people' || searchType === 'repos');
            const skipUsers   = searchType === 'buckets' || searchType === 'repos';

            const [foundUsers, foundBuckets] = await Promise.all([
                skipUsers
                    ? Promise.resolve([])
                    : User.find({ username: new RegExp(escaped, 'i'), isAnonymous: false })
                        .limit(U_LIMIT + 1).lean(),
                skipBuckets
                    ? Promise.resolve([])
                    : Bucket.find({
                        name:    new RegExp(escaped, 'i'),
                        isDraft: { $ne: true },
                        $or:     FILTER_PUBLIC.$or,
                      })
                      .select(BUCKET_SELECT)
                      .limit(B_LIMIT + 1)
                      .populate('userId', 'username anonymousId avatar')
                      .lean(),
            ]);

            hasMoreUsers   = foundUsers.length   > U_LIMIT;
            hasMoreBuckets = foundBuckets.length > B_LIMIT;
            users   = foundUsers.slice(0, U_LIMIT);
            buckets = foundBuckets.slice(0, B_LIMIT);
        }

        // ── Grab counts ───────────────────────────────────────────────────────
        const grabCounts = await Promise.all(
            buckets.map(b => Bucket.countDocuments({
                $or: [{ sourceBucketId: b._id }, { originalBucketId: b._id }],
            }))
        );

        // ── Public bucket counts per user ─────────────────────────────────────
        const bucketCounts = await Promise.all(
            users.map(u => Bucket.countDocuments({
                userId:  u._id,
                isDraft: { $ne: true },
                $or:     FILTER_PUBLIC.$or,
            }))
        );

        // ── Which buckets has the viewer already grabbed? ─────────────────────
        let grabbedSet = new Set();
        if (req.user?._id && buckets.length) {
            const grabs = await Bucket.find({
                userId:         req.user._id,
                sourceBucketId: { $in: buckets.map(b => b._id) },
            }).select('sourceBucketId').lean();
            grabs.forEach(g => grabbedSet.add(String(g.sourceBucketId)));
        }

        // ── Which users/curators does the viewer already follow? ──────────────
        let followedIds = new Set();
        if (req.user?._id && !req.user.isAnonymous) {
            const allTargetIds = [
                ...buckets.map(b => b.userId?._id).filter(Boolean),
                ...users.map(u => u._id),
            ];
            if (allTargetIds.length) {
                const subs = await Subscription.find({
                    followerId: req.user._id,
                    followeeId: { $in: allTargetIds },
                }).select('followeeId').lean();
                subs.forEach(s => followedIds.add(String(s.followeeId)));
            }
        }

        // ── Format buckets ────────────────────────────────────────────────────
        const formattedBuckets = buckets.map((b, i) => ({
            _id:         b._id,
            name:        b.name,
            thumbnail:   b.thumbnail || b.links?.find(l => l.image)?.image || '',
            linkCount:   b.links?.length || 0,
            isPaywalled: b.isPaywalled  || false,
            price:       b.price        || 0,
            viewCount:   b.viewCount    || 0,
            shareCount:  b.shareCount   || 0,
            createdAt:   b.createdAt,
            updatedAt:   b.updatedAt,
            description: b.description  || '',
            hashtags:    b.hashtags     || [],
            isGrabbed:   grabbedSet.has(String(b._id)),
            grabCount:   grabCounts[i],
            grabbers:    (b.grabbedBy || [])
                .filter(g => g.avatar)
                .slice(-4)
                .map(g => ({ username: g.username || '?', avatar: g.avatar })),
            curator: {
                username:    b.userId?.username    || 'Unknown',
                userId:      b.userId?.anonymousId || '',
                avatar:      b.userId?.avatar      || '',
                isFollowing: followedIds.has(String(b.userId?._id)),
            },
        }));

        // ── Format users ──────────────────────────────────────────────────────
        const formattedUsers = users.map((u, i) => ({
            username:    u.username,
            avatar:      u.avatar    || null,
            anonymousId: u.anonymousId,
            bucketCount: bucketCounts[i],
            isFollowing: followedIds.has(String(u._id)),
            isSelf:      !!(req.user && !req.user.isAnonymous &&
                            req.user._id.toString() === u._id.toString()),
        }));

        // ── Sidebar: repositories ─────────────────────────────────────────────
        const sidebarTerm    = q.replace(/^[@#]/, '').replace(/^https?:\/\/[^/]*\//, '').trim();
        const sidebarEscaped = sidebarTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        let repos           = [];
        let reposMatchQuery = false;
        if (sidebarEscaped) {
            const found = await Repository.find({ domain: new RegExp(sidebarEscaped, 'i') })
                .sort({ totalClicks: -1 }).limit(R_LIMIT + 1).lean();
            reposMatchQuery = found.length > 0;
            hasMoreRepos    = found.length > R_LIMIT;
            repos           = found.slice(0, R_LIMIT);
        }
        if (!repos.length) {
            repos = await Repository.find().sort({ totalClicks: -1 }).limit(R_LIMIT).lean();
        }

        // ── Sidebar: hashtags ─────────────────────────────────────────────────
        let tagResults    = [];
        let tagsMatchQuery = false;
        if (sidebarEscaped.length >= 2) {
            tagResults = await Bucket.aggregate([
                { $match: { isDraft: { $ne: true }, $or: FILTER_PUBLIC.$or } },
                { $unwind: '$hashtags' },
                { $match: { hashtags: new RegExp(sidebarEscaped, 'i') } },
                { $group: { _id: { $toLower: '$hashtags' }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: T_LIMIT },
            ]);
            tagsMatchQuery = tagResults.length > 0;
        }
        if (!tagResults.length) {
            tagResults = await Bucket.aggregate([
                { $match: { isDraft: { $ne: true }, $or: FILTER_PUBLIC.$or } },
                { $unwind: '$hashtags' },
                { $group: { _id: { $toLower: '$hashtags' }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: T_LIMIT },
            ]);
        }

        const formattedRepos = repos.map(r => ({
            domain:      r.domain,
            bucketCount: r.bucketCount || 0,
            topLinks:    (r.topLinks || []).slice(0, 4).map(l => ({ image: l.image || '' })),
        }));

        const formattedTags = tagResults.map(t => ({ tag: t._id, count: t.count }));

        res.render('v2/search', {
            title:          `"${q}" — Search`,
            page:           'explore',
            user:           req.user ?? null,
            query:          q,
            searchType,
            users:          formattedUsers,
            buckets:        formattedBuckets,
            repos:          formattedRepos,
            tags:           formattedTags,
            reposMatchQuery,
            tagsMatchQuery,
            hasMoreUsers,
            hasMoreBuckets,
            hasMoreRepos,
        });

    } catch (err) {
        console.error('Search error:', err);
        res.render('v2/search', {
            title:           `"${q}" — Search`,
            page:            'explore',
            user:            req.user ?? null,
            query:           q,
            searchType,
            users:           [],
            buckets:         [],
            repos:           [],
            tags:            [],
            reposMatchQuery: false,
            tagsMatchQuery:  false,
            hasMoreUsers:    false,
            hasMoreBuckets:  false,
            hasMoreRepos:    false,
        });
    }
});

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
            .select('name description thumbnail visibility isPublic isPaywalled price links viewCount shareCount grabbedBy sourceBucketId sourceUrl originalCuratorName hashtags mature isDraft createdAt updatedAt')
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

// Report page — /v2/report/:bucketId
app.get('/v2/report/:bucketId', anonymousAuth, async (req, res) => {
    try {
        const { bucketId } = req.params;
        const bucket = await Bucket.findById(bucketId).lean();
        if (!bucket) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null });

        const vis = bucketVisibility(bucket);
        const isOwner = !!(req.user && !req.user.isAnonymous && bucket.userId.toString() === req.user._id.toString());
        if (vis === 'private' && !isOwner) {
            return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        const curator = await User.findById(bucket.userId).select('username avatar anonymousId').lean();
        const curatorName   = curator?.username || 'Anonymous';
        const curatorAvatar = curator?.avatar   || null;
        const thumbnailUrl  = bucket.thumbnail  || bucket.links?.find(l => l.image)?.image || null;

        res.render('v2/report', {
            title: 'Report · ' + bucket.name,
            page: '',
            user: req.user ?? null,
            bucket,
            bucketId,
            curatorName,
            curatorAvatar,
            thumbnailUrl,
        });
    } catch (err) {
        console.error('Error loading report page:', err);
        res.status(500).send('Error loading report page');
    }
});

// Bucket thumbnail — /v2/bucket/:bucketId/thumbnail.jpg
app.get('/v2/bucket/:bucketId/thumbnail.jpg', async (req, res) => {
    try {
        const bucket = await Bucket.findById(req.params.bucketId).lean();
        if (!bucket) return res.status(404).send('Not found');
        const rawImage = bucket.thumbnail || bucket.links?.find(l => l.image)?.image || null;
        if (!rawImage) return res.status(404).send('Not found');
        const mimeMatch = rawImage.match(/^data:(image\/\w+);base64,/);
        const base64Data = mimeMatch ? rawImage.slice(mimeMatch[0].length) : rawImage;
        res.set('Content-Type', mimeMatch ? mimeMatch[1] : 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=31536000');
        res.send(Buffer.from(base64Data, 'base64'));
    } catch {
        res.status(500).send('Error');
    }
});

// Bucket view page — /v2/bucket/:bucketId  (accessible to anyone)
app.get('/v2/bucket/:bucketId', anonymousAuth, async (req, res) => {
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
            const userId = (req.user && !req.user.isAnonymous) ? req.user._id : null;
            trackBucketView(bucketId, userId, req.ip).catch(() => {});
        }

        const bucketUrl = `${shareBaseUrl}/v2/bucket/${bucketId}`;
        const hasThumbnail = !!(bucket.thumbnail || bucket.links?.some(l => l.image));
        const ogImage = hasThumbnail ? `${shareBaseUrl}/v2/bucket/${bucketId}/thumbnail.jpg` : null;

        res.render('v2/bucket', {
            title: bucket.name,
            page: 'explore',
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
            ogTitle: `${bucket.name} - Shared Link Collection`,
            ogDescription: '',
            ogUrl: bucketUrl,
            ogImage,
        });
    } catch (err) {
        console.error('Error loading bucket view:', err);
        res.status(500).send('Error loading bucket');
    }
});

// Start the server
connectMongo()
    .then(() => {
        server.listen(PORT, () => {
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

        // Delete anonymous users based on inactivity:
        //   - no buckets: expire after 1 hour
        //   - has buckets: expire after 7 days (matches cookie lifetime)
        async function cleanupAnonUsers() {
            const oneHourAgo  = new Date(Date.now() - 60 * 60 * 1000);
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

            // Anon users inactive > 7 days (with or without buckets)
            const staleUsers = await User.find({ isAnonymous: true, lastActive: { $lt: sevenDaysAgo } }, '_id');
            // Anon users inactive > 1 hour with no buckets
            const recentUsers = await User.find({ isAnonymous: true, lastActive: { $lt: oneHourAgo, $gte: sevenDaysAgo } }, '_id');

            const recentUserIds = recentUsers.map(u => u._id);
            const bucketedIds = recentUserIds.length
                ? (await Bucket.distinct('userId', { userId: { $in: recentUserIds } })).map(id => id.toString())
                : [];
            const toDeleteRecent = recentUserIds.filter(id => !bucketedIds.includes(id.toString()));

            const staleIds = staleUsers.map(u => u._id);
            const allToDelete = [...staleIds, ...toDeleteRecent];

            if (allToDelete.length === 0) return;

            // Delete buckets for stale users (the recent ones without buckets have none)
            if (staleIds.length > 0) {
                await Bucket.deleteMany({ userId: { $in: staleIds } });
            }
            const result = await User.deleteMany({ _id: { $in: allToDelete } });
            console.log(`[cleanup] Deleted ${result.deletedCount} anonymous user(s) (${staleIds.length} stale with buckets, ${toDeleteRecent.length} recent without buckets)`);
        }
        cleanupAnonUsers().catch(err => console.error('[cleanup] Initial anon cleanup failed:', err));
        setInterval(() => {
            cleanupAnonUsers().catch(err => console.error('[cleanup] Anon cleanup failed:', err));
        }, 60 * 60 * 1000);
    })
    .catch(err => {
        console.error('Failed to connect to MongoDB:', err.message);
        process.exit(1);
    });