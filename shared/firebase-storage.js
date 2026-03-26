// shared/firebase-storage.js
// Firestore-backed storage with guest/user separation.

(function () {
  const FIREBASE_API_KEY = 'AIzaSyA7dMDGoWCDXSIWBZ5Bl-NFnnXAp2zV6i4';
  const FIRESTORE_PROJECT_ID = 'task-crm-edf17';

  const INSTALLATION_ID_KEY = 'installationId';
  const GUEST_AUTH_KEY = 'guestAuth';
  const LAST_SYNC_KEY = 'cloudSyncMeta';
  const GUEST_TASKS_KEY = 'guestTasks';
  const GUEST_SETTINGS_KEY = 'guestSettings';
  const DEBUG_LOG_KEY = 'tspDebugLogs';
  const ALARM_TASK_INDEX_KEY = 'alarmTaskIndex';
  const SYNC_COOLDOWN_MS = 5000;

  let _inflightSync = null;

  function firestoreBaseUrl() {
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIRESTORE_PROJECT_ID)}/databases/(default)/documents`;
  }

  function hasFirestoreConfig() {
    return !!FIRESTORE_PROJECT_ID;
  }

  function buildDocUrl(profileKey) {
    return `${firestoreBaseUrl()}/profiles/${encodeURIComponent(profileKey)}?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  }

  function toAlarmTask(task) {
    if (!task || typeof task !== 'object') return null;
    return {
      id: task.id,
      contactName: task.contactName || '',
      description: task.description || '',
      remindAt: Number(task.remindAt) || 0,
      completed: !!task.completed,
    };
  }

  async function setAlarmTaskIndex(tasks) {
    const safe = (Array.isArray(tasks) ? tasks : [])
      .map(toAlarmTask)
      .filter((t) => t && t.id);
    await setLocal({ [ALARM_TASK_INDEX_KEY]: safe });
  }

  function randomId(prefix) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `${prefix}_${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  async function getLocal(keys) {
    return await chrome.storage.local.get(keys);
  }

  async function setLocal(obj) {
    await chrome.storage.local.set(obj);
  }

  async function appendDebugLog(event, details) {
    try {
      const data = await getLocal([DEBUG_LOG_KEY]);
      const logs = Array.isArray(data[DEBUG_LOG_KEY]) ? data[DEBUG_LOG_KEY] : [];
      logs.push({ at: new Date().toISOString(), event, details: details || {} });
      await setLocal({ [DEBUG_LOG_KEY]: logs.slice(-120) });
    } catch (_) {
      // Best effort only.
    }
  }

  async function getDebugLogs() {
    const data = await getLocal([DEBUG_LOG_KEY]);
    return Array.isArray(data[DEBUG_LOG_KEY]) ? data[DEBUG_LOG_KEY] : [];
  }

  async function clearDebugLogs() {
    await chrome.storage.local.remove(DEBUG_LOG_KEY);
  }

  async function ensureInstallationId() {
    const data = await getLocal(INSTALLATION_ID_KEY);
    if (data.installationId) return data.installationId;
    const installationId = randomId('install');
    await setLocal({ installationId });
    return installationId;
  }

  function isTokenValid(session) {
    if (!session || !session.idToken || !session.expiresAt) return false;
    return Date.now() < session.expiresAt - 30000;
  }

  async function refreshToken(refreshToken) {
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
    if (!res.ok) throw new Error('TOKEN_REFRESH_FAILED');
    const json = await res.json();
    return {
      idToken: json.id_token,
      refreshToken: json.refresh_token,
      localId: json.user_id,
      expiresAt: Date.now() + (parseInt(json.expires_in, 10) * 1000),
    };
  }

  async function getAuthState() {
    const data = await getLocal(['auth']);
    return data.auth || null;
  }

  async function ensureUserSession(auth) {
    if (isTokenValid(auth)) return auth;
    if (!auth || !auth.refreshToken) return null;
    try {
      const refreshed = await refreshToken(auth.refreshToken);
      const merged = { ...auth, ...refreshed };
      await setLocal({ auth: merged });
      return merged;
    } catch (_) {
      await chrome.storage.local.remove('auth');
      return null;
    }
  }

  async function resolveIdentity() {
    const installationId = await ensureInstallationId();
    const auth = await ensureUserSession(await getAuthState());

    if (auth && auth.idToken && auth.localId) {
      await appendDebugLog('resolveIdentity.user', { uid: auth.localId });
      return {
        profileKey: String(auth.localId),
        legacyProfileKey: `user_${auth.localId}`,
        authUid: auth.localId,
        mode: 'user',
        idToken: auth.idToken,
        installationId,
      };
    }

    await appendDebugLog('resolveIdentity.guest', { installationId });
    return {
      profileKey: `guest_${installationId}`,
      authUid: null,
      mode: 'guest',
      idToken: null,
      installationId,
    };
  }

  function hasRemoteData(remote) {
    if (!remote || typeof remote !== 'object') return false;
    return Array.isArray(remote.tasks) || !!remote.settings;
  }

  function toFirestoreValue(value) {
    if (value === null || value === undefined) return { nullValue: null };
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(toFirestoreValue) } };
    }
    if (typeof value === 'object') {
      const fields = {};
      Object.keys(value).forEach((k) => { fields[k] = toFirestoreValue(value[k]); });
      return { mapValue: { fields } };
    }
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return { integerValue: String(value) };
      return { doubleValue: value };
    }
    return { stringValue: String(value) };
  }

  function fromFirestoreValue(node) {
    if (!node || typeof node !== 'object') return null;
    if ('nullValue' in node) return null;
    if ('stringValue' in node) return node.stringValue;
    if ('booleanValue' in node) return !!node.booleanValue;
    if ('integerValue' in node) return parseInt(node.integerValue, 10);
    if ('doubleValue' in node) return Number(node.doubleValue);
    if ('arrayValue' in node) {
      const values = node.arrayValue && Array.isArray(node.arrayValue.values) ? node.arrayValue.values : [];
      return values.map(fromFirestoreValue);
    }
    if ('mapValue' in node) {
      const out = {};
      const fields = (node.mapValue && node.mapValue.fields) || {};
      Object.keys(fields).forEach((k) => { out[k] = fromFirestoreValue(fields[k]); });
      return out;
    }
    return null;
  }

  function decodeFirestoreDocument(doc) {
    if (!doc || !doc.fields) return null;
    const out = {};
    Object.keys(doc.fields).forEach((k) => {
      out[k] = fromFirestoreValue(doc.fields[k]);
    });
    return out;
  }

  async function readRemoteProfileByKey(identity, profileKey) {
    if (!hasFirestoreConfig()) return null;
    await appendDebugLog('firestore.read.start', {
      projectId: FIRESTORE_PROJECT_ID,
      profileKey,
    });
    const res = await fetch(buildDocUrl(profileKey), {
      headers: { Authorization: `Bearer ${identity.idToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await appendDebugLog('firestore.read.error', {
        status: res.status,
        profileKey,
        detail: detail.slice(0, 800),
      });
      throw new Error('REMOTE_READ_FAILED');
    }
    const doc = await res.json();
    await appendDebugLog('firestore.read.ok', {
      profileKey,
      hasFields: !!doc.fields,
    });
    return decodeFirestoreDocument(doc);
  }

  async function readRemoteProfile(identity) {
    const primary = await readRemoteProfileByKey(identity, identity.profileKey);
    if (primary) return primary;

    if (identity.mode === 'user' && identity.legacyProfileKey) {
      const legacy = await readRemoteProfileByKey(identity, identity.legacyProfileKey);
      if (legacy) {
        await appendDebugLog('firestore.read.legacy_hit', {
          profileKey: identity.legacyProfileKey,
          migratedTarget: identity.profileKey,
        });
        return legacy;
      }
    }
    return null;
  }

  async function writeRemoteFields(identity, patch) {
    if (!hasFirestoreConfig()) return;
    const merged = {
      ...patch,
      meta: {
        mode: identity.mode,
        authUid: identity.authUid,
        installationId: identity.installationId,
        updatedAt: Date.now(),
      },
    };

    const fields = {};
    Object.keys(merged).forEach((k) => { fields[k] = toFirestoreValue(merged[k]); });
    await appendDebugLog('firestore.write.start', {
      projectId: FIRESTORE_PROJECT_ID,
      profileKey: identity.profileKey,
      keys: Object.keys(patch || {}),
    });

    const res = await fetch(buildDocUrl(identity.profileKey), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${identity.idToken}`,
      },
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await appendDebugLog('firestore.write.error', {
        status: res.status,
        profileKey: identity.profileKey,
        detail: detail.slice(0, 1200),
      });
      throw new Error('REMOTE_WRITE_FAILED');
    }

    await appendDebugLog('firestore.write.ok', {
      profileKey: identity.profileKey,
      keys: Object.keys(patch || {}),
    });
  }

  async function deleteRemoteProfile(identity) {
    return await deleteRemoteProfileByKey(identity, identity.profileKey);
  }

  async function deleteRemoteProfileByKey(identity, profileKey) {
    if (!hasFirestoreConfig()) return;
    const res = await fetch(buildDocUrl(profileKey), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${identity.idToken}` },
    });
    if (res.status === 404) return;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await appendDebugLog('firestore.delete.error', {
        status: res.status,
        profileKey,
        detail: detail.slice(0, 1000),
      });
      throw new Error('REMOTE_DELETE_FAILED');
    }
    await appendDebugLog('firestore.delete.ok', { profileKey });
  }

  async function setActiveLocalData(data) {
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    await setLocal({
      tasks,
      settings: data.settings || null,
    });
    await setAlarmTaskIndex(tasks);
  }

  async function clearActiveLocalData() {
    await chrome.storage.local.remove(['tasks', 'settings', ALARM_TASK_INDEX_KEY]);
  }

  async function getGuestLocalData() {
    const data = await getLocal([GUEST_TASKS_KEY, GUEST_SETTINGS_KEY]);
    return {
      tasks: Array.isArray(data[GUEST_TASKS_KEY]) ? data[GUEST_TASKS_KEY] : [],
      settings: data[GUEST_SETTINGS_KEY] || null,
    };
  }

  async function setGuestLocalData(data) {
    await setLocal({
      [GUEST_TASKS_KEY]: Array.isArray(data.tasks) ? data.tasks : [],
      [GUEST_SETTINGS_KEY]: data.settings || null,
    });
  }

  async function clearGuestLocalData() {
    await chrome.storage.local.remove([GUEST_TASKS_KEY, GUEST_SETTINGS_KEY]);
  }

  async function markSync(profileKey) {
    await setLocal({ [LAST_SYNC_KEY]: { profileKey, at: Date.now() } });
  }

  async function shouldSync(profileKey, force) {
    if (force) return true;
    const data = await getLocal([LAST_SYNC_KEY]);
    const meta = data[LAST_SYNC_KEY];
    if (!meta || meta.profileKey !== profileKey) return true;
    return (Date.now() - meta.at) > SYNC_COOLDOWN_MS;
  }

  function mergeTasks(remoteTasks, guestTasks) {
    const map = new Map();
    (Array.isArray(remoteTasks) ? remoteTasks : []).forEach((t) => map.set(t.id, t));
    (Array.isArray(guestTasks) ? guestTasks : []).forEach((t) => {
      if (!map.has(t.id)) map.set(t.id, t);
    });
    return Array.from(map.values());
  }

  async function syncGuestMode(force) {
    const identity = await resolveIdentity();
    if (identity.mode !== 'guest') return;
    if (!(await shouldSync(identity.profileKey, force))) return;
    const guestLocal = await getGuestLocalData();
    await setActiveLocalData(guestLocal);

    await markSync(identity.profileKey);
  }

  async function syncUserMode(force) {
    const identity = await resolveIdentity();
    if (identity.mode !== 'user') return;
    if (!(await shouldSync(identity.profileKey, force))) return;
    if (identity.legacyProfileKey) {
      const current = await readRemoteProfileByKey(identity, identity.profileKey).catch(() => null);
      if (!hasRemoteData(current)) {
        const legacy = await readRemoteProfileByKey(identity, identity.legacyProfileKey).catch(() => null);
        if (hasRemoteData(legacy)) {
          await writeRemoteFields(identity, {
            tasks: Array.isArray(legacy.tasks) ? legacy.tasks : [],
            settings: legacy.settings || null,
          });
          await deleteRemoteProfileByKey(identity, identity.legacyProfileKey).catch(() => null);
          await appendDebugLog('firestore.migrate.legacy_to_uid.ok', {
            from: identity.legacyProfileKey,
            to: identity.profileKey,
          });
        }
      }
    }
    await markSync(identity.profileKey);
  }

  async function syncFromCloud(force) {
    if (_inflightSync) return _inflightSync;

    _inflightSync = (async () => {
      const identity = await resolveIdentity();
      if (identity.mode === 'guest') await syncGuestMode(force);
      else await syncUserMode(force);
    })().catch(() => {
      // Fall back silently.
    }).finally(() => {
      _inflightSync = null;
    });

    return _inflightSync;
  }

  async function setTasks(tasks) {
    const safeTasks = Array.isArray(tasks) ? tasks : [];
    await setAlarmTaskIndex(safeTasks);
    const identity = await resolveIdentity();

    if (identity.mode === 'guest') {
      await setActiveLocalData({ tasks: safeTasks, settings: (await getLocal(['settings'])).settings || null });
      await setGuestLocalData({ ...(await getGuestLocalData()), tasks: safeTasks });
      await markSync(identity.profileKey);
      return;
    }

    if (!hasFirestoreConfig()) {
      await setActiveLocalData({ tasks: safeTasks, settings: (await getLocal(['settings'])).settings || null });
      return;
    }

    try {
      await writeRemoteFields(identity, { tasks: safeTasks });
      await markSync(identity.profileKey);
      // Logged-in data should not remain in local persistent cache.
      await chrome.storage.local.remove('tasks');
    } catch (err) {
      await appendDebugLog('setTasks.user.remoteSync.failed', {
        message: err && err.message ? err.message : String(err),
      });
      // Fallback cache only if remote write failed.
      await setActiveLocalData({ tasks: safeTasks, settings: (await getLocal(['settings'])).settings || null });
    }
  }

  async function setSettings(settings) {
    const safeSettings = settings || null;
    const identity = await resolveIdentity();

    if (identity.mode === 'guest') {
      await setActiveLocalData({ tasks: (await getLocal(['tasks'])).tasks || [], settings: safeSettings });
      await setGuestLocalData({ ...(await getGuestLocalData()), settings: safeSettings });
      await markSync(identity.profileKey);
      return;
    }

    if (!hasFirestoreConfig()) {
      await setActiveLocalData({ tasks: (await getLocal(['tasks'])).tasks || [], settings: safeSettings });
      return;
    }

    try {
      await writeRemoteFields(identity, { settings: safeSettings });
      await markSync(identity.profileKey);
      await chrome.storage.local.remove('settings');
    } catch (err) {
      await appendDebugLog('setSettings.user.remoteSync.failed', {
        message: err && err.message ? err.message : String(err),
      });
      await setActiveLocalData({ tasks: (await getLocal(['tasks'])).tasks || [], settings: safeSettings });
    }
  }

  async function getTasks() {
    const identity = await resolveIdentity();
    if (identity.mode === 'user' && hasFirestoreConfig()) {
      const remote = await readRemoteProfile(identity).catch(() => null);
      if (hasRemoteData(remote)) return Array.isArray(remote.tasks) ? remote.tasks : [];
      return [];
    }
    const data = await getLocal(['tasks']);
    return Array.isArray(data.tasks) ? data.tasks : [];
  }

  async function getSettings() {
    const identity = await resolveIdentity();
    if (identity.mode === 'user' && hasFirestoreConfig()) {
      const remote = await readRemoteProfile(identity).catch(() => null);
      if (remote && typeof remote === 'object') return remote.settings || null;
      return null;
    }
    const data = await getLocal(['settings']);
    return data.settings || null;
  }

  async function postSignIn(options) {
    const opts = options || {};
    const mergeGuestData = opts.mergeGuestData;

    const identity = await resolveIdentity();
    if (identity.mode !== 'user') return { ok: false, reason: 'NO_USER_IDENTITY' };

    const [remote, guestLocal] = await Promise.all([
      hasFirestoreConfig() ? readRemoteProfile(identity).catch(() => null) : null,
      getGuestLocalData(),
    ]);

    const remoteData = {
      tasks: Array.isArray(remote?.tasks) ? remote.tasks : [],
      settings: remote?.settings || null,
    };
    const guestHasData = guestLocal.tasks.length > 0 || !!guestLocal.settings;

    if (guestHasData && mergeGuestData !== true && mergeGuestData !== false) {
      return {
        ok: true,
        hasRemoteData: hasRemoteData(remote),
        needsMergeChoice: true,
        guestTaskCount: guestLocal.tasks.length,
      };
    }

    if (guestHasData && mergeGuestData === true) {
      const merged = {
        tasks: mergeTasks(remoteData.tasks, guestLocal.tasks),
        settings: remoteData.settings || guestLocal.settings || null,
      };
      if (hasFirestoreConfig()) {
        try {
          await writeRemoteFields(identity, merged);
        } catch (_) {
          return { ok: false, reason: 'REMOTE_WRITE_FAILED', hasRemoteData: hasRemoteData(remote) };
        }
      }
      await clearGuestLocalData();
      await clearActiveLocalData();
      await setAlarmTaskIndex(merged.tasks);
      await markSync(identity.profileKey);
      return { ok: true, hasRemoteData: hasRemoteData(remote), mergedGuest: true };
    }

    await clearActiveLocalData();
    await setAlarmTaskIndex(remoteData.tasks);
    await markSync(identity.profileKey);
    return { ok: true, hasRemoteData: hasRemoteData(remote), mergedGuest: false };
  }

  async function postSignOut() {
    try {
      await syncGuestMode(true);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function init() {
    try {
      await ensureInstallationId();
      await syncFromCloud(false);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function forceResync() {
    try {
      await syncFromCloud(true);
      return true;
    } catch (_) {
      return false;
    }
  }

  window.TaskSaverCloud = {
    init,
    forceResync,
    getTasks,
    setTasks,
    getSettings,
    setSettings,
    postSignIn,
    postSignOut,
    getDebugLogs,
    clearDebugLogs,
  };
})();
