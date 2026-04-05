// Utility helper functions

const statusMsg = document.getElementById('statusMsg');
const emptyResultsContainer = document.getElementById('emptyResultsContainer');
const resultContainer = document.getElementById('resultContainer');
const lookUpResultsContainer = document.getElementById('lookUpResultsContainer');
const notificationBadgeWrapper = document.getElementById('notificationBadgeWrapper');
const notificationText = document.getElementById('notificationText');
const closeNotifBadgeBtn = document.getElementById('closeNotifBadgeBtn');
const stopBtn = document.getElementById('stopBtn');
const extractBtnText = document.getElementById('extractBtnText');
const extractBtnSpinner = document.getElementById('extractBtnSpinner');

// Auto-hide timer
let notificationTimer = null;

// Show spinner and hide text in extract button
export function showExtractSpinner() {
    if (extractBtnText) extractBtnText.classList.add('hidden');
    if (extractBtnSpinner) extractBtnSpinner.classList.remove('hidden');
}

// Hide spinner and show text in extract button
export function hideExtractSpinner() {
    if (extractBtnSpinner) extractBtnSpinner.classList.add('hidden');
    if (extractBtnText) extractBtnText.classList.remove('hidden');
}

// Show stop button in notification badge
export function showStopButton() {
    if (stopBtn) {
        stopBtn.classList.remove('hidden');
        // Remove forced display none
        stopBtn.style.display = '';
    }
}

// Hide stop button in notification badge
export function hideStopButton() {
    if (stopBtn) {
        stopBtn.classList.add('hidden');
        // Force display none as backup
        stopBtn.style.display = 'none';
    }
}

// Show notification badge
export function showNotification(msg, type = 'info', duration = 8000, showStop = false) {
    if (!notificationBadgeWrapper || !notificationText) return;
    
    // Clear any existing timer
    if (notificationTimer) {
        clearTimeout(notificationTimer);
        notificationTimer = null;
    }
    
    // Set the message
    notificationText.textContent = msg;
    
    // Remove all type classes
    notificationBadgeWrapper.classList.remove(
        'text-gray-800', 'text-blue-800', 'text-green-800', 'text-yellow-800', 'text-red-800',
    );
    
    // Add appropriate styling based on type
    switch(type) {
        case 'success':
            notificationBadgeWrapper.classList.add('text-green-800');
            break;
        case 'error':
            notificationBadgeWrapper.classList.add('text-red-800');
            break;
        case 'warning':
            notificationBadgeWrapper.classList.add('text-yellow-800');
            break;
        case 'info':
        default:
            notificationBadgeWrapper.classList.add('text-blue-800');
            break;
    }
    
    // Show the notification
    notificationBadgeWrapper.classList.remove('hidden');
    
    // ALWAYS hide stop button first, then show only if explicitly requested
    hideStopButton();
    if (showStop === true) {
        showStopButton();
    }
    
    // Auto-hide after duration (if duration is not null/0)
    if (duration > 0) {
        notificationTimer = setTimeout(() => {
            hideNotification();
        }, duration);
    }
}

// Hide notification badge
export function hideNotification() {
    if (notificationTimer) {
        clearTimeout(notificationTimer);
        notificationTimer = null;
    }
    
    if (notificationBadgeWrapper) {
        notificationBadgeWrapper.classList.add('hidden');
    }
    
    // Also hide stop button when notification is hidden
    hideStopButton();
}

// Initialize close button for notification badge
export function initNotificationBadge() {
    if (closeNotifBadgeBtn) {
        closeNotifBadgeBtn.addEventListener('click', () => {
            hideNotification();
        });
    }
    
    // Hide by default
    hideNotification();
}

// Legacy function for backward compatibility (maps to showNotification)
export function showStatus(msg, colorClass) {
    // Map old color classes to new types
    let type = 'info';
    if (colorClass.includes('green')) type = 'success';
    else if (colorClass.includes('red')) type = 'error';
    else if (colorClass.includes('yellow')) type = 'warning';
    else if (colorClass.includes('blue')) type = 'info';
    
    showNotification(msg, type);
}

// Legacy function for backward compatibility
export function hideStatus() {
    hideNotification();
}

// Toggle between empty and results containers
export function updateContainers(hasLinks) {
    if (!emptyResultsContainer || !resultContainer) return;

    // Don't change containers while lookup results are visible
    const lookUpActive = lookUpResultsContainer && !lookUpResultsContainer.classList.contains('hidden');
    if (lookUpActive) {
        emptyResultsContainer.classList.add('hidden');
        resultContainer.classList.add('hidden');
        return;
    }

    if (hasLinks) {
        emptyResultsContainer.classList.add('hidden');
        resultContainer.classList.remove('hidden');
    } else {
        resultContainer.classList.add('hidden');
        emptyResultsContainer.classList.remove('hidden');
    }
}

// Show the lookup results container (hides empty + result containers)
export function showLookUpResults() {
    if (lookUpResultsContainer) lookUpResultsContainer.classList.remove('hidden');
    if (emptyResultsContainer) emptyResultsContainer.classList.add('hidden');
    if (resultContainer) resultContainer.classList.add('hidden');
}

// Hide the lookup results container and restore normal view
export function hideLookUpResults() {
    if (lookUpResultsContainer) lookUpResultsContainer.classList.add('hidden');
    // Let updateContainers handle showing the right container
}

// Check if a bucket can be edited/deleted (not Singletons)
export function isBucketEditable(bucketName) {
    return bucketName !== 'Singletons';
}

// Validate URL
export function isValidUrl(urlString) {
    try {
        new URL(urlString);
        return true;
    } catch {
        return false;
    }
}

// Copy text to clipboard
export async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}