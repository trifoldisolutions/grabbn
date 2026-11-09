// models/link.js
import mongoose from 'mongoose';

const linkSchema = new mongoose.Schema(
  {
    userId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User', 
      required: true,
      index: true 
    },
    href: { 
      type: String, 
      required: true, 
      index: true 
    },
    text: { 
      type: String, 
      default: '' 
    },
    duration: { 
      type: String, 
      default: '' 
    },
    buckets: { 
      type: [String], 
      default: []  // Empty array = Singleton link (not in any bucket)
    },
    sourceUrl: { type: String, default: '' }
  },
  { timestamps: true }
);

// Compound index for userId + href to ensure unique links per user
linkSchema.index({ userId: 1, href: 1 }, { unique: true });

// Index for bucket filtering
linkSchema.index({ userId: 1, buckets: 1 });

export default mongoose.model('Link', linkSchema);