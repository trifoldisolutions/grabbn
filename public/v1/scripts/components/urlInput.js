// URL input component

const urlInput = document.getElementById('urlInput');
const urlInputContainer = document.getElementById('urlInputContainer');
const clearURLInputBtn = document.getElementById('clearURLInputBtn');

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

