// server/models/partnerApplication.js
import mongoose from 'mongoose';

const claimedAccountSchema = new mongoose.Schema({
    email:          { type: String, default: '' },
    phone:          { type: String, default: '' },
    bucketOwnerIds: { type: [String], default: [] }
}, { _id: false });

const partnerApplicationSchema = new mongoose.Schema({
    userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status:          { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    pitch:           { type: String, default: '' },
    idFileRef:       { type: String, default: '' },  // base64 data URL
    selfieFileRef:   { type: String, default: '' },  // base64 data URL
    claimedAccounts: { type: [claimedAccountSchema], default: [] },
    submittedAt:     { type: Date, default: Date.now },
    reviewedAt:      { type: Date, default: null },
    reviewedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason:     { type: String, default: '' },
    tier:                { type: String, enum: ['junior', 'pro'], default: null },
    usResidentConfirmed: { type: Boolean, default: false },
    ageConfirmed:        { type: Boolean, default: false },
}, { timestamps: false });

export default mongoose.model('PartnerApplication', partnerApplicationSchema);
