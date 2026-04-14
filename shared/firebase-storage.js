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
    const contactName = task.contactName || (task.contact && task.contact.name) || '';
    return {
      id: task.id,
      contactName,
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

  function normalizeTaskType(type, platform) {
    const valid = new Set(['linkedin', 'email', 'call', 'meeting']);
    const rawType = String(type || '').trim().toLowerCase();
    if (valid.has(rawType)) return rawType;

    const p = String(platform || '').trim().toLowerCase();
    if (p === 'linkedin') return 'linkedin';
    if (p === 'gmail' || p === 'outlook' || p === 'email') return 'email';
    if (p === 'whatsapp') return 'meeting';
    return 'linkedin';
  }

  function normalizePriority(priority) {
    const p = String(priority || '').trim().toLowerCase();
    if (p === 'low' || p === 'medium' || p === 'high') return p;
    return 'medium';
  }

  function normalizeStatus(status, completed) {
    const s = String(status || '').trim().toLowerCase();
    if (s === 'pending' || s === 'in_progress' || s === 'done') return s;
    return completed ? 'done' : 'pending';
  }

  function toEpochMs(value, fallbackMs) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : fallbackMs;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return fallbackMs;
  }

  function toTaskDocForWrite(taskDoc, identity) {
    const out = { ...taskDoc };
    out.remindAt = new Date(toEpochMs(taskDoc.remindAt, Date.now()));
    out.createdAt = new Date(toEpochMs(taskDoc.createdAt, Date.now()));
    out.updatedAt = new Date(toEpochMs(taskDoc.updatedAt, Date.now()));
    if (!out.createdBy && identity && identity.authUid) {
      out.createdBy = `users/${identity.authUid}`;
    }
    return out;
  }

  function normalizeTaskDocument(task) {
    const src = (task && typeof task === 'object') ? task : {};
    const srcContact = (src.contact && typeof src.contact === 'object') ? src.contact : {};

    const firstName = String(srcContact.firstName || src.firstName || '').trim();
    const lastName = String(srcContact.lastName || src.lastName || '').trim();
    const fallbackName = `${firstName} ${lastName}`.trim();
    const contactName = String(srcContact.name || src.contactName || fallbackName || '').trim();
    const completed = !!src.completed;
    const remindAt = toEpochMs(src.remindAt, Date.now());
    const createdAt = toEpochMs(src.createdAt, Date.now());
    const updatedAt = toEpochMs(src.updatedAt, Date.now());

    const rawTags = Array.isArray(src.tags) ? src.tags : [];
    const tags = rawTags
      .map((t) => String(t || '').trim())
      .filter(Boolean);

    return {
      id: String(src.id || randomId('task')),
      type: normalizeTaskType(src.type, src.platform),
      platform: String(src.platform || '').trim().toLowerCase() || 'linkedin',
      contact: {
        name: contactName,
        firstName,
        lastName,
        profileUrl: String(srcContact.profileUrl || src.profileUrl || '').trim(),
        email: String(srcContact.email || src.email || '').trim(),
        title: String(srcContact.title || src.title || '').trim(),
      },
      stage: String(src.stage || 'lead').trim() || 'lead',
      status: normalizeStatus(src.status, completed),
      description: String(src.description || '').trim(),
      completed,
      ownerId: String(src.ownerId || src.owner || '').trim(),
      assignedTo: String(src.assignedTo || '').trim(),
      followUpDays: Number(src.followUpDays ?? src.followupDays) || 0,
      remindAt,
      createdAt,
      updatedAt,
      threadUrl: String(src.threadUrl || '').trim(),
      priority: normalizePriority(src.priority),
      tags,
      createdBy: String(src.createdBy || '').trim(),
    };
  }

  function toLegacyTaskView(task) {
    const normalized = normalizeTaskDocument(task);
    const contact = normalized.contact || {};
    return {
      ...normalized,
      contactName: contact.name || '',
      firstName: contact.firstName || '',
      lastName: contact.lastName || '',
      profileUrl: contact.profileUrl || '',
      email: contact.email || '',
      title: contact.title || '',
      owner: normalized.ownerId || '',
      followupDays: normalized.followUpDays || 0,
    };
  }

  async function resolveTaskScope(identity) {
    if (!identity || identity.mode !== 'user' || !hasFirestoreConfig() || !identity.idToken || !identity.authUid) {
      return null;
    }
    const teamId = await resolveTeamId(identity);
    if (teamId) {
      return {
        kind: 'team',
        path: `teams/${teamId}/tasks`,
      };
    }
    return {
      kind: 'user',
      path: `users/${identity.authUid}/tasks`,
    };
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
    if (value instanceof Date) return { timestampValue: value.toISOString() };
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
    // Return timestamps as epoch ms so all date-comparison code works unchanged
    if ('timestampValue' in node) return new Date(node.timestampValue).getTime();
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
        updatedAt: new Date(),
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
    const safeTasks = (Array.isArray(tasks) ? tasks : []).map(toLegacyTaskView);
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
      const scope = await resolveTaskScope(identity);
      if (!scope) {
        await setActiveLocalData({ tasks: safeTasks, settings: (await getLocal(['settings'])).settings || null });
        return;
      }

      const desiredDocs = safeTasks.map((t) => toTaskDocForWrite(normalizeTaskDocument(t), identity));
      const desiredById = new Map(desiredDocs.map((t) => [t.id, t]));
      const remoteDocs = await getTaskDocs(scope.path, identity.idToken).catch(() => []);

      for (const taskDoc of desiredDocs) {
        await addTaskDoc(scope.path, identity.idToken, taskDoc);
      }

      for (const remoteTask of remoteDocs) {
        if (!desiredById.has(remoteTask.id)) {
          await deleteTaskDoc(scope.path, identity.idToken, remoteTask.id);
        }
      }

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
      const teamId = await resolveTeamId(identity);
      if (teamId) {
        await saveTeamSettings(teamId, identity, safeSettings || {});
      } else {
        await writeRemoteFields(identity, { settings: safeSettings });
      }
      await markSync(identity.profileKey);
      await chrome.storage.local.remove('settings');
    } catch (err) {
      await appendDebugLog('setSettings.user.remoteSync.failed', {
        message: err && err.message ? err.message : String(err),
      });
      await setActiveLocalData({ tasks: (await getLocal(['tasks'])).tasks || [], settings: safeSettings });
    }
  }

  // ===== Team Task CRUD =====

  // In-memory cache so we don't re-fetch users/{uid} on every call
  let _teamIdCache = null;

  async function resolveTeamId(identity) {
    if (!identity.authUid) return null;
    if (_teamIdCache && _teamIdCache.uid === identity.authUid) return _teamIdCache.teamId;
    try {
      const userProfile = await readDocAtPath(`users/${identity.authUid}`, identity.idToken);
      const teamId = (userProfile && userProfile.teamId) || null;
      _teamIdCache = { uid: identity.authUid, teamId };
      return teamId;
    } catch (_) {
      return null;
    }
  }

  function slugifyLabel(label, fallback) {
    const slug = String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return slug || fallback;
  }

  function normalizeDocId(raw, fallback) {
    const cleaned = String(raw || '').trim().replace(/\//g, '_');
    return cleaned || fallback;
  }

  function colorToBg(color, alpha) {
    const hex = String(color || '').trim().replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return `rgba(69,115,210,${alpha || 0.14})`;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha || 0.14})`;
  }

  async function readTeamSettings(teamId, identity) {
    const [ownerDocs, stageDocs] = await Promise.all([
      listCollectionAtPath(`teams/${teamId}/owners`, identity.idToken).catch(() => []),
      listCollectionAtPath(`teams/${teamId}/stages`, identity.idToken).catch(() => []),
    ]);

    const owners = ownerDocs
      .slice()
      .sort((a, b) => {
        const ao = Number(a.order) || 0;
        const bo = Number(b.order) || 0;
        if (ao !== bo) return ao - bo;
        return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
      })
      .map((doc) => {
        const id = normalizeDocId(doc.ownerId || doc.id, randomId('owner'));
        const color = String(doc.color || '#4573d2');
        return {
          id,
          label: String(doc.name || id),
          color,
          bg: colorToBg(color, 0.14),
        };
      });

    const stages = stageDocs
      .slice()
      .sort((a, b) => {
        const ao = Number(a.order) || 0;
        const bo = Number(b.order) || 0;
        if (ao !== bo) return ao - bo;
        return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
      })
      .map((doc) => {
        const value = normalizeDocId(doc.id || slugifyLabel(doc.title, 'stage'), randomId('stage'));
        const color = String(doc.color || '#6366f1');
        return {
          value,
          label: String(doc.title || value),
          color,
          bg: colorToBg(color, 0.12),
        };
      });

    return { owners, stages };
  }

  async function saveTeamSettings(teamId, identity, settings) {
    const incomingOwners = Array.isArray(settings.owners) ? settings.owners : [];
    const incomingStages = Array.isArray(settings.stages) ? settings.stages : [];

    const [existingOwners, existingStages] = await Promise.all([
      listCollectionAtPath(`teams/${teamId}/owners`, identity.idToken).catch(() => []),
      listCollectionAtPath(`teams/${teamId}/stages`, identity.idToken).catch(() => []),
    ]);

    const existingOwnerMap = new Map(existingOwners.map((o) => [o.id, o]));
    const existingStageMap = new Map(existingStages.map((s) => [s.id, s]));
    const keepOwnerIds = new Set();
    const keepStageIds = new Set();

    for (let i = 0; i < incomingOwners.length; i += 1) {
      const owner = incomingOwners[i] || {};
      const ownerId = normalizeDocId(owner.id, slugifyLabel(owner.label, `owner_${i + 1}`));
      keepOwnerIds.add(ownerId);
      const prev = existingOwnerMap.get(ownerId);
      const createdAt = prev && prev.createdAt ? new Date(prev.createdAt) : new Date();
      await writeDocAtPath(`teams/${teamId}/owners/${ownerId}`, identity.idToken, {
        ownerId,
        name: String(owner.label || owner.name || ownerId),
        color: String(owner.color || '#4573d2'),
        createdAt,
        createdBy: `users/${identity.authUid}`,
        order: i,
      });
    }

    for (let i = 0; i < incomingStages.length; i += 1) {
      const stage = incomingStages[i] || {};
      const stageId = normalizeDocId(stage.value, slugifyLabel(stage.label, `stage_${i + 1}`));
      keepStageIds.add(stageId);
      const prev = existingStageMap.get(stageId);
      const createdAt = prev && prev.createdAt ? new Date(prev.createdAt) : new Date();
      await writeDocAtPath(`teams/${teamId}/stages/${stageId}`, identity.idToken, {
        title: String(stage.label || stage.title || stageId),
        color: String(stage.color || '#6366f1'),
        createdAt,
        createdBy: `users/${identity.authUid}`,
        order: i,
      });
    }

    for (const doc of existingOwners) {
      if (!keepOwnerIds.has(doc.id)) {
        await deleteDocAtPath(`teams/${teamId}/owners/${doc.id}`, identity.idToken);
      }
    }
    for (const doc of existingStages) {
      if (!keepStageIds.has(doc.id)) {
        await deleteDocAtPath(`teams/${teamId}/stages/${doc.id}`, identity.idToken);
      }
    }
  }

  async function addTaskDoc(collectionPath, idToken, task) {
    await writeDocAtPath(`${collectionPath}/${task.id}`, idToken, task);
  }

  function normalizeLookup(value) {
    return String(value || '').trim().toLowerCase();
  }

  async function ensureTeamContact(contact) {
    const identity = await resolveIdentity();
    if (identity.mode !== 'user' || !hasFirestoreConfig()) return null;

    const teamId = await resolveTeamId(identity);
    if (!teamId) return null;

    const safe = (contact && typeof contact === 'object') ? contact : {};
    const firstName = String(safe.firstName || '').trim();
    const lastName = String(safe.lastName || '').trim();
    const name = String(safe.name || `${firstName} ${lastName}`.trim()).trim();
    const linkedinUrl = String(safe.linkedinUrl || '').trim();
    const email = String(safe.email || '').trim().toLowerCase();
    const phone = String(safe.phone || '').trim();
    const company = String(safe.company || '').trim();
    const designation = String(safe.designation || '').trim();

    const existing = await listCollectionAtPath(`teams/${teamId}/contacts`, identity.idToken).catch(() => []);
    const linkedinKey = normalizeLookup(linkedinUrl);
    const emailKey = normalizeLookup(email);

    // Use only strong identifiers for dedupe. Name-only matching can overwrite
    // unrelated contacts that happen to share or resemble a name.
    const matched = existing.find((doc) => {
      const dLinkedin = normalizeLookup(doc.linkedinUrl);
      const dEmail = normalizeLookup(doc.email);
      if (linkedinKey && dLinkedin && linkedinKey === dLinkedin) return true;
      if (emailKey && dEmail && emailKey === dEmail) return true;
      return false;
    });

    const contactId = matched ? matched.id : randomId('contact');
    await writeDocAtPath(`teams/${teamId}/contacts/${contactId}`, identity.idToken, {
      name,
      firstName,
      lastName,
      linkedinUrl,
      email,
      phone,
      company,
      designation,
      createdAt: matched && matched.createdAt ? new Date(matched.createdAt) : new Date(),
      addedBy: identity.authUid,
    });

    return { id: contactId, teamId };
  }

  async function searchTeamContacts(query, limit) {
    const identity = await resolveIdentity();
    if (identity.mode !== 'user' || !hasFirestoreConfig()) return [];

    const teamId = await resolveTeamId(identity);
    if (!teamId) return [];

    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const max = Math.max(1, Math.min(Number(limit) || 8, 25));
    const all = await listCollectionAtPath(`teams/${teamId}/contacts`, identity.idToken).catch(() => []);

    const score = (c) => {
      const fn = String(c.firstName || '').toLowerCase();
      const ln = String(c.lastName || '').toLowerCase();
      const nm = String(c.name || '').toLowerCase();
      if (fn.startsWith(needle) || ln.startsWith(needle)) return 0;
      if (nm.startsWith(needle)) return 1;
      if (fn.includes(needle) || ln.includes(needle)) return 2;
      if (nm.includes(needle)) return 3;
      return 99;
    };

    return all
      .map((c) => ({ ...c, _score: score(c) }))
      .filter((c) => c._score < 99)
      .sort((a, b) => {
        if (a._score !== b._score) return a._score - b._score;
        return String(a.name || '').localeCompare(String(b.name || ''));
      })
      .slice(0, max)
      .map((c) => ({
        id: c.id,
        name: String(c.name || ''),
        firstName: String(c.firstName || ''),
        lastName: String(c.lastName || ''),
        linkedinUrl: String(c.linkedinUrl || ''),
        email: String(c.email || ''),
        phone: String(c.phone || ''),
        company: String(c.company || ''),
        designation: String(c.designation || ''),
      }));
  }

  async function listTeamContacts(limit) {
    const identity = await resolveIdentity();
    if (identity.mode !== 'user' || !hasFirestoreConfig()) return [];

    const teamId = await resolveTeamId(identity);
    if (!teamId) return [];

    const max = Math.max(1, Math.min(Number(limit) || 500, 1000));
    const all = await listCollectionAtPath(`teams/${teamId}/contacts`, identity.idToken).catch(() => []);

    return all
      .sort((a, b) => {
        const aTs = Number(a.updatedAt || a.createdAt || 0);
        const bTs = Number(b.updatedAt || b.createdAt || 0);
        return bTs - aTs;
      })
      .slice(0, max)
      .map((c) => ({
        id: c.id,
        name: String(c.name || ''),
        firstName: String(c.firstName || ''),
        lastName: String(c.lastName || ''),
        linkedinUrl: String(c.linkedinUrl || ''),
        email: String(c.email || ''),
        phone: String(c.phone || ''),
        company: String(c.company || ''),
        designation: String(c.designation || ''),
        createdAt: Number(c.createdAt || 0),
        updatedAt: Number(c.updatedAt || 0),
      }));
  }

  async function updateTeamContact(contactId, fields) {
    const identity = await resolveIdentity();
    if (identity.mode !== 'user' || !hasFirestoreConfig()) return null;

    const teamId = await resolveTeamId(identity);
    if (!teamId || !contactId) return null;

    const path = `teams/${teamId}/contacts/${contactId}`;
    const existing = await readDocAtPath(path, identity.idToken);
    if (!existing) throw new Error('CONTACT_NOT_FOUND');

    const incoming = (fields && typeof fields === 'object') ? fields : {};
    const safe = {
      name: String(incoming.name ?? existing.name ?? '').trim(),
      firstName: String(incoming.firstName ?? existing.firstName ?? '').trim(),
      lastName: String(incoming.lastName ?? existing.lastName ?? '').trim(),
      linkedinUrl: String(incoming.linkedinUrl ?? existing.linkedinUrl ?? '').trim(),
      email: String(incoming.email ?? existing.email ?? '').trim().toLowerCase(),
      phone: String(incoming.phone ?? existing.phone ?? '').trim(),
      company: String(incoming.company ?? existing.company ?? '').trim(),
      designation: String(incoming.designation ?? existing.designation ?? '').trim(),
      createdAt: existing.createdAt ? new Date(existing.createdAt) : new Date(),
      updatedAt: new Date(),
      addedBy: existing.addedBy || identity.authUid,
    };

    await writeDocAtPath(path, identity.idToken, safe);
    return { id: String(contactId), teamId };
  }

  async function getTaskDocs(collectionPath, idToken) {
    const docs = await listCollectionAtPath(collectionPath, idToken);
    return docs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async function updateTaskFields(collectionPath, idToken, taskId, fields) {
    const maskParams = Object.keys(fields)
      .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join('&');
    const url = `${firestoreBaseUrl()}/${collectionPath}/${encodeURIComponent(taskId)}?${maskParams}&key=${encodeURIComponent(FIREBASE_API_KEY)}`;
    const docFields = {};
    Object.keys(fields).forEach((k) => { docFields[k] = toFirestoreValue(fields[k]); });
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ fields: docFields }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`TASK_PATCH_FAILED:${taskId}: ${detail.slice(0, 400)}`);
    }
  }

  async function deleteTaskDoc(collectionPath, idToken, taskId) {
    const url = `${firestoreBaseUrl()}/${collectionPath}/${encodeURIComponent(taskId)}?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`TASK_DELETE_FAILED:${taskId}`);
  }

  // ===== High-level task methods (route to team collection or local array) =====

  async function saveTask(task) {
    const taskDoc = normalizeTaskDocument(task);
    const taskView = toLegacyTaskView(taskDoc);
    const identity = await resolveIdentity();

    // Update alarm index (add/replace this task)
    const existing = (await getLocal([ALARM_TASK_INDEX_KEY]))[ALARM_TASK_INDEX_KEY] || [];
    const newIndex = existing.filter((t) => t.id !== taskDoc.id);
    newIndex.push(toAlarmTask(taskDoc));
    await setLocal({ [ALARM_TASK_INDEX_KEY]: newIndex });

    if (identity.mode === 'user' && hasFirestoreConfig()) {
      const scope = await resolveTaskScope(identity);
      if (scope) {
        await addTaskDoc(scope.path, identity.idToken, toTaskDocForWrite(taskDoc, identity));
        await markSync(identity.profileKey);
        return;
      }
    }

    // Guest mode: update local array
    const local = await getLocal(['tasks']);
    const localTasks = Array.isArray(local.tasks) ? local.tasks : [];
    const updatedLocal = [...localTasks.filter((t) => t.id !== taskDoc.id), taskView];
    await setActiveLocalData({ tasks: updatedLocal, settings: (await getLocal(['settings'])).settings || null });
    await setGuestLocalData({ ...(await getGuestLocalData()), tasks: updatedLocal });
  }

  async function patchTask(taskId, fields) {
    const identity = await resolveIdentity();
    const safeFields = { ...(fields || {}) };
    if ('owner' in safeFields && !('ownerId' in safeFields)) {
      safeFields.ownerId = safeFields.owner;
      delete safeFields.owner;
    }
    if ('followupDays' in safeFields && !('followUpDays' in safeFields)) {
      safeFields.followUpDays = safeFields.followupDays;
      delete safeFields.followupDays;
    }
    if ('contactName' in safeFields) {
      const patchContact = (safeFields.contact && typeof safeFields.contact === 'object') ? safeFields.contact : {};
      safeFields.contact = { ...patchContact, name: String(safeFields.contactName || '') };
      delete safeFields.contactName;
    }
    if ('priority' in safeFields) safeFields.priority = normalizePriority(safeFields.priority);
    if ('status' in safeFields || 'completed' in safeFields) {
      safeFields.status = normalizeStatus(safeFields.status, safeFields.completed);
    }
    if ('remindAt' in safeFields) {
      safeFields.remindAt = new Date(toEpochMs(safeFields.remindAt, Date.now()));
    }
    if ('createdAt' in safeFields) {
      safeFields.createdAt = new Date(toEpochMs(safeFields.createdAt, Date.now()));
    }
    if ('updatedAt' in safeFields) {
      safeFields.updatedAt = new Date(toEpochMs(safeFields.updatedAt, Date.now()));
    }
    if ('createdBy' in safeFields) {
      if (typeof safeFields.createdBy === 'object' && safeFields.createdBy && safeFields.createdBy.uid) {
        safeFields.createdBy = `users/${safeFields.createdBy.uid}`;
      } else {
        safeFields.createdBy = String(safeFields.createdBy || '').trim();
      }
    }
    if (!('createdBy' in safeFields) && identity && identity.authUid) {
      safeFields.createdBy = `users/${identity.authUid}`;
    }

    if (identity.mode === 'user' && hasFirestoreConfig()) {
      const scope = await resolveTaskScope(identity);
      if (scope) {
        await updateTaskFields(scope.path, identity.idToken, taskId, safeFields);
        // Keep alarm index in sync
        const existing = (await getLocal([ALARM_TASK_INDEX_KEY]))[ALARM_TASK_INDEX_KEY] || [];
        const updated = existing.map((t) => {
          if (t.id !== taskId) return t;
          return {
            ...t,
            description: ('description' in safeFields) ? String(safeFields.description || '') : t.description,
            remindAt: ('remindAt' in safeFields) ? Number(safeFields.remindAt) || 0 : t.remindAt,
            completed: ('completed' in safeFields) ? !!safeFields.completed : t.completed,
            contactName: (
              safeFields.contact && typeof safeFields.contact === 'object' && safeFields.contact.name
            ) ? String(safeFields.contact.name) : t.contactName,
          };
        });
        await setLocal({ [ALARM_TASK_INDEX_KEY]: updated });
        return;
      }
    }

    // Fallback: read-modify-write
    const tasks = await getTasks();
    await setTasks(tasks.map((t) => t.id === taskId ? { ...t, ...safeFields } : t));
  }

  async function removeTask(taskId) {
    const identity = await resolveIdentity();

    if (identity.mode === 'user' && hasFirestoreConfig()) {
      const scope = await resolveTaskScope(identity);
      if (scope) {
        await deleteTaskDoc(scope.path, identity.idToken, taskId);
        const existing = (await getLocal([ALARM_TASK_INDEX_KEY]))[ALARM_TASK_INDEX_KEY] || [];
        await setLocal({ [ALARM_TASK_INDEX_KEY]: existing.filter((t) => t.id !== taskId) });
        return;
      }
    }

    // Fallback: read-modify-write
    const tasks = await getTasks();
    await setTasks(tasks.filter((t) => t.id !== taskId));
  }

  async function getTasks() {
    const identity = await resolveIdentity();
    if (identity.mode === 'user' && hasFirestoreConfig()) {
      const scope = await resolveTaskScope(identity);
      if (scope) {
        const docs = await getTaskDocs(scope.path, identity.idToken).catch(() => []);
        return docs.map(toLegacyTaskView);
      }
      // Fallback: profile array
      const remote = await readRemoteProfile(identity).catch(() => null);
      if (hasRemoteData(remote)) {
        const legacy = Array.isArray(remote.tasks) ? remote.tasks : [];
        return legacy.map(toLegacyTaskView);
      }
      return [];
    }
    const data = await getLocal(['tasks']);
    return (Array.isArray(data.tasks) ? data.tasks : []).map(toLegacyTaskView);
  }

  async function getSettings() {
    const identity = await resolveIdentity();
    if (identity.mode === 'user' && hasFirestoreConfig()) {
      const teamId = await resolveTeamId(identity);
      if (teamId) {
        return await readTeamSettings(teamId, identity).catch(() => ({ owners: [], stages: [] }));
      }
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

    const guestLocal = await getGuestLocalData();

    let scope = null;
    let remoteProfile = null;
    let remoteTasks = [];
    let remoteSettings = null;

    if (hasFirestoreConfig()) {
      scope = await resolveTaskScope(identity).catch(() => null);
      if (scope) {
        const remoteDocs = await getTaskDocs(scope.path, identity.idToken).catch(() => []);
        remoteTasks = remoteDocs.map(toLegacyTaskView);
        const teamId = await resolveTeamId(identity).catch(() => null);
        if (teamId) {
          remoteSettings = await readTeamSettings(teamId, identity).catch(() => null);
        } else {
          remoteProfile = await readRemoteProfile(identity).catch(() => null);
          remoteSettings = remoteProfile?.settings || null;
        }
      } else {
        remoteProfile = await readRemoteProfile(identity).catch(() => null);
        remoteTasks = Array.isArray(remoteProfile?.tasks) ? remoteProfile.tasks.map(toLegacyTaskView) : [];
        remoteSettings = remoteProfile?.settings || null;
      }
    }

    const guestHasData = guestLocal.tasks.length > 0 || !!guestLocal.settings;
    const remoteHasData = remoteTasks.length > 0 || !!remoteSettings;

    if (guestHasData && mergeGuestData !== true && mergeGuestData !== false) {
      return {
        ok: true,
        hasRemoteData: remoteHasData,
        needsMergeChoice: true,
        guestTaskCount: guestLocal.tasks.length,
      };
    }

    if (guestHasData && mergeGuestData === true) {
      const mergedTasks = mergeTasks(remoteTasks, guestLocal.tasks).map(toLegacyTaskView);
      const mergedSettings = remoteSettings || guestLocal.settings || null;

      if (hasFirestoreConfig()) {
        try {
          if (scope) {
            const desiredDocs = mergedTasks.map((t) => toTaskDocForWrite(normalizeTaskDocument(t), identity));
            const desiredById = new Map(desiredDocs.map((t) => [t.id, t]));
            const currentRemoteDocs = await getTaskDocs(scope.path, identity.idToken).catch(() => []);

            for (const taskDoc of desiredDocs) {
              await addTaskDoc(scope.path, identity.idToken, taskDoc);
            }

            for (const remoteTask of currentRemoteDocs) {
              if (!desiredById.has(remoteTask.id)) {
                await deleteTaskDoc(scope.path, identity.idToken, remoteTask.id);
              }
            }

            const teamId = await resolveTeamId(identity).catch(() => null);
            if (teamId) {
              if (mergedSettings && typeof mergedSettings === 'object') {
                await saveTeamSettings(teamId, identity, mergedSettings);
              }
            } else {
              await writeRemoteFields(identity, { settings: mergedSettings });
            }
          } else {
            await writeRemoteFields(identity, { tasks: mergedTasks, settings: mergedSettings });
          }
        } catch (_) {
          return { ok: false, reason: 'REMOTE_WRITE_FAILED', hasRemoteData: remoteHasData };
        }
      }

      await clearGuestLocalData();
      await clearActiveLocalData();
      await setAlarmTaskIndex(mergedTasks);
      await markSync(identity.profileKey);
      return { ok: true, hasRemoteData: remoteHasData, mergedGuest: true };
    }

    await clearActiveLocalData();
    await setAlarmTaskIndex(remoteTasks);
    await markSync(identity.profileKey);
    return { ok: true, hasRemoteData: remoteHasData, mergedGuest: false };
  }

  async function postSignOut() {
    try {
      await syncGuestMode(true);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ===== Users / Teams / Members collection helpers =====

  function buildCollectionUrl(path) {
    return `${firestoreBaseUrl()}/${path}?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  }

  function buildQueryUrl() {
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIRESTORE_PROJECT_ID)}/databases/(default)/documents:runQuery?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  }

  async function writeDocAtPath(path, idToken, data) {
    const fields = {};
    Object.keys(data).forEach((k) => { fields[k] = toFirestoreValue(data[k]); });
    const res = await fetch(buildCollectionUrl(path), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`WRITE_FAILED:${path}: ${detail.slice(0, 400)}`);
    }
    return await res.json();
  }

  async function deleteDocAtPath(path, idToken) {
    const res = await fetch(buildCollectionUrl(path), {
      method: 'DELETE',
      headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
    });
    if (res.status === 404) return;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`DELETE_FAILED:${path}: ${detail.slice(0, 400)}`);
    }
  }

  async function createUserProfile(userId, idToken, { name, email, teamId, role }) {
    return await writeDocAtPath(`users/${userId}`, idToken, {
      name: name || '',
      email: email || '',
      teamId: teamId || '',
      role: role || 'member',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
  }

  async function createTeamDoc(teamId, idToken, { name, teamCode, ownerId, members }) {
    return await writeDocAtPath(`teams/${teamId}`, idToken, {
      name: name || '',
      teamCode: teamCode || '',
      ownerId: ownerId || '',
      members: Array.isArray(members) ? members : [],
      createdAt: new Date(),
    });
  }

  async function addTeamMember(teamId, memberId, idToken, { userId, role, name, email }) {
    return await writeDocAtPath(`teams/${teamId}/members/${memberId}`, idToken, {
      userId: userId || '',
      role: role || 'member',
      name: name || '',
      email: email || '',
      joinedAt: new Date(),
    });
  }

  async function seedDefaultTeamStages(teamId, idToken, createdByUid) {
    const defaults = [
      { id: 'prospect', title: 'prospect', color: '#4f46e5' },
      { id: 'interseted', title: 'Interseted', color: '#0ea5e9' },
      { id: 'not_intreseted', title: 'not intreseted', color: '#ef4444' },
      { id: 'contacted', title: 'Contacted', color: '#10b981' },
      { id: 'lost_on_price', title: 'Lost On Price', color: '#f59e0b' },
      { id: 'lead', title: 'lead', color: '#8b5cf6' },
      { id: 'clients', title: 'clients', color: '#14b8a6' },
    ];

    for (let i = 0; i < defaults.length; i += 1) {
      const stage = defaults[i];
      await writeDocAtPath(`teams/${teamId}/stages/${stage.id}`, idToken, {
        title: stage.title,
        color: stage.color,
        createdAt: new Date(),
        createdBy: createdByUid ? `users/${createdByUid}` : '',
        order: i,
      });
    }
  }

  // Field-masked PATCH — updates only the `members` array on the team doc.
  // This satisfies the self-join security rule (affectedKeys = ['members'] only).
  async function updateTeamMembersArray(teamId, idToken, members) {
    const fields = { members: toFirestoreValue(Array.isArray(members) ? members : []) };
    const url = `${firestoreBaseUrl()}/teams/${encodeURIComponent(teamId)}?updateMask.fieldPaths=members&key=${encodeURIComponent(FIREBASE_API_KEY)}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`WRITE_FAILED:teams/${teamId}: ${detail.slice(0, 400)}`);
    }
  }

  async function findTeamByCode(teamCode, idToken) {
    const res = await fetch(buildQueryUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'teams' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'teamCode' },
              op: 'EQUAL',
              value: { stringValue: teamCode },
            },
          },
          limit: 1,
        },
      }),
    });
    if (!res.ok) return null;
    const results = await res.json();
    // runQuery returns an array; first element has document if found
    const first = Array.isArray(results) ? results[0] : null;
    if (!first || !first.document) return null;
    const doc = first.document;
    // Extract teamId from document name: .../documents/teams/{teamId}
    const nameParts = (doc.name || '').split('/');
    const teamId = nameParts[nameParts.length - 1];
    return { teamId, ...decodeFirestoreDocument(doc) };
  }

  async function readDocAtPath(path, idToken) {
    const res = await fetch(`${firestoreBaseUrl()}/${path}?key=${encodeURIComponent(FIREBASE_API_KEY)}`, {
      headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const doc = await res.json();
    return decodeFirestoreDocument(doc);
  }

  async function listCollectionAtPath(path, idToken) {
    const res = await fetch(`${firestoreBaseUrl()}/${path}?key=${encodeURIComponent(FIREBASE_API_KEY)}`, {
      headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
    });
    if (!res.ok) return [];
    const data = await res.json();
    const docs = Array.isArray(data.documents) ? data.documents : [];
    return docs.map((doc) => ({
      id: (doc.name || '').split('/').pop(),
      ...decodeFirestoreDocument(doc),
    }));
  }

  function generateTeamCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map((b) => chars[b % chars.length])
      .join('');
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
    // Granular task ops (team-aware)
    saveTask,
    patchTask,
    removeTask,
    ensureTeamContact,
    searchTeamContacts,
    listTeamContacts,
    updateTeamContact,
    getSettings,
    setSettings,
    postSignIn,
    postSignOut,
    getDebugLogs,
    clearDebugLogs,
    // User / team provisioning
    createUserProfile,
    createTeamDoc,
    addTeamMember,
    seedDefaultTeamStages,
    findTeamByCode,
    generateTeamCode,
    updateTeamMembersArray,
    // Generic Firestore helpers
    readDocAtPath,
    listCollectionAtPath,
  };
})();
