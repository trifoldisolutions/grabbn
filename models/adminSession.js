import mongoose from 'mongoose';

// One signed-in admin panel session. The raw token lives only in the _gadmin
// cookie; storing its hash means a database read can't be replayed as a login.
const adminSessionSchema = new mongoose.Schema({
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } } // MongoDB removes it once expired
}, { timestamps: true });

export default mongoose.model('AdminSession', adminSessionSchema);
