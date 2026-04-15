// content.js - Nudge
// Floating fixed button - works on LinkedIn, Gmail, Outlook Web and WhatsApp Web.
// No DOM injection into the host page's framework tree.
const cloudStore = window.TaskSaverCloud;

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

// Module-level STAGES — refreshed from storage each time the modal opens
let STAGES = DEFAULT_SETTINGS.stages;

let lastUrl = location.href;

// ===== Platform detection =====
function detectPlatform() {
  const h = location.hostname;
  if (h.includes('linkedin.com'))          return 'linkedin';
  if (h === 'mail.google.com')             return 'gmail';
  if (h.includes('outlook.live.com') ||
      h.includes('outlook.office.com'))    return 'outlook';
  if (h === 'web.whatsapp.com')            return 'whatsapp';
  return null;
}

// ===== Per-platform config =====
const PLATFORM_CONFIG = {
  linkedin: {
    label:  '📋 Save as Task',
    color:  '#0a66c2',
    hover:  '#004182',
    thread: 'Message Thread',
  },
  gmail: {
    label:  '📋 Save Email as Task',
    color:  '#ea4335',
    hover:  '#c5221f',
    thread: 'Email Thread',
  },
  outlook: {
    label:  '📋 Save Email as Task',
    color:  '#0078d4',
    hover:  '#005a9e',
    thread: 'Email Thread',
  },
  whatsapp: {
    label:  '📋 Save Chat as Task',
    color:  '#25d366',
    hover:  '#1da851',
    thread: 'Chat',
  },
};

// ===== Should button be visible on this page? =====
function shouldShowButton() {
  const platform = detectPlatform();
  if (!platform) return false;
  if (platform === 'linkedin') return location.pathname.startsWith('/messaging');
  return true; // Gmail, Outlook, WhatsApp: always show when tab is active
}

// ===================================================================
// ===== Get canonical thread URL — handles split-pane layouts =====
// ===================================================================
// Gmail and Outlook both use a split-pane where clicking an email does NOT
// change location.href. The thread/message ID is only in the DOM.
// We read it from DOM attributes and build a proper deep-link URL so
// the saved task link re-opens the exact email later.

function getThreadUrl(platform) {
  if (platform === 'gmail')     return getGmailThreadUrl();
  if (platform === 'outlook')   return getOutlookThreadUrl();
  if (platform === 'whatsapp')  return getWhatsAppThreadUrl();
  // LinkedIn: URL always reflects the open conversation
  return location.href;
}

// ---- WhatsApp deep-link ----
// WhatsApp Web does NOT change location.href per conversation.
// We try to build a wa.me deep-link from the phone number so the saved
// link opens the correct chat. Group chats fall back to the base URL.
function getWhatsAppThreadUrl() {
  const chatId = extractWhatsAppChatId();

  if (chatId) {
    // Personal chat: "919876543210@c.us" → phone number is the part before @
    const phoneMatch = chatId.match(/^(\d+)@c\.us$/);
    if (phoneMatch) {
      return `https://wa.me/${phoneMatch[1]}`;
    }

    // Group chat: "12345678@g.us" — no wa.me equivalent, encode as query param
    const groupMatch = chatId.match(/^(.+)@g\.us$/);
    if (groupMatch) {
      // Just return base WhatsApp URL — groups can't be deep-linked externally
      return 'https://web.whatsapp.com/';
    }
  }

  // Fallback: current page URL (stays as web.whatsapp.com)
  return location.href;
}

