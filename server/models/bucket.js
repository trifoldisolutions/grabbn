// server/models/Bucket.js
import mongoose from 'mongoose';

const linkSchema = new mongoose.Schema({
  href: { type: String, required: true },
  text: { type: String, default: '' },
  duration: { type: String, default: '' },
  isFree: { type: Boolean, default: false },
  image: { type: String, default: null },
  clickCount: { type: Number, default: 0 },
  isPinned: { type: Boolean, default: false },
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
    visibility: {
      type: String,
      enum: ['public', 'unlisted', 'private'],
      default: undefined
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
    shareCount: {
      type: Number,
      default: 0
    },
    grabbedBy: [{
      userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      username: { type: String, default: '' },
      avatar:   { type: String, default: '' }
    }],
    isDraft: {
      type: Boolean,
      default: false
    },
    exploreScore: {
      type: Number,
      default: 0,
      index: true
    },
    exploreScoreUpdatedAt: {
      type: Date,
      default: null
    },
    // Primary domain topic — derived by buildExploreScores from sourceUrl / pinned link /
    // highest-clicked link / first link (in priority order). Used for topic-based recommendations.
    topic: {
      type: String,
      default: null,
      index: true
    }
  },
  { timestamps: true }
);

// Compound index for userId + name to ensure unique bucket names per user
bucketSchema.index({ userId: 1, name: 1 }, { unique: true });

// Compound index for explore feed: public buckets sorted by score
bucketSchema.index({ isPublic: 1, exploreScore: -1 });

// Keep visibility and isPublic in sync on every save
bucketSchema.pre('save', function () {
  if (this.visibility) {
    this.isPublic = this.visibility === 'public';
  } else {
    this.visibility = this.isPublic ? 'public' : 'private';
  }
});

export default mongoose.model('Bucket', bucketSchema);