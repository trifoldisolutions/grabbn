// Finds a page's title and image for /api/meta: page fetching (ScraperAPI, Zyte), per-site adapters and HTML parsing.
import * as cheerio from 'cheerio';
import https from 'https';
import { fetchAndStoreImage } from './r2.js';

// ====================
// HELPERS
// ====================

/**
 * Downloads an external image URL server-side and returns a base64 data URL.
 *   - Already-base64 (data:) or relative (/) strings pass through unchanged.
 *   - Returns null if the fetch fails, the MIME type isn't an image,
 *     or the file is larger than MAX_LINK_IMG_BYTES (avoids bloating Mongo docs).
 */
const MAX_LINK_IMG_BYTES = 800 * 1024; // 800 KB raw → ~1.1 MB as base64
export const ALLOWED_LINK_IMG_MIME = new Set(['image/jpeg','image/jpg','image/png','image/webp','image/gif','image/avif','image/svg+xml']);

async function fetchImageAsBase64(url, { referer, minBytes = 0 } = {}) {
    if (!url) return null;
    if (url.startsWith('data:') || url.startsWith('/')) return url;
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
        const upstream = await fetch(url, {
            signal: controller.signal,
            headers,
            redirect: 'follow',
        });
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
        return `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
    } catch (e) {
        console.warn('[img] fetch threw', e.message, url.slice(0, 120));
        return null;
    }
}

// Domains whose product metadata requires JS rendering to retrieve correctly.
const JS_RENDER_DOMAINS = new Set([
    'amazon.com', 'www.amazon.com', 'a.co',
    'shein.com', 'www.shein.com', 'us.shein.com',
    'temu.com', 'www.temu.com', 'share.temu.com',
    'aliexpress.com', 'www.aliexpress.com',
    'ebay.com', 'www.ebay.com',
    'etsy.com', 'www.etsy.com',
]);

export function needsRender(rawUrl) {
    try { return JS_RENDER_DOMAINS.has(new URL(rawUrl).hostname); } catch { return false; }
}

// Some sites redirect unauthenticated HEAD requests to a login/interstitial page.
// For those domains we keep the original product URL and let the renderer handle it.
// a.co short links are also preserved — ScraperAPI follows the redirect itself and
// renders the final Amazon page, avoiding HEAD-based resolution which can land on a
// non-product page (search, home) that lacks #productTitle.
const PRESERVE_ORIGINAL_RENDER_URL_DOMAINS = new Set([
    'a.co',
    'temu.com', 'www.temu.com',
    'shein.com', 'www.shein.com', 'us.shein.com',
]);

function shouldPreserveOriginalRenderUrl(rawUrl) {
    try {
        return PRESERVE_ORIGINAL_RENDER_URL_DOMAINS.has(new URL(rawUrl).hostname);
    } catch {
        return false;
    }
}

// Follow redirects to get the final URL (resolves short URLs like a.co before scraping).
export async function resolveUrl(url) {
    if (shouldPreserveOriginalRenderUrl(url)) return url;
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: ctrl.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
        });
        return res.url || url;
    } catch {
        return url;
    }
}

export function normalizeMetaUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const hostname = url.hostname.toLowerCase();

        if (domainMatches(hostname, ['amazon.com', 'a.co'])) {
            // Normalize to canonical product URL — strips tracking/search-result params
            // that cause ScraperAPI to return inconsistent images.
            const m = url.pathname.match(/\/dp\/([A-Z0-9]{10})/i)
                   || url.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/i);
            if (m) return `https://www.amazon.com/dp/${m[1]}`;
            return new URL('https://www.amazon.com' + url.pathname).toString();
        }

        if (hostname === 'temu.com' || hostname === 'www.temu.com') {
            const clean = new URL(url.origin + url.pathname);
            ['spec_id', 'spec_ids', 'spec_gallery_id'].forEach(function (key) {
                const value = url.searchParams.get(key);
                if (value) clean.searchParams.set(key, value);
            });
            return clean.toString();
        }

        return url.toString();
    } catch {
        return rawUrl;
    }
}

