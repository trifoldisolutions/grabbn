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
import { buildExploreScores } from './server/jobs/buildExploreScores.js';
import { FILTER_PUBLIC } from './server/utils/filters.js';
import { validateLinks } from './server/utils/urlSafety.js';
import bucketShareRouter from './server/routes/bucketShare.js';
import authRouter from './server/routes/auth.js';
import creditsRouter, { handleWebhook } from './server/routes/credits.js';
import connectRouter, { handleConnectWebhook } from './server/routes/stripeConnect.js';
import notificationsRouter from './server/routes/notifications.js';
import bucketCommentsRouter from './server/routes/bucketComments.js';
import dmRouter from './server/routes/dm.js';
import blockRouter from './server/routes/block.js';
import adminRouter     from './server/routes/admin.js';
import adminAuthRouter from './server/routes/admin/auth.js';
import { adminSessionAuth, requireAdminSession } from './server/middleware/adminSessionAuth.js';
import Notification from './server/models/notification.js';
import Block from './server/models/block.js';
import Conversation from './server/models/conversation.js';
import DirectMessage from './server/models/directMessage.js';
import BucketComment from './server/models/bucketComment.js';
import BucketView from './server/models/bucketView.js';
import BucketShare from './server/models/bucketShare.js';
import FeedImpression from './server/models/feedImpression.js';
import TopicScore from './server/models/topicScore.js';
import BucketSkip   from './server/models/bucketSkip.js';
import RepoSkip     from './server/models/repoSkip.js';
import ShareVisit   from './server/models/shareVisit.js';
import BucketRating from './server/models/bucketRating.js';
import UserRepo     from './server/models/userRepo.js';
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

    const isFirstTab = !wsClients.has(userId);
    if (!wsClients.has(userId)) wsClients.set(userId, new Set());
    wsClients.get(userId).add(ws);

    // Notify conversation partners that this user just came online (first tab only)
    if (isFirstTab) {
        Conversation.find({ participants: userId }).select('participants').lean()
            .then(convs => {
                const partners = [...new Set(
                    convs.flatMap(c => c.participants.map(String).filter(id => id !== userId))
                )];
                for (const partnerId of partners) {
                    pushNotification(partnerId, { type: 'user_online', userId });
                }
            }).catch(() => {});
    }

    ws.on('close', () => {
        const set = wsClients.get(userId);
        if (set) {
            set.delete(ws);
            if (!set.size) {
                wsClients.delete(userId);
                // Stamp lastActive so "last seen" is accurate
                const lastSeenAt = new Date();
                User.findByIdAndUpdate(userId, { lastActive: lastSeenAt }, { timestamps: false }).catch(() => {});
                // Notify conversation partners that this user went offline
                Conversation.find({ participants: userId }).select('participants').lean()
                    .then(convs => {
                        const partners = [...new Set(
                            convs.flatMap(c => c.participants.map(String).filter(id => id !== userId))
                        )];
                        for (const partnerId of partners) {
                            pushNotification(partnerId, { type: 'user_offline', userId, lastSeenAt: lastSeenAt.toISOString() });
                        }
                    }).catch(() => {});
            }
        }
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
app.use('/api/admin/auth', adminAuthRouter); // must be before adminRouter (no session guard)
app.use('/api/admin', adminRouter);
app.use('/api/credits', creditsRouter);
app.use('/api/connect', connectRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/buckets/:id/comments', bucketCommentsRouter);
app.use('/api/dm', dmRouter);
app.use('/api/users', blockRouter);

// Online presence — checks wsClients for an active connection
app.get('/api/users/:userId/online-status', anonymousAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        const connections = wsClients.get(String(userId));
        const online = !!(connections && connections.size > 0);
        let lastSeenAt = null;
        if (!online) {
            const u = await User.findById(userId).select('lastActive').lean();
            lastSeenAt = u?.lastActive ?? null;
        }
        return res.json({ online, lastSeenAt });
    } catch (err) {
        console.error('[online-status]', err);
        res.json({ online: false, lastSeenAt: null });
    }
});

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
        res.redirect('/showroom');
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

// ── GET /api/buckets/mine ─────────────────────────────────────────────────────
// Returns the current user's buckets with enough info to render the clone modal.
app.get('/api/buckets/mine', requireAuth, requireVerification, async (req, res) => {
    try {
        const buckets = await Bucket.find({ userId: req.user._id })
            .select('name thumbnail links')
            .sort({ order: 1, createdAt: 1 })
            .lean();

        res.json(buckets.map(b => ({
            name:      b.name,
            thumbnail: b.thumbnail || null,
            linkCount: (b.links || []).length,
        })));
    } catch (err) {
        console.error('Error fetching user buckets:', err);
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
        const { name, description, tags, visibility, monetized, price, mature, sourceUrl, thumbnail, links, draft, repoId } = req.body;

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

        if (Array.isArray(links) && links.length > 0) {
            if (links.length > 256) return res.status(400).json({ error: 'A bucket cannot have more than 256 links' });
            const urls = links.map(l => l.url || '');
            const { ok, blocked } = await validateLinks(urls);
            if (!ok) return res.status(400).json({ error: 'One or more links were rejected for safety reasons', blocked });
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

        // Validate repoId belongs to this user
        let resolvedRepoId = null;
        if (repoId) {
            const repo = await UserRepo.findOne({ _id: repoId, userId: req.user._id });
            if (repo) resolvedRepoId = repo._id;
        }

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
            repoId:      resolvedRepoId,
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

        const existing = await Bucket.findOne({ userId: req.user._id, name: oldName });
        if (!existing) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        existing.name = newName;
        await existing.save();

        res.json({ name: existing.name });
    } catch (error) {
        console.error('Error updating bucket:', error);
        res.status(500).json({ error: 'Failed to update bucket' });
    }
});

// Full bucket update (used by profile edit modal)
app.patch('/api/buckets/:id/full', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name, description, tags, visibility, monetized, price, mature, sourceUrl, thumbnail, links, isDraft, repoId } = req.body;

        // Fetch current state to detect meaningful changes before building the update
        const current = await Bucket.findOne({ _id: req.params.id, userId: req.user._id });
        if (!current) return res.status(404).json({ error: 'Bucket not found' });

        const update = {};
        if (name        !== undefined) update.name        = name;
        if (description !== undefined) update.description = String(description || '').slice(0, 256);
        if (tags        !== undefined) update.hashtags    = Array.isArray(tags) ? tags.slice(0, 8) : [];
        if (mature      !== undefined) update.mature      = !!mature;
        if (repoId !== undefined) {
            if (!repoId) {
                update.repoId = null;
            } else {
                const repo = await UserRepo.findOne({ _id: repoId, userId: req.user._id });
                update.repoId = repo ? repo._id : null;
            }
        }
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
            if (links.length > 256) return res.status(400).json({ error: 'A bucket cannot have more than 256 links' });
            if (links.length > 0) {
                const urls = links.map(l => l.url || '');
                const { ok, blocked } = await validateLinks(urls);
                if (!ok) return res.status(400).json({ error: 'One or more links were rejected for safety reasons', blocked });
            }
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

        // Track real content changes (new links, link hrefs changed) as meaningful activity
        // so the explore score activity decay uses an honest signal rather than any edit.
        if (notifyGrabbers) update.lastMeaningfulActivityAt = new Date();

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

// ── User Repos ────────────────────────────────────────────────────────────────

// List all repos for the current user (with per-repo bucket counts + first thumbnail)
app.get('/api/repos', requireAuth, async (req, res) => {
    try {
        const [repos, counts, thumbs] = await Promise.all([
            UserRepo.find({ userId: req.user._id }).sort({ name: 1 }).lean(),
            Bucket.aggregate([
                { $match: { userId: req.user._id, repoId: { $ne: null } } },
                { $group: { _id: '$repoId', count: { $sum: 1 } } },
            ]),
            // First non-empty thumbnail per repo (oldest bucket first)
            Bucket.aggregate([
                { $match: { userId: req.user._id, repoId: { $ne: null }, thumbnail: { $nin: [null, ''] } } },
                { $sort: { createdAt: 1 } },
                { $group: { _id: '$repoId', thumb: { $first: '$thumbnail' } } },
            ]),
        ]);
        const countMap = Object.fromEntries(counts.map(c => [c._id.toString(), c.count]));
        const thumbMap = Object.fromEntries(thumbs.map(t => [t._id.toString(), t.thumb]));
        res.json(repos.map(r => ({
            ...r,
            bucketCount: countMap[r._id.toString()] ?? 0,
            thumb:       thumbMap[r._id.toString()] ?? null,
        })));
    } catch (err) {
        console.error('Error fetching repos:', err);
        res.status(500).json({ error: 'Failed to fetch repos' });
    }
});

// Create a new repo
app.post('/api/repos', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Repo name is required' });
        }
        const trimmed = name.trim().slice(0, 80);
        const existing = await UserRepo.findOne({ userId: req.user._id, name: trimmed });
        if (existing) return res.status(409).json({ error: 'You already have a repo with that name' });
        const repo = await UserRepo.create({
            userId:      req.user._id,
            name:        trimmed,
            description: String(description || '').slice(0, 256),
        });
        res.status(201).json(repo);
    } catch (err) {
        console.error('Error creating repo:', err);
        res.status(500).json({ error: 'Failed to create repo' });
    }
});

