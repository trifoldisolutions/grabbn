// Bucket links popup manager

import { getStoredLinks, deleteLinkFromBucket, removeBucket, getBucketShareId, addLinks, loadBucketsFromStorage, loadLinksFromStorage, toggleBucketVisibility, setBucketPaywall, setLinkFree } from '../state/store.js';
import { copyToClipboard, showNotification } from '../utils/helpers.js';

const seeLinksWrapper = document.getElementById('seeLinksWrapper');
const bucketLinksPopup = document.getElementById('bucketLinksPopup');
const closePopupBtn = document.getElementById('closePopupBtn');
const popupBucketName = document.getElementById('popupBucketName');
const popupLinksList = document.getElementById('popupLinksList');
function updateLinkCount(text) { const el = document.getElementById('popupLinkCount'); if (el) el.textContent = text; }
const bucketCopyAllBtn = document.getElementById('bucketCopyAllBtn');
const bucketShareBtn = document.getElementById('bucketShareBtn');
const bucketDeleteBtn = document.getElementById('bucketDeleteBtn');
const popupBucketMetadata = document.getElementById('popupBucketMetadata');
const addLinkForm = document.getElementById('addLinkForm');
const addLinkLabel = document.getElementById('addLinkLabel');
const addLinkUrl = document.getElementById('addLinkUrl');
const addLinkBtn = document.getElementById('addLinkBtn');
const addLinkModeBtn = document.getElementById('addLinkModeBtn');
const lookupModeBtn = document.getElementById('lookupModeBtn');
const linkModeLabel = document.getElementById('linkModeLabel');
const switchIndicator = document.getElementById('switchIndicator');
const clearAddLinkLabel = document.getElementById('clearAddLinkLabel');
const clearAddLinkUrl = document.getElementById('clearAddLinkUrl');
const lookupResultsBanner = document.getElementById('lookupResultsBanner');
const lookupResultsText = document.getElementById('lookupResultsText');
const clearLookupBtn = document.getElementById('clearLookupBtn');

const addLinkFormContainer = document.getElementById('addLinkFormContainer');
const bucketDeleteBtnContainer = document.getElementById('bucketDeleteBtnContainer');
const bucketGrabBtnContainer = document.getElementById('bucketGrabBtnContainer');
const bucketGrabBtn = document.getElementById('bucketGrabBtn');
const bucketReportBtnContainer = document.getElementById('bucketReportBtnContainer');
const bucketReportBtn = document.getElementById('bucketReportBtn');
const bucketVisibilityBtnContainer = document.getElementById('bucketVisibilityBtnContainer');
const bucketVisibilityBtn = document.getElementById('bucketVisibilityBtn');
const bucketPaywallBtnContainer = document.getElementById('bucketPaywallBtnContainer');

const bucketPriceInput = document.getElementById('bucketPriceInput');
const bucketPriceDollarHint = document.getElementById('bucketPriceDollarHint');
const bucketPriceCurrencyToggle = document.getElementById('bucketPriceCurrencyToggle');
const bucketPaywallSaveBtn = document.getElementById('bucketPaywallSaveBtn');
const bucketFooterPrice = document.getElementById('bucketFooterPrice');
const bucketFooterPriceText = document.getElementById('bucketFooterPriceText');
const bucketFooterPriceDollar = document.getElementById('bucketFooterPriceDollar');

let priceInputMode = 'crd'; // 'crd' | 'usd'

// ── Multi-select state ──────────────────────────────────────────────────────
let isMultiSelectMode = false;
let selectedHrefs = new Set();
let bulkMonetizeMode = 'free'; // 'free' | 'paywalled'

const bulkSelectRow = document.getElementById('bulkSelectRow');
const bulkActions = document.getElementById('bulkActions');
const bulkMonetizeBtn = document.getElementById('bulkMonetizeBtn');
const bulkMonetizeBtnLabel = document.getElementById('bulkMonetizeBtnLabel');
const bulkCopyBtn = document.getElementById('bulkCopyBtn');
const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
const selectAllBtn = document.getElementById('selectAllBtn');
const bulkSelectCloseBtn = document.getElementById('bulkSelectCloseBtn');

let currentBucketLinks = [];
let currentBucketName = '';
let currentBucketIsPublic = false;
let currentBucketVisibility = 'private';
let currentBucketIsPaywalled = false;
let currentBucketPrice = 0;
let currentLinkMode = 'add';
let isShowingLookupResults = false;
let isReadOnlyMode = false;
let isFormHidden = false;
let readOnlyShareUrl = '';
let currentBucketData = null;

// Format anonymous ID (show first 4 and last 4 characters)
function formatAnonymousId(anonymousId) {
    if (!anonymousId || anonymousId.length <= 8) {
        return anonymousId || 'Unknown';
    }
    const first4 = anonymousId.substring(0, 4);
    const last4 = anonymousId.substring(anonymousId.length - 4);
    return `${first4}...${last4}`;
}

// Format date for display
function formatDate(dateString) {
    if (!dateString) return 'Unknown';
    
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now - date);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    // If within last 7 days, show relative time
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    
    // Otherwise show formatted date
    return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric' 
    });
}

// ========== VISIBILITY UI ==========

// Update the visibility button to reflect the current visibility state
function updateVisibilityUI(visibility) {
    // Accept legacy boolean for backwards compat
    if (typeof visibility === 'boolean') visibility = visibility ? 'public' : 'private';
    currentBucketVisibility = visibility;
    currentBucketIsPublic   = visibility === 'public';

    if (bucketVisibilityBtn) {
        const span = bucketVisibilityBtn.querySelector('span');
        const svg  = bucketVisibilityBtn.querySelector('svg');

        if (visibility === 'public') {
            if (span) span.textContent = 'Public';
            if (svg) svg.innerHTML = '<path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5M12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5s5 2.24 5 5s-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3s3-1.34 3-3s-1.34-3-3-3"/>';
            bucketVisibilityBtn.className = 'h-10 w-auto px-3 rounded-md flex items-center justify-center gap-x-1 font-medium bg-green-50 text-green-700';
        } else if (visibility === 'unlisted') {
            if (span) span.textContent = 'Unlisted';
            if (svg) svg.innerHTML = '<path fill="currentColor" d="M13.5 6a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M5 12.5a8.5 8.5 0 1 1 17 0 8.5 8.5 0 0 1-17 0m8.5-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6m-5 3a5 5 0 1 1 10 0 5 5 0 0 1-10 0"/>';
            bucketVisibilityBtn.className = 'h-10 w-auto px-3 rounded-md flex items-center justify-center gap-x-1 font-medium bg-amber-50 text-amber-600';
        } else {
            if (span) span.textContent = 'Private';
            if (svg) svg.innerHTML = '<path fill="currentColor" d="M17 9V7A5 5 0 0 0 7 7v2a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-7a3 3 0 0 0-3-3M9 7a3 3 0 0 1 6 0v2H9Zm9 12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1Z"/>';
            bucketVisibilityBtn.className = 'h-10 w-auto px-3 rounded-md flex items-center justify-center gap-x-1 font-medium bg-gray-100 text-gray-600';
        }
    }

    // Share is always enabled; show a hint for non-public buckets
    if (bucketShareBtn) {
        bucketShareBtn.disabled = false;
        bucketShareBtn.style.opacity = '1';
        bucketShareBtn.title = visibility === 'public' ? '' : 'Share link (not visible in search or showroom)';
    }

    // Paywall is only available for public buckets
    const canMonetize = visibility === 'public';
    if (bucketPaywallBtnContainer) {
        if (!isFormHidden) {
            bucketPaywallBtnContainer.classList.remove('hidden');
            bucketPaywallBtnContainer.classList.add('flex');
        }

        if (canMonetize) {
            bucketPaywallBtnContainer.style.opacity = '1';
            bucketPaywallBtnContainer.style.pointerEvents = 'auto';
        } else {
            bucketPaywallBtnContainer.style.opacity = '0.4';
            bucketPaywallBtnContainer.style.pointerEvents = 'none';
            if (currentBucketIsPaywalled && currentBucketName && currentBucketName !== 'Singletons') {
                currentBucketIsPaywalled = false;
                updatePaywallUI(false, currentBucketPrice);
                setBucketPaywall(currentBucketName, false, currentBucketPrice).catch(() => {});
            }
        }
    }

    updateLinkMonetizationToggles();
}

// ========== PAYWALL UI ==========

function updatePaywallUI(isPaywalled, price) {
    currentBucketIsPaywalled = isPaywalled;
    currentBucketPrice = price ?? 0;

    if (bucketPriceInput) {
        bucketPriceInput.value = currentBucketPrice;
    }

    if (bucketPriceDollarHint) {
        if (isPaywalled && currentBucketPrice > 0) {
            bucketPriceDollarHint.textContent = priceInputMode === 'crd'
                ? `This bucket is valued at $${(currentBucketPrice / 100).toFixed(2)}`
                : `This bucket is valued at ${currentBucketPrice} EWL`;
            bucketPriceDollarHint.classList.remove('hidden');
        } else {
            bucketPriceDollarHint.textContent = '';
            bucketPriceDollarHint.classList.add('hidden');
        }
    }

    if (bucketFooterPrice && bucketFooterPriceText) {
        if (isPaywalled && price > 0) {
            bucketFooterPriceText.textContent = `${price} EWL`;
            if (bucketFooterPriceDollar) bucketFooterPriceDollar.textContent = `$${(price / 100).toFixed(2)}`;
        } else {
            bucketFooterPriceText.textContent = '0 EWL';
            if (bucketFooterPriceDollar) bucketFooterPriceDollar.textContent = '$0.00';
        }
    }
}