// Returns true if the HTML is a Cloudflare bot-challenge page rather than the real site.
export function isCloudflareChallengeHtml(html) {
    if (!html) return false;
    return html.includes('risk-id=') || html.includes('challenges.cloudflare.com') || html.includes('Just a moment');
}

// Fetch fully rendered HTML via ScraperAPI, then extract OG tags.
export async function fetchViaScraperAPI(url, { wait = 0, ultraPremium = false } = {}) {
    const key = process.env.SCRAPERAPI_KEY;
    if (!key) return null;
    const resolved = await resolveUrl(url);
    console.log('[meta] ScraperAPI resolved URL:', resolved);
    let apiUrl = `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(resolved)}&render=true&country_code=us`;
    if (wait > 0) apiUrl += `&wait=${wait}`;
    if (ultraPremium) apiUrl += '&ultra_premium=true';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
        const res = await fetch(apiUrl, { signal: ctrl.signal });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.warn('[meta] ScraperAPI non-200:', res.status, body.slice(0, 200));
            return null;
        }
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

// Fetch fully rendered HTML via Zyte API — handles Cloudflare-protected sites.
// Uses https.request instead of fetch to avoid Node.js/Windows TLS renegotiation issues.
// Also tolerates abrupt socket close (Windows schannel missing close_notify) by
// resolving with whatever data was received if we got a 200 and a parseable JSON body.
async function fetchViaZyte(url) {
    const key = process.env.ZYTE_API_KEY;
    if (!key) return null;
    const body = JSON.stringify({ url, browserHtml: true });
    const auth = Buffer.from(key + ':').toString('base64');
    return new Promise((resolve) => {
        let settled = false;
        function done(val) { if (!settled) { settled = true; resolve(val); } }

        function tryParse(statusCode, raw) {
            if (statusCode !== 200) { console.warn('[meta] Zyte non-200:', statusCode, raw.slice(0, 200)); return null; }
            try { return JSON.parse(raw).browserHtml ?? null; }
            catch { console.warn('[meta] Zyte JSON parse failed, raw length:', raw.length); return null; }
        }

        const req = https.request({
            hostname: 'api.zyte.com',
            port: 443,
            path: '/v1/extract',
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + auth,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => { chunks.push(chunk); });
            res.on('end', () => { done(tryParse(res.statusCode, Buffer.concat(chunks).toString('utf8'))); });
            // Socket closed without TLS close_notify — try to use buffered data anyway
            res.on('error', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                console.warn('[meta] Zyte response stream error — attempting partial parse, length:', raw.length);
                done(tryParse(res.statusCode, raw));
            });
        });
        req.setTimeout(120000, () => { req.destroy(); done(null); });
        req.on('error', (e) => { console.warn('[meta] Zyte error:', e.message); done(null); });
        req.write(body);
        req.end();
    });
}

// Extract goods_id and cat_id from a Shein product URL slug.
function parseSheinProductIds(url) {
    const m = String(url).match(/-p-(\d+)(?:-cat-(\d+))?(?:\.html)?/);
    if (!m) return null;
    return { goodsId: m[1], catId: m[2] || null };
}

export function sheinTitleOnlyMeta(pageUrl, usage, titleOverride = null, extra = {}) {
    return {
        title: titleOverride || slugTitleFromUrl(pageUrl) || null,
        image: null,
        images: [],
        provider: 'shein',
        titleSource: titleOverride ? 'api' : 'slug',
        imageStatus: 'unavailable',
        imageReason: 'shein_product_images_blocked',
        ...extra,
        usage,
    };
}