// Rename / update a repo
app.patch('/api/repos/:id', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name, description } = req.body;
        const update = {};
        if (name !== undefined) {
            const trimmed = String(name).trim().slice(0, 80);
            if (!trimmed) return res.status(400).json({ error: 'Repo name cannot be empty' });
            const conflict = await UserRepo.findOne({ userId: req.user._id, name: trimmed, _id: { $ne: req.params.id } });
            if (conflict) return res.status(409).json({ error: 'You already have a repo with that name' });
            update.name = trimmed;
        }
        if (description !== undefined) update.description = String(description).slice(0, 256);
        const repo = await UserRepo.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id },
            update,
            { new: true }
        );
        if (!repo) return res.status(404).json({ error: 'Repo not found' });
        res.json(repo);
    } catch (err) {
        console.error('Error updating repo:', err);
        res.status(500).json({ error: 'Failed to update repo' });
    }
});

// Delete a repo — its buckets are unassigned, not deleted
app.delete('/api/repos/:id', requireAuth, async (req, res) => {
    try {
        const repo = await UserRepo.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
        if (!repo) return res.status(404).json({ error: 'Repo not found' });
        await Bucket.updateMany({ userId: req.user._id, repoId: req.params.id }, { $unset: { repoId: 1 } });
        res.json({ ok: true });
    } catch (err) {
        console.error('Error deleting repo:', err);
        res.status(500).json({ error: 'Failed to delete repo' });
    }
});

// ── Bucket helpers ────────────────────────────────────────────────────────────

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
        await bucket.save({ timestamps: false });

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

        res.json({
            name: bucket.name,
            visibility: bucketVisibility(bucket),
            isPublic: bucket.isPublic,
            isPaywalled: bucket.isPaywalled || false,
            price: bucket.price || 0,
            createdAt: bucket.createdAt,
            updatedAt: bucket.updatedAt,
            linkCount: bucket.links.length,
            grabCount: bucket.grabbedBy?.length ?? 0,
            viewCount: bucket.viewCount || 0,
            shareCount: bucket.shareCount || 0,
            curator: {
                username: bucket.userId.username,
                userId: bucket.userId.anonymousId
            },
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
app.get('/api/buckets/snapshots', anonymousAuth, async (req, res) => {
    try {
        const ids = (req.query.ids || '').split(',')
            .map(s => s.trim())
            .filter(id => mongoose.Types.ObjectId.isValid(id))
            .slice(0, 50); // cap to avoid abuse
        if (!ids.length) return res.json({});
        const buckets = await Bucket.find({ _id: { $in: ids } })
            .select('name ratingSum ratingCount grabbedBy')
            .lean();
        const result = {};
        for (const b of buckets) {
            const ratingAvg = b.ratingCount > 0
                ? Math.round((b.ratingSum / b.ratingCount) * 10) / 10
                : null;
            result[String(b._id)] = {
                name:      b.name,
                ratingAvg,
                grabCount: b.grabbedBy?.length ?? 0,
            };
        }
        return res.json(result);
    } catch (err) {
        console.error('[snapshots]', err);
        res.status(500).json({ error: 'Failed' });
    }
});

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

        const grabCounts = buckets.map(bucket => bucket.grabbedBy?.length ?? 0);

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
                isOwner
            };
        }));

        res.json({ hasMore, buckets: formattedBuckets });
    } catch (error) {
        console.error('Error looking up bucket:', error);
        res.status(500).json({ error: 'Failed to lookup bucket' });
    }
});

// Save a bucket to the current user's grabbed collection
app.post('/api/buckets/grab', requireAuth, requireVerification, async (req, res) => {
    try {
        const { sourceBucketId } = req.body;

        if (!sourceBucketId) {
            return res.status(400).json({ error: 'sourceBucketId is required' });
        }

        const bucket = await Bucket.findById(sourceBucketId).select('+topic').populate('userId', 'username anonymousId');
        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        // Only public buckets can be grabbed
        if (bucketVisibility(bucket) !== 'public') {
            return res.status(403).json({ error: 'Only public buckets can be grabbed' });
        }

        // Paywalled buckets require the user to have unlocked them first
        if (bucket.isPaywalled) {
            const isOwner = bucket.userId._id.equals(req.user._id);
            if (!isOwner) {
                const access = await BucketAccess.findOne({ userId: req.user._id, bucketId: bucket._id });
                if (!access) {
                    return res.status(403).json({ error: 'Unlock this bucket before grabbing it' });
                }
            }
        }

        // Check if already grabbed
        const alreadyGrabbed = bucket.grabbedBy?.some(g => g.userId.toString() === req.user._id.toString());
        if (alreadyGrabbed) {
            return res.status(409).json({ error: 'You already have this bucket in your collection' });
        }

        await Bucket.findByIdAndUpdate(bucket._id, {
            $push: { grabbedBy: { userId: req.user._id, username: req.user.username || '', avatar: req.user.avatar || '', grabbedAt: new Date() } }
        }, { timestamps: false });

        addGuestPoints(req.user, bucket.topic ?? null, GUEST_PTS.grab);

        // Notify the curator (skip self-grabs)
        if (!bucket.userId._id.equals(req.user._id)) {
            Notification.create({
                userId: bucket.userId._id,
                type: 'bucket_grabbed',
                data: {
                    grabberId:       req.user._id,
                    grabberUsername: req.user.username || '',
                    bucketId:        bucket._id,
                    bucketName:      bucket.name,
                },
            }).then(n => pushNotification(bucket.userId._id, { type: 'new_notification', notification: n }))
              .catch(err => console.error('[notif] bucket_grabbed:', err));
        }

        res.status(201).json({ bucket: { _id: bucket._id, name: bucket.name } });
    } catch (error) {
        console.error('Error grabbing bucket:', error);
        res.status(500).json({ error: 'Failed to grab bucket' });
    }
});

// Remove a bucket from the current user's grabbed collection
app.delete('/api/buckets/grab/:sourceBucketId', requireAuth, requireVerification, async (req, res) => {
    try {
        const { sourceBucketId } = req.params;

        await Bucket.findByIdAndUpdate(sourceBucketId, {
            $pull: { grabbedBy: { userId: req.user._id } }
        }, { timestamps: false });

        res.json({ success: true });
    } catch (error) {
        console.error('Error ungrabbing bucket:', error);
        res.status(500).json({ error: 'Failed to ungrab bucket' });
    }
});

// Increment viewCount (and directViewCount when source !== 'explore') for a bucket,
// deduplicating permanently by userId (logged-in) or IP (anon).
// isOwner check must be done by the caller before invoking this.
async function trackBucketView(bucketId, userId, ip, source) {
    const isExplore = source === 'explore';
    const inc = isExplore ? { viewCount: 1 } : { viewCount: 1, directViewCount: 1 };
    if (userId) {
        const exists = await BucketView.exists({ bucketId, userId });
        if (!exists) {
            await BucketView.create({ bucketId, userId, ip: null });
            await Bucket.findByIdAndUpdate(bucketId, { $inc: inc }, { timestamps: false });
        }
    } else {
        const exists = await BucketView.exists({ bucketId, ip });
        if (!exists) {
            await BucketView.create({ bucketId, userId: null, ip });
            await Bucket.findByIdAndUpdate(bucketId, { $inc: inc }, { timestamps: false });
        }
    }
}

