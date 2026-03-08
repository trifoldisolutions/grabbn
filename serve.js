import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import axios from 'axios';
import * as cheerio from 'cheerio';
import User from './server/models/user.js';
import Bucket from './server/models/bucket.js';
import Report from './server/models/report.js';
import BucketAccess from './server/models/bucketAccess.js';
import { anonymousAuth, requireAuth, requireVerification } from './server/middleware/anonymousAuth.js';
import { getScrapingStatus } from './server/middleware/scrapingLimit.js';
import bucketShareRouter from './server/routes/bucketShare.js';
import authRouter from './server/routes/auth.js';
import creditsRouter, { handleWebhook } from './server/routes/credits.js';
import connectRouter, { handleConnectWebhook } from './server/routes/stripeConnect.js';

dotenv.config();

// Required for ES modules (__dirname equivalent)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Popup-session — registered BEFORE the global CORS middleware so we can
// allow any origin (bookmarklet runs on arbitrary third-party sites).
// No credentials: the token provides short-lived access to link data only.
// ---------------------------------------------------------------------------
const popupSessions = new Map();

app.options('/api/popup-session', cors({ origin: '*' }));

app.post('/api/popup-session',
    cors({ origin: '*', methods: ['POST', 'OPTIONS'] }),
    express.json({ limit: '2mb' }),
    (req, res) => {
        const { links, sourceUrl } = req.body;
        if (!Array.isArray(links)) {
            return res.status(400).json({ error: 'links is required' });
        }
        const token =
            Math.random().toString(36).slice(2, 10) +
            Math.random().toString(36).slice(2, 10);
        popupSessions.set(token, {
            links: links.slice(0, 1000),
            sourceUrl: String(sourceUrl || '').slice(0, 2000),
            createdAt: Date.now()
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

app.use('/api/auth', authRouter);
app.use('/api/credits', creditsRouter);
app.use('/api/connect', connectRouter);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

app.use('/share', bucketShareRouter);

// Route root based on hostname:
//   grabbn.com / www.grabbn.com  → landing page
//   app.grabbn.com               → the app
app.get('/', (req, res) => {
    const host = req.hostname; // excludes port
    if (host === 'app.grabbn.com') {
        res.sendFile(path.join(__dirname, 'public', 'app.html'));
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


// Parse duration helper function
function parseDuration(text) {
    if (!text) return null;
    text = String(text).toLowerCase().trim();

    // Case: 137:55, 19:32, 1:02:33
    const timeFormat = text.match(/(\d+):(\d{2})(?::(\d{2}))?/);
    if (timeFormat) {
        const part1 = parseInt(timeFormat[1], 10);
        const part2 = parseInt(timeFormat[2], 10);
        const part3 = timeFormat[3] ? parseInt(timeFormat[3], 10) : 0;

        // If we have 3 parts, treat as hh:mm:ss
        if (timeFormat[3]) {
            const hours = part1;
            const mins = part2;
            const secs = part3;
            return hours * 60 + mins + (secs > 0 ? 1 : 0);
        } else {
            // 2 parts => treat as mm:ss
            const mins = part1;
            const secs = part2;
            return mins + (secs > 0 ? 1 : 0);
        }
    }

    // Case: 19m, 25min, 60 mins
    const minuteOnly = text.match(/(\d+)\s*m(in)?s?/);
    if (minuteOnly) {
        return parseInt(minuteOnly[1], 10);
    }

    // Case: 1h30, 2 hours 15 min
    const hourFormat = text.match(/(\d+)\s*h(our)?s?\s*(\d+)?\s*m?/);
    if (hourFormat) {
        const h = parseInt(hourFormat[1], 10);
        const m = parseInt(hourFormat[3] || 0, 10);
        return h * 60 + m;
    }

    return null;
}

// ====================
// API ENDPOINTS
// ====================

// Get user info (for debugging/testing)
app.get('/api/user', requireAuth, requireVerification, (req, res) => {
    res.json({
        anonymousId: req.user.anonymousId,
        isAnonymous: req.user.isAnonymous,
        createdAt: req.user.createdAt,
        lastActive: req.user.lastActive
    });
});

// Get scraping status (limits, remaining, etc.)
app.get('/api/scraping-status', requireAuth, requireVerification, getScrapingStatus);

// Increment scraping counter (called once per scraping session from frontend)
app.post('/api/scraping/increment', requireAuth, requireVerification, async (req, res) => {
    try {
        // Check if user can scrape first
        if (!req.user.canScrape()) {
            return res.status(429).json({
                error: 'Daily scraping limit reached',
                message: 'You have reached your daily limit. Please try again tomorrow or log in for more scrapes.'
            });
        }

        await req.user.incrementScrapingCount();

        const remaining = req.user.getRemainingScrapers();

        res.json({
            success: true,
            remaining: remaining,
            used: req.user.dailyScrapingCount,
            limit: req.user.scrapingLimit
        });
    } catch (error) {
        console.error('Error incrementing scraping count:', error);
        res.status(500).json({ error: 'Failed to update scraping count' });
    }
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
        const { name } = req.body;

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

        const bucket = await Bucket.create({
            userId: req.user._id,
            name
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

// Toggle bucket public/private visibility
app.patch('/api/buckets/:name/visibility', requireAuth, requireVerification, async (req, res) => {
    try {
        const { name } = req.params;
        const { isPublic } = req.body;

        if (name === 'Singletons') {
            return res.status(403).json({ error: 'Singletons bucket cannot be made public' });
        }

        if (typeof isPublic !== 'boolean') {
            return res.status(400).json({ error: 'isPublic must be a boolean' });
        }

        const bucket = await Bucket.findOneAndUpdate(
            { userId: req.user._id, name },
            { isPublic },
            { new: true }
        );

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }

        res.json({ name: bucket.name, isPublic: bucket.isPublic });
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
                if (isOwner || bucket.isPublic) buckets = [bucket];
            }
        }

        // 2. Raw ObjectId
        if (!buckets.length && /^[a-f0-9]{24}$/i.test(q)) {
            const bucket = await Bucket.findById(q).populate('userId', 'username anonymousId');
            if (bucket) {
                const isOwner = bucket.userId._id.equals(req.user._id);
                if (isOwner || bucket.isPublic) buckets = [bucket];
            }
        }

        // 3. Name search (case-insensitive, partial match, paginated — public only for non-owners)
        if (!buckets.length) {
            const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            buckets = await Bucket.find({
                name: new RegExp(escaped, 'i'),
                $or: [{ userId: req.user._id }, { isPublic: true }]
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

        // Only public buckets can be grabbed
        if (!source.isPublic) {
            return res.status(403).json({ error: 'This bucket is private and cannot be grabbed' });
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

            // Add links to bucket (avoid duplicates)
            for (const link of links) {
                const exists = bucket.links.some(l => l.href === link.href);

                if (!exists) {
                    bucket.links.push({
                        href: link.href,
                        text: link.text || '',
                        duration: link.duration || ''
                    });
                }
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

// Scrape endpoint — fetches a URL and extracts video links with durations
app.get('/scrape', requireAuth, requireVerification, async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(data);
        const linksMap = new Map();

        // Detect maximum page number from any ?page=XX links
        let maxPage = 1;
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const match = href.match(/page=(\d+)/i);
            if (match) {
                const num = parseInt(match[1], 10);
                if (!Number.isNaN(num) && num > maxPage) maxPage = num;
            }
        });

        // Extract all relevant video links + durations
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();

            if (!href) return;

            try {
                if (href.includes('viewkey=') && !href.includes('pkey=')) {
                    const absoluteUrl = new URL(href, url).href;

                    const container = $(el).closest('li, .thumb, .video, .phimage, .item, div');
                    const durationVar =
                        container.find('var.duration[data-title="Video Duration"]').first() ||
                        $(el).find('var.duration[data-title="Video Duration"]').first();

                    const durationText =
                        (durationVar && durationVar.text() && durationVar.text().trim()) || '';

                    const minutes = parseDuration(durationText);
                    if (minutes !== null && minutes < 19) return;

                    const existing = linksMap.get(absoluteUrl);
                    const linkObj = {
                        href: absoluteUrl,
                        text: text || '(No Text)',
                        duration: durationText || null
                    };

                    if (!existing || text.length > existing.text.length) {
                        linksMap.set(absoluteUrl, linkObj);
                    }
                }
            } catch (err) {
                // Silently ignore errors for individual anchors
            }
        });

        const links = Array.from(linksMap.values());
        res.json({ links, count: links.length, maxPage });
    } catch (error) {
        console.error(error.message);
        res.status(500).json({
            error: 'Failed to scrape the URL. It might differ by site security.'
        });
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
    })
    .catch(err => {
        console.error('Failed to connect to MongoDB:', err.message);
        process.exit(1);
    });