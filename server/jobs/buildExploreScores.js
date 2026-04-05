import Bucket from '../models/bucket.js';
import TopicScore from '../models/topicScore.js';
import { FILTER_PUBLIC } from '../utils/filters.js';

// ─── Tuning constants ─────────────────────────────────────────────────────────
const SCORE_HALF_LIFE_DAYS    = 30;  // creation-age half-life
const ACTIVITY_HALF_LIFE_DAYS = 14;  // recent-activity half-life (shorter = rewards fresh traction more)
const SCORE_FLOOR             = 0.1; // minimum recency multiplier (old buckets never zero out)
const BATCH_SIZE              = 500;
const COLD_START_BOOST_DAYS   = 7;   // new buckets get a temporary boost for this many days
const COLD_START_BOOST_MAX    = 1.5; // additive bonus at day 0, tapering linearly to 0 by day 7

// ─── Scoring helpers ──────────────────────────────────────────────────────────

/**
 * Blended recency decay using both createdAt and lastMeaningfulActivityAt.
 *
 * Two independent decay curves are computed:
 *   - Age decay      : 30d half-life anchored to createdAt
 *   - Activity decay : 14d half-life anchored to lastMeaningfulActivityAt
 *                      (only real content events: new link added, link href changed)
 *
 * We take the better (max) of the two so that:
 *   - A new bucket benefits from its naturally high age decay.
 *   - An old bucket that gains fresh links/content gets rescued by the activity
 *     decay instead of being crushed by its creation age.
 */
function recencyDecay(createdAt, lastMeaningfulActivityAt) {
    const now = Date.now();
    const daysSinceCreated   = (now - new Date(createdAt))                            / 86_400_000;
    const daysSinceActivity  = (now - new Date(lastMeaningfulActivityAt || createdAt)) / 86_400_000;

    const ageDecay      = Math.exp((-Math.LN2 / SCORE_HALF_LIFE_DAYS)    * daysSinceCreated);
    const activityDecay = Math.exp((-Math.LN2 / ACTIVITY_HALF_LIFE_DAYS) * daysSinceActivity);

    return Math.max(SCORE_FLOOR, Math.max(ageDecay, activityDecay));
}

/**
 * Returns a linearly-decaying cold-start boost for new buckets.
 * Full bonus (COLD_START_BOOST_MAX) at day 0, zero at COLD_START_BOOST_DAYS.
 */
function coldStartBoost(createdAt) {
    const daysSinceCreated = (Date.now() - new Date(createdAt)) / 86_400_000;
    if (daysSinceCreated >= COLD_START_BOOST_DAYS) return 0;
    return COLD_START_BOOST_MAX * (1 - daysSinceCreated / COLD_START_BOOST_DAYS);
}

/**
 * exploreScore formula (all log terms use natural log):
 *   ( log(grabbedBy.length + 1) × 1.2          — intentional curation (reduced: was 2.0)
 *   + log(Σ links[].clickCount + 1) × 1.0      — active engagement (raised: was 0.8)
 *   + log(directViewCount + 1) × 0.3           — organic reach (explore-driven views excluded)
 *   + log(verifiedShareCount + 1) × 0.5        — confirmed distribution (arrival via shared link)
 *   + min(hashtags.length × 0.1, 0.5)          — topic diversity bonus
 *   + log(ratingSum + 1) × 0.8                 — quality signal (sum of 1–3 star ratings from verified consumers)
 *   - log(skipCount + 1) × 1.2 )               — "not interested" penalty (unique skippers only)
 *   × recencyDecay(createdAt, lastMeaningfulActivityAt)
 *   + coldStartBoost(createdAt)                 — additive boost for first 7 days, only if bucket has links
 */
function computeExploreScore(bucket) {
    const grabCount          = (bucket.grabbedBy || []).length;
    const totalClicks        = bucket._totalLinkClicks    || 0;
    const directViewCount    = bucket.directViewCount     || 0;
    const verifiedShareCount = bucket.verifiedShareCount  || 0;
    const skipCount          = bucket.skipCount           || 0;
    const hashtagCount       = (bucket.hashtags || []).length;
    const linkCount          = (bucket.links    || []).length;
    const ratingSum          = bucket.ratingSum            || 0;

    const base =
        Math.log(grabCount + 1)          * 1.2 +
        Math.log(totalClicks + 1)        * 1.0 +
        Math.log(directViewCount + 1)    * 0.3 +
        Math.log(verifiedShareCount + 1) * 0.5 +
        Math.min(hashtagCount * 0.1, 0.5) +
        Math.log(ratingSum + 1)          * 0.8 -
        Math.log(skipCount + 1)          * 1.2;

    const decayed = Math.max(0, base) * recencyDecay(bucket.createdAt, bucket.lastMeaningfulActivityAt);

    // Cold-start boost only applies to buckets with at least one link — empty buckets
    // shouldn't be surfaced before any engagement signals have accumulated.
    const boost = linkCount > 0 ? coldStartBoost(bucket.createdAt) : 0;

    return Math.round((decayed + boost) * 10000) / 10000;
}

