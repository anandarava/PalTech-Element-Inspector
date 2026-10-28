/**
 * test-steps-tab.js — Manages the Test Step Generator tab in the side panel.
 *
 * Flow:
 *   1. User clicks "Start Recording" → injectIfNeeded → sendMessage('startRecording')
 *   2. recorder.js fires chrome.runtime.sendMessage({ action:'stepRecorded', step })
 *   3. This class (if isRecording) converts the step to natural English and appends it.
 *   4. User clicks "Stop Recording" → sendMessage('stopRecording')
 *   5. A formatted QA test case document is shown with metadata + numbered steps.
 *   6. User can copy or download the document as a .txt file.
 *
 * Label resolution priority for each step:
 *   1. Playwright locator semantics (getByRole name, getByLabel, getByText, etc.)
 *   2. Humanized elementName (strips Container/Txt/Btn etc., converts camelCase)
 *   3. Generic fallback ("the element", "the button", etc.)
 */

class TestStepsTab {
  constructor() {
    this.steps       = [];
    this.isRecording = false;
    this.activeTabId = null;
    this._prepared   = [];     // view models produced by _prepareSteps()
    this._registry   = null;   // locator -> { label, role }, for consistent wording
    this._editingIdx = null;   // index of the cell being edited
    this._editingField = null; // which column that cell is in
    this._activeEditor = null; // { save, finish } for the open cell, if any
    this._manualSeq  = 0;      // ids for steps the tester adds by hand
    // Id of the step newly recorded steps hang under, so that recording can
    // continue from a row part-way up the table instead of at the bottom.
    this._insertAfterId = null;
    this._stoppedAt     = 0;   // when recording last stopped (see _listenForSteps)

    this._buildUI();
    this._bindEvents();
    this._listenForSteps();
    this._updateActiveTab();
  }

  // ── UI Construction ─────────────────────────────────────────────────────────

  _buildUI() {
    const container = document.getElementById('teststeps-tab');
    if (!container) return;

    // The tab is a single artefact: the step table. The test-case metadata
    // fields (name, id, objective, preconditions, overall expected result) were
    // removed — that information belongs in whatever test management tool the
    // table is pasted into, not duplicated here.
    container.innerHTML = `
      <div class="ts-toolbar">
        <button id="tsStartBtn" class="ts-start-btn">&#9654; Start Recording</button>
        <button id="tsStopBtn"  class="ts-stop-btn"  disabled>&#9632; Stop</button>
        <button id="tsClearBtn" class="ts-clear-btn" disabled>&#128465; Clear</button>
        <span class="ts-toolbar-spacer"></span>
        <button id="tsCopyOutput"     class="ts-action-btn" disabled title="Copy the table (tab separated — pastes straight into Excel, Sheets or Jira)">&#128203; Copy</button>
        <button id="tsDownloadOutput" class="ts-action-btn" disabled title="Download the table as CSV">&#8595; CSV</button>
      </div>

      <div id="tsStatusBar" class="ts-status-bar" style="display:none;"></div>

      <div class="ts-section-header">
        Test Steps
        <span id="tsStepCount" class="ts-step-count">0</span>
      </div>

      <div id="tsStepList" class="ts-table-wrap">
        <p class="ts-empty">Click "Start Recording" then interact with the page.</p>
      </div>
    `;

    this.startBtn    = document.getElementById('tsStartBtn');
    this.stopBtn     = document.getElementById('tsStopBtn');
    this.clearBtn    = document.getElementById('tsClearBtn');
    this.statusBar   = document.getElementById('tsStatusBar');
    this.stepList    = document.getElementById('tsStepList');
    this.stepCount   = document.getElementById('tsStepCount');
    this.copyBtn     = document.getElementById('tsCopyOutput');
    this.downloadBtn = document.getElementById('tsDownloadOutput');
  }

  _bindEvents() {
    if (!this.startBtn) return;

    this.startBtn.addEventListener('click',    () => this._startRecording());
    this.stopBtn.addEventListener('click',     () => this._stopRecording());
    this.clearBtn.addEventListener('click',    () => this._clearSteps());
    this.copyBtn.addEventListener('click',     () => this._copyOutput());
    this.downloadBtn.addEventListener('click', () => this._downloadOutput());
  }

  // ── Active tab tracking ─────────────────────────────────────────────────────

