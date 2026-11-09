import mongoose from 'mongoose';

// Embedded entity sub-doc — represents a parsed @mention, b: bucket reference, or raw URL
const entitySchema = new mongoose.Schema({
    type:     { type: String, enum: ['mention', 'bucket_ref', 'url'], required: true },
    raw:      { type: String, required: true },  // original text as typed (e.g. "@john", "b:frontend-tips", "https://...")
    value:    { type: String, required: true },  // resolved value: username, bucketId, or URL
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null }, // { name, ratingAvg, grabCount } for bucket_ref only
}, { _id: false });

const bucketCommentSchema = new mongoose.Schema({
    bucketId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Bucket',        required: true },
    userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User',          required: true },
    username:        { type: String, default: '' },
    avatar:          { type: String, default: '' },
    body:            { type: String, required: true, maxlength: 250 },
    parentCommentId: { type: mongoose.Schema.Types.ObjectId, ref: 'BucketComment', default: null },
    isPinned:        { type: Boolean, default: false },
    agreementCount:  { type: Number,  default: 0 },
    isEdited:        { type: Boolean, default: false },
    editedAt:        { type: Date,    default: null },
    editLockedAt:    { type: Date,    default: null }, // set to createdAt + 48h on first save
    entities:        { type: [entitySchema], default: [] },
    deletedAt:       { type: Date,    default: null }, // soft delete
}, { timestamps: true });

// Primary query index: non-deleted comments for a bucket, sorted pinned → most agreed → newest
bucketCommentSchema.index({ bucketId: 1, deletedAt: 1, isPinned: -1, agreementCount: -1, createdAt: -1 });

// For delete-own lookups
bucketCommentSchema.index({ userId: 1 });

export default mongoose.model('BucketComment', bucketCommentSchema);
