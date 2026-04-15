const FIREBASE_API_KEY = 'AIzaSyA7dMDGoWCDXSIWBZ5Bl-NFnnXAp2zV6i4';
const cloudStore = window.TaskSaverCloud;

const DEFAULT_SETTINGS = {
  owners: [
    { id: 'owner_default', label: 'You', email: '', color: '#4573d2', bg: '#eef2fc' },
  ],
};

let authMode = 'signin';
let rotatingTimer = null;

function dashboardUrl() {
  return chrome.runtime.getURL('dashboard/dashboard.html');
}

function parseModeFromQuery() {
  const url = new URL(location.href);
  const mode = url.searchParams.get('mode');
  if (mode === 'signup') authMode = 'signup';
}

function updateAuthModeUI() {
  const isSignUp = authMode === 'signup';
  document.getElementById('auth-subtitle').textContent = 'One tap. Back in the conversation';
  document.getElementById('auth-submit').textContent = isSignUp ? 'Sign Up' : 'Sign In';
  document.getElementById('auth-switch-text').textContent = isSignUp ? 'Already have an account?' : "Don't have an account?";
  document.getElementById('auth-switch-btn').textContent = isSignUp ? 'Sign In' : 'Sign Up';
  const errorEl = document.getElementById('auth-error');
  errorEl.hidden = true;
  errorEl.classList.remove('auth-error--success');

  const nameEl     = document.getElementById('auth-name');
  const teamcodeEl = document.getElementById('auth-teamcode');
  const forgotBtn = document.getElementById('auth-forgot-btn');
  if (nameEl)     { nameEl.hidden     = !isSignUp; nameEl.required     = isSignUp; }
  if (teamcodeEl) { teamcodeEl.hidden = !isSignUp; }
  if (forgotBtn) forgotBtn.hidden = isSignUp;
}

function toggleAuthMode() {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  updateAuthModeUI();
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
  return json;
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
  return json;
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

function setAuthMessage(message, isSuccess) {
  const errorEl = document.getElementById('auth-error');
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.hidden = false;
  errorEl.classList.toggle('auth-error--success', !!isSuccess);
}

function friendlyResetError(code) {
  if (code.includes('INVALID_EMAIL')) return 'Please enter a valid email address.';
  if (code.includes('MISSING_EMAIL')) return 'Please enter your email first.';
  if (code.includes('NETWORK_REQUEST_FAILED')) return 'Network error. Check your connection.';
  if (code.includes('TOO_MANY_REQUESTS')) return 'Too many attempts. Please wait and try again.';
  return 'Could not send reset email. Please try again.';
}

async function handleForgotPassword() {
  const email = document.getElementById('auth-email').value.trim();
  const forgotBtn = document.getElementById('auth-forgot-btn');
  if (!email) {
    setAuthMessage('Please enter your email first.', false);
    return;
  }

  if (forgotBtn) forgotBtn.disabled = true;
  try {
    await sendPasswordResetEmail(email);
    setAuthMessage('If this email is registered, a password reset link has been sent.', true);
  } catch (err) {
    setAuthMessage(friendlyResetError(err.message || ''), false);
  } finally {
    if (forgotBtn) forgotBtn.disabled = false;
  }
}

function friendlyAuthError(code, mode) {
  if (code.includes('INVALID_EMAIL')) return 'Please enter a valid email address.';
  if (code.includes('NETWORK_REQUEST_FAILED')) return 'Network error. Check your connection.';
  if (code.includes('TOO_MANY_REQUESTS')) return 'Too many attempts. Please wait and try again.';
  if (mode === 'signup') {
    if (code.includes('EMAIL_EXISTS')) return 'An account with this email already exists.';
    if (code.includes('WEAK_PASSWORD')) return 'Password must be at least 6 characters.';
    return `Sign up failed: ${code}`;
  }
  if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/.test(code)) return 'Invalid email or password.';
  return `Sign in failed: ${code}`;
}

