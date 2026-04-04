import mongoose from 'mongoose';

// One rating per (bucketId, userId) — gated by: user has grabbed the bucket
// AND has clicked at least 2 links from it (enforced at the API layer).
const bucketRatingSchema = new mongoose.Schema({
    bucketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bucket', required: true },
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
    stars:    { type: Number, required: true, min: 1, max: 3 },
}, { timestamps: true });

// Enforce one rating per user per bucket
bucketRatingSchema.index({ bucketId: 1, userId: 1 }, { unique: true });

// For fast per-bucket aggregation queries
bucketRatingSchema.index({ bucketId: 1 });

export default mongoose.model('BucketRating', bucketRatingSchema);
