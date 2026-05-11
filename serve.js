import * as cheerio from 'cheerio';
import http from 'http';
import https from 'https';
import { randomBytes, createHash } from 'crypto';
import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
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
import { sendOtpEmail, sendDataExportEmail, sendAccountDeletionEmail } from './server/utils/email.js';
import { translate } from './server/i18n.js';
import { validateLinks } from './server/utils/urlSafety.js';
import { fetchAndStoreImage, deleteR2Images, uploadImageToR2, uploadFileToR2 } from './server/utils/r2.js';
import bucketShareRouter from './server/routes/bucketShare.js';
import authRouter from './server/routes/auth.js';
import creditsRouter, { handleWebhook } from './server/routes/credits.js';
import connectRouter, { handleConnectWebhook } from './server/routes/stripeConnect.js';
import notificationsRouter from './server/routes/notifications.js';
import bucketCommentsRouter from './server/routes/bucketComments.js';
import dmRouter from './server/routes/dm.js';
import blockRouter from './server/routes/block.js';
import partnershipRouter from './server/routes/partnership.js';
import PartnerApplication from './server/models/partnerApplication.js';
import adminRouter     from './server/routes/admin.js';
import adminAuthRouter from './server/routes/admin/auth.js';
import devTodosRouter  from './server/routes/devTodos.js';
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
import CommentAgreement from './server/models/commentAgreement.js';
import Link from './server/models/link.js';
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
        User.findById(userId).select('privacy').lean().then(u => {
            if (u?.privacy?.showActivityStatus === false) return;
            Conversation.find({ participants: userId }).select('participants').lean()
                .then(convs => {
                    const partners = [...new Set(
                        convs.flatMap(c => c.participants.map(String).filter(id => id !== userId))
                    )];
                    for (const partnerId of partners) {
                        pushNotification(partnerId, { type: 'user_online', userId });
                    }
                }).catch(() => {});
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
                // Notify conversation partners that this user went offline (only if status is visible)
                User.findById(userId).select('privacy').lean().then(u => {
                    if (u?.privacy?.showActivityStatus === false) return;
                    Conversation.find({ participants: userId }).select('participants').lean()
                        .then(convs => {
                            const partners = [...new Set(
                                convs.flatMap(c => c.participants.map(String).filter(id => id !== userId))
                            )];
                            for (const partnerId of partners) {
                                pushNotification(partnerId, { type: 'user_offline', userId, lastSeenAt: lastSeenAt.toISOString() });
                            }
                        }).catch(() => {});
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
const PRODUCTION_ORIGINS = ['https://grabbn.com', 'https://www.grabbn.com', 'https://app.grabbn.com'];

function ALLOWED_ORIGINS(origin, callback) {
  if (!origin) return callback(null, true); // server-to-server / curl
  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
    return callback(null, true); // browser extension
  }
  if (process.env.NODE_ENV !== 'production') return callback(null, true);
  if (PRODUCTION_ORIGINS.includes(origin)) return callback(null, true);
  callback(new Error(`CORS: origin ${origin} not allowed`));
}

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

// ── i18n: inject t() into every EJS render ──────────────────────────────────
app.use((req, res, next) => {
    const lang = req.user?.language || 'en';
    res.locals.t = (key) => translate(lang, key);
    next();
});

// ── EJS helper: route external image URLs through the proxy ─────────────────
// Base64 data URLs and relative paths pass through unchanged; anything that
// starts with http/https is proxied so CDN hotlink blocks / Varnish errors on
// external sites never reach the end user.
app.use((req, res, next) => {
    const r2Base = process.env.R2_PUBLIC_URL || '';
    res.locals.imgSrc = (url) => {
        if (!url) return '';
        if (url.startsWith('data:') || url.startsWith('/')) return url;
        if (r2Base && url.startsWith(r2Base)) return url; // own CDN — serve directly
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
app.use('/api/partnership', partnershipRouter);

// Online presence — checks wsClients for an active connection
app.get('/api/users/:userId/online-status', anonymousAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        const u = await User.findById(userId).select('lastActive privacy').lean();
        if (!u) return res.json({ online: false, lastSeenAt: null });
        if (u.privacy?.showActivityStatus === false) return res.json({ hidden: true });
        const connections = wsClients.get(String(userId));
        const online = !!(connections && connections.size > 0);
        const lastSeenAt = online ? null : (u.lastActive ?? null);
        return res.json({ online, lastSeenAt });
    } catch (err) {
        console.error('[online-status]', err);
        res.json({ online: false, lastSeenAt: null });
    }
});

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'dev_ressources')));
app.use('/api/dev/todos', devTodosRouter);

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
    const isProd = process.env.NODE_ENV === 'production';
    const uri = isProd
        ? (process.env.ATLAS_URL || process.env.MONGODB_URI)
        : process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB || 'grabbn';
    if (!uri) {
        throw new Error('MONGODB_URI is not set in .env');
    }
    await mongoose.connect(uri, { dbName });
    console.log(`MongoDB connected [${isProd ? 'production' : 'development'}]: ${dbName}`);
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
const ALLOWED_LINK_IMG_MIME = new Set(['image/jpeg','image/jpg','image/png','image/webp','image/gif','image/avif','image/svg+xml']);

async function fetchImageAsBase64(url, { referer, minBytes = 0 } = {}) {
    if (!url) return null;
    if (url.startsWith('data:') || url.startsWith('/')) return url;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': referer ? 'cross-site' : 'none',
        };
        if (referer) {
            headers['Referer'] = referer;
            try { headers['Origin'] = new URL(referer).origin; } catch {}
        }
        const upstream = await fetch(url, {
            signal: controller.signal,
            headers,
            redirect: 'follow',
        });
        clearTimeout(timer);
        if (!upstream.ok) {
            console.warn('[img] fetch failed', upstream.status, url.slice(0, 120));
            return null;
        }
        const type = (upstream.headers.get('content-type') || '').split(';')[0].trim();
        if (!ALLOWED_LINK_IMG_MIME.has(type)) {
            console.warn('[img] bad content-type', type, url.slice(0, 120));
            return null;
        }
        const buf = await upstream.arrayBuffer();
        if (buf.byteLength > MAX_LINK_IMG_BYTES) {
            console.warn('[img] too large', buf.byteLength, url.slice(0, 120));
            return null;
        }
        if (minBytes > 0 && buf.byteLength < minBytes) {
            console.warn('[img] too small, likely placeholder', buf.byteLength, url.slice(0, 120));
            return null;
        }
        return `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
    } catch (e) {
        console.warn('[img] fetch threw', e.message, url.slice(0, 120));
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


const META_DAILY_LIMIT = 50;
const META_FETCH_COST  = 2; // JWL per extra fetch

// Per-minute sliding window (hidden, alert only)
const _metaMinuteMap = new Map();
function metaMinuteCheck(userId) {
    const now = Date.now();
    const timestamps = (_metaMinuteMap.get(userId) || []).filter(t => now - t < 60_000);
    if (timestamps.length >= 20) return false;
    timestamps.push(now);
    _metaMinuteMap.set(userId, timestamps);
    return true;
}

// Daily counter with optional bonus quota (calendar day, UTC) — persisted in DB.
async function metaDailyCheck(userId) {
    const today = new Date().toISOString().slice(0, 10);
    const user = await User.findOneAndUpdate(
        { _id: userId, $or: [{ metaFetchDate: { $ne: today } }, { metaFetchDate: null }] },
        { $set: { metaFetchDate: today, metaFetchCount: 0, metaFetchBonus: 0 } },
        { new: false }
    );
    // If the update matched, the doc was reset — now atomically increment
    // Otherwise the doc already has today's date; just increment
    const updated = await User.findOneAndUpdate(
        { _id: userId, metaFetchDate: today, $expr: { $lt: ['$metaFetchCount', { $add: [{ $ifNull: ['$metaFetchLimit', META_DAILY_LIMIT] }, '$metaFetchBonus'] }] } },
        { $inc: { metaFetchCount: 1 } },
        { new: true, projection: { metaFetchCount: 1, metaFetchBonus: 1, metaFetchLimit: 1 } }
    );
    if (!updated) {
        const cur = await User.findById(userId, { metaFetchCount: 1, metaFetchBonus: 1, metaFetchLimit: 1 });
        const used  = cur?.metaFetchCount ?? 0;
        const base  = cur?.metaFetchLimit ?? META_DAILY_LIMIT;
        const limit = base + (cur?.metaFetchBonus ?? 0);
        return { ok: false, used, limit };
    }
    const base  = updated.metaFetchLimit ?? META_DAILY_LIMIT;
    const limit = base + updated.metaFetchBonus;
    return { ok: true, used: updated.metaFetchCount, limit };
}

async function metaDailyAddBonus(userId, fetches) {
    const today = new Date().toISOString().slice(0, 10);
    await User.updateOne(
        { _id: userId, $or: [{ metaFetchDate: { $ne: today } }, { metaFetchDate: null }] },
        { $set: { metaFetchDate: today, metaFetchCount: 0, metaFetchBonus: 0 } }
    );
    const updated = await User.findOneAndUpdate(
        { _id: userId },
        { $inc: { metaFetchBonus: fetches } },
        { new: true, projection: { metaFetchCount: 1, metaFetchBonus: 1, metaFetchLimit: 1 } }
    );
    const base = updated.metaFetchLimit ?? META_DAILY_LIMIT;
    return { limit: base + updated.metaFetchBonus, used: updated.metaFetchCount };
}

// Domains whose product metadata requires JS rendering to retrieve correctly.
const JS_RENDER_DOMAINS = new Set([
    'amazon.com', 'www.amazon.com', 'a.co',
    'shein.com', 'www.shein.com', 'us.shein.com',
    'temu.com', 'www.temu.com', 'share.temu.com',
    'aliexpress.com', 'www.aliexpress.com',
    'ebay.com', 'www.ebay.com',
    'etsy.com', 'www.etsy.com',
]);

function needsRender(rawUrl) {
    try { return JS_RENDER_DOMAINS.has(new URL(rawUrl).hostname); } catch { return false; }
}

// Some sites redirect unauthenticated HEAD requests to a login/interstitial page.
// For those domains we keep the original product URL and let the renderer handle it.
// a.co short links are also preserved — ScraperAPI follows the redirect itself and
// renders the final Amazon page, avoiding HEAD-based resolution which can land on a
// non-product page (search, home) that lacks #productTitle.
const PRESERVE_ORIGINAL_RENDER_URL_DOMAINS = new Set([
    'a.co',
    'temu.com', 'www.temu.com',
    'shein.com', 'www.shein.com', 'us.shein.com',
]);

function shouldPreserveOriginalRenderUrl(rawUrl) {
    try {
        return PRESERVE_ORIGINAL_RENDER_URL_DOMAINS.has(new URL(rawUrl).hostname);
    } catch {
        return false;
    }
}

// Follow redirects to get the final URL (resolves short URLs like a.co before scraping).
async function resolveUrl(url) {
    if (shouldPreserveOriginalRenderUrl(url)) return url;
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: ctrl.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
        });
        return res.url || url;
    } catch {
        return url;
    }
}

function normalizeMetaUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const hostname = url.hostname.toLowerCase();

        if (domainMatches(hostname, ['amazon.com', 'a.co'])) {
            // Normalize to canonical product URL — strips tracking/search-result params
            // that cause ScraperAPI to return inconsistent images.
            const m = url.pathname.match(/\/dp\/([A-Z0-9]{10})/i)
                   || url.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/i);
            if (m) return `https://www.amazon.com/dp/${m[1]}`;
            return new URL('https://www.amazon.com' + url.pathname).toString();
        }

        if (hostname === 'temu.com' || hostname === 'www.temu.com') {
            const clean = new URL(url.origin + url.pathname);
            ['spec_id', 'spec_ids', 'spec_gallery_id'].forEach(function (key) {
                const value = url.searchParams.get(key);
                if (value) clean.searchParams.set(key, value);
            });
            return clean.toString();
        }

        return url.toString();
    } catch {
        return rawUrl;
    }
}

// Returns true if the HTML is a Cloudflare bot-challenge page rather than the real site.
function isCloudflareChallengeHtml(html) {
    if (!html) return false;
    return html.includes('risk-id=') || html.includes('challenges.cloudflare.com') || html.includes('Just a moment');
}

