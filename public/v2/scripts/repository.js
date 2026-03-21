// Repository detail page
(function () {
    const domain    = window.__REPO_DOMAIN__;
    const linksEl   = document.getElementById('repo-links');
    const metaEl    = document.getElementById('repo-meta');
    const emptyEl   = document.getElementById('repo-empty');
    const errorEl   = document.getElementById('repo-error');

    // ── Helpers ───────────────────────────────────────────────────────────────

    function formatNum(n) {
        n = Number(n) || 0;
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1_000)     return (n / 1_000).toFixed(2).replace(/\.?0+$/, '')   + 'K';
        return String(n);
    }

    function escHtml(str) {
        return String(str).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
    }

    function escAttr(str) {
        return String(str).replace(/"/g, '&quot;');
    }

    // ── Link row builder ──────────────────────────────────────────────────────

    function createLinkRow(link) {
        const row = document.createElement('a');
        row.href      = link.href;
        row.target    = '_blank';
        row.rel       = 'noopener noreferrer';
        row.className = 'flex items-center gap-3 px-4 py-3 bg-white rounded-lg border border-gray-100 hover:border-orchid-200 hover:shadow-sm transition-all group';

        // Fire click tracking (fire-and-forget via beacon — no bucketId available on
        // the repo page, so we use a placeholder 'repo' source identifier)
        row.addEventListener('click', function () {
            navigator.sendBeacon('/api/links/click', new Blob([
                JSON.stringify({ href: link.href, bucketId: '000000000000000000000000' })
            ], { type: 'application/json' }));
        });

        const thumb = link.image
            ? `<img src="${escAttr(link.image)}" alt="" loading="lazy" class="w-14 h-10 object-cover rounded-md shrink-0 bg-gray-100" />`
            : `<div class="w-14 h-10 rounded-md bg-silver-100 flex items-center justify-center shrink-0">
                   <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" class="text-gray-300" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M20 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2H4v10.1l4.995-4.994a1.25 1.25 0 0 1 1.768 0l4.065 4.066l1.238-1.238a1.25 1.25 0 0 1 1.768 0L20 15.101zm-4.5 2a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3"/></g></svg>
               </div>`;

        row.innerHTML = `
            ${thumb}
            <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-woodsmoke-950 group-hover:text-orchid-700 transition-colors truncate">
                    ${escHtml(link.text || link.href)}
                </p>
                <p class="text-xs text-gray-400 truncate mt-0.5">${escHtml(link.href)}</p>
            </div>
            <div class="flex flex-col items-end gap-1 shrink-0">
                <span class="text-xs font-semibold text-orchid-600">${formatNum(link.totalClicks)} clicks</span>
                <span class="text-xs text-gray-300">${link.bucketSpread} bucket${link.bucketSpread !== 1 ? 's' : ''}</span>
            </div>
            <svg class="w-4 h-4 text-gray-300 group-hover:text-orchid-400 transition-colors shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>`;

        return row;
    }

    // ── Load ──────────────────────────────────────────────────────────────────

    async function load() {
        try {
            const res = await fetch(`/api/v2/repositories/${encodeURIComponent(domain)}`);
            if (res.status === 404) {
                emptyEl.classList.remove('hidden');
                metaEl.textContent = 'No data yet';
                return;
            }
            if (!res.ok) throw new Error('Request failed');

            const repo = await res.json();

            metaEl.textContent = `${formatNum(repo.totalClicks)} clicks · ${formatNum(repo.bucketCount)} bucket${repo.bucketCount !== 1 ? 's' : ''}`;

            if (!repo.topLinks || repo.topLinks.length === 0) {
                emptyEl.classList.remove('hidden');
                return;
            }

            linksEl.innerHTML = '';
            repo.topLinks.forEach(link => linksEl.appendChild(createLinkRow(link)));
        } catch (e) {
            console.error('Repository load error:', e);
            errorEl.classList.remove('hidden');
            metaEl.textContent = '';
        }
    }

    load();
})();
