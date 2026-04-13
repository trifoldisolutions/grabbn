/**
 * URL safety utilities.
 *
 * isValidUrl      — protocol allowlist (sync, always runs)
 * isUrlShortener  — blocks known URL shortener domains (sync)
 * checkUrlHaus    — URLhaus lookup, no API key required (async, fails open)
 * validateLinks   — runs all checks; returns { ok: boolean, blocked: string[] }
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Common URL shortener domains. Add more as needed.
const URL_SHORTENERS = new Set([
    'bit.ly', 'bitly.com',
    'tinyurl.com',
    't.co',
    'goo.gl',
    'ow.ly',
    'buff.ly',
    'rebrand.ly',
    'short.io',
    'tiny.cc',
    'is.gd',
    'v.gd',
    'cutt.ly',
    'bl.ink',
    'hyperurl.co',
    'shorturl.at',
    'clck.ru',
    't2m.io',
    'snip.ly',
    'lnkd.in',
    'youtu.be',  // youtube shortener
    'fb.me',
    'amzn.to', 'amzn.com',
    'adf.ly',
    'bc.vc',
    'adfoc.us',
    'sh.st',
    'ouo.io',
    'shorte.st',
]);

export function isUrlShortener(href) {
    try {
        const { hostname } = new URL(href);
        // Match exact domain or any subdomain (e.g. go.bitly.com)
        return [...URL_SHORTENERS].some(s => hostname === s || hostname.endsWith('.' + s));
    } catch {
        return false;
    }
}

export function isValidUrl(href) {
    try {
        const u = new URL(href);
        return ALLOWED_PROTOCOLS.has(u.protocol);
    } catch {
        return false;
    }
}

/**
 * Check a single hostname against URLhaus (abuse.ch) host lookup.
 * Returns true if the host is listed as malicious.
 */
async function isHostListedOnUrlHaus(host) {
    try {
        const res = await fetch('https://urlhaus-api.abuse.ch/v1/host/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ host }),
            signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) return false;

        const data = await res.json();
        return data.query_status === 'is_listed';
    } catch {
        return false; // fail open — don't block submissions if API is down
    }
}

/**
 * Check URLs against URLhaus using host-level deduplication.
 * Many links share the same domain, so we deduplicate before hitting the API —
 * 256 links with 20 unique hosts = 20 requests instead of 256.
 * Returns the subset of urls whose host is flagged.
 */
export async function checkUrlHaus(urls) {
    if (urls.length === 0) return [];

    // Extract unique hostnames, skip unparseable URLs
    const hostToUrls = new Map();
    for (const url of urls) {
        try {
            const { hostname } = new URL(url);
            if (!hostToUrls.has(hostname)) hostToUrls.set(hostname, []);
            hostToUrls.get(hostname).push(url);
        } catch { /* skip */ }
    }

    // Check each unique host in parallel
    const flaggedHosts = new Set(
        (await Promise.all(
            [...hostToUrls.keys()].map(async host => (await isHostListedOnUrlHaus(host) ? host : null))
        )).filter(Boolean)
    );

    // Return every URL whose host was flagged
    return urls.filter(url => {
        try { return flaggedHosts.has(new URL(url).hostname); } catch { return false; }
    });
}

/**
 * Validate an array of URL strings.
 * @param {string[]} urls
 * @returns {{ ok: boolean, blocked: string[] }}
 */
export async function validateLinks(urls) {
    const invalid = urls.filter(u => !isValidUrl(u));
    if (invalid.length > 0) {
        return { ok: false, blocked: invalid };
    }

    const shortened = urls.filter(u => isUrlShortener(u));
    if (shortened.length > 0) {
        return { ok: false, blocked: shortened };
    }

    const flagged = await checkUrlHaus(urls);
    if (flagged.length > 0) {
        return { ok: false, blocked: flagged };
    }

    return { ok: true, blocked: [] };
}
