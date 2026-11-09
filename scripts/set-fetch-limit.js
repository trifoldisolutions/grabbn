// One-time script: set metaFetchLimit for a specific user.
// Usage: node --env-file=.env scripts/set-fetch-limit.js <email> <limit>
import mongoose from 'mongoose';
import User from '../models/user.js';

const [,, email, limitArg] = process.argv;
if (!email || !limitArg) { console.error('Usage: set-fetch-limit.js <email> <limit>'); process.exit(1); }
const limit = parseInt(limitArg, 10);

await mongoose.connect(process.env.MONGODB_URI + process.env.MONGODB_DB);
const user = await User.findOneAndUpdate(
    { email },
    { $set: { metaFetchLimit: limit } },
    { new: true, projection: { email: 1, metaFetchLimit: 1 } }
);
if (!user) { console.error('User not found:', email); process.exit(1); }
console.log(`Set metaFetchLimit=${user.metaFetchLimit} for ${user.email}`);
process.exit(0);