  _updateActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length) this.activeTabId = tabs[0].id;
    });
  }

  // ── Step listener ───────────────────────────────────────────────────────────

  _listenForSteps() {
    chrome.runtime.onMessage.addListener((request) => {
      if (request.action === 'stepRecorded' && request.step) {
        // Stopping makes the recorder emit one last step: whatever was still
        // being typed when the tester pressed Stop, which no blur will ever
        // report now. It arrives just after the stop acknowledgement, so a
        // plain isRecording check dropped the value on the floor.
        const late = !this.isRecording && this._stoppedAt &&
                     (Date.now() - this._stoppedAt) <= TestStepsTab.LATE_STEP_MS;
        if (this.isRecording || late) {
          this._placeRecordedStep(request.step);
          this._renderStepList();
          this._refreshOutput();
          this._persistSteps();
          if (late) {
            // The counts in the status line have to grow with it
            const { shown, recorded } = this._applyStoppedState();
            this._showStatus(this._stoppedMessage(shown, recorded),
                             shown > 0 ? 'success' : 'idle');
          }
        }
      }
      // The recorder measures what actually changed on the page and sends it a
      // moment later, once the DOM has settled. Attach it to its step.
      if (request.action === 'stepOutcome' && request.stepId != null) {
        const step = this.steps.find(s => s.id === request.stepId);
        if (step) {
          step.outcome = request.outcome;
          this._renderStepList();
          this._refreshOutput();
          this._persistSteps();
        }
      }
      if (request.action === 'tabChanged') {
        this._updateActiveTab();
      }
      if (request.action === 'recordingInterrupted' && this.isRecording) {
        // The page could not be re-armed after a navigation (chrome:// page,
        // Web Store, PDF viewer, tab closed). Say so instead of pretending.
        window.PalTechUtils.RecordingController.markInterrupted();
      }
    });

    // Reset this tab's UI when recording is stopped from the other tab, and
    // pick a recording back up when the panel is reopened while it is running.
    window.PalTechUtils.RecordingController.register(
      'teststeps',
      (owner, interrupted) => {
        if (!this.isRecording) return;
        this._applyStoppedState();
        if (interrupted) {
          this._showStatus('Recording stopped — the page could not be recorded after navigating.', 'error');
        }
      },
      (tabId, savedSteps) => this._resumeRecording(tabId, savedSteps)
    );
  }

  /** Mirror the steps into session storage so closing the panel cannot lose them. */
  _persistSteps() {
    window.PalTechUtils.RecordingController.saveSteps('teststeps', this.steps);
  }

  /**
   * Re-attach this tab to a recording that outlived the previous panel document.
   *
   * Closing the side panel destroys this class and its step table, but neither
   * the page recorder nor the service worker that re-arms it after every
   * navigation. The reopened panel therefore came up with Stop disabled over a
   * recorder that was still capturing, and the only way to stop it was to close
   * the tab or reload the page.
   *
   * Steps performed while the panel was closed are genuinely gone — the page
   * sends each one to a panel that was not there to receive it — so say so
   * rather than presenting the table as a complete test case.
   */
  _resumeRecording(tabId, savedSteps) {
    if (!this.startBtn) return;

    this.activeTabId = tabId;
    this.isRecording = true;
    this._stoppedAt  = 0;

    if (Array.isArray(savedSteps) && savedSteps.length && !this.steps.length) {
      this.steps = savedSteps;
      // New steps go at the end of what was recovered, not into the middle of
      // it: the insertion point belonged to the panel document that is gone.
      this._insertAfterId = null;
      this._renderStepList();
      this._refreshOutput();
    }

    this.startBtn.disabled = true;
    this.stopBtn.disabled  = false;
    this.clearBtn.disabled = false;
    this._showStatus(
      'Recording is still running on the page. Anything done while the panel was closed was not captured.',
      'recording'
    );
  }

  // ── Where a newly recorded step goes ────────────────────────────────────────

  /** A hand-added row with nothing typed into any column yet. */
  _isBlankManual(step) {
    return !!step && step.type === 'manual' &&
      !String(step.actionOverride   || '').trim() &&
      !String(step.testDataOverride || '').trim() &&
      !String(step.expectedOverride || '').trim();
  }

  /** The step new recordings hang under, or null when they go at the end. */
  _cursorStep() {
    if (this._insertAfterId == null) return null;
    return this.steps.find(s => s.id === this._insertAfterId) || null;
  }

  /**
   * Add a step the recorder just sent.
   *
   * Normally that means the end of the list. But a row parked with "+" is an
   * insertion point: the tester is saying the steps they are about to record
   * belong THERE, not underneath everything recorded so far. Adding half a
   * dozen steps that way beats typing each one out by hand.
   *
   * The cursor advances to each step as it lands, so a run of them stays in the
   * order it was carried out, and the rows below the insertion point keep their
   * own order and their real timestamps.
   */
  _placeRecordedStep(step) {
    const cursor = this._cursorStep();
    if (!cursor) {
      this.steps.push(step);
      return;
    }

    // A blank parked row was only ever a marker for "put them here" — the first
    // real step takes its place, inheriting where it sat. A row with text in it
    // is a step in its own right, so it stays and the recording goes below it.
    if (this._isBlankManual(cursor)) {
      const at = this.steps.indexOf(cursor);
      if (cursor.after != null) step.after = cursor.after;
      this.steps.splice(at, 1, step);
    } else {
      step.after = cursor.id;
      const at = this.steps.indexOf(cursor);
      this.steps.splice(at + 1, 0, step);
    }

    this._insertAfterId = step.id;
  }

  // ── Recording control ───────────────────────────────────────────────────────
  // All start/stop goes through the shared RecordingController (utils.js) so the
  // Recorder and Test Steps tabs can never both drive the single page recorder.

  /**
   * Close the open cell before the table starts moving underneath it.
   *
   * Anything typed is kept — the tester wrote it on purpose — but the editor
   * itself cannot stay open, because renders are suppressed for as long as it
   * is and the steps about to arrive would be invisible.
   */
  _commitOpenEdit() {
    const editor = this._activeEditor;
    if (editor) editor.save();
  }

  /**
   * How the status bar describes where the next steps will land.
   * @param {number} at - 1-based row number of the insertion point
   */
  _recordingMessage(at) {
    return at > 0
      ? `Recording… new steps are being added at step ${at}.`
      : 'Recording… interact with the page.';
  }

  /** 1-based row of the insertion point, or 0 when steps go at the end. */
  _insertRowNumber() {
    const cursor = this._cursorStep();
    if (!cursor) return 0;
    const rows = this._prepareSteps();
    // The blank marker is replaced by the first step recorded, so the number to
    // announce is the row it is sitting on; a row with text keeps its place and
    // the recording starts on the row after it.
    const at = rows.findIndex(vm => (vm.ids || [vm.step.id]).indexOf(cursor.id) >= 0);
    if (at < 0) return 0;
    return this._isBlankManual(cursor) ? at + 1 : at + 2;
  }

  _startRecording() {
    this._commitOpenEdit();

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs.length) {
        this._showStatus('Could not determine the active tab.', 'error');
        return;
      }
      this.activeTabId = tabs[0].id;

      // isRecording is set BEFORE the start message goes out, because the
      // recorder emits its first "navigate" step synchronously inside start().
      this.isRecording = true;
      this._stoppedAt  = 0;

      window.PalTechUtils.RecordingController.startRecording(
        'teststeps',
        this.activeTabId,
        () => {
          this.startBtn.disabled = true;
          this.stopBtn.disabled  = false;
          this.clearBtn.disabled = false;
          this._showStatus(this._recordingMessage(this._insertRowNumber()), 'recording');
        },
        (errMsg) => {
          this.isRecording = false;
          this._showStatus(errMsg, 'error');
        }
      );
    });
  }

  /**
   * @returns {{ shown: number, recorded: number }} steps in the table, and the
   *   raw events they were built from
   */
  _applyStoppedState() {
    this.isRecording       = false;
    this.startBtn.disabled = false;
    this.stopBtn.disabled  = true;
    // The insertion point lasts for one recording. Left armed, a recording
    // started an hour later would quietly land its steps half-way up a table
    // the tester has since finished with.
    this._insertAfterId    = null;
    // Steps flushed by the recorder as it shuts down are still accepted for a
    // moment after this (see _listenForSteps).
    this._stoppedAt        = Date.now();

    // The count that matters is the number of STEPS IN THE TABLE, not the
    // number of events recorded to build them: a click and the navigation it
    // caused are one step, a hover that led nowhere is none, a label click and
    // the checkbox it ticked are one. Counting this.steps announced "3 steps
    // recorded" over a table showing 2.
    const shown = this._prepareSteps().length;
    if (shown > 0) {
      this.copyBtn.disabled     = false;
      this.downloadBtn.disabled = false;
    }

    // Rows whose outcome was still being measured read "Measuring…" while
    // recording; now that it has stopped they can show their final result.
    this._renderStepList();

    return { shown, recorded: this.steps.length };
  }

  /**
   * What the status bar says once recording stops. When events were merged the
   * difference is stated, so a tester who counted their own clicks can see
   * where the missing ones went instead of doubting the table.
   */
  _stoppedMessage(shown, recorded) {
    if (!shown) return 'Stopped. No steps recorded.';
    const plural = shown > 1 ? 's' : '';
    const merged = Math.max(0, recorded - shown);
    return merged > 0
      ? `Stopped. ${shown} step${plural} recorded (${recorded} events, ${merged} merged).`
      : `Stopped. ${shown} step${plural} recorded.`;
  }

  _stopRecording() {
    window.PalTechUtils.RecordingController.stopRecording('teststeps', () => {
      const { shown, recorded } = this._applyStoppedState();
      this._showStatus(this._stoppedMessage(shown, recorded),
                       shown > 0 ? 'success' : 'idle');
    });
  }

  _clearSteps() {
    this.steps             = [];
    this._prepared         = [];
    this._registry         = null;
    this._editingIdx       = null;
    this._editingField     = null;
    this._activeEditor     = null;
    this._insertAfterId    = null;
    if (this.stepList) this.stepList.classList.remove('ts-editing');
    this.copyBtn.disabled  = true;
    this.downloadBtn.disabled = true;
    // Stay clickable while recording — more steps are still coming in
    this.clearBtn.disabled = !this.isRecording;
    this._renderStepList();
    this._refreshOutput();
    this._persistSteps();
    this._showStatus(this.isRecording ? this._recordingMessage(0) : '',
                     this.isRecording ? 'recording' : 'idle');
  }

  // ── Status bar ──────────────────────────────────────────────────────────────

  _showStatus(msg, type) {
    if (!this.statusBar) return;
    if (!msg) { this.statusBar.style.display = 'none'; return; }
    this.statusBar.textContent = msg;
    this.statusBar.className   = 'ts-status-bar ts-status-' + type;
    this.statusBar.style.display = 'block';
  }

  // ── Label resolution helpers ────────────────────────────────────────────────

  /**
   * Extract the first quoted text from the recorder's description field, unless
   * that text is a bare tag name — the recorder fell back to tagName, which is
   * not a label.
   */
  _extractDescriptionText(step) {
    const m = (step.description || '').match(/"([^"]+)"/);
    if (!m) return '';
    const text = m[1].trim();
    return this._isJunkLabel(text) ? '' : text;
  }

  /**
   * True for strings that look like an internal identifier rather than
   * something a tester would recognise on screen.
   *
   * Five families, all seen in real recordings:
   *   - bare tag names            "div", "span", "svg", "path"
   *   - type abbreviations        "Txt", "Btn", "Lbl", "Fld"
   *   - CSS/SVG class soup        "Footer Logo Svg S0Fill", "cls-1", "st0"
   *   - URLs                      "https://app.example.com/Home/Dashboard"
   *   - icon-font class names     "Fa Angle Right", "Glyphicon Chevron Down"
   */
  _isJunkLabel(text) {
    if (!text) return true;
    const t = String(text).trim();
    const lower = t.toLowerCase();

    if (TestStepsTab.TAG_NAMES.has(lower)) return true;
    if (TestStepsTab.ABBREVIATIONS.has(lower.replace(/\s+/g, ''))) return true;

    // A URL is never a label. The recorder describes a navigation as
    // Navigate to "https://…", and that quoted URL used to be read as the
    // element's name, producing expected results like
    //   The "https://prod ireland automation test.example.com/Home/…" menu opens
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;        // https://…
    if (/^www\./i.test(lower)) return true;                      // www.example.com
    if (/^\/\S*$/.test(t)) return true;                          // /Home/Dashboard
    // A host name: either it carries a path, or it has the two or more dots a
    // domain has. One dot and no slash is a file name — "Report.pdf" and
    // "Contract.docx" are labels a tester reads off the screen, and rejecting
    // them left the step saying "Click on the link".
    if (!/\s/.test(t)) {
      const dots = (t.match(/\./g) || []).length;
      if (t.includes('/') && dots >= 1) return true;
      if (dots >= 2 && /[a-z]{2,}$/i.test(t)) return true;
    }

    // Tokens that only ever come from CSS class names, SVG path data, or the
    // class names component frameworks generate. Any one of them proves the
    // label was scraped from markup rather than read off the screen.
    const tokens = lower.split(/[\s_-]+/).filter(Boolean);
    const artefact = new RegExp(
      '^(' +
        // SVG / CSS internals
        'svg|path|fill|stroke|clip|clippath|mask|defs|cls\\d*|st\\d+|s\\d+[a-z]*|' +
        // Framework-generated markers, kept generic across libraries
        'ng|ngcontent|nghost|inserted|tns|mat|cdk|mdc|mui|sc|jsx|svelte|chakra|' +
        // Icon-font class names. These name a GLYPH, never a function, so
        // "fa-angle-right" must not become the step's label — the icon
        // vocabulary in the recorder is what turns it into "next icon".
        'fa|fas|far|fab|fal|fad|glyphicon|glyphicons|mdi|ion|ionicon|ionicons|' +
        'feather|octicon|icomoon|typcn|dashicons|' +
        // Angular/Vue form-state classes that leak into class lists
        'pristine|untouched|dirty|touched|valid|invalid|' +
        // Hashes
        '[a-f0-9]{6,}' +
      ')$'
    );
    if (tokens.some(tok => artefact.test(tok))) return true;

    // Long strings of concatenated class words are never a real label
    if (tokens.length > 8) return true;

    // A single very long word that mixes in digits, or that has a run of
    // consonants no language produces, is a generated id and not a name:
    // "checkboxuof7wufzhoc23qjqszvhuwreportChk". The length floor keeps real
    // words ("Acknowledgements", "Recommendations") out of it.
    if (tokens.length === 1 && t.length >= 16) {
      if (/\d/.test(t)) return true;
      if (/[bcdfghjklmnpqrstvwxz]{5,}/i.test(t)) return true;
    }

    return false;
  }

  /** Title-case a label that came from an attribute rather than visible text. */
  _tidyLabel(text) {
    if (!text) return '';
    const t = String(text).trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    // Leave anything already containing capitals alone — that is real UI text
    if (/[A-Z]/.test(t)) return t;
    return t.replace(/\b\w/g, c => c.toUpperCase());
  }

  _parseLocator(locator) {
    if (!locator || locator === 'page') return null;
    let m;

    m = locator.match(/getByRole\(['"](\w+)['"]\s*,\s*\{[^}]*name:\s*['"]([^'"]+)['"]/);
    if (m) return { role: m[1], label: m[2] };

    m = locator.match(/getByRole\(['"](\w+)['"]\)/);
    if (m) return { role: m[1], label: '' };

    m = locator.match(/getByLabel\(['"]([^'"]+)['"]\)/);
    if (m) return { role: 'field', label: m[1] };

    m = locator.match(/getByPlaceholder\(['"]([^'"]+)['"]\)/);
    if (m) return { role: 'field', label: m[1] };

    m = locator.match(/getByText\(['"]([^'"]+)['"]/);
    if (m) return { role: '', label: m[1] };

    m = locator.match(/getByAltText\(['"]([^'"]+)['"]\)/);
    if (m) return { role: 'image', label: m[1] };

    m = locator.match(/getByTitle\(['"]([^'"]+)['"]\)/);
    if (m) return { role: '', label: m[1] };

    m = locator.match(/getByTestId\(['"]([^'"]+)['"]\)/);
    if (m) return { role: '', label: m[1] };

    return null;
  }

  /** Internal camelCase name -> readable words, or '' when it carries nothing. */
  _humanizeName(name) {
    if (!name) return '';
    let s = name;

    s = s.replace(/(Btn|Button|Link|Lnk|Anchor|Img|Image|Icon|Input|Field|Select|Combo|Checkbox|Check|Radio|Toggle|Switch)$/i, '');
    s = s.replace(/(Container|Wrapper|Box|Panel|Section|Area|Region|Holder|Frame|View|Screen|Component|Widget|Module|Node|Cell|Row|Col|Group|Block|Div|Span|Card|Tile|Item|Entry|Tab)$/i, '');
    s = s.replace(/(Txt|Text|Lbl|Label|Val|Value|Desc|Title|Header|Heading|Num|Str)$/i, '');
    s = s.replace(/\d+$/, '');
    s = s.replace(/^\d[\dhms]*/i, '');
    s = s.replace(/_+/g, ' ');
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
    s = s.replace(/\b(\w+)(\s+\1)+\b/gi, '$1');
    s = s.trim().replace(/\b\w/g, c => c.toUpperCase()).trim();

    return this._isJunkLabel(s) ? '' : s;
  }

  /** Fallback role inference for steps recorded before roles were captured. */
  _inferRole(step) {
    const css  = step.css  || '';
    const xp   = step.xpath || '';
    const name = step.elementName || '';

    if (/^button\b|>\s*button\b/i.test(css) || /\/\/button\b/i.test(xp))   return 'button';
    if (/^a\b|^a\[|\[href/i.test(css)       || /\/\/a\b/i.test(xp))        return 'link';
    if (/^input\b/i.test(css)               || /\/\/input\b/i.test(xp))    return 'field';
    if (/^select\b/i.test(css)              || /\/\/select\b/i.test(xp))   return 'dropdown';
    if (/^textarea\b/i.test(css)            || /\/\/textarea\b/i.test(xp)) return 'text area';
    if (/^img\b/i.test(css)                 || /\/\/img\b/i.test(xp))      return 'image';

    if (/Btn$|Button$/i.test(name))                                return 'button';
    if (/Link$|Lnk$|Anchor$/i.test(name))                          return 'link';
    if (/Input$|Field$/i.test(name))                               return 'field';
    if (/Select$|Dropdown$|Combo$/i.test(name))                    return 'dropdown';
    if (/Img$|Image$|Icon$/i.test(name))                           return 'image';
    if (/Checkbox$|Check$/i.test(name))                            return 'checkbox';
    if (/Tab$/i.test(name))                                        return 'tab';
    if (/Menu$|Nav$|Navbar$|Navigation$/i.test(name))              return 'menu';
    if (/Dialog$|Modal$|Popup$|Overlay$/i.test(name))              return 'dialog';

    // Structural words are never used for something the user clicked
    const isPointerAction = ['click', 'dblclick', 'rightClick', 'hover', 'tap'].includes(step.type);
    if (!isPointerAction) {
      if (/Container$|Wrapper$|Panel$|Section$|Card$|Box$|Area$|Region$|Widget$/i.test(name)) return 'section';
      if (/Table$|Grid$|List$/i.test(name))                        return 'list';
    }

    return '';
  }

  /** ARIA / internal role names -> the words a tester uses. */
  _readableRole(role) {
    const MAP = {
      textbox: 'field', searchbox: 'field', combobox: 'dropdown', listbox: 'dropdown list',
      menuitem: 'menu item', menuitemcheckbox: 'menu item', option: 'option',
      columnheader: 'column header', rowheader: 'row header', row: 'row', cell: 'cell',
      gridcell: 'cell', treeitem: 'tree item', listitem: 'list item',
      banner: 'header', contentinfo: 'footer', complementary: 'sidebar',
      navigation: 'navigation menu', main: 'main content', region: 'section',
      search: 'search area', form: 'form', status: 'status bar', alert: 'alert',
      alertdialog: 'alert dialog', dialog: 'dialog', tooltip: 'tooltip',
      tablist: 'tab bar', tabpanel: 'tab panel', spinbutton: 'number input',
      progressbar: 'progress bar', separator: 'divider', toolbar: 'toolbar',
      tree: 'tree', treegrid: 'tree grid', grid: 'grid', rowgroup: 'row group',
      radio: 'radio button', img: 'image', link: 'link', button: 'button',
      checkbox: 'checkbox', tab: 'tab', heading: 'heading', switch: 'toggle'
    };
    return MAP[role] || role;
  }

  /** The best role word for a step, preferring what the recorder resolved live. */
  _roleOf(step) {
    const entry = (this._registry && this._registry.get(step.locator)) || null;
    if (entry && entry.role) return entry.role;
    const raw = step.role || (this._parseLocator(step.locator) || {}).role || this._inferRole(step);
    return raw ? this._readableRole(raw) : '';
  }

  _buildLabelRegistry(steps) {
    const registry = new Map();

    steps.forEach(step => {
      const key = step.locator;
      if (!key || key === 'page') return;

      const locInfo = this._parseLocator(step.locator);
      let label = (locInfo && locInfo.label) || '';
      if (this._isJunkLabel(label)) label = '';
      label = label || this._extractDescriptionText(step) || this._humanizeName(step.elementName || '');
      label = this._tidyLabel(this._nameForSentence(step, label));

      const rawRole = step.role || (locInfo && locInfo.role) || this._inferRole(step);
      const role = rawRole ? this._readableRole(rawRole) : '';

      const existing = registry.get(key);
      const score = (label ? 2 : 0) + (role ? 1 : 0);
      const existingScore = existing ? (existing.label ? 2 : 0) + (existing.role ? 1 : 0) : -1;
      if (score > existingScore) registry.set(key, { label, role });
    });

    return registry;
  }

  /**
   * The recorded steps in the order the tester carried them out.
   *
   * Every step is placed by when its action BEGAN. For everything except typing
   * that is when it was recorded; for a fill it is when the first character was
   * entered, which the recorder stamps as startedAt. A stable sort keeps steps
   * that began at the same moment in their recorded order.
   *
   * A step carrying `after` is the exception: it was PLACED, by hand or by
   * recording into an insertion point part-way up the table, and it hangs
   * directly beneath the step it names however late it was actually recorded.
   * Placement is deliberately not expressed by rewriting timestamps — the merge
   * heuristics below read the real gaps between events (a run of the same key,
   * a widget echoing back the option just chosen, a navigation caused by the
   * click before it), so a faked timestamp would silently change which steps
   * merge. Real times are left alone and only the ORDER is overridden.
   */
  _inTesterOrder(steps) {
    const began = (step) => step.startedAt || step.ts || 0;
    const decorate = (list) => list
      .map((step, index) => ({ step, index }))
      .sort((a, b) => (began(a.step) - began(b.step)) || (a.index - b.index))
      .map(entry => entry.step);

    const present  = new Set(steps.map(s => s.id));
    // An anchor that has since been deleted is no anchor at all; the step falls
    // back to its own recorded moment rather than vanishing from the table.
    const anchored = new Map();  // anchor id -> steps hanging off it
    const pinned   = [];         // placed above everything (TOP)
    const roots    = [];
    steps.forEach(step => {
      const anchor = step.after;
      if (anchor === TestStepsTab.TOP) {
        pinned.push(step);
      } else if (anchor != null && anchor !== step.id && present.has(anchor)) {
        if (!anchored.has(anchor)) anchored.set(anchor, []);
        anchored.get(anchor).push(step);
      } else {
        roots.push(step);
      }
    });

    if (!anchored.size && !pinned.length) return decorate(roots);

    const out  = [];
    const seen = new Set();      // also breaks any cycle in the anchor chain
    const emit = (step) => {
      if (seen.has(step.id)) return;
      seen.add(step.id);
      out.push(step);
      const kids = anchored.get(step.id);
      if (kids) decorate(kids).forEach(emit);
    };
    decorate(pinned).forEach(emit);
    decorate(roots).forEach(emit);
    // Anything left is part of a cycle — show it rather than drop it.
    steps.forEach(step => { if (!seen.has(step.id)) { seen.add(step.id); out.push(step); } });
    return out;
  }

  /** Text reduced to what matters when comparing two labels for sameness. */
  _compareText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** The bare label for a step's element, without any role wording. */
  _elemLabel(step) {
    const entry = (this._registry && this._registry.get(step.locator)) || null;
    if (entry && entry.label) return entry.label;
    const locInfo = this._parseLocator(step.locator);
    let label = (locInfo && locInfo.label) || '';
    if (this._isJunkLabel(label)) label = '';
    return this._tidyLabel(this._nameForSentence(step,
      label || this._extractDescriptionText(step) || this._humanizeName(step.elementName || '')
    ));
  }

  /** Is this text a block of content rather than the name of a control? */
  _tooLongForName(text) {
    return String(text == null ? '' : text).trim().length > TestStepsTab.NAME_MAX;
  }

  /**
   * Cut a name on a word boundary, never through the middle of a word.
   *
   * A half-word reads as a typo and cannot be searched for on the page, which
   * is what made "…Quality Engineering Equi" worse than useless in a step.
   */
  _trimName(text) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (t.length <= TestStepsTab.NAME_MAX) return t;
    const cut = t.substring(0, TestStepsTab.NAME_MAX);
    const at  = cut.lastIndexOf(' ');
    return (at > TestStepsTab.NAME_MAX * 0.5 ? cut.substring(0, at) : cut).trim() + '…';
  }

  /**
   * The name to put in a sentence, which is not always the accessible name.
   *
   * A link's accessible name is every word inside it. For a card — one link
   * around a person's name, their job title, their department and where they
   * sit — that is the right thing for a LOCATOR (it is how Playwright finds
   * the link) and useless in an instruction: the whole card ended up quoted as
   * the name of the link, and then again as the name of a page.
   *
   * The recorder resolves the card's own heading live, in the DOM, and sends it
   * in the step description, so that is preferred whenever the accessible name
   * has run away. A trimmed name is the last resort — better a short name than
   * a paragraph, and better a paragraph than nothing.
   */
  _nameForSentence(step, label) {
    if (!this._tooLongForName(label)) return label;
    const narrower = this._extractDescriptionText(step) ||
                     this._humanizeName(step.elementName || '');
    if (narrower && !this._tooLongForName(narrower) && !this._isJunkLabel(narrower)) {
      return narrower;
    }
    return this._trimName(label);
  }

  /**
   * The element as a tester would refer to it, including where it is on screen.
   *   'the "Leave Policies" button in the navigation menu'
   *   'the image in the page header'      (no label available)
   */
  _elemPhrase(step, withRegion) {
    const label = this._elemLabel(step);
    const role  = this._roleOf(step);

    let phrase;
    // A name ending in "icon" came from the icon vocabulary, not from anything
    // written on screen. Quoting it and bolting a role on the end produces
    // 'the "Close Icon" button'; a tester says "the close icon".
    if (/\bicon$/i.test(label)) {
      phrase = `the ${label.toLowerCase()}`;
    }
    // A class-derived name often already ends in the role word: "csi-button"
    // humanises to "Csi Button", and appending the role gives
    // 'the "Csi Button" button'.
    else if (label && role && this._labelEndsWithRole(label, role)) {
      phrase = `the "${label}"`;
    }
    else if (label && role) phrase = `the "${label}" ${role}`;
    else if (label)         phrase = `"${label}"`;
    else if (role)          phrase = `the ${role}`;
    else                    phrase = 'the element';

    if (withRegion !== false) phrase += this._regionSuffix(step, label);
    return phrase;
  }

  /**
   * A control named in a sentence: its label in quotes when it has one, and a
   * plain description of the kind of control when it does not.
   *
   * Quoting the fallback produced 'the "checkbox" checkbox' and 'The "menu"
   * menu opens' whenever a label was rejected as junk — a stutter that reads
   * like a bug to whoever runs the test.
   *
   * @param {string} label - the label, possibly empty
   * @param {string} kind  - the word for this kind of control, e.g. 'checkbox'
   * @returns {string} 'the "Terms" checkbox' or 'the checkbox'
   */
  _named(label, kind) {
    // "save icon" names the control that was pressed, not the menu that
    // appeared: 'The "Save Icon" menu opens' is describing the wrong thing.
    if (label && /\bicon$/i.test(label) && !/icon/i.test(kind)) return `the ${kind}`;
    return label ? `the "${label}" ${kind}` : `the ${kind}`;
  }

  /** As _named, but capitalised for the start of a sentence. */
  _Named(label, kind) {
    const phrase = this._named(label, kind);
    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
  }

  /** True when appending the role would repeat the label's own last words. */
  _labelEndsWithRole(label, role) {
    if (!label || !role) return false;
    const re = new RegExp('(^|\\s)' + TestStepsTab.escapeRegExp(role) + '$', 'i');
    return re.test(String(label).trim());
  }

  /**
   * " in the page header" — or nothing, when saying it would be redundant.
   *
   * Without the overlap check a step reads "Enter the search text in the
   * "Search" field in the "Search" dialog": two prepositional phrases naming
   * the same thing.
   */
  _regionSuffix(step, label) {
    const region = step.region;
    if (!region) return '';

    if (label) {
      // Word-level comparison. Substring matching wrongly suppressed the region
      // for a link named "Me" inside "the navigation menu", because the word
      // "menu" happens to contain "me".
      const regionWords = new Set(
        region.toLowerCase().replace(/^the\s+/, '').split(/\W+/).filter(Boolean)
      );
      const labelWords = label.toLowerCase().split(/\W+/).filter(Boolean);
      if (labelWords.length && labelWords.every(w => regionWords.has(w))) return '';
    }

    return ` in ${region}`;
  }

  /** What a field is asking for, so the instruction reads naturally. */
  _valueNoun(label) {
    const l = (label || '').toLowerCase();
    if (/search|find|filter/.test(l))     return 'search text';
    if (/e-?mail/.test(l))                return 'email address';
    if (/password|passcode/.test(l))      return 'password';
    if (/phone|mobile|contact number/.test(l)) return 'phone number';
    // Anchored: an unanchored /to\b/ matched the word "to" anywhere, so
    // "Notes to reviewer" and "Report to manager" both asked for a date.
    if (/\bdate\b|\bdue\b|\bexpiry\b/.test(l))  return 'date';
    if (/^(from|to|start|end)$/.test(l.trim())) return 'date';
    if (/name/.test(l))                   return 'name';
    if (/code|id\b|number/.test(l))       return 'value';
    if (/comment|remark|reason|note|description/.test(l)) return 'text';
    return 'value';
  }

  _shortUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.pathname + (u.search || '');
    } catch (_) {
      return url;
    }
  }

  /** Most specific part of a document title: "Me | Timesheet" -> "Timesheet". */
  _cleanScreenName(name) {
    if (!name) return '';
    let raw = String(name).trim();

    // Strip the product name every page in the session carries:
    // "Staff Member Dashboard - ComplySci" is a screen called
    // "Staff Member Dashboard". Splitting on the hyphen alone cannot do this —
    // the brand sits at the end here and at the start in other apps.
    if (this._brand) {
      const b = TestStepsTab.escapeRegExp(this._brand);
      const stripped = raw
        .replace(new RegExp('\\s*[|\\u2013\\u2014\\u00b7:\\-]+\\s*' + b + '\\s*$', 'i'), '')
        .replace(new RegExp('^\\s*' + b + '\\s*[|\\u2013\\u2014\\u00b7:\\-]+\\s*', 'i'), '');
      if (stripped.trim()) raw = stripped.trim();
    }

    const parts = raw.split(/\s*[|–—·]\s*/).filter(Boolean);
    const pick = parts.length ? parts[parts.length - 1] : raw;
    return pick.trim().substring(0, 60);
  }

  /**
   * Index the screens seen in this recording, so a step whose only evidence is
   * a URL change can still be described by the page a tester would recognise.
   *
   * Two products of one pass over the recorded outcomes:
   *   _brand        the product name repeated across page titles, to strip
   *   _screenByPath path -> screen name, so "The URL changes to /ControlRoom/
   *                 Activities" becomes "The Activities page is displayed"
   */
  _buildScreenIndex(steps) {
    const titles = [];
    const seen   = [];

    steps.forEach(step => {
      const o = step.outcome;
      if (!o || o.kind !== 'screen') return;
      const heading = o.heading || o.title || '';
      const url     = o.url || step.url || '';
      if (!heading) return;
      titles.push(heading);
      if (url) seen.push({ heading, path: this._shortUrl(url).split('?')[0] });
    });

    this._brand = this._detectBrand(titles);

    // Built after the brand, so the stored names are already brand-free
    const byPath = new Map();
    seen.forEach(({ heading, path }) => {
      const name = this._cleanScreenName(heading);
      if (path && name && !byPath.has(path)) byPath.set(path, name);
    });
    this._screenByPath = byPath;
  }

  /**
   * The product name shared by the page titles in a recording, or ''.
   * A segment only counts as the brand when it appears in two or more
   * DIFFERENT titles — one title is not evidence of anything.
   */
  _detectBrand(titles) {
    const unique = Array.from(new Set(titles.map(t => String(t).trim()).filter(Boolean)));
    if (unique.length < 2) return '';

    const counts = new Map();
    unique.forEach(title => {
      const parts = title.split(/\s*[|–—·:]\s*|\s+-\s+/).filter(Boolean);
      if (parts.length < 2) return;   // a single-segment title carries no brand
      new Set(parts.map(p => p.trim())).forEach(seg => {
        counts.set(seg, (counts.get(seg) || 0) + 1);
      });
    });

    let brand = '', best = 1;
    counts.forEach((count, seg) => {
      if (count > best || (count === best && seg.length > brand.length)) {
        if (count >= 2) { brand = seg; best = count; }
      }
    });
    return brand;
  }

  /** The page a path belongs to, named as a tester would name it. */
  _screenNameForPath(url) {
    if (!url || !this._screenByPath) return '';
    return this._screenByPath.get(this._shortUrl(url).split('?')[0]) || '';
  }

  // ── Action sentence + test data ─────────────────────────────────────────────

  /**
   * Describe one step the way a manual test case does: what the tester does,
   * to which control, and where that control is — with any value the tester has
   * to supply pulled out into its own Test Data column.
   *
   * @returns {{ action: string, testData: string }}
   */
  _describeAction(step, isFirst, repeat) {
    const label  = this._elemLabel(step);
    const phrase = this._elemPhrase(step);
    const where  = this._regionSuffix(step, label);
    const fieldName = label ? `the "${label}" field` : 'the field';

    switch (step.type) {

      case 'navigate': {
        const screen = this._cleanScreenName(
          (step.outcome && step.outcome.kind === 'screen' && step.outcome.heading) || ''
        );
        const action = isFirst
          ? (screen
              ? `Launch the browser and open the "${screen}" page of the application`
              : 'Launch the browser and open the application URL')
          : (screen
              ? `Navigate directly to the "${screen}" page using its URL`
              : 'Navigate directly to the page using its URL');
        return { action, testData: step.url || '' };
      }

      case 'click':
        return { action: `Click on ${phrase}`, testData: '' };

      case 'dblclick':
        return { action: `Double-click on ${phrase}`, testData: '' };

      case 'rightClick':
        return { action: `Right-click on ${phrase} to open the context menu`, testData: '' };

      case 'hover':
        return { action: `Move the mouse pointer over ${phrase}`, testData: '' };

      case 'tap':
        return { action: `Tap on ${phrase}`, testData: '' };

      case 'fill': {
        const noun = this._valueNoun(label);
        return {
          action: `Enter the ${noun} in ${fieldName}${where}`,
          testData: step.displayValue || step.value || ''
        };
      }

      case 'select':
        return {
          action: `Select an option from ${this._named(label, 'dropdown')}${where}`,
          testData: step.displayValue || step.value || ''
        };

      case 'check':
        return { action: `Select ${this._named(label, 'checkbox')}${where}`, testData: '' };

      case 'uncheck':
        return { action: `Clear ${this._named(label, 'checkbox')}${where}`, testData: '' };

      case 'press': {
        const key = step.value || step.displayValue || '';
        // Four rows reading "Press the Backspace key" is not four instructions
        // — it is one instruction carried out four times.
        const times = repeat > 1 ? ` ${repeat} times` : '';
        return {
          action: label
            ? `Press the ${key} key${times} while focus is in ${fieldName}`
            : `Press the ${key} key${times}`,
          testData: key
        };
      }

      case 'submit':
        return { action: `Submit the form${where}`, testData: '' };

      case 'fileUpload':
        return {
          action: `Upload a file using ${this._named(label, 'file upload control')}${where}`,
          testData: step.displayValue || step.value || ''
        };

      case 'scroll': {
        const dy = parseInt(step.value, 10) || 0;
        return {
          action: `Scroll ${dy >= 0 ? 'down' : 'up'} the page`,
          testData: `${Math.abs(dy)} px`
        };
      }

      case 'dragDrop':
        return {
          action: label
            ? `Drag "${label}" and drop it onto "${step.displayValue || 'the target'}"`
            : 'Drag the element and drop it onto the target',
          testData: ''
        };

      case 'dialog':
        return {
          action: `${step.value === 'accept' ? 'Accept' : 'Dismiss'} the browser dialog message`,
          testData: step.displayValue || ''
        };

      case 'manual':
        // Nothing was observed, so there is nothing to describe. The text comes
        // from the tester, through the same override the other columns use.
        return { action: '', testData: '' };

      default:
        return { action: step.description || step.type, testData: '' };
    }
  }

  // ── Expected results ────────────────────────────────────────────────────────

  /**
   * Turn a measured outcome into an Expected Result sentence.
   * The order mirrors the recorder's ladder: a URL change is the weakest
   * evidence an action worked, so it is only used when nothing better was seen.
   * @returns {string|null} null when nothing observable happened
   */
  _outcomeToEnglish(outcome, step) {
    if (!outcome) return null;
    const label = this._elemLabel(step);
    const role  = this._roleOf(step);

    switch (outcome.kind) {
      case 'dialogOpened':
        return outcome.title && outcome.title !== 'dialog'
          ? `The "${outcome.title}" dialog opens`
          : 'A dialog opens';

      case 'dialogClosed':
        return outcome.title && outcome.title !== 'dialog'
          ? `The "${outcome.title}" dialog closes`
          : 'The dialog closes';

      case 'message':
        return `The message "${outcome.text}" is displayed`;

      case 'screen': {
        const screen = this._cleanScreenName(outcome.heading);
        return screen
          ? `The "${screen}" page is displayed`
          : `The ${this._shortUrl(outcome.url)} page is displayed`;
      }

      case 'panelOpened': {
        const what = label || this._tidyLabel(outcome.label || '');
        const named = this._Named(this._isJunkLabel(what) ? '' : what,
                                  outcome.hover ? 'submenu' : 'menu');
        return `${named} opens and its options are listed`;
      }

      case 'panelClosed': {
        // Clicking an option in a dropdown closes the dropdown. Reporting that
        // as "The "QaAuto Allow Revision" menu closes" names the option as if
        // it were the menu; what happened is that the option was chosen.
        if (/^(option|item|list item|menu item)$/i.test(role || '') && label) {
          return `"${label}" is selected and the list of options closes`;
        }
        const shut = label || this._tidyLabel(outcome.label || '');
        return `${this._Named(this._isJunkLabel(shut) ? '' : shut, 'menu')} closes`;
      }

      case 'expanded':
        return `${this._Named(label, 'menu')} expands and its options are shown`;

      case 'collapsed':
        return `${this._Named(label, 'menu')} collapses`;

      case 'selected': {
        const what = label;
        const kind = role || 'item';
        // A dropdown option, list item or menu item has no content of its own
        // to reveal — only a tab or a tree node does. "'Contains' becomes the
        // selected option and its content is shown" describes nothing.
        const chosen = what ? `"${what}"` : 'The item';
        if (/^(option|item|list item|menu item|dropdown list)$/i.test(kind)) {
          return `${chosen} is shown as the selected ${kind === 'dropdown list' ? 'option' : kind}`;
        }
        return `${chosen} becomes the selected ${kind} and its content is shown`;
      }

      case 'checked':
        return `${this._Named(label, 'checkbox')} is ticked`;

      case 'unchecked':
        return `${this._Named(label, 'checkbox')} is cleared`;

      case 'listCountChanged': {
        if (outcome.hover) {
          return `${this._Named(label, 'submenu')} opens showing ${outcome.to} items`;
        }
        const term = step.type === 'fill' ? (step.displayValue || step.value || '') : '';
        if (term) {
          return `The list filters to ${outcome.to} result${outcome.to === 1 ? '' : 's'} matching "${term}"`;
        }
        // A control whose own label says it expands the list deserves wording
        // that matches the intent, not a bare row count.
        if (/\b(show|view|see|load|display)\s*(all|more)\b|\bexpand\b/i.test(label || '') &&
            outcome.to > outcome.from) {
          return `The full list of ${outcome.to} items is displayed (${outcome.from} were shown before)`;
        }
        return outcome.to > outcome.from
          ? `The list updates to show ${outcome.to} rows (was ${outcome.from})`
          : `The list narrows to ${outcome.to} row${outcome.to === 1 ? '' : 's'} (was ${outcome.from})`;
      }

      case 'listReordered':
        return label
          ? `The list is re-sorted by "${label}" — "${outcome.first}" is now the first row`
          : `The list order changes — "${outcome.first}" is now the first row`;

      case 'contentExpanded':
        // A page-level size change cannot be pinned on the control that was
        // pressed, so it must not be worded as if it could.
        if (outcome.page) return 'Additional content is displayed on the page';
        return label
          ? `Additional content is displayed under "${label}"`
          : 'Additional content is displayed on the page';

      case 'contentCollapsed':
        if (outcome.page) return 'The expanded content is hidden';
        return label
          ? `The content under "${label}" is hidden`
          : 'The expanded content is hidden';

      case 'selectionChanged': {
        const marked = this._tidyLabel(outcome.label || '');
        return marked && !this._isJunkLabel(marked)
          ? `"${marked}" is highlighted as the current selection`
          : `${label ? `"${label}"` : 'The selected item'} is highlighted as the current selection`;
      }

      case 'scrolled':
        return outcome.dy > 0
          ? 'The page scrolls down to the content the control points to'
          : 'The page scrolls back up the page';

      case 'valueSet':
        return `${this._Named(label, 'field')} contains "${outcome.value}"`;

      case 'valueCleared': {
        // Named from the FIELD that was emptied, never from the control that
        // was pressed. Those are different elements — a search box is cleared
        // by an × of its own, a form by a Reset button beside it — and
        // borrowing the pressed element's label wrote nonsense: a click on a
        // person's card in a details panel came out as 'The "Associate Software
        // Engineer G1" field is cleared and is empty'.
        const emptied = this._tidyLabel(outcome.name || '');
        if (outcome.count > 1) return 'The entered values are cleared and the fields are empty';
        return (emptied && !this._isJunkLabel(emptied))
          ? `The "${emptied}" field is cleared and is empty`
          : 'The entered value is cleared and the field is empty';
      }

      case 'focused':
        const focusedName = label || this._tidyLabel(outcome.label || '');
        return `${this._Named(this._isJunkLabel(focusedName) ? '' : focusedName, 'field')}` +
               ' receives focus and is ready for input';

      case 'url': {
        // A URL change is the weakest evidence there is, and no manual tester
        // verifies an address bar. If any step in this recording landed on the
        // same path and reported a heading, name the page instead.
        const known = this._screenNameForPath(outcome.url);
        const named = known ? `"${known}"` : this._shortUrl(outcome.url).split('?')[0];
        return outcome.samePath
          ? `The ${named} page reloads with the updated parameters`
          : `The ${named} page is displayed`;
      }

      case 'none':
      default:
        return null;
    }
  }

  /**
   * Expected results that follow from the action itself and need no observation.
   *
   * Typing a value into a field means the value is in the field — that is not a
   * guess, and it is a far more useful row than "no change detected". Clicks on
   * buttons and links are deliberately NOT covered: what they should do is real
   * knowledge we do not have, and inventing it would be worse than flagging it.
   */
  _implicitExpected(step) {
    const label = this._elemLabel(step);
    const role  = this._roleOf(step);

    switch (step.type) {
      case 'fill': {
        const shown = step.displayValue || step.value || '';
        if (!shown) return null;
        return `The value "${shown}" is entered and displayed in ${this._named(label, 'field')}`;
      }
      case 'select': {
        const shown = step.displayValue || step.value || '';
        if (!shown) return null;
        return `"${shown}" is shown as the selected option in ${this._named(label, 'dropdown')}`;
      }
      case 'check':
        return `${this._Named(label, 'checkbox')} is ticked`;
      case 'uncheck':
        return `${this._Named(label, 'checkbox')} is cleared`;
      case 'click':
        // Clicking into a text field has one self-evident result
        if (role === 'field' || role === 'text area') {
          return `${this._Named(label, 'field')} receives focus and the cursor is ready for input`;
        }
        return null;
      case 'navigate': {
        const known = this._screenNameForPath(step.url);
        return known
          ? `The "${known}" page is displayed`
          : `The application page at ${this._shortUrl(step.url)} is loaded`;
      }

      case 'scroll': {
        // Scrolling always has a result, and it is the same one every time.
        const dy = parseInt(step.value, 10) || 0;
        return dy >= 0
          ? 'The page scrolls down and the content further down the page is displayed'
          : 'The page scrolls up and the content higher up the page is displayed';
      }

      case 'press': {
        // What these keys do is defined by the browser, not by the
        // application, so it is not a guess for any of them.
        const key = String(step.value || step.displayValue || '').toLowerCase();
        const where = label ? ` in ${this._named(label, 'field')}` : '';
        if (key === 'tab')       return 'Focus moves to the next control on the page';
        if (key === 'shift+tab') return 'Focus moves back to the previous control on the page';
        if (key === 'backspace') return `The character before the cursor is deleted${where}`;
        if (key === 'delete')    return `The character after the cursor is deleted${where}`;
        if (key === 'control+a') return `All the text${where || ' in the field'} is selected`;
        if (key === 'control+c') return 'The selected text is copied to the clipboard';
        if (key === 'control+x') return `The selected text is cut${where}`;
        if (key === 'control+v') return `The copied text is pasted${where}`;
        if (key === 'home')      return 'The cursor moves to the start';
        if (key === 'end')       return 'The cursor moves to the end';
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * The expected result a control's OWN NAME implies, for the steps where
   * nothing observable could be measured.
   *
   * This is inference, not observation, so every sentence it returns is still
   * flagged for the tester to confirm — but "The changes are saved" is a
   * starting point a tester can correct in two seconds, where "No page change
   * was detected" is a blank page they have to fill in from memory.
   *
   * It is application-agnostic because it keys on the words the application
   * itself puts on its buttons and the icon vocabulary every icon set has
   * agreed on for years — never on anything specific to one product.
   *
   * @returns {string|null} null when the control has no name to reason from
   */
  _inferredExpected(step) {
    const PRESSED = ['click', 'dblclick', 'tap', 'rightClick', 'press'];
    if (!PRESSED.includes(step.type)) return null;

    const label    = this._elemLabel(step);
    const role     = this._roleOf(step);
    const inDialog = /dialog|modal|pop-?up|overlay/i.test(step.region || '');
    const named    = label ? '"' + label + '"' : '';
    const panel    = inDialog ? 'dialog' : 'panel';

    if (step.type === 'rightClick') {
      return named
        ? 'The context menu for ' + named + ' opens with its options listed'
        : 'The context menu opens with its options listed';
    }

    if (step.type === 'press') {
      const key = String(step.value || step.displayValue || '').toLowerCase();
      if (key.includes('enter')) {
        return 'The entered value is submitted and the result is shown';
      }
      if (key.includes('escape')) {
        return 'The open ' + panel + ' closes without saving the changes';
      }
      if (key.includes('arrowdown') || key.includes('arrowright')) {
        return 'The next option in the list is highlighted';
      }
      if (key.includes('arrowup') || key.includes('arrowleft')) {
        return 'The previous option in the list is highlighted';
      }
      if (key.includes('pagedown')) return 'The page moves down to the next screenful';
      if (key.includes('pageup'))   return 'The page moves up to the previous screenful';
      if (key === ' ' || key.includes('space')) {
        return 'The control in focus is toggled';
      }
      return null;
    }

    // What the control says it does. Matched against the visible name, which
    // for an icon-only control is the icon's meaning ("save icon", "close
    // icon") resolved by the recorder.
    if (label) {
      const hay = label.toLowerCase();
      for (let i = 0; i < TestStepsTab.CONTROL_INTENTS.length; i++) {
        const entry = TestStepsTab.CONTROL_INTENTS[i];
        if (entry[0].test(hay)) return entry[1]({ named, label, role, inDialog, panel });
      }
    }

    // No vocabulary matched. The KIND of control still says something.
    if (label) {
      switch (role) {
        case 'link':          return 'The ' + named + ' page is displayed';
        case 'tab':           return 'The ' + named + ' tab is selected and its content is shown';
        case 'menu item':     return 'The ' + named + ' section is displayed';
        case 'option':
        case 'list item':     return named + ' is shown as the selected option';
        case 'dropdown':
        case 'dropdown list':
        case 'combobox':      return 'The list of options in the ' + named +
                                     ' dropdown opens';
        case 'field':
        case 'text area':     return 'The ' + named + ' field receives focus and is ready ' +
                                     'for input';
        case 'row':
        case 'cell':          return 'The selected row ' + named + ' is highlighted';
        case 'column header': return 'The list is re-sorted by ' + named;
        default:
          // Where the control lives says something when its kind does not: a
          // named control in a navigation area opens a section.
          if (/nav|menu|sidebar|side ?bar|tab ?bar/i.test(step.region || '')) {
            return 'The ' + named + ' section is displayed';
          }
          return 'The ' + named + ' action is carried out and its result is shown on the page';
      }
    }

    // Nothing observed AND nothing to read: saying anything here would be
    // making it up, so the step stays honestly incomplete.
    return null;
  }

  /**
   * Expected Result for one prepared step.
   * @returns {{ text: string, flagged: boolean, pending?: boolean }}
   */
  _expectedFor(vm) {
    const step = vm.step;

    if (step.expectedOverride) {
      return { text: step.expectedOverride, flagged: false };
    }

    // Nothing was measured for a hand-written step and nothing should be
    // guessed. An empty cell is the honest state, and it is not a warning.
    if (step.type === 'manual') {
      return { text: '', flagged: false };
    }

    // A navigation caused by this action is the strongest evidence it worked.
    // The same guard as below applies: what was measured while a page was
    // loading describes the new page arriving, never a control being operated.
    // Without this, a click that loaded a page could report "The "Page" menu
    // opens" — the menu the new page rendered on its way in.
    if (vm.navOutcome) {
      const navOutcome = vm.navOutcome.outcome;
      const usable = navOutcome && TestStepsTab.NAVIGATION_OUTCOMES.has(navOutcome.kind);
      const navText = usable
        ? this._outcomeToEnglish(navOutcome, vm.navOutcome.step)
        : null;
      if (navText) return { text: navText, flagged: false };

      const url    = vm.navOutcome.step.url;
      const screen = this._screenNameForPath(url);
      if (screen) return { text: `The "${screen}" page is displayed`, flagged: false };
      const short = this._shortUrl(url).split('?')[0];
      if (short) return { text: `The ${short} page is displayed`, flagged: false };
    }

    // Same heading and same path as the step before: this was an in-page tab or
    // section switch, not a navigation. Repeating "The Profile page is
    // displayed" three times in a row tells a tester nothing.
    if (vm.screenRepeat) {
      const label = this._elemLabel(step);
      const role  = this._roleOf(step) || 'tab';
      return {
        text: label
          ? `The "${label}" ${role} is selected and its content is shown`
          : 'The selected section content is shown',
        flagged: false
      };
    }

    // An event the recorder folded into this step (a form submit fired by the
    // click) may have seen more than the click itself did.
    let outcome = step.outcome;
    if ((!outcome || outcome.kind === 'none') && vm.foldedOutcome) {
      outcome = vm.foldedOutcome;
    }

    // The typing that follows is its own row, so a click that merely put the
    // cursor in the field must not report the typed value as its result. The
    // click's settle window overlaps the typing — the tester types INTO it —
    // so the measurement is real; it just belongs to the next step.
    if (vm.typedNext && outcome && outcome.kind === 'valueSet') {
      outcome = null;
    }

    // A page load cannot open a menu or select a tab. When the settle window
    // closes before an SPA has rendered its heading, the diff falls through to
    // whatever else appeared — panels, list rows — and attributes it to the act
    // of loading the page. Only outcomes that describe a page ARRIVING are
    // believable for a navigation.
    if (step.type === 'navigate' && outcome &&
        !TestStepsTab.NAVIGATION_OUTCOMES.has(outcome.kind)) {
      outcome = null;
    }

    const text = this._outcomeToEnglish(outcome, step);
    if (text) return { text, flagged: false };

    const implicit = this._implicitExpected(step);
    if (implicit) return { text: implicit, flagged: false };

    if (!step.outcome && this.isRecording) {
      return { text: 'Measuring…', flagged: false, pending: true };
    }

    // Nothing was observable. Rather than hand back a blank row, say what the
    // control's own name says it does — flagged, because this is read off the
    // button, not measured.
    const inferred = this._inferredExpected(step);
    if (inferred) return { text: inferred, flagged: true, inferred: true };

    // A component the recorder could not see into (a closed shadow root) is a
    // different problem from "nothing happened", and guessing from the wrapper's
    // name is how three different buttons in one widget came out as three
    // identical rows. Say what is actually wrong so the tester knows to write
    // this step themselves.
    if (step.opaque) {
      return {
        text: 'This control is inside a component the recorder cannot read — ' +
              'describe what should happen',
        flagged: true
      };
    }

    // Wording note: this sentence is the ONLY signal that the step needs a
    // human, so it has to say so in full — nothing else marks the row.
    return {
      text: 'No page change was detected — confirm the expected outcome',
      flagged: true
    };
  }

  // ── Step preparation (noise removal + navigation folding) ───────────────────

  /**
   * Turn the raw recorded stream into the steps a QA reader should see.
   *
   *   1. Hovers that changed nothing were mouse travel, not instructions.
   *   2. A navigation a click caused is that click's EXPECTED RESULT, not a step.
   *   3. Clicking into a field and then typing into it is one instruction.
   *
   * @returns {Array} view models: { step, action, testData, expected, flagged }
   */
  _prepareSteps() {
    this._registry = this._buildLabelRegistry(this.steps);
    this._buildScreenIndex(this.steps);

    const NAV_WINDOW_MS  = 3000;
    const SAME_PRESS_MS  = 1500;   // one press of one control, seen twice
    const REPEAT_KEY_MS  = 3000;   // the same key pressed again, still one instruction
    const POINTER = ['click', 'dblclick', 'rightClick', 'tap'];

    // Pass 0 — put the steps in the order the tester carried them out.
    //
    // A typed value can only be recorded once it is final, which is when focus
    // leaves the field — and that is usually the click on whatever comes next.
    // Recording order therefore had the click BEFORE the typing that led to it:
    //   Click on the "QaAuto AllowRevision" option
    //   Enter the value in the "Select the employee..." field
    // The recorder stamps a fill with the moment typing began, so ordering by
    // that puts the two back the right way round. Ties keep their recorded
    // order, so nothing else moves.
    const source = this._inTesterOrder(this.steps);

    // Pass 1 — drop hovers that led nowhere, and clicks that merely focused a
    // field the very next step types into.
    //
    // Each surviving entry records the id of EVERY event it was built from, in
    // `ids`. Deleting a row has to remove all of them: a row can stand for four
    // Backspaces, or a click plus the submit it fired, and removing only the
    // first left the rest to reappear as a row of their own — press the × on
    // "Press the Backspace key 4 times" and a row saying "3 times" took its
    // place.
    const kept = [];
    let carry = [];        // ids of events that belong to whatever comes next

    /** Keep this step as a row of its own, owning any carried-over events. */
    const keep = (entry) => {
      entry.ids = [entry.step.id].concat(carry);
      carry = [];
      kept.push(entry);
    };

    /** This event belongs to the row before it. */
    const mergeBack = (step) => {
      if (kept.length) kept[kept.length - 1].ids.push(step.id);
      else carry.push(step.id);
    };

    /** This event belongs to the row that comes after it. */
    const mergeForward = (step) => { carry.push(step.id); };

    source.forEach((step, origIndex) => {
      const next = source[origIndex + 1];
      const prev = source[origIndex - 1];

      if (step.type === 'hover') {
        // Only a hover that REVEALED something is an instruction. A hover
        // credited with a panel closing was the pointer leaving the panel it
        // had opened two steps earlier — "Move the mouse pointer over the close
        // icon / The Close Icon menu closes" is not a test step.
        const kind = (step.outcome && step.outcome.kind) || 'none';
        if (!TestStepsTab.HOVER_OUTCOMES.has(kind)) { mergeForward(step); return; }
        const sameAsNext = next && POINTER.includes(next.type) && next.locator === step.locator;
        const sameAsPrev = prev && POINTER.includes(prev.type) && prev.locator === step.locator;
        if (sameAsNext) { mergeForward(step); return; }
        if (sameAsPrev) { mergeBack(step);    return; }
      }

      // Holding Backspace to clear a field produces one step per character.
      // They are one instruction: "Press the Backspace key 4 times".
      if (step.type === 'press' && kept.length) {
        const last = kept[kept.length - 1];
        const sameKey = last.step.type === 'press' &&
                        String(last.step.value || '') === String(step.value || '') &&
                        last.step.locator === step.locator;
        // The run is measured from the last press in it, held on the view
        // model. Writing it back to the recorded step would change the gaps on
        // the next render, and the table would come out differently each time.
        const runEnd = last.runEndTs || last.step.ts;
        const gap = (step.ts && runEnd) ? (step.ts - runEnd) : 0;
        if (sameKey && gap >= 0 && gap <= REPEAT_KEY_MS) {
          last.repeat = (last.repeat || 1) + 1;
          last.runEndTs = step.ts;
          if (step.outcome && step.outcome.kind !== 'none') last.foldedOutcome = step.outcome;
          mergeBack(step);
          return;
        }
      }

      // A click on a submit button fires a click AND a submit. Two rows for one
      // press of one button reads as two instructions, and the second one
      // ("Submit the form") repeats the first one's expected result. Keep the
      // click — it names the button the tester presses — but carry over the
      // submit's outcome, which is often the richer of the two.
      if (step.type === 'submit' && kept.length) {
        const last = kept[kept.length - 1];
        const dt = (step.ts && last.step.ts) ? (step.ts - last.step.ts) : 0;
        if (POINTER.includes(last.step.type) && dt >= 0 && dt <= SAME_PRESS_MS) {
          if (step.outcome && step.outcome.kind !== 'none') last.foldedOutcome = step.outcome;
          mergeBack(step);
          return;
        }
      }

      // An icon nested inside a control registers its own click. With no name
      // of its own and nothing observed, the row reads "Click on the image" —
      // a step the tester cannot act on, describing a click they only made
      // once. Drop it in favour of the real control next to it.
      if (POINTER.includes(step.type) &&
          (!step.outcome || step.outcome.kind === 'none') &&
          !this._elemLabel(step)) {
        const nearby = (other) => {
          if (!other) return false;
          if (!POINTER.includes(other.type) && other.type !== 'hover') return false;
          const dt = Math.abs((other.ts || 0) - (step.ts || 0));
          return other.locator !== step.locator && dt <= SAME_PRESS_MS;
        };
        if (nearby(next)) { mergeForward(step); return; }
        if (nearby(prev)) { mergeBack(step);    return; }
      }

      // A dropdown widget writes the chosen option's text into its input. That
      // is the application echoing the selection, not the tester typing — and
      // the click on the option already says what was chosen.
      //
      // A value the tester really typed survives this: it is the few characters
      // they entered to filter the list, not the full option label, and pass 0
      // has already moved it above the click.
      if ((step.type === 'fill' || step.type === 'select') && (step.value || step.displayValue)) {
        const written = this._compareText(step.displayValue || step.value);
        const echoes = (other) => {
          if (!other || !['click', 'dblclick', 'tap'].includes(other.type)) return false;
          if (!/^(option|item|list item|menu item)$/i.test(this._roleOf(other) || '')) return false;
          const chosen = this._elemLabel(other);
          return !!chosen && this._compareText(chosen) === written;
        };
        if (echoes(prev)) { mergeBack(step);    return; }
        if (echoes(next)) { mergeForward(step); return; }
      }

      // A click that operates the control acted on next.
      //   "Click the Terms label"    + "Select the Terms checkbox"
      //   "Click the custom toggle"  + "Select the toggle's checkbox"
      //   "Click the Search field"   + "Enter x in the Search field"
      // The label and the control it operates are different elements, so their
      // locators differ — matching on the label they share catches the rest,
      // and the recorder resolves real <label> elements at source.
      let typedNext = false;
      if (step.type === 'click' && next &&
          ['fill', 'select', 'check', 'uncheck'].includes(next.type)) {
        const label = this._elemLabel(step);
        const dt = (next.ts && step.ts) ? (next.ts - step.ts) : 0;
        const sameControl = next.locator === step.locator ||
          (!!label && label === this._elemLabel(next) && dt >= 0 && dt <= SAME_PRESS_MS);

        if (sameControl) {
          // Ticking a box or choosing from a dropdown is ONE physical click:
          // clicking a <label> is how the box gets ticked, so two rows would
          // describe the same press twice.
          if (next.type !== 'fill') { mergeForward(step); return; }

          // Typing is different. "Click the field" and "Enter the value" are
          // two instructions, and a tester following the case needs both — the
          // second one alone does not say where the cursor goes. Collapsing
          // them also hid the typing completely whenever the fill went
          // missing, leaving a click row whose expected result quietly
          // reported the typed text as though the click had done it.
          typedNext = true;
        }
      }

      // A single click can register twice when a control nests presentational
      // elements (an icon span inside a link, say). If two consecutive pointer
      // steps resolve to the same label and the first achieved nothing, it was
      // the same click seen twice.
      if (POINTER.includes(step.type) && next && POINTER.includes(next.type)) {
        const dt = (next.ts && step.ts) ? (next.ts - step.ts) : 0;
        const kind = (step.outcome && step.outcome.kind) || 'none';
        // Clicking a control that is ALREADY the focused one achieves nothing
        // the row before it did not: the cursor was there already. Without
        // this, a field clicked twice produced two identical rows, each saying
        // the field receives focus.
        const nothingNew = kind === 'none' ||
                           (kind === 'focused' && next.locator === step.locator);
        const sameLabel = this._elemLabel(step) &&
                          this._elemLabel(step) === this._elemLabel(next);
        if (nothingNew && sameLabel && dt >= 0 && dt <= 1500) {
          mergeForward(step);
          return;
        }
      }

      keep({ step, origIndex, typedNext });
    });

    // Events dropped after the last surviving row still have to belong to it
    if (carry.length && kept.length) {
      kept[kept.length - 1].ids.push(...carry);
      carry = [];
    }

    // Pass 2 — fold click-caused navigations into the action that caused them
    const out = [];
    kept.forEach(entry => {
      const step = entry.step;

      if (step.type === 'navigate' && out.length > 0) {
        const prev = out[out.length - 1];
        const prevStep = prev.step;
        const causedByAction = POINTER.includes(prevStep.type) ||
                               ['press', 'submit', 'select'].includes(prevStep.type);
        const dt = (step.ts && prevStep.ts) ? (step.ts - prevStep.ts) : 0;
        const withinWindow = dt >= 0 && dt <= NAV_WINDOW_MS;

        if (causedByAction && (withinWindow || prev.navOutcome)) {
          prev.navOutcome = { step, outcome: step.outcome };
          prev.ids = (prev.ids || []).concat(entry.ids || [step.id]);
          return;
        }

        if (prevStep.type === 'navigate') {
          const samePath = this._shortUrl(prevStep.url).split('?')[0] ===
                           this._shortUrl(step.url).split('?')[0];
          if (samePath) {
            // The newer navigation replaces the older one, and inherits it
            entry.ids = (prev.ids || []).concat(entry.ids || []);
            out[out.length - 1] = entry;
            return;
          }
        }
      }

      // The kept entry is carried through as-is: it may already hold the
      // outcome of an event folded into it in pass 1.
      out.push(entry);
    });

    // Pass 3 — compose the sentences, tracking which screen we are on so a
    // repeated heading is reported as an in-page switch rather than a navigation
    let lastScreen = '';
    let lastPath   = '';

    out.forEach((vm, idx) => {
      const effective = (vm.navOutcome && vm.navOutcome.outcome) || vm.step.outcome;
      if (effective && effective.kind === 'screen') {
        const screen = this._cleanScreenName(effective.heading);
        const path   = this._shortUrl(effective.url || vm.step.url || '').split('?')[0];
        // Only compare paths when both are known: a click step carries no URL,
        // so requiring a match meant the same screen was reported over and
        // over — "The Certifications page is displayed" against a click on a
        // menu that opened no page at all.
        const samePlace = (!path || !lastPath) ? true : path === lastPath;
        if (screen && screen === lastScreen && samePlace) {
          vm.screenRepeat = true;
        } else {
          lastScreen = screen;
          if (path) lastPath = path;
        }
      }

      // The page this step is carried out on, for anything that needs to talk
      // about where the tester is
      vm.screen = lastScreen;

      const described = this._describeAction(vm.step, idx === 0, vm.repeat || 1);
      // A tester's correction always wins over what was generated
      vm.action   = vm.step.actionOverride   || described.action;
      vm.testData = vm.step.testDataOverride || described.testData;

      const expected = this._expectedFor(vm);
      vm.expected = expected.text;
      vm.flagged  = expected.flagged;
      vm.pending  = !!expected.pending;
      vm.inferred = !!expected.inferred;
    });

    return out;
  }

  // ── Step table rendering ────────────────────────────────────────────────────

  _renderStepList() {
    if (!this.stepList) return;

    // Never blow away a half-typed cell. New steps arriving while the user
    // edits are rendered once editing finishes.
    if (this._editingIdx !== null && this._editingIdx !== undefined) {
      this._renderQueued = true;
      return;
    }
    this._renderQueued = false;

    const prepared = this._prepared = this._prepareSteps();
    this.stepCount.textContent = prepared.length;

    if (!prepared.length) {
      // Once a row exists, "+" on the row itself is the way to add another;
      // this is only here because an empty table has no row to hover.
      this.stepList.innerHTML =
        '<p class="ts-empty">Click "Start Recording" then interact with the page.<br>' +
        '<button id="tsAddFirst" class="ts-empty-add">&#43; Add a step by hand</button></p>';
      const addFirst = document.getElementById('tsAddFirst');
      if (addFirst) addFirst.addEventListener('click', () => this._insertManualStep());
      return;
    }

    const esc = window.PalTechUtils.escapeHtml;

    // The column widths live in a <colgroup> rather than in the stylesheet.
    // The panel's global table rules (th:nth-child(1) { width: 13% } and the
    // rest, written for the inspector results table) outrank a class selector,
    // which is why the "#" column used to take an eighth of the table. A width
    // declared on <col> beats any cell rule in a fixed-layout table.
    let html = `
      <table class="ts-table">
        <colgroup>
          <col style="width:52px">
          <col style="width:34%">
          <col style="width:16%">
          <col>
        </colgroup>
        <thead>
          <tr>
            <th class="ts-col-num">S.No</th>
            <th class="ts-col-action">Action Performed</th>
            <th class="ts-col-data">Test Data</th>
            <th class="ts-col-exp">Expected Result</th>
          </tr>
        </thead>
        <tbody>`;

    // The row the next recorded step will land on, so that "start recording and
    // the steps appear up here" is something the tester can see coming.
    const cursorId = this._insertAfterId;

    prepared.forEach((vm, idx) => {
      const expClass = vm.flagged ? ' ts-exp-flagged'
                     : vm.pending ? ' ts-exp-pending'
                     : '';
      const marker = vm.flagged ? '<span class="ts-exp-warn">&#9888;</span> ' : '';
      const manual = vm.step.type === 'manual';
      const cursor = cursorId != null &&
        (vm.ids || [vm.step.id]).indexOf(cursorId) >= 0;

      // Every cell a tester may need to correct is rendered the same way, with
      // a placeholder when there is nothing in it yet.
      const cell = (field, text, extraClass, prefix) => {
        const spec = TestStepsTab.EDITABLE[field];
        const body = (text === '' || text == null)
          ? `<span class="ts-cell-empty">${esc(spec.empty)}</span>`
          : esc(text);
        return `<td class="ts-cell-${spec.cls}${extraClass || ''}"` +
               ` data-idx="${idx}" data-field="${field}"` +
               ` title="Click to edit">${prefix || ''}${body}</td>`;
      };

      const cursorTitle = this._isBlankManual(vm.step)
        ? 'Recorded steps will be added here'
        : 'Recorded steps will be added below this step';

      html += `
        <tr class="ts-row${manual ? ' ts-row-manual' : ''}${cursor ? ' ts-row-cursor' : ''}"
            data-idx="${idx}"${cursor ? ` title="${cursorTitle}"` : ''}>
          <td class="ts-cell-num">
            <span class="ts-num">${idx + 1}</span>
            <span class="ts-row-tools">
              <button class="ts-row-add" data-idx="${idx}" title="Insert a step below">&#43;</button>
              <button class="ts-row-del" data-idx="${idx}" title="Remove this step">&times;</button>
            </span>
          </td>
          ${cell('action', vm.action)}
          ${cell('data', vm.testData)}
          ${cell('exp', vm.expected, expClass, marker)}
        </tr>`;
    });

    html += '</tbody></table>';

    this.stepList.innerHTML = html;
    this._bindStepListEvents();
  }

  _bindStepListEvents() {
    this.stepList.querySelectorAll('.ts-row-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeRow(parseInt(btn.dataset.idx, 10));
      });
    });

    this.stepList.querySelectorAll('.ts-row-add').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._insertManualStep(parseInt(btn.dataset.idx, 10));
      });
    });

    // Action, Test Data and Expected Result are all correctable: the sentences
    // are generated from what the recorder could observe, and the tester is the
    // one who knows what the step is for.
    this.stepList.querySelectorAll('[data-field]').forEach(cell => {
      cell.addEventListener('click', () => {
        this._beginEdit(parseInt(cell.dataset.idx, 10), cell.dataset.field);
      });
    });
  }

  /**
   * True while a cell is open in the inline editor.
   *
   * A row whose editor is open is not finished: nothing has been typed yet and
   * Save/Cancel/Reset have not been pressed. Renders are suppressed for the
   * whole table while it is open (see _renderStepList), so adding or removing
   * a row in the meantime changes this.steps under a table that cannot redraw —
   * the row indices the buttons carry go stale and a second "+" leaves two
   * blank rows behind. The row tools are inert until the open cell is settled,
   * and the cursor goes back to it so it is obvious what is waiting.
   */
  _editorOpen() {
    if (this._editingIdx === null || this._editingIdx === undefined) return false;
    const input = this.stepList &&
      this.stepList.querySelector('.ts-cell-editing .ts-exp-input');
    if (input) input.focus();
    return true;
  }

  _removeRow(idx) {
    if (this._editorOpen()) return;
    const vm = this._prepared && this._prepared[idx];
    if (!vm) return;
    const orderBefore = this._inTesterOrder(this.steps);
    // Every event the row was built from goes with it — the click AND the
    // submit it fired, all four Backspaces, the navigation folded in as its
    // expected result. Leaving any behind let them re-form into a new row.
    const remove = new Set((vm.ids && vm.ids.length) ? vm.ids : [vm.step.id]);
    if (vm.navOutcome) remove.add(vm.navOutcome.step.id);
    this.steps = this.steps.filter(s => !remove.has(s.id));

    // Steps placed under a row that has just gone are re-hung on the row above
    // it. Left pointing at nothing they would fall back to their own recorded
    // time, which for steps recorded into an insertion point is later than
    // everything else: delete one row and the group beneath it teleports to the
    // bottom of the table. With nothing above to hang from they are pinned to
    // the top, which is where the row that owned them was.
    if (this.steps.some(s => remove.has(s.after))) {
      const at = orderBefore.findIndex(s => s.id === vm.step.id);
      let inherited = TestStepsTab.TOP;
      for (let i = at - 1; i >= 0; i--) {
        if (!remove.has(orderBefore[i].id)) { inherited = orderBefore[i].id; break; }
      }
      this.steps.forEach(s => { if (remove.has(s.after)) s.after = inherited; });
      if (remove.has(this._insertAfterId)) this._insertAfterId = null;
    } else if (remove.has(this._insertAfterId)) {
      this._insertAfterId = null;
    }

    this._renderStepList();
    this._refreshOutput();
    this._persistSteps();
  }

  /**
   * Add a step the recorder could not see.
   *
   * A recording misses everything that happens outside the page: a login done
   * before recording started, a value read out of an email, a check the tester
   * makes by eye. Those steps have to be writable by hand or the case cannot be
   * handed to someone else to run.
   *
   * @param {number} [idx] - insert below this row; appended when omitted.
   */
  _insertManualStep(idx) {
    if (this._editorOpen()) return;

    const vm = (idx === null || idx === undefined)
      ? null
      : (this._prepared && this._prepared[idx]);

    const step = {
      id: 'm' + (++this._manualSeq),
      type: 'manual',
      locator: '', priority: '', elementName: '', css: '', xpath: '',
      value: '', displayValue: '', description: '',
      ts: Date.now()
    };

    // Insert after the recorded step this row was built from — and after any
    // navigation folded into it, so that folding still happens on the next pass.
    let pos = this.steps.length;
    if (vm) {
      const anchor = vm.navOutcome ? vm.navOutcome.step : vm.step;
      const at = this.steps.findIndex(s => s.id === anchor.id);
      if (at >= 0) pos = at + 1;
      // `after` is what actually holds the row in place (see _inTesterOrder).
      // The timestamp is copied as well so that the row still lands somewhere
      // sensible if the step it was added under is later deleted.
      step.after = anchor.id;
      step.ts    = anchor.startedAt || anchor.ts || step.ts;
    }
    this.steps.splice(pos, 0, step);

    // Whatever is recorded next belongs under the row just added, not at the
    // bottom of the table: parking a row is how the tester says "the steps I
    // am about to record go HERE".
    this._insertAfterId = step.id;

    this._renderStepList();
    this._refreshOutput();
    this._persistSteps();

    // The row is left INACTIVE on purpose — its Action cell used to open for
    // editing straight away, and an open cell freezes the table (see
    // _renderStepList). Parking a row is normally the prelude to recording the
    // steps that belong there, so the tester would go off and interact with the
    // page while the table quietly stopped redrawing: nothing they did showed
    // up until they came back and closed the editor. The row renders with its
    // "Describe this step…" placeholders and is one click away from editing,
    // which costs a click and keeps the table live.
    if (this.isRecording) {
      // Opening the editor used to be what confirmed the row had been parked.
      // Now the status line says where the next recorded steps will land.
      this._showStatus(this._recordingMessage(this._insertRowNumber()), 'recording');
    }
  }

  /**
   * Inline editor for one cell of one step.
   * @param {number} idx   - row index in the prepared list
   * @param {string} field - 'action' | 'data' | 'exp'
   */
  _beginEdit(idx, field) {
    const spec = TestStepsTab.EDITABLE[field];
    const vm   = this._prepared && this._prepared[idx];
    if (!spec || !vm) return;

    // ONE cell at a time. Nothing used to stop a second cell being opened while
    // the first was still open, and because the table cannot redraw while an
    // editor is up (see _renderStepList) the first cell kept its textarea and
    // its buttons on screen even though _activeEditor had already moved on to
    // the second. Save or Cancel on either one then re-rendered the whole
    // table: the other editor vanished, buttons and typed text with it, and
    // nothing it held was ever written to the step. _editorOpen() puts the
    // cursor back in the cell that is waiting, so it is obvious which one.
    if (this._editorOpen()) return;

    const cell = this.stepList.querySelector(`[data-field="${field}"][data-idx="${idx}"]`);
    if (!cell) return;

    this._editingIdx   = idx;
    this._editingField = field;
    // Greys out every row's + and x for as long as the editor is open, so the
    // tools look as inert as they now behave (_editorOpen).
    this.stepList.classList.add('ts-editing');

    const generated = field === 'action' ? vm.action
                    : field === 'data'   ? vm.testData
                    // A flagged-but-inferred sentence is worth correcting; the
                    // "nothing was detected" message is not worth editing.
                    : ((vm.flagged && !vm.inferred) ? '' : vm.expected);
    const current = vm.step[spec.prop] || generated || '';

    const esc = window.PalTechUtils.escapeHtml;
    const hint = typeof spec.placeholder === 'function'
      ? spec.placeholder(vm)
      : spec.placeholder;

    cell.classList.add('ts-cell-editing');
    // Every cell carries title="Click to edit" (see _renderStepList), and a
    // title is inherited by any descendant that has none of its own — so this
    // one was the tooltip over the textarea and over Save and Cancel (Reset
    // escaped it only because it sets its own). The others are inert while this
    // editor is open, so they must stop advertising a click that does nothing.
    // finish() re-renders the rows from scratch, which puts every tooltip back.
    this.stepList.querySelectorAll('[data-field]')
      .forEach(td => td.removeAttribute('title'));
    cell.innerHTML = `
      <textarea class="ts-exp-input" rows="${spec.rows}"
                placeholder="${esc(hint)}"></textarea>
      <div class="ts-exp-actions">
        <button class="ts-exp-save">Save</button>
        <button class="ts-exp-cancel">Cancel</button>
        <button class="ts-exp-reset" title="${spec.resetTitle}">Reset</button>
      </div>`;

    const input = cell.querySelector('.ts-exp-input');
    input.value = current;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    // Clicks inside the editor must not re-trigger the cell's own edit handler
    cell.querySelectorAll('*').forEach(el =>
      el.addEventListener('click', ev => ev.stopPropagation()));

    const finish = () => {
      this._activeEditor = null;
      this._editingIdx   = null;
      this._editingField = null;
      this.stepList.classList.remove('ts-editing');
      this._renderStepList();
      this._refreshOutput();
    };

    const save = () => {
      const value = input.value.trim();
      if (value) vm.step[spec.prop] = value;
      else delete vm.step[spec.prop];
      finish();
      this._persistSteps();
    };

    // Held so that starting a recording can close the editor for the tester —
    // the table cannot redraw while a cell is open, so steps would arrive into
    // a frozen table (see _renderStepList).
    this._activeEditor = { save, finish };

    cell.querySelector('.ts-exp-save').addEventListener('click', save);
    cell.querySelector('.ts-exp-cancel').addEventListener('click', finish);
    cell.querySelector('.ts-exp-reset').addEventListener('click', () => {
      delete vm.step[spec.prop];
      finish();
    });

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); finish(); }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        cell.querySelector('.ts-exp-save').click();
      }
    });
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  /**
   * The table as rows of [number, action, test data, expected].
   *
   * A step whose outcome could not be measured says so in its own Expected
   * Result sentence ("No page change was detected — confirm the expected
   * outcome"), so nothing is marked up around it: no inlined
   * "[TO BE CONFIRMED]" prefix to strip, and no extra column to explain.
   */
  _buildRows() {
    const prepared = this._prepared = this._prepareSteps();
    return prepared.map((vm, idx) => [
      String(idx + 1),
      vm.action,
      vm.testData || '',
      vm.expected
    ]);
  }

  static get COLUMNS() {
    return ['S.No', 'Action Performed', 'Test Data', 'Expected Result'];
  }

  /** Tab separated — pastes directly into Excel, Google Sheets or a Jira table. */
  _buildTSV() {
    const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ').trim();
    const rows  = this._buildRows();
    if (!rows.length) return '';
    return [TestStepsTab.COLUMNS, ...rows]
      .map(cols => cols.map(clean).join('\t'))
      .join('\n');
  }

  /** RFC-4180 CSV, for import into a test management tool. */
  _buildCSV() {
    const quote = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const rows  = this._buildRows();
    if (!rows.length) return '';
    return [TestStepsTab.COLUMNS, ...rows]
      .map(cols => cols.map(quote).join(','))
      .join('\r\n');
  }

  _refreshOutput() {
    const hasSteps = (this._prepared && this._prepared.length) || this.steps.length > 0;
    if (this.copyBtn)     this.copyBtn.disabled     = !hasSteps;
    if (this.downloadBtn) this.downloadBtn.disabled = !hasSteps;
  }

  _copyOutput() {
    const tsv = this._buildTSV();
    if (!tsv) return;
    window.PalTechUtils.copyToClipboard(tsv);
    const orig = this.copyBtn.textContent;
    this.copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { this.copyBtn.textContent = orig; }, 1800);
  }

  _downloadOutput() {
    const csv = this._buildCSV();
    if (!csv) return;
    // BOM so Excel opens UTF-8 accented characters correctly
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'test-steps.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
}

