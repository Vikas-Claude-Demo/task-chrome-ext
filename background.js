// background.js - Service Worker (Manifest V3)
// All logic must be event-driven. No persistent state in memory.
// chrome.alarms survive service worker termination - always use them for scheduling.

// ===== Alarm fires: send notification =====
chrome.alarms.onAlarm.addListener(async (alarm) => {
  const tasks = await getTasksForBackground();
  const task = tasks.find(t => t.id === alarm.name);

  if (!task || task.completed) return;

  chrome.notifications.create(alarm.name, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `Reminder: ${task.contactName}`,
    message: task.description,
    priority: 2,
    requireInteraction: true
  });

  await updateBadge();
});

// ===== Message handler for content.js and popup.js =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'CREATE_ALARM') {
    chrome.alarms.create(message.task.id, { when: message.task.remindAt });
    updateBadge().then(() => sendResponse({ success: true }));
    return true; // keep message channel open for async response
  }

  if (message.action === 'DELETE_ALARM') {
    chrome.alarms.clear(message.alarmName);
    updateBadge().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === 'UPDATE_BADGE') {
    updateBadge().then(() => sendResponse({ success: true }));
    return true;
  }
});

// ===== Recalculate badge from storage =====
async function updateBadge() {
  const tasks = await getTasksForBackground();
  const pendingCount = tasks.filter(t => !t.completed).length;

  if (pendingCount === 0) {
    chrome.action.setBadgeText({ text: '' });
  } else {
    chrome.action.setBadgeText({ text: String(pendingCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#CC0000' });
  }
}

async function getTasksForBackground() {
  const data = await chrome.storage.local.get(['alarmTaskIndex', 'tasks']);
  if (Array.isArray(data.alarmTaskIndex)) return data.alarmTaskIndex;
  return Array.isArray(data.tasks) ? data.tasks : [];
}

// ===== Re-sync badge on browser restart or extension install/update =====
chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
