/**
 * inspection.js - Functions for element inspection mode
 *
 * Wrapped in an IIFE guard so that repeated executeScript injections
 * never re-declare variables (avoids "Identifier already declared" errors).
 * State is kept on window.PalTechInspectionState so it survives re-injection.
 */
(function () {

  // Re-injection guard: re-export and stop if already running
  if (window.PalTechInspection) {
    // Re-wire the export in case the page partially reloaded
    return;
  }

  // Persistent state on window so re-injection doesn't lose it
  if (!window.PalTechInspectionState) {
    window.PalTechInspectionState = {
      active: false,
      overlay: null
    };
  }
  const state = window.PalTechInspectionState;

  // ── Overlay ────────────────────────────────────────────────

  function createInspectionOverlay() {
    const existing = document.querySelector('#selector-inspection-overlay');
    if (existing) return existing;

    const overlay = document.createElement('div');
    overlay.id = 'selector-inspection-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:999999',
      'background:rgba(255,165,0,0.3)',
      'border:2px solid orange',
      'box-sizing:border-box',
      'display:none'
    ].join(';');
    document.body.appendChild(overlay);

    // Tooltip shown near cursor on mousemove — shows tag + element name
    const tooltip = document.createElement('div');
    tooltip.id = 'selector-inspection-tooltip';
    tooltip.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:1000000',
      'background:#333',
      'color:#fff',
      'font-family:monospace',
      'font-size:11px',
      'padding:4px 8px',
      'border-radius:4px',
      'white-space:nowrap',
      'display:none',
      'max-width:300px',
      'overflow:hidden',
      'text-overflow:ellipsis'
    ].join(';');
    document.body.appendChild(tooltip);
    state.tooltip = tooltip;

    return overlay;
  }

  // ── Shadow DOM helpers ─────────────────────────────────────

  /**
   * Pierces shadow roots recursively to find the real element under the cursor.
   * Standard elementFromPoint() stops at the shadow host and never sees
   * elements inside open shadow roots (Web Components, etc.).
   */
  function deepElementFromPoint(x, y) {
    let elem = document.elementFromPoint(x, y);
    let depth = 0;
    while (elem && elem.shadowRoot && depth++ < 40) {
      const inner = elem.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === elem) break;
      elem = inner;
    }
    return elem;
  }

  /**
   * Builds a Playwright-compatible pierce path for a shadow-DOM element.
   * e.g.  "div.app-root >> css=button.submit"
   * Returns null for elements not inside any shadow root.
   */
  function buildShadowPiercePath(elem) {
    // content/shadow.js owns this now, so inspection mode and the recorder
    // cannot drift apart on how a component is addressed. The walk below is
    // kept as the fallback for a load where that module is missing.
    if (window.PalTechShadow) {
      const shared = window.PalTechShadow.piercePath(elem);
      if (shared) return shared;
    }

    const parts = [];
    let current = elem;
    while (current) {
      const host = current.getRootNode && current.getRootNode();
      if (!host || host === document) break;
      if (host instanceof ShadowRoot) {
        // Use a simple tag+class selector for each shadow-layer element
        const tag = current.tagName.toLowerCase();
        // Read classes through the shared helper: SVG elements expose className
        // as an SVGAnimatedString and would otherwise be silently skipped.
        const classNames = (window.PalTechSelectors && window.PalTechSelectors.getClassNames)
          ? window.PalTechSelectors.getClassNames(current)
          : [];
        const escapeIdent = (window.PalTechSelectors && window.PalTechSelectors.cssEscapeIdent)
          ? window.PalTechSelectors.cssEscapeIdent
          : (s => s);
        const cls = classNames.length ? '.' + classNames.map(escapeIdent).join('.') : '';
        parts.unshift(`css=${tag}${cls}`);
        current = host.host;
      } else {
        break;
      }
    }
    if (parts.length === 0) return null;
    // Add the top-level host selector
    const hostTag = current ? current.tagName.toLowerCase() : '';
    const escapeHostId = (window.PalTechSelectors && window.PalTechSelectors.cssEscapeIdent)
      ? window.PalTechSelectors.cssEscapeIdent
      : (s => s);
    const hostId  = current && current.id ? `#${escapeHostId(current.id)}` : '';
    parts.unshift(`css=${hostTag}${hostId}`);
    return parts.join(' >> ');
  }

  /**
   * Escapers for text that ends up inside GENERATED CODE, not inside HTML.
   *
   * WHY: the iframe branch below interpolated page-supplied names straight into
   * Playwright locators. An aria-label of  Employee's name  produced
   *     getByRole('div', { name: 'Employee's name' })
   * — code that will not compile in the test the QA engineer pastes it into.
   * playwright.js has done this correctly all along; these just borrow it, and
   * keep working if that module failed to load.
   */
  function escLit(str) {
    return (window.PalTechPlaywright && window.PalTechPlaywright.escLit)
      ? window.PalTechPlaywright.escLit(str)
      : String(str == null ? '' : str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  /** For a value inside a double-quoted CSS attribute selector. */
  function escAttr(str) {
    return (window.PalTechPlaywright && window.PalTechPlaywright.attrValue)
      ? window.PalTechPlaywright.attrValue(str)
      : String(str == null ? '' : str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // ── Event handlers ─────────────────────────────────────────

  function handleMouseMove(e) {
    if (!state.active || !state.overlay) return;
    const elem = deepElementFromPoint(e.clientX, e.clientY);
    if (!elem || elem === state.overlay || elem === state.tooltip) return;

    // The overlay is position:fixed, so it is placed in VIEWPORT coordinates —
    // exactly what getBoundingClientRect() returns. Adding window.scrollY/X here
    // (as this used to) pushed the highlight box off by the scroll offset on
    // every scrolled page.
    const rect = elem.getBoundingClientRect();
    state.overlay.style.display = 'block';
    state.overlay.style.top    = rect.top    + 'px';
    state.overlay.style.left   = rect.left   + 'px';
    state.overlay.style.width  = rect.width  + 'px';
    state.overlay.style.height = rect.height + 'px';

    // Update tooltip content and position near cursor
    if (state.tooltip) {
      const tag = elem.tagName.toLowerCase();
      const name = window.PalTechNaming
        ? window.PalTechNaming.generateElementName(elem)
        : (elem.id || elem.getAttribute('aria-label') || tag);
      state.tooltip.textContent = `<${tag}>  ${name}`;
      // Offset so tooltip doesn't sit under the cursor
      const tx = Math.min(e.clientX + 14, window.innerWidth - 310);
      const ty = e.clientY + 18;
      state.tooltip.style.left    = tx + 'px';
      state.tooltip.style.top     = ty + 'px';
      state.tooltip.style.display = 'block';
    }
  }

  function handleElementClick(e) {
    if (!state.active) return;

    e.preventDefault();
    e.stopPropagation();

    // Use shadow-piercing lookup so Web Component internals are inspectable
    const elem = deepElementFromPoint(e.clientX, e.clientY);
    if (!elem || elem === state.overlay) return;

    // iFrame detection: if the user clicked on an iframe, try to inspect
    // the element inside it (same-origin only — cross-origin is blocked by CSP).
    if (elem.tagName.toLowerCase() === 'iframe') {
      try {
        const iframeDoc = elem.contentDocument || elem.contentWindow?.document;
        if (iframeDoc) {
          const rect = elem.getBoundingClientRect();
          const innerX = e.clientX - rect.left;
          const innerY = e.clientY - rect.top;
          const innerElem = iframeDoc.elementFromPoint(innerX, innerY);
          if (innerElem) {
            // Build a specific frameLocator selector from the iframe's own attributes
            let frameSelector = 'iframe';
            if (elem.id) {
              frameSelector = `iframe#${CSS.escape(elem.id)}`;
            } else if (elem.getAttribute('name')) {
              frameSelector = `iframe[name="${escAttr(elem.getAttribute('name'))}"]`;
            } else if (elem.getAttribute('title')) {
              frameSelector = `iframe[title="${escAttr(elem.getAttribute('title'))}"]`;
            } else if (elem.src) {
              try {
                const srcPath = new URL(elem.src).pathname.split('/').pop();
                if (srcPath) frameSelector = `iframe[src*="${escAttr(srcPath)}"]`;
              } catch (_) {}
            }

            // Build a specific inner-element selector from its available attributes
            const innerTag = innerElem.tagName.toLowerCase();
            let innerSelector = innerTag;
            let playwrightLocator = '';

            const frame = `page.frameLocator('${escLit(frameSelector)}')`;

            if (innerElem.getAttribute('data-testid')) {
              const tid = innerElem.getAttribute('data-testid');
              innerSelector = `[data-testid="${escAttr(tid)}"]`;
              playwrightLocator = `${frame}.getByTestId('${escLit(tid)}')`;
            } else if (innerElem.getAttribute('aria-label')) {
              const label = innerElem.getAttribute('aria-label');
              innerSelector = `[aria-label="${escAttr(label)}"]`;
              playwrightLocator = `${frame}.getByRole('${escLit(innerTag)}', { name: '${escLit(label)}' })`;
            } else if (innerElem.id) {
              innerSelector = `#${CSS.escape(innerElem.id)}`;
              playwrightLocator = `${frame}.locator('${escLit(innerSelector)}')`;
            } else if (innerElem.getAttribute('name')) {
              innerSelector = `[name="${escAttr(innerElem.getAttribute('name'))}"]`;
              playwrightLocator = `${frame}.locator('${escLit(innerSelector)}')`;
            } else if (innerElem.getAttribute('placeholder')) {
              const ph = innerElem.getAttribute('placeholder');
              playwrightLocator = `${frame}.getByPlaceholder('${escLit(ph)}')`;
            } else {
              playwrightLocator = `${frame}.locator('${escLit(innerSelector)}')`;
            }

            chrome.runtime.sendMessage({
              action: 'elementInspected',
              element: {
                tag:  innerTag,
                text: (innerElem.textContent || '').trim().substring(0, 100),
                name: `iframe > ${innerTag}`,
                alternativeSelectors: [],
                generalizedSelectors: [],
                playwrightLocator,
                playwrightPriority: 'iFrame',
                shadowPiercePath: null,
                iframeNote: `Inside ${frameSelector}. frameLocator() scopes Playwright to the iframe before locating the element.`
              }
            });
            return;
          }
        }
      } catch (_) {
        chrome.runtime.sendMessage({
          action: 'elementInspected',
          element: {
            tag: 'iframe', text: '', name: 'Cross-origin iframe',
            alternativeSelectors: [], generalizedSelectors: [],
            playwrightLocator: '', playwrightPriority: 'N/A',
            shadowPiercePath: null,
            iframeNote: 'Cross-origin iframe — cannot inspect content due to browser security policy.'
          }
        });
        return;
      }
    }

    // Everything below is wrapped so that a single problematic element can
    // never leave the panel with no response at all. Previously a throw here
    // (an SVG icon was enough) meant no message was ever sent and the panel
    // just sat there showing the previous element.
    if (!window.PalTechSelectors) {
      chrome.runtime.sendMessage({
        action: 'elementInspected',
        element: {
          tag: elem.tagName ? elem.tagName.toLowerCase() : 'unknown',
          text: '', name: 'Selector module not loaded',
          alternativeSelectors: [], generalizedSelectors: [],
          playwrightLocator: '', playwrightPriority: 'N/A',
          shadowPiercePath: null,
          inspectError: 'The selector module failed to load on this page. Reload the page and try again.'
        }
      });
      return;
    }

    try {
      const shadowPiercePath = buildShadowPiercePath(elem);

      const alternativeSelectors = window.PalTechSelectors.getAlternativeSelectors(elem);

      const cssSelector = window.PalTechSelectors.getCssSelector(elem);
      const xpath       = window.PalTechSelectors.getRelativeXpath(elem);

      let playwrightLocator  = '';
      let playwrightPriority = 'N/A';

      // The P1-P9 chain runs for component content too. It used to be skipped
      // here, because its uniqueness counts were document-only: every candidate
      // for an element inside a shadow root scored 0 matches, so the pierce path
      // was the only thing left. Those counts now pierce open roots the way
      // Playwright's own engines do (content/shadow.js), so a component button
      // gets getByRole('button', { name: 'Send message' }) — a locator a human
      // can read — instead of a chain of hashed class names.
      if (window.PalTechPlaywright) {
        const pw = window.PalTechPlaywright.getPlaywrightLocator(elem, cssSelector, xpath);
        playwrightLocator  = pw.locator;
        playwrightPriority = pw.priority;
      }

      // Nothing resolvable came back: the host chain at least addresses the
      // component, which beats an XPath that cannot cross into it at all.
      if (!playwrightLocator && shadowPiercePath) {
        playwrightLocator  = `page.locator('${escLit(shadowPiercePath)}')`;
        playwrightPriority = 'Shadow - Pierce path';
      }

      // The pierce path is reported alongside either way, as its own section in
      // the panel: it is the one form that says WHICH component the element is in.

      chrome.runtime.sendMessage({
        action: 'elementInspected',
        element: {
          tag:                 elem.tagName.toLowerCase(),
          text:                elem.textContent ? elem.textContent.trim().substring(0, 100) : '',
          name:                window.PalTechSelectors.getElementName(elem),
          alternativeSelectors,
          generalizedSelectors: [],
          playwrightLocator,
          playwrightPriority,
          shadowPiercePath     // null for regular elements, pierce path for shadow DOM
        }
      });
    } catch (err) {
      console.error('PalTech: failed to inspect element', err);
      chrome.runtime.sendMessage({
        action: 'elementInspected',
        element: {
          tag: elem.tagName ? elem.tagName.toLowerCase() : 'unknown',
          text: '', name: 'Inspection failed',
          alternativeSelectors: [], generalizedSelectors: [],
          playwrightLocator: '', playwrightPriority: 'N/A',
          shadowPiercePath: null,
          inspectError: 'Could not build selectors for this element: ' + (err && err.message ? err.message : String(err))
        }
      });
    }
  }

  // ── Public API ─────────────────────────────────────────────

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      stopInspectionMode();
      // Notify the side panel so the button label resets
      chrome.runtime.sendMessage({ action: 'inspectionStoppedByEscape' });
    }
  }

  function startInspectionMode() {
    stopInspectionMode(); // clean slate

    console.log('Starting inspection mode');
    state.active  = true;
    state.overlay = createInspectionOverlay();
    document.body.style.cursor = 'crosshair';

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('click', handleElementClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return true;
  }

  function stopInspectionMode() {
    if (!state.active) return false;

    console.log('Stopping inspection mode');
    state.active = false;
    document.body.style.cursor = '';

    if (state.overlay) {
      state.overlay.style.display = 'none';
    }
    if (state.tooltip) {
      state.tooltip.style.display = 'none';
    }

    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('click', handleElementClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    return true;
  }

  // 'pagehide', not 'unload': unload is deprecated and does not fire when the
  // page goes into the back/forward cache, which left the inspection tooltip
  // and its listeners in place on a page the tester had navigated away from.
  // content-script.js already cleans up this way.
  window.addEventListener('pagehide', () => {
    stopInspectionMode();
    const tip = document.querySelector('#selector-inspection-tooltip');
    if (tip) tip.remove();
  });

  window.PalTechInspection = { startInspectionMode, stopInspectionMode };

})();
