// server/middleware/scrapingLimit.js

/**
 * Middleware to check if user has exceeded daily scraping limit
 * Must be used after anonymousAuth middleware
 */
export async function checkScrapingLimit(req, res, next) {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Check if user can scrape
        if (!req.user.canScrape()) {
            const limit = req.user.scrapingLimit;
            
            return res.status(429).json({
                error: 'Daily scraping limit reached',
                message: `You have reached your daily limit of ${limit} scrapes. Please try again tomorrow or log in for more scrapes.`,
                limit: limit,
                used: req.user.dailyScrapingCount,
                remaining: 0,
                resetTime: getNextResetTime()
            });
        }

        // User can scrape, continue
        next();
    } catch (error) {
        console.error('Scraping limit check error:', error);
        res.status(500).json({ error: 'Failed to check scraping limit' });
    }
}

/**
 * Helper to get next reset time (midnight UTC)
 */
function getNextResetTime() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.toISOString();
}

/**
 * Get user's current scraping status
 */
export async function getScrapingStatus(req, res) {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Reset if needed
        req.user.checkAndResetDailyLimit();
        
        const remaining = req.user.getRemainingScrapers();
        const limit = req.user.scrapingLimit;
        const used = req.user.dailyScrapingCount;

        res.json({
            limit: limit,
            used: used,
            remaining: remaining,
            canScrape: req.user.canScrape(),
            resetTime: getNextResetTime(),
            isAnonymous: req.user.isAnonymous
        });
    } catch (error) {
        console.error('Error fetching scraping status:', error);
        res.status(500).json({ error: 'Failed to fetch scraping status' });
    }
}