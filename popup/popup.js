// popup/popup.js - Task manager popup

// ===== Firebase Auth (REST API — no SDK required) =====
// Replace YOUR_FIREBASE_API_KEY with the Web API Key from:
// Firebase Console → Project Settings → General → Web API Key
const FIREBASE_API_KEY = 'AIzaSyA7dMDGoWCDXSIWBZ5Bl-NFnnXAp2zV6i4';
const cloudStore = window.TaskSaverCloud;
const appConfig = window.TaskSaverConfig || {};

async function getAuthState() {
  const data = await chrome.storage.local.get('auth');
  return data.auth || null;
}

async function isAuthenticated() {
  const auth = await getAuthState();
  if (!auth || !auth.idToken) return false;
  if (Date.now() < auth.expiresAt - 30000) return true; // 30s buffer
  return await refreshAuthToken(auth.refreshToken);
}

async function refreshAuthToken(refreshToken) {
  try {
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
      }
    );
    if (!res.ok) { await signOut(); return false; }
    const json = await res.json();
    const auth = await getAuthState();
    await chrome.storage.local.set({ auth: {
      ...auth,
      idToken: json.id_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (parseInt(json.expires_in, 10) * 1000),
    }});
    return true;
  } catch { await signOut(); return false; }
}

async function signInWithEmailPassword(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'LOGIN_FAILED');
  return json; // { idToken, refreshToken, localId, email, expiresIn }
}

async function signUpWithEmailPassword(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'SIGNUP_FAILED');
  return json; // { idToken, refreshToken, localId, email, expiresIn }
}

async function signOut() {
  await chrome.storage.local.remove('auth');
  await chrome.storage.sync.remove('currentOwner');
  await cloudStore.postSignOut();
}

function friendlyAuthError(code, mode) {
  // API key not yet configured
  if (code.includes('API_KEY_INVALID') || code.includes('API key not valid'))
    return 'Firebase API key not configured. See popup.js → FIREBASE_API_KEY.';
  // Common to both modes
  if (code.includes('INVALID_EMAIL'))         return 'Please enter a valid email address.';
  if (code.includes('NETWORK_REQUEST_FAILED')) return 'Network error. Check your connection.';
  if (code.includes('TOO_MANY_REQUESTS') || code.includes('TOO_MANY_ATTEMPTS'))
    return 'Too many attempts. Please wait a moment and try again.';

  if (mode === 'signup') {
    if (code.includes('EMAIL_EXISTS'))  return 'An account with this email already exists.';
    if (code.includes('WEAK_PASSWORD')) return 'Password must be at least 6 characters.';
    if (code.includes('ADMIN_ONLY_OPERATION')) return 'Sign-ups are disabled for this project.';
    return `Sign up failed: ${code}`;
  }
  if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/.test(code))
    return 'Invalid email or password.';
  if (code.includes('USER_DISABLED')) return 'This account has been disabled.';
  return `Sign in failed: ${code}`;
}

// ===== Default settings (fallback) =====

const DEFAULT_SETTINGS = {
  owners: [
    { id: 'owner_default', label: 'You', email: '', color: '#4573d2', bg: '#eef2fc' },
  ],
  stages: [
    { value: 'prospect',       label: 'Prospect',       color: '#6366f1', bg: '#eeeefd' },
    { value: 'lead',           label: 'Lead',           color: '#3b82f6', bg: '#eff6ff' },
    { value: 'interested',     label: 'Interested',     color: '#d97706', bg: '#fffbeb' },
    { value: 'not_interested', label: 'Not Interested', color: '#9ba4b0', bg: '#f3f4f6' },
    { value: 'nurturing',      label: 'Nurturing',      color: '#7c3aed', bg: '#f5f3ff' },
    { value: 'win',            label: 'Win',            color: '#2da44e', bg: '#edfbf2' },
    { value: 'dead',           label: 'Dead',           color: '#d32f2f', bg: '#fdecea' },
  ],
};

// Mutable — populated by loadSettings() before any render
let OWNERS = DEFAULT_SETTINGS.owners;

let currentFilter = 'today';
let currentOwner  = OWNERS[0].id;

// 'signin' | 'signup' — tracks which mode the auth form is in
let _authMode = 'signin';

// Guard to prevent registering storage.onChanged listener more than once
let _listenersSetup = false;
let _lockListenersSetup = false;

