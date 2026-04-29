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
  let overlay = null;

  // ---------------------------------------------------------------------------
  // Pick mode
  // ---------------------------------------------------------------------------

  function startPickMode() {
    if (pickModeActive) return;
    pickModeActive = true;
    window.__grabbnLastMeta = null;
    document.body.classList.add('grabbn-pick-mode');
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onLinkClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    showHint('Click any link to save it · Esc to cancel');
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
      if (overlay) { removeOverlay(); }
      else { stopPickMode(); }
    }
  }

  function onLinkClick(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    stopPickMode();
    showOverlay(link.href, link.textContent.trim().slice(0, 200));
    // Kick off meta fetch in background immediately; result used at save time
    chrome.runtime.sendMessage({ type: 'GET_META', url: link.href }, (resp) => {
      if (resp?.ok) {
        window.__grabbnLastMeta = { title: resp.title, image: resp.image };
        // Update preview text if we got a better title
        const preview = document.getElementById('grabbn-link-preview');
        if (preview && resp.title) preview.textContent = resp.title;
      }
    });
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
  // Overlay — bucket picker
  // ---------------------------------------------------------------------------

  const GRAB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
    <g fill="none" fill-rule="evenodd">
      <path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/>
      <path fill="currentColor" d="M17.961 7.058a2.5 2.5 0 0 0-3.349-1.896a2.498 2.498 0 0 0-4.225 0A2.5 2.5 0 0 0 7 7.5l.001.962a4.7 4.7 0 0 0-.87-.584C5.11 7.36 4.12 7.44 3.077 7.866c-.84.345-1.107 1.308-.747 2.028l2.842 5.684A8 8 0 0 0 12.326 20H13a8 8 0 0 0 8-8V9.5a2.5 2.5 0 0 0-3.039-2.442M10 7.5a.5.5 0 1 0-1 0V11a1 1 0 0 1-1.78.625c-.925-1.156-1.517-1.72-1.995-1.964a1.2 1.2 0 0 0-.835-.117l2.57 5.14A6 6 0 0 0 12.326 18H13a6 6 0 0 0 6-6V9.5a.5.5 0 1 0-1 0v.5a1 1 0 1 1-2 0V7.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0V6.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0z"/>
    </g>
  </svg>`;

  async function showOverlay(href, text) {
    removeOverlay();

    overlay = document.createElement('div');
    overlay.id = 'grabbn-overlay';
    overlay.innerHTML = `
      <div id="grabbn-modal">
        <div id="grabbn-modal-header">
          <span id="grabbn-modal-logo">${GRAB_ICON}<span>Grabbn</span></span>
          <button id="grabbn-close">✕</button>
        </div>
        <div id="grabbn-link-preview" title="${escapeHtml(href)}">${escapeHtml(truncate(href, 58))}</div>
        <div id="grabbn-bucket-list"><div class="grabbn-loading">Loading buckets…</div></div>
        <div id="grabbn-footer" style="display:none">
          <span id="grabbn-selected-count">0 selected</span>
          <button id="grabbn-save-btn" disabled>Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#grabbn-close').addEventListener('click', removeOverlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) removeOverlay(); });

    const resp = await chrome.runtime.sendMessage({ type: 'GET_BUCKETS' });
    const list = overlay.querySelector('#grabbn-bucket-list');

    if (!resp.ok || !resp.buckets?.length) {
      list.innerHTML = '<div class="grabbn-empty">No buckets found. Create one on Grabbn first.</div>';
      return;
    }

    list.innerHTML = '';
    const footer = overlay.querySelector('#grabbn-footer');
    const saveBtn = overlay.querySelector('#grabbn-save-btn');
    const countEl = overlay.querySelector('#grabbn-selected-count');
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
      countEl.textContent = checked.length === 1 ? '1 selected' : `${checked.length} selected`;
      saveBtn.disabled = checked.length === 0;
    });

    saveBtn.addEventListener('click', () => {
      const bucketNames = [...list.querySelectorAll('.grabbn-cb:checked')].map(cb => cb.value);
      if (!bucketNames.length) return;
      saveLink(href, text, bucketNames);
    });
  }

  function removeOverlay() { overlay?.remove(); overlay = null; }

  async function saveLink(href, text, bucketNames) {
    const saveBtn = overlay?.querySelector('#grabbn-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const meta = window.__grabbnLastMeta || {};
    const image = meta.image || '';
    const resolvedText = meta.title || text;
    const resp = await chrome.runtime.sendMessage({ type: 'SAVE_LINK', href, text: resolvedText, image, bucketNames });

    if (!overlay) return; // dismissed while saving

    if (resp.ok) {
      showSuccessState(bucketNames);
    } else {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      showInlineError(resp.error || 'Failed to save');
    }
  }

  function showSuccessState(bucketNames) {
    if (!overlay) return;
    const modal = overlay.querySelector('#grabbn-modal');
    modal.innerHTML = `
      <div id="grabbn-modal-header">
        <span id="grabbn-modal-logo">${GRAB_ICON}<span>Grabbn</span></span>
        <button id="grabbn-close">✕</button>
      </div>
      <div id="grabbn-success">
        <div class="grabbn-success-icon">✓</div>
        <div class="grabbn-success-msg">Saved to ${bucketNames.length === 1 ? `"${escapeHtml(bucketNames[0])}"` : `${bucketNames.length} buckets`}</div>
      </div>
      <div id="grabbn-footer" style="display:flex">
        <button id="grabbn-again-btn">Pick another link</button>
        <button id="grabbn-done-btn">Done</button>
      </div>
    `;
    modal.querySelector('#grabbn-close').addEventListener('click', removeOverlay);
    modal.querySelector('#grabbn-done-btn').addEventListener('click', removeOverlay);
    modal.querySelector('#grabbn-again-btn').addEventListener('click', () => {
      removeOverlay();
      startPickMode();
    });
  }

  function showInlineError(msg) {
    let err = overlay?.querySelector('#grabbn-inline-error');
    if (!err) {
      err = document.createElement('div');
      err.id = 'grabbn-inline-error';
      overlay.querySelector('#grabbn-footer').before(err);
    }
    err.textContent = msg;
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
