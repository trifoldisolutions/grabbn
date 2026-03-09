// Main application entry point

import {
    loadBucketsFromStorage,
    loadLinksFromStorage,
    loadViewModeFromStorage,
    getIsRunning,
    getFilteredLinks,
    getCreditsBalance,
    topupCredits,
    getConnectStatus,
    startConnectOnboarding,
    requestCashout,
    addBucket
} from './state/store.js';

import {
    showStatus,
    hideStatus,
    initNotificationBadge,
    showNotification,
    showExtractSpinner,
    hideExtractSpinner,
    showLookUpResults,
    hideLookUpResults,
    updateContainers,
    copyToClipboard
} from './utils/helpers.js';
import { initUrlInput, getUrlValue, setUrlValue } from './components/urlInput.js';
import { initFilterDropdown } from './components/filterDropdown.js';
import { initLinksList, applyFilter } from './components/linksList.js';
import {
    checkAuthStatus,
    openLoginModal,
    handleLogout
} from './components/authModal.js';
import { openBucketPopup, openBucketPopupReadOnly } from './components/bucketPopup.js';

// DOM elements
const extractBtn = document.getElementById('extractBtn');
const copyBtn = document.getElementById('copy-links-btn');

// User hub elements
const userHubBtn = document.getElementById('userHubBtn');
const userHubLoading = document.getElementById('userHubLoading');
const userHubLoaded = document.getElementById('userHubLoaded');
const userHubAvatar = document.getElementById('userHubAvatar');
const userHubName = document.getElementById('userHubName');
const userHubEmail = document.getElementById('userHubEmail');
const userHubModalWrapper = document.getElementById('userHubModalWrapper');
const modalUserAvatar = document.getElementById('modalUserAvatar');
const modalUserName = document.getElementById('modalUserName');
const modalUserEmail = document.getElementById('modalUserEmail');
const hubLoginBtn = document.getElementById('hubLoginBtn');
const modalAnonActions = document.getElementById('modalAnonActions');
const modalAuthActions = document.getElementById('modalAuthActions');
const modalDeleteWrapper = document.getElementById('modalDeleteWrapper');
const lookUpResultsContainer = document.getElementById('lookUpResultsContainer');
const lookUpCardView = document.getElementById('lookUpCardView');
const lookUpCountBadge = document.getElementById('lookUpCountBadge');
const clearLookUpResultsBtn = document.getElementById('clearLookUpResultsBtn');
const closeLookUpResultsBtn = document.getElementById('closeLookUpResultsBtn');
const reportModalWrapper = document.getElementById('reportModalWrapper');
const reportForm = document.getElementById('reportForm');
const reportBucketId = document.getElementById('reportBucketId');

// Credits elements
const modalCreditsSection = document.getElementById('modalCreditsSection');
const modalCreditsAmount = document.getElementById('modalCreditsAmount');
const modalCreditsDollarHint = document.getElementById('modalCreditsDollarHint');
const modalTopupBtn = document.getElementById('modalTopupBtn');
const modalCashOutBtn = document.getElementById('modalCashOutBtn');
const addCreditsModal = document.getElementById('addCreditsModal');
const closeCreditsModalBtn = document.getElementById('closeCreditsModalBtn');
const creditsModalBalance = document.getElementById('creditsModalBalance');
const creditsModalError = document.getElementById('creditsModalError');
const creditsTabAdd = document.getElementById('creditsTabAdd');
const creditsTabHistory = document.getElementById('creditsTabHistory');
const creditsAddPanel = document.getElementById('creditsAddPanel');
const creditsHistoryPanel = document.getElementById('creditsHistoryPanel');
const creditsHistoryList = document.getElementById('creditsHistoryList');
const creditsHistoryEmpty = document.getElementById('creditsHistoryEmpty');
const creditsHistoryLoading = document.getElementById('creditsHistoryLoading');
const creditsHistoryPager = document.getElementById('creditsHistoryPager');
const creditsHistoryPrev = document.getElementById('creditsHistoryPrev');
const creditsHistoryNext = document.getElementById('creditsHistoryNext');
const creditsHistoryPageLabel = document.getElementById('creditsHistoryPageLabel');
const customCreditsInput = document.getElementById('customCreditsInput');
const customCreditsModeToggle = document.getElementById('customCreditsModeToggle');
const customCreditsBtn = document.getElementById('customCreditsBtn');
const customCreditsHint = document.getElementById('customCreditsHint');
const reportDetail = document.getElementById('reportDetail');
const closeReportModalBtn = document.getElementById('closeReportModalBtn');
const reportSubmitBtn = document.getElementById('reportSubmitBtn');

// Track lookup results and pagination state
let lookUpBuckets = [];
let lookUpHasMore = false;
let lookUpSkip = 0;
let lookUpQuery = '';
let lookUpLoading = false;
let isAccountSuspended = false;

// Format anonymous ID to show first 4 and last 4 characters
function formatAnonymousId(anonymousId) {
    if (!anonymousId || anonymousId.length <= 8) {
        return anonymousId;
    }
    const first4 = anonymousId.substring(0, 4);
    const last4 = anonymousId.substring(anonymousId.length - 4);
    return `${first4}...${last4}`;
}

// Mask email to show only first and last 3 chars of the local part
function maskEmail(email) {
    if (!email) return '';
    const [local, domain] = email.split('@');
    if (!domain) return email;
    if (local.length <= 6) return email;
    return `${local.substring(0, 3)}***${local.substring(local.length - 3)}@${domain}`;
}

// Show an element that needs display:flex
function showFlex(el) {
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
}

// Hide an element that was shown with flex
function hideFlex(el) {
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('flex');
}

// Show the suspension / verification notice inside the user hub modal
function showVerificationBanner(type) {
    const notice = document.getElementById('modalSuspensionNotice');
    const title = document.getElementById('modalSuspensionTitle');
    const msg = document.getElementById('modalSuspensionMsg');
    if (!notice || !title || !msg) return;

    if (type === 'suspended') {
        isAccountSuspended = true;
        notice.classList.add('bg-red-50', 'border-red-200', 'text-red-800');
        title.textContent = 'Account Suspended';
        msg.textContent = 'Verify your email to restore access before your account is permanently deleted.';

        // Disable top-up while suspended
        if (modalTopupBtn) {
            modalTopupBtn.disabled = true;
            modalTopupBtn.title = 'Account suspended — verify your email to top up';
        }
    } else {
        notice.classList.add('bg-amber-50', 'border-amber-200', 'text-amber-800');
        title.textContent = 'Verify Your Email';
        msg.textContent = 'Please verify your email. Your account will be suspended if not verified within 2 hours.';
    }

    notice.classList.remove('hidden');
    notice.classList.add('flex');
}

