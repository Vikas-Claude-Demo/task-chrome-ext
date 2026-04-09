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
  document.getElementById('auth-error').hidden = true;

  const nameEl     = document.getElementById('auth-name');
  const teamcodeEl = document.getElementById('auth-teamcode');
  if (nameEl)     { nameEl.hidden     = !isSignUp; nameEl.required     = isSignUp; }
  if (teamcodeEl) { teamcodeEl.hidden = !isSignUp; }
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

  const trimmedCode = (teamCode || '').trim().toUpperCase();
  if (trimmedCode) {
    const found = await cloud.findTeamByCode(trimmedCode, idToken);
    if (!found) throw new Error('TEAM_NOT_FOUND');
    teamId = found.teamId;
    role   = 'member';

    // Add to subcollection (includes name/email so display works without cross-user reads)
    await cloud.addTeamMember(teamId, userId, idToken, { userId, role, name, email });
    // Update members array on team doc using a field-masked PATCH (satisfies self-join rule)
    const existingMembers = Array.isArray(found.members) ? found.members : [];
    if (!existingMembers.includes(userId)) {
      await cloud.updateTeamMembersArray(teamId, idToken, [...existingMembers, userId]);
    }
  } else {
    teamId = `team_${userId}`;
    role   = 'admin';
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

  await cloud.createUserProfile(userId, idToken, { name, email, teamId, role });
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
  document.getElementById('guest-btn').addEventListener('click', continueAsGuest);
});

window.addEventListener('beforeunload', () => {
  if (rotatingTimer) clearInterval(rotatingTimer);
});
