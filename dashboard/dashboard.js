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

async function sendPasswordResetEmail(email) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email })
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || 'PASSWORD_RESET_FAILED');
  return json;
}

function friendlyResetError(code) {
  if (code.includes('INVALID_EMAIL')) return 'Please enter a valid email address.';
  if (code.includes('MISSING_EMAIL')) return 'Please enter your email first.';
  if (code.includes('NETWORK_REQUEST_FAILED')) return 'Network error. Check your connection.';
  if (code.includes('TOO_MANY_REQUESTS')) return 'Too many attempts. Please wait and try again.';
  return 'Could not send reset email. Please try again.';
}

function setAuthMessage(el, message, isSuccess) {
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  el.classList.toggle('auth-error--success', !!isSuccess);
}

async function handleForgotPassword(emailInputId, errorElId, triggerBtn) {
  const email = String(document.getElementById(emailInputId)?.value || '').trim();
  const errorEl = document.getElementById(errorElId);
  if (!email) {
    setAuthMessage(errorEl, 'Please enter your email first.', false);
    return;
  }

  if (triggerBtn) triggerBtn.disabled = true;
  try {
    await sendPasswordResetEmail(email);
    setAuthMessage(errorEl, 'If this email is registered, a reset link has been sent.', true);
  } catch (err) {
    setAuthMessage(errorEl, friendlyResetError(err.message || ''), false);
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
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

let currentTab = 'dashboard';       // 'dashboard' | 'contacts' | 'tasks'
let currentTaskFilter = 'all';      // sub-filter within Tasks tab: 'all' | 'pending' | 'overdue' | 'completed'
let currentSort = 'remindAt-asc';
let searchQuery = '';
let customerSearchQuery = '';
let customerStageFilter = 'all';
let customerTagFilter = 'all';
let customerSort = 'lastActivity-desc';
let customerView = 'cards';          // 'cards' | 'table'
let cachedAllTasks = [];
let cachedTeamContacts = [];
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
  return STAGES.find(s => s.value === value) || STAGES[0] || {
    value: 'unassigned',
    label: 'No Stage',
    color: '#9ba4b0',
    bg: '#f3f4f6',
  };
}

// ===== Load settings from storage =====

async function loadSettings() {
  const s = await cloudStore.getSettings();
  if (s && Array.isArray(s.owners)) {
    OWNERS = s.owners;
  } else {
    OWNERS = DEFAULT_SETTINGS.owners;
  }
  if (s && Array.isArray(s.stages)) {
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
      if (!syncResult.guestTaskCount || syncResult.guestTaskCount <= 0) {
        syncResult = await cloudStore.postSignIn({ mergeGuestData: false });
      } else {
      const prompt = syncResult.hasRemoteData
        ? `Found ${syncResult.guestTaskCount} guest tasks on this device. Merge them into your account data?`
        : `No cloud data found for this account. Merge ${syncResult.guestTaskCount} guest tasks into this account?`;
      const shouldMerge = confirm(prompt);
      syncResult = await cloudStore.postSignIn({ mergeGuestData: shouldMerge });
      }
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
  document.getElementById('auth-error').classList.remove('auth-error--success');
  document.getElementById('auth-subtitle').textContent = 'One tap. Back in the conversation';
  const submitBtn = document.getElementById('auth-submit');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Sign In';

  const forgotBtn = document.getElementById('auth-forgot-btn');
  if (forgotBtn) {
    forgotBtn.hidden = false;
    forgotBtn.onclick = () => handleForgotPassword('auth-email', 'auth-error', forgotBtn);
  }

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
  document.getElementById('auth-error').classList.remove('auth-error--success');
  const forgotBtn = document.getElementById('auth-forgot-btn');
  if (forgotBtn) forgotBtn.hidden = isSignUp;

  // Show signup-only fields
  const nameEl     = document.getElementById('auth-name');
  const teamcodeEl = document.getElementById('auth-teamcode');
  if (nameEl)     { nameEl.hidden     = !isSignUp; nameEl.required     = isSignUp; }
  if (teamcodeEl) { teamcodeEl.hidden = !isSignUp; }
}

// Provision Firestore user + team docs after a successful signup.
// If teamCode is provided and valid, joins that team; otherwise creates a new one.
async function provisionUserAndTeam(userId, idToken, name, email, teamCode) {
  const cloud = window.TaskSaverCloud;
  let teamId, role;
  let existingMembers = [];

  const trimmedCode = (teamCode || '').trim().toUpperCase();
  if (trimmedCode) {
    // Try to join an existing team
    const found = await cloud.findTeamByCode(trimmedCode, idToken);
    if (!found) throw new Error('TEAM_NOT_FOUND');
    teamId = found.teamId;
    role   = 'member';
    existingMembers = Array.isArray(found.members) ? found.members : [];
  } else {
    // Create a new team with the user as owner
    teamId = `team_${userId}`;
    role   = 'admin';
  }

  // Create user profile first so isTeamMember(teamId) can pass via userTeamId() during join.
  await cloud.createUserProfile(userId, idToken, { name, email, teamId, role });

  if (trimmedCode) {
    // Update members array first (self-join rule), then write member subdocument.
    if (!existingMembers.includes(userId)) {
      await cloud.updateTeamMembersArray(teamId, idToken, [...existingMembers, userId]);
    }
    await cloud.addTeamMember(teamId, userId, idToken, { userId, role, name, email });
  } else {
    const generatedCode = cloud.generateTeamCode();
    const teamName      = name ? `${name}'s Team` : 'My Team';

    await cloud.createTeamDoc(teamId, idToken, {
      name:    teamName,
      teamCode: generatedCode,
      ownerId: userId,
      members: [userId],
    });
    await cloud.seedDefaultTeamStages(teamId, idToken, userId);
    await cloud.addTeamMember(teamId, userId, idToken, { userId, role, name, email });
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const email     = document.getElementById('auth-email').value.trim();
  const password  = document.getElementById('auth-password').value;
  const name      = (document.getElementById('auth-name')?.value || '').trim();
  const teamCode  = document.getElementById('auth-teamcode')?.value || '';
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

    if (isSignUp) {
      await provisionUserAndTeam(json.localId, json.idToken, name, email, teamCode);
    }

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
        name:         name || null,
        ownerId,
        expiresAt:    Date.now() + (parseInt(json.expiresIn, 10) * 1000),
      }
    });

    await chrome.storage.sync.set({ currentOwner: ownerId });

    closeAuthModal();
    await completePostSignInMergeFlow();

    await initApp();
    await applyAccessState();
  } catch (err) {
    errorEl.textContent = err.message === 'TEAM_NOT_FOUND'
      ? 'Team code not found. Check the code or leave it blank to create a new team.'
      : friendlyAuthError(err.message, _authMode);
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = isSignUp ? 'Sign Up' : 'Sign In';
  }
}

// ===== App init (runs only when authenticated) =====

