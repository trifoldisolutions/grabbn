import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema({
    // Always exactly 2 participants
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],

    lastMessageAt:       { type: Date, default: Date.now },
    lastMessagePreview:  { type: String, default: '' }, // ~60-char snapshot
    lastMessageSenderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Per-participant unread counts
    unreadCounts: {
        type: Map,
        of: Number,
        default: {},
    },

    // Optional: DM-from-comment context (captured at conversation creation, never changes)
    contextCommentId:       { type: mongoose.Schema.Types.ObjectId, ref: 'BucketComment', default: null },
    contextCommentBody:     { type: String, default: null },      // snapshot at creation time
    contextCommentUsername: { type: String, default: null },
    contextCommentBucketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bucket', default: null },
    contextCommentBucketName: { type: String, default: null },

    createdAt: { type: Date, default: Date.now },
});

// Primary query: all conversations for a user sorted by activity
conversationSchema.index({ participants: 1, lastMessageAt: -1 });

export default mongoose.model('Conversation', conversationSchema);
