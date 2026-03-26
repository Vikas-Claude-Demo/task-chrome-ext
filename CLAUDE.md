# Project: Nudge

## What This Is
Nudge is a Chrome extension that lets users save follow-up tasks directly from LinkedIn Messaging, Gmail, Outlook Web, and WhatsApp Web. It provides smart reminders via Chrome notifications and a full CRM-style dashboard with pipeline stages, task owners, filtering, search, and a contact timeline. Data syncs to Firebase/Firestore with guest and authenticated modes.

## Read These Before Starting Work
1. `docs/PLAN.md`       — overall plan and tech stack
2. `docs/STATUS.md`     — what's done, in progress, and up next
3. `docs/HANDOFF.md`    — what the last session left for you

## Rules
- Always read all docs/ files before starting any work
- Use `/start` at the beginning of every session
- Use `/done` at the end of every session
- Never mark something done unless it's tested and working
- Log all architectural decisions in `docs/DECISIONS.md`
- Keep `docs/HANDOFF.md` short and actionable

## Tech Stack
- **Language**: JavaScript (ES6+)
- **Platform**: Chrome Extension (Manifest V3)
- **Backend**: Firebase/Firestore (REST API, no SDK — direct fetch calls)
- **Auth**: Firebase Identity Toolkit (email/password)
- **Storage**: `chrome.storage.local` for local state, Firestore for cloud sync

## Project Structure
```
/
├── manifest.json              # Chrome extension manifest (MV3)
├── background.js              # Service worker — alarms, notifications, badge
├── content.js                 # Floating "Save as Task" button + modal (LinkedIn, Gmail, Outlook, WhatsApp)
├── content.css                # Styles for injected content script UI
├── shared/
│   ├── config.js              # Central config (e.g., FREE_TASK_LIMIT)
│   └── firebase-storage.js    # Firestore REST client, auth, guest/user sync
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.css
│   └── popup.js
├── dashboard/
│   ├── dashboard.html         # Full-page dashboard (opened from popup)
│   ├── dashboard.css
│   └── dashboard.js
├── home/
│   ├── home.html              # Landing/onboarding page
│   ├── home.css
│   ├── home.js
│   └── images/                # Onboarding slide SVGs
├── icons/                     # Extension icons (16, 48, 128)
└── docs/                      # Project docs (plan, status, decisions, handoff)
```

## Coding Conventions
- Use `const`/`let`, never `var`
- Prefer arrow functions for callbacks
- Use `async/await` over raw Promise chains
- Follow Chrome Extension Manifest V3 patterns (service workers, not persistent background pages)
- Keep content scripts minimal; do heavy logic in the background service worker
- Use `chrome.storage.local` for persistent state; avoid `localStorage` in extensions

## Chrome Extension Notes
- Always declare permissions in `manifest.json` with minimum necessary scope
- Use `chrome.runtime.sendMessage` / `chrome.runtime.onMessage` for communication between scripts
- Test by loading unpacked extension at `chrome://extensions` with Developer Mode enabled
- Check the service worker console via the "Inspect views" link on the extensions page

## Development Guidelines
- Do not commit sensitive keys or tokens
- Keep the manifest `permissions` array minimal
- Prefer `chrome.scripting.executeScript` over inline scripts to comply with CSP
- Write self-contained, idempotent content scripts where possible