// Fetch fully rendered HTML via ScraperAPI, then extract OG tags.
async function fetchViaScraperAPI(url, { wait = 0, ultraPremium = false } = {}) {
    const key = process.env.SCRAPERAPI_KEY;
    if (!key) return null;
    const resolved = await resolveUrl(url);
    console.log('[meta] ScraperAPI resolved URL:', resolved);
    let apiUrl = `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(resolved)}&render=true&country_code=us`;
    if (wait > 0) apiUrl += `&wait=${wait}`;
    if (ultraPremium) apiUrl += '&ultra_premium=true';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
        const res = await fetch(apiUrl, { signal: ctrl.signal });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.warn('[meta] ScraperAPI non-200:', res.status, body.slice(0, 200));
            return null;
        }
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

// Fetch fully rendered HTML via Zyte API — handles Cloudflare-protected sites.
// Uses https.request instead of fetch to avoid Node.js/Windows TLS renegotiation issues.
// Also tolerates abrupt socket close (Windows schannel missing close_notify) by
// resolving with whatever data was received if we got a 200 and a parseable JSON body.
async function fetchViaZyte(url) {
    const key = process.env.ZYTE_API_KEY;
    if (!key) return null;
    const body = JSON.stringify({ url, browserHtml: true });
    const auth = Buffer.from(key + ':').toString('base64');
    return new Promise((resolve) => {
        let settled = false;
        function done(val) { if (!settled) { settled = true; resolve(val); } }

        function tryParse(statusCode, raw) {
            if (statusCode !== 200) { console.warn('[meta] Zyte non-200:', statusCode, raw.slice(0, 200)); return null; }
            try { return JSON.parse(raw).browserHtml ?? null; }
            catch { console.warn('[meta] Zyte JSON parse failed, raw length:', raw.length); return null; }
        }

        const req = https.request({
            hostname: 'api.zyte.com',
            port: 443,
            path: '/v1/extract',
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + auth,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => { chunks.push(chunk); });
            res.on('end', () => { done(tryParse(res.statusCode, Buffer.concat(chunks).toString('utf8'))); });
            // Socket closed without TLS close_notify — try to use buffered data anyway
            res.on('error', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                console.warn('[meta] Zyte response stream error — attempting partial parse, length:', raw.length);
                done(tryParse(res.statusCode, raw));
            });
        });
        req.setTimeout(120000, () => { req.destroy(); done(null); });
        req.on('error', (e) => { console.warn('[meta] Zyte error:', e.message); done(null); });
        req.write(body);
        req.end();
    });
}

// Extract goods_id and cat_id from a Shein product URL slug.
function parseSheinProductIds(url) {
    const m = String(url).match(/-p-(\d+)(?:-cat-(\d+))?(?:\.html)?/);
    if (!m) return null;
    return { goodsId: m[1], catId: m[2] || null };
}

function sheinTitleOnlyMeta(pageUrl, usage, titleOverride = null, extra = {}) {
    return {
        title: titleOverride || slugTitleFromUrl(pageUrl) || null,
        image: null,
        images: [],
        provider: 'shein',
        titleSource: titleOverride ? 'api' : 'slug',
        imageStatus: 'unavailable',
        imageReason: 'shein_product_images_blocked',
        ...extra,
        usage,
    };
}