async function initApp() {
  await initTheme();
  await loadSettings();     // MUST be first — populates OWNERS and STAGES
  await renderAll();
  setupTabs();
  setupTaskSubFilters();
  setupCustomerSearch();
  setupCustomerFilters();
  setupCustomerViewToggle();
  setupSearch();
  setupNewTaskButton();
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
      closeAllStageDropdowns();
    });
    window.addEventListener('scroll', closeAllStageDropdowns, true);
    window.addEventListener('resize', closeAllStageDropdowns);

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
  const labelEl = document.getElementById('auth-user-label');
  const emailEl = document.getElementById('auth-user-email');
  if (!labelEl) return;
  const auth = await getAuthState();
  if (auth && auth.email) {
    labelEl.textContent = 'Logged in as';
    if (emailEl) {
      emailEl.textContent = auth.email;
      emailEl.title = auth.email;
    }
  } else {
    labelEl.textContent = 'Guest mode';
    if (emailEl) {
      emailEl.textContent = '';
      emailEl.title = '';
    }
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
      ${isSignUp ? `<input id="auth-modal-name" type="text" class="auth-input" placeholder="Full Name" autocomplete="name" required />` : ''}
      <input id="auth-modal-email" type="email" class="auth-input" placeholder="Email" autocomplete="email" required />
      <input id="auth-modal-password" type="password" class="auth-input" placeholder="Password" autocomplete="current-password" required />
      ${isSignUp ? '' : '<button type="button" id="auth-modal-forgot-btn" class="auth-forgot-btn">Forgot password?</button>'}
      ${isSignUp ? `<input id="auth-modal-teamcode" type="text" class="auth-input" placeholder="Team Code (optional — leave blank to create new team)" autocomplete="off" maxlength="8" />` : ''}
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
  box.querySelector('#auth-modal-forgot-btn')?.addEventListener('click', () => {
    const btn = box.querySelector('#auth-modal-forgot-btn');
    handleForgotPassword('auth-modal-email', 'auth-modal-error', btn);
  });
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
  const name      = (document.getElementById('auth-modal-name')?.value || '').trim();
  const teamCode  = document.getElementById('auth-modal-teamcode')?.value || '';
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

    if (isSignUp) {
      await provisionUserAndTeam(json.localId, json.idToken, name, email, teamCode);
    }

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
        name:         name || null,
        ownerId,
        expiresAt:    Date.now() + (parseInt(json.expiresIn, 10) * 1000),
      }
    });

    await chrome.storage.sync.set({ currentOwner: ownerId });

    closeAuthModal();
    await completePostSignInMergeFlow();

    await initApp();
    await applyAccessState();
  } catch (err) {
    errorEl.textContent = err.message === 'TEAM_NOT_FOUND'
      ? 'Team code not found. Check the code or leave it blank to create a new team.'
      : friendlyAuthError(err.message, _authMode);
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = isSignUp ? 'Sign Up' : 'Sign In';
  }
}

// ===== Main render =====

async function renderAll() {
  const [tasks, contacts] = await Promise.all([
    cloudStore.getTasks(),
    (cloudStore.listTeamContacts ? cloudStore.listTeamContacts(500) : Promise.resolve([])).catch(() => []),
  ]);
  cachedAllTasks = Array.isArray(tasks) ? tasks : [];
  cachedTeamContacts = Array.isArray(contacts) ? contacts : [];
  showTab(currentTab);
}

// ===== Theme system =====
async function initTheme() {
  try {
    const data = await chrome.storage.sync.get('theme');
    const theme = data.theme || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeIcon(theme);
  } catch (_) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  updateThemeIcon(next);
  chrome.storage.sync.set({ theme: next });
}

function updateThemeIcon(theme) {
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ===== Tab system =====
function setupTabs() {
  const tabBtns = document.querySelectorAll('.nav-btn[data-tab]');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('nav-btn--active'));
      btn.classList.add('nav-btn--active');
      currentTab = btn.dataset.tab;
      showTab(currentTab);
    });
  });

  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
}

function showTab(tab) {
  // Map sidebar tabs to panel IDs
  const taskListTabs = new Set(['today', 'thisweek', 'pending', 'overdue', 'completed']);
  const panelTab = taskListTabs.has(tab) ? 'tasks' : (tab === 'contacts' ? 'customers' : tab);

  document.querySelectorAll('.tab-panel').forEach(p => {
    p.hidden = true;
    p.classList.remove('tab-panel--active');
  });
  const panel = document.getElementById(`tab-${panelTab}`);
  if (panel) {
    panel.hidden = false;
    panel.classList.add('tab-panel--active');
  }

  // Update sidebar counts always
  updateSidebarCounts(cachedAllTasks);

  // Update header title
  const titles = { dashboard: 'Dashboard', contacts: 'Contacts', customers: 'Contacts', today: 'Today', thisweek: 'This Week', pending: 'Pending', overdue: 'Overdue', completed: 'Completed' };
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = titles[tab] || 'Tasks';

  const dateStr = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const subtitleEl = document.getElementById('page-subtitle');

  if (tab === 'dashboard') {
    if (subtitleEl) subtitleEl.textContent = `${dateStr} — ${cachedAllTasks.length} tasks across ${new Set(cachedAllTasks.map(t => (t.contactName || '').toLowerCase()).filter(Boolean)).size} customers`;
    renderDashboardTab(cachedAllTasks);
  } else if (tab === 'contacts' || tab === 'customers') {
    renderCustomersTab(cachedAllTasks, cachedTeamContacts);
  } else if (taskListTabs.has(tab)) {
    currentTaskFilter = tab === 'today' ? 'today' : tab === 'thisweek' ? 'thisweek' : tab;
    renderTasks(cachedAllTasks);
  }
}

function updateSidebarCounts(allTasks) {
  const now = Date.now();
  const td  = todayRange();
  const wk  = thisWeekRange();
  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('count-today', allTasks.filter(t => !t.completed && t.remindAt >= td.start && t.remindAt <= td.end).length);
  el('count-thisweek', allTasks.filter(t => !t.completed && t.remindAt >= wk.start && t.remindAt <= wk.end).length);
  el('count-pending', allTasks.filter(t => !t.completed && t.remindAt >= now).length);
  el('count-overdue', allTasks.filter(t => !t.completed && t.remindAt < now).length);
  el('count-completed', allTasks.filter(t => t.completed).length);
}

