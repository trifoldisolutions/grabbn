const BASE_URL_CANDIDATES = [
  'https://app.grabbn.com',
  'https://grabbn.com',
  'https://www.grabbn.com',
  'http://localhost:3000',
];
const ACTIVE_BASE_URL_KEY = 'activeBaseUrl';
const API_REQUEST_TIMEOUT_MS = 7000;
const AUTH_REQUEST_TIMEOUT_MS = 12000;
const MAX_IMAGE_BYTES = 800 * 1024;

// Fetch an external image URL and return a base64 data URI.
// Extension service workers bypass CORS for URLs covered by host_permissions.
async function fetchImageBase64(url) {
  if (!url || url.startsWith('data:')) return url || '';
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return '';
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) return '';
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return `data:${mime};base64,${btoa(binary)}`;
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

async function getActiveBaseUrl() {
  const { [ACTIVE_BASE_URL_KEY]: activeBaseUrl } = await chrome.storage.local.get(ACTIVE_BASE_URL_KEY);
  return activeBaseUrl || null;
}

async function setActiveBaseUrl(url) {
  await chrome.storage.local.set({ [ACTIVE_BASE_URL_KEY]: url });
}

async function getBaseUrls() {
  const activeBaseUrl = await getActiveBaseUrl();
  if (!activeBaseUrl) return [...BASE_URL_CANDIDATES];
  return [activeBaseUrl, ...BASE_URL_CANDIDATES.filter(url => url !== activeBaseUrl)];
}