// Call Shein's internal product API to get title + image list without needing JS rendering.
// Returns { title, images } or null if unavailable.
async function fetchSheinProduct(pageUrl) {
    const ids = parseSheinProductIds(pageUrl);
    if (!ids) return null;
    const { goodsId, catId } = ids;
    const params = new URLSearchParams({ goods_id: goodsId, currency: 'USD', lang: 'en', country: 'US' });
    if (catId) params.set('cat_id', catId);
    const endpoint = `https://us.shein.com/api/productInfo/queryGoodsDetailByGoodsId?${params}`;

    const sheinHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': pageUrl,
        'Origin': 'https://us.shein.com',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
    };

    async function tryFetch(url, opts) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
            return await fetch(url, { ...opts, signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    let res = await tryFetch(endpoint, { headers: sheinHeaders });

    if (!res.ok) { console.warn('[meta] Shein API direct failed:', res.status); return null; }
    let json;
    try { json = await res.json(); } catch { console.warn('[meta] Shein API: non-JSON response'); return null; }
    // Navigate common response shapes: { info: { detail: {...} } } or { data: { detail: {...} } }
    const detail = json?.info?.detail ?? json?.data?.detail ?? json?.detail ?? null;
    if (!detail) { console.warn('[meta] Shein API: no detail in response, keys:', Object.keys(json || {}).join(',')); return null; }
    const title = cleanTitle(detail.goods_name || detail.name || null) || null;
    // goods_imgs is an array of { origin_image, medium_image, thumbnail }
    const rawImgs = detail.goods_imgs || detail.mainImageList || [];
    const images = rawImgs
        .map(img => img?.origin_image || img?.medium_image || (typeof img === 'string' ? img : null))
        .filter(Boolean);
    console.log('[meta] Shein API ok — title:', title, 'images:', images.length);
    return { title, images };
}

// Fetch an image through ScraperAPI's residential proxy — bypasses CDN hotlink blocks.
async function fetchImageViaScraperAPIProxy(imageUrl) {
    const key = process.env.SCRAPERAPI_KEY;
    if (!key) return null;
    const apiUrl = `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(imageUrl)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
        const res = await fetch(apiUrl, { signal: ctrl.signal });
        if (!res.ok) { console.warn('[img-proxy] ScraperAPI fetch failed', res.status); return null; }
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!ALLOWED_LINK_IMG_MIME.has(type)) { console.warn('[img-proxy] bad content-type', type); return null; }
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_LINK_IMG_BYTES || buf.byteLength < 5120) {
            console.warn('[img-proxy] bad size', buf.byteLength);
            return null;
        }
        return `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
    } catch (e) {
        console.warn('[img-proxy] threw', e.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Returns true if an image URL looks like a site logo/marketing asset rather than a product image.
function isJunkImage(imageUrl) {
    if (!imageUrl) return true;
    const lower = imageUrl.toLowerCase();
    return (
        lower.includes('/logo') ||
        lower.includes('/logos') ||
        lower.includes('/marketing/') ||
        lower.includes('/brand/') ||
        lower.includes('/favicon') ||
        lower.includes('/icon') ||
        // Shein CDN non-product paths (acp/ach = app content/template assets like partner logos)
        lower.includes('ltwebstatic.com/images3_acp/') ||
        lower.includes('ltwebstatic.com/images3_ach/') ||
        lower.includes('ltwebstatic.com/v4/j/ccc/') ||
        lower.includes('ltwebstatic.com/v4/p/tinypic/')
    );
}


async function normalizeMetaImage(imageUrl, { referer } = {}) {
    if (!imageUrl) return null;
    return await fetchAndStoreImage(imageUrl, { referer, folder: 'meta/links' }) || imageUrl;
}

function absolutizeUrl(rawUrl, baseUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;
    try {
        return new URL(trimmed, baseUrl).toString();
    } catch {
        return null;
    }
}

function looksLikeImageUrl(value) {
    if (typeof value !== 'string') return false;
    const lower = value.toLowerCase();
    return (
        lower.startsWith('data:image/') ||
        /\.(avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/.test(lower) ||
        lower.includes('/images/') ||
        lower.includes('/image/') ||
        lower.includes('image=') ||
        lower.includes('images-') ||
        lower.includes('media-amazon.com/images/')
    );
}

function collectImageCandidates(value, out) {
    if (!value) return;
    if (typeof value === 'string') {
        if (looksLikeImageUrl(value)) out.push(value);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(function (item) { collectImageCandidates(item, out); });
        return;
    }
    if (typeof value === 'object') {
        ['image', 'thumbnailUrl', 'contentUrl', 'url'].forEach(function (key) {
            if (key in value) collectImageCandidates(value[key], out);
        });
    }
}

function parseJsonObject(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function pickFirstValidImage(candidates, baseUrl) {
    for (const candidate of candidates) {
        const absolute = absolutizeUrl(candidate, baseUrl);
        if (absolute && !isJunkImage(absolute)) return absolute;
    }
    return null;
}

function extractDynamicImageMap(raw, baseUrl) {
    if (!raw) return null;
    const parsed = parseJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const urls = Object.keys(parsed);
    return pickFirstValidImage(urls, baseUrl);
}

function hostnameFromUrl(rawUrl) {
    try {
        return new URL(rawUrl).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function domainMatches(hostname, domains) {
    return domains.some(function (domain) {
        return hostname === domain || hostname.endsWith('.' + domain);
    });
}

// Titles that signal we got a site homepage/generic page rather than a product page.
const GENERIC_SITE_TITLES = new Set([
    'shein',
    "women's & men's clothing, shop online fashion | shein",
    'shop women\'s & men\'s fashion online | shein',
    'temu',
    'temu - affordable quality, express yourself',
    'temu - affordable quality everything',
    'amazon',
    'amazon.com',
]);

function isGenericTitle(title) {
    if (!title) return true;
    const lower = title.toLowerCase().trim();
    if (GENERIC_SITE_TITLES.has(lower)) return true;
    // Single word that is just a brand name (e.g. "Temu", "SHEIN", "Amazon")
    if (/^(temu|shein|amazon|aliexpress|ebay|etsy)$/i.test(lower)) return true;
    return false;
}

// Extract a human-readable title from the URL slug for marketplace product URLs.
function slugTitleFromUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const hostname = url.hostname.toLowerCase();
        let path = decodeURIComponent(url.pathname).replace(/\.html?$/i, '');

        let slug = null;

        if (domainMatches(hostname, ['shein.com'])) {
            // /Women-s-Solid-Color-Corduroy-Overall-Dress-p-1234567
            // /category/Women-s-Dress-p-1234.html  — strip after -p-
            const m = path.match(/\/([^/]+?)-p-\d+/i) || path.match(/\/([^/]+)$/);
            if (m) slug = m[1];
        } else if (domainMatches(hostname, ['temu.com', 'share.temu.com'])) {
            // /fi-en/1pc-stylish-pearl-shell-...-g-601099519015453
            const m = path.match(/\/(?:[a-z]{2}-[a-z]{2}\/)?(.+?)-g-\d+$/i) || path.match(/\/(?:[a-z]{2}-[a-z]{2}\/)?([^/]+)$/);
            if (m) slug = m[1];
        }

        if (!slug) return null;
        // Convert slug to readable title: hyphens → spaces, capitalise each word
        return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || null;
    } catch {
        return null;
    }
}

const MARKETPLACE_ADAPTERS = [
    {
        name: 'amazon',
        domains: ['amazon.com', 'a.co'],
        titleSelectors: [
            '#productTitle',
            'span#productTitle',
            '#title_feature_div #productTitle',
            '#title span.a-size-large',
            '#title span',
            '.product-title-word-break',
        ],
        imageSelectors: [
            ['#landingImage', 'data-old-hires'],
            ['#landingImage', 'src'],
            ['#imgTagWrapperId img', 'data-old-hires'],
            ['#imgTagWrapperId img', 'src'],
            ['#main-image-container img', 'src'],
        ],
        dynamicImageAttrs: [
            ['#landingImage', 'data-a-dynamic-image'],
            ['#imgTagWrapperId img', 'data-a-dynamic-image'],
        ],
    },
    {
        name: 'etsy',
        domains: ['etsy.com'],
        titleSelectors: ['h1[data-buy-box-listing-title="true"]', 'h1.wt-text-body-03'],
        imageSelectors: [
            ['img[data-index="0"]', 'src'],
            ['img[data-index="0"]', 'srcset'],
            ['img[data-carousel-image]', 'src'],
            ['img[data-carousel-image]', 'srcset'],
        ],
    },
    {
        name: 'ebay',
        domains: ['ebay.com'],
        titleSelectors: ['#x-title-label-lbl + h1', 'h1.x-item-title__mainTitle', 'h1'],
        imageSelectors: [
            ['#icImg', 'src'],
            ['#icImg', 'data-src'],
            ['.ux-image-carousel-item img', 'src'],
            ['.ux-image-carousel-item img', 'data-zoom-src'],
        ],
    },
    {
        name: 'temu',
        domains: ['temu.com', 'share.temu.com'],
        titleSelectors: [
            '[class*="goods-name"]',
            '[class*="product-title"]',
            '[data-testid="goods-name"]',
            '[data-testid="product-title"]',
        ],
        imageSelectors: [
            ['img', 'src'],
            ['img', 'data-src'],
            ['img', 'srcset'],
        ],
    },
    {
        name: 'aliexpress',
        domains: ['aliexpress.com'],
        titleSelectors: ['h1[data-pl="product-title"]', 'h1'],
        imageSelectors: [
            ['img.magnifier-image', 'src'],
            ['img.magnifier-image', 'srcset'],
            ['img', 'src'],
            ['img', 'srcset'],
        ],
    },
    {
        name: 'shein',
        domains: ['shein.com'],
        titleSelectors: [
            '.product-intro__head-name',
            '.goods-title-text',
            '[class*="product-intro"] h1',
            '[class*="ProductIntro"] h1',
            'h1[data-testid]',
            '[data-testid="product-intro-title"]',
            'h1',
        ],
        imageSelectors: [
            ['.crop-image-container img', 'data-src'],
            ['.crop-image-container', 'before-src'],
            ['.crop-image-container img', 'src'],
            ['.product-intro__thumbs-item--main img', 'data-src'],
            ['.product-intro__thumbs-item--main img', 'src'],
            ['[class*="main-swiper"] img', 'data-src'],
            ['[class*="main-swiper"] img', 'src'],
            ['[class*="product-intro__main"] img', 'data-src'],
            ['[class*="product-intro__main"] img', 'src'],
            ['img[class*="crop-image"]', 'data-src'],
            ['img[class*="crop-image"]', 'src'],
        ],
    },
];

function firstNonEmptyText($, selectors) {
    for (const selector of selectors || []) {
        const value = $(selector).first().text().trim();
        if (value) return value;
    }
    return null;
}

function parseSrcsetCandidate(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const first = raw.split(',').map(function (part) { return part.trim().split(/\s+/)[0]; }).find(Boolean);
    return first || null;
}

function parseSrcsetCandidates(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return raw
        .split(',')
        .map(function (part) {
            const bits = part.trim().split(/\s+/).filter(Boolean);
            const url = bits[0] || '';
            const descriptor = bits[1] || '';
            let score = 0;
            if (/^\d+w$/i.test(descriptor)) score = parseInt(descriptor, 10) || 0;
            else if (/^\d+(\.\d+)?x$/i.test(descriptor)) score = Math.round((parseFloat(descriptor) || 0) * 1000);
            return { url, score };
        })
        .filter(function (entry) { return !!entry.url; })
        .sort(function (a, b) { return b.score - a.score; })
        .map(function (entry) { return entry.url; });
}

function collectSelectorImages($, selectors, out) {
    for (const [selector, attr] of selectors || []) {
        const raw = $(selector).first().attr(attr);
        if (!raw) continue;
        const value = attr === 'srcset' ? parseSrcsetCandidate(raw) : raw;
        if (value) out.push(value);
    }
}

function collectDynamicImages($, selectors, pageUrl, out) {
    for (const [selector, attr] of selectors || []) {
        const raw = $(selector).first().attr(attr);
        const image = extractDynamicImageMap(raw, pageUrl);
        if (image) out.push(image);
    }
}

function collectDomImageCandidates($, out) {
    const ranked = [];
    $('img, source').each(function () {
        const el = $(this);
        const attrs = [
            'data-old-hires',
            'data-zoom-image',
            'data-large-image',
            'data-src',
            'data-lazy-src',
            'data-original',
            'data-image',
            'data-srcset',
            'srcset',
            'src',
        ];

        const width = parseInt(el.attr('width') || '0', 10) || 0;
        const height = parseInt(el.attr('height') || '0', 10) || 0;
        const area = width * height;
        const cls = String(el.attr('class') || '').toLowerCase();
        const id = String(el.attr('id') || '').toLowerCase();
        const alt = String(el.attr('alt') || '').toLowerCase();
        const roleBoost =
            (/(hero|main|primary|product|gallery|media|image)/.test(cls) ? 2000 : 0) +
            (/(hero|main|primary|product|gallery|media|image)/.test(id) ? 2000 : 0) +
            (/(product|main)/.test(alt) ? 500 : 0);

        attrs.forEach(function (attr) {
            const raw = el.attr(attr);
            if (!raw) return;
            const urls = /srcset$/i.test(attr) ? parseSrcsetCandidates(raw) : [raw];
            urls.forEach(function (url, index) {
                ranked.push({
                    url,
                    score: area + roleBoost - index,
                });
            });
        });
    });

    ranked
        .sort(function (a, b) { return b.score - a.score; })
        .forEach(function (entry) { out.push(entry.url); });
}

function uniqueImages(candidates, baseUrl, limit = 24) {
    const out = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const absolute = absolutizeUrl(candidate, baseUrl);
        if (!absolute || isJunkImage(absolute) || seen.has(absolute)) continue;
        seen.add(absolute);
        out.push(absolute);
        if (out.length >= limit) break;
    }
    return out;
}

async function resolveBestImage(candidates, { referer, minBytes = 0 } = {}) {
    const tried = uniqueImages(candidates, referer || undefined, 24);
    for (const candidate of tried) {
        let normalized = await fetchAndStoreImage(candidate, { referer, minBytes, folder: 'meta/links' });
        if (!normalized) normalized = await fetchImageViaScraperAPIProxy(candidate);
        if (normalized) return { image: normalized, candidates: tried };
    }
    return { image: tried[0] || null, candidates: tried };
}

function findMarketplaceAdapter(pageUrl) {
    const hostname = hostnameFromUrl(pageUrl);
    return MARKETPLACE_ADAPTERS.find(function (adapter) {
        return domainMatches(hostname, adapter.domains);
    }) || null;
}

function collectJsonLdData($) {
    const parsed = [];
    $('script[type="application/ld+json"]').each(function () {
        const raw = $(this).contents().text().trim();
        if (!raw) return;
        const value = parseJsonObject(raw);
        if (value) parsed.push(value);
    });
    return parsed;
}

function collectNames(value, out) {
    if (!value) return;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) out.push(trimmed);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(function (item) { collectNames(item, out); });
        return;
    }
    if (typeof value === 'object') {
        if (typeof value.name === 'string' && value.name.trim()) out.push(value.name.trim());
        if (value['@graph']) collectNames(value['@graph'], out);
    }
}

function extractGenericMeta($) {
    const m = (prop, attr = 'property') =>
        $(`meta[${attr}="${prop}"]`).attr('content') || null;
    return {
        titleCandidates: [
            m('og:title'),
            m('twitter:title', 'name'),
            $('meta[name="title"]').attr('content'),
            $('h1').first().text().trim(),
            $('title').first().text().trim(),
        ].filter(Boolean),
        imageCandidates: [
            m('og:image'),
            m('og:image:url'),
            m('twitter:image', 'name'),
            m('twitter:image:src', 'name'),
            $('meta[itemprop="image"]').attr('content'),
            $('link[rel="image_src"]').attr('href'),
        ].filter(Boolean),
    };
}

function cleanTitle(t) {
    if (!t) return t;
    // Strip non-breaking spaces, zero-width chars, and LTR/RTL marks that survive .trim()
    return t.replace(/[\u00a0\u200b-\u200f\u202a-\u202e\u2060-\u2063\ufeff]/g, ' ').trim().replace(/\s+/g, ' ') || null;
}

function collectJsonLdProductNames(blocks) {
    const names = [];
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        const type = node['@type'];
        if ((type === 'Product' || type === 'ProductGroup') && typeof node.name === 'string') {
            const n = cleanTitle(node.name);
            if (n) names.push(n);
        }
        if (node['@graph']) visit(node['@graph']);
    }
    blocks.forEach(visit);
    return names;
}

// Scan all inline <script> tags for CDN image URLs embedded in JSON data (e.g. Shein's __NEXT_DATA__).
function extractScriptEmbeddedImages($, pageUrl) {
    const CDN_PATTERN = /https?:\/\/(?:img\.ltwebstatic\.com|img\.kwcdn\.com|img\.temu\.com)[^\s"'<>]+\.(?:webp|jpe?g|png|avif)/gi;
    const seen = new Set();
    const results = [];
    $('script').each(function () {
        let text = $(this).html() || '';
        if (!text.includes('ltwebstatic') && !text.includes('kwcdn') && !text.includes('temu')) return;
        // Normalize JSON-escaped slashes (\/) and unicode escapes (\u002F) before scanning
        text = text.replace(/\\u002[Ff]/g, '/').replace(/\\\//g, '/');
        let m;
        CDN_PATTERN.lastIndex = 0;
        while ((m = CDN_PATTERN.exec(text)) !== null) {
            const url = m[0];
            if (!seen.has(url)) { seen.add(url); results.push(url); }
        }
    });
    // Sort: product image paths first (spmp, plain /images3/), deprioritize known non-product paths
    results.sort(function (a, b) {
        function score(u) {
            if (u.includes('/spmp/') || u.includes('images3_spmp')) return 0;
            if (u.includes('/images3/')) return 1;
            return 2; // _ccc, _acp, or unknown suffixes
        }
        return score(a) - score(b);
    });
    return results;
}

function extractOG(html, pageUrl) {
    const $ = cheerio.load(html);
    const generic = extractGenericMeta($);
    const adapter = findMarketplaceAdapter(pageUrl);
    const titleCandidates = generic.titleCandidates.map(cleanTitle).filter(Boolean);
    const imageCandidates = generic.imageCandidates.slice();
    const jsonLdBlocks = collectJsonLdData($);

    const jsonLdProductNames = collectJsonLdProductNames(jsonLdBlocks);

    const jsonLdNames = [];
    jsonLdBlocks.forEach(function (parsed) {
        collectNames(parsed, jsonLdNames);
        collectImageCandidates(parsed, imageCandidates);
    });

    if (adapter) {
        const adapterTitle = cleanTitle(firstNonEmptyText($, adapter.titleSelectors));
        // Adapter DOM selector wins; JSON-LD Product.name is second for marketplace pages
        if (adapterTitle) {
            titleCandidates.unshift(adapterTitle);
        } else if (jsonLdProductNames.length) {
            titleCandidates.unshift(jsonLdProductNames[0]);
        }
        // Adapter DOM images take priority over OG tags (OG often points to blocked CDN)
        const adapterImages = [];
        collectSelectorImages($, adapter.imageSelectors, adapterImages);
        collectDynamicImages($, adapter.dynamicImageAttrs, pageUrl, adapterImages);
        imageCandidates.unshift(...adapterImages);
    }

    collectDomImageCandidates($, imageCandidates);

    let title = titleCandidates.find(Boolean) || jsonLdProductNames.find(Boolean) || jsonLdNames.map(cleanTitle).find(Boolean) || null;

    // When scraping returned a generic site-level title (e.g. Shein/Temu homepage OG tag
    // instead of the product), fall back to the product name embedded in the URL slug.
    if (isGenericTitle(title) && adapter) {
        title = slugTitleFromUrl(pageUrl) || title;
    }

    const image = pickFirstValidImage(imageCandidates, pageUrl);

    // For marketplace pages: always mine script tags for CDN image URLs (e.g. __NEXT_DATA__)
    const scriptImages = adapter ? extractScriptEmbeddedImages($, pageUrl) : [];
    if (scriptImages.length) console.log('[meta] script-embedded images found:', scriptImages.length, scriptImages.map(u => u.slice(0, 100)));

    const allImages = uniqueImages([...imageCandidates, ...scriptImages], pageUrl, 24);

    return { title, image, allImages };
}

// Scrape OG/meta tags from a URL — returns { title, image } for link auto-fill.
app.get('/api/meta', requireAuth, async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!metaMinuteCheck(String(req.user._id))) return res.status(429).json({ error: 'rate_minute' });
    const daily = await metaDailyCheck(String(req.user._id));
    if (!daily.ok) return res.status(429).json({ error: 'rate_daily', used: daily.used, limit: daily.limit });

    const usage = { used: daily.used, limit: daily.limit };
    const normalizedUrl = normalizeMetaUrl(url);

    // JS-rendered domains: use ScraperAPI (rendered HTML).
    if (needsRender(normalizedUrl)) {
        const resolvedUrl = await resolveUrl(normalizedUrl);
        console.log('[meta] normalized URL:', normalizedUrl);
        console.log('[meta] needsRender — resolved:', resolvedUrl);

        // Shein: try internal product API first. If it fails, return slug title + no image —
        // Shein: try internal API first, then Zyte (CF-bypass renderer), then slug title fallback.
        const isShein = domainMatches(hostnameFromUrl(normalizedUrl), ['shein.com']);
        if (isShein) {
            const sheinData = await fetchSheinProduct(resolvedUrl);
            const imgOpts = { referer: resolvedUrl, minBytes: 5120 };

            if (sheinData?.images?.length) {
                const title = sheinData.title || slugTitleFromUrl(resolvedUrl) || null;
                const { image: normalizedImage, candidates } = await resolveBestImage(sheinData.images, imgOpts);
                if (normalizedImage) console.log('[meta] Shein API image resolved');
                return res.json({ title, image: normalizedImage, images: candidates.slice(0, 8), usage });
            }

            console.log('[meta] Shein: product images unavailable via server-side scraping � returning title only');
            return res.json(sheinTitleOnlyMeta(
                resolvedUrl,
                usage,
                sheinData?.title || null,
                { imageAttemptsSkipped: true }
            ));
        }

        try {
            const html = await fetchViaScraperAPI(resolvedUrl);
            console.log('[meta] ScraperAPI html length:', html ? html.length : 'null');
            if (html && !isCloudflareChallengeHtml(html)) {
                const { title, image, allImages } = extractOG(html, resolvedUrl);
                console.log('[meta] extractOG raw ->', { title, image, candidateCount: allImages.length });
                const imgOpts = { referer: resolvedUrl, minBytes: 5120 };
                const { image: normalizedImage, candidates } = await resolveBestImage(allImages.length ? allImages : [image], imgOpts);
                console.log('[meta] normalizedImage ->', normalizedImage ? normalizedImage.slice(0, 60) : null);
                const images = candidates.slice(0, 8);
                const resolvedTitle = !isGenericTitle(title) ? title : null;
                return res.json({ title: resolvedTitle || (isGenericTitle(title) ? null : title), image: normalizedImage, images, usage });
            }
        } catch (e) { console.error('[meta] ScraperAPI threw:', e.message); }
        return res.json({ title: slugTitleFromUrl(normalizedUrl) || null, image: null, images: [], usage });
    }

    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 10000);
        const upstream = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
            },
            redirect: 'follow',
        });
        if (!upstream.ok) return res.json({ title: null, image: null, images: [], usage });
        const html = await upstream.text();
        const { title, image, allImages } = extractOG(html, normalizedUrl);
        const { image: normalizedImage, candidates } = await resolveBestImage(allImages.length ? allImages : [image], {
            referer: normalizedUrl,
            minBytes: 2048,
        });

        res.json({ title: title || null, image: normalizedImage, images: candidates.slice(0, 8), usage });
    } catch {
        res.json({ title: null, image: null, images: [], usage });
    }
});

