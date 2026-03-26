# Nudge

Save follow-up tasks from LinkedIn, Gmail, Outlook, and WhatsApp with one click. Get smart reminders via Chrome notifications and manage your outreach pipeline with a full CRM-style dashboard.

## Features

- One-click task creation from LinkedIn Messaging, Gmail, Outlook Web, and WhatsApp Web
- Smart reminders via Chrome alarms and desktop notifications
- CRM pipeline stages (Prospect, Lead, Interested, Nurturing, Win, Dead, etc.)
- Full dashboard with card/table views, filtering, search, and sorting
- Contact timeline panel showing task history per contact
- Multi-owner support for team workflows
- Cloud sync via Firebase/Firestore with guest and authenticated modes
- Free tier with configurable task limit

## Tech Stack

- **JavaScript (ES6+)** — no framework, no build step
- **Chrome Extension Manifest V3** — service workers, content scripts
- **Firebase/Firestore** — REST API (no SDK) for cloud sync and auth
- **Chrome APIs** — storage, alarms, notifications, tabs

## Getting Started

### Prerequisites

- Google Chrome (or any Chromium-based browser)

### Installation

```bash
git clone https://github.com/Vikas-Claude-Demo/task-chrome-ext.git
```

### Running

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select the cloned project folder
4. Open LinkedIn Messaging, Gmail, Outlook, or WhatsApp Web
5. Look for the floating **"Save as Task"** button

## Project Structure

```
/
├── manifest.json              # Extension manifest (permissions, content scripts, service worker)
├── background.js              # Service worker — alarms, notifications, badge count
├── content.js                 # Floating "Save as Task" button + modal on supported platforms
├── content.css                # Styles for injected UI
├── shared/                    # Shared code (config, Firebase storage client)
├── popup/                     # Extension popup (quick task view)
├── dashboard/                 # Full-page dashboard (table/card views, timeline, settings)
├── home/                      # Onboarding/landing page
├── icons/                     # Extension icons (16, 48, 128)
└── docs/                      # Project documentation
```

## Contributing

1. Clone the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push to the branch and open a Pull Request

## License

All rights reserved