// ===== Dashboard overview tab =====
function renderDashboardTab(allTasks) {
  const now = Date.now();
  const td  = todayRange();
  const wk  = thisWeekRange();

  const todayTasks   = allTasks.filter(t => !t.completed && t.remindAt >= td.start && t.remindAt <= td.end);
  const overdueTasks = allTasks.filter(t => !t.completed && t.remindAt < now);
  const pendingTasks = allTasks.filter(t => !t.completed && t.remindAt >= now);
  const weekTasks    = allTasks.filter(t => !t.completed && t.remindAt > td.end && t.remindAt <= wk.end);
  const completedTasks = allTasks.filter(t => t.completed);
  const uniqueContacts = new Set(allTasks.map(t => (t.contactName || '').toLowerCase()).filter(Boolean));

  const el = (id) => document.getElementById(id);

  // Stats
  el('dash-stat-total').textContent = allTasks.length;
  el('dash-stat-pending').textContent = pendingTasks.length;
  el('dash-stat-overdue').textContent = overdueTasks.length;
  el('dash-stat-done').textContent = completedTasks.length;
  el('dash-stat-followups').textContent = todayTasks.length + weekTasks.length;

  // Sub-stats
  const totalSub = el('dash-stat-total-sub');
  if (totalSub) totalSub.textContent = uniqueContacts.size > 0 ? `${uniqueContacts.size} customers` : '';
  const pendingSub = el('dash-stat-pending-sub');
  if (pendingSub) pendingSub.textContent = todayTasks.length > 0 ? `↑ ${todayTasks.length} new today` : '';
  const overdueSub = el('dash-stat-overdue-sub');
  if (overdueSub) overdueSub.textContent = overdueTasks.length > 0 ? 'needs attention' : '';
  const doneSub = el('dash-stat-done-sub');
  if (doneSub) doneSub.textContent = completedTasks.length > 0 ? `↑ ${completedTasks.length} this week` : '';
  const followSub = el('dash-stat-followups-sub');
  if (followSub) followSub.textContent = todayTasks.length > 0 ? `● ${todayTasks.length} due today` : '';

  // Today date
  const todayDate = el('dash-today-date');
  if (todayDate) todayDate.textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  // Overdue section
  const overdueList = el('dash-overdue-list');
  overdueList.innerHTML = '';
  const overdueSection = el('dash-overdue-section');
  const overdueCount = el('dash-overdue-count');
  if (overdueCount) overdueCount.textContent = overdueTasks.length;
  if (overdueTasks.length === 0) {
    overdueSection.hidden = true;
  } else {
    overdueSection.hidden = false;
    overdueTasks.slice(0, 4).forEach(task => overdueList.appendChild(buildDashCard(task)));
  }

  // Today section
  const todayList = el('dash-today-list');
  todayList.innerHTML = '';
  const todayEmpty = el('dash-today-empty');
  if (todayTasks.length === 0) {
    todayEmpty.hidden = false;
    todayList.hidden = true;
  } else {
    todayEmpty.hidden = true;
    todayList.hidden = false;
    todayTasks.slice(0, 4).forEach(task => todayList.appendChild(buildDashCard(task)));
  }

  // Week section
  const weekList = el('dash-week-list');
  weekList.innerHTML = '';
  const weekSection = el('dash-week-section');
  if (weekTasks.length === 0) {
    weekSection.hidden = true;
  } else {
    weekSection.hidden = false;
    weekTasks.slice(0, 4).forEach(task => weekList.appendChild(buildDashCard(task)));
  }

  // Wire "View all" buttons
  document.querySelectorAll('.dash-section__viewall').forEach(btn => {
    btn.onclick = () => {
      const goto = btn.dataset.goto;
      if (goto) {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('nav-btn--active'));
        const target = document.querySelector(`.nav-btn[data-tab="${goto}"]`);
        if (target) target.classList.add('nav-btn--active');
        currentTab = goto;
        showTab(goto);
      }
    };
  });
}

// ===== Build dashboard-style task card (matches mockup) =====
const AVATAR_COLORS = ['#6c63ff', '#FF4CB4', '#f59e0b', '#2ecc71', '#3b82f6', '#e74c3c', '#9b59b6', '#1abc9c'];

