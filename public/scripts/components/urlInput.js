// URL input component

const urlInput = document.getElementById('urlInput');
const urlInputContainer = document.getElementById('urlInputContainer');
const clearURLInputBtn = document.getElementById('clearURLInputBtn');
const roleSwitchBtn = document.getElementById('roleSwitchBtn');

// Role definitions
const ROLES = {
    WEB_SCRAPING: 'web-scraping',
    BUCKET_LOOKUP: 'bucket-lookup'
};

const ROLE_ORDER = [ROLES.WEB_SCRAPING, ROLES.BUCKET_LOOKUP];

// Keep clear button hidden unless there's text
function updateClearURLButton() {
    if (!clearURLInputBtn || !urlInput) return;
    
    const hasValue = urlInput.value.trim().length > 0;
    clearURLInputBtn.classList.toggle('invisible', !hasValue);
    clearURLInputBtn.classList.toggle('pointer-events-none', !hasValue);
}

// Initialize URL input component
export function initUrlInput(onInputChange) {
    if (!urlInput || !urlInputContainer || !clearURLInputBtn) return;

    // Focus/blur effects
    urlInput.addEventListener('focus', () => {
        urlInputContainer.classList.add('ring-2', 'ring-orchid-500', 'border-transparent', 'bg-orchid-50');
    });

    urlInput.addEventListener('blur', () => {
        urlInputContainer.classList.remove('ring-2', 'ring-orchid-500', 'border-transparent', 'bg-orchid-50');
    });

    // Clear button click
    clearURLInputBtn.addEventListener('click', () => {
        urlInput.value = '';
        urlInput.focus();
        updateClearURLButton();
        if (onInputChange) onInputChange();
    });

    // Input changes
    urlInput.addEventListener('input', () => {
        updateClearURLButton();
        if (onInputChange) onInputChange();
    });

    // Escape key clears input
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && urlInput.value) {
            e.preventDefault();
            clearURLInputBtn.click();
        }
    });

    // Initialize state on first load
    updateClearURLButton();
}

// Get current URL value
export function getUrlValue() {
    return urlInput ? urlInput.value.trim() : '';
}

// Set URL value
export function setUrlValue(value) {
    if (urlInput) {
        urlInput.value = value;
        updateClearURLButton();
    }
}

// Focus URL input
export function focusUrlInput() {
    if (urlInput) {
        urlInput.focus();
    }
}

// Get the current role
export function getCurrentRole() {
    if (!roleSwitchBtn) return ROLES.WEB_SCRAPING;
    return roleSwitchBtn.dataset.role || ROLES.WEB_SCRAPING;
}

// Initialize role switch button
export function initRoleSwitch(onRoleChange) {
    if (!roleSwitchBtn) return;

    const icons = roleSwitchBtn.querySelectorAll(':scope > span');
    const scrapeIcon = icons[0]; // first span — globe (visible by default)
    const lookupIcon = icons[1]; // second span — folder (hidden by default)

    roleSwitchBtn.addEventListener('click', () => {
        const currentIndex = ROLE_ORDER.indexOf(getCurrentRole());
        const nextIndex = (currentIndex + 1) % ROLE_ORDER.length;
        const nextRole = ROLE_ORDER[nextIndex];

        roleSwitchBtn.dataset.role = nextRole;

        const isLookup = nextRole === ROLES.BUCKET_LOOKUP;

        // Toggle icons
        lookupIcon.classList.toggle('hidden', !isLookup);
        scrapeIcon.classList.toggle('hidden', isLookup);

        // Update input
        if (urlInput) {
            urlInput.type = isLookup ? 'text' : 'url';
            urlInput.placeholder = isLookup
                ? 'find a bucket by its name, public link or id'
                : 'https://example.com';
            urlInput.value = '';
            updateClearURLButton();
        }

        if (onRoleChange) onRoleChange(nextRole);
    });
}