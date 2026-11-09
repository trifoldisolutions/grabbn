import mongoose from 'mongoose';
const { Schema } = mongoose;

const registeredLinkSchema = new Schema({
    url:                 { type: String, required: true, unique: true },
    registeredBy:        { type: Schema.Types.ObjectId, ref: 'User', required: true },
    registrantUsername:  { type: String, required: true },
    status:              { type: String, enum: ['active', 'disputed'], default: 'active' },
    disputedAt:          { type: Date, default: null }
}, { timestamps: true });

export default mongoose.model('RegisteredLink', registeredLinkSchema);
