# Grabbn - Refactored File Structure

## 📁 Project Structure

```
scripts/
├── app.js                      # Main entry point (~100 lines)
├── state/
│   └── store.js               # State management & localStorage (~200 lines)
├── services/
│   └── scraper.js             # API calls & scraping logic (~100 lines)
├── components/
│   ├── bucketDropdown.js      # Bucket management UI (~350 lines)
│   ├── filterDropdown.js      # Filter dropdown UI (~150 lines)
│   ├── urlInput.js            # URL input field (~80 lines)
│   └── linksList.js           # Links rendering & actions (~120 lines)
└── utils/
    └── helpers.js             # Utility functions (~60 lines)
```

## 📦 Module Descriptions

### **app.js** (Main Entry Point)
- Initializes all components
- Wires up event handlers for extract and stop buttons
- Coordinates between different modules
- Entry point for the entire application

**Key Functions:**
- `init()` - Initializes the app
- `handleExtract()` - Handles the extract button click
- `handleStop()` - Handles the stop button click
- `updateExtractButtonLookState()` - Updates extract button disabled state

---

### **state/store.js** (State Management)
Centralized state management with localStorage persistence.

**State Variables:**
- `storedLinks` - Array of extracted links with bucket tags
- `bucketOptions` - Array of bucket names
- `currentFilters` - Array of active filters
- `stopRequested` - Boolean for graceful stop
- `isRunning` - Boolean for scraping status

**Key Functions:**
- `getStoredLinks()` / `setStoredLinks()`
- `getBucketOptions()` / `setBucketOptions()`
- `addLinks()` - Merges new links without duplicates
- `loadBucketsFromStorage()` / `saveBucketsToStorage()`
- `loadLinksFromStorage()` / `saveLinksToStorage()`
- `subscribe()` - Subscribe to state changes
- `getFilteredLinks()` - Get links filtered by current filters

---

### **services/scraper.js** (Scraping Service)
Handles all API communication and multi-page crawling logic.

**Key Functions:**
- `scrapeMultiplePages(baseUrl, selectedBuckets, onStatus)` - Main scraping orchestrator
- `buildPageUrl(baseUrl, page)` - Builds pagination URLs
- `stopScraping()` - Requests graceful stop

**Features:**
- Multi-page crawling with auto-discovery
- Progress callbacks for status updates
- Graceful stop mechanism
- Error handling

---

### **components/bucketDropdown.js** (Bucket Management)
Manages the bucket dropdown UI and all bucket operations.

**Key Functions:**
- `initBucketDropdown(onSelectionChange)` - Initialize the component
- `getSelectedBuckets()` - Get currently selected buckets
- `getIsAnyBucketSelected()` - Check if any bucket is selected

**Features:**
- Create new buckets
- Edit existing buckets (except Singletons)
- Delete buckets (except Singletons)
- Multi-select bucket functionality
- Auto-persist to localStorage

---

### **components/filterDropdown.js** (Filter Management)
Handles the filter dropdown for viewing specific buckets.

**Key Functions:**
- `initFilterDropdown(onFilterChange)` - Initialize the component
- `refreshFilterOptions()` - Refresh the dropdown options

**Features:**
- Filter by specific buckets
- "All Buckets" option
- Multi-select filtering
- Auto-updates when links change

---

### **components/urlInput.js** (URL Input)
Manages the URL input field and clear button.

**Key Functions:**
- `initUrlInput(onInputChange)` - Initialize the component
- `getUrlValue()` - Get current URL value
- `setUrlValue(value)` - Set URL value
- `focusUrlInput()` - Focus the input field

**Features:**
- Clear button toggle
- Focus/blur visual states
- Escape key to clear
- Input validation callback

---

### **components/linksList.js** (Links Display)
Renders the links list and handles list actions.

**Key Functions:**
- `initLinksList()` - Initialize the component
- `applyFilter()` - Apply current filters and re-render

**Features:**
- Render links with bucket tags
- Copy all links to clipboard
- Reset/clear all links
- Count badge updates
- Auto-subscribes to state changes

---

### **utils/helpers.js** (Utilities)
Shared utility functions used across components.

**Key Functions:**
- `showStatus(msg, color)` - Display status message
- `hideStatus()` - Hide status message
- `updateContainers(hasLinks)` - Toggle empty/results view
- `isBucketEditable(bucketName)` - Check if bucket can be edited
- `isValidUrl(urlString)` - Validate URL format
- `copyToClipboard(text)` - Copy text to clipboard

---

## 🔧 How to Use

### In your HTML file:
```html
<script type="module" src="./scripts/app.js"></script>
```

### Import Pattern:
All files use ES6 module imports. Example:
```javascript
import { getStoredLinks, addLinks } from './state/store.js';
import { scrapeMultiplePages } from './services/scraper.js';
```

---

## 🎯 Benefits of This Structure

1. **Separation of Concerns**: Each file has a clear, single responsibility
2. **Easy Testing**: Components can be tested independently
3. **Maintainability**: Bugs are easier to locate and fix
4. **Scalability**: Easy to add new features without affecting existing code
5. **Reusability**: Components can be reused in other projects
6. **Collaboration**: Multiple developers can work on different modules
7. **Code Organization**: No more scrolling through 1000+ line files

---

## 🔄 State Management Pattern

The app uses a simple pub/sub pattern:

```javascript
// Subscribe to state changes
subscribe(() => {
    // This runs whenever state changes
    renderMyComponent();
});

// Update state (automatically notifies subscribers)
setStoredLinks(newLinks);
```

---

## 🚀 Adding New Features

### To add a new component:
1. Create a new file in `components/`
2. Export an `init` function
3. Import and call it in `app.js`

### To add new state:
1. Add getters/setters in `state/store.js`
2. Call `notifyListeners()` after state changes
3. Subscribe to changes in your components

---

## 📝 Notes

- All localStorage operations are handled in `state/store.js`
- API calls are centralized in `services/scraper.js`
- UI state updates trigger through the subscribe mechanism
- The "Singletons" bucket is protected and cannot be edited/deleted
- Filters persist across scraping sessions
- Links are deduplicated by href, with bucket tags merged

---

## 🐛 Debugging Tips

- Check browser console for module loading errors
- Verify all imports use correct relative paths
- Ensure `type="module"` is set in your script tag
- State changes can be monitored via subscriptions
- Use browser's Network tab to debug API calls