// Record a view for a bucket
app.post('/api/buckets/:id/view', requireAuth, requireVerification, async (req, res) => {
    try {
        const bucket = await Bucket.findById(req.params.id).select('_id userId topic').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        if (!bucket.userId.equals(req.user._id)) {
            await trackBucketView(bucket._id, req.user._id, null);
            addGuestPoints(req.user, bucket.topic ?? null, GUEST_PTS.pageVisit);
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
        const bucket = await Bucket.findById(req.params.id).select('_id userId topic').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        if (bucket.userId.equals(req.user._id)) {
            return res.json({ success: true }); // owner sharing their own bucket doesn't count
        }

        try {
            await BucketShare.create({ bucketId: bucket._id, userId: req.user._id });
            await Bucket.findByIdAndUpdate(bucket._id, { $inc: { shareCount: 1 } }, { timestamps: false });
            addGuestPoints(req.user, bucket.topic ?? null, GUEST_PTS.share);
        } catch (err) {
            if (err.code !== 11000) throw err; // 11000 = duplicate key — user already shared, skip silently
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error recording share:', error);
        res.status(500).json({ error: 'Failed to record share' });
    }
});

// Not interested in a bucket.
// Tracks per-user skips (for feed filtering) and increments skipCount (for score penalty).
// Trust & safety categories also file a soft report in the background.
app.post('/api/buckets/:id/not-interested', async (req, res) => {
    try {
        const { category, reason } = req.body;

        const validCategories = ['not-relevant', 'low-quality', 'trust-safety', 'already-in-feed'];
        if (!category || !validCategories.includes(category)) {
            return res.status(400).json({ error: 'Invalid category' });
        }

        const bucket = await Bucket.findById(req.params.id).select('_id userId').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        const userId = (req.user && !req.user.isAnonymous) ? req.user._id : null;
        const ip     = req.ip;

        // Deduplicate: one skip per user/IP per bucket
        const existingSkip = userId
            ? await BucketSkip.exists({ bucketId: bucket._id, userId })
            : await BucketSkip.exists({ bucketId: bucket._id, ip });

        if (!existingSkip) {
            await BucketSkip.create({ bucketId: bucket._id, userId, ip: userId ? null : ip, category, reason: reason || null });
            await Bucket.findByIdAndUpdate(bucket._id, { $inc: { skipCount: 1 } }, { timestamps: false });
        }

        // Trust & safety reasons also file a soft report (fire-and-forget)
        if (category === 'trust-safety' && userId) {
            const reportReason = reason === 'spam' ? 'spam' : 'inappropriate';
            Report.create({ bucketId: bucket._id, userId, reason: reportReason, detail: `via not-interested: ${reason || ''}` }).catch(() => {});
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error recording not-interested:', error);
        res.status(500).json({ error: 'Failed to record' });
    }
});

// Rate a bucket (1–3 stars)
// Gate: user must have grabbed the bucket AND clicked at least 2 links from it.
app.post('/api/buckets/:bucketId/rate', requireAuth, requireVerification, async (req, res) => {
    try {
        const { bucketId } = req.params;
        const stars = Number(req.body.stars);

        if (![1, 2, 3].includes(stars)) {
            return res.status(400).json({ error: 'stars must be 1, 2, or 3' });
        }

        // Must have grabbed the bucket
        const ratedBucket = await Bucket.findById(bucketId).select('grabbedBy').lean();
        const grabbed = ratedBucket?.grabbedBy?.some(g => g.userId.toString() === req.user._id.toString());
        if (!grabbed) {
            return res.status(403).json({ error: 'Grab this bucket before rating it' });
        }

        // Must have clicked at least 2 links from it
        const clickCount = await LinkClick.countDocuments({ bucketId, userId: req.user._id });
        if (clickCount < 2) {
            return res.status(403).json({ error: 'Explore at least 2 links before rating' });
        }

        // Upsert: adjust ratingSum by the delta if re-rating
        const existing = await BucketRating.findOne({ bucketId, userId: req.user._id }).select('stars').lean();
        if (existing) {
            const delta = stars - existing.stars;
            await Promise.all([
                BucketRating.updateOne({ bucketId, userId: req.user._id }, { $set: { stars } }),
                Bucket.findByIdAndUpdate(bucketId, { $inc: { ratingSum: delta } }, { timestamps: false })
            ]);
        } else {
            await Promise.all([
                BucketRating.create({ bucketId, userId: req.user._id, stars }),
                Bucket.findByIdAndUpdate(bucketId, { $inc: { ratingSum: stars, ratingCount: 1 } }, { timestamps: false })
            ]);
        }

        res.json({ ok: true, stars });
    } catch (err) {
        console.error('Error rating bucket:', err);
        res.status(500).json({ error: 'Failed to save rating' });
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

        const { ok, blocked } = await validateLinks(links.map(l => l.href || ''));
        if (!ok) return res.status(400).json({ error: 'One or more links were rejected for safety reasons', blocked });

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
            if (newLinks.length > 0) {
                if (bucket.links.length + newLinks.length > 256) {
                    results.push({ bucket: bucketName, error: 'Bucket is at the 256-link limit' });
                    continue;
                }
                bucket.links.push(...newLinks);
                bucket.lastMeaningfulActivityAt = new Date();
            }

            // Auto-set bucket thumbnail from first link image if not already set
            if (!bucket.thumbnail) {
                const firstWithImage = bucket.links.find(l => l.image);
                if (firstWithImage) bucket.thumbnail = firstWithImage.image;
            }

            // Update sourceUrl if provided
            if (links[0]?.sourceUrl && !bucket.sourceUrl) {
                bucket.sourceUrl = links[0].sourceUrl;
            }

            await bucket.save({ timestamps: newLinks.length > 0 });
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

        const [, bucket] = await Promise.all([
            LinkClick.create({ href, domain, bucketId, userId: req.user?._id ?? null }),
            Bucket.findOneAndUpdate(
                { _id: bucketId, 'links.href': href },
                { $inc: { 'links.$.clickCount': 1 } },
                { timestamps: false, new: false, select: 'topic' }
            ),
        ]);

        addGuestPoints(req.user, bucket?.topic ?? null, GUEST_PTS.linkClick);
    } catch (err) {
        console.error('LinkClick record error:', err);
    }
});

// ---------------------------------------------------------------------------
// Guest session point tracking
// ---------------------------------------------------------------------------
// Point weights
const GUEST_PTS = { grab: 4, share: 5, pageVisit: 1, linkClick: 0.5 };
const WARM_THRESHOLD    = 10;   // points needed to transition to warm start
const ACTIVE_CAP_MIN    = 360;  // 6 hours of combined active time — reset if exceeded without warmth
const IDLE_CUTOFF_MIN   = 30;   // gaps longer than this aren't counted as active time

/**
 * Fire-and-forget — update a user's guest recommendation session after any engagement event.
 * @param {Object} user     - req.user (may be anonymous or registered)
 * @param {string} topic    - domain topic of the bucket they engaged with (may be null)
 * @param {number} pts      - point weight for this action
 */
async function addGuestPoints(user, topic, pts) {
    if (!user?._id) return;
    try {
        const now  = new Date();
        const u    = await User.findById(user._id).select('guestSession').lean();
        if (!u) return;

        const gs = u.guestSession || {};

        // Compute elapsed active time since last event (ignore idle gaps > IDLE_CUTOFF_MIN)
        let deltaMinutes = 0;
        if (gs.lastActiveAt) {
            const idleMinutes = (now - new Date(gs.lastActiveAt)) / 60000;
            if (idleMinutes < IDLE_CUTOFF_MIN) deltaMinutes = idleMinutes;
        }

        const newPoints       = (gs.points       || 0) + pts;
        const newActiveMinutes = (gs.activeMinutes || 0) + deltaMinutes;

        // If the 6h active budget is exhausted without reaching warm, reset the session
        if (!gs.warmStart && newActiveMinutes > ACTIVE_CAP_MIN && newPoints < WARM_THRESHOLD) {
            await User.updateOne({ _id: user._id }, {
                $set: {
                    'guestSession.points':           0,
                    'guestSession.activeMinutes':    0,
                    'guestSession.topicEngagements': [],
                    'guestSession.inferredTopic':    null,
                    'guestSession.lastActiveAt':     now,
                    'guestSession.warmStart':        false
                }
            });
            return;
        }

        // Update per-topic engagement tally
        const engagements = [...(gs.topicEngagements || [])];
        if (topic) {
            const entry = engagements.find(e => e.domain === topic);
            if (entry) entry.pts += pts;
            else engagements.push({ domain: topic, pts });
        }

        // inferredTopic = domain with most accumulated pts
        const inferredTopic = engagements.length
            ? engagements.reduce((best, e) => e.pts > best.pts ? e : best).domain
            : (gs.inferredTopic || null);

        const warmStart = gs.warmStart || newPoints >= WARM_THRESHOLD;

        await User.updateOne({ _id: user._id }, {
            $set: {
                'guestSession.points':           newPoints,
                'guestSession.activeMinutes':    newActiveMinutes,
                'guestSession.topicEngagements': engagements,
                'guestSession.inferredTopic':    inferredTopic,
                'guestSession.lastActiveAt':     now,
                'guestSession.warmStart':        warmStart
            }
        });
    } catch (err) {
        console.error('[guestSession] update error:', err);
    }
}

// ---------------------------------------------------------------------------
// V2 API — showroom feed (personalized for logged-in users, public fallback)
// ---------------------------------------------------------------------------
app.get('/api/showroom', anonymousAuth, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip  = (page - 1) * limit;

        let buckets;
        let isPersonalized = false;

        if (req.user?._id && !req.user.isAnonymous) {
            // Resolve followed curator IDs
            const subs = await Subscription.find({ followerId: req.user._id }).select('followeeId').lean();
            const followedIds = subs.map(s => s.followeeId);

            // Find grabbed buckets and when the user grabbed them, to surface updates since then
            const grabbedBuckets = await Bucket.find({
                'grabbedBy.userId': req.user._id
            }).select('_id grabbedBy').lean();
            // Only surface a grabbed bucket if it was updated after the user grabbed it
            const updatedGrabbedConditions = grabbedBuckets.map(b => {
                const entry = b.grabbedBy.find(g => g.userId.toString() === req.user._id.toString());
                return { _id: b._id, updatedAt: { $gt: entry?.grabbedAt || new Date(0) } };
            });

            if (followedIds.length > 0 || updatedGrabbedConditions.length > 0) {
                isPersonalized = true;
                const orClauses = [];
                if (followedIds.length > 0)              orClauses.push({ userId: { $in: followedIds } });
                if (updatedGrabbedConditions.length > 0) orClauses.push(...updatedGrabbedConditions);
                buckets = await Bucket.find({
                    $or: orClauses,
                    ...FILTER_PUBLIC,
                    isDraft: { $ne: true },
                    name:    { $ne: 'Singletons' }
                })
                    .sort({ updatedAt: -1 })
                    .skip(skip)
                    .limit(limit + 1)
                    .populate('userId', 'username anonymousId avatar')
                    .select('name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags');
            }
        }

        // Topic-based feed for anonymous/guest users
        if (!isPersonalized && req.user?.isAnonymous) {
            isPersonalized = true;
            const gs            = req.user.guestSession || {};
            const BUCKET_SELECT = 'name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags topic';
            const BASE_FILTER   = { ...FILTER_PUBLIC, isDraft: { $ne: true }, name: { $ne: 'Singletons' } };

            if (gs.warmStart && gs.inferredTopic) {
                // Warm start — user has revealed a topic preference.
                // Reserve 1 slot per page for a discovery bucket from the second-best topic.
                const mainLimit = limit - 1;
                const secondTopic = await TopicScore.findOne({ domain: { $ne: gs.inferredTopic } })
                    .sort({ score: -1 }).lean();

                const [mainBuckets, discoveryBucket] = await Promise.all([
                    Bucket.find({ topic: gs.inferredTopic, ...BASE_FILTER })
                        .sort({ exploreScore: -1 })
                        .skip(skip)
                        .limit(mainLimit + 1)
                        .populate('userId', 'username anonymousId avatar')
                        .select(BUCKET_SELECT),
                    secondTopic
                        ? Bucket.findOne({ topic: secondTopic.domain, ...BASE_FILTER })
                            .sort({ exploreScore: -1 })
                            .skip(skip % 10) // gentle variety across pages
                            .populate('userId', 'username anonymousId avatar')
                            .select(BUCKET_SELECT)
                        : Promise.resolve(null)
                ]);

                const hasMoreMain = mainBuckets.length > mainLimit;
                const mainItems   = hasMoreMain ? mainBuckets.slice(0, mainLimit) : mainBuckets;
                buckets = discoveryBucket ? [...mainItems, discoveryBucket] : mainItems;
                // Reuse hasMore from main stream
                buckets._hasMore = hasMoreMain;
            } else {
                // Cold start — show the best performing topic this week
                const bestTopic = await TopicScore.findOne({ bucketCount: { $gte: 3 } })
                    .sort({ score: -1 }).lean();

                if (bestTopic) {
                    buckets = await Bucket.find({ topic: bestTopic.domain, ...BASE_FILTER })
                        .sort({ exploreScore: -1 })
                        .skip(skip)
                        .limit(limit + 1)
                        .populate('userId', 'username anonymousId avatar')
                        .select(BUCKET_SELECT);
                }

                // Fallback if no topic scores exist yet — sort by exploreScore globally
                if (!buckets || buckets.length === 0) {
                    buckets = await Bucket.find(BASE_FILTER)
                        .sort({ exploreScore: -1 })
                        .skip(skip)
                        .limit(limit + 1)
                        .populate('userId', 'username anonymousId avatar')
                        .select(BUCKET_SELECT);
                }
            }
        }

        // Fallback for logged-in users with no follows/grabs yet
        if (!isPersonalized) {
            buckets = await Bucket.find({ ...FILTER_PUBLIC, isDraft: { $ne: true }, name: { $ne: 'Singletons' } })
                .sort({ exploreScore: -1 })
                .skip(skip)
                .limit(limit + 1)
                .populate('userId', 'username anonymousId avatar')
                .select('name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags');
        }

        // Warm-start path sets _hasMore on the array itself to avoid over-slicing
        // the mixed main+discovery result. All other paths use the +1 sentinel trick.
        const hasMore = buckets._hasMore ?? (buckets.length > limit);
        const items   = buckets._hasMore  ? buckets : (hasMore ? buckets.slice(0, limit) : buckets);

        // Build grabbed set for current user
        let grabbedSet = new Set();
        if (req.user?._id && !req.user.isAnonymous) {
            const grabs = await Bucket.find({
                _id:               { $in: items.map(b => b._id) },
                'grabbedBy.userId': req.user._id
            }).select('_id').lean();
            grabs.forEach(g => grabbedSet.add(String(g._id)));
        }

        // Build follow set for current user
        const curatorIds = [...new Set(items.map(b => b.userId?._id).filter(Boolean))];
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
                _id:         b._id,
                name:        b.name,
                thumbnail:   b.thumbnail || b.links.find(l => l.image)?.image || '',
                linkCount:   b.links.length,
                isPaywalled: b.isPaywalled || false,
                price:       b.price || 0,
                viewCount:   b.viewCount   || 0,
                shareCount:  b.shareCount  || 0,
                ratingSum:   b.ratingSum   || 0,
                ratingCount: b.ratingCount || 0,
                createdAt:   b.createdAt,
                updatedAt:   b.updatedAt,
                description: b.description || '',
                hashtags:    b.hashtags    || [],
                isGrabbed:   grabbedSet.has(String(b._id)),
                grabCount:   (b.grabbedBy || []).length,
                grabbers:    (b.grabbedBy || [])
                    .slice(-4)
                    .map(g => ({ username: g.username || '?', avatar: g.avatar || '' })),
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

// ---------------------------------------------------------------------------
// V2 API — explore feed (scored + personalized, paginated)
// ---------------------------------------------------------------------------
app.get('/api/explore', anonymousAuth, async (req, res) => {
    try {
        const limit      = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip       = Math.max(0, parseInt(req.query.skip)  || 0);
        const excludeIds = (req.query.excludeIds || '').split(',').filter(Boolean).slice(0, 200);

        // Phase 1: fetch candidates sorted by pre-computed exploreScore
        const candidates = await Bucket.find({
            ...FILTER_PUBLIC,
            isDraft:     { $ne: true },
            isPaywalled: { $ne: true },
            name:        { $ne: 'Singletons' },
            thumbnail:   { $exists: true, $ne: '' }
        })
            .sort({ exploreScore: -1 })
            .skip(skip)
            .limit(limit * 5)
            .populate('userId', 'username anonymousId avatar')
            .select('name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags exploreScore')
            .lean();

        // Phase 2: filter out buckets already shown to this user in the last 2h,
        // and buckets the user has explicitly skipped (never show again).
        const impressionFilter = req.user?._id
            ? { userId: req.user._id }
            : req.user?.anonymousId
                ? { anonymousId: req.user.anonymousId }
                : null;

        const clientExcluded = new Set(excludeIds.map(String));

        let unseenCandidates = candidates;
        if (impressionFilter) {
            const [seen, skipped] = await Promise.all([
                FeedImpression.find(impressionFilter).select('bucketId').lean(),
                req.user?._id
                    ? BucketSkip.find({ userId: req.user._id }).select('bucketId').lean()
                    : Promise.resolve([])
            ]);
            const seenIds    = new Set(seen.map(i => String(i.bucketId)));
            const skippedIds = new Set(skipped.map(s => String(s.bucketId)));
            unseenCandidates = candidates.filter(b =>
                !seenIds.has(String(b._id)) && !skippedIds.has(String(b._id)) && !clientExcluded.has(String(b._id))
            );
        } else if (clientExcluded.size) {
            unseenCandidates = candidates.filter(b => !clientExcluded.has(String(b._id)));
        }

        // Phase 3: personalize for authenticated non-anonymous users
        let scored = unseenCandidates;

        if (req.user?._id && !req.user.isAnonymous) {
            // Signal A: hashtag overlap with grabbed buckets
            const grabbedBuckets = await Bucket.find({
                'grabbedBy.userId': req.user._id
            }).select('hashtags').lean();
            const userHashtags = new Set(grabbedBuckets.flatMap(b => b.hashtags || []));

            // Signal B: domain affinity — domains clicked in the last 30 days
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const domainClicks = await LinkClick.aggregate([
                { $match: { userId: req.user._id, createdAt: { $gte: thirtyDaysAgo } } },
                { $group: { _id: '$domain', clicks: { $sum: 1 } } }
            ]);
            const domainAffinityMap = Object.fromEntries(domainClicks.map(d => [d._id, d.clicks]));

            // Signal C: social proximity — followed curator IDs
            const subs = await Subscription.find({ followerId: req.user._id }).select('followeeId').lean();
            const followedIds = new Set(subs.map(s => String(s.followeeId)));

            scored = candidates.map(b => {
                let score = b.exploreScore || 0;

                // Signal A: hashtag overlap ×1.5 per matching tag
                const tagOverlap = (b.hashtags || []).filter(t => userHashtags.has(t)).length;
                score *= 1 + (tagOverlap * 0.5);

                // Signal B: domain affinity +0.4 per recent click on matching domain
                const bucketDomains = (b.links || []).map(l => {
                    try { return new URL(l.href).hostname; } catch { return null; }
                }).filter(Boolean);
                const affinityBoost = bucketDomains.reduce((acc, d) => acc + (domainAffinityMap[d] || 0) * 0.4, 0);
                score += affinityBoost;

                // Signal C: social proximity ×1.3 if grabbed by someone you follow
                const grabbedByFollowed = (b.grabbedBy || []).some(g => followedIds.has(String(g.userId)));
                if (grabbedByFollowed) score *= 1.3;

                return { ...b, _personalizedScore: score };
            });

            scored.sort((a, b) => (b._personalizedScore || 0) - (a._personalizedScore || 0));
        }

        // Phase 4: jitter — shift rankings between refreshes
        const JITTER = 0.35;
        scored = scored
            .map(b => ({
                ...b,
                _jitteredScore: (b._personalizedScore ?? b.exploreScore ?? 0) * (1 - JITTER + Math.random() * JITTER * 2)
            }))
            .sort((a, b) => b._jitteredScore - a._jitteredScore);

        // Phase 5: diversity caps — prevent feed from being dominated by one curator or topic
        const MAX_PER_CURATOR = 2;
        const MAX_PER_TOPIC   = 3;
        const curatorCount = {};
        const topicCount   = {};
        const diverse = [];
        for (const b of scored) {
            const curatorKey = String(b.userId?._id || b.userId);
            const topicKey   = b.topic || '__none__';
            if ((curatorCount[curatorKey] || 0) >= MAX_PER_CURATOR) continue;
            if (topicKey !== '__none__' && (topicCount[topicKey] || 0) >= MAX_PER_TOPIC) continue;
            diverse.push(b);
            curatorCount[curatorKey] = (curatorCount[curatorKey] || 0) + 1;
            topicCount[topicKey]     = (topicCount[topicKey]     || 0) + 1;
            if (diverse.length >= limit + 1) break;
        }

        const items   = diverse.slice(0, limit);
        const hasMore = diverse.length > limit;

        // Build grabbed set for current user
        let grabbedSet = new Set();
        if (req.user?._id && !req.user.isAnonymous) {
            const grabs = await Bucket.find({
                _id:               { $in: items.map(b => b._id) },
                'grabbedBy.userId': req.user._id
            }).select('_id').lean();
            grabs.forEach(g => grabbedSet.add(String(g._id)));
        }

        // Build follow set for current user
        const curatorIds = [...new Set(items.map(b => b.userId?._id).filter(Boolean))];
        let followedSet = new Set();
        if (req.user?._id && !req.user.isAnonymous) {
            const subs = await Subscription.find({
                followerId: req.user._id,
                followeeId: { $in: curatorIds }
            }).select('followeeId').lean();
            subs.forEach(s => followedSet.add(String(s.followeeId)));
        }

        // Bucket counts per curator
        const bucketCounts = await Bucket.aggregate([
            { $match: { userId: { $in: curatorIds }, ...FILTER_PUBLIC, name: { $ne: 'Singletons' } } },
            { $group: { _id: '$userId', count: { $sum: 1 } } }
        ]);
        const bucketCountMap = Object.fromEntries(bucketCounts.map(r => [String(r._id), r.count]));

        res.json({
            hasMore,
            buckets: items.map(b => ({
                _id:         b._id,
                name:        b.name,
                thumbnail:   b.thumbnail || (b.links || []).find(l => l.image)?.image || '',
                linkCount:   (b.links || []).length,
                isPaywalled: b.isPaywalled || false,
                price:       b.price || 0,
                viewCount:   b.viewCount   || 0,
                shareCount:  b.shareCount  || 0,
                ratingSum:   b.ratingSum   || 0,
                ratingCount: b.ratingCount || 0,
                createdAt:   b.createdAt,
                updatedAt:   b.updatedAt,
                description: b.description || '',
                hashtags:    b.hashtags    || [],
                isGrabbed:   grabbedSet.has(String(b._id)),
                grabCount:   (b.grabbedBy || []).length,
                grabbers:    (b.grabbedBy || [])
                    .slice(-4)
                    .map(g => ({ username: g.username || '?', avatar: g.avatar || '' })),
                curator: {
                    username:    b.userId?.username    || 'Unknown',
                    userId:      b.userId?.anonymousId || '',
                    avatar:      b.userId?.avatar      || '',
                    bucketCount: bucketCountMap[String(b.userId?._id)] || 0,
                    isFollowing: followedSet.has(String(b.userId?._id))
                }
            }))
        });

        // Record impressions for returned buckets (fire-and-forget, don't block response)
        if (impressionFilter && items.length) {
            const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours
            FeedImpression.insertMany(
                items.map(b => ({ ...impressionFilter, bucketId: b._id, expiresAt })),
                { ordered: false }
            ).catch(() => {}); // swallow errors — impressions are best-effort
        }
    } catch (err) {
        console.error('Explore feed error:', err);
        res.status(500).json({ error: 'Failed to load explore feed' });
    }
});

// ---------------------------------------------------------------------------
// V2 API — named explore rows (promoted / paywalled / new / revisit)
// ---------------------------------------------------------------------------

const EXPLORE_ROW_SELECT = 'name thumbnail links isPaywalled isPromoted price viewCount shareCount ratingSum ratingCount createdAt userId grabbedBy';

function parseExcludeIds(raw) {
    return (raw || '').split(',').filter(Boolean).slice(0, 200);
}

function formatExploreRow(buckets, grabbedSet) {
    return buckets.map(b => ({
        _id:         b._id,
        name:        b.name,
        thumbnail:   b.thumbnail || (b.links || []).find(l => l.image)?.image || '',
        linkCount:   (b.links || []).length,
        isPaywalled: b.isPaywalled || false,
        isPromoted:  b.isPromoted  || false,
        price:       b.price       || 0,
        viewCount:   b.viewCount   || 0,
        shareCount:  b.shareCount  || 0,
        ratingSum:   b.ratingSum   || 0,
        ratingCount: b.ratingCount || 0,
        isGrabbed:   grabbedSet.has(String(b._id)),
        grabCount:   (b.grabbedBy || []).length,
        grabbers:    (b.grabbedBy || []).slice(-4).map(g => ({ username: g.username || '?', avatar: g.avatar || '' })),
        curator: {
            username: b.userId?.username    || 'Unknown',
            userId:   b.userId?.anonymousId || '',
            avatar:   b.userId?.avatar      || '',
            bucketCount: 0,
            isFollowing: false
        }
    }));
}

async function buildGrabbedSet(buckets, userId) {
    if (!userId || !buckets.length) return new Set();
    const grabs = await Bucket.find({
        _id: { $in: buckets.map(b => b._id) },
        'grabbedBy.userId': userId
    }).select('_id').lean();
    return new Set(grabs.map(g => String(g._id)));
}

// Promoted row
app.get('/api/explore/promoted', anonymousAuth, async (req, res) => {
    try {
        const excludeIds = parseExcludeIds(req.query.excludeIds);
        const buckets = await Bucket.find({
            ...FILTER_PUBLIC,
            isPromoted: true,
            isDraft:    { $ne: true },
            thumbnail:  { $exists: true, $ne: '' },
            ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {})
        })
            .sort({ exploreScore: -1 })
            .limit(9)
            .populate('userId', 'username anonymousId avatar')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const grabbedSet = await buildGrabbedSet(buckets, req.user?._id);
        res.json({ buckets: formatExploreRow(buckets, grabbedSet) });
    } catch (err) {
        console.error('Explore promoted row error:', err);
        res.status(500).json({ error: 'Failed to load promoted row' });
    }
});

// Paywalled row — excludes promoted buckets to avoid overlap
app.get('/api/explore/paywalled', anonymousAuth, async (req, res) => {
    try {
        const excludeIds = parseExcludeIds(req.query.excludeIds);
        const buckets = await Bucket.find({
            ...FILTER_PUBLIC,
            isPaywalled: true,
            isPromoted:  { $ne: true },
            isDraft:     { $ne: true },
            thumbnail:   { $exists: true, $ne: '' },
            ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {})
        })
            .sort({ exploreScore: -1 })
            .limit(9)
            .populate('userId', 'username anonymousId avatar')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const grabbedSet = await buildGrabbedSet(buckets, req.user?._id);
        res.json({ buckets: formatExploreRow(buckets, grabbedSet) });
    } catch (err) {
        console.error('Explore paywalled row error:', err);
        res.status(500).json({ error: 'Failed to load paywalled row' });
    }
});

// New row — sorted by creation date
app.get('/api/explore/new', anonymousAuth, async (req, res) => {
    try {
        const excludeIds = parseExcludeIds(req.query.excludeIds);
        const buckets = await Bucket.find({
            ...FILTER_PUBLIC,
            isDraft:   { $ne: true },
            thumbnail: { $exists: true, $ne: '' },
            ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {})
        })
            .sort({ createdAt: -1 })
            .limit(9)
            .populate('userId', 'username anonymousId avatar')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const grabbedSet = await buildGrabbedSet(buckets, req.user?._id);
        res.json({ buckets: formatExploreRow(buckets, grabbedSet) });
    } catch (err) {
        console.error('Explore new row error:', err);
        res.status(500).json({ error: 'Failed to load new row' });
    }
});

// Revisit row — buckets the user viewed but never grabbed (logged-in only)
app.get('/api/explore/revisit', anonymousAuth, async (req, res) => {
    try {
        if (!req.user?._id || req.user.isAnonymous) return res.json({ buckets: [] });

        const excludeIds = parseExcludeIds(req.query.excludeIds);
        const views      = await BucketView.find({ userId: req.user._id }).select('bucketId').lean();
        const viewedIds  = views.map(v => v.bucketId);
        if (!viewedIds.length) return res.json({ buckets: [] });

        const buckets = await Bucket.find({
            ...FILTER_PUBLIC,
            _id:                { $in: viewedIds, ...(excludeIds.length ? { $nin: excludeIds } : {}) },
            'grabbedBy.userId': { $ne: req.user._id },
            isDraft:            { $ne: true },
            thumbnail:          { $exists: true, $ne: '' }
        })
            .sort({ exploreScore: -1 })
            .limit(9)
            .populate('userId', 'username anonymousId avatar')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const grabbedSet = await buildGrabbedSet(buckets, req.user._id);
        res.json({ buckets: formatExploreRow(buckets, grabbedSet) });
    } catch (err) {
        console.error('Explore revisit row error:', err);
        res.status(500).json({ error: 'Failed to load revisit row' });
    }
});

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

// Attach up to 4 bucket thumbnails to each repo for the 2x2 thumbnail grid
async function enrichReposWithBucketThumbnails(repos) {
    await Promise.all(repos.map(async repo => {
        const escapedDomain = repo.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const domainPattern = new RegExp(`^https?://(www\\.)?${escapedDomain}`, 'i');
        const buckets = await Bucket.find({
            hashtags:     repo.tag,
            visibility:   'public',
            isDraft:      false,
            'links.href': domainPattern
        })
        .sort({ exploreScore: -1 })
        .limit(4)
        .select('thumbnail links')
        .lean();
        repo.topBucketThumbnails = buckets
            .map(b => b.thumbnail || b.links.find(l => l.image)?.image || '')
            .filter(Boolean);
    }));
}

app.get('/api/repositories', anonymousAuth, async (req, res) => {
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
            const items   = hasMore ? page.slice(0, limit) : page;
            await enrichReposWithBucketThumbnails(items);
            return res.json({ hasMore, repositories: items });
        }

        // ── Logged-in users: personalised scoring ────────────────────────────
        const userId = req.user._id;
        const cutoff = new Date(Date.now() - 90 * 86_400_000); // 90-day window

        // Run all lookups in parallel
        const [domainClicks, subscriptions, userBuckets, skippedRepos] = await Promise.all([
            // Signal 1 — direct affinity: domains this user has clicked recently
            LinkClick.aggregate([
                { $match: { userId, createdAt: { $gte: cutoff } } },
                { $group: { _id: '$domain', count: { $sum: 1 } } }
            ]),
            // Signal 2 — subscription: curators this user follows
            Subscription.find({ followerId: userId }).select('followeeId').lean(),
            // Signal 3 — tag affinity: hashtags on the user's own public buckets
            Bucket.find({ userId, isDraft: false }).select('hashtags').lean(),
            // Signal 4 — skipped repos: never show these again
            RepoSkip.find({ userId }).select('domain tag').lean()
        ]);

        // domain → click count  (direct affinity map)
        const affinityMap   = Object.fromEntries(domainClicks.map(d => [d._id, d.count]));
        // set of subscribed curator _id strings (for O(1) lookup)
        const subscribedIds = new Set(subscriptions.map(s => String(s.followeeId)));
        // set of hashtags the user has used across their own buckets
        const userTags      = new Set(userBuckets.flatMap(b => b.hashtags || []));
        // set of "domain::tag" pairs the user dismissed
        const skippedKeys   = new Set(skippedRepos.map(s => `${s.domain}::${s.tag}`));

        // Score every non-skipped repo
        const hasPreferences = affinityMap.size > 0 || userTags.size > 0 || subscribedIds.size > 0;

        const relevant  = [];
        const popular   = [];

        for (const repo of allRepos) {
            if (skippedKeys.has(`${repo.domain}::${repo.tag}`)) continue;

            const affinityScore     = (affinityMap[repo.domain] || 0) * 3;
            const tagScore          = userTags.has(repo.tag) ? 4 : 0;
            const subLinkCount      = repo.topLinks.filter(
                l => l.curatorId && subscribedIds.has(String(l.curatorId))
            ).length;
            const subscriptionScore = subLinkCount * 5;
            const popularityScore   = Math.log(repo.totalClicks + 1) * 0.5;
            const totalScore        = affinityScore + tagScore + subscriptionScore + popularityScore;

            const scored = { ...repo, _score: totalScore };

            // If user has preferences, only show repos with at least one matching signal.
            // If no preferences yet, everything goes into "relevant" (sorted by popularity).
            if (!hasPreferences || affinityScore > 0 || tagScore > 0 || subscriptionScore > 0) {
                relevant.push(scored);
            } else {
                popular.push(scored);
            }
        }

        relevant.sort((a, b) => b._score - a._score);
        popular.sort((a, b) => b._score - a._score);

        // Merge: relevant first, then popular repos as padding
        const scored = [...relevant, ...popular];

        const page    = scored.slice(skip, skip + limit + 1);
        const hasMore = page.length > limit;
        const items   = (hasMore ? page.slice(0, limit) : page)
            .map(({ _score, ...repo }) => repo); // strip internal field before sending

        await enrichReposWithBucketThumbnails(items);
        res.json({ hasMore, repositories: items });
    } catch (err) {
        console.error('Repositories endpoint error:', err);
        res.status(500).json({ error: 'Failed to load repositories' });
    }
});

