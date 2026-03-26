// dashboard/dashboard.js - Full page task manager with contact timeline

// ===== Firebase Auth (REST API — no SDK required) =====
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
    return 'Firebase API key not configured. See dashboard.js → FIREBASE_API_KEY.';
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

// 'signin' | 'signup' — tracks which mode the auth form is in
let _authMode = 'signin';

// Guard to prevent registering storage.onChanged listener more than once
let _listenersSetup = false;
let _lockListenersSetup = false;

let currentFilter = 'today';
let currentSort = 'remindAt-asc';
let searchQuery = '';
let cachedAllTasks = [];
let currentView = 'table'; // 'cards' | 'table'
let currentOwnerFilter = 'all'; // 'all' | owner id

// ===== Default settings (fallback when no settings stored yet) =====

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
let STAGES = DEFAULT_SETTINGS.stages;

// In-memory draft used while settings modal is open
let _draftOwners = [];
let _draftStages = [];

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
  STAGES = DEFAULT_SETTINGS.stages;
  return owner;
}

function getOwner(id) {
  return OWNERS.find(o => o.id === id) || null;
}

function getStage(value) {
  return STAGES.find(s => s.value === value) || STAGES[0];
}

// ===== Load settings from storage =====

async function loadSettings() {
  const s = await cloudStore.getSettings();
  if (s && Array.isArray(s.owners) && s.owners.length > 0) {
    OWNERS = s.owners;
  } else {
    OWNERS = DEFAULT_SETTINGS.owners;
  }
  if (s && Array.isArray(s.stages) && s.stages.length > 0) {
    STAGES = s.stages;
  } else {
    STAGES = DEFAULT_SETTINGS.stages;
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
  location.href = chrome.runtime.getURL(`home/home.html${suffix}`);
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
// banner is injected below the header, but the dashboard remains visible.

document.addEventListener('DOMContentLoaded', async () => {
  await cloudStore.init();
  await initApp();
  await applyAccessState();
});

// ===== Auth form =====

function setupAuthForm() {
  _authMode = 'signin';

  // Replace form to clear any previously attached listeners
  const oldForm = document.getElementById('auth-form');
  const newForm = oldForm.cloneNode(true);
  oldForm.parentNode.replaceChild(newForm, oldForm);
  document.getElementById('auth-form').addEventListener('submit', handleLogin);
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

  document.getElementById('auth-subtitle').textContent    = 'One tap. Back in the conversation';
  document.getElementById('auth-submit').textContent      = isSignUp ? 'Sign Up' : 'Sign In';
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

    await chrome.storage.sync.set({ currentOwner: ownerId });

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

// ===== App init (runs only when authenticated) =====

async function initApp() {
  await loadSettings();     // MUST be first — populates OWNERS and STAGES
  await renderAll();
  setupNav();
  setupSearch();
  setupSort();
  setupTimeline();
  setupViewToggle();
  setupOwnerFilter();
  setupSettings();

  // Register one-time listeners only once (initApp can be called multiple times after login)
  if (!_listenersSetup) {
    _listenersSetup = true;

    document.getElementById('signout-btn').addEventListener('click', handleAuthActionClick);

    // Close any open stage dropdown when clicking outside
    document.addEventListener('click', () => {
      document.querySelectorAll('.stage-dropdown--open').forEach(d => d.classList.remove('stage-dropdown--open'));
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.tasks) renderAll();
      if (area === 'local' && changes.settings) {
        loadSettings().then(() => {
          setupOwnerFilter();
          renderAll();
        });
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
    btn.innerHTML = '⏏ Sign Out';
    btn.title = 'Sign out';
  } else {
    btn.innerHTML = '↪ Sign In';
    btn.title = 'Sign in';
  }
}

async function updateAuthUserLabel() {
  const el = document.getElementById('auth-user-label');
  if (!el) return;
  const auth = await getAuthState();
  if (auth && auth.email) {
    el.textContent = `Logged in as ${auth.email}`;
  } else {
    el.textContent = 'Guest mode';
  }
}

function setLockedReadonly(locked, taskCount) {
  document.body.classList.toggle('app-locked', locked);

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
    document.body.appendChild(overlay);
  }

  const msg = overlay.querySelector('#readonly-lock-msg');
  if (msg) msg.textContent = `You have ${taskCount} tasks. Sign in to edit tasks in dashboard.`;

  if (!_lockListenersSetup) {
    _lockListenersSetup = true;
    overlay.querySelector('#readonly-signin-btn')?.addEventListener('click', () => openHomePage('signin'));
    overlay.querySelector('#readonly-signup-btn')?.addEventListener('click', () => openHomePage('signup'));
  }
}

async function applyAccessState() {
  const [authed, taskCount] = await Promise.all([isAuthenticated(), getTaskCount()]);
  updateAuthActionButton(authed);
  await updateAuthUserLabel();
  const locked = !authed && taskCount >= FREE_TASK_LIMIT;
  setLockedReadonly(locked, taskCount);
  removeFreemiumBanner();
}

// ===== Freemium banner =====
// Shown as a sticky strip below the header when the user hits the free task
// limit but is not signed in. The full dashboard remains visible beneath it.

function showFreemiumBanner(taskCount) {
  removeFreemiumBanner(); // prevent duplicates

  const banner = document.createElement('div');
  banner.id = 'freemium-banner';
  banner.className = 'freemium-banner';
  banner.innerHTML = `
    <span class="freemium-banner__text">
      🔒 You've used <strong>${taskCount} free tasks</strong>.
      Sign in to keep saving new tasks.
    </span>
    <div class="freemium-banner__actions">
      <button class="freemium-banner__btn freemium-banner__btn--signin" id="fb-signin">Sign In</button>
      <button class="freemium-banner__btn freemium-banner__btn--signup" id="fb-signup">Sign Up Free</button>
    </div>
  `;

  // Insert at the very top of <main> so it sits below the header
  const main = document.getElementById('main-content');
  main.prepend(banner);

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

  const overlay = document.createElement('div');
  overlay.id = 'auth-modal-overlay';
  overlay.className = 'auth-modal-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAuthModal(); });

  const box = document.createElement('div');
  box.className = 'auth-modal-box';

  box.innerHTML = `
    <button class="auth-modal-close" id="auth-modal-close-btn" aria-label="Close">✕</button>
    <div class="auth-logo">📋</div>
    <h2 class="auth-title">Nudge</h2>
    <p class="auth-subtitle" id="auth-modal-subtitle">
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

  setTimeout(() => box.querySelector('#auth-modal-email').focus(), 50);
}

function closeAuthModal() {
  const el = document.getElementById('auth-modal-overlay');
  if (el) el.remove();
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

    await chrome.storage.sync.set({ currentOwner: ownerId });

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

// ===== Main render =====

async function renderAll() {
  cachedAllTasks = await cloudStore.getTasks();

  updateCounts(cachedAllTasks);
  updateStats(cachedAllTasks);
  renderTasks(cachedAllTasks);
}

// Returns start-of-today and end-of-today timestamps
function todayRange() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
}

// Returns start-of-this-week (Mon) and end-of-this-week (Sun) timestamps
function thisWeekRange() {
  const now   = new Date();
  const day   = now.getDay(); // 0=Sun..6=Sat
  const diff  = (day === 0 ? -6 : 1 - day); // shift to Monday
  const start = new Date(now); start.setDate(now.getDate() + diff); start.setHours(0, 0, 0, 0);
  const end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
}

function updateCounts(allTasks) {
  const now  = Date.now();
  const td   = todayRange();
  const wk   = thisWeekRange();
  document.getElementById('count-today').textContent    = allTasks.filter(t => !t.completed && t.remindAt >= td.start && t.remindAt <= td.end).length;
  document.getElementById('count-thisweek').textContent = allTasks.filter(t => !t.completed && t.remindAt >= wk.start && t.remindAt <= wk.end).length;
  document.getElementById('count-all').textContent      = allTasks.length;
  document.getElementById('count-pending').textContent  = allTasks.filter(t => !t.completed && t.remindAt >= now).length;
  document.getElementById('count-overdue').textContent  = allTasks.filter(t => !t.completed && t.remindAt < now).length;
  document.getElementById('count-completed').textContent = allTasks.filter(t => t.completed).length;
}

function updateStats(allTasks) {
  const now = Date.now();
  const td  = todayRange();
  const wk  = thisWeekRange();
  document.getElementById('stat-today').textContent   = allTasks.filter(t => !t.completed && t.remindAt >= td.start && t.remindAt <= td.end).length;
  document.getElementById('stat-week').textContent    = allTasks.filter(t => !t.completed && t.remindAt >= wk.start && t.remindAt <= wk.end).length;
  document.getElementById('stat-pending').textContent = allTasks.filter(t => !t.completed && t.remindAt >= now).length;
  document.getElementById('stat-overdue').textContent = allTasks.filter(t => !t.completed && t.remindAt < now).length;
  document.getElementById('stat-done').textContent    = allTasks.filter(t => t.completed).length;
}

function renderTasks(allTasks) {
  const now = Date.now();

  const td = todayRange();
  const wk = thisWeekRange();

  let tasks = allTasks.filter(task => {
    if (currentFilter === 'today')    return !task.completed && task.remindAt >= td.start && task.remindAt <= td.end;
    if (currentFilter === 'thisweek') return !task.completed && task.remindAt >= wk.start && task.remindAt <= wk.end;
    if (currentFilter === 'pending')  return !task.completed && task.remindAt >= now;
    if (currentFilter === 'overdue')  return !task.completed && task.remindAt < now;
    if (currentFilter === 'completed') return task.completed;
    return true; // 'all'
  });

  // Owner filter
  if (currentOwnerFilter !== 'all') {
    tasks = tasks.filter(t => !t.owner || t.owner === currentOwnerFilter);
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    tasks = tasks.filter(t =>
      t.contactName.toLowerCase().includes(q) ||
      (t.description && t.description.toLowerCase().includes(q))
    );
  }

  const [sortKey, sortDir] = currentSort.split('-');
  tasks.sort((a, b) => {
    if (sortKey === 'name') {
      const cmp = a.contactName.toLowerCase().localeCompare(b.contactName.toLowerCase());
      return sortDir === 'asc' ? cmp : -cmp;
    }
    const valA = a[sortKey] || 0;
    const valB = b[sortKey] || 0;
    return sortDir === 'asc' ? valA - valB : valB - valA;
  });

  const grid       = document.getElementById('task-grid');
  const tableWrap  = document.getElementById('task-table-wrap');
  const emptyState = document.getElementById('empty-state');

  // Clear both views
  grid.querySelectorAll('.task-card').forEach(el => el.remove());
  document.getElementById('task-table-body').innerHTML = '';

  if (tasks.length === 0) {
    emptyState.hidden = false;
    grid.hidden = true;
    tableWrap.hidden = true;
  } else {
    emptyState.hidden = true;
    if (currentView === 'table') {
      grid.hidden = true;
      tableWrap.hidden = false;
      renderTable(tasks, allTasks);
    } else {
      grid.hidden = false;
      tableWrap.hidden = true;
      tasks.forEach(task => grid.appendChild(buildCard(task, allTasks)));
    }
  }

  const titles = { today: 'Today', thisweek: 'This Week', all: 'All Tasks', pending: 'Pending', overdue: 'Overdue', completed: 'Completed' };
  document.getElementById('page-title').textContent = titles[currentFilter];
  document.getElementById('page-subtitle').textContent = `${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;
}

// ===== Table view =====

// Columns shown depend on the current filter:
// today / thisweek → compact (no Status, no Follow-up)
// all / pending / overdue / completed → full
const COMPACT_FILTERS = new Set(['today', 'thisweek']);

function renderTable(tasks, allTasks) {
  const compact = COMPACT_FILTERS.has(currentFilter);
  const tbody = document.getElementById('task-table-body');
  tbody.innerHTML = '';
  const now = Date.now();

  // Rebuild thead to match visible columns
  const thead = document.querySelector('#task-table thead tr');
  thead.innerHTML = '';
  const headers = ['Contact', 'Owner', 'Stage', 'Platform', ...(compact ? [] : ['Status', 'Follow-up']), 'Reminder', 'Notes', 'Actions'];
  headers.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    thead.appendChild(th);
  });

  const platformNames = { linkedin: '🔵 LinkedIn', gmail: '📧 Gmail', outlook: '📨 Outlook', whatsapp: '💬 WhatsApp' };

  tasks.forEach(task => {
    const overdue = !task.completed && task.remindAt < now;
    const tr = document.createElement('tr');
    tr.className = task.completed ? 'tr--done' : overdue ? 'tr--overdue' : '';

    // Contact
    const tdContact = document.createElement('td');
    tdContact.className = 'td-contact';
    const _displayName = (task.firstName || task.lastName) ? `${task.firstName || ''} ${task.lastName || ''}`.trim() : (task.contactName || 'Unknown');
    const _initials = ((task.firstName || task.contactName || '?')[0] + (task.lastName || '')[0]).toUpperCase();
    const avatar = document.createElement('span');
    avatar.className = 'tbl-avatar';
    avatar.textContent = _initials;
    if (task.completed) avatar.style.background = '#b0b8c4';
    else if (overdue)   avatar.style.background = '#f06a6a';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tbl-name';
    nameSpan.textContent = _displayName;
    nameSpan.style.cursor = 'pointer';
    nameSpan.addEventListener('click', () => openTimeline(task.contactName, allTasks));
    if (task.profileUrl) {
      const profIcon = document.createElement('a');
      profIcon.href = task.profileUrl;
      profIcon.target = '_blank';
      profIcon.rel = 'noopener noreferrer';
      profIcon.textContent = ' 👤';
      profIcon.title = 'View LinkedIn profile';
      profIcon.style.cssText = 'text-decoration:none;font-size:12px;margin-left:4px;';
      tdContact.append(avatar, nameSpan, profIcon);
    } else {
      tdContact.append(avatar, nameSpan);
    }

    // Owner
    const tdOwner = document.createElement('td');
    const ownerDef = getOwner(task.owner);
    if (ownerDef) {
      const chip = document.createElement('span');
      chip.className = 'tbl-owner-chip';
      chip.textContent = ownerDef.label[0];
      chip.title = ownerDef.label;
      chip.style.setProperty('--owner-color', ownerDef.color);
      chip.style.setProperty('--owner-bg', ownerDef.bg);
      const chipLabel = document.createElement('span');
      chipLabel.className = 'tbl-owner-label';
      chipLabel.textContent = ownerDef.label;
      const chipWrap = document.createElement('span');
      chipWrap.className = 'tbl-owner-wrap';
      chipWrap.append(chip, chipLabel);
      tdOwner.appendChild(chipWrap);
    } else {
      tdOwner.textContent = '—';
      tdOwner.style.color = 'var(--text-tertiary)';
    }

    // Stage
    const tdStage = document.createElement('td');
    tdStage.appendChild(buildStageBadge(task));

    // Platform
    const tdPlatform = document.createElement('td');
    tdPlatform.textContent = platformNames[task.platform] || '📋 Unknown';
    tdPlatform.className = 'td-platform';

    // Reminder
    const tdReminder = document.createElement('td');
    tdReminder.textContent = formatRelativeReminder(task.remindAt);
    tdReminder.className = 'td-reminder';
    if (overdue) tdReminder.style.color = '#d95f5f';

    // Notes
    const tdNotes = document.createElement('td');
    tdNotes.className = 'td-notes';
    tdNotes.textContent = task.description || '—';

    // Actions
    const tdActions = document.createElement('td');
    tdActions.className = 'td-actions';

    if (task.threadUrl) {
      const msgBtn = document.createElement('a');
      msgBtn.className = 'tbl-btn tbl-btn--msg';
      msgBtn.href = task.threadUrl;
      msgBtn.target = '_blank';
      msgBtn.rel = 'noopener noreferrer';
      msgBtn.title = 'Open thread';
      msgBtn.textContent = '💬';
      tdActions.appendChild(msgBtn);
    }

    if (!task.completed) {
      const doneBtn = document.createElement('button');
      doneBtn.className = 'tbl-btn tbl-btn--done';
      doneBtn.title = 'Mark Done';
      doneBtn.textContent = '✓';
      doneBtn.addEventListener('click', () => handleComplete(task.id));
      tdActions.appendChild(doneBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'tbl-btn tbl-btn--delete';
    delBtn.title = 'Delete';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => handleDelete(task.id));
    tdActions.appendChild(delBtn);

    // Build row — Status and Follow-up only for non-compact views
    if (compact) {
      tr.append(tdContact, tdOwner, tdStage, tdPlatform, tdReminder, tdNotes, tdActions);
    } else {
      const tdStatus = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = `tbl-pill ${task.completed ? 'tbl-pill--done' : overdue ? 'tbl-pill--overdue' : 'tbl-pill--pending'}`;
      pill.textContent = task.completed ? '✓ Done' : overdue ? '⚠ Overdue' : 'Pending';
      tdStatus.appendChild(pill);

      const tdFollowup = document.createElement('td');
      tdFollowup.textContent = task.followupDays ? `${task.followupDays}d` : '—';
      tdFollowup.className = 'td-center';

      tr.append(tdContact, tdOwner, tdStage, tdPlatform, tdStatus, tdFollowup, tdReminder, tdNotes, tdActions);
    }

    tbody.appendChild(tr);
  });
}

// ===== View toggle =====

function setupViewToggle() {
  const cardsBtn = document.getElementById('view-cards');
  const tableBtn = document.getElementById('view-table');

  cardsBtn.addEventListener('click', () => {
    if (currentView === 'cards') return;
    currentView = 'cards';
    cardsBtn.classList.add('view-btn--active');
    cardsBtn.setAttribute('aria-pressed', 'true');
    tableBtn.classList.remove('view-btn--active');
    tableBtn.setAttribute('aria-pressed', 'false');
    renderTasks(cachedAllTasks);
  });

  tableBtn.addEventListener('click', () => {
    if (currentView === 'table') return;
    currentView = 'table';
    tableBtn.classList.add('view-btn--active');
    tableBtn.setAttribute('aria-pressed', 'true');
    cardsBtn.classList.remove('view-btn--active');
    cardsBtn.setAttribute('aria-pressed', 'false');
    renderTasks(cachedAllTasks);
  });
}

// ===== Build task card =====

function buildCard(task, allTasks) {
  const now = Date.now();
  const overdue = !task.completed && task.remindAt < now;
  const daysUntil = Math.ceil((task.remindAt - now) / (1000 * 60 * 60 * 24));

  const card = document.createElement('div');
  card.className = `task-card ${task.completed ? 'task-card--done' : overdue ? 'task-card--overdue' : 'task-card--pending'}`;
  card.setAttribute('role', 'listitem');

  // ---- Top: clickable avatar + name ----
  const top = document.createElement('div');
  top.className = 'task-card__top';

  const contactBtn = document.createElement('button');
  contactBtn.className = 'task-card__contact-btn';
  contactBtn.title = 'View follow-up timeline';
  contactBtn.addEventListener('click', () => openTimeline(task.contactName, allTasks));

  const _cardDisplayName = (task.firstName || task.lastName) ? `${task.firstName || ''} ${task.lastName || ''}`.trim() : (task.contactName || 'Unknown');
  const _cardInitials = ((task.firstName || task.contactName || '?')[0] + (task.lastName || '')[0]).toUpperCase();

  const avatar = document.createElement('div');
  avatar.className = 'task-card__avatar';
  avatar.textContent = _cardInitials;

  const nameBlock = document.createElement('div');
  nameBlock.className = 'task-card__name-block';

  const nameEl = document.createElement('p');
  nameEl.className = 'task-card__name';
  nameEl.textContent = _cardDisplayName;

  const createdEl = document.createElement('p');
  createdEl.className = 'task-card__created';

  // Platform icon + "Saved X ago"
  const platformIcons = { linkedin: '🔵', gmail: '📧', outlook: '📨', whatsapp: '💬' };
  const platformNames = { linkedin: 'LinkedIn', gmail: 'Gmail', outlook: 'Outlook', whatsapp: 'WhatsApp' };
  const pIcon = platformIcons[task.platform] || '📋';
  const pName = platformNames[task.platform] || task.platform || 'Unknown';
  createdEl.textContent = `${pIcon} ${pName} · ${formatRelativeDate(task.createdAt)}`;

  nameBlock.append(nameEl, createdEl);
  contactBtn.append(avatar, nameBlock);

  const badge = document.createElement('span');
  badge.className = `task-card__badge ${task.completed ? 'badge--done' : overdue ? 'badge--overdue' : 'badge--pending'}`;
  badge.textContent = task.completed ? '✓ Done' : overdue ? '⚠ Overdue' : `${task.followupDays || '?'}d follow-up`;

  top.append(contactBtn, badge);

  // ---- Thread link ----
  let threadEl = null;
  if (task.threadUrl) {
    threadEl = document.createElement('a');
    threadEl.className = 'task-card__thread';
    threadEl.href = task.threadUrl;
    threadEl.target = '_blank';
    threadEl.rel = 'noopener noreferrer';
    threadEl.innerHTML = '<span class="thread-icon">💬</span> Open message thread';
  }

  // ---- Reminder ----
  const reminderRow = document.createElement('div');
  reminderRow.className = 'task-card__reminder';

  const reminderIcon = document.createElement('span');
  reminderIcon.className = 'reminder-icon';
  reminderIcon.textContent = task.completed ? '🗓' : overdue ? '⏰' : '🔔';

  const reminderText = document.createElement('span');
  if (task.completed) {
    reminderText.textContent = `Reminder was ${formatDate(task.remindAt)}`;
  } else if (overdue) {
    reminderText.textContent = `Was due ${formatDate(task.remindAt)}`;
    reminderText.style.color = '#cc0000';
  } else {
    reminderText.textContent = `${formatDate(task.remindAt)}  ·  in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}`;
  }

  reminderRow.append(reminderIcon, reminderText);

  // ---- Notes ----
  let notesEl = null;
  if (task.description) {
    notesEl = document.createElement('p');
    notesEl.className = 'task-card__notes';
    notesEl.textContent = task.description;
  }

  // ---- Actions ----
  const actions = document.createElement('div');
  actions.className = 'task-card__actions';

  // Stage badge (first item, always visible)
  actions.appendChild(buildStageBadge(task));

  if (!task.completed) {
    const doneBtn = document.createElement('button');
    doneBtn.className = 'card-btn card-btn--done card-btn--icon';
    doneBtn.innerHTML = '✓';
    doneBtn.title = 'Mark Done';
    doneBtn.setAttribute('aria-label', 'Mark Done');
    doneBtn.addEventListener('click', () => handleComplete(task.id));
    actions.appendChild(doneBtn);
  }

  if (task.threadUrl) {
    const msgBtn = document.createElement('a');
    msgBtn.className = 'card-btn card-btn--msg card-btn--icon';
    msgBtn.href = task.threadUrl;
    msgBtn.target = '_blank';
    msgBtn.rel = 'noopener noreferrer';
    msgBtn.innerHTML = '💬';
    msgBtn.title = 'Open Message Thread';
    msgBtn.setAttribute('aria-label', 'Open Message Thread');
    actions.appendChild(msgBtn);
  }

  const tlBtn = document.createElement('button');
  tlBtn.className = 'card-btn card-btn--timeline card-btn--icon';
  tlBtn.innerHTML = '📅';
  tlBtn.title = 'View History';
  tlBtn.setAttribute('aria-label', 'View History');
  tlBtn.addEventListener('click', () => openTimeline(task.contactName, allTasks));
  actions.appendChild(tlBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'card-btn card-btn--delete card-btn--icon';
  deleteBtn.innerHTML = '🗑';
  deleteBtn.title = 'Delete Task';
  deleteBtn.setAttribute('aria-label', 'Delete Task');
  deleteBtn.addEventListener('click', () => handleDelete(task.id));
  actions.appendChild(deleteBtn);

  // ---- Assemble ----
  card.appendChild(top);
  if (threadEl) card.appendChild(threadEl);
  card.appendChild(reminderRow);
  if (notesEl) card.appendChild(notesEl);
  card.appendChild(actions);

  return card;
}

// ===== Timeline panel =====

function setupTimeline() {
  document.getElementById('tl-close').addEventListener('click', closeTimeline);
  document.getElementById('timeline-overlay').addEventListener('click', closeTimeline);
}

function openTimeline(contactName, allTasks) {
  // Filter all tasks for this contact (case-insensitive)
  const contactTasks = allTasks
    .filter(t => t.contactName.toLowerCase() === contactName.toLowerCase())
    .sort((a, b) => a.createdAt - b.createdAt); // chronological

  // Populate header
  document.getElementById('tl-avatar').textContent = contactName.charAt(0).toUpperCase();
  document.getElementById('tl-name').textContent = contactName;

  const lastTask = contactTasks[contactTasks.length - 1];
  const metaParts = [`${contactTasks.length} follow-up${contactTasks.length !== 1 ? 's' : ''}`];
  if (lastTask) metaParts.push(`Last: ${formatShortDate(lastTask.createdAt)}`);
  document.getElementById('tl-meta').textContent = metaParts.join('  ·  ');

  // Latest thread link
  const latestThreadEl = document.getElementById('tl-latest-thread');
  latestThreadEl.innerHTML = '';
  const latestWithThread = [...contactTasks].reverse().find(t => t.threadUrl);
  if (latestWithThread) {
    const link = document.createElement('a');
    link.className = 'tl-latest-link';
    link.href = latestWithThread.threadUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '💬 Open latest message thread';
    latestThreadEl.appendChild(link);
  }

  // Build timeline items
  const body = document.getElementById('tl-body');
  body.innerHTML = '';

  if (contactTasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'tl-empty';
    empty.textContent = 'No tasks found for this contact.';
    body.appendChild(empty);
  } else {
    contactTasks.forEach((task, index) => {
      body.appendChild(buildTimelineItem(task, index, contactTasks.length));
    });
  }

  // Show panel
  document.getElementById('timeline-panel').classList.remove('tl-hidden');
  document.getElementById('timeline-overlay').classList.remove('tl-hidden');
  document.getElementById('main-content').classList.add('main--shifted');
}

function buildTimelineItem(task, index, total) {
  const now = Date.now();
  const overdue = !task.completed && task.remindAt < now;

  const item = document.createElement('div');
  item.className = `tl-item${index === total - 1 ? ' tl-item--last' : ''}`;
  item.setAttribute('role', 'listitem');

  // ---- Row 1: date + badges ----
  const row1 = document.createElement('div');
  row1.className = 'tl-item__row1';

  const dateChip = document.createElement('span');
  dateChip.className = 'tl-date';
  dateChip.textContent = formatShortDate(task.createdAt);

  const followupBadge = document.createElement('span');
  followupBadge.className = 'tl-badge tl-badge--followup';
  followupBadge.textContent = `${task.followupDays || '?'}d`;

  const statusBadge = document.createElement('span');
  statusBadge.className = `tl-badge ${task.completed ? 'tl-badge--done' : overdue ? 'tl-badge--overdue' : 'tl-badge--pending'}`;
  statusBadge.textContent = task.completed ? 'Done' : overdue ? 'Overdue' : 'Pending';

  row1.append(dateChip, followupBadge, statusBadge);

  // ---- Reminder line ----
  const reminderLine = document.createElement('p');
  reminderLine.className = 'tl-reminder';
  reminderLine.textContent = (task.completed ? '🗓 ' : overdue ? '⏰ ' : '🔔 ') + formatDate(task.remindAt);
  if (overdue) reminderLine.style.color = '#cc0000';

  // ---- Notes ----
  let notesEl = null;
  if (task.description) {
    notesEl = document.createElement('p');
    notesEl.className = 'tl-notes';
    notesEl.textContent = `"${task.description}"`;
  }

  // ---- Thread link ----
  let threadEl = null;
  if (task.threadUrl) {
    threadEl = document.createElement('a');
    threadEl.className = 'tl-thread-link';
    threadEl.href = task.threadUrl;
    threadEl.target = '_blank';
    threadEl.rel = 'noopener noreferrer';
    threadEl.textContent = '↗ Open thread';
  }

  item.append(row1, reminderLine);
  if (notesEl) item.appendChild(notesEl);
  if (threadEl) item.appendChild(threadEl);

  return item;
}

function closeTimeline() {
  document.getElementById('timeline-panel').classList.add('tl-hidden');
  document.getElementById('timeline-overlay').classList.add('tl-hidden');
  document.getElementById('main-content').classList.remove('main--shifted');
}

// ===== Stage badge =====

function buildStageBadge(task) {
  const stage = getStage(task.stage);

  const wrapper = document.createElement('div');
  wrapper.className = 'stage-badge-wrap';
  wrapper.style.position = 'relative';
  wrapper.style.display = 'inline-block';

  const badge = document.createElement('button');
  badge.className = 'stage-badge';
  badge.textContent = stage.label;
  badge.style.setProperty('--stage-color', stage.color);
  badge.style.setProperty('--stage-bg', stage.bg);
  badge.title = 'Change stage';

  const dropdown = document.createElement('div');
  dropdown.className = 'stage-dropdown';

  STAGES.forEach(s => {
    const item = document.createElement('button');
    item.className = 'stage-dropdown__item' + (s.value === task.stage ? ' stage-dropdown__item--active' : '');
    item.textContent = s.label;
    item.style.setProperty('--stage-color', s.color);
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      dropdown.classList.remove('stage-dropdown--open');
      await handleStageChange(task.id, s.value);
    });
    dropdown.appendChild(item);
  });

  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains('stage-dropdown--open');
    // Close all other open stage dropdowns first
    document.querySelectorAll('.stage-dropdown--open').forEach(d => d.classList.remove('stage-dropdown--open'));
    if (!isOpen) dropdown.classList.add('stage-dropdown--open');
  });

  wrapper.append(badge, dropdown);
  return wrapper;
}

async function handleStageChange(taskId, newStage) {
  const tasks = (await cloudStore.getTasks()).map(t => t.id === taskId ? { ...t, stage: newStage } : t);
  await cloudStore.setTasks(tasks);
  await renderAll();
}

// ===== Actions =====

async function handleComplete(taskId) {
  const tasks = (await cloudStore.getTasks()).map(t => t.id === taskId ? { ...t, completed: true } : t);
  await cloudStore.setTasks(tasks);
  chrome.runtime.sendMessage({ action: 'DELETE_ALARM', alarmName: taskId });
  await renderAll();
}

async function handleDelete(taskId) {
  if (!confirm('Delete this task?')) return;
  const tasks = (await cloudStore.getTasks()).filter(t => t.id !== taskId);
  await cloudStore.setTasks(tasks);
  chrome.runtime.sendMessage({ action: 'DELETE_ALARM', alarmName: taskId });
  await renderAll();
}

// ===== Nav, search, sort =====

function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('nav-btn--active'));
      btn.classList.add('nav-btn--active');
      currentFilter = btn.dataset.filter;
      renderAll();
    });
  });
}

