// Bucket dropdown component

import {
    getBucketOptions,
    addBucket,
    removeBucket,
    updateBucket,
    subscribe
} from '../state/store.js';
import { isBucketEditable } from '../utils/helpers.js';

const linksBucketsDropdownBtn = document.getElementById('linksBucketsDropdownBtn');
const linksBucketsDropdownContainer = document.getElementById('linksBucketsDropdownContainer');
const linksCreateNewBucketWrapper = document.getElementById('linksCreateNewBucketWrapper');
const linksCreateNewBucketBtn = document.getElementById('linksCreateNewBucketBtn');
const linksSelectedBucketName = document.getElementById('linksSelectedBucketName');
const linksCreateNewBucketBtnContainer = document.getElementById('linksCreateNewBucketBtnContainer');
const linksNewBucketCreationContainer = document.getElementById('linksNewBucketCreationContainer');

// State for edit mode
let isEditingBucket = false;
let editingBucketOptionContainer = null;

// Get selected buckets from DOM
export function getSelectedBuckets() {
    const allOptionContainers = document.querySelectorAll('.linksBucketsDropdownOptionContainer');
    const selectedBuckets = [];

    allOptionContainers.forEach((container) => {
        const checkedIcon = container.querySelector('.dropdownOptionCheckedIcon');
        const nameEl = container.querySelector('.linksBucketsDropdownOptionName');

        if (checkedIcon && !checkedIcon.classList.contains('hidden') && nameEl) {
            selectedBuckets.push(nameEl.textContent.trim());
        }
    });

    return selectedBuckets;
}

// Return true only if at least one bucket option is selected
export function getIsAnyBucketSelected() {
    return getSelectedBuckets().length > 0;
}

// Update the selected bucket label
function updateSelectedBucketLabel() {
    const selectedNames = getSelectedBuckets();

    if (linksSelectedBucketName) {
        if (selectedNames.length === 0) {
            linksSelectedBucketName.textContent = 'Select buckets';
        } else {
            linksSelectedBucketName.textContent = selectedNames.join(', ');
        }
    }
}

// Generate HTML for a single bucket option
function buildBucketOptionHTML(bucketName, isSelected = false) {
    const isSingletons = bucketName === 'Singletons';

    const actionButtonsHTML = isSingletons ? '' : `
            <div class="flex flex-row gap-x-1 items-center">
                <button class="linksBucketsOptionEditBtn h-6 w-6 flex items-center justify-center" title="Edit bucket">
                    <span>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M5 19h1.098L16.796 8.302l-1.098-1.098L5 17.902zm-1 1v-2.52l13.875-13.9l2.54 2.563L6.52 20zM19 6.112L17.889 5zm-2.762 1.65l-.54-.558l1.098 1.098z"/></svg>
                    </span>
                </button>
                <button class="linksBucketsOptionDeleteBtn h-6 w-6 flex items-center justify-center" title="Delete bucket">
                    <span>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M7.616 20q-.667 0-1.141-.475T6 18.386V6h-.5q-.213 0-.356-.144T5 5.499t.144-.356T5.5 5H9q0-.31.23-.54t.54-.23h4.46q.31 0 .54.23T15 5h3.5q.213 0 .356.144t.144.357t-.144.356T18.5 6H18v12.385q0 .666-.475 1.14t-1.14.475zM17 6H7v12.385q0 .269.173.442t.443.173h8.769q.269 0 .442-.173t.173-.442zm-6.692 11q.213 0 .357-.144t.143-.356v-8q0-.213-.144-.356T10.307 8t-.356.144t-.143.356v8q0 .213.144.356q.144.144.356.144m3.385 0q.213 0 .356-.144t.143-.356v-8q0-.213-.144-.356Q13.904 8 13.692 8q-.213 0-.357.144t-.143.356v8q0 .213.144.356t.357.144M7 6v13z"/></svg>
                    </span>
                </button>
            </div>`;

    return `
            <div class="linksBucketsDropdownOptionContainer flex flex-row gap-x-2">
                <div class="w-full flex flex-row justify-between items-center">
                    <button class="dropdownOptionCheckingBtn h-8 w-full px-1 flex items-center gap-x-1" aria-selected="${isSelected}">
                        <span class="dropdownOptionUncheckedIcon ${isSelected ? 'hidden' : ''}">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M5.616 20q-.691 0-1.153-.462T4 18.384V5.616q0-.691.463-1.153T5.616 4h12.769q.69 0 1.153.463T20 5.616v12.769q0 .69-.462 1.153T18.384 20zm0-1h12.769q.23 0 .423-.192t.192-.424V5.616q0-.231-.192-.424T18.384 5H5.616q-.231 0-.424.192T5 5.616v12.769q0 .23.192.423t.423.192"/></svg>
                        </span>
                        <span class="dropdownOptionCheckedIcon ${!isSelected ? 'hidden' : ''}">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="m10.6 15.508l6.396-6.396l-.707-.708l-5.689 5.688l-2.85-2.85l-.708.708zM5.616 20q-.691 0-1.153-.462T4 18.384V5.616q0-.691.463-1.153T5.616 4h12.769q.69 0 1.153.463T20 5.616v12.769q0 .69-.462 1.153T18.384 20z"/></svg>
                        </span>
                        <span class="linksBucketsDropdownOptionName font-medium truncate max-w-40">${bucketName}</span>
                    </button>
                    ${actionButtonsHTML}
                </div>
            </div>
        `;
}

