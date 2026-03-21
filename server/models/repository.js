import mongoose from 'mongoose';

// Each top link stored inside a repository
const topLinkSchema = new mongoose.Schema({
    href:         { type: String, required: true },
    text:         { type: String, default: '' },
    image:        { type: String, default: '' },
    totalClicks:  { type: Number, default: 0 },
    bucketSpread: { type: Number, default: 1 }, // how many distinct buckets contain this link
    score:        { type: Number, default: 0 },
    curatorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null } // owner of the first bucket that contributed this link
}, { _id: false });

// One document per domain — rebuilt periodically by the aggregation job
const repositorySchema = new mongoose.Schema({
    domain:      { type: String, required: true, unique: true },
    topLinks:    [topLinkSchema],
    totalClicks: { type: Number, default: 0 },
    bucketCount: { type: Number, default: 0 },
    rebuiltAt:   { type: Date, default: Date.now }
});

// Sort repos by popularity on the showroom sidebar
repositorySchema.index({ totalClicks: -1 });

export default mongoose.model('Repository', repositorySchema);
