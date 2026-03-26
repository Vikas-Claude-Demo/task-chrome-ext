# Architectural Decisions

A log of key technical decisions made during this project. Append new entries — never delete old ones.

---

## 2026-02-26 — Manifest V3 with no build step

**Decision:** Use Chrome Extension Manifest V3 with vanilla JavaScript — no bundler, no framework.
**Reason:** Keeps the project simple, avoids build complexity, and allows fast iteration. MV3 is required for new Chrome Web Store submissions.
**Alternatives considered:** React/Preact for UI, Webpack/Vite bundler — rejected to keep zero-dependency simplicity.

---

## 2026-02-26 — Firebase REST API instead of Firebase SDK

**Decision:** Call Firestore and Identity Toolkit via direct REST/fetch instead of importing the Firebase JS SDK.
**Reason:** The Firebase SDK is large (~100KB+) and would need a bundler for Chrome extensions. REST calls keep the extension lightweight and avoid CSP issues.
**Alternatives considered:** Firebase JS SDK (too large), Supabase (less familiar), custom backend (unnecessary overhead).

---

## 2026-02-26 — Guest mode with anonymous auth

**Decision:** Support a guest mode using Firebase anonymous authentication tied to an installation ID.
**Reason:** Users can start using the extension immediately without sign-up. Their tasks sync to Firestore under a guest profile and migrate to their account if they later sign up.
**Alternatives considered:** Local-only mode (no sync), mandatory sign-up (too much friction).

---

## 2026-02-27 — Alarm task index for background service worker

**Decision:** Maintain a lightweight `alarmTaskIndex` in `chrome.storage.local` with only the fields the service worker needs (id, contactName, description, remindAt, completed).
**Reason:** The service worker can't access the full task objects efficiently. A slim index keeps alarm/notification logic fast without reading the entire task store.
**Alternatives considered:** Reading full tasks in background.js (wasteful), storing alarm data in chrome.alarms metadata (too limited).
