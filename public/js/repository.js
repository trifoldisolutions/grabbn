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

    // ── SVG assets ────────────────────────────────────────────────────────────

    const NO_THUMB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" class="text-gray-400" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M20 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2H4v10.1l4.995-4.994a1.25 1.25 0 0 1 1.768 0l4.065 4.066l1.238-1.238a1.25 1.25 0 0 1 1.768 0L20 15.101zm-4.5 2a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3"/></g></svg>`;

    const GRAB_BTN_ICON_DEFAULT = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none" fill-rule="evenodd"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M17.961 7.058a2.5 2.5 0 0 0-3.349-1.896a2.498 2.498 0 0 0-4.225 0A2.5 2.5 0 0 0 7 7.5l.001.962a4.7 4.7 0 0 0-.87-.584C5.11 7.36 4.12 7.44 3.077 7.866c-.84.345-1.107 1.308-.747 2.028l2.842 5.684A8 8 0 0 0 12.326 20H13a8 8 0 0 0 8-8V9.5a2.5 2.5 0 0 0-3.039-2.442M10 7.5a.5.5 0 1 0-1 0V11a1 1 0 0 1-1.78.625c-.925-1.156-1.517-1.72-1.995-1.964a1.2 1.2 0 0 0-.835-.117l2.57 5.14A6 6 0 0 0 12.326 18H13a6 6 0 0 0 6-6V9.5a.5.5 0 1 0-1 0v.5a1 1 0 1 1-2 0V7.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0V6.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0z"/></g></svg>`;

    const GRAB_BTN_ICON_GRABBED = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M15.5 5a2.5 2.5 0 0 1 2.461 2.058A2.5 2.5 0 0 1 21 9.5V12a8 8 0 0 1-8 8h-.674a8 8 0 0 1-7.155-4.422L2.329 9.894c-.36-.72-.093-1.683.747-2.028c1.043-.427 2.034-.507 3.055.012q.443.227.869.584V7.5a2.5 2.5 0 0 1 3.388-2.338a2.498 2.498 0 0 1 4.224 0A2.5 2.5 0 0 1 15.5 5"/></g></svg>`;

    const SPINNER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><circle cx="4" cy="12" r="3" fill="currentColor"><animate id="a" attributeName="r" begin="0;b.end-0.25s" dur="0.75s" values="3;.2;3"/></circle><circle cx="12" cy="12" r="3" fill="currentColor"><animate attributeName="r" begin="a.end-0.6s" dur="0.75s" values="3;.2;3"/></circle><circle cx="20" cy="12" r="3" fill="currentColor"><animate id="b" attributeName="r" begin="a.end-0.45s" dur="0.75s" values="3;.2;3"/></circle></svg>`;

    const VIEW_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M12 5c3.679 0 8.162 2.417 9.73 5.901c.146.328.27.71.27 1.099c0 .388-.123.771-.27 1.099C20.161 16.583 15.678 19 12 19s-8.162-2.417-9.73-5.901C2.124 12.77 2 12.389 2 12c0-.388.123-.771.27-1.099C3.839 7.417 8.322 5 12 5m0 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8m0 2a2 2 0 1 1 0 4a2 2 0 0 1 0-4"/></g></svg>`;

    const SHARE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M14.055 3.38a1 1 0 0 1 1.09.217l6 6a1 1 0 0 1 0 1.414l-6 6A1 1 0 0 1 13.5 16.5V14c-3.53.26-6.212 1.493-8.144 3.764a1 1 0 0 1-1.743-.578C3.117 12.568 5.259 7.44 13.5 6.03V3.5a1 1 0 0 1 .555-.12"/></g></svg>`;

    const MORE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M5 10a2 2 0 1 1 0 4a2 2 0 0 1 0-4m7 0a2 2 0 1 1 0 4a2 2 0 0 1 0-4m7 0a2 2 0 1 1 0 4a2 2 0 0 1 0-4"/></g></svg>`;

    const ALERT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="m13.299 3.148l8.634 14.954a1.5 1.5 0 0 1-1.299 2.25H3.366a1.5 1.5 0 0 1-1.299-2.25l8.634-14.954c.577-1 2.02-1 2.598 0M12 15a1 1 0 1 0 0 2a1 1 0 0 0 0-2m0-7a1 1 0 0 0-.993.883L11 9v4a1 1 0 0 0 1.993.117L13 13V9a1 1 0 0 0-1-1"/></g></svg>`;

    const MOVE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><g fill="none"><path d="M24 0v24H0V0zM12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.019-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M6.046 11.677A7.5 7.5 0 0 1 20 15.5a1 1 0 1 0 2 0A9.5 9.5 0 0 0 4.78 9.963l-.537-3.045a1 1 0 1 0-1.97.347l1.042 5.909a1 1 0 0 0 .412.645a1.1 1.1 0 0 0 .975.125l5.68-1.001a1 1 0 1 0-.347-1.97z"/></g></svg>`;

    // ── Bucket card builder ───────────────────────────────────────────────────

    function createBucketCard(b) {
        const card = document.createElement('div');
        card.className = 'flex flex-col rounded-md bg-white border border-silver-100';

        const linkCount  = b.links?.length     ?? 0;
        const grabCount  = b.grabbedBy?.length ?? 0;
        const grabbed    = !!b.isGrabbed;
        const grabColor  = grabbed ? 'text-orchid-600' : 'text-gray-500 hover:text-orchid-600';
        const u          = window.__GRABBN_USER__;
        const curatorId  = b.userId?._id ?? b.userId;
        const isCurator  = u && !u.isAnonymous && curatorId && String(curatorId) === String(u._id);

        const thumbContent = b.thumbnail
            ? `<img src="/b/${escAttr(b._id)}/thumbnail.jpg" class="w-full h-full object-cover" loading="lazy" />`
            : `<div class="w-full h-full flex items-center justify-center text-gray-400">${NO_THUMB_SVG}</div>`;

        const grabBtn = `<button class="grab-btn flex items-center gap-1 text-sm font-medium transition-colors ${grabColor}" data-grabbed="${grabbed}" data-bucket-id="${escAttr(b._id)}">
            ${grabbed ? GRAB_BTN_ICON_GRABBED : GRAB_BTN_ICON_DEFAULT}
            <span class="grab-count">${formatNum(grabCount)}</span>
        </button>`;

        card.innerHTML = `
            <div class="relative p-2">
                <a href="/b/${escAttr(b._id)}" class="block aspect-square overflow-hidden rounded-sm bg-silver-100">
                    ${thumbContent}
                </a>
                <div class="absolute bottom-4 right-4 flex items-center gap-1">
                    <span class="px-1.5 py-0.5 rounded text-[12px] font-semibold bg-white/80 backdrop-blur-sm text-gray-600 leading-none">
                        ${linkCount} link${linkCount !== 1 ? 's' : ''}
                    </span>
                    <span class="px-1.5 py-0.5 rounded text-[12px] font-bold backdrop-blur-sm leading-none ${b.isPaywalled ? 'bg-orchid-600 text-white' : 'bg-white/80 text-gray-600'}">
                        ${b.isPaywalled ? `${formatNum(b.price)} EWL` : 'Free'}
                    </span>
                </div>
            </div>
            <div class="flex items-center gap-1 px-3 pt-2.5 pb-0 min-w-0">
                <p class="font-semibold truncate flex-1 text-woodsmoke-950">${escHtml(b.name)}</p>
                <div class="relative shrink-0">
                    <button class="menu-btn w-6 h-6 rounded-full flex items-center justify-center text-gray-400 hover:text-woodsmoke-950 hover:bg-gray-100 transition-colors" data-bucket-id="${escAttr(b._id)}">
                        ${MORE_ICON}
                    </button>
                    <div class="context-menu hidden absolute right-0 top-full mt-1 bg-white rounded-md shadow-lg border border-gray-100 py-1 z-50 min-w-[160px]">
                        <button class="remove-btn flex items-center gap-2 w-full px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors" data-bucket-id="${escAttr(b._id)}">
                            ${ALERT_ICON}
                            Remove from repo
                        </button>
                        <button class="move-btn flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors" data-bucket-id="${escAttr(b._id)}">
                            ${MOVE_ICON}
                            Move to another repo
                        </button>
                        ${!isCurator ? `<button class="report-btn flex items-center gap-2 w-full px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors" data-bucket-id="${escAttr(b._id)}">
                            ${ALERT_ICON}
                            Report
                        </button>` : ''}
                    </div>
                </div>
            </div>
            <div class="flex items-center gap-3 px-3 pt-1.5 pb-2.5" onclick="event.stopPropagation()">
                ${(b.ratingCount > 0) ? `<span class="flex items-center gap-1 text-sm font-medium text-amber-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2L9.19 8.63L2 9.24l5.46 4.73L5.82 21z"/></svg>
                    <span>${Math.round((b.ratingSum / b.ratingCount) * 10) / 10}</span>
                    <span class="text-gray-400 font-normal">(${b.ratingCount})</span>
                </span>` : ''}
                ${grabBtn}
                <span class="flex items-center gap-1 text-sm font-medium text-gray-500">
                    ${VIEW_ICON}
                    <span>${formatNum(b.viewCount ?? 0)}</span>
                </span>
                <button class="share-btn flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-orchid-600 transition-colors" data-bucket-id="${escAttr(b._id)}">
                    ${SHARE_ICON}
                    <span>${formatNum(b.shareCount ?? 0)}</span>
                </button>
            </div>
        `;

        card.querySelector('.grab-btn').addEventListener('click', onGrabClick);
        card.querySelector('.share-btn').addEventListener('click', onShareClick);
        card.querySelector('.menu-btn').addEventListener('click', onMenuClick);
        card.querySelector('.remove-btn').addEventListener('click', onRemoveClick);
        card.querySelector('.move-btn').addEventListener('click', onMoveClick);
        card.querySelector('.report-btn')?.addEventListener('click', onReportClick);

        return card;
    }

    // ── Context menu handler ──────────────────────────────────────────────────

    function onMenuClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const menu   = e.currentTarget.nextElementSibling;
        const isOpen = !menu.classList.contains('hidden');
        document.querySelectorAll('.context-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
        if (!isOpen) menu.classList.remove('hidden');
    }

    document.addEventListener('click', () => {
        document.querySelectorAll('.context-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
    });

    // ── Remove from repo handler ──────────────────────────────────────────────

    async function onRemoveClick(e) {
        e.preventDefault();
        e.stopPropagation();
        document.querySelectorAll('.context-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));

        const bucketId = e.currentTarget.dataset.bucketId;
        if (!confirm('Remove this bucket from the repository?')) return;

        try {
            const res = await fetch(`/api/repositories/${encodeURIComponent(domain)}/${encodeURIComponent(tag)}/buckets/${bucketId}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            if (res.ok) {
                e.currentTarget.closest('.flex.flex-col')?.remove();
            } else {
                const d = await res.json().catch(() => ({}));
                window.showToast(d.error || 'Failed to remove bucket', 'error');
            }
        } catch (err) {
            window.showToast('Network error', 'error');
        }
    }

    // ── Move to another repo handler ──────────────────────────────────────────

    function onMoveClick(e) {
        e.preventDefault();
        e.stopPropagation();
        document.querySelectorAll('.context-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));

        const bucketId = e.currentTarget.dataset.bucketId;
        window.location.href = `/b/${bucketId}?move=1`;
    }

    // ── Report handler ────────────────────────────────────────────────────────

    function onReportClick(e) {
        e.preventDefault();
        e.stopPropagation();
        document.querySelectorAll('.context-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));

        const bucketId = e.currentTarget.dataset.bucketId;
        window.location.href = `/report?bucketId=${bucketId}`;
    }

    // ── Grab handler ──────────────────────────────────────────────────────────

    async function onGrabClick(e) {
        e.preventDefault();
        e.stopPropagation();

        if (window.__GRABBN_USER__?.isAnonymous) {
            window.location.href = '/signup.html';
            return;
        }

        const btn = e.currentTarget;
        if (btn.dataset.busy === 'true') return;

        const bucketId = btn.dataset.bucketId;
        const grabbed  = btn.dataset.grabbed === 'true';
        const countEl  = btn.querySelector('.grab-count');
        const count    = parseInt(countEl?.textContent?.replace(/[KM]/g, '') || '0', 10);

        btn.dataset.busy = 'true';
        btn.innerHTML = `${SPINNER_SVG}<span class="grab-count">${formatNum(count)}</span>`;
        btn.className = 'grab-btn flex items-center gap-1 text-sm font-medium transition-colors text-gray-400 cursor-wait';

        if (grabbed) {
            try {
                const res = await fetch(`/api/buckets/grab/${bucketId}`, { method: 'DELETE' });
                setGrabbed(btn, res.ok ? false : true, count + (res.ok ? -1 : 0));
            } catch { setGrabbed(btn, true, count); }
        } else {
            try {
                const res = await fetch('/api/buckets/grab', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sourceBucketId: bucketId })
                });
                const ok = res.ok || res.status === 409;
                setGrabbed(btn, ok, count + (res.ok ? 1 : 0));
            } catch { setGrabbed(btn, false, count); }
        }

        btn.dataset.busy = 'false';
    }

    function setGrabbed(btn, grabbed, count) {
        btn.dataset.grabbed = String(grabbed);
        btn.className = `grab-btn flex items-center gap-1 text-sm font-medium transition-colors ${grabbed ? 'text-orchid-600' : 'text-gray-500 hover:text-orchid-600'}`;
        btn.innerHTML = `${grabbed ? GRAB_BTN_ICON_GRABBED : GRAB_BTN_ICON_DEFAULT}<span class="grab-count">${formatNum(count)}</span>`;
    }

    // ── Share handler ─────────────────────────────────────────────────────────

    async function onShareClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const btn = e.currentTarget;
        if (btn.dataset.busy) return;
        btn.dataset.busy = '1';

        const bucketId = btn.dataset.bucketId;
        const url      = `${window.location.origin}/b/${bucketId}`;
        const origHtml = btn.innerHTML;
        const u = window.__GRABBN_USER__;
        const shareText = (u && !u.isAnonymous && u.username)
            ? `@${u.username} is sharing a link collection with you from Grabbn. Have a look at it!`
            : 'Check out this link collection on Grabbn!';

        const showFeedback = () => {
            btn.innerHTML = '<span class="text-xs">Copied!</span>';
            setTimeout(() => { btn.innerHTML = origHtml; delete btn.dataset.busy; }, 2000);
        };

        if (navigator.share) {
            try { await navigator.share({ text: shareText, url }); delete btn.dataset.busy; }
            catch (_) { await navigator.clipboard.writeText(shareText + '\n' + url).catch(() => {}); showFeedback(); }
        } else {
            await navigator.clipboard.writeText(shareText + '\n' + url).catch(() => {});
            showFeedback();
        }
        fetch(`/api/buckets/${bucketId}/share`, { method: 'POST', credentials: 'include' }).catch(() => {});
    }

    // ── Load ──────────────────────────────────────────────────────────────────

    async function load() {
        try {
            const res = await fetch(`/api/repositories/${encodeURIComponent(domain)}/${encodeURIComponent(tag)}`);

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
