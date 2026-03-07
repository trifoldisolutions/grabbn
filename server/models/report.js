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
      required: true
    },
    reason: {
      type: String,
      enum: ['spam', 'malicious', 'inappropriate', 'copyright', 'other'],
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

// One report per user per bucket
reportSchema.index({ reporterId: 1, bucketId: 1 }, { unique: true });

export default mongoose.model('Report', reportSchema);
