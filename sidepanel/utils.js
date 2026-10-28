/**
 * utils.js - Utility functions for the sidepanel
 */

/**
 * Escapes HTML entities in a string to prevent XSS
 * @param {string} unsafe - The unsafe string
 * @returns {string} - The escaped string
 */
function escapeHtml(unsafe) {
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  
  /**
   * Escapes a string for use inside a double-quoted HTML attribute.
   *
   * `&` MUST be escaped first. Selector text comes from the inspected page, and
   * a value containing the literal characters `&quot;` used to survive unchanged
   * — the browser then decoded it back to a real `"`, closing the attribute and
   * letting page content inject markup into the privileged side panel.
   *
   * @param {string} str - The string to escape
   * @returns {string} - The escaped string
   */
  function escapeForAttribute(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  
  /**
   * Copies text to the clipboard using the modern async Clipboard API,
   * with a textarea fallback for pages that block clipboard access.
   * @param {string} text - The text to copy
   */
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {
        _fallbackCopy(text);
      });
    } else {
      _fallbackCopy(text);
    }
  }

  function _fallbackCopy(text) {
    const tempInput = document.createElement('textarea');
    tempInput.value = text;
    tempInput.style.position = 'fixed';
    tempInput.style.opacity = '0';
    document.body.appendChild(tempInput);
    tempInput.focus();
    tempInput.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(tempInput);
  }
  
  /**
   * Exports data to CSV file
   * @param {Array} data - The data to export
   * @param {string} filename - The filename to use
   */
  function exportToCSV(data, filename) {
    if (!data || data.length === 0) return;
    
    // Convert data to CSV
    const headers = Object.keys(data[0]);

    // A cell needs quoting for a newline or a carriage return as much as for a
    // comma: an unquoted newline ends the record, so one selector or label
    // containing one split the rest of its row into a row of its own, and the
    // table stopped lining up in Excel and everywhere else.
    const NEEDS_QUOTES = /[",\r\n]/;
    const cellOf = (value) => {
      // Not `value || ''` — that turned a legitimate 0 or false into an empty cell
      const cell = (value === null || value === undefined) ? '' : String(value);
      return NEEDS_QUOTES.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
    };

    // CRLF line endings, as RFC 4180 specifies
    let csvContent = headers.map(cellOf).join(',') + '\r\n';
    data.forEach(function (item) {
      csvContent += headers.map(header => cellOf(item[header])).join(',') + '\r\n';
    });
    
    // Create download link
    const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    
    // Clean up
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
  
  /**
   * Exports data to JSON file — handles special characters safely,
   * unlike CSV which breaks on selectors containing commas or quotes.
   * @param {Array} data - The data to export
   * @param {string} filename - The filename to use
   */
  function exportToJSON(data, filename) {
    if (!data || data.length === 0) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  /**
   * Generates a Playwright TypeScript Page Object Model class from an array
   * of selector rows and triggers a download of the .ts file.
   * @param {Array}  data      - selectorData array from multi-tab
   * @param {string} className - Name for the generated class (e.g. "LoginPage")
   */
  function exportToPOM(data, className) {
    if (!data || data.length === 0) return;
    // Class names must be valid TypeScript identifiers
    className = String(className || 'GeneratedPage')
      .replace(/[^a-zA-Z0-9_$]/g, '')
      .replace(/^[0-9]+/, '') || 'GeneratedPage';

    const lines = [];
    lines.push(`import { Page, Locator } from '@playwright/test';`);
    lines.push(``);
    lines.push(`export class ${className} {`);
    lines.push(`  constructor(private page: Page) {}`);
    lines.push(``);

    const usedNames = new Set();
    data.forEach(item => {
      const locator = item['Playwright Locator'];
      if (!locator) return;

      // Build a safe camelCase getter name from the element name
      let name = (item['Element Name'] || 'element').replace(/[^a-zA-Z0-9]/g, '_');
      name = name.replace(/^[0-9_]+/, '') || 'element';
      name = name.charAt(0).toLowerCase() + name.slice(1);
      // Deduplicate: if name already used, append index
      let uniqueName = name;
      let n = 2;
      while (usedNames.has(uniqueName)) { uniqueName = `${name}${n++}`; }
      usedNames.add(uniqueName);

      // The recorded locator is a page-scoped expression like
      //   page.getByRole('button', { name: 'Save' })
      // Inside the class the page lives on `this.page`, so rewrite the leading
      // `page.` rather than blindly prefixing `this.` — a locator that does not
      // start with `page.` used to produce uncompilable TypeScript.
      const bodyExpr = /^page\./.test(locator)
        ? 'this.' + locator
        : `this.page.locator(${JSON.stringify(locator)})`;

      lines.push(`  get ${uniqueName}(): Locator {`);
      lines.push(`    return ${bodyExpr};`);
      lines.push(`  }`);
      lines.push(``);
    });

    lines.push(`}`);

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${className}.ts`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  /**
   * Gets the display name for a selector type
   * @param {string} type - The selector type ('xpath', 'css', 'jquery')
   * @returns {string} - The formatted display name
   */
  function getDisplayName(type) {
    const types = {
      'xpath': 'XPath',
      'css': 'CSS',
      'jquery': 'jQuery'
    };
    return types[type] || type;
  }

  /**
   * Scores a selector's fragility using heuristics.
   * Pure string analysis — no DOM access — safe to call from any context.
   * Returns { label: 'Stable'|'Moderate'|'Fragile', score: 0-100, reason: string }
   */
  function scoreFragility(selector, type) {
    if (!selector) return { label: 'Unknown', score: 50, reason: 'No selector provided' };

    let score = 0;
    const reasons = [];

    if (type === 'xpath') {
      if (/\[\d+\]/.test(selector)) {
        score += 40;
        reasons.push('uses positional index [n]');
      }
      if (/contains\(@class/.test(selector)) {
        score += 25;
        reasons.push('class attribute can toggle with state');
      }
      if (/normalize-space|starts-with/.test(selector) && selector.length > 60) {
        score += 20;
        reasons.push('long text-based selector');
      }
      if (/@id.*ember|@id.*\d{4,}/.test(selector)) {
        score += 35;
        reasons.push('auto-generated ID detected');
      }
      if (/@data-testid|@data-test|@data-cy|@aria-label/.test(selector)) {
        score = Math.max(0, score - 30);
        reasons.push('has stable test/aria attribute');
      }
    } else {
      if (/nth-child|nth-of-type/.test(selector)) {
        score += 40;
        reasons.push('uses positional pseudo-class');
      }
      if (/\.(active|disabled|open|show|hidden|visible)/.test(selector)) {
        score += 25;
        reasons.push('state-dependent class selector');
      }
      if (/[a-z0-9]{20,}/i.test(selector)) {
        score += 30;
        reasons.push('may contain auto-generated class names');
      }
      if (/\[data-testid|data-test|data-cy|aria-label/.test(selector)) {
        score = Math.max(0, score - 30);
        reasons.push('has stable test/aria attribute');
      }
      if (/^#[a-zA-Z]/.test(selector) && !/\d{4,}/.test(selector)) {
        score = Math.max(0, score - 20);
        reasons.push('stable ID selector');
      }
    }

    score = Math.min(100, Math.max(0, score));
    let label, cls;
    if (score <= 20)      { label = 'Stable';   cls = 'frag-stable';   }
    else if (score <= 50) { label = 'Moderate'; cls = 'frag-moderate'; }
    else                  { label = 'Fragile';  cls = 'frag-fragile';  }

    // `cls` is the CSS class the side panel renders the badge with. Without it
    // the badge got class="frag-badge undefined" — white text, no background.
    return { label, cls, score, reason: reasons.join('; ') || 'No specific issues' };
  }

  // ── Bookmarks ───────────────────────────────────────────────────────────
  //
  // Three tabs read and write this list. They each used to do it inline, none
  // of them checked whether the write succeeded, and the records had no
  // identity of their own — they were addressed by their position in the array,
  // so a second panel window holding a stale list deleted somebody else's row.

  const BOOKMARKS_KEY = 'paltech_bookmarks';

  /**
   * A unique id for a stored bookmark.
   * Random on purpose: this identifies a RECORD, so it has to be unique — the
   * opposite of an element name, which has to be reproducible.
   */
  function newBookmarkId() {
    return 'bm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * @param {Function} onDone - (bookmarks, errorMessage|null)
   */
  function readBookmarks(onDone) {
    chrome.storage.local.get(BOOKMARKS_KEY, (result) => {
      const err = chrome.runtime.lastError;
      if (err) { onDone([], err.message || 'could not read saved bookmarks'); return; }
      onDone(result[BOOKMARKS_KEY] || [], null);
    });
  }

  /**
   * @param {Array}    list
   * @param {Function} onDone - (errorMessage|null)
   *
   * chrome.storage.local holds 10MB without the unlimitedStorage permission and
   * every bookmark carries a whole selector row, so the quota is a failure that
   * really happens. Reporting it beats a panel that says "Bookmarked!" over a
   * write that silently did nothing.
   */
  function writeBookmarks(list, onDone) {
    chrome.storage.local.set({ [BOOKMARKS_KEY]: list }, () => {
      const err = chrome.runtime.lastError;
      if (typeof onDone === 'function') {
        onDone(err ? (err.message || 'could not save the bookmark') : null);
      }
    });
  }

  /**
   * Append one bookmark.
   * @param {Object}   entry  - { domain, pageUrl, elementName, data }
   * @param {Function} onDone - (errorMessage|null)
   */
  function addBookmark(entry, onDone) {
    readBookmarks((bookmarks, readErr) => {
      if (readErr) { if (onDone) onDone(readErr); return; }
      bookmarks.push(Object.assign({ id: newBookmarkId() }, entry));
      writeBookmarks(bookmarks, onDone);
    });
  }

  /**
   * The content scripts, in load order. MUST stay identical to the `js` array
   * in manifest.json — the modules assign to window in this order and depend on
   * each other.
   *
   * This used to be copy-pasted into each tab file, and the copies had drifted:
   * the Multiple Elements tab injected neither inspection.js nor recorder.js.
   * Because the ping then succeeded forever after, clicking "Generate Selectors"
   * first left Inspection Mode broken until the page was reloaded.
   */
  const CONTENT_SCRIPT_FILES = self.PALTECH_CONTENT_SCRIPT_FILES;

  /**
   * Makes sure every content script is present in `tabId`, then calls onReady().
   * Pings first so an already-injected page is never injected twice.
   * @param {number}   tabId
   * @param {Function} onReady
   * @param {Function} [onError] - receives an error message string
   */
  function ensureContentScripts(tabId, onReady, onError) {
    const fail = (msg) => { if (typeof onError === 'function') onError(msg); };

    if (!tabId) {
      fail('Could not determine the active tab.');
      return;
    }

    chrome.tabs.sendMessage(tabId, { action: 'ping' }, (pingResponse) => {
      // Reading lastError is what marks it as handled — do not remove
      const pingFailed = !!chrome.runtime.lastError;
      if (!pingFailed && pingResponse && pingResponse.alive) {
        onReady();
        return;
      }

      chrome.scripting.executeScript(
        { target: { tabId }, files: CONTENT_SCRIPT_FILES },
        () => {
          if (chrome.runtime.lastError) {
            fail(chrome.runtime.lastError.message);
            return;
          }
          onReady();
        }
      );
    });
  }

  /**
   * Installs the MAIN-world page hooks (SPA navigation + native dialogs).
   * Must be a separate call from ensureContentScripts(): these run in the page's
   * own JS world, which the regular content scripts cannot reach.
   * Failure is non-fatal — recording still works, minus navigate/dialog steps.
   * @param {number}   tabId
   * @param {Function} onDone - always called, whether injection succeeded or not
   */
  function ensurePageHooks(tabId, onDone) {
    const done = () => { if (typeof onDone === 'function') onDone(); };
    if (!tabId) { done(); return; }

    try {
      chrome.scripting.executeScript(
        { target: { tabId }, files: [self.PALTECH_PAGE_HOOK_FILE], world: 'MAIN' },
        () => {
          if (chrome.runtime.lastError) {
            console.warn('PalTech: page hooks unavailable —', chrome.runtime.lastError.message);
          }
          done();
        }
      );
    } catch (e) {
      console.warn('PalTech: page hooks unavailable —', e);
      done();
    }
  }

  /**
   * Shared recording controller.
   *
   * There is ONE recorder in the page, but two panel tabs drive it (Recorder and
   * Test Steps). They each used to keep a private isRecording flag, so starting
   * in one and stopping in the other left the first stuck at "Recording…" with
   * capture already off, and starting in both duplicated every step into two
   * lists. This controller owns the state that must be shared: who is recording,
   * on which tab, and who needs to be told when that changes.
   *
   * It also fixes the start race. recorder.js emits its "navigate" step for the
   * starting URL from inside start(), i.e. BEFORE the sendMessage callback runs.
   * Tabs that only set isRecording in that callback dropped the step, so the
   * generated test had no page.goto()/cy.visit() line. startRecording() below
   * marks the session active *before* the message goes out.
   *
   * Finally, it survives the panel being closed. A side panel document is torn
   * down when the panel closes, taking ownerId, ownerTabId and every collected
   * step with it — while the page recorder keeps capturing and the service
   * worker keeps re-arming it after each navigation. Reopening therefore built
   * a panel that believed nothing was recording: Stop was disabled and the only
   * way to turn the recorder off was to close the tab or reload the page. So
   * the session (owner, tab, steps) is mirrored into chrome.storage.session and
   * restore() rebuilds it on the next open.
   */
  const RecordingController = (function () {
    let ownerId = null;      // 'recorder' | 'teststeps'
    let ownerTabId = null;
    const subscribers = new Map(); // id -> { onStopped, onResumed }

    const TAB_KEY   = self.PALTECH_RECORDING_KEY;
    const OWNER_KEY = self.PALTECH_RECORDING_OWNER_KEY;
    const stepsKeyFor = (id) => self.PALTECH_RECORDING_STEPS_PREFIX + id;

    const LABELS = {
      recorder:  'Recorder',
      teststeps: 'Test Steps'
    };

    function label(id) {
      return LABELS[id] || id;
    }

    /**
     * Register a tab so it can be told when recording stops elsewhere.
     * @param {string}   id
     * @param {Function} onStopped - (previousOwner, interrupted)
     * @param {Function} [onResumed] - (tabId, savedSteps) when restore() finds
     *        a recording this tab started before the panel was closed
     */
    function register(id, onStopped, onResumed) {
      subscribers.set(id, { onStopped, onResumed });
    }

    function isActive()          { return ownerId !== null; }
    function isOwnedBy(id)       { return ownerId === id; }
    function currentOwnerLabel() { return ownerId ? label(ownerId) : ''; }
    function currentTabId()      { return ownerTabId; }

    /** Fire-and-forget session write; storage is a convenience here, never a
     *  dependency, so a failure must not break recording. */
    function sessionWrite(fn) {
      try {
        const p = fn();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { /* session storage unavailable — non-fatal */ }
    }

    function clearSessionKey() {
      sessionWrite(() => chrome.storage.session.remove([
        TAB_KEY, OWNER_KEY, stepsKeyFor('recorder'), stepsKeyFor('teststeps')
      ]));
    }

    function saveSessionKey(tabId, id) {
      sessionWrite(() => chrome.storage.session.set({
        [TAB_KEY]: tabId,
        [OWNER_KEY]: id
      }));
    }

    /**
     * Mirror the steps collected so far, so closing the panel mid-recording
     * does not throw them away. Only the owning tab's list is kept, and only
     * while its recording is running.
     * @param {string} id
     * @param {Array}  steps
     */
    function saveSteps(id, steps) {
      if (!isOwnedBy(id)) return;
      sessionWrite(() => chrome.storage.session.set({
        [stepsKeyFor(id)]: Array.isArray(steps) ? steps : []
      }));
    }

    /**
     * @param {string}   id      - 'recorder' | 'teststeps'
     * @param {number}   tabId
     * @param {Function} onStarted
     * @param {Function} onError - receives a user-facing message
     */
    function startRecording(id, tabId, onStarted, onError) {
      const fail = (msg) => { if (typeof onError === 'function') onError(msg); };

      if (isActive() && !isOwnedBy(id)) {
        fail(`Recording is already running in the ${currentOwnerLabel()} tab. Stop it there first.`);
        return;
      }

      ensureContentScripts(tabId, () => {
        // MAIN-world hooks are best-effort: recording still works without them,
        // it just misses SPA navigation and dialog steps.
        ensurePageHooks(tabId, () => {
          // Claim ownership BEFORE the message goes out — see the note above.
          ownerId    = id;
          ownerTabId = tabId;
          saveSessionKey(tabId, id);

          chrome.tabs.sendMessage(tabId, { action: 'startRecording' }, (res) => {
            if (chrome.runtime.lastError || !res || !res.success) {
              // Roll the claim back so the UI does not lie
              ownerId    = null;
              ownerTabId = null;
              clearSessionKey();
              const detail = chrome.runtime.lastError
                ? chrome.runtime.lastError.message
                : (res && res.error) || 'the page did not respond';
              fail('Could not start recording: ' + detail + ' Try refreshing the page.');
              return;
            }
            if (typeof onStarted === 'function') onStarted();
          });
        });
      }, (errMsg) => {
        fail('Injection error: ' + errMsg);
      });
    }

    /**
     * Stops recording and notifies every other registered tab.
     * @param {string}   id      - the tab requesting the stop
     * @param {Function} onDone
     */
    function stopRecording(id, onDone) {
      const tabId = ownerTabId;
      const previousOwner = ownerId;

      ownerId    = null;
      ownerTabId = null;
      clearSessionKey();

      const finish = () => {
        // Tell the other tab so its buttons reset too
        subscribers.forEach((sub, subId) => {
          if (subId !== id && typeof sub.onStopped === 'function') {
            sub.onStopped(previousOwner);
          }
        });
        if (typeof onDone === 'function') onDone();
      };

      if (!tabId) { finish(); return; }

      chrome.tabs.sendMessage(tabId, { action: 'stopRecording' }, () => {
        // Reading lastError marks it handled — the tab may already be gone
        void chrome.runtime.lastError;
        finish();
      });
    }

    /**
     * Rebuild the session a previous panel document left running.
     *
     * Called once, after every tab has registered. Nothing is claimed on the
     * strength of the stored keys alone: the page is asked whether its recorder
     * is genuinely still active, because the tab may have been closed, replaced,
     * or navigated somewhere the content scripts cannot run — in which case the
     * stale keys are cleared instead, exactly as a stop would.
     *
     * @param {Function} [onDone] - called with true when a session was resumed
     */
    function restore(onDone) {
      const finish = (resumed) => { if (typeof onDone === 'function') onDone(!!resumed); };

      if (isActive()) { finish(false); return; }   // this document already owns one

      let pending;
      try {
        pending = chrome.storage.session.get([TAB_KEY, OWNER_KEY,
                                              stepsKeyFor('recorder'),
                                              stepsKeyFor('teststeps')]);
      } catch (e) { finish(false); return; }

      if (!pending || typeof pending.then !== 'function') { finish(false); return; }

      pending.then((stored) => {
        const tabId = stored && stored[TAB_KEY];
        const id    = stored && stored[OWNER_KEY];

        if (typeof tabId !== 'number' || !subscribers.has(id)) {
          if (stored && (tabId !== undefined || id !== undefined)) clearSessionKey();
          finish(false);
          return;
        }

        chrome.tabs.sendMessage(tabId, { action: 'isRecording' }, (res) => {
          // Reading lastError marks it handled — the tab may be gone entirely
          const unreachable = !!chrome.runtime.lastError;
          if (unreachable || !res || !res.recording) {
            clearSessionKey();
            finish(false);
            return;
          }

          ownerId    = id;
          ownerTabId = tabId;

          const sub   = subscribers.get(id);
          const steps = stored[stepsKeyFor(id)];
          if (sub && typeof sub.onResumed === 'function') {
            sub.onResumed(tabId, Array.isArray(steps) ? steps : []);
          }
          finish(true);
        });
      }).catch(() => finish(false));
    }

    /** Called when the recorder dies for reasons outside the panel's control. */
    function markInterrupted() {
      const previousOwner = ownerId;
      ownerId    = null;
      ownerTabId = null;
      clearSessionKey();
      subscribers.forEach((sub) => {
        if (typeof sub.onStopped === 'function') sub.onStopped(previousOwner, true);
      });
    }

    return {
      register,
      restore,
      saveSteps,
      startRecording,
      stopRecording,
      markInterrupted,
      isActive,
      isOwnedBy,
      currentOwnerLabel,
      currentTabId
    };
  })();

  // Export utility functions
  window.PalTechUtils = {
    CONTENT_SCRIPT_FILES,
    BOOKMARKS_KEY,
    newBookmarkId,
    readBookmarks,
    writeBookmarks,
    addBookmark,
    ensureContentScripts,
    ensurePageHooks,
    RecordingController,
    escapeHtml,
    escapeForAttribute,
    copyToClipboard,
    exportToCSV,
    exportToJSON,
    exportToPOM,
    getDisplayName,
    scoreFragility
  };