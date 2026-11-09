import cookieParser from 'cookie-parser';
import cors from 'cors';
import { randomBytes } from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import Bucket from './models/bucket.js';
import Conversation from './models/conversation.js';
import User from './models/user.js';
import { anonymousAuth } from './middleware/anonymousAuth.js';
import { translate } from './services/i18n.js';
import { buildExploreScores } from './services/jobs/buildExploreScores.js';
import { buildRepositories } from './services/jobs/buildRepositories.js';
import { pushNotification, wsClients } from './services/ws.js';
import adminRouter, { adminApiRouter } from './routes/admin.js';
import apiRouter, { popupSessionRouter } from './routes/api.js';
import appRouter from './routes/app.js';
import publicRouter from './routes/public.js';
import webhooksRouter from './routes/webhooks.js';

dotenv.config();

// Required for ES modules (__dirname equivalent)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Facades: every section's router. Most are mounted together after the static files; these two have to come earlier.
const facades = [
    { name: 'Bookmarklet session', mount: '/api', router: popupSessionRouter },
    { name: 'Webhooks', mount: '/api', router: webhooksRouter },
    { name: 'Public', mount: '/', router: publicRouter },
    { name: 'App', mount: '/', router: appRouter },
    { name: 'Admin', mount: '/admin', router: adminRouter },
    { name: 'Admin API', mount: '/api/admin', router: adminApiRouter },
    { name: 'API', mount: '/api', router: apiRouter },
];
const [popupFacade, webhooksFacade, ...sectionFacades] = facades;


// ---------------------------------------------------------------------------
// WebSocket — one persistent connection per logged-in user.
// Client registry lives in services/ws.js to avoid circular imports.
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
// ---------------------------------------------------------------------------
app.use(popupFacade.mount, popupFacade.router);

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
app.use(webhooksFacade.mount, webhooksFacade.router);

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

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

sectionFacades.forEach(({ mount, router }) => app.use(mount, router));

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
            console.log('');
            facades.forEach(({ name, mount, router }) => {
                console.log(`[${name}]`);
                (router.routes || []).forEach(({ method, path: p, label }) => {
                    const full = (mount === '/' ? '' : mount) + (p === '/' && mount !== '/' ? '' : p);
                    console.log(`  ${method.padEnd(6)} http://localhost:${PORT}${full || '/'} — ${label}`);
                });
            });
            console.log('');
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
