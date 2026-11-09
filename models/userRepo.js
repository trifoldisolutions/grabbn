import mongoose from 'mongoose';

const userRepoSchema = new mongoose.Schema(
    {
        userId: {
            type:     mongoose.Schema.Types.ObjectId,
            ref:      'User',
            required: true,
            index:    true,
        },
        name: {
            type:      String,
            required:  true,
            maxlength: 80,
            trim:      true,
        },
        description: {
            type:      String,
            default:   '',
            maxlength: 256,
        },
    },
    { timestamps: true }
);

// One user cannot have two repos with the same name
userRepoSchema.index({ userId: 1, name: 1 }, { unique: true });

export default mongoose.model('UserRepo', userRepoSchema);