// Proxy an image URL through the server (auth required) — used by the image picker.
// Returns raw image binary so it can be used directly as <img src="/api/img-proxy?url=...">.
app.get('/api/img-proxy', requireAuth, async (req, res) => {
    const { url, referer } = req.query;
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).end();
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 10000);
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': referer ? 'cross-site' : 'none',
        };
        if (referer) { headers['Referer'] = referer; try { headers['Origin'] = new URL(referer).origin; } catch {} }
        const upstream = await fetch(url, { signal: ctrl.signal, headers, redirect: 'follow' });
        if (!upstream.ok) return res.status(502).end();
        const type = (upstream.headers.get('content-type') || '').split(';')[0].trim();
        if (!ALLOWED_LINK_IMG_MIME.has(type)) return res.status(422).end();
        const buf = await upstream.arrayBuffer();
        res.set('Content-Type', type);
        res.set('Cache-Control', 'private, max-age=300');
        res.send(Buffer.from(buf));
    } catch {
        res.status(502).end();
    }
});

// Purchase extra daily meta fetches with JWL credits (2 JWL each).
app.get('/api/meta/usage', requireAuth, async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const doc   = await User.findById(req.user._id, { metaFetchDate: 1, metaFetchCount: 1, metaFetchBonus: 1, metaFetchLimit: 1 });
    const used  = (doc?.metaFetchDate === today ? (doc.metaFetchCount ?? 0) : 0);
    const base  = doc?.metaFetchLimit ?? META_DAILY_LIMIT;
    const limit = base + (doc?.metaFetchDate === today ? (doc.metaFetchBonus ?? 0) : 0);
    res.json({ used, limit });
});