function buildDashCard(task) {
  const card = document.createElement('div');
  const overdue = !task.completed && task.remindAt < Date.now();
  const statusClass = task.completed ? 'done' : overdue ? 'overdue' : 'pending';
  card.className = `dash-card dash-card--${statusClass}`;
  card.setAttribute('role', 'listitem');

  const displayName = (task.firstName || task.lastName) ? `${task.firstName || ''} ${task.lastName || ''}`.trim() : (task.contactName || 'Unknown');
  const parts = displayName.split(' ');
  const initials = (parts[0] || '?')[0].toUpperCase();
  const colorIdx = Math.abs([...displayName].reduce((a, c) => a + c.charCodeAt(0), 0)) % AVATAR_COLORS.length;

  // Determine priority based on followupDays
  const priority = task.followupDays <= 2 ? 'high' : task.followupDays <= 7 ? 'medium' : 'low';
  const priorityLabel = priority.toUpperCase();

  // Platform labels
  const platformLabels = { linkedin: 'LinkedIn', gmail: 'Email', outlook: 'Email', whatsapp: 'WhatsApp' };
  const platformIcons = { linkedin: '💬', gmail: '📧', outlook: '📧', whatsapp: '💬', call: '📞', slack: '💬' };

  const stage = task.stage ? getStage(task.stage) : null;

  card.innerHTML = `
    <div class="dash-card__top">
      <div class="dash-card__contact">
        <div class="dash-card__avatar" style="background:${AVATAR_COLORS[colorIdx]}">${initials}</div>
        <div class="dash-card__name-block">
          <span class="dash-card__name">${escapeHtml(displayName)}</span>
          <span class="dash-card__company">${task.title ? escapeHtml(task.title) : (stage ? escapeHtml(stage.label) : '')}</span>
        </div>
      </div>
      <span class="dash-card__priority dash-card__priority--${priority}">${priorityLabel}</span>
    </div>
    <div class="dash-card__body">
      <span class="dash-card__task-title">${escapeHtml(task.description ? task.description.split('\n')[0].slice(0, 60) : (task.followupDays ? task.followupDays + '-day follow-up' : 'Follow up'))}</span>
      ${task.description && task.description.length > 60 ? `<span class="dash-card__desc">${escapeHtml(task.description.slice(0, 100))}</span>` : ''}
    </div>
    <div class="dash-card__footer">
      <span class="dash-card__footer-item"><span class="dash-card__status-dot dash-card__status-dot--${statusClass}"></span> ${statusClass}</span>
      <span class="dash-card__footer-item">📅 ${new Date(task.remindAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
      <span class="dash-card__footer-item">${platformIcons[task.platform] || '📋'} ${platformLabels[task.platform] || task.platform || ''}</span>
    </div>
  `;

  // Click to open timeline
  card.addEventListener('click', () => openTimeline(task.contactName, cachedAllTasks));

  return card;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ===== Customers tab =====
function renderCustomersTab(allTasks, teamContacts) {
  const contactMap = new Map();

  const withTaskStats = (base) => {
    const displayName = (base.displayName || '').trim() || [base.firstName || '', base.lastName || ''].join(' ').trim() || base.contactName || 'Unknown';
    const firstName = String(base.firstName || '').trim();
    const lastName = String(base.lastName || '').trim();
    const contactName = String(base.contactName || displayName).trim() || displayName;
    const matches = allTasks.filter((t) => {
      const tName = String(t.contactName || '').trim().toLowerCase();
      if (tName && tName === contactName.toLowerCase()) return true;
      const tEmail = String(t.email || (t.contact && t.contact.email) || '').trim().toLowerCase();
      const cEmail = String(base.email || '').trim().toLowerCase();
      return !!(tEmail && cEmail && tEmail === cEmail);
    });

    const sorted = matches.slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    const latest = sorted[0] || null;
    const baseTags = Array.isArray(base.tags) ? base.tags : [];
    const taskTags = matches.flatMap((t) => (Array.isArray(t.tags) ? t.tags : []));
    const tags = Array.from(new Set(
      [...baseTags, ...taskTags]
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    ));

    return {
      id: base.id || '',
      displayName,
      contactName,
      firstName,
      lastName,
      title: String(base.title || base.designation || '').trim(),
      company: String(base.company || '').trim(),
      profileUrl: String(base.profileUrl || base.linkedinUrl || '').trim(),
      email: String(base.email || '').trim().toLowerCase(),
      phone: String(base.phone || '').trim(),
      tags,
      tasks: sorted,
      lastInteraction: latest ? Number(latest.createdAt || latest.updatedAt || 0) : Number(base.updatedAt || base.createdAt || 0),
      currentStage: latest ? latest.stage : null,
    };
  };

  // Seed from team contacts collection first.
  (Array.isArray(teamContacts) ? teamContacts : []).forEach((c) => {
    const displayName = [c.firstName || '', c.lastName || ''].join(' ').trim() || c.name || 'Unknown';
    const key = `id:${String(c.id || '')}`;
    contactMap.set(key, withTaskStats({
      id: c.id,
      displayName,
      contactName: c.name || displayName,
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      title: c.designation || '',
      company: c.company || '',
      profileUrl: c.linkedinUrl || '',
      email: c.email || '',
      phone: c.phone || '',
      tags: Array.isArray(c.tags) ? c.tags : [],
      createdAt: c.createdAt || 0,
      updatedAt: c.updatedAt || 0,
    }));
  });

  // Include task-derived contacts not present in team contacts.
  allTasks.forEach(task => {
    const taskName = (task.firstName || task.lastName)
      ? `${task.firstName || ''} ${task.lastName || ''}`.trim()
      : (task.contactName || 'Unknown');
    const taskEmail = String(task.email || (task.contact && task.contact.email) || '').trim().toLowerCase();
    const fallbackKey = taskEmail ? `email:${taskEmail}` : `name:${String(task.contactName || taskName || 'unknown').toLowerCase()}`;

    const already = [...contactMap.values()].find((x) => {
      if (taskEmail && x.email && x.email === taskEmail) return true;
      return x.contactName.toLowerCase() === String(task.contactName || taskName || '').toLowerCase();
    });
    if (already) return;

    contactMap.set(fallbackKey, withTaskStats({
      id: '',
      displayName: taskName,
      contactName: task.contactName || taskName,
      firstName: task.firstName || '',
      lastName: task.lastName || '',
      title: task.title || '',
      company: '',
      profileUrl: task.profileUrl || '',
      email: taskEmail,
      phone: '',
      tags: [],
      createdAt: task.createdAt || 0,
      updatedAt: task.updatedAt || 0,
    }));
  });

  let customers = [...contactMap.values()];
  refreshCustomerFilterOptions(customers);

  if (customerSearchQuery) {
    const q = customerSearchQuery.toLowerCase();
    customers = customers.filter(c => {
      return c.displayName.toLowerCase().includes(q)
        || c.email.includes(q)
        || c.company.toLowerCase().includes(q)
        || c.title.toLowerCase().includes(q);
    });
  }

  if (customerStageFilter !== 'all') {
    customers = customers.filter((c) => String(c.currentStage || '').trim() === customerStageFilter);
  }

  if (customerTagFilter !== 'all') {
    const wanted = customerTagFilter.toLowerCase();
    customers = customers.filter((c) => (Array.isArray(c.tags) ? c.tags : [])
      .map((t) => String(t || '').trim().toLowerCase())
      .includes(wanted));
  }

  if (customerSort === 'name-asc') {
    customers.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')));
  } else if (customerSort === 'name-desc') {
    customers.sort((a, b) => String(b.displayName || '').localeCompare(String(a.displayName || '')));
  } else if (customerSort === 'lastActivity-asc') {
    customers.sort((a, b) => Number(a.lastInteraction || 0) - Number(b.lastInteraction || 0));
  } else {
    customers.sort((a, b) => Number(b.lastInteraction || 0) - Number(a.lastInteraction || 0));
  }

  const grid = document.getElementById('customer-grid');
  const tableWrap = document.getElementById('customer-table-wrap');
  grid.innerHTML = '';
  if (tableWrap) document.getElementById('customer-table-body').innerHTML = '';
  const emptyEl = document.getElementById('customer-empty');

  const subtitleEl = document.getElementById('page-subtitle');
  if (subtitleEl) subtitleEl.textContent = `${customers.length} contact${customers.length !== 1 ? 's' : ''}`;

  if (customers.length === 0) {
    emptyEl.hidden = false;
    grid.hidden = true;
    if (tableWrap) tableWrap.hidden = true;
    return;
  }
  emptyEl.hidden = true;

  if (customerView === 'table' && tableWrap) {
    grid.hidden = true;
    tableWrap.hidden = false;
    renderCustomerTable(customers, allTasks);
  } else {
    grid.hidden = false;
    if (tableWrap) tableWrap.hidden = true;
    customers.forEach(customer => {
      grid.appendChild(buildCustomerCard(customer, allTasks));
    });
  }
}

function renderCustomerTable(customers, allTasks) {
  const thead = document.querySelector('#customer-table thead tr');
  const tbody = document.getElementById('customer-table-body');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  ['Name', 'Title', 'Email', 'Tasks', 'Pending', 'Stage', 'Last Activity', 'Profile', 'Actions'].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    thead.appendChild(th);
  });

  customers.forEach(customer => {
    const tr = document.createElement('tr');
    const pendingCount = customer.tasks.filter(t => !t.completed).length;
    const latestTask = Array.isArray(customer.tasks) && customer.tasks.length > 0 ? customer.tasks[0] : null;
    const stage = customer.currentStage ? getStage(customer.currentStage) : null;
    const initials = (String(customer.displayName || '').trim().charAt(0) || '?').toUpperCase();
    const colorIdx = Math.abs([...customer.displayName].reduce((a, c) => a + c.charCodeAt(0), 0)) % AVATAR_COLORS.length;

    // Name
    const tdName = document.createElement('td');
    tdName.className = 'td-contact';
    const avatar = document.createElement('span');
    avatar.className = 'tbl-avatar';
    avatar.textContent = initials;
    avatar.style.background = AVATAR_COLORS[colorIdx];
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tbl-name';
    nameSpan.textContent = customer.displayName || 'Unknown';
    nameSpan.style.cursor = 'pointer';
    nameSpan.addEventListener('click', () => openTimeline(customer.contactName, allTasks));
    tdName.append(avatar, nameSpan);

    // Title
    const tdTitle = document.createElement('td');
    tdTitle.textContent = customer.title || '—';
    tdTitle.style.maxWidth = '200px';
    tdTitle.style.overflow = 'hidden';
    tdTitle.style.textOverflow = 'ellipsis';
    tdTitle.style.whiteSpace = 'nowrap';
    tdTitle.title = customer.title || '';

    // Email
    const tdEmail = document.createElement('td');
    tdEmail.textContent = customer.email || '—';

    // Tasks count
    const tdTasks = document.createElement('td');
    tdTasks.textContent = customer.tasks.length;

    // Pending
    const tdPending = document.createElement('td');
    tdPending.textContent = pendingCount;
    if (pendingCount > 0) tdPending.style.color = 'var(--amber)';

    // Stage
    const tdStage = document.createElement('td');
    if (latestTask && latestTask.id) {
      tdStage.appendChild(buildStageBadge(latestTask));
    } else if (stage) {
      const badge = document.createElement('span');
      badge.className = 'stage-badge';
      badge.style.setProperty('--stage-bg', stage.bg);
      badge.style.setProperty('--stage-color', stage.color);
      badge.textContent = stage.label;
      tdStage.appendChild(badge);
    } else {
      tdStage.textContent = '—';
    }

    // Last activity
    const tdActivity = document.createElement('td');
    tdActivity.textContent = formatRelativeDate(customer.lastInteraction);

    // Profile
    const tdProfile = document.createElement('td');
    if (customer.profileUrl) {
      const link = document.createElement('a');
      link.href = customer.profileUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '👤';
      link.title = 'View profile';
      link.style.textDecoration = 'none';
      tdProfile.appendChild(link);
    } else {
      tdProfile.textContent = '—';
    }

    // Actions
    const tdActions = document.createElement('td');
    const tlBtn = document.createElement('button');
    tlBtn.className = 'tbl-btn';
    tlBtn.textContent = '📅';
    tlBtn.title = 'View timeline';
    tlBtn.addEventListener('click', () => openTimeline(customer.contactName, allTasks));
    tdActions.appendChild(tlBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'tbl-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit contact';
    editBtn.addEventListener('click', () => openContactEditModal(customer));
    tdActions.appendChild(editBtn);

    tr.append(tdName, tdTitle, tdEmail, tdTasks, tdPending, tdStage, tdActivity, tdProfile, tdActions);
    tbody.appendChild(tr);
  });
}

