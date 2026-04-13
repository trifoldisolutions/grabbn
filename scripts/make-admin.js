/**
 * scripts/make-admin.js
 *
 * Promote an existing registered user to admin, or demote them back to user.
 * The target account must already exist (signed up via the normal flow).
 *
 * Usage:
 *   node --env-file=.env scripts/make-admin.js <email> [role]
 *
 * Arguments:
 *   email   – the registered email address of the account to promote/demote
 *   role    – one of: superadmin | moderator | user  (default: superadmin)
 *
 * Examples:
 *   node --env-file=.env scripts/make-admin.js you@example.com
 *   node --env-file=.env scripts/make-admin.js you@example.com moderator
 *   node --env-file=.env scripts/make-admin.js you@example.com user
 */

import mongoose from 'mongoose';

// ── Args ──────────────────────────────────────────────────────────────────────
const [,, email, roleArg = 'superadmin'] = process.argv;

const VALID_ROLES = ['user', 'moderator', 'superadmin'];

if (!email) {
    console.error('\n  ✖  Email is required.\n');
    console.error('  Usage: node --env-file=.env scripts/make-admin.js <email> [role]\n');
    process.exit(1);
}

if (!VALID_ROLES.includes(roleArg)) {
    console.error(`\n  ✖  Invalid role "${roleArg}". Must be one of: ${VALID_ROLES.join(', ')}\n`);
    process.exit(1);
}

// ── DB connection ─────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('\n  ✖  MONGODB_URI is not set in your .env file.\n');
    process.exit(1);
}

const DB_NAME = process.env.MONGODB_DB || 'grabbn';
await mongoose.connect(MONGO_URI, { dbName: DB_NAME });

// ── Minimal User schema (avoid importing the full model tree) ─────────────────
const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
    email:             String,
    username:          String,
    isAnonymous:       Boolean,
    isEmailVerified:   Boolean,
    role:              String,
    accountSuspendedAt: Date,
}, { strict: false }));

// ── Find user ─────────────────────────────────────────────────────────────────
const user = await User.findOne({ email: email.toLowerCase().trim() });

if (!user) {
    console.error(`\n  ✖  No account found with email: ${email}\n`);
    console.error('  Make sure the account is registered via the normal signup flow first.\n');
    await mongoose.disconnect();
    process.exit(1);
}

if (user.isAnonymous) {
    console.error(`\n  ✖  "${email}" is an anonymous account. Register it first.\n`);
    await mongoose.disconnect();
    process.exit(1);
}

// ── Show current state ────────────────────────────────────────────────────────
const prevRole = user.role || 'user';
console.log(`
  Account found
  ─────────────────────────────────────
  Email     : ${user.email}
  Username  : ${user.username || '(none)'}
  Verified  : ${user.isEmailVerified ? 'yes' : 'no'}
  Current role : ${prevRole}
  New role     : ${roleArg}
`);

if (prevRole === roleArg) {
    console.log(`  ✔  Nothing to do — role is already "${roleArg}".\n`);
    await mongoose.disconnect();
    process.exit(0);
}

// ── Apply change ──────────────────────────────────────────────────────────────
user.role = roleArg;
await user.save();

const action = roleArg === 'user'
    ? `demoted to regular user`
    : `promoted to ${roleArg}`;

console.log(`  ✔  ${user.email} has been ${action}.\n`);

if (roleArg !== 'user') {
    console.log(`  → They can now log in at /admin/login\n`);
}

await mongoose.disconnect();
