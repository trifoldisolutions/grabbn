import mongoose from 'mongoose';

// One record per (bucketId, userId) or (bucketId, ip) — permanent for both logged-in and anon.
// A view means "this unique person/IP ever saw this bucket" — aligns with how grabs work.
const bucketViewSchema = new mongoose.Schema({
    bucketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bucket', required: true },
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ip:       { type: String, default: null },
}, { timestamps: true });

// Fast dedup lookups
bucketViewSchema.index({ bucketId: 1, userId: 1 }, { sparse: true });
bucketViewSchema.index({ bucketId: 1, ip: 1 },     { sparse: true });

export default mongoose.model('BucketView', bucketViewSchema);