// ---------------------------------------------------------------------------
// V2 API — single repository detail by domain + tag
// ---------------------------------------------------------------------------
app.get('/api/repositories/:domain/:tag', anonymousAuth, async (req, res) => {
    try {
        const { domain, tag } = req.params;

        // Escape domain for use in a regex (dots etc.)
        const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const domainPattern = new RegExp(`^https?://(www\\.)?${escapedDomain}`, 'i');

        const [repo, topBuckets] = await Promise.all([
            Repository.findOne({ domain, tag }).lean(),
            // Buckets tagged with `tag` that contain at least one link from `domain`
            Bucket.find({
                hashtags:      tag,
                visibility:    'public',
                isDraft:       false,
                'links.href':  domainPattern
            })
            .sort({ exploreScore: -1 })
            .limit(12)
            .select('_id name description thumbnail links grabbedBy viewCount userId')
            .populate('userId', 'username avatar')
            .lean()
        ]);

        if (!repo)                       return res.status(404).json({ error: 'Repository not found' });
        if (topBuckets.length < 1)       return res.status(404).json({ error: 'Repository not found' });
        res.json({ ...repo, topBuckets });
    } catch (err) {
        console.error('Repository detail error:', err);
        res.status(500).json({ error: 'Failed to load repository' });
    }
});

