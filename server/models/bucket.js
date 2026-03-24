// server/models/Bucket.js
import mongoose from 'mongoose';

const linkSchema = new mongoose.Schema({
  href: { type: String, required: true },
  text: { type: String, default: '' },
  duration: { type: String, default: '' },
  isFree: { type: Boolean, default: false },
  image: { type: String, default: null },
  addedAt: { type: Date, default: Date.now }
}, { _id: false });

const bucketSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true
    },
    links: {
      type: [linkSchema],
      default: []
    },
    description: {
      type: String,
      default: '',
      maxlength: 256
    },
    hashtags: {
      type: [String],
      default: []
    },
    mature: {
      type: Boolean,
      default: false
    },
    sourceUrl: {
      type: String,
      default: ''
    },
    thumbnail: {
      type: String,  // base64 or URL
      default: ''
    },
    order: {
      type: Number,
      default: 0
    },
    sourceBucketId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    originalCuratorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    originalCuratorName: {
      type: String,
      default: ''
    },
    originalBucketId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    isPublic: {
      type: Boolean,
      default: false
    },
    isPaywalled: {
      type: Boolean,
      default: false
    },
    price: {
      type: Number,
      default: 0
    },
    viewCount: {
      type: Number,
      default: 0
    },
    viewedBy: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      lastViewedVersion: { type: Date }
    }],
    shareCount: {
      type: Number,
      default: 0
    },
    sharedBy: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      lastSharedVersion: { type: Date }
    }],
    grabbedBy: [{
      userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      username: { type: String, default: '' },
      avatar:   { type: String, default: '' }
    }]
  },
  { timestamps: true }
);

// Compound index for userId + name to ensure unique bucket names per user
bucketSchema.index({ userId: 1, name: 1 }, { unique: true });

export default mongoose.model('Bucket', bucketSchema);