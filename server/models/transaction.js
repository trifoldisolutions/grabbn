// server/models/transaction.js
import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },
        type: {
            type: String,
            enum: ['topup', 'unlock', 'earn', 'platform_fee', 'cashout'],
            required: true
        },
        amount: {
            type: Number,
            required: true
        },
        relatedBucketId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Bucket',
            default: null
        },
        stripePaymentIntentId: {
            type: String,
            default: ''
        }
    },
    { timestamps: true }
);

export default mongoose.model('Transaction', transactionSchema);
