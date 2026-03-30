import mongoose from 'mongoose';

const bucketShareSchema = new mongoose.Schema({
    bucketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bucket', required: true },
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

// Unique constraint — the DB enforces one share record per user per bucket,
// making duplicate-key errors the dedup mechanism (race-condition-safe).
bucketShareSchema.index({ bucketId: 1, userId: 1 }, { unique: true });

export default mongoose.model('BucketShare', bucketShareSchema);