app.post('/api/meta/topup', requireAuth, async (req, res) => {
    const fetches = parseInt(req.body?.fetches);
    if (!Number.isInteger(fetches) || fetches <= 0 || fetches > 500) {
        return res.status(400).json({ error: 'Invalid fetch count' });
    }
    const cost = fetches * META_FETCH_COST;
    const user = await User.findOneAndUpdate(
        { _id: req.user._id, credits: { $gte: cost } },
        { $inc: { credits: -cost } },
        { new: true }
    );
    if (!user) return res.status(402).json({ error: 'Insufficient balance' });
    const { limit, used } = await metaDailyAddBonus(String(req.user._id), fetches);
    res.json({ credits: user.credits, usage: { used, limit } });
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

app.post('/api/user/export', requireAuth, requireVerification, async (req, res) => {
    if (req.user.isAnonymous) return res.status(403).json({ error: 'Account required' });
    if (!req.user.email) return res.status(400).json({ error: 'No email address on file' });

    const EXPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const EXPORT_LIMIT = 2;
    const history = (req.user.preferences?.get?.('exportHistory') || [])
        .map(d => new Date(d).getTime())
        .filter(t => Date.now() - t < EXPORT_WINDOW_MS);
    if (history.length >= EXPORT_LIMIT) {
        return res.status(429).json({ error: 'You can request up to 2 exports per 7 days' });
    }

    history.push(Date.now());
    await User.updateOne({ _id: req.user._id }, { $set: { 'preferences.exportHistory': history } });
    res.json({ ok: true });

    // Background — no await
    (async () => {
        try {
            const [buckets, grabs, following] = await Promise.all([
                Bucket.find({ userId: req.user._id }).lean(),
                BucketAccess.find({ userId: req.user._id }).populate('bucketId', 'name description hashtags visibility createdAt').lean(),
                Subscription.find({ followerId: req.user._id }).populate('followeeId', 'username displayName').lean(),
            ]);

            const payload = {
                exportedAt: new Date().toISOString(),
                account: {
                    username:     req.user.username,
                    email:        req.user.email,
                    displayName:  req.user.displayName,
                    bio:          req.user.bio,
                    website:      req.user.website,
                    socialLinks:  req.user.socialLinks,
                    category:     req.user.category,
                    language:     req.user.language,
                    credits:      req.user.credits,
                    privacy:      req.user.privacy,
                    createdAt:    req.user.createdAt,
                },
                buckets: buckets.map(b => ({
                    name:        b.name,
                    description: b.description,
                    hashtags:    b.hashtags,
                    visibility:  b.visibility,
                    links:       b.links.map(l => ({ href: l.href, text: l.text, addedAt: l.addedAt })),
                    createdAt:   b.createdAt,
                })),
                grabs: grabs
                    .filter(g => g.bucketId)
                    .map(g => ({
                        bucketName:  g.bucketId.name,
                        description: g.bucketId.description,
                        hashtags:    g.bucketId.hashtags,
                        grabbedAt:   g.grantedAt,
                    })),
                following: following
                    .filter(s => s.followeeId)
                    .map(s => ({
                        username:    s.followeeId.username,
                        displayName: s.followeeId.displayName,
                    })),
            };

            const buffer = Buffer.from(JSON.stringify(payload, null, 2));
            const key = `exports/${req.user._id}-${Date.now()}.json`;
            const url = await uploadFileToR2(buffer, key, 'application/json');
            await sendDataExportEmail(req.user.email, url);
        } catch (err) {
            console.error('[export] failed for user', req.user._id, err.message);
        }
    })();
});

// Cascade-erase all personal data for a user. Called by both the GDPR erasure
// and full account deletion routes.
async function eraseUserData(userId) {
    const convs = await Conversation.find({ participants: userId }, '_id').lean();
    const convIds = convs.map(c => c._id);

    await Promise.all([
        // Content
        Bucket.deleteMany({ userId }),
        Link.deleteMany({ userId }),
        BucketAccess.deleteMany({ userId }),
        // Social
        Subscription.deleteMany({ $or: [{ followerId: userId }, { followeeId: userId }] }),
        Block.deleteMany({ $or: [{ blockerId: userId }, { blockedId: userId }] }),
        // Comments & agreements
        BucketComment.updateMany({ userId }, { $set: { deletedAt: new Date(), body: '[deleted]', username: '', avatar: '' } }),
        CommentAgreement.deleteMany({ userId }),
        // Messaging
        DirectMessage.deleteMany({ conversationId: { $in: convIds } }),
        Conversation.deleteMany({ participants: userId }),
        // Notifications
        Notification.deleteMany({ userId }),
        // Activity / analytics
        BucketView.deleteMany({ userId }),
        BucketSkip.deleteMany({ userId }),
        BucketRating.deleteMany({ userId }),
        BucketShare.deleteMany({ userId }),
        FeedImpression.deleteMany({ userId }),
        LinkClick.deleteMany({ userId }),
        UserRepo.deleteMany({ userId }),
        RepoSkip.deleteMany({ userId }),
        // Admin / misc
        Report.deleteMany({ reporterId: userId }),
        PartnerApplication.deleteMany({ userId }),
    ]);
}

// DELETE /api/user/data — GDPR right to erasure.
// Deletes all personal data and content then anonymises the account shell.
// The user document is kept but stripped of all PII so it cannot be linked back.
app.delete('/api/user/data', requireAuth, async (req, res) => {
    if (req.user.isAnonymous) return res.status(403).json({ error: 'Account required' });
    const { confirm } = req.body;
    if (confirm !== 'DELETE') return res.status(400).json({ error: 'Confirmation required' });

    try {
        await eraseUserData(req.user._id);

        await User.updateOne({ _id: req.user._id }, {
            $set: {
                isAnonymous:   true,
                email:         undefined,
                googleId:      undefined,
                password:      undefined,
                username:      undefined,
                displayName:   '',
                bio:           '',
                avatar:        '',
                website:       '',
                socialLinks:   [],
                bookmarkletToken: undefined,
                preferences:   {},
                credits:       0,
            },
            $unset: {
                email: '', googleId: '', password: '', username: '', bookmarkletToken: '',
                resetPasswordToken: '', resetPasswordExpires: '',
                otpCode: '', otpExpires: '', otpSentAt: '',
            },
        });

        res.clearCookie('sessionId');
        res.clearCookie('_accts');
        res.json({ ok: true });
    } catch (err) {
        console.error('[delete-data] error:', err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

// DELETE /api/user/account — soft-delete with 90-day reactivation window.
// Data is preserved until the user explicitly requests erasure (GDPR).
app.delete('/api/user/account', requireAuth, async (req, res) => {
    if (req.user.isAnonymous) return res.status(403).json({ error: 'Account required' });
    const { confirm } = req.body;
    if (confirm !== 'DELETE') return res.status(400).json({ error: 'Confirmation required' });

    try {
        const email = req.user.email;
        await User.updateOne({ _id: req.user._id }, { $set: { deletedAt: new Date() } });

        res.clearCookie('sessionId');
        res.clearCookie('_accts');
        res.json({ ok: true });

        // Send final email in background
        sendAccountDeletionEmail(email).catch(err =>
            console.error('[delete-account] email failed:', err.message)
        );
    } catch (err) {
        console.error('[delete-account] error:', err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

app.patch('/api/user/settings', requireAuth, requireVerification, async (req, res) => {
    try {
        const { isMatureGated, showActivityStatus, showGrabbedBuckets, whoCanMessage, accountVisibility } = req.body;
        const update = {};
        if (isMatureGated !== undefined) update.isMatureGated = !!isMatureGated;
        if (showActivityStatus  !== undefined) update['privacy.showActivityStatus']  = !!showActivityStatus;
        if (showGrabbedBuckets !== undefined) update['privacy.showGrabbedBuckets'] = !!showGrabbedBuckets;
        if (whoCanMessage !== undefined) {
            const VALID_WCM = new Set(['no_one', 'people_i_follow', 'people_who_follow_me', 'same_category', 'everyone']);
            const values = Array.isArray(whoCanMessage) ? whoCanMessage : [whoCanMessage];
            if (!values.length || values.some(v => !VALID_WCM.has(v)))
                return res.status(400).json({ error: 'Invalid whoCanMessage value' });
            update['privacy.whoCanMessage'] = values;
        }
        if (accountVisibility !== undefined) {
            if (!['public', 'unlisted', 'private'].includes(accountVisibility))
                return res.status(400).json({ error: 'Invalid accountVisibility value' });
            update['privacy.accountVisibility'] = accountVisibility;
        }
        if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No valid fields provided' });
        await User.findByIdAndUpdate(req.user._id, update);
        res.json({ ok: true });
    } catch (err) {
        console.error('Settings update error:', err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// Get all buckets for current user (NO Singletons returned)
app.get('/api/buckets', requireAuth, requireVerification, async (req, res) => {
    try {
        const buckets = await Bucket.find({ userId: req.user._id })
            .select('name')
            .sort({ order: 1, createdAt: 1 })
            .lean();

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
        const { name, description, tags, visibility, monetized, price, mature, sourceUrl, thumbnail, links, draft, repoIds } = req.body;

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

        // Validate repoIds belong to this user
        let resolvedRepoIds = [];
        if (Array.isArray(repoIds) && repoIds.length > 0) {
            const validIds = repoIds.filter(id => mongoose.Types.ObjectId.isValid(id));
            const repos = await UserRepo.find({ _id: { $in: validIds }, userId: req.user._id }).select('_id');
            resolvedRepoIds = repos.map(r => r._id);
        }

        const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'private';

        // Create bucket first so we have its ID for scoped R2 paths
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
            isDraft:     !!draft,
            repoIds:     resolvedRepoIds,
        });

        const bucketId = String(bucket._id);
        const resolvedLinks = Array.isArray(links) ? await Promise.all(links.map(async l => ({
            href:     l.url   || '',
            text:     l.title || '',
            isFree:   !l.monetized,
            isPinned: !!l.pinned,
            image:    await fetchAndStoreImage(l.thumb || null, { folder: `buckets/${bucketId}/links` }) ?? l.thumb ?? null,
        }))) : [];

        const resolvedThumb = await fetchAndStoreImage(thumbnail || null, { folder: `buckets/${bucketId}/thumbnail` }) || '';
        const effectiveThumb = resolvedThumb || resolvedLinks.find(l => l.image)?.image || '';

        bucket.links     = resolvedLinks;
        bucket.thumbnail = effectiveThumb;
        await bucket.save();

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
        const { name, description, tags, visibility, monetized, price, mature, sourceUrl, thumbnail, links, isDraft, repoIds, removeRepoId, addRepoIds } = req.body;

        // Fetch current state to detect meaningful changes before building the update
        const current = await Bucket.findOne({ _id: req.params.id, userId: req.user._id });
        if (!current) return res.status(404).json({ error: 'Bucket not found' });

        const update = {};
        if (name        !== undefined) update.name        = name;
        if (description !== undefined) update.description = String(description || '').slice(0, 256);
        if (tags        !== undefined) update.hashtags    = Array.isArray(tags) ? tags.slice(0, 8) : [];
        if (mature      !== undefined) update.mature      = !!mature;
        if (repoIds !== undefined) {
            if (!Array.isArray(repoIds) || repoIds.length === 0) {
                update.repoIds = [];
            } else {
                const validIds = repoIds.filter(id => mongoose.Types.ObjectId.isValid(id));
                const repos = await UserRepo.find({ _id: { $in: validIds }, userId: req.user._id }).select('_id');
                update.repoIds = repos.map(r => r._id);
            }
        }
        if (removeRepoId && mongoose.Types.ObjectId.isValid(removeRepoId)) {
            update.repoIds = (current.repoIds || []).filter(id => String(id) !== String(removeRepoId));
        }
        if (Array.isArray(addRepoIds) && addRepoIds.length > 0) {
            const validIds = addRepoIds.filter(id => mongoose.Types.ObjectId.isValid(id));
            const repos = await UserRepo.find({ _id: { $in: validIds }, userId: req.user._id }).select('_id');
            const newIds = repos.map(r => String(r._id));
            const existingIds = (current.repoIds || []).map(id => String(id));
            update.repoIds = [...new Set([...existingIds, ...newIds])];
        }
        if (visibility !== undefined) {
            const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'private';
            update.visibility = vis;
            update.isPublic   = vis === 'public';
        }
        if (monetized   !== undefined) update.isPaywalled = !!monetized;
        if (price       !== undefined) update.price       = Number(price) || 0;
        if (sourceUrl   !== undefined) update.sourceUrl   = sourceUrl || '';
        const bId = String(req.params.id);
        if (thumbnail   !== undefined) update.thumbnail   = await fetchAndStoreImage(thumbnail || null, { folder: `buckets/${bId}/thumbnail` }) || '';
        if (links       !== undefined) {
            if (links.length > 256) return res.status(400).json({ error: 'A bucket cannot have more than 256 links' });
            if (links.length > 0) {
                const urls = links.map(l => l.url || '');
                const { ok, blocked } = await validateLinks(urls);
                if (!ok) return res.status(400).json({ error: 'One or more links were rejected for safety reasons', blocked });
            }
            update.links = await Promise.all(links.map(async l => ({
                href:       l.url   || '',
                text:       l.title || '',
                isFree:     !l.monetized,
                isPinned:   !!l.pinned,
                isArchived: !!l.archived,
                // Fall back to the original URL if base64 conversion fails — never wipe a thumbnail
                image:      await fetchAndStoreImage(l.thumb || null, { folder: `buckets/${bId}/links` }) ?? l.thumb ?? null,
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
                { $match: { userId: req.user._id, repoIds: { $exists: true, $ne: [] } } },
                { $unwind: '$repoIds' },
                { $group: { _id: '$repoIds', count: { $sum: 1 } } },
            ]),
            // First non-empty thumbnail per repo (oldest bucket first)
            Bucket.aggregate([
                { $match: { userId: req.user._id, repoIds: { $exists: true, $ne: [] }, thumbnail: { $nin: [null, ''] } } },
                { $sort: { createdAt: 1 } },
                { $unwind: '$repoIds' },
                { $group: { _id: '$repoIds', thumb: { $first: '$thumbnail' } } },
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
        await Bucket.updateMany({ userId: req.user._id, repoIds: repo._id }, { $pull: { repoIds: repo._id } });
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
        const drafts = await Bucket.find({ userId: req.user._id, isDraft: true }).select('thumbnail links.image');
        await Bucket.deleteMany({ userId: req.user._id, isDraft: true });
        const imageUrls = drafts.flatMap(b => [b.thumbnail, ...b.links.map(l => l.image)]).filter(Boolean);
        await deleteR2Images(imageUrls);
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

        const bucket = await Bucket.findOneAndDelete({
            userId: req.user._id,
            name
        });

        if (bucket) {
            const imageUrls = [bucket.thumbnail, ...bucket.links.map(l => l.image)].filter(Boolean);
            await deleteR2Images(imageUrls);
        }

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
        const removedLink = bucket.links.find(link => link.href === href);
        bucket.links = bucket.links.filter(link => link.href !== href);

        if (bucket.links.length === initialLength) {
            return res.status(404).json({ error: 'Link not found in bucket' });
        }

        // Save the updated bucket
        await bucket.save();

        if (removedLink?.image) await deleteR2Images([removedLink.image]);

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

        const bucketDoc = await Bucket.findOne({ userId: req.user._id, name }).select('_id');
        if (!bucketDoc) return res.status(404).json({ error: 'Bucket not found' });

        const storedThumbnail = await fetchAndStoreImage(thumbnail || null, { folder: `buckets/${bucketDoc._id}/thumbnail` }) || '';
        const bucket = await Bucket.findByIdAndUpdate(
            bucketDoc._id,
            { thumbnail: storedThumbnail },
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
    const inc = source === 'explore'
        ? { viewCount: 1 }
        : source === 'showroom'
            ? { viewCount: 1, showroomViewCount: 1 }
            : { viewCount: 1, directViewCount: 1 };
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
        const validReasons = ['spam', 'malicious', 'inappropriate', 'copyright', 'mature_content', 'other'];

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

// Report a user
app.post('/api/users/:userId/report', requireAuth, requireVerification, async (req, res) => {
    try {
        const { reason, detail } = req.body;
        const validReasons = ['spam', 'malicious', 'inappropriate', 'harassment', 'other'];
        if (!reason || !validReasons.includes(reason))
            return res.status(400).json({ error: 'Invalid report reason' });

        if (!mongoose.Types.ObjectId.isValid(req.params.userId))
            return res.status(400).json({ error: 'Invalid user ID' });

        const target = await User.findById(req.params.userId);
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (target._id.equals(req.user._id))
            return res.status(403).json({ error: 'Cannot report yourself' });

        await Report.create({
            reporterId:     req.user._id,
            reportedUserId: target._id,
            reason,
            detail: detail ? String(detail).slice(0, 500) : '',
        });

        res.json({ success: true });
    } catch (err) {
        if (err.code === 11000)
            return res.status(409).json({ error: 'You have already reported this user' });
        console.error('Error reporting user:', err);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// Return paginated link data for a single owned bucket (used by the edit modal)
app.get('/api/buckets/:id/links', requireAuth, requireVerification, async (req, res) => {
    try {
        const skip  = Math.max(0, parseInt(req.query.skip)  || 0);
        const limit = Math.min(256, Math.max(1, parseInt(req.query.limit) || 256));
        const [result] = await Bucket.aggregate([
            { $match: { _id: new mongoose.Types.ObjectId(req.params.id), userId: req.user._id } },
            { $project: { total: { $size: '$links' }, links: { $slice: ['$links', skip, limit] } } },
        ]);
        if (!result) return res.status(404).json({ error: 'Not found' });
        const links = result.links || [];
        res.json({ links, total: result.total || 0, hasMore: skip + links.length < result.total });
    } catch (err) {
        console.error('Error fetching bucket links:', err);
        res.status(500).json({ error: 'Failed to fetch links' });
    }
});

// Get all links for current user
app.get('/api/links', requireAuth, requireVerification, async (req, res) => {
    try {
        const buckets = await Bucket.find({ userId: req.user._id })
            .select('name sourceUrl links.href links.text links.image links.duration links.isFree links.clickCount links.isPinned')
            .lean();

        const linksMap = new Map();
        buckets.forEach(bucket => {
            (bucket.links || []).forEach(link => {
                const key = link.href;
                if (!linksMap.has(key)) {
                    linksMap.set(key, {
                        href: link.href,
                        text: link.text,
                        image: link.image || null,
                        duration: link.duration,
                        isFree: link.isFree || false,
                        clickCount: link.clickCount || 0,
                        isPinned: link.isPinned || false,
                        sourceUrl: bucket.sourceUrl || '',
                        buckets: [bucket.name],
                    });
                } else {
                    linksMap.get(key).buckets.push(bucket.name);
                }
            });
        });

        res.json(Array.from(linksMap.values()));
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
                        image:    await fetchAndStoreImage(link.image || null, { folder: `buckets/${bucket._id}/links` }) ?? (link.image?.startsWith('http') ? link.image : null),
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
        const buckets = await Bucket.find({ userId: req.user._id }).select('thumbnail links.image');
        await Bucket.deleteMany({ userId: req.user._id });
        const imageUrls = buckets.flatMap(b => [b.thumbnail, ...b.links.map(l => l.image)]).filter(Boolean);
        await deleteR2Images(imageUrls);
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
            .populate('userId', 'username anonymousId avatar privacy')
            .select('name thumbnail links isPaywalled price viewCount shareCount ratingSum ratingCount createdAt updatedAt userId grabbedBy description hashtags exploreScore')
            .lean();

        // Strip buckets from private/unlisted accounts before further processing
        const visibleCandidates = candidates.filter(b => !['private', 'unlisted'].includes(b.userId?.privacy?.accountVisibility));

        // Phase 2: filter out buckets already shown to this user in the last 2h,
        // and buckets the user has explicitly skipped (never show again).
        const impressionFilter = req.user?._id
            ? { userId: req.user._id }
            : req.user?.anonymousId
                ? { anonymousId: req.user.anonymousId }
                : null;

        const clientExcluded = new Set(excludeIds.map(String));

        let unseenCandidates = visibleCandidates;
        if (impressionFilter) {
            const [seen, skipped] = await Promise.all([
                FeedImpression.find(impressionFilter).select('bucketId').lean(),
                req.user?._id
                    ? BucketSkip.find({ userId: req.user._id }).select('bucketId').lean()
                    : Promise.resolve([])
            ]);
            const seenIds    = new Set(seen.map(i => String(i.bucketId)));
            const skippedIds = new Set(skipped.map(s => String(s.bucketId)));
            unseenCandidates = visibleCandidates.filter(b =>
                !seenIds.has(String(b._id)) && !skippedIds.has(String(b._id)) && !clientExcluded.has(String(b._id))
            );
        } else if (clientExcluded.size) {
            unseenCandidates = visibleCandidates.filter(b => !clientExcluded.has(String(b._id)));
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
            .populate('userId', 'username anonymousId avatar privacy')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const visibleBuckets = buckets.filter(b => !['private', 'unlisted'].includes(b.userId?.privacy?.accountVisibility));
        const grabbedSet = await buildGrabbedSet(visibleBuckets, req.user?._id);
        res.json({ buckets: formatExploreRow(visibleBuckets, grabbedSet) });
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
            .populate('userId', 'username anonymousId avatar privacy')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const visibleBuckets = buckets.filter(b => !['private', 'unlisted'].includes(b.userId?.privacy?.accountVisibility));
        const grabbedSet = await buildGrabbedSet(visibleBuckets, req.user?._id);
        res.json({ buckets: formatExploreRow(visibleBuckets, grabbedSet) });
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
            .populate('userId', 'username anonymousId avatar privacy')
            .select(EXPLORE_ROW_SELECT)
            .lean();

        const visibleBuckets = buckets.filter(b => !['private', 'unlisted'].includes(b.userId?.privacy?.accountVisibility));
        const grabbedSet = await buildGrabbedSet(visibleBuckets, req.user?._id);
        res.json({ buckets: formatExploreRow(visibleBuckets, grabbedSet) });
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
        if (req.user.privacy?.accountVisibility === 'private')
            return res.status(403).json({ error: 'Private accounts cannot follow others' });

        const curator = await User.findOne({ anonymousId: req.params.anonymousId });
        if (!curator) return res.status(404).json({ error: 'Curator not found' });
        if (curator._id.equals(req.user._id)) return res.status(400).json({ error: 'Cannot subscribe to yourself' });
        if (curator.privacy?.accountVisibility === 'private')
            return res.status(403).json({ error: 'Cannot follow a private account' });

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
    { path: '/showroom',       view: 'showroom',        title: 'Show Room',       page: 'home'          },
    { path: '/explore',        view: 'explore',         title: 'Explore',         page: 'explore'       },
    { path: '/transactions',   view: 'transactions',    title: 'Transactions',    page: 'transactions'  },
    // /settings is handled below (redirect + per-section routes)
    { path: '/docs',           view: 'docs',            title: 'Docs',            page: 'docs'          },
    { path: '/faq',            view: 'faq',             title: 'FAQ',             page: 'faq'           },
    { path: '/contact',        view: 'contact',         title: 'Contact',         page: 'contact'       },
    { path: '/login',          view: 'login',           title: 'Log In',          page: 'login'         },
    { path: '/signup',         view: 'signup',          title: 'Sign Up',         page: 'signup'        },
    { path: '/reset-password', view: 'reset-password',  title: 'Reset Password',  page: 'reset-password'},
    { path: '/topup',          view: 'topup',           title: 'Top Up Credits',  page: 'topup'         },
    { path: '/partnership',    view: 'partnership',     title: 'Partner Program', page: 'partnership'   },
];

for (const { path: routePath, view, title, page } of appPages) {
    app.get(routePath, anonymousAuth, requireNonAdmin, (req, res) => {
        res.render(view, { title, page, user: req.user ?? null });
    });
}

// Settings — redirect root + per-section routes
app.get('/settings', anonymousAuth, requireNonAdmin, (req, res) => {
    res.redirect('/settings/account');
});

const SETTINGS_SECTIONS = [
    { section: 'account',       title: 'Account'       },
    { section: 'privacy',       title: 'Privacy'       },
    { section: 'content',       title: 'Content'       },
    { section: 'notifications', title: 'Notifications' },
    { section: 'monetization',  title: 'Monetization'  },
    { section: 'integrations',  title: 'Integrations'  },
    { section: 'danger',        title: 'Danger Zone'   },
];

for (const { section, title } of SETTINGS_SECTIONS) {
    app.get(`/settings/${section}`, anonymousAuth, requireNonAdmin, (req, res) => {
        res.render(`settings-${section}`, { title, page: 'settings', settingsSection: section, user: req.user ?? null });
    });
}

const USERNAME_LIMITS = [
    { count: 2, windowMs: 24 * 60 * 60 * 1000,      label: 'daily'   },
    { count: 3, windowMs: 7  * 24 * 60 * 60 * 1000, label: 'weekly'  },
    { count: 4, windowMs: 30 * 24 * 60 * 60 * 1000, label: 'monthly' },
];

// Returns { blocked: true, availableAt: Date } or { blocked: false }
function checkUsernameRateLimit(user) {
    const now = Date.now();
    const log = (user.usernameChangeLog || []).map(d => new Date(d).getTime());
    for (const { count, windowMs } of USERNAME_LIMITS) {
        const inWindow = log.filter(t => now - t < windowMs).sort((a, b) => a - b);
        if (inWindow.length >= count) {
            return { blocked: true, availableAt: new Date(inWindow[0] + windowMs) };
        }
    }
    return { blocked: false };
}


// PATCH /api/user/username
app.patch('/api/user/username', requireAuth, async (req, res) => {
    try {
        const { username } = req.body;
        if (!username?.trim()) return res.status(400).json({ error: 'Username is required' });
        const trimmed = username.trim();
        if (trimmed.length < 3 || trimmed.length > 20) return res.status(400).json({ error: 'Username must be 3–20 characters' });
        if (!/^[a-zA-Z0-9]+$/.test(trimmed)) return res.status(400).json({ error: 'Username may only contain letters and numbers' });
        if (trimmed.toLowerCase() === req.user.username?.toLowerCase()) return res.status(400).json({ error: 'This is already your username' });
        const rateLimit = checkUsernameRateLimit(req.user);
        if (rateLimit.blocked) {
            const formatted = rateLimit.availableAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            return res.status(429).json({ error: `You've hit a username change limit. Try again on ${formatted}.` });
        }
        const isAdmin = ['moderator', 'superadmin'].includes(req.user.role);
        const roleFilter = isAdmin ? { role: { $in: ['moderator', 'superadmin'] } } : { role: 'user' };
        const taken = await User.findOne({ username: new RegExp(`^${trimmed}$`, 'i'), _id: { $ne: req.user._id }, ...roleFilter });
        if (taken) return res.status(409).json({ error: 'This username is already taken' });
        const now = new Date();
        const pruned = (req.user.usernameChangeLog || []).filter(d => now - new Date(d).getTime() < 30 * 24 * 60 * 60 * 1000);
        pruned.push(now);
        await User.findByIdAndUpdate(req.user._id, { username: trimmed, usernameChangeLog: pruned });
        res.json({ ok: true, username: trimmed });
    } catch (err) {
        console.error('Username update error:', err);
        res.status(500).json({ error: 'Failed to update username' });
    }
});

// PATCH /api/user/password
app.patch('/api/user/password', requireAuth, requireVerification, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required' });
        const user = await User.findById(req.user._id).select('+password');
        if (!user) return res.status(404).json({ error: 'User not found' });
        const valid = await user.comparePassword(currentPassword);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        if ((newPassword.match(/[a-z]/g) || []).length < 2) return res.status(400).json({ error: 'Password must contain at least 2 lowercase letters' });
        if ((newPassword.match(/[A-Z]/g) || []).length < 2) return res.status(400).json({ error: 'Password must contain at least 2 uppercase letters' });
        if ((newPassword.match(/[0-9]/g) || []).length < 2) return res.status(400).json({ error: 'Password must contain at least 2 digits' });
        if ((newPassword.match(/[^a-zA-Z0-9]/g) || []).length < 2) return res.status(400).json({ error: 'Password must contain at least 2 special characters' });
        user.password = newPassword;
        user.passwordChangedAt = new Date();
        await user.save();
        res.json({ ok: true });
    } catch (err) {
        console.error('Password update error:', err);
        res.status(500).json({ error: 'Failed to update password' });
    }
});

// PATCH /api/user/bio
app.patch('/api/user/bio', requireAuth, async (req, res) => {
    try {
        const bio = (req.body.bio ?? '').trim();
        if (bio.length > 128) return res.status(400).json({ error: 'Bio must be 128 characters or fewer' });
        await User.findByIdAndUpdate(req.user._id, { bio });
        res.json({ ok: true, bio });
    } catch (err) {
        console.error('Bio update error:', err);
        res.status(500).json({ error: 'Failed to update bio' });
    }
});

// PATCH /api/user/display-name
app.patch('/api/user/display-name', requireAuth, async (req, res) => {
    try {
        const raw = (req.body.displayName ?? '').trim();
        if (raw === '') {
            await User.findByIdAndUpdate(req.user._id, { displayName: '' });
            return res.json({ ok: true, displayName: '' });
        }
        if (!/^[a-zA-Z ]+$/.test(raw)) return res.status(400).json({ error: 'Display name may only contain letters' });
        if (raw.length > 30) return res.status(400).json({ error: 'Display name may not exceed 30 characters' });
        const displayName = raw.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
        await User.findByIdAndUpdate(req.user._id, { displayName });
        res.json({ ok: true, displayName });
    } catch (err) {
        console.error('Display name update error:', err);
        res.status(500).json({ error: 'Failed to update display name' });
    }
});

// PATCH /api/user/language
const VALID_LANGUAGES = new Set([
    'en','es','fr','de','pt','it','nl','ru','ja','zh','ko','ar','hi','tr','pl','sv','no','da','fi','id',
]);
app.patch('/api/user/language', requireAuth, async (req, res) => {
    try {
        const language = (req.body.language ?? '').trim();
        if (!VALID_LANGUAGES.has(language)) return res.status(400).json({ error: 'Invalid language' });
        await User.findByIdAndUpdate(req.user._id, { language });
        res.json({ ok: true, language });
    } catch (err) {
        console.error('Language update error:', err);
        res.status(500).json({ error: 'Failed to update language' });
    }
});

// PATCH /api/user/category
const _categoriesJson  = JSON.parse(readFileSync(path.join(__dirname, 'public/data/categories.json'), 'utf8'));
const VALID_CATEGORIES = new Set(['', ..._categoriesJson.categories.map(c => c.value), ..._categoriesJson.adultCategories.map(c => c.value)]);
const ADULT_CATEGORIES = new Set(_categoriesJson.adultCategories.map(c => c.value));
app.patch('/api/user/category', requireAuth, async (req, res) => {
    try {
        const category = (req.body.category ?? '').trim();
        if (!VALID_CATEGORIES.has(category)) return res.status(400).json({ error: 'Invalid category' });
        if (ADULT_CATEGORIES.has(category) && req.user.isMatureGated) return res.status(403).json({ error: 'Disable the mature filter to select an adult category' });
        await User.findByIdAndUpdate(req.user._id, { category });
        res.json({ ok: true, category });
    } catch (err) {
        console.error('Category update error:', err);
        res.status(500).json({ error: 'Failed to update category' });
    }
});

// PATCH /api/user/links
const URL_SHORTENER_HOSTS = new Set([
    'bit.ly','tinyurl.com','t.co','ow.ly','goo.gl','buff.ly','short.link','tiny.cc',
    'is.gd','v.gd','rb.gy','cutt.ly','shorturl.at','clck.ru','rebrand.ly','bl.ink',
    'lnkd.in','snip.ly','soo.gd','adf.ly','bit.do','tr.im','cli.gs','yfrog.com',
    'migre.me','ff.im','url4.eu','twitthis.com','su.pr','twurl.nl','youtu.be',
]);
const PLATFORM_DOMAINS = {
    twitter:   ['twitter.com','x.com'],
    github:    ['github.com'],
    instagram: ['instagram.com'],
    linkedin:  ['linkedin.com'],
    youtube:   ['youtube.com','youtu.be'],
    tiktok:    ['tiktok.com'],
    facebook:  ['facebook.com','fb.com'],
    discord:   ['discord.gg','discord.com'],
    twitch:    ['twitch.tv'],
    bluesky:   ['bsky.app','bsky.social'],
    other:     null,
    // adult — only available when isMatureGated is false
    onlyfans:  ['onlyfans.com'],
    fansly:    ['fansly.com'],
    fanvue:    ['fanvue.com'],
    pornhub:   ['pornhub.com'],
};
const ADULT_PLATFORMS = new Set(['onlyfans','fansly','fanvue','pornhub']);
function validateLinkUrl(url, platform = null) {
    if (!url) return null; // empty is allowed
    let u;
    try { u = new URL(url); } catch { return 'Enter a valid URL.'; }
    if (u.protocol !== 'https:') return 'Links must use HTTPS.';
    const host = u.hostname.replace(/^www\./, '');
    if (URL_SHORTENER_HOSTS.has(host)) return 'URL shorteners are not allowed.';
    if (platform && platform !== 'other') {
        const allowed = PLATFORM_DOMAINS[platform];
        if (allowed) {
            const match = allowed.some(d => host === d || host.endsWith('.' + d));
            if (!match) return `Must be a valid ${platform} link (${allowed.join(' or ')}).`;
        }
    }
    return null;
}
app.patch('/api/user/links', requireAuth, async (req, res) => {
    try {
        const website     = (req.body.website ?? '').trim();
        const rawSocials  = Array.isArray(req.body.socialLinks) ? req.body.socialLinks : [];
        const websiteErr  = validateLinkUrl(website);
        if (websiteErr) return res.status(400).json({ error: websiteErr });
        if (rawSocials.length > 3) return res.status(400).json({ error: 'Max 3 social links' });
        const socialLinks = [];
        for (const s of rawSocials) {
            const platform = (s.platform ?? '').trim();
            const url      = (s.url ?? '').trim();
            if (!PLATFORM_DOMAINS.hasOwnProperty(platform)) return res.status(400).json({ error: 'Invalid platform' });
            if (ADULT_PLATFORMS.has(platform) && req.user.isMatureGated !== false) return res.status(403).json({ error: 'Disable the mature content filter to add this platform' });
            const urlErr = validateLinkUrl(url, platform);
            if (urlErr) return res.status(400).json({ error: urlErr });
            socialLinks.push({ platform, url });
        }
        await User.findByIdAndUpdate(req.user._id, { website, socialLinks });
        res.json({ ok: true, website, socialLinks });
    } catch (err) {
        console.error('Links update error:', err);
        res.status(500).json({ error: 'Failed to update links' });
    }
});

// PATCH /api/user/avatar
const ALLOWED_AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB decoded
app.patch('/api/user/avatar', requireAuth, async (req, res) => {
    try {
        const { avatar } = req.body;
        if (!avatar || typeof avatar !== 'string') return res.status(400).json({ error: 'No image provided' });
        const match = avatar.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
        if (!match) return res.status(400).json({ error: 'Invalid image format' });
        const [, mimeType, b64] = match;
        if (!ALLOWED_AVATAR_MIME.has(mimeType)) return res.status(400).json({ error: 'Unsupported image type' });
        const buffer = Buffer.from(b64, 'base64');
        if (buffer.byteLength > MAX_AVATAR_BYTES) return res.status(400).json({ error: 'Image must be under 2 MB' });
        const oldAvatar = req.user.avatar;
        const url = await uploadImageToR2(buffer, mimeType, 'users/avatars');
        await User.findByIdAndUpdate(req.user._id, { avatar: url });
        if (oldAvatar) deleteR2Images([oldAvatar]).catch(() => {});
        res.json({ ok: true, avatar: url });
    } catch (err) {
        console.error('Avatar update error:', err);
        res.status(500).json({ error: 'Failed to update avatar' });
    }
});

// POST /api/user/avatar — alias for the PATCH handler (accepts same base64 body)
app.post('/api/user/avatar', requireAuth, async (req, res) => {
    try {
        const { avatar } = req.body;
        if (!avatar || typeof avatar !== 'string') return res.status(400).json({ error: 'No image provided' });
        const match = avatar.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
        if (!match) return res.status(400).json({ error: 'Invalid image format' });
        const [, mimeType, b64] = match;
        if (!ALLOWED_AVATAR_MIME.has(mimeType)) return res.status(400).json({ error: 'Unsupported image type' });
        const buffer = Buffer.from(b64, 'base64');
        if (buffer.byteLength > MAX_AVATAR_BYTES) return res.status(400).json({ error: 'Image must be under 2 MB' });
        const oldAvatar = req.user.avatar;
        const url = await uploadImageToR2(buffer, mimeType, 'users/avatars');
        await User.findByIdAndUpdate(req.user._id, { avatar: url });
        if (oldAvatar) deleteR2Images([oldAvatar]).catch(() => {});
        res.json({ ok: true, avatar: url });
    } catch (err) {
        console.error('Avatar upload error:', err);
        res.status(500).json({ error: 'Failed to upload avatar' });
    }
});

// PATCH /api/user/profile — consolidated profile update (username)
app.patch('/api/user/profile', requireAuth, async (req, res) => {
    try {
        const { username } = req.body;
        if (!username?.trim()) return res.status(400).json({ error: 'Username is required' });
        const trimmed = username.trim();
        if (trimmed.length < 3 || trimmed.length > 20) return res.status(400).json({ error: 'Username must be 3–20 characters' });
        if (!/^[a-zA-Z0-9]+$/.test(trimmed)) return res.status(400).json({ error: 'Username may only contain letters and numbers' });
        if (trimmed.toLowerCase() === req.user.username?.toLowerCase()) return res.status(400).json({ error: 'This is already your username' });
        const rateLimit = checkUsernameRateLimit(req.user);
        if (rateLimit.blocked) {
            const formatted = rateLimit.availableAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            return res.status(429).json({ error: `You've hit a username change limit. Try again on ${formatted}.` });
        }
        const isAdmin = ['moderator', 'superadmin'].includes(req.user.role);
        const roleFilter = isAdmin ? { role: { $in: ['moderator', 'superadmin'] } } : { role: 'user' };
        const taken = await User.findOne({ username: new RegExp(`^${trimmed}$`, 'i'), _id: { $ne: req.user._id }, ...roleFilter });
        if (taken) return res.status(409).json({ error: 'This username is already taken' });
        const now = new Date();
        const pruned = (req.user.usernameChangeLog || []).filter(d => now - new Date(d).getTime() < 30 * 24 * 60 * 60 * 1000);
        pruned.push(now);
        await User.findByIdAndUpdate(req.user._id, { username: trimmed, usernameChangeLog: pruned });
        res.json({ ok: true, username: trimmed });
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// PATCH /api/user/email — change email address (requires current password; triggers new OTP)
app.patch('/api/user/email', requireAuth, async (req, res) => {
    try {
        const { newEmail, currentPassword } = req.body;
        if (!newEmail || !currentPassword) return res.status(400).json({ error: 'New email and current password are required' });
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(newEmail)) return res.status(400).json({ error: 'Invalid email format' });
        const normalized = newEmail.toLowerCase().trim();
        if (normalized === req.user.email) return res.status(400).json({ error: 'This is already your email address' });
        const user = await User.findById(req.user._id).select('+password');
        if (!user) return res.status(404).json({ error: 'User not found' });
        const valid = await user.comparePassword(currentPassword);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        const taken = await User.findOne({ email: normalized, _id: { $ne: req.user._id } });
        if (taken) return res.status(409).json({ error: 'Email is already in use' });
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        user.email = normalized;
        user.isEmailVerified = false;
        user.otpCode = createHash('sha256').update(code).digest('hex');
        user.otpExpires = new Date(Date.now() + 10 * 60 * 1000);
        user.otpSentAt = new Date();
        await user.save();
        await sendOtpEmail(normalized, code);
        res.json({ ok: true, requiresOtp: true, email: normalized });
    } catch (err) {
        console.error('Email update error:', err);
        res.status(500).json({ error: 'Failed to update email' });
    }
});

// PATCH /api/user/notification-prefs — per-type notification toggles
const VALID_NOTIF_TYPES = new Set([
    'new_follower', 'bucket_grabbed', 'bucket_unlocked', 'new_bucket_published',
    'grabbed_bucket_updated', 'comment_mention', 'bucket_tagged', 'comment_reply',
    'comment_agreed', 'new_dm',
]);
app.patch('/api/user/notification-prefs', requireAuth, requireVerification, async (req, res) => {
    try {
        const prefs = req.body;
        if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
            return res.status(400).json({ error: 'Prefs must be an object' });
        }
        const update = {};
        for (const [key, val] of Object.entries(prefs)) {
            if (!VALID_NOTIF_TYPES.has(key)) return res.status(400).json({ error: `Unknown notification type: ${key}` });
            if (typeof val !== 'boolean') return res.status(400).json({ error: `Value for ${key} must be a boolean` });
            update[`notificationPrefs.${key}`] = val;
        }
        if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No valid fields provided' });
        await User.findByIdAndUpdate(req.user._id, { $set: update });
        res.json({ ok: true });
    } catch (err) {
        console.error('Notification prefs update error:', err);
        res.status(500).json({ error: 'Failed to update notification preferences' });
    }
});

// GET /api/user/export — download user data as JSON
app.get('/api/user/export', requireAuth, requireVerification, async (req, res) => {
    try {
        const userId = req.user._id;
        const [user, buckets, grabbedBuckets] = await Promise.all([
            User.findById(userId).select(
                'username email avatar bio website socialLinks category isMatureGated newsletterSubscribed notificationPrefs createdAt'
            ).lean(),
            Bucket.find({ userId }).select('name description tags visibility monetized price mature isDraft links createdAt updatedAt').lean(),
            Bucket.find({ 'grabbedBy.userId': userId }).select('name _id').lean(),
        ]);
        res.setHeader('Content-Disposition', 'attachment; filename="grabbn-export.json"');
        res.json({
            exportedAt: new Date().toISOString(),
            profile: user,
            buckets: buckets.map(b => ({
                name: b.name,
                description: b.description,
                tags: b.tags,
                visibility: b.visibility,
                monetized: b.monetized,
                price: b.price,
                mature: b.mature,
                isDraft: b.isDraft,
                linkCount: (b.links || []).length,
                createdAt: b.createdAt,
                updatedAt: b.updatedAt,
            })),
            grabbed: grabbedBuckets.map(b => ({ id: b._id, name: b.name })),
        });
    } catch (err) {
        console.error('Export error:', err);
        res.status(500).json({ error: 'Failed to export data' });
    }
});

// Partnership apply page — custom handler to pass application status to template
app.get('/partnership/apply', anonymousAuth, requireNonAdmin, async (req, res) => {
    const u = req.user;
    let applicationStatus = null;
    if (u && !u.isAnonymous && u.isEmailVerified && !u.isPartner) {
        try {
            applicationStatus = await PartnerApplication
                .findOne({ userId: u._id })
                .sort({ submittedAt: -1 })
                .select('status submittedAt rejectionReason')
                .lean();
        } catch { /* non-fatal */ }
    }
    res.render('partnership-apply', {
        title: 'Apply — Partner Program',
        page:  'partnership',
        user:  u ?? null,
        applicationStatus: applicationStatus ?? null
    });
});

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

// /admin/partners/applications — application queue list
app.get('/admin/partners/applications', adminPage('superadmin'), async (req, res) => {
    try {
        const status       = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
        const page         = Math.max(1, parseInt(req.query.page) || 1);
        const limit        = 30;
        const skip         = (page - 1) * limit;

        const [applications, total, pendingCount] = await Promise.all([
            PartnerApplication.find({ status })
                .populate('userId', 'email username isEmailVerified createdAt country')
                .sort({ submittedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            PartnerApplication.countDocuments({ status }),
            PartnerApplication.countDocuments({ status: 'pending' })
        ]);

        res.render('admin/partner-applications', {
            admin: req.user,
            applications,
            status,
            pendingCount,
            pagination: { total, page, pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        console.error('[admin/partners/applications page]', err);
        res.status(500).send('Server error');
    }
});

// /admin/partners/applications/:appId — single application review
app.get('/admin/partners/applications/:appId', adminPage('superadmin'), async (req, res) => {
    try {
        const { appId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(appId)) return res.status(404).render('admin/not-found');

        const application = await PartnerApplication.findById(appId)
            .populate('userId', 'email username isEmailVerified createdAt country isPartner')
            .lean();

        if (!application) return res.status(404).render('admin/not-found');

        res.render('admin/partner-application-detail', { admin: req.user, application });
    } catch (err) {
        console.error('[admin/partners/applications/:id page]', err);
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

            const userFilter = {
                username:   new RegExp(escaped, 'i'),
                isAnonymous: false,
                'privacy.accountVisibility': { $nin: ['private', 'unlisted'] },
            };
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
            .populate('userId', 'username anonymousId avatar privacy')
            .lean();

            const visible = found.filter(b => !['private', 'unlisted'].includes(b.userId?.privacy?.accountVisibility));
            const hasMore = visible.length > B_LIMIT;
            const buckets = visible.slice(0, B_LIMIT);

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
            const found = await User.findOne({ username: profileUrlMatch[1], isAnonymous: false, 'privacy.accountVisibility': { $nin: ['private', 'unlisted'] } }).lean();
            if (found) users = [found];

        } else if (isObjectId) {
            const [bucket, userByAnonId] = await Promise.all([
                Bucket.findById(q)
                    .select(BUCKET_SELECT)
                    .populate('userId', 'username anonymousId avatar')
                    .lean(),
                User.findOne({ anonymousId: q, isAnonymous: false, 'privacy.accountVisibility': { $nin: ['private', 'unlisted'] } }).lean(),
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
                    : User.find({ username: new RegExp(escaped, 'i'), isAnonymous: false, 'privacy.accountVisibility': { $nin: ['private', 'unlisted'] } })
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

        res.render('search', {
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
        res.render('search', {
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

async function resolveCanMessage(viewer, profileUser) {
    if (!viewer || viewer.isAnonymous) return true; // let auth redirect handle it
    const rawWcm = profileUser.privacy?.whoCanMessage;
    const wcm = Array.isArray(rawWcm) ? rawWcm : (rawWcm ? [rawWcm] : ['everyone']);
    if (wcm.includes('no_one')) return false;
    if (wcm.includes('everyone')) return true;
    const [pif, pfm, sc] = await Promise.all([
        wcm.includes('people_i_follow')      ? Subscription.exists({ followerId: profileUser._id, followeeId: viewer._id }) : false,
        wcm.includes('people_who_follow_me') ? Subscription.exists({ followerId: viewer._id,    followeeId: profileUser._id }) : false,
        wcm.includes('same_category')        ? Promise.resolve(!!(viewer.category && viewer.category === profileUser.category)) : false,
    ]);
    return !!(pif || pfm || sc);
}

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
    try {
        const profileUser = await User.findOne({ username: req.params.username, isAnonymous: false }).lean();
        if (!profileUser) return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user ?? null });

        const viewer  = req.user ?? null;
        const isOwner = !!(viewer && !viewer.isAnonymous && viewer._id.toString() === profileUser._id.toString());

        if (!isOwner) {
            const visibility = profileUser.privacy?.accountVisibility ?? 'public';
            if (visibility === 'private')
                return res.status(404).render('404', { title: 'Not Found', page: '', user: viewer });

            if (viewer && !viewer.isAnonymous) {
                const blocked = await Block.exists({ blockerId: profileUser._id, blockedId: viewer._id });
                if (blocked) return res.status(404).render('404', { title: 'Not Found', page: '', user: viewer });
            }
        }

        const addDisplayThumb = (b) => ({
            ...b,
            _id: b._id.toString(),
            displayThumb: b.thumbnail || null,
        });

        const bucketFilter = isOwner
            ? { userId: profileUser._id }
            : { userId: profileUser._id, ...FILTER_PUBLIC };

        const canMessage = isOwner ? false : await resolveCanMessage(viewer, profileUser);

        const isBlocked = (!isOwner && viewer && !viewer.isAnonymous)
            ? !!(await Block.exists({ blockerId: viewer._id, blockedId: profileUser._id }))
            : false;

        const [allBuckets, subscriberCount, followingCount, rawGrabbed, userRepos] = await Promise.all([
            Bucket.find(bucketFilter)
                .select('name description thumbnail visibility isPublic isPaywalled price links._id viewCount shareCount grabbedBy sourceUrl hashtags mature isDraft ratingCount ratingSum repoIds createdAt updatedAt' + (isOwner ? ' bucketOwningId' : ''))
                .sort({ order: 1, createdAt: -1 })
                .lean(),
            Subscription.countDocuments({ followeeId: profileUser._id }),
            Subscription.countDocuments({ followerId: profileUser._id }),
            (isOwner || profileUser.privacy?.showGrabbedBuckets !== false)
                ? Bucket.find({ 'grabbedBy.userId': profileUser._id })
                    .select('name description thumbnail visibility isPublic isPaywalled price links._id viewCount shareCount grabbedBy sourceUrl hashtags mature ratingCount ratingSum createdAt updatedAt')
                    .populate('userId', 'username')
                    .sort({ createdAt: -1 })
                    .lean()
                : Promise.resolve([]),
            UserRepo.find({ userId: profileUser._id }).sort({ name: 1 }).lean(),
        ]);

        const hideMature = !isOwner && (viewer === null || viewer.isAnonymous || viewer.isMatureGated !== false);
        const matureAck  = !!req.cookies?.matureAck;
        const profileHasMature = allBuckets.some(b => b.mature) || rawGrabbed.some(b => b.mature);
        const showMatureGate   = hideMature && profileHasMature && !matureAck;

        const ownBuckets        = allBuckets.map(addDisplayThumb);
        const grabbedBuckets    = rawGrabbed.map(addDisplayThumb);
        const publicBucketCount = allBuckets.filter(b => b.visibility === 'public').length;
        const publicRepoIds     = new Set(allBuckets.filter(b => b.visibility === 'public').flatMap(b => (b.repoIds || []).map(id => id.toString())));
        const publicRepoCount   = userRepos.filter(r => publicRepoIds.has(r._id.toString())).length;
        const totalViews     = ownBuckets.reduce((sum, b) => sum + (b.viewCount       ?? 0), 0);
        const totalGrabs     = ownBuckets.reduce((sum, b) => sum + (b.grabbedBy?.length ?? 0), 0);
        const memberSince    = new Date(profileUser.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

        res.render('profile', {
            title:       `@${profileUser.username}`,
            page:        'profile',
            user:        viewer,
            profileUser,
            isOwner,
            ownBuckets,
            grabbedBuckets,
            publicBucketCount,
            publicRepoCount,
            userRepos,
            totalViews,
            totalGrabs,
            subscriberCount,
            followingCount,
            memberSince,
            showMatureGate,
            canMessage,
            isBlocked,
        });
    } catch (err) {
        console.error('Profile page error:', err);
        res.status(500).render('404', { title: 'Error', page: '', user: req.user ?? null });
    }
});

// Dynamic repository page — domain + tag come from the path
// User-created repo page — single ObjectId segment distinguishes it from domain+tag repos
app.get('/o/:repoId', anonymousAuth, async (req, res) => {
    try {
        const { repoId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(repoId)) {
            return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        const repo = await UserRepo.findById(repoId).lean();
        if (!repo) return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user ?? null });

        const viewer  = req.user ?? null;
        const owner   = await User.findById(repo.userId).select('username avatar anonymousId').lean();
        if (!owner) return res.status(404).render('404', { title: 'Not Found', page: '', user: viewer });

        const isOwner = !!(viewer && !viewer.isAnonymous && viewer._id.toString() === repo.userId.toString());

        // Visitors see public + unlisted buckets (unlisted = accessible via link/repo, not discoverable); owner sees all
        const bucketFilter = isOwner
            ? { repoIds: repo._id }
            : { repoIds: repo._id, ...FILTER_ACCESSIBLE };

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

        res.render('repo', {
            title:          repo.name,
            page:           'repo',
            user:           viewer,
            matureAck:      !!req.cookies.matureAck,
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
        res.status(500).render('404', { title: 'Error', page: '', user: req.user ?? null });
    }
});

app.get('/o/:topic/:tag', anonymousAuth, (req, res) => {
    const topic = req.params.topic || '';
    const tag   = req.params.tag   || '';
    res.render('repository', { title: `#${tag} in ${topic}`, page: 'repository', user: req.user ?? null, domain: topic, tag });
});

// Report page — /v2/report/:bucketId
app.get('/report/:bucketId', anonymousAuth, async (req, res) => {
    try {
        const { bucketId } = req.params;
        const bucket = await Bucket.findById(bucketId).lean();
        if (!bucket) return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user ?? null });

        const vis = bucketVisibility(bucket);
        const isOwner = !!(req.user && !req.user.isAnonymous && bucket.userId.toString() === req.user._id.toString());
        if (vis === 'private' && !isOwner) {
            return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        const curator = await User.findById(bucket.userId).select('username avatar anonymousId').lean();
        const curatorName   = curator?.username || 'Anonymous';
        const curatorAvatar = curator?.avatar   || null;
        const thumbnailUrl  = bucket.thumbnail  || bucket.links?.find(l => l.image)?.image || null;

        res.render('report', {
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
        // Legacy base64 data URL
        const mimeMatch = rawImage.match(/^data:(image\/\w+);base64,/);
        if (mimeMatch) {
            res.set('Content-Type', mimeMatch[1]);
            res.set('Cache-Control', 'public, max-age=31536000');
            return res.send(Buffer.from(rawImage.slice(mimeMatch[0].length), 'base64'));
        }
        // R2 or external URL — redirect the client directly to it
        res.redirect(302, rawImage);
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
        if (!bucket) return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user ?? null });

        const curator = await User.findById(bucket.userId).select('username avatar anonymousId').lean();
        const curatorName        = curator?.username    || 'Anonymous';
        const curatorAvatar      = curator?.avatar      || null;
        const curatorAnonymousId = curator?.anonymousId || null;

        const thumbnailUrl = bucket.thumbnail || bucket.links?.find(l => l.image)?.image || null;
        const shareBaseUrl = `${req.protocol}://${req.get('host')}`;

        const vis = bucketVisibility(bucket);
        const isOwner = !!(req.user && !req.user.isAnonymous && bucket.userId.toString() === req.user._id.toString());
        if (vis === 'private' && !isOwner) {
            return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        // Block check: if bucket's curator has blocked the viewer, treat as 404
        if (!isOwner && req.user && !req.user.isAnonymous) {
            const blocked = await Block.exists({ blockerId: bucket.userId, blockedId: req.user._id });
            if (blocked) return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user ?? null });
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
            const viewSource = req.query.src === 'explore' ? 'explore' : req.query.src === 'showroom' ? 'showroom' : 'direct';
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

        res.render('bucket', {
            title: bucket.name,
            page: 'explore',
            user: req.user ?? null,
            matureAck: !!req.cookies.matureAck,
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
            bucketOwningId: isOwner ? (bucket.bucketOwningId || null) : null,
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
    res.render('messages', { title: 'Messages', page: 'messages', user: req.user, ...MSG_DEFAULTS });
});

app.get('/messages/:conversationId', anonymousAuth, requireAuth, requireVerification, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user });
        }

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user });

        const isParticipant = conversation.participants.some(p => p.toString() === req.user._id.toString());
        if (!isParticipant) return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user });

        const otherId = conversation.participants.find(p => p.toString() !== req.user._id.toString());
        if (otherId) {
            const blocked = await Block.exists({ blockerId: otherId, blockedId: req.user._id });
            if (blocked) return res.status(404).render('404', { title: 'Not Found', page: '', user: req.user });
        }

        const otherUser = otherId ? await User.findById(otherId).select('username avatar anonymousId').lean() : null;

        res.render('messages', {
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
async function backfillBucketOwningIds() {
    const buckets = await Bucket.find({ bucketOwningId: { $exists: false } }, '_id').lean();
    if (!buckets.length) return;
    const ops = buckets.map(b => ({
        updateOne: {
            filter: { _id: b._id },
            update: { $set: { bucketOwningId: randomBytes(16).toString('hex') } },
        },
    }));
    const result = await mongoose.connection.collection('buckets').bulkWrite(ops, { ordered: false });
    console.log(`[migration] backfilled bucketOwningId on ${result.modifiedCount} buckets`);
}

connectMongo()
    .then(() => {
        backfillBucketOwningIds().catch(err => console.error('[migration] backfillBucketOwningIds failed:', err));
        server.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
            console.log(`Scraping endpoint: http://localhost:${PORT}/scrape?url=YOUR_URL`);
            console.log(`Frontend available at http://localhost:${PORT}`);
            console.log(`Dev To-Do: http://localhost:${PORT}/todo.html`);
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