// Fetch and display user info
async function displayUserInfo() {
    if (!userHubBtn) return;

    try {
        const authStatus = await checkAuthStatus();

        if (authStatus.authenticated && authStatus.user) {
            const user = authStatus.user;
            const displayName = user.username || user.email.split('@')[0];
            const initial = displayName.charAt(0);

            // Show suspension/verification banner if needed
            if (!user.isEmailVerified) {
                showVerificationBanner(user.accountSuspendedAt ? 'suspended' : 'unverified');
            }

            // Hub trigger: avatar + name + masked email
            userHubAvatar.textContent = initial;
            showFlex(userHubAvatar);
            userHubName.textContent = displayName;
            if (user.email) userHubEmail.textContent = maskEmail(user.email);

            // Modal header: larger avatar + same info
            modalUserAvatar.textContent = initial;
            showFlex(modalUserAvatar);
            modalUserName.textContent = displayName;
            if (user.email) modalUserEmail.textContent = maskEmail(user.email);

            // Modal actions: show auth section, hide anon section
            modalAnonActions.classList.add('hidden');
            showFlex(modalAuthActions);
            showFlex(modalDeleteWrapper);
            if (hubLoginBtn) hideFlex(hubLoginBtn);
        } else if (authStatus.isAnonymous) {
            // Anonymous user
            const response = await fetch('/api/user', { credentials: 'include' });

            if (!response.ok) {
                console.error('Failed to fetch user info');
                return;
            }

            const userData = await response.json();

            if (userData.isAnonymous && userData.anonymousId) {
                const formattedId = formatAnonymousId(userData.anonymousId);
                userHubName.textContent = `user ${formattedId}`;
                modalUserName.textContent = `user ${formattedId}`;
            }

            // Modal actions: show anon section, hide auth section
            modalAnonActions.classList.remove('hidden');
            hideFlex(modalAuthActions);
            hideFlex(modalDeleteWrapper);
            if (hubLoginBtn) showFlex(hubLoginBtn);
        } else {
            // Unknown/error state — keep button hidden
            if (hubLoginBtn) hideFlex(hubLoginBtn);
        }

        // Switch hub trigger from loading to loaded state
        userHubLoading.classList.add('hidden');
        showFlex(userHubLoaded);
    } catch (error) {
        console.error('Error fetching user info:', error);
    }
}

// Update extract button state
function updateExtractButtonLookState() {
    const hasValue = Boolean(getUrlValue());
    const isActive = !isAccountSuspended && hasValue;
    if (extractBtn) {
        extractBtn.setAttribute('aria-disabled', String(!isActive));
        extractBtn.classList.toggle('opacity-50', !isActive);
        extractBtn.classList.toggle('cursor-not-allowed', !isActive);
        extractBtn.classList.toggle('pointer-events-none', !isActive);
    }
}


// Render a single bucket card in the lookup results container
function renderLookUpCard(bucket) {
    if (!lookUpCardView) return;

    const linkCount = bucket.totalLinkCount ?? (bucket.links ? bucket.links.length : 0);
    const sourceUrl = bucket.sourceUrl || '';
    const displayUrl = sourceUrl || 'No source URL';

    const card = document.createElement('div');
    card.dataset.bucketName = bucket.name;
    card.dataset.bucketId = bucket._id || '';
    card.className = 'bg-white rounded-md border border-gray-200 flex flex-col h-full break-inside-avoid mb-2';

    const thumbnail = bucket.thumbnail || '';

    card.innerHTML = `
        <div class="p-2 border-b border-gray-100 bg-orchid-50 flex flex-col gap-y-1">
            <div class="flex items-center justify-between gap-2">
                <h3 class="text-base font-bold text-gray-900 truncate">${bucket.name}</h3>
                <div class="flex items-center gap-1 shrink-0">
                    ${bucket.isPaywalled ? `<span class="text-xs font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">🔒 Paid</span>` : ''}
                    <span class="text-orchid-500 text-xs font-semibold rounded-full">${linkCount} link(s)</span>
                </div>
            </div>
            <div class="bucketSourceURLContainer flex flex-row justify-between items-center px-2 py-1 rounded-md border border-silver-200 gap-x-1">
                <a href="${sourceUrl}" target="_blank" class="bucketMotherLink text-sm text-silver-500 hover:text-orchid-600 truncate transition-colors" title="${displayUrl}">
                    ${displayUrl}
                </a>
            </div>
        </div>
        <div class="w-full h-auto aspect-video flex items-center justify-center bg-silver-50 overflow-hidden">
            ${thumbnail
                ? `<img src="${thumbnail}" alt="${bucket.name} thumbnail" class="w-full h-full object-cover">`
                : `<span class="text-silver-400 text-sm">No thumbnail</span>`
            }
        </div>
        <div class="cardCTASWrapper w-full h-auto flex flex-row px-3 py-3 justify-between gap-x-2">
            <div class="bucketOpenBtnContainer flex flex-1">
                <button class="lookUpBucketOpenBtn h-10 w-full border border-orchid-800 rounded-sm bg-orchid-50 text-orchid-800 font-medium flex flex-row items-center justify-center leading-none">See Content</button>
            </div>
            ${!bucket.isOwner ? `
            <div class="bucketGrabBtnContainer flex">
                <button class="lookUpBucketGrabBtn h-10 px-3 border rounded-sm text-sm font-medium flex items-center justify-center gap-x-1 transition-colors ${bucket.isPaywalled && !bucket.hasAccess ? 'border-gray-300 bg-gray-100 text-gray-400 cursor-not-allowed' : 'border-green-600 bg-green-50 text-green-700 hover:bg-green-100'}" ${bucket.isPaywalled && !bucket.hasAccess ? 'disabled title="Unlock this bucket to grab it"' : ''}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M12 20q-.213 0-.357-.144T11.5 19.5v-7h-7q-.213 0-.356-.144T4 11.999t.144-.356t.356-.143h7v-7q0-.213.144-.356T12.001 4t.356.144t.143.356v7h7q.213 0 .356.144t.144.357t-.144.356t-.356.143h-7v7q0 .213-.144.356t-.357.144"/></svg>
                    Grab
                </button>
            </div>
            ` : ''}
        </div>
    `;

    lookUpCardView.appendChild(card);

    // Bind "See Content" button
    const openBtn = card.querySelector('.lookUpBucketOpenBtn');
    openBtn.addEventListener('click', () => {
        if (bucket.isOwner) {
            openBucketPopup(bucket.name, { hideForm: true, bucketData: bucket });
        } else {
            openBucketPopupReadOnly(bucket);
            // Track view (fire-and-forget)
            fetch(`/api/buckets/${bucket._id}/view`, {
                method: 'POST',
                credentials: 'include'
            }).catch(() => {});
        }
    });

    // Bind "Grab" button (viewers only)
    const grabBtn = card.querySelector('.lookUpBucketGrabBtn');
    if (grabBtn) {
        grabBtn.addEventListener('click', async () => {
            if (!bucket._id || !bucket.links?.length) {
                showNotification('No links to grab', 'warning', 3000);
                return;
            }

            try {
                grabBtn.disabled = true;
                grabBtn.style.opacity = '0.5';

                const response = await fetch('/api/buckets/grab', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ sourceBucketId: bucket._id })
                });

                if (response.status === 409) {
                    const { error } = await response.json();
                    showNotification(error, 'warning', 3000);
                    return;
                }

                if (!response.ok) {
                    const { error } = await response.json();
                    throw new Error(error || 'Failed to grab bucket');
                }

                await loadBucketsFromStorage();
                showNotification(`Grabbed "${bucket.name}" — ${bucket.links.length} link(s) added to your collection!`, 'success', 3000);

                grabBtn.innerHTML = `<span class="text-sm font-medium">Grabbed!</span>`;
                grabBtn.classList.remove('bg-green-50', 'text-green-700');
                grabBtn.classList.add('bg-green-100', 'text-green-800');
            } catch (error) {
                showNotification(`Failed to grab bucket: ${error.message}`, 'error');
                grabBtn.disabled = false;
                grabBtn.style.opacity = '1';
            }
        });
    }
}

