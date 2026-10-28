/**
 * playwright.js - Generates Playwright locators using a P1→P9 priority chain
 * Priority mirrors Playwright's official best-practice recommendations.
 */

(function () {

  // ---------- ARIA role map: HTML tag → implicit ARIA role ----------
  const IMPLICIT_ROLE_MAP = {
    a: 'link',
    button: 'button',
    summary: 'button',
    details: 'group',
    input: {
      checkbox: 'checkbox',
      radio: 'radio',
      range: 'slider',
      number: 'spinbutton',
      search: 'searchbox',
      email: 'textbox',
      tel: 'textbox',
      url: 'textbox',
      text: 'textbox',
      password: 'textbox',
      default: 'textbox'
    },
    select: 'combobox',
    textarea: 'textbox',
    img: 'img',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
    li: 'listitem',
    ul: 'list',
    ol: 'list',
    table: 'table',
    tr: 'row',
    th: 'columnheader',
    td: 'cell',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    aside: 'complementary',
    section: 'region',
    form: 'form',
    dialog: 'dialog',
    menuitem: 'menuitem',
    menu: 'menu',
    option: 'option',
    progressbar: 'progressbar',
    meter: 'meter'
  };

  // Test-id attribute names checked in priority order
  const TEST_ID_ATTRS = [
    'data-testid',
    'data-test',
    'data-cy',
    'data-automation-id',
    'data-qa'
  ];

  // ---------- Helpers ----------

  function getImplicitAriaRole(elem) {
    const tag = elem.tagName.toLowerCase();
    const roleEntry = IMPLICIT_ROLE_MAP[tag];
    if (!roleEntry) return null;
    if (typeof roleEntry === 'string') return roleEntry;
    // input sub-types
    const type = (elem.getAttribute('type') || 'text').toLowerCase();
    return roleEntry[type] || roleEntry.default || null;
  }

  function getAriaRole(elem) {
    return elem.getAttribute('role') || getImplicitAriaRole(elem);
  }

  /**
   * Derives the accessible name following ARIA spec order:
   * aria-label → aria-labelledby → inner text / value → title → placeholder
   */
  function getAccessibleName(elem) {
    // 1. aria-label
    const ariaLabel = (elem.getAttribute('aria-label') || '').trim();
    if (ariaLabel) return ariaLabel;

    // 2. aria-labelledby
    const labelledBy = elem.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      const parts = ids
        .map(id => {
          const el = document.getElementById(id);
          return el ? el.textContent.trim() : '';
        })
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    // 3. Visible text / value (for buttons, links, headings, etc.)
    const tag = elem.tagName.toLowerCase();
    const textTags = ['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'summary'];
    if (textTags.includes(tag)) {
      const text = (elem.textContent || '').trim();
      if (text) return text;
    }

    // input[type=submit|button|reset] value
    if (tag === 'input') {
      const inputType = (elem.getAttribute('type') || '').toLowerCase();
      if (['submit', 'button', 'reset'].includes(inputType)) {
        const val = (elem.getAttribute('value') || '').trim();
        if (val) return val;
      }
    }

    // 4. title
    const title = (elem.getAttribute('title') || '').trim();
    if (title) return title;

    // 5. placeholder (last resort for accessible name)
    const placeholder = (elem.getAttribute('placeholder') || '').trim();
    if (placeholder) return placeholder;

    return null;
  }

  /**
   * Finds the text of a <label> element associated with a form control.
   * Checks: wrapping label → label[for=id]
   */
  function getAssociatedLabel(elem) {
    // Wrapped in a <label>
    let parent = elem.parentElement;
    while (parent) {
      if (parent.tagName.toLowerCase() === 'label') {
        const text = (parent.textContent || '').trim();
        if (text) return text;
      }
      parent = parent.parentElement;
    }

    // label[for=id]
    if (elem.id) {
      const label = document.querySelector(`label[for="${CSS.escape(elem.id)}"]`);
      if (label) {
        const text = (label.textContent || '').trim();
        if (text) return text;
      }
    }

    // aria-label as stand-in label
    const ariaLabel = (elem.getAttribute('aria-label') || '').trim();
    if (ariaLabel) return ariaLabel;

    return null;
  }

  // ---------- Match counting ----------
  //
  // Counting is done from the RAW value, never by re-parsing the generated
  // locator string. The old implementation built e.g.
  //     page.getByText('Don\'t save')
  // and then matched it back with /^page\.getByText\('(.+)'\)$/ — which fails
  // on any value containing an escaped quote. Every P1-P7 candidate then scored
  // 0 matches and the element silently fell through to a fragile XPath.

  // Role lookups scan the whole document, and the multi-element scan asks for
  // hundreds of elements in a row, so cache the role -> elements map for the
  // duration of one scan. resetRoleCache() is called at the start of each scan;
  // the timestamp guard keeps the cache honest for one-off inspector clicks.
  let roleCache = new Map();
  let roleCacheStamp = 0;
  const ROLE_CACHE_TTL_MS = 2000;

  /**
   * The trimmed text of every leaf element, cached for the duration of a scan.
   *
   * WHY: countByText() below is asked about a different string for every
   * element a scan looks at, and it used to walk the entire DOM each time.
   * Collecting the leaf text once turns each of those walks into a pass over a
   * plain array of strings — no DOM access, no layout.
   */
  let leafTexts = null;
  let leafStamp = 0;

  function resetRoleCache() {
    leafTexts = null;
    leafStamp = 0;
    roleCache = new Map();
    roleCacheStamp = Date.now();
  }

  function elementsWithRole(role) {
    if (Date.now() - roleCacheStamp > ROLE_CACHE_TTL_MS) resetRoleCache();
    if (roleCache.has(role)) return roleCache.get(role);

    // Resolve the role of every element once (explicit role attribute wins,
    // otherwise the implicit role for the tag/type). This replaces the old
    // tag-guessing query, which appended `input:not([type])` for EVERY input
    // sub-type and so counted a bare <input> as a checkbox, radio and slider.
    const matches = [];
    const all = deepAll();
    for (let i = 0; i < all.length; i++) {
      if (getAriaRole(all[i]) === role) matches.push(all[i]);
    }
    roleCache.set(role, matches);
    return matches;
  }

  /**
   * Every element on the page, INCLUDING the contents of open shadow roots.
   *
   * Playwright's engines all pierce open shadow DOM: getByRole, getByText and
   * css= find a button inside a web component without being told about it. The
   * counts below decide whether a candidate locator is unique, so they have to
   * see the same elements Playwright will — counting only document content
   * scored every locator for a component's insides as "matches 0" and rejected
   * it, leaving a CSS path or XPath that cannot resolve at all.
   */
  function deepAll() {
    if (window.PalTechShadow) return window.PalTechShadow.queryAll('*', 20000);
    return Array.prototype.slice.call(document.querySelectorAll('*'));
  }

  /** querySelectorAll across document and open shadow roots, as a list. */
  function deepQueryAll(selector) {
    if (window.PalTechShadow) return window.PalTechShadow.queryAll(selector, 1000);
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  function safeCssCount(selector) {
    try {
      return deepQueryAll(selector).length;
    } catch (e) {
      return 0;
    }
  }

  function safeXpathCount(xpath) {
    try {
      return document.evaluate(
        xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
      ).snapshotLength;
    } catch (e) {
      return 0;
    }
  }

  // Escape a value for a double-quoted CSS attribute selector
  function attrValue(str) {
    return String(str == null ? '' : str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function countByAttr(attr, value) {
    return safeCssCount(`[${attr}="${attrValue(value)}"]`);
  }

  function countByTestId(value) {
    // A test id matches if ANY of the recognised test-id attributes carries it
    const seen = new Set();
    for (const attr of TEST_ID_ATTRS) {
      let nodes;
      try {
        nodes = deepQueryAll(`[${attr}="${attrValue(value)}"]`);
      } catch (e) {
        continue;
      }
      nodes.forEach(n => seen.add(n));
    }
    return seen.size;
  }

  function countByLabel(text) {
    const byAriaLabel = countByAttr('aria-label', text);
    if (byAriaLabel > 0) return byAriaLabel;

    let count = 0;
    deepQueryAll('input, select, textarea').forEach(el => {
      if (getAssociatedLabel(el) === text) count++;
    });
    return count;
  }

  function countByRole(role, name) {
    const candidates = elementsWithRole(role);
    if (!name) return candidates.length;
    let count = 0;
    for (const el of candidates) {
      if (getAccessibleName(el) === name) count++;
    }
    return count;
  }

  function allLeafTexts() {
    if (leafTexts && Date.now() - leafStamp <= ROLE_CACHE_TTL_MS) return leafTexts;
    const texts = [];
    const all = deepAll();
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.children.length > 0) continue;      // leaf nodes only
      const t = (el.textContent || '').trim();
      if (t) texts.push(t);
    }
    leafTexts = texts;
    leafStamp = Date.now();
    return leafTexts;
  }

  function countByText(text, exact) {
    const texts = allLeafTexts();
    let count = 0;
    for (let i = 0; i < texts.length; i++) {
      if (exact ? texts[i] === text : texts[i].includes(text)) count++;
    }
    return count;
  }

  // Escape a string for use inside single-quoted JS string literals in a locator
  function escLit(str) {
    return String(str == null ? '' : str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  // ---------- P1-P9 builder functions ----------
  //
  // Each builder returns { locator, priority, count } where `count` is the
  // number of elements on the page the locator resolves to. A candidate is
  // accepted only when count === 1.

  // P1: getByRole
  function buildGetByRole(elem) {
    const role = getAriaRole(elem);
    if (!role) return null;

    const name = getAccessibleName(elem);
    const locator = name
      ? `page.getByRole('${escLit(role)}', { name: '${escLit(name)}' })`
      : `page.getByRole('${escLit(role)}')`;

    return { locator, priority: 'P1 - getByRole', count: countByRole(role, name) };
  }

  // P2: getByTestId — a dedicated test id is the most stable thing on a page,
  // so it is tried before the text-derived locators below.
  function buildGetByTestId(elem) {
    for (const attr of TEST_ID_ATTRS) {
      const val = (elem.getAttribute(attr) || '').trim();
      if (val) {
        return {
          locator: `page.getByTestId('${escLit(val)}')`,
          priority: 'P2 - getByTestId',
          count: countByTestId(val)
        };
      }
    }
    return null;
  }

  // P3: getByLabel
  function buildGetByLabel(elem) {
    const tag = elem.tagName.toLowerCase();
    if (!['input', 'select', 'textarea'].includes(tag)) return null;
    const labelText = getAssociatedLabel(elem);
    if (!labelText) return null;
    return {
      locator: `page.getByLabel('${escLit(labelText)}')`,
      priority: 'P3 - getByLabel',
      count: countByLabel(labelText)
    };
  }

  // P4: getByPlaceholder
  function buildGetByPlaceholder(elem) {
    const tag = elem.tagName.toLowerCase();
    if (!['input', 'textarea'].includes(tag)) return null;
    const ph = (elem.getAttribute('placeholder') || '').trim();
    if (!ph) return null;
    return {
      locator: `page.getByPlaceholder('${escLit(ph)}')`,
      priority: 'P4 - getByPlaceholder',
      count: countByAttr('placeholder', ph)
    };
  }

  // P5: getByText
  function buildGetByText(elem) {
    const text = (elem.textContent || '').trim();
    if (!text || text.length > 200) return null;

    // Prefer exact match for short strings
    if (text.length <= 50) {
      return {
        locator: `page.getByText('${escLit(text)}', { exact: true })`,
        priority: 'P5 - getByText',
        count: countByText(text, true)
      };
    }
    const partial = text.substring(0, 50);
    return {
      locator: `page.getByText('${escLit(partial)}')`,
      priority: 'P5 - getByText',
      count: countByText(partial, false)
    };
  }

  // P6: getByAltText
  function buildGetByAltText(elem) {
    const alt = (elem.getAttribute('alt') || '').trim();
    if (!alt) return null;
    return {
      locator: `page.getByAltText('${escLit(alt)}')`,
      priority: 'P6 - getByAltText',
      count: countByAttr('alt', alt)
    };
  }

  // P7: getByTitle
  function buildGetByTitle(elem) {
    const title = (elem.getAttribute('title') || '').trim();
    if (!title) return null;
    return {
      locator: `page.getByTitle('${escLit(title)}')`,
      priority: 'P7 - getByTitle',
      count: countByAttr('title', title)
    };
  }

  // P8: CSS fallback
  function buildCssLocator(cssSelector) {
    if (!cssSelector) return null;
    return {
      // escLit() matters here: a CSS selector containing an apostrophe
      // (e.g. [title='Don't']) otherwise produced a locator string that is
      // not valid JavaScript when pasted into a test.
      locator: `page.locator('css=${escLit(cssSelector)}')`,
      priority: 'P8 - CSS locator',
      count: safeCssCount(cssSelector)
    };
  }

  // P9: XPath fallback
  function buildXpathLocator(xpath) {
    if (!xpath) return null;
    return {
      locator: `page.locator('xpath=${escLit(xpath)}')`,
      priority: 'P9 - XPath locator',
      count: safeXpathCount(xpath)
    };
  }

  // ---------- Master function ----------

  /**
   * A host-chain locator for an element inside a web component:
   *   page.locator('css=div#chat-host >> css=button.cw_btn')
   *
   * Only reached when the plain selector is not unique page-wide. Playwright's
   * css= engine pierces open roots on its own, so the chain is about
   * DISAMBIGUATION: it pins the element to the component it belongs to, which
   * is exactly what makes two identical-looking buttons in two instances of the
   * same component tellable apart.
   */
  function buildPierceLocator(elem, cssSelector) {
    if (!window.PalTechShadow || !window.PalTechShadow.inShadow(elem)) return null;

    const hosts = window.PalTechShadow.hostChain(elem);
    if (!hosts.length) return null;

    const parts = [];
    for (const host of hosts) {
      const sel = getCssSelectorFor(host);
      if (!sel) return null;
      parts.push('css=' + sel);
    }
    // Inside its own root the element already has a selector that resolves
    // there — that is what selectors.js guarantees.
    if (!cssSelector) return null;
    parts.push('css=' + cssSelector);

    const path = parts.join(' >> ');
    return {
      locator: `page.locator('${escLit(path)}')`,
      priority: 'P8 - CSS locator (shadow DOM)',
      // Constructed to be unique: every host in the chain is addressed
      // individually, and the last step is unique inside that host's root.
      count: 1
    };
  }

  /** The CSS selector selectors.js would build for a node. */
  function getCssSelectorFor(node) {
    try {
      return (window.PalTechSelectors && window.PalTechSelectors.getCssSelector)
        ? window.PalTechSelectors.getCssSelector(node)
        : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Returns the best Playwright locator for elem by walking P1->P9.
   * Each candidate is accepted only if exactly one element matches.
   * @param {Element} elem
   * @param {string} cssSelector - pre-computed CSS selector (from selectors.js)
   * @param {string} xpath       - pre-computed XPath (from selectors.js)
   * @returns {{ locator: string, priority: string }}
   */
  function getPlaywrightLocator(elem, cssSelector, xpath) {
    const builders = [
      () => buildGetByRole(elem),
      () => buildGetByTestId(elem),
      () => buildGetByLabel(elem),
      () => buildGetByPlaceholder(elem),
      () => buildGetByText(elem),
      () => buildGetByAltText(elem),
      () => buildGetByTitle(elem),
      () => buildCssLocator(cssSelector),
      () => buildPierceLocator(elem, cssSelector),
      () => buildXpathLocator(xpath)
    ];

    for (const build of builders) {
      try {
        const candidate = build();
        if (!candidate) continue;
        if (candidate.count === 1) {
          return { locator: candidate.locator, priority: candidate.priority };
        }
      } catch (e) {
        // builder threw - try next
      }
    }

    // Ultimate fallback: return the raw fallbacks even if not unique.
    // For an element inside a web component the host chain comes first — a bare
    // selector may be ambiguous, but an XPath is not merely ambiguous there, it
    // cannot resolve at all.
    const pierced = buildPierceLocator(elem, cssSelector);
    if (pierced) return { locator: pierced.locator, priority: pierced.priority };

    if (xpath) {
      return { locator: `page.locator('xpath=${escLit(xpath)}')`, priority: 'P9 - XPath locator' };
    }
    if (cssSelector) {
      return { locator: `page.locator('css=${escLit(cssSelector)}')`, priority: 'P8 - CSS locator' };
    }

    return { locator: '', priority: 'N/A' };
  }

  // Expose
  window.PalTechPlaywright = {
    getPlaywrightLocator,
    resetRoleCache,
    // Exported so no other module has to reinvent it: the iframe path in
    // inspection.js was interpolating page text into locators unescaped.
    escLit,
    attrValue
  };

})();
