/**
 * background.js — service worker.
 *
 * Responsibilities:
 *   1. Open the side panel from the toolbar action.
 *   2. Tell the panel when the active tab or its URL changes (stale banner).
 *   3. Re-arm the recorder after a page navigation — a full page load destroys
 *      the content script and everything it held in memory, so without this the
 *      recorder silently stopped capturing while the panel still said
 *      "Recording…".
 */

importScripts('shared/contentScriptFiles.js');

// setPanelBehavior returns a promise; an unhandled rejection here would show up
// as a service-worker error on every startup.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('PalTech: could not set panel behavior', err));

// ── Panel notifications ──────────────────────────────────────────────────────

function notifyPanel(message) {
  // The side panel is often closed. sendMessage then rejects with
  // "Could not establish connection" — expected, and safe to ignore.
  chrome.runtime.sendMessage(message).catch(() => {});
}

chrome.tabs.onActivated.addListener(() => {
  notifyPanel({ action: 'tabChanged' });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.active) {
    notifyPanel({ action: 'tabChanged' });
  }
});

// ── Recorder continuity across navigations ───────────────────────────────────

/**
 * Reads the tab id currently being recorded, or null.
 * Stored by the side panel in chrome.storage.session when recording starts.
 */
async function getRecordingTabId() {
  try {
    const result = await chrome.storage.session.get(self.PALTECH_RECORDING_KEY);
    const value = result[self.PALTECH_RECORDING_KEY];
    return typeof value === 'number' ? value : null;
  } catch (e) {
    return null;
  }
}

/**
 * Re-injects the content scripts and restarts the recorder in `tabId`.
 * Called after a navigation completes while recording is active.
 */
/**
 * True when the content scripts are already alive in `tabId`.
 * The manifest auto-injects them at document_idle on every page load, so after
 * a navigation they are usually there before this runs — injecting a second
 * time is wasted work at best, and re-evaluates files that may not survive it.
 */
async function contentScriptsAlive(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return !!(res && res.alive);
  } catch (e) {
    return false;   // no listener yet, or the page cannot be scripted
  }
}

async function rearmRecorder(tabId) {
  try {
    if (!(await contentScriptsAlive(tabId))) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: self.PALTECH_CONTENT_SCRIPT_FILES
      });
    }

    // MAIN-world hooks for SPA navigation and native dialogs
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [self.PALTECH_PAGE_HOOK_FILE],
        world: 'MAIN'
      });
    } catch (hookErr) {
      console.warn('PalTech: page hooks unavailable after navigation', hookErr);
    }

    await chrome.tabs.sendMessage(tabId, {
      action: 'startRecording',
      options: { resumed: true }
    });
  } catch (e) {
    // Injection is blocked on chrome:// pages, the Web Store, PDFs, etc.
    console.warn('PalTech: could not re-arm recorder after navigation', e);
    notifyPanel({ action: 'recordingInterrupted', tabId });
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const recordingTabId = await getRecordingTabId();
  if (recordingTabId === tabId) {
    await rearmRecorder(tabId);
  }
});

// Stop tracking a tab that goes away, so a later tab reusing the id is not
// silently put into recording mode.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const recordingTabId = await getRecordingTabId();
  if (recordingTabId === tabId) {
    try {
      // The owner and its collected steps go with it — a panel opened later
      // must not try to resume a recording whose tab no longer exists.
      await chrome.storage.session.remove([
        self.PALTECH_RECORDING_KEY,
        self.PALTECH_RECORDING_OWNER_KEY,
        self.PALTECH_RECORDING_STEPS_PREFIX + 'recorder',
        self.PALTECH_RECORDING_STEPS_PREFIX + 'teststeps'
      ]);
    } catch (e) { /* nothing else to do */ }
    notifyPanel({ action: 'recordingInterrupted', tabId });
  }
});
