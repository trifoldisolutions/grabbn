import mongoose from 'mongoose';

const adminAuditLogSchema = new mongoose.Schema({
    adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action:      { type: String, required: true, index: true },
    targetType:  { type: String, default: null, index: true },
    targetId:    { type: mongoose.Schema.Types.ObjectId, default: null },
    meta:        { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

export default mongoose.model('AdminAuditLog', adminAuditLogSchema);