// Render bucket options in dropdown (diff-based: only adds/removes what changed)
function renderBucketOptions() {
    if (!linksBucketsDropdownContainer || !linksCreateNewBucketWrapper) return;

    const bucketOptions = getBucketOptions();

    // Build a map of currently rendered bucket elements by name
    const existingOptions = linksBucketsDropdownContainer.querySelectorAll('.linksBucketsDropdownOptionContainer');
    const renderedBuckets = new Map();
    existingOptions.forEach(option => {
        const nameEl = option.querySelector('.linksBucketsDropdownOptionName');
        if (nameEl) {
            renderedBuckets.set(nameEl.textContent.trim(), option);
        }
    });

    // Remove buckets that no longer exist in state
    for (const [name, element] of renderedBuckets) {
        if (!bucketOptions.includes(name)) {
            element.remove();
            renderedBuckets.delete(name);
        }
    }

    // Add only new buckets that aren't already in the DOM
    bucketOptions.forEach((bucketName, index) => {
        if (renderedBuckets.has(bucketName)) return;

        const isFirstBucket = index === 0 && renderedBuckets.size === 0;
        const html = buildBucketOptionHTML(bucketName, isFirstBucket);
        linksCreateNewBucketWrapper.insertAdjacentHTML('beforebegin', html);
    });

    // Update the selected bucket label
    updateSelectedBucketLabel();
}

// Dropdown control functions
function openLinksBucketsDropdown() {
    if (!linksBucketsDropdownContainer || !linksBucketsDropdownBtn) return;
    linksBucketsDropdownContainer.classList.remove('hidden');
    linksBucketsDropdownBtn.setAttribute('aria-expanded', 'true');
}

function closeLinksBucketsDropdown() {
    if (!linksBucketsDropdownContainer || !linksBucketsDropdownBtn) return;
    linksBucketsDropdownContainer.classList.add('hidden');
    linksBucketsDropdownBtn.setAttribute('aria-expanded', 'false');
}

function isLinksBucketsDropdownOpen() {
    return linksBucketsDropdownContainer && !linksBucketsDropdownContainer.classList.contains('hidden');
}

// Show creation container
function showBucketCreationContainer() {
    if (!linksNewBucketCreationContainer || !linksCreateNewBucketBtnContainer) return;
    linksCreateNewBucketBtnContainer.classList.add('hidden');
    linksNewBucketCreationContainer.classList.remove('hidden');

    const firstInteractiveEl = linksNewBucketCreationContainer.querySelector(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])'
    );
    if (firstInteractiveEl) firstInteractiveEl.focus();
}

// Reset and hide create/edit UI
function resetBucketCreateEditUI() {
    const newBucketInput = linksNewBucketCreationContainer?.querySelector('input[type="text"]');
    if (newBucketInput) newBucketInput.value = '';

    isEditingBucket = false;
    editingBucketOptionContainer = null;

    if (linksNewBucketCreationContainer) {
        linksNewBucketCreationContainer.classList.add('hidden');
        linksNewBucketCreationContainer.removeAttribute('data-mode');
    }
    if (linksCreateNewBucketBtnContainer) {
        linksCreateNewBucketBtnContainer.classList.remove('hidden');
    }
}

