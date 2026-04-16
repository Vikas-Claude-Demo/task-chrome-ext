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

---

## 2026-04-09 — Scoped task documents under team/user collections

**Decision:** Store authenticated tasks as Firestore documents under scoped collections (`teams/{teamId}/tasks/{taskId}` when the user belongs to a team, otherwise `users/{uid}/tasks/{taskId}`), and normalize task payloads to include `priority` and `tags`.
**Reason:** Avoids global task arrays, supports team-shared task visibility by collection path, and makes incremental task updates (`patchTask`) cheaper and safer than rewriting full arrays.
**Alternatives considered:** Keeping task arrays under profile documents (harder to scale and merge), team-only writes with no user fallback (breaks users without team setup).

---

## 2026-04-09 — Team-scoped owners and stages collections

**Decision:** Store CRM settings as team subcollections: `teams/{teamId}/owners/{ownerId}` and `teams/{teamId}/stages/{stageId}`.
**Reason:** Team settings become shared, queryable entities with metadata (`createdAt`, `createdBy`) and can be maintained independently of profile settings blobs.
**Alternatives considered:** Storing owners/stages in profile `settings` map (not team-shared by default and harder to audit per-record metadata).

---

## 2026-04-10 — Dashboard contacts tab uses team contacts with inline edit

**Decision:** Use a dedicated dashboard Contacts tab (`data-tab="contacts"`) backed by Firestore `teams/{teamId}/contacts`, with list + edit flow in-dashboard.
**Reason:** Contacts should be team-shared records independent from task rows, and users need direct editing of email, phone, company, designation, and LinkedIn URL.
**Alternatives considered:** Deriving contacts only from tasks (misses team contact records and makes edits non-persistent), separate contacts management page (more navigation friction).

---

## 2026-04-16 — Dashboard task tabs support owner + creator filters

**Decision:** In dashboard task-list views (Today, This Week, Pending, Overdue, Completed), keep the existing owner filter (`task.owner`) and add a separate team-member creator filter using `task.createdBy` (Firestore-style `users/{uid}`), with creator options sourced from `teams/{teamId}/members` and shown by member name/email.
**Reason:** Users need both assignment-based filtering (owner) and attribution-based filtering (who created the task) at the same time.
**Alternatives considered:** Replacing owner filtering with creator-only filtering was rejected because it removes useful assignment workflows.