function setupSearch() {
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderAll();
  });
}

function setupSort() {
  document.getElementById('sort-select').addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderAll();
  });
}

function setupOwnerFilter() {
  const container = document.getElementById('owner-filter-pills');
  if (!container) return;
  container.innerHTML = '';

  // "All" pill
  const allPill = document.createElement('button');
  allPill.className = 'owner-filter-pill' + (currentOwnerFilter === 'all' ? ' owner-filter-pill--active' : '');
  allPill.textContent = 'All';
  allPill.addEventListener('click', () => { currentOwnerFilter = 'all'; setupOwnerFilter(); renderAll(); });
  container.appendChild(allPill);

  OWNERS.forEach(owner => {
    const pill = document.createElement('button');
    pill.className = 'owner-filter-pill' + (currentOwnerFilter === owner.id ? ' owner-filter-pill--active' : '');
    pill.textContent = owner.label;
    pill.style.setProperty('--owner-color', owner.color);
    pill.style.setProperty('--owner-bg', owner.bg);
    pill.addEventListener('click', () => { currentOwnerFilter = owner.id; setupOwnerFilter(); renderAll(); });
    container.appendChild(pill);
  });
}

// ===== Utilities =====

function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }) + ' · 9:00 AM';
}

// Human-friendly reminder label: "in 30 min", "in 3 hrs", "Tomorrow", "Next week", or a date
function formatRelativeReminder(ms) {
  const now = Date.now();
  const diff = ms - now; // positive = future, negative = past

  if (diff < 0) {
    // Overdue — show how long ago
    const absDiff = -diff;
    const mins  = Math.floor(absDiff / 60000);
    const hours = Math.floor(absDiff / 3600000);
    const days  = Math.floor(absDiff / 86400000);
    if (mins  < 60)  return `${mins}m overdue`;
    if (hours < 24)  return `${hours}h overdue`;
    if (days  === 1) return 'Yesterday';
    if (days  < 7)   return `${days}d overdue`;
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);

  if (mins  < 60)  return `in ${mins} min`;
  if (hours < 24)  return `in ${hours} hr${hours !== 1 ? 's' : ''}`;
  if (days  === 1) return 'Tomorrow';
  if (days  < 7)   return `in ${days} days`;
  if (days  < 14)  return 'Next week';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatShortDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

// ===== Settings Modal =====

function labelToSlug(label) {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setupSettings() {
  document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
  document.getElementById('settings-close').addEventListener('click', closeSettingsModal);
  document.getElementById('settings-overlay').addEventListener('click', closeSettingsModal);
  document.getElementById('settings-cancel').addEventListener('click', closeSettingsModal);
  document.getElementById('settings-save').addEventListener('click', saveSettings);

  // Tab switching
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(t => {
        t.classList.remove('settings-tab--active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('settings-tab--active');
      tab.setAttribute('aria-selected', 'true');
      const target = tab.dataset.tab;
      document.querySelectorAll('.settings-panel').forEach(p => {
        p.classList.toggle('settings-panel--hidden', p.dataset.panel !== target);
      });
    });
  });

  // Add-row buttons
  document.getElementById('settings-add-owner').addEventListener('click', () => {
    _draftOwners.push({ id: '', label: '', color: '#4573d2', bg: '#eef2fc' });
    renderSettingsOwners();
  });
  document.getElementById('settings-add-stage').addEventListener('click', () => {
    _draftStages.push({ value: '', label: '', color: '#6366f1', bg: '#eeeefd' });
    renderSettingsStages();
  });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('settings-modal');
      if (!modal.classList.contains('settings-hidden')) closeSettingsModal();
    }
  });
}

