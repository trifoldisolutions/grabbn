// server/models/bucketAccess.js
import mongoose from 'mongoose';

const bucketAccessSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        bucketId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Bucket',
            required: true
        },
        grantedAt: {
            type: Date,
            default: Date.now
        }
    },
    { timestamps: false }
);

// Compound unique index — one access record per user per bucket
bucketAccessSchema.index({ userId: 1, bucketId: 1 }, { unique: true });

export default mongoose.model('BucketAccess', bucketAccessSchema);
