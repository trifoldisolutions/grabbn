// Links list component

import {
    getStoredLinks,
    getFilteredLinks,
    getCurrentFilters,
    clearLinks,
    subscribe,
    getCurrentViewMode,
    setCurrentViewMode,
    getBucketSourceUrl,
    getBucketThumbnail,
    getBucketOptions,
    getDraftBucketName
} from '../state/store.js';
import { updateContainers, showStatus, copyToClipboard, showNotification } from '../utils/helpers.js';
import { initBucketPopup, openBucketPopup } from './bucketPopup.js';

const linkList = document.getElementById('linkList');
const cardView = document.getElementById('cardView');
const cardViewLoadingOverlay = document.getElementById('cardViewLoadingOverlay');
const countBadge = document.getElementById('countBadge');
const resetBtn = document.getElementById('reset-list-btn');
const copyBtn = document.getElementById('copy-links-btn');
const listViewBtn = document.getElementById('listViewBtn');
const cardViewBtn = document.getElementById('cardViewBtn');

// Render links list (traditional list view)
function renderListView(links) {
    if (!linkList) return;

    linkList.innerHTML = '';

    links.forEach((link, index) => {
        const li = document.createElement('li');
        li.className = 'py-4';

        // Create bucket tags HTML
        const bucketsHTML = link.buckets && link.buckets.length > 0
            ? `<div class="flex flex-wrap gap-1 mt-2">
                ${link.buckets.map(bucket =>
                `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orchid-100 text-orchid-800">${bucket}</span>`
            ).join('')}
                </div>`
            : '';

        li.innerHTML = `
            <div class="flex gap-3 items-start">
                ${link.image ? `<img src="${link.image}" alt="" class="w-16 h-12 object-cover rounded shrink-0 mt-0.5 bg-gray-100" onerror="this.style.display='none'">` : ''}
                <div class="flex-1 min-w-0">
                    <span class="font-medium text-gray-800 text-sm">${link.text}</span>
                    ${link.duration ? `<span class="text-gray-500 text-xs ml-2">(${link.duration})</span>` : ''}
                    <a href="${link.href}" target="_blank" class="text-blue-600 text-xs mt-1 break-all block">
                        ${link.href}
                    </a>
                    ${bucketsHTML}
                </div>
            </div>`;

        linkList.appendChild(li);

        // Insert a blank spacer li after every 5 items
        if ((index + 1) % 6 === 0) {
            const spacerLi = document.createElement('li');
            spacerLi.className = 'listSpacer w-full flex items-center justify-center h-[5rem]';
            spacerLi.innerHTML = `
                <a href="" class="italic text-sm text-gray-400">Advertise here ...</a>
            `
            spacerLi.setAttribute('aria-hidden', 'true');
            linkList.appendChild(spacerLi);
        }
    });
}

// Render card view (diff-based: only adds/removes what changed)
async function renderCardView(links) {
    if (!cardView) return;

    const isInitialLoad = cardView.querySelectorAll(':scope > [data-bucket-name]').length === 0;
    if (isInitialLoad && cardViewLoadingOverlay) {
        cardViewLoadingOverlay.classList.remove('hidden');
        cardViewLoadingOverlay.classList.add('flex');
    }

    // Group links by buckets
    const bucketGroups = {};

    links.forEach(link => {
        if (link.buckets && link.buckets.length > 0) {
            link.buckets.forEach(bucket => {
                if (!bucketGroups[bucket]) {
                    bucketGroups[bucket] = [];
                }
                bucketGroups[bucket].push(link);
            });
        } else {
            if (!bucketGroups['Singletons']) {
                bucketGroups['Singletons'] = [];
            }
            bucketGroups['Singletons'].push(link);
        }
    });

    // Include empty buckets so newly created ones show as cards
    const activeFilters = getCurrentFilters();
    const allBuckets = getBucketOptions();
    allBuckets.forEach(bucket => {
        if (!bucketGroups[bucket]) {
            if (activeFilters.length === 0 || activeFilters.includes(bucket)) {
                bucketGroups[bucket] = [];
            }
        }
    });

    const sortedBuckets = Object.keys(bucketGroups).sort();

    // Build map of currently rendered cards by bucket name
    const existingCards = new Map();
    cardView.querySelectorAll(':scope > [data-bucket-name]').forEach(card => {
        existingCards.set(card.dataset.bucketName, card);
    });

    // Remove cards for buckets that should no longer be displayed
    for (const [name, card] of existingCards) {
        if (!sortedBuckets.includes(name)) {
            card.remove();
            existingCards.delete(name);
        }
    }

    // Update link counts and draft badge on existing cards
    for (const [name, card] of existingCards) {
        const bucketLinks = bucketGroups[name] || [];
        const countEl = card.querySelector('.shrink-0');
        if (countEl) {
            countEl.textContent = `${bucketLinks.length} link(s)`;
        }

        const thumb = card.querySelector('.cardThumbnailContainer');
        if (thumb) {
            const existingBadge = thumb.querySelector('.draftBadge');
            if (name === getDraftBucketName()) {
                if (!existingBadge) {
                    const badge = document.createElement('span');
                    badge.className = 'draftBadge absolute top-2 left-2 z-30 bg-gray-800/75 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full pointer-events-none';
                    badge.textContent = 'Draft';
                    thumb.appendChild(badge);
                }
            } else {
                existingBadge?.remove();
            }
        }
    }

    // Add only new cards that aren't already in the DOM
    for (const bucketName of sortedBuckets) {
        if (existingCards.has(bucketName)) continue;

        const bucketLinks = bucketGroups[bucketName];

        // Get the source URL for this bucket
        const sourceUrl = getBucketSourceUrl(bucketName);
        const displayUrl = sourceUrl || 'No source URL';

        // Try to get thumbnail
        const thumbnail = await getBucketThumbnail(bucketName);

        const card = document.createElement('div');
        card.dataset.bucketName = bucketName;

        card.className = 'bg-white rounded-md border border-gray-200 flex flex-col h-full break-inside-avoid mb-2';

        const isDraft = bucketName === getDraftBucketName();

        card.innerHTML = `
            <div class="p-2 border-b border-gray-100 bg-orchid-50 flex flex-col gap-y-1">
                <div class="flex items-center justify-between">
                    <h3 class="text-base font-bold text-gray-900 truncate">${bucketName}</h3>
                    <span class="text-orchid-500 text-xs font-semibold rounded-full shrink-0">
                        ${bucketLinks.length} link(s)
                    </span>
                </div>
                <div class="bucketSourceURLContainer flex flex-row justify-between items-center px-2 py-1 rounded-md border border-silver-200 gap-x-1">
                    <a href="${sourceUrl}" target="_blank" class="bucketMotherLink text-sm text-silver-500 hover:text-orchid-600 truncate transition-colors" title="${displayUrl}">
                        ${displayUrl}
                    </a>
                </div>
            </div>
            <div class="cardThumbnailContainer w-full h-auto aspect-video flex items-center justify-center bg-silver-50 relative overflow-hidden cursor-pointer group"
                 data-bucket-name="${bucketName}">
                ${thumbnail ?
                `<img src="${thumbnail}" alt="${bucketName} thumbnail" class="w-full h-full object-cover">` :
                `<span class="text-silver-400 text-sm">No thumbnail</span>`
            }
                ${isDraft ? `<span class="draftBadge absolute top-2 left-2 z-30 bg-gray-800/75 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full pointer-events-none">Draft</span>` : ''}
                <div class="cardThumbnailEditBtnContainer absolute top-0 left-0 w-full h-full z-25 bg-black bg-opacity-0 group-hover:bg-opacity-40 transition-all duration-200 hidden group-hover:flex items-center justify-center">
                    <button class="cardThumbnailEditBtn h-10 w-10 bg-white rounded-full flex items-center justify-center hover:scale-110 transition-transform">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M8.27 9.77H4.807q-.348 0-.578-.23T4 8.962V5.5q0-.213.143-.357T4.5 5t.357.143T5 5.5v2.735q1-1.896 2.851-3.066T12 4q2.514 0 4.488 1.383t2.866 3.563q.085.177.016.365t-.245.274t-.378.016q-.2-.068-.286-.245q-.77-1.929-2.509-3.142T12 5Q9.979 5 8.36 6.044T5.909 8.77H8.27q.214 0 .357.143t.143.357t-.143.357t-.357.143m.039 7.731h7.538q.243 0 .354-.217t-.03-.43l-2.02-2.713q-.13-.161-.323-.161q-.192 0-.323.162l-2.292 2.898l-1.427-1.725q-.131-.143-.314-.143q-.182 0-.313.162l-1.154 1.52q-.162.213-.05.43t.354.217M5.616 21q-.672 0-1.144-.472T4 19.385v-6.27q0-.213.143-.356t.357-.143t.357.143t.143.357v6.269q0 .269.173.442t.443.173h12.769q.269 0 .442-.173t.173-.442v-6.27q0-.213.143-.356t.357-.143t.357.143t.143.357v6.269q0 .67-.472 1.143q-.472.472-1.143.472z"/></svg>
                    </button>
                </div>
                <input type="file" class="cardThumbnailInput hidden" accept="image/jpeg,image/jpg,image/png">
            </div>
            <div class="cardCTASWrapper w-full h-auto flex flex-row px-3 mt-3 justify-between">
                <div class="bucketOpenBtnContainer flex flex-1">
                    <button class="bucketOpenBtn h-10 w-full border border-orchid-800 rounded-sm bg-orchid-50 text-orchid-800 font-medium flex flex-row items-center justify-center leading-none">See Content</button>
                </div>
            </div>
        `;

        cardView.appendChild(card);
    }

    // Rebuild ad spacers at correct positions
    cardView.querySelectorAll('.cardAdSpacer').forEach(s => s.remove());
    const allCardElements = cardView.querySelectorAll(':scope > [data-bucket-name]');
    let cardCount = 0;
    allCardElements.forEach(card => {
        cardCount++;
        if (cardCount % 6 === 0) {
            const adSpacer = document.createElement('div');
            adSpacer.className = 'cardAdSpacer col-span-full w-full flex items-center justify-center h-[5rem] rounded-md border border-dashed border-gray-200 bg-silver-50';
            adSpacer.innerHTML = `
                <a href="" class="italic text-sm text-gray-400">Advertise here ...</a>
            `;
            adSpacer.setAttribute('aria-hidden', 'true');
            card.after(adSpacer);
        }
    });

    setupThumbnailUploadHandlers();
    setupBucketOpenHandlers();

    if (cardViewLoadingOverlay) {
        cardViewLoadingOverlay.classList.add('hidden');
        cardViewLoadingOverlay.classList.remove('flex');
    }
}

// Setup "See Links" button handlers (skips already-bound buttons)
function setupBucketOpenHandlers() {
    const openButtons = document.querySelectorAll('.bucketOpenBtn:not([data-handler-bound])');

    openButtons.forEach(button => {
        button.setAttribute('data-handler-bound', 'true');
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            
            const card = button.closest('[data-bucket-name]');
            const bucketName = card?.dataset.bucketName;
            
            if (!bucketName) {
                showNotification('Could not identify bucket', 'error', 3000, false);
                return;
            }
            
            // Open the popup with this bucket's links
            openBucketPopup(bucketName);
        });
    });
}

// Setup thumbnail upload handlers (skips already-bound containers)
function setupThumbnailUploadHandlers() {
    const thumbnailContainers = document.querySelectorAll('.cardThumbnailContainer:not([data-handler-bound])');

    thumbnailContainers.forEach(container => {
        container.setAttribute('data-handler-bound', 'true');
        const bucketName = container.dataset.bucketName;
        const fileInput = container.querySelector('.cardThumbnailInput');
        const editBtn = container.querySelector('.cardThumbnailEditBtn');

        // Click on container or edit button opens file picker
        const openFilePicker = (e) => {
            e.stopPropagation();
            fileInput.click();
        };

        container.addEventListener('click', openFilePicker);
        if (editBtn) {
            editBtn.addEventListener('click', openFilePicker);
        }

        // Handle file selection
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            // Validate file type
            if (!['image/jpeg', 'image/jpg', 'image/png'].includes(file.type)) {
                showStatus('Please select a JPG or PNG image', 'text-red-500');
                return;
            }

            // Validate file size (max 5MB)
            if (file.size > 5 * 1024 * 1024) {
                showStatus('Image must be smaller than 5MB', 'text-red-500');
                return;
            }

            try {
                const reader = new FileReader();

                reader.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 50); // reading = 0–50%
                        showNotification(`Uploading thumbnail… ${pct}%`, 'info', 0);
                    }
                };

                reader.onload = async (event) => {
                    const base64Data = event.target.result;
                    showNotification('Uploading thumbnail… 50%', 'info', 0);

                    try {
                        await new Promise((resolve, reject) => {
                            const xhr = new XMLHttpRequest();
                            xhr.open('PUT', `/api/buckets/${encodeURIComponent(bucketName)}/thumbnail`);
                            xhr.setRequestHeader('Content-Type', 'application/json');
                            xhr.withCredentials = true;

                            xhr.upload.onprogress = (e) => {
                                if (e.lengthComputable) {
                                    const pct = 50 + Math.round((e.loaded / e.total) * 50); // upload = 50–100%
                                    showNotification(`Uploading thumbnail… ${pct}%`, 'info', 0);
                                }
                            };

                            xhr.onload = () => {
                                if (xhr.status >= 200 && xhr.status < 300) {
                                    resolve();
                                } else {
                                    try { reject(new Error(JSON.parse(xhr.responseText).error)); }
                                    catch { reject(new Error('Upload failed')); }
                                }
                            };
                            xhr.onerror = () => reject(new Error('Network error'));
                            xhr.send(JSON.stringify({ thumbnail: base64Data }));
                        });

                        showNotification('Processing…', 'info', 0);

                        // Wait for the image to actually render before declaring success
                        await new Promise((resolveImg) => {
                            const existingImg = container.querySelector('img');
                            const noThumbSpan = container.querySelector('span');

                            const afterPaint = () => requestAnimationFrame(resolveImg);

                            if (existingImg) {
                                existingImg.onload = afterPaint;
                                existingImg.onerror = afterPaint;
                                existingImg.src = base64Data;
                            } else {
                                if (noThumbSpan) {
                                    container.innerHTML = `
                                        <img src="${base64Data}" alt="${bucketName} thumbnail" class="w-full h-full object-cover">
                                        <div class="cardThumbnailEditBtnContainer absolute top-0 left-0 w-full h-full z-25 bg-black bg-opacity-0 group-hover:bg-opacity-40 transition-all duration-200 hidden group-hover:flex items-center justify-center">
                                            <button class="cardThumbnailEditBtn h-10 w-10 bg-white rounded-full flex items-center justify-center hover:scale-110 transition-transform">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M8.27 9.77H4.807q-.348 0-.578-.23T4 8.962V5.5q0-.213.143-.357T4.5 5t.357.143T5 5.5v2.735q1-1.896 2.851-3.066T12 4q2.514 0 4.488 1.383t2.866 3.563q.085.177.016.365t-.245.274t-.378.016q-.2-.068-.286-.245q-.77-1.929-2.509-3.142T12 5Q9.979 5 8.36 6.044T5.909 8.77H8.27q.214 0 .357.143t.143.357t-.143.357t-.357.143m.039 7.731h7.538q.243 0 .354-.217t-.03-.43l-2.02-2.713q-.13-.161-.323-.161q-.192 0-.323.162l-2.292 2.898l-1.427-1.725q-.131-.143-.314-.143q-.182 0-.313.162l-1.154 1.52q-.162.213-.05.43t.354.217M5.616 21q-.672 0-1.144-.472T4 19.385v-6.27q0-.213.143-.356t.357-.143t.357.143t.143.357v6.269q0 .269.173.442t.443.173h12.769q.269 0 .442-.173t.173-.442v-6.27q0-.213.143-.356t.357-.143t.357.143t.143.357v6.269q0 .67-.472 1.143q-.472.472-1.143.472z"/></svg>
                                            </button>
                                        </div>
                                        <input type="file" class="cardThumbnailInput hidden" accept="image/jpeg,image/jpg,image/png">
                                    `;
                                    setupThumbnailUploadHandlers();
                                }
                                const newImg = container.querySelector('img');
                                if (newImg) {
                                    newImg.onload = afterPaint;
                                    newImg.onerror = afterPaint;
                                } else {
                                    resolveImg();
                                }
                            }
                        });

                        container.style.animation = '';
                        showStatus('Thumbnail updated!', 'text-green-600');
                    } catch (error) {
                        container.style.animation = '';
                        showStatus('Failed to upload thumbnail', 'text-red-500');
                        console.error('Upload error:', error);
                    }
                };

                showNotification('Uploading thumbnail… 0%', 'info', 0);
                container.style.animation = 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite';
                reader.readAsDataURL(file);
            } catch (error) {
                showStatus('Failed to read image file', 'text-red-500');
                console.error('File read error:', error);
            }

            // Reset input
            e.target.value = '';
        });
    });
}

// Update view based on current mode
function updateView() {
    const filteredLinks = getFilteredLinks();
    const viewMode = getCurrentViewMode();

    if (!linkList) return;

    if (viewMode === 'list' || !cardView) {
        // List view or fallback if cardView doesn't exist
        linkList.classList.remove('hidden');
        if (cardView) cardView.classList.add('hidden');
        renderListView(filteredLinks);
    } else {
        // Card view
        linkList.classList.add('hidden');
        cardView.classList.remove('hidden');
        renderCardView(filteredLinks);
    }

    // Update count badge
    const storedLinks = getStoredLinks();
    const currentFilters = getCurrentFilters();

    if (countBadge) {
        if (currentFilters.length === 0) {
            countBadge.textContent = `${storedLinks.length} stored`;
        } else {
            countBadge.textContent = `${filteredLinks.length} of ${storedLinks.length}`;
        }
    }

    if (copyBtn) {
        copyBtn.disabled = filteredLinks.length === 0;
    }

    const allBuckets = getBucketOptions();
    const hasUserBuckets = allBuckets.some(b => b !== 'Singletons');
    updateContainers(filteredLinks.length > 0 || hasUserBuckets);
}

// Update button states
function updateViewButtons() {
    const viewMode = getCurrentViewMode();

    if (listViewBtn && cardViewBtn) {
        if (viewMode === 'list') {
            listViewBtn.classList.add('bg-white');
            listViewBtn.classList.remove('bg-transparent');
            cardViewBtn.classList.remove('bg-white');
            cardViewBtn.classList.add('bg-transparent');
        } else {
            cardViewBtn.classList.add('bg-white');
            cardViewBtn.classList.remove('bg-transparent');
            listViewBtn.classList.remove('bg-white');
            listViewBtn.classList.add('bg-transparent');
        }
    }
}

// Apply current filter and render
export function applyFilter() {
    updateView();
}

// Initialize links list component
export function initLinksList() {
    if (!resetBtn || !copyBtn) return;

    // Reset button
    resetBtn.addEventListener('click', () => {
        clearLinks();
        if (linkList) linkList.innerHTML = '';
        if (cardView) cardView.innerHTML = '';
        if (countBadge) countBadge.textContent = '0 items';
        showStatus('List cleared.', 'text-red-500');
        if (copyBtn) copyBtn.disabled = true;
        updateContainers(false);
    });

    // Copy button
    copyBtn.addEventListener('click', async () => {
        const filteredLinks = getFilteredLinks();
        const urls = filteredLinks.map(link => link.href).join('\n');

        const success = await copyToClipboard(urls);
        if (success) {
            showStatus('Links copied to clipboard!', 'text-green-600');
        } else {
            showStatus('Failed to copy.', 'text-red-500');
        }
    });

    // View mode buttons
    if (listViewBtn) {
        listViewBtn.addEventListener('click', () => {
            const currentMode = getCurrentViewMode();
            if (currentMode === 'list') return; // Already in list view

            setCurrentViewMode('list');
            updateViewButtons();
        });
    }

    if (cardViewBtn) {
        cardViewBtn.addEventListener('click', () => {
            const currentMode = getCurrentViewMode();
            if (currentMode === 'card') return; // Already in card view

            setCurrentViewMode('card');
            updateViewButtons();
        });
    }

    // Subscribe to state changes
    subscribe(() => {
        updateView();
    });

    // Initial render
    updateView();

    updateViewButtons();
    initBucketPopup();
}