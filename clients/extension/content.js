// Guard against double-injection
if (window.__grabbnInjected) {
  chrome.runtime.sendMessage({ type: 'START_PICK_MODE' });
} else {
  window.__grabbnInjected = true;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let pickModeActive = false;  // true only during crosshair phase
  let siblingsActive = true;
  let anchorEl       = null;
  let hoveredEl      = null;
  let shield         = null;
  let selPanel       = null;
  let reviewPanel    = null;

  // highlightedEls: [{ el, href, link, domImagePromise }]
  let highlightedEls = [];
  let checkedEls     = new Set();
  let lastCheckedEl  = null;
  let detectedCards  = new Set();

  const metaRequests = new Map();
  const metaCache    = new Map();
  const MAX_SELECTION = 100;

  // Review state
  let reviewItems          = [];
  let reviewSelectedUrls   = new Set();
  let reviewSelectedBuckets = new Set();
  let reviewBucketsLoaded  = [];

  // ---------------------------------------------------------------------------
  // Pick mode — phase 1 (crosshair)
  // ---------------------------------------------------------------------------

  function startPickMode(withSiblings) {
    if (pickModeActive) return;
    pickModeActive = true;
    siblingsActive = withSiblings !== false;
    anchorEl = null;
    clearHighlightedEls();
    metaRequests.clear();
    metaCache.clear();
    removeSelPanel();
    removeReviewPanel();
    document.body.classList.add('grabbn-pick-mode');
    createShield();
    detectListings();
    document.addEventListener('keydown', onKeyDown, true);
    showHint('Click a card to anchor · Esc to cancel');
  }

  function stopPickMode() {
    pickModeActive = false;
    document.body.classList.remove('grabbn-pick-mode');
    removeShield();
    document.removeEventListener('keydown', onKeyDown, true);
    clearHighlight();
    clearListings();
    removeHint();
  }

  function cancelAll() {
    clearHighlightedEls();
    anchorEl = null;
    metaRequests.clear();
    metaCache.clear();
    removeSelPanel();
    removeReviewPanel();
    if (pickModeActive) stopPickMode();
  }

  // ---------------------------------------------------------------------------
  // Listing detection (dashed outlines during crosshair phase)
  // ---------------------------------------------------------------------------

  function detectListings() {
    const skipSelector = 'header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';
    const seen = new Set();
    for (const link of deepQuerySelectorAll(document, 'a[href]')) {
      if (link.closest('#grabbn-sel-panel, #grabbn-review-panel, #grabbn-hint')) continue;
      if (link.closest(skipSelector)) continue;
      const card = findCardAncestor(link);
      if (seen.has(card)) continue;
      seen.add(card);
      detectedCards.add(card);
      card.classList.add('grabbn-listing');
    }
  }

  function clearListings() {
    for (const card of detectedCards) card.classList.remove('grabbn-listing');
    detectedCards.clear();
  }

  // ---------------------------------------------------------------------------
  // Card ancestor detection
  // ---------------------------------------------------------------------------

  function findCardAncestor(link, maxLevels = 12) {
    let el = link;
    let firstRepeating = null;
    let firstCardLike  = null;

    for (let i = 0; i < maxLevels; i++) {
      let parent = el.parentElement;
      if (!parent) {
        const root = el.getRootNode();
        if (root instanceof ShadowRoot) parent = root.host;
      }
      if (!parent || parent === document.body || parent === document.documentElement) break;

      let sameTagCount = 0;
      for (const child of parent.children) {
        if (child.tagName === el.tagName) sameTagCount++;
      }

      if (sameTagCount >= 2) {
        if (!firstRepeating) firstRepeating = el;
        if (!firstCardLike && el.tagName !== 'A') {
          if (el.tagName.includes('-') || (el.querySelector('img') && el.querySelector('a[href]'))) {
            firstCardLike = el;
          }
        }
      }

      el = parent;
    }

    return firstCardLike || firstRepeating || link;
  }

  // ---------------------------------------------------------------------------
  // Shield (crosshair overlay)
  // ---------------------------------------------------------------------------

  function createShield() {
    if (shield) return;
    shield = document.createElement('div');
    shield.id = 'grabbn-shield';
    shield.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483640;cursor:crosshair;';
    document.body.appendChild(shield);
    shield.addEventListener('mousemove', onShieldMouseMove);
    shield.addEventListener('click', onShieldClick);
  }

  function removeShield() {
    if (!shield) return;
    shield.remove();
    shield = null;
  }

  function linkFromPoint(x, y) {
    const elems = document.elementsFromPoint(x, y);
    for (const el of elems) {
      if (el === shield) continue;
      if (el.closest?.('#grabbn-sel-panel, #grabbn-review-panel, #grabbn-hint')) continue;
      if (el.tagName === 'A' && el.href) return el;
    }
    return null;
  }

  function onShieldMouseMove(e) {
    const link = linkFromPoint(e.clientX, e.clientY);
    if (!link) { clearHighlight(); return; }
    const card = findCardAncestor(link);
    if (hoveredEl === card) return;
    clearHighlight();
    hoveredEl = card;
    card.classList.add('grabbn-link-hover');
  }

  function onShieldClick(e) {
    const link = linkFromPoint(e.clientX, e.clientY);
    if (!link) return;

    // Exit crosshair phase — keep the page interactive
    stopPickMode();

    anchorEl = findCardAncestor(link);
    addElementWithCheckbox(anchorEl, link);
    if (siblingsActive) addSiblings(anchorEl);

    updateSelPanel();
  }

  function clearHighlight() {
    if (hoveredEl) { hoveredEl.classList.remove('grabbn-link-hover'); hoveredEl = null; }
  }

  // ---------------------------------------------------------------------------
  // Checkbox injection (phase 2)
  // ---------------------------------------------------------------------------

  function addElementWithCheckbox(card, link) {
    if (highlightedEls.find(e => e.el === card)) return;
    if (highlightedEls.length >= MAX_SELECTION) return;

    card.classList.remove('grabbn-listing');
    card.classList.add('grabbn-link-selected');

    const pos = window.getComputedStyle(card).position;
    if (pos === 'static') {
      card.style.position = 'relative';
      card.dataset.grabbnRelative = '1';
    }

    const wrap = document.createElement('div');
    wrap.className = 'grabbn-cb-wrap';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = false;
    cb.className = 'grabbn-cb-input';
    cb.addEventListener('click', (evt) => {
      evt.stopPropagation();

      if (evt.shiftKey && lastCheckedEl !== null) {
        const fromIdx = highlightedEls.findIndex(e => e.el === lastCheckedEl);
        const toIdx   = highlightedEls.findIndex(e => e.el === card);
        if (fromIdx !== -1 && toIdx !== -1) {
          const lo = Math.min(fromIdx, toIdx);
          const hi = Math.max(fromIdx, toIdx);
          for (let j = lo; j <= hi; j++) {
            const target = highlightedEls[j].el;
            checkedEls.add(target);
            target.classList.add('grabbn-link-selected');
            const targetCb = target.querySelector('.grabbn-cb-input');
            if (targetCb) targetCb.checked = true;
          }
          cb.checked = true;
        }
      } else {
        if (cb.checked) {
          checkedEls.add(card);
          card.classList.add('grabbn-link-selected');
        } else {
          checkedEls.delete(card);
          card.classList.remove('grabbn-link-selected');
        }
        lastCheckedEl = card;
      }

      updateSelPanel();
    });

    wrap.appendChild(cb);
    card.appendChild(wrap);

    const href = link.href;
    const domImagePromise = extractDomProductImage(card, href).catch(() => null);
    highlightedEls.push({ el: card, href, link, domImagePromise });

    fetchMetaForHref(href);
  }

  function clearHighlightedEls() {
    for (const { el } of highlightedEls) {
      el.classList.remove('grabbn-link-selected', 'grabbn-listing');
      el.querySelector('.grabbn-cb-wrap')?.remove();
      if (el.dataset.grabbnRelative) {
        el.style.position = '';
        delete el.dataset.grabbnRelative;
      }
    }
    highlightedEls = [];
    checkedEls.clear();
    lastCheckedEl = null;
  }

  // ---------------------------------------------------------------------------
  // Siblings detection
  // ---------------------------------------------------------------------------

  function addSiblings(anchor) {
    const tag = anchor.tagName.toLowerCase();
    const cls = anchor.classList.length > 0 ? anchor.classList[0] : null;
    let sel = null;
    if (tag.includes('-')) {
      sel = tag;
    } else if (cls) {
      try { sel = `${tag}.${CSS.escape(cls)}`; } catch { sel = tag; }
    }
    if (!sel) return;

    for (const el of document.querySelectorAll(sel)) {
      if (el === anchor) continue;
      if (el.closest('#grabbn-sel-panel, #grabbn-review-panel, #grabbn-hint')) continue;
      const sibLink = deepQuerySelector(el, 'a[href]');
      if (!sibLink) continue;
      if (highlightedEls.length >= MAX_SELECTION) break;
      addElementWithCheckbox(el, sibLink);
    }
  }

  // ---------------------------------------------------------------------------
  // Meta fetching
  // ---------------------------------------------------------------------------

  function fetchMetaForHref(href) {
    if (metaRequests.has(href)) return;
    const p = new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_META', url: href }, (resp) => {
        if (resp?.ok) {
          metaCache.set(href, {
            title: resp.title,
            image: resp.image,
            images: resp.images || [],
          });
        } else if (resp?.error === 'rate_daily') {
          metaCache.set(href, { error: 'rate_daily', used: resp.used, limit: resp.limit });
        }
        resolve(resp || null);
      });
    });
    metaRequests.set(href, p);
  }

  // ---------------------------------------------------------------------------
  // Key handler
  // ---------------------------------------------------------------------------

  function onKeyDown(e) {
    if (e.key === 'Escape' && e.isTrusted) {
      e.preventDefault();
      e.stopPropagation();
      cancelAll();
    }
  }

  // ---------------------------------------------------------------------------
  // Hint banner
  // ---------------------------------------------------------------------------

  function showHint(msg) {
    removeHint();
    const el = document.createElement('div');
    el.id = 'grabbn-hint';
    el.textContent = msg;
    document.body.appendChild(el);
  }

  function removeHint() { document.getElementById('grabbn-hint')?.remove(); }

  // ---------------------------------------------------------------------------
  // Grabbn icon SVG
  // ---------------------------------------------------------------------------

  const GRAB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
    <g fill="none" fill-rule="evenodd">
      <path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/>
      <path fill="currentColor" d="M17.961 7.058a2.5 2.5 0 0 0-3.349-1.896a2.498 2.498 0 0 0-4.225 0A2.5 2.5 0 0 0 7 7.5l.001.962a4.7 4.7 0 0 0-.87-.584C5.11 7.36 4.12 7.44 3.077 7.866c-.84.345-1.107 1.308-.747 2.028l2.842 5.684A8 8 0 0 0 12.326 20H13a8 8 0 0 0 8-8V9.5a2.5 2.5 0 0 0-3.039-2.442M10 7.5a.5.5 0 1 0-1 0V11a1 1 0 0 1-1.78.625c-.925-1.156-1.517-1.72-1.995-1.964a1.2 1.2 0 0 0-.835-.117l2.57 5.14A6 6 0 0 0 12.326 18H13a6 6 0 0 0 6-6V9.5a.5.5 0 1 0-1 0v.5a1 1 0 1 1-2 0V7.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0V6.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0z"/>
    </g>
  </svg>`;

  // ---------------------------------------------------------------------------
  // Selection panel (phase 2 — after anchor clicked)
  // ---------------------------------------------------------------------------

  function updateSelPanel() {
    // If the user changes selection while the review panel is open, dismiss it
    // so the selection panel reflects the updated state instead of stacking.
    if (reviewPanel) removeReviewPanel();

    const n     = checkedEls.size;
    const total = highlightedEls.length;
    if (total === 0) { removeSelPanel(); return; }

    if (!selPanel) {
      selPanel = document.createElement('div');
      selPanel.id = 'grabbn-sel-panel';
      document.body.appendChild(selPanel);
    }

    selPanel.innerHTML = `
      <div id="grabbn-sel-header">
        <span id="grabbn-sel-logo">${GRAB_ICON}<span>Grabbn</span></span>
        <span id="grabbn-sel-count">${n} / ${total} checked</span>
      </div>
      <p id="grabbn-sel-hint">Check the cards you want · hold <strong>Shift</strong> to select a range.</p>
      <div id="grabbn-sel-footer">
        <button id="grabbn-sel-cancel">Cancel</button>
        <button id="grabbn-sel-grab" ${n === 0 ? 'disabled' : ''}>Grab ${n} link${n !== 1 ? 's' : ''}</button>
      </div>
    `;

    selPanel.querySelector('#grabbn-sel-cancel').addEventListener('click', cancelAll);
    if (n > 0) {
      selPanel.querySelector('#grabbn-sel-grab').addEventListener('click', onGrabLinks);
    }
  }

  function removeSelPanel() { selPanel?.remove(); selPanel = null; }

  // ---------------------------------------------------------------------------
  // Grab Links — collect items and show review
  // ---------------------------------------------------------------------------

  async function onGrabLinks() {
    const items = [];
    for (const { el, href, link, domImagePromise } of highlightedEls) {
      if (!checkedEls.has(el)) continue;

      let text = '';
      const h = deepQuerySelector(el, 'h1,h2,h3,h4,h5,h6');
      if (h) text = h.textContent.trim();
      if (!text) text = (link.title || link.getAttribute('aria-label') || '').trim();
      if (!text) text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 120);

      const domImg = await (domImagePromise?.catch(() => null));
      items.push({ href, text: text.slice(0, 120), domImage: domImg?.image || '' });
    }

    removeSelPanel();
    showReviewPanel(items);
  }

  // ---------------------------------------------------------------------------
  // Review panel
  // ---------------------------------------------------------------------------

  function showReviewPanel(items) {
    reviewItems          = items;
    reviewSelectedUrls   = new Set(items.map(i => i.href));
    reviewSelectedBuckets = new Set();
    reviewBucketsLoaded  = [];

    reviewPanel = document.createElement('div');
    reviewPanel.id = 'grabbn-review-panel';
    document.body.appendChild(reviewPanel);

    renderReviewShell();
    loadReviewBuckets();
  }

  function renderReviewShell() {
    const n = reviewItems.length;

    reviewPanel.innerHTML = `
      <div id="grabbn-review-header">
        <span id="grabbn-review-logo">${GRAB_ICON}<span>Grabbn</span></span>
        <span id="grabbn-review-title">${n} item${n !== 1 ? 's' : ''} to save</span>
        <button id="grabbn-review-close">✕</button>
      </div>
      <ul id="grabbn-review-list">
        ${reviewItems.map(item => `
          <li class="grabbn-review-row">
            <input type="checkbox" class="grabbn-review-cb" data-href="${escapeHtml(item.href)}" checked>
            ${item.domImage
              ? `<img class="grabbn-review-thumb" src="${escapeHtml(item.domImage)}" alt="" onerror="this.remove()">`
              : '<div class="grabbn-review-thumb grabbn-review-thumb-empty"></div>'}
            <div class="grabbn-review-info">
              <span class="grabbn-review-text">${escapeHtml(item.text || item.href)}</span>
              <span class="grabbn-review-href">${escapeHtml(truncate(item.href, 50))}</span>
            </div>
          </li>
        `).join('')}
      </ul>
      <div id="grabbn-review-footer">
        <div id="grabbn-review-footer-top">
          <span id="grabbn-review-count">${n} selected</span>
          <button id="grabbn-review-all">All</button>
          <button id="grabbn-review-none">None</button>
          <div id="grabbn-bucket-wrap">
            <button id="grabbn-bucket-btn" type="button">
              <span id="grabbn-bucket-label">Bucket…</span>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div id="grabbn-bucket-dropdown" class="grabbn-bucket-dropdown grabbn-hidden"></div>
          </div>
          <button id="grabbn-review-save" disabled>Save</button>
        </div>
        <div id="grabbn-review-status" class="grabbn-hidden"></div>
        <div id="grabbn-dup-warn" class="grabbn-hidden"></div>
      </div>
    `;

    reviewPanel.querySelector('#grabbn-review-close').addEventListener('click', () => {
      cancelAll();
    });

    reviewPanel.querySelectorAll('.grabbn-review-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) reviewSelectedUrls.add(cb.dataset.href);
        else reviewSelectedUrls.delete(cb.dataset.href);
        updateReviewCount();
        updateReviewSaveBtn();
      });
    });

    reviewPanel.querySelector('#grabbn-review-all').addEventListener('click', () => {
      reviewItems.forEach(i => reviewSelectedUrls.add(i.href));
      reviewPanel.querySelectorAll('.grabbn-review-cb').forEach(cb => { cb.checked = true; });
      updateReviewCount(); updateReviewSaveBtn();
    });

    reviewPanel.querySelector('#grabbn-review-none').addEventListener('click', () => {
      reviewSelectedUrls.clear();
      reviewPanel.querySelectorAll('.grabbn-review-cb').forEach(cb => { cb.checked = false; });
      updateReviewCount(); updateReviewSaveBtn();
    });

    const bucketBtn      = reviewPanel.querySelector('#grabbn-bucket-btn');
    const bucketDropdown = reviewPanel.querySelector('#grabbn-bucket-dropdown');
    bucketBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bucketDropdown.classList.toggle('grabbn-hidden');
    });
    document.addEventListener('click', closeBucketDropdown);

    reviewPanel.querySelector('#grabbn-review-save').addEventListener('click', doSave);
  }

  function closeBucketDropdown() {
    reviewPanel?.querySelector('#grabbn-bucket-dropdown')?.classList.add('grabbn-hidden');
  }

  function updateReviewCount() {
    const el = reviewPanel?.querySelector('#grabbn-review-count');
    if (el) el.textContent = `${reviewSelectedUrls.size} selected`;
  }

  function updateReviewSaveBtn() {
    const btn = reviewPanel?.querySelector('#grabbn-review-save');
    if (btn) btn.disabled = reviewSelectedUrls.size === 0 || reviewSelectedBuckets.size === 0;
  }

  async function loadReviewBuckets() {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_BUCKETS' });
    if (!reviewPanel) return;

    const dropdown = reviewPanel.querySelector('#grabbn-bucket-dropdown');
    if (!dropdown) return;

    if (!resp.ok || !resp.buckets?.length) {
      dropdown.innerHTML = '<div class="grabbn-bucket-empty">No buckets found.</div>';
      return;
    }

    reviewBucketsLoaded = resp.buckets;
    reviewSelectedBuckets.add(resp.buckets[0].name);
    updateBucketLabel();
    updateReviewSaveBtn();
    renderBucketDropdown();
  }

  function renderBucketDropdown() {
    const dropdown = reviewPanel?.querySelector('#grabbn-bucket-dropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '';
    for (const { name } of reviewBucketsLoaded) {
      const item = document.createElement('label');
      item.className = 'grabbn-bucket-option';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'grabbn-bucket-option-cb';
      cb.checked = reviewSelectedBuckets.has(name);
      cb.addEventListener('change', () => {
        if (cb.checked) reviewSelectedBuckets.add(name);
        else reviewSelectedBuckets.delete(name);
        updateBucketLabel();
        updateReviewSaveBtn();
        renderBucketDropdown();
      });
      const nameSpan = document.createElement('span');
      nameSpan.className = 'grabbn-bucket-option-name';
      nameSpan.textContent = name;
      item.appendChild(cb);
      item.appendChild(nameSpan);
      dropdown.appendChild(item);
    }
  }

  function updateBucketLabel() {
    const label = reviewPanel?.querySelector('#grabbn-bucket-label');
    if (!label) return;
    if (reviewSelectedBuckets.size === 0) {
      label.textContent = 'Bucket…';
      label.dataset.empty = '1';
    } else if (reviewSelectedBuckets.size === 1) {
      label.textContent = [...reviewSelectedBuckets][0];
      delete label.dataset.empty;
    } else {
      label.textContent = `${reviewSelectedBuckets.size} buckets`;
      delete label.dataset.empty;
    }
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  async function doSave(skipDupCheck = false) {
    if (reviewSelectedUrls.size === 0 || reviewSelectedBuckets.size === 0) return;

    const saveBtn = reviewPanel?.querySelector('#grabbn-review-save');
    const status  = reviewPanel?.querySelector('#grabbn-review-status');
    const dupWarn = reviewPanel?.querySelector('#grabbn-dup-warn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    if (dupWarn) { dupWarn.classList.add('grabbn-hidden'); dupWarn.innerHTML = ''; }

    // Wait for any pending meta fetches
    const pending = [...reviewSelectedUrls]
      .filter(href => metaRequests.has(href) && !metaCache.has(href))
      .map(href => metaRequests.get(href).catch(() => null));
    if (pending.length) {
      await Promise.race([Promise.all(pending), new Promise(r => setTimeout(r, 20000))]);
    }

    const linksPayload = await Promise.all(
      reviewItems
        .filter(i => reviewSelectedUrls.has(i.href))
        .map(async i => {
          const meta = metaCache.get(i.href) || {};
          return {
            href:   i.href,
            text:   meta.title  || i.text,
            image:  meta.image  || i.domImage || '',
            images: meta.images || [],
          };
        })
    );

    if (!skipDupCheck) {
      if (saveBtn) saveBtn.textContent = 'Checking…';
      const checkResp = await chrome.runtime.sendMessage({
        type:  'CHECK_DUPLICATES',
        hrefs: linksPayload.map(l => l.href),
      }).catch(() => ({ ok: true, duplicates: {} }));

      const dups = checkResp.duplicates || {};
      const dupEntries = Object.entries(dups).map(([href, buckets]) => {
        const item = linksPayload.find(l => l.href === href) || {};
        const label = (item.text || href).slice(0, 50) + ((item.text || href).length > 50 ? '…' : '');
        return { label, buckets };
      });

      if (dupEntries.length > 0 && dupWarn) {
        const listHtml = dupEntries.map(e =>
          `<li><strong>${e.label}</strong> — ${e.buckets.join(', ')}</li>`
        ).join('');
        dupWarn.innerHTML = `
          <p class="grabbn-dup-title">Already saved in your library:</p>
          <ul class="grabbn-dup-list">${listHtml}</ul>
          <div class="grabbn-dup-actions">
            <button id="grabbn-dup-anyway">Save anyway</button>
            <button id="grabbn-dup-cancel">Cancel</button>
          </div>`;
        dupWarn.classList.remove('grabbn-hidden');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
        dupWarn.querySelector('#grabbn-dup-anyway').addEventListener('click', () => doSave(true));
        dupWarn.querySelector('#grabbn-dup-cancel').addEventListener('click', () => {
          dupWarn.classList.add('grabbn-hidden');
          dupWarn.innerHTML = '';
        });
        return;
      }
    }

    if (saveBtn) saveBtn.textContent = 'Saving…';
    const resp = await chrome.runtime.sendMessage({
      type:        'SAVE_LINKS',
      links:       linksPayload,
      bucketNames: [...reviewSelectedBuckets],
    });

    if (resp.ok) {
      showReviewSuccess(linksPayload.length, [...reviewSelectedBuckets]);
    } else {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      if (status) {
        status.textContent = resp.error || 'Failed to save.';
        status.classList.remove('grabbn-hidden');
        status.classList.add('grabbn-status-error');
      }
    }
  }

  function showReviewSuccess(count, bucketNames) {
    if (!reviewPanel) return;
    const bucketLabel = bucketNames.length === 1
      ? `"${escapeHtml(bucketNames[0])}"`
      : `${bucketNames.length} buckets`;

    for (const { el } of highlightedEls) el.classList.remove('grabbn-link-selected');

    reviewPanel.innerHTML = `
      <div id="grabbn-review-header">
        <span id="grabbn-review-logo">${GRAB_ICON}<span>Grabbn</span></span>
      </div>
      <div id="grabbn-success">
        <div class="grabbn-success-icon">✓</div>
        <div class="grabbn-success-msg">${count} link${count !== 1 ? 's' : ''} saved to ${bucketLabel}</div>
      </div>
      <div id="grabbn-review-footer">
        <div id="grabbn-review-footer-top">
          <button id="grabbn-again-btn">Pick more</button>
          <button id="grabbn-done-btn">Done</button>
        </div>
      </div>
    `;

    reviewPanel.querySelector('#grabbn-done-btn').addEventListener('click', () => {
      removeReviewPanel();
      clearHighlightedEls();
    });
    reviewPanel.querySelector('#grabbn-again-btn').addEventListener('click', () => {
      removeReviewPanel();
      clearHighlightedEls();
      metaRequests.clear();
      metaCache.clear();
      startPickMode(siblingsActive);
    });
  }

  function removeReviewPanel() {
    document.removeEventListener('click', closeBucketDropdown);
    reviewPanel?.remove();
    reviewPanel = null;
    reviewItems          = [];
    reviewSelectedUrls   = new Set();
    reviewSelectedBuckets = new Set();
    reviewBucketsLoaded  = [];
  }

  // ---------------------------------------------------------------------------
  // Shadow-DOM-piercing query helpers
  // ---------------------------------------------------------------------------

  function deepQuerySelector(root, selector) {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const found2 = deepQuerySelector(el.shadowRoot, selector);
        if (found2) return found2;
      }
    }
    return null;
  }

  function deepQuerySelectorAll(root, selector) {
    const results = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        for (const found of deepQuerySelectorAll(el.shadowRoot, selector)) {
          results.push(found);
        }
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Image utilities
  // ---------------------------------------------------------------------------

  function extractUrlFromCssImage(value) {
    if (!value) return '';
    const m = String(value).match(/url\((['"]?)(.*?)\1\)/i);
    return m ? m[2] : '';
  }

  function normalizeImageUrl(raw) {
    if (!raw) return '';
    const value = String(raw).trim();
    if (!value) return '';
    if (value.startsWith('data:')) return value;
    if (value.startsWith('blob:')) return '';
    try { return new URL(value, location.href).href; }
    catch { return ''; }
  }

  function parseSrcsetCandidates(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return raw
      .split(',')
      .map(part => {
        const bits = part.trim().split(/\s+/).filter(Boolean);
        const url  = bits[0] || '';
        const descriptor = bits[1] || '';
        let score = 0;
        if (/^\d+w$/i.test(descriptor))          score = parseInt(descriptor, 10) || 0;
        else if (/^\d+(\.\d+)?x$/i.test(descriptor)) score = (parseFloat(descriptor) || 0) * 1000;
        return { url, score };
      })
      .filter(c => c.url)
      .sort((a, b) => b.score - a.score);
  }


  function gatherImgs(root) {
    const imgs = [...root.querySelectorAll('img')];
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) imgs.push(...el.shadowRoot.querySelectorAll('img'));
    }
    return imgs;
  }

  async function extractDomProductImage(card, href) {
    const urlScores = new Map(); // url → best score seen so far
    const pageUrl   = location.href;
    const pageRoot  = location.origin + '/';

    function addCandidate(raw, baseScore) {
      if (!raw) return;
      const url = normalizeImageUrl(String(raw).trim());
      if (!url) return;
      if (/^data:image\/gif;base64,/i.test(url)) return;
      // img.src resolves to the page URL when src="" — skip it
      if (url === pageUrl || url === pageRoot) return;
      urlScores.set(url, Math.max(urlScores.get(url) || 0, baseScore));
    }

    for (const img of gatherImgs(card)) {
      // Bonus for images that have actually loaded at a decent size
      const naturalBonus =
        img.naturalWidth > 1 && img.naturalHeight > 1
          ? Math.min((img.naturalWidth * img.naturalHeight) / 10000, 100)
          : 0;

      // Lazy-load attributes (checked before src so placeholder srcs don't win)
      const LAZY_ATTRS = [
        'data-src', 'data-lazy-src', 'data-origin-src', 'data-original',
        'data-lazy', 'data-url', 'data-image', 'data-main-image',
        'data-old-hires', 'before-src', 'data-before-src',
      ];
      for (const attr of LAZY_ATTRS) {
        const v = img.getAttribute(attr);
        if (v) { addCandidate(v, 80 + naturalBonus); break; }
      }

      // Browser-selected source (resolves picture/srcset correctly once loaded)
      if (img.currentSrc) addCandidate(img.currentSrc, 100 + naturalBonus);

      // Explicit src attribute (may be a placeholder — lower priority)
      addCandidate(img.getAttribute('src'), 60 + naturalBonus);

      // srcset on the img element itself
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
      if (srcset) {
        const best = parseSrcsetCandidates(srcset)[0];
        if (best?.url) addCandidate(best.url, 70 + naturalBonus);
      }

      // <source> elements inside a <picture> parent
      if (img.parentElement?.tagName === 'PICTURE') {
        for (const src of img.parentElement.querySelectorAll('source')) {
          const ss = src.getAttribute('srcset') || '';
          if (!ss) continue;
          const best = parseSrcsetCandidates(ss)[0];
          if (best?.url) { addCandidate(best.url, 90 + naturalBonus); break; }
        }
      }
    }

    // CSS background-image fallback (only when no <img> candidates found)
    if (!urlScores.size) {
      for (const el of card.querySelectorAll('*')) {
        const bg  = extractUrlFromCssImage(window.getComputedStyle(el).backgroundImage || '');
        const url = normalizeImageUrl(bg);
        if (url && url !== pageUrl) { urlScores.set(url, 20); break; }
      }
    }

    // YouTube: derive thumbnail from video ID in the href
    if (!urlScores.size && href) {
      const ytId = new URLSearchParams(new URL(href, location.href).search).get('v');
      if (ytId) urlScores.set(`https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`, 50);
    }

    if (!urlScores.size) return null;
    const [bestUrl] = [...urlScores.entries()].sort((a, b) => b[1] - a[1]);
    return { image: bestUrl[0], source: 'dom_image_url' };
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function truncate(str, n) { return str.length > n ? str.slice(0, n) + '…' : str; }

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_PICK_MODE') startPickMode(msg.siblingsActive !== false);
  });
}