// Call Shein's internal product API to get title + image list without needing JS rendering.
// Returns { title, images } or null if unavailable.
export async function fetchSheinProduct(pageUrl) {
    const ids = parseSheinProductIds(pageUrl);
    if (!ids) return null;
    const { goodsId, catId } = ids;
    const params = new URLSearchParams({ goods_id: goodsId, currency: 'USD', lang: 'en', country: 'US' });
    if (catId) params.set('cat_id', catId);
    const endpoint = `https://us.shein.com/api/productInfo/queryGoodsDetailByGoodsId?${params}`;

    const sheinHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': pageUrl,
        'Origin': 'https://us.shein.com',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
    };

    async function tryFetch(url, opts) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
            return await fetch(url, { ...opts, signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    let res = await tryFetch(endpoint, { headers: sheinHeaders });

    if (!res.ok) { console.warn('[meta] Shein API direct failed:', res.status); return null; }
    let json;
    try { json = await res.json(); } catch { console.warn('[meta] Shein API: non-JSON response'); return null; }
    // Navigate common response shapes: { info: { detail: {...} } } or { data: { detail: {...} } }
    const detail = json?.info?.detail ?? json?.data?.detail ?? json?.detail ?? null;
    if (!detail) { console.warn('[meta] Shein API: no detail in response, keys:', Object.keys(json || {}).join(',')); return null; }
    const title = cleanTitle(detail.goods_name || detail.name || null) || null;
    // goods_imgs is an array of { origin_image, medium_image, thumbnail }
    const rawImgs = detail.goods_imgs || detail.mainImageList || [];
    const images = rawImgs
        .map(img => img?.origin_image || img?.medium_image || (typeof img === 'string' ? img : null))
        .filter(Boolean);
    console.log('[meta] Shein API ok — title:', title, 'images:', images.length);
    return { title, images };
}

// Fetch an image through ScraperAPI's residential proxy — bypasses CDN hotlink blocks.
async function fetchImageViaScraperAPIProxy(imageUrl) {
    const key = process.env.SCRAPERAPI_KEY;
    if (!key) return null;
    const apiUrl = `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(imageUrl)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
        const res = await fetch(apiUrl, { signal: ctrl.signal });
        if (!res.ok) { console.warn('[img-proxy] ScraperAPI fetch failed', res.status); return null; }
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!ALLOWED_LINK_IMG_MIME.has(type)) { console.warn('[img-proxy] bad content-type', type); return null; }
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_LINK_IMG_BYTES || buf.byteLength < 5120) {
            console.warn('[img-proxy] bad size', buf.byteLength);
            return null;
        }
        return `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
    } catch (e) {
        console.warn('[img-proxy] threw', e.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Returns true if an image URL looks like a site logo/marketing asset rather than a product image.
function isJunkImage(imageUrl) {
    if (!imageUrl) return true;
    const lower = imageUrl.toLowerCase();
    return (
        lower.includes('/logo') ||
        lower.includes('/logos') ||
        lower.includes('/marketing/') ||
        lower.includes('/brand/') ||
        lower.includes('/favicon') ||
        lower.includes('/icon') ||
        // Shein CDN non-product paths (acp/ach = app content/template assets like partner logos)
        lower.includes('ltwebstatic.com/images3_acp/') ||
        lower.includes('ltwebstatic.com/images3_ach/') ||
        lower.includes('ltwebstatic.com/v4/j/ccc/') ||
        lower.includes('ltwebstatic.com/v4/p/tinypic/')
    );
}


async function normalizeMetaImage(imageUrl, { referer } = {}) {
    if (!imageUrl) return null;
    return await fetchAndStoreImage(imageUrl, { referer, folder: 'meta/links' }) || imageUrl;
}

function absolutizeUrl(rawUrl, baseUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;
    try {
        return new URL(trimmed, baseUrl).toString();
    } catch {
        return null;
    }
}

function looksLikeImageUrl(value) {
    if (typeof value !== 'string') return false;
    const lower = value.toLowerCase();
    return (
        lower.startsWith('data:image/') ||
        /\.(avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/.test(lower) ||
        lower.includes('/images/') ||
        lower.includes('/image/') ||
        lower.includes('image=') ||
        lower.includes('images-') ||
        lower.includes('media-amazon.com/images/')
    );
}

function collectImageCandidates(value, out) {
    if (!value) return;
    if (typeof value === 'string') {
        if (looksLikeImageUrl(value)) out.push(value);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(function (item) { collectImageCandidates(item, out); });
        return;
    }
    if (typeof value === 'object') {
        ['image', 'thumbnailUrl', 'contentUrl', 'url'].forEach(function (key) {
            if (key in value) collectImageCandidates(value[key], out);
        });
    }
}

function parseJsonObject(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function pickFirstValidImage(candidates, baseUrl) {
    for (const candidate of candidates) {
        const absolute = absolutizeUrl(candidate, baseUrl);
        if (absolute && !isJunkImage(absolute)) return absolute;
    }
    return null;
}

function extractDynamicImageMap(raw, baseUrl) {
    if (!raw) return null;
    const parsed = parseJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const urls = Object.keys(parsed);
    return pickFirstValidImage(urls, baseUrl);
}

export function hostnameFromUrl(rawUrl) {
    try {
        return new URL(rawUrl).hostname.toLowerCase();
    } catch {
        return '';
    }
}

export function domainMatches(hostname, domains) {
    return domains.some(function (domain) {
        return hostname === domain || hostname.endsWith('.' + domain);
    });
}

// Titles that signal we got a site homepage/generic page rather than a product page.
const GENERIC_SITE_TITLES = new Set([
    'shein',
    "women's & men's clothing, shop online fashion | shein",
    'shop women\'s & men\'s fashion online | shein',
    'temu',
    'temu - affordable quality, express yourself',
    'temu - affordable quality everything',
    'amazon',
    'amazon.com',
]);

export function isGenericTitle(title) {
    if (!title) return true;
    const lower = title.toLowerCase().trim();
    if (GENERIC_SITE_TITLES.has(lower)) return true;
    // Single word that is just a brand name (e.g. "Temu", "SHEIN", "Amazon")
    if (/^(temu|shein|amazon|aliexpress|ebay|etsy)$/i.test(lower)) return true;
    return false;
}

// Extract a human-readable title from the URL slug for marketplace product URLs.
export function slugTitleFromUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const hostname = url.hostname.toLowerCase();
        let path = decodeURIComponent(url.pathname).replace(/\.html?$/i, '');

        let slug = null;

        if (domainMatches(hostname, ['shein.com'])) {
            // /Women-s-Solid-Color-Corduroy-Overall-Dress-p-1234567
            // /category/Women-s-Dress-p-1234.html  — strip after -p-
            const m = path.match(/\/([^/]+?)-p-\d+/i) || path.match(/\/([^/]+)$/);
            if (m) slug = m[1];
        } else if (domainMatches(hostname, ['temu.com', 'share.temu.com'])) {
            // /fi-en/1pc-stylish-pearl-shell-...-g-601099519015453
            const m = path.match(/\/(?:[a-z]{2}-[a-z]{2}\/)?(.+?)-g-\d+$/i) || path.match(/\/(?:[a-z]{2}-[a-z]{2}\/)?([^/]+)$/);
            if (m) slug = m[1];
        }

        if (!slug) return null;
        // Convert slug to readable title: hyphens → spaces, capitalise each word
        return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || null;
    } catch {
        return null;
    }
}

const MARKETPLACE_ADAPTERS = [
    {
        name: 'amazon',
        domains: ['amazon.com', 'a.co'],
        titleSelectors: [
            '#productTitle',
            'span#productTitle',
            '#title_feature_div #productTitle',
            '#title span.a-size-large',
            '#title span',
            '.product-title-word-break',
        ],
        imageSelectors: [
            ['#landingImage', 'data-old-hires'],
            ['#landingImage', 'src'],
            ['#imgTagWrapperId img', 'data-old-hires'],
            ['#imgTagWrapperId img', 'src'],
            ['#main-image-container img', 'src'],
        ],
        dynamicImageAttrs: [
            ['#landingImage', 'data-a-dynamic-image'],
            ['#imgTagWrapperId img', 'data-a-dynamic-image'],
        ],
    },
    {
        name: 'etsy',
        domains: ['etsy.com'],
        titleSelectors: ['h1[data-buy-box-listing-title="true"]', 'h1.wt-text-body-03'],
        imageSelectors: [
            ['img[data-index="0"]', 'src'],
            ['img[data-index="0"]', 'srcset'],
            ['img[data-carousel-image]', 'src'],
            ['img[data-carousel-image]', 'srcset'],
        ],
    },
    {
        name: 'ebay',
        domains: ['ebay.com'],
        titleSelectors: ['#x-title-label-lbl + h1', 'h1.x-item-title__mainTitle', 'h1'],
        imageSelectors: [
            ['#icImg', 'src'],
            ['#icImg', 'data-src'],
            ['.ux-image-carousel-item img', 'src'],
            ['.ux-image-carousel-item img', 'data-zoom-src'],
        ],
    },
    {
        name: 'temu',
        domains: ['temu.com', 'share.temu.com'],
        titleSelectors: [
            '[class*="goods-name"]',
            '[class*="product-title"]',
            '[data-testid="goods-name"]',
            '[data-testid="product-title"]',
        ],
        imageSelectors: [
            ['img', 'src'],
            ['img', 'data-src'],
            ['img', 'srcset'],
        ],
    },
    {
        name: 'aliexpress',
        domains: ['aliexpress.com'],
        titleSelectors: ['h1[data-pl="product-title"]', 'h1'],
        imageSelectors: [
            ['img.magnifier-image', 'src'],
            ['img.magnifier-image', 'srcset'],
            ['img', 'src'],
            ['img', 'srcset'],
        ],
    },
    {
        name: 'shein',
        domains: ['shein.com'],
        titleSelectors: [
            '.product-intro__head-name',
            '.goods-title-text',
            '[class*="product-intro"] h1',
            '[class*="ProductIntro"] h1',
            'h1[data-testid]',
            '[data-testid="product-intro-title"]',
            'h1',
        ],
        imageSelectors: [
            ['.crop-image-container img', 'data-src'],
            ['.crop-image-container', 'before-src'],
            ['.crop-image-container img', 'src'],
            ['.product-intro__thumbs-item--main img', 'data-src'],
            ['.product-intro__thumbs-item--main img', 'src'],
            ['[class*="main-swiper"] img', 'data-src'],
            ['[class*="main-swiper"] img', 'src'],
            ['[class*="product-intro__main"] img', 'data-src'],
            ['[class*="product-intro__main"] img', 'src'],
            ['img[class*="crop-image"]', 'data-src'],
            ['img[class*="crop-image"]', 'src'],
        ],
    },
];

function firstNonEmptyText($, selectors) {
    for (const selector of selectors || []) {
        const value = $(selector).first().text().trim();
        if (value) return value;
    }
    return null;
}

function parseSrcsetCandidate(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const first = raw.split(',').map(function (part) { return part.trim().split(/\s+/)[0]; }).find(Boolean);
    return first || null;
}

function parseSrcsetCandidates(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return raw
        .split(',')
        .map(function (part) {
            const bits = part.trim().split(/\s+/).filter(Boolean);
            const url = bits[0] || '';
            const descriptor = bits[1] || '';
            let score = 0;
            if (/^\d+w$/i.test(descriptor)) score = parseInt(descriptor, 10) || 0;
            else if (/^\d+(\.\d+)?x$/i.test(descriptor)) score = Math.round((parseFloat(descriptor) || 0) * 1000);
            return { url, score };
        })
        .filter(function (entry) { return !!entry.url; })
        .sort(function (a, b) { return b.score - a.score; })
        .map(function (entry) { return entry.url; });
}

function collectSelectorImages($, selectors, out) {
    for (const [selector, attr] of selectors || []) {
        const raw = $(selector).first().attr(attr);
        if (!raw) continue;
        const value = attr === 'srcset' ? parseSrcsetCandidate(raw) : raw;
        if (value) out.push(value);
    }
}

function collectDynamicImages($, selectors, pageUrl, out) {
    for (const [selector, attr] of selectors || []) {
        const raw = $(selector).first().attr(attr);
        const image = extractDynamicImageMap(raw, pageUrl);
        if (image) out.push(image);
    }
}

function collectDomImageCandidates($, out) {
    const ranked = [];
    $('img, source').each(function () {
        const el = $(this);
        const attrs = [
            'data-old-hires',
            'data-zoom-image',
            'data-large-image',
            'data-src',
            'data-lazy-src',
            'data-original',
            'data-image',
            'data-srcset',
            'srcset',
            'src',
        ];

        const width = parseInt(el.attr('width') || '0', 10) || 0;
        const height = parseInt(el.attr('height') || '0', 10) || 0;
        const area = width * height;
        const cls = String(el.attr('class') || '').toLowerCase();
        const id = String(el.attr('id') || '').toLowerCase();
        const alt = String(el.attr('alt') || '').toLowerCase();
        const roleBoost =
            (/(hero|main|primary|product|gallery|media|image)/.test(cls) ? 2000 : 0) +
            (/(hero|main|primary|product|gallery|media|image)/.test(id) ? 2000 : 0) +
            (/(product|main)/.test(alt) ? 500 : 0);

        attrs.forEach(function (attr) {
            const raw = el.attr(attr);
            if (!raw) return;
            const urls = /srcset$/i.test(attr) ? parseSrcsetCandidates(raw) : [raw];
            urls.forEach(function (url, index) {
                ranked.push({
                    url,
                    score: area + roleBoost - index,
                });
            });
        });
    });

    ranked
        .sort(function (a, b) { return b.score - a.score; })
        .forEach(function (entry) { out.push(entry.url); });
}

function uniqueImages(candidates, baseUrl, limit = 24) {
    const out = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const absolute = absolutizeUrl(candidate, baseUrl);
        if (!absolute || isJunkImage(absolute) || seen.has(absolute)) continue;
        seen.add(absolute);
        out.push(absolute);
        if (out.length >= limit) break;
    }
    return out;
}

export async function resolveBestImage(candidates, { referer, minBytes = 0 } = {}) {
    const tried = uniqueImages(candidates, referer || undefined, 24);
    for (const candidate of tried) {
        let normalized = await fetchAndStoreImage(candidate, { referer, minBytes, folder: 'meta/links' });
        if (!normalized) normalized = await fetchImageViaScraperAPIProxy(candidate);
        if (normalized) return { image: normalized, candidates: tried };
    }
    return { image: tried[0] || null, candidates: tried };
}

function findMarketplaceAdapter(pageUrl) {
    const hostname = hostnameFromUrl(pageUrl);
    return MARKETPLACE_ADAPTERS.find(function (adapter) {
        return domainMatches(hostname, adapter.domains);
    }) || null;
}

function collectJsonLdData($) {
    const parsed = [];
    $('script[type="application/ld+json"]').each(function () {
        const raw = $(this).contents().text().trim();
        if (!raw) return;
        const value = parseJsonObject(raw);
        if (value) parsed.push(value);
    });
    return parsed;
}

function collectNames(value, out) {
    if (!value) return;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) out.push(trimmed);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(function (item) { collectNames(item, out); });
        return;
    }
    if (typeof value === 'object') {
        if (typeof value.name === 'string' && value.name.trim()) out.push(value.name.trim());
        if (value['@graph']) collectNames(value['@graph'], out);
    }
}