async function resolveOwnerId(email) {
  const settings = await cloudStore.getSettings();
  const owners = (settings && Array.isArray(settings.owners) && settings.owners.length > 0)
    ? settings.owners
    : DEFAULT_SETTINGS.owners;
  const owner = owners.find(o => o.email && o.email.toLowerCase() === email.toLowerCase());
  return owner ? owner.id : `owner_${(email || 'user').split('@')[0].replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

async function ensureSingleOwnerSettings(email, preferredId) {
  const safeEmail = (email || '').trim().toLowerCase();
  const local = safeEmail.split('@')[0] || 'owner';
  const id = (preferredId || `owner_${local}`).replace(/[^a-z0-9_]/g, '_');
  const labelBase = local.replace(/[^a-z0-9]+/g, ' ').trim();
  const label = labelBase ? labelBase.charAt(0).toUpperCase() + labelBase.slice(1) : 'You';
  const owner = { id, label, email: safeEmail, color: '#4573d2', bg: '#eef2fc' };
  const existing = await cloudStore.getSettings();
  await cloudStore.setSettings({ ...(existing || {}), owners: [owner] });
  return owner.id;
}

async function provisionUserAndTeam(userId, idToken, name, email, teamCode) {
  const cloud = window.TaskSaverCloud;
  let teamId, role;
  let existingMembers = [];

  const trimmedCode = (teamCode || '').trim().toUpperCase();
  if (trimmedCode) {
    const found = await cloud.findTeamByCode(trimmedCode, idToken);
    if (!found) throw new Error('TEAM_NOT_FOUND');
    teamId = found.teamId;
    role   = 'member';
    existingMembers = Array.isArray(found.members) ? found.members : [];
  } else {
    teamId = `team_${userId}`;
    role   = 'admin';
  }

  // Create user profile first so isTeamMember(teamId) can pass via userTeamId() during join.
  await cloud.createUserProfile(userId, idToken, { name, email, teamId, role });

  if (trimmedCode) {
    // Update members array on team doc first (self-join rule allows adding your own uid).
    if (!existingMembers.includes(userId)) {
      await cloud.updateTeamMembersArray(teamId, idToken, [...existingMembers, userId]);
    }
    // Then write member subdocument with profile details.
    await cloud.addTeamMember(teamId, userId, idToken, { userId, role, name, email });
  } else {
    const generatedCode = cloud.generateTeamCode();
    const teamName      = name ? `${name}'s Team` : 'My Team';

    await cloud.createTeamDoc(teamId, idToken, {
      name:     teamName,
      teamCode: generatedCode,
      ownerId:  userId,
      members:  [userId],
    });
    await cloud.seedDefaultTeamStages(teamId, idToken, userId);
    await cloud.addTeamMember(teamId, userId, idToken, { userId, role, name, email });
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const name     = (document.getElementById('auth-name')?.value || '').trim();
  const teamCode = document.getElementById('auth-teamcode')?.value || '';
  const errorEl  = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit');
  const isSignUp = authMode === 'signup';

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

    const ownerId = isSignUp
      ? await ensureSingleOwnerSettings(json.email || email, `owner_${json.localId}`)
      : await resolveOwnerId(json.email || email);
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
    await completePostSignInMergeFlow();
    location.href = dashboardUrl();
  } catch (err) {
    errorEl.textContent = err.message === 'TEAM_NOT_FOUND'
      ? 'Team code not found. Check the code or leave it blank to create a new team.'
      : friendlyAuthError(err.message, authMode);
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = isSignUp ? 'Sign Up' : 'Sign In';
  }
}

async function continueAsGuest() {
  await chrome.storage.local.remove('auth');
  await chrome.storage.sync.remove('currentOwner');
  await cloudStore.postSignOut();
  location.href = dashboardUrl();
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

function setupImageRotator() {
  const imgEl = document.getElementById('rotating-image');
  const images = [
    'images/slide-1.svg',
    'images/slide-2.svg',
    'images/slide-3.svg',
  ];
  let idx = 0;

  const setImage = () => {
    idx = (idx + 1) % images.length;
    imgEl.style.opacity = '0.25';
    setTimeout(() => {
      imgEl.src = images[idx];
      imgEl.style.opacity = '1';
    }, 220);
  };

  imgEl.src = images[0];
  rotatingTimer = setInterval(setImage, 2800);
}

document.addEventListener('DOMContentLoaded', async () => {
  parseModeFromQuery();
  updateAuthModeUI();
  setupImageRotator();
  await cloudStore.init();

  document.getElementById('auth-form').addEventListener('submit', handleAuthSubmit);
  document.getElementById('auth-switch-btn').addEventListener('click', toggleAuthMode);
  document.getElementById('auth-forgot-btn').addEventListener('click', handleForgotPassword);
  document.getElementById('guest-btn').addEventListener('click', continueAsGuest);
});

window.addEventListener('beforeunload', () => {
  if (rotatingTimer) clearInterval(rotatingTimer);
});
