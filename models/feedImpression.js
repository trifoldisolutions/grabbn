import mongoose from 'mongoose';

// Tracks which buckets were returned in a user's feed (not page visits).
// Records expire after 2 hours so the same bucket can resurface after that window.
const feedImpressionSchema = new mongoose.Schema({
    bucketId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Bucket', required: true },
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    anonymousId: { type: String, default: null },
    expiresAt:   { type: Date, required: true }
});

// Fast lookup: "which buckets has this user already seen?"
feedImpressionSchema.index({ userId: 1, bucketId: 1 }, { sparse: true });
feedImpressionSchema.index({ anonymousId: 1, bucketId: 1 }, { sparse: true });

// MongoDB auto-deletes documents once expiresAt is reached
feedImpressionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('FeedImpression', feedImpressionSchema);