// ---------------------------------------------------------------------------
// V2 API — mark a (domain, tag) repo as not interested
// ---------------------------------------------------------------------------
app.post('/api/repositories/:domain/:tag/not-interested', anonymousAuth, async (req, res) => {
    try {
        const { domain, tag } = req.params;
        const userId = req.user && !req.user.isAnonymous ? req.user._id : null;
        const ip     = userId ? null : (req.headers['x-forwarded-for'] || req.ip);

        await RepoSkip.updateOne(
            { domain, tag, ...(userId ? { userId } : { ip }) },
            { $setOnInsert: { domain, tag, userId, ip } },
            { upsert: true }
        );

        res.json({ ok: true });
    } catch (err) {
        console.error('Repo not-interested error:', err);
        res.status(500).json({ error: 'Failed to record skip' });
    }
});

// ---------------------------------------------------------------------------
// App routes — server-rendered with EJS
// ---------------------------------------------------------------------------
const appPages = [
    { path: '/showroom',       view: 'v2/showroom',        title: 'Show Room',       page: 'home'          },
    { path: '/explore',        view: 'v2/explore',         title: 'Explore',         page: 'explore'       },
    { path: '/transactions',   view: 'v2/transactions',    title: 'Transactions',    page: 'transactions'  },
    { path: '/settings',       view: 'v2/settings',        title: 'Settings',        page: 'settings'      },
    { path: '/docs',           view: 'v2/docs',            title: 'Docs',            page: 'docs'          },
    { path: '/faq',            view: 'v2/faq',             title: 'FAQ',             page: 'faq'           },
    { path: '/contact',        view: 'v2/contact',         title: 'Contact',         page: 'contact'       },
    { path: '/login',          view: 'v2/login',           title: 'Log In',          page: 'login'         },
    { path: '/signup',         view: 'v2/signup',          title: 'Sign Up',         page: 'signup'        },
    { path: '/reset-password', view: 'v2/reset-password',  title: 'Reset Password',  page: 'reset-password'},
    { path: '/topup',          view: 'v2/topup',           title: 'Top Up Credits',  page: 'topup'         },
];