/**
 * Bare tag names that must never be used as an element label. When one of these
 * is all the recorder could find, it means no real label exists — including the
 * SVG tags, which is why steps used to read `Hover over "path"`.
 */
/**
 * Element-type abbreviations the naming logic produces. On their own they are
 * not a label — a step reading `Click on "Txt"` is meaningless to a tester.
 */
/**
 * `after` value meaning "above every recorded step", used when the row a step
 * was placed under is deleted and there is nothing left above it. Never an id:
 * ids are recorder numbers or "m1", "m2" for hand-added rows.
 */
TestStepsTab.TOP = '^top';

/**
 * How long a step is still accepted after recording stops. The recorder emits
 * the value left in a field as it shuts down, and that message lands just
 * after the stop acknowledgement.
 */
TestStepsTab.LATE_STEP_MS = 1500;

/**
 * Longest text that still reads as the NAME of a control in a sentence.
 *
 * Beyond this it is a block of content that happens to be wrapped in a link or
 * a list item — a card, a table row, a notification. The word-count rule in
 * _isJunkLabel is aimed at concatenated class names and let a seven-word person
 * card through, so length is the dimension that catches this one.
 */
TestStepsTab.NAME_MAX = 48;

/**
 * What a control's name says it will do — the vocabulary applications have
 * shared for decades, in priority order. Used only when nothing observable
 * could be measured, and always flagged for a tester to confirm.
 *
 * Each entry is [pattern, sentence({ named, label, role, inDialog, panel })].
 * `named` is the label already in quotes, or '' when there is none.
 *
 * Deliberately generic: not one entry names a product, a screen or a field of
 * any particular application.
 */
