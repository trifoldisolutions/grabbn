import mongoose from 'mongoose';

const blockSchema = new mongoose.Schema({
    blockerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    blockedId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt:  { type: Date, default: Date.now },
});

// Prevent duplicate blocks
blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

// Fast "has this userId been blocked by anyone?" lookup
blockSchema.index({ blockedId: 1 });

export default mongoose.model('Block', blockSchema);
