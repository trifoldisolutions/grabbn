// server/models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const userSchema = new mongoose.Schema(
  {
    anonymousId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    isAnonymous: { 
      type: Boolean, 
      default: true 
    },
    // For registered users
    email: {
      type: String,
      sparse: true,
      lowercase: true,
      trim: true
    },
    password: {
      type: String,
      select: false // Don't include password in queries by default
    },
    googleId: {
      type: String,
      sparse: true,
      unique: true
    },
    username: {
      type: String,
      sparse: true,
      trim: true
    },
    // Track when this user was created
    createdAt: { 
      type: Date, 
      default: Date.now 
    },
    lastActive: { 
      type: Date, 
      default: Date.now 
    },
    // Store user preferences
    preferences: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {}
    },
    resetPasswordToken: {
      type: String,
      select: false
    },
    resetPasswordExpires: {
      type: Date,
      select: false
    },
    otpCode: {
      type: String,
      select: false
    },
    otpExpires: {
      type: Date,
      select: false
    },
    otpSentAt: {
      type: Date,
      select: false
    },
    isEmailVerified: {
      type: Boolean,
      default: false
    },
    pendingEmail:           { type: String, default: null },
    pendingEmailOtp:        { type: String, select: false, default: null },
    pendingEmailOtpExpires: { type: Date,   select: false, default: null },
    pendingEmailOtpSentAt:  { type: Date,   select: false, default: null },
    emailChangeLog: { type: [Date], default: [] },
    emailHistory:   { type: [{ hash: String, changedAt: Date, _id: false }], default: [] },
    accountSuspendedAt: {
      type: Date,
      default: null
    },
    credits: {
      type: Number,
      default: 0,
      min: 0
    },
    // Fraud prevention fields (H1 + H3)
    firstPurchaseAt:        { type: Date,    default: null  },
    dailyPurchaseCount:     { type: Number,  default: 0     },
    dailyPurchaseResetDate: { type: Date,    default: null  },
    dailyUnlockSpend:       { type: Number,  default: 0     },
    dailyUnlockResetDate:   { type: Date,    default: null  },
    pendingCredits:         { type: Number,  default: 0     },
    pendingCreditsUntil:    { type: Date,    default: null  },
    flagged:                { type: Boolean, default: false },
    stripeAccountId: { type: String, default: '' },
    stripeAccountStatus: {
      type: String,
      enum: ['none', 'pending', 'active'],
      default: 'none'
    },
    currency:     { type: String, default: 'USD' },
    avatar:       { type: String, default: '' },
    displayName:  { type: String, default: '', maxlength: 30 },
    bio:          { type: String, default: '', maxlength: 128 },
    website:     { type: String, default: '' },
    socialLinks: { type: [{ platform: String, url: String }], default: [] },
    notificationsClearedAt: { type: Date, default: null },
    newsletterSubscribed: { type: Boolean, default: false },
    isMatureGated:        { type: Boolean, default: true  },
    category:  { type: String, default: '' },
    language:  { type: String, default: 'en' },
    privacy: {
      showActivityStatus:  { type: Boolean, default: true },
      showGrabbedBuckets:  { type: Boolean, default: true },
      accountVisibility:  { type: String, enum: ['public', 'unlisted', 'private'], default: 'public' },
      whoCanMessage:      { type: [String], default: ['everyone'] },
    },
    // Tags (without #) the user wants hidden from their feed and search
    mutedTags:   { type: [String], default: [] },
    // Topic/category values the user wants hidden from their feed
    mutedTopics: { type: [String], default: [] },
    // Default interaction settings applied to newly created buckets
    commentDefaults: {
      allowComments: { type: String, enum: ['everyone', 'followers', 'followees', 'no_one'], default: 'everyone' },
      allowGrabs:    { type: String, enum: ['everyone', 'followers', 'followees', 'no_one'], default: 'everyone' },
    },
    isPartner: { type: Boolean, default: false },
    // Admin access tier — set manually in the database for the first superadmin.
    // 'user' is the default for all regular accounts.
    role: {
      type: String,
      enum: ['user', 'moderator', 'superadmin'],
      default: 'user'
    },
    // Daily meta-fetch quota (persisted so server restarts don't reset counts)
    metaFetchDate:  { type: String, default: null },  // YYYY-MM-DD UTC
    metaFetchCount: { type: Number, default: 0 },
    metaFetchBonus: { type: Number, default: 0 },
    metaFetchLimit: { type: Number, default: null },  // per-user override; null = use META_DAILY_LIMIT
    notificationPrefs: {
      new_follower:           { type: Boolean, default: true },
      bucket_grabbed:         { type: Boolean, default: true },
      bucket_unlocked:        { type: Boolean, default: true },
      new_bucket_published:   { type: Boolean, default: true },
      grabbed_bucket_updated: { type: Boolean, default: true },
      comment_mention:        { type: Boolean, default: true },
      bucket_tagged:          { type: Boolean, default: true },
      comment_reply:          { type: Boolean, default: true },
      comment_agreed:         { type: Boolean, default: true },
      new_dm:                 { type: Boolean, default: true },
    },
    emailNotificationPrefs: {
      new_follower:           { type: Boolean, default: false },
      bucket_grabbed:         { type: Boolean, default: false },
      bucket_unlocked:        { type: Boolean, default: false },
      new_bucket_published:   { type: Boolean, default: false },
      grabbed_bucket_updated: { type: Boolean, default: false },
      comment_mention:        { type: Boolean, default: false },
      comment_reply:          { type: Boolean, default: false },
      comment_agreed:         { type: Boolean, default: false },
      bucket_tagged:          { type: Boolean, default: false },
      new_dm:                 { type: Boolean, default: false },
    },
    // Account deletion grace period — set on voluntary deletion, cleared on reactivation
    deletedAt: { type: Date, default: null },
    // Rate-limiting for comment posts (1 comment per minute per user)
    lastCommentAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    // Rate-limiting for username changes (2/day, 3/week, 4/month)
    usernameChangeLog: { type: [Date], default: [] },
    // Region inferred from IP on first visit (ISO 3166-1 alpha-2 country + subdivision code)
    country: { type: String, default: null },
    region:  { type: String, default: null },
    city:    { type: String, default: null },
    // Guest/anon recommendation session state.
    // Carried over intact when an anonymous user converts to a registered account.
    guestSession: {
        // Domain of the topic they engage with most (argmax of topicEngagements)
        inferredTopic:    { type: String,  default: null },
        // Accumulated weighted engagement points (grab×4, share×5, pageVisit×1, linkClick×0.5)
        points:           { type: Number,  default: 0 },
        // Per-domain engagement breakdown — stored as an array to avoid dot-in-key issues
        // with MongoDB paths (domain names contain dots).
        // [ { domain: "github.com", pts: 7.5 }, … ]
        topicEngagements: { type: [{ domain: String, pts: Number, _id: false }], default: [] },
        // Combined active browsing time in minutes (idle gaps > 30 min are excluded)
        activeMinutes:    { type: Number,  default: 0 },
        // Timestamp of the last engagement event — used to compute active-time deltas
        lastActiveAt:     { type: Date,    default: null },
        // True once the user crosses the warm-start threshold (≥ 10 pts within 6h active time)
        warmStart:        { type: Boolean, default: false }
    }
  },
  { timestamps: true }
);

// Hash password before saving - FIXED VERSION WITHOUT next()
// Normalize legacy boolean commentDefaults fields to the string enum
userSchema.pre('validate', function () {
  const PERMS = ['everyone', 'followers', 'followees', 'no_one'];
  if (!this.commentDefaults) return;
  for (const field of ['allowComments', 'allowGrabs']) {
    const v = this.commentDefaults[field];
    if (v === true || v === 'true') this.commentDefaults[field] = 'everyone';
    else if (v === false || v === 'false') this.commentDefaults[field] = 'no_one';
    else if (v !== undefined && v !== null && !PERMS.includes(v)) this.commentDefaults[field] = 'everyone';
  }
});

userSchema.pre('save', async function() {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) return;
  
  // Hash the password
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to compare password for login
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Convert anonymous user to registered user
userSchema.methods.convertToRegistered = async function(email, password, username) {
  this.email = email;
  this.password = password; // Will be hashed by pre-save hook
  this.username = username;
  this.isAnonymous = false;
  return this.save();
};

// Update lastActive on every interaction
userSchema.methods.touch = function() {
  this.lastActive = new Date();
  return this.save();
};

export default mongoose.model('User', userSchema);