function extractGenericMeta($) {
    const m = (prop, attr = 'property') =>
        $(`meta[${attr}="${prop}"]`).attr('content') || null;
    return {
        titleCandidates: [
            m('og:title'),
            m('twitter:title', 'name'),
            $('meta[name="title"]').attr('content'),
            $('h1').first().text().trim(),
            $('title').first().text().trim(),
        ].filter(Boolean),
        imageCandidates: [
            m('og:image'),
            m('og:image:url'),
            m('twitter:image', 'name'),
            m('twitter:image:src', 'name'),
            $('meta[itemprop="image"]').attr('content'),
            $('link[rel="image_src"]').attr('href'),
        ].filter(Boolean),
    };
}

function cleanTitle(t) {
    if (!t) return t;
    // Strip non-breaking spaces, zero-width chars, and LTR/RTL marks that survive .trim()
    return t.replace(/[\u00a0\u200b-\u200f\u202a-\u202e\u2060-\u2063\ufeff]/g, ' ').trim().replace(/\s+/g, ' ') || null;
}

function collectJsonLdProductNames(blocks) {
    const names = [];
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        const type = node['@type'];
        if ((type === 'Product' || type === 'ProductGroup') && typeof node.name === 'string') {
            const n = cleanTitle(node.name);
            if (n) names.push(n);
        }
        if (node['@graph']) visit(node['@graph']);
    }
    blocks.forEach(visit);
    return names;
}