// Render all accumulated lookup results
function renderLookUpResults() {
    if (!lookUpCardView) return;

    lookUpCardView.innerHTML = '';
    lookUpBuckets.forEach(bucket => renderLookUpCard(bucket));

    if (lookUpCountBadge) {
        lookUpCountBadge.textContent = `${lookUpBuckets.length} found`;
    }

    showLookUpResults();
}

// Append only the new buckets (used for subsequent pages)
function appendLookUpResults(newBuckets) {
    if (!lookUpCardView) return;

    newBuckets.forEach(bucket => renderLookUpCard(bucket));

    if (lookUpCountBadge) {
        lookUpCountBadge.textContent = `${lookUpBuckets.length} found`;
    }
}

// Clear all lookup results and restore normal view
function clearLookUpResults() {
    lookUpBuckets = [];
    lookUpHasMore = false;
    lookUpSkip = 0;
    lookUpQuery = '';
    if (lookUpCardView) lookUpCardView.innerHTML = '';
    if (lookUpCountBadge) lookUpCountBadge.textContent = '0 found';
    hideLookUpResults();

    // Restore the correct main container
    const filteredLinks = getFilteredLinks();
    updateContainers(filteredLinks.length > 0);
}

// Close lookup section without clearing results, and show the main view
function closeLookUpResults() {
    hideLookUpResults();
    const filteredLinks = getFilteredLinks();
    updateContainers(filteredLinks.length > 0);
}

