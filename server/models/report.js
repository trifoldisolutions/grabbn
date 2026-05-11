import mongoose from 'mongoose';

const reportSchema = new mongoose.Schema(
  {
    reporterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    bucketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bucket',
      default: null
    },
    reportedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    reason: {
      type: String,
      enum: ['spam', 'malicious', 'inappropriate', 'copyright', 'harassment', 'other'],
      required: true
    },
    detail: {
      type: String,
      maxlength: 500,
      default: ''
    },
    status: {
      type: String,
      enum: ['pending', 'reviewed', 'dismissed'],
      default: 'pending'
    }
  },
  { timestamps: true }
);

// One report per reporter per target
reportSchema.index({ reporterId: 1, bucketId: 1 }, { unique: true, sparse: true });
reportSchema.index({ reporterId: 1, reportedUserId: 1 }, { unique: true, sparse: true });

export default mongoose.model('Report', reportSchema);
