// Bucket helpers shared by the API and the public pages.
import Bucket from '../models/bucket.js';
import BucketView from '../models/bucketView.js';

// ---------------------------------------------------------------------------
// Visibility helpers — handle both new docs (visibility string) and old docs
// (isPublic boolean) so the migration is seamless.
// ---------------------------------------------------------------------------

// Derives the effective visibility string from a bucket document.
export function bucketVisibility(bucket) {
  if (bucket.visibility) return bucket.visibility;
  return bucket.isPublic ? 'public' : 'private';
}

// MongoDB filter that matches "link-accessible" buckets (public + unlisted)
// and meet the minimum link requirement enforced on write.
export const FILTER_ACCESSIBLE = {
  'links.2': { $exists: true },
  $or: [
    { visibility: { $in: ['public', 'unlisted'] } },
    { visibility: { $exists: false }, isPublic: true },
  ]
};

// Increment viewCount (and directViewCount when source !== 'explore') for a bucket,
// deduplicating permanently by userId (logged-in) or IP (anon).
// isOwner check must be done by the caller before invoking this.
export async function trackBucketView(bucketId, userId, ip, source) {
    const inc = source === 'explore'
        ? { viewCount: 1 }
        : source === 'showroom'
            ? { viewCount: 1, showroomViewCount: 1 }
            : { viewCount: 1, directViewCount: 1 };
    if (userId) {
        const exists = await BucketView.exists({ bucketId, userId });
        if (!exists) {
            await BucketView.create({ bucketId, userId, ip: null });
            await Bucket.findByIdAndUpdate(bucketId, { $inc: { ...inc, authViewCount: 1 } }, { timestamps: false });
        }
    } else {
        const exists = await BucketView.exists({ bucketId, ip });
        if (!exists) {
            await BucketView.create({ bucketId, userId: null, ip });
            await Bucket.findByIdAndUpdate(bucketId, { $inc: inc }, { timestamps: false });
        }
    }
}

// ---------------------------------------------------------------------------
// V2 API — repositories (pre-computed cache, rebuilt hourly)
// ---------------------------------------------------------------------------

// Attach up to 4 bucket thumbnails to each repo for the 2x2 thumbnail grid
export async function enrichReposWithBucketThumbnails(repos) {
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