// Handle lookup button click
async function handleLookup() {
    const query = getUrlValue();
    if (!query) {
        showNotification('Enter a bucket name, share link, or ID.', 'warning', 3000, false);
        return;
    }

    // Disable button and show spinner
    if (extractBtn) {
        extractBtn.classList.add('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
        extractBtn.setAttribute('aria-disabled', 'true');
    }
    showExtractSpinner();

    // Reset pagination state for new search
    lookUpQuery = query;
    lookUpSkip = 0;
    lookUpHasMore = false;
    lookUpBuckets.length = 0;

    try {
        const response = await fetch(`/api/buckets/lookup?q=${encodeURIComponent(query)}&skip=0`, {
            credentials: 'include'
        });

        if (response.status === 404) {
            showNotification('No bucket found matching that query.', 'warning', 4000, false);
            return;
        }

        if (!response.ok) {
            showNotification('Something went wrong. Please try again.', 'error', 4000, false);
            return;
        }

        const { buckets, hasMore } = await response.json();

        lookUpBuckets.push(...buckets);
        lookUpSkip = buckets.length;
        lookUpHasMore = hasMore;

        renderLookUpResults();

        const totalLinks = buckets.reduce((sum, b) => sum + (b.links?.length || 0), 0);
        showNotification(`Found ${buckets.length} bucket(s) with ${totalLinks} link(s) total.`, 'success', 3000, false);
    } catch (error) {
        showNotification('Cannot connect to server.', 'error', 4000, false);
    } finally {
        hideExtractSpinner();
        setTimeout(() => updateExtractButtonLookState(), 100);
    }
}

// Load next page of lookup results
async function loadMoreLookup() {
    if (!lookUpHasMore || lookUpLoading || !lookUpQuery) return;

    lookUpLoading = true;

    try {
        const response = await fetch(
            `/api/buckets/lookup?q=${encodeURIComponent(lookUpQuery)}&skip=${lookUpSkip}`,
            { credentials: 'include' }
        );

        if (!response.ok) return;

        const { buckets, hasMore } = await response.json();

        lookUpBuckets.push(...buckets);
        lookUpSkip += buckets.length;
        lookUpHasMore = hasMore;

        appendLookUpResults(buckets);
    } catch (error) {
        // Silently fail — user can scroll again to retry
    } finally {
        lookUpLoading = false;
    }
}

// Infinite scroll: load more when near the bottom of the lookup container
if (lookUpCardView) {
    lookUpCardView.addEventListener('scroll', () => {
        const { scrollTop, scrollHeight, clientHeight } = lookUpCardView;
        if (scrollHeight - scrollTop - clientHeight < 200) {
            loadMoreLookup();
        }
    });
}

// Bookmarklet modal
function setupBookmarkletModal() {
    const btn = document.getElementById('getBookmarkletBtn');
    const modal = document.getElementById('bookmarkletModal');
    const closeBtn = document.getElementById('closeBookmarkletModal');
    const linkEl = document.getElementById('bookmarkletLink');
    const codeEl = document.getElementById('bookmarkletCode');
    const copyBtn = document.getElementById('copyBookmarkletBtn');

    if (!btn || !modal) return;

    const origin = window.location.origin;
    // Injects a floating widget (iframe) directly into the current page.
    // Clicking again toggles it off.
    // xl()  = shared link-extraction helper (used for current page + paginated fetches)
    // wf    = widget iframe reference (so the page can relay fetched-page data back in)
    // Bookmarklet injects a floating iframe widget into the current page.
    // window.name accumulation: each click merges the current page's links with
    // everything collected so far (keyed by hostname), so SPA sites like SHEIN
    // work by navigating page-by-page and clicking the bookmarklet each time.
    // grabbn-reset clears the accumulator after a successful save.
    const code = `javascript:(function(){var ex=document.getElementById('grabbn-widget');if(ex){ex.remove();return;}function xi(a,base){var el=a,img,src,attrs=['data-src','data-lazy','data-original','data-srcset','src'],depth=0;while(el&&depth<5){img=el.querySelector('img');if(img){for(var k=0;k<attrs.length;k++){src=(img.getAttribute(attrs[k])||'').trim();if(src.indexOf(' ')!==-1)src=src.split(',')[0].trim().split(' ')[0];if(src&&src.indexOf('data:')!==0&&src.indexOf('.svg')===-1){try{return new URL(src,base).href;}catch{}}}}el=el.parentElement;depth++;}return null;}function xl(doc,base){var l=[],s=new Set();doc.querySelectorAll('a[href]').forEach(function(a){var r=a.getAttribute('href');if(!r||r[0]==='#'||/^(javascript|mailto|tel):/.test(r))return;try{var h=new URL(r,base).href;if(s.has(h))return;s.add(h);var t=(a.title||a.getAttribute('aria-label')||'').trim();if(!t){var i=a.querySelector('img');if(i)t=(i.alt||'').trim();}if(!t){var f=a.textContent.trim().replace(/\\s+/g,' ');t=f.replace(/[$€£¥][\\d\\s,.]+.*/,'').trim()||f;}t=t.slice(0,120);if(t.length>2)l.push({href:h,text:t,image:xi(a,base)});}catch{}});return l;}var WN_KEY='grabbn:'+location.hostname+':';var acc=null;try{if(window.name&&window.name.indexOf(WN_KEY)===0)acc=JSON.parse(window.name.slice(WN_KEY.length));}catch{}if(acc&&acc.pagesCollected>=50){alert('Grabbn: 50-page limit reached. Save your current collection first, then continue grabbing.');return;}var curLinks=xl(document,location.href);var seen=new Set(acc?acc.links.map(function(l){return l.href;}):[]);var merged=acc?acc.links.slice():[];curLinks.forEach(function(l){if(!seen.has(l.href)){merged.push(l);seen.add(l.href);}});if(merged.length>2000)merged=merged.slice(0,2000);var pagesCollected=(acc?acc.pagesCollected:0)+1;try{window.name=WN_KEY+JSON.stringify({links:merged,pagesCollected:pagesCollected});}catch{}var maxPage=1,cp=parseInt(new URLSearchParams(location.search).get('page')||'1',10);document.querySelectorAll('a[href]').forEach(function(a){var m=(a.getAttribute('href')||'').match(/[?&]page=(\\d+)/i);if(m){var n=parseInt(m[1],10);if(n>maxPage)maxPage=n;}});var sty=document.createElement('style');sty.textContent='@keyframes grabbn-spin{to{transform:rotate(360deg)}}';document.head.appendChild(sty);var ov=document.createElement('div');ov.id='grabbn-widget';ov.style.cssText='position:fixed;bottom:20px;right:20px;width:380px;height:560px;z-index:2147483647;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.2);overflow:hidden;background:#fff;border:1px solid #e5e7eb;';var xb=document.createElement('button');xb.title='Close';xb.textContent='\u00d7';xb.style.cssText='position:absolute;top:9px;right:9px;z-index:10;background:rgba(255,255,255,.95);border:1px solid #e5e7eb;border-radius:6px;width:24px;height:24px;font-size:16px;cursor:pointer;color:#6b7280;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;';xb.onclick=function(){ov.remove();};ov.appendChild(xb);var ld=document.createElement('div');ld.style.cssText='display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:8px;color:#9ca3af;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';ld.innerHTML='<div style="width:20px;height:20px;border:2px solid #f3e8ff;border-top-color:#b346b3;border-radius:50%;animation:grabbn-spin .8s linear infinite;"></div><span>Loading Grabbn\u2026</span>';ov.appendChild(ld);document.body.appendChild(ov);var wf=null;window.addEventListener('message',function(e){if(e.origin!=='${origin}')return;if(e.data==='grabbn-close'){ov.remove();return;}if(e.data==='grabbn-reset'){try{window.name='';}catch{}return;}if(e.data&&e.data.type==='grabbn-fetch-pages'){var urls=e.data.urls;urls.forEach(function(u,i){fetch(u).then(function(r){return r.text();}).then(function(html){var d2=new DOMParser().parseFromString(html,'text/html');var pl=xl(d2,u);if(wf)wf.contentWindow.postMessage({type:'grabbn-page-links',links:pl,pageUrl:u,index:i,total:urls.length},'${origin}');}).catch(function(){if(wf)wf.contentWindow.postMessage({type:'grabbn-page-links',links:[],pageUrl:u,index:i,total:urls.length,error:true},'${origin}');});});}});fetch('${origin}/api/popup-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({links:merged,sourceUrl:location.href,maxPage:maxPage,currentPage:cp,pagesCollected:pagesCollected})}).then(function(r){return r.json();}).then(function(d){if(!d.token){ld.querySelector('span').textContent='Server error.';return;}ld.remove();var fr=document.createElement('iframe');fr.src='${origin}/popup.html?session='+d.token;fr.style.cssText='width:100%;height:100%;border:none;display:block;';ov.appendChild(fr);wf=fr;}).catch(function(){ld.querySelector('span').textContent='Could not connect.';});})();`;

    btn.addEventListener('click', () => {
        if (linkEl) linkEl.href = code;
        if (codeEl) codeEl.textContent = code;
        modal.classList.remove('hidden');
    });

    closeBtn?.addEventListener('click', () => modal.classList.add('hidden'));

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
    });

    copyBtn?.addEventListener('click', async () => {
        const success = await copyToClipboard(code);
        if (success) {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        }
    });
}

