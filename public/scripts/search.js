// Search results page — renders user cards and bucket cards.
// Bucket cards use the exact same DOM structure as showroom.js.
(function () {

    // ── Window data ───────────────────────────────────────────────────────────
    const USERS            = window.__SEARCH_USERS__    || [];
    const BUCKETS          = window.__SEARCH_BUCKETS__  || [];
    const REPOS            = window.__SEARCH_REPOS__    || [];
    const TAGS             = window.__SEARCH_TAGS__     || [];
    const REPOS_MATCH_Q    = !!window.__REPOS_MATCH_Q__;
    const TAGS_MATCH_Q     = !!window.__TAGS_MATCH_Q__;
    const SEARCH_TYPE      = window.__SEARCH_TYPE__     || ''; // '' | 'people' | 'buckets' | 'repos'
    const HAS_MORE_USERS   = !!window.__HAS_MORE_USERS__;
    const HAS_MORE_BUCKETS = !!window.__HAS_MORE_BUCKETS__;
    const HAS_MORE_REPOS   = !!window.__HAS_MORE_REPOS__;
    const QUERY            = new URLSearchParams(window.location.search).get('q') || '';

    // ── Infinite scroll state ─────────────────────────────────────────────────
    let userSkip   = USERS.length;
    let bucketSkip = BUCKETS.length;
    let repoSkip   = REPOS.length;

    // ── SVG assets (identical to showroom) ────────────────────────────────────

    const NO_THUMB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" class="text-gray-400" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M20 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2H4v10.1l4.995-4.994a1.25 1.25 0 0 1 1.768 0l4.065 4.066l1.238-1.238a1.25 1.25 0 0 1 1.768 0L20 15.101zm-4.5 2a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3"/></g></svg>`;

    const GRAB_BTN_ICON_DEFAULT = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none" fill-rule="evenodd"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M17.961 7.058a2.5 2.5 0 0 0-3.349-1.896a2.498 2.498 0 0 0-4.225 0A2.5 2.5 0 0 0 7 7.5l.001.962a4.7 4.7 0 0 0-.87-.584C5.11 7.36 4.12 7.44 3.077 7.866c-.84.345-1.107 1.308-.747 2.028l2.842 5.684A8 8 0 0 0 12.326 20H13a8 8 0 0 0 8-8V9.5a2.5 2.5 0 0 0-3.039-2.442M10 7.5a.5.5 0 1 0-1 0V11a1 1 0 0 1-1.78.625c-.925-1.156-1.517-1.72-1.995-1.964a1.2 1.2 0 0 0-.835-.117l2.57 5.14A6 6 0 0 0 12.326 18H13a6 6 0 0 0 6-6V9.5a.5.5 0 1 0-1 0v.5a1 1 0 1 1-2 0V7.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0V6.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0z"/></g></svg>`;

    const GRAB_BTN_ICON_GRABBED = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M15.5 5a2.5 2.5 0 0 1 2.461 2.058A2.5 2.5 0 0 1 21 9.5V12a8 8 0 0 1-8 8h-.674a8 8 0 0 1-7.155-4.422L2.329 9.894c-.36-.72-.093-1.683.747-2.028c1.043-.427 2.034-.507 3.055.012q.443.227.869.584V7.5a2.5 2.5 0 0 1 3.388-2.338a2.498 2.498 0 0 1 4.224 0A2.5 2.5 0 0 1 15.5 5"/></g></svg>`;

    const SPINNER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><circle cx="4" cy="12" r="3" fill="currentColor"><animate id="a" attributeName="r" begin="0;b.end-0.25s" dur="0.75s" values="3;.2;3"/></circle><circle cx="12" cy="12" r="3" fill="currentColor"><animate attributeName="r" begin="a.end-0.6s" dur="0.75s" values="3;.2;3"/></circle><circle cx="20" cy="12" r="3" fill="currentColor"><animate id="b" attributeName="r" begin="a.end-0.45s" dur="0.75s" values="3;.2;3"/></circle></svg>`;

    const MORE_ICON  = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M5 10a2 2 0 1 1 0 4a2 2 0 0 1 0-4m7 0a2 2 0 1 1 0 4a2 2 0 0 1 0-4m7 0a2 2 0 1 1 0 4a2 2 0 0 1 0-4"/></g></svg>`;

    const FLAG_ICON  = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M5 3a1 1 0 0 1 1 1v1h12.138a1 1 0 0 1 .765 1.644L15.44 11l3.463 4.356A1 1 0 0 1 18.138 17H6v3a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1"/></g></svg>`;

    const SHARE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M14.055 3.38a1 1 0 0 1 1.09.217l6 6a1 1 0 0 1 0 1.414l-6 6A1 1 0 0 1 13.5 16.5V14c-3.53.26-6.212 1.493-8.144 3.764a1 1 0 0 1-1.743-.578C3.117 12.568 5.259 7.44 13.5 6.03V3.5a1 1 0 0 1 .555-.12"/></g></svg>`;

    const VIEW_ICON  = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M12 5c3.679 0 8.162 2.417 9.73 5.901c.146.328.27.71.27 1.099c0 .388-.123.771-.27 1.099C20.161 16.583 15.678 19 12 19s-8.162-2.417-9.73-5.901C2.124 12.77 2 12.389 2 12c0-.388.123-.771.27-1.099C3.839 7.417 8.322 5 12 5m0 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8m0 2a2 2 0 1 1 0 4a2 2 0 0 1 0-4"/></g></svg>`;

    const USER_AVATAR_PLACEHOLDER = `<div class="w-10 h-10 rounded-full bg-orchid-100 flex items-center justify-center shrink-0 text-orchid-600"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M12 13c2.396 0 4.575.694 6.178 1.672c.8.488 1.484 1.064 1.978 1.69c.486.615.844 1.351.844 2.138c0 .845-.411 1.511-1.003 1.986c-.56.45-1.299.748-2.084.956c-1.578.417-3.684.558-5.913.558s-4.335-.14-5.913-.558c-.785-.208-1.524-.506-2.084-.956C3.41 20.01 3 19.345 3 18.5c0-.787.358-1.523.844-2.139c.494-.625 1.177-1.2 1.978-1.69C7.425 13.695 9.605 13 12 13m0-11a5 5 0 1 1 0 10a5 5 0 0 1 0-10"/></g></svg></div>`;

    const BTN_BASE = 'grab-btn flex items-center gap-1.5 text-sm font-medium transition-colors';

    // ── Helpers ───────────────────────────────────────────────────────────────

    function formatNum(n) {
        n = Number(n) || 0;
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1_000)     return (n / 1_000).toFixed(2).replace(/\.?0+$/, '')   + 'K';
        return String(n);
    }

    function timeAgo(dateStr) {
        const diff   = Date.now() - new Date(dateStr).getTime();
        const mins   = Math.floor(diff / 60_000);
        const hours  = Math.floor(diff / 3_600_000);
        const days   = Math.floor(diff / 86_400_000);
        const weeks  = Math.floor(days / 7);
        const months = Math.floor(days / 30);
        const years  = Math.floor(days / 365);
        if (years  >= 1) return years  + 'y ago';
        if (months >= 1) return months + 'mo ago';
        if (weeks  >= 1) return weeks  + 'w ago';
        if (days   >= 1) return days   + 'd ago';
        if (hours  >= 1) return hours  + 'h ago';
        if (mins   >= 1) return mins   + 'm ago';
        return 'just now';
    }

    function dateLabel(createdAt, updatedAt) {
        const created = timeAgo(createdAt);
        if (!updatedAt) return created;
        if (new Date(createdAt).getTime() === new Date(updatedAt).getTime()) return created;
        return created + ' \u2022 updated ' + timeAgo(updatedAt);
    }

    function escHtml(str) {
        return String(str).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
    }

    function escAttr(str) {
        return String(str).replace(/"/g, '&quot;');
    }

    function show(id) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('hidden');
    }

    function hide(id) {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    }

    // ── User cards ────────────────────────────────────────────────────────────

    function appendUsers(list, container) {
        list.forEach(u => container.appendChild(createUserCard(u)));
    }

    function createUserCard(u) {
        const el = document.createElement('div');
        el.className = 'flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-silver-50 transition-colors';

        const avatarHtml = u.avatar
            ? `<img src="${escAttr(u.avatar)}" alt="@${escAttr(u.username)}" class="w-10 h-10 rounded-full object-cover shrink-0" />`
            : USER_AVATAR_PLACEHOLDER;

        const isLoggedIn = window.__GRABBN_USER__ && !window.__GRABBN_USER__.isAnonymous;

        let actionBtn = '';
        if (!u.isSelf) {
            if (isLoggedIn && u.isFollowing) {
                actionBtn = `<a href="/u/${encodeURIComponent(u.username)}"
                    class="shrink-0 text-sm font-semibold px-4 py-1 rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                    onclick="event.stopPropagation()">Message</a>`;
            } else {
                actionBtn = `<button
                    class="follow-btn shrink-0 text-sm font-semibold px-4 py-1 rounded-md bg-orchid-100 text-orchid-600 hover:bg-orchid-200 transition-colors"
                    data-anon-id="${escAttr(u.anonymousId)}"
                    data-following="0">Follow</button>`;
            }
        }

        el.innerHTML = `
            <a href="/u/${encodeURIComponent(u.username)}" class="flex items-center gap-3 flex-1 min-w-0 group">
                ${avatarHtml}
                <div class="flex-1 min-w-0">
                    <div class="font-semibold text-woodsmoke-900 text-sm group-hover:text-orchid-600 transition-colors">@${escHtml(u.username)}</div>
                    <div class="text-xs text-gray-400 mt-0.5">${u.bucketCount} public bucket${u.bucketCount !== 1 ? 's' : ''}</div>
                </div>
            </a>
            ${actionBtn}
        `;

        const followBtn = el.querySelector('.follow-btn');
        if (followBtn) followBtn.addEventListener('click', onFollowClick);

        return el;
    }

    // ── Bucket cards (identical structure to showroom) ────────────────────────

    function appendBuckets(list, grid) {
        list.forEach(b => grid.appendChild(createCard(b)));
    }

    function createCard(b) {
        const card = document.createElement('a');
        card.href      = `/b/${b._id}`;
        card.className = 'flex flex-col rounded-md bg-white border border-silver-100 cursor-pointer';

        const thumb = b.thumbnail
            ? `<div class="px-3 pb-3"><img src="${escAttr(b.thumbnail)}" class="w-full aspect-[1] object-cover rounded-md" loading="lazy" /></div>`
            : `<div class="px-3 pb-3"><div class="w-full aspect-[1] bg-silver-100 rounded-md flex items-center justify-center">${NO_THUMB_SVG}</div></div>`;

        const avatarRing  = 'w-6 h-6 sm:w-8 sm:h-8 rounded-full border-2 border-white shrink-0 overflow-hidden';
        const grabberList = (b.grabbers && b.grabbers.length > 0) ? b.grabbers : [];
        const PLACEHOLDER_COLORS = ['bg-orchid-200', 'bg-blue-200', 'bg-amber-200'];
        const placeholderStack = PLACEHOLDER_COLORS.map(c =>
            `<div class="${avatarRing} ${c}"></div>`
        ).join('');
        const avatarStack = grabberList.length > 0
            ? grabberList.map(g =>
                `<img src="${escAttr(g.avatar)}" alt="${escAttr(g.username)}" class="${avatarRing}" title="${escAttr(g.username)}" loading="lazy" />`
              ).join('')
            : placeholderStack;

        const isCurator = b.curator.userId && b.curator.userId === window.__GRABBN_USER__?.anonymousId;
        const grabbed   = !!b.isGrabbed;
        const grabCount = formatNum(b.grabCount ?? b.grabbers?.length ?? 0);
        const grabColor = grabbed ? 'text-orchid-600' : 'text-gray-500 hover:text-orchid-600';
        const grabActionBtn = isCurator ? '' : `
            <button class="${BTN_BASE} ${grabColor}" data-grabbed="${grabbed}" data-bucket-id="${escAttr(b._id)}" title="Grab this bucket" onclick="event.preventDefault();event.stopPropagation()">
                ${grabbed ? GRAB_BTN_ICON_GRABBED : GRAB_BTN_ICON_DEFAULT}
                <span class="grab-count">${grabCount}</span>
            </button>`;

        card.innerHTML = `
            <!-- Curator -->
            <div class="flex items-center justify-between px-3 pt-3 pb-2">
                <a href="/u/${escAttr(b.curator.username || '')}" class="flex items-center gap-2 group min-w-0" onclick="event.stopPropagation()">
                    ${b.curator.avatar
                        ? `<img src="${escAttr(b.curator.avatar)}" alt="${escAttr(b.curator.username)}" class="w-10 h-10 rounded-full object-cover shrink-0" />`
                        : `<div class="w-10 h-10 rounded-full bg-orchid-100 flex items-center justify-center shrink-0 text-orchid-600"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M12 13c2.396 0 4.575.694 6.178 1.672c.8.488 1.484 1.064 1.978 1.69c.486.615.844 1.351.844 2.138c0 .845-.411 1.511-1.003 1.986c-.56.45-1.299.748-2.084.956c-1.578.417-3.684.558-5.913.558s-4.335-.14-5.913-.558c-.785-.208-1.524-.506-2.084-.956C3.41 20.01 3 19.345 3 18.5c0-.787.358-1.523.844-2.139c.494-.625 1.177-1.2 1.978-1.69C7.425 13.695 9.605 13 12 13m0-11a5 5 0 1 1 0 10a5 5 0 0 1 0-10"/></g></svg></div>`
                    }
                    <div class="flex flex-col leading-tight min-w-0">
                        <span class="text-sm font-semibold text-woodsmoke-950 group-hover:text-orchid-600 transition-colors truncate">@${escHtml(b.curator.username || 'Unknown')}</span>
                        <span class="text-xs text-gray-400 truncate">${dateLabel(b.createdAt, b.updatedAt)}</span>
                    </div>
                </a>
                <button class="follow-btn shrink-0 text-sm font-semibold px-5 py-1 rounded-md ${b.curator.isFollowing ? 'bg-gray-100 text-gray-500' : 'bg-orchid-100 text-orchid-600'}"
                    data-anon-id="${escAttr(b.curator.userId)}"
                    data-following="${b.curator.isFollowing ? '1' : '0'}">
                    ${b.curator.isFollowing ? 'Following' : 'Follow'}
                </button>
            </div>

            <!-- Thumbnail -->
            <div class="relative">
                ${thumb}
                <div class="absolute bottom-6 right-6 flex items-center gap-1.5">
                    <div class="px-2 py-0.5 rounded-md text-xs font-semibold bg-white/80 backdrop-blur-sm text-gray-500">
                        ${b.linkCount} link${b.linkCount !== 1 ? 's' : ''}
                    </div>
                    <div class="px-2 py-0.5 rounded-md text-xs font-bold backdrop-blur-sm ${b.isPaywalled ? 'bg-orchid-600 text-white' : 'bg-white/80 text-gray-500'}">
                        ${b.isPaywalled ? `${formatNum(b.price)} EWL` : 'Free'}
                    </div>
                </div>
                <div class="absolute bottom-3 left-6 translate-y-1/2 flex -space-x-2 z-10">${avatarStack}</div>
            </div>

            <!-- Card body -->
            <div class="px-3 pt-2 pb-3 flex flex-col gap-1">
                <div class="flex items-center gap-1">
                    <p class="font-medium leading-snug text-[1.1rem] truncate flex-1">${escHtml(b.name)}</p>
                    <div class="relative shrink-0">
                        <button class="menu-btn w-7 h-7 rounded-md flex items-center justify-center text-gray-400 hover:text-woodsmoke-950 hover:bg-gray-100 transition-colors" data-bucket-id="${escAttr(b._id)}" onclick="event.preventDefault();event.stopPropagation()">
                            ${MORE_ICON}
                        </button>
                        <div class="context-menu hidden absolute right-0 top-full mt-1 bg-white rounded-md shadow-lg border border-gray-100 py-1 z-50 min-w-[140px]">
                            <button class="report-btn flex items-center gap-2 w-full px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors" data-bucket-id="${escAttr(b._id)}">
                                ${FLAG_ICON}
                                Report
                            </button>
                        </div>
                    </div>
                </div>
                ${b.description ? `<p class="text-xs text-gray-500 line-clamp-2 leading-relaxed">${escHtml(b.description)}</p>` : ''}
                ${b.hashtags && b.hashtags.length > 0 ? `<div class="flex flex-wrap gap-1">${b.hashtags.slice(0, 4).map(tag => `<span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-orchid-50 text-orchid-500">#${escHtml(tag)}</span>`).join('')}</div>` : ''}
                <div class="flex items-center gap-4 pt-0.5" onclick="event.preventDefault();event.stopPropagation()">
                    ${grabActionBtn}
                    <span class="flex items-center gap-1 text-sm font-medium text-gray-500">
                        ${VIEW_ICON}
                        <span>${formatNum(b.viewCount ?? 0)}</span>
                    </span>
                    <button class="share-btn flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-orchid-600 transition-colors" data-bucket-id="${escAttr(b._id)}">
                        ${SHARE_ICON}
                        <span>${formatNum(b.shareCount ?? 0)}</span>
                    </button>
                </div>
            </div>
        `;

        const grabBtn = card.querySelector('.grab-btn');
        if (grabBtn) grabBtn.addEventListener('click', onGrabClick);

        const shareBtn = card.querySelector('.share-btn');
        if (shareBtn) shareBtn.addEventListener('click', onShareClick);

        const menuBtn = card.querySelector('.menu-btn');
        if (menuBtn) menuBtn.addEventListener('click', onMenuClick);

        const followBtn = card.querySelector('.follow-btn');
        if (followBtn) followBtn.addEventListener('click', onFollowClick);

        const curatorLink = card.querySelector('a[href^="/u/"]');
        if (curatorLink) curatorLink.addEventListener('click', e => e.stopPropagation());

        return card;
    }

    // ── Repo cards ────────────────────────────────────────────────────────────

    function appendRepos(list, grid) {
        list.forEach(r => grid.appendChild(createRepoCard(r)));
    }

    function createRepoCard(repo) {
        const IMG_PH = `<div class="w-full h-full bg-silver-100 flex items-center justify-center"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" class="text-gray-300" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M20 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2H4v10.1l4.995-4.994a1.25 1.25 0 0 1 1.768 0l4.065 4.066l1.238-1.238a1.25 1.25 0 0 1 1.768 0L20 15.101zm-4.5 2a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3"/></g></svg></div>`;
        const cells = Array.from({ length: 4 }, (_, i) => {
            const img = repo.topLinks?.[i]?.image;
            return img
                ? `<div class="w-full h-full overflow-hidden bg-gray-100"><img src="${escAttr(img)}" alt="" loading="lazy" class="w-full h-full object-cover" /></div>`
                : IMG_PH;
        });
        const card = document.createElement('a');
        card.href      = `/o/${encodeURIComponent(repo.domain)}/${encodeURIComponent(repo.tag || '')}`;
        card.className = 'block rounded-md overflow-hidden cursor-pointer hover:shadow-md transition-shadow bg-white border border-gray-100';
        card.innerHTML = `
            <div class="grid grid-cols-2 gap-0.5 aspect-square">${cells.join('')}</div>
            <div class="px-2 py-1.5">
                <p class="text-xs font-semibold truncate text-woodsmoke-950">${escHtml(repo.domain)}</p>
                <p class="text-xs text-gray-400">${formatNum(repo.bucketCount)} bucket${repo.bucketCount !== 1 ? 's' : ''}</p>
            </div>`;
        return card;
    }

    // ── Follow handler ────────────────────────────────────────────────────────

    async function onFollowClick(e) {
        e.preventDefault();
        e.stopPropagation();

        if (!window.__GRABBN_USER__ || window.__GRABBN_USER__.isAnonymous) {
            window.location.href = '/signup.html';
            return;
        }

        const btn = e.currentTarget;
        if (btn.dataset.busy === 'true') return;

        const anonId    = btn.dataset.anonId;
        const following = btn.dataset.following === '1';

        btn.dataset.busy = 'true';

        try {
            const res = await fetch(`/api/users/${encodeURIComponent(anonId)}/subscribe`, {
                method: following ? 'DELETE' : 'POST',
            });

            if (res.ok || res.status === 409) {
                const nowFollowing = !following;
                btn.dataset.following = nowFollowing ? '1' : '0';
                btn.textContent       = nowFollowing ? 'Following' : 'Follow';
                btn.className         = `follow-btn shrink-0 text-sm font-semibold px-${anonId ? '5' : '4'} py-1 rounded-md ${nowFollowing ? 'bg-gray-100 text-gray-500' : 'bg-orchid-100 text-orchid-600'}`;
            }
        } catch { /* network error — leave state unchanged */ }

        btn.dataset.busy = 'false';
    }

    // ── Grab handler ──────────────────────────────────────────────────────────

    async function onGrabClick(e) {
        e.preventDefault();
        e.stopPropagation();

        if (!window.__GRABBN_USER__ || window.__GRABBN_USER__.isAnonymous) {
            window.location.href = '/signup.html';
            return;
        }

        const btn = e.currentTarget;
        if (btn.dataset.busy === 'true') return;

        const bucketId = btn.dataset.bucketId;
        const grabbed  = btn.dataset.grabbed === 'true';

        btn.dataset.busy = 'true';
        setLoading(btn);

        if (grabbed) {
            try {
                const res = await fetch(`/api/buckets/grab/${bucketId}`, { method: 'DELETE' });
                setGrabbed(btn, res.ok ? false : true);
            } catch { setGrabbed(btn, true); }
        } else {
            try {
                const res = await fetch('/api/buckets/grab', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ sourceBucketId: bucketId }),
                });
                setGrabbed(btn, res.ok || res.status === 409 ? true : false);
            } catch { setGrabbed(btn, false); }
        }

        btn.dataset.busy = 'false';
    }

    // ── Share handler ─────────────────────────────────────────────────────────

    async function onShareClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const btn = e.currentTarget;
        if (btn.dataset.busy) return;
        btn.dataset.busy = '1';

        const bucketId  = btn.dataset.bucketId;
        const url       = `${window.location.origin}/b/${bucketId}`;
        const origHtml  = btn.innerHTML;
        const u         = window.__GRABBN_USER__;
        const shareText = (u && !u.isAnonymous && u.username)
            ? `@${u.username} is sharing a link collection with you from Grabbn. Have a look at it!`
            : 'Check out this link collection on Grabbn!';

        const showFeedback = () => {
            btn.innerHTML = '<span>Link copied!</span>';
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

    // ── Button state helpers ──────────────────────────────────────────────────

    function setLoading(btn) {
        btn.className = `${BTN_BASE} text-gray-400 cursor-wait`;
        btn.innerHTML = `${SPINNER_SVG}<span class="grab-count">${btn.querySelector('.grab-count')?.textContent ?? ''}</span>`;
    }

    function setGrabbed(btn, grabbed) {
        const count = btn.querySelector('.grab-count')?.textContent ?? '0';
        btn.dataset.grabbed = String(grabbed);
        if (grabbed) {
            btn.className = `${BTN_BASE} text-orchid-600`;
            btn.innerHTML = `${GRAB_BTN_ICON_GRABBED}<span class="grab-count">${count}</span>`;
        } else {
            btn.className = `${BTN_BASE} text-gray-500 hover:text-orchid-600`;
            btn.innerHTML = `${GRAB_BTN_ICON_DEFAULT}<span class="grab-count">${count}</span>`;
        }
    }

    // ── Tags sidebar ──────────────────────────────────────────────────────────

    function renderTags() {
        const list = document.getElementById('search-tags-list');
        if (!list) return;
        if (!TAGS.length) {
            list.innerHTML = '<p class="text-xs text-gray-400 py-2">No tags found.</p>';
            return;
        }
        TAGS.forEach(t => {
            const pill = document.createElement('a');
            pill.href      = `/search?q=${encodeURIComponent('#' + t.tag)}`;
            pill.className = 'inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md bg-orchid-50 text-orchid-600 hover:bg-orchid-100 transition-colors';
            pill.innerHTML = `#${escHtml(t.tag)} <span class="text-orchid-300 font-normal">${formatNum(t.count)}</span>`;
            list.appendChild(pill);
        });
    }

    // ── Infinite scroll ───────────────────────────────────────────────────────

    function setupInfiniteScroll(type) {
        const ids = {
            people:  { sentinel: 'users-scroll-sentinel',      loading: 'users-loading',   grid: 'search-users-list' },
            buckets: { sentinel: 'buckets-scroll-sentinel',    loading: 'buckets-loading', grid: 'search-buckets-grid' },
            repos:   { sentinel: 'repos-scroll-sentinel',      loading: 'repos-loading',   grid: 'search-repos-main-grid' },
        };
        const { sentinel: sentinelId, loading: loadingId, grid: gridId } = ids[type] || {};
        const sentinel = document.getElementById(sentinelId);
        const loadingEl = document.getElementById(loadingId);
        if (!sentinel) return;

        let fetching = false;
        let done     = false;

        const observer = new IntersectionObserver(async (entries) => {
            if (!entries[0].isIntersecting || fetching || done) return;
            fetching = true;

            if (loadingEl) { loadingEl.classList.remove('hidden'); }

            const skip = type === 'people' ? userSkip : type === 'buckets' ? bucketSkip : repoSkip;

            try {
                const res  = await fetch(`/api/search?q=${encodeURIComponent(QUERY)}&type=${type}&skip=${skip}`);
                const data = await res.json();
                const grid = document.getElementById(gridId);

                if (grid && data.items && data.items.length > 0) {
                    if (type === 'people')  appendUsers(data.items, grid);
                    if (type === 'buckets') appendBuckets(data.items, grid);
                    if (type === 'repos')   appendRepos(data.items, grid);
                }

                if (type === 'people')  userSkip   += (data.items || []).length;
                if (type === 'buckets') bucketSkip += (data.items || []).length;
                if (type === 'repos')   repoSkip   += (data.items || []).length;

                if (!data.hasMore) {
                    done = true;
                    observer.disconnect();
                }
            } catch (err) {
                console.error('Search pagination error:', err);
            }

            if (loadingEl) { loadingEl.classList.add('hidden'); }
            fetching = false;
        }, { rootMargin: '300px' });

        observer.observe(sentinel);
    }

    // ── Boot ──────────────────────────────────────────────────────────────────

    (function boot() {
        const isTypeSpecific = !!SEARCH_TYPE;

        // Show back link in type-specific mode
        if (isTypeSpecific) show('search-back-link');

        const showUsers     = !SEARCH_TYPE || SEARCH_TYPE === 'people';
        const showBuckets   = !SEARCH_TYPE || SEARCH_TYPE === 'buckets';
        const showReposMain = SEARCH_TYPE === 'repos';

        let totalCount = 0;

        // ── People ────────────────────────────────────────────────────────────
        if (showUsers && USERS.length > 0) {
            show('section-users');
            const container = document.getElementById('search-users-list');
            if (container) appendUsers(USERS, container);
            totalCount += USERS.length;

            if (!isTypeSpecific && HAS_MORE_USERS) {
                // Mixed mode: show "Show More" link
                show('users-more-link');
            } else if (SEARCH_TYPE === 'people') {
                // Type-specific mode: show sentinel for infinite scroll
                show('users-scroll-sentinel');
                setupInfiniteScroll('people');
            }
        }

        // ── Buckets ───────────────────────────────────────────────────────────
        if (showBuckets && BUCKETS.length > 0) {
            show('section-buckets');
            const grid = document.getElementById('search-buckets-grid');
            if (grid) appendBuckets(BUCKETS, grid);
            totalCount += BUCKETS.length;
            // Always set up infinite scroll for buckets (mixed and type-specific)
            setupInfiniteScroll('buckets');
        }

        // ── Repos: main column (type=repos) or sidebar (mixed/other) ──────────
        if (showReposMain) {
            show('section-repos-main');
            hide('sidebar-repos-section');
            const grid = document.getElementById('search-repos-main-grid');
            if (grid) appendRepos(REPOS, grid);
            totalCount += REPOS.length;
            setupInfiniteScroll('repos');
        } else {
            // Sidebar repos
            const sidebarGrid = document.getElementById('search-repos-list');
            if (sidebarGrid) {
                if (REPOS.length > 0) {
                    appendRepos(REPOS, sidebarGrid);
                } else {
                    sidebarGrid.innerHTML = '<p class="col-span-3 text-xs text-gray-400 py-2">No repositories yet.</p>';
                }
            }
            if (HAS_MORE_REPOS) show('repos-more-link');
        }

        // ── Tags ──────────────────────────────────────────────────────────────
        renderTags();

        // ── Total count line ──────────────────────────────────────────────────
        const totalLine = document.getElementById('search-total-line');
        if (totalLine) {
            if (showReposMain) {
                const n = REPOS.length;
                totalLine.textContent = n + ' result' + (n !== 1 ? 's' : '');
            } else {
                totalLine.textContent = totalCount + ' result' + (totalCount !== 1 ? 's' : '');
            }
        }

        // ── Empty state ───────────────────────────────────────────────────────
        const noMain = USERS.length === 0 && BUCKETS.length === 0;
        if (!isTypeSpecific && noMain) {
            show('search-empty');
        } else if (isTypeSpecific && SEARCH_TYPE === 'people' && USERS.length === 0) {
            show('search-empty');
        } else if (isTypeSpecific && SEARCH_TYPE === 'buckets' && BUCKETS.length === 0) {
            show('search-empty');
        } else if (showReposMain && REPOS.length === 0) {
            show('search-empty');
        }
    })();

})();
