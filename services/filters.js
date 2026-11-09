// Shared MongoDB filter helpers

// Matches buckets that are publicly discoverable (visibility = 'public', or legacy isPublic = true)
// and meet the minimum link requirement enforced on write.
export const FILTER_PUBLIC = {
    'links.2': { $exists: true },
    $or: [
        { visibility: 'public' },
        { visibility: { $exists: false }, isPublic: true },
    ]
};