// Scan all inline <script> tags for CDN image URLs embedded in JSON data (e.g. Shein's __NEXT_DATA__).
function extractScriptEmbeddedImages($, pageUrl) {
    const CDN_PATTERN = /https?:\/\/(?:img\.ltwebstatic\.com|img\.kwcdn\.com|img\.temu\.com)[^\s"'<>]+\.(?:webp|jpe?g|png|avif)/gi;
    const seen = new Set();
    const results = [];
    $('script').each(function () {
        let text = $(this).html() || '';
        if (!text.includes('ltwebstatic') && !text.includes('kwcdn') && !text.includes('temu')) return;
        // Normalize JSON-escaped slashes (\/) and unicode escapes (\u002F) before scanning
        text = text.replace(/\\u002[Ff]/g, '/').replace(/\\\//g, '/');
        let m;
        CDN_PATTERN.lastIndex = 0;
        while ((m = CDN_PATTERN.exec(text)) !== null) {
            const url = m[0];
            if (!seen.has(url)) { seen.add(url); results.push(url); }
        }
    });
    // Sort: product image paths first (spmp, plain /images3/), deprioritize known non-product paths
    results.sort(function (a, b) {
        function score(u) {
            if (u.includes('/spmp/') || u.includes('images3_spmp')) return 0;
            if (u.includes('/images3/')) return 1;
            return 2; // _ccc, _acp, or unknown suffixes
        }
        return score(a) - score(b);
    });
    return results;
}

export function extractOG(html, pageUrl) {
    const $ = cheerio.load(html);
    const generic = extractGenericMeta($);
    const adapter = findMarketplaceAdapter(pageUrl);
    const titleCandidates = generic.titleCandidates.map(cleanTitle).filter(Boolean);
    const imageCandidates = generic.imageCandidates.slice();
    const jsonLdBlocks = collectJsonLdData($);

    const jsonLdProductNames = collectJsonLdProductNames(jsonLdBlocks);

    const jsonLdNames = [];
    jsonLdBlocks.forEach(function (parsed) {
        collectNames(parsed, jsonLdNames);
        collectImageCandidates(parsed, imageCandidates);
    });

    if (adapter) {
        const adapterTitle = cleanTitle(firstNonEmptyText($, adapter.titleSelectors));
        // Adapter DOM selector wins; JSON-LD Product.name is second for marketplace pages
        if (adapterTitle) {
            titleCandidates.unshift(adapterTitle);
        } else if (jsonLdProductNames.length) {
            titleCandidates.unshift(jsonLdProductNames[0]);
        }
        // Adapter DOM images take priority over OG tags (OG often points to blocked CDN)
        const adapterImages = [];
        collectSelectorImages($, adapter.imageSelectors, adapterImages);
        collectDynamicImages($, adapter.dynamicImageAttrs, pageUrl, adapterImages);
        imageCandidates.unshift(...adapterImages);
    }

    collectDomImageCandidates($, imageCandidates);

    let title = titleCandidates.find(Boolean) || jsonLdProductNames.find(Boolean) || jsonLdNames.map(cleanTitle).find(Boolean) || null;

    // When scraping returned a generic site-level title (e.g. Shein/Temu homepage OG tag
    // instead of the product), fall back to the product name embedded in the URL slug.
    if (isGenericTitle(title) && adapter) {
        title = slugTitleFromUrl(pageUrl) || title;
    }

    const image = pickFirstValidImage(imageCandidates, pageUrl);

    // For marketplace pages: always mine script tags for CDN image URLs (e.g. __NEXT_DATA__)
    const scriptImages = adapter ? extractScriptEmbeddedImages($, pageUrl) : [];
    if (scriptImages.length) console.log('[meta] script-embedded images found:', scriptImages.length, scriptImages.map(u => u.slice(0, 100)));

    const allImages = uniqueImages([...imageCandidates, ...scriptImages], pageUrl, 24);

    return { title, image, allImages };
}

