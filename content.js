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

// ===== Create the floating button once =====
function createFloatingButton() {
  if (document.getElementById('lts-float-btn')) return;

  const platform = detectPlatform();
  if (!platform) return;
  const cfg = PLATFORM_CONFIG[platform];

  const btn = document.createElement('button');
  btn.id = 'lts-float-btn';
  btn.textContent = cfg.label;
  btn.title = `${cfg.label} (Nudge)`;

  // Override CSS color vars with platform color
  btn.style.setProperty('background', cfg.color, 'important');

  btn.addEventListener('mouseenter', () => {
    btn.style.setProperty('background', cfg.hover, 'important');
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.setProperty('background', cfg.color, 'important');
  });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const contactName = extractContactName(platform);

    // For Gmail/Outlook: warn if no email is open
    if ((platform === 'gmail' || platform === 'outlook') && contactName === 'Open an email first') {
      showNoThreadToast(platform);
      return;
    }

    // Use a deep-link thread URL (not raw location.href which may lack thread ID in split-pane)
    const threadUrl = getThreadUrl(platform);
    openModal(contactName, threadUrl, platform).catch((err) => {
      if (isExtensionContextInvalidated(err)) {
        showExtensionReloadToast();
        return;
      }
      console.error('[TSP] openModal error:', err);
      showExtensionReloadToast('Could not open task modal. Refresh this tab and try again.');
    });
  });

  document.body.appendChild(btn);
}

// ===== Show/hide button based on page =====
function updateButtonVisibility() {
  const btn = document.getElementById('lts-float-btn');
  if (!btn) return;
  const show = shouldShowButton();
  btn.style.display = show ? 'flex' : 'none';

  // Also update button color in case platform changed (unlikely but safe)
  if (show) {
    const cfg = PLATFORM_CONFIG[detectPlatform()];
    if (cfg) btn.style.setProperty('background', cfg.color, 'important');
  }
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
  createFloatingButton();
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

// ---- LinkedIn ----
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
      if (el && el.textContent.trim()) return el.textContent.trim();
    } catch (_) {}
  }
  for (const containerSel of ['.msg-thread', '.scaffold-layout__main']) {
    const container = document.querySelector(containerSel);
    if (!container) continue;
    for (const tag of ['h1', 'h2', 'h3']) {
      const el = container.querySelector(tag);
      if (el && el.textContent.trim().length > 1) return el.textContent.trim();
    }
  }
  return 'Unknown Contact';
}

// ---- Gmail ----
function extractGmailName() {
  let sender = '';
  let subject = '';

  // ── Find the reading pane root first ─────────────────────────────────────
  // All extractions should be scoped INSIDE the reading pane, not the full
  // document — otherwise we accidentally read list-row data from other emails.
  const pane = getGmailReadingPane();

  // ---- Subject ----
  // .hP is the thread subject heading rendered inside the open reading pane.
  const subjectSelectors = ['.hP', 'h2.hP', '.ha h2', 'h1', 'h2'];
  for (const sel of subjectSelectors) {
    try {
      // Prefer scoped to pane; fall back to document if pane not found
      const root = pane || document;
      const el = root.querySelector(sel);
      if (el && el.textContent.trim()) {
        subject = el.textContent.trim().replace(/\s*\(\d+\)\s*$/, '').trim();
        break;
      }
    } catch (_) {}
  }

  // ---- Sender ----
  // .gD inside [data-expanded="true"] = the sender span of the expanded message.
  // Gmail sets a 'name' attribute on .gD with the display name.
  const senderSelectors = [
    '[data-expanded="true"] .gD',
    '[data-expanded="true"] [email]',
    '.aqJ .gD',        // expanded message header cell
    '.adn.ads .gD',    // another expanded state class
    '.gD[name]',       // any .gD with explicit name attr
    '.gD[email]',      // any .gD with email attr
  ];
  for (const sel of senderSelectors) {
    try {
      const root = pane || document;
      const el = root.querySelector(sel);
      if (el) {
        const nameAttr = el.getAttribute('name') || el.getAttribute('data-name');
        const txt = nameAttr ? nameAttr.trim() : el.textContent.trim();
        // Reject bare email addresses as the display name (use as last resort)
        if (txt && txt.length > 1 && !txt.includes('@')) { sender = txt; break; }
        if (txt && txt.length > 1 && !sender) { sender = txt; } // email addr fallback
      }
    } catch (_) {}
  }

  // ---- Fallback: document.title ────────────────────────────────────────────
  // Gmail sets title to "Subject - me@gmail.com - Gmail" when a thread is open,
  // and "Inbox (5) - me@gmail.com - Gmail" when it's not.
  if (!subject) {
    const stripped = document.title
      .replace(/ - Gmail$/, '')
      .replace(/ - [^-]+@[^-]+(\.\w+)+$/, '') // remove "- email@domain" suffix
      .trim();
    const genericLabels = /^(Inbox|Sent|Drafts|Spam|Trash|Starred|Snoozed|All Mail|Important)/i;
    if (stripped && !genericLabels.test(stripped)) {
      subject = stripped.replace(/\s*\(\d+\)\s*$/, '').trim();
    }
  }

  if (sender && subject) return `${sender} — ${subject}`;
  if (subject) return subject;
  if (sender)  return sender;
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
  let sender = '';
  let subject = '';

  // Sender
  const senderSelectors = [
    '[data-testid="senderName"]',
    '.ms-Persona-primaryText',
    '.allowTextSelection [data-testid="sender"] span',
    '.oMY5O',    // OWA sender name class (varies)
    '.RPcS5b',
    '.UHiM0',
  ];
  for (const sel of senderSelectors) {
    try {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 1) { sender = el.textContent.trim(); break; }
    } catch (_) {}
  }

  // Subject
  const subjectSelectors = [
    '[data-testid="subject"]',
    '.OZZZK',    // Outlook subject in reading pane
    '.ovuGFd',
    '[aria-label*="Subject"] span',
    'h1[role="heading"]',
    'h2[role="heading"]',
  ];
  for (const sel of subjectSelectors) {
    try {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 1) { subject = el.textContent.trim(); break; }
    } catch (_) {}
  }

  // Fallback: document.title
  // Outlook title formats:
  //   "Re: Subject - Outlook"     ← email open
  //   "Inbox - Outlook"           ← no email open
  if (!sender && !subject) {
    const stripped = document.title
      .replace(/ - (Outlook|Microsoft 365|Mail).*$/, '')
      .trim();
    const genericLabels = /^(Inbox|Sent Items|Drafts|Junk Email|Deleted Items|Archive|Calendar|People|Tasks)/i;
    if (stripped && !genericLabels.test(stripped)) {
      subject = stripped;
    }
  }

  if (sender && subject) return `${sender} — ${subject}`;
  if (sender)  return sender;
  if (subject) return subject;
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

