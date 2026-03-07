// services/scraper.js
// Handles scraping with proper limit tracking

import { 
    addLinks, 
    setStopRequested, 
    setIsRunning,
    getStopRequested,
    getHardPageLimit 
} from '../state/store.js';

const API_BASE_URL = window.location.origin;

/**
 * Scrape multiple pages from a URL
 * Only counts as ONE scrape regardless of how many pages
 */
export async function scrapeMultiplePages(baseUrl, selectedBuckets, statusCallback) {
    try {
        setIsRunning(true);
        setStopRequested(false);

        // IMPORTANT: Increment counter ONCE at the start of scraping session
        try {
            const incrementResponse = await fetch(`${API_BASE_URL}/api/scraping/increment`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!incrementResponse.ok) {
                const errorData = await incrementResponse.json();
                
                if (incrementResponse.status === 429) {
                    // Limit reached
                    throw new Error('Daily scraping limit reached');
                }
                
                throw new Error(errorData.error || 'Failed to validate scraping limit');
            }

            const incrementData = await incrementResponse.json();
            console.log('Scraping session started:', incrementData);

        } catch (incrementError) {
            setIsRunning(false);
            throw incrementError;
        }

        // First scrape to detect max pages
        statusCallback('Scraping page 1...', 'text-blue-500');

        const firstPageResponse = await fetch(
            `${API_BASE_URL}/scrape?url=${encodeURIComponent(baseUrl)}`,
            { credentials: 'include' }
        );

        if (!firstPageResponse.ok) {
            const errorData = await firstPageResponse.json();
            throw new Error(errorData.error || 'Failed to scrape');
        }

        const firstPageData = await firstPageResponse.json();
        const { links: firstPageLinks, maxPage } = firstPageData;

        // Collect all links
        let allLinks = [...firstPageLinks];

        // Add source URL to links
        allLinks = allLinks.map(link => ({ ...link, sourceUrl: baseUrl }));

        // Save first page
        if (allLinks.length > 0) {
            await addLinks(allLinks, selectedBuckets, baseUrl);
        }

        statusCallback(
            `Page 1: Found ${firstPageLinks.length} link(s). Detected ${maxPage} total page(s).`,
            'text-blue-500'
        );

        // Check if user wants to stop
        if (getStopRequested()) {
            statusCallback('Scraping stopped by user.', 'text-yellow-500');
            setIsRunning(false);
            return;
        }

        // If multiple pages exist, scrape them
        if (maxPage > 1) {
            const pagesToScrape = Math.min(maxPage, getHardPageLimit());

            for (let page = 2; page <= pagesToScrape; page++) {
                // Check stop flag
                if (getStopRequested()) {
                    statusCallback('Scraping stopped by user.', 'text-yellow-500');
                    break;
                }

                statusCallback(`Scraping page ${page} of ${pagesToScrape}...`, 'text-blue-500');

                // Build page URL
                const pageUrl = baseUrl.includes('?')
                    ? `${baseUrl}&page=${page}`
                    : `${baseUrl}?page=${page}`;

                try {
                    const pageResponse = await fetch(
                        `${API_BASE_URL}/scrape?url=${encodeURIComponent(pageUrl)}`,
                        { credentials: 'include' }
                    );

                    if (!pageResponse.ok) {
                        console.error(`Failed to scrape page ${page}`);
                        continue;
                    }

                    const pageData = await pageResponse.json();
                    const pageLinks = pageData.links.map(link => ({ 
                        ...link, 
                        sourceUrl: baseUrl 
                    }));

                    // Save links from this page
                    if (pageLinks.length > 0) {
                        await addLinks(pageLinks, selectedBuckets, baseUrl);
                        allLinks = [...allLinks, ...pageLinks];
                    }

                    statusCallback(
                        `Page ${page}: Found ${pageLinks.length} link(s). Total: ${allLinks.length}`,
                        'text-blue-500'
                    );

                } catch (pageError) {
                    console.error(`Error scraping page ${page}:`, pageError);
                    statusCallback(
                        `Error on page ${page}. Continuing...`,
                        'text-yellow-500'
                    );
                }

                // Small delay between pages
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            if (pagesToScrape < maxPage) {
                statusCallback(
                    `Stopped at page ${pagesToScrape} (limit: ${getHardPageLimit()} pages).`,
                    'text-yellow-500'
                );
            }
        }

        // Final status
        const finalMessage = getStopRequested()
            ? `Stopped. Collected ${allLinks.length} link(s) total.`
            : `Complete! Collected ${allLinks.length} link(s) from ${Math.min(maxPage, getHardPageLimit())} page(s).`;

        statusCallback(finalMessage, 'text-green-600');

    } catch (error) {
        console.error('Scraping error:', error);
        throw error;
    } finally {
        setIsRunning(false);
        setStopRequested(false);
    }
}

/**
 * Request to stop scraping
 */
export function stopScraping() {
    setStopRequested(true);
}