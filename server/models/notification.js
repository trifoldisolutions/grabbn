import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type:      { type: String, required: true, enum: [
        'new_follower',
        'bucket_grabbed',
        'bucket_unlocked',
        'new_bucket_published',
        'grabbed_bucket_updated',
    ]},
    data:      { type: mongoose.Schema.Types.Mixed, required: true },
    seen:      { type: Boolean, default: false }, // true after first modal open
    read:      { type: Boolean, default: false }, // true after explicit "mark as read"
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 }, // TTL: 90 days
});

// Fast lookup: all notifications for a user, newest first
notificationSchema.index({ userId: 1, createdAt: -1 });

// Unread count badge
notificationSchema.index({ userId: 1, read: 1 });

// Dedup: grabbed_bucket_updated — one per (userId, sourceBucketId) per day
notificationSchema.index({ userId: 1, type: 1, 'data.sourceBucketId': 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);
