// State management with MongoDB backend (no localStorage)

const API_BASE_URL = window.location.origin;

// Application state (cached from server)
let storedLinks = [];
let bucketOptions = [];
let stopRequested = false;
let isRunning = false;
let currentFilters = [];
let currentViewMode = 'card';
let isInitialized = false;

const HARD_PAGE_LIMIT = 50;

// State change listeners
const listeners = new Set();

function notifyListeners() {
    listeners.forEach(callback => callback());
}

export function subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}

// ========== GETTERS ==========

export function getStoredLinks() {
    return storedLinks;
}

export function getBucketOptions() {
    return bucketOptions;
}

export function getStopRequested() {
    return stopRequested;
}

export function getIsRunning() {
    return isRunning;
}

export function getCurrentFilters() {
    return currentFilters;
}

export function getHardPageLimit() {
    return HARD_PAGE_LIMIT;
}

export function getCurrentViewMode() {
    return currentViewMode;
}

export function getIsInitialized() {
    return isInitialized;
}

// ========== API CALLS ==========

async function fetchBucketsFromServer() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/buckets`, {
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch buckets');
        }
        
        const buckets = await response.json();
        bucketOptions = ['Singletons', ...buckets];
        notifyListeners();
    } catch (error) {
        console.error('Error fetching buckets:', error);
        bucketOptions = ['Singletons'];
        notifyListeners();
    }
}

async function fetchLinksFromServer() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/links`, {
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch links');
        }
        
        const links = await response.json();
        storedLinks = links;
        notifyListeners();
    } catch (error) {
        console.error('Error fetching links:', error);
        storedLinks = [];
        notifyListeners();
    }
}

async function createBucketOnServer(bucketName) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/buckets`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ name: bucketName })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create bucket');
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error creating bucket:', error);
        throw error;
    }
}

async function updateBucketOnServer(oldName, newName) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/buckets/${encodeURIComponent(oldName)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ newName })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to update bucket');
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error updating bucket:', error);
        throw error;
    }
}

async function deleteBucketOnServer(bucketName) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/buckets/${encodeURIComponent(bucketName)}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete bucket');
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error deleting bucket:', error);
        throw error;
    }
}

async function saveLinksToServer(links, buckets = []) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/links`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ links, buckets })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to save links');
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error saving links:', error);
        throw error;
    }
}

async function clearLinksOnServer() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/links`, {
            method: 'DELETE',
            credentials: 'include'
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to clear links');
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error clearing links:', error);
        throw error;
    }
}

async function deleteLinkFromBucketOnServer(bucketName, linkHref) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/buckets/${encodeURIComponent(bucketName)}/links`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ href: linkHref })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete link');
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error deleting link:', error);
        throw error;
    }
}

// ========== SETTERS ==========

export function setStoredLinks(links) {
    storedLinks = links;
    notifyListeners();
}

export async function addLinks(newLinks, buckets = [], sourceUrl = '') {
    try {
        await saveLinksToServer(newLinks, buckets);
        await fetchLinksFromServer();
    } catch (error) {
        console.error('Failed to add links:', error);
        throw error;
    }
}

export function getBucketSourceUrl(bucketName) {
    const linkInBucket = storedLinks.find(link => 
        link.buckets && link.buckets.includes(bucketName)
    );
    return linkInBucket?.sourceUrl || '';
}

export async function clearLinks() {
    try {
        await clearLinksOnServer();
        storedLinks = [];
        notifyListeners();
    } catch (error) {
        console.error('Failed to clear links:', error);
        throw error;
    }
}

export async function deleteLinkFromBucket(bucketName, linkHref) {
    try {
        await deleteLinkFromBucketOnServer(bucketName, linkHref);

        // Refresh links from server to get updated state
        await fetchLinksFromServer();
    } catch (error) {
        console.error('Failed to delete link from bucket:', error);
        throw error;
    }
}

export async function setLinkFree(bucketName, href, isFree) {
    const response = await fetch(`${API_BASE_URL}/api/buckets/${encodeURIComponent(bucketName)}/links/free`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ href, isFree })
    });
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update link free status');
    }
    return response.json();
}

export function setBucketOptions(buckets) {
    bucketOptions = buckets;
    notifyListeners();
}

export async function addBucket(bucketName) {
    try {
        await createBucketOnServer(bucketName);
        
        if (!bucketOptions.includes(bucketName)) {
            bucketOptions.push(bucketName);
            notifyListeners();
        }
    } catch (error) {
        console.error('Failed to add bucket:', error);
        throw error;
    }
}

export async function removeBucket(bucketName) {
    try {
        await deleteBucketOnServer(bucketName);
        
        const index = bucketOptions.indexOf(bucketName);
        if (index > -1) {
            bucketOptions.splice(index, 1);
        }
        
        await fetchLinksFromServer();
    } catch (error) {
        console.error('Failed to remove bucket:', error);
        throw error;
    }
}

export async function updateBucket(oldName, newName) {
    try {
        await updateBucketOnServer(oldName, newName);
        
        const index = bucketOptions.indexOf(oldName);
        if (index > -1) {
            bucketOptions[index] = newName;
            notifyListeners();
        }
        
        await fetchLinksFromServer();
    } catch (error) {
        console.error('Failed to update bucket:', error);
        throw error;
    }
}

export function setStopRequested(value) {
    stopRequested = value;
}

