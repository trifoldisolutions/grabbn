// grabbnScrapeEngine.js
// Universal scraping engine using Playwright.
// Handles JS-rendered pages (YouTube, Amazon, Pinterest, SHEIN, etc.)
// Returns: { links: [{ href, text }], count, maxPage }

import { chromium } from 'playwright';
import * as cheerio from 'cheerio';

const SKIP_SCHEMES = ['#', 'mailto:', 'javascript:', 'tel:', 'data:'];

// Links inside these containers are navigation/utility, not content
const NAV_SELECTORS = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';

// Very short text is almost always a nav/utility link ("Ad", "About", "Home")
const MIN_TEXT_LENGTH = 8;

// Phrases that indicate a bot-challenge or gate page instead of real content
const BLOCK_PAGE_SIGNALS = [
    /more information/i,
    /just a moment/i,
    /checking your browser/i,
    /enable javascript/i,
    /access denied/i,
    /403 forbidden/i,
    /cloudflare/i,
    /please verify/i,
    /are you a robot/i,
    /captcha/i,
    /ddos protection/i,
    /security check/i,
    /ray id/i,
];

function isBlockPage(title, bodyText) {
    const combined = `${title} ${bodyText.slice(0, 2000)}`;
    return BLOCK_PAGE_SIGNALS.some(re => re.test(combined));
}

export async function scrapePage(url) {
    const browser = await chromium.launch({ headless: true });

    try {
        const context = await browser.newContext({
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'en-US',
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            }
        });

        const page = await context.newPage();

        // Hide the webdriver flag — the primary signal sites use for bot detection
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // Try networkidle first; fall back to load if it times out
        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
        } catch {
            await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        }

        // Scroll to bottom to trigger lazy-loaded content (infinite scroll, etc.)
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1500);

        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body?.innerText || '');

        if (isBlockPage(title, bodyText)) {
            throw new Error(`Bot-challenge page detected (title: "${title}"). The site is blocking automated access.`);
        }

        const html = await page.content();
        const $ = cheerio.load(html);
        const linksMap = new Map();

        // Detect max pagination from ?page=N or &page=N patterns
        let maxPage = 1;
        $('a').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const match = href.match(/[?&]page=(\d+)/i);
            if (match) {
                const num = parseInt(match[1], 10);
                if (!Number.isNaN(num) && num > maxPage) maxPage = num;
            }
        });

        // Extract content anchor links, skipping nav/header/footer noise
        $('a').each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();

            if (!href || !text) return;
            if (text.length < MIN_TEXT_LENGTH) return;
            if (SKIP_SCHEMES.some(scheme => href.startsWith(scheme))) return;

            // Skip links inside nav/header/footer containers
            if ($(el).closest(NAV_SELECTORS).length > 0) return;

            try {
                const absoluteUrl = new URL(href, url).href;
                if (!linksMap.has(absoluteUrl)) {
                    linksMap.set(absoluteUrl, { href: absoluteUrl, text });
                }
            } catch {
                // skip malformed URLs
            }
        });

        const links = Array.from(linksMap.values());
        return { links, count: links.length, maxPage };

    } finally {
        await browser.close();
    }
}