function buildCustomerCard(customer, allTasks) {
  const card = document.createElement('div');
  card.className = 'customer-card';
  card.setAttribute('role', 'listitem');
  card.addEventListener('click', () => openTimeline(customer.contactName, allTasks));

  const initials = (String(customer.displayName || '').trim().charAt(0) || '?').toUpperCase();
  const pendingCount = customer.tasks.filter(t => !t.completed).length;
  const latestTask = Array.isArray(customer.tasks) && customer.tasks.length > 0 ? customer.tasks[0] : null;
  const stage = customer.currentStage ? getStage(customer.currentStage) : null;

  // Avatar
  const header = document.createElement('div');
  header.className = 'customer-card__header';

  const avatar = document.createElement('div');
  avatar.className = 'customer-card__avatar';
  avatar.textContent = initials;

  const info = document.createElement('div');
  info.className = 'customer-card__info';
  const nameEl = document.createElement('p');
  nameEl.className = 'customer-card__name';
  nameEl.textContent = customer.displayName;
  const metaEl = document.createElement('p');
  metaEl.className = 'customer-card__meta';
  metaEl.textContent = formatRelativeDate(customer.lastInteraction);
  info.append(nameEl);
  if (customer.title) {
    const titleEl = document.createElement('p');
    titleEl.className = 'customer-card__title';
    titleEl.textContent = customer.title;
    info.appendChild(titleEl);
  }
  info.appendChild(metaEl);

  header.append(avatar, info);
  card.appendChild(header);

  // Stats row
  const stats = document.createElement('div');
  stats.className = 'customer-card__stats';
  const totalSpan = document.createElement('span');
  totalSpan.textContent = `${customer.tasks.length} task${customer.tasks.length !== 1 ? 's' : ''}`;
  const pendingSpan = document.createElement('span');
  pendingSpan.textContent = `${pendingCount} pending`;
  stats.append(totalSpan, pendingSpan);

  if (customer.profileUrl) {
    const profLink = document.createElement('a');
    profLink.href = customer.profileUrl;
    profLink.target = '_blank';
    profLink.rel = 'noopener noreferrer';
    profLink.textContent = '👤 Profile';
    profLink.addEventListener('click', (e) => e.stopPropagation());
    stats.appendChild(profLink);
  }

  card.appendChild(stats);

  const actions = document.createElement('div');
  actions.className = 'customer-card__stats';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'tbl-btn';
  editBtn.textContent = '✎';
  editBtn.title = 'Edit contact';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openContactEditModal(customer);
  });
  actions.appendChild(editBtn);
  card.appendChild(actions);

  // Stage badge
  if (latestTask && latestTask.id) {
    const stageControl = buildStageBadge(latestTask);
    stageControl.style.alignSelf = 'flex-start';
    card.appendChild(stageControl);
  } else if (stage) {
    const badge = document.createElement('span');
    badge.className = 'stage-badge';
    badge.style.setProperty('--stage-bg', stage.bg);
    badge.style.setProperty('--stage-color', stage.color);
    badge.textContent = stage.label;
    badge.style.alignSelf = 'flex-start';
    card.appendChild(badge);
  }

  return card;
}

function openContactEditModal(contact) {
  const existing = document.getElementById('contact-edit-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'contact-edit-overlay';
  overlay.className = 'settings-overlay';

  const modal = document.createElement('div');
  modal.className = 'settings-modal';
  modal.style.width = '520px';

  const header = document.createElement('div');
  header.className = 'settings-modal__header';
  header.innerHTML = `<h2 class="settings-modal__title">Edit Contact</h2>`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-modal__close';
  closeBtn.innerHTML = '&#x2715;';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);

  const panel = document.createElement('div');
  panel.className = 'settings-panel';

  const mkField = (label, id, value, type = 'text') => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.style.display = 'block';

    const l = document.createElement('label');
    l.className = 'settings-label';
    l.textContent = label;
    l.htmlFor = id;

    const i = document.createElement('input');
    i.id = id;
    i.type = type;
    i.className = 'settings-input';
    i.value = value || '';
    i.style.width = '100%';

    row.append(l, i);
    return row;
  };

  panel.append(
    mkField('First Name', 'ce-first', contact.firstName || ''),
    mkField('Last Name', 'ce-last', contact.lastName || ''),
    mkField('Email', 'ce-email', contact.email || '', 'email'),
    mkField('Phone', 'ce-phone', contact.phone || ''),
    mkField('Company', 'ce-company', contact.company || ''),
    mkField('Designation', 'ce-designation', contact.title || ''),
    mkField('LinkedIn URL', 'ce-linkedin', contact.profileUrl || '', 'url')
  );

  const footer = document.createElement('div');
  footer.className = 'settings-modal__footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'settings-footer-btn settings-footer-btn--cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const saveBtn = document.createElement('button');
  saveBtn.className = 'settings-footer-btn settings-footer-btn--save';
  saveBtn.textContent = 'Save Contact';
  saveBtn.addEventListener('click', async () => {
    try {
      const firstName = document.getElementById('ce-first').value.trim();
      const lastName = document.getElementById('ce-last').value.trim();
      const fullName = `${firstName} ${lastName}`.trim() || contact.displayName || contact.contactName;
      const payload = {
        name: fullName,
        firstName,
        lastName,
        email: document.getElementById('ce-email').value.trim().toLowerCase(),
        phone: document.getElementById('ce-phone').value.trim(),
        company: document.getElementById('ce-company').value.trim(),
        designation: document.getElementById('ce-designation').value.trim(),
        linkedinUrl: document.getElementById('ce-linkedin').value.trim(),
      };

      if (contact.id && cloudStore.updateTeamContact) {
        await cloudStore.updateTeamContact(contact.id, payload);
      } else {
        await cloudStore.ensureTeamContact(payload);
      }

      overlay.remove();
      await renderAll();
      showTab(currentTab);
    } catch (err) {
      alert('Could not update contact. Please try again.');
      console.error('[dashboard] contact update failed', err);
    }
  });

  footer.append(cancelBtn, saveBtn);
  modal.append(header, panel, footer);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function setupTaskSubFilters() {
  document.querySelectorAll('.sub-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sub-filter-pill').forEach(b => b.classList.remove('sub-filter-pill--active'));
      btn.classList.add('sub-filter-pill--active');
      currentTaskFilter = btn.dataset.filter;
      renderTasks(cachedAllTasks);
    });
  });
}