export function setIsRunning(value) {
    isRunning = value;
}

export function setCurrentFilters(filters) {
    currentFilters = filters;
    notifyListeners();
}

export function addFilter(filter) {
    if (!currentFilters.includes(filter)) {
        currentFilters.push(filter);
        notifyListeners();
    }
}

export function removeFilter(filter) {
    const index = currentFilters.indexOf(filter);
    if (index > -1) {
        currentFilters.splice(index, 1);
        notifyListeners();
    }
}

export function clearFilters() {
    currentFilters = [];
    notifyListeners();
}

export function setCurrentViewMode(mode) {
    if (mode === 'list' || mode === 'card') {
        currentViewMode = mode;
        localStorage.setItem('viewMode', mode);
        notifyListeners();
    }
}

// Set bucket paywall flag and price
export async function setBucketPaywall(bucketName, isPaywalled, price) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/buckets/${encodeURIComponent(bucketName)}/paywall`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ isPaywalled, price })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to update paywall');
        }

        return await response.json();
    } catch (error) {
        console.error('Error updating bucket paywall:', error);
        throw error;
    }
}

// Get current user's credit balance
export async function getCreditsBalance() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/credits/balance`, {
            credentials: 'include'
        });

        if (!response.ok) throw new Error('Failed to fetch balance');
        return await response.json();
    } catch (error) {
        console.error('Error fetching credits balance:', error);
        return { credits: 0 };
    }
}

// Initiate Stripe Checkout for a credit topup — redirects the page
export async function topupCredits(credits) {
    const response = await fetch(`${API_BASE_URL}/api/credits/topup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ credits })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create checkout session');
    }

    const { url } = await response.json();
    window.location.href = url;
}

// Unlock a paywalled bucket by spending credits
export async function unlockBucket(bucketId) {
    const response = await fetch(`${API_BASE_URL}/api/credits/unlock/${bucketId}`, {
        method: 'POST',
        credentials: 'include'
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to unlock bucket');
    }

    return await response.json();
}

// ========== STRIPE CONNECT ==========

export async function getConnectStatus() {
    const response = await fetch(`${API_BASE_URL}/api/connect/status`, {
        credentials: 'include'
    });
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch connect status');
    }
    return await response.json();
}

export async function startConnectOnboarding() {
    const response = await fetch(`${API_BASE_URL}/api/connect/onboard`, {
        method: 'POST',
        credentials: 'include'
    });
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start onboarding');
    }
    return await response.json();
}

export async function requestCashout() {
    const response = await fetch(`${API_BASE_URL}/api/connect/cashout`, {
        method: 'POST',
        credentials: 'include'
    });
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to process cashout');
    }
    return await response.json();
}

// Toggle bucket public/private visibility
export async function toggleBucketVisibility(bucketName, isPublic) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/buckets/${encodeURIComponent(bucketName)}/visibility`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ isPublic })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to update visibility');
        }

        return await response.json();
    } catch (error) {
        console.error('Error updating bucket visibility:', error);
        throw error;
    }
}

// Update bucket thumbnail
export async function updateBucketThumbnail(bucketName, thumbnailData) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/buckets/${encodeURIComponent(bucketName)}/thumbnail`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ thumbnail: thumbnailData })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to update thumbnail');
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error updating thumbnail:', error);
        throw error;
    }
}

// Get bucket thumbnail
export async function getBucketThumbnail(bucketName) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/buckets/${encodeURIComponent(bucketName)}/thumbnail`, {
            credentials: 'include'
        });
        
        if (!response.ok) {
            return null;
        }
        
        const data = await response.json();
        return data.thumbnail;
    } catch (error) {
        console.error('Error fetching thumbnail:', error);
        return null;
    }
}

// ========== INITIALIZATION ==========

export async function loadBucketsFromStorage() {
    await fetchBucketsFromServer();
}

export async function loadLinksFromStorage() {
    await fetchLinksFromServer();
}

export function loadViewModeFromStorage() {
    const saved = localStorage.getItem('viewMode');
    if (saved === 'list' || saved === 'card') {
        currentViewMode = saved;
    }
}

export async function initializeFromServer() {
    if (isInitialized) {
        return;
    }
    
    try {
        await Promise.all([
            fetchBucketsFromServer(),
            fetchLinksFromServer()
        ]);
        
        loadViewModeFromStorage();
        isInitialized = true;
    } catch (error) {
        console.error('Failed to initialize from server:', error);
    }
}

export async function getBucketShareId(bucketName) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/buckets/${encodeURIComponent(bucketName)}/id`, {
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error('Failed to get bucket ID');
        }
        
        const data = await response.json();
        return data.bucketId;
    } catch (error) {
        console.error('Error getting bucket share ID:', error);
        throw error;
    }
}

// ========== UTILITY FUNCTIONS ==========

export function getActiveBucketsInLinks() {
    const activeBuckets = new Set();
    storedLinks.forEach(link => {
        if (link.buckets && link.buckets.length > 0) {
            link.buckets.forEach(bucket => activeBuckets.add(bucket));
        }
    });
    return Array.from(activeBuckets).sort();
}

export function getFilteredLinks() {
    return currentFilters.length === 0
        ? storedLinks
        : storedLinks.filter(link =>
            link.buckets && link.buckets.some(bucket => currentFilters.includes(bucket))
        );
}