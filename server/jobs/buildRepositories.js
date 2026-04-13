import LinkClick from '../models/linkClick.js';
import Bucket from '../models/bucket.js';
import Repository from '../models/repository.js';

// ─── Tuning constants ───────────────────────────────────────────────────────
const TOP_LINKS_PER_REPO = 10;  // max links stored per repo
const TOP_REPOS          = 200; // max (domain, tag) repos to keep
const MIN_CLICKS         = 2;   // ignore a (domain, tag) pair with a single stray click
const MIN_BUCKETS        = 1;   // min distinct buckets required before a repo is created
const RECENCY_HALF_LIFE  = 90;  // days at which a click counts as 50% weight

// ─── Scoring helpers ─────────────────────────────────────────────────────────

/**
 * Time-decay factor.
 * - A click from today  → 1.0
 * - A click from 90d   → 0.5
 * - A click from ∞     → floor of 0.3  (good old links are never zeroed out)
 */
function recencyFactor(lastClickAt) {
    const daysSince = (Date.now() - new Date(lastClickAt)) / 86_400_000;
    const decay = Math.exp((-Math.LN2 / RECENCY_HALF_LIFE) * daysSince);
    return Math.max(0.3, decay);
}

/**
 * Bucket-spread bonus.
 * A link that appears in many different people's buckets is more trustworthy.
 * - 1 bucket  → bonus 1.0  (no multiplier)
 * - 2 buckets → bonus 1.35
 * - 10 buckets → bonus 2.15
 */
function spreadBonus(bucketSpread) {
    return 1 + Math.log(Math.max(1, bucketSpread)) * 0.5;
}

/**
 * Final score for a link.
 * totalClicks drives magnitude; recency and spread are multipliers.
 */
function computeScore(link) {
    return link.totalClicks * recencyFactor(link.lastClickAt) * spreadBonus(link.bucketSpread);
}

// ─── Main job ────────────────────────────────────────────────────────────────

export async function buildRepositories() {
    console.log('[repos] Starting rebuild…');
    const t0 = Date.now();

    // ── Stage 1: aggregate LinkClicks joined with bucket hashtags ────────────
    // Groups by (href, domain, tag) where tag comes from the containing bucket's
    // hashtags. Only public buckets with at least one hashtag produce repos.
    const clickData = await LinkClick.aggregate([
        // Group by (href, domain, bucketId): count clicks per link per bucket
        {
            $group: {
                _id:         { href: '$href', domain: '$domain', bucketId: '$bucketId' },
                clicks:      { $sum: 1 },
                lastClickAt: { $max: '$createdAt' }
            }
        },
        // Join with the bucket to get its hashtags and visibility
        {
            $lookup: {
                from:         'buckets',
                localField:   '_id.bucketId',
                foreignField: '_id',
                as:           'bucket'
            }
        },
        { $unwind: '$bucket' },
        // Only public buckets that have at least one hashtag
        {
            $match: {
                'bucket.hashtags.0': { $exists: true },
                $or: [
                    { 'bucket.visibility': 'public' },
                    { 'bucket.isPublic': true }
                ]
            }
        },
        // Unwind hashtags — one record per (href, domain, bucketId, tag)
        { $unwind: '$bucket.hashtags' },
        // Group by (href, domain, tag): sum clicks, collect distinct buckets
        {
            $group: {
                _id:             { href: '$_id.href', domain: '$_id.domain', tag: '$bucket.hashtags' },
                totalClicks:     { $sum: '$clicks' },
                distinctBuckets: { $addToSet: '$_id.bucketId' },
                lastClickAt:     { $max: '$lastClickAt' }
            }
        },
        { $addFields: { bucketSpread: { $size: '$distinctBuckets' } } },
        { $sort: { totalClicks: -1 } },
        // Group by (domain, tag): collect all its links + domain-tag-level click total
        {
            $group: {
                _id: { domain: '$_id.domain', tag: '$_id.tag' },
                links: {
                    $push: {
                        href:         '$_id.href',
                        totalClicks:  '$totalClicks',
                        bucketSpread: '$bucketSpread',
                        lastClickAt:  '$lastClickAt'
                    }
                },
                domainTagTotalClicks: { $sum: '$totalClicks' },
                allBucketArrays:      { $push: '$distinctBuckets' }
            }
        },
        // Drop (domain, tag) pairs that barely exist
        { $match: { domainTagTotalClicks: { $gte: MIN_CLICKS } } },
        { $sort: { domainTagTotalClicks: -1 } },
        { $limit: TOP_REPOS }
    ]);

    if (!clickData.length) {
        console.log('[repos] No click data yet — skipping rebuild.');
        return;
    }

    // ── Stage 2: enrich links with text + image from any public bucket ───────
    const allHrefs = [...new Set(clickData.flatMap(d => d.links.map(l => l.href)))];

    const linkMeta = await Bucket.aggregate([
        { $match: { 'links.href': { $in: allHrefs }, $or: [{ visibility: 'public' }, { visibility: { $exists: false }, isPublic: true }] } },
        { $unwind: '$links' },
        { $match: { 'links.href': { $in: allHrefs } } },
        {
            $group: {
                _id:       '$links.href',
                text:      { $first: '$links.text' },
                image:     { $first: '$links.image' },
                curatorId: { $first: '$userId' }
            }
        }
    ]);

    // href → { text, image, curatorId }
    const metaMap = Object.fromEntries(
        linkMeta.map(m => [m._id, { text: m.text || '', image: m.image || '', curatorId: m.curatorId || null }])
    );

    // ── Stage 3: score links and upsert into the Repository cache ────────────
    const ops = [];

    for (const repo of clickData) {
        const repoBucketCount = new Set(
            repo.allBucketArrays.flat().map(id => String(id))
        ).size;

        // Enforce minimum quality bar — skip thin (domain, tag) pairs
        if (repoBucketCount < MIN_BUCKETS) continue;

        const scoredLinks = repo.links
            .map(link => {
                const meta = metaMap[link.href] || {};
                return {
                    href:         link.href,
                    text:         meta.text      || '',
                    image:        meta.image     || '',
                    curatorId:    meta.curatorId || null,
                    totalClicks:  link.totalClicks,
                    bucketSpread: link.bucketSpread,
                    score:        Math.round(computeScore(link) * 100) / 100
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, TOP_LINKS_PER_REPO);

        ops.push({
            updateOne: {
                filter: { domain: repo._id.domain, tag: repo._id.tag },
                update: {
                    $set: {
                        domain:      repo._id.domain,
                        tag:         repo._id.tag,
                        topLinks:    scoredLinks,
                        totalClicks: repo.domainTagTotalClicks,
                        bucketCount: repoBucketCount,
                        rebuiltAt:   new Date()
                    }
                },
                upsert: true
            }
        });
    }

    await Repository.bulkWrite(ops);

    // Remove (domain, tag) pairs that dropped out of the top list
    const activeKeys = clickData.map(d => ({ domain: d._id.domain, tag: d._id.tag }));
    await Repository.deleteMany({
        $nor: activeKeys.map(k => ({ domain: k.domain, tag: k.tag }))
    });

    console.log(`[repos] Rebuilt ${ops.length} repositories in ${Date.now() - t0}ms`);
}
