/**
 * contentScriptFiles.js — the single source of truth for which content scripts
 * get injected, and in what order.
 *
 * Loaded by BOTH the side panel (as a <script> tag) and the service worker (via
 * importScripts), so there is exactly one list. Previously each side-panel tab
 * carried its own hard-coded copy and the copies had drifted apart, which is
 * what broke Inspection Mode after a Generate Selectors run.
 *
 * This array MUST stay in sync with the `js` array of content_scripts in
 * manifest.json — run_tests.js asserts that it does.
 */
(function (root) {

  root.PALTECH_CONTENT_SCRIPT_FILES = [
    // First: every other module asks it how to see through shadow DOM
    'content/shadow.js',
    'content/elementNaming.js',
    'content/playwright.js',
    'content/selectors.js',
    'content/highlighting.js',
    'content/inspection.js',
    'content/codeGen.js',
    'content/recorder.js',
    'content/content-script.js'
  ];

  // Injected separately, into the page's MAIN world — see content/pageHooks.js
  root.PALTECH_PAGE_HOOK_FILE = 'content/pageHooks.js';

  // Also MAIN world, but DECLARED in the manifest at document_start rather than
  // injected: it has to replace attachShadow before the page builds its
  // components. Listed here only so the wiring tests can find it.
  root.PALTECH_SHADOW_HOOK_FILE = 'content/shadowHook.js';

  // chrome.storage.session key holding the tab id currently being recorded.
  // The service worker reads it to re-arm the recorder after a navigation.
  root.PALTECH_RECORDING_KEY = 'paltech_recording_tab';

  // Which panel tab owns that recording ('recorder' | 'teststeps'), and the
  // steps it has collected so far. Closing the side panel destroys the panel
  // document and everything it held in memory, while the page keeps recording
  // — these two keys are what a reopened panel rebuilds its state from, so its
  // Stop button works again instead of sitting disabled over a live recorder.
  root.PALTECH_RECORDING_OWNER_KEY = 'paltech_recording_owner';
  root.PALTECH_RECORDING_STEPS_PREFIX = 'paltech_recording_steps_';

})(typeof self !== 'undefined' ? self : this);