function ownerFromEmail(email, fallbackId) {
  const safeEmail = (email || '').trim().toLowerCase();
  const local = safeEmail.split('@')[0] || 'owner';
  const id = (fallbackId || `owner_${local}`).replace(/[^a-z0-9_]/g, '_');
  const labelBase = local.replace(/[^a-z0-9]+/g, ' ').trim();
  const label = labelBase ? labelBase.charAt(0).toUpperCase() + labelBase.slice(1) : 'You';
  return { id, label, email: safeEmail, color: '#4573d2', bg: '#eef2fc' };
}

async function ensureSingleOwnerSettings(email, preferredId) {
  const owner = ownerFromEmail(email, preferredId);
  await cloudStore.setSettings({
    owners: [owner],
    stages: DEFAULT_SETTINGS.stages,
  });
  OWNERS = [owner];
  return owner;
}

async function loadSettings() {
  const s = await cloudStore.getSettings();
  if (s && Array.isArray(s.owners) && s.owners.length > 0) {
    OWNERS = s.owners;
  } else {
    OWNERS = DEFAULT_SETTINGS.owners;
  }
}

// ===== Freemium gate =====
// Users can create up to FREE_TASK_LIMIT tasks without signing in.
// Once they hit the limit, the auth gate is shown and login is required.
const FREE_TASK_LIMIT = appConfig.FREE_TASK_LIMIT || 100;

async function getTaskCount() {
  const tasks = await cloudStore.getTasks();
  return tasks.length;
}

function openHomePage(mode) {
  const suffix = mode ? `?mode=${encodeURIComponent(mode)}` : '';
  chrome.tabs.create({ url: chrome.runtime.getURL(`home/home.html${suffix}`) });
}

async function completePostSignInMergeFlow() {
  try {
    let syncResult = await cloudStore.postSignIn();
    if (syncResult && syncResult.needsMergeChoice) {
      const prompt = syncResult.hasRemoteData
        ? `Found ${syncResult.guestTaskCount} guest tasks on this device. Merge them into your account data?`
        : `No cloud data found for this account. Merge ${syncResult.guestTaskCount} guest tasks into this account?`;
      const shouldMerge = confirm(prompt);
      syncResult = await cloudStore.postSignIn({ mergeGuestData: shouldMerge });
    }
    if (syncResult && syncResult.ok === false && syncResult.reason === 'REMOTE_WRITE_FAILED') {
      alert('Signed in, but guest data merge failed (cloud write issue). Your guest data is kept locally.');
      await cloudStore.postSignIn({ mergeGuestData: false });
    }
  } catch (_) {
    // Keep sign-in successful even if sync step fails.
  }
}

// ===== Boot =====
// The app always loads — we never block with a fullscreen auth gate.
// When the free limit is reached and the user is not signed in, a sticky
// banner is shown at the top, but the dashboard remains fully visible.

document.addEventListener('DOMContentLoaded', async () => {
  await cloudStore.init();
  await initApp();
  await applyAccessState();
});

// ===== Auth form =====

function setupAuthForm() {
  _authMode = 'signin';

  // Replace form element to clear any previously attached listeners
  const oldForm = document.getElementById('auth-form');
  const newForm = oldForm.cloneNode(true);
  oldForm.parentNode.replaceChild(newForm, oldForm);
  document.getElementById('auth-form').addEventListener('submit', handleLogin);

  // Clear previous error/value state and reset to sign-in labels
  document.getElementById('auth-error').hidden = true;
  document.getElementById('auth-subtitle').textContent = 'One tap. Back in the conversation';
  const submitBtn = document.getElementById('auth-submit');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Sign In';

  // Toggle switch
  document.getElementById('auth-switch-text').textContent = "Don't have an account?";
  const switchBtn = document.getElementById('auth-switch-btn');
  switchBtn.textContent = 'Sign Up';
  switchBtn.onclick = () => toggleAuthMode();
}

function toggleAuthMode() {
  _authMode = _authMode === 'signin' ? 'signup' : 'signin';
  const isSignUp = _authMode === 'signup';

  document.getElementById('auth-subtitle').textContent  = 'One tap. Back in the conversation';
  document.getElementById('auth-submit').textContent    = isSignUp ? 'Sign Up' : 'Sign In';
  document.getElementById('auth-switch-text').textContent = isSignUp ? 'Already have an account?' : "Don't have an account?";
  document.getElementById('auth-switch-btn').textContent  = isSignUp ? 'Sign In' : 'Sign Up';
  document.getElementById('auth-error').hidden = true;
}