// Initialize the application
async function init() {
    // Handle Stripe return and deep-link URL params
    const urlParams = new URLSearchParams(window.location.search);
    const fromCreditsSuccess = urlParams.has('credits_success');
    const creditsSessionId = urlParams.get('session_id');
    if (fromCreditsSuccess) {
        history.replaceState(null, '', window.location.pathname);
    } else if (urlParams.has('credits_cancelled')) {
        history.replaceState(null, '', window.location.pathname);
        showNotification('Payment cancelled.', 'info', 4000);
    } else if (urlParams.has('connect_success')) {
        history.replaceState(null, '', window.location.pathname);
        showNotification('Bank account connected! You can now cash out.', 'success', 6000);
    } else if (urlParams.has('connect_pending')) {
        history.replaceState(null, '', window.location.pathname);
        showNotification('Stripe onboarding incomplete. Please try again.', 'warning', 6000);
    }

    // Load saved data from server
    await loadBucketsFromStorage();
    await loadLinksFromStorage();
    loadViewModeFromStorage();

    // Display user info
    await displayUserInfo();

    // Initialize components
    initUrlInput(() => {
        updateExtractButtonLookState();
    });

    initFilterDropdown(() => {
        applyFilter();
    });

    initLinksList();

    // Check if user is authenticated
    const authStatus = await checkAuthStatus();
    updateUIForAuthState(authStatus);

    setupAuthButtons();
    setupUserHubModal();
    setupCreditsModal();

    // Refresh credits balance whenever a bucket unlock spends credits
    window.addEventListener('credits:changed', () => {
        loadCreditsBalance();
        checkUnreadTransactions();
    });

    // Load credits balance for registered users
    if (authStatus.authenticated) {
        if (fromCreditsSuccess && creditsSessionId) {
            await verifyAndLoadCredits(creditsSessionId);
        } else {
            await loadCreditsBalance();
        }
        checkUnreadTransactions();
    }

    // Handle deep-link params that require components to be ready
    if (urlParams.has('openAuth')) {
        history.replaceState(null, '', window.location.pathname);
        openLoginModal();
    } else if (urlParams.has('openCredits')) {
        history.replaceState(null, '', window.location.pathname);
        if (authStatus.authenticated) window.location.href = '/topup.html';
        else openLoginModal();
    }

    // Setup extract button
    if (extractBtn) {
        extractBtn.addEventListener('click', () => {
            handleLookup();
        });
    }

    // Setup clear lookup results button
    if (clearLookUpResultsBtn) {
        clearLookUpResultsBtn.addEventListener('click', clearLookUpResults);
    }

    // Setup close lookup results button (hides section, shows main view)
    if (closeLookUpResultsBtn) {
        closeLookUpResultsBtn.addEventListener('click', closeLookUpResults);
    }

    // Listen for bucket dropdown changes (for extract button state)
    document.addEventListener('click', (e) => {
        if (e.target.closest('.linksBucketsDropdownOptionContainer')) {
            setTimeout(updateExtractButtonLookState, 0);
        }
    });

    // Initial extract button state
    updateExtractButtonLookState();

    initNotificationBadge();

    setupBookmarkletModal();
    setupCreateBucketFab();
}

// Update UI based on authentication state
function updateUIForAuthState(authStatus) {
    if (authStatus.authenticated && authStatus.user) {
        const user = authStatus.user;
        const displayName = user.username || user.email.split('@')[0];
        const initial = displayName.charAt(0);

        if (userHubAvatar) { userHubAvatar.textContent = initial; showFlex(userHubAvatar); }
        if (userHubName) userHubName.textContent = displayName;
        if (userHubEmail && user.email) userHubEmail.textContent = maskEmail(user.email);
        if (modalUserAvatar) { modalUserAvatar.textContent = initial; showFlex(modalUserAvatar); }
        if (modalUserName) modalUserName.textContent = displayName;
        if (modalUserEmail && user.email) modalUserEmail.textContent = maskEmail(user.email);

        if (modalAnonActions) modalAnonActions.classList.add('hidden');
        if (modalAuthActions) showFlex(modalAuthActions);
        if (modalDeleteWrapper) showFlex(modalDeleteWrapper);
        if (hubLoginBtn) hideFlex(hubLoginBtn);
    } else if (authStatus.isAnonymous) {
        if (modalAnonActions) modalAnonActions.classList.remove('hidden');
        if (modalAuthActions) hideFlex(modalAuthActions);
        if (modalDeleteWrapper) hideFlex(modalDeleteWrapper);
        if (hubLoginBtn) showFlex(hubLoginBtn);
    } else {
        if (hubLoginBtn) hideFlex(hubLoginBtn);
    }
}

// Open / close the user hub modal
function openUserHubModal() {
    if (!userHubModalWrapper) return;
    userHubModalWrapper.classList.remove('hidden');
    userHubModalWrapper.classList.add('flex');
}

function closeUserHubModal() {
    if (!userHubModalWrapper) return;
    userHubModalWrapper.classList.add('hidden');
    userHubModalWrapper.classList.remove('flex');
}

