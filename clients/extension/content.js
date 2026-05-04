// Guard against double-injection
if (window.__grabbnInjected) {
  chrome.runtime.sendMessage({ type: 'START_PICK_MODE' });
} else {
  window.__grabbnInjected = true;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let pickModeActive = false;
  let hoveredLink = null;
  let selPanel = null;       // floating selection panel
  let bucketOverlay = null;  // final bucket-picker overlay
  let selectedLinks = [];    // { href, text, element, domImagePromise }
  const metaRequests = new Map(); // href → Promise<resp>
  const metaCache    = new Map(); // href → resolved meta object

  // ---------------------------------------------------------------------------
  // Pick mode
  // ---------------------------------------------------------------------------

  function startPickMode() {
    if (pickModeActive) return;
    pickModeActive = true;
    selectedLinks = [];
    metaRequests.clear();
    metaCache.clear();
    removeSelPanel();
    document.body.classList.add('grabbn-pick-mode');
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onLinkClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    showHint('Click links to select · Esc to cancel');
  }

  function stopPickMode() {
    pickModeActive = false;
    document.body.classList.remove('grabbn-pick-mode');
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onLinkClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    clearHighlight();
    removeHint();
  }

  function cancelSelection() {
    for (const { element } of selectedLinks) element.classList.remove('grabbn-link-selected');
    selectedLinks = [];
    metaRequests.clear();
    metaCache.clear();
    removeSelPanel();
    stopPickMode();
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function onMouseOver(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    clearHighlight();
    hoveredLink = link;
    link.classList.add('grabbn-link-hover');
  }

  function onMouseOut(e) {
    const link = e.target.closest('a[href]');
    if (link) link.classList.remove('grabbn-link-hover');
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (bucketOverlay) { removeBucketOverlay(); }
      else { cancelSelection(); }
    }
  }

  const MAX_SELECTION = 100;

  function onLinkClick(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();

    const href = link.href;
    const existingIdx = selectedLinks.findIndex(l => l.href === href);

    if (existingIdx >= 0) {
      selectedLinks[existingIdx].element.classList.remove('grabbn-link-selected');
      selectedLinks.splice(existingIdx, 1);
    } else {
      if (selectedLinks.length >= MAX_SELECTION) {
        showSelPanelError(`Max ${MAX_SELECTION} links per batch.`);
        return;
      }
      link.classList.add('grabbn-link-selected');
      const domImagePromise = extractDomProductImage(link).catch(() => null);
      selectedLinks.push({
        href,
        text: link.textContent.trim().replace(/\s+/g, ' ').slice(0, 200),
        element: link,
        domImagePromise,
      });
      fetchMetaForHref(href);
    }
    updateSelPanel();
  }

  function fetchMetaForHref(href) {
    if (metaRequests.has(href)) return;
    const p = new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_META', url: href }, (resp) => {
        if (resp?.ok) {
          metaCache.set(href, {
            title: resp.title,
            image: resp.image,
            images: resp.images || [],
            provider: resp.provider,
            imageStatus: resp.imageStatus,
            imageReason: resp.imageReason,
          });
        } else if (resp?.error === 'rate_daily') {
          metaCache.set(href, { error: 'rate_daily', used: resp.used, limit: resp.limit });
        }
        resolve(resp || null);
      });
    });
    metaRequests.set(href, p);
  }

  function clearHighlight() {
    if (hoveredLink) { hoveredLink.classList.remove('grabbn-link-hover'); hoveredLink = null; }
  }

  // ---------------------------------------------------------------------------
  // Hint
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
  // Selection panel
  // ---------------------------------------------------------------------------

  function updateSelPanel() {
    if (!selectedLinks.length) {
      removeSelPanel();
      showHint('Click links to select · Esc to cancel');
      return;
    }
    removeHint();
    if (!selPanel) {
      selPanel = document.createElement('div');
      selPanel.id = 'grabbn-sel-panel';
      document.body.appendChild(selPanel);
    }
    const n = selectedLinks.length;
    selPanel.innerHTML = `
      <div id="grabbn-sel-header">
        <span id="grabbn-sel-logo">${GRAB_ICON}<span>Grabbn</span></span>
        <span id="grabbn-sel-count">${n} / ${MAX_SELECTION} selected</span>
      </div>
      <ul id="grabbn-sel-list">
        ${selectedLinks.map((l, i) => `
          <li class="grabbn-sel-row" data-idx="${i}">
            <input type="checkbox" class="grabbn-sel-cb" data-href="${escapeHtml(l.href)}" checked />
            <span class="grabbn-sel-row-text" title="${escapeHtml(l.href)}">${escapeHtml(l.text || truncate(l.href, 44))}</span>
          </li>
        `).join('')}
      </ul>
      <div id="grabbn-sel-footer">
        <button id="grabbn-sel-cancel">Cancel</button>
        <button id="grabbn-sel-save">Save ${n} link${n !== 1 ? 's' : ''}</button>
      </div>
    `;
    selPanel.querySelector('#grabbn-sel-cancel').addEventListener('click', cancelSelection);
    selPanel.querySelector('#grabbn-sel-save').addEventListener('click', showBucketPicker);
    selPanel.querySelectorAll('.grabbn-sel-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (!cb.checked) {
          const idx = selectedLinks.findIndex(l => l.href === cb.dataset.href);
          if (idx >= 0) {
            selectedLinks[idx].element.classList.remove('grabbn-link-selected');
            selectedLinks.splice(idx, 1);
          }
          updateSelPanel();
        }
      });
    });
  }

  function removeSelPanel() { selPanel?.remove(); selPanel = null; }

  function showSelPanelError(msg) {
    if (!selPanel) return;
    let err = selPanel.querySelector('#grabbn-sel-error');
    if (!err) {
      err = document.createElement('div');
      err.id = 'grabbn-sel-error';
      selPanel.querySelector('#grabbn-sel-footer').before(err);
    }
    err.textContent = msg;
    clearTimeout(err._t);
    err._t = setTimeout(() => err.remove(), 2500);
  }

  // ---------------------------------------------------------------------------
  // Bucket picker overlay
  // ---------------------------------------------------------------------------

  const GRAB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
    <g fill="none" fill-rule="evenodd">
      <path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/>
      <path fill="currentColor" d="M17.961 7.058a2.5 2.5 0 0 0-3.349-1.896a2.498 2.498 0 0 0-4.225 0A2.5 2.5 0 0 0 7 7.5l.001.962a4.7 4.7 0 0 0-.87-.584C5.11 7.36 4.12 7.44 3.077 7.866c-.84.345-1.107 1.308-.747 2.028l2.842 5.684A8 8 0 0 0 12.326 20H13a8 8 0 0 0 8-8V9.5a2.5 2.5 0 0 0-3.039-2.442M10 7.5a.5.5 0 1 0-1 0V11a1 1 0 0 1-1.78.625c-.925-1.156-1.517-1.72-1.995-1.964a1.2 1.2 0 0 0-.835-.117l2.57 5.14A6 6 0 0 0 12.326 18H13a6 6 0 0 0 6-6V9.5a.5.5 0 1 0-1 0v.5a1 1 0 1 1-2 0V7.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0V6.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0z"/>
    </g>
  </svg>`;

  async function showBucketPicker() {
    removeBucketOverlay();
    const n = selectedLinks.length;
    if (!n) return;

    bucketOverlay = document.createElement('div');
    bucketOverlay.id = 'grabbn-overlay';
    bucketOverlay.innerHTML = `
      <div id="grabbn-modal">
        <div id="grabbn-modal-header">
          <span id="grabbn-modal-logo">${GRAB_ICON}<span>Grabbn</span></span>
          <button id="grabbn-close">✕</button>
        </div>
        <div id="grabbn-link-preview">${n} link${n !== 1 ? 's' : ''} ready to save</div>
        <div id="grabbn-bucket-list"><div class="grabbn-loading">Loading buckets…</div></div>
        <div id="grabbn-footer" style="display:none">
          <span id="grabbn-selected-count">0 buckets</span>
          <button id="grabbn-save-btn" disabled>Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(bucketOverlay);
    bucketOverlay.querySelector('#grabbn-close').addEventListener('click', removeBucketOverlay);
    bucketOverlay.addEventListener('click', e => { if (e.target === bucketOverlay) removeBucketOverlay(); });

    const resp = await chrome.runtime.sendMessage({ type: 'GET_BUCKETS' });
    const list = bucketOverlay?.querySelector('#grabbn-bucket-list');
    if (!list) return;

    if (!resp.ok || !resp.buckets?.length) {
      list.innerHTML = '<div class="grabbn-empty">No buckets found. Create one on Grabbn first.</div>';
      return;
    }

    list.innerHTML = '';
    const footer = bucketOverlay.querySelector('#grabbn-footer');
    const saveBtn = bucketOverlay.querySelector('#grabbn-save-btn');
    const countEl = bucketOverlay.querySelector('#grabbn-selected-count');
    footer.style.display = 'flex';

    resp.buckets.forEach(({ name, linkCount, thumbnail }) => {
      const row = document.createElement('label');
      row.className = 'grabbn-bucket-row';
      row.innerHTML = `
        <input type="checkbox" class="grabbn-cb" value="${escapeHtml(name)}" />
        ${thumbnail
          ? `<img class="grabbn-bucket-thumb" src="${escapeHtml(thumbnail)}" alt="" />`
          : `<div class="grabbn-bucket-thumb grabbn-bucket-thumb-empty"></div>`}
        <span class="grabbn-bucket-name">${escapeHtml(name)}</span>
        <span class="grabbn-bucket-count">${linkCount ?? 0}</span>
      `;
      list.appendChild(row);
    });

    list.addEventListener('change', () => {
      const checked = list.querySelectorAll('.grabbn-cb:checked');
      countEl.textContent = checked.length === 1 ? '1 bucket' : `${checked.length} buckets`;
      saveBtn.disabled = checked.length === 0;
    });

    saveBtn.addEventListener('click', () => {
      const bucketNames = [...list.querySelectorAll('.grabbn-cb:checked')].map(cb => cb.value);
      if (!bucketNames.length) return;
      saveAllLinks(bucketNames);
    });
  }

  function removeBucketOverlay() { bucketOverlay?.remove(); bucketOverlay = null; }

  // ---------------------------------------------------------------------------
  // Save all selected links
  // ---------------------------------------------------------------------------

  async function saveAllLinks(bucketNames) {
    const saveBtn = bucketOverlay?.querySelector('#grabbn-save-btn');
    const n = selectedLinks.length;

    // Wait for any still-pending meta fetches (up to 20 s total)
    const pendingPromises = selectedLinks
      .filter(l => metaRequests.has(l.href) && !metaCache.has(l.href))
      .map(l => metaRequests.get(l.href).catch(() => null));

    if (pendingPromises.length) {
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Fetching images…'; }
      await Promise.race([
        Promise.all(pendingPromises),
        new Promise(r => setTimeout(r, 20000)),
      ]);
    }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = `Saving ${n} link${n !== 1 ? 's' : ''}…`; }

    const linksPayload = await Promise.all(selectedLinks.map(async (entry) => {
      let meta = metaCache.get(entry.href) || {};
      if (!meta.image && entry.domImagePromise) {
        const domImage = await entry.domImagePromise.catch(() => null);
        if (domImage) meta = { ...meta, image: domImage.image };
      }
      return {
        href: entry.href,
        text: meta.title || entry.text,
        image: meta.image || '',
        images: meta.images || [],
      };
    }));

    const resp = await chrome.runtime.sendMessage({
      type: 'SAVE_LINKS',
      links: linksPayload,
      bucketNames,
    });

    if (!bucketOverlay) return;

    if (resp.ok) {
      showSuccessState(n, bucketNames);
    } else {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = `Save ${n} link${n !== 1 ? 's' : ''}`; }
      showInlineError(resp.error || 'Failed to save');
    }
  }

  function showSuccessState(linkCount, bucketNames) {
    if (!bucketOverlay) return;
    const modal = bucketOverlay.querySelector('#grabbn-modal');
    const bucketLabel = bucketNames.length === 1
      ? `"${escapeHtml(bucketNames[0])}"`
      : `${bucketNames.length} buckets`;
    modal.innerHTML = `
      <div id="grabbn-modal-header">
        <span id="grabbn-modal-logo">${GRAB_ICON}<span>Grabbn</span></span>
        <button id="grabbn-close">✕</button>
      </div>
      <div id="grabbn-success">
        <div class="grabbn-success-icon">✓</div>
        <div class="grabbn-success-msg">${linkCount} link${linkCount !== 1 ? 's' : ''} saved to ${bucketLabel}</div>
      </div>
      <div id="grabbn-footer" style="display:flex">
        <button id="grabbn-again-btn">Pick more links</button>
        <button id="grabbn-done-btn">Done</button>
      </div>
    `;
    for (const { element } of selectedLinks) element.classList.remove('grabbn-link-selected');
    selectedLinks = [];
    metaRequests.clear();
    metaCache.clear();
    removeSelPanel();

    modal.querySelector('#grabbn-close').addEventListener('click', () => { removeBucketOverlay(); stopPickMode(); });
    modal.querySelector('#grabbn-done-btn').addEventListener('click', () => { removeBucketOverlay(); stopPickMode(); });
    modal.querySelector('#grabbn-again-btn').addEventListener('click', () => {
      removeBucketOverlay();
      startPickMode();
    });
  }

  function showInlineError(msg) {
    if (!bucketOverlay) return;
    let err = bucketOverlay.querySelector('#grabbn-inline-error');
    if (!err) {
      err = document.createElement('div');
      err.id = 'grabbn-inline-error';
      bucketOverlay.querySelector('#grabbn-footer').before(err);
    }
    err.textContent = msg;
  }

  // ---------------------------------------------------------------------------
  // Image utilities (unchanged)
  // ---------------------------------------------------------------------------

  function isVisibleElement(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;
    if (rect.bottom <= 0 || rect.right <= 0) return false;
    if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.05;
  }

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
    if (value.startsWith('blob:')) return ''; // browser-only, useless to the server
    try { return new URL(value, location.href).href; }
    catch { return ''; }
  }

  function parseSrcsetCandidates(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return raw
      .split(',')
      .map(part => {
        const bits = part.trim().split(/\s+/).filter(Boolean);
        const url = bits[0] || '';
        const descriptor = bits[1] || '';
        let score = 0;
        if (/^\d+w$/i.test(descriptor)) score = parseInt(descriptor, 10) || 0;
        else if (/^\d+(\.\d+)?x$/i.test(descriptor)) score = (parseFloat(descriptor) || 0) * 1000;
        return { url, score };
      })
      .filter(candidate => candidate.url)
      .sort((a, b) => b.score - a.score);
  }

  function getElementImageUrl(el) {
    if (!el) return '';

    const directCandidates = [
      el.getAttribute?.('data-old-hires'),
      el.getAttribute?.('src'),
      el.getAttribute?.('data-src'),
      el.getAttribute?.('data-origin-src'),
      el.getAttribute?.('data-lazy-src'),
      el.getAttribute?.('data-main-image'),
      el.getAttribute?.('before-src'),
      el.getAttribute?.('data-before-src'),
      el.getAttribute?.('data-original'),
      el.getAttribute?.('data-image'),
      el.currentSrc,
      el.src,
    ];
    const attrCandidates = [];

    const srcset = el.getAttribute?.('srcset') || el.getAttribute?.('data-srcset') || '';
    if (srcset) {
      parseSrcsetCandidates(srcset).forEach(candidate => attrCandidates.push(candidate.url));
    }
    directCandidates.forEach(candidate => attrCandidates.push(candidate));

    const bg = extractUrlFromCssImage(el.style?.backgroundImage || '');
    const computedBg = extractUrlFromCssImage(window.getComputedStyle(el).backgroundImage || '');
    if (bg) attrCandidates.push(bg);
    if (computedBg) attrCandidates.push(computedBg);

    for (const candidate of attrCandidates) {
      const normalized = normalizeImageUrl(candidate);
      if (normalized && !/^data:image\/gif;base64,/i.test(normalized)) return normalized;
    }

    return '';
  }

  function getCandidateImages(link) {
    const candidates = [];
    const seen = new Set();

    function addImage(img, baseScore) {
      if (!img || seen.has(img) || !isVisibleElement(img)) return;
      const url = getElementImageUrl(img);
      if (!url) return;
      seen.add(img);
      const rect = img.getBoundingClientRect();
      const area = rect.width * rect.height;
      const naturalArea = (img.naturalWidth || 0) * (img.naturalHeight || 0);
      const linkRect = link.getBoundingClientRect();
      const imgCx = rect.left + rect.width / 2;
      const imgCy = rect.top + rect.height / 2;
      const linkCx = linkRect.left + linkRect.width / 2;
      const linkCy = linkRect.top + linkRect.height / 2;
      const distance = Math.hypot(imgCx - linkCx, imgCy - linkCy);
      candidates.push({
        url,
        rect,
        score: baseScore + Math.min(area / 5000, 120) + Math.min(naturalArea / 50000, 80) - Math.min(distance / 8, 120),
      });
    }

    link.querySelectorAll('img').forEach(img => addImage(img, 400));
    let current = link;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      current.querySelectorAll('img').forEach(img => addImage(img, 300 - depth * 25));
    }

    const linkAncestors = new Set();
    let lcaEl = link;
    while (lcaEl) { linkAncestors.add(lcaEl); lcaEl = lcaEl.parentElement; }

    let lcaBestImg = null, lcaBestDepth = Infinity;
    for (const img of document.querySelectorAll('img')) {
      const r = img.getBoundingClientRect();
      if (r.width < 60 || r.height < 60 || r.bottom <= 0 || r.top >= window.innerHeight) continue;
      let el = img.parentElement;
      let depth = 0;
      while (el && depth < 15) {
        if (linkAncestors.has(el)) {
          if (depth < lcaBestDepth) { lcaBestDepth = depth; lcaBestImg = img; }
          break;
        }
        depth++;
        el = el.parentElement;
      }
    }
    if (lcaBestImg) addImage(lcaBestImg, 520);

    [
      '#landingImage',
      '#imgTagWrapperId img',
      '#main-image-container img',
      '#imageBlock img',
      '.product-intro__main img',
      '.product-intro__thumbs-item--main img',
      '[class*="product-intro__main"] img',
      '[class*="main-swiper"] img',
      '.crop-image-container img',
    ].forEach(selector => {
      document.querySelectorAll(selector).forEach(img => addImage(img, 260));
    });

    return candidates.sort((a, b) => b.score - a.score);
  }

  async function extractDomProductImage(link) {
    const candidates = getCandidateImages(link);
    if (!candidates.length) return null;
    return { image: candidates[0].url, source: 'dom_image_url' };
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
    if (msg.type === 'START_PICK_MODE') startPickMode();
  });
}
