// Filter dropdown component

import { 
    getCurrentFilters, 
    getActiveBucketsInLinks,
    setCurrentFilters,
    subscribe 
} from '../state/store.js';

const filterDropdownBtn = document.getElementById('filterDropdownBtn');
const filterDropdownContainer = document.getElementById('filterDropdownContainer');
const filterSelectedName = document.getElementById('filterSelectedName');

// Update filter label
function updateFilterLabel() {
    if (!filterSelectedName) return;
    
    const currentFilters = getCurrentFilters();
    
    if (currentFilters.length === 0) {
        filterSelectedName.textContent = 'All Buckets';
    } else if (currentFilters.length === 1) {
        filterSelectedName.textContent = currentFilters[0];
    } else {
        filterSelectedName.textContent = `${currentFilters.length} buckets`;
    }
}

// Render filter options
function renderFilterOptions() {
    if (!filterDropdownContainer) return;
    
    // Clear existing options
    filterDropdownContainer.innerHTML = '';
    
    const activeBuckets = getActiveBucketsInLinks();
    const currentFilters = getCurrentFilters();
    
    // Always add "All Buckets" option first
    const isAllSelected = currentFilters.length === 0;
    const allBucketsOption = `
        <div class="filterOptionContainer">
            <button class="filterOptionBtn h-8 w-full px-2 flex items-center gap-x-1 hover:bg-gray-50 rounded text-sm" data-filter="all">
                <span class="filterOptionUncheckedIcon ${isAllSelected ? 'hidden' : ''}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M5.616 20q-.691 0-1.153-.462T4 18.384V5.616q0-.691.463-1.153T5.616 4h12.769q.69 0 1.153.463T20 5.616v12.769q0 .69-.462 1.153T18.384 20zm0-1h12.769q.23 0 .423-.192t.192-.424V5.616q0-.231-.192-.424T18.384 5H5.616q-.231 0-.424.192T5 5.616v12.769q0 .23.192.423t.423.192"/></svg>
                </span>
                <span class="filterOptionCheckedIcon ${!isAllSelected ? 'hidden' : ''}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="m10.6 15.508l6.396-6.396l-.707-.708l-5.689 5.688l-2.85-2.85l-.708.708zM5.616 20q-.691 0-1.153-.462T4 18.384V5.616q0-.691.463-1.153T5.616 4h12.769q.69 0 1.153.463T20 5.616v12.769q0 .69-.462 1.153T18.384 20z"/></svg>
                </span>
                <span class="flex-1 text-left font-medium">All Buckets</span>
            </button>
        </div>
    `;
    filterDropdownContainer.insertAdjacentHTML('beforeend', allBucketsOption);
    
    // Add separator if there are active buckets
    if (activeBuckets.length > 0) {
        filterDropdownContainer.insertAdjacentHTML('beforeend', '<div class="h-px bg-gray-200 my-1"></div>');
    }
    
    // Add each active bucket as a filter option with checkbox
    activeBuckets.forEach(bucketName => {
        const isSelected = currentFilters.includes(bucketName);
        const bucketOption = `
            <div class="filterOptionContainer">
                <button class="filterOptionBtn h-8 w-full px-2 flex items-center gap-x-1 hover:bg-gray-50 rounded text-sm" data-filter="${bucketName}">
                    <span class="filterOptionUncheckedIcon ${isSelected ? 'hidden' : ''}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M5.616 20q-.691 0-1.153-.462T4 18.384V5.616q0-.691.463-1.153T5.616 4h12.769q.69 0 1.153.463T20 5.616v12.769q0 .69-.462 1.153T18.384 20zm0-1h12.769q.23 0 .423-.192t.192-.424V5.616q0-.231-.192-.424T18.384 5H5.616q-.231 0-.424.192T5 5.616v12.769q0 .23.192.423t.423.192"/></svg>
                    </span>
                    <span class="filterOptionCheckedIcon ${!isSelected ? 'hidden' : ''}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="m10.6 15.508l6.396-6.396l-.707-.708l-5.689 5.688l-2.85-2.85l-.708.708zM5.616 20q-.691 0-1.153-.462T4 18.384V5.616q0-.691.463-1.153T5.616 4h12.769q.69 0 1.153.463T20 5.616v12.769q0 .69-.462 1.153T18.384 20z"/></svg>
                    </span>
                    <span class="flex-1 text-left">${bucketName}</span>
                </button>
            </div>
        `;
        filterDropdownContainer.insertAdjacentHTML('beforeend', bucketOption);
    });
}

// Initialize filter dropdown component
export function initFilterDropdown(onFilterChange) {
    if (!filterDropdownBtn || !filterDropdownContainer) return;

    // Toggle dropdown
    filterDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !filterDropdownContainer.classList.contains('hidden');
        
        if (isOpen) {
            filterDropdownContainer.classList.add('hidden');
        } else {
            // Render fresh options before opening
            renderFilterOptions();
            filterDropdownContainer.classList.remove('hidden');
        }
    });
    
    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!filterDropdownContainer.classList.contains('hidden') &&
            !filterDropdownContainer.contains(e.target) &&
            !filterDropdownBtn.contains(e.target)) {
            filterDropdownContainer.classList.add('hidden');
        }
    });
    
    // Handle filter option clicks
    filterDropdownContainer.addEventListener('click', (e) => {
        const optionBtn = e.target.closest('.filterOptionBtn');
        if (!optionBtn) return;
        
        const filterValue = optionBtn.dataset.filter;
        const currentFilters = getCurrentFilters();
        let newFilters;
        
        if (filterValue === 'all') {
            // "All Buckets" clicked - clear all filters
            newFilters = [];
        } else {
            // Individual bucket clicked - toggle it
            const index = currentFilters.indexOf(filterValue);
            if (index > -1) {
                // Already selected, remove it
                newFilters = [...currentFilters];
                newFilters.splice(index, 1);
            } else {
                // Not selected, add it
                newFilters = [...currentFilters, filterValue];
            }
        }
        
        setCurrentFilters(newFilters);
        updateFilterLabel();
        if (onFilterChange) onFilterChange();
        
        // Re-render the dropdown to update checkboxes
        renderFilterOptions();
    });

    // Initial render
    updateFilterLabel();

    // Subscribe to state changes
    subscribe(() => {
        updateFilterLabel();
    });
}

// Export for use in other components
export function refreshFilterOptions() {
    renderFilterOptions();
    updateFilterLabel();
}