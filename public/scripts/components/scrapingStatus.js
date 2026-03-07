// components/scrapingStatus.js
// Display user's scraping limits and remaining scrapes

const scrapingStatusContainer = document.getElementById('scrapingStatusContainer');
const scrapingStatusText = document.getElementById('scrapingStatusText');

let currentStatus = null;

// Fetch scraping status from server
export async function fetchScrapingStatus() {
    try {
        const response = await fetch('/api/scraping-status', {
            credentials: 'include'
        });
        
        if (!response.ok) {
            console.error('Failed to fetch scraping status');
            return null;
        }
        
        const status = await response.json();
        currentStatus = status;
        updateStatusDisplay(status);
        return status;
    } catch (error) {
        console.error('Error fetching scraping status:', error);
        return null;
    }
}

// Update status display in UI
function updateStatusDisplay(status) {
    if (!scrapingStatusText || !status) return;
    
    const remaining = status.remaining;
    const limit = status.limit;

    // Color based on remaining percentage
    let colorClass = 'text-woodsmoke-600';
    if (remaining === 0) {
        colorClass = 'text-red-600';
    } else if (remaining <= 2) {
        colorClass = 'text-yellow-600';
    }

    scrapingStatusText.textContent = `${remaining}/${limit} scrapes left today.`;
    scrapingStatusText.className = `text-xs ${colorClass} font-medium`;
    
    // Show/hide container
    if (scrapingStatusContainer) {
        scrapingStatusContainer.classList.remove('hidden');
    }
}

// Get current status (cached)
export function getCurrentStatus() {
    return currentStatus;
}

// Check if user can scrape
export function canUserScrape() {
    if (!currentStatus) return false;
    return currentStatus.canScrape;
}

// Update after scraping
export function decrementRemaining() {
    if (!currentStatus) return;
    
    currentStatus.used += 1;
    currentStatus.remaining = Math.max(0, currentStatus.remaining - 1);
    currentStatus.canScrape = currentStatus.remaining > 0;
    updateStatusDisplay(currentStatus);
}

// Initialize status display
export function initScrapingStatus() {
    fetchScrapingStatus();
}

// Refresh status (call after successful scrape)
export function refreshScrapingStatus() {
    return fetchScrapingStatus();
}