import mongoose from 'mongoose';

// One agreement (like) per user per comment — mirrors the BucketRating pattern.
const commentAgreementSchema = new mongoose.Schema({
    commentId: { type: mongoose.Schema.Types.ObjectId, ref: 'BucketComment', required: true },
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',          required: true },
}, { timestamps: true });

// Enforce one agreement per user per comment
commentAgreementSchema.index({ commentId: 1, userId: 1 }, { unique: true });

// Fast per-comment agreement count
commentAgreementSchema.index({ commentId: 1 });

export default mongoose.model('CommentAgreement', commentAgreementSchema);
