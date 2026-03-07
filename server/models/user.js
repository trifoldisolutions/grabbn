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
      unique: true,
      lowercase: true,
      trim: true
    },
    password: {
      type: String,
      select: false // Don't include password in queries by default
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
    // Scraping limits tracking
    dailyScrapingCount: {
      type: Number,
      default: 0
    },
    lastScrapingResetDate: {
      type: Date,
      default: Date.now
    },
    scrapingLimit: {
      type: Number,
      default: function() {
        // Anonymous users: 2 scrapes per day
        // Registered users: 12 scrapes per day
        return this.isAnonymous ? 2 : 12;
      }
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
    newsletterSubscribed: { type: Boolean, default: false }
  },
  { timestamps: true }
);

// Hash password before saving - FIXED VERSION WITHOUT next()
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
  this.scrapingLimit = 12;
  return this.save();
};

// Update lastActive on every interaction
userSchema.methods.touch = function() {
  this.lastActive = new Date();
  return this.save();
};

// Check if user needs daily reset
userSchema.methods.checkAndResetDailyLimit = function() {
  const now = new Date();
  const lastReset = new Date(this.lastScrapingResetDate);
  
  // Check if it's a new day (UTC)
  const isNewDay = now.toDateString() !== lastReset.toDateString();
  
  if (isNewDay) {
    this.dailyScrapingCount = 0;
    this.lastScrapingResetDate = now;
  }
  
  return isNewDay;
};

// Check if user can scrape (has not exceeded limit)
userSchema.methods.canScrape = function() {
  this.checkAndResetDailyLimit();
  return this.dailyScrapingCount < this.scrapingLimit;
};

// Get remaining scrapes for today
userSchema.methods.getRemainingScrapers = function() {
  this.checkAndResetDailyLimit();
  return Math.max(0, this.scrapingLimit - this.dailyScrapingCount);
};

// Increment scraping count
userSchema.methods.incrementScrapingCount = async function() {
  this.checkAndResetDailyLimit();
  this.dailyScrapingCount += 1;
  this.lastActive = new Date();
  return this.save();
};

export default mongoose.model('User', userSchema);