const MESSAGE_TIMEOUT_MS = 35000;

let pendingEmail = '';

const views = {
  loading: document.getElementById('view-loading'),
  loggedin: document.getElementById('view-loggedin'),
  login: document.getElementById('view-login'),
  otp: document.getElementById('view-otp'),
};

function showView(name) {
  Object.values(views).forEach(view => {
    view.style.display = 'none';
  });
  views[name].style.display = name === 'loggedin' || name === 'login' || name === 'otp' ? 'block' : 'flex';
}

function sendRuntimeMessage(message, { timeoutMs = MESSAGE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The extension took too long to respond. Please try again.'));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

async function savePendingOtp(email) {
  await chrome.storage.session.set({ pendingOtpEmail: email });
}

async function clearPendingOtp() {
  await chrome.storage.session.remove('pendingOtpEmail');
}

function setError(id, msg) {
  document.getElementById(id).textContent = msg;
}

async function initializePopup() {
  try {
    const res = await sendRuntimeMessage({ type: 'CHECK_AUTH' });
    if (res?.authenticated && res.user) {
      await clearPendingOtp();
      document.getElementById('header-user').textContent = res.user.username || res.user.email || '';
      showView('loggedin');
      return;
    }
  } catch (err) {
    setError('login-error', err.message || 'Unable to check your session right now.');
  }

  const { pendingOtpEmail } = await chrome.storage.session.get('pendingOtpEmail');
  if (pendingOtpEmail) {
    pendingEmail = pendingOtpEmail;
    document.getElementById('otp-hint').textContent = `Enter the 6-digit code sent to ${pendingEmail}.`;
    showView('otp');
    return;
  }

  showView('login');
}

initializePopup();

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

document.getElementById('btn-login').addEventListener('click', async () => {
  const email = document.getElementById('input-email').value.trim();
  const password = document.getElementById('input-password').value;
  setError('login-error', '');

  if (!email || !password) {
    setError('login-error', 'Email and password are required.');
    return;
  }

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  let res;
  try {
    res = await sendRuntimeMessage({ type: 'LOGIN', email, password });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Sign in';
    setError('login-error', err.message || 'Login failed.');
    return;
  }

  btn.disabled = false;
  btn.textContent = 'Sign in';

  if (!res?.ok) {
    setError('login-error', res?.error || 'Login failed.');
    return;
  }

  pendingEmail = res.email || email;
  await savePendingOtp(pendingEmail);
  document.getElementById('otp-hint').textContent = `Enter the 6-digit code sent to ${pendingEmail}.`;
  showView('otp');
});

document.getElementById('input-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-login').click();
});

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------

document.getElementById('btn-otp').addEventListener('click', async () => {
  const code = document.getElementById('input-otp').value.trim();
  setError('otp-error', '');

  if (!code) {
    setError('otp-error', 'Enter the verification code.');
    return;
  }

  const btn = document.getElementById('btn-otp');
  btn.disabled = true;
  btn.textContent = 'Verifying...';

  let res;
  try {
    res = await sendRuntimeMessage({ type: 'VERIFY_OTP', email: pendingEmail, code });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Verify';
    setError('otp-error', err.message || 'Verification failed.');
    return;
  }

  btn.disabled = false;
  btn.textContent = 'Verify';

  if (!res?.ok) {
    setError('otp-error', res?.error || 'Invalid code');
    return;
  }

  await clearPendingOtp();
  document.getElementById('header-user').textContent = res.user?.username || res.user?.email || '';
  showView('loggedin');
});

document.getElementById('input-otp').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-otp').click();
});

// ---------------------------------------------------------------------------
// Pick mode
// ---------------------------------------------------------------------------

document.getElementById('btn-pick').addEventListener('click', async () => {
  const btn = document.getElementById('btn-pick');
  btn.disabled = true;

  try {
    await sendRuntimeMessage({ type: 'ACTIVATE_PICK_MODE' });
    window.close();
  } catch (err) {
    btn.disabled = false;
    setError('login-error', err.message || 'Could not start pick mode.');
    showView('loggedin');
  }
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

document.getElementById('btn-logout').addEventListener('click', async () => {
  try {
    await sendRuntimeMessage({ type: 'LOGOUT' });
  } catch {}

  document.getElementById('header-user').textContent = '';
  document.getElementById('input-email').value = '';
  document.getElementById('input-password').value = '';
  showView('login');
});
