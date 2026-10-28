/**
 * selectors.js - Functions for generating and working with various selectors (XPath, CSS, jQuery)
 *
 * Wrapped in an IIFE with a re-injection guard, like every other content
 * script. Content scripts share the isolated world's global scope, so any
 * top-level const/let/class here throws "Identifier 'X' has already been
 * declared" the second time the file is injected — and it does get injected
 * twice: the manifest at document_idle, the side panel when its ping finds
 * nothing, the service worker after a navigation while recording.
 *
 * The body keeps its original indentation; re-indenting the whole file would
 * bury every real change in it.
 */
(function () {

if (window.PalTechSelectors) return;   // already evaluated on this page

/**
 * Safely reads an element's class list.
 * SVG elements expose `className` as an SVGAnimatedString object (not a string),
 * so calling .trim()/.split() on it throws a TypeError. Always go through here.
 * @param {Element} elem
 * @returns {string[]} array of class names (empty when the element has none)
 */
function getClassNames(elem) {
  if (!elem) return [];
  let cls = elem.className;
  if (cls && typeof cls === 'object') {
    // SVGAnimatedString (SVG elements) exposes the literal value on .baseVal
    cls = typeof cls.baseVal === 'string' ? cls.baseVal : '';
  }
  if (typeof cls !== 'string') {
    cls = (elem.getAttribute && elem.getAttribute('class')) || '';
  }
  return String(cls).trim().split(/\s+/).filter(Boolean);
}

/**
 * Escapes a string for use as a CSS identifier (id or class name).
 * Modern class systems (Tailwind: "md:flex", "w-1/2") and auto-generated ids
 * contain characters that are syntax errors in a raw CSS selector.
 * @param {string} str
 * @returns {string}
 */
function cssEscapeIdent(str) {
  const s = String(str == null ? '' : str);
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  // Fallback for environments without CSS.escape
  return s.replace(/([^\w-]|^(?=\d))/g, '\\$&');
}

/**
 * Escapes a string for use inside a double-quoted CSS attribute selector value.
 * @param {string} str
 * @returns {string}
 */
function cssEscapeAttrValue(str) {
  return String(str == null ? '' : str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Returns true when `selector` is a syntactically valid CSS selector.
 * Used to make sure we never hand an unparseable selector to querySelectorAll()
 * (which throws) or to the side panel (where it would silently fail to match).
 * @param {string} selector
 * @returns {boolean}
 */
function isValidCssSelector(selector) {
  if (!selector || typeof selector !== 'string') return false;
  try {
    document.querySelector(selector);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * How many elements a selector matches — 0 instead of throwing when the
 * selector is invalid.
 *
 * Counted across the document AND every open shadow root, which is how
 * Playwright's css= engine counts: it pierces open roots. Counting with
 * document.querySelectorAll alone returned 0 for everything inside a web
 * component, so a perfectly good selector for a button in a component was
 * judged to match nothing and thrown away in favour of a longer path that
 * matched nothing either.
 *
 * @param {string} selector
 * @returns {number}
 */
function safeCssCount(selector) {
  if (!selector) return 0;
  try {
    if (window.PalTechShadow) return window.PalTechShadow.count(selector);
    return document.querySelectorAll(selector).length;
  } catch (e) {
    return 0;
  }
}

function escapeXpathString(stringLiterals) {
    /**
     * Escapes quotes for XPath string literals, avoids HTML entity escaping
     */
    if (!stringLiterals) return "''"; // Handle null/undefined values
    
    const str = String(stringLiterals); // Ensure we're working with a string
    
    if (!str.includes("'")) {
      return `'${str}'`;
    } else if (!str.includes('"')) {
      return `"${str}"`;
    } else {
      // Split the string and use concat() in XPath
      const parts = str.split("'");
      return "concat(" + parts.map(part => `'${part}'`).join(", \"'\", ") + ")";
    }
  }
  
  function getRelativeXpath(elem, doc = document) {
    if (!elem || !elem.tagName) return null;

    // XPath cannot address shadow DOM. There is no axis that crosses a shadow
    // boundary, document.evaluate never descends into a root, and Playwright's
    // xpath= engine does not pierce either — so any expression produced for an
    // element inside a web component is a locator that can never resolve.
    // Returning nothing keeps it out of the priority ladder, which then picks a
    // role, text or piercing-CSS locator that does work.
    if (window.PalTechShadow && window.PalTechShadow.inShadow(elem)) return null;

    const tag = elem.tagName.toLowerCase();
  
    // Validate uniqueness of XPath.
    // Strictly unique means: exactly one node matches, and it is our element.
    // Anything looser produces a locator that silently resolves to the wrong
    // element, and Playwright's strict mode rejects it outright.
    function isUnique(xpath) {
      try {
        const result = doc.evaluate(xpath, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return result.snapshotLength === 1 && result.snapshotItem(0) === elem;
      } catch (e) {
        // Malformed or unsupported XPath — never treat it as usable
        console.debug("XPath evaluation note:", e.message);
        return false;
      }
    }
  
    // Strategy 1: ID (always highest priority)
    if (elem.id) {
      const xpath = `//${tag}[@id=${escapeXpathString(elem.id)}]`;
      if (isUnique(xpath)) return xpath;
      
      // Try more generic ID selector as fallback
      const idXpath = `//*[@id=${escapeXpathString(elem.id)}]`;
      if (isUnique(idXpath)) return idXpath;
    }
  
    // Strategy 2: Priority attributes - enhanced list
    const priorityAttrs = [
      // Test automation attributes first
      'data-testid', 'data-test', 'data-cy', 'data-automation-id', 'data-qa',
      // Standard attributes
      'name', 'aria-label', 'aria-labelledby', 'title', 'placeholder',
      'for', 'type', 'value', 'href', 'src', 'alt', 'role'
    ];
  
    // Check for data-* attributes not already in priorityAttrs
    const dataAttrs = [];
    for (let i = 0; i < elem.attributes.length; i++) {
      const attr = elem.attributes[i].name;
      if (attr.startsWith('data-') && !priorityAttrs.includes(attr)) {
        dataAttrs.push(attr);
      }
    }
    
    // Combine standard priority attributes with any found data attributes
    const allPriorityAttrs = [...priorityAttrs, ...dataAttrs];
  
    // Try each attribute
    for (const attr of allPriorityAttrs) {
      if (elem.hasAttribute(attr)) {
        const val = elem.getAttribute(attr).trim();
        if (val) {
          const isUrl = ['href', 'src'].includes(attr);
          const shortVal = isUrl ? val.split('?')[0] : val.substring(0, 20);
          
          // Try exact match first
          if (!isUrl && val.length <= 40) {
            const exactXpath = `//${tag}[@${attr}=${escapeXpathString(val)}]`;
            if (isUnique(exactXpath)) return exactXpath;
          }
          
          // Try contains as fallback
          const xpath = `//${tag}[contains(@${attr}, ${escapeXpathString(shortVal)})]`;
          if (isUnique(xpath)) return xpath;

          // Try combining the attribute with a sibling attribute for more specificity.
          // NOTE: @tagName was removed — it is a JS DOM property, not an HTML attribute,
          // so that XPath condition never matched any element and was dead code.
          for (const sibAttr of ['name', 'type', 'role', 'aria-label']) {
            if (sibAttr !== attr && elem.hasAttribute(sibAttr)) {
              const sibVal = elem.getAttribute(sibAttr).trim();
              if (sibVal) {
                const combinedXpath = `//${tag}[@${attr}=${escapeXpathString(val)} and @${sibAttr}=${escapeXpathString(sibVal)}]`;
                if (isUnique(combinedXpath)) return combinedXpath;
              }
            }
          }
        }
      }
    }
  
    // Strategy 3: Specific classes (enhanced to check multiple class combinations)
    {
      const ignored = ['active', 'hidden', 'show', 'btn', 'container', 'row', 'col', 'form', 'disabled'];
      const classes = getClassNames(elem).filter(c => !ignored.includes(c)).sort((a, b) => b.length - a.length);
      
      // Try single class first
      for (const cls of classes) {
        const xpath = `//${tag}[contains(@class, ${escapeXpathString(cls)})]`;
        if (isUnique(xpath)) return xpath;
      }
      
      // Try combinations of two classes if we have multiple classes
      if (classes.length > 1) {
        for (let i = 0; i < classes.length - 1; i++) {
          for (let j = i + 1; j < classes.length; j++) {
            const xpath = `//${tag}[contains(@class, ${escapeXpathString(classes[i])}) and contains(@class, ${escapeXpathString(classes[j])})]`;
            if (isUnique(xpath)) return xpath;
          }
        }
      }
    }
  
    // Strategy 4: Text content (enhanced to handle different text scenarios)
    const text = elem.textContent?.trim();
    const textTags = ['a', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'p', 'span', 'li', 'th', 'td', 'div'];
    
    if (text && textTags.includes(tag)) {
      // For very short text, use exact match
      if (text.length <= 20) {
        const exactTextXpath = `//${tag}[normalize-space(.)=${escapeXpathString(text)}]`;
        if (isUnique(exactTextXpath)) return exactTextXpath;
      }
      
      // For medium-length text, use contains with the first portion
      if (text.length > 20 && text.length <= 100) {
        const shortText = text.substring(0, 20).trim();
        const containsXpath = `//${tag}[contains(normalize-space(.), ${escapeXpathString(shortText)})]`;
        if (isUnique(containsXpath)) return containsXpath;
      }
      
      // For long text, use starts-with
      if (text.length > 100) {
        const startText = text.substring(0, 30).trim();
        const startsWithXpath = `//${tag}[starts-with(normalize-space(.), ${escapeXpathString(startText)})]`;
        if (isUnique(startsWithXpath)) return startsWithXpath;
      }
      
      // Try text + attribute combination for better uniqueness
      for (const attr of ['name', 'class', 'type', 'role']) {
        if (elem.hasAttribute(attr)) {
          const val = elem.getAttribute(attr);
          if (val) {
            const shortText = text.length > 30 ? text.substring(0, 30) : text;
            const comboXpath = `//${tag}[contains(normalize-space(.), ${escapeXpathString(shortText)}) and @${attr}=${escapeXpathString(val)}]`;
            if (isUnique(comboXpath)) return comboXpath;
          }
        }
      }
    }
  
    // Strategy 5: Enhanced Parent context with multiple levels
    if (elem.parentElement) {
      // Try immediate parent first
      const parent = elem.parentElement;
      const parentTag = parent.tagName.toLowerCase();

      // Collect every plausible way of addressing the parent, then verify the
      // full path. Previously the first plausible parent expression was used
      // and the resulting path was returned WITHOUT any uniqueness check, so
      // `//form/input` was handed out on pages with three forms.
      const parentCandidates = [];

      if (parent.id) {
        parentCandidates.push(`//${parentTag}[@id=${escapeXpathString(parent.id)}]`);
        parentCandidates.push(`//*[@id=${escapeXpathString(parent.id)}]`);
      }
      if (parent.hasAttribute('data-testid')) {
        parentCandidates.push(
          `//${parentTag}[@data-testid=${escapeXpathString(parent.getAttribute('data-testid'))}]`
        );
      }
      if (!['div', 'span'].includes(parentTag)) {
        parentCandidates.push(`//${parentTag}`);
        const parentSiblings = Array.from(parent.parentElement?.children || [])
          .filter(e => e.tagName.toLowerCase() === parentTag);
        const parentIdx = parentSiblings.indexOf(parent) + 1;
        if (parentIdx > 0) parentCandidates.push(`(//${parentTag})[${parentIdx}]`);
      }
      for (const cls of getClassNames(parent)) {
        if (!['container', 'row', 'col', 'wrapper'].includes(cls)) {
          parentCandidates.push(`//${parentTag}[contains(@class, ${escapeXpathString(cls)})]`);
        }
      }
      if (parent.parentElement && parent.parentElement.id) {
        const gpTag = parent.parentElement.tagName.toLowerCase();
        parentCandidates.push(
          `//${gpTag}[@id=${escapeXpathString(parent.parentElement.id)}]/${parentTag}`
        );
      }

      // Ways of addressing the element inside its parent, most stable first
      const siblings = Array.from(parent.children).filter(e => e.tagName.toLowerCase() === tag);
      const idx = siblings.indexOf(elem) + 1;
      const thisText = elem.textContent?.trim();

      const childSuffixes = [];
      if (elem.id) childSuffixes.push(`/${tag}[@id=${escapeXpathString(elem.id)}]`);
      if (thisText && thisText.length < 50 && textTags.includes(tag)) {
        childSuffixes.push(
          `/${tag}[contains(normalize-space(.), ${escapeXpathString(thisText.substring(0, 30))})]`
        );
      }
      if (siblings.length === 1) childSuffixes.push(`/${tag}`);
      if (idx > 0) childSuffixes.push(`/${tag}[${idx}]`);

      for (const parentXpath of parentCandidates) {
        for (const suffix of childSuffixes) {
          const candidate = parentXpath + suffix;
          if (isUnique(candidate)) return candidate;
        }
      }
    }

    // Strategy 6: Try a combination of attributes for better uniqueness
    const attrCombos = [
      ['type', 'name'],
      ['type', 'class'],
      ['class', 'name'],
      ['placeholder', 'class'],
      ['role', 'class']
    ];
    
    for (const [attr1, attr2] of attrCombos) {
      if (elem.hasAttribute(attr1) && elem.hasAttribute(attr2)) {
        const val1 = elem.getAttribute(attr1).trim();
        const val2 = elem.getAttribute(attr2).trim();
        
        if (val1 && val2) {
          const comboXpath = `//${tag}[@${attr1}=${escapeXpathString(val1)} and @${attr2}=${escapeXpathString(val2)}]`;
          if (isUnique(comboXpath)) return comboXpath;
        }
      }
    }
  
    // Fallback: Index-based with improved robustness
    try {
      // Try to add some context when using index-based approach
      const parent = elem.parentElement;
      if (parent) {
        const parentTag = parent.parentElement?.tagName.toLowerCase() || 'body';
        const siblingsWithSameTag = Array.from(parent.children).filter(e => e.tagName.toLowerCase() === tag);
        
        if (siblingsWithSameTag.length < 10) {  // Only use if there aren't too many siblings
          const idx = siblingsWithSameTag.indexOf(elem) + 1;
          const contextXpath = `//${parentTag}//${tag}[${idx}]`;
          if (isUnique(contextXpath)) return contextXpath;
        }
      }
      
      // Final fallback - global index
      const allElems = Array.from(doc.getElementsByTagName(tag));
      const idx = allElems.indexOf(elem) + 1;
      return `(//${tag})[${idx}]`;
    } catch (e) {
      console.error("Error creating index-based XPath:", e);
      return `//${tag}`; // Ultimate fallback
    }
  }
  
  function getElementName(elem) {
    // Check if the element appears to be a span with a class attribute
    if (elem.tagName?.toLowerCase() === 'span' && elem.hasAttribute('class')) {
      // Generate a better name specific for spans with classes
      const className = elem.getAttribute('class');
      if (className) {
        // Handle the class attribute specially
        const cleanClassName = className.replace(/^class=["']|["']$/g, '').trim();
        const firstClass = cleanClassName.split(/\s+/)[0];
        if (firstClass) {
          // Convert the class name to a nice span name
          const spanName = window.PalTechNaming ? 
            window.PalTechNaming.generateElementName(elem) : 
            `${firstClass}Span`;
          
          // Use our enhanced naming if available
          return spanName;
        }
      }
    }
    
    // Use the new improved element naming logic from elementNaming.js
    return window.PalTechNaming ? window.PalTechNaming.generateElementName(elem) : getLegacyElementName(elem);
  }
  
  // Keep the old implementation as a fallback
  function getLegacyElementName(elem) {
    if (!elem || !elem.tagName) return "Unknown Element";
    
    const tag = elem.tagName.toLowerCase();
    const text = elem.textContent ? elem.textContent.trim() : "";
  
    const tagName = tag === 'a' 
      ? 'Link' 
      : /^h[1-6]$/.test(tag) 
        ? 'Heading' 
        : tag.charAt(0).toUpperCase() + tag.slice(1);
  
    const attrs = ['placeholder', 'aria-label', 'name', 'value', 'id'];
    for (const attr of attrs) {
      if (elem.hasAttribute(attr) && elem.getAttribute(attr)) {
        const attrValue = elem.getAttribute(attr).trim();
        if (attrValue) {
          return `${attrValue} ${tagName}`;
        }
      }
    }
  
    if (text) {
      // Limit text length for readability
      const shortText = text.length > 30 ? text.substring(0, 27) + '...' : text;
      return `${shortText} ${tagName}`;
    }
  
    const className = elem.getAttribute('class')?.split(' ')[0];
    if (className) {
      return `${className} ${tagName}`;
    }
  
    return tagName;
  }
  
  /**
   * Builds the most specific valid CSS selector for an element.
   *
   * Every candidate is escaped with cssEscapeIdent() and validated before use,
   * so class names from modern frameworks (Tailwind "md:flex", "w-1/2") and
   * auto-generated ids that start with a digit can never produce a selector
   * that throws in querySelectorAll().
   *
   * Guarantees: the returned string is either '' or a syntactically valid CSS
   * selector that matches the element.
   */
  function getCssSelector(elem) {
    if (!elem || !elem.tagName) return "";

    const tag = elem.tagName.toLowerCase();

    // The scope a selector for this element has to be resolved in: its own
    // shadow root when it lives in a web component, otherwise the document.
    // Searching the document for an element inside a component finds nothing,
    // so every candidate below used to be rejected and the walk fell through to
    // a long path that matched nothing either.
    const scope = window.PalTechShadow ? window.PalTechShadow.rootOf(elem) : document;

    // Returns the candidate when it is valid AND uniquely matches elem
    function tryUnique(selector) {
      if (!selector) return null;
      try {
        const matches = scope.querySelectorAll(selector);
        if (matches.length === 1 && matches[0] === elem) return selector;
      } catch (e) {
        // invalid selector — ignore this candidate
      }
      return null;
    }

    // 1. ID (most efficient) — escaped, and verified to actually be unique.
    //    Duplicate ids are common in generated markup, so never assume.
    if (elem.id) {
      const hit = tryUnique(`#${cssEscapeIdent(elem.id)}`) ||
                  tryUnique(`${tag}#${cssEscapeIdent(elem.id)}`);
      if (hit) return hit;
    }

    // 2. A unique attribute
    const uniqueAttributes = [
      'data-testid', 'data-test', 'data-cy', 'data-automation-id', 'data-qa',
      'name', 'aria-label', 'title', 'alt', 'placeholder', 'role'
    ];
    for (const attr of uniqueAttributes) {
      if (!elem.hasAttribute(attr)) continue;
      const value = elem.getAttribute(attr);
      if (!value) continue;
      const escaped = cssEscapeAttrValue(value);
      const hit = tryUnique(`[${attr}="${escaped}"]`) ||
                  tryUnique(`${tag}[${attr}="${escaped}"]`);
      if (hit) return hit;
    }

    // 3. tag + class combinations (1, then 2, then 3 classes)
    const classNames = getClassNames(elem).map(cssEscapeIdent);

    for (const cls of classNames) {
      const hit = tryUnique(`${tag}.${cls}`);
      if (hit) return hit;
    }
    for (let i = 0; i < classNames.length; i++) {
      for (let j = i + 1; j < classNames.length; j++) {
        const hit = tryUnique(`${tag}.${classNames[i]}.${classNames[j]}`);
        if (hit) return hit;
        for (let k = j + 1; k < classNames.length; k++) {
          const hit3 = tryUnique(`${tag}.${classNames[i]}.${classNames[j]}.${classNames[k]}`);
          if (hit3) return hit3;
        }
      }
    }

    // 4. Walk up the tree building a descendant path, stopping as soon as the
    //    accumulated path is unique. Each level is escaped and index-qualified
    //    only when it has same-tag siblings.
    function levelSelector(node) {
      let sel = node.tagName.toLowerCase();
      if (node.id) {
        const withId = `${sel}#${cssEscapeIdent(node.id)}`;
        // Only use the id if it is actually unique where it will be resolved
        try {
          if (scope.querySelectorAll(`#${cssEscapeIdent(node.id)}`).length === 1) {
            return { selector: withId, anchored: true };
          }
        } catch (e) { /* fall through to class/index form */ }
      }
      const cls = getClassNames(node).map(cssEscapeIdent).slice(0, 2);
      if (cls.length) sel += '.' + cls.join('.');

      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children)
          .filter(el => el.tagName === node.tagName);
        if (siblings.length > 1) {
          sel += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      return { selector: sel, anchored: false };
    }

    const path = [];
    let current = elem;
    let depth = 0;
    while (current && current.nodeType === 1 &&
           current.tagName !== 'HTML' && current.tagName !== 'BODY' && depth < 6) {
      const level = levelSelector(current);
      path.unshift(level.selector);

      const candidate = path.join(' > ');
      const hit = tryUnique(candidate);
      if (hit) return hit;

      // An id-anchored ancestor is as far up as we ever need to go
      if (level.anchored) break;

      current = current.parentElement;
      depth++;
    }

    // 5. Last resort: the accumulated path, or a positional selector.
    //    Only return something querySelectorAll() can actually parse.
    const built = path.join(' > ');
    if (isValidCssSelector(built) && built) return built;

    const parent = elem.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(el => el.tagName === elem.tagName);
      const idx = siblings.indexOf(elem) + 1;
      const fallback = `${tag}:nth-of-type(${idx})`;
      if (isValidCssSelector(fallback)) return fallback;
    }
    return tag;
  }

  /**
   * Wraps a CSS selector as a jQuery call.
   * jQuery uses CSS syntax, so the only work is quoting: attribute selectors
   * contain double quotes ([title="Save"]) which have to be escaped or the
   * emitted snippet is not valid JavaScript.
   */
  function getJQuerySelector(elem) {
    try {
      const cssSelector = getCssSelector(elem);
      if (!cssSelector) return `$("${elem.tagName.toLowerCase()}")`;
      return `$("${cssSelector.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
    } catch (e) {
      console.error("Error generating jQuery selector:", e);
      return `$("${elem.tagName.toLowerCase()}")`;
    }
  }
  
  function getJQueryCount(selector) {
    try {
      // Extract the actual selector from the jQuery string, undoing the
      // escaping applied by getJQuerySelector()
      const match = selector.match(/^\$\("([\s\S]*)"\)$/);
      if (match) {
        const cssSelector = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        return safeCssCount(cssSelector);
      }
      return 0;
    } catch (e) {
      console.error("Error evaluating jQuery selector:", e);
      return 0;
    }
  }
  
  function getXPathCount(xpath) {
    try {
      // Handle empty or invalid XPath
      if (!xpath || typeof xpath !== 'string') return 0;
      
      // Normalize XPath to remove common syntax issues
      let normalizedXpath = xpath.trim();
      
      // Remove potentially problematic parts in a way that doesn't affect the essentials
      if (normalizedXpath.includes(' and @tagName=')) {
        normalizedXpath = normalizedXpath.replace(/ and @tagName=['"][^'"]+['"]/, '');
      }
      
      // Handle potentially tricky XPaths that use concat() functions
      if (normalizedXpath.includes('concat(')) {
        // Try a simplified version without concat if it's too complex
        try {
          const result = document.evaluate(
            normalizedXpath, 
            document, 
            null, 
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, 
            null
          );
          return result.snapshotLength;
        } catch (concatError) {
          // Fall back to a tag-only version
          const tagMatch = normalizedXpath.match(/\/\/(\w+)/);
          if (tagMatch && tagMatch[1]) {
            const tagOnlyXpath = `//${tagMatch[1]}`;
            console.debug(`Simplifying complex XPath: ${xpath} -> ${tagOnlyXpath}`);
            
            const tagResult = document.evaluate(
              tagOnlyXpath, 
              document, 
              null, 
              XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, 
              null
            );
            // Return a high number to indicate this is not precise but an approximation
            return tagResult.snapshotLength > 0 ? tagResult.snapshotLength : 0;
          }
        }
      }
      
      // Standard evaluation attempt
      const result = document.evaluate(
        normalizedXpath, 
        document, 
        null, 
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, 
        null
      );
      return result.snapshotLength;
    } catch (e) {
      console.debug("XPath count evaluation note:", e.message, "for XPath:", xpath);
      
      // Try to extract the tag for a fallback count
      try {
        const tagMatch = xpath.match(/\/\/(\w+)/);
        if (tagMatch && tagMatch[1]) {
          const tagOnlyXpath = `//${tagMatch[1]}`;
          const tagResult = document.evaluate(
            tagOnlyXpath, 
            document, 
            null, 
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, 
            null
          );
          // Return a high number to indicate this is not precise but an approximation
          return tagResult.snapshotLength > 0 ? Math.min(tagResult.snapshotLength, 99) : 0;
        }
      } catch (fallbackError) {
        // Truly cannot evaluate
      }
      
      return 0;
    }
  }
  
  /**
   * Enhanced alternative selectors generation to ensure complete coverage
   * Returns selectors of all types for any element
   */
  function getAlternativeSelectors(elem) {
    if (!elem || !elem.tagName) return [];
    
    const selectors = [];
    const seen = new Set(); // Track already added selectors to avoid duplicates
    
    // Helper function to add unique selectors
    function addUniqueSelector(selector, type, count, error = false) {
      if (!seen.has(selector)) {
        seen.add(selector);
        selectors.push({ 
          count: count, 
          selector: selector, 
          type: type,
          error: error
        });
        return true;
      }
      return false;
    }
    
    // Helper function to check selector uniqueness and add it
    function isUnique(selector, type) {
      try {
        const result = type === 'xpath' 
          ? document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength
          : document.querySelectorAll(selector).length;
        addUniqueSelector(selector, type, result);
        return { count: result, selector: selector, type: type };
      } catch (e) {
        console.error(`Error evaluating selector: ${selector}`, e);
        addUniqueSelector(selector, type, 0, true);
        return { count: 0, selector: selector, type: type, error: true };
      }
    }
    
    // Get basic information about the element
    const tag = elem.tagName.toLowerCase();
    const id = elem.id;
    const classes = getClassNames(elem);
    
    // -------------- XPATH SELECTORS --------------
    // All values go through escapeXpathString() — a raw apostrophe in an
    // attribute value or text node otherwise produces an unparseable XPath.

    // 1. Generate tag-based XPath (always available)
    isUnique(`//${tag}`, 'xpath');

    // 2. ID-based XPath (if available)
    if (id) {
      isUnique(`//${tag}[@id=${escapeXpathString(id)}]`, 'xpath');
      isUnique(`//*[@id=${escapeXpathString(id)}]`, 'xpath');
    }

    // 3. Class-based XPath
    if (classes.length > 0) {
      classes.forEach(cls => {
        isUnique(`//${tag}[contains(@class, ${escapeXpathString(cls)})]`, 'xpath');
      });

      // Combined class XPath if multiple classes
      if (classes.length > 1) {
        const classConditions = classes
          .map(cls => `contains(@class, ${escapeXpathString(cls)})`)
          .join(' and ');
        isUnique(`//${tag}[${classConditions}]`, 'xpath');
      }
    }

    // 4. Attribute-based XPath for various attributes
    const attributes = ['name', 'placeholder', 'title', 'alt', 'href', 'src', 'role', 'aria-label', 'type', 'value'];
    attributes.forEach(attr => {
      if (elem.hasAttribute(attr)) {
        const val = elem.getAttribute(attr);
        if (val && val.trim()) {
          isUnique(`//${tag}[@${attr}=${escapeXpathString(val)}]`, 'xpath');
        }
      }
    });

    // 5. Position-based XPath.
    //    NOTE: `//button[2]` means "every button that is the 2nd button child of
    //    its own parent" — NOT "the 2nd button on the page". The parenthesised
    //    form `(//button)[2]` is the one that indexes the flat document order.
    try {
      const parentNode = elem.parentNode;
      const siblings = parentNode
        ? Array.from(parentNode.children).filter(child => child.tagName.toLowerCase() === tag)
        : [];
      const siblingPosition = siblings.indexOf(elem) + 1;

      // Document-order index (the meaning users actually expect)
      const docIndex = Array.from(document.getElementsByTagName(tag)).indexOf(elem) + 1;
      if (docIndex > 0) {
        isUnique(`(//${tag})[${docIndex}]`, 'xpath');
      }

      // Sibling index scoped to the parent tag
      if (siblingPosition > 0 && parentNode && parentNode.tagName) {
        const parentTag = parentNode.tagName.toLowerCase();
        isUnique(`//${parentTag}/${tag}[${siblingPosition}]`, 'xpath');
      }
    } catch (e) {
      console.error("Error creating position-based XPath:", e);
    }

    // 6. Text-based XPath if element has text content
    const text = elem.textContent?.trim();
    if (text && text.length < 100) {
      isUnique(`//${tag}[normalize-space(text())=${escapeXpathString(text)}]`, 'xpath');
      isUnique(`//${tag}[contains(text(), ${escapeXpathString(text.substring(0, 30))})]`, 'xpath');
    }

    // 7. Relative XPath (typically most reliable)
    const relativeXpath = getRelativeXpath(elem);
    if (relativeXpath) {
      addUniqueSelector(relativeXpath, 'xpath', getXPathCount(relativeXpath));
    }

    // -------------- CSS SELECTORS --------------
    // Identifiers go through cssEscapeIdent() and values through
    // cssEscapeAttrValue(), so Tailwind-style classes ("md:flex", "w-1/2")
    // and numeric ids can never produce a selector that throws.

    // 1. Basic tag selector (always available)
    isUnique(tag, 'css');

    // 2. ID-based CSS (if available)
    if (id) {
      isUnique(`#${cssEscapeIdent(id)}`, 'css');
      isUnique(`${tag}#${cssEscapeIdent(id)}`, 'css');
    }

    // 3. Class-based CSS
    const escapedClasses = classes.map(cssEscapeIdent);
    if (escapedClasses.length > 0) {
      // Single class
      escapedClasses.forEach(cls => {
        isUnique(`.${cls}`, 'css');
        isUnique(`${tag}.${cls}`, 'css');
      });

      // Combinations of classes (up to 3)
      if (escapedClasses.length > 1) {
        for (let i = 0; i < escapedClasses.length - 1 && i < 2; i++) {
          for (let j = i + 1; j < escapedClasses.length && j < i + 3; j++) {
            isUnique(`${tag}.${escapedClasses[i]}.${escapedClasses[j]}`, 'css');
          }
        }
      }
    }

    // 4. Attribute-based CSS
    attributes.forEach(attr => {
      if (elem.hasAttribute(attr)) {
        const val = elem.getAttribute(attr);
        if (val && val.trim()) {
          const escaped = cssEscapeAttrValue(val);
          isUnique(`${tag}[${attr}="${escaped}"]`, 'css');
          isUnique(`[${attr}="${escaped}"]`, 'css');
        }
      }
    });

    // 5. Position-based CSS (nth-of-type)
    try {
      const parentNode = elem.parentNode;
      const siblings = parentNode
        ? Array.from(parentNode.children).filter(child => child.tagName.toLowerCase() === tag)
        : [];
      const position = siblings.indexOf(elem) + 1;

      if (position > 0) {
        isUnique(`${tag}:nth-of-type(${position})`, 'css');

        // With parent context for better specificity
        if (parentNode && parentNode.tagName) {
          const parentTag = parentNode.tagName.toLowerCase();
          isUnique(`${parentTag} > ${tag}:nth-of-type(${position})`, 'css');
        }
      }
    } catch (e) {
      console.error("Error creating position-based CSS:", e);
    }

    // 6. Parent-child CSS
    try {
      let current = elem;
      let parents = [];
      let depth = 0;

      // Traverse up to 3 levels of parents for context
      while (current.parentElement && depth < 3) {
        const parent = current.parentElement;
        parents.unshift(parent.tagName.toLowerCase());
        current = parent;
        depth++;
      }

      if (parents.length > 0) {
        isUnique(`${parents.join(' > ')} > ${tag}`, 'css');
      }
    } catch (e) {
      console.error("Error creating parent-child CSS:", e);
    }

    // -------------- JQUERY SELECTORS --------------

    // Convert CSS selectors to jQuery format (only the valid, non-erroring ones)
    const cssSelectors = selectors.filter(sel => sel.type === 'css' && !sel.error);

    // Ensure we have at least some jQuery selectors
    if (cssSelectors.length > 0) {
      // Convert top 5 most specific CSS selectors to jQuery
      cssSelectors
        .slice()
        .sort((a, b) => a.count - b.count)
        .slice(0, 5)
        .forEach(sel => {
          const jquerySelector = `$("${sel.selector.replace(/"/g, '\\"')}")`;
          addUniqueSelector(jquerySelector, 'jquery', sel.count);
        });
    } else {
      // If no CSS selectors, create basic jQuery selectors
      if (id) {
        addUniqueSelector(`$("#${cssEscapeIdent(id)}")`, 'jquery', safeCssCount(`#${cssEscapeIdent(id)}`));
      }

      if (escapedClasses.length > 0) {
        addUniqueSelector(`$(".${escapedClasses[0]}")`, 'jquery', safeCssCount(`.${escapedClasses[0]}`));
      }

      // Always add tag-based selector
      addUniqueSelector(`$("${tag}")`, 'jquery', safeCssCount(tag));
    }

    // Ensure we have at least one of each type of selector
    const hasXpath = selectors.some(sel => sel.type === 'xpath');
    const hasCss = selectors.some(sel => sel.type === 'css');
    const hasJquery = selectors.some(sel => sel.type === 'jquery');
    
    if (!hasXpath) {
      addUniqueSelector(`//${tag}`, 'xpath', document.getElementsByTagName(tag).length);
    }
    
    if (!hasCss) {
      addUniqueSelector(tag, 'css', document.getElementsByTagName(tag).length);
    }
    
    if (!hasJquery) {
      addUniqueSelector(`$("${tag}")`, 'jquery', document.getElementsByTagName(tag).length);
    }
    
    return selectors;
  }
  
  /**
   * Generalized selectors (selectors that intentionally match a family of
   * similar elements) are not part of the current UI — the side panel has no
   * section that renders them. The previous implementation was left behind as
   * a 130-line commented-out block; it has been removed. This stub stays so the
   * exported API and its callers keep working.
   *
   * @returns {Array} always an empty array
   */
  function getGeneralizedSelectors(elem) {
    return [];
  }

  /**
   * Most elements a scan will report on before it stops.
   *
   * Each element costs a handful of document-wide queries — an XPath count, a
   * CSS count, a jQuery count and the P1-P9 Playwright chain — and the scan is
   * synchronous, so the page is frozen for its whole duration. A data grid with
   * a few thousand rows produced a table nobody could read from a tab nobody
   * could use. Past this many, stop and say so.
   */
  const MAX_SCAN_ELEMENTS = 1500;

  /** Whether the last scan stopped early. Read by the side panel. */
  let lastScanTruncated = 0;

  function generateUISelectors() {
    // Start a fresh ARIA-role cache for this scan. Role resolution walks the
    // whole document, and this scan asks for hundreds of elements in a row.
    if (window.PalTechPlaywright && window.PalTechPlaywright.resetRoleCache) {
      window.PalTechPlaywright.resetRoleCache();
    }
    // Same for the element-position index used to name unnamed elements
    if (window.PalTechNaming && window.PalTechNaming.resetPositionIndex) {
      window.PalTechNaming.resetPositionIndex();
    }
    lastScanTruncated = 0;

    // Enhanced query for automation-relevant UI elements, including modern UI patterns and multi-level navigation
    const selectorString = 'a[href], button, input, select, textarea, label, [onclick], [role], [tabindex], h1, h2, h3, h4, h5, h6, div[class*="btn"], div[class*="button"], div[class*="menu"], div[class*="nav"], div[class*="tab"], div[class*="card"], span[class*="icon"], span[class*="badge"], [data-testid], [data-test], [data-cy], [data-automation-id]';
    
    try {
      // First pass - collect all basic UI elements
      const uiElements = document.querySelectorAll(selectorString);
      
      // Second pass - specifically look for hierarchical navigation elements
      // This targets common navigation patterns like nav > ul > li > a, menus, and dropdowns
      const navSelectors = [
        'nav', 
        'ul li a',                       // Basic list navigation
        'ol li a',                       // Ordered list navigation
        '[role="navigation"] a',         // ARIA navigation
        '[role="menu"] [role="menuitem"]', // ARIA menus
        '.nav li a',                     // Bootstrap-style navigation
        '.navbar a',                     // Navbar navigation
        '.dropdown .dropdown-menu a',    // Dropdown menus
        '.menu .submenu a',              // Generic submenus
        '.sidebar a',                    // Sidebar navigation
        '.tree li a',                    // Tree navigation
        '.accordion a',                  // Accordion navigation
        'header a',                      // Header links
        'footer a'                       // Footer links
      ];
      
      // Third pass - look for form hierarchies
      const formSelectors = [
        'form fieldset',                  // Form fieldsets
        'form legend',                    // Form legends
        'fieldset > label',               // Labels within fieldsets
        '.form-group',                    // Bootstrap form groups
        '.form-row',                      // Form rows
        '.form-section',                  // Form sections
        'form .input-group',              // Input groups
        'label input',                    // Inputs within labels
        'label select',                   // Selects within labels
        'label textarea'                  // Textareas within labels
      ];
      
      // Fourth pass - look for card/panel hierarchies
      const cardSelectors = [
        '.card',                          // Card containers
        '.card-header',                   // Card headers
        '.card-body',                     // Card bodies
        '.card-footer',                   // Card footers
        '.panel',                         // Panels
        '.panel-heading',                 // Panel headers
        '.panel-body',                    // Panel bodies
        '.panel-footer',                  // Panel footers
        '.modal-header',                  // Modal headers
        '.modal-body',                    // Modal bodies
        '.modal-footer'                   // Modal footers
      ];
      
      // Fifth pass - look for tab-based hierarchies
      const tabSelectors = [
        '.tab-pane',                      // Tab panes
        '.tab-content',                   // Tab content containers
        '.nav-tabs > li',                 // Tab nav items
        '[role="tabpanel"]',              // ARIA tab panels
        '[role="tab"]',                   // ARIA tabs
        '.tabs > *'                       // Generic tab children
      ];
      
      // Sixth pass - look for accordion and collapsible element hierarchies
      const accordionSelectors = [
        '.accordion-item',                // Accordion items
        '.accordion-header',              // Accordion headers
        '.accordion-collapse',            // Accordion collapse sections
        '.collapse',                      // Collapse elements
        '.expansion-panel',               // Material expansion panels
        '[aria-expanded]'                 // Elements with aria-expanded
      ];
      
      // Seventh pass - look for list-based hierarchies
      const listSelectors = [
        'ul > li',                        // Generic list items
        'ol > li',                        // Ordered list items
        '.list-group-item',               // Bootstrap list group items
        'dl > dt',                        // Definition terms
        'dl > dd',                        // Definition descriptions
        '.tree-node',                     // Tree nodes
        '.tree-item',                     // Tree items
        '[role="listbox"] > [role="option"]' // ARIA listbox options
      ];
      
      // Eighth pass - look for grid/table-based hierarchies
      const gridSelectors = [
        'table > thead > tr > th',        // Table headers
        'table > tbody > tr > td',        // Table cells
        '.grid-row',                      // Grid rows
        '.grid-cell',                     // Grid cells
        '[role="grid"] [role="row"] [role="gridcell"]', // ARIA grid cells
        '.data-row',                      // Data rows
        '.data-cell'                      // Data cells
      ];
      
      // Ninth pass - look for item collections
      const collectionSelectors = [
        '.item-collection > .item',       // Item collections
        '.product-grid > .product',       // Product grids
        '.gallery > .gallery-item',       // Gallery items
        '.data-list > .data-item'         // Data list items
      ];
      
      // Collect all elements from all hierarchical selectors
      const allHierarchySelectors = [
        ...navSelectors, 
        ...formSelectors, 
        ...cardSelectors, 
        ...tabSelectors, 
        ...accordionSelectors, 
        ...listSelectors,
        ...gridSelectors,
        ...collectionSelectors
      ];
      
      const hierarchicalElements = new Set();
      allHierarchySelectors.forEach(selector => {
        try {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => hierarchicalElements.add(el));
        } catch (e) {
          // Ignore invalid selectors
        }
      });
      
      // Find important structural containers that may not be caught by specific selectors
      const genericContainerSelectors = [
        'div[class*="container"]', 
        'div[class*="section"]',
        'div[class*="group"]',
        'div[class*="panel"]',
        'div[class*="view"]',
        'div[class*="layout"]',
        'div[class*="wrapper"]',
        'div[class*="content"]'
      ];
      
      const structuralContainers = new Set();
      genericContainerSelectors.forEach(selector => {
        try {
          // Only get containers that have children and aren't too common
          const containers = document.querySelectorAll(selector);
          if (containers.length < 50) { // Avoid selecting too many generic containers
            containers.forEach(container => {
              // Only include containers that have multiple interactive children or specific structure
              if (container.children.length >= 2) {
                // Check if it has interactive children or heading+content pattern
                const hasInteractiveChildren = container.querySelectorAll('a, button, input, select').length > 0;
                const hasHeadingWithContent = container.querySelector('h1, h2, h3, h4, h5, h6') && 
                                             container.querySelector('p, div > p, div > ul, div > div');
                
                if (hasInteractiveChildren || hasHeadingWithContent) {
                  structuralContainers.add(container);
                }
              }
            });
          }
        } catch (e) {
          // Ignore invalid selectors
        }
      });
      
      // Find multi-level interactive patterns (any level of nesting with interactive elements)
      document.querySelectorAll('div > div, section > div, article > div, main > div').forEach(nestedDiv => {
        const hasNestedInteractives = nestedDiv.querySelectorAll('a, button, input, select').length > 0;
        const hasStructuralClasses =
          /content|panel|section|group|area|container|wrapper/i.test(getClassNames(nestedDiv).join(' '));
        
        if (hasNestedInteractives && hasStructuralClasses) {
          structuralContainers.add(nestedDiv);
          // Also add direct interactive children
          nestedDiv.querySelectorAll('a, button, input, select').forEach(child => {
            hierarchicalElements.add(child);
          });
        }
      });
      
      // Combine and deduplicate all elements
      const allElements = new Set([
        ...uiElements, 
        ...hierarchicalElements, 
        ...structuralContainers
      ]);
      
      const seenXpaths = new Set();
      const data = [];
      
      // Process each element
      for (const elem of allElements) {
        if (data.length >= MAX_SCAN_ELEMENTS) {
          lastScanTruncated = allElements.size;
          console.warn(
            `PalTech: this page has ${allElements.size} candidate elements; ` +
            `reporting the first ${MAX_SCAN_ELEMENTS}.`
          );
          break;
        }
        try {
          // Skip invisible elements
          if (!isElementVisible(elem)) continue;
          
          // Ensure our script is ready to use
          if (!window.PalTechNaming) {
            console.warn("PalTechNaming not available yet, using legacy element naming");
          }
          
          const relXpath = getRelativeXpath(elem, document);
          
          if (relXpath && !seenXpaths.has(relXpath)) {
            seenXpaths.add(relXpath);
            
            // Evaluate XPath count
            const xpathCount = getXPathCount(relXpath);
            
            // CSS selector and count.
            // safeCssCount() never throws — an unparseable selector used to blow up
            // here and silently drop the whole element from the results table.
            const cssSelector = getCssSelector(elem);
            const cssCount = safeCssCount(cssSelector);
            
            // jQuery selector and count
            const jquerySelector = getJQuerySelector(elem);
            const jqueryCount = getJQueryCount(jquerySelector);
            
            // Generate element name using our enhanced naming logic
            const elementName = getElementName(elem);
            
            // Playwright locator (P1→P9 priority chain)
            let playwrightLocator = '';
            let playwrightPriority = 'N/A';
            if (window.PalTechPlaywright) {
              const pw = window.PalTechPlaywright.getPlaywrightLocator(elem, cssSelector, relXpath);
              playwrightLocator = pw.locator;
              playwrightPriority = pw.priority;
            }

            data.push({
              'Element Name': elementName,
              'Relative XPath': relXpath,
              'XPath Health': scoreFragility(relXpath, 'xpath'),
              'Xpath selectors Count': xpathCount,
              'CSS Selector': cssSelector,
              'CSS Health': scoreFragility(cssSelector, 'css'),
              'CSS selectors count': cssCount,
              'jQuery Selector': jquerySelector,
              'jQuery selectors count': jqueryCount,
              'Playwright Locator': playwrightLocator,
              'Playwright Priority': playwrightPriority
            });
          }
        } catch (error) {
          console.error("Error processing element:", error);
          // Continue with next element
        }
      }
      
      return data;
    } catch (e) {
      console.error("Error in generateUISelectors:", e);
      return [];
    }
  }
  
  /**
   * Checks if an element is visible on the page.
   *
   * The previous version only looked at the element's OWN computed style, so an
   * element inside a `visibility:hidden` or `opacity:0` parent was reported as
   * visible (collapsed menus, inactive tab panels, closed modals all leaked into
   * the results). checkVisibility() walks the ancestor chain for us where it is
   * available; the manual path below does the same thing as a fallback.
   *
   * @param {Element} elem - DOM element to check
   * @returns {boolean} - Whether the element is visible
   */
  function isElementVisible(elem) {
    try {
      if (!elem || elem.nodeType !== 1) return false;

      if (typeof elem.checkVisibility === 'function') {
        const visible = elem.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
          contentVisibilityAuto: true,
          opacityProperty: true,
          visibilityProperty: true
        });
        if (!visible) return false;
      } else {
        // Fallback: walk up the tree checking the properties that inherit
        let node = elem;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 50) {
          const style = window.getComputedStyle(node);
          if (style.display === 'none') return false;
          if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
          if (parseFloat(style.opacity) === 0) return false;
          node = node.parentElement;
          depth++;
        }
      }

      // Skip elements with zero dimensions
      const rect = elem.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return false;
      }

      // Skip elements positioned entirely outside the document
      // (the classic off-screen "hidden" trick: left:-9999px)
      if (rect.right < 0 || rect.bottom < 0) {
        return false;
      }

      return true;
    } catch (e) {
      return true; // In case of errors, default to showing the element
    }
  }
  
  /**
   * Scores a selector's fragility using heuristics.
   * Returns { label: 'Stable'|'Moderate'|'Fragile', score: 0-100, reason: string }
   * Lower score = more stable.
   * @param {string} selector - XPath or CSS selector string
   * @param {string} type     - 'xpath' | 'css'
   */
  function scoreFragility(selector, type) {
    if (!selector) return { label: 'Unknown', score: 50, reason: 'No selector provided' };

    let score = 0;
    const reasons = [];

    if (type === 'xpath') {
      // Positional index — breaks when DOM order changes
      if (/\[\d+\]/.test(selector)) {
        score += 40;
        reasons.push('uses positional index [n]');
      }
      // contains(@class, ...) — class toggles with state (active, disabled, etc.)
      if (/contains\(@class/.test(selector)) {
        score += 25;
        reasons.push('class attribute can toggle with state');
      }
      // Long text-based selectors fragment easily
      if (/normalize-space|starts-with/.test(selector) && selector.length > 60) {
        score += 20;
        reasons.push('long text-based selector');
      }
      // Auto-generated-looking IDs
      if (/@id.*ember|@id.*\d{4,}/.test(selector)) {
        score += 35;
        reasons.push('auto-generated ID detected');
      }
      // Good signals
      if (/@data-testid|@data-test|@data-cy|@aria-label/.test(selector)) {
        score = Math.max(0, score - 30);
        reasons.push('has stable test/aria attribute');
      }
    } else {
      // CSS
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

  // Export functions to be used in other modules
  window.PalTechSelectors = {
    getClassNames,
    cssEscapeIdent,
    cssEscapeAttrValue,
    isValidCssSelector,
    safeCssCount,
    escapeXpathString,
    getRelativeXpath,
    getElementName,
    getCssSelector,
    getJQuerySelector,
    getJQueryCount,
    getXPathCount,
    getAlternativeSelectors,
    getGeneralizedSelectors,
    generateUISelectors,
    scoreFragility,
    /** 0, or the number of candidates found when the last scan stopped early. */
    getLastScanTruncated: () => lastScanTruncated
  };

})();
