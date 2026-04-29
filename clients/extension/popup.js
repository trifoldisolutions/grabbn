let pendingEmail = '';

const views = {
  loading:   document.getElementById('view-loading'),
  loggedin:  document.getElementById('view-loggedin'),
  login:     document.getElementById('view-login'),
  otp:       document.getElementById('view-otp'),
};

function showView(name) {
  Object.values(views).forEach(v => v.style.display = 'none');
  views[name].style.display = name === 'loggedin' || name === 'login' || name === 'otp' ? 'block' : 'flex';
}

function setError(id, msg) {
  document.getElementById(id).textContent = msg;
}

// ---------------------------------------------------------------------------
// Boot — check auth state
// ---------------------------------------------------------------------------

chrome.runtime.sendMessage({ type: 'CHECK_AUTH' }, (res) => {
  if (res?.authenticated && res.user) {
    document.getElementById('header-user').textContent = res.user.username || res.user.email || '';
    showView('loggedin');
  } else {
    showView('login');
  }
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

document.getElementById('btn-login').addEventListener('click', async () => {
  const email    = document.getElementById('input-email').value.trim();
  const password = document.getElementById('input-password').value;
  setError('login-error', '');

  if (!email || !password) { setError('login-error', 'Email and password are required.'); return; }

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  const res = await chrome.runtime.sendMessage({ type: 'LOGIN', email, password });

  btn.disabled = false;
  btn.textContent = 'Sign in';

  if (!res.ok) { setError('login-error', res.error); return; }

  pendingEmail = res.email || email;
  document.getElementById('otp-hint').textContent = `Enter the 6-digit code sent to ${pendingEmail}.`;
  showView('otp');
});

// Enter key on password field submits login
document.getElementById('input-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-login').click();
});

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------

document.getElementById('btn-otp').addEventListener('click', async () => {
  const code = document.getElementById('input-otp').value.trim();
  setError('otp-error', '');

  if (!code) { setError('otp-error', 'Enter the verification code.'); return; }

  const btn = document.getElementById('btn-otp');
  btn.disabled = true;
  btn.textContent = 'Verifying…';

  const res = await chrome.runtime.sendMessage({ type: 'VERIFY_OTP', email: pendingEmail, code });

  btn.disabled = false;
  btn.textContent = 'Verify';

  if (!res.ok) { setError('otp-error', res.error); return; }

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

  await chrome.runtime.sendMessage({ type: 'ACTIVATE_PICK_MODE' });
  window.close(); // close popup so user can interact with the page
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

document.getElementById('btn-logout').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'LOGOUT' });
  document.getElementById('header-user').textContent = '';
  document.getElementById('input-email').value = '';
  document.getElementById('input-password').value = '';
  showView('login');
});
