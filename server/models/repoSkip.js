import mongoose from 'mongoose';

// Tracks per-user "not interested" skips on (domain, tag) repo pairs.
// Used to filter skipped repos from the user's personalised repo list.
const repoSkipSchema = new mongoose.Schema({
    domain: { type: String, required: true },
    tag:    { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ip:     { type: String, default: null }, // anon fallback
}, { timestamps: true });

// Prevent duplicate skips
repoSkipSchema.index({ domain: 1, tag: 1, userId: 1 }, { sparse: true });
repoSkipSchema.index({ domain: 1, tag: 1, ip: 1 },     { sparse: true });

// Feed filtering: fetch all (domain, tag) pairs skipped by a given user
repoSkipSchema.index({ userId: 1 });

export default mongoose.model('RepoSkip', repoSkipSchema);