function openSettingsModal() {
  _draftOwners = OWNERS.map(o => ({ ...o }));
  _draftStages = STAGES.map(s => ({ ...s }));

  // Reset to owners tab
  document.querySelectorAll('.settings-tab').forEach(t => {
    const isOwners = t.dataset.tab === 'owners';
    t.classList.toggle('settings-tab--active', isOwners);
    t.setAttribute('aria-selected', isOwners ? 'true' : 'false');
  });
  document.querySelectorAll('.settings-panel').forEach(p => {
    p.classList.toggle('settings-panel--hidden', p.dataset.panel !== 'owners');
  });

  renderSettingsOwners();
  renderSettingsStages();

  document.getElementById('settings-overlay').classList.remove('settings-hidden');
  document.getElementById('settings-modal').classList.remove('settings-hidden');
  document.getElementById('settings-close').focus();
}

function closeSettingsModal() {
  document.getElementById('settings-overlay').classList.add('settings-hidden');
  document.getElementById('settings-modal').classList.add('settings-hidden');
  _draftOwners = [];
  _draftStages = [];
}

function renderSettingsOwners() {
  const container = document.getElementById('settings-owners-list');
  container.innerHTML = '';

  _draftOwners.forEach((owner, idx) => {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const idChip = document.createElement('span');
    idChip.className = 'settings-row__id';
    idChip.textContent = owner.id || '(new)';
    idChip.title = owner.id ? 'Stable ID — cannot change' : 'Auto-generated from name on save';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'settings-row__input';
    labelInput.placeholder = 'Name';
    labelInput.value = owner.label;
    labelInput.maxLength = 40;
    labelInput.addEventListener('input', () => { _draftOwners[idx].label = labelInput.value; });

    const colorWrap = document.createElement('label');
    colorWrap.className = 'settings-row__color-wrap';
    colorWrap.title = 'Text color';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'settings-row__color';
    colorInput.value = owner.color;
    colorInput.addEventListener('input', () => { _draftOwners[idx].color = colorInput.value; });
    colorWrap.appendChild(colorInput);

    const bgWrap = document.createElement('label');
    bgWrap.className = 'settings-row__color-wrap';
    bgWrap.title = 'Background color';
    const bgInput = document.createElement('input');
    bgInput.type = 'color';
    bgInput.className = 'settings-row__color';
    bgInput.value = owner.bg;
    bgInput.addEventListener('input', () => { _draftOwners[idx].bg = bgInput.value; });
    bgWrap.appendChild(bgInput);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'settings-row__delete';
    deleteBtn.title = 'Remove owner';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => { _draftOwners.splice(idx, 1); renderSettingsOwners(); });

    row.append(idChip, labelInput, colorWrap, bgWrap, deleteBtn);
    container.appendChild(row);
  });
}

