import mongoose from 'mongoose';

const bucketViewSchema = new mongoose.Schema({
    bucketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bucket', required: true },
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ip:       { type: String, default: null },
    expiresAt: { type: Date, default: null }
}, { timestamps: true });

// Fast dedup lookups
bucketViewSchema.index({ bucketId: 1, userId: 1 }, { sparse: true });
bucketViewSchema.index({ bucketId: 1, ip: 1 },     { sparse: true });

// TTL: MongoDB ignores documents where expiresAt is null,
// so logged-in records (expiresAt: null) are kept permanently
// while anon records (expiresAt: now+6h) are auto-deleted.
bucketViewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('BucketView', bucketViewSchema);
