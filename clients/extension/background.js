const BASE_URL = 'https://app.grabbn.com';
const MAX_IMAGE_BYTES = 800 * 1024;

// Fetch an external image URL and return a base64 data URI.
// Extension service workers bypass CORS for URLs covered by host_permissions (*://*/*).
async function fetchImageBase64(url) {
  if (!url || url.startsWith('data:')) return url || '';
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return '';
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) return '';
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return `data:${mime};base64,${b64}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getAnonymousId() {
  const { anonymousId } = await chrome.storage.local.get('anonymousId');
  return anonymousId || null;
}

async function setAnonymousId(id) {
  await chrome.storage.local.set({ anonymousId: id });
}

async function clearAnonymousId() {
  await chrome.storage.local.remove('anonymousId');
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiRequest(path, options = {}) {
  const anonymousId = await getAnonymousId();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (anonymousId) headers['X-Anonymous-Id'] = anonymousId;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  return res;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function checkAuthStatus() {
  try {
    const res = await apiRequest('/api/auth/status');
    if (!res.ok) return { authenticated: false };
    const data = await res.json();
    return data;
  } catch {
    return { authenticated: false };
  }
}

// After a successful OTP verification the server sets the anonymousId cookie.
// We read it back via chrome.cookies and persist it in storage so future
// requests can include it via the X-Anonymous-Id header.
async function syncCookieToStorage() {
  const domains = [
    'localhost',
    'grabbn.com',
    'app.grabbn.com',
  ];
  for (const domain of domains) {
    try {
      const cookie = await chrome.cookies.get({
        url: domain === 'localhost' ? 'http://localhost:3000' : `https://${domain}`,
        name: 'anonymousId',
      });
      if (cookie?.value) {
        await setAnonymousId(cookie.value);
        return cookie.value;
      }
    } catch {
      // cookie not found on this domain, try next
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case 'CHECK_AUTH': {
        const anonymousId = await getAnonymousId();
        if (!anonymousId) { sendResponse({ authenticated: false }); return; }
        const status = await checkAuthStatus();
        sendResponse(status);
        break;
      }

      case 'LOGIN': {
        // Step 1: send email + password, triggers OTP email
        try {
          const res = await fetch(`${BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: msg.email, password: msg.password }),
            credentials: 'include',
          });
          const data = await res.json();
          if (!res.ok) { sendResponse({ ok: false, error: data.error || 'Login failed' }); return; }
          sendResponse({ ok: true, requiresOtp: data.requiresOtp, email: data.email });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case 'VERIFY_OTP': {
        try {
          const res = await fetch(`${BASE_URL}/api/auth/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: msg.email, code: msg.code }),
            credentials: 'include',
          });
          const data = await res.json();
          if (!res.ok || !data.success) { sendResponse({ ok: false, error: data.error || 'Invalid code' }); return; }

          // Sync cookie → storage so header auth works for future requests
          await syncCookieToStorage();
          sendResponse({ ok: true, user: data.user });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case 'LOGOUT': {
        await clearAnonymousId();
        sendResponse({ ok: true });
        break;
      }

      case 'ACTIVATE_PICK_MODE': {
        // Inject content script into the active tab
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
          await chrome.tabs.sendMessage(tab.id, { type: 'START_PICK_MODE' });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case 'GET_META': {
        try {
          const res = await apiRequest(`/api/meta?url=${encodeURIComponent(msg.url)}`);
          if (!res.ok) { sendResponse({ ok: false }); return; }
          const data = await res.json();
          sendResponse({ ok: true, title: data.title || '', image: data.image || '' });
        } catch {
          sendResponse({ ok: false });
        }
        break;
      }

      case 'GET_BUCKETS': {
        try {
          const res = await apiRequest('/api/buckets/mine');
          if (!res.ok) { sendResponse({ ok: false, error: 'Failed to load buckets' }); return; }
          const buckets = await res.json();
          sendResponse({ ok: true, buckets });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case 'SAVE_LINK': {
        try {
          const image = await fetchImageBase64(msg.image);
          const res = await apiRequest('/api/links', {
            method: 'POST',
            body: JSON.stringify({
              links: [{ href: msg.href, text: msg.text || '', image }],
              buckets: msg.bucketNames,
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            sendResponse({ ok: false, error: err.error || 'Failed to save' });
            return;
          }
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true; // keep message channel open for async response
});
