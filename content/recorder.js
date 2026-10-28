/**
 * recorder.js — Records live user interactions on the page and forwards them
 * as structured step objects to the side panel via chrome.runtime.sendMessage.
 *
 * Listeners covered (18 total across 8 categories):
 *   Mouse    : click, dblclick, contextmenu, mouseover/mouseout
 *   Keyboard : keydown (special keys + Ctrl combos)
 *   Form     : blur (fill), change (select/check/uncheck/file/range), submit, paste
 *   Nav      : SPA route changes, reported by content/pageHooks.js (MAIN world)
 *   Drag/Drop: dragstart, drop
 *   Scroll   : wheel (debounced)
 *   Touch    : touchstart, touchend (tap)
 *   Dialog   : alert/confirm/prompt, reported by content/pageHooks.js (MAIN world)
 *
 * Injected on-demand when recording starts (listed in manifest.json).
 * Uses IIFE guard — safe to re-inject.
 */
(function () {
  if (window.PalTechRecorder) return;

  // ── State ───────────────────────────────────────────────────────────────────
  const state = {
    active:           false,
    indicator:        null,
    hoverTimer:       null,
    lastHoveredElem:  null,
    lastNavigatedUrl: null
  };

  // Step ids must not collide across page loads. A full navigation reloads this
  // content script and resets module state, so seed the counter from the clock
  // instead of starting at 0 every time.
  let stepIdCounter = Date.now();
  let scrollTimer   = null;
  let scrollAccY    = 0;
  let dragSource    = null;

  // Tracks the latest typed value per input element (updated on every keystroke).
  // Used as a fallback when the app clears the field before blur fires.
  const lastInputValues = new WeakMap();

  // When the tester started typing into an element. A fill can only be emitted
  // once the value is final — which is when focus LEAVES the field, and that is
  // usually a click somewhere else. Stamping the step with the moment typing
  // began is what keeps "enter a value, then pick from the list it filtered"
  // in the order the tester did it.
  const typingStarts = new WeakMap();

  // Tracks the last value already emitted as a fill step per element.
  // Prevents duplicate fill steps when both keydown(Enter) and blur both try to emit.
  const lastFilledValues = new WeakMap();

  // Fields holding typed text that has not been emitted as a step yet. A Set,
  // not a WeakMap, because it has to be ITERABLE: flushPendingFills() below
  // needs to find these fields when nothing blurred them. Emptied on stop().
  const pendingFills = new Set();

  // ── Special keys that get recorded as press() steps ────────────────────────
  const SPECIAL_KEYS = new Set([
    // Tab belongs here: "press Tab to move to the next field" is an
    // instruction a tester follows, and a form filled by tabbing between
    // fields recorded the values with nothing saying how focus moved.
    'Enter', 'Escape', 'Backspace', 'Delete', 'Tab',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown',
    'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'
  ]);

  // ── Shadow DOM ──────────────────────────────────────────────────────────────
  //
  // Every DOM question below has to be asked through content/shadow.js, or the
  // answer stops at the first web component on the page: events arrive
  // retargeted to the component's host, closest() and parentElement dead-end at
  // the boundary, and document queries never descend into it. Each helper falls
  // back to the plain DOM API so the recorder still works if that module failed
  // to load — degraded to document-only, never broken.

  const Shadow = window.PalTechShadow || null;

  /** The element actually interacted with, not the component that contains it. */
  function deepTarget(e) {
    if (Shadow) return Shadow.deepTarget(e);
    return (e && e.target) || null;
  }

  /** Parent in the flat tree: a shadow root's child is followed by its host. */
  function flatParent(node) {
    if (Shadow) return Shadow.flatParent(node);
    return (node && node.parentElement) || null;
  }

  /** closest() across shadow boundaries. */
  function deepClosest(node, selector) {
    try {
      if (Shadow) return Shadow.deepClosest(node, selector);
      return (node && node.closest) ? node.closest(selector) : null;
    } catch (_) {
      return null;
    }
  }

  /** querySelectorAll across the document and every open shadow root. */
  function deepQueryAll(selector, cap) {
    try {
      if (Shadow) return Shadow.queryAll(selector, cap);
      return Array.prototype.slice.call(document.querySelectorAll(selector), 0, cap || 500);
    } catch (_) {
      return [];
    }
  }

  /** The element that really holds focus, followed into shadow roots. */
  function deepActiveElement() {
    try {
      return Shadow ? Shadow.activeElement() : document.activeElement;
    } catch (_) {
      return null;
    }
  }

  /**
   * contains() across shadow boundaries: is `node` anywhere inside `host`,
   * including inside components rendered within it?
   */
  function deepContains(host, node) {
    if (!host || !node) return false;
    // Two independent attempts: the native check is the fast path, and the walk
    // is the one that crosses shadow boundaries. They are tried separately
    // because sharing a try/catch meant a throw from the first silently skipped
    // the second, which is the answer that matters.
    try {
      if (typeof host.contains === 'function' && host.contains(node)) return true;
    } catch (_) {}
    try {
      let curr = node;
      for (let i = 0; i < 40 && curr; i++) {
        if (curr === host) return true;
        curr = flatParent(curr);
      }
    } catch (_) {}
    return false;
  }

  /** The document or shadow root an element lives in — the scope to query. */
  function scopeOf(node) {
    try {
      return Shadow ? Shadow.rootOf(node) : document;
    } catch (_) {
      return document;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function nextId() { return ++stepIdCounter; }

  /**
   * Walk up the DOM to find a label associated with a form control.
   * Checks: aria-label → label[for=id] → wrapping <label> → placeholder/title
   */
  function getLabel(elem) {
    const ariaLabel = (elem.getAttribute('aria-label') || '').trim();
    if (ariaLabel) return ariaLabel;
    if (elem.id) {
      try {
        // A control's <label for> lives in the same root it does, so the search
        // is scoped there: inside a component, document has never heard of it.
        const lbl = scopeOf(elem).querySelector(`label[for="${CSS.escape(elem.id)}"]`);
        if (lbl) return (lbl.textContent || '').trim();
      } catch (_) {}
    }
    let p = flatParent(elem);
    while (p) {
      if (p.tagName.toLowerCase() === 'label') return (p.textContent || '').trim();
      p = flatParent(p);
    }
    return (elem.getAttribute('placeholder') || elem.getAttribute('title') || '').trim();
  }

  /**
   * The element's own short text.
   *
   * Only for small elements: a control that wraps eight or more descendants is a
   * container, and returning its whole text would put a paragraph in the step.
   * This is what lets a date cell, a chip or a div-based control be named at all
   * — previously anything outside a fixed tag whitelist came out as
   * "the element".
   */
  function ownShortText(elem) {
    try {
      if (!elem || elem.nodeType !== 1) return '';
      if (elem.querySelectorAll('*').length > 8) return '';
      const t = (elem.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 40) return '';
      return t;
    } catch (_) {
      return '';
    }
  }

  const NAME_CAP = 60;      // longest label that can stand as a name

  /**
   * The name of a control that wraps a whole block of content.
   *
   * A card is very often a single <a> or <li> around four lines of
   * information: a person's name, their job title, their department, where they
   * sit. Reading textContent off it and cutting at a fixed length produced
   *   Click on the "Nikhila Marupally Software Engineer Quality Engineering
   *   Equi" link
   * — the whole card, chopped mid-word, then quoted again in the expected
   * result as though it were the name of a page.
   *
   * The thing a tester would call it is the card's own heading, so that is what
   * this looks for: a real heading element, an explicit role, or the first
   * descendant that carries a short line of text of its own. It is only ever
   * consulted for an element whose text is too long or too structured to be a
   * label — a short <a> or <button> never reaches here.
   */
  function headlineText(elem) {
    try {
      const candidates = elem.querySelectorAll(
        'h1, h2, h3, h4, h5, h6, [role="heading"], strong, b, [class*="title"], [class*="name"], [class*="heading"]'
      );
      for (let i = 0; i < candidates.length && i < 8; i++) {
        const t = textOf(candidates[i], NAME_CAP).trim();
        if (t && t.length <= 40) return t;
      }

      // No heading: the first child that holds a short line of its own is the
      // next best thing. Card markup is usually a stack of <div>s or <span>s,
      // and the first of them is the one the rest describes.
      const kids = elem.children || [];
      for (let i = 0; i < kids.length && i < 8; i++) {
        const t = textOf(kids[i], NAME_CAP).trim();
        if (t && t.length <= 40) return t;
      }
    } catch (_) {}
    return '';
  }

  /**
   * Cut a name to length WITHOUT breaking a word in half.
   * "…Quality Engineering Equi" is the shape of the bug this exists to avoid:
   * a truncated word reads as a typo, and a tester cannot search the page for
   * it.
   */
  function trimToWords(text, cap) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (t.length <= cap) return t;
    const cut = t.substring(0, cap);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > cap * 0.5 ? cut.substring(0, lastSpace) : cut).trim() + '…';
  }

  /**
   * Common icon vocabulary, matched against class names and icon attributes.
   * Icon-only buttons carry no text and no label in most component libraries,
   * and "the element" is useless in a test case. The words below are the ones
   * icon sets have agreed on for years, so this stays application-agnostic.
   */
  const ICON_INTENTS = [
    [/close|dismiss|cross|times|clear/,                 'close'],
    [/back|arrow[-_]?left|chevron[-_]?left|caret[-_]?left|prev/, 'back'],
    [/forward|arrow[-_]?right|chevron[-_]?right|caret[-_]?right|next/, 'next'],
    [/edit|pencil|modify/,                              'edit'],
    [/delete|trash|bin|destroy/,                        'delete'],
    [/(^|[^a-z])(add|plus|create|new)([^a-z]|$)/,       'add'],
    [/search|magnif|lookup/,                            'search'],
    [/filter|funnel/,                                   'filter'],
    [/calendar|datepick|date[-_]?picker/,               'calendar'],
    [/download|export/,                                 'download'],
    [/upload|import|attach|paperclip/,                  'upload'],
    [/print/,                                           'print'],
    [/refresh|reload|sync|rotate/,                      'refresh'],
    [/expand|chevron[-_]?down|caret[-_]?down|show[-_]?more/, 'expand'],
    [/collapse|chevron[-_]?up|caret[-_]?up|show[-_]?less/,   'collapse'],
    [/hamburger|menu|bars|kebab|ellipsis|dots/,         'menu'],
    [/settings|gear|cog|preferences/,                   'settings'],
    [/avatar|profile|account|user/,                     'profile'],
    [/notification|bell/,                               'notifications'],
    [/help|question|info/,                              'help'],
    [/logout|signout|sign[-_]?out|power|exit/,          'logout'],
    [/save|submit|tick|check(mark)?|done/,              'save'],
    [/cancel|undo|revert/,                              'cancel'],
    [/sort/,                                            'sort'],
    [/(^|[^a-z])(view|eye|preview)([^a-z]|$)/,          'view'],
    [/copy|duplicate|clone/,                            'copy'],
    [/star|favou?rite|bookmark|pin/,                    'favourite'],
    [/home|dashboard/,                                  'home']
  ];

  /**
   * Guess what an unlabelled icon control is for, from the vocabulary its
   * markup uses. Returns e.g. 'close icon', or '' when nothing is recognised.
   */
  function describeIconIntent(elem) {
    if (!elem || elem.nodeType !== 1) return '';

    const hints = [];
    const push = (v) => { if (v) hints.push(String(v)); };

    try {
      push((window.PalTechSelectors
        ? window.PalTechSelectors.getClassNames(elem).join(' ')
        : ''));
      push(elem.getAttribute('data-icon'));
      push(elem.getAttribute('id'));
      push(elem.getAttribute('name'));
      push(elem.getAttribute('data-action'));

      // Icon libraries put the meaningful word on a child <i>, <svg> or <use>
      const iconChild = elem.querySelector('i, use, svg, [class*="icon"]');
      if (iconChild) {
        push(window.PalTechSelectors
          ? window.PalTechSelectors.getClassNames(iconChild).join(' ')
          : '');
        push(iconChild.getAttribute && iconChild.getAttribute('data-icon'));
        push(iconChild.getAttribute && (iconChild.getAttribute('href') ||
             iconChild.getAttribute('xlink:href')));
      }
    } catch (_) {}

    const haystack = hints.join(' ').toLowerCase();
    if (!haystack) return '';

    for (const [pattern, word] of ICON_INTENTS) {
      if (pattern.test(haystack)) return word + ' icon';
    }
    return '';
  }

  /**
   * Visible/accessible name for any element, in the order a person would read
   * it: an explicit label, then the text on the control, then what its icon
   * appears to be for.
   */
  function getVisibleName(elem) {
    if (!elem || elem.nodeType !== 1) return '';

    const tag = elem.tagName.toLowerCase();
    if (['button','a','summary','h1','h2','h3','h4','h5','h6','label','th','td','li','option'].includes(tag)) {
      const t = (elem.textContent || '').replace(/\s+/g, ' ').trim();
      // A short line of text IS the control's name. Anything longer, or
      // anything built out of several elements, is a block of content that
      // merely happens to be wrapped in a link or a list item — and its text
      // is not a label. Being on this tag list used to exempt an element from
      // that judgement altogether, which is how a whole person-card came to be
      // quoted as the name of a link and then as the name of a page.
      if (t && t.length <= 40 && (elem.querySelectorAll('*').length <= 8)) return t;
      if (t) {
        const headline = headlineText(elem);
        if (headline) return headline;
      }
      // Fall through: an aria-label or the icon vocabulary may still name it
      // better than its own wall of text. Only if neither does is the text used,
      // and then cut on a word boundary.
    }

    const labelled = getLabel(elem);
    if (labelled) return labelled;

    const own = ownShortText(elem);
    if (own) return own;

    const icon = describeIconIntent(elem);
    if (icon) return icon;

    // Last resort for a container-shaped control with nothing to narrow to:
    // its text, cut at a word boundary so no half-word ever reaches a step.
    const text = (elem.textContent || '').replace(/\s+/g, ' ').trim();
    return text ? trimToWords(text, NAME_CAP) : '';
  }

  /**
   * Compute the best Playwright locator, CSS, XPath, and element name for elem.
   * Falls back gracefully if any module is not yet available.
   */
  // Building a locator walks the whole document several times. Hover, keydown
  // and mouseover all ask for the same element repeatedly, so cache the result
  // per element for a short window — without this, recording on a large page is
  // visibly laggy. The TTL keeps the cache honest when the DOM changes.
  const locatorCache = new WeakMap();
  const LOCATOR_CACHE_TTL_MS = 1500;

  function getLocatorData(elem) {
    if (!elem || elem.nodeType !== 1) {
      return { locator: '', priority: '', name: '', css: '', xpath: '' };
    }

    const cached = locatorCache.get(elem);
    if (cached && (Date.now() - cached.stamp) < LOCATOR_CACHE_TTL_MS) {
      return cached.data;
    }

    let data;
    try {
      const css   = window.PalTechSelectors ? (window.PalTechSelectors.getCssSelector(elem)   || '') : '';
      const xpath = window.PalTechSelectors ? (window.PalTechSelectors.getRelativeXpath(elem)  || '') : '';
      const pw    = window.PalTechPlaywright
        ? window.PalTechPlaywright.getPlaywrightLocator(elem, css, xpath)
        : { locator: css ? `page.locator('css=${css}')` : '', priority: 'P8 - CSS locator' };
      const name  = window.PalTechNaming ? (window.PalTechNaming.generateElementName(elem) || '') : '';
      data = { locator: pw.locator, priority: pw.priority, name, css, xpath };
    } catch (_) {
      data = { locator: '', priority: '', name: '', css: '', xpath: '' };
    }

    locatorCache.set(elem, { data, stamp: Date.now() });
    return data;
  }

  /**
   * Send a completed step to the side panel.
   * The panel may be closed, in which case sendMessage rejects with
   * "Could not establish connection" — swallow it rather than leaving an
   * unhandled promise rejection in the page console on every interaction.
   *
   * @param {Object}  step
   * @param {Element} [target] - the element acted on; when given, the observable
   *                             outcome of the action is measured and sent as a
   *                             follow-up 'stepOutcome' message.
   * @param {Object}  [before] - snapshot taken before the app reacted. Defaults
   *                             to a snapshot taken right now.
   */
  function sendStep(step, target, before) {
    step.ts = Date.now();

    // Context the side panel needs to write an instruction a tester can follow:
    // what kind of control it is, and whereabouts on the page it lives.
    // Resolving these here is far more reliable than inferring them later by
    // pattern-matching a CSS selector or XPath string.
    if (target && target.nodeType === 1) {
      step.tagName = (target.tagName || '').toLowerCase();
      step.role    = describeRoleOf(target);
      step.region  = describeRegion(target);
      // The element renders something but exposes nothing to read — the mark of
      // a component whose shadow root is closed and could not be re-opened in
      // time (see content/shadowHook.js). Saying so lets the panel flag the
      // step for a human instead of describing the wrapper as if it had been
      // clicked, which is how three different buttons in one widget came out as
      // three identical rows.
      if (Shadow && Shadow.looksOpaque(target)) step.opaque = true;
    }
    try {
      const result = chrome.runtime.sendMessage({ action: 'stepRecorded', step });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {}

    if (target !== undefined) {
      scheduleOutcome(step.id, before || captureSnapshot(target), target, step.type);
    }

    // Applications mount components as they are used — the dialog that builds
    // its shadow root the first time it opens did not exist when recording
    // started, and its <select> would go unrecorded until the next reload.
    armShadowRoots();
  }

  /** Send the measured outcome of an earlier step. */
  function sendOutcome(stepId, outcome) {
    if (!outcome) return;
    try {
      const result = chrome.runtime.sendMessage({ action: 'stepOutcome', stepId, outcome });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {}
  }

  // ── Outcome capture ─────────────────────────────────────────────────────────
  //
  // A step is only useful to a QA reader if it says what the action ACHIEVED.
  // We cannot know intent, but we can observe what changed: snapshot a small
  // amount of page state before the app reacts, wait for DOM mutations to go
  // quiet, snapshot again, and diff. The panel turns that diff into an
  // "Expected Result" line.
  //
  // Deliberately cheap: bounded queries, no serialisation of the DOM, and the
  // MutationObserver is connected only during the settle window after an action.

  // Requests the page has in flight, reported by pageHooks.js from the MAIN
  // world. Used only to decide how long to keep waiting for an action's effect.
  const net = { open: new Set(), lastEndId: 0, lastEndTs: 0 };

  /**
   * How much an outcome is worth saying. Used by the late re-check: a first
   * measurement that landed on weak evidence (a panel appearing, a URL change)
   * is replaced when the app finally renders the page or the message it was
   * fetching. Without this, only a completely undetected step was ever
   * corrected, so a dashboard that took three seconds to render was reported as
   * "the menu opens" forever.
   */
  const OUTCOME_STRENGTH = {
    none: 0,
    url: 1, focused: 1, scrolled: 2,
    panelClosed: 2, collapsed: 2, contentCollapsed: 2,
    panelOpened: 3, expanded: 3, contentExpanded: 3, valueSet: 3,
    selected: 4, checked: 4, unchecked: 4, listReordered: 4, listCountChanged: 4,
    selectionChanged: 4, valueCleared: 4,
    dialogClosed: 5, dialogOpened: 5, message: 5,
    screen: 6
  };

  function outcomeStrength(outcome) {
    if (!outcome) return -1;
    const s = OUTCOME_STRENGTH[outcome.kind];
    return typeof s === 'number' ? s : 2;
  }

  const OUTCOME_QUIET_MS     = 400;   // mutations must stop for this long
  const OUTCOME_MAX_WAIT_MS  = 5000;  // hard cap so recording never feels stuck
  const OUTCOME_BUSY_WAIT_MS = 10000; // cap while the app is still fetching
  const OUTCOME_RECHECK_MS   = 9000;  // one late look for slow back-ends
  const TEXT_CAP             = 120;

  let pendingOutcome = null;

  let outcomeGeneration = 0;

  function isVisible(el) {
    try { return !!el && el.getClientRects().length > 0; } catch (_) { return false; }
  }

  function textOf(el, cap) {
    if (!el) return '';
    return (el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, cap || TEXT_CAP);
  }

  /** The heading that identifies the current screen. */
  function currentHeading() {
    const candidates = deepQueryAll('h1, h2, [role="heading"]', 30);
    for (let i = 0; i < candidates.length && i < 30; i++) {
      if (!isVisible(candidates[i])) continue;
      const t = textOf(candidates[i], 80);
      if (t) return t;
    }
    return '';
  }

  function currentBreadcrumb() {
    const hits = deepQueryAll('[aria-label*="readcrumb"], nav.breadcrumb, .breadcrumb', 1);
    const bc = hits.length ? hits[0] : null;
    return isVisible(bc) ? textOf(bc, 80) : '';
  }

  /**
   * Signatures of visible dropdowns, menus and expandable panels.
   * Opening a filter panel or closing a popover is a real outcome that no
   * heading, dialog or row count picks up.
   */
  function panelSignatures() {
    const out = [];
    const nodes = deepQueryAll(
      '[role="menu"], [role="listbox"], [aria-expanded="true"], ' +
      '.dropdown-menu.show, .dropdown-menu.open, [class*="popover"], [class*="popper"]',
      40
    );
    nodes.forEach(p => {
      if (out.length >= 8 || !isVisible(p)) return;
      out.push(((p.getAttribute('aria-label') || textOf(p, 40)) || 'panel').trim());
    });
    return out;
  }

  /**
   * What the page currently marks as chosen: the highlighted nav item, the
   * current tab, the selected grid row.
   *
   * WHY: clicking a nav item usually marks a DIFFERENT element as current — a
   * parent <li>, a wrapper div — so watching the clicked element's own state
   * misses it, and the step was reported as "no page change was detected".
   * The class names below are the ones component libraries have settled on.
   */
  function selectionMarks() {
    const out = [];
    try {
      const nodes = deepQueryAll(
        '[aria-selected="true"], [aria-current], .active, .selected, .is-active, ' +
        '.is-selected, .current, .k-state-selected, .ui-state-active, .Mui-selected',
        60
      );
      for (let i = 0; i < nodes.length && out.length < 10; i++) {
        const t = textOf(nodes[i], 40);
        if (t) out.push(t);
      }
    } catch (_) {}
    return out;
  }

  /**
   * Rendered size of the element acted on and of its immediate surroundings.
   *
   * WHY: a submenu, an accordion or a details panel is very often already in
   * the DOM and only toggled with CSS. Nothing is added, no text changes (
   * textContent counts hidden text too), so every text- and node-based signal
   * is blind to it — but the container's height always moves.
   */
  function boxSignature(elem) {
    if (!elem || elem.nodeType !== 1) return null;
    try {
      const own    = elem.getBoundingClientRect();
      const up     = flatParent(elem);
      const parent = up ? up.getBoundingClientRect() : null;
      return {
        h:  Math.round(own.height),
        w:  Math.round(own.width),
        ph: parent ? Math.round(parent.height) : 0,
        pw: parent ? Math.round(parent.width)  : 0
      };
    } catch (_) {
      return null;
    }
  }

  /** How tall the page is, and how far down it is scrolled. */
  function pageMetrics() {
    try {
      return {
        h: (document.documentElement && document.documentElement.scrollHeight) || 0,
        y: window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0
      };
    } catch (_) {
      return { h: 0, y: 0 };
    }
  }

  /** Titles of visible modal dialogs. */
  function dialogSignatures() {
    const out = [];
    const nodes = deepQueryAll(
      '[role="dialog"], [role="alertdialog"], dialog[open], .modal.show, .modal.in, .MuiDialog-root',
      20
    );
    nodes.forEach(d => {
      if (out.length >= 5 || !isVisible(d)) return;
      const titleEl = d.querySelector('h1, h2, h3, [role="heading"], .modal-title, .MuiDialogTitle-root');
      const title = titleEl ? textOf(titleEl, 60) : (d.getAttribute('aria-label') || '');
      out.push(title.trim() || 'dialog');
    });
    return out;
  }

  /** Text of visible toasts, alerts and validation messages. */
  function alertTexts() {
    const out = [];
    const nodes = deepQueryAll(
      '[role="alert"], [role="status"], .toast, .snackbar, .notification, ' +
      '.invalid-feedback, .error-message, .field-error, .help-block.error',
      20
    );
    nodes.forEach(a => {
      if (out.length >= 5 || !isVisible(a)) return;
      const t = textOf(a);
      if (t) out.push(t);
    });
    return out;
  }

  /**
   * Row count plus the first and last row's text.
   * The counts detect filtering; the first/last text detects re-sorting, which
   * is otherwise invisible (a sort changes order but not the number of rows).
   */
  function listStats() {
    // Results are not always <tr>/<li>. Card and div-based lists are common in
    // SPA apps, and missing them is why a search that clearly filtered a list
    // could still report "no visible change".
    const rows = deepQueryAll(
      'tbody tr, [role="row"], [role="listitem"], [role="option"], ' +
      '[role="treeitem"], [role="menuitem"], ' +
      '.list-item, .list-group-item, .card, ' +
      '[class*="list-item"], [class*="grid-item"], [class*="result-item"], [class*="-card"]',
      500
    );
    const visible = [];
    for (let i = 0; i < rows.length && visible.length < 400; i++) {
      if (isVisible(rows[i])) visible.push(rows[i]);
    }
    return {
      count: visible.length,
      first: visible.length ? textOf(visible[0], 60) : '',
      last:  visible.length ? textOf(visible[visible.length - 1], 60) : ''
    };
  }

  /**
   * Which text fields on the page hold a value, by label.
   *
   * WHY: emptying a field is one of the commonest outcomes there is — the ×
   * inside a search box, a Clear or Reset button, a chip's remove icon — and
   * nothing else in this snapshot can see it. The value went, so the field's
   * own `value` diff (which only fires for a value ARRIVING) said nothing, and
   * the ladder fell through to whatever the emptying knocked over: pressing the
   * × in a search box was reported as "the content under Close Icon is hidden".
   *
   * Only whether each field is filled is kept, never the value: this is the
   * generic signal for "a field was cleared", and no snapshot needs to hold a
   * password or a customer's details to answer it.
   */
  function fieldStates() {
    const out = [];
    try {
      const fields = deepQueryAll('input, textarea', 40);
      for (let i = 0; i < fields.length && out.length < 20; i++) {
        const el = fields[i];
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'hidden'].includes(type)) {
          continue;
        }
        if (!isVisible(el)) continue;
        out.push({
          // Keyed by label where there is one, by position otherwise, so the
          // before and after states of the same field can be lined up.
          key:    (getLabel(el) || '').substring(0, 60) || ('#' + i),
          name:   (getLabel(el) || '').substring(0, 60),
          filled: !!String(el.value == null ? '' : el.value).trim(),
          // Kept so the diff can ask whether the field is anywhere near the
          // control that was pressed. A field cleared on the far side of the
          // page was not cleared BY this step.
          el
        });
      }
    } catch (_) {}
    return out;
  }

  /**
   * Label of whatever currently holds focus, or '' when it has no real label.
   *
   * This used to fall back to el.tagName, which produced expected results like
   * 'The cursor is placed in the "INPUT" field' — a tag name is not a label.
   */
  function describeFocus() {
    const el = deepActiveElement();
    if (!el || el === document.body || el === document.documentElement) return '';
    return (getLabel(el) || '').toString().substring(0, 60);
  }

  /**
   * Human description of the region an element sits in, for action sentences
   * written from the user's point of view ("...in the page header").
   * Returns '' when the surrounding region adds nothing useful.
   */
  function describeRegion(elem) {
    if (!elem || !elem.closest) return '';

    // A dialog is the most useful context there is
    try {
      const dialog = deepClosest(elem, '[role="dialog"], [role="alertdialog"], dialog, .modal, .MuiDialog-root');
      if (dialog && dialog !== elem) {
        const t = dialog.querySelector('h1, h2, h3, [role="heading"], .modal-title, .MuiDialogTitle-root');
        const name = t ? textOf(t, 40) : (dialog.getAttribute('aria-label') || '');
        return name ? `the "${name}" dialog` : 'the dialog';
      }
    } catch (_) {}

    const REGIONS = [
      ['[role="search"]',        'the search area'],
      ['[role="toolbar"]',       'the toolbar'],
      ['[role="tablist"]',       'the tab bar'],
      ['[role="menu"]',          'the open menu'],
      ['[role="menubar"]',       'the menu bar'],
      ['[role="listbox"]',       'the dropdown list'],
      ['nav, [role="navigation"]', 'the navigation menu'],
      ['header, [role="banner"]',  'the page header'],
      ['footer, [role="contentinfo"]', 'the page footer'],
      ['aside, [role="complementary"]', 'the sidebar'],
      ['table, [role="table"], [role="grid"]', 'the results table'],
      ['form',                   'the form'],

      // Semantics first, markup last. Plenty of applications build a menu out
      // of plain <div>s with no role at all, and without these a top-level nav
      // item was described as "Click on "Control Room"" with no context — which
      // left nothing to reason about when its outcome could not be measured.
      ['[class*="navbar"], [class*="nav-"], [class*="navigation"], [id*="nav"]',
                                 'the navigation menu'],
      ['[class*="sidebar"], [class*="side-nav"], [class*="sidenav"], [class*="side-menu"]',
                                 'the sidebar'],
      ['[class*="menu"]',        'the navigation menu'],
      ['[class*="dropdown"], [class*="popover"], [class*="popper"]', 'the open menu'],
      ['[class*="toolbar"], [class*="action-bar"], [class*="actions"]', 'the toolbar'],
      ['[class*="modal"], [class*="dialog"]', 'the dialog'],
      ['[class*="header"], [class*="masthead"]', 'the page header'],
      ['[class*="footer"]',      'the page footer'],
      ['[class*="grid"], [class*="datatable"], [class*="data-table"], [class*="table"]',
                                 'the results table']
    ];

    // Crosses component boundaries: a button inside a web component still sits
    // in the page's header or navigation as far as a tester is concerned, and
    // native closest() stops at the boundary and reported no region at all.
    for (const [selector, name] of REGIONS) {
      try {
        const hit = deepClosest(elem, selector);
        if (hit && hit !== elem) return name;
      } catch (_) {}
    }
    // <main> and <body> are deliberately absent: "in the main content" tells a
    // tester nothing they did not already know.
    return '';
  }

  /** Explicit or implicit ARIA-ish role, resolved in the page where the DOM is. */
  function describeRoleOf(elem) {
    if (!elem || elem.nodeType !== 1) return '';
    const explicit = elem.getAttribute && elem.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = (elem.tagName || '').toLowerCase();
    const type = (elem.getAttribute && (elem.getAttribute('type') || '')).toLowerCase();
    const MAP = {
      a: 'link', button: 'button', select: 'dropdown', textarea: 'text area',
      img: 'image', summary: 'button', label: 'label',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      th: 'column header', td: 'cell', li: 'list item', option: 'option'
    };
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio')    return 'radio button';
      if (type === 'file')     return 'file input';
      if (['submit', 'button', 'reset'].includes(type)) return 'button';
      return 'field';
    }
    return MAP[tag] || '';
  }

  /**
   * aria-expanded for a control, looking at the element itself, then a
   * descendant, then an ancestor.
   *
   * Component libraries rarely put the attribute where you click: an accordion
   * header is often a <div> wrapping the button that actually carries
   * aria-expanded, so checking only the clicked element missed every expand.
   */
  function nearestExpandedState(elem) {
    try {
      if (!elem || elem.nodeType !== 1) return null;
      if (elem.hasAttribute('aria-expanded')) return elem.getAttribute('aria-expanded');
      const descendant = elem.querySelector('[aria-expanded]') ||
        (elem.shadowRoot ? elem.shadowRoot.querySelector('[aria-expanded]') : null);
      if (descendant) return descendant.getAttribute('aria-expanded');
      const ancestor = deepClosest(elem, '[aria-expanded]');
      if (ancestor) return ancestor.getAttribute('aria-expanded');
    } catch (_) {}
    return null;
  }

  function targetState(elem) {
    if (!elem || elem.nodeType !== 1) return null;
    let classes = [];
    try {
      classes = window.PalTechSelectors
        ? window.PalTechSelectors.getClassNames(elem)
        : [];
    } catch (_) {}
    let checked = elem.getAttribute('aria-checked');
    const type = (elem.getAttribute('type') || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') checked = String(!!elem.checked);
    return {
      expanded: nearestExpandedState(elem),
      selected: elem.getAttribute('aria-selected'),
      checked,
      active: classes.some(c => /^(active|selected|current|is-open|is-active)$/i.test(c)),
      value: ('value' in elem) ? String(elem.value == null ? '' : elem.value).substring(0, 80) : '',
      disabled: !!elem.disabled
    };
  }

  function captureSnapshot(target) {
    try {
      return {
        url:        location.href,
        title:      document.title,
        heading:    currentHeading(),
        breadcrumb: currentBreadcrumb(),
        dialogs:    dialogSignatures(),
        panels:     panelSignatures(),
        marks:      selectionMarks(),
        box:        boxSignature(target),
        page:       pageMetrics(),
        alerts:     alertTexts(),
        list:       listStats(),
        fields:     fieldStates(),
        // Total visible text on the page. An accordion opening or a details
        // panel rendering changes nothing we track by selector, but it always
        // adds text — this is the generic catch-all for "content appeared".
        // Counted through the shadow roots as well — a component that renders a
        // whole panel of text adds nothing to document.body.textContent, which
        // is why opening one used to read as "no page change was detected".
        textLength: Shadow ? Shadow.textLength()
                           : (document.body && document.body.textContent || '').length,
        focus:      describeFocus(),
        // Whether the acted-on element itself holds focus. Comparing focus
        // LABELS was wrong: an unrelated field grabbing focus during the settle
        // window was reported as the outcome of a hover.
        targetFocused: !!(target && target.nodeType === 1 && deepActiveElement() === target),
        target:     targetState(target)
      };
    } catch (_) {
      return null;
    }
  }

  function arrayAdded(before, after) {
    return after.filter(x => before.indexOf(x) === -1);
  }

  /**
   * Could the control that was pressed be what emptied this field?
   *
   * A control that clears something sits with the thing it clears: the × inside
   * a search box, a chip's remove icon, a Reset button on the form it resets.
   * So the test is whether the two share a container a few levels up the flat
   * tree — generic, and it needs no knowledge of any widget.
   *
   * Deliberately conservative in both directions. The walk stops short of the
   * page-level containers, where "shares a container" would mean nothing at
   * all; and when the answer is no, nothing is lost — the ladder carries on to
   * the panel, list and content signals, which is where the outcome of a step
   * that merely happened to reset a search box actually lives.
   *
   * @param {Element} field
   * @param {Element} [target] - the element acted on
   */
  function clearedByTarget(field, target) {
    if (!field || !target) return false;
    if (field === target) return true;
    try {
      let container = target;
      for (let i = 0; i < 6 && container; i++) {
        if (container === document.body || container === document.documentElement) break;
        const tag = (container.tagName || '').toLowerCase();
        if (tag === 'main' || tag === 'body' || tag === 'html') break;
        if (deepContains(container, field)) return true;
        container = flatParent(container);
      }
    } catch (_) {}
    return false;
  }

  function samePath(a, b) {
    try { return new URL(a).pathname === new URL(b).pathname; } catch (_) { return a === b; }
  }

  /**
   * Turn two snapshots into a ranked outcome.
   *
   * The order below IS the priority ladder. A URL change is the LAST thing we
   * fall back on: "the URL changed" tells a manual tester almost nothing, while
   * "the Time Sheet page is displayed" is something they can actually check.
   */
  /**
   * @param {Object} before
   * @param {Object} after
   * @param {Object} [ctx] - { target, actionType, mutatedInsideTarget }
   */
  function diffSnapshots(before, after, ctx) {
    if (!before || !after) return { kind: 'none' };
    ctx = ctx || {};
    const actionType = ctx.actionType || '';
    const isHover    = actionType === 'hover';

    // 1/2. Dialogs
    const dialogsOpened = arrayAdded(before.dialogs, after.dialogs);
    if (dialogsOpened.length) return { kind: 'dialogOpened', title: dialogsOpened[0] };
    const dialogsClosed = arrayAdded(after.dialogs, before.dialogs);
    if (dialogsClosed.length) return { kind: 'dialogClosed', title: dialogsClosed[0] };

    // 3. Messages / toasts / validation
    const newAlerts = arrayAdded(before.alerts, after.alerts);
    if (newAlerts.length) return { kind: 'message', text: newAlerts[0] };

    // 4. Screen identity — heading first, then breadcrumb, then title
    const headingChanged    = after.heading    && after.heading    !== before.heading;
    const breadcrumbChanged = after.breadcrumb && after.breadcrumb !== before.breadcrumb;
    const titleChanged      = after.title      && after.title      !== before.title;
    if (headingChanged || breadcrumbChanged || titleChanged) {
      return {
        kind: 'screen',
        heading: after.heading || after.breadcrumb || after.title,
        title: after.title,
        url: after.url
      };
    }

    // A navigation is not a control being operated. Everything below describes
    // something a control did; when an SPA has not painted its heading yet, the
    // ladder used to fall through to whatever else had appeared and report the
    // act of loading a page as "the menu opens".
    if (actionType === 'navigate') {
      return after.url !== before.url
        ? { kind: 'url', url: after.url, samePath: samePath(before.url, after.url) }
        : { kind: 'none' };
    }

    // 5-7. State of the element that was acted on
    const b = before.target, a = after.target;
    if (b && a) {
      if (b.expanded !== a.expanded && a.expanded !== null) {
        return { kind: a.expanded === 'true' ? 'expanded' : 'collapsed' };
      }
      if (b.selected !== a.selected && a.selected === 'true') return { kind: 'selected' };
      if (b.active !== a.active && a.active) return { kind: 'selected' };
      if (b.checked !== a.checked && a.checked !== null) {
        return { kind: a.checked === 'true' ? 'checked' : 'unchecked' };
      }
    }

    // 7b. A field was emptied BY THIS STEP.
    //
    // Ranked here deliberately: clearing a field IS what a clear control does,
    // and it has to be reported ahead of the things the clearing knocks over —
    // the results list shrinking back, the suggestions panel closing, the page
    // getting shorter. Those are consequences; this is the action.
    //
    // Everything that empties fields for another reason has already returned
    // above: a navigation (screen), a dialog closing (dialogClosed), a form
    // submitting (message).
    //
    // The two conditions below are what keep it from stealing other steps'
    // outcomes, and both come from real recordings:
    //
    //   - TYPING is never a clearing. An autocomplete resets its search box
    //     when a suggestion is picked, and that reset landed inside the
    //     measurement window of the fill — so "Enter the search text
    //     'poojitha'" was reported as "the Search field is cleared and is
    //     empty", the opposite of what the step did.
    //
    //   - The field has to be NEAR the control pressed. Picking a suggestion
    //     also clears that search box, and the click that opened a details card
    //     was credited with the clearing instead of with the card appearing.
    //     A clear control lives with the thing it clears — the × inside the
    //     box, the Reset button on the form — so proximity in the flat tree is
    //     the generic test, and it costs nothing to be wrong about: the ladder
    //     simply carries on to the panel and content signals below.
    if (before.fields && after.fields && !isHover && actionType !== 'fill') {
      const stillFilled = new Set();
      after.fields.forEach(f => { if (f.filled) stillFilled.add(f.key); });
      const present = new Set(after.fields.map(f => f.key));
      const cleared = before.fields.filter(f =>
        f.filled && present.has(f.key) && !stillFilled.has(f.key) &&
        clearedByTarget(f.el, ctx.target));
      if (cleared.length) {
        return { kind: 'valueCleared', name: cleared[0].name, count: cleared.length };
      }
    }

    // 8. Menus / dropdowns / expandable panels
    const panelsOpened = arrayAdded(before.panels || [], after.panels || []);
    if (panelsOpened.length) {
      return { kind: 'panelOpened', label: panelsOpened[0], hover: isHover };
    }
    const panelsClosed = arrayAdded(after.panels || [], before.panels || []);
    if (panelsClosed.length) return { kind: 'panelClosed', label: panelsClosed[0] };

    // 9/10. List content.
    //
    // For a HOVER this is only believable when the DOM that changed was inside
    // the element being hovered — i.e. a fly-out menu. Without that check, a
    // background render elsewhere on the page was reported as "the list updates
    // to show 7 rows" for a step that merely moved the mouse.
    if (before.list && after.list) {
      const listChangeTrusted = !isHover || ctx.mutatedInsideTarget;
      if (listChangeTrusted) {
        if (before.list.count !== after.list.count) {
          return {
            kind: 'listCountChanged',
            from: before.list.count, to: after.list.count,
            hover: isHover
          };
        }
        if (after.list.count > 1 &&
            before.list.first !== after.list.first &&
            before.list.count === after.list.count) {
          return { kind: 'listReordered', first: after.list.first, count: after.list.count };
        }
      }
    }

    // 10b. Something else on the page became the current selection: a nav item
    //      highlighted, a tab marked current, a grid row selected. Not trusted
    //      for a hover, which highlights things merely by being over them.
    if (!isHover) {
      const marksGained = arrayAdded(before.marks || [], after.marks || []);
      if (marksGained.length) {
        return { kind: 'selectionChanged', label: marksGained[0] };
      }
    }

    // 10c. The element acted on, or the container holding it, changed size.
    //      This is what catches a submenu or an accordion that was already in
    //      the DOM and was only toggled with CSS.
    if (before.box && after.box) {
      const dOwn    = after.box.h  - before.box.h;
      const dParent = after.box.ph - before.box.ph;
      const grew    = Math.max(dOwn, dParent);
      const shrank  = Math.min(dOwn, dParent);
      if (grew > 8)    return { kind: 'contentExpanded',  delta: grew };
      if (shrank < -8) return { kind: 'contentCollapsed', delta: shrank };
    }

    // 11. Content appeared or disappeared in place (accordions, detail panels,
    //     inline expanders). Only trusted when the DOM that changed was inside
    //     or alongside the element acted on, so an unrelated background render
    //     is never reported as the outcome of this step.
    if (ctx.mutatedInsideTarget &&
        typeof before.textLength === 'number' && typeof after.textLength === 'number') {
      const delta = after.textLength - before.textLength;
      if (delta > 40)  return { kind: 'contentExpanded',  delta };
      if (delta < -40) return { kind: 'contentCollapsed', delta };
    }

    // 11b. The page itself got taller or shorter, or moved. Page-level and
    //       unattributable, so it sits at the bottom of the ladder — but a
    //       panel opening somewhere else on screen is still worth reporting.
    if (before.page && after.page) {
      const dh = after.page.h - before.page.h;
      if (Math.abs(dh) > 24) {
        return { kind: dh > 0 ? 'contentExpanded' : 'contentCollapsed', delta: dh, page: true };
      }
      const dy = after.page.y - before.page.y;
      if (Math.abs(dy) > 40 && actionType !== 'scroll') {
        return { kind: 'scrolled', dy: dy };
      }
    }

    // 12. Field value
    if (b && a && b.value !== a.value && a.value) {
      return { kind: 'valueSet', value: a.value };
    }

    // 13. Focus — only when the element that was acted on is the one that ended
    // up focused. Comparing focus labels alone attributed an unrelated field
    // stealing focus to whatever step happened to be in flight.
    if (after.targetFocused && !before.targetFocused && !isHover) {
      return { kind: 'focused', label: after.focus };
    }

    // 12. URL only — lowest priority on purpose
    if (after.url !== before.url) {
      return { kind: 'url', url: after.url, samePath: samePath(before.url, after.url) };
    }

    // 13. Nothing observable
    return { kind: 'none' };
  }

  /**
   * Measure the outcome of stepId once the page settles.
   * Only one action is tracked at a time; a new action flushes the previous one
   * immediately so rapid clicking still produces an outcome for every step.
   */
  function scheduleOutcome(stepId, before, target, actionType) {
    flushPendingOutcome();

    // Every scheduled measurement gets a number. The late re-check below runs
    // seconds later, by which time the tester may have moved on; anything it
    // sees then belongs to the newer action, so it is dropped.
    const generation = ++outcomeGeneration;

    const ctx = {
      stepId, before, target, actionType,
      done: false,
      mutatedInsideTarget: false
    };
    pendingOutcome = ctx;

    const measure = () => diffSnapshots(before, captureSnapshot(target), {
      target,
      actionType,
      mutatedInsideTarget: ctx.mutatedInsideTarget
    });

    ctx.startedAt = Date.now();
    // Requests already in flight when the tester acted (a long-poll, an
    // analytics beacon) say nothing about what THIS action achieved, so they
    // must never hold the measurement open.
    ctx.netIgnore = new Set(net.open);

    /**
     * @param {boolean} [force] - measure now, even if the app is still
     *   fetching. Set when a NEW action arrives: from that moment on, anything
     *   that changes on the page belongs to the new step, not this one.
     */
    ctx.finish = function (force) {
      if (ctx.done) return;

      // The app is still fetching what this action asked for. Measuring now
      // reports the page as it was before the response landed — which is how a
      // grid reloading over XHR became "no page change was detected". Wait for
      // the request, up to a cap so recording can never hang.
      const elapsed = Date.now() - ctx.startedAt;
      const stillBusy = requestsPendingFor(ctx);
      if (!force && stillBusy && elapsed < OUTCOME_BUSY_WAIT_MS) {
        clearTimeout(ctx.quietTimer);
        clearTimeout(ctx.hardTimer);
        ctx.quietTimer = setTimeout(ctx.finish, OUTCOME_QUIET_MS);
        ctx.hardTimer  = setTimeout(ctx.finish, OUTCOME_BUSY_WAIT_MS - elapsed);
        return;
      }

      ctx.done = true;
      clearTimeout(ctx.quietTimer);
      clearTimeout(ctx.hardTimer);
      if (ctx.observer) { try { ctx.observer.disconnect(); } catch (_) {} }
      if (pendingOutcome === ctx) pendingOutcome = null;

      const outcome = measure();
      sendOutcome(stepId, outcome);

      // One late re-check. Slow back-ends can land their response after the
      // hard cap; rather than lengthening every step's wait, look once more and
      // send a correction when what turns up says more than the first read did.
      // A weak first read matters as much as no read at all: an SPA that has
      // not painted its heading yet leaves the diff reporting whatever else
      // appeared on the way.
      // Nothing to gain from re-looking once the page itself, a dialog or a
      // message has been seen — those are the strongest readings there are.
      if (outcomeStrength(outcome) < OUTCOME_STRENGTH.message) {
        setTimeout(() => {
          if (generation !== outcomeGeneration) return;
          const late = measure();
          if (outcomeStrength(late) > outcomeStrength(outcome)) sendOutcome(stepId, late);
        }, Math.max(1000, OUTCOME_RECHECK_MS - OUTCOME_MAX_WAIT_MS));
      }
    };

    ctx.quietTimer = setTimeout(ctx.finish, OUTCOME_QUIET_MS);
    ctx.hardTimer  = setTimeout(ctx.finish, OUTCOME_MAX_WAIT_MS);

    try {
      const OBSERVE = { subtree: true, childList: true, attributes: true, characterData: true };
      const observed = new Set();

      /**
       * Watch the document and every open shadow root.
       *
       * A MutationObserver does NOT descend into a shadow root, so a component
       * that swapped its whole contents reported no mutations at all: the
       * settle window closed on the first quiet tick and the step was written
       * up as "no page change was detected". Roots are re-scanned on each batch
       * because the action being measured often CREATES the component it
       * opens.
       */
      let lastRootScan = 0;
      const observeAll = () => {
        try {
          if (!observed.has(document.documentElement)) {
            observed.add(document.documentElement);
            ctx.observer.observe(document.documentElement, OBSERVE);
          }
          if (!Shadow) return;
          // Throttled: a busy page delivers mutation batches many times a
          // second, and re-walking every element on each one to look for new
          // roots would cost more than the measurement is worth.
          const now = Date.now();
          if (now - lastRootScan < 250) return;
          lastRootScan = now;
          Shadow.resetCache();
          Shadow.roots().forEach(root => {
            if (observed.has(root)) return;
            observed.add(root);
            try { ctx.observer.observe(root, OBSERVE); } catch (_) {}
          });
        } catch (_) {}
      };

      ctx.observer = new MutationObserver((records) => {
        if (ctx.done) return;
        observeAll();

        // Remember whether the DOM that changed was inside the element acted on.
        // A hover only "opens a menu" if the new nodes belong to it.
        if (!ctx.mutatedInsideTarget && target && target.contains) {
          const up = flatParent(target);
          for (let i = 0; i < records.length && i < 50; i++) {
            const node = records[i].target;
            try {
              // contains() does not cross a shadow boundary either, so the flat
              // ancestor walk answers "did the thing I clicked change?" for a
              // control that renders its menu inside its own root.
              if (node && (target.contains(node) || (up && up.contains(node)) ||
                           deepContains(target, node))) {
                ctx.mutatedInsideTarget = true;
                break;
              }
            } catch (_) {}
          }
        }

        clearTimeout(ctx.quietTimer);
        ctx.quietTimer = setTimeout(ctx.finish, OUTCOME_QUIET_MS);
      });
      observeAll();
    } catch (_) {
      // No MutationObserver — the timers alone still produce an outcome
    }
  }

  /**
   * Whether the page is still fetching something this action asked for.
   * @param {Object} ctx - the pending measurement
   */
  function requestsPendingFor(ctx) {
    let pending = false;
    net.open.forEach((id) => { if (!ctx.netIgnore.has(id)) pending = true; });
    if (pending) return true;
    // A response that has only just landed still has to be rendered
    return !!(net.lastEndTs && !ctx.netIgnore.has(net.lastEndId) &&
              Date.now() - net.lastEndTs < OUTCOME_QUIET_MS);
  }

  function flushPendingOutcome() {
    if (pendingOutcome && !pendingOutcome.done) pendingOutcome.finish(true);
    pendingOutcome = null;
  }

  function cancelPendingOutcome() {
    if (pendingOutcome) {
      pendingOutcome.done = true;
      clearTimeout(pendingOutcome.quietTimer);
      clearTimeout(pendingOutcome.hardTimer);
      if (pendingOutcome.observer) { try { pendingOutcome.observer.disconnect(); } catch (_) {} }
    }
    pendingOutcome = null;
  }

  /**
   * Baseline snapshot taken when a field gains focus.
   *
   * A fill step is emitted at blur, but search-as-you-type has ALREADY filtered
   * the list by then — diffing from blur would show no change. Diffing from
   * focus attributes the filtering to the typing, which is where it belongs.
   */
  const inputBaselines = new WeakMap();

  function handleFocusIn(e) {
    if (!state.active) return;
    const t = deepTarget(e);
    if (!t || t.nodeType !== 1) return;
    const tag = (t.tagName || '').toLowerCase();
    if (!['input', 'textarea', 'select'].includes(tag)) return;
    if (!inputBaselines.has(t)) inputBaselines.set(t, captureSnapshot(t));
  }

  // ── Element targeting ───────────────────────────────────────────────────────

  /** True for <svg> and anything inside it (path, g, use, circle, ...). */
  function isSvgNode(elem) {
    if (!elem || elem.nodeType !== 1) return false;
    if (elem.ownerSVGElement) return true;
    return (elem.tagName || '').toLowerCase() === 'svg';
  }

  // Roles that describe a CONTAINER rather than a control. Walking up to one of
  // these would attribute a click to the whole page region it belongs to.
  const CONTAINER_ROLES = new Set([
    'presentation', 'none', 'main', 'banner', 'navigation', 'contentinfo',
    'complementary', 'region', 'group', 'list', 'document', 'application',
    'form', 'search', 'toolbar', 'tablist', 'menubar', 'grid', 'table',
    'rowgroup', 'row', 'article', 'feed', 'figure', 'heading', 'separator',
    'status', 'log', 'marquee', 'timer', 'tooltip', 'dialog', 'alertdialog'
  ]);

  const CONTROL_TAGS = [
    'a', 'button', 'input', 'select', 'textarea', 'label',
    'summary', 'details', 'option'
  ];

  /**
   * A real control: something with semantic meaning in the markup.
   * This is deliberately separate from the cursor:pointer test below.
   */
  function isSemanticControl(elem) {
    if (!elem || elem.nodeType !== 1 || isSvgNode(elem)) return false;
    if (elem === document.body || elem === document.documentElement) return false;

    const tag = (elem.tagName || '').toLowerCase();
    if (CONTROL_TAGS.includes(tag)) return true;

    const role = (elem.getAttribute('role') || '').toLowerCase();
    if (role && !CONTAINER_ROLES.has(role)) return true;

    if (elem.hasAttribute('onclick')) return true;
    if (elem.hasAttribute('tabindex') && elem.getAttribute('tabindex') !== '-1') return true;

    return false;
  }

  /** Clickable only by virtue of its styling — the weakest kind of evidence. */
  function isClickableByStyle(elem) {
    if (!elem || elem.nodeType !== 1 || isSvgNode(elem)) return false;
    if (elem === document.body || elem === document.documentElement) return false;
    try {
      return window.getComputedStyle(elem).cursor === 'pointer';
    } catch (_) {
      return false;
    }
  }

  /** Kept for callers that only need a yes/no answer. */
  function isInteractive(elem) {
    return isSemanticControl(elem) || isClickableByStyle(elem);
  }

  /**
   * Resolve the element the user meant to act on.
   *
   * TWO PASSES, and the order matters. Component frameworks wrap their controls
   * in presentational elements that inherit cursor:pointer:
   *
   *     <a href="/me"><span class="menu-icon ng-star-inserted"></span>Me</a>
   *
   * A single pass that accepts cursor:pointer stops at that inner <span>, which
   * has no role and no text — so the step came out as
   * `Click on "Menu Icon Ng Star Inserted"` with no role, and clicking the icon
   * versus the text produced two different steps for one nav item.
   *
   * Looking for a semantic control FIRST resolves both to the <a>, which is
   * what the user actually clicked. The styling heuristic is only the fallback
   * for genuinely div-based controls.
   */
  /**
   * The control a <label> operates, or null.
   *
   * WHY: clicking a label IS clicking its control — the browser forwards the
   * click. Recording the label as its own step produced two rows for one
   * physical click ("Click on the "Edit Accounts" label" followed by "Select
   * the "Edit Accounts" checkbox"), and gave the first row an invented expected
   * result for a click that never had one of its own.
   */
  function controlForLabel(elem) {
    if (!elem || elem.nodeType !== 1) return null;
    if ((elem.tagName || '').toLowerCase() !== 'label') return null;
    const isFormControl = (el) =>
      !!el && el.nodeType === 1 &&
      ['input', 'select', 'textarea'].includes((el.tagName || '').toLowerCase());

    try {
      // The browser's own answer, which honours both for= and nesting
      if (isFormControl(elem.control)) return elem.control;

      // for="id" — but only when it really points at a control. A label whose
      // target is missing or is some other element stays a label.
      const id = elem.getAttribute && elem.getAttribute('for');
      if (id && document.getElementById) {
        const byId = document.getElementById(id);
        if (isFormControl(byId)) return byId;
      }

      const nested = elem.querySelector ? elem.querySelector('input, select, textarea') : null;
      return isFormControl(nested) ? nested : null;
    } catch (_) {
      return null;
    }
  }

  /** A label resolves to what it operates; everything else is itself. */
  function throughLabel(elem) {
    return controlForLabel(elem) || elem;
  }

  function getInteractiveTarget(elem) {
    if (!elem || elem.nodeType !== 1) return elem;

    // SVG internals are never a meaningful target — jump out to the icon's owner
    let start = elem;
    if (isSvgNode(start)) {
      const svgRoot = start.ownerSVGElement || start;
      start = flatParent(svgRoot) || svgRoot;
    }

    const MAX_DEPTH = 10;

    // Both passes climb the FLAT tree, so a button inside a web component
    // resolves to that button — and if the clickable thing is the component
    // host itself, the walk still reaches it.
    // Pass 1 — the nearest real control
    let curr = start;
    for (let i = 0; i < MAX_DEPTH && curr && curr !== document.body; i++) {
      if (isSemanticControl(curr)) return throughLabel(curr);
      curr = flatParent(curr);
    }

    // Pass 2 — the nearest thing the page styles as clickable
    curr = start;
    for (let i = 0; i < MAX_DEPTH && curr && curr !== document.body; i++) {
      if (isClickableByStyle(curr)) return throughLabel(curr);
      curr = flatParent(curr);
    }

    return throughLabel(start);
  }
  // ── Event Handlers ──────────────────────────────────────────────────────────

  // 1. CLICK ──────────────────────────────────────────────────────────────────

  /**
   * Record one press of one control.
   *
   * @param {Element} target   - already resolved through getInteractiveTarget
   * @param {Object} [before]  - snapshot taken before the app reacted
   */
  function recordClick(target, before) {
    if (!target || target.nodeType !== 1) return;

    // Anything typed elsewhere is a step of its own and belongs BEFORE this
    // click. Normally blur has already emitted it; this covers the controls
    // that keep focus on the field they act on.
    flushPendingFills(target);

    const tag  = (target.tagName || '').toLowerCase();
    const type = (target.getAttribute('type') || '').toLowerCase();
    // Checkboxes, radios, file inputs are handled by the change handler
    if (tag === 'input' && (type === 'checkbox' || type === 'radio' || type === 'file')) return;

    const d = getLocatorData(target);
    if (!d.locator) return;
    const label = getVisibleName(target);
    sendStep({
      id: nextId(), type: 'click',
      locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
      value: '', displayValue: '',
      description: `Click ${label ? '"' + label + '"' : tag}`,
      url: location.href
    }, target, before || captureSnapshot(target));
  }

  function handleClick(e) {
    if (!state.active) return;
    cancelPendingHover();

    // One physical press produces at most one click, so this click accounts for
    // whatever press is outstanding — even when the two resolve to different
    // elements, which is what happens when the element pressed is gone by
    // mouseup and the browser dispatches the click at a surviving ancestor.
    const press = claimPendingPress();

    const target = getInteractiveTarget(deepTarget(e));

    // The press-time snapshot predates the app's own mousedown handlers, so it
    // is the better "before" whenever we have one for this element. Snapshotting
    // at click time stays correct for everything else: we run in the capture
    // phase, ahead of the app's click handlers.
    const before = (press && press.target === target)
      ? press.before
      : captureSnapshot(target);

    recordClick(target, before);
  }

  // 2. DOUBLE-CLICK ───────────────────────────────────────────────────────────
  function handleDblClick(e) {
    if (!state.active) return;
    cancelPendingHover();
    const target = getInteractiveTarget(deepTarget(e));
    const before = captureSnapshot(target);
    const d = getLocatorData(target);
    if (!d.locator) return;
    const label = getVisibleName(target);
    sendStep({
      id: nextId(), type: 'dblclick',
      locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
      value: '', displayValue: '',
      description: `Double-click ${label ? '"' + label + '"' : target.tagName.toLowerCase()}`,
      url: location.href
    }, target, before);
  }

  // 3. RIGHT-CLICK (contextmenu) ──────────────────────────────────────────────
  function handleContextMenu(e) {
    if (!state.active) return;
    cancelPendingHover();
    const target = getInteractiveTarget(deepTarget(e));
    const before = captureSnapshot(target);
    const d = getLocatorData(target);
    if (!d.locator) return;
    const label = getVisibleName(target);
    sendStep({
      id: nextId(), type: 'rightClick',
      locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
      value: '', displayValue: '',
      description: `Right-click ${label ? '"' + label + '"' : target.tagName.toLowerCase()}`,
      url: location.href
    }, target, before);
  }

  // 3b. INPUT — track typed value on every keystroke so blur can use it as fallback ──
  function handleInput(e) {
    if (!state.active) return;
    const target = deepTarget(e);
    const tag    = (target.tagName || '').toLowerCase();
    if (!['input', 'textarea'].includes(tag)) return;
    const type = (target.getAttribute('type') || 'text').toLowerCase();
    if (['checkbox','radio','file','submit','button','reset','image'].includes(type)) return;
    // Always update (including empty) so deliberate clearing is tracked correctly
    lastInputValues.set(target, target.value);
    pendingFills.add(target);
    if (!typingStarts.has(target)) {
      typingStarts.set(target, Date.now());
      // A fresh run of typing may legitimately re-enter the value that was
      // recorded last time round: search "abc", clear it with Backspace, search
      // "abc" again. emitFill's guard below is only meant to stop Enter AND
      // blur emitting the SAME entry twice, and it used to last for the life of
      // the page — so the second search was silently dropped.
      lastFilledValues.delete(target);
    }
  }

  /**
   * Central fill emitter — deduplicates so the same value is never sent twice
   * for the same element (prevents double-step when both Enter and blur both fire).
   */
  function emitFill(target, d, value, label, type) {
    if (!value) return;
    // Guards against Enter and blur both emitting the same entry. Cleared when
    // a new run of typing starts (handleInput), so re-entering the same text
    // later is recorded rather than swallowed.
    if (lastFilledValues.get(target) === value) return;
    lastFilledValues.set(target, value);
    pendingFills.delete(target);
    const isPassword   = (type || '').toLowerCase() === 'password';
    const displayValue = isPassword ? '•'.repeat(value.length) : value;
    const tag          = (target.tagName || '').toLowerCase();
    // Diff from the moment the field gained focus, not from now: a
    // search-as-you-type list has already re-filtered by the time blur fires.
    const baseline = inputBaselines.get(target);
    inputBaselines.delete(target);
    const startedAt = typingStarts.get(target) || Date.now();
    typingStarts.delete(target);
    sendStep({
      id: nextId(), type: 'fill', startedAt,
      locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
      value, displayValue, isPassword,
      description: `Fill "${label || tag}" with "${displayValue}"`,
      url: location.href
    }, target, baseline || captureSnapshot(target));
  }

  /**
   * Emit the value standing in a field as a step, whatever prompted it.
   *
   * What the tester typed comes first, and the field's current value second.
   *
   * WHY THAT ORDER: a combobox writes the chosen option's text into its own
   * input when you pick from the list — programmatically, so no input event
   * fires. Reading target.value therefore reported the widget's text as though
   * the tester had typed it, and the test data column held the full option
   * label instead of the few characters that were actually entered.
   * lastInputValues only ever holds values that arrived with a real input
   * event, so it is the honest answer whenever there is one.
   */
  function fillFrom(target) {
    if (!target || target.nodeType !== 1) return;
    const tag = (target.tagName || '').toLowerCase();
    if (!['input', 'textarea'].includes(tag)) return;
    const type = (target.getAttribute('type') || 'text').toLowerCase();
    if (['checkbox','radio','file','submit','button','reset','image'].includes(type)) return;

    pendingFills.delete(target);
    const typed = lastInputValues.get(target);
    const value = (typed !== undefined && typed !== '') ? typed : (target.value || '');
    lastInputValues.delete(target);
    if (!value) return;

    const d = getLocatorData(target);
    if (!d.locator) return;
    const label = getLabel(target) || d.name;
    emitFill(target, d, value, label, type);
  }

  /**
   * Emit anything typed but not yet recorded.
   *
   * A fill is normally emitted on blur or Enter, and that loses the value
   * outright whenever neither happens:
   *
   *   - Stop is pressed with the cursor still in the field. The commonest case
   *     of all, and the value simply disappeared.
   *   - The control clicked next keeps focus on the field. Chat and search
   *     widgets do this deliberately (their Send button suppresses the blur),
   *     so the typing was never a step — and the click's own outcome
   *     measurement then reported the typed text as ITS result: "Click on the
   *     Message field / The Message field contains 'an'".
   *   - The field is removed from the DOM while focused. Closing a dialog does
   *     that, and node removal fires no blur event.
   *
   * @param {Element} [except] - leave this field alone; the tester is still in it
   */
  function flushPendingFills(except) {
    if (!pendingFills.size) return;
    // Array.from, not slice.call: a Set is not array-like, and slice.call on one
    // quietly yields an empty list.
    Array.from(pendingFills).forEach(target => {
      if (target === except) return;
      pendingFills.delete(target);
      try { fillFrom(target); } catch (_) {}
    });
  }

  // 4. FILL — captured on blur; uses lastInputValues as fallback if app cleared the field ──
  function handleBlur(e) {
    if (!state.active) return;
    fillFrom(deepTarget(e));
  }

  // 5. CHANGE — handles select, checkbox, radio, file, range ──────────────────
  function handleChange(e) {
    if (!state.active) return;
    const target = deepTarget(e);
    const tag    = target.tagName.toLowerCase();
    const type   = (target.getAttribute('type') || '').toLowerCase();
    // The change event fires after the control's own state flipped, so use the
    // focus-time baseline where we have one.
    const before = inputBaselines.get(target) || captureSnapshot(target);
    inputBaselines.delete(target);
    const d      = getLocatorData(target);
    if (!d.locator) return;
    const label  = getLabel(target) || d.name;

    if (tag === 'select') {
      const idx  = target.selectedIndex;
      const text = idx >= 0 ? (target.options[idx].text || '') : '';
      const val  = target.value || '';
      sendStep({
        id: nextId(), type: 'select',
        locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
        value: val, displayValue: text,
        description: `Select "${text}" in "${label || 'dropdown'}"`,
        url: location.href
      }, target, before);

    } else if (tag === 'input' && type === 'checkbox') {
      const actionType = target.checked ? 'check' : 'uncheck';
      sendStep({
        id: nextId(), type: actionType,
        locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
        value: String(target.checked), displayValue: '',
        description: `${target.checked ? 'Check' : 'Uncheck'} "${label || 'checkbox'}"`,
        url: location.href
      }, target, before);

    } else if (tag === 'input' && type === 'radio') {
      sendStep({
        id: nextId(), type: 'check',
        locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
        value: target.value, displayValue: label,
        description: `Select radio "${label || target.value}"`,
        url: location.href
      }, target, before);

    } else if (tag === 'input' && type === 'file') {
      const files = Array.from(target.files || []).map(f => f.name);
      sendStep({
        id: nextId(), type: 'fileUpload',
        locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
        value: files.join(', '), displayValue: files.join(', '),
        description: `Upload "${files.join(', ')}" to "${label || 'file input'}"`,
        url: location.href
      }, target, before);

    } else if (tag === 'input' && type === 'range') {
      sendStep({
        id: nextId(), type: 'fill',
        locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
        value: target.value, displayValue: target.value,
        description: `Set slider "${label || 'range'}" to ${target.value}`,
        url: location.href
      }, target, before);
    }
  }

  // 6. KEYDOWN — special keys + Ctrl/Cmd combos ───────────────────────────────
  function handleKeydown(e) {
    if (!state.active) return;
    const isCtrl = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd + letter combos (A, C, V, X, Z, Y)
    if (isCtrl && !e.altKey) {
      const MAP = { a:'Control+A', c:'Control+C', v:'Control+V', x:'Control+X', z:'Control+Z', y:'Control+Y' };
      const combo = MAP[e.key.toLowerCase()];
      if (combo) {
        const target = deepTarget(e);
        const tag    = target.tagName.toLowerCase();
        const isInput = ['input','textarea'].includes(tag);
        const d = isInput ? getLocatorData(target) : { locator: 'page', priority: '', name: 'page', css: '', xpath: '' };
        if (isInput && !d.locator) return;
        const label = isInput ? (getLabel(target) || d.name || tag) : 'page';
        if (isInput) typingStarts.delete(target);   // see the note below
        sendStep({
          id: nextId(), type: 'press',
          locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
          value: combo, displayValue: combo,
          description: `Press "${combo}" on "${label}"`,
          url: location.href
        });
        return;
      }
    }

    if (!SPECIAL_KEYS.has(e.key)) return;

    const keyTarget = deepTarget(e);
    const target = (keyTarget && keyTarget !== document.body && keyTarget !== document)
      ? keyTarget
      : document.documentElement;
    const tag    = (target.tagName || '').toLowerCase();
    const d      = getLocatorData(target);
    if (!d.locator) return;
    const label  = getLabel(target) || d.name || tag;

    // When Enter is pressed on a text input, emit the fill step NOW — before the
    // app can clear the field or navigate away. emitFill deduplicates so blur
    // won't emit it a second time.
    if (e.key === 'Enter') {
      const inputType = (target.getAttribute('type') || 'text').toLowerCase();
      const isTextField = ['input', 'textarea'].includes(tag) &&
        !['checkbox','radio','file','submit','button','reset','image'].includes(inputType);
      if (isTextField) {
        const currentValue = lastInputValues.get(target) || target.value || '';
        if (currentValue) emitFill(target, d, currentValue, label, inputType);
      }
    }

    // A recorded keypress is a step of its own, so anything typed AFTERWARDS
    // belongs after it. Clearing the typing mark makes the next character
    // entered start a fresh run.
    //
    // This is what puts "press Backspace, then type the value" in that order:
    // Backspace edits the field, so it fires an input event of its own, and
    // without this the typed value was dated to the first Backspace and sorted
    // above the very keypresses that cleared the field for it.
    typingStarts.delete(target);

    sendStep({
      id: nextId(), type: 'press',
      locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
      value: e.key, displayValue: e.key,
      description: `Press "${e.key}" on "${label}"`,
      url: location.href
    });
  }

  // 7. FORM SUBMIT ────────────────────────────────────────────────────────────
  function handleSubmit(e) {
    if (!state.active) return;
    const form = deepTarget(e);
    if ((form.tagName || '').toLowerCase() !== 'form') return;
    const before = captureSnapshot(form);
    const d = getLocatorData(form);
    if (!d.locator) return;
    sendStep({
      id: nextId(), type: 'submit',
      locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
      value: '', displayValue: '',
      description: 'Submit form',
      url: location.href
    }, form, before);
  }

  // 8. HOVER — only record if cursor stays > 700ms (avoids noise) ─────────────
  function handleMouseover(e) {
    if (!state.active) return;
    const target = getInteractiveTarget(deepTarget(e));
    if (target === state.lastHoveredElem) return;
    clearTimeout(state.hoverTimer);
    state.lastHoveredElem = target;

    // Snapshot now, while the cursor has only just arrived — a fly-out menu
    // opens during the 700ms wait, and that difference is the whole point.
    const before = captureSnapshot(target);

    state.hoverTimer = setTimeout(() => {
      if (!state.active) return;
      const d = getLocatorData(target);
      if (!d.locator) return;
      const label = getVisibleName(target);
      sendStep({
        id: nextId(), type: 'hover',
        locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
        value: '', displayValue: '',
        description: `Hover over "${label || target.tagName.toLowerCase()}"`,
        url: location.href
      }, target, before);
    }, 700);
  }

  /**
   * Kill a hover step that has not fired yet.
   *
   * Moving the mouse to a control and clicking it used to produce BOTH a hover
   * and a click — and because the 700ms timer outlived a fast click, the hover
   * was often appended AFTER it ("Click Home" then "Hover Home"). A hover that
   * ends in a click was never a distinct user intention.
   */
  function cancelPendingHover() {
    clearTimeout(state.hoverTimer);
    state.hoverTimer = null;
  }

  // ── One press, one step ─────────────────────────────────────────────────────
  //
  // A control that commits on MOUSEDOWN and then disappears never produces a
  // click event at all: a click is dispatched only when mousedown and mouseup
  // happen on the same element, and there is nothing left under the pointer by
  // then.
  //
  // Every autocomplete works this way, for a good reason — touching the
  // dropdown blurs the input, and blur closes the list, so a widget that waited
  // for the click would lose the selection. Menus, date pickers and tree
  // pickers do the same. The recording that came out held "click the search
  // field" and "enter the value" but nothing for the result the tester picked,
  // because the only event that ever arrived was the blur.
  //
  // So the press is remembered, and recorded only if no click follows it.
  //
  // THE WAIT STARTS AT MOUSEUP, NOT AT THE PRESS. Timing it from mousedown
  // means guessing how long the tester holds the button down, and getting that
  // wrong records the same click twice: the window closed mid-press, the step
  // was written from the press, and then mouseup dispatched a click that found
  // no press left to claim. An ordinary deliberate click on a search box was
  // enough to produce two identical rows. A click, if the browser is going to
  // dispatch one at all, follows mouseup immediately — so a short wait after
  // the button is RELEASED is both reliable and independent of the press.

  const ORPHAN_PRESS_MS = 150;

  let pendingPress = null;   // { target, before, timer }

  function forgetPendingPress() {
    if (!pendingPress) return;
    clearTimeout(pendingPress.timer);
    pendingPress = null;
  }

  /** Called by whatever DID record the press, so it is never recorded twice. */
  function claimPendingPress() {
    const press = pendingPress;
    forgetPendingPress();
    return press;
  }

  function handleMouseDown(e) {
    if (!state.active) return;
    cancelPendingHover();
    forgetPendingPress();

    // Primary button only: a right-click has contextmenu of its own, and a
    // middle-click press is not a step.
    if (!e || (e.button !== undefined && e.button !== 0)) return;

    const target = getInteractiveTarget(deepTarget(e));
    if (!target || target.nodeType !== 1) return;

    // Controls only. Without this, dragging a scrollbar or starting a text
    // selection — neither of which ends in a click on what was pressed — would
    // invent a step for whatever happened to be under the pointer.
    if (!isInteractive(target)) return;

    // No timer yet: nothing is decided until the button comes back up. Holding
    // the button down, however long, is still one press.
    pendingPress = {
      target,
      // Taken now, ahead of the app's own mousedown handlers. For a widget that
      // acts on mousedown this is the only honest "before" there is; measuring
      // from click time would compare the page against itself after the fact.
      before: captureSnapshot(target),
      timer: null
    };
  }

  function handleMouseUp() {
    if (!state.active) return;
    const press = pendingPress;
    if (!press || press.timer) return;    // already waiting on this one

    press.timer = setTimeout(() => {
      if (pendingPress !== press) return; // a click claimed it
      pendingPress = null;
      recordClick(press.target, press.before);
    }, ORPHAN_PRESS_MS);
  }

  function handleMouseout() {
    clearTimeout(state.hoverTimer);
  }

  // 9. SCROLL — debounced 500ms, ignores tiny nudges < 50px ──────────────────
  function handleWheel(e) {
    if (!state.active) return;
    scrollAccY += e.deltaY;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const dy = Math.round(scrollAccY);
      if (Math.abs(dy) >= 50) {
        sendStep({
          id: nextId(), type: 'scroll',
          locator: 'page', priority: '', elementName: 'page', css: '', xpath: '',
          value: String(dy), displayValue: String(dy),
          description: `Scroll ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px`,
          url: location.href
        });
      }
      scrollAccY = 0;
    }, 500);
  }

  // 10. DRAG & DROP ───────────────────────────────────────────────────────────
  function handleDragstart(e) {
    if (!state.active) return;
    // The press that began this drag will never become a click, and it is not
    // one: without this, every drag invented a click on whatever it started
    // from.
    forgetPendingPress();
    dragSource = deepTarget(e);
  }

  function handleDrop(e) {
    if (!state.active || !dragSource) return;
    const srcD = getLocatorData(dragSource);
    const tgtD = getLocatorData(deepTarget(e));
    if (!srcD.locator || !tgtD.locator) return;
    sendStep({
      id: nextId(), type: 'dragDrop',
      locator: srcD.locator, priority: srcD.priority, elementName: srcD.name, css: srcD.css, xpath: srcD.xpath,
      value: tgtD.locator, displayValue: tgtD.name,
      targetLocator: tgtD.locator, targetCss: tgtD.css, targetXpath: tgtD.xpath,
      description: `Drag "${srcD.name || 'element'}" onto "${tgtD.name || 'target'}"`,
      url: location.href
    });
    dragSource = null;
  }

  // 11. PASTE ─────────────────────────────────────────────────────────────────
  function handlePaste(e) {
    if (!state.active) return;
    const target = deepTarget(e);
    const tag    = (target.tagName || '').toLowerCase();
    if (!['input','textarea'].includes(tag)) return;
    const text = (e.clipboardData || window.clipboardData || {}).getData('text') || '';
    if (!text) return;
    const d     = getLocatorData(target);
    if (!d.locator) return;
    const label = getLabel(target) || d.name;
    const preview = text.substring(0, 40) + (text.length > 40 ? '…' : '');
    sendStep({
      id: nextId(), type: 'fill',
      locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
      value: text, displayValue: preview,
      description: `Paste "${preview}" into "${label || tag}"`,
      url: location.href
    });
  }

  // 12. TOUCH TAP ─────────────────────────────────────────────────────────────
  let touchStartTarget = null, touchStartTime = 0;
  function handleTouchstart(e) {
    if (!state.active) return;
    touchStartTarget = deepTarget(e);
    touchStartTime   = Date.now();
  }

  function handleTouchend(e) {
    if (!state.active || !touchStartTarget) return;
    if (Date.now() - touchStartTime > 600) return; // long-press — skip
    // Emulated touch fires mousedown too; the tap is the step, not the press
    claimPendingPress();
    const target = getInteractiveTarget(touchStartTarget);
    const d      = getLocatorData(target);
    if (!d.locator) return;
    const label = getVisibleName(target);
    sendStep({
      id: nextId(), type: 'tap',
      locator: d.locator, priority: d.priority, elementName: d.name, css: d.css, xpath: d.xpath,
      value: '', displayValue: '',
      description: `Tap "${label || target.tagName.toLowerCase()}"`,
      url: location.href
    });
    touchStartTarget = null;
  }

  // ── Page hooks (SPA navigation + native dialogs) ────────────────────────────
  //
  // The actual patching lives in content/pageHooks.js, which runs in the page's
  // MAIN world. Patching history/alert/confirm/prompt from here (the isolated
  // world) only ever replaced our own copies and never intercepted anything the
  // page itself called. We now just listen for what pageHooks.js reports.

  function recordNavigate(url) {
    const step = {
      id: nextId(), type: 'navigate',
      locator: 'page', priority: '', elementName: 'page', css: '', xpath: '',
      value: '', displayValue: '',
      description: `Navigate to "${url || location.href}"`,
      url: url || location.href
    };

    // Pass a deliberately empty "before" so the settle pass reports the screen
    // that has finished rendering. On an SPA the heading often does not exist
    // yet at navigation time, and the panel needs it to say "the Time Sheet page
    // is displayed" instead of falling back to the raw URL.
    sendStep(step, document.documentElement, {
      url: '', title: '', heading: '', breadcrumb: '',
      dialogs: [], alerts: [], list: { count: 0, first: '', last: '' },
      focus: '', target: null
    });
  }

  function handlePageEvent(e) {
    if (!state.active) return;

    let payload;
    try {
      payload = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail;
    } catch (_) {
      return;
    }
    if (!payload || !payload.kind) return;

    if (payload.kind === 'navigate') {
      // Ignore a repeat of the URL we are already sitting on — frameworks fire
      // replaceState on every render in some setups.
      if (payload.url === state.lastNavigatedUrl) return;
      state.lastNavigatedUrl = payload.url;
      recordNavigate(payload.url);
      return;
    }

    if (payload.kind === 'net') {
      const id = Number(payload.id) || 0;
      if (payload.ev === 'start') {
        net.open.add(id);
      } else {
        net.open.delete(id);
        net.lastEndId = id;
        net.lastEndTs = Date.now();
      }
      return;
    }

    if (payload.kind === 'dialog') {
      const message = String(payload.message || '');
      const label   = payload.dialog === 'confirm' ? 'confirm'
                    : payload.dialog === 'prompt'  ? 'prompt'
                    : 'alert';
      let description = `Handle ${label}: "${message.substring(0, 60)}"`;
      if (payload.dialog === 'confirm') {
        description += ` → ${payload.result === 'accept' ? 'Accept' : 'Dismiss'}`;
      } else if (payload.dialog === 'prompt') {
        description += ` → "${payload.value || ''}"`;
      }

      sendStep({
        id: nextId(), type: 'dialog',
        locator: 'page', priority: '', elementName: 'page', css: '', xpath: '',
        value: payload.result === 'accept' ? 'accept' : 'dismiss',
        displayValue: payload.dialog === 'prompt'
          ? String(payload.value || '')
          : message.substring(0, 100),
        dialogKind: payload.dialog,
        description,
        url: location.href
      });
    }
  }

  // ── Recording Indicator (visible on the page) ───────────────────────────────

  function showIndicator() {
    if (state.indicator) return;
    const style = document.createElement('style');
    style.id = 'paltech-rec-style';
    style.textContent =
      '@keyframes paltech-blink{0%,100%{opacity:1}50%{opacity:.25}}';
    document.head.appendChild(style);

    const div = document.createElement('div');
    div.id = 'paltech-recording-indicator';
    div.style.cssText = [
      'position:fixed','top:12px','right:12px','z-index:2147483647',
      'background:#dc3545','color:#fff','padding:5px 12px',
      'border-radius:20px','font-family:monospace','font-size:12px',
      'font-weight:bold','pointer-events:none',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)',
      'display:flex','align-items:center','gap:6px'
    ].join(';');
    div.innerHTML =
      '<span style="width:8px;height:8px;background:#fff;border-radius:50%;' +
      'animation:paltech-blink 1s infinite"></span>REC';
    document.body.appendChild(div);
    state.indicator = div;
  }

  function hideIndicator() {
    if (state.indicator) { state.indicator.remove(); state.indicator = null; }
    const s = document.getElementById('paltech-rec-style');
    if (s) s.remove();
  }

  // ── Events that cannot leave a shadow root ──────────────────────────────────
  //
  // `change` and `submit` are composed: false — the platform stops them at the
  // component boundary, so a document listener never hears them. A <select>, a
  // checkbox or a form inside ANY web component was therefore silently
  // unrecorded. Every other event the recorder listens for is composed and
  // reaches the document on its own, and must NOT be bound here as well or each
  // one would be recorded twice.

  const NON_COMPOSED = [
    ['change', handleChange],
    ['submit', handleSubmit]
  ];

  // Roots we have bound to, so re-arming is idempotent and stop() can unbind.
  let armedRoots = [];

  /**
   * Bind the non-composed handlers inside every open shadow root.
   *
   * Called on start and again after each step, because components are created
   * as an application is used — a dialog that mounts on first open has no root
   * to bind at the moment recording begins.
   */
  function armShadowRoots() {
    if (!state.active || !Shadow) return;
    try {
      Shadow.roots().forEach(root => {
        if (armedRoots.indexOf(root) !== -1) return;
        armedRoots.push(root);
        NON_COMPOSED.forEach(([name, handler]) => {
          try { root.addEventListener(name, handler, true); } catch (_) {}
        });
      });
    } catch (_) {}
  }

  function disarmShadowRoots() {
    armedRoots.forEach(root => {
      NON_COMPOSED.forEach(([name, handler]) => {
        try { root.removeEventListener(name, handler, true); } catch (_) {}
      });
    });
    armedRoots = [];
  }

  // ── Start / Stop ────────────────────────────────────────────────────────────

  /**
   * @param {Object} [options]
   * @param {boolean} [options.resumed] - true when the service worker re-armed
   *        recording after a page navigation. The starting URL is still recorded
   *        (the navigation genuinely happened and belongs in the test), but the
   *        step id sequence continues rather than restarting.
   */
  function start(options) {
    if (state.active) return;
    state.active = true;
    state.lastNavigatedUrl = location.href;

    document.addEventListener('click',       handleClick,       true);
    document.addEventListener('mousedown',   handleMouseDown,   true);
    document.addEventListener('mouseup',     handleMouseUp,     true);
    document.addEventListener('dblclick',    handleDblClick,    true);
    document.addEventListener('contextmenu', handleContextMenu, true);
    document.addEventListener('blur',        handleBlur,        true);
    document.addEventListener('focusin',     handleFocusIn,     true);
    document.addEventListener('input',       handleInput,       true);
    document.addEventListener('change',      handleChange,      true);
    document.addEventListener('keydown',     handleKeydown,     true);
    document.addEventListener('submit',      handleSubmit,      true);
    document.addEventListener('mouseover',   handleMouseover,   true);
    document.addEventListener('mouseout',    handleMouseout,    true);
    document.addEventListener('wheel',       handleWheel,       { capture: true, passive: true });
    document.addEventListener('dragstart',   handleDragstart,   true);
    document.addEventListener('drop',        handleDrop,        true);
    document.addEventListener('paste',       handlePaste,       true);
    document.addEventListener('touchstart',  handleTouchstart,  { capture: true, passive: true });
    document.addEventListener('touchend',    handleTouchend,    true);

    // Reported by content/pageHooks.js from the page's MAIN world
    document.addEventListener('paltech-page-event', handlePageEvent);

    // Components that already exist get their non-composed events bound now;
    // ones mounted later are picked up after each step (see sendStep).
    if (Shadow) Shadow.resetCache();
    armShadowRoots();

    showIndicator();

    // Record the starting URL as the first step
    recordNavigate(location.href);
  }

  function stop() {
    if (!state.active) return;

    // Before anything is torn down: a value still being typed when Stop was
    // pressed is part of the test, and blur is never going to fire now.
    flushPendingFills();
    pendingFills.clear();

    state.active = false;

    document.removeEventListener('click',       handleClick,       true);
    document.removeEventListener('mousedown',   handleMouseDown,   true);
    document.removeEventListener('mouseup',     handleMouseUp,     true);
    document.removeEventListener('dblclick',    handleDblClick,    true);
    document.removeEventListener('contextmenu', handleContextMenu, true);
    document.removeEventListener('blur',        handleBlur,        true);
    document.removeEventListener('focusin',     handleFocusIn,     true);
    document.removeEventListener('input',       handleInput,       true);
    document.removeEventListener('change',      handleChange,      true);
    document.removeEventListener('keydown',     handleKeydown,     true);
    document.removeEventListener('submit',      handleSubmit,      true);
    document.removeEventListener('mouseover',   handleMouseover,   true);
    document.removeEventListener('mouseout',    handleMouseout,    true);
    document.removeEventListener('wheel',       handleWheel,       true);
    document.removeEventListener('dragstart',   handleDragstart,   true);
    document.removeEventListener('drop',        handleDrop,        true);
    document.removeEventListener('paste',       handlePaste,       true);
    document.removeEventListener('touchstart',  handleTouchstart,  true);
    document.removeEventListener('touchend',    handleTouchend,    true);
    document.removeEventListener('paltech-page-event', handlePageEvent);

    disarmShadowRoots();
    forgetPendingPress();
    clearTimeout(state.hoverTimer);
    clearTimeout(scrollTimer);
    cancelPendingOutcome();
    scrollAccY   = 0;
    dragSource   = null;
    touchStartTarget = null;
    hideIndicator();
  }

  function isActive() {
    return !!state.active;
  }

  window.PalTechRecorder = {
    start, stop, isActive,
    // Exposed for run_tests.js only — these are the two pieces of targeting and
    // outcome logic worth asserting on directly.
    __internals: {
      getInteractiveTarget, isInteractive, diffSnapshots, isSvgNode, outcomeStrength,
      controlForLabel,
      // The fill pipeline: when a typed value becomes a step is the whole
      // question, and it is only answerable by driving the handlers.
      handleInput, handleBlur, handleKeydown, handleClick, flushPendingFills,
      // A press that never becomes a click is the whole point of these
      handleMouseDown, handleMouseUp, handleDragstart, recordClick, ORPHAN_PRESS_MS,
      // Naming a control that wraps a whole card
      getVisibleName, headlineText, trimToWords
    }
  };

})();
