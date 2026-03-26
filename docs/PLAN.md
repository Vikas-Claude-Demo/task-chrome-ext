# Plan: Nudge

## Vision
Nudge is a Chrome extension that makes it effortless to save follow-up tasks from messaging platforms (LinkedIn, Gmail, Outlook, WhatsApp) with one click. It provides smart reminders via Chrome notifications and a CRM-style dashboard to manage contacts through a sales/outreach pipeline.

## Goals
- One-click task creation from LinkedIn Messaging, Gmail, Outlook Web, and WhatsApp Web
- Smart reminders via Chrome alarms and notifications
- Full dashboard with filtering, search, sorting, card/table views, and contact timeline
- CRM pipeline stages (Prospect, Lead, Interested, Not Interested, Nurturing, Win, Dead)
- Multi-owner support for team workflows
- Cloud sync via Firebase/Firestore with guest and authenticated modes
- Free tier with task limit (configurable via `FREE_TASK_LIMIT`)

## Out of Scope
- Native mobile app
- Browser extensions for non-Chromium browsers (Firefox, Safari)
- Full CRM features (deals, revenue tracking, email campaigns)
- Real-time collaboration / multi-user editing

## Tech Stack
| Layer          | Choice                       | Reason                                              |
|----------------|------------------------------|-----------------------------------------------------|
| Platform       | Chrome Extension (MV3)       | Direct access to messaging platforms via content scripts |
| Language       | JavaScript (ES6+)            | No build step needed, fast iteration                 |
| Backend        | Firebase/Firestore (REST)    | Serverless, free tier, no SDK bundle size            |
| Auth           | Firebase Identity Toolkit    | Email/password auth, integrates with Firestore rules |
| Local Storage  | chrome.storage.local         | Persists across service worker restarts              |
| Notifications  | chrome.alarms + chrome.notifications | Reliable scheduling even when SW sleeps       |

## Folder Structure
```
/
├── manifest.json              # Extension manifest (permissions, content scripts, service worker)
├── background.js              # Alarms, notifications, badge count
├── content.js                 # Platform-specific "Save as Task" button + modal
├── content.css                # Injected UI styles
├── shared/                    # Code shared across popup, dashboard, content scripts
│   ├── config.js              # Central config constants
│   └── firebase-storage.js    # Firestore REST client, auth, sync logic
├── popup/                     # Extension popup (quick task view)
├── dashboard/                 # Full-page dashboard (table/card views, timeline, settings)
├── home/                      # Onboarding/landing page
├── icons/                     # Extension icons
└── docs/                      # Project documentation
```

## How to Run
```bash
# No build step required — pure vanilla JS

# To test:
# 1. Open chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked" and select this project folder
# 4. Open LinkedIn Messaging, Gmail, Outlook, or WhatsApp Web
# 5. Look for the floating "Save as Task" button
```

## Milestones
- [x] Phase 1: Core task saving from LinkedIn Messaging
- [x] Phase 2: Multi-platform support (Gmail, Outlook, WhatsApp)
- [x] Phase 3: Dashboard with filtering, search, card/table views
- [x] Phase 4: Firebase auth + cloud sync (guest & authenticated)
- [x] Phase 5: CRM pipeline stages, multi-owner, settings modal
- [x] Phase 6: Contact timeline panel, onboarding home page
- [ ] Phase 7: Polish, bug fixes, Chrome Web Store submission