// ---- Gmail deep-link ----
//
// The core problem: in split-pane view, the email list has MANY rows each with
// data-thread-id. querySelector always returns the FIRST one — not the open one.
// We must read the ID only from the CURRENTLY OPEN thread, not from the list.
//
// Strategy (most specific → least specific):
//   1. Reading pane container  — the div that wraps the open thread body
//   2. Selected/opened list row — the highlighted tr in the thread list
//   3. URL hash                — works when Gmail navigated to the thread view
//
function getGmailThreadUrl() {
  const accountMatch = location.pathname.match(/\/mail\/u\/(\d+)\//);
  const acct = accountMatch ? accountMatch[1] : '0';
  const base = `https://mail.google.com/mail/u/${acct}/#all/`;

  const id = readGmailOpenThreadId();
  if (id) return base + encodeURIComponent(id);

  // Fallback: URL hash contains thread ID (non-split-pane, or after clicking through)
  const urlMatch = location.href.match(/#(?:[a-z/]+\/)([A-Za-z0-9]{6,})/);
  if (urlMatch) return base + urlMatch[1];

  return location.href;
}

// Read the thread ID of the currently-open email only.
// Returns a string ID or null.
function readGmailOpenThreadId() {

  // ── STRATEGY 1: Reading pane itself ───────────────────────────────────────
  // getGmailReadingPane() already finds the right container scoped to the open
  // thread. If that container or any of its ancestors carry data-thread-id, use it.
  try {
    const pane = getGmailReadingPane();
    if (pane) {
      // Walk up from pane to find data-thread-id on an ancestor div
      let el = pane;
      while (el && el !== document.body) {
        const id = el.getAttribute('data-thread-id') ||
                   el.getAttribute('data-legacy-thread-id');
        if (id && id.length > 4) return id;
        el = el.parentElement;
      }
      // Also search inside the pane for a child with data-thread-id
      // (but NOT inside a table row — list items live there)
      const inner = pane.querySelectorAll('[data-thread-id], [data-legacy-thread-id]');
      for (const child of inner) {
        if (child.closest('tr')) continue; // skip list rows
        const id = child.getAttribute('data-thread-id') ||
                   child.getAttribute('data-legacy-thread-id');
        if (id && id.length > 4) return id;
      }
    }
  } catch (_) {}

  // ── STRATEGY 2: Selected / opened row in the thread list ─────────────────
  // Gmail marks the open thread row with specific class combinations.
  // Priority: aria-selected="true" > tabindex="0" > .btb > .x7/.zE
  //
  // We collect all candidate rows, score them, return the best.
  const rowSelectors = [
    'tr[aria-selected="true"]',   // most reliable — explicit ARIA
    'tr.zA.btb',                  // focused/open state class
    'tr.zA.x7',                   // read + selected
    'tr.zA.zE',                   // unread + selected
  ];

  for (const sel of rowSelectors) {
    try {
      const rows = document.querySelectorAll(sel);
      for (const row of rows) {
        // Extract ID from the row's id attribute: "thread-f:1234ABCD"
        if (row.id) {
          const m = row.id.match(/thread-[a-z]:([\w]+)/i);
          if (m && m[1].length > 4) return m[1];
        }
        // Also check explicit data attributes on the row
        const id = row.getAttribute('data-thread-id') ||
                   row.getAttribute('data-legacy-thread-id');
        if (id && id.length > 4) return id;
      }
    } catch (_) {}
  }

  // ── STRATEGY 3: jslog on non-table elements ───────────────────────────────
  // Some Gmail builds encode thread_id inside a jslog attribute on pane wrappers.
  try {
    const jslogEls = document.querySelectorAll('[jslog*="thread_id"]');
    for (const el of jslogEls) {
      if (el.closest('tr')) continue; // skip list rows
      const jslog = el.getAttribute('jslog') || '';
      const m = jslog.match(/thread_id[:\s]+([A-Za-z0-9]+)/i);
      if (m && m[1].length > 4) return m[1];
    }
  } catch (_) {}

  return null;
}

// ---- Outlook deep-link ----
// Outlook Web keeps the URL at /mail/inbox even when an email is open in the
// reading pane. The selected conversation carries its ID in:
//   data-convid      on the focused conversation row
//   data-itemid      on the message body container
// We reconstruct the direct-open URL:
//   outlook.live.com  → https://outlook.live.com/mail/0/id/{convid}
//   outlook.office.com → https://outlook.office.com/mail/id/{convid}
function getOutlookThreadUrl() {
  // Detect which Outlook host we're on
  const isLive   = location.hostname.includes('outlook.live.com');
  const isOffice = location.hostname.includes('outlook.office.com');

  // Account index (Outlook Live uses /mail/0/, /mail/1/ for multiple accounts)
  const acctMatch = location.pathname.match(/\/mail\/(\d+)\//);
  const acct = acctMatch ? acctMatch[1] : '0';

  // Try to get the conversation/item ID from the selected row
  const convIdSelectors = [
    '[data-convid]',
    '[aria-selected="true"][data-convid]',
    '[data-itemid]',
    // Focused reading pane wrapper
    '[role="main"] [data-item-id]',
    '[data-testid="mail-list-item"][aria-selected="true"]',
  ];

  let convId = null;
  for (const sel of convIdSelectors) {
    try {
      const el = document.querySelector(sel);
      if (!el) continue;
      convId = el.getAttribute('data-convid') ||
               el.getAttribute('data-itemid') ||
               el.getAttribute('data-item-id');
      if (convId && convId.length > 4) break;
    } catch (_) {}
  }

  if (convId) {
    const encoded = encodeURIComponent(convId);
    if (isLive)   return `https://outlook.live.com/mail/${acct}/id/${encoded}`;
    if (isOffice) return `https://outlook.office.com/mail/id/${encoded}`;
  }

  // Fallback: current URL (better than nothing)
  return location.href;
}

// ===== Panel state =====
let _panelFilter = 'today';

// ===== Create the floating widget (FAB + full popup panel) =====
function createWidget() {
  if (document.getElementById('lts-widget')) return;

  const platform = detectPlatform();
  if (!platform) return;
  const cfg = PLATFORM_CONFIG[platform];

  // --- FAB (small circular button) ---
  const fab = document.createElement('button');
  fab.id = 'lts-widget';
  fab.textContent = '📌';
  fab.title = 'Nudge — click to open, drag to move';
  fab.style.setProperty('background', cfg.color, 'important');

  // --- Floating Panel (full popup replica) ---
  const panel = document.createElement('div');
  panel.id = 'lts-widget-popup';

  // Header (draggable, red like popup)
  const header = document.createElement('div');
  header.className = 'lts-panel-header';
  header.innerHTML = '<span class="lts-panel-title">Nudge</span>';

  const headerRight = document.createElement('div');
  headerRight.className = 'lts-panel-header-right';

  const badge = document.createElement('span');
  badge.className = 'lts-panel-badge';
  badge.id = 'lts-panel-badge';
  badge.textContent = '0';
  badge.hidden = true;

  const expandBtn = document.createElement('button');
  expandBtn.className = 'lts-panel-expand';
  expandBtn.textContent = '⤢';
  expandBtn.title = 'Open full dashboard';
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'OPEN_DASHBOARD' });
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'lts-panel-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeWidgetPopup();
  });

  headerRight.append(badge, expandBtn, closeBtn);
  header.appendChild(headerRight);
  panel.appendChild(header);

  // Action buttons row
  const actionsRow = document.createElement('div');
  actionsRow.className = 'lts-panel-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'lts-panel-action-btn';
  saveBtn.innerHTML = '📋 Save as Task';
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const contactName = extractContactName(platform);
    if ((platform === 'gmail' || platform === 'outlook') && contactName === 'Open an email first') {
      showNoThreadToast(platform);
      return;
    }
    const threadUrl = getThreadUrl(platform);
    openModal(contactName, threadUrl, platform).catch((err) => {
      if (isExtensionContextInvalidated(err)) { showExtensionReloadToast(); return; }
      console.error('[TSP] openModal error:', err);
      showExtensionReloadToast('Could not open task modal. Refresh this tab and try again.');
    });
  });
  actionsRow.appendChild(saveBtn);

  if (platform === 'linkedin') {
    const grabBtn = document.createElement('button');
    grabBtn.className = 'lts-panel-action-btn';
    grabBtn.innerHTML = '💬 Grab Chat';
    grabBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const contactName = extractLinkedInName();
      const messages = extractLinkedInChat();
      if (!messages || messages.length === 0) {
        showGrabChatToast('⚠️ No messages found. Open a conversation first.', '#b45309');
        return;
      }

      // 1. Copy chat to clipboard
      const chatText = formatChatAsText(contactName, messages);
      try { await navigator.clipboard.writeText(chatText); } catch (_) {}

      // 2. Open Claude in a new tab with the conversation for reply help
      const claudePrompt = `/linkedin-reply ${chatText}`;
      const claudeUrl = `https://claude.ai/new?q=${encodeURIComponent(claudePrompt)}`;
      window.open(claudeUrl, '_blank');

      // 3. Check if a task already exists for this contact
      let existingTasks = [];
      try { existingTasks = await cloudStore.getTasks(); } catch (_) {}

      const matchingTask = existingTasks
        .filter(t => t.contactName === contactName && t.platform === 'linkedin' && !t.completed)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

      if (matchingTask) {
        // Attach chat to existing task's description
        const separator = matchingTask.description ? '\n\n───── Chat grabbed ' + new Date().toLocaleString() + ' ─────\n\n' : '';
        matchingTask.description = (matchingTask.description || '') + separator + chatText;
        try {
          await cloudStore.patchTask(matchingTask.id, { description: matchingTask.description, updatedAt: Date.now() });
          showGrabChatToast('✅ Chat copied & attached to existing task!', '#2da44e');
          renderPanelTasks();
        } catch (_) {
          showGrabChatToast('⚠️ Chat copied but failed to attach to task.', '#b45309');
        }
      } else {
        // No existing task — open Save as Task modal with chat pre-filled
        showGrabChatToast('📋 Chat copied! Now save your task.', '#0a66c2');
        const threadUrl = getThreadUrl(platform);
        openModal(contactName, threadUrl, platform, chatText).catch((err) => {
          if (isExtensionContextInvalidated(err)) { showExtensionReloadToast(); return; }
          console.error('[TSP] openModal error:', err);
        });
      }
    });
    actionsRow.appendChild(grabBtn);
  }
  panel.appendChild(actionsRow);

  // Filter tabs
  const tabs = document.createElement('div');
  tabs.className = 'lts-panel-tabs';
  ['today', 'pending', 'completed'].forEach(f => {
    const tab = document.createElement('button');
    tab.className = 'lts-panel-tab' + (f === 'today' ? ' lts-panel-tab--active' : '');
    tab.dataset.filter = f;
    tab.textContent = f === 'today' ? '☀️ Today' : f.charAt(0).toUpperCase() + f.slice(1);
    tab.addEventListener('click', () => {
      tabs.querySelectorAll('.lts-panel-tab').forEach(t => t.classList.remove('lts-panel-tab--active'));
      tab.classList.add('lts-panel-tab--active');
      _panelFilter = f;
      renderPanelTasks();
    });
    tabs.appendChild(tab);
  });
  panel.appendChild(tabs);

  // Task list container
  const taskList = document.createElement('div');
  taskList.className = 'lts-panel-tasks';
  taskList.id = 'lts-panel-tasks';
  panel.appendChild(taskList);

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  // --- FAB: draggable + click ---
  let fabDragging = false, fabWasDragged = false;
  let fabDragStartX, fabDragStartY, fabStartLeft, fabStartTop;

  chrome.storage.local.get('nudgeWidgetPos', (data) => {
    if (data.nudgeWidgetPos) {
      fab.style.setProperty('bottom', `${data.nudgeWidgetPos.bottom}px`, 'important');
      fab.style.setProperty('right', `${data.nudgeWidgetPos.right}px`, 'important');
    }
  });

  fab.addEventListener('mousedown', (e) => {
    e.preventDefault();
    fabDragging = true; fabWasDragged = false;
    fabDragStartX = e.clientX; fabDragStartY = e.clientY;
    const r = fab.getBoundingClientRect();
    fabStartLeft = r.left; fabStartTop = r.top;
    fab.classList.add('lts-widget--dragging');
  });

  // --- Panel header: draggable ---
  let panelDragging = false;
  let panelDragStartX, panelDragStartY, panelStartLeft, panelStartTop;

  chrome.storage.local.get('nudgePanelPos', (data) => {
    if (data.nudgePanelPos) {
      panel.style.setProperty('bottom', `${data.nudgePanelPos.bottom}px`, 'important');
      panel.style.setProperty('right', `${data.nudgePanelPos.right}px`, 'important');
    }
  });

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.lts-panel-expand, .lts-panel-close, .lts-panel-badge')) return;
    e.preventDefault();
    panelDragging = true;
    panelDragStartX = e.clientX; panelDragStartY = e.clientY;
    const r = panel.getBoundingClientRect();
    panelStartLeft = r.left; panelStartTop = r.top;
    header.classList.add('lts-panel--dragging');
  });

  document.addEventListener('mousemove', (e) => {
    if (fabDragging) {
      const dx = e.clientX - fabDragStartX, dy = e.clientY - fabDragStartY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) fabWasDragged = true;
      fab.style.setProperty('right', `${Math.max(0, window.innerWidth - (fabStartLeft + dx) - fab.offsetWidth)}px`, 'important');
      fab.style.setProperty('bottom', `${Math.max(0, window.innerHeight - (fabStartTop + dy) - fab.offsetHeight)}px`, 'important');
    }
    if (panelDragging) {
      const dx = e.clientX - panelDragStartX, dy = e.clientY - panelDragStartY;
      panel.style.setProperty('right', `${Math.max(0, window.innerWidth - (panelStartLeft + dx) - panel.offsetWidth)}px`, 'important');
      panel.style.setProperty('bottom', `${Math.max(0, window.innerHeight - (panelStartTop + dy) - panel.offsetHeight)}px`, 'important');
    }
  });

  document.addEventListener('mouseup', () => {
    if (fabDragging) {
      fabDragging = false; fab.classList.remove('lts-widget--dragging');
      if (fabWasDragged) chrome.storage.local.set({ nudgeWidgetPos: { right: parseInt(fab.style.right) || 24, bottom: parseInt(fab.style.bottom) || 80 } });
    }
    if (panelDragging) {
      panelDragging = false; header.classList.remove('lts-panel--dragging');
      chrome.storage.local.set({ nudgePanelPos: { right: parseInt(panel.style.right) || 24, bottom: parseInt(panel.style.bottom) || 140 } });
    }
  });

  fab.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (fabWasDragged) { fabWasDragged = false; return; }
    toggleWidgetPopup();
  });

  // Listen for task changes to re-render
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.tasks || changes.settings)) renderPanelTasks();
  });
}

