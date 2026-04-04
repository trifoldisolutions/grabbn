import mongoose from 'mongoose';

// One record per (bucketId, sid, userId) or (bucketId, sid, ip).
// Deduplicates verifiedShareCount: a recipient refreshing the same share link
// doesn't inflate the count, but each distinct visitor counts once per sid.
const shareVisitSchema = new mongoose.Schema({
    bucketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bucket', required: true, index: true },
    sid:      { type: String, required: true, maxlength: 32 },
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ip:       { type: String, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Fast dedup lookups
shareVisitSchema.index({ bucketId: 1, sid: 1, userId: 1 }, { sparse: true });
shareVisitSchema.index({ bucketId: 1, sid: 1, ip: 1 },     { sparse: true });

// Auto-expire after 90 days — share links older than that can be counted fresh
shareVisitSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7_776_000 });

export default mongoose.model('ShareVisit', shareVisitSchema);
