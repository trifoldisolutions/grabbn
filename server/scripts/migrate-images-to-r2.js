/**
 * One-time migration: upload all base64 image strings from MongoDB to Cloudflare R2
 * and replace them with CDN URLs.
 *
 * Run with:
 *   node --env-file=.env server/scripts/migrate-images-to-r2.js
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import Bucket from '../models/bucket.js';
import PartnerApplication from '../models/partnerApplication.js';
import { uploadImageToR2 } from '../utils/r2.js';

const BATCH_SIZE = 50;

async function uploadBase64(dataUri, folder) {
    const match = dataUri.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
    if (!match) return null;
    const [, mimeType, b64] = match;
    const buffer = Buffer.from(b64, 'base64');
    return uploadImageToR2(buffer, mimeType, folder);
}

async function migrateBuckets() {
    console.log('--- Migrating Bucket images ---');
    let processed = 0, updated = 0, failed = 0;
    let skip = 0;

    while (true) {
        const buckets = await Bucket.find({
            $or: [
                { thumbnail: /^data:/ },
                { 'links.image': /^data:/ },
            ]
        }).skip(skip).limit(BATCH_SIZE).select('_id thumbnail links');

        if (buckets.length === 0) break;

        for (const bucket of buckets) {
            try {
                const update = {};

                if (bucket.thumbnail?.startsWith('data:')) {
                    const url = await uploadBase64(bucket.thumbnail, 'buckets/thumbnails');
                    if (url) update.thumbnail = url;
                    else failed++;
                }

                const newLinks = await Promise.all(bucket.links.map(async link => {
                    if (!link.image?.startsWith('data:')) return link;
                    const url = await uploadBase64(link.image, 'buckets/links');
                    if (url) { updated++; return { ...link.toObject(), image: url }; }
                    failed++;
                    return link;
                }));

                if (Object.keys(update).length > 0 || newLinks.some((l, i) => l.image !== bucket.links[i]?.image)) {
                    await Bucket.findByIdAndUpdate(bucket._id, {
                        ...update,
                        links: newLinks,
                    }, { timestamps: false });
                    updated++;
                }

                processed++;
            } catch (err) {
                console.error(`Bucket ${bucket._id} failed:`, err.message);
                failed++;
                processed++;
            }
        }

        skip += BATCH_SIZE;
        console.log(`  processed ${processed}, updated ${updated}, failed ${failed}`);
    }

    console.log(`Buckets done — processed: ${processed}, updated: ${updated}, failed: ${failed}`);
}

async function migratePartnerApplications() {
    console.log('--- Migrating PartnerApplication images ---');
    let processed = 0, updated = 0, failed = 0;
    let skip = 0;

    while (true) {
        const apps = await PartnerApplication.find({
            $or: [
                { idFileRef: /^data:/ },
                { selfieFileRef: /^data:/ },
            ]
        }).skip(skip).limit(BATCH_SIZE);

        if (apps.length === 0) break;

        for (const app of apps) {
            try {
                const update = {};

                if (app.idFileRef?.startsWith('data:')) {
                    const url = await uploadBase64(app.idFileRef, 'partners');
                    if (url) update.idFileRef = url;
                    else failed++;
                }
                if (app.selfieFileRef?.startsWith('data:')) {
                    const url = await uploadBase64(app.selfieFileRef, 'partners');
                    if (url) update.selfieFileRef = url;
                    else failed++;
                }

                if (Object.keys(update).length > 0) {
                    await PartnerApplication.findByIdAndUpdate(app._id, update);
                    updated++;
                }

                processed++;
            } catch (err) {
                console.error(`PartnerApplication ${app._id} failed:`, err.message);
                failed++;
                processed++;
            }
        }

        skip += BATCH_SIZE;
        console.log(`  processed ${processed}, updated ${updated}, failed ${failed}`);
    }

    console.log(`PartnerApplications done — processed: ${processed}, updated: ${updated}, failed: ${failed}`);
}

async function main() {
    if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID) {
        console.error('R2 env vars not set. Check R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL in .env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB });
    console.log('Connected to MongoDB');

    await migrateBuckets();
    await migratePartnerApplications();

    await mongoose.disconnect();
    console.log('Migration complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
