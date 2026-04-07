// server/utils/entityParser.js
// Shared entity parsing for comments and direct messages.
// Resolves u:username, b:bucket, and raw URL references from a text body.

import mongoose from 'mongoose';
import Bucket from '../models/bucket.js';
import User from '../models/user.js';

export function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BUCKET_FIELDS = 'name ratingSum ratingCount grabbedBy thumbnail links isPaywalled price viewCount createdAt updatedAt userId';

export async function fetchBucketSnapshot(bucketId) {
    try {
        const bucket = await Bucket.findById(bucketId)
            .select(BUCKET_FIELDS)
            .populate('userId', 'username avatar')
            .lean();
        if (!bucket) return null;
        return buildSnapshot(bucket);
    } catch {
        return null;
    }
}

export function buildSnapshot(bucket) {
    const ratingAvg = bucket.ratingCount > 0
        ? Math.round((bucket.ratingSum / bucket.ratingCount) * 10) / 10
        : null;
    const curator = (bucket.userId && typeof bucket.userId === 'object' && bucket.userId.username)
        ? { username: bucket.userId.username, avatar: bucket.userId.avatar || null }
        : null;
    return {
        name:        bucket.name,
        ratingAvg,
        grabCount:   bucket.grabbedBy?.length ?? 0,
        thumbnail:   bucket.thumbnail  || null,
        linkCount:   bucket.links?.length ?? 0,
        isPaywalled: !!bucket.isPaywalled,
        price:       bucket.price      || 0,
        viewCount:   bucket.viewCount  || 0,
        curator,
        publishedAt: bucket.createdAt  || null,
        updatedAt:   bucket.updatedAt  || null,
    };
}

export async function resolveBucketRef(ref) {
    try {
        let bucket = null;
        const urlMatch = ref.match(/\/v2\/bucket\/([a-fA-F0-9]{24})/);
        if (urlMatch) {
            bucket = await Bucket.findById(urlMatch[1])
                .select(BUCKET_FIELDS)
                .populate('userId', 'username avatar')
                .lean();
        } else if (mongoose.Types.ObjectId.isValid(ref)) {
            bucket = await Bucket.findById(ref)
                .select(BUCKET_FIELDS)
                .populate('userId', 'username avatar')
                .lean();
        }
        if (!bucket) {
            bucket = await Bucket.findOne({ name: new RegExp('^' + escapeRegex(ref) + '$', 'i') })
                .select(BUCKET_FIELDS)
                .populate('userId', 'username avatar')
                .lean();
        }
        if (!bucket) return { bucketId: null, snapshot: null };
        return { bucketId: String(bucket._id), snapshot: buildSnapshot(bucket) };
    } catch {
        return { bucketId: null, snapshot: null };
    }
}

// Parse a body string and resolve all entity references.
export async function parseAndResolveEntities(body, userId) {
    const entities = [];
    const seen = new Set();

    // ── 1. u:username mentions ───────────────────────────────────────────────
    const mentionRe = /\bu:([a-zA-Z0-9_]{1,30})/g;
    let m;
    while ((m = mentionRe.exec(body)) !== null) {
        const raw      = m[0];
        const username = m[1];
        const key      = `mention:${username.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const user = await User.findOne({ username }).select('_id avatar').lean();
        if (user) {
            entities.push({ type: 'mention', raw, value: username, snapshot: { avatar: user.avatar || null } });
        }
    }

    // ── 2. Bucket page URLs ──────────────────────────────────────────────────
    const bucketUrlRe = /https?:\/\/\S+\/v2\/bucket\/([a-fA-F0-9]{24})(?:[?#]\S*)?/g;
    while ((m = bucketUrlRe.exec(body)) !== null) {
        const raw      = m[0];
        const bucketId = m[1];
        const key      = `bucket_ref:${bucketId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const snapshot = await fetchBucketSnapshot(bucketId);
        if (!snapshot) continue;
        entities.push({ type: 'bucket_ref', raw, value: bucketId, snapshot });
    }

    // ── 3. b:name or b:"name with spaces" shorthand ──────────────────────────
    const bucketRefRe = /\bb:(?:"([^"]{1,500})"|([a-zA-Z0-9_\-]{1,100}))/g;
    while ((m = bucketRefRe.exec(body)) !== null) {
        const raw = m[0];
        const ref = (m[1] || m[2]).trim();
        const key = `bucket_ref_text:${ref.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { bucketId, snapshot } = await resolveBucketRef(ref);
        if (!bucketId) continue;
        entities.push({ type: 'bucket_ref', raw, value: bucketId, snapshot });
    }

    // ── 4. Raw URLs ──────────────────────────────────────────────────────────
    const urlRe = /https?:\/\/\S+/g;
    while ((m = urlRe.exec(body)) !== null) {
        const raw = m[0];
        if (/\/v2\/bucket\/[a-fA-F0-9]{24}/.test(raw)) continue;
        const key = `url:${raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entities.push({ type: 'url', raw, value: raw, snapshot: null });
    }

    return entities;
}
