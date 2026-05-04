import { S3Client, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';

const MIME_TO_EXT = {
    'image/jpeg':   'jpg',
    'image/jpg':    'jpg',
    'image/png':    'png',
    'image/webp':   'webp',
    'image/gif':    'gif',
    'image/avif':   'avif',
    'image/svg+xml':'svg',
};

const ALLOWED_LINK_IMG_MIME = new Set(Object.keys(MIME_TO_EXT));
const MAX_LINK_IMG_BYTES = 800 * 1024;

let _client = null;
function getClient() {
    if (!_client) {
        _client = new S3Client({
            region: 'auto',
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId:     process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
        });
    }
    return _client;
}

export async function uploadImageToR2(buffer, mimeType, folder = 'buckets/links') {
    const ext = MIME_TO_EXT[mimeType] || 'jpg';
    const hash = createHash('sha256').update(buffer).digest('hex');
    const key = `${folder}/${hash}.${ext}`;

    await getClient().send(new PutObjectCommand({
        Bucket:      process.env.R2_BUCKET_NAME,
        Key:         key,
        Body:        buffer,
        ContentType: mimeType,
        CacheControl: 'public, max-age=31536000',
    }));

    return `${process.env.R2_PUBLIC_URL}/${key}`;
}

// Drop-in replacement for fetchImageAsBase64.
// Returns an R2 CDN URL string, or null on failure.
export async function fetchAndStoreImage(url, { referer, minBytes = 0, folder = 'buckets/links' } = {}) {
    if (!url) return null;
    // Already our own R2 URL or a relative path — pass through without re-uploading
    const r2Base = process.env.R2_PUBLIC_URL;
    if (url.startsWith('/') || (r2Base && url.startsWith(r2Base))) return url;
    // Blob URLs are browser-only and can't be fetched server-side
    if (!url.startsWith('data:') && !url.startsWith('http://') && !url.startsWith('https://')) return null;
    // Legacy base64 blob — upload it to R2
    if (url.startsWith('data:')) {
        const match = url.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
        if (!match) return null;
        const [, mimeType, b64] = match;
        if (!ALLOWED_LINK_IMG_MIME.has(mimeType)) return null;
        const buffer = Buffer.from(b64, 'base64');
        try { return await uploadImageToR2(buffer, mimeType, folder); } catch { return null; }
    }
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': referer ? 'cross-site' : 'none',
        };
        if (referer) {
            headers['Referer'] = referer;
            try { headers['Origin'] = new URL(referer).origin; } catch {}
        }
        const upstream = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
        clearTimeout(timer);
        if (!upstream.ok) {
            console.warn('[img] fetch failed', upstream.status, url.slice(0, 120));
            return null;
        }
        const type = (upstream.headers.get('content-type') || '').split(';')[0].trim();
        if (!ALLOWED_LINK_IMG_MIME.has(type)) {
            console.warn('[img] bad content-type', type, url.slice(0, 120));
            return null;
        }
        const buf = await upstream.arrayBuffer();
        if (buf.byteLength > MAX_LINK_IMG_BYTES) {
            console.warn('[img] too large', buf.byteLength, url.slice(0, 120));
            return null;
        }
        if (minBytes > 0 && buf.byteLength < minBytes) {
            console.warn('[img] too small, likely placeholder', buf.byteLength, url.slice(0, 120));
            return null;
        }
        return await uploadImageToR2(Buffer.from(buf), type, folder);
    } catch (e) {
        console.warn('[img] fetch/upload threw', e.message, url.slice(0, 120));
        return null;
    }
}

// Delete one or more R2 objects by their CDN URLs. Silently skips non-R2 URLs.
export async function deleteR2Images(urls) {
    const base = process.env.R2_PUBLIC_URL;
    if (!base) return;

    const keys = urls
        .filter(u => u && u.startsWith(base))
        .map(u => ({ Key: u.slice(base.length).replace(/^\//, '') }));

    if (keys.length === 0) return;

    try {
        await getClient().send(new DeleteObjectsCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Delete: { Objects: keys, Quiet: true },
        }));
    } catch (e) {
        console.warn('[img] R2 delete failed:', e.message);
    }
}