// ===== Render tasks inside panel =====
async function renderPanelTasks() {
  const container = document.getElementById('lts-panel-tasks');
  const badge = document.getElementById('lts-panel-badge');
  if (!container) return;

  let allTasks = [];
  try { allTasks = await cloudStore.getTasks(); } catch { return; }

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

  const filtered = allTasks.filter(t => {
    if (_panelFilter === 'today')     return !t.completed && t.remindAt >= todayStart.getTime() && t.remindAt <= todayEnd.getTime();
    if (_panelFilter === 'pending')   return !t.completed;
    if (_panelFilter === 'completed') return t.completed;
    return true;
  });
  filtered.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return a.remindAt - b.remindAt;
  });

  // Badge count (today's tasks)
  const todayCount = allTasks.filter(t => !t.completed && t.remindAt >= todayStart.getTime() && t.remindAt <= todayEnd.getTime()).length;
  if (badge) {
    badge.textContent = todayCount > 99 ? '99+' : String(todayCount);
    badge.hidden = todayCount === 0;
  }

  container.innerHTML = '';
  if (filtered.length === 0) {
    container.innerHTML = '<p class="lts-panel-empty">No tasks yet.<br>Open a conversation and click <strong>"Save as Task"</strong> to get started.</p>';
    return;
  }

  filtered.forEach(task => {
    const card = document.createElement('div');
    card.className = 'lts-ptask' + (task.completed ? ' lts-ptask--done' : '');

    // Avatar + name row
    const top = document.createElement('div');
    top.className = 'lts-ptask__top';

    const avatar = document.createElement('span');
    avatar.className = 'lts-ptask__avatar';
    avatar.textContent = getTaskInitials(task);

    const nameBlock = document.createElement('div');
    nameBlock.className = 'lts-ptask__name-block';
    const name = document.createElement('span');
    name.className = 'lts-ptask__name';
    name.textContent = getTaskDisplayName(task);
    nameBlock.appendChild(name);

    // Profile + thread links row
    const links = document.createElement('div');
    links.className = 'lts-ptask__links';
    if (task.profileUrl) {
      const profLink = document.createElement('a');
      profLink.className = 'lts-ptask__profile-link';
      profLink.href = task.profileUrl;
      profLink.target = '_blank';
      profLink.rel = 'noopener noreferrer';
      profLink.title = 'View profile';
      profLink.textContent = '👤 Profile';
      links.appendChild(profLink);
    }
    if (task.threadUrl) {
      const threadLink = document.createElement('a');
      threadLink.className = 'lts-ptask__thread';
      threadLink.href = task.threadUrl;
      threadLink.target = '_blank';
      threadLink.rel = 'noopener noreferrer';
      threadLink.textContent = '💬 Thread';
      links.appendChild(threadLink);
    }
    if (links.children.length > 0) nameBlock.appendChild(links);

    const overdue = !task.completed && task.remindAt < Date.now();
    const status = document.createElement('span');
    status.className = 'lts-ptask__status lts-ptask__status--' + (task.completed ? 'done' : overdue ? 'overdue' : 'pending');
    status.textContent = task.completed ? 'Done' : overdue ? 'Overdue' : 'Pending';
    top.append(avatar, nameBlock, status);
    card.appendChild(top);

    const followup = document.createElement('p');
    followup.className = 'lts-ptask__followup';
    const days = task.followupDays ? `${task.followupDays}-day follow-up` : 'Follow-up';
    followup.textContent = `${days} · ${new Date(task.remindAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    card.appendChild(followup);

    const actions = document.createElement('div');
    actions.className = 'lts-ptask__actions';
    if (!task.completed) {
      const doneBtn = document.createElement('button');
      doneBtn.className = 'lts-ptask-btn lts-ptask-btn--done';
      doneBtn.textContent = '✓ Done';
      doneBtn.addEventListener('click', async () => {
        await cloudStore.patchTask(task.id, { completed: true, status: 'done', updatedAt: Date.now() });
        chrome.runtime.sendMessage({ action: 'DELETE_ALARM', alarmName: task.id });
        renderPanelTasks();
      });
      actions.appendChild(doneBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'lts-ptask-btn lts-ptask-btn--del';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      await cloudStore.removeTask(task.id);
      chrome.runtime.sendMessage({ action: 'DELETE_ALARM', alarmName: task.id });
      renderPanelTasks();
    });
    actions.appendChild(delBtn);
    card.appendChild(actions);

    container.appendChild(card);
  });
}

function toggleWidgetPopup() {
  const panel = document.getElementById('lts-widget-popup');
  if (!panel) return;
  if (panel.classList.contains('lts-popup--open')) {
    closeWidgetPopup();
  } else {
    positionPopup();
    panel.classList.add('lts-popup--open');
    renderPanelTasks();
  }
}

function closeWidgetPopup() {
  const panel = document.getElementById('lts-widget-popup');
  if (panel) panel.classList.remove('lts-popup--open');
}

function positionPopup() {
  const fab = document.getElementById('lts-widget');
  const panel = document.getElementById('lts-widget-popup');
  if (!fab || !panel) return;
  chrome.storage.local.get('nudgePanelPos', (data) => {
    if (data.nudgePanelPos) {
      panel.style.setProperty('right', `${data.nudgePanelPos.right}px`, 'important');
      panel.style.setProperty('bottom', `${data.nudgePanelPos.bottom}px`, 'important');
    } else {
      const rect = fab.getBoundingClientRect();
      panel.style.setProperty('right', `${window.innerWidth - rect.right}px`, 'important');
      panel.style.setProperty('bottom', `${window.innerHeight - rect.top + 8}px`, 'important');
    }
  });
}

// ===== Extract LinkedIn conversation messages =====
function extractLinkedInChat() {
  const messages = [];

  // LinkedIn messaging DOM selectors for message items
  const msgSelectors = [
    '.msg-s-event-listitem',
    '.msg-s-message-list__event',
    '[class*="msg-s-event-listitem"]',
  ];

  let msgElements = [];
  for (const sel of msgSelectors) {
    msgElements = document.querySelectorAll(sel);
    if (msgElements.length > 0) break;
  }

  // If no structured messages found, try a broader approach
  if (msgElements.length === 0) {
    // Try the message list container and get all message-like blocks
    const container = document.querySelector('.msg-s-message-list-content, [class*="msg-s-message-list"]');
    if (container) {
      msgElements = container.querySelectorAll('li, [role="listitem"]');
    }
  }

  for (const msgEl of msgElements) {
    // Extract sender name
    let sender = '';
    const senderSelectors = [
      '.msg-s-message-group__name',
      '.msg-s-message-group__profile-link',
      '[class*="msg-s-message-group__name"]',
      '.msg-s-event-listitem__link span',
      'span.t-14.t-bold',
    ];
    for (const sel of senderSelectors) {
      const el = msgEl.querySelector(sel);
      if (el && el.textContent.trim()) {
        sender = el.textContent.trim();
        break;
      }
    }

    // Extract timestamp
    let time = '';
    const timeSelectors = [
      '.msg-s-message-group__timestamp',
      'time',
      '[class*="timestamp"]',
      '.msg-s-message-list__time-heading',
    ];
    for (const sel of timeSelectors) {
      const el = msgEl.querySelector(sel);
      if (el) {
        time = (el.getAttribute('datetime') || el.textContent || '').trim();
        break;
      }
    }

    // Extract message body text
    let body = '';
    const bodySelectors = [
      '.msg-s-event-listitem__body',
      '.msg-s-event__content',
      '[class*="msg-s-event-listitem__message-bubble"]',
      '.msg-s-message-group__content p',
      'p.msg-s-event-listitem__body',
    ];
    for (const sel of bodySelectors) {
      const el = msgEl.querySelector(sel);
      if (el && el.textContent.trim()) {
        body = el.textContent.trim();
        break;
      }
    }

    // Only add if we got meaningful content
    if (body) {
      messages.push({ sender, time, body });
    }
  }

  return messages;
}

// ===== Grab Chat modal =====
function openGrabChatModal(contactName, messages) {
  // Remove any existing modal
  const existing = document.getElementById('lts-grab-chat-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'lts-grab-chat-overlay';
  overlay.className = 'lts-grab-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const modal = document.createElement('div');
  modal.className = 'lts-grab-modal';
  modal.addEventListener('click', (e) => e.stopPropagation());

  // Header
  const header = document.createElement('div');
  header.className = 'lts-grab-header';

  const title = document.createElement('h2');
  title.className = 'lts-grab-title';
  title.textContent = `Chat with ${contactName}`;

  const headerRight = document.createElement('div');
  headerRight.style.cssText = 'display:flex;gap:8px;align-items:center;';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'lts-grab-copy-btn';
  copyBtn.textContent = '📋 Copy All';
  copyBtn.addEventListener('click', () => {
    const text = formatChatAsText(contactName, messages);
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = '✓ Copied!';
      setTimeout(() => { copyBtn.textContent = '📋 Copy All'; }, 2000);
    });
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'lts-close-btn';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());

  headerRight.append(copyBtn, closeBtn);
  header.append(title, headerRight);

  // Message count
  const countBadge = document.createElement('div');
  countBadge.className = 'lts-grab-count';
  countBadge.textContent = `${messages.length} message${messages.length !== 1 ? 's' : ''} captured`;

  // Chat body
  const chatBody = document.createElement('div');
  chatBody.className = 'lts-grab-body';

  for (const msg of messages) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'lts-grab-msg';

    if (msg.sender || msg.time) {
      const meta = document.createElement('div');
      meta.className = 'lts-grab-msg-meta';
      if (msg.sender) {
        const senderSpan = document.createElement('span');
        senderSpan.className = 'lts-grab-msg-sender';
        senderSpan.textContent = msg.sender;
        meta.appendChild(senderSpan);
      }
      if (msg.time) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'lts-grab-msg-time';
        timeSpan.textContent = msg.time;
        meta.appendChild(timeSpan);
      }
      msgDiv.appendChild(meta);
    }

    const bodyP = document.createElement('p');
    bodyP.className = 'lts-grab-msg-body';
    bodyP.textContent = msg.body;
    msgDiv.appendChild(bodyP);

    chatBody.appendChild(msgDiv);
  }

  modal.append(header, countBadge, chatBody);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Esc to close
  const escHandler = (e) => {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
}

// Format chat as plain text for clipboard
function formatChatAsText(contactName, messages) {
  let text = `LinkedIn Chat with ${contactName}\n`;
  text += `Captured: ${new Date().toLocaleString()}\n`;
  text += '─'.repeat(40) + '\n\n';

  for (const msg of messages) {
    if (msg.sender) text += `${msg.sender}`;
    if (msg.time) text += ` (${msg.time})`;
    if (msg.sender || msg.time) text += ':\n';
    text += `${msg.body}\n\n`;
  }

  return text.trim();
}

// Toast for grab chat
function showGrabChatToast(message, color) {
  const existing = document.getElementById('lts-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'lts-toast';
  toast.textContent = message;
  toast.style.setProperty('background', color || '#0a66c2', 'important');
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add('lts-toast--visible'), 10);
  setTimeout(() => {
    toast.classList.remove('lts-toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ===== Show/hide widget based on page =====
function updateButtonVisibility() {
  const fab = document.getElementById('lts-widget');
  if (!fab) return;
  const show = shouldShowButton();
  fab.style.display = show ? 'flex' : 'none';

  // Update FAB color to match platform
  if (show) {
    const cfg = PLATFORM_CONFIG[detectPlatform()];
    if (cfg) fab.style.setProperty('background', cfg.color, 'important');
  }

  // Hide popup when widget hides
  if (!show) closeWidgetPopup();
}

// ===== Poll for URL changes (all platforms are SPAs) =====
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    updateButtonVisibility();
    removeModal();
  }
}, 600);

// ===== Init =====
(async () => {
  await cloudStore.init();
  createWidget();
  updateButtonVisibility();
})();

// ===================================================================
// ===== Extract contact name — per platform =====
// ===================================================================

function extractContactName(platform) {
  switch (platform) {
    case 'linkedin':  return extractLinkedInName();
    case 'gmail':     return extractGmailName();
    case 'outlook':   return extractOutlookName();
    case 'whatsapp':  return extractWhatsAppName();
    default:          return 'Unknown Contact';
  }
}

// ===== CRM helpers =====
function parseContactName(fullName) {
  const trimmed = (fullName || '').trim();
  if (!trimmed || trimmed === 'Unknown Contact') return { firstName: '', lastName: '' };

  // Guard against accidental "Name - Subject" style strings from email UIs.
  const withoutStatus = trimmed.replace(/\s+Status\s+is\s+.*$/i, '').trim();
  const withoutSubject = withoutStatus.replace(/\s+[\u2014\u2013-]\s+.*$/, '').trim();
  const withoutEmail = withoutSubject.replace(/<[^>]+>/g, '').trim();
  const parts = withoutEmail.split(/\s+/);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
}

function getTaskDisplayName(task) {
  if (task.firstName || task.lastName) return `${task.firstName || ''} ${task.lastName || ''}`.trim();
  return task.contactName || 'Unknown';
}

function getTaskInitials(task) {
  const first = (task.firstName || task.contactName || '?')[0] || '?';
  const last = (task.lastName || '')[0] || '';
  return (first + last).toUpperCase();
}

function extractLinkedInProfileUrl() {
  const selectors = [
    '.msg-thread__link-to-profile',
    '.msg-entity-lockup__entity-title a',
    'a[href*="/in/"]',
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const href = el.href || el.getAttribute('href') || '';
        if (href.includes('/in/')) return href.split('?')[0]; // strip query params
      }
    } catch (_) {}
  }
  // Try broader search in conversation header
  const headerEl = document.querySelector('.msg-thread, .scaffold-layout__detail');
  if (headerEl) {
    const links = headerEl.querySelectorAll('a[href*="/in/"]');
    for (const link of links) {
      const href = link.href || '';
      if (href.includes('/in/')) return href.split('?')[0];
    }
  }
  return '';
}

// ---- LinkedIn ----
// Split raw LinkedIn text on "Status is offline/online" boundary
// Pattern: "{Name} Status is offline {Title/Headline}"
// e.g. "vikas singh Status is offline xyz at dsfd"
//   → name: "vikas singh", title: "xyz at dsfd"
function cleanLinkedInText(raw) {
  return String(raw || '')
    .replace(/\s*Status\s+is\s+.*$/i, '')
    .replace(/\s*\u00b7\s*\d+(st|nd|rd|th)?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLinkedInNameAndTitle(rawText) {
  const text = (rawText || '').trim();
  if (!text) return { name: '', title: '' };

  const statusMatch = text.match(/\s*Status is (offline|online|busy|away|dnd|reachable|active|available|mobile)\s*/i);
  if (statusMatch) {
    const name = cleanLinkedInText(text.slice(0, statusMatch.index));
    const tail = String(text.slice(statusMatch.index + statusMatch[0].length) || '').trim();
    const title = cleanLinkedInText(tail);
    return { name: name || 'Unknown Contact', title: title || '' };
  }

  // No status marker — return whole cleaned text as name
  return { name: cleanLinkedInText(text) || text, title: '' };
}

function extractLinkedInName() {
  const selectors = [
    '.msg-thread__link-to-profile',
    '.msg-entity-lockup__entity-title',
    '.msg-overlay-conversation-bubble__participant-names',
    '.msg-overlay-conversation-bubble__title',
    '.msg-conversation-listitem__participant-names span',
    '.msg-s-message-list-container h2',
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      const raw = el && el.textContent.trim();
      if (raw) {
        const { name } = splitLinkedInNameAndTitle(raw);
        if (name) return name;
      }
    } catch (_) {}
  }
  for (const containerSel of ['.msg-thread', '.scaffold-layout__main']) {
    const container = document.querySelector(containerSel);
    if (!container) continue;
    for (const tag of ['h1', 'h2', 'h3']) {
      const el = container.querySelector(tag);
      const raw = el && el.textContent.trim();
      if (raw && raw.length > 1) {
        const { name } = splitLinkedInNameAndTitle(raw);
        if (name) return name;
      }
    }
  }
  return 'Unknown Contact';
}

function extractLinkedInTitle() {
  // First try dedicated subtitle element
  const subtitleSelectors = [
    '.msg-entity-lockup__entity-title + .msg-entity-lockup__entity-subtitle',
    '.msg-entity-lockup__entity-subtitle',
    '.msg-overlay-conversation-bubble__subtitle',
    '.msg-thread .msg-entity-lockup__entity-subtitle',
    '.msg-thread .t-14.t-black--light',
    '.msg-thread [class*="entity-subtitle"]',
  ];
  for (const sel of subtitleSelectors) {
    try {
      const el = document.querySelector(sel);
      const raw = el && el.textContent.trim();
      if (raw) {
        const cleaned = cleanLinkedInText(raw);
        if (cleaned && cleaned.length > 2) return cleaned;
      }
    } catch (_) {}
  }

  // Fall back: extract title from the combined name+title element
  const nameSelectors = [
    '.msg-thread__link-to-profile',
    '.msg-entity-lockup__entity-title',
    '.msg-overlay-conversation-bubble__participant-names',
    '.msg-overlay-conversation-bubble__title',
  ];
  for (const sel of nameSelectors) {
    try {
      const el = document.querySelector(sel);
      const raw = el && el.textContent.trim();
      if (raw) {
        const { title } = splitLinkedInNameAndTitle(raw);
        if (title) return title;
      }
    } catch (_) {}
  }
  return '';
}

function extractContactTitle(platform) {
  if (platform === 'linkedin') return extractLinkedInTitle();
  return '';
}

function extractEmailAddress(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const match = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : '';
}

function cleanEmailDisplayName(name) {
  return String(name || '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\"']/g, '')
    .trim();
}

function parseGmailContactInfo() {
  const pane = getGmailReadingPane();
  const root = pane || document;

  let subject = '';
  const subjectSelectors = ['.hP', 'h2.hP', '.ha h2', 'h1', 'h2'];
  for (const sel of subjectSelectors) {
    try {
      const el = root.querySelector(sel);
      const txt = (el && el.textContent ? el.textContent.trim() : '');
      if (txt) {
        subject = txt.replace(/\s*\(\d+\)\s*$/, '').trim();
        break;
      }
    } catch (_) {}
  }

  let senderName = '';
  let senderEmail = '';
  const toRecipients = [];
  const seenRecipientKeys = new Set();

  const addRecipient = (email, name) => {
    const safeEmail = String(email || '').trim().toLowerCase();
    if (!safeEmail) return;
    if (safeEmail === senderEmail) return;
    const safeName = cleanEmailDisplayName(name || '');
    const key = `${safeEmail}|${safeName.toLowerCase()}`;
    if (seenRecipientKeys.has(key)) return;
    seenRecipientKeys.add(key);
    toRecipients.push({ name: safeName, email: safeEmail });
  };
  const senderSelectors = [
    '[data-expanded="true"] .gD',
    '[data-expanded="true"] [email]',
    '.aqJ .gD',
    '.adn.ads .gD',
    '.gD[name]',
    '.gD[email]',
  ];
  for (const sel of senderSelectors) {
    try {
      const el = root.querySelector(sel);
      if (!el) continue;

      const nameAttr = cleanEmailDisplayName(el.getAttribute('name') || el.getAttribute('data-name') || '');
      const emailAttr = String(el.getAttribute('email') || '').trim().toLowerCase();
      const text = (el.textContent || '').trim();

      if (!senderEmail) senderEmail = emailAttr || extractEmailAddress(text) || extractEmailAddress(nameAttr);

      const candidateName = nameAttr || cleanEmailDisplayName(text);
      if (candidateName && !candidateName.includes('@')) {
        senderName = candidateName;
        break;
      }
      if (!senderName && candidateName) senderName = candidateName;
    } catch (_) {}
  }

  const recipientSelectors = [
    '[data-expanded="true"] .g2[email]',
    '[data-expanded="true"] [email]:not(.gD)',
    '.g2[email]',
    '[email]:not(.gD)',
    '[data-hovercard-id*="@"]',
    'a[href^="mailto:"]',
  ];

  for (const sel of recipientSelectors) {
    try {
      const els = root.querySelectorAll(sel);
      if (!els || els.length === 0) continue;

      for (const el of els) {
        const text = (el.textContent || '').trim();
        const nameAttr = cleanEmailDisplayName(el.getAttribute('name') || el.getAttribute('data-name') || '');

        const emailAttr = String(el.getAttribute('email') || '').trim().toLowerCase();
        const hovercardEmail = String(el.getAttribute('data-hovercard-id') || '').trim().toLowerCase();
        const href = String(el.getAttribute('href') || '').trim();
        const hrefEmail = href.startsWith('mailto:') ? String(href.slice(7)).split('?')[0].trim().toLowerCase() : '';

        const foundEmail = emailAttr
          || (hovercardEmail.includes('@') ? hovercardEmail : '')
          || hrefEmail
          || extractEmailAddress(text)
          || extractEmailAddress(nameAttr);

        if (!foundEmail) continue;
        const foundName = nameAttr || cleanEmailDisplayName(text);
        addRecipient(foundEmail, foundName);
      }
    } catch (_) {}
  }

  if (!subject) {
    const stripped = document.title
      .replace(/ - Gmail$/, '')
      .replace(/ - [^-]+@[^-]+(\.\w+)+$/, '')
      .trim();
    const genericLabels = /^(Inbox|Sent|Drafts|Spam|Trash|Starred|Snoozed|All Mail|Important)/i;
    if (stripped && !genericLabels.test(stripped)) {
      subject = stripped.replace(/\s*\(\d+\)\s*$/, '').trim();
    }
  }

  if (!senderEmail && senderName) senderEmail = extractEmailAddress(senderName);
  senderName = cleanEmailDisplayName(senderName);

  const sentView = /#(?:sent|sent\/|all\/)/i.test(location.href);
  const uniqueRecipients = toRecipients.filter((r) => r && r.email && r.email !== senderEmail);
  const primaryRecipient = uniqueRecipients[0] || toRecipients[0] || null;

  const primaryName = sentView
    ? String((primaryRecipient && primaryRecipient.name) || '').trim()
    : senderName;
  const primaryEmail = sentView
    ? String((primaryRecipient && primaryRecipient.email) || '').trim().toLowerCase()
    : senderEmail;

  return {
    senderName,
    senderEmail,
    toRecipients,
    subject,
    primaryName: cleanEmailDisplayName(primaryName || (sentView ? '' : senderName) || ''),
    primaryEmail: String(primaryEmail || (sentView ? '' : senderEmail) || '').trim().toLowerCase(),
  };
}

function parseOutlookContactInfo() {
  let senderName = '';
  let senderEmail = '';
  let subject = '';

  const senderSelectors = [
    '[data-testid="senderName"]',
    '[data-testid="sender"]',
    '.ms-Persona-primaryText',
    '.allowTextSelection [data-testid="sender"] span',
    '.oMY5O',
    '.RPcS5b',
    '.UHiM0',
  ];
  for (const sel of senderSelectors) {
    try {
      const el = document.querySelector(sel);
      if (!el) continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;

      if (!senderEmail) senderEmail = extractEmailAddress(txt);
      const cleaned = cleanEmailDisplayName(txt);
      if (cleaned && cleaned.length > 1) {
        senderName = cleaned;
        break;
      }
    } catch (_) {}
  }

  // Some Outlook builds expose sender email separately in data attributes.
  if (!senderEmail) {
    try {
      const emailCarrier = document.querySelector('[data-testid="sender"] [title*="@"], [title*="@"]');
      if (emailCarrier) {
        senderEmail = extractEmailAddress(emailCarrier.getAttribute('title') || emailCarrier.textContent || '');
      }
    } catch (_) {}
  }

  const subjectSelectors = [
    '[data-testid="subject"]',
    '.OZZZK',
    '.ovuGFd',
    '[aria-label*="Subject"] span',
    'h1[role="heading"]',
    'h2[role="heading"]',
  ];
  for (const sel of subjectSelectors) {
    try {
      const el = document.querySelector(sel);
      const txt = (el && el.textContent ? el.textContent.trim() : '');
      if (txt.length > 1) {
        subject = txt;
        break;
      }
    } catch (_) {}
  }

  if (!subject) {
    const stripped = document.title
      .replace(/ - (Outlook|Microsoft 365|Mail).*$/, '')
      .trim();
    const genericLabels = /^(Inbox|Sent Items|Drafts|Junk Email|Deleted Items|Archive|Calendar|People|Tasks)/i;
    if (stripped && !genericLabels.test(stripped)) {
      subject = stripped;
    }
  }

  senderName = cleanEmailDisplayName(senderName);
  return { senderName, senderEmail, subject };
}

// ---- Gmail ----
function extractGmailName() {
  const info = parseGmailContactInfo();
  if (info.primaryName) return info.primaryName;
  if (info.senderName) return info.senderName;
  if (info.subject) return 'Unknown Contact';
  return 'Open an email first';
}

// Return the reading pane DOM element, or null if not found.
// This is the container that holds the open thread (not the list).
function getGmailReadingPane() {
  // Try containers that Gmail uses for the reading pane / thread view.
  // These are divs, NOT table rows — that's the key discriminator.
  const candidates = [
    '[role="main"]',           // outermost main region
    '.nH.aHU',                 // reading pane wrapper (split view)
    '.nH[data-thread-id]',     // pane with thread id attr
    '.aeF',                    // another reading pane class
    '.bkK',                    // conversation view root
    '.g3',                     // thread detail wrapper
  ];
  for (const sel of candidates) {
    try {
      const el = document.querySelector(sel);
      // Make sure it contains a .hP subject heading — that means a thread is open
      if (el && el.querySelector('.hP')) return el;
    } catch (_) {}
  }
  return null; // no reading pane found = no thread open
}

// ---- Outlook Web ----
function extractOutlookName() {
  const info = parseOutlookContactInfo();
  if (info.senderName) return info.senderName;
  if (info.subject) return 'Unknown Contact';
  return 'Open an email first'; // sentinel — triggers warning toast
}

// ---- WhatsApp Web ----
function extractWhatsAppName() {
  // Strategy 1: data-testid selectors (most stable across WhatsApp updates)
  const testIdSelectors = [
    '[data-testid="conversation-info-header-chat-title"]',
    '[data-testid="conversation-info-header"] span[dir="auto"]',
    '[data-testid="chat-title"]',
  ];
  for (const sel of testIdSelectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const txt = (el.getAttribute('title') || el.textContent || '').trim();
        if (txt && txt.length > 1) return txt;
      }
    } catch (_) {}
  }

  // Strategy 2: header span with dir="auto" — title attribute holds the full name
  // The DOM shows: <span dir="auto" title="ContactName ...">
  try {
    const header = document.querySelector('#main header');
    if (header) {
      // Prefer spans that have a title attribute (WhatsApp puts the full name there)
      const titled = header.querySelectorAll('span[dir="auto"][title]');
      for (const span of titled) {
        const txt = span.getAttribute('title').trim();
        if (txt && txt.length > 1) return txt;
      }
      // Fallback: any span[dir="auto"] — read textContent
      const spans = header.querySelectorAll('span[dir="auto"]');
      for (const span of spans) {
        const txt = span.textContent.trim();
        if (txt && txt.length > 1 && !txt.includes('~')) return txt;
      }
    }
  } catch (_) {}

  // Strategy 3: selected conversation in the left sidebar
  try {
    const sidebarSelectors = [
      '[aria-selected="true"] [data-testid="cell-frame-title"] span',
      '[aria-selected="true"] span[dir="auto"]',
      '[aria-selected="true"] span[title]',
    ];
    for (const sel of sidebarSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const txt = (el.getAttribute('title') || el.textContent || '').trim();
        if (txt && txt.length > 1) return txt;
      }
    }
  } catch (_) {}

  return 'Unknown Chat';
}

// ---- WhatsApp: extract phone number or chat ID from DOM for direct link ----
// data-id on message bubbles looks like: "true_917568783307@c.us_3A2B88FB..."
// Format: "{direction}_{jid}_{messageId}" — we extract the JID (jid = phone@c.us or group@g.us)
function extractWhatsAppChatId() {
  try {
    // Message bubbles inside #main carry data-id with the JID embedded
    const msgEls = document.querySelectorAll('#main [data-id]');
    for (const el of msgEls) {
      const raw = el.getAttribute('data-id') || '';
      // Format: "true_919876543210@c.us_MESSAGEID" or "false_919876543210@c.us_MESSAGEID"
      const match = raw.match(/^(?:true|false)_(\d+@c\.us|[^_]+@g\.us)_/);
      if (match) return match[1]; // e.g. "917568783307@c.us"
    }
  } catch (_) {}

  return null;
}

// ===================================================================
// ===== URL shortening — per platform =====
// ===================================================================

function shortenUrl(url, platform) {
  try {
    if (platform === 'linkedin') {
      return url
        .replace('https://www.linkedin.com/messaging/thread/', 'thread/')
        .slice(0, 45) + '…';
    }
    if (platform === 'gmail') {
      // After our fix, the saved URL is always a canonical deep-link:
      //   https://mail.google.com/mail/u/0/#all/THREAD_ID
      // Also handle the case where we fell back to the raw URL (split-pane, no ID found):
      //   #inbox   ← no thread open, saved as fallback
      const threadMatch = url.match(/#(?:[a-z/]+\/)([A-Za-z0-9%]{6,})/);
      if (threadMatch) {
        const id = decodeURIComponent(threadMatch[1]);
        // Show just the last 10 chars of the ID so it fits the modal
        return `✉ gmail/…${id.slice(-10)}`;
      }
      const hashMatch = url.match(/#([a-z]+)/);
      return hashMatch ? `✉ gmail/${hashMatch[1]}` : '✉ gmail/inbox';
    }
    if (platform === 'outlook') {
      // After our fix, URL is either:
      //   https://outlook.live.com/mail/0/id/CONVID
      //   https://outlook.office.com/mail/id/CONVID
      // or the raw fallback URL (which is just /mail/inbox)
      const idMatch = url.match(/\/id\/([^/?#]+)/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        return `📧 outlook/…${id.slice(-12)}`;
      }
      // Fallback — just show the folder name from the path
      const pathParts = location.pathname.split('/').filter(Boolean);
      const folder = pathParts[pathParts.length - 1] || 'inbox';
      return `📧 outlook/${folder}`;
    }
    if (platform === 'whatsapp') {
      return url.replace('https://web.whatsapp.com/', 'wa/').slice(0, 40) + '…';
    }
  } catch (_) {}
  return url.slice(0, 45) + '…';
}

// ===== Follow-up day options =====
const FOLLOWUP_OPTIONS = [
  { label: '2 days',  days: 2  },
  { label: '4 days',  days: 4  },
  { label: '7 days',  days: 7  },
  { label: '15 days', days: 15 },
  { label: '30 days', days: 30 },
];

function daysFromNow(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setHours(9, 0, 0, 0); // 9 AM on that day
  return d;
}

// ===================================================================
// ===== Modal =====
// ===================================================================

async function openModal(contactName, threadUrl, platform, prefillDescription) {
  removeModal();

  // Refresh STAGES from storage so any settings changes are picked up immediately
  let _s = null;
  try {
    _s = await cloudStore.getSettings();
  } catch (err) {
    if (isExtensionContextInvalidated(err)) throw err;
  }
  if (_s && Array.isArray(_s.stages) && _s.stages.length > 0) {
    STAGES = _s.stages;
  } else {
    STAGES = DEFAULT_SETTINGS.stages;
  }

  const cfg = PLATFORM_CONFIG[platform] || PLATFORM_CONFIG.linkedin;
  let selectedDays = 2;

  const overlay = document.createElement('div');
  overlay.id = 'lts-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) removeModal();
  });

  const modal = document.createElement('div');
  modal.id = 'lts-modal';
  modal.setAttribute('role', 'dialog');
  modal.addEventListener('click', (e) => e.stopPropagation());

  const modalBody = document.createElement('div');
  modalBody.className = 'lts-modal-body';

  const modalFooter = document.createElement('div');
  modalFooter.className = 'lts-modal-footer';

  // ---- Header ----
  const header = document.createElement('div');
  header.className = 'lts-modal-header';
  header.style.setProperty('background', cfg.color, 'important');

  const title = document.createElement('h2');
  title.className = 'lts-modal-title';
  title.textContent = 'Save as Task';

  // Platform source badge (e.g. "LinkedIn", "WhatsApp")
  const platformLabels = {
    linkedin:  'LinkedIn',
    gmail:     'Gmail',
    outlook:   'Outlook',
    whatsapp:  'WhatsApp',
  };
  const sourceBadge = document.createElement('span');
  sourceBadge.className = 'lts-source-badge';
  sourceBadge.textContent = platformLabels[platform] || platform;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'lts-close-btn';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', removeModal);

  header.append(title, sourceBadge, closeBtn);

  // ---- First Name / Last Name (CRM) ----
  let emailPrefill = '';
  let titlePrefill = extractContactTitle(platform);
  let emailContext = null;

  if (platform === 'gmail') {
    const info = parseGmailContactInfo();
    if (info.primaryName) contactName = info.primaryName;
    else if (info.senderName) contactName = info.senderName;
    if (info.primaryEmail) emailPrefill = info.primaryEmail;
    else if (info.senderEmail) emailPrefill = info.senderEmail;
    if (info.subject) titlePrefill = info.subject;
    emailContext = {
      from: info.senderEmail || '',
      to: Array.isArray(info.toRecipients) ? info.toRecipients.map((r) => r.email).filter(Boolean) : [],
    };
  } else if (platform === 'outlook') {
    const info = parseOutlookContactInfo();
    if (info.senderName) contactName = info.senderName;
    if (info.senderEmail) emailPrefill = info.senderEmail;
    if (info.subject) titlePrefill = info.subject;
  }

  const parsed = parseContactName(contactName);
  const profileUrl = platform === 'linkedin' ? extractLinkedInProfileUrl() : '';

  const nameRow = document.createElement('div');
  nameRow.className = 'lts-field-group lts-name-row';

  const fnCol = document.createElement('div');
  fnCol.className = 'lts-name-col';
  const fnLabel = document.createElement('label');
  fnLabel.className = 'lts-field-label';
  fnLabel.textContent = 'First Name';
  fnLabel.htmlFor = 'lts-firstname';
  const fnInput = document.createElement('input');
  fnInput.type = 'text';
  fnInput.id = 'lts-firstname';
  fnInput.className = 'lts-input';
  fnInput.value = parsed.firstName;
  fnInput.placeholder = 'First name';
  fnCol.append(fnLabel, fnInput);

  const lnCol = document.createElement('div');
  lnCol.className = 'lts-name-col';
  const lnLabel = document.createElement('label');
  lnLabel.className = 'lts-field-label';
  lnLabel.textContent = 'Last Name';
  lnLabel.htmlFor = 'lts-lastname';
  const lnInput = document.createElement('input');
  lnInput.type = 'text';
  lnInput.id = 'lts-lastname';
  lnInput.className = 'lts-input';
  lnInput.value = parsed.lastName;
  lnInput.placeholder = 'Last name';
  lnCol.append(lnLabel, lnInput);

  nameRow.append(fnCol, lnCol);

  // ---- Title / Headline ----
  const titleRow = document.createElement('div');
  titleRow.className = 'lts-field-group';

  const titleLabel = document.createElement('label');
  titleLabel.className = 'lts-field-label';
  titleLabel.textContent = 'Title';
  titleLabel.htmlFor = 'lts-title';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.id = 'lts-title';
  titleInput.className = 'lts-input';
  titleInput.value = titlePrefill;
  titleInput.placeholder = 'e.g. CEO at Acme Corp';

  titleRow.append(titleLabel, titleInput);

  // ---- LinkedIn Profile URL ----
  const profileRow = document.createElement('div');
  profileRow.className = 'lts-field-group';

  const profileLabel = document.createElement('p');
  profileLabel.className = 'lts-field-label';
  profileLabel.textContent = 'LinkedIn Profile';

  const profileInput = document.createElement('input');
  profileInput.type = 'url';
  profileInput.id = 'lts-profile-url';
  profileInput.className = 'lts-input';
  profileInput.value = profileUrl;
  profileInput.placeholder = 'https://linkedin.com/in/...';

  profileRow.append(profileLabel, profileInput);

  // ---- Email (optional) ----
  const emailRow = document.createElement('div');
  emailRow.className = 'lts-field-group';

  const emailLabel = document.createElement('label');
  emailLabel.className = 'lts-field-label';
  emailLabel.textContent = 'Email';
  emailLabel.htmlFor = 'lts-email';

  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.id = 'lts-email';
  emailInput.className = 'lts-input';
  emailInput.value = emailPrefill;
  emailInput.placeholder = 'name@company.com (optional)';

  emailRow.append(emailLabel, emailInput);

  if (platform === 'gmail' && emailContext && (emailContext.from || (emailContext.to && emailContext.to.length))) {
    const emailMeta = document.createElement('p');
    emailMeta.className = 'lts-reminder-preview';
    const fromText = emailContext.from || 'unknown';
    const toText = (emailContext.to && emailContext.to.length)
      ? emailContext.to.join(', ')
      : 'unknown';
    emailMeta.textContent = `From: ${fromText} | To: ${toText}`;
    emailRow.appendChild(emailMeta);
  }

  // ---- Contact search (team contacts) ----
  const searchRow = document.createElement('div');
  searchRow.className = 'lts-field-group lts-contact-search';

  const searchLabel = document.createElement('label');
  searchLabel.className = 'lts-field-label';
  searchLabel.textContent = 'Search Contact';
  searchLabel.htmlFor = 'lts-contact-search';

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.id = 'lts-contact-search';
  searchInput.className = 'lts-input';
  searchInput.placeholder = 'Search by first name or last name';

  const searchResults = document.createElement('div');
  searchResults.className = 'lts-contact-results';
  searchResults.hidden = true;

  let searchTimer = null;

  const contactTitleFromDoc = (contact) => {
    const des = String(contact.designation || '').trim();
    const comp = String(contact.company || '').trim();
    if (des && comp) return `${des} at ${comp}`;
    return des || comp || '';
  };

  const applyContactToForm = (contact) => {
    fnInput.value = contact.firstName || '';
    lnInput.value = contact.lastName || '';
    const nameText = [contact.firstName || '', contact.lastName || ''].join(' ').trim() || contact.name || '';
    searchInput.value = nameText;
    profileInput.value = contact.linkedinUrl || '';
    emailInput.value = contact.email || '';
    if (!titleInput.value.trim()) {
      titleInput.value = contactTitleFromDoc(contact);
    }
  };

  const hideSearchResults = () => {
    searchResults.hidden = true;
    searchResults.innerHTML = '';
  };

  const renderSearchResults = (contacts) => {
    searchResults.innerHTML = '';
    if (!Array.isArray(contacts) || contacts.length === 0) {
      hideSearchResults();
      return;
    }

    contacts.forEach((contact) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'lts-contact-option';
      const displayName = [contact.firstName || '', contact.lastName || ''].join(' ').trim() || contact.name || 'Unknown';
      const subtitle = contactTitleFromDoc(contact) || contact.email || '';
      option.innerHTML = `
        <span class="lts-contact-option__name">${displayName}</span>
        <span class="lts-contact-option__meta">${subtitle}</span>
      `;
      option.addEventListener('click', () => {
        applyContactToForm(contact);
        hideSearchResults();
      });
      searchResults.appendChild(option);
    });

    searchResults.hidden = false;
  };

  searchInput.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
      hideSearchResults();
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const contacts = await cloudStore.searchTeamContacts(q, 8);
        renderSearchResults(contacts);
      } catch (_) {
        hideSearchResults();
      }
    }, 180);
  });

  searchInput.addEventListener('focus', () => {
    if (searchResults.children.length > 0) searchResults.hidden = false;
  });

  modal.addEventListener('click', (e) => {
    if (!searchRow.contains(e.target)) hideSearchResults();
  });

  searchRow.append(searchLabel, searchInput, searchResults);

  // ---- Stage selector ----
  let selectedStage = 'prospect';

  const owners = (_s && Array.isArray(_s.owners)) ? _s.owners : [];
  let selectedOwner = 'owner_default';
  try {
    const ownerData = await chrome.storage.sync.get('currentOwner');
    selectedOwner = ownerData.currentOwner || selectedOwner;
  } catch (_) {}
  if (owners.length === 1) {
    selectedOwner = owners[0].id;
  } else if (owners.length > 1 && !owners.find((o) => o.id === selectedOwner)) {
    selectedOwner = owners[0].id;
  }

  let ownerRow = null;
  if (owners.length > 1) {
    ownerRow = document.createElement('div');
    ownerRow.className = 'lts-field-group';

    const ownerLabel = document.createElement('label');
    ownerLabel.className = 'lts-field-label';
    ownerLabel.textContent = 'Owner';
    ownerLabel.htmlFor = 'lts-owner';

    const ownerSelect = document.createElement('select');
    ownerSelect.id = 'lts-owner';
    ownerSelect.className = 'lts-input lts-stage-select';

    owners.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label || o.id;
      if (o.id === selectedOwner) opt.selected = true;
      ownerSelect.appendChild(opt);
    });

    ownerSelect.addEventListener('change', () => {
      selectedOwner = ownerSelect.value;
      try {
        chrome.storage.sync.set({ currentOwner: selectedOwner });
      } catch (_) {}
    });

    ownerRow.append(ownerLabel, ownerSelect);
  }

  const stageRow = document.createElement('div');
  stageRow.className = 'lts-field-group';

  const stageLabel = document.createElement('p');
  stageLabel.className = 'lts-field-label';
  stageLabel.textContent = 'Stage';

  const stageSelect = document.createElement('select');
  stageSelect.id = 'lts-stage';
  stageSelect.className = 'lts-input lts-stage-select';
  STAGES.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.value;
    opt.textContent = s.label;
    if (s.value === selectedStage) opt.selected = true;
    stageSelect.appendChild(opt);
  });
  stageSelect.addEventListener('change', () => { selectedStage = stageSelect.value; });

  stageRow.append(stageLabel, stageSelect);

  // ---- Tags (multi-select + create) ----
  let teamTags = [];
  try {
    const fetchedTags = await cloudStore.listTeamTags(200);
    teamTags = Array.isArray(fetchedTags) ? fetchedTags : [];
  } catch (_) {
    teamTags = [];
  }
  const selectedTagLabels = new Set();

  const tagsRow = document.createElement('div');
  tagsRow.className = 'lts-field-group';

  const tagsLabel = document.createElement('label');
  tagsLabel.className = 'lts-field-label';
  tagsLabel.textContent = 'Tags';
  tagsLabel.htmlFor = 'lts-tag-create';

  const tagsChips = document.createElement('div');
  tagsChips.className = 'lts-tag-chips';

  const tagsCreateRow = document.createElement('div');
  tagsCreateRow.className = 'lts-tag-create-row';

  const tagsCreateInput = document.createElement('input');
  tagsCreateInput.type = 'text';
  tagsCreateInput.id = 'lts-tag-create';
  tagsCreateInput.className = 'lts-input';
  tagsCreateInput.placeholder = 'Create a tag and press Enter';

  const tagsCreateBtn = document.createElement('button');
  tagsCreateBtn.type = 'button';
  tagsCreateBtn.className = 'lts-pill';
  tagsCreateBtn.textContent = '+ Add';

  const tagsStatus = document.createElement('p');
  tagsStatus.className = 'lts-reminder-preview';
  tagsStatus.hidden = true;

  const renderTagChips = () => {
    tagsChips.innerHTML = '';
    (Array.isArray(teamTags) ? teamTags : []).forEach((tag) => {
      const label = String((tag && tag.label) || '').trim();
      if (!label) return;

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lts-tag-chip';
      chip.textContent = label;
      if (selectedTagLabels.has(label)) chip.classList.add('lts-tag-chip--active');
      chip.addEventListener('click', () => {
        if (selectedTagLabels.has(label)) selectedTagLabels.delete(label);
        else selectedTagLabels.add(label);
        renderTagChips();
      });
      tagsChips.appendChild(chip);
    });
  };

  const createTag = async () => {
    const raw = String(tagsCreateInput.value || '').trim();
    if (!raw) return;
    tagsStatus.hidden = true;
    tagsStatus.textContent = '';

    const existing = teamTags.find((t) => String((t && t.label) || '').trim().toLowerCase() === raw.toLowerCase());
    if (existing) {
      selectedTagLabels.add(existing.label);
      tagsCreateInput.value = '';
      renderTagChips();
      return;
    }

    let created = null;
    try {
      created = await cloudStore.createTeamTag({ label: raw });
    } catch (_) {
      created = null;
    }

    if (created && created.label) {
      teamTags.push(created);
      selectedTagLabels.add(created.label);
    } else {
      tagsStatus.hidden = false;
      tagsStatus.textContent = 'Could not create tag in cloud. Please try again.';
      return;
    }

    tagsCreateInput.value = '';
    renderTagChips();
  };

  tagsCreateBtn.addEventListener('click', createTag);
  tagsCreateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createTag();
    }
  });

  renderTagChips();
  tagsCreateRow.append(tagsCreateInput, tagsCreateBtn);
  tagsRow.append(tagsLabel, tagsChips, tagsCreateRow, tagsStatus);

  // ---- Follow-up selector ----
  const followupRow = document.createElement('div');
  followupRow.className = 'lts-field-group';

  const followupLabel = document.createElement('p');
  followupLabel.className = 'lts-field-label';
  followupLabel.textContent = 'Follow up in';

  const pillsContainer = document.createElement('div');
  pillsContainer.className = 'lts-pills';

  const activatePill = (activePill, days) => {
    selectedDays = days;
    pillsContainer.querySelectorAll('.lts-pill').forEach(p => {
      p.classList.remove('lts-pill--active');
      p.style.removeProperty('background');
      p.style.removeProperty('border-color');
    });
    activePill.classList.add('lts-pill--active');
    activePill.style.setProperty('background', cfg.color, 'important');
    activePill.style.setProperty('border-color', cfg.color, 'important');
    const preview = document.getElementById('lts-reminder-preview');
    if (preview) preview.textContent = formatPreviewDate(daysFromNow(selectedDays));
  };

  FOLLOWUP_OPTIONS.forEach(opt => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'lts-pill' + (opt.days === selectedDays ? ' lts-pill--active' : '');
    pill.textContent = opt.label;
    pill.dataset.days = opt.days;

    if (opt.days === selectedDays) {
      pill.style.setProperty('background', cfg.color, 'important');
      pill.style.setProperty('border-color', cfg.color, 'important');
    }

    pill.addEventListener('click', () => {
      customInput.style.setProperty('display', 'none', 'important');
      activatePill(pill, opt.days);
    });

    pillsContainer.appendChild(pill);
  });

  // Custom pill + inline input
  const customPill = document.createElement('button');
  customPill.type = 'button';
  customPill.className = 'lts-pill';
  customPill.textContent = 'Custom';

  const customInput = document.createElement('input');
  customInput.type = 'number';
  customInput.min = '1';
  customInput.max = '365';
  customInput.placeholder = 'days';
  customInput.className = 'lts-custom-days-input';
  customInput.style.setProperty('display', 'none', 'important');

  customPill.addEventListener('click', () => {
    activatePill(customPill, selectedDays);
    customInput.style.setProperty('display', 'inline-block', 'important');
    customInput.focus();
    customInput.select();
  });

  customInput.addEventListener('input', () => {
    const v = parseInt(customInput.value, 10);
    if (v > 0 && v <= 365) {
      selectedDays = v;
      const preview = document.getElementById('lts-reminder-preview');
      if (preview) preview.textContent = formatPreviewDate(daysFromNow(selectedDays));
    }
  });

  pillsContainer.appendChild(customPill);
  pillsContainer.appendChild(customInput);

  const reminderPreview = document.createElement('p');
  reminderPreview.id = 'lts-reminder-preview';
  reminderPreview.className = 'lts-reminder-preview';
  reminderPreview.textContent = formatPreviewDate(daysFromNow(selectedDays));

  followupRow.append(followupLabel, pillsContainer, reminderPreview);

  // ---- Description (optional) ----
  const descRow = document.createElement('div');
  descRow.className = 'lts-field-group';

  const descLabel = document.createElement('label');
  descLabel.htmlFor = 'lts-desc';
  descLabel.className = 'lts-field-label';

  const descLabelText = document.createElement('span');
  descLabelText.textContent = 'Notes';
  const descOptional = document.createElement('span');
  descOptional.className = 'lts-optional';
  descOptional.textContent = ' (optional)';
  descLabel.append(descLabelText, descOptional);

  const descInput = document.createElement('textarea');
  descInput.id = 'lts-desc';
  descInput.className = 'lts-input lts-textarea';
  descInput.placeholder = 'e.g. Discussed partnership, follow up on proposal…';
  descInput.rows = 3;
  descInput.maxLength = 5000;
  if (prefillDescription) {
    descInput.value = prefillDescription;
    descInput.rows = 5;
  }

  descRow.append(descLabel, descInput);

  // ---- Error ----
  const errorEl = document.createElement('p');
  errorEl.id = 'lts-error';
  errorEl.className = 'lts-error lts-hidden';
  errorEl.setAttribute('role', 'alert');

  // ---- Save button ----
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save Task';
  saveBtn.className = 'lts-save-btn';
  saveBtn.style.setProperty('background', cfg.color, 'important');
  saveBtn.addEventListener('mouseenter', () => saveBtn.style.setProperty('background', cfg.hover, 'important'));
  saveBtn.addEventListener('mouseleave', () => saveBtn.style.setProperty('background', cfg.color, 'important'));

  saveBtn.addEventListener('click', () => {
    const finalFirstName = fnInput.value.trim();
    const finalLastName = lnInput.value.trim();
    const finalProfileUrl = profileInput.value.trim();
    const finalEmail = emailInput.value.trim();
    const finalTitle = titleInput.value.trim();
    const finalContactName = `${finalFirstName} ${finalLastName}`.trim() || contactName;
    const finalTags = Array.from(selectedTagLabels);
    handleSave(finalContactName, threadUrl, descInput, selectedDays, errorEl, platform, selectedStage, finalFirstName, finalLastName, finalProfileUrl, finalEmail, finalTitle, selectedOwner, emailContext, finalTags);
  });

  // ---- Assemble ----
  modalBody.append(searchRow, nameRow, titleRow, profileRow, emailRow);
  if (ownerRow) modalBody.appendChild(ownerRow);
  modalBody.append(stageRow, tagsRow, followupRow, descRow);
  modalFooter.append(errorEl, saveBtn);
  modal.append(header, modalBody, modalFooter);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  setTimeout(() => descInput.focus(), 50);

  const escHandler = (e) => {
    if (e.key === 'Escape') { removeModal(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
}

function removeModal() {
  const el = document.getElementById('lts-overlay');
  if (el) el.remove();
}

function isExtensionContextInvalidated(err) {
  return String(err && err.message ? err.message : err).includes('Extension context invalidated');
}

function showExtensionReloadToast(message) {
  const existing = document.getElementById('lts-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'lts-toast';
  toast.textContent = message || 'Extension updated. Refresh this Gmail tab and try again.';
  toast.style.setProperty('background', '#d95f5f', 'important');
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add('lts-toast--visible'), 10);
  setTimeout(() => {
    toast.classList.remove('lts-toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

async function handleSave(contactName, threadUrl, descInput, selectedDays, errorEl, platform, stage, firstName, lastName, profileUrl, email, title, selectedOwnerId, emailContext, selectedTags) {
  try {
    const description = descInput.value.trim();
    const remindAt = daysFromNow(selectedDays);

    hideError(errorEl);

    // Read active owner from storage (set by popup owner switcher)
    let owner = String(selectedOwnerId || '').trim() || 'owner_default';
    if (!selectedOwnerId) {
      try {
        const ownerData = await chrome.storage.sync.get('currentOwner');
        owner = ownerData.currentOwner || 'owner_default';
      } catch (_) {
        owner = 'owner_default';
      }
    }

    // Validate selected owner against team owner docs/settings.
    // If the selected owner is stale, fall back to the first configured owner id.
    try {
      const settings = await cloudStore.getSettings();
      const owners = (settings && Array.isArray(settings.owners)) ? settings.owners : [];
      if (owners.length === 1) {
        owner = owners[0].id;
      } else if (owners.length > 0 && !owners.find((o) => o.id === owner)) {
        owner = owners[0].id;
      }
    } catch (_) {
      // Keep best-effort selected owner.
    }

    // Get creator identity for attribution
    let authData = null;
    try { authData = (await chrome.storage.local.get('auth')).auth || null; } catch (_) {}

    const now = new Date();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedFromEmail = String((emailContext && emailContext.from) || '').trim().toLowerCase();
    const normalizedToEmails = Array.isArray(emailContext && emailContext.to)
      ? emailContext.to.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
      : [];
    const normalizedTags = Array.isArray(selectedTags)
      ? selectedTags.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    const normalizedType = (
      platform === 'linkedin' ? 'linkedin'
        : (platform === 'gmail' || platform === 'outlook') ? 'email'
          : platform === 'whatsapp' ? 'meeting'
            : 'linkedin'
    );
    const task = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: normalizedType,
      platform: platform || 'linkedin',
      contact: {
        name: contactName || '',
        firstName: firstName || '',
        lastName: lastName || '',
        profileUrl: profileUrl || '',
        title: title || '',
        email: normalizedEmail,
      },
      stage: stage || 'prospect',
      status: 'pending',
      description,
      completed: false,
      // ownerId is always the selected owner document id from team settings
      ownerId: owner,
      assignedTo: '',
      followUpDays: selectedDays,
      remindAt: now.getTime() + selectedDays * 86400000,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
      threadUrl: threadUrl || '',
      priority: 'medium',
      tags: normalizedTags,
      // Creator attribution as Firestore-style user reference
      createdBy: authData && authData.localId ? `users/${authData.localId}` : '',
      // Keep flat fields for backwards-compat with existing render code
      contactName: contactName || '',
      firstName: firstName || '',
      lastName: lastName || '',
      profileUrl: profileUrl || '',
      email: normalizedEmail,
      title: title || '',
      owner,
      emailFrom: normalizedFromEmail,
      emailTo: normalizedToEmails,
    };

    if (cloudStore && (platform === 'linkedin' || platform === 'gmail' || platform === 'outlook')) {
      await cloudStore.ensureTeamContact({
        name: contactName || '',
        firstName: firstName || '',
        lastName: lastName || '',
        linkedinUrl: profileUrl || '',
        email: normalizedEmail,
        phone: '',
        company: '',
        designation: '',
        tags: normalizedTags,
      }).catch(() => null);
    }

    let persisted = false;
    try {
      if (cloudStore) {
        await cloudStore.saveTask(task);
        persisted = true;
      }
    } catch (_) {
      persisted = false;
    }

    if (!persisted) {
      const local = await chrome.storage.local.get('tasks').catch(() => ({}));
      const localTasks = Array.isArray(local.tasks) ? local.tasks : [];
      await chrome.storage.local.set({ tasks: [...localTasks, task] });
      persisted = true;
    }

    chrome.runtime.sendMessage({ action: 'CREATE_ALARM', task });
    removeModal();
    showSavedToast(contactName, selectedDays, platform);
  } catch (err) {
    if (isExtensionContextInvalidated(err)) {
      showError(errorEl, 'Extension updated. Refresh this Gmail tab, then try again.');
      return;
    }
    showError(errorEl, 'Failed to save. Please try again.');
    console.error('[TSP] Save error:', err);
  }
}

// ---- Success toast ----
function showSavedToast(contactName, days, platform) {
  const existing = document.getElementById('lts-toast');
  if (existing) existing.remove();

  const cfg = PLATFORM_CONFIG[platform] || PLATFORM_CONFIG.linkedin;

  const toast = document.createElement('div');
  toast.id = 'lts-toast';
  toast.textContent = `✓ Task saved! Following up in ${days} days.`;
  toast.style.setProperty('background', cfg.color, 'important');
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add('lts-toast--visible'), 10);
  setTimeout(() => {
    toast.classList.remove('lts-toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ---- "Open an email first" toast (Gmail/Outlook, no thread visible) ----
function showNoThreadToast(platform) {
  const existing = document.getElementById('lts-toast');
  if (existing) existing.remove();

  const msg = platform === 'outlook'
    ? '⚠️ Open an email to save it as a task'
    : '⚠️ Open an email thread first, then click Save';

  const toast = document.createElement('div');
  toast.id = 'lts-toast';
  toast.textContent = msg;
  // Use a neutral amber colour so it reads as a warning, not success
  toast.style.setProperty('background', '#b45309', 'important');
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add('lts-toast--visible'), 10);
  setTimeout(() => {
    toast.classList.remove('lts-toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function showError(el, msg) { el.textContent = msg; el.classList.remove('lts-hidden'); }
function hideError(el) { el.textContent = ''; el.classList.add('lts-hidden'); }

function formatPreviewDate(date) {
  return 'Reminder: ' + date.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }) + ' at 9:00 AM';
}
