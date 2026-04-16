// Showroom feed — infinite scroll
(function () {
    let page    = 1;
    let loading = false;
    let hasMore = true;

    const grid   = document.getElementById('showroom-grid');
    const loader = document.getElementById('showroom-loader');

    async function loadPage() {
        if (loading || !hasMore) return;
        loading = true;
        loader.classList.remove('hidden');

        try {
            const res = await fetch(`/api/showroom?page=${page}`);
            if (!res.ok) throw new Error('Feed request failed');
            const { buckets, hasMore: more } = await res.json();

            hasMore = more;
            page++;

            if (buckets.length === 0 && page === 2) {
                grid.innerHTML = '<p class="col-span-5 text-sm text-gray-500 text-center py-12">No public buckets yet.</p>';
                return;
            }

            buckets.forEach(b => grid.appendChild(createCard(b)));
        } catch (e) {
            console.error('Showroom load error:', e);
        } finally {
            loading = false;
            loader.classList.add('hidden');
        }
    }

    // ── SVG assets ──────────────────────────────────────────────────────────

    const NO_THUMB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" class="text-gray-400" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M20 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2H4v10.1l4.995-4.994a1.25 1.25 0 0 1 1.768 0l4.065 4.066l1.238-1.238a1.25 1.25 0 0 1 1.768 0L20 15.101zm-4.5 2a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3"/></g></svg>`;

    // Outlined grab — used in stats row
    const GRAB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none" fill-rule="evenodd"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M17.961 7.058a2.5 2.5 0 0 0-3.349-1.896a2.498 2.498 0 0 0-4.225 0A2.5 2.5 0 0 0 7 7.5l.001.962a4.7 4.7 0 0 0-.87-.584C5.11 7.36 4.12 7.44 3.077 7.866c-.84.345-1.107 1.308-.747 2.028l2.842 5.684A8 8 0 0 0 12.326 20H13a8 8 0 0 0 8-8V9.5a2.5 2.5 0 0 0-3.039-2.442M10 7.5a.5.5 0 1 0-1 0V11a1 1 0 0 1-1.78.625c-.925-1.156-1.517-1.72-1.995-1.964a1.2 1.2 0 0 0-.835-.117l2.57 5.14A6 6 0 0 0 12.326 18H13a6 6 0 0 0 6-6V9.5a.5.5 0 1 0-1 0v.5a1 1 0 1 1-2 0V7.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0V6.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0z"/></g></svg>`;

    // Line grab (mingcute:hand-grab-line) — not yet grabbed
    const GRAB_BTN_ICON_DEFAULT = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none" fill-rule="evenodd"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M17.961 7.058a2.5 2.5 0 0 0-3.349-1.896a2.498 2.498 0 0 0-4.225 0A2.5 2.5 0 0 0 7 7.5l.001.962a4.7 4.7 0 0 0-.87-.584C5.11 7.36 4.12 7.44 3.077 7.866c-.84.345-1.107 1.308-.747 2.028l2.842 5.684A8 8 0 0 0 12.326 20H13a8 8 0 0 0 8-8V9.5a2.5 2.5 0 0 0-3.039-2.442M10 7.5a.5.5 0 1 0-1 0V11a1 1 0 0 1-1.78.625c-.925-1.156-1.517-1.72-1.995-1.964a1.2 1.2 0 0 0-.835-.117l2.57 5.14A6 6 0 0 0 12.326 18H13a6 6 0 0 0 6-6V9.5a.5.5 0 1 0-1 0v.5a1 1 0 1 1-2 0V7.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0V6.5a.5.5 0 1 0-1 0V10a1 1 0 1 1-2 0z"/></g></svg>`;

    // Fill grab (mingcute:hand-grab-fill) — already grabbed
    const GRAB_BTN_ICON_GRABBED = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M15.5 5a2.5 2.5 0 0 1 2.461 2.058A2.5 2.5 0 0 1 21 9.5V12a8 8 0 0 1-8 8h-.674a8 8 0 0 1-7.155-4.422L2.329 9.894c-.36-.72-.093-1.683.747-2.028c1.043-.427 2.034-.507 3.055.012q.443.227.869.584V7.5a2.5 2.5 0 0 1 3.388-2.338a2.498 2.498 0 0 1 4.224 0A2.5 2.5 0 0 1 15.5 5"/></g></svg>`;

    // 3-dots spinner (svg-spinners:3-dots-scale)
    const SPINNER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><circle cx="4" cy="12" r="3" fill="currentColor"><animate id="a" attributeName="r" begin="0;b.end-0.25s" dur="0.75s" values="3;.2;3"/></circle><circle cx="12" cy="12" r="3" fill="currentColor"><animate attributeName="r" begin="a.end-0.6s" dur="0.75s" values="3;.2;3"/></circle><circle cx="20" cy="12" r="3" fill="currentColor"><animate id="b" attributeName="r" begin="a.end-0.45s" dur="0.75s" values="3;.2;3"/></circle></svg>`;

    // mingcute:more-1-line — horizontal 3-dot menu trigger
    const MORE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M5 10a2 2 0 1 1 0 4a2 2 0 0 1 0-4m7 0a2 2 0 1 1 0 4a2 2 0 0 1 0-4m7 0a2 2 0 1 1 0 4a2 2 0 0 1 0-4"/></g></svg>`;

    // mingcute:flag-1-fill — report action
    const FLAG_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M5 3a1 1 0 0 1 1 1v1h12.138a1 1 0 0 1 .765 1.644L15.44 11l3.463 4.356A1 1 0 0 1 18.138 17H6v3a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1"/></g></svg>`;

    // mingcute:eye-close-line — not interested action
    const EYE_OFF_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M10.588 13.412a2 2 0 1 0 2.824-2.824zm-6.54-5.117c-.38.368-.38.965 0 1.333l.738.737A13 13 0 0 0 2.46 12.41a1 1 0 0 0 1.08 1.08 1 1 0 0 0 .86-.62A11 11 0 0 1 6.12 10.95l.97.97a4 4 0 0 0 5.64 5.64l.97.97a11 11 0 0 1-1.44 1.16 1 1 0 0 0 1.48 1.07A13 13 0 0 0 15 19.3l1.29 1.29a.943.943 0 1 0 1.333-1.333l-13-13a.943.943 0 0 0-1.574.038M12 7c-.69 0-1.355.117-1.98.332l1.537 1.537A2 2 0 0 1 13.13 10.443l1.537 1.537A4 4 0 0 0 12 7m8.46 4.59a1 1 0 0 0-1.94.48A11 11 0 0 1 17.88 13.05l.97.97a13 13 0 0 0 1.612-2.03A1 1 0 0 0 20.46 11.59"/></g></svg>`;

    // mingcute:share-forward-fill — share action
    const SHARE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M14.055 3.38a1 1 0 0 1 1.09.217l6 6a1 1 0 0 1 0 1.414l-6 6A1 1 0 0 1 13.5 16.5V14c-3.53.26-6.212 1.493-8.144 3.764a1 1 0 0 1-1.743-.578C3.117 12.568 5.259 7.44 13.5 6.03V3.5a1 1 0 0 1 .555-.12"/></g></svg>`;

    // eye icon — view count
    const VIEW_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M12 5c3.679 0 8.162 2.417 9.73 5.901c.146.328.27.71.27 1.099c0 .388-.123.771-.27 1.099C20.161 16.583 15.678 19 12 19s-8.162-2.417-9.73-5.901C2.124 12.77 2 12.389 2 12c0-.388.123-.771.27-1.099C3.839 7.417 8.322 5 12 5m0 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8m0 2a2 2 0 1 1 0 4a2 2 0 0 1 0-4"/></g></svg>`;

    // Action row grab button base classes
    const BTN_BASE = 'grab-btn flex items-center gap-1.5 text-sm font-medium transition-colors';

    // ── Card builder ─────────────────────────────────────────────────────────

    function createCard(b) {
        const card = document.createElement('a');
        card.href      = `/b/${b._id}`;
        card.className = 'flex flex-col rounded-md bg-white border border-silver-100 cursor-pointer';

        // Thumbnail / placeholder
        const thumb = b.thumbnail
            ? `<div class="px-3 pb-3"><img src="${escAttr(b.thumbnail)}" class="w-full aspect-[1] object-cover rounded-md" loading="lazy" /></div>`
            : `<div class="px-3 pb-3"><div class="w-full aspect-[1] bg-silver-100 rounded-md flex items-center justify-center">${NO_THUMB_SVG}</div></div>`;

        // Avatar stack — real grabbers only
        const avatarRing  = 'w-8 h-8 sm:w-10 sm:h-10 rounded-full border-2 border-white shrink-0 overflow-hidden';
        const grabberList = (b.grabbers && b.grabbers.length > 0) ? b.grabbers : [];
        const avatarStack = grabberList
            .filter(g => g.avatar)
            .map(g => `<img src="${escAttr(g.avatar)}" alt="${escAttr(g.username)}" class="${avatarRing}" title="${escAttr(g.username)}" loading="lazy" />`)
            .join('');

        // Grab button state
        const isCurator = b.curator.userId && b.curator.userId === window.__GRABBN_USER__?.anonymousId;
        const grabbed   = !!b.isGrabbed;
        const grabCount = formatNum(b.grabCount ?? b.grabbers?.length ?? 0);
        const grabColor = grabbed ? 'text-orchid-600' : 'text-gray-500 hover:text-orchid-600';
        const grabActionBtn = isCurator
            ? `<span class="flex items-center gap-1.5 text-sm font-medium text-gray-400">${GRAB_ICON}<span class="grab-count">${grabCount}</span></span>`
            : `<button class="${BTN_BASE} ${grabColor}" data-grabbed="${grabbed}" data-bucket-id="${escAttr(b._id)}" title="Grab this bucket" onclick="event.preventDefault();event.stopPropagation()">
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
                <!-- Bottom badges: link count + price -->
                <div class="absolute bottom-6 right-6 flex items-center gap-1.5">
                    <div class="px-2 py-0.5 rounded-md text-xs font-semibold bg-white/80 backdrop-blur-sm text-gray-500">
                        ${b.linkCount} link${b.linkCount !== 1 ? 's' : ''}
                    </div>
                    <div class="px-2 py-0.5 rounded-md text-xs font-bold backdrop-blur-sm ${b.isPaywalled ? 'bg-orchid-600 text-white' : 'bg-white/80 text-gray-500'}">
                        ${b.isPaywalled ? `${formatNum(b.price)} EWL` : 'Free'}
                    </div>
                </div>
                <!-- Grabbers avatar stack — straddles the bottom edge of the thumbnail -->
                <div class="absolute bottom-3 left-6 translate-y-1/2 flex -space-x-2 z-10">${avatarStack}</div>
            </div>

            <!-- Card body — pt-5 clears the avatar stack bleed -->
            <div class="px-3 pt-2 pb-3 flex flex-col gap-1">
                <div class="flex items-center gap-1">
                    <p class="font-medium leading-snug text-[1.1rem] truncate flex-1">${escHtml(b.name)}</p>
                    <div class="relative shrink-0">
                        <button class="menu-btn w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-woodsmoke-950 hover:bg-gray-100 transition-colors" data-bucket-id="${escAttr(b._id)}" onclick="event.preventDefault();event.stopPropagation()">
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
                <!-- Action row -->
                <div class="flex items-center gap-4 pt-1.5" onclick="event.preventDefault();event.stopPropagation()">
                    ${(b.ratingCount > 0) ? `<span class="flex items-center gap-1 text-sm font-medium text-amber-500">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2L9.19 8.63L2 9.24l5.46 4.73L5.82 21z"/></svg>
                        <span>${Math.round((b.ratingSum / b.ratingCount) * 10) / 10}</span>
                        <span class="text-gray-400 font-normal">(${b.ratingCount})</span>
                    </span>` : ''}
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
                ${b.description ? `<p class="text-xs text-gray-500 line-clamp-2 leading-relaxed">${escHtml(b.description)}</p>` : ''}
                ${b.hashtags && b.hashtags.length > 0 ? `<div class="flex flex-wrap gap-1">${b.hashtags.slice(0, 4).map(tag => `<span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-orchid-50 text-orchid-500">#${escHtml(tag)}</span>`).join('')}</div>` : ''}
            </div>
        `;

        // Attach grab click — only if button was rendered
        const grabBtn = card.querySelector('.grab-btn');
        if (grabBtn) grabBtn.addEventListener('click', onGrabClick);

        // Attach share click
        const shareBtn = card.querySelector('.share-btn');
        if (shareBtn) shareBtn.addEventListener('click', onShareClick);

        // Attach context menu toggle
        const menuBtn = card.querySelector('.menu-btn');
        if (menuBtn) menuBtn.addEventListener('click', onMenuClick);

        // Attach follow click
        const followBtn = card.querySelector('.follow-btn');
        if (followBtn) followBtn.addEventListener('click', onFollowClick);

        // Stop curator link from triggering the card <a> navigation
        const curatorLink = card.querySelector('a[href^="/u/"]');
        if (curatorLink) curatorLink.addEventListener('click', e => e.stopPropagation());

        return card;
    }

    // ── Follow button handler ─────────────────────────────────────────────────

    async function onFollowClick(e) {
        e.preventDefault();
        e.stopPropagation();

        if (window.__GRABBN_USER__?.isAnonymous) {
            window.location.href = '/signup.html';
            return;
        }

        const btn       = e.currentTarget;
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
                btn.className         = `follow-btn shrink-0 text-sm font-semibold px-5 py-1 rounded-md ${nowFollowing ? 'bg-gray-100 text-gray-500' : 'bg-orchid-100 text-orchid-600'}`;
            }
        } catch { /* network error — leave state unchanged */ }

        btn.dataset.busy = 'false';
    }

    // ── Grab button handler ───────────────────────────────────────────────────

    async function onGrabClick(e) {
        e.preventDefault();
        e.stopPropagation();

        // Redirect anonymous users to sign up
        if (window.__GRABBN_USER__?.isAnonymous) {
            window.location.href = '/signup.html';
            return;
        }

        const btn      = e.currentTarget;
        if (btn.dataset.busy === 'true') return; // debounce

        const bucketId = btn.dataset.bucketId;
        const grabbed  = btn.dataset.grabbed === 'true';

        btn.dataset.busy = 'true';
        setLoading(btn);

        if (grabbed) {
            // Ungrab
            try {
                const res = await fetch(`/api/buckets/grab/${bucketId}`, { method: 'DELETE' });
                setGrabbed(btn, res.ok ? false : true);
            } catch {
                setGrabbed(btn, true); // revert on network failure
            }
        } else {
            // Grab
            try {
                const res = await fetch('/api/buckets/grab', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ sourceBucketId: bucketId })
                });
                // 409 = already grabbed server-side, treat as success
                setGrabbed(btn, res.ok || res.status === 409 ? true : false);
            } catch {
                setGrabbed(btn, false); // revert on network failure
            }
        }

        btn.dataset.busy = 'false';
    }

    // ── Share button handler ──────────────────────────────────────────────────

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
            btn.innerHTML = '<span>Link copied!</span>';
            setTimeout(() => { btn.innerHTML = origHtml; delete btn.dataset.busy; }, 2000);
        };

        if (navigator.share) {
            try {
                await navigator.share({ text: shareText, url });
                delete btn.dataset.busy;
            } catch (_) {
                await navigator.clipboard.writeText(shareText + '\n' + url).catch(() => {});
                showFeedback();
            }
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
        const menu = e.currentTarget.nextElementSibling; // .context-menu
        const isOpen = !menu.classList.contains('hidden');
        // Close any other open menus first
        document.querySelectorAll('.context-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
        if (!isOpen) menu.classList.remove('hidden');
    }

    // Close menus when clicking outside
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

    // ── Helpers ───────────────────────────────────────────────────────────────

    // 325 → "325",  1234 → "1.23K",  10567343 → "10.5M"
    function formatNum(n) {
        n = Number(n) || 0;
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '')    + 'M';
        if (n >= 1_000)     return (n / 1_000).toFixed(2).replace(/\.?0+$/, '')      + 'K';
        return String(n);
    }

    function dateLabel(createdAt, updatedAt) {
        const created = timeAgo(createdAt);
        if (!updatedAt) return created;
        const cTime = new Date(createdAt).getTime();
        const uTime = new Date(updatedAt).getTime();
        if (cTime === uTime) return created;
        return created + ' \u2022 updated ' + timeAgo(updatedAt);
    }

    // "just now" / "3m ago" / "2h ago" / "1w ago" / "3mo ago" / "2y ago"
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

    function escHtml(str) {
        return String(str).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
    }

    function escAttr(str) {
        return String(str).replace(/"/g, '&quot;');
    }

    // ── Repositories sidebar ──────────────────────────────────────────────────

    const repoList = document.getElementById('repositories-list');

    function createRepoCard(repo) {
        const imgLinks = repo.topLinks.filter(l => l.image).slice(0, 4);
        const cells = Array.from({ length: 4 }, (_, i) => {
            const link = imgLinks[i];
            return link
                ? `<div class="w-full h-full overflow-hidden bg-gray-100"><img src="${escAttr(link.image)}" alt="" loading="lazy" class="w-full h-full object-cover" /></div>`
                : `<div class="w-full h-full bg-silver-100 flex items-center justify-center"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" class="text-gray-300" viewBox="0 0 24 24"><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M20 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2H4v10.1l4.995-4.994a1.25 1.25 0 0 1 1.768 0l4.065 4.066l1.238-1.238a1.25 1.25 0 0 1 1.768 0L20 15.101zm-4.5 2a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3"/></g></svg></div>`;
        });

        const card = document.createElement('div');
        card.className      = 'relative rounded-lg bg-white border border-gray-100 overflow-hidden hover:shadow-md transition-shadow';
        card.dataset.domain = repo.domain;
        card.dataset.tag    = repo.tag;

        card.innerHTML = `
            <a href="/o/${encodeURIComponent(repo.domain)}/${encodeURIComponent(repo.tag)}" class="block">
                <div class="grid grid-cols-2 gap-0.5 aspect-square">${cells.join('')}</div>
            </a>
            <div class="flex items-start justify-between gap-1 px-2.5 py-2 min-w-0">
                <a href="/o/${encodeURIComponent(repo.domain)}/${encodeURIComponent(repo.tag)}" class="min-w-0 flex-1 block">
                    <p class="text-sm font-semibold truncate text-woodsmoke-950"><span class="text-orchid-600">#</span>${escHtml(repo.tag)}</p>
                    <p class="text-xs text-gray-400 truncate mt-0.5">in ${escHtml(repo.domain)}</p>
                </a>
                <div class="relative shrink-0">
                    <button class="repo-menu-btn w-5 h-5 rounded-full flex items-center justify-center text-gray-300 hover:text-gray-500 hover:bg-gray-100 transition-colors" onclick="event.preventDefault();event.stopPropagation()">
                        ${MORE_ICON}
                    </button>
                    <div class="context-menu hidden absolute right-0 top-full mt-1 bg-white rounded-md shadow-lg border border-gray-100 py-1 z-50 min-w-[150px]">
                        <button class="repo-not-interested-btn flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                            ${EYE_OFF_ICON}
                            Not interested
                        </button>
                    </div>
                </div>
            </div>`;

        card.querySelector('.repo-menu-btn').addEventListener('click', onMenuClick);
        card.querySelector('.repo-not-interested-btn').addEventListener('click', onRepoNotInterestedClick);

        return card;
    }

    async function onRepoNotInterestedClick(e) {
        e.preventDefault();
        e.stopPropagation();

        const card   = e.currentTarget.closest('[data-domain]');
        const domain = card.dataset.domain;
        const tag    = card.dataset.tag;

        document.querySelectorAll('.context-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));

        card.style.transition = 'opacity 0.15s';
        card.style.opacity    = '0';
        setTimeout(() => card.remove(), 150);

        fetch(`/api/repositories/${encodeURIComponent(domain)}/${encodeURIComponent(tag)}/not-interested`, {
            method: 'POST'
        }).catch(() => {});
    }

    async function loadRepositories() {
        if (!repoList) return;
        try {
            const res  = await fetch('/api/repositories?limit=8');
            if (!res.ok) return;
            const { repositories } = await res.json();

            repoList.innerHTML = '';
            if (!repositories || repositories.length === 0) {
                repoList.innerHTML = '<p class="col-span-2 text-xs text-gray-400 text-center py-4">No repositories yet.</p>';
                return;
            }
            repositories.forEach(repo => repoList.appendChild(createRepoCard(repo)));
        } catch (e) {
            console.error('Repositories load error:', e);
        }
    }

    loadRepositories();

    // ── Infinite scroll ───────────────────────────────────────────────────────

    const observer = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting) loadPage();
    }, { rootMargin: '300px' });

    observer.observe(loader);

    // Initial load
    loadPage();
})();