async function syncAnonymousIdFromCookie() {
  const baseUrls = await getBaseUrls();
  for (const baseUrl of baseUrls) {
    try {
      const cookie = await chrome.cookies.get({ url: baseUrl, name: 'anonymousId' });
      const cookieValue = cookie?.value || null;
      if (!cookieValue) continue;
      await setAnonymousId(cookieValue);
      await setActiveBaseUrl(baseUrl);
      return cookieValue;
    } catch {
      // Try the next host.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth cache (chrome.storage.session - cleared when browser closes)
// ---------------------------------------------------------------------------

const AUTH_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

async function getCachedAuthStatus() {
  try {
    const { authCache } = await chrome.storage.session.get('authCache');
    if (!authCache || Date.now() - authCache.ts > AUTH_CACHE_TTL_MS) return null;
    return authCache.status;
  } catch {
    return null;
  }
}

async function setCachedAuthStatus(status) {
  try {
    await chrome.storage.session.set({ authCache: { ts: Date.now(), status } });
  } catch {}
}

async function clearAuthCache() {
  try {
    await chrome.storage.session.remove('authCache');
  } catch {}
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function normalizeRequestError(err, fallbackMessage = 'Request failed. Please try again.') {
  if (!err) return fallbackMessage;

  if (err.name === 'AbortError') {
    return 'Request timed out. Please try again.';
  }

  if (err.message) {
    if (err.message.includes('Failed to fetch')) {
      return 'Network error reaching Grabbn. Please try again.';
    }
    return err.message;
  }

  return fallbackMessage;
}

function isInvalidApiHostResponse(path, res) {
  if (!path.startsWith('/api/')) return false;

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const isJson = contentType.includes('application/json');

  if (res.status === 404 || res.status === 405) {
    return !isJson;
  }

  if (!res.ok && contentType && !isJson && (contentType.includes('text/plain') || contentType.includes('text/html'))) {
    return true;
  }

  return false;
}

async function apiRequest(path, options = {}) {
  const anonymousId = await getAnonymousId();
  const baseUrls = await getBaseUrls();
  let lastError = null;

  for (const baseUrl of baseUrls) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (anonymousId) headers['X-Anonymous-Id'] = anonymousId;

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? API_REQUEST_TIMEOUT_MS;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const { timeoutMs: _timeoutMs, signal: callerSignal, ...fetchOptions } = options;

    try {
      const res = await fetch(`${baseUrl}${path}`, {
        credentials: 'include',
        ...fetchOptions,
        headers,
        signal: callerSignal || controller.signal,
      });

      if (isInvalidApiHostResponse(path, res)) {
        lastError = new Error(`Host ${baseUrl} does not expose the expected API for ${path} (HTTP ${res.status}).`);
        console.warn('[apiRequest] skipping non-API host response', {
          baseUrl,
          path,
          status: res.status,
          contentType: res.headers.get('content-type') || '',
        });
        continue;
      }

      await setActiveBaseUrl(baseUrl);
      return res;
    } catch (err) {
      lastError = err;
      console.warn('[apiRequest] host failed', {
        baseUrl,
        path,
        name: err?.name,
        message: err?.message,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error('Unable to reach Grabbn.');
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function checkAuthStatus() {
  try {
    const res = await apiRequest('/api/auth/status');
    if (!res.ok) return { authenticated: false };
    return await res.json();
  } catch {
    return { authenticated: false };
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'CHECK_AUTH': {
          const cached = await getCachedAuthStatus();
          if (cached) {
            sendResponse(cached);
            return;
          }

          const anonymousId = await getAnonymousId();
          if (!anonymousId) {
            await syncAnonymousIdFromCookie();
          }

          const status = await checkAuthStatus();
          if (status.authenticated) {
            await setCachedAuthStatus(status);
          }
          sendResponse(status);
          break;
        }

        case 'LOGIN': {
          try {
            const res = await apiRequest('/api/auth/login', {
              method: 'POST',
              body: JSON.stringify({ email: msg.email, password: msg.password }),
              timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
            });
            let data;
            try {
              data = await res.json();
            } catch (parseErr) {
              console.error('[LOGIN] non-JSON response', res.status, parseErr.message);
              sendResponse({ ok: false, error: `Server error (HTTP ${res.status})` });
              return;
            }
            if (!res.ok) {
              sendResponse({ ok: false, error: data?.error || data?.message || `Login failed (${res.status})` });
              return;
            }
            sendResponse({ ok: true, requiresOtp: data.requiresOtp, email: data.email });
          } catch (err) {
            console.error('[LOGIN] fetch error:', {
              name: err?.name,
              message: err?.message,
              stack: err?.stack,
            });
            sendResponse({
              ok: false,
              error: normalizeRequestError(err, 'Login failed. Please try again.'),
            });
          }
          break;
        }

        case 'VERIFY_OTP': {
          try {
            const res = await apiRequest('/api/auth/verify-otp', {
              method: 'POST',
              body: JSON.stringify({ email: msg.email, code: msg.code }),
              timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
              sendResponse({ ok: false, error: data.error || 'Invalid code' });
              return;
            }

            if (data.anonymousId) {
              await setAnonymousId(data.anonymousId);
            } else {
              await syncAnonymousIdFromCookie();
            }
            const authStatus = { authenticated: true, user: data.user };
            await setCachedAuthStatus(authStatus);
            sendResponse({ ok: true, user: data.user });
          } catch (err) {
            sendResponse({
              ok: false,
              error: normalizeRequestError(err, 'Verification failed. Please try again.'),
            });
          }
          break;
        }

        case 'LOGOUT': {
          try {
            await apiRequest('/api/auth/logout', { method: 'POST' });
          } catch {}
          await clearAnonymousId();
          await clearAuthCache();
          sendResponse({ ok: true });
          break;
        }

        case 'ACTIVATE_PICK_MODE': {
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
            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              sendResponse({ ok: false, error: errData.error || '', used: errData.used, limit: errData.limit });
              return;
            }
            const data = await res.json();
            sendResponse({
              ok: true,
              title: data.title || '',
              image: data.image || '',
              images: data.images || [],
              provider: data.provider || '',
              imageStatus: data.imageStatus || '',
              imageReason: data.imageReason || '',
            });
          } catch (err) {
            sendResponse({ ok: false, error: normalizeRequestError(err) });
          }
          break;
        }

        case 'GET_BUCKETS': {
          try {
            const res = await apiRequest('/api/buckets/mine');
            if (!res.ok) {
              sendResponse({ ok: false, error: 'Failed to load buckets' });
              return;
            }
            const buckets = await res.json();
            sendResponse({ ok: true, buckets });
          } catch (err) {
            sendResponse({ ok: false, error: normalizeRequestError(err) });
          }
          break;
        }

        case 'SAVE_LINKS': {
          try {
            const processedLinks = [];
            for (const link of msg.links || []) {
              let image = link.image?.startsWith('data:') ? link.image : '';
              if (!image && link.images?.length) {
                for (const url of link.images) {
                  image = await fetchImageBase64(url);
                  if (image) break;
                }
              }
              if (!image && link.image) {
                image = await fetchImageBase64(link.image);
              }
              processedLinks.push({
                href: link.href,
                text: link.text || '',
                image,
              });
            }
            const res = await apiRequest('/api/links', {
              method: 'POST',
              body: JSON.stringify({ links: processedLinks, buckets: msg.bucketNames }),
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              sendResponse({ ok: false, error: err.error || 'Failed to save' });
              return;
            }
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: normalizeRequestError(err) });
          }
          break;
        }

        case 'SAVE_LINK': {
          try {
            let image = msg.image?.startsWith('data:') ? msg.image : '';
            if (!image && msg.images?.length) {
              for (const url of msg.images) {
                image = await fetchImageBase64(url);
                if (image) break;
              }
            }
            if (!image && msg.image) {
              image = await fetchImageBase64(msg.image);
            }
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
            sendResponse({ ok: false, error: normalizeRequestError(err) });
          }
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[background:onMessage]', msg?.type, err);
      sendResponse({
        ok: false,
        authenticated: false,
        error: normalizeRequestError(err, 'Unexpected error'),
      });
    }
  })();

  return true; // keep message channel open for async response
});
