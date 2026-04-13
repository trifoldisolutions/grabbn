// Repository detail page — bucket-oriented
(function () {
    const domain       = window.__REPO_DOMAIN__;
    const tag          = window.__REPO_TAG__;
    const bucketsEl    = document.getElementById('repo-buckets');
    const metaEl       = document.getElementById('repo-meta');
    const emptyEl      = document.getElementById('repo-empty');
    const errorEl      = document.getElementById('repo-error');

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

    // ── Bucket card builder ───────────────────────────────────────────────────

    function createBucketCard(b) {
        const card = document.createElement('a');
        card.href      = `/v2/b/${b._id}`;
        card.className = 'group flex flex-col rounded-xl bg-white border border-gray-100 overflow-hidden hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 cursor-pointer';

        // ── Thumbnail ─────────────────────────────────────────────────────────
        let thumbHtml;
        if (b.thumbnail) {
            // Uploaded thumbnail
            thumbHtml = `<img src="/v2/b/${b._id}/thumbnail.jpg" alt="" loading="lazy" class="w-full aspect-video object-cover bg-gray-100" />`;
        } else {
            // Fall back to 2×2 mosaic from link images
            const imgLinks = (b.links || []).filter(l => l.image).slice(0, 4);
            if (imgLinks.length) {
                const cells = Array.from({ length: 4 }, (_, i) => {
                    const l = imgLinks[i];
                    return l
                        ? `<div class="overflow-hidden bg-gray-100"><img src="${escAttr(l.image)}" alt="" loading="lazy" class="w-full h-full object-cover" /></div>`
                        : `<div class="bg-silver-100"></div>`;
                });
                thumbHtml = `<div class="grid grid-cols-2 gap-0.5 aspect-video">${cells.join('')}</div>`;
            } else {
                // No images at all — gradient block with initial
                const initial = escHtml((b.name || '?')[0].toUpperCase());
                thumbHtml = `<div class="w-full aspect-video bg-gradient-to-br from-orchid-50 to-orchid-100 flex items-center justify-center">
                    <span class="text-4xl font-black text-orchid-300 select-none">${initial}</span>
                </div>`;
            }
        }

        // ── Curator ───────────────────────────────────────────────────────────
        const cu    = b.userId;
        const uname = cu?.username || 'unknown';
        const avatarHtml = cu?.avatar
            ? `<img src="${escAttr(cu.avatar)}" alt="" class="w-5 h-5 rounded-full object-cover shrink-0" />`
            : `<div class="w-5 h-5 rounded-full bg-orchid-100 flex items-center justify-center shrink-0">
                   <span class="text-[10px] font-bold text-orchid-500">${escHtml(uname[0]?.toUpperCase() || '?')}</span>
               </div>`;

        // ── Stats ─────────────────────────────────────────────────────────────
        const linkCount = b.links?.length      ?? 0;
        const grabCount = b.grabbedBy?.length  ?? 0;
        const viewCount = b.viewCount          ?? 0;

        const descHtml = b.description
            ? `<p class="text-xs text-gray-400 line-clamp-2 leading-relaxed">${escHtml(b.description)}</p>`
            : '';

        card.innerHTML = `
            ${thumbHtml}
            <div class="flex flex-col gap-2 p-3 flex-1">
                <p class="text-sm font-semibold text-woodsmoke-950 group-hover:text-orchid-700 transition-colors line-clamp-2 leading-snug">${escHtml(b.name)}</p>
                ${descHtml}
                <div class="flex items-center justify-between mt-auto pt-1.5 border-t border-gray-50">
                    <div class="flex items-center gap-1.5 min-w-0">
                        ${avatarHtml}
                        <span class="text-xs text-gray-400 truncate">@${escHtml(uname)}</span>
                    </div>
                    <div class="flex items-center gap-2.5 shrink-0 text-xs text-gray-400">
                        <span title="Links">${linkCount} lnk</span>
                        <span title="Grabs">${formatNum(grabCount)} grb</span>
                    </div>
                </div>
            </div>`;

        return card;
    }

    // ── Load ──────────────────────────────────────────────────────────────────

    async function load() {
        try {
            const res = await fetch(`/api/v2/repositories/${encodeURIComponent(domain)}/${encodeURIComponent(tag)}`);

            if (res.status === 404) {
                emptyEl.classList.remove('hidden');
                return;
            }
            if (!res.ok) throw new Error('Request failed');

            const repo = await res.json();

            // Meta bar
            const bc = repo.topBuckets?.length ?? 0;
            metaEl.textContent = `${bc} bucket${bc !== 1 ? 's' : ''} · ${formatNum(repo.totalClicks)} clicks`;

            // ── Primary: bucket grid ──────────────────────────────────────────
            if (bc > 0) {
                bucketsEl.innerHTML = '';
                repo.topBuckets.forEach(b => bucketsEl.appendChild(createBucketCard(b)));
            } else {
                emptyEl.classList.remove('hidden');
                return;
            }

        } catch (e) {
            console.error('Repository load error:', e);
            errorEl.classList.remove('hidden');
        }
    }

    load();
})();