TestStepsTab.CONTROL_INTENTS = [
  [/\b(log|sign)[\s-]?out\b|\blogout\b|\bsignout\b/,
    () => 'The user is signed out and the login page is displayed'],
  [/\b(log|sign)[\s-]?in\b|\blogin\b|\bsignin\b|\bauthenticate\b/,
    () => 'The user is signed in and the landing page is displayed'],
  [/\b(save|apply|submit|confirm|ok|done|finish|update|accept|agree)\b/,
    (c) => 'The changes are saved and a confirmation message is displayed'],
  [/\b(cancel|discard|revert|undo)\b/,
    (c) => 'The ' + c.panel + ' closes and no changes are saved'],
  // Ahead of close/dismiss: the × inside a search box, a chip's remove icon and
  // a Clear button all empty something rather than closing it, and every one of
  // them is named from this vocabulary.
  [/\b(clear|erase|reset|empty)\b/,
    (c) => 'The entered value is cleared and the field is empty'],
  [/\b(close|dismiss|exit)\b/,
    (c) => 'The ' + c.panel + ' closes and the previous content is shown again'],
  [/\b(delete|remove|trash|bin|clear all)\b/,
    (c) => 'The selected record is deleted and no longer appears in the list'],
  [/\b(add|new|create|plus)\b/,
    (c) => 'The form to create a new record is displayed'],
  [/\b(edit|modify|rename|pencil)\b/,
    (c) => 'The selected record opens for editing with its current values shown'],
  [/\b(search|find|lookup|magnif)\b/,
    () => 'The records matching the search criteria are listed'],
  [/\b(filter|funnel)\b/,
    () => 'The list is filtered to the records matching the criteria'],
  [/\b(reset|clear)\b/,
    () => 'The entered values are cleared and the list returns to its full set'],
  [/\b(export|download|csv|excel|xlsx|pdf|report)\b/,
    () => 'The file is generated and downloaded'],
  [/\b(import|upload|attach|browse|choose file)\b/,
    () => 'The file chooser opens so a file can be selected'],
  [/\bprint\b/,
    () => 'The print preview for the current content opens'],
  [/\b(refresh|reload|sync|recalculate)\b/,
    () => 'The content is reloaded with the latest data'],
  [/\b(next|forward|continue|proceed)\b/,
    () => 'The next page of the process is displayed'],
  [/\b(back|previous|prev|return)\b/,
    () => 'The previous page is displayed again'],
  [/\b(open|view|details|preview|eye)\b/,
    (c) => 'The selected record opens and its details are displayed'],
  [/\b(menu|hamburger|bars|kebab|ellipsis|dots)\b/,
    () => 'The navigation menu opens and its options are listed'],
  [/\b(expand|show more|show all|view all|more)\b/,
    () => 'The hidden content is shown in full'],
  [/\b(collapse|show less|hide)\b/,
    () => 'The content is hidden and only the summary remains'],
  [/\b(settings|preferences|configure|gear|cog)\b/,
    () => 'The settings for the current area are displayed'],
  [/\b(help|support|faq|guide|question)\b/,
    () => 'The help content for the current page is displayed'],
  [/\b(profile|account|avatar|my details)\b/,
    () => 'The account menu opens and its options are listed'],
  [/\b(notification|alert|bell|inbox)\b/,
    () => 'The notifications panel opens and the unread items are listed'],
  [/\b(copy|duplicate|clone)\b/,
    () => 'The value is copied and a confirmation is shown'],
  [/\bsort\b/,
    (c) => 'The list is re-sorted and the order of the rows changes'],
  [/\bselect all\b|\bcheck all\b/,
    () => 'Every row in the list is selected'],
  [/\b(approve|authorise|authorize|certify|sign)\b/,
    () => 'The record is approved and its status changes'],
  [/\b(reject|decline|deny)\b/,
    () => 'The record is rejected and its status changes'],
  [/\b(assign|allocate)\b/,
    () => 'The record is assigned and the assignee is shown against it'],
  [/\b(send|email|notify|share)\b/,
    () => 'The message is sent and a confirmation is displayed'],
  [/\b(yes|proceed anyway)\b/,
    (c) => 'The action is confirmed and carried out'],
  [/\b(no|not now)\b/,
    (c) => 'The action is cancelled and nothing changes'],
  [/\b(calendar|date ?picker)\b/,
    () => 'The date picker opens so a date can be chosen'],
  [/\b(history|audit|log|trail)\b/,
    () => 'The history for the record is displayed'],
  [/\b(dashboard|home)\b/,
    () => 'The dashboard is displayed'],
  [/\b(logo|brand)\b/,
    () => 'The application home page is displayed']
];

