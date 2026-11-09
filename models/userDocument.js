import mongoose from 'mongoose';

const userDocumentSchema = new mongoose.Schema({
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type:       { type: String, enum: ['gov-id', 'selfie'], required: true },
    fileRef:    { type: String, required: true }, // R2 CDN URL
    uploadedAt: { type: Date, default: Date.now },
}, { timestamps: false });

userDocumentSchema.index({ userId: 1, type: 1 }, { unique: true });

export default mongoose.model('UserDocument', userDocumentSchema);