async function handleLogin(e) {
  e.preventDefault();
  const email     = document.getElementById('auth-email').value.trim();
  const password  = document.getElementById('auth-password').value;
  const errorEl   = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit');
  const isSignUp  = _authMode === 'signup';

  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = isSignUp ? 'Creating account…' : 'Signing in…';

  try {
    const json = isSignUp
      ? await signUpWithEmailPassword(email, password)
      : await signInWithEmailPassword(email, password);

    await loadSettings();
    const owner = OWNERS.find(o => o.email && o.email.toLowerCase() === email.toLowerCase());
    const resolvedOwner = isSignUp
      ? await ensureSingleOwnerSettings(email, `owner_${json.localId}`)
      : (owner || ownerFromEmail(email, `owner_${json.localId}`));
    const ownerId = resolvedOwner.id;

    await chrome.storage.local.set({
      auth: {
        idToken:      json.idToken,
        refreshToken: json.refreshToken,
        localId:      json.localId,
        email:        json.email,
        ownerId,
        expiresAt:    Date.now() + (parseInt(json.expiresIn, 10) * 1000),
      }
    });

    currentOwner = ownerId;
    await chrome.storage.sync.set({ currentOwner });

    // Close auth modal and refresh access state — user is now signed in
    closeAuthModal();
    await completePostSignInMergeFlow();

    await initApp();
    await applyAccessState();
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err.message, _authMode);
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = isSignUp ? 'Sign Up' : 'Sign In';
  }
}

// ===== App init (runs only when authenticated) =====

async function initApp() {
  await loadSettings();

  // Resolve currentOwner: prefer auth-stamped ownerId, then sync storage
  const authState = await getAuthState();
  if (authState?.ownerId && OWNERS.find(o => o.id === authState.ownerId)) {
    currentOwner = authState.ownerId;
    await chrome.storage.sync.set({ currentOwner });
  } else {
    const stored = await chrome.storage.sync.get('currentOwner');
    if (stored.currentOwner && OWNERS.find(o => o.id === stored.currentOwner)) {
      currentOwner = stored.currentOwner;
    } else {
      currentOwner = OWNERS[0].id;
    }
  }

  setupOwnerSwitcher();
  await renderTasks();
  setupFilterTabs();

  // Register one-time listeners only once (initApp can be called multiple times after login)
  if (!_listenersSetup) {
    _listenersSetup = true;

    document.getElementById('open-dashboard-btn').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    });

    document.getElementById('signout-btn').addEventListener('click', handleAuthActionClick);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.tasks) renderTasks();
      if (area === 'local' && changes.settings) {
        loadSettings().then(() => {
          if (!OWNERS.find(o => o.id === currentOwner)) {
            currentOwner = OWNERS[0].id;
            chrome.storage.sync.set({ currentOwner });
          }
          setupOwnerSwitcher();
          renderTasks();
        });
      }
      if (area === 'sync' && changes.currentOwner) {
        currentOwner = changes.currentOwner.newValue;
        setupOwnerSwitcher();
        renderTasks();
      }
      if (area === 'local' && (changes.auth || changes.tasks || changes.settings)) {
        applyAccessState();
      }
    });
  }
}

async function handleAuthActionClick() {
  const authed = await isAuthenticated();
  if (authed) {
    await signOut();
    openHomePage('signin');
    return;
  }
  openHomePage('signin');
}

function updateAuthActionButton(authed) {
  const btn = document.getElementById('signout-btn');
  if (!btn) return;
  if (authed) {
    btn.textContent = 'Sign Out';
    btn.title = 'Sign out';
  } else {
    btn.textContent = 'Sign In';
    btn.title = 'Sign in';
  }
}

function setLockedReadonly(locked, taskCount) {
  const app = document.getElementById('app-content');
  const root = document.getElementById('popup-root');
  if (!app || !root) return;

  app.classList.toggle('app-content--locked', locked);
  if (!locked) {
    const existing = document.getElementById('readonly-lock-overlay');
    if (existing) existing.remove();
    return;
  }

  let overlay = document.getElementById('readonly-lock-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'readonly-lock-overlay';
    overlay.className = 'readonly-lock-overlay';
    overlay.innerHTML = `
      <div class="readonly-lock-box">
        <h3>Read-only preview</h3>
        <p id="readonly-lock-msg"></p>
        <div class="readonly-lock-actions">
          <button id="readonly-signin-btn" class="readonly-lock-btn readonly-lock-btn--signin">Sign In</button>
          <button id="readonly-signup-btn" class="readonly-lock-btn readonly-lock-btn--signup">Sign Up</button>
        </div>
      </div>
    `;
    root.appendChild(overlay);
  }

  const msg = overlay.querySelector('#readonly-lock-msg');
  if (msg) msg.textContent = `You have ${taskCount} tasks. Sign in to edit tasks in popup.`;

  if (!_lockListenersSetup) {
    _lockListenersSetup = true;
    overlay.querySelector('#readonly-signin-btn')?.addEventListener('click', () => openHomePage('signin'));
    overlay.querySelector('#readonly-signup-btn')?.addEventListener('click', () => openHomePage('signup'));
  }
}