function setupUserHubModal() {
    if (!userHubBtn || !userHubModalWrapper) return;

    userHubBtn.addEventListener('click', openUserHubModal);

    // Close on backdrop click
    userHubModalWrapper.addEventListener('click', (e) => {
        if (e.target === userHubModalWrapper) closeUserHubModal();
    });

    const closeBtn = document.getElementById('closeUserHubModalBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeUserHubModal);
}

// Delete account
async function handleDeleteAccount() {
    if (!confirm('This will permanently delete your account and all your data. This action cannot be undone.\n\nAre you sure?')) return;

    try {
        const response = await fetch('/api/auth/account', {
            method: 'DELETE',
            credentials: 'include'
        });

        if (response.ok) {
            window.location.reload();
        } else {
            const data = await response.json().catch(() => ({}));
            alert(data.error || 'Failed to delete account. Please try again.');
        }
    } catch (error) {
        console.error('Delete account error:', error);
        alert('Something went wrong. Please try again.');
    }
}

// Wire up logout/delete-account buttons
function setupAuthButtons() {
    const logoutLink = document.getElementById('logoutLink');
    const deleteAccountLink = document.getElementById('deleteAccountLink');

    if (logoutLink) {
        logoutLink.addEventListener('click', (e) => {
            e.preventDefault();
            closeUserHubModal();
            if (confirm('Are you sure you want to log out?')) {
                handleLogout();
            }
        });
    }

    if (deleteAccountLink) {
        deleteAccountLink.addEventListener('click', (e) => {
            e.preventDefault();
            closeUserHubModal();
            handleDeleteAccount();
        });
    }
}

// ========== CREDITS ==========

async function loadCreditsBalance() {
    try {
        const { credits } = await getCreditsBalance();
        if (modalCreditsAmount) modalCreditsAmount.textContent = credits.toLocaleString();
        if (modalCreditsDollarHint) modalCreditsDollarHint.textContent = `≈ $${(credits / 100).toFixed(2)}`;
        if (creditsModalBalance) creditsModalBalance.textContent = credits.toLocaleString();
        if (modalCreditsSection) showFlex(modalCreditsSection);
        if (modalCashOutBtn) modalCashOutBtn.disabled = credits === 0;
        return credits;
    } catch {
        // Non-critical — silently fail
        return 0;
    }
}

// Verifies a Stripe checkout session and updates the credits display
async function verifyAndLoadCredits(sessionId) {
    try {
        const response = await fetch(`/api/credits/verify?session_id=${encodeURIComponent(sessionId)}`, {
            credentials: 'include'
        });
        if (!response.ok) throw new Error('Verify failed');
        const { credits } = await response.json();
        if (modalCreditsAmount) modalCreditsAmount.textContent = credits.toLocaleString();
        if (modalCreditsDollarHint) modalCreditsDollarHint.textContent = `≈ $${(credits / 100).toFixed(2)}`;
        if (creditsModalBalance) creditsModalBalance.textContent = credits.toLocaleString();
        if (modalCreditsSection) showFlex(modalCreditsSection);
        if (modalCashOutBtn) modalCashOutBtn.disabled = credits === 0;
        showNotification('Credits added to your account!', 'success', 5000);
    } catch {
        // Fallback — just show the current balance
        await loadCreditsBalance();
        showNotification('Credits added to your account!', 'success', 5000);
    }
}

function openCreditsModal() {
    if (!addCreditsModal) return;
    addCreditsModal.classList.remove('hidden');
    addCreditsModal.classList.add('flex');
    // Refresh balance each time modal opens
    getCreditsBalance().then(({ credits }) => {
        if (creditsModalBalance) creditsModalBalance.textContent = credits.toLocaleString();
        if (modalCreditsAmount) modalCreditsAmount.textContent = credits.toLocaleString();
        if (modalCreditsDollarHint) modalCreditsDollarHint.textContent = `≈ $${(credits / 100).toFixed(2)}`;
        if (modalCashOutBtn) modalCashOutBtn.disabled = credits === 0;
    }).catch(() => {});
}

function closeCreditsModal() {
    if (!addCreditsModal) return;
    addCreditsModal.classList.add('hidden');
    addCreditsModal.classList.remove('flex');
    resetCustomCreditsInput();
}

function setupCreditsModal() {
    if (modalTopupBtn) {
        modalTopupBtn.addEventListener('click', () => {
            window.location.href = '/topup.html';
        });
    }
    if (closeCreditsModalBtn) {
        closeCreditsModalBtn.addEventListener('click', closeCreditsModal);
    }
    if (addCreditsModal) {
        addCreditsModal.addEventListener('click', (e) => {
            if (e.target === addCreditsModal) closeCreditsModal();
        });
    }
    document.querySelectorAll('.credits-package-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            window.location.href = '/topup.html';
        });
    });

    // Custom amount input
    if (customCreditsModeToggle) {
        customCreditsModeToggle.addEventListener('click', () => {
            customCreditsMode = customCreditsMode === 'crd' ? 'usd' : 'crd';
            const isCrd = customCreditsMode === 'crd';
            customCreditsModeToggle.textContent = isCrd ? 'CRD' : 'USD';
            if (customCreditsInput) {
                customCreditsInput.step = isCrd ? '1' : '0.01';
                customCreditsInput.placeholder = isCrd ? '0' : '0.00';
                customCreditsInput.value = '';
            }
            if (customCreditsHint) { customCreditsHint.textContent = ''; customCreditsHint.classList.add('hidden'); }
        });
    }
    if (customCreditsInput) {
        customCreditsInput.addEventListener('input', updateCustomCreditsHint);
    }
    if (customCreditsBtn) {
        customCreditsBtn.addEventListener('click', () => {
            window.location.href = '/topup.html';
        });
    }

    // Tab switching
    if (creditsTabAdd) {
        creditsTabAdd.addEventListener('click', () => switchCreditsTab('add'));
    }
    if (creditsTabHistory) {
        creditsTabHistory.addEventListener('click', () => switchCreditsTab('history'));
    }

    // Cash out button
    if (modalCashOutBtn) {
        modalCashOutBtn.addEventListener('click', async () => {
            modalCashOutBtn.disabled = true;
            if (creditsModalError) creditsModalError.classList.add('hidden');
            try {
                const { stripeAccountStatus, credits } = await getConnectStatus();
                if (stripeAccountStatus !== 'active') {
                    // Not connected yet — start Stripe Express onboarding
                    const { url } = await startConnectOnboarding();
                    window.location.href = url;
                    return; // redirect in progress, keep button disabled
                }
                // Already connected — confirm and initiate cashout
                const dollars = (credits / 100).toFixed(2);
                const confirmed = confirm(`Cash out ${credits.toLocaleString()} credits ($${dollars}) to your connected bank account?`);
                if (!confirmed) {
                    modalCashOutBtn.disabled = credits === 0;
                    return;
                }
                await requestCashout();
                showNotification('Cashout initiated! Funds will arrive in 1–2 business days.', 'success', 7000);
                await loadCreditsBalance();
            } catch (error) {
                if (creditsModalError) {
                    creditsModalError.textContent = error.message || 'Cashout failed. Please try again.';
                    creditsModalError.classList.remove('hidden');
                }
                modalCashOutBtn.disabled = false;
            }
        });
    }

    // History pagination
    if (creditsHistoryPrev) {
        creditsHistoryPrev.addEventListener('click', () => {
            if (!creditsHistoryPrev.disabled) loadCreditsHistory(creditsHistoryCurrentPage - 1);
        });
    }
    if (creditsHistoryNext) {
        creditsHistoryNext.addEventListener('click', () => {
            if (!creditsHistoryNext.disabled) loadCreditsHistory(creditsHistoryCurrentPage + 1);
        });
    }
}