function renderSettingsStages() {
  const container = document.getElementById('settings-stages-list');
  container.innerHTML = '';

  _draftStages.forEach((stage, idx) => {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const slugChip = document.createElement('span');
    slugChip.className = 'settings-row__id';
    slugChip.textContent = stage.value || '(new)';
    slugChip.title = stage.value ? 'Stable value stored on tasks — cannot change' : 'Auto-generated from label on save';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'settings-row__input';
    labelInput.placeholder = 'Stage label';
    labelInput.value = stage.label;
    labelInput.maxLength = 40;
    labelInput.addEventListener('input', () => {
      _draftStages[idx].label = labelInput.value;
      if (!stage.value) slugChip.textContent = labelToSlug(labelInput.value) || '(new)';
    });

    const colorWrap = document.createElement('label');
    colorWrap.className = 'settings-row__color-wrap';
    colorWrap.title = 'Text color';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'settings-row__color';
    colorInput.value = stage.color;
    colorInput.addEventListener('input', () => { _draftStages[idx].color = colorInput.value; });
    colorWrap.appendChild(colorInput);

    const bgWrap = document.createElement('label');
    bgWrap.className = 'settings-row__color-wrap';
    bgWrap.title = 'Background color';
    const bgInput = document.createElement('input');
    bgInput.type = 'color';
    bgInput.className = 'settings-row__color';
    bgInput.value = stage.bg;
    bgInput.addEventListener('input', () => { _draftStages[idx].bg = bgInput.value; });
    bgWrap.appendChild(bgInput);

    const upBtn = document.createElement('button');
    upBtn.className = 'settings-row__move';
    upBtn.textContent = '↑';
    upBtn.title = 'Move up';
    upBtn.disabled = idx === 0;
    upBtn.addEventListener('click', () => {
      [_draftStages[idx - 1], _draftStages[idx]] = [_draftStages[idx], _draftStages[idx - 1]];
      renderSettingsStages();
    });

    const downBtn = document.createElement('button');
    downBtn.className = 'settings-row__move';
    downBtn.textContent = '↓';
    downBtn.title = 'Move down';
    downBtn.disabled = idx === _draftStages.length - 1;
    downBtn.addEventListener('click', () => {
      [_draftStages[idx + 1], _draftStages[idx]] = [_draftStages[idx], _draftStages[idx + 1]];
      renderSettingsStages();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'settings-row__delete';
    deleteBtn.title = 'Remove stage';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => { _draftStages.splice(idx, 1); renderSettingsStages(); });

    row.append(slugChip, labelInput, colorWrap, bgWrap, upBtn, downBtn, deleteBtn);
    container.appendChild(row);
  });
}

async function saveSettings() {
  const saveBtn = document.getElementById('settings-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  // Validate and finalize owners
  const usedOwnerIds = new Set();
  const finalOwners = _draftOwners
    .filter(o => o.label.trim() !== '')
    .map(o => {
      let id = o.id || labelToSlug(o.label) || `owner_${Date.now()}`;
      // Deduplicate ids
      let suffix = 2;
      const base = id;
      while (usedOwnerIds.has(id)) { id = `${base}_${suffix++}`; }
      usedOwnerIds.add(id);
      return { id, label: o.label.trim(), color: o.color, bg: o.bg };
    });

  // Validate and finalize stages
  const usedValues = new Set();
  const finalStages = _draftStages
    .filter(s => s.label.trim() !== '')
    .map(s => {
      let value = s.value || labelToSlug(s.label) || `stage_${Date.now()}`;
      // Deduplicate slugs
      let suffix = 2;
      const base = value;
      while (usedValues.has(value)) { value = `${base}_${suffix++}`; }
      usedValues.add(value);
      return { value, label: s.label.trim(), color: s.color, bg: s.bg };
    });

  if (finalOwners.length === 0) {
    alert('At least one owner is required.');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Changes';
    return;
  }
  if (finalStages.length === 0) {
    alert('At least one stage is required.');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Changes';
    return;
  }

  await cloudStore.setSettings({ owners: finalOwners, stages: finalStages });

  // Update module-level arrays immediately
  OWNERS = finalOwners;
  STAGES = finalStages;

  // Reset owner filter if active owner was deleted
  if (currentOwnerFilter !== 'all' && !OWNERS.find(o => o.id === currentOwnerFilter)) {
    currentOwnerFilter = 'all';
  }

  setupOwnerFilter();
  await renderAll();
  closeSettingsModal();

  saveBtn.disabled = false;
  saveBtn.textContent = 'Save Changes';
}

// ===== Utilities =====

function formatRelativeDate(ms) {
  const diff = Date.now() - ms;
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7)  return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