// ========== SEARCH ALGORITHM ==========

// Compute bigram (character pair) similarity between two strings (Dice coefficient)
function bigramSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1.length < 2 || str2.length < 2) {
        return str1 === str2 ? 1 : 0;
    }

    const getBigrams = (str) => {
        const bigrams = new Map();
        for (let i = 0; i < str.length - 1; i++) {
            const pair = str.substring(i, i + 2);
            bigrams.set(pair, (bigrams.get(pair) || 0) + 1);
        }
        return bigrams;
    };

    const bigrams1 = getBigrams(str1);
    const bigrams2 = getBigrams(str2);

    let intersection = 0;
    for (const [bigram, count] of bigrams1) {
        if (bigrams2.has(bigram)) {
            intersection += Math.min(count, bigrams2.get(bigram));
        }
    }

    const total = str1.length - 1 + str2.length - 1;
    return total === 0 ? 0 : (2 * intersection) / total;
}

// Score a single link against the search queries
function computeRelevanceScore(link, labelQuery, urlQuery) {
    let labelScore = 0;
    let urlScore = 0;
    const hasLabelQuery = labelQuery && labelQuery.length > 0;
    const hasUrlQuery = urlQuery && urlQuery.length > 0;

    const linkText = (link.text || '').toLowerCase();
    const linkHref = (link.href || '').toLowerCase();

    if (hasLabelQuery) {
        const q = labelQuery.toLowerCase();

        if (linkText === q) labelScore += 20;
        else if (linkText.startsWith(q)) labelScore += 15;
        else if (linkText.includes(q)) labelScore += 10;
        else {
            // Token-based: split query into words, check overlap
            const queryTokens = q.split(/\s+/).filter(Boolean);
            const matchCount = queryTokens.filter(qt => linkText.includes(qt)).length;
            if (matchCount > 0) {
                labelScore += (matchCount / queryTokens.length) * 7;
            }
        }

        // Fuzzy bonus via bigram similarity
        const sim = bigramSimilarity(q, linkText);
        if (sim > 0.2) labelScore += sim * 4;
    }

    if (hasUrlQuery) {
        const q = urlQuery.toLowerCase();

        if (linkHref === q) urlScore += 20;
        else if (linkHref.includes(q)) urlScore += 10;
        else {
            // Split URL into segments and match
            const queryParts = q.split(/[\/\.\?\&\=\-\_\:]+/).filter(Boolean);
            const hrefParts = linkHref.split(/[\/\.\?\&\=\-\_\:]+/).filter(Boolean);
            const matchCount = queryParts.filter(qp =>
                hrefParts.some(hp => hp.includes(qp))
            ).length;
            if (matchCount > 0) {
                urlScore += (matchCount / queryParts.length) * 7;
            }
        }

        const sim = bigramSimilarity(q, linkHref);
        if (sim > 0.2) urlScore += sim * 4;
    }

    // If both queries given, both must contribute (AND logic)
    if (hasLabelQuery && hasUrlQuery) {
        if (labelScore === 0 || urlScore === 0) return 0;
    }

    return labelScore + urlScore;
}