async function openModal(contactName, threadUrl, platform) {
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

  // ---- Contact name ----
  const contactRow = document.createElement('div');
  contactRow.className = 'lts-field-group';

  const contactLabel = document.createElement('p');
  contactLabel.className = 'lts-field-label';
  contactLabel.textContent = 'Contact';

  const contactValue = document.createElement('p');
  contactValue.className = 'lts-contact-name';
  contactValue.textContent = contactName;

  contactRow.append(contactLabel, contactValue);

  // ---- Thread URL (readonly link) ----
  const threadRow = document.createElement('div');
  threadRow.className = 'lts-field-group';

  const threadLabel = document.createElement('p');
  threadLabel.className = 'lts-field-label';
  threadLabel.textContent = cfg.thread; // platform-specific label

  const threadLink = document.createElement('a');
  threadLink.className = 'lts-thread-url';
  threadLink.href = threadUrl;
  threadLink.target = '_blank';
  threadLink.rel = 'noopener noreferrer';
  threadLink.textContent = shortenUrl(threadUrl, platform);
  threadLink.title = threadUrl;

  threadRow.append(threadLabel, threadLink);

  // ---- Stage selector ----
  let selectedStage = 'prospect';

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

  // ---- Follow-up selector ----
  const followupRow = document.createElement('div');
  followupRow.className = 'lts-field-group';

  const followupLabel = document.createElement('p');
  followupLabel.className = 'lts-field-label';
  followupLabel.textContent = 'Follow up in';

  const pillsContainer = document.createElement('div');
  pillsContainer.className = 'lts-pills';

  FOLLOWUP_OPTIONS.forEach(opt => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'lts-pill' + (opt.days === selectedDays ? ' lts-pill--active' : '');
    pill.textContent = opt.label;
    pill.dataset.days = opt.days;

    // Active pill uses platform color
    if (opt.days === selectedDays) {
      pill.style.setProperty('background', cfg.color, 'important');
      pill.style.setProperty('border-color', cfg.color, 'important');
    }

    pill.addEventListener('click', () => {
      selectedDays = opt.days;
      pillsContainer.querySelectorAll('.lts-pill').forEach(p => {
        p.classList.remove('lts-pill--active');
        p.style.removeProperty('background');
        p.style.removeProperty('border-color');
      });
      pill.classList.add('lts-pill--active');
      pill.style.setProperty('background', cfg.color, 'important');
      pill.style.setProperty('border-color', cfg.color, 'important');

      const preview = document.getElementById('lts-reminder-preview');
      if (preview) preview.textContent = formatPreviewDate(daysFromNow(selectedDays));
    });

    pillsContainer.appendChild(pill);
  });

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
  descInput.maxLength = 500;

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
    handleSave(contactName, threadUrl, descInput, selectedDays, errorEl, platform, selectedStage);
  });

  // ---- Assemble ----
  modal.append(header, contactRow, threadRow, stageRow, followupRow, descRow, errorEl, saveBtn);
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

async function handleSave(contactName, threadUrl, descInput, selectedDays, errorEl, platform, stage) {
  try {
    const description = descInput.value.trim();
    const remindAt = daysFromNow(selectedDays);

    hideError(errorEl);

    // Read active owner from storage (set by popup owner switcher)
    let owner = 'owner_default';
    try {
      const ownerData = await chrome.storage.sync.get('currentOwner');
      owner = ownerData.currentOwner || 'owner_default';
    } catch (_) {
      owner = 'owner_default';
    }

    const task = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      contactName,
      threadUrl,
      description,
      remindAt: remindAt.getTime(),
      followupDays: selectedDays,
      createdAt: Date.now(),
      completed: false,
      platform: platform || 'linkedin',
      stage: stage || 'prospect',
      owner,
    };

    let tasks = [];
    try {
      tasks = cloudStore ? await cloudStore.getTasks() : [];
    } catch (_) {
      const local = await chrome.storage.local.get('tasks').catch(() => ({}));
      tasks = Array.isArray(local.tasks) ? local.tasks : [];
    }

    const nextTasks = [...tasks, task];
    let persisted = false;
    try {
      if (cloudStore) {
        await cloudStore.setTasks(nextTasks);
        persisted = true;
      }
    } catch (_) {
      persisted = false;
    }

    if (!persisted) {
      await chrome.storage.local.set({ tasks: nextTasks });
      persisted = true;
    }

    if (!persisted) {
      throw new Error('SAVE_PERSIST_FAILED');
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
