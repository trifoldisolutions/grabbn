import mongoose from 'mongoose';

// One document per domain — upserted by buildExploreScores every 2h.
// Represents the aggregated engagement weight of all public buckets whose
// primary topic resolves to that domain.
const topicScoreSchema = new mongoose.Schema({
    domain:      { type: String, required: true, unique: true, index: true },
    score:       { type: Number, default: 0 },   // Σ exploreScore of all buckets in this topic
    bucketCount: { type: Number, default: 0 },   // number of contributing public buckets
    updatedAt:   { type: Date,   default: null }
}, { timestamps: false });

export default mongoose.model('TopicScore', topicScoreSchema);
