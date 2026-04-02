import Bucket from '../models/bucket.js';
import TopicScore from '../models/topicScore.js';
import { FILTER_PUBLIC } from '../utils/filters.js';

// ─── Tuning constants ─────────────────────────────────────────────────────────
const SCORE_HALF_LIFE_DAYS    = 30;  // creation-age half-life
const ACTIVITY_HALF_LIFE_DAYS = 14;  // recent-activity half-life (shorter = rewards fresh traction more)
const SCORE_FLOOR             = 0.1; // minimum recency multiplier (old buckets never zero out)
const BATCH_SIZE              = 500;

// ─── Scoring helpers ──────────────────────────────────────────────────────────

/**
 * Blended recency decay using both createdAt and updatedAt.
 *
 * Two independent decay curves are computed:
 *   - Age decay    : 30d half-life anchored to createdAt
 *   - Activity decay: 14d half-life anchored to updatedAt
 *
 * We take the better (max) of the two so that:
 *   - A new bucket benefits from its naturally high age decay.
 *   - An old bucket that gains recent traction (grabs, edits) gets rescued
 *     by the activity decay instead of being crushed by its creation age.
 */
function recencyDecay(createdAt, updatedAt) {
    const now = Date.now();
    const daysSinceCreated  = (now - new Date(createdAt))            / 86_400_000;
    const daysSinceUpdated  = (now - new Date(updatedAt || createdAt)) / 86_400_000;

    const ageDecay      = Math.exp((-Math.LN2 / SCORE_HALF_LIFE_DAYS)    * daysSinceCreated);
    const activityDecay = Math.exp((-Math.LN2 / ACTIVITY_HALF_LIFE_DAYS) * daysSinceUpdated);

    return Math.max(SCORE_FLOOR, Math.max(ageDecay, activityDecay));
}

/**
 * exploreScore formula (all log terms use natural log):
 *   ( log(grabbedBy.length + 1) × 2.0      — intentional curation
 *   + log(Σ links[].clickCount + 1) × 0.8  — active engagement
 *   + log(viewCount + 1) × 0.3             — passive reach
 *   + log(shareCount + 1) × 0.5            — intentional distribution
 *   + min(hashtags.length × 0.1, 0.5) )    — topic diversity bonus
 *   × recencyDecay(createdAt, halfLife=30d)
 */
function computeExploreScore(bucket) {
    const grabCount      = (bucket.grabbedBy || []).length;
    const totalClicks    = bucket._totalLinkClicks || 0;
    const viewCount      = bucket.viewCount  || 0;
    const shareCount     = bucket.shareCount || 0;
    const hashtagCount   = (bucket.hashtags  || []).length;

    const base =
        Math.log(grabCount + 1)    * 2.0 +
        Math.log(totalClicks + 1)  * 0.8 +
        Math.log(viewCount + 1)    * 0.3 +
        Math.log(shareCount + 1)   * 0.5 +
        Math.min(hashtagCount * 0.1, 0.5);

    return Math.round(base * recencyDecay(bucket.createdAt, bucket.updatedAt) * 10000) / 10000;
}

/**
 * Derive the primary domain topic for a bucket.
 *
 * Priority order:
 *   1. sourceUrl (curator-declared source)
 *   2. Pinned link's domain
 *   3. Link with the highest clickCount
 *   4. First link in the array
 *
 * Returns the hostname with leading "www." stripped, or null if no URL can be parsed.
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

    // Stream a cursor over all public, non-draft buckets.
    // Project only the fields needed to compute the score and topic.
    const cursor = Bucket.aggregate([
        {
            $match: {
                ...FILTER_PUBLIC,
                isDraft:  { $ne: true },
                name:     { $ne: 'Singletons' }
            }
        },
        {
            $project: {
                grabbedBy:         1,
                viewCount:         1,
                shareCount:        1,
                hashtags:          1,
                createdAt:         1,
                updatedAt:         1,
                sourceUrl:         1,
                links:             { href: 1, isPinned: 1, clickCount: 1 },
                _totalLinkClicks:  { $sum: '$links.clickCount' }
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
            await Bucket.bulkWrite(ops);
            total += ops.length;
            ops = [];
        }
    }

    if (ops.length) {
        await Bucket.bulkWrite(ops);
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
                isDraft: { $ne: true },
                topic:   { $ne: null }
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
