import mongoose from 'mongoose';

// One report per user per comment — mirrors the existing Report model pattern.
const commentReportSchema = new mongoose.Schema({
    commentId:  { type: mongoose.Schema.Types.ObjectId, ref: 'BucketComment', required: true },
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User',          required: true },
    reason:     { type: String, enum: ['spam', 'harassment', 'inappropriate', 'other'], required: true },
    status:     { type: String, enum: ['pending', 'reviewed', 'dismissed'], default: 'pending' },
}, { timestamps: true });

// One report per user per comment
commentReportSchema.index({ commentId: 1, reporterId: 1 }, { unique: true });

export default mongoose.model('CommentReport', commentReportSchema);