/**
 * Derive the primary topic for a bucket.
 *
 * Topic is always a domain or subdomain — never a hashtag.
 * Priority order:
 *   1. sourceUrl domain
 *   2. Pinned link's domain
 *   3. Link with the highest clickCount
 *   4. First link in the array
 */
function deriveTopic(bucket) {
    function hostname(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
    }

    if (bucket.sourceUrl) {
        const h = hostname(bucket.sourceUrl);
        if (h) return h;
    }

    const links = bucket.links || [];

    const pinned = links.find(l => l.isPinned);
    if (pinned?.href) {
        const h = hostname(pinned.href);
        if (h) return h;
    }

    const byClicks = [...links].sort((a, b) => (b.clickCount || 0) - (a.clickCount || 0));
    if (byClicks[0]?.href) {
        const h = hostname(byClicks[0].href);
        if (h) return h;
    }

    if (links[0]?.href) {
        return hostname(links[0].href);
    }

    return null;
}

// ─── Main job ─────────────────────────────────────────────────────────────────

export async function buildExploreScores() {
    console.log('[explore] Starting score rebuild…');
    const t0 = Date.now();

    // Zero out scores for any public buckets that no longer have a thumbnail
    // so they are immediately excluded from explore queries.
    await Bucket.collection.updateMany(
        {
            $and: [
                FILTER_PUBLIC,
                { isDraft: { $ne: true } },
                { $or: [{ thumbnail: { $exists: false } }, { thumbnail: '' }] }
            ]
        },
        { $set: { exploreScore: 0 } }
    );

    // Stream a cursor over all public, non-draft buckets.
    // Project only the fields needed to compute the score and topic.
    const cursor = Bucket.aggregate([
        {
            $match: {
                ...FILTER_PUBLIC,
                isDraft:   { $ne: true },
                name:      { $ne: 'Singletons' },
                thumbnail: { $exists: true, $ne: '' }
            }
        },
        {
            $project: {
                grabbedBy:                1,
                directViewCount:          1,
                verifiedShareCount:       1,
                skipCount:                1,
                hashtags:                 1,
                createdAt:                1,
                lastMeaningfulActivityAt: 1,
                sourceUrl:                1,
                ratingSum:                1,
                links:                    { href: 1, isPinned: 1, clickCount: 1 },
                _totalLinkClicks:         { $sum: '$links.clickCount' }
            }
        }
    ]).cursor();

    let ops   = [];
    let total = 0;
    const now = new Date();

    for await (const bucket of cursor) {
        const score = computeExploreScore(bucket);
        const topic = deriveTopic(bucket);

        ops.push({
            updateOne: {
                filter: { _id: bucket._id },
                update: { $set: { exploreScore: score, exploreScoreUpdatedAt: now, topic } }
            }
        });

        if (ops.length >= BATCH_SIZE) {
            await Bucket.collection.bulkWrite(ops);
            total += ops.length;
            ops = [];
        }
    }

    if (ops.length) {
        await Bucket.collection.bulkWrite(ops);
        total += ops.length;
    }

    console.log(`[explore] Scored ${total} buckets in ${Date.now() - t0}ms`);

    // ── Topic score aggregation ───────────────────────────────────────────────
    // After all buckets have been scored and their topics set, aggregate
    // exploreScore by topic to produce a weekly-fresh domain ranking.
    console.log('[explore] Rebuilding topic scores…');
    const t1 = Date.now();

    const topicAgg = await Bucket.aggregate([
        {
            $match: {
                ...FILTER_PUBLIC,
                isDraft:   { $ne: true },
                topic:     { $ne: null },
                thumbnail: { $exists: true, $ne: '' }
            }
        },
        {
            $group: {
                _id:         '$topic',
                score:       { $sum: '$exploreScore' },
                bucketCount: { $sum: 1 }
            }
        }
    ]);

    if (topicAgg.length) {
        const topicOps = topicAgg.map(t => ({
            updateOne: {
                filter: { domain: t._id },
                update: { $set: { domain: t._id, score: t.score, bucketCount: t.bucketCount, updatedAt: now } },
                upsert: true
            }
        }));
        await TopicScore.bulkWrite(topicOps);
    }

    console.log(`[explore] Topic scores updated for ${topicAgg.length} domains in ${Date.now() - t1}ms`);
}