let creditsHistoryCurrentPage = 1;
let customCreditsMode = 'crd'; // 'crd' | 'usd'

function resetCustomCreditsInput() {
    if (customCreditsInput) { customCreditsInput.value = ''; customCreditsInput.step = '1'; customCreditsInput.placeholder = '0'; }
    if (customCreditsModeToggle) customCreditsModeToggle.textContent = 'CRD';
    if (customCreditsHint) { customCreditsHint.textContent = ''; customCreditsHint.classList.add('hidden'); }
    customCreditsMode = 'crd';
}

function updateCustomCreditsHint() {
    if (!customCreditsHint || !customCreditsInput) return;
    const raw = parseFloat(customCreditsInput.value);
    if (!raw || raw <= 0) {
        customCreditsHint.textContent = '';
        customCreditsHint.classList.add('hidden');
        return;
    }
    customCreditsHint.textContent = customCreditsMode === 'crd'
        ? `= $${(raw / 100).toFixed(2)}`
        : `= ${Math.round(raw * 100).toLocaleString()} credits`;
    customCreditsHint.classList.remove('hidden');
}

// ---- Unread transaction tracking ----
const HISTORY_LAST_SEEN_KEY = 'creditsHistoryLastSeen';

function getHistoryLastSeen() {
    const val = localStorage.getItem(HISTORY_LAST_SEEN_KEY);
    return val ? new Date(val) : null;
}

function markHistoryAsSeen() {
    localStorage.setItem(HISTORY_LAST_SEEN_KEY, new Date().toISOString());
}

function showHistoryUnreadDot() {
    if (!creditsTabHistory) return;
    if (creditsTabHistory.querySelector('.history-unread-dot')) return;
    const dot = document.createElement('span');
    dot.className = 'history-unread-dot inline-block w-2 h-2 rounded-full bg-orchid-500 ml-1.5 align-middle mb-0.5';
    creditsTabHistory.appendChild(dot);
}

function hideHistoryUnreadDot() {
    creditsTabHistory?.querySelector('.history-unread-dot')?.remove();
}

async function checkUnreadTransactions() {
    try {
        const res = await fetch('/api/credits/history?page=1', { credentials: 'include' });
        if (!res.ok) return;
        const { transactions } = await res.json();
        const lastSeen = getHistoryLastSeen();
        const hasUnread = transactions.some(tx => !lastSeen || new Date(tx.createdAt) > lastSeen);
        if (hasUnread) showHistoryUnreadDot();
        else hideHistoryUnreadDot();
    } catch {
        // Non-critical
    }
}

function switchCreditsTab(tab) {
    const isHistory = tab === 'history';

    creditsTabAdd.classList.toggle('text-orchid-600', !isHistory);
    creditsTabAdd.classList.toggle('border-orchid-600', !isHistory);
    creditsTabAdd.classList.toggle('text-gray-500', isHistory);
    creditsTabAdd.classList.toggle('border-transparent', isHistory);

    creditsTabHistory.classList.toggle('text-orchid-600', isHistory);
    creditsTabHistory.classList.toggle('border-orchid-600', isHistory);
    creditsTabHistory.classList.toggle('text-gray-500', !isHistory);
    creditsTabHistory.classList.toggle('border-transparent', !isHistory);

    creditsAddPanel.classList.toggle('hidden', isHistory);
    creditsHistoryPanel.classList.toggle('hidden', !isHistory);
    creditsHistoryPanel.classList.toggle('flex', isHistory);

    if (isHistory) loadCreditsHistory(1);
}