// Search links and return sorted by relevance
function searchLinks(links, labelQuery, urlQuery) {
    const scored = [];

    for (const link of links) {
        const score = computeRelevanceScore(link, labelQuery, urlQuery);
        if (score > 0) {
            scored.push({ link, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map(r => r.link);
}

// Escape HTML for safe insertion
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Highlight matching substring in text
function highlightMatch(text, query) {
    if (!query || !text) return escapeHtml(text || '');

    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase().trim();
    const index = lowerText.indexOf(lowerQuery);

    if (index === -1) return escapeHtml(text);

    const before = escapeHtml(text.substring(0, index));
    const match = escapeHtml(text.substring(index, index + lowerQuery.length));
    const after = escapeHtml(text.substring(index + lowerQuery.length));
    return `${before}<mark class="bg-yellow-200 rounded px-0.5">${match}</mark>${after}`;
}

// Fetch bucket metadata from server
async function fetchBucketMetadata(bucketName) {
    try {
        const response = await fetch(`/api/buckets/${encodeURIComponent(bucketName)}/metadata`, {
            credentials: 'include'
        });
        
        if (!response.ok) {
            console.error('Failed to fetch bucket metadata');
            return null;
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error fetching bucket metadata:', error);
        return null;
    }
}

// Reset form to add mode and clear any lookup state
function resetFormState() {
    currentLinkMode = 'add';
    isShowingLookupResults = false;

    if (switchIndicator) switchIndicator.style.left = '2px';
    if (addLinkModeBtn) { addLinkModeBtn.classList.add('text-orchid-700'); addLinkModeBtn.classList.remove('text-orchid-400'); }
    if (lookupModeBtn) { lookupModeBtn.classList.add('text-orchid-400'); lookupModeBtn.classList.remove('text-orchid-700'); }
    if (addLinkBtn) {
        addLinkBtn.querySelector('span').textContent = 'Add New Entry';
        addLinkBtn.disabled = true;
        addLinkBtn.setAttribute('aria-disabled', 'true');
    }
    if (addLinkLabel) {
        addLinkLabel.value = '';
        addLinkLabel.placeholder = 'label';
    }
    if (addLinkUrl) {
        addLinkUrl.value = '';
        addLinkUrl.placeholder = 'https://...';
        addLinkUrl.type = 'url';
    }
    if (clearAddLinkLabel) { clearAddLinkLabel.classList.add('hidden'); clearAddLinkLabel.classList.remove('flex'); }
    if (clearAddLinkUrl) { clearAddLinkUrl.classList.add('hidden'); clearAddLinkUrl.classList.remove('flex'); }
    if (lookupResultsBanner) {
        lookupResultsBanner.classList.add('hidden');
        lookupResultsBanner.classList.remove('flex');
    }
}

// Open popup with bucket links
export async function openBucketPopup(bucketName, options = {}) {
    if (!seeLinksWrapper || !bucketLinksPopup) return;

    // Reset form to clean state
    resetFormState();

    // Hide the add/lookup form if requested (e.g. from lookup results)
    if (options.hideForm) {
        isFormHidden = true;
        if (addLinkFormContainer) addLinkFormContainer.classList.add('hidden');
        // Show grab button, hide delete and visibility/paywall buttons
        if (bucketDeleteBtnContainer) bucketDeleteBtnContainer.classList.add('hidden');
        if (bucketVisibilityBtnContainer) bucketVisibilityBtnContainer.classList.add('hidden');
        if (bucketPaywallBtnContainer) { bucketPaywallBtnContainer.classList.add('hidden'); bucketPaywallBtnContainer.classList.remove('flex'); }
        if (bucketGrabBtnContainer) bucketGrabBtnContainer.classList.remove('hidden');
    }

    // Store full bucket data for grab feature
    if (options.bucketData) {
        currentBucketData = options.bucketData;
    }

    // Store current bucket name
    currentBucketName = bucketName;
    const isSingletons = bucketName === 'Singletons';

    // Always fetch fresh links from the server so changes made in other tabs
    // (e.g. via the bookmarklet) are reflected immediately without a page reload.
    await loadLinksFromStorage();

    // Get all links for this bucket
    const allLinks = getStoredLinks();
    const bucketLinks = allLinks.filter(link =>
        link.buckets && link.buckets.includes(bucketName)
    );
    
    currentBucketLinks = bucketLinks;
    
    // Update popup content
    if (popupBucketName) {
        popupBucketName.textContent = bucketName;
    }
    
    updateLinkCount(`${bucketLinks.length} link${bucketLinks.length !== 1 ? 's' : ''}`);
    
    // Default to private state while metadata loads
    if (!isSingletons) updateVisibilityUI(false);

    // Fetch and display metadata
    if (popupBucketMetadata) {
        popupBucketMetadata.innerHTML = '<div class="text-xs text-gray-600 flex items-center gap-2"><span id="popupLinkCount" class="font-medium text-gray-500"></span><span class="text-gray-400">•</span><span>Loading metadata...</span></div>';
        updateLinkCount(`${bucketLinks.length} link${bucketLinks.length !== 1 ? 's' : ''}`);

        const metadata = await fetchBucketMetadata(bucketName);

        if (metadata) {
            updateVisibilityUI(metadata.visibility || (metadata.isPublic ? 'public' : 'private'));
            updatePaywallUI(!!metadata.isPaywalled, metadata.price ?? 0);
            // Display username if available, otherwise fallback to formatted user ID
            const curatorDisplay = metadata.curator?.username
                ? metadata.curator.username
                : formatAnonymousId(metadata.curator?.userId);
            const createdFormatted = formatDate(metadata.createdAt);
            const modifiedFormatted = formatDate(metadata.updatedAt);

            const forkedFromHtml = metadata.originalCurator
                ? `<div class="flex items-center gap-2">
                        <span class="font-medium text-gray-700">Forked from:</span>
                        <span>${metadata.originalCurator.username}</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="font-medium text-gray-700">Original Bucket ID:</span>
                        <span class="font-mono text-gray-500">${metadata.originalBucketId}</span>
                        <button onclick="navigator.clipboard.writeText('${metadata.originalBucketId}').then(() => { this.textContent = 'Copied!'; setTimeout(() => this.textContent = 'Copy', 1500); })" class="text-blue-500 hover:text-blue-700 cursor-pointer text-xs">Copy</button>
                    </div>`
                : '';

            const statsItems = [
                metadata.viewCount > 0 ? `<span>${metadata.viewCount} view${metadata.viewCount !== 1 ? 's' : ''}</span>` : '',
                metadata.shareCount > 0 ? `<span>${metadata.shareCount} share${metadata.shareCount !== 1 ? 's' : ''}</span>` : '',
                metadata.grabCount > 0 ? `<span>${metadata.grabCount} grab${metadata.grabCount !== 1 ? 's' : ''}</span>` : ''
            ].filter(Boolean);

            const statsHtml = `<div class="flex items-center gap-2 flex-wrap">
                    <span id="popupLinkCount" class="font-medium text-gray-500"></span>
                    ${statsItems.length > 0 ? '<span class="text-gray-400">•</span>' + statsItems.join('<span class="text-gray-400">•</span>') : ''}
                </div>`;

            popupBucketMetadata.innerHTML = `
                <div class="flex flex-col gap-1 text-xs text-gray-600">
                    <div class="flex items-center gap-2">
                        <span class="font-medium text-gray-700">Curator:</span>
                        <span>${curatorDisplay}</span>
                    </div>
                    ${forkedFromHtml}
                    <div class="flex items-center gap-2 flex-wrap">
                        <div class="flex items-center gap-1">
                            <span class="font-medium text-gray-700">Created:</span>
                            <span>${createdFormatted}</span>
                        </div>
                        <span class="text-gray-400">•</span>
                        <div class="flex items-center gap-1">
                            <span class="font-medium text-gray-700">Last Modified:</span>
                            <span>${modifiedFormatted}</span>
                        </div>
                    </div>
                    ${statsHtml}
                </div>
            `;
            updateLinkCount(`${currentBucketLinks.length} link${currentBucketLinks.length !== 1 ? 's' : ''}`);
        } else {
            popupBucketMetadata.innerHTML = '<span id="popupLinkCount" class="text-xs font-medium text-gray-500"></span>';
            updateLinkCount(`${currentBucketLinks.length} link${currentBucketLinks.length !== 1 ? 's' : ''}`);
        }
    }
    
    // Hide visibility/paywall buttons and disable delete for the default Singletons bucket
    if (bucketVisibilityBtnContainer) {
        bucketVisibilityBtnContainer.classList.toggle('hidden', isSingletons);
    }
    if (bucketPaywallBtnContainer && isSingletons) {
        bucketPaywallBtnContainer.classList.add('hidden');
        bucketPaywallBtnContainer.classList.remove('flex');
    }
    if (bucketDeleteBtn) {
        bucketDeleteBtn.disabled = isSingletons;
        bucketDeleteBtn.style.opacity = isSingletons ? '0.5' : '1';
    }

    // Render links
    renderPopupLinks(bucketLinks);

    // Show popup with animation
    seeLinksWrapper.classList.remove('hidden');
    
    // Prevent body scroll when popup is open
    document.body.style.overflow = 'hidden';
    
    // Add small delay for animation
    setTimeout(() => {
        if (bucketLinksPopup) {
            bucketLinksPopup.style.transform = 'scale(1)';
            bucketLinksPopup.style.opacity = '1';
        }
    }, 10);
}

// Open popup in read-only mode with pre-fetched bucket data
export function openBucketPopupReadOnly(data) {
    if (!seeLinksWrapper || !bucketLinksPopup) return;

    resetFormState();

    isReadOnlyMode = true;
    readOnlyShareUrl = `${window.location.origin}/v2/bucket/${data._id}`;
    currentBucketName = data.name;
    currentBucketLinks = data.links || [];
    currentBucketData = data;

    // Populate header
    if (popupBucketName) popupBucketName.textContent = data.name;
    const totalCount = data.totalLinkCount ?? currentBucketLinks.length;
    const hiddenCount = data.hiddenCount || 0;
    const countLabel = hiddenCount > 0
        ? `${currentBucketLinks.length} of ${totalCount} link${totalCount !== 1 ? 's' : ''}`
        : `${totalCount} link${totalCount !== 1 ? 's' : ''}`;
    updateLinkCount(countLabel);

    // Populate metadata directly (no fetch needed)
    if (popupBucketMetadata) {
        const curatorDisplay = data.curator?.username || formatAnonymousId(data.curator?.userId);
        const forkedFromHtml = data.originalCurator
            ? `<div class="flex items-center gap-2">
                    <span class="font-medium text-gray-700">Forked from:</span>
                    <span>${data.originalCurator.username}</span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="font-medium text-gray-700">Original Bucket ID:</span>
                    <span class="font-mono text-gray-500">${data.originalBucketId}</span>
                    <button onclick="navigator.clipboard.writeText('${data.originalBucketId}').then(() => { this.textContent = 'Copied!'; setTimeout(() => this.textContent = 'Copy', 1500); })" class="text-blue-500 hover:text-blue-700 cursor-pointer text-xs">Copy</button>
                </div>`
            : '';

        const statsItems = [
            data.viewCount > 0 ? `<span>${data.viewCount} view${data.viewCount !== 1 ? 's' : ''}</span>` : '',
            data.shareCount > 0 ? `<span>${data.shareCount} share${data.shareCount !== 1 ? 's' : ''}</span>` : '',
            data.grabCount > 0 ? `<span>${data.grabCount} grab${data.grabCount !== 1 ? 's' : ''}</span>` : ''
        ].filter(Boolean);

        const statsHtml = statsItems.length > 0
            ? `<div class="flex items-center gap-2 flex-wrap">
                    ${statsItems.join('<span class="text-gray-400">•</span>')}
                </div>`
            : '';

        popupBucketMetadata.innerHTML = `
            <div class="flex flex-col gap-1 text-xs text-gray-600">
                <div class="flex items-center gap-2">
                    <span class="font-medium text-gray-700">Curator:</span>
                    <span>${curatorDisplay}</span>
                </div>
                ${forkedFromHtml}
                <div class="flex items-center gap-2 flex-wrap">
                    <div class="flex items-center gap-1">
                        <span class="font-medium text-gray-700">Created:</span>
                        <span>${formatDate(data.createdAt)}</span>
                    </div>
                    <span class="text-gray-400">•</span>
                    <div class="flex items-center gap-1">
                        <span class="font-medium text-gray-700">Last Modified:</span>
                        <span>${formatDate(data.updatedAt)}</span>
                    </div>
                </div>
                ${statsHtml}
            </div>
        `;
    }

    // Hide add-link form, delete button, visibility/paywall buttons; show report button (not our bucket)
    if (addLinkFormContainer) addLinkFormContainer.classList.add('hidden');
    if (bucketDeleteBtnContainer) bucketDeleteBtnContainer.classList.add('hidden');
    if (bucketVisibilityBtnContainer) bucketVisibilityBtnContainer.classList.add('hidden');
    if (bucketPaywallBtnContainer) { bucketPaywallBtnContainer.classList.add('hidden'); bucketPaywallBtnContainer.classList.remove('flex'); }
    if (bucketReportBtnContainer) bucketReportBtnContainer.classList.remove('hidden');

    // Show grab button only when all links are accessible (free bucket or already unlocked)
    if (bucketGrabBtnContainer) {
        if ((data.hiddenCount || 0) > 0) {
            bucketGrabBtnContainer.classList.add('hidden');
        } else {
            bucketGrabBtnContainer.classList.remove('hidden');
        }
    }

    // Share button stays visible
    if (bucketShareBtn) {
        bucketShareBtn.disabled = false;
        bucketShareBtn.style.opacity = '1';
    }

    // Render links (copy-only, no delete buttons)
    renderPopupLinksReadOnly(currentBucketLinks, {
        isPaywalled: data.isPaywalled || false,
        hasAccess: data.hasAccess !== false,
        hiddenCount: data.hiddenCount || 0,
        price: data.price || 0,
        bucketId: data._id
    });

    // Show popup with animation
    seeLinksWrapper.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
        if (bucketLinksPopup) {
            bucketLinksPopup.style.transform = 'scale(1)';
            bucketLinksPopup.style.opacity = '1';
        }
    }, 10);
}

// Re-fetch a bucket by ID after unlocking and refresh the read-only popup
async function refreshPopupAfterUnlock(bucketId) {
    const res = await fetch(`/api/buckets/lookup?q=${encodeURIComponent(bucketId)}`, { credentials: 'include' });
    const json = await res.json();
    if (!res.ok || !json.buckets?.length) throw new Error('Could not reload bucket');
    openBucketPopupReadOnly(json.buckets[0]);
}

// Render links without delete buttons (read-only mode)
function renderPopupLinksReadOnly(links, paywallInfo = {}) {
    if (!popupLinksList) return;
    popupLinksList.innerHTML = '';

    if (links.length === 0 && !paywallInfo.hiddenCount) {
        popupLinksList.innerHTML = `
            <li class="py-8 text-center text-gray-500">No links in this bucket</li>
        `;
        return;
    }

    links.forEach((link, index) => {
        const li = document.createElement('li');
        li.className = 'py-3 hover:bg-gray-50 transition-colors';

        li.innerHTML = `
            <div class="flex items-start gap-3">
                <span class="shrink-0 w-6 h-6 flex items-center justify-center bg-orchid-100 text-orchid-700 rounded-full text-xs font-medium">
                    ${index + 1}
                </span>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-medium text-gray-900 text-sm">${escapeHtml(link.text || 'Untitled Link')}</span>
                        ${link.duration ? `<span class="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">${link.duration}</span>` : ''}
                    </div>
                    <a href="${link.href}" target="_blank" class="text-blue-600 hover:text-blue-800 text-xs break-all block transition-colors">
                        ${escapeHtml(link.href)}
                    </a>
                </div>
                <div class="shrink-0">
                    <button class="popupCopyLinkBtn h-8 w-8 flex items-center justify-center hover:bg-gray-200 rounded transition-colors" data-href="${link.href}" title="Copy link">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                            <path fill="currentColor" d="M9.116 17q-.691 0-1.153-.462T7.5 15.385V4.615q0-.69.463-1.153T9.116 3h7.769q.69 0 1.153.462t.462 1.153v10.77q0 .69-.462 1.152T16.884 17zm0-1h7.769q.23 0 .423-.192t.192-.423V4.615q0-.23-.192-.423T16.884 4H9.116q-.231 0-.424.192t-.192.423v10.77q0 .23.192.423t.423.192m-3 4q-.69 0-1.153-.462T4.5 18.385V6.615h1v11.77q0 .23.192.423t.423.192h8.77v1zM8.5 16V4z"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;
        popupLinksList.appendChild(li);
    });

    // Setup copy buttons (reuse existing logic)
    setupPopupCopyButtons();

    // Paywall notice — shown when some links are hidden
    if (paywallInfo.hiddenCount > 0) {
        const priceCredits = paywallInfo.price || 0;
        const priceDollars = (priceCredits / 100).toFixed(2);
        const priceDisplay = priceCredits ? `${priceCredits} credits ($${priceDollars})` : 'credits';

        const notice = document.createElement('li');
        notice.className = 'py-4 px-3 border-t border-gray-200 text-center';
        notice.innerHTML = `
            <div class="flex flex-col items-center gap-2">
                <span class="text-gray-600 text-sm font-medium">
                    🔒 ${paywallInfo.hiddenCount} link${paywallInfo.hiddenCount !== 1 ? 's' : ''} hidden behind paywall
                </span>
                <button id="popupUnlockBtn" class="px-4 py-1.5 bg-orchid-600 text-white text-xs rounded hover:bg-orchid-700 transition-colors" data-bucket-id="${paywallInfo.bucketId}" data-price-display="${escapeHtml(priceDisplay)}">
                    Unlock for ${priceDisplay}
                </button>
            </div>
        `;
        popupLinksList.appendChild(notice);

        const unlockBtn = document.getElementById('popupUnlockBtn');
        if (unlockBtn) {
            unlockBtn.addEventListener('click', async () => {
                const bucketId = unlockBtn.dataset.bucketId;
                const displayLabel = unlockBtn.dataset.priceDisplay;
                unlockBtn.disabled = true;
                unlockBtn.textContent = 'Unlocking…';
                try {
                    const res = await fetch(`/api/credits/unlock/${bucketId}`, { method: 'POST', credentials: 'include' });
                    const json = await res.json();
                    if (!res.ok) throw new Error(json.error || 'Failed to unlock');
                    await refreshPopupAfterUnlock(bucketId);
                    window.dispatchEvent(new CustomEvent('credits:changed'));
                } catch (err) {
                    unlockBtn.disabled = false;
                    unlockBtn.textContent = `Unlock for ${displayLabel}`;
                    showNotification(err.message, 'error');
                }
            });
        }
    }
}

// Close popup
export function closeBucketPopup() {
    if (!seeLinksWrapper || !bucketLinksPopup) return;

    // Animate out
    bucketLinksPopup.style.transform = 'scale(0.95)';
    bucketLinksPopup.style.opacity = '0';

    setTimeout(() => {
        seeLinksWrapper.classList.add('hidden');

        // Reset multi-select
        isMultiSelectMode = false;
        selectedHrefs.clear();
        bulkMonetizeMode = 'free';
        if (bulkSelectRow) { bulkSelectRow.classList.add('hidden'); bulkSelectRow.classList.remove('flex'); }

        currentBucketLinks = [];
        currentBucketName = '';
        currentBucketData = null;
        currentBucketIsPaywalled = false;
        currentBucketPrice = 0;
        priceInputMode = 'crd';
        if (bucketPriceCurrencyToggle) bucketPriceCurrencyToggle.textContent = 'EWL';
        if (bucketPriceInput) { bucketPriceInput.step = '1'; bucketPriceInput.placeholder = '0'; }

        // Restore read-only hidden elements
        if (isReadOnlyMode) {
            if (addLinkFormContainer) addLinkFormContainer.classList.remove('hidden');
            if (bucketDeleteBtnContainer) bucketDeleteBtnContainer.classList.remove('hidden');
            if (bucketVisibilityBtnContainer) bucketVisibilityBtnContainer.classList.remove('hidden');
            if (bucketPaywallBtnContainer) { bucketPaywallBtnContainer.classList.add('hidden'); bucketPaywallBtnContainer.classList.remove('flex'); }
            if (bucketGrabBtnContainer) bucketGrabBtnContainer.classList.add('hidden');
            if (bucketReportBtnContainer) bucketReportBtnContainer.classList.add('hidden');
            isReadOnlyMode = false;
            readOnlyShareUrl = '';
        }

        // Restore form if it was hidden via options
        if (isFormHidden) {
            if (addLinkFormContainer) addLinkFormContainer.classList.remove('hidden');
            if (bucketDeleteBtnContainer) bucketDeleteBtnContainer.classList.remove('hidden');
            if (bucketVisibilityBtnContainer) bucketVisibilityBtnContainer.classList.remove('hidden');
            if (bucketPaywallBtnContainer) { bucketPaywallBtnContainer.classList.add('hidden'); bucketPaywallBtnContainer.classList.remove('flex'); }
            if (bucketGrabBtnContainer) bucketGrabBtnContainer.classList.add('hidden');
            if (bucketReportBtnContainer) bucketReportBtnContainer.classList.add('hidden');
            isFormHidden = false;
        }

        currentBucketIsPublic = false;
        currentBucketVisibility = 'private';

        // Restore body scroll
        document.body.style.overflow = '';
    }, 200);
}

// Render links in popup (with optional highlight queries for lookup mode)
function renderPopupLinks(links, highlightLabel = '', highlightUrl = '') {
    if (!popupLinksList) return;

    popupLinksList.innerHTML = '';

    if (links.length === 0) {
        const emptyMsg = isShowingLookupResults
            ? 'No matching links found'
            : 'No links in this bucket';
        popupLinksList.innerHTML = `
            <li class="py-8 text-center text-gray-500">
                ${emptyMsg}
            </li>
        `;
        return;
    }

    links.forEach((link, index) => {
        const li = document.createElement('li');
        li.className = 'py-3 hover:bg-gray-50 transition-colors';
        li.style.transition = 'opacity 0.2s ease, transform 0.2s ease';

        const displayText = highlightLabel
            ? highlightMatch(link.text || 'Untitled Link', highlightLabel)
            : escapeHtml(link.text || 'Untitled Link');
        const displayHref = highlightUrl
            ? highlightMatch(link.href, highlightUrl)
            : escapeHtml(link.href);

        const monetizeBtnClass = currentBucketVisibility !== 'public'
            ? 'text-gray-300 cursor-not-allowed'
            : link.isFree
                ? 'bg-white border border-gray-200 text-gray-500 hover:bg-gray-50'
                : 'bg-orchid-600 text-white hover:bg-orchid-700';
        const monetizeBtnTitle = currentBucketVisibility !== 'public'
            ? 'Make bucket public to monetize'
            : link.isFree
                ? 'Free access — click to put under paywall'
                : 'Under paywall — click to make free';

        const isChecked = selectedHrefs.has(link.href);
        const checkboxSvg = isChecked
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="m10.6 16.6l7.05-7.05l-1.4-1.4l-5.65 5.65l-2.85-2.85l-1.4 1.4zM5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21z"/></svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21zm0-2h14V5H5z"/></svg>`;
        const leadingEl = isMultiSelectMode
            ? `<button class="linkSelectCheckbox shrink-0 w-6 h-6 flex items-center justify-center cursor-pointer transition-colors ${isChecked ? 'text-orchid-600' : 'text-gray-400'}" data-href="${link.href}" data-checked="${isChecked}">${checkboxSvg}</button>`
            : `<span class="linkIndexBadge shrink-0 w-6 h-6 flex items-center justify-center bg-orchid-100 text-orchid-700 rounded-full text-xs font-medium cursor-pointer select-none" data-href="${link.href}">${index + 1}</span>`;

        const actionsEl = isMultiSelectMode ? '' : `
                <div class="shrink-0 flex gap-1">
                    <button class="popupCopyLinkBtn h-8 w-8 flex items-center justify-center hover:bg-gray-200 rounded transition-colors" data-href="${link.href}" title="Copy link">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                            <path fill="currentColor" d="M9.116 17q-.691 0-1.153-.462T7.5 15.385V4.615q0-.69.463-1.153T9.116 3h7.769q.69 0 1.153.462t.462 1.153v10.77q0 .69-.462 1.152T16.884 17zm0-1h7.769q.23 0 .423-.192t.192-.423V4.615q0-.23-.192-.423T16.884 4H9.116q-.231 0-.424.192t-.192.423v10.77q0 .23.192.423t.423.192m-3 4q-.69 0-1.153-.462T4.5 18.385V6.615h1v11.77q0 .23.192.423t.423.192h8.77v1zM8.5 16V4z"/>
                        </svg>
                    </button>
                    <button class="popupMonetizeToggleBtn h-8 w-8 flex items-center justify-center rounded transition-colors ${monetizeBtnClass}" data-href="${link.href}" title="${monetizeBtnTitle}" ${currentBucketVisibility !== 'public' ? 'disabled' : ''}>
                        <span class="text-sm font-semibold">$</span>
                    </button>
                    <button class="popupDeleteLinkBtn h-8 w-8 flex items-center justify-center hover:bg-red-100 hover:text-red-600 rounded transition-colors" data-href="${link.href}" title="Delete link">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                            <path fill="currentColor" d="M7.616 20q-.667 0-1.141-.475T6 18.386V6h-.5q-.213 0-.356-.144T5 5.499t.144-.356T5.5 5H9q0-.31.23-.54t.54-.23h4.46q.31 0 .54.23T15 5h3.5q.213 0 .356.144t.144.357t-.144.356T18.5 6H18v12.385q0 .666-.475 1.14t-1.14.475zM17 6H7v12.385q0 .269.173.442t.443.173h8.769q.269 0 .442-.173t.173-.442zm-6.692 11q.213 0 .357-.144t.143-.356v-8q0-.213-.144-.356T10.307 8t-.356.144t-.143.356v8q0 .213.144.356q.144.144.356.144m3.385 0q.213 0 .356-.144t.143-.356v-8q0-.213-.144-.356Q13.904 8 13.692 8q-.213 0-.357.144t-.143.356v8q0 .213.144.356t.357.144M7 6v13z"/>
                        </svg>
                    </button>
                </div>`;

        li.innerHTML = `
            <div class="flex items-start gap-3">
                ${leadingEl}
                ${link.image ? `<img src="${link.image}" alt="" class="w-14 h-10 object-cover rounded shrink-0 mt-0.5 bg-gray-100" onerror="this.style.display='none'">` : ''}
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-medium text-gray-900 text-sm">${displayText}</span>
                        ${link.duration ? `<span class="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">${link.duration}</span>` : ''}
                    </div>
                    <a href="${link.href}" target="_blank" class="text-blue-600 hover:text-blue-800 text-xs break-all block transition-colors">
                        ${displayHref}
                    </a>
                </div>
                ${actionsEl}
            </div>
        `;

        popupLinksList.appendChild(li);
    });

    if (isMultiSelectMode) {
        setupCheckboxListeners();
    } else {
        // Setup individual copy buttons
        setupPopupCopyButtons();

        // Setup individual delete buttons
        setupPopupDeleteButtons();

        // Setup monetization toggle buttons
        setupPopupMonetizeButtons();

        // Long-press on index badge activates multi-select for that link
        setupLongPressListeners();
    }
}

function updateBulkUI() {
    if (!bulkActions || !bulkMonetizeBtnLabel) return;
    const count = selectedHrefs.size;
    bulkActions.classList.remove('hidden');
    bulkActions.classList.add('flex');
    bulkMonetizeBtnLabel.textContent = bulkMonetizeMode === 'free' ? 'Make Free' : 'Make Paywalled';
    const hasSelection = count > 0;
    [bulkMonetizeBtn, bulkCopyBtn, bulkDeleteBtn].forEach(btn => {
        if (btn) btn.disabled = !hasSelection;
    });
    if (selectAllBtn) {
        const allSelected = count > 0 && count === currentBucketLinks.length;
        selectAllBtn.innerHTML = allSelected
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="m10.6 16.6l7.05-7.05l-1.4-1.4l-5.65 5.65l-2.85-2.85l-1.4 1.4zM5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21z"/></svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21zm0-2h14V5H5z"/></svg>`;
        selectAllBtn.classList.toggle('text-orchid-600', allSelected);
        selectAllBtn.classList.toggle('text-gray-400', !allSelected);
    }
}

const checkedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="m10.6 16.6l7.05-7.05l-1.4-1.4l-5.65 5.65l-2.85-2.85l-1.4 1.4zM5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21z"/></svg>`;
const uncheckedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21zm0-2h14V5H5z"/></svg>`;

function setCheckboxState(btn, checked) {
    btn.dataset.checked = checked;
    btn.innerHTML = checked ? checkedSvg : uncheckedSvg;
    btn.classList.toggle('text-orchid-600', checked);
    btn.classList.toggle('text-gray-400', !checked);
}

function setupCheckboxListeners() {
    popupLinksList.querySelectorAll('.linkSelectCheckbox').forEach(btn => {
        btn.addEventListener('click', () => {
            const href = btn.dataset.href;
            const nowChecked = btn.dataset.checked !== 'true';
            if (nowChecked) selectedHrefs.add(href);
            else selectedHrefs.delete(href);
            setCheckboxState(btn, nowChecked);
            updateBulkUI();
        });
    });
}

function activateMultiSelect(triggeredHref) {
    isMultiSelectMode = true;
    selectedHrefs.clear();
    bulkMonetizeMode = 'free';
    if (triggeredHref) selectedHrefs.add(triggeredHref);
    if (bulkSelectRow) {
        bulkSelectRow.classList.remove('hidden');
        bulkSelectRow.classList.add('flex');
    }
    renderPopupLinks(currentBucketLinks);
    updateBulkUI();
}

function deactivateMultiSelect() {
    isMultiSelectMode = false;
    selectedHrefs.clear();
    bulkMonetizeMode = 'free';
    if (bulkSelectRow) {
        bulkSelectRow.classList.add('hidden');
        bulkSelectRow.classList.remove('flex');
    }
    renderPopupLinks(currentBucketLinks);
}

function setupLongPressListeners() {
    const LONG_PRESS_MS = 500;
    popupLinksList.querySelectorAll('.linkIndexBadge').forEach(badge => {
        let timer = null;

        const start = () => {
            timer = setTimeout(() => {
                timer = null;
                activateMultiSelect(badge.dataset.href);
            }, LONG_PRESS_MS);
        };

        const cancel = () => {
            if (timer) { clearTimeout(timer); timer = null; }
        };

        badge.addEventListener('mousedown', start);
        badge.addEventListener('touchstart', start, { passive: true });
        badge.addEventListener('mouseup', cancel);
        badge.addEventListener('mouseleave', cancel);
        badge.addEventListener('touchend', cancel);
        badge.addEventListener('touchcancel', cancel);
        // Prevent context menu on long-press on mobile
        badge.addEventListener('contextmenu', e => e.preventDefault());
    });
}

// Setup copy buttons for individual links
function setupPopupCopyButtons() {
    const copyButtons = popupLinksList.querySelectorAll('.popupCopyLinkBtn');
    
    copyButtons.forEach(button => {
        button.addEventListener('click', async (e) => {
            e.stopPropagation();
            const href = button.dataset.href;
            
            if (!href) return;
            
            const success = await copyToClipboard(href);
            
            if (success) {
                // Visual feedback
                const originalHTML = button.innerHTML;
                button.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                        <path fill="currentColor" d="m9.55 17.308l-4.97-4.97l.714-.713l4.256 4.256l9.156-9.156l.713.714z"/>
                    </svg>
                `;
                button.classList.add('text-green-600');
                
                setTimeout(() => {
                    button.innerHTML = originalHTML;
                    button.classList.remove('text-green-600');
                }, 1500);
                
                showNotification('Link copied!', 'success', 2000);
            } else {
                showNotification('Failed to copy link', 'error');
            }
        });
    });
}

// Setup delete buttons for individual links
function setupPopupDeleteButtons() {
    const deleteButtons = popupLinksList.querySelectorAll('.popupDeleteLinkBtn');
    
    deleteButtons.forEach(button => {
        button.addEventListener('click', async (e) => {
            e.stopPropagation();
            const href = button.dataset.href;
            
            if (!href) return;
            
            // Use stored bucket name instead of reading from DOM
            if (!currentBucketName) {
                showNotification('Could not identify bucket', 'error');
                return;
            }
            
            // Confirm deletion
            const linkText = button.closest('.flex').querySelector('.font-medium')?.textContent || 'this link';
            const confirmed = confirm(`Delete "${linkText}" from ${currentBucketName}?`);
            
            if (!confirmed) return;
            
            try {
                // Show loading state
                button.disabled = true;
                button.style.opacity = '0.5';
                
                // Delete from server
                await deleteLinkFromBucket(currentBucketName, href);
                
                // Remove from current list
                const linkElement = button.closest('li');
                if (linkElement) {
                    linkElement.style.opacity = '0';
                    linkElement.style.transform = 'translateX(20px)';
                    
                    setTimeout(() => {
                        linkElement.remove();
                        
                        // Update current bucket links
                        currentBucketLinks = currentBucketLinks.filter(link => link.href !== href);
                        
                        // Update count
                        updateLinkCount(`${currentBucketLinks.length} link${currentBucketLinks.length !== 1 ? 's' : ''}`);
                        
                        // If no links left, show empty message
                        if (currentBucketLinks.length === 0) {
                            popupLinksList.innerHTML = `
                                <li class="py-8 text-center text-gray-500">
                                    No links in this bucket
                                </li>
                            `;
                        }
                    }, 200);
                }
                
                showNotification('Link deleted successfully!', 'success', 2000);
            } catch (error) {
                showNotification(`Failed to delete: ${error.message}`, 'error');
                button.disabled = false;
                button.style.opacity = '1';
            }
        });
    });
}

// Setup monetization toggle buttons for individual links
function setupPopupMonetizeButtons() {
    const monetizeButtons = popupLinksList.querySelectorAll('.popupMonetizeToggleBtn');

    monetizeButtons.forEach(button => {
        button.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (currentBucketVisibility !== 'public') return;

            const href = button.dataset.href;
            const link = currentBucketLinks.find(l => l.href === href);
            if (!link) return;

            const newIsFree = !link.isFree;

            // Optimistic update
            link.isFree = newIsFree;
            applyMonetizeBtnState(button, newIsFree);

            try {
                await setLinkFree(currentBucketName, href, newIsFree);
            } catch (error) {
                // Revert on failure
                link.isFree = !newIsFree;
                applyMonetizeBtnState(button, !newIsFree);
                showNotification('Failed to update link access', 'error');
            }
        });
    });
}

function applyMonetizeBtnState(btn, isFree) {
    if (isFree) {
        btn.className = 'popupMonetizeToggleBtn h-8 w-8 flex items-center justify-center rounded transition-colors bg-white border border-gray-200 text-gray-500 hover:bg-gray-50';
        btn.title = 'Free access — click to put under paywall';
    } else {
        btn.className = 'popupMonetizeToggleBtn h-8 w-8 flex items-center justify-center rounded transition-colors bg-orchid-600 text-white hover:bg-orchid-700';
        btn.title = 'Under paywall — click to make free';
    }
}

// Update all per-link monetization toggle buttons when bucket visibility changes
function updateLinkMonetizationToggles() {
    const toggles = popupLinksList?.querySelectorAll('.popupMonetizeToggleBtn');
    if (!toggles) return;

    toggles.forEach(btn => {
        btn.disabled = currentBucketVisibility !== 'public';
        if (currentBucketVisibility !== 'public') {
            btn.className = 'popupMonetizeToggleBtn h-8 w-8 flex items-center justify-center rounded transition-colors text-gray-300 cursor-not-allowed';
            btn.title = 'Make bucket public to monetize';
        } else {
            const link = currentBucketLinks.find(l => l.href === btn.dataset.href);
            applyMonetizeBtnState(btn, link?.isFree ?? false);
        }
    });
}

// Initialize popup handlers
export function initBucketPopup() {
    if (!seeLinksWrapper || !bucketLinksPopup) return;
    
    // Set initial animation state
    bucketLinksPopup.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
    bucketLinksPopup.style.transform = 'scale(0.95)';
    bucketLinksPopup.style.opacity = '0';
    
    // Close button handler
    if (closePopupBtn) {
        closePopupBtn.addEventListener('click', closeBucketPopup);
    }
    
    // Click outside to close (track mousedown to prevent text selection from closing)
    let mouseDownTarget = null;
    seeLinksWrapper.addEventListener('mousedown', (e) => {
        mouseDownTarget = e.target;
    });
    seeLinksWrapper.addEventListener('click', (e) => {
        if (e.target === seeLinksWrapper && mouseDownTarget === seeLinksWrapper) {
            closeBucketPopup();
        }
    });
    
    // Prevent clicks inside popup from closing it
    if (bucketLinksPopup) {
        bucketLinksPopup.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }
    
    // Copy all links button
    if (bucketCopyAllBtn) {
        bucketCopyAllBtn.addEventListener('click', async () => {
            if (currentBucketLinks.length === 0) {
                showNotification('No links to copy', 'warning');
                return;
            }
            
            const urls = currentBucketLinks.map(link => link.href).join('\n');
            const success = await copyToClipboard(urls);
            
            if (success) {
                showNotification(`Copied ${currentBucketLinks.length} link${currentBucketLinks.length !== 1 ? 's' : ''}!`, 'success', 3000);
                
                // Visual feedback on button
                const originalText = bucketCopyAllBtn.querySelector('span')?.textContent || bucketCopyAllBtn.textContent;
                const buttonSpan = bucketCopyAllBtn.querySelector('span');
                if (buttonSpan) {
                    buttonSpan.textContent = '✓ Copied!';
                }
                bucketCopyAllBtn.classList.add('bg-green-100', 'text-green-700');
                bucketCopyAllBtn.classList.remove('bg-orchid-50', 'text-orchid-600');
                
                setTimeout(() => {
                    if (buttonSpan) {
                        buttonSpan.textContent = originalText;
                    }
                    bucketCopyAllBtn.classList.remove('bg-green-100', 'text-green-700');
                    bucketCopyAllBtn.classList.add('bg-orchid-50', 'text-orchid-600');
                }, 2000);
            } else {
                showNotification('Failed to copy links', 'error');
            }
        });
    }
    
    // Share bucket button
    if (bucketShareBtn) {
        bucketShareBtn.addEventListener('click', async () => {
            if (!currentBucketName) {
                showNotification('Could not identify bucket to share', 'error');
                return;
            }
            
            try {
                // Show loading state
                bucketShareBtn.disabled = true;
                bucketShareBtn.style.opacity = '0.5';

                // In read-only mode we already know the share URL
                let shareUrl;
                if (isReadOnlyMode && readOnlyShareUrl) {
                    shareUrl = readOnlyShareUrl;
                } else {
                    const bucketId = await getBucketShareId(currentBucketName);
                    shareUrl = `${window.location.origin}/v2/bucket/${bucketId}`;
                }
                
                // Build share text + URL
                const u = window.__GRABBN_USER__;
                const shareText = (u && !u.isAnonymous && u.username)
                    ? `@${u.username} is sharing a link collection with you from Grabbn. Have a look at it!`
                    : 'Check out this link collection on Grabbn!';
                const sharePayload = shareText + '\n' + shareUrl;

                // Copy to clipboard
                const success = await copyToClipboard(sharePayload);

                if (success) {
                    showNotification(`Share link copied! Send it to your friends.`, 'success', 3000);

                    // Track share (fire-and-forget)
                    const bucketIdMatch = shareUrl.match(/\/v2\/([a-f0-9]{24})/i);
                    if (bucketIdMatch) {
                        fetch(`/api/buckets/${bucketIdMatch[1]}/share`, {
                            method: 'POST',
                            credentials: 'include'
                        }).catch(() => {});
                    }

                    // Visual feedback
                    const originalText = bucketShareBtn.querySelector('span')?.textContent || bucketShareBtn.textContent;
                    const buttonSpan = bucketShareBtn.querySelector('span');
                    if (buttonSpan) {
                        buttonSpan.textContent = '✓ Link Copied!';
                    }
                    bucketShareBtn.classList.add('bg-green-100', 'text-green-700');
                    bucketShareBtn.classList.remove('bg-orchid-50', 'text-orchid-600');
                    
                    setTimeout(() => {
                        if (buttonSpan) {
                            buttonSpan.textContent = originalText;
                        }
                        bucketShareBtn.classList.remove('bg-green-100', 'text-green-700');
                        bucketShareBtn.classList.add('bg-orchid-50', 'text-orchid-600');
                    }, 2000);
                } else {
                    showNotification('Failed to copy share link', 'error');
                }
            } catch (error) {
                showNotification(`Error creating share link: ${error.message}`, 'error');
            } finally {
                bucketShareBtn.disabled = false;
                bucketShareBtn.style.opacity = '1';
            }
        });
    }
    
    // Visibility toggle button
    if (bucketVisibilityBtn) {
        bucketVisibilityBtn.addEventListener('click', async () => {
            if (!currentBucketName || currentBucketName === 'Singletons') return;

            const cycle = { public: 'unlisted', unlisted: 'private', private: 'public' };
            const newVis = cycle[currentBucketVisibility] || 'public';
            const labels = { public: 'Bucket is now public.', unlisted: 'Bucket is unlisted — share the link to grant access.', private: 'Bucket set to private.' };

            try {
                bucketVisibilityBtn.disabled = true;
                bucketVisibilityBtn.style.opacity = '0.5';

                await toggleBucketVisibility(currentBucketName, newVis);
                updateVisibilityUI(newVis);

                showNotification(labels[newVis], 'success', 3000);
            } catch (error) {
                showNotification(`Failed to update visibility: ${error.message}`, 'error');
            } finally {
                bucketVisibilityBtn.disabled = false;
                bucketVisibilityBtn.style.opacity = '1';
            }
        });
    }

    // Currency toggle — switch between EWL and USD input modes
    if (bucketPriceCurrencyToggle) {
        bucketPriceCurrencyToggle.addEventListener('click', () => {
            priceInputMode = priceInputMode === 'crd' ? 'usd' : 'crd';
            const isCrd = priceInputMode === 'crd';
            bucketPriceCurrencyToggle.textContent = isCrd ? 'EWL' : 'USD';
            if (bucketPriceInput) {
                bucketPriceInput.step = isCrd ? '1' : '0.01';
                bucketPriceInput.placeholder = isCrd ? '0' : '0.00';
                bucketPriceInput.value = '';
            }
            if (bucketPriceDollarHint) { bucketPriceDollarHint.textContent = ''; bucketPriceDollarHint.classList.add('hidden'); }
        });
    }

    // Price input — live hint (opposite unit, sentence format)
    if (bucketPriceInput) {
        bucketPriceInput.addEventListener('input', () => {
            if (!bucketPriceDollarHint) return;
            const raw = parseFloat(bucketPriceInput.value);
            if (!raw || raw <= 0) {
                bucketPriceDollarHint.textContent = '';
                bucketPriceDollarHint.classList.add('hidden');
                return;
            }
            if (priceInputMode === 'crd') {
                bucketPriceDollarHint.textContent = `Access to this bucket will be valued at $${(raw / 100).toFixed(2)}`;
            } else {
                bucketPriceDollarHint.textContent = `Access to this bucket will be valued at ${Math.round(raw * 100)} EWL`;
            }
            bucketPriceDollarHint.classList.remove('hidden');
        });
    }

    // Paywall save button — price 0 means free, price > 0 means paywalled
    if (bucketPaywallSaveBtn) {
        bucketPaywallSaveBtn.addEventListener('click', async () => {
            if (!currentBucketName) return;
            const raw = parseFloat(bucketPriceInput?.value) || 0;
            const price = priceInputMode === 'crd'
                ? Math.max(0, Math.round(raw))
                : Math.max(0, Math.round(raw * 100));
            const isPaywalled = price > 0;

            if (isPaywalled && price < 1) {
                showNotification('Enter a price of at least 1 credit, or 0 for free.', 'error', 3000);
                bucketPriceInput?.focus();
                return;
            }

            try {
                bucketPaywallSaveBtn.disabled = true;
                bucketPaywallSaveBtn.style.opacity = '0.5';
                await setBucketPaywall(currentBucketName, isPaywalled, price);
                updatePaywallUI(isPaywalled, price);
                showNotification(isPaywalled ? `Paywall set — ${price} credits ($${(price / 100).toFixed(2)}) to unlock.` : 'Bucket is now free.', 'success', 3000);
            } catch (error) {
                showNotification(`Failed to set paywall: ${error.message}`, 'error');
            } finally {
                bucketPaywallSaveBtn.disabled = false;
                bucketPaywallSaveBtn.style.opacity = '1';
            }
        });
    }

    // Delete bucket button
    if (bucketDeleteBtn) {
        bucketDeleteBtn.addEventListener('click', async () => {
            if (!currentBucketName) {
                showNotification('Could not identify bucket to delete', 'error');
                return;
            }
            
            if (currentBucketName === 'Singletons') {
                showNotification('Cannot delete the default Singletons bucket', 'warning', 3000);
                return;
            }
            
            // Get link count
            const linkCount = currentBucketLinks.length;
            
            const confirmed = confirm(
                `Delete bucket "${currentBucketName}"?\n\n${linkCount} link${linkCount !== 1 ? 's' : ''} will be PERMANENTLY DELETED.\n\nThis action cannot be undone.`
            );
            
            if (!confirmed) return;

            // Disable corresponding card in card view
            const card = document.querySelector(`#cardView > [data-bucket-name="${currentBucketName}"]`);
            if (card) {
                card.style.opacity = '0.5';
                card.style.pointerEvents = 'none';
            }

            // Disable corresponding dropdown element
            const dropdownOptions = document.querySelectorAll('.linksBucketsDropdownOptionContainer');
            let dropdownOption = null;
            dropdownOptions.forEach(opt => {
                const nameEl = opt.querySelector('.linksBucketsDropdownOptionName');
                if (nameEl && nameEl.textContent.trim() === currentBucketName) {
                    dropdownOption = opt;
                }
            });
            if (dropdownOption) {
                dropdownOption.style.opacity = '0.5';
                dropdownOption.style.pointerEvents = 'none';
            }

            try {
                bucketDeleteBtn.disabled = true;
                bucketDeleteBtn.style.opacity = '0.5';

                await removeBucket(currentBucketName);

                showNotification(`Bucket "${currentBucketName}" and all its links deleted!`, 'success', 3000);

                // Close the popup since the bucket is gone
                closeBucketPopup();
            } catch (error) {
                showNotification(`Failed to delete: ${error.message}`, 'error');
                // Restore on failure
                if (card) {
                    card.style.opacity = '';
                    card.style.pointerEvents = '';
                }
                if (dropdownOption) {
                    dropdownOption.style.opacity = '';
                    dropdownOption.style.pointerEvents = '';
                }
            } finally {
                bucketDeleteBtn.disabled = false;
                bucketDeleteBtn.style.opacity = '1';
            }
        });
    }
    
    // Grab bucket button — clones the bucket into the user's collection
    if (bucketGrabBtn) {
        bucketGrabBtn.addEventListener('click', async () => {
            if (!currentBucketData?._id || currentBucketLinks.length === 0) {
                showNotification('No links to grab', 'warning', 3000);
                return;
            }

            try {
                bucketGrabBtn.disabled = true;
                bucketGrabBtn.style.opacity = '0.5';

                const response = await fetch('/api/buckets/grab', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ sourceBucketId: currentBucketData._id })
                });

                if (response.status === 409) {
                    const { error } = await response.json();
                    showNotification(error, 'warning', 3000);
                    return;
                }

                if (!response.ok) {
                    const { error } = await response.json();
                    throw new Error(error || 'Failed to grab bucket');
                }

                // Refresh bucket list so the new bucket appears in the dropdown
                await loadBucketsFromStorage();

                showNotification(`Grabbed "${currentBucketName}" — ${currentBucketLinks.length} link(s) added to your collection!`, 'success', 3000);

                // Visual feedback
                const btnSpan = bucketGrabBtn.querySelector('span');
                if (btnSpan) btnSpan.textContent = 'Grabbed!';
                bucketGrabBtn.classList.remove('bg-green-50', 'text-green-700');
                bucketGrabBtn.classList.add('bg-green-100', 'text-green-800');

                setTimeout(() => {
                    if (btnSpan) btnSpan.textContent = 'Grab Bucket';
                    bucketGrabBtn.classList.add('bg-green-50', 'text-green-700');
                    bucketGrabBtn.classList.remove('bg-green-100', 'text-green-800');
                }, 2000);
            } catch (error) {
                showNotification(`Failed to grab bucket: ${error.message}`, 'error');
            } finally {
                bucketGrabBtn.disabled = false;
                bucketGrabBtn.style.opacity = '1';
            }
        });
    }

    // Report bucket button — opens the report modal
    if (bucketReportBtn) {
        bucketReportBtn.addEventListener('click', () => {
            if (!currentBucketData?._id) return;
            window.openReportModal(currentBucketData._id, {
                name: currentBucketData.name,
                thumbnail: currentBucketData.thumbnail,
                linkCount: currentBucketData.links?.length ?? 0,
                curator: currentBucketData.curator?.username || formatAnonymousId(currentBucketData.curator?.userId) || 'Unknown'
            });
        });
    }

    // ========== MODE TOGGLE & INPUT VALIDATION ==========

    // Update button enabled/disabled state based on current mode and input values
    function updateAddLinkBtnState() {
        if (!addLinkBtn) return;
        const label = addLinkLabel.value.trim();
        const url = addLinkUrl.value.trim();

        let enabled;
        if (currentLinkMode === 'add') {
            // Add mode: require at least a URL
            enabled = url.length > 0;
        } else {
            // Lookup mode: require at least one field
            enabled = label.length > 0 || url.length > 0;
        }

        addLinkBtn.disabled = !enabled;
        addLinkBtn.setAttribute('aria-disabled', String(!enabled));
    }

    // Clear lookup results and restore full links list
    function clearLookupResults() {
        isShowingLookupResults = false;
        if (lookupResultsBanner) {
            lookupResultsBanner.classList.add('hidden');
            lookupResultsBanner.classList.remove('flex');
        }
        renderPopupLinks(currentBucketLinks);
        updateLinkCount(`${currentBucketLinks.length} link${currentBucketLinks.length !== 1 ? 's' : ''}`);
    }

    // Toggle between add-link and lookup modes
    function setLinkMode(mode) {
        currentLinkMode = mode;

        if (mode === 'add') {
            if (switchIndicator) switchIndicator.style.left = '2px';
            addLinkModeBtn.classList.add('text-orchid-700'); addLinkModeBtn.classList.remove('text-orchid-400');
            lookupModeBtn.classList.add('text-orchid-400'); lookupModeBtn.classList.remove('text-orchid-700');
            addLinkBtn.querySelector('span').textContent = 'Add New Entry';
            addLinkLabel.placeholder = 'label';
            addLinkUrl.placeholder = 'https://...';
            addLinkUrl.type = 'url';
            // Clear any active lookup results when switching to add mode
            if (isShowingLookupResults) clearLookupResults();
        } else {
            if (switchIndicator) switchIndicator.style.left = 'calc(50% - 2px)';
            lookupModeBtn.classList.add('text-orchid-700'); lookupModeBtn.classList.remove('text-orchid-400');
            addLinkModeBtn.classList.add('text-orchid-400'); addLinkModeBtn.classList.remove('text-orchid-700');
            addLinkBtn.querySelector('span').textContent = 'Look Up Links';
            addLinkLabel.placeholder = 'search by label...';
            addLinkUrl.placeholder = 'search by URL...';
            addLinkUrl.type = 'text';
        }

        // Clear inputs and reset button state on mode switch
        addLinkLabel.value = '';
        addLinkUrl.value = '';
        if (clearAddLinkLabel) { clearAddLinkLabel.classList.add('hidden'); clearAddLinkLabel.classList.remove('flex'); }
        if (clearAddLinkUrl) { clearAddLinkUrl.classList.add('hidden'); clearAddLinkUrl.classList.remove('flex'); }
        updateAddLinkBtnState();
    }

    if (addLinkModeBtn) {
        addLinkModeBtn.addEventListener('click', () => setLinkMode('add'));
    }
    if (lookupModeBtn) {
        lookupModeBtn.addEventListener('click', () => setLinkMode('lookup'));
    }

    // Show/hide a clear button based on whether its input has content
    function toggleClearBtn(input, btn) {
        if (!btn) return;
        if (input && input.value.length > 0) {
            btn.classList.remove('hidden');
            btn.classList.add('flex');
        } else {
            btn.classList.add('hidden');
            btn.classList.remove('flex');
        }
    }

    // Live-validate inputs to enable/disable button + toggle clear icons
    if (addLinkLabel) {
        addLinkLabel.addEventListener('input', () => {
            updateAddLinkBtnState();
            toggleClearBtn(addLinkLabel, clearAddLinkLabel);
        });
    }
    if (addLinkUrl) {
        addLinkUrl.addEventListener('input', () => {
            updateAddLinkBtnState();
            toggleClearBtn(addLinkUrl, clearAddLinkUrl);
        });
    }

    // Clear individual input buttons
    if (clearAddLinkLabel) {
        clearAddLinkLabel.addEventListener('click', () => {
            addLinkLabel.value = '';
            toggleClearBtn(addLinkLabel, clearAddLinkLabel);
            updateAddLinkBtnState();
            addLinkLabel.focus();
        });
    }
    if (clearAddLinkUrl) {
        clearAddLinkUrl.addEventListener('click', () => {
            addLinkUrl.value = '';
            toggleClearBtn(addLinkUrl, clearAddLinkUrl);
            updateAddLinkBtnState();
            addLinkUrl.focus();
        });
    }

    // Clear lookup banner button
    if (clearLookupBtn) {
        clearLookupBtn.addEventListener('click', () => {
            clearLookupResults();
            addLinkLabel.value = '';
            addLinkUrl.value = '';
            if (clearAddLinkLabel) { clearAddLinkLabel.classList.add('hidden'); clearAddLinkLabel.classList.remove('flex'); }
            if (clearAddLinkUrl) { clearAddLinkUrl.classList.add('hidden'); clearAddLinkUrl.classList.remove('flex'); }
            updateAddLinkBtnState();
            addLinkLabel.focus();
        });
    }

    // ========== FORM SUBMIT (ADD or LOOKUP) ==========

    if (addLinkForm) {
        addLinkForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            if (!currentBucketName) {
                showNotification('Could not identify bucket', 'error');
                return;
            }

            // ---- LOOKUP MODE ----
            if (currentLinkMode === 'lookup') {
                const labelQuery = addLinkLabel.value.trim();
                const urlQuery = addLinkUrl.value.trim();

                if (!labelQuery && !urlQuery) {
                    showNotification('Enter a label or URL to search', 'warning', 3000);
                    return;
                }

                const results = searchLinks(currentBucketLinks, labelQuery, urlQuery);

                isShowingLookupResults = true;
                renderPopupLinks(results, labelQuery, urlQuery);

                // Show results banner
                if (lookupResultsBanner && lookupResultsText) {
                    lookupResultsText.textContent = `Showing ${results.length} of ${currentBucketLinks.length} links`;
                    lookupResultsBanner.classList.remove('hidden');
                    lookupResultsBanner.classList.add('flex');
                }

                updateLinkCount(`${results.length} of ${currentBucketLinks.length} link${currentBucketLinks.length !== 1 ? 's' : ''}`);
                return;
            }

            // ---- ADD MODE ----
            const url = addLinkUrl.value.trim();
            if (!url) {
                showNotification('Please enter a URL', 'warning', 3000);
                addLinkUrl.focus();
                return;
            }

            const label = addLinkLabel.value.trim() || url;

            // Disable form while submitting
            addLinkBtn.disabled = true;
            addLinkBtn.innerHTML = '<span><svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24"><circle cx="4" cy="12" r="3" fill="currentColor"><animate id="SVG9IgbRbsl" attributeName="r" begin="0;SVGFUNpCWdG.end-0.25s" dur="0.75s" values="3;.2;3"/></circle><circle cx="12" cy="12" r="3" fill="currentColor"><animate attributeName="r" begin="SVG9IgbRbsl.end-0.6s" dur="0.75s" values="3;.2;3"/></circle><circle cx="20" cy="12" r="3" fill="currentColor"><animate id="SVGFUNpCWdG" attributeName="r" begin="SVG9IgbRbsl.end-0.45s" dur="0.75s" values="3;.2;3"/></circle></svg></span>';

            try {
                await addLinks([{ href: url, text: label }], [currentBucketName]);

                // Refresh popup links from updated state
                const allLinks = getStoredLinks();
                currentBucketLinks = allLinks.filter(link =>
                    link.buckets && link.buckets.includes(currentBucketName)
                );
                renderPopupLinks(currentBucketLinks);

                updateLinkCount(`${currentBucketLinks.length} link${currentBucketLinks.length !== 1 ? 's' : ''}`);

                // Clear form
                addLinkLabel.value = '';
                addLinkUrl.value = '';
                if (clearAddLinkLabel) { clearAddLinkLabel.classList.add('hidden'); clearAddLinkLabel.classList.remove('flex'); }
                if (clearAddLinkUrl) { clearAddLinkUrl.classList.add('hidden'); clearAddLinkUrl.classList.remove('flex'); }
                updateAddLinkBtnState();

                showNotification('Link added!', 'success', 2000);
            } catch (error) {
                showNotification(`Failed to add link: ${error.message}`, 'error');
            } finally {
                addLinkBtn.disabled = false;
                addLinkBtn.innerHTML = '<span><svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24"><path fill="currentColor" d="M17.077 16.077h-2.448q-.194 0-.335-.144q-.14-.143-.14-.356q0-.194.144-.347q.143-.153.356-.153h2.423v-2.423q0-.213.144-.356q.144-.144.357-.144t.356.144t.143.356v2.423H20.5q.213 0 .356.144q.144.144.144.357t-.144.356t-.356.143h-2.423V18.5q0 .213-.144.356t-.357.144t-.356-.144t-.143-.356zm-6.961 0H7.077q-1.692 0-2.884-1.192T3 12t1.193-2.885t2.884-1.193h3.039q.194 0 .347.153t.153.357t-.153.347t-.347.143H7.075q-1.267 0-2.171.904T4 12t.904 2.173t2.17.904h3.042q.194 0 .347.153t.153.356t-.153.348t-.347.143M9 12.5q-.213 0-.356-.144t-.144-.357t.144-.356T9 11.5h6q.213 0 .356.144t.144.357t-.144.356T15 12.5zm12-.5h-1q0-1.27-.904-2.173q-.904-.904-2.17-.904H13.86q-.194 0-.335-.144t-.14-.356q0-.194.143-.347q.144-.153.357-.153h3.038q1.692 0 2.885 1.193T21 12"/></svg></span>';
                updateAddLinkBtnState();
            }
        });
    }

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !seeLinksWrapper.classList.contains('hidden')) {
            closeBucketPopup();
        }
    });

    // ── Multi-select event listeners ──────────────────────────────────────────

    if (bulkSelectCloseBtn) {
        bulkSelectCloseBtn.addEventListener('click', deactivateMultiSelect);
    }

    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            const allSelected = selectedHrefs.size === currentBucketLinks.length;
            if (allSelected) {
                // Deselect all — stay in multi-select mode
                selectedHrefs.clear();
                popupLinksList.querySelectorAll('.linkSelectCheckbox').forEach(btn => {
                    setCheckboxState(btn, false);
                });
                updateBulkUI();
            } else {
                currentBucketLinks.forEach(l => selectedHrefs.add(l.href));
                popupLinksList.querySelectorAll('.linkSelectCheckbox').forEach(btn => {
                    setCheckboxState(btn, true);
                });
                updateBulkUI();
            }
        });
    }

    if (bulkCopyBtn) {
        bulkCopyBtn.addEventListener('click', async () => {
            if (!selectedHrefs.size) return;
            const text = [...selectedHrefs].join('\n');
            const ok = await copyToClipboard(text);
            showNotification(ok ? `${selectedHrefs.size} link(s) copied!` : 'Copy failed', ok ? 'success' : 'error', 2000);
        });
    }

    if (bulkDeleteBtn) {
        bulkDeleteBtn.addEventListener('click', async () => {
            if (!selectedHrefs.size) return;
            const count = selectedHrefs.size;
            if (!confirm(`Delete ${count} link(s) from "${currentBucketName}"?`)) return;
            for (const href of [...selectedHrefs]) {
                await deleteLinkFromBucket(currentBucketName, href);
                currentBucketLinks = currentBucketLinks.filter(l => l.href !== href);
                selectedHrefs.delete(href);
            }
            updateBulkUI();
            renderPopupLinks(currentBucketLinks);
            updateLinkCount(`${currentBucketLinks.length} link${currentBucketLinks.length !== 1 ? 's' : ''}`);
            showNotification(`${count} link(s) deleted.`, 'success', 2000);
        });
    }

    if (bulkMonetizeBtn) {
        bulkMonetizeBtn.addEventListener('click', async () => {
            if (!selectedHrefs.size) return;
            const makeFree = bulkMonetizeMode === 'free';
            bulkMonetizeMode = makeFree ? 'paywalled' : 'free';
            updateBulkUI();
            for (const href of selectedHrefs) {
                const link = currentBucketLinks.find(l => l.href === href);
                if (!link) continue;
                link.isFree = makeFree;
                await setLinkFree(currentBucketName, href, makeFree);
            }
            showNotification(`${selectedHrefs.size} link(s) set to ${makeFree ? 'free' : 'paywalled'}.`, 'success', 2000);
        });
    }
}