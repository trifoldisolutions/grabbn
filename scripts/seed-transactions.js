/**
 * scripts/seed-transactions.js
 *
 * Seeds fake transaction history for a user to preview the transactions page.
 * Safe to run multiple times — clears previous seed data first.
 *
 * Usage:
 *   node --env-file=.env scripts/seed-transactions.js <username>
 *
 * Example:
 *   node --env-file=.env scripts/seed-transactions.js fatshew
 */

import mongoose from 'mongoose';

const [,, username] = process.argv;

if (!username) {
    console.error('\n  ✖  Username is required.\n');
    console.error('  Usage: node --env-file=.env scripts/seed-transactions.js <username>\n');
    process.exit(1);
}

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error('\n  ✖  MONGODB_URI is not set.\n');
    process.exit(1);
}

const DB_NAME = process.env.MONGODB_DB || 'grabbn';
await mongoose.connect(MONGO_URI, { dbName: DB_NAME });

const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
    username: String,
    credits:  Number,
}, { strict: false }));

const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', new mongoose.Schema({
    userId:               { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type:                 String,
    amount:               Number,
    relatedBucketId:      { type: mongoose.Schema.Types.ObjectId, default: null },
    stripePaymentIntentId: { type: String, default: '' },
    createdAt:            Date,
    updatedAt:            Date,
    __seed:               Boolean,
}, { strict: false }));

const user = await User.findOne({ username: username.trim() });
if (!user) {
    console.error(`\n  ✖  No user found with username: ${username}\n`);
    await mongoose.disconnect();
    process.exit(1);
}

console.log(`\n  Found user: @${user.username} (${user._id})`);

// Clear previous seed data for this user
const deleted = await Transaction.deleteMany({ userId: user._id, __seed: true });
if (deleted.deletedCount > 0) {
    console.log(`  Cleared ${deleted.deletedCount} previous seed transaction(s).`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysAgo(n, hourOffset = 0) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(d.getHours() - hourOffset);
    return d;
}

function tx(type, amount, daysBack, hourOffset = 0) {
    return {
        userId:   user._id,
        type,
        amount,
        relatedBucketId:       null,
        stripePaymentIntentId: '',
        createdAt: daysAgo(daysBack, hourOffset),
        updatedAt: daysAgo(daysBack, hourOffset),
        __seed:    true,
    };
}

// ── Seed data — 90 days of realistic activity ─────────────────────────────────

const transactions = [
    // ~3 months ago — first top-up
    tx('topup',  500,  88),
    tx('unlock', -200, 87, 2),
    tx('earn',    80,  85),
    tx('earn',    80,  85, 4),

    // ~2 months ago — more activity
    tx('topup',  1000, 62),
    tx('earn',    160, 60),
    tx('earn',    160, 59),
    tx('unlock', -200, 58),
    tx('earn',    80,  55),
    tx('earn',    80,  54),
    tx('earn',    160, 53),
    tx('unlock', -200, 52),

    // ~6 weeks ago — cashout
    tx('earn',    160, 48),
    tx('earn',    80,  47),
    tx('earn',    320, 45),
    tx('cashout', -1200, 43),

    // ~1 month ago
    tx('topup',  500,  30),
    tx('earn',    80,  28),
    tx('earn',    160, 27),
    tx('earn',    80,  26),
    tx('unlock', -200, 25),

    // ~2 weeks ago
    tx('topup',  1000, 14),
    tx('earn',    160, 13),
    tx('earn',    320, 12),
    tx('earn',    160, 11),
    tx('earn',    80,  10),
    tx('unlock', -200, 9),
    tx('earn',    160, 8),

    // Last week — busier
    tx('earn',    320, 6),
    tx('earn',    160, 6, 3),
    tx('earn',    80,  5),
    tx('unlock', -200, 5, 2),
    tx('earn',    320, 4),
    tx('earn',    160, 3),
    tx('earn',    80,  3, 5),
    tx('earn',    160, 2),
    tx('earn',    320, 1),
    tx('earn',    80,  0, 3),
];

await Transaction.insertMany(transactions);

// Set credit balance to match the net of all seed transactions
const net = transactions.reduce((sum, t) => sum + t.amount, 0);
await User.updateOne({ _id: user._id }, { $set: { credits: Math.max(net, 0) } });

console.log(`  Inserted ${transactions.length} seed transactions.`);
console.log(`  Set @${user.username} credit balance to ${Math.max(net, 0)} cr.`);
console.log(`\n  ✔  Done. Visit /transactions to preview.\n`);

await mongoose.disconnect();
