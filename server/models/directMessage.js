import mongoose from 'mongoose';

const entitySchema = new mongoose.Schema({
    type:     { type: String, enum: ['mention', 'bucket_ref', 'url'], required: true },
    raw:      { type: String, required: true },
    value:    { type: String, required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const directMessageSchema = new mongoose.Schema({
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body:           { type: String, required: true, maxlength: 350 },
    entities:       { type: [entitySchema], default: [] },
    readAt:         { type: Date, default: null }, // null = unread by recipient
    createdAt:      { type: Date, default: Date.now, expires: 60 * 60 * 24 * 365 }, // TTL: 1 year
});

// Primary query: all messages in a conversation, chronological
directMessageSchema.index({ conversationId: 1, createdAt: 1 });

export default mongoose.model('DirectMessage', directMessageSchema);
