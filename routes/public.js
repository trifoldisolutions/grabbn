// Public pages, mounted at /. A logged-out visitor can reach all of these.
import express from 'express';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import Block from '../models/block.js';
import Bucket from '../models/bucket.js';
import BucketAccess from '../models/bucketAccess.js';
import BucketComment from '../models/bucketComment.js';
import BucketRating from '../models/bucketRating.js';
import LinkClick from '../models/linkClick.js';
import PartnerApplication from '../models/partnerApplication.js';
import RegisteredLink from '../models/registeredLink.js';
import Repository from '../models/repository.js';
import ShareVisit from '../models/shareVisit.js';
import Subscription from '../models/subscription.js';
import User from '../models/user.js';
import UserRepo from '../models/userRepo.js';
import { requireNonAdmin } from '../middleware/adminAuth.js';
import { anonymousAuth } from '../middleware/anonymousAuth.js';
import { FILTER_PUBLIC } from '../services/filters.js';
import { FILTER_ACCESSIBLE, bucketVisibility, enrichReposWithBucketThumbnails, trackBucketView } from '../services/buckets.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Old share links, mounted at /share
// =============================================================================

const bucketShareRouter = express.Router();

// Serve bucket thumbnail as actual image (must come BEFORE redirect route)
bucketShareRouter.get('/bucket/:bucketId/thumbnail.jpg', async (req, res) => {
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
bucketShareRouter.get('/bucket/:bucketId', (req, res) => {
    res.redirect(301, `/v2/b/${req.params.bucketId}`);
});

router.use('/share', bucketShareRouter);

// Route root based on hostname:
//   grabbn.com / www.grabbn.com  → landing page
//   app.grabbn.com               → the app
router.get('/', (req, res) => {
    const host = req.hostname; // excludes port
    if (host === 'app.grabbn.com') {
        res.redirect('/showroom');
    } else {
        res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
    }
});

// ---------------------------------------------------------------------------
// App routes — server-rendered with EJS
// ---------------------------------------------------------------------------
const publicPages = [
    { path: '/showroom',       view: 'public/showroom',        title: 'Show Room',       page: 'home'          },
    { path: '/explore',        view: 'public/explore',         title: 'Explore',         page: 'explore'       },
    { path: '/docs',           view: 'public/docs',            title: 'Docs',            page: 'docs'          },
    { path: '/faq',            view: 'public/faq',             title: 'FAQ',             page: 'faq'           },
    { path: '/contact',        view: 'public/contact',         title: 'Contact',         page: 'contact'       },
    { path: '/partnership',    view: 'public/partnership',     title: 'Partner Program', page: 'partnership'   },
];

for (const { path: routePath, view, title, page } of publicPages) {
    router.get(routePath, anonymousAuth, requireNonAdmin, (req, res) => {
        res.render(view, { title, page, user: req.user ?? null });
    });
}

const BOT_UA_RE = /bot|crawl|slurp|spider|mediapartners|facebookexternalhit|whatsapp|twitterbot|linkedinbot|embedly|quora|showyoubot|outbrain|pinterest|vkShare|W3C_Validator|headless|python-requests|node-fetch|axios|java\/|curl\/|wget\//i;

function isBot(req) {
    const ua = req.headers['user-agent'] || '';
    return BOT_UA_RE.test(ua);
}

// Partnership apply page — custom handler to pass application status to template
router.get('/partnership/apply', anonymousAuth, requireNonAdmin, async (req, res) => {
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
    res.render('public/partnership-apply', {
        title: 'Apply — Partner Program',
        page:  'partnership',
        user:  u ?? null,
        applicationStatus: applicationStatus ?? null
    });
});

// Partnership program — PDF export
router.get('/partnership/pdf', async (req, res) => {
    let browser;
    try {
        const puppeteer = (await import('puppeteer')).default;
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();

        // A4 at 96dpi = 794px wide; give enough height so nothing is cropped before PDF generation
        await page.setViewport({ width: 794, height: 1200 });

        // Read here, not at load time: dotenv.config() in server.js runs after this file is imported.
        const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
        await page.goto(`${baseUrl}/partnership`, { waitUntil: 'networkidle0', timeout: 15000 });

        // Strip all navigation chrome, let only the main content column render
        await page.addStyleTag({ content: `
            header, nav, aside, footer,
            [id*="sidebar"], [id*="topbar"], [class*="sidebar"], [class*="topbar"],
            [id="notificationModal"], [id="messagesModal"] {
                display: none !important;
            }
            html, body {
                background: white !important;
                height: auto !important;
                overflow: visible !important;
            }
        ` });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '14mm', right: '14mm', bottom: '14mm', left: '14mm' },
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="grabbn-partner-program.pdf"');
        res.send(pdf);
    } catch (err) {
        console.error('[partnership/pdf]', err);
        res.status(500).send('Failed to generate PDF');
    } finally {
        if (browser) await browser.close();
    }
});

// Block admin accounts from the regular user frontend — redirect to /admin
router.use('/showroom', requireNonAdmin);

// Search page — /v2/search?q=<query>[&type=people|buckets|repos]
router.get('/search', anonymousAuth, async (req, res) => {
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

        res.render('public/search', {
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
        res.render('public/search', {
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

// Legacy @username redirect
router.get('/@:username', (req, res) => {
    res.redirect(301, `/u/${req.params.username}`);
});

// Profile page — /v2/u/:username  (public — anyone can view)
router.get('/u/:username', anonymousAuth, async (req, res) => {
    try {
        const profileUser = await User.findOne({ username: req.params.username, isAnonymous: false }).lean();
        if (!profileUser) return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user ?? null });

        const viewer  = req.user ?? null;
        const isOwner = !!(viewer && !viewer.isAnonymous && viewer._id.toString() === profileUser._id.toString());

        if (!isOwner) {
            const visibility = profileUser.privacy?.accountVisibility ?? 'public';
            if (visibility === 'private')
                return res.status(404).render('public/404', { title: 'Not Found', page: '', user: viewer });

            if (viewer && !viewer.isAnonymous) {
                const blocked = await Block.exists({ blockerId: profileUser._id, blockedId: viewer._id });
                if (blocked) return res.status(404).render('public/404', { title: 'Not Found', page: '', user: viewer });
            }
        }

        const addDisplayThumb = (b) => ({
            ...b,
            _id: b._id.toString(),
            displayThumb: b.thumbnail || null,
        });

        const bucketFilter = isOwner
            ? { userId: profileUser._id }
            : { userId: profileUser._id, ...FILTER_PUBLIC, isArchived: { $ne: true } };

        const canMessage = isOwner ? false : await resolveCanMessage(viewer, profileUser);

        const isBlocked = (!isOwner && viewer && !viewer.isAnonymous)
            ? !!(await Block.exists({ blockerId: viewer._id, blockedId: profileUser._id }))
            : false;

        const [allBuckets, subscriberCount, followingCount, rawGrabbed, userRepos] = await Promise.all([
            Bucket.find(bucketFilter)
                .select('name description thumbnail visibility isPublic isPaywalled price links._id viewCount shareCount grabbedBy sourceUrl hashtags mature isDraft isArchived allowComments allowGrabs ratingCount ratingSum repoIds createdAt updatedAt' + (isOwner ? ' bucketOwningId' : ''))
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

        const ownBuckets        = allBuckets.filter(b => !b.isArchived).map(addDisplayThumb);
        const archivedBuckets   = isOwner ? allBuckets.filter(b => b.isArchived).map(addDisplayThumb) : [];
        const grabbedBuckets    = rawGrabbed.map(addDisplayThumb);
        const publicBucketCount = allBuckets.filter(b => b.visibility === 'public' && !b.isArchived).length;
        const publicRepoIds     = new Set(allBuckets.filter(b => b.visibility === 'public').flatMap(b => (b.repoIds || []).map(id => id.toString())));
        const publicRepoCount   = userRepos.filter(r => publicRepoIds.has(r._id.toString())).length;
        const totalViews     = ownBuckets.reduce((sum, b) => sum + (b.viewCount       ?? 0), 0);
        const totalGrabs     = ownBuckets.reduce((sum, b) => sum + (b.grabbedBy?.length ?? 0), 0);
        const memberSince    = new Date(profileUser.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

        res.render('public/profile', {
            title:       `@${profileUser.username}`,
            page:        'profile',
            user:        viewer,
            profileUser,
            isOwner,
            ownBuckets,
            archivedBuckets,
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
        res.status(500).render('public/404', { title: 'Error', page: '', user: req.user ?? null });
    }
});

// Dynamic repository page — domain + tag come from the path
// User-created repo page — single ObjectId segment distinguishes it from domain+tag repos
router.get('/o/:repoId', anonymousAuth, async (req, res) => {
    try {
        const { repoId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(repoId)) {
            return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        const repo = await UserRepo.findById(repoId).lean();
        if (!repo) return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user ?? null });

        const viewer  = req.user ?? null;
        const owner   = await User.findById(repo.userId).select('username avatar anonymousId').lean();
        if (!owner) return res.status(404).render('public/404', { title: 'Not Found', page: '', user: viewer });

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

        res.render('public/repo', {
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
        res.status(500).render('public/404', { title: 'Error', page: '', user: req.user ?? null });
    }
});

router.get('/o/:topic/:tag', anonymousAuth, (req, res) => {
    const topic = req.params.topic || '';
    const tag   = req.params.tag   || '';
    res.render('public/repository', { title: `#${tag} in ${topic}`, page: 'repository', user: req.user ?? null, domain: topic, tag });
});

// Report page — /v2/report/:bucketId
router.get('/report/:bucketId', anonymousAuth, async (req, res) => {
    try {
        const { bucketId } = req.params;
        const bucket = await Bucket.findById(bucketId).lean();
        if (!bucket) return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user ?? null });

        const vis = bucketVisibility(bucket);
        const isOwner = !!(req.user && !req.user.isAnonymous && bucket.userId.toString() === req.user._id.toString());
        if (vis === 'private' && !isOwner) {
            return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        const curator = await User.findById(bucket.userId).select('username avatar anonymousId').lean();
        const curatorName   = curator?.username || 'Anonymous';
        const curatorAvatar = curator?.avatar   || null;
        const thumbnailUrl  = bucket.thumbnail  || bucket.links?.find(l => l.image)?.image || null;

        res.render('public/report', {
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
router.get('/b/:bucketId/thumbnail.jpg', async (req, res) => {
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

// Bucket view page — /v2/b/:bucketId  (accessible to anyone)
router.get('/b/:bucketId', anonymousAuth, async (req, res) => {
    try {
        const { bucketId } = req.params;
        const bucket = await Bucket.findById(bucketId).lean();
        if (!bucket) return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user ?? null });

        const curator = await User.findById(bucket.userId).select('username avatar anonymousId').lean();
        const curatorName        = curator?.username    || 'Anonymous';
        const curatorAvatar      = curator?.avatar      || null;
        const curatorAnonymousId = curator?.anonymousId || null;

        const thumbnailUrl = bucket.thumbnail || bucket.links?.find(l => l.image)?.image || null;
        const shareBaseUrl = `${req.protocol}://${req.get('host')}`;

        const vis = bucketVisibility(bucket);
        const isOwner = !!(req.user && !req.user.isAnonymous && bucket.userId.toString() === req.user._id.toString());
        if (vis === 'private' && !isOwner) {
            return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user ?? null });
        }
        if (!isOwner && ['public', 'unlisted'].includes(vis) && (bucket.links?.length ?? 0) < 3) {
            return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user ?? null });
        }

        // Block check: if bucket's curator has blocked the viewer, treat as 404
        if (!isOwner && req.user && !req.user.isAnonymous) {
            const blocked = await Block.exists({ blockerId: bucket.userId, blockedId: req.user._id });
            if (blocked) return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user ?? null });
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
        let commentBlockReason = null; // 'clicks' | 'no_one' | 'followers' | 'followees' | null
        let canRate    = false;
        let userRating = null;
        if (!isOwner && req.user && !req.user.isAnonymous) {
            const clickCount = await LinkClick.countDocuments({ bucketId, userId: req.user._id });
            const hasClicks  = clickCount >= 2;

            const perm = bucket.allowComments;
            const normalizedPerm = (perm === false || perm === 'false') ? 'no_one'
                : (perm === true || perm === 'true' || !perm) ? 'everyone'
                : perm;

            if (normalizedPerm === 'no_one') {
                commentBlockReason = 'no_one';
            } else if (normalizedPerm === 'followers') {
                const isFollower = !!(await Subscription.exists({ followerId: req.user._id, followeeId: curator._id }));
                if (!isFollower) commentBlockReason = 'followers';
                else if (!hasClicks) commentBlockReason = 'clicks';
                else canComment = true;
            } else if (normalizedPerm === 'followees') {
                const isFollowee = !!(await Subscription.exists({ followerId: curator._id, followeeId: req.user._id }));
                if (!isFollowee) commentBlockReason = 'followees';
                else if (!hasClicks) commentBlockReason = 'clicks';
                else canComment = true;
            } else {
                // 'everyone'
                if (!hasClicks) commentBlockReason = 'clicks';
                else canComment = true;
            }

            if (hasGrabbed) {
                const existingRating = await BucketRating.findOne({ bucketId, userId: req.user._id }).select('stars').lean();
                canRate    = clickCount >= 2;
                userRating = existingRating?.stars ?? null;
            }
        }
        const ratingCount    = bucket.ratingCount || 0;
        const ratingAvg      = ratingCount > 0 ? Math.round((bucket.ratingSum / ratingCount) * 10) / 10 : null;
        const commentCount   = await BucketComment.countDocuments({ bucketId, deletedAt: null });

        // Track view (fire-and-forget, skip owner and bots)
        if (!isOwner && !isBot(req)) {
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

        // Fetch registration info for links not owned by this bucket's creator (for attribution display)
        const bucketHrefs = bucket.links.map(l => l.href);
        const foreignRegs = await RegisteredLink.find({
            url:          { $in: bucketHrefs },
            registeredBy: { $ne: bucket.userId }
        }).select('url registrantUsername status').lean();
        const linkRegistrations = Object.fromEntries(
            foreignRegs.map(r => [r.url, { registrantUsername: r.registrantUsername, status: r.status }])
        );

        res.render('public/bucket', {
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
            commentBlockReason,
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
            linkRegistrations,
        });
    } catch (err) {
        console.error('Error loading bucket view:', err);
        res.status(500).send('Error loading bucket');
    }
});


router.routes = [
  { method: 'GET', path: '/share/bucket/:bucketId/thumbnail.jpg', label: 'Shared bucket thumbnail' },
  { method: 'GET', path: '/share/bucket/:bucketId', label: 'Old share link: redirects to the bucket page' },
  { method: 'GET', path: '/', label: 'Landing page, or the app on app.grabbn.com' },
  { method: 'GET', path: '/showroom', label: 'Show Room page' },
  { method: 'GET', path: '/explore', label: 'Explore page' },
  { method: 'GET', path: '/docs', label: 'Docs page' },
  { method: 'GET', path: '/faq', label: 'FAQ page' },
  { method: 'GET', path: '/contact', label: 'Contact page' },
  { method: 'GET', path: '/partnership', label: 'Partner program page' },
  { method: 'GET', path: '/partnership/apply', label: 'Partner application page' },
  { method: 'GET', path: '/partnership/pdf', label: 'Partner program as a PDF' },
  { method: 'GET', path: '/search', label: 'Search page' },
  { method: 'GET', path: '/@:username', label: 'Old profile link: redirects to /u/:username' },
  { method: 'GET', path: '/u/:username', label: 'Profile page' },
  { method: 'GET', path: '/o/:repoId', label: 'Repo page' },
  { method: 'GET', path: '/o/:topic/:tag', label: 'Repository page' },
  { method: 'GET', path: '/report/:bucketId', label: 'Report a bucket page' },
  { method: 'GET', path: '/b/:bucketId/thumbnail.jpg', label: 'Bucket thumbnail' },
  { method: 'GET', path: '/b/:bucketId', label: 'Bucket page' },
];

export default router;