async function loadCreditsHistory(page = 1) {
    creditsHistoryCurrentPage = page;
    creditsHistoryList.innerHTML = '';
    creditsHistoryEmpty.classList.add('hidden');
    creditsHistoryPager.classList.add('hidden');
    creditsHistoryLoading.classList.remove('hidden');

    try {
        const res = await fetch(`/api/credits/history?page=${page}`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to load');
        const { transactions, pages } = await res.json();

        creditsHistoryLoading.classList.add('hidden');

        if (!transactions.length) {
            creditsHistoryEmpty.classList.remove('hidden');
            return;
        }

        const lastSeen = getHistoryLastSeen();
        creditsHistoryList.innerHTML = transactions
            .map(tx => renderHistoryRow(tx, !lastSeen || new Date(tx.createdAt) > lastSeen))
            .join('');

        // Mark all as seen immediately and hide the dot
        markHistoryAsSeen();
        hideHistoryUnreadDot();

        // Remove the unread bold styling after 6 seconds
        const unreadRows = creditsHistoryList.querySelectorAll('.tx-unread');
        if (unreadRows.length) {
            setTimeout(() => {
                unreadRows.forEach(row => row.classList.remove('tx-unread'));
            }, 6000);
        }

        if (pages > 1) {
            creditsHistoryPageLabel.textContent = `Page ${page} of ${pages}`;
            creditsHistoryPrev.disabled = page <= 1;
            creditsHistoryNext.disabled = page >= pages;
            creditsHistoryPager.classList.remove('hidden');
        }
    } catch {
        creditsHistoryLoading.classList.add('hidden');
        creditsHistoryList.innerHTML = '<p class="p-6 text-center text-sm text-red-500">Failed to load history.</p>';
    }
}

function renderHistoryRow(tx, isUnread = false) {
    const isPositive = tx.amount > 0;
    const amountStr = `${isPositive ? '+' : ''}${tx.amount.toLocaleString()} cr`;
    const amountClass = isPositive ? 'text-green-600' : 'text-red-500';

    const labels = {
        topup: 'Credits purchased',
        unlock: tx.relatedBucketId?.name ? `Unlocked "${tx.relatedBucketId.name}"` : 'Bucket unlocked',
        earn:   tx.relatedBucketId?.name ? `Earned from "${tx.relatedBucketId.name}"` : 'Bucket earned',
    };
    const label = labels[tx.type] ?? tx.type;

    const date = new Date(tx.createdAt);
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const unreadClass = isUnread ? ' tx-unread font-semibold' : '';

    return `<div class="flex items-center justify-between px-5 py-3 gap-x-3${unreadClass}">
        <div class="min-w-0">
            <p class="text-sm text-gray-800 truncate">${label}</p>
            <p class="text-xs text-gray-400 mt-0.5">${dateStr}</p>
        </div>
        <span class="text-sm font-semibold whitespace-nowrap ${amountClass}">${amountStr}</span>
    </div>`;
}

// Report modal logic
function resetReportModalState() {
    reportDetail.classList.add('hidden');
    reportDetail.value = '';
    reportSubmitBtn.disabled = true;
    reportSubmitBtn.classList.add('opacity-50', 'cursor-not-allowed');
    reportSubmitBtn.classList.remove('hover:bg-red-700');
    reportSubmitBtn.textContent = 'Submit Report';
}

function openReportModal(bucketId, bucketInfo = {}) {
    reportBucketId.value = bucketId;
    reportForm.reset();
    resetReportModalState();

    // Populate preview
    const previewThumbnail = document.getElementById('reportPreviewThumbnail');
    const previewName = document.getElementById('reportPreviewName');
    const previewCurator = document.getElementById('reportPreviewCurator');
    const previewCount = document.getElementById('reportPreviewCount');

    if (previewName) previewName.textContent = bucketInfo.name || 'Unknown bucket';
    if (previewCurator) previewCurator.textContent = bucketInfo.curator ? `by ${bucketInfo.curator}` : '';
    if (previewCount) {
        const count = bucketInfo.linkCount ?? 0;
        previewCount.textContent = `${count} link${count !== 1 ? 's' : ''}`;
    }
    if (previewThumbnail) {
        if (bucketInfo.thumbnail) {
            previewThumbnail.innerHTML = `<img src="${bucketInfo.thumbnail}" alt="" class="w-full h-full object-cover">`;
        } else {
            previewThumbnail.innerHTML = `<span class="text-silver-400 text-xs">No img</span>`;
        }
    }

    reportModalWrapper.classList.remove('hidden');
}
window.openReportModal = openReportModal;

function closeReportModal() {
    reportModalWrapper.classList.add('hidden');
}

// Enable submit + show detail when a reason is picked
if (reportForm) {
    reportForm.addEventListener('change', (e) => {
        if (e.target.name === 'reportReason') {
            reportDetail.classList.remove('hidden');
            reportSubmitBtn.disabled = false;
            reportSubmitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            reportSubmitBtn.classList.add('hover:bg-red-700');
        }
    });
}

if (closeReportModalBtn) {
    closeReportModalBtn.addEventListener('click', closeReportModal);
}

if (reportModalWrapper) {
    reportModalWrapper.addEventListener('click', (e) => {
        if (e.target === reportModalWrapper) closeReportModal();
    });
}

if (reportForm) {
    reportForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const reason = reportForm.querySelector('input[name="reportReason"]:checked');
        if (!reason) return;

        reportSubmitBtn.disabled = true;
        reportSubmitBtn.classList.add('opacity-50', 'cursor-not-allowed');
        reportSubmitBtn.classList.remove('hover:bg-red-700');
        reportSubmitBtn.textContent = 'Submitting...';

        try {
            const res = await fetch(`/api/buckets/${reportBucketId.value}/report`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    reason: reason.value,
                    detail: reportDetail.value.trim()
                })
            });

            const data = await res.json();

            if (res.ok) {
                showNotification('Report submitted. Thanks.', 'success');
                closeReportModal();
            } else if (res.status === 409) {
                showNotification('You have already reported this bucket.', 'warning');
                closeReportModal();
            } else {
                showNotification(data.error || 'Failed to submit report.', 'error');
            }
        } catch {
            showNotification('Failed to submit report.', 'error');
        } finally {
            reportSubmitBtn.disabled = false;
            reportSubmitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            reportSubmitBtn.classList.add('hover:bg-red-700');
            reportSubmitBtn.textContent = 'Submit Report';
        }
    });
}

// ========== CREATE BUCKET FAB ==========

function setupCreateBucketFab() {
    const fab       = document.getElementById('createBucketFab');
    const modal     = document.getElementById('createBucketModal');
    const closeBtn  = document.getElementById('closeCreateBucketModal');
    const input     = document.getElementById('createBucketNameInput');
    const confirmBtn = document.getElementById('createBucketConfirmBtn');
    const errorEl   = document.getElementById('createBucketError');

    if (!fab || !modal) return;

    function openModal() {
        if (input) { input.value = ''; input.disabled = false; }
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Create Bucket'; }
        if (errorEl) { errorEl.textContent = ''; errorEl.classList.add('hidden'); }
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        setTimeout(() => input?.focus(), 50);
    }

    function closeModal() {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    fab.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    });

    async function handleCreate() {
        const name = input?.value.trim();
        if (!name) { input?.focus(); return; }

        if (name.toLowerCase() === 'singletons') {
            if (errorEl) { errorEl.textContent = '"Singletons" is a reserved name.'; errorEl.classList.remove('hidden'); }
            return;
        }

        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Creating…'; }
        if (input) input.disabled = true;
        if (errorEl) errorEl.classList.add('hidden');

        try {
            await addBucket(name);
            showNotification(`Bucket "${name}" created.`, 'success', 3000);
            closeModal();
        } catch (err) {
            if (errorEl) {
                errorEl.textContent = err.message || 'Failed to create bucket.';
                errorEl.classList.remove('hidden');
            }
            if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Create Bucket'; }
            if (input) { input.disabled = false; input.focus(); }
        }
    }

    confirmBtn?.addEventListener('click', handleCreate);
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleCreate(); });
}

// Start the app
init();