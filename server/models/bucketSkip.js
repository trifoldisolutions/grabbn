import mongoose from 'mongoose';

// Tracks per-user "not interested" skips.
// Used to:
//   1. Filter skipped buckets from a user's future feed.
//   2. Aggregate skipCount on the Bucket for the exploreScore penalty.
const bucketSkipSchema = new mongoose.Schema({
    bucketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bucket', required: true },
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',   default: null },
    ip:       { type: String, default: null },  // anon fallback
    category: { type: String, default: null },  // level-1 reason (e.g. "not-relevant")
    reason:   { type: String, default: null },  // level-2 sub-reason (e.g. "not-my-style")
}, { timestamps: true });

// Fast existence check: did this user/IP already skip this bucket?
bucketSkipSchema.index({ bucketId: 1, userId: 1 }, { sparse: true });
bucketSkipSchema.index({ bucketId: 1, ip: 1 },     { sparse: true });

// Feed filtering: fetch all bucket IDs skipped by a given user
bucketSkipSchema.index({ userId: 1 });

export default mongoose.model('BucketSkip', bucketSkipSchema);