for (const { path: routePath, view, title, page } of appPages) {
    app.get(routePath, anonymousAuth, requireNonAdmin, (req, res) => {
        res.render(view, { title, page, user: req.user ?? null });
    });
}

// ---------------------------------------------------------------------------
// Admin panel — server-rendered EJS pages at /admin/*
// Protected by anonymousAuth + requireModerator (imported from adminAuth.js)
// ---------------------------------------------------------------------------
import { requireModerator as _requireModerator, requireSuperadmin as _requireSuperadmin, requireNonAdmin } from './server/middleware/adminAuth.js';

// Convenience: resolve the _gadmin session cookie then role check, pass `admin`
// to the template. For page routes we render a convincing 404 instead of
// returning a 403 JSON so the existence of the admin panel isn't revealed.
function adminPage(minRole = 'moderator') {
    const allowedRoles = minRole === 'superadmin' ? ['superadmin'] : ['moderator', 'superadmin'];
    return [
        adminSessionAuth,
        (req, res, next) => {
            if (!req.user || req.user.isAnonymous || !allowedRoles.includes(req.user.role)) {
                return res.status(404).render('admin/not-found');
            }
            res.locals.admin = req.user;
            next();
        }
    ];
}

// /admin/login  →  standalone login page (no auth guard — publicly accessible)
// If already logged in as admin (_gadmin cookie), redirect straight to panel.
app.get('/admin/login', adminSessionAuth, (req, res) => {
    if (req.user && !req.user.isAnonymous && ['moderator', 'superadmin'].includes(req.user.role)) {
        return res.redirect('/admin');
    }
    res.render('admin/login');
});

// /admin  →  redirect to overview (users for now)
app.get('/admin', adminPage(), (req, res) => res.redirect('/admin/users'));

// /admin/users  →  user list
app.get('/admin/users', adminPage(), (req, res) => {
    res.render('admin/users', { admin: req.user });
});

// /admin/users/:userId  →  user detail
app.get('/admin/users/:userId', adminPage(), async (req, res) => {
    try {
        const { default: User } = await import('./server/models/user.js');
        const viewUser = await User.findById(req.params.userId)
            .select('-password -otpCode -otpExpires -otpSentAt -resetPasswordToken -resetPasswordExpires')
            .lean();
        if (!viewUser) return res.status(404).send('User not found');
        res.render('admin/user-detail', { admin: req.user, viewUser });
    } catch (err) {
        console.error('[admin/users/:id page]', err);
        res.status(500).send('Server error');
    }
});

