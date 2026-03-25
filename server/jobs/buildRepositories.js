import LinkClick from '../models/linkClick.js';
import Bucket from '../models/bucket.js';
import Repository from '../models/repository.js';

// ─── Tuning constants ───────────────────────────────────────────────────────
const TOP_LINKS_PER_DOMAIN = 10;  // max links stored per repo
const TOP_DOMAINS          = 100; // max repos to keep in the cache
const MIN_CLICKS           = 2;   // ignore a domain with a single stray click
const RECENCY_HALF_LIFE    = 90;  // days at which a click counts as 50% weight

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

    // ── Stage 1: aggregate LinkClick → top hrefs grouped by domain ──────────
    const clickData = await LinkClick.aggregate([
        // Group by (href, domain): count clicks, collect unique buckets, track recency
        {
            $group: {
                _id:             { href: '$href', domain: '$domain' },
                totalClicks:     { $sum: 1 },
                distinctBuckets: { $addToSet: '$bucketId' },
                lastClickAt:     { $max: '$createdAt' }
            }
        },
        // Materialise bucket spread so downstream stages can see it
        {
            $addFields: { bucketSpread: { $size: '$distinctBuckets' } }
        },
        // Sort best links first so $push inside the next $group preserves order
        { $sort: { totalClicks: -1 } },

        // Group by domain: collect all its links + sum domain-level click total
        // allBucketArrays collects every per-link distinctBuckets array so we can
        // flatten + deduplicate them in JS to get the true domain-level bucket count
        {
            $group: {
                _id: '$_id.domain',
                links: {
                    $push: {
                        href:            '$_id.href',
                        totalClicks:     '$totalClicks',
                        bucketSpread:    '$bucketSpread',
                        lastClickAt:     '$lastClickAt'
                    }
                },
                domainTotalClicks: { $sum: '$totalClicks' },
                allBucketArrays:   { $push: '$distinctBuckets' }
            }
        },
        // Drop domains that barely exist
        { $match: { domainTotalClicks: { $gte: MIN_CLICKS } } },
        { $sort: { domainTotalClicks: -1 } },
        { $limit: TOP_DOMAINS }
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
                curatorId: { $first: '$userId' }   // owner of the first matching public bucket
            }
        }
    ]);

    // href → { text, image, curatorId }
    const metaMap = Object.fromEntries(
        linkMeta.map(m => [m._id, { text: m.text || '', image: m.image || '', curatorId: m.curatorId || null }])
    );

    // ── Stage 3: score links and upsert into the Repository cache ────────────
    const ops = clickData.map(domain => {
        // Flatten all per-link distinctBuckets arrays → unique bucket count for this domain
        const domainBucketCount = new Set(
            domain.allBucketArrays.flat().map(id => String(id))
        ).size;

        const scoredLinks = domain.links
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
            .slice(0, TOP_LINKS_PER_DOMAIN);

        return {
            updateOne: {
                filter: { domain: domain._id },
                update: {
                    $set: {
                        domain:      domain._id,
                        topLinks:    scoredLinks,
                        totalClicks: domain.domainTotalClicks,
                        bucketCount: domainBucketCount,
                        rebuiltAt:   new Date()
                    }
                },
                upsert: true
            }
        };
    });

    await Repository.bulkWrite(ops);

    // Remove domains that dropped out of the top list
    const activeDomains = clickData.map(d => d._id);
    await Repository.deleteMany({ domain: { $nin: activeDomains } });

    console.log(`[repos] Rebuilt ${ops.length} repositories in ${Date.now() - t0}ms`);
}