// Initialize bucket dropdown component
export function initBucketDropdown(onSelectionChange) {
    if (!linksBucketsDropdownBtn || !linksBucketsDropdownContainer) return;

    // Setup ARIA attributes
    linksBucketsDropdownBtn.setAttribute('aria-haspopup', 'listbox');
    linksBucketsDropdownBtn.setAttribute('aria-expanded', 'false');
    linksBucketsDropdownBtn.setAttribute('aria-controls', 'linksBucketsDropdownContainer');

    // Toggle on button click
    linksBucketsDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isLinksBucketsDropdownOpen()) {
            closeLinksBucketsDropdown();
        } else {
            openLinksBucketsDropdown();
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!isLinksBucketsDropdownOpen()) return;
        const clickedInsideContainer = linksBucketsDropdownContainer.contains(e.target);
        const clickedButton = linksBucketsDropdownBtn.contains(e.target);
        if (!clickedInsideContainer && !clickedButton) {
            closeLinksBucketsDropdown();
        }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isLinksBucketsDropdownOpen()) {
            closeLinksBucketsDropdown();
            linksBucketsDropdownBtn.focus();
        }
    });

    // Handle bucket option clicks
    linksBucketsDropdownContainer.addEventListener('click', (e) => {
        // Keep open if clicking the "Create New" area
        if (
            (linksCreateNewBucketWrapper && linksCreateNewBucketWrapper.contains(e.target)) ||
            (linksCreateNewBucketBtn && linksCreateNewBucketBtn.contains(e.target))
        ) {
            return;
        }

        // Ignore edit/delete button clicks
        if (e.target.closest('.linksBucketsOptionEditBtn') ||
            e.target.closest('.linksBucketsOptionDeleteBtn')) {
            return;
        }

        // Only handle real bucket option buttons
        const optionButton = e.target.closest('.linksBucketsDropdownOptionContainer button');
        if (!optionButton) return;

        // Get current icons for this button
        const checkedIcon = optionButton.querySelector('.dropdownOptionCheckedIcon');
        const uncheckedIcon = optionButton.querySelector('.dropdownOptionUncheckedIcon');

        // Determine if this option is currently selected
        const isCurrentlySelected = checkedIcon && !checkedIcon.classList.contains('hidden');

        // Toggle this option's selection state
        if (checkedIcon) checkedIcon.classList.toggle('hidden', isCurrentlySelected);
        if (uncheckedIcon) uncheckedIcon.classList.toggle('hidden', !isCurrentlySelected);

        if (optionButton) {
            optionButton.setAttribute('aria-selected', isCurrentlySelected ? 'false' : 'true');
        }

        // Update the selected bucket label
        updateSelectedBucketLabel();
        if (onSelectionChange) onSelectionChange();

        // Close after selecting an option
        closeLinksBucketsDropdown();
    });

    // Create new bucket button
    if (linksCreateNewBucketBtn && linksCreateNewBucketBtnContainer && linksNewBucketCreationContainer) {
        linksCreateNewBucketBtn.addEventListener('click', (e) => {
            e.preventDefault();
            showBucketCreationContainer();
        });
    }

    // Handle edit button clicks
    linksBucketsDropdownContainer.addEventListener('click', (e) => {
        const editBtn = e.target.closest('.linksBucketsOptionEditBtn');
        if (!editBtn) return;

        e.stopPropagation();

        const optionContainer = editBtn.closest('.linksBucketsDropdownOptionContainer');
        if (!optionContainer) return;

        const nameEl = optionContainer.querySelector('.linksBucketsDropdownOptionName');
        const currentName = nameEl ? nameEl.textContent.trim() : '';

        if (!isBucketEditable(currentName)) {
            alert('The "Singletons" bucket cannot be renamed as it is the default bucket.');
            return;
        }

        isEditingBucket = true;
        editingBucketOptionContainer = optionContainer;
        showBucketCreationContainer();

        const editInput = linksNewBucketCreationContainer.querySelector('input[type="text"]');
        if (editInput) {
            editInput.value = currentName;
            editInput.focus();
            editInput.select();
        }
    });

    // Handle delete button clicks
    linksBucketsDropdownContainer.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.linksBucketsOptionDeleteBtn');
        if (!deleteBtn) return;

        e.stopPropagation();

        const optionContainer = deleteBtn.closest('.linksBucketsDropdownOptionContainer');
        if (!optionContainer) return;

        const nameEl = optionContainer.querySelector('.linksBucketsDropdownOptionName');
        const bucketName = nameEl ? nameEl.textContent.trim() : '';

        if (!isBucketEditable(bucketName)) {
            alert('The "Singletons" bucket cannot be deleted as it is the default bucket.');
            return;
        }

        // UPDATED CONFIRMATION MESSAGE
        if (confirm(`Are you sure you want to delete the bucket "${bucketName}"?\n\nAll links in this bucket will be PERMANENTLY DELETED.\n\nThis action cannot be undone.`)) {
            const checkedIcon = optionContainer.querySelector('.dropdownOptionCheckedIcon');
            const wasSelected = checkedIcon && !checkedIcon.classList.contains('hidden');

            // Disable dropdown element
            optionContainer.style.opacity = '0.5';
            optionContainer.style.pointerEvents = 'none';

            // Disable corresponding card in card view
            const card = document.querySelector(`#cardView > [data-bucket-name="${bucketName}"]`);
            if (card) {
                card.style.opacity = '0.5';
                card.style.pointerEvents = 'none';
            }

            try {
                await removeBucket(bucketName);
                optionContainer.remove();

                if (wasSelected) {
                    updateSelectedBucketLabel();
                }

                if (onSelectionChange) onSelectionChange();
            } catch (error) {
                alert(`Failed to delete bucket: ${error.message}`);
                // Restore on failure
                optionContainer.style.opacity = '';
                optionContainer.style.pointerEvents = '';
                if (card) {
                    card.style.opacity = '';
                    card.style.pointerEvents = '';
                }
            }
        }
    });

    // Handle confirm button for create/edit
    const createBucketConfirmBtn = linksNewBucketCreationContainer?.querySelector('button');
    const newBucketInput = linksNewBucketCreationContainer?.querySelector('input[type="text"]');

    if (createBucketConfirmBtn && newBucketInput) {
        const loadingSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" class="animate-spin"><path fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-2a8 8 0 0 0-8-8z"/></svg>`;

        function setBucketBtnLoading(loading) {
            const btnSpan = createBucketConfirmBtn.querySelector('span');
            if (!btnSpan) return;
            if (loading) {
                btnSpan.dataset.originalHtml = btnSpan.innerHTML;
                btnSpan.innerHTML = loadingSvg;
                createBucketConfirmBtn.disabled = true;
                newBucketInput.disabled = true;
            } else {
                btnSpan.innerHTML = btnSpan.dataset.originalHtml || '';
                createBucketConfirmBtn.disabled = false;
                newBucketInput.disabled = false;
            }
        }

        createBucketConfirmBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const bucketName = newBucketInput.value.trim();

            if (!bucketName) {
                newBucketInput.focus();
                return;
            }

            // EDIT MODE
            if (isEditingBucket && editingBucketOptionContainer) {
                const optionNameEl = editingBucketOptionContainer.querySelector('.linksBucketsDropdownOptionName');

                if (optionNameEl) {
                    const oldName = optionNameEl.textContent.trim();

                    setBucketBtnLoading(true);
                    try {
                        await updateBucket(oldName, bucketName);

                        const checkedIcon = editingBucketOptionContainer.querySelector('.dropdownOptionCheckedIcon');
                        const isSelected = checkedIcon && !checkedIcon.classList.contains('hidden');

                        if (isSelected) {
                            updateSelectedBucketLabel();
                        }
                    } catch (error) {
                        alert(`Failed to update bucket: ${error.message}`);
                    } finally {
                        setBucketBtnLoading(false);
                    }
                }

                resetBucketCreateEditUI();
                return;
            }

            // CREATE MODE
            if (bucketName.toLowerCase() === 'singletons') {
                alert('"Singletons" is a reserved bucket name.');
                return;
            }

            const bucketOptions = getBucketOptions();
            if (bucketOptions.includes(bucketName)) {
                alert('A bucket with this name already exists!');
                return;
            }

            setBucketBtnLoading(true);
            try {
                await addBucket(bucketName);

                resetBucketCreateEditUI();
                updateSelectedBucketLabel();
                if (onSelectionChange) onSelectionChange();
            } catch (error) {
                alert(`Failed to create bucket: ${error.message}`);
            } finally {
                setBucketBtnLoading(false);
            }
        });

        // Allow Enter key to create/edit bucket
        newBucketInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                createBucketConfirmBtn.click();
            }
        });
    }

    // Initial render
    renderBucketOptions();

    // Subscribe to state changes
    subscribe(() => {
        renderBucketOptions();
    });
}