/**
 * scripts/reset-repositories.js
 *
 * Drops all documents from the Repository collection so the new
 * (domain, tag) compound index can be applied cleanly on next rebuild.
 * Run this once after deploying the repo model change.
 *
 * Usage:
 *   node --env-file=.env scripts/reset-repositories.js
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('\n  ✖  MONGODB_URI is not set in your .env file.\n');
    process.exit(1);
}

const DB_NAME = process.env.MONGODB_DB || 'grabbn';
await mongoose.connect(MONGO_URI, { dbName: DB_NAME });

const col = mongoose.connection.collection('repositories');
await col.drop().catch(err => {
    // If collection doesn't exist yet, that's fine
    if (err.codeName !== 'NamespaceNotFound') throw err;
});
console.log('\n  ✔  Dropped repositories collection (documents + indexes).\n');
console.log('  Mongoose will recreate the correct indexes on next server start.\n');

await mongoose.disconnect();