function setupCustomerSearch() {
  const el = document.getElementById('customer-search');
  if (!el) return;
  el.addEventListener('input', (e) => {
    customerSearchQuery = e.target.value.trim();
    renderCustomersTab(cachedAllTasks, cachedTeamContacts);
  });
}

function refreshCustomerFilterOptions(customers) {
  const stageEl = document.getElementById('customer-stage-filter');
  const tagEl = document.getElementById('customer-tag-filter');
  const sortEl = document.getElementById('customer-sort');
  if (!stageEl || !tagEl || !sortEl) return;

  const stageBefore = customerStageFilter;
  const tagBefore = customerTagFilter;

  stageEl.innerHTML = '<option value="all">All stages</option>';
  STAGES.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.value;
    opt.textContent = s.label;
    stageEl.appendChild(opt);
  });

  const tags = Array.from(new Set(
    (Array.isArray(customers) ? customers : [])
      .flatMap((c) => (Array.isArray(c.tags) ? c.tags : []))
      .map((t) => String(t || '').trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  tagEl.innerHTML = '<option value="all">All tags</option>';
  tags.forEach((tag) => {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = tag;
    tagEl.appendChild(opt);
  });

  if ([...stageEl.options].some((o) => o.value === stageBefore)) {
    customerStageFilter = stageBefore;
  } else {
    customerStageFilter = 'all';
  }
  if ([...tagEl.options].some((o) => o.value === tagBefore)) {
    customerTagFilter = tagBefore;
  } else {
    customerTagFilter = 'all';
  }

  stageEl.value = customerStageFilter;
  tagEl.value = customerTagFilter;
  sortEl.value = customerSort;
}

function setupCustomerFilters() {
  const stageEl = document.getElementById('customer-stage-filter');
  const tagEl = document.getElementById('customer-tag-filter');
  const sortEl = document.getElementById('customer-sort');
  if (!stageEl || !tagEl || !sortEl) return;

  stageEl.onchange = (e) => {
    customerStageFilter = e.target.value || 'all';
    renderCustomersTab(cachedAllTasks, cachedTeamContacts);
  };

  tagEl.onchange = (e) => {
    customerTagFilter = e.target.value || 'all';
    renderCustomersTab(cachedAllTasks, cachedTeamContacts);
  };

  sortEl.onchange = (e) => {
    customerSort = e.target.value || 'lastActivity-desc';
    renderCustomersTab(cachedAllTasks, cachedTeamContacts);
  };
}

function setupCustomerViewToggle() {
  const cardsBtn = document.getElementById('cust-view-cards');
  const tableBtn = document.getElementById('cust-view-table');
  if (!cardsBtn || !tableBtn) return;
  cardsBtn.addEventListener('click', () => {
    customerView = 'cards';
    cardsBtn.classList.add('view-btn--active');
    tableBtn.classList.remove('view-btn--active');
    renderCustomersTab(cachedAllTasks, cachedTeamContacts);
  });
  tableBtn.addEventListener('click', () => {
    customerView = 'table';
    tableBtn.classList.add('view-btn--active');
    cardsBtn.classList.remove('view-btn--active');
    renderCustomersTab(cachedAllTasks, cachedTeamContacts);
  });
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

function renderTasks(allTasks) {
  const now = Date.now();
  const td = todayRange();
  const wk = thisWeekRange();

  let tasks = allTasks.filter(task => {
    if (currentTaskFilter === 'today')    return !task.completed && task.remindAt >= td.start && task.remindAt <= td.end;
    if (currentTaskFilter === 'thisweek') return !task.completed && task.remindAt >= wk.start && task.remindAt <= wk.end;
    if (currentTaskFilter === 'pending')  return !task.completed && task.remindAt >= now;
    if (currentTaskFilter === 'overdue')  return !task.completed && task.remindAt < now;
    if (currentTaskFilter === 'completed') return task.completed;
    return true; // 'all'
  });

  // Owner filter
  if (currentOwnerFilter !== 'all') {
    tasks = tasks.filter(t => !t.owner || t.owner === currentOwnerFilter);
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    tasks = tasks.filter(t =>
      (t.contactName || '').toLowerCase().includes(q) ||
      (t.description && t.description.toLowerCase().includes(q))
    );
  }

  const [sortKey, sortDir] = currentSort.split('-');
  tasks.sort((a, b) => {
    if (sortKey === 'name') {
      const cmp = (a.contactName || '').toLowerCase().localeCompare((b.contactName || '').toLowerCase());
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

  const titles = { all: 'All Tasks', today: 'Today', thisweek: 'This Week', pending: 'Pending', overdue: 'Overdue', completed: 'Completed' };
  const titleEl = document.getElementById('page-title');
  const subtitleEl = document.getElementById('page-subtitle');
  if (titleEl) titleEl.textContent = titles[currentTaskFilter] || 'All Tasks';
  if (subtitleEl) subtitleEl.textContent = `${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;
}

// ===== Table view =====

function renderTable(tasks, allTasks) {
  const compact = false; // always show full columns
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
    const _initials = ((task.firstName || task.contactName || '?')[0]).toUpperCase();
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
  const _cardInitials = ((task.firstName || task.contactName || '?')[0]).toUpperCase();

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

function closeAllStageDropdowns() {
  document.querySelectorAll('.stage-dropdown--open').forEach((dropdown) => {
    dropdown.classList.remove('stage-dropdown--open');

    if (dropdown.dataset.floating !== '1') return;

    const hostId = dropdown.dataset.hostId;
    const host = hostId ? document.querySelector(`[data-stage-host="${hostId}"]`) : null;
    if (host) host.appendChild(dropdown);

    dropdown.style.position = '';
    dropdown.style.top = '';
    dropdown.style.left = '';
    dropdown.style.zIndex = '';
    dropdown.dataset.floating = '';
    dropdown.dataset.hostId = '';
  });
}

function buildStageBadge(task) {
  const stage = getStage(task.stage);

  const wrapper = document.createElement('div');
  wrapper.className = 'stage-badge-wrap';
  wrapper.style.position = 'relative';
  wrapper.style.display = 'inline-block';
  const hostId = `stage_${task.id}_${Math.random().toString(36).slice(2, 7)}`;
  wrapper.dataset.stageHost = hostId;

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
    closeAllStageDropdowns();
    if (isOpen) return;

    // Render in body with fixed positioning to avoid clipping inside table wrappers.
    document.body.appendChild(dropdown);
    dropdown.classList.add('stage-dropdown--open');
    dropdown.dataset.floating = '1';
    dropdown.dataset.hostId = hostId;
    dropdown.style.position = 'fixed';
    dropdown.style.zIndex = '12000';

    const badgeRect = badge.getBoundingClientRect();
    const ddRect = dropdown.getBoundingClientRect();
    const safeLeft = Math.max(8, Math.min(badgeRect.left, window.innerWidth - ddRect.width - 8));
    const safeTop = Math.max(8, Math.min(badgeRect.bottom + 4, window.innerHeight - ddRect.height - 8));
    dropdown.style.left = `${safeLeft}px`;
    dropdown.style.top = `${safeTop}px`;
  });

  wrapper.append(badge, dropdown);
  return wrapper;
}

async function handleStageChange(taskId, newStage) {
  await cloudStore.patchTask(taskId, { stage: newStage, updatedAt: Date.now() });
  await renderAll();
}

// ===== Actions =====

async function handleComplete(taskId) {
  await cloudStore.patchTask(taskId, { completed: true, status: 'done', updatedAt: Date.now() });
  chrome.runtime.sendMessage({ action: 'DELETE_ALARM', alarmName: taskId });
  await renderAll();
}

async function handleDelete(taskId) {
  if (!confirm('Delete this task?')) return;
  await cloudStore.removeTask(taskId);
  chrome.runtime.sendMessage({ action: 'DELETE_ALARM', alarmName: taskId });
  await renderAll();
}

// ===== Nav, search, sort =====

function setupSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  input.oninput = () => {
    const q = input.value.trim();
    searchQuery = q;

    // Header search should work in both task and contact views.
    if (currentTab === 'contacts' || currentTab === 'customers') {
      customerSearchQuery = q;
      renderCustomersTab(cachedAllTasks, cachedTeamContacts);
      return;
    }

    // When searching from Dashboard overview, switch to task list so results are visible.
    if (currentTab === 'dashboard') {
      const pendingBtn = document.querySelector('.nav-btn[data-tab="pending"]');
      if (pendingBtn) {
        document.querySelectorAll('.nav-btn[data-tab]').forEach((b) => b.classList.remove('nav-btn--active'));
        pendingBtn.classList.add('nav-btn--active');
      }
      currentTab = 'pending';
      showTab('pending');
      currentTaskFilter = 'all';
    }

    renderTasks(cachedAllTasks);
  };
}

function setupNewTaskButton() {
  const btn = document.getElementById('new-task-btn');
  if (!btn) return;

  btn.onclick = () => openNewTaskModal();
}

function openNewTaskModal() {
  const existing = document.getElementById('new-task-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'new-task-overlay';
  overlay.className = 'settings-overlay';

  const modal = document.createElement('div');
  modal.className = 'settings-modal';
  modal.style.width = '520px';

  const header = document.createElement('div');
  header.className = 'settings-modal__header';
  header.innerHTML = '<h2 class="settings-modal__title">New Task</h2>';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-modal__close';
  closeBtn.innerHTML = '&#x2715;';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);

  const panel = document.createElement('div');
  panel.className = 'settings-panel';

  const mkField = (label, id, type, value, required) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.style.display = 'block';

    const l = document.createElement('label');
    l.className = 'settings-label';
    l.textContent = label;
    l.htmlFor = id;

    const i = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    i.id = id;
    i.className = 'settings-input';
    if (type !== 'textarea') i.type = type;
    if (type === 'textarea') i.rows = 3;
    i.value = value || '';
    i.required = !!required;
    i.style.width = '100%';

    row.append(l, i);
    return row;
  };

  const mkSelect = (label, id, options, value) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.style.display = 'block';

    const l = document.createElement('label');
    l.className = 'settings-label';
    l.textContent = label;
    l.htmlFor = id;

    const s = document.createElement('select');
    s.id = id;
    s.className = 'settings-input';
    s.style.width = '100%';
    options.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === value) o.selected = true;
      s.appendChild(o);
    });
    row.append(l, s);
    return row;
  };

  const ownerOptions = (OWNERS || []).map((o) => ({ value: o.id, label: o.label }));
  const defaultOwner = (currentOwnerFilter !== 'all' && getOwner(currentOwnerFilter))
    ? currentOwnerFilter
    : ((OWNERS[0] && OWNERS[0].id) || 'owner_default');
  const stageOptions = (STAGES && STAGES.length > 0)
    ? STAGES.map((s) => ({ value: s.value, label: s.label }))
    : [{ value: 'prospect', label: 'Prospect' }];

  panel.append(
    mkField('Contact Name', 'nt-contact', 'text', '', true),
    mkField('Email (optional)', 'nt-email', 'email', '', false),
    mkSelect('Owner', 'nt-owner', ownerOptions.length ? ownerOptions : [{ value: 'owner_default', label: 'You' }], defaultOwner),
    mkSelect('Stage', 'nt-stage', stageOptions, (stageOptions[0] && stageOptions[0].value) || 'prospect'),
    mkField('Notes (optional)', 'nt-notes', 'textarea', '', false)
  );

  const footer = document.createElement('div');
  footer.className = 'settings-modal__footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'settings-footer-btn settings-footer-btn--cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const saveBtn = document.createElement('button');
  saveBtn.className = 'settings-footer-btn settings-footer-btn--save';
  saveBtn.textContent = 'Create Task';
  saveBtn.addEventListener('click', async () => {
    const contactName = String(document.getElementById('nt-contact').value || '').trim();
    if (!contactName) {
      alert('Contact name is required.');
      return;
    }

    const email = String(document.getElementById('nt-email').value || '').trim().toLowerCase();
    const selectedOwner = String(document.getElementById('nt-owner').value || defaultOwner);
    const selectedStage = String(document.getElementById('nt-stage').value || 'prospect');
    const description = String(document.getElementById('nt-notes').value || '').trim();

    const now = Date.now();
    const remindAt = new Date(now + (2 * 24 * 60 * 60 * 1000));
    remindAt.setHours(9, 0, 0, 0);

    const parts = contactName.split(/\s+/).filter(Boolean);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ');

    const task = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'linkedin',
      platform: 'linkedin',
      contact: {
        name: contactName,
        firstName,
        lastName,
        profileUrl: '',
        email,
        title: '',
      },
      stage: selectedStage,
      status: 'pending',
      description,
      completed: false,
      ownerId: selectedOwner,
      owner: selectedOwner,
      assignedTo: '',
      followUpDays: 2,
      followupDays: 2,
      remindAt: remindAt.getTime(),
      createdAt: now,
      updatedAt: now,
      threadUrl: '',
      priority: 'medium',
      tags: [],
      createdBy: '',
      contactName,
      firstName,
      lastName,
      profileUrl: '',
      email,
      title: '',
    };

    try {
      await cloudStore.saveTask(task);
      overlay.remove();
      await renderAll();

      const pendingBtn = document.querySelector('.nav-btn[data-tab="pending"]');
      if (pendingBtn) {
        document.querySelectorAll('.nav-btn[data-tab]').forEach((b) => b.classList.remove('nav-btn--active'));
        pendingBtn.classList.add('nav-btn--active');
      }
      currentTab = 'pending';
      showTab('pending');
    } catch (err) {
      alert('Could not create task. Please try again.');
      console.error('[dashboard] new task failed', err);
    }
  });

  footer.append(cancelBtn, saveBtn);
  modal.append(header, panel, footer);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  const first = document.getElementById('nt-contact');
  if (first) first.focus();
}

function setupSort() {
  document.getElementById('sort-select').addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderTasks(cachedAllTasks);
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
  allPill.addEventListener('click', () => { currentOwnerFilter = 'all'; setupOwnerFilter(); renderTasks(cachedAllTasks); });
  container.appendChild(allPill);

  OWNERS.forEach(owner => {
    const pill = document.createElement('button');
    pill.className = 'owner-filter-pill' + (currentOwnerFilter === owner.id ? ' owner-filter-pill--active' : '');
    pill.textContent = owner.label;
    pill.style.setProperty('--owner-color', owner.color);
    pill.style.setProperty('--owner-bg', owner.bg);
    pill.addEventListener('click', () => { currentOwnerFilter = owner.id; setupOwnerFilter(); renderTasks(cachedAllTasks); });
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
      if (target === 'team') renderSettingsTeam();
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

  // Pre-populate the team panel content (async, non-blocking)
  renderSettingsTeam();

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

  if (_draftOwners.length === 0) {
    container.innerHTML = '<p class="settings-team-empty">No owners yet. Click "+ Add Owner" to create one.</p>';
    return;
  }

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

  if (_draftStages.length === 0) {
    container.innerHTML = '<p class="settings-team-empty">No stages yet. Click "+ Add Stage" to create one.</p>';
    return;
  }

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

async function loadTeamData() {
  const data = await chrome.storage.local.get(['auth']);
  const auth = data.auth;
  if (!auth || !auth.localId || !auth.idToken) return null;

  const cloud = window.TaskSaverCloud;
  const userProfile = await cloud.readDocAtPath(`users/${auth.localId}`, auth.idToken).catch(() => null);
  if (!userProfile || !userProfile.teamId) return null;

  const teamId = userProfile.teamId;
  const [teamDoc, memberDocs] = await Promise.all([
    cloud.readDocAtPath(`teams/${teamId}`, auth.idToken).catch(() => null),
    cloud.listCollectionAtPath(`teams/${teamId}/members`, auth.idToken).catch(() => []),
  ]);
  if (!teamDoc) return null;

  // name/email are stored directly on each member doc to avoid cross-user profile reads
  const membersWithProfiles = memberDocs.map((m) => ({
    userId: m.userId,
    role: m.role || 'member',
    joinedAt: m.joinedAt || 0,
    name: m.name || '',
    email: m.email || '',
  }));

  return {
    teamCode: teamDoc.teamCode || '',
    teamName: teamDoc.name || '',
    ownerId: teamDoc.ownerId || '',
    members: membersWithProfiles,
  };
}

async function renderSettingsTeam() {
  const container = document.getElementById('settings-team-panel');
  container.innerHTML = '<p class="settings-team-empty">Loading team data…</p>';

  let data;
  try {
    data = await loadTeamData();
  } catch (_) {
    data = null;
  }

  if (!data) {
    container.innerHTML = '<p class="settings-team-empty">Sign in to view team info.</p>';
    return;
  }

  container.innerHTML = '';

  // Team code section
  const codeSection = document.createElement('div');
  codeSection.className = 'settings-team-section';

  if (data.teamName) {
    const teamNameEl = document.createElement('p');
    teamNameEl.className = 'settings-team-name';
    teamNameEl.textContent = data.teamName;
    codeSection.appendChild(teamNameEl);
  }

  const codeLabel = document.createElement('p');
  codeLabel.className = 'settings-team-label';
  codeLabel.textContent = 'Team Code';
  codeSection.appendChild(codeLabel);

  const codeHint = document.createElement('p');
  codeHint.className = 'settings-team-hint';
  codeHint.textContent = 'Share this code with teammates so they can join your team on sign-up.';
  codeSection.appendChild(codeHint);

  const codeRow = document.createElement('div');
  codeRow.className = 'settings-team-code-row';

  const codeDisplay = document.createElement('span');
  codeDisplay.className = 'settings-team-code';
  codeDisplay.textContent = data.teamCode || '—';
  codeRow.appendChild(codeDisplay);

  if (data.teamCode) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'settings-team-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(data.teamCode).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
      }).catch(() => {});
    });
    codeRow.appendChild(copyBtn);
  }

  codeSection.appendChild(codeRow);
  container.appendChild(codeSection);

  // Members section
  const membersSection = document.createElement('div');
  membersSection.className = 'settings-team-section';

  const membersLabel = document.createElement('p');
  membersLabel.className = 'settings-team-label';
  membersLabel.textContent = `Members (${data.members.length})`;
  membersSection.appendChild(membersLabel);

  const membersList = document.createElement('div');
  membersList.className = 'settings-list';

  if (data.members.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-team-empty';
    empty.textContent = 'No members found.';
    membersList.appendChild(empty);
  } else {
    data.members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'settings-row';

      const avatar = document.createElement('span');
      avatar.className = 'settings-team-avatar';
      avatar.textContent = (m.name || m.email || m.userId).charAt(0).toUpperCase();

      const info = document.createElement('div');
      info.className = 'settings-team-member-info';

      const nameEl = document.createElement('span');
      nameEl.className = 'settings-team-member-name';
      nameEl.textContent = m.name || m.email || m.userId;

      if (m.name && m.email) {
        const emailEl = document.createElement('span');
        emailEl.className = 'settings-team-member-email';
        emailEl.textContent = m.email;
        info.append(nameEl, emailEl);
      } else {
        info.appendChild(nameEl);
      }

      const roleBadge = document.createElement('span');
      roleBadge.className = `settings-team-role settings-team-role--${m.role}`;
      roleBadge.textContent = m.role;

      row.append(avatar, info, roleBadge);
      membersList.appendChild(row);
    });
  }

  membersSection.appendChild(membersList);
  container.appendChild(membersSection);
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