// ── Search: JSON pagination API ──────────────────────────────────────────────
app.get('/api/search', anonymousAuth, async (req, res) => {
    const q    = (req.query.q    || '').trim();
    const type = (req.query.type || '').toLowerCase(); // people | buckets | repos
    const skip = Math.max(0, parseInt(req.query.skip) || 0);

    if (!q || !['people', 'buckets', 'repos'].includes(type)) {
        return res.json({ items: [], hasMore: false });
    }

    const BUCKET_SELECT = 'name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags isDraft visibility isPublic';
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
            // Build exclusion set: users who have blocked the viewer
            let blockedByIds = [];
            if (req.user && !req.user.isAnonymous) {
                const blocks = await Block.find({ blockedId: req.user._id }).select('blockerId').lean();
                blockedByIds = blocks.map(b => b.blockerId);
            }

            const userFilter = { username: new RegExp(escaped, 'i'), isAnonymous: false };
            if (blockedByIds.length) userFilter._id = { $nin: blockedByIds };

            const found  = await User.find(userFilter)
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
            // Exclude buckets from users who have blocked the viewer
            let blockedByUserIds = [];
            if (req.user && !req.user.isAnonymous) {
                const blocks = await Block.find({ blockedId: req.user._id }).select('blockerId').lean();
                blockedByUserIds = blocks.map(b => b.blockerId);
            }

            const bucketFilter = {
                name:    new RegExp(escaped, 'i'),
                isDraft: { $ne: true },
                $or:     FILTER_PUBLIC.$or,
            };
            if (blockedByUserIds.length) bucketFilter.userId = { $nin: blockedByUserIds };

            const found = await Bucket.find(bucketFilter)
            .select(BUCKET_SELECT)
            .skip(skip).limit(B_LIMIT + 1)
            .populate('userId', 'username anonymousId avatar')
            .lean();

            const hasMore = found.length > B_LIMIT;
            const buckets = found.slice(0, B_LIMIT);

            const grabCounts = buckets.map(b => b.grabbedBy?.length ?? 0);
            let grabbedSet = new Set();
            if (req.user?._id && !req.user.isAnonymous && buckets.length) {
                const grabs = await Bucket.find({
                    _id:               { $in: buckets.map(b => b._id) },
                    'grabbedBy.userId': req.user._id,
                }).select('_id').lean();
                grabs.forEach(g => grabbedSet.add(String(g._id)));
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
            const repoItems = found.slice(0, R_LIMIT).map(r => ({
                domain:      r.domain,
                tag:         r.tag,
                bucketCount: r.bucketCount || 0,
            }));
            await enrichReposWithBucketThumbnails(repoItems);
            return res.json({ hasMore, items: repoItems });
        }

        return res.json({ items: [], hasMore: false });

    } catch (err) {
        console.error('Search API error:', err);
        return res.json({ items: [], hasMore: false });
    }
});

// Block admin accounts from the regular user frontend — redirect to /admin
app.use('/showroom', requireNonAdmin);

// Search page — /v2/search?q=<query>[&type=people|buckets|repos]
app.get('/search', anonymousAuth, async (req, res) => {
    const q          = (req.query.q    || '').trim();
    const searchType = (req.query.type || '').toLowerCase(); // '' | 'people' | 'buckets' | 'repos'
    if (!q) return res.redirect('/explore');

    const BUCKET_SELECT = 'name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags isDraft visibility isPublic';
    const U_LIMIT = 6, B_LIMIT = 9, R_LIMIT = 3, T_LIMIT = 18;

    let users   = [];
    let buckets = [];
    let hasMoreUsers   = false;
    let hasMoreBuckets = false;
    let hasMoreRepos   = false;

    try {
        // 1. Bucket share URL  →  /share/bucket/{id}
        const shareMatch = q.match(/\/share\/bucket\/([a-f0-9]{24})/i);

        // 2. Profile URL  →  /v2/u/username  or  /v2/@username (legacy)
        const profileUrlMatch = q.match(/\/(?:u\/|@)([A-Za-z0-9_.-]+)(?:[/?]|$)/);

        // 3. Raw 24-char hex ObjectId
        const isObjectId = /^[a-f0-9]{24}$/i.test(q);

        // 4. @username or u:username shorthand
        const usernameAt = q.startsWith('@') ? q.slice(1) : (q.startsWith('u:') ? q.slice(2) : null);

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
        const grabCounts = buckets.map(b => b.grabbedBy?.length ?? 0);

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
        if (req.user?._id && !req.user.isAnonymous && buckets.length) {
            const grabs = await Bucket.find({
                _id:               { $in: buckets.map(b => b._id) },
                'grabbedBy.userId': req.user._id,
            }).select('_id').lean();
            grabs.forEach(g => grabbedSet.add(String(g._id)));
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
            const pattern = new RegExp(sidebarEscaped, 'i');
            const found = await Repository.find({
                $or: [{ domain: pattern }, { tag: pattern }]
            }).sort({ totalClicks: -1 }).limit(R_LIMIT + 1).lean();
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

        await enrichReposWithBucketThumbnails(repos);
        const formattedRepos = repos.map(r => ({
            domain:               r.domain,
            tag:                  r.tag,
            bucketCount:          r.bucketCount || 0,
            topBucketThumbnails:  r.topBucketThumbnails || [],
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

// Profile page — redirect /v2/profile to the logged-in user's profile route
app.get('/profile', anonymousAuth, requireAuth, (req, res) => {
    const username = req.user?.username;
    if (username) return res.redirect(`/u/${username}`);
    res.redirect('/showroom');
});

// Legacy @username redirect
app.get('/@:username', (req, res) => {
    res.redirect(301, `/u/${req.params.username}`);
});

// Profile page — /v2/u/:username  (public — anyone can view)
app.get('/u/:username', anonymousAuth, async (req, res) => {
    // Who is being viewed
    const profileUser = await User.findOne({ username: req.params.username, isAnonymous: false }).lean();
    if (!profileUser) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null }).catch(() => res.status(404).send('User not found'));

    // Is the logged-in user the owner of this profile?
    const viewer  = req.user ?? null;
    const isOwner = !!(viewer && !viewer.isAnonymous && viewer._id.toString() === profileUser._id.toString());

    // Block check: if profileUser has blocked the viewer, treat as 404
    if (!isOwner && viewer && !viewer.isAnonymous) {
        const blocked = await Block.exists({ blockerId: profileUser._id, blockedId: viewer._id });
        if (blocked) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: viewer });
    }

    const addDisplayThumb = (b) => ({
        ...b,
        _id: b._id.toString(),
        displayThumb: b.thumbnail || b.links?.find(l => l.image)?.image || null,
    });

    // Owners see all their buckets; visitors only see public ones (not unlisted)
    const bucketFilter = isOwner
        ? { userId: profileUser._id }
        : { userId: profileUser._id, ...FILTER_PUBLIC };

    const [allBuckets, subscriberCount, followingCount, rawGrabbed, userRepos] = await Promise.all([
        Bucket.find(bucketFilter)
            .select('name description thumbnail visibility isPublic isPaywalled price links viewCount shareCount grabbedBy sourceUrl hashtags mature isDraft ratingCount ratingSum repoId createdAt updatedAt')
            .sort({ order: 1, createdAt: -1 })
            .lean(),
        Subscription.countDocuments({ followeeId: profileUser._id }),
        Subscription.countDocuments({ followerId: profileUser._id }),
        Bucket.find({ 'grabbedBy.userId': profileUser._id })
            .select('name description thumbnail visibility isPublic isPaywalled price links viewCount shareCount grabbedBy sourceUrl hashtags ratingCount ratingSum createdAt updatedAt')
            .populate('userId', 'username')
            .sort({ createdAt: -1 })
            .lean(),
        UserRepo.find({ userId: profileUser._id }).sort({ name: 1 }).lean(),
    ]);

    const ownBuckets     = allBuckets.map(addDisplayThumb);
    const grabbedBuckets = rawGrabbed.map(addDisplayThumb);
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
        userRepos,
        totalViews,
        totalGrabs,
        subscriberCount,
        followingCount,
        memberSince,
    });
});

// Dynamic repository page — domain + tag come from the path
// User-created repo page — single ObjectId segment distinguishes it from domain+tag repos
app.get('/o/:repoId', anonymousAuth, async (req, res) => {
    try {
        const { repoId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(repoId)) {
            return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        const repo = await UserRepo.findById(repoId).lean();
        if (!repo) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null });

        const viewer  = req.user ?? null;
        const owner   = await User.findById(repo.userId).select('username avatar anonymousId').lean();
        if (!owner) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: viewer });

        const isOwner = !!(viewer && !viewer.isAnonymous && viewer._id.toString() === repo.userId.toString());

        // Visitors see public + unlisted buckets (unlisted = accessible via link/repo, not discoverable); owner sees all
        const bucketFilter = isOwner
            ? { repoId: repo._id }
            : { repoId: repo._id, ...FILTER_ACCESSIBLE };

        const rawBuckets = await Bucket.find(bucketFilter)
            .select('name description thumbnail visibility isPublic isPaywalled price links viewCount shareCount grabbedBy sourceUrl hashtags mature isDraft ratingCount ratingSum createdAt updatedAt')
            .sort({ createdAt: -1 })
            .lean();

        const buckets = rawBuckets.map(b => ({
            ...b,
            _id:          b._id.toString(),
            displayThumb: b.thumbnail || b.links?.find(l => l.image)?.image || null,
        }));

        const createdAt = new Date(repo.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const pageUrl   = `${req.protocol}://${req.get('host')}/o/${repoId}`;

        res.render('v2/repo', {
            title:          repo.name,
            page:           'repo',
            user:           viewer,
            ogTitle:        `${repo.name} — by @${owner.username}`,
            ogDescription:  `A curated repo of ${buckets.length} bucket${buckets.length !== 1 ? 's' : ''} by @${owner.username}`,
            ogUrl:          pageUrl,
            repo,
            owner,
            isOwner,
            buckets,
            createdAt,
            pageUrl,
        });
    } catch (err) {
        console.error('Error rendering repo page:', err);
        res.status(500).render('v2/404', { title: 'Error', page: '', user: req.user ?? null });
    }
});

