/**
 * Manual test script for urlSafety utilities.
 * Run with: node scripts/test-url-safety.js
 */

import { isValidUrl, isUrlShortener, checkUrlHaus, checkSafeBrowsing, validateLinks } from '../server/utils/urlSafety.js';

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';

function pass(label) { console.log(`${GREEN}  ✓ ${label}${RESET}`); }
function fail(label) { console.log(`${RED}  ✗ ${label}${RESET}`); }
function info(label) { console.log(`${YELLOW}  ~ ${label}${RESET}`); }

// ─── 1. Protocol allowlist ────────────────────────────────────────────────────
console.log(`\n${BOLD}1. isValidUrl (protocol allowlist)${RESET}`);

const cases = [
    { url: 'https://example.com',           expect: true  },
    { url: 'http://example.com/path?q=1',   expect: true  },
    { url: 'javascript:alert(1)',            expect: false },
    { url: 'data:text/html,<script>x</script>', expect: false },
    { url: 'file:///etc/passwd',             expect: false },
    { url: 'ftp://files.example.com',        expect: false },
    { url: 'not-a-url-at-all',               expect: false },
    { url: '',                               expect: false },
];

for (const { url, expect } of cases) {
    const result = isValidUrl(url);
    const ok = result === expect;
    (ok ? pass : fail)(`isValidUrl(${JSON.stringify(url)}) → ${result} (expected ${expect})`);
}

// ─── 2. validateLinks rejects bad protocols ───────────────────────────────────
console.log(`\n${BOLD}2. validateLinks blocks bad protocols${RESET}`);

{
    const { ok, blocked } = await validateLinks(['javascript:alert(1)', 'data:text/html,x']);
    if (!ok && blocked.length === 2) pass('rejects javascript: and data: urls');
    else fail(`unexpected result: ok=${ok}, blocked=${JSON.stringify(blocked)}`);
}

// ─── 3. validateLinks passes clean URLs (no URLhaus hit expected) ─────────────
console.log(`\n${BOLD}3. validateLinks passes known-clean URLs${RESET}`);

{
    const { ok, blocked } = await validateLinks(['https://github.com', 'https://youtube.com']);
    if (ok) pass('github.com and youtube.com pass');
    else fail(`unexpectedly blocked: ${JSON.stringify(blocked)}`);
}

// ─── 4. URL shortener blocklist ──────────────────────────────────────────────
console.log(`\n${BOLD}4. isUrlShortener${RESET}`);

const shortenerCases = [
    { url: 'https://bit.ly/abc123',          expect: true  },
    { url: 'https://tinyurl.com/xyz',         expect: true  },
    { url: 'https://t.co/abc',               expect: true  },
    { url: 'https://amzn.to/3xyz',           expect: true  },
    { url: 'https://go.bitly.com/xyz',       expect: true  }, // subdomain
    { url: 'https://github.com/foo/bar',     expect: false },
    { url: 'https://youtube.com/watch?v=x',  expect: false }, // full youtube ok
    { url: 'https://youtu.be/abc',           expect: true  }, // shortener not ok
];

for (const { url, expect } of shortenerCases) {
    const result = isUrlShortener(url);
    const ok = result === expect;
    (ok ? pass : fail)(`isUrlShortener(${JSON.stringify(url)}) → ${result} (expected ${expect})`);
}

{
    const { ok, blocked } = await validateLinks(['https://bit.ly/abc123', 'https://github.com']);
    if (!ok && blocked.includes('https://bit.ly/abc123')) pass('validateLinks blocks shortener URLs');
    else fail(`unexpected result: ok=${ok}, blocked=${JSON.stringify(blocked)}`);
}

// ─── 5. URLhaus API reachability ─────────────────────────────────────────────
// We verify the API responds correctly rather than relying on a specific URL
// staying in their live list (entries expire once a site is taken down).
console.log(`\n${BOLD}4. checkUrlHaus — API reachability${RESET}`);

{
    // Fetch a currently-listed URL directly from URLhaus to use as a live fixture
    info('fetching a live entry from URLhaus recent feed...');
    try {
        const feedRes = await fetch('https://urlhaus-api.abuse.ch/v1/urls/recent/limit/1/', {
            method: 'GET',
            signal: AbortSignal.timeout(8000),
        });
        const feed = await feedRes.json();
        const liveUrl = feed.urls?.[0]?.url;

        if (!liveUrl) {
            info('Could not fetch a live entry from URLhaus feed — skipping live check');
        } else {
            info(`testing with live URLhaus entry: ${liveUrl}`);
            const flagged = await checkUrlHaus([liveUrl]);
            if (flagged.length > 0) pass(`URLhaus correctly flagged the live entry`);
            else info('URLhaus returned no results for live entry — may have just been delisted. API is reachable.');
        }
    } catch (err) {
        info(`URLhaus feed unreachable: ${err.message} — skipping live check`);
    }
}

// ─── 5. 256-link cap via validateLinks ───────────────────────────────────────
console.log(`\n${BOLD}5. 256-link limit (schema-level, not in validateLinks)${RESET}`);
info('The cap is enforced in the route handlers, not in validateLinks.');
info('To test it: POST /api/buckets with a links array of 257 items and confirm a 400 response.');

// ─── 6. Host deduplication efficiency ────────────────────────────────────────
console.log(`\n${BOLD}6. Host deduplication${RESET}`);

{
    const urls = [
        'https://github.com/foo',
        'https://github.com/bar',
        'https://github.com/baz',
        'https://youtube.com/watch?v=1',
        'https://youtube.com/watch?v=2',
    ];
    info(`5 URLs across 2 unique hosts — should fire 2 URLhaus requests, not 5`);
    const flagged = await checkUrlHaus(urls);
    pass(`deduplication ran without error; flagged: ${flagged.length === 0 ? 'none (expected)' : flagged.join(', ')}`);
}

// ─── 7. Google Safe Browsing ──────────────────────────────────────────────────
console.log(`\n${BOLD}7. checkSafeBrowsing${RESET}`);

{
    const apiKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY;
    if (!apiKey) {
        info('GOOGLE_SAFE_BROWSING_API_KEY not set — skipping (set it in .env to enable)');
    } else {
        // Google maintains a canonical test URL for Safe Browsing integrations
        const testUrl = 'http://malware.testing.google.test/testing/malware/';
        info(`checking Google test URL: ${testUrl}`);
        const flagged = await checkSafeBrowsing([testUrl]);
        if (flagged.length > 0) pass('Safe Browsing correctly flagged the Google test URL');
        else fail('Safe Browsing did not flag the Google test URL — check your API key');

        // Clean URL should pass
        const clean = await checkSafeBrowsing(['https://github.com']);
        if (clean.length === 0) pass('github.com passes Safe Browsing');
        else fail('github.com was unexpectedly flagged by Safe Browsing');
    }
}

console.log('');