/**
 * The three correctable columns: which property on the step holds the tester's
 * version, what the cell says when it is empty, and how the editor is set up.
 */
TestStepsTab.EDITABLE = {
  action: {
    prop: 'actionOverride', cls: 'action', rows: 3,
    empty: 'Describe this step…',
    // A function, not a string: the hint names the page the step sits on,
    // which is read from the recording. It carried an example from one
    // particular product before — no use to anyone testing anything else.
    placeholder: (vm) => (vm && vm.screen)
      ? `What does the tester do on the "${vm.screen}" page?`
      : 'What does the tester do at this point?',
    resetTitle: 'Go back to the recorded action'
  },
  data: {
    prop: 'testDataOverride', cls: 'data', rows: 2,
    empty: '—',
    placeholder: (vm) => (vm && vm.testData)
      ? 'The value the tester supplies for this step'
      : 'Any value the tester has to supply',
    resetTitle: 'Go back to the recorded test data'
  },
  exp: {
    prop: 'expectedOverride', cls: 'exp', rows: 3,
    empty: 'Describe what should happen…',
    placeholder: (vm) => (vm && vm.screen)
      ? `What should happen on the "${vm.screen}" page after this step?`
      : 'What should happen after this step?',
    resetTitle: 'Go back to the detected result'
  }
};