app.get('/o/:topic/:tag', anonymousAuth, (req, res) => {
    const topic = req.params.topic || '';
    const tag   = req.params.tag   || '';
    res.render('v2/repository', { title: `#${tag} in ${topic}`, page: 'repository', user: req.user ?? null, domain: topic, tag });
});

// Report page — /v2/report/:bucketId
app.get('/report/:bucketId', anonymousAuth, async (req, res) => {
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

// Bucket thumbnail — /v2/b/:bucketId/thumbnail.jpg
app.get('/b/:bucketId/thumbnail.jpg', async (req, res) => {
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

// Bucket recommendations — returns similar public buckets sorted by exploreScore.
// Matching strategy (in order of preference):
//   1. Shared hashtags (any overlap)
//   2. Same topic (domain / derived topic)
// The current bucket and its curator's other buckets are excluded.
app.get('/api/buckets/:id/recommendations', anonymousAuth, async (req, res) => {
    try {
        const bucket = await Bucket.findById(req.params.id)
            .select('userId topic hashtags')
            .lean();
        if (!bucket) return res.json({ buckets: [] });

        const BASE_FILTER = { ...FILTER_PUBLIC, isDraft: { $ne: true }, name: { $ne: 'Singletons' } };
        const exclude = { _id: { $ne: bucket._id }, userId: { $ne: bucket.userId } };

        // Build OR conditions: hashtag overlap first, topic fallback
        const orConditions = [];
        if (bucket.hashtags?.length > 0) {
            orConditions.push({ hashtags: { $in: bucket.hashtags } });
        }
        if (bucket.topic) {
            orConditions.push({ topic: bucket.topic });
        }

        let recs = [];
        if (orConditions.length > 0) {
            recs = await Bucket.find({ ...BASE_FILTER, ...exclude, $or: orConditions })
                .sort({ exploreScore: -1 })
                .limit(3)
                .populate('userId', 'username avatar anonymousId')
                .select('name thumbnail links grabbedBy hashtags topic userId viewCount shareCount isPaywalled price')
                .lean();
        }

        res.json({
            buckets: recs.map(b => ({
                _id:         b._id,
                name:        b.name,
                thumbnail:   b.thumbnail || (b.links || []).find(l => l.image)?.image || '',
                linkCount:   (b.links || []).length,
                grabCount:   (b.grabbedBy || []).length,
                viewCount:   b.viewCount   || 0,
                shareCount:  b.shareCount  || 0,
                isPaywalled: b.isPaywalled || false,
                price:       b.price       || 0,
                hashtags:    b.hashtags    || [],
                topic:       b.topic       || null,
                curator: {
                    username: b.userId?.username    || 'Unknown',
                    avatar:   b.userId?.avatar      || '',
                    userId:   b.userId?.anonymousId || ''
                }
            }))
        });
    } catch (err) {
        console.error('Recommendations error:', err);
        res.json({ buckets: [] });
    }
});

// Bucket view page — /v2/b/:bucketId  (accessible to anyone)
app.get('/b/:bucketId', anonymousAuth, async (req, res) => {
    try {
        const { bucketId } = req.params;
        const bucket = await Bucket.findById(bucketId).lean();
        if (!bucket) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null });

        const curator = await User.findById(bucket.userId).select('username avatar anonymousId').lean();
        const curatorName        = curator?.username    || 'Anonymous';
        const curatorAvatar      = curator?.avatar      || null;
        const curatorAnonymousId = curator?.anonymousId || null;

        const thumbnailUrl = bucket.thumbnail || bucket.links?.find(l => l.image)?.image || null;
        const shareBaseUrl = `${req.protocol}://${req.get('host')}`;

        const vis = bucketVisibility(bucket);
        const isOwner = !!(req.user && !req.user.isAnonymous && bucket.userId.toString() === req.user._id.toString());
        if (vis === 'private' && !isOwner) {
            return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        // Block check: if bucket's curator has blocked the viewer, treat as 404
        if (!isOwner && req.user && !req.user.isAnonymous) {
            const blocked = await Block.exists({ blockerId: bucket.userId, blockedId: req.user._id });
            if (blocked) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        const hasAccess = isOwner
            || !bucket.isPaywalled
            || (!req.user.isAnonymous && !!(await BucketAccess.findOne({ userId: req.user._id, bucketId: bucket._id })));

        const isFollowing = !isOwner && req.user && !req.user.isAnonymous && curatorAnonymousId
            ? !!(await Subscription.exists({ followerId: req.user._id, followeeId: curator._id }))
            : false;

        const hasGrabbed = !isOwner && req.user && !req.user.isAnonymous
            ? !!(bucket.grabbedBy?.some(g => g.userId.toString() === req.user._id.toString()))
            : false;

        // Comment eligibility: clicked >= 2 links (no grab required)
        // Rating eligibility: grabbed + clicked >= 2 links
        let canComment = false;
        let canRate    = false;
        let userRating = null;
        if (!isOwner && req.user && !req.user.isAnonymous) {
            const clickCount = await LinkClick.countDocuments({ bucketId, userId: req.user._id });
            canComment = clickCount >= 2;
            if (hasGrabbed) {
                const existingRating = await BucketRating.findOne({ bucketId, userId: req.user._id }).select('stars').lean();
                canRate    = clickCount >= 2;
                userRating = existingRating?.stars ?? null;
            }
        }
        const ratingCount    = bucket.ratingCount || 0;
        const ratingAvg      = ratingCount > 0 ? Math.round((bucket.ratingSum / ratingCount) * 10) / 10 : null;
        const commentCount   = await BucketComment.countDocuments({ bucketId, deletedAt: null });

        // Track view (fire-and-forget, skip owner)
        if (!isOwner) {
            const userId = (req.user && !req.user.isAnonymous) ? req.user._id : null;
            const viewSource = req.query.src === 'explore' ? 'explore' : 'direct';
            trackBucketView(bucketId, userId, req.ip, viewSource).catch(() => {});
        }

        // Verified share: deduplicate by (bucketId, sid, visitor)
        if (req.query.ref === 'share' && req.query.sid) {
            const sid    = String(req.query.sid).slice(0, 32);
            const userId = (req.user && !req.user.isAnonymous) ? req.user._id : null;
            const ip     = req.ip;
            (async () => {
                try {
                    const seen = userId
                        ? await ShareVisit.exists({ bucketId, sid, userId })
                        : await ShareVisit.exists({ bucketId, sid, ip });
                    if (!seen) {
                        await ShareVisit.create({ bucketId, sid, userId, ip: userId ? null : ip });
                        await Bucket.findByIdAndUpdate(bucketId, { $inc: { verifiedShareCount: 1 } }, { timestamps: false });
                    }
                } catch (_) {}
            })();
        }

        const bucketUrl = `${shareBaseUrl}/b/${bucketId}`;
        const hasThumbnail = !!(bucket.thumbnail || bucket.links?.some(l => l.image));
        const ogImage = hasThumbnail ? `${shareBaseUrl}/b/${bucketId}/thumbnail.jpg` : null;

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
            canComment,
            canRate,
            userRating,
            ratingCount,
            ratingAvg,
            commentCount,
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

// Messages — shared template for both inbox and active conversation
const MSG_DEFAULTS = { activeConversationId: null, conversation: null, otherUser: null };

app.get('/messages', anonymousAuth, requireAuth, requireVerification, (req, res) => {
    res.render('v2/messages', { title: 'Messages', page: 'messages', user: req.user, ...MSG_DEFAULTS });
});

app.get('/messages/:conversationId', anonymousAuth, requireAuth, requireVerification, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user });
        }

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user });

        const isParticipant = conversation.participants.some(p => p.toString() === req.user._id.toString());
        if (!isParticipant) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user });

        const otherId = conversation.participants.find(p => p.toString() !== req.user._id.toString());
        if (otherId) {
            const blocked = await Block.exists({ blockerId: otherId, blockedId: req.user._id });
            if (blocked) return res.status(404).render('v2/404', { title: 'Not Found', page: '', user: req.user });
        }

        const otherUser = otherId ? await User.findById(otherId).select('username avatar anonymousId').lean() : null;

        res.render('v2/messages', {
            title:                `Chat with @${otherUser?.username || 'User'}`,
            page:                 'messages',
            user:                 req.user,
            activeConversationId: String(conversationId),
            conversation,
            otherUser,
        });
    } catch (err) {
        console.error('Error loading conversation page:', err);
        res.status(500).send('Error loading conversation');
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
        const REPO_REBUILD_INTERVAL    = 60 * 60 * 1000;  // 1 hour
        const EXPLORE_REBUILD_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours
        buildRepositories().catch(err => console.error('[repos] Initial build failed:', err));
        setInterval(() => {
            buildRepositories().catch(err => console.error('[repos] Scheduled build failed:', err));
        }, REPO_REBUILD_INTERVAL);

        // Run explore score build staggered 1h after repos, then every 2 hours
        setTimeout(() => {
            buildExploreScores().catch(err => console.error('[explore] Initial build failed:', err));
            setInterval(() => {
                buildExploreScores().catch(err => console.error('[explore] Scheduled build failed:', err));
            }, EXPLORE_REBUILD_INTERVAL);
        }, 60 * 60 * 1000);

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