async function applyAccessState() {
  const [authed, taskCount] = await Promise.all([isAuthenticated(), getTaskCount()]);
  updateAuthActionButton(authed);
  const locked = !authed && taskCount >= FREE_TASK_LIMIT;
  setLockedReadonly(locked, taskCount);
  removeFreemiumBanner();
}

// ===== Freemium banner =====
// Shown as a sticky strip below the popup header when the user hits the free
// task limit but is not signed in. The full app remains visible beneath it.

function showFreemiumBanner(taskCount) {
  removeFreemiumBanner(); // prevent duplicates

  const banner = document.createElement('div');
  banner.id = 'freemium-banner';
  banner.className = 'freemium-banner';
  banner.innerHTML = `
    <span class="freemium-banner__text">
      🔒 You've used <strong>${taskCount}</strong> free tasks.
      Sign in to keep saving.
    </span>
    <div class="freemium-banner__actions">
      <button class="freemium-banner__btn freemium-banner__btn--signin" id="fb-signin">Sign In</button>
      <button class="freemium-banner__btn freemium-banner__btn--signup" id="fb-signup">Sign Up</button>
    </div>
  `;

  // Insert at the very top of #popup-root (above everything)
  const root = document.getElementById('popup-root');
  root.prepend(banner);

  banner.querySelector('#fb-signin').addEventListener('click', () => openHomePage('signin'));
  banner.querySelector('#fb-signup').addEventListener('click', () => openHomePage('signup'));
}

function removeFreemiumBanner() {
  const b = document.getElementById('freemium-banner');
  if (b) b.remove();
}

// ===== Compact auth modal (used by freemium banner) =====

function openAuthModal(mode) {
  closeAuthModal(); // prevent duplicates

  _authMode = mode || 'signin';
  const isSignUp = _authMode === 'signup';
  document.body.classList.add('auth-open');

  const overlay = document.createElement('div');
  overlay.id = 'auth-modal-overlay';
  overlay.className = 'auth-modal-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAuthModal(); });

  const box = document.createElement('div');
  box.className = 'auth-modal-box';

  box.innerHTML = `
    <button class="auth-modal-close" id="auth-modal-close-btn" aria-label="Close">✕</button>
    <div class="auth-logo" style="font-size:30px;margin-bottom:6px;">📋</div>
    <h2 class="auth-title" style="font-size:14px;">Nudge</h2>
    <p class="auth-subtitle" id="auth-modal-subtitle" style="font-size:12px;margin-bottom:12px;">
      One tap. Back in the conversation
    </p>
    <form id="auth-modal-form" class="auth-form" novalidate>
      <input id="auth-modal-email" type="email" class="auth-input" placeholder="Email" autocomplete="email" required />
      <input id="auth-modal-password" type="password" class="auth-input" placeholder="Password" autocomplete="current-password" required />
      <p id="auth-modal-error" class="auth-error" hidden></p>
      <button type="submit" id="auth-modal-submit" class="auth-submit-btn">
        ${isSignUp ? 'Sign Up' : 'Sign In'}
      </button>
    </form>
    <p class="auth-switch">
      <span id="auth-modal-switch-text">${isSignUp ? 'Already have an account?' : "Don't have an account?"}</span>
      <button type="button" id="auth-modal-switch-btn" class="auth-switch-btn">
        ${isSignUp ? 'Sign In' : 'Sign Up'}
      </button>
    </p>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  box.querySelector('#auth-modal-close-btn').addEventListener('click', closeAuthModal);
  box.querySelector('#auth-modal-form').addEventListener('submit', handleAuthModalLogin);
  box.querySelector('#auth-modal-switch-btn').addEventListener('click', () => {
    const newMode = _authMode === 'signin' ? 'signup' : 'signin';
    closeAuthModal();
    openAuthModal(newMode);
  });

  box.querySelector('#auth-modal-email').focus();
}

function closeAuthModal() {
  const el = document.getElementById('auth-modal-overlay');
  if (el) el.remove();
  document.body.classList.remove('auth-open');
}

async function handleAuthModalLogin(e) {
  e.preventDefault();
  const email     = document.getElementById('auth-modal-email').value.trim();
  const password  = document.getElementById('auth-modal-password').value;
  const errorEl   = document.getElementById('auth-modal-error');
  const submitBtn = document.getElementById('auth-modal-submit');
  const isSignUp  = _authMode === 'signup';

  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = isSignUp ? 'Creating account…' : 'Signing in…';

  try {
    const json = isSignUp
      ? await signUpWithEmailPassword(email, password)
      : await signInWithEmailPassword(email, password);

    await loadSettings();
    const owner = OWNERS.find(o => o.email && o.email.toLowerCase() === email.toLowerCase());
    const resolvedOwner = isSignUp
      ? await ensureSingleOwnerSettings(email, `owner_${json.localId}`)
      : (owner || ownerFromEmail(email, `owner_${json.localId}`));
    const ownerId = resolvedOwner.id;

    await chrome.storage.local.set({
      auth: {
        idToken:      json.idToken,
        refreshToken: json.refreshToken,
        localId:      json.localId,
        email:        json.email,
        ownerId,
        expiresAt:    Date.now() + (parseInt(json.expiresIn, 10) * 1000),
      }
    });

    currentOwner = ownerId;
    await chrome.storage.sync.set({ currentOwner });

    // Close modal and refresh access state — user is now signed in
    closeAuthModal();
    await completePostSignInMergeFlow();

    await initApp();
    await applyAccessState();
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err.message, _authMode);
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = isSignUp ? 'Sign Up' : 'Sign In';
  }
}

// ===== Owner switcher =====

function setupOwnerSwitcher() {
  const ownerBar = document.getElementById('owner-bar');
  const container = document.getElementById('owner-pills');
  if (ownerBar) ownerBar.hidden = OWNERS.length <= 1;
  container.innerHTML = '';
  OWNERS.forEach(owner => {
    const pill = document.createElement('button');
    pill.className = 'owner-pill' + (owner.id === currentOwner ? ' owner-pill--active' : '');
    pill.textContent = owner.label;
    pill.style.setProperty('--owner-color', owner.color);
    pill.style.setProperty('--owner-bg', owner.bg);
    pill.title = `Switch to ${owner.label}`;
    pill.addEventListener('click', async () => {
      currentOwner = owner.id;
      await chrome.storage.sync.set({ currentOwner });
      setupOwnerSwitcher();
      renderTasks();
    });
    container.appendChild(pill);
  });
}

async function renderTasks() {
  const allTasks = await cloudStore.getTasks();

  // Today = reminder date falls within today (overdue tasks also shown in pending)
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);

  const filtered = allTasks.filter(task => {
    // Filter by owner — tasks without an owner are shown under everyone
    if (OWNERS.length > 1 && task.owner && task.owner !== currentOwner) return false;
    if (currentFilter === 'today')     return !task.completed && task.remindAt >= todayStart.getTime() && task.remindAt <= todayEnd.getTime();
    if (currentFilter === 'pending')   return !task.completed;
    if (currentFilter === 'completed') return task.completed;
    return true;
  });

  // Sort: pending first by remindAt asc, completed last
  filtered.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return a.remindAt - b.remindAt;
  });

  const container = document.getElementById('task-list-container');
  const emptyState = document.getElementById('empty-state');

  container.querySelectorAll('.task-card').forEach(el => el.remove());

  if (filtered.length === 0) {
    emptyState.hidden = false;
  } else {
    emptyState.hidden = true;
    filtered.forEach(task => container.appendChild(buildTaskCard(task)));
  }

  // Header badge = tasks due today
  const tStart = new Date(); tStart.setHours(0, 0, 0, 0);
  const tEnd   = new Date(); tEnd.setHours(23, 59, 59, 999);
  const todayCount = allTasks.filter(t => !t.completed && t.remindAt >= tStart.getTime() && t.remindAt <= tEnd.getTime()).length;
  const badge = document.getElementById('badge-count');
  badge.textContent = todayCount > 99 ? '99+' : String(todayCount);
  badge.hidden = todayCount === 0;
}

function buildTaskCard(task) {
  const card = document.createElement('div');
  card.className = `task-card${task.completed ? ' task-card--completed' : ''}`;
  card.setAttribute('role', 'listitem');

  // ---- Top row: contact name + status pill ----
  const topRow = document.createElement('div');
  topRow.className = 'task-card__top';

  // Avatar
  const displayName = (task.firstName || task.lastName) ? `${task.firstName || ''} ${task.lastName || ''}`.trim() : (task.contactName || 'Unknown');
  const initials = ((task.firstName || task.contactName || '?')[0] + (task.lastName || '')[0]).toUpperCase();

  const avatar = document.createElement('span');
  avatar.className = 'task-card__avatar';
  avatar.textContent = initials;

  const contactEl = document.createElement('span');
  contactEl.className = 'task-card__contact';
  contactEl.textContent = displayName;

  const statusPill = document.createElement('span');
  const overdue = !task.completed && task.remindAt < Date.now();
  statusPill.className = `task-card__status ${task.completed ? 'status--done' : overdue ? 'status--overdue' : 'status--pending'}`;
  statusPill.textContent = task.completed ? 'Done' : overdue ? 'Overdue' : 'Pending';

  topRow.append(avatar, contactEl, statusPill);

  // ---- Links row (profile + thread) ----
  const linksRow = document.createElement('div');
  linksRow.className = 'task-card__links';
  if (task.profileUrl) {
    const profLink = document.createElement('a');
    profLink.className = 'task-card__profile-link';
    profLink.href = task.profileUrl;
    profLink.target = '_blank';
    profLink.rel = 'noopener noreferrer';
    profLink.textContent = '👤 Profile';
    linksRow.appendChild(profLink);
  }
  if (task.threadUrl) {
    const threadLink = document.createElement('a');
    threadLink.className = 'task-card__thread';
    threadLink.href = task.threadUrl;
    threadLink.target = '_blank';
    threadLink.rel = 'noopener noreferrer';
    threadLink.textContent = '💬 Thread';
    linksRow.appendChild(threadLink);
  }

  // ---- Owner badge ----
  if (task.owner) {
    const ownerDef = OWNERS.find(o => o.id === task.owner);
    if (ownerDef) {
      const ownerBadge = document.createElement('span');
      ownerBadge.className = 'task-card__owner';
      ownerBadge.textContent = ownerDef.label[0];
      ownerBadge.title = ownerDef.label;
      ownerBadge.style.setProperty('--owner-color', ownerDef.color);
      ownerBadge.style.setProperty('--owner-bg', ownerDef.bg);
      topRow.appendChild(ownerBadge);
    }
  }

  // ---- Follow-up info ----
  const followupEl = document.createElement('p');
  followupEl.className = 'task-card__followup';
  const followupDays = task.followupDays ? `${task.followupDays}-day follow-up` : 'Follow-up';
  followupEl.textContent = `${followupDays} · ${formatDate(task.remindAt)}`;

  // ---- Notes (optional) ----
  let notesEl = null;
  if (task.description) {
    notesEl = document.createElement('p');
    notesEl.className = 'task-card__notes';
    notesEl.textContent = task.description;
  }

  // ---- Actions ----
  const actions = document.createElement('div');
  actions.className = 'task-card__actions';

  if (!task.completed) {
    const completeBtn = document.createElement('button');
    completeBtn.className = 'task-btn task-btn--complete';
    completeBtn.textContent = '✓ Done';
    completeBtn.addEventListener('click', () => handleComplete(task.id));
    actions.appendChild(completeBtn);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'task-btn task-btn--delete';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => handleDelete(task.id));
  actions.appendChild(deleteBtn);

  // ---- Assemble ----
  card.appendChild(topRow);
  if (linksRow.children.length > 0) card.appendChild(linksRow);
  card.appendChild(followupEl);
  if (notesEl) card.appendChild(notesEl);
  card.appendChild(actions);

  return card;
}

async function handleComplete(taskId) {
  const tasks = (await cloudStore.getTasks()).map(t => t.id === taskId ? { ...t, completed: true } : t);
  await cloudStore.setTasks(tasks);
  chrome.runtime.sendMessage({ action: 'DELETE_ALARM', alarmName: taskId });
  await renderTasks();
}

async function handleDelete(taskId) {
  const tasks = (await cloudStore.getTasks()).filter(t => t.id !== taskId);
  await cloudStore.setTasks(tasks);
  chrome.runtime.sendMessage({ action: 'DELETE_ALARM', alarmName: taskId });
  await renderTasks();
}

function setupFilterTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('tab-btn--active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('tab-btn--active');
      btn.setAttribute('aria-selected', 'true');
      currentFilter = btn.dataset.filter;
      renderTasks();
    });
  });
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  }) + ' · 9:00 AM';
}
