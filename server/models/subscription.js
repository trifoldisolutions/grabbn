import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema({
    followerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    followeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

// One subscription per pair — prevents duplicates
subscriptionSchema.index({ followerId: 1, followeeId: 1 }, { unique: true });

// Fast lookup: "who does this user follow?" (used in repo personalization)
subscriptionSchema.index({ followerId: 1 });

// Fast lookup: "how many followers does this curator have?"
subscriptionSchema.index({ followeeId: 1 });

export default mongoose.model('Subscription', subscriptionSchema);
