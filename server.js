const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

// Allow your frontend to talk to this backend
app.use(cors());
app.use(express.json());

// Parse a duration string into minutes (rounded up)
// Handles: "137:55", "19:32", "1:02:33", "19m", "25 min", "1h30", "2 hours 15 min"
function parseDuration(text) {
    if (!text) return null;
    text = String(text).toLowerCase().trim();

    // Case: 137:55, 19:32, 1:02:33
    const timeFormat = text.match(/(\d+):(\d{2})(?::(\d{2}))?/);
    if (timeFormat) {
        const part1 = parseInt(timeFormat[1], 10);
        const part2 = parseInt(timeFormat[2], 10);
        const part3 = timeFormat[3] ? parseInt(timeFormat[3], 10) : 0;

        // If we have 3 parts, treat as hh:mm:ss
        if (timeFormat[3]) {
            const hours = part1;
            const mins = part2;
            const secs = part3;
            return hours * 60 + mins + (secs > 0 ? 1 : 0); // in minutes
        } else {
            // 2 parts => treat as mm:ss (works fine even for 137:55)
            const mins = part1;
            const secs = part2;
            return mins + (secs > 0 ? 1 : 0);
        }
    }

    // Case: 19m, 25min, 60 mins
    const minuteOnly = text.match(/(\d+)\s*m(in)?s?/);
    if (minuteOnly) {
        return parseInt(minuteOnly[1], 10);
    }

    // Case: 1h30, 2 hours 15 min
    const hourFormat = text.match(/(\d+)\s*h(our)?s?\s*(\d+)?\s*m?/);
    if (hourFormat) {
        const h = parseInt(hourFormat[1], 10);
        const m = parseInt(hourFormat[3] || 0, 10);
        return h * 60 + m;
    }

    return null;
}

app.get('/scrape', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        // 1. Fetch the raw HTML from the website
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        // 2. Load HTML into Cheerio
        const $ = cheerio.load(data);
        const linksMap = new Map();

        // 3a. Detect maximum page number from any ?page=XX links
        let maxPage = 1;
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const match = href.match(/page=(\d+)/i);
            if (match) {
                const num = parseInt(match[1], 10);
                if (!Number.isNaN(num) && num > maxPage) {
                    maxPage = num;
                }
            }
        });

        // 3b. Extract all relevant video links + durations
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();

            if (!href) return;

            try {
                // Keep same filtering logic for video URLs
                if (href.includes('viewkey=') && !href.includes('pkey=')) {
                    const absoluteUrl = new URL(href, url).href;

                    // Find a container around the link that also holds the duration
                    const container = $(el).closest('li, .thumb, .video, .phimage, .item, div');

                    // Duration is inside:
                    // <var class="bgShadeEffect duration tooltipTrig" data-title="Video Duration">137:55</var>
                    const durationVar =
                        container
                            .find('var.duration[data-title="Video Duration"]')
                            .first() ||
                        $(el)
                            .find('var.duration[data-title="Video Duration"]')
                            .first();

                    const durationText =
                        (durationVar && durationVar.text() && durationVar.text().trim()) || '';

                    // Use parsed minutes to filter out short videos (< 19 minutes)
                    const minutes = parseDuration(durationText);
                    if (minutes !== null && minutes < 19) {
                        return; // EXCLUDE this video
                    }

                    const existing = linksMap.get(absoluteUrl);
                    const linkObj = {
                        href: absoluteUrl,
                        text: text || '(No Text)',
                        duration: durationText || null
                    };

                    // If duplicate href: keep the one with longer text
                    if (!existing || text.length > existing.text.length) {
                        linksMap.set(absoluteUrl, linkObj);
                    }
                }
            } catch (err) {
                // Silently ignore errors for individual anchors
            }
        });

        // 4. Send back JSON
        const links = Array.from(linksMap.values());
        res.json({ links, count: links.length, maxPage });
    } catch (error) {
        console.error(error.message);
        res.status(500).json({
            error: 'Failed to scrape the URL. It might differ by site security.'
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
