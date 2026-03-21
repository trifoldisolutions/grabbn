import mongoose from 'mongoose';

const linkClickSchema = new mongoose.Schema({
    href:     { type: String, required: true },
    domain:   { type: String, required: true },
    bucketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bucket', required: true },
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// Domain aggregation with recency filtering
linkClickSchema.index({ domain: 1, createdAt: -1 });

// Per-link click totals
linkClickSchema.index({ href: 1, createdAt: -1 });

// User affinity queries
linkClickSchema.index({ userId: 1, createdAt: -1 });

// Auto-expire events older than 6 months
linkClickSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export default mongoose.model('LinkClick', linkClickSchema);
