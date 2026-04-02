// Shared MongoDB filter helpers

// Matches buckets that are publicly discoverable (visibility = 'public', or legacy isPublic = true).
export const FILTER_PUBLIC = {
    $or: [
        { visibility: 'public' },
        { visibility: { $exists: false }, isPublic: true },
    ]
};