/**
 * The only outcomes a page load can legitimately produce. Everything else the
 * diff can report describes something a control did, not a page arriving.
 */
TestStepsTab.NAVIGATION_OUTCOMES = new Set(['screen', 'message', 'dialogOpened', 'url']);

/**
 * Outcomes that make a hover a real instruction: the pointer landing there
 * revealed something. A hover that closes a panel, or that coincides with a
 * URL change, is the pointer travelling on its way somewhere else.
 */
TestStepsTab.HOVER_OUTCOMES = new Set([
  'panelOpened', 'expanded', 'contentExpanded', 'listCountChanged',
  'message', 'dialogOpened'
]);

/** Escape a string for safe use inside a RegExp. */
TestStepsTab.escapeRegExp = function (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

TestStepsTab.ABBREVIATIONS = new Set([
  'txt', 'btn', 'lbl', 'fld', 'drp', 'chk', 'rad', 'img', 'num', 'pwd',
  'sel', 'opt', 'elem', 'el', 'ctrl', 'wrap', 'cont', 'txtarea', 'combo',
  'link', 'button', 'input', 'field', 'label', 'text', 'value', 'item',
  'container', 'wrapper', 'element'
]);

TestStepsTab.TAG_NAMES = new Set([
  'a','abbr','article','aside','b','blockquote','body','br','button',
  'caption','cite','code','col','colgroup','dd','del','details','dfn',
  'div','dl','dt','em','fieldset','figcaption','figure','footer','form',
  'h1','h2','h3','h4','h5','h6','header','hr','i','img','input','ins',
  'kbd','label','legend','li','main','mark','menu','nav','ol','optgroup',
  'option','p','pre','q','s','section','select','small','span','strong',
  'sub','summary','sup','table','tbody','td','template','textarea','tfoot',
  'th','thead','time','tr','u','ul','var','video',
  // SVG — an icon's internals are never a meaningful label
  'svg','path','g','use','circle','rect','line','polyline','polygon',
  'ellipse','defs','symbol','tspan','clippath','mask','image','foreignobject'
]);

// (The per-step icons were dropped along with the list layout — the table
//  identifies each step by its number and its action sentence.)

window.testStepsTab = new TestStepsTab();
