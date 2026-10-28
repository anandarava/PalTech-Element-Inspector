/**
 * elementNaming.js - Handles intelligent naming of UI elements for automation
 * Follows best practices for naming conventions in test automation
 *
 * Wrapped in an IIFE with a re-injection guard, like every other content
 * script. Without it a second evaluation of this file threw
 *     SyntaxError: Identifier 'GENERATED_CLASS_RE' has already been declared
 * because the five top-level consts below are lexical declarations sharing the
 * isolated world's global scope. That happens for real: the service worker
 * re-injects the whole list after a navigation while recording, on a page the
 * manifest has already auto-injected at document_idle.
 *
 * The body is deliberately left at its original indentation — re-indenting 300
 * lines would bury the change that matters.
 */
(function () {

if (window.PalTechNaming) return;   // already evaluated on this page

/**
 * Gets a mapping of common element types to their abbreviations
 * @returns {Object} - Mapping of element types to abbreviations
 */
function getElementTypeMap() {
  return {
    // Form inputs
    'input': {
      'text': 'txt',
      'password': 'pwd',
      'email': 'email',
      'number': 'num',
      'checkbox': 'chk',
      'radio': 'rad',
      'submit': 'btn',
      'button': 'btn',
      'file': 'file',
      'search': 'search',
      'tel': 'phone',
      'date': 'date',
      'time': 'time',
      'default': 'fld'
    },
    // Interactive elements
    'button': 'btn',
    'a': 'link',
    'select': 'drp',
    'textarea': 'txtArea',
    'label': 'lbl',
    // Content elements
    'h1': 'heading',
    'h2': 'heading',
    'h3': 'heading',
    'h4': 'heading',
    'h5': 'heading',
    'h6': 'heading',
    'p': 'text',
    'span': 'txt',
    'div': 'container',
    'img': 'img',
    'table': 'tbl',
    'tr': 'row',
    'td': 'cell',
    'th': 'colHeader',
    'ul': 'list',
    'ol': 'ordList',
    'li': 'item',
    'form': 'form',
    'iframe': 'frame',
    'dialog': 'dialog',
    'menu': 'menu',
    'nav': 'nav'
  };
}

/**
 * Class names emitted by component frameworks and build tools. These carry no
 * meaning for a person reading a test step, and they change between builds.
 * Kept deliberately generic — the extension has to work on any application.
 *
 *   ng-*, _ngcontent-*, _nghost-*      Angular
 *   mat-*, cdk-*, mdc-*, Mui*          Material / Angular CDK / MUI
 *   sc-*, css-*, emotion-*, jsx-*      styled-components / emotion / styled-jsx
 *   v-*, data-v-*, svelte-*            Vue / Svelte style scoping
 *   ant-*, el-*, q-*, ion-*, chakra-*  Ant, Element, Quasar, Ionic, Chakra
 */
const GENERATED_CLASS_RE =
  /^(ng[-_]|_ng(content|host)|mat[-_]|cdk[-_]|mdc[-_]|mui[a-z]*-|sc-|css-|emotion-|jsx-|v-|data-v-|svelte-|ant-|el-|q-|ion-|chakra-|tw-|js-)/i;

/** Classes that describe transient STATE rather than identity. */
const STATE_CLASS_RE =
  /^(active|inactive|selected|deselected|disabled|enabled|open|opened|closed|show|shown|hide|hidden|visible|invisible|expanded|collapsed|pristine|dirty|touched|untouched|valid|invalid|inserted|loading|loaded|ready|busy|error|success|warning|info|focus|focused|hover|hovered|checked|unchecked|first|last|odd|even|current|highlight|highlighted)$/i;

/** Layout / spacing / typography utilities (Bootstrap, Tailwind and friends). */
const UTILITY_CLASS_RE =
  /^(mt|mb|ml|mr|ms|me|mx|my|pt|pb|pl|pr|ps|pe|px|py|p|m|w|h|min|max|top|left|right|bottom|z|gap|order|basis|grow|shrink|flex|grid|col|row|container|wrapper|d|bg|text|font|leading|tracking|border|rounded|shadow|opacity|position|absolute|relative|fixed|sticky|block|inline|hidden|overflow|align|justify|items|content|self|space|divide|ring|outline|cursor|select|transition|duration|ease|delay|animate|transform|translate|rotate|scale|skew|origin|sr|btn|badge|card|form|input|group|clearfix|float|pull|no)($|-)/i;

/** Hashed or minified class names, e.g. "a3f9c2", "x1n2onr6". */
const HASHED_CLASS_RE = /^[a-z]?[0-9a-f]{5,}$|^[a-z]\d[a-z0-9]{4,}$/i;

/**
 * Icon-font class names. These name a GLYPH, not a function: "fa-angle-right"
 * told us an arrow was drawn there, and using it as the element's name produced
 * steps reading `Click on "Fa Angle Right I"`. The recorder has an icon
 * vocabulary that turns the same markup into "next icon", which is what a
 * tester would actually say.
 */
const ICON_FONT_CLASS_RE =
  /^(fa|fas|far|fab|fal|fad|fa-(solid|regular|brands|light|duotone|sharp)|glyphicons?|mdi|ion|ionicons?|material-icons|material-symbols|feather|octicon|icomoon|typcn|dashicons|bi|vjs-icon)($|-)/i;

/**
 * Whether a class name is worth using as part of an element's name.
 * @param {string} cls
 * @returns {boolean}
 */
function isDescriptiveClass(cls) {
  if (!cls || cls.length < 3) return false;
  if (GENERATED_CLASS_RE.test(cls)) return false;
  if (STATE_CLASS_RE.test(cls))     return false;
  if (UTILITY_CLASS_RE.test(cls))   return false;
  if (HASHED_CLASS_RE.test(cls))    return false;
  if (ICON_FONT_CLASS_RE.test(cls)) return false;
  if (/^\d/.test(cls))              return false;
  return true;
}

/**
 * Converts text to camelCase format
 * @param {string} text - Text to convert
 * @returns {string} - camelCase formatted text
 */
function toCamelCase(text) {
  if (!text) return '';
  
  // Replace special characters with spaces
  text = text.replace(/[^\w\s]/g, ' ')
    // Replace multiple spaces with single space
    .replace(/\s+/g, ' ')
    .trim();
  
  // Convert to camelCase
  return text
    .split(' ')
    .map((word, index) => {
      if (index === 0) {
        // First word lowercase
        return word.toLowerCase();
      }
      // Other words capitalize first letter
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

/**
 * Gets the element type suffix based on tag and attributes
 * @param {Element} elem - DOM element
 * @returns {string} - Element type suffix
 */
function getElementTypeSuffix(elem) {
  if (!elem || !elem.tagName) return '';
  
  const tag = elem.tagName.toLowerCase();
  const elementTypes = getElementTypeMap();
  
  // Special handling for input elements
  if (tag === 'input') {
    const inputType = elem.getAttribute('type')?.toLowerCase() || 'default';
    return elementTypes.input[inputType] || elementTypes.input.default;
  }
  
  // Check for ARIA roles that override the element type
  if (elem.getAttribute('role')) {
    const role = elem.getAttribute('role').toLowerCase();
    switch (role) {
      case 'button': return 'btn';
      case 'checkbox': return 'chk';
      case 'combobox': return 'combo';
      case 'listbox': return 'list';
      case 'radiogroup': return 'radGroup';
      case 'tab': return 'tab';
      case 'tabpanel': return 'panel';
      case 'menu': return 'menu';
      case 'menuitem': return 'menuItem';
      case 'dialog': return 'dialog';
      case 'alert': return 'alert';
    }
  }
  
  // Regular elements
  return elementTypes[tag] || tag;
}

/**
 * Gets the element component prefix based on classes and context
 * @param {Element} elem - DOM element
 * @returns {string} - Component prefix or empty string
 */
function getComponentPrefix(elem) {
  if (!elem || !elem.classList) return '';
  
  // Check for common component classes
  const classNames = Array.from(elem.classList);
  
  // Look for common component patterns in class names
  for (const cls of classNames) {
    // Match component-like classes (e.g. navbar-item, sidebar-link, etc.)
    if (/^(nav|menu|header|footer|sidebar|modal|dialog|card|form|widget)($|-)/i.test(cls)) {
      const match = cls.match(/^([a-z]+)($|-)/i);
      if (match && match[1]) {
        return match[1].toLowerCase() + '_';
      }
    }
  }
  
  // Check for "data-component" attribute
  if (elem.hasAttribute('data-component')) {
    return elem.getAttribute('data-component').toLowerCase() + '_';
  }
  
  return '';
}

/**
 * Gets a descriptive part for the element name based on attributes and content
 * @param {Element} elem - DOM element
 * @returns {string} - Descriptive part for the name
 */
function getElementDescription(elem) {
  if (!elem) return '';
  
  // NOTE: a special case here used to camel-case a <span>'s ENTIRE class
  // attribute into the name, producing labels like "menuIconNgStarInserted" and
  // "footerLogoSvgS0Fill". It has been removed — the generic path below already
  // picks a single descriptive class, and only after every real source of a name
  // (accessibility attributes, form attributes, visible text) has been tried.

  // Special handling for inputs with names or IDs that look like form field identifiers
  if ((elem.tagName.toLowerCase() === 'input' || elem.tagName.toLowerCase() === 'label')) {
    // Check for ID or name attributes that use underscores (common in forms)
    const formId = elem.id || elem.getAttribute('name') || '';
    if (formId && formId.includes('_')) {
      return toCamelCase(formId);
    }
    
    // For labels, check if they're associated with inputs via "for" attribute
    if (elem.tagName.toLowerCase() === 'label' && elem.hasAttribute('for')) {
      const forAttr = elem.getAttribute('for');
      if (forAttr) {
        return toCamelCase(forAttr);
      }
    }
    
    // For checkboxes and radio buttons with form value, use that
    if (elem.tagName.toLowerCase() === 'input' && 
        (elem.type === 'checkbox' || elem.type === 'radio') && 
        elem.hasAttribute('value')) {
      return toCamelCase(elem.getAttribute('value'));
    }
  }
  
  // Priority order for naming:
  // 1. Accessibility and test attributes
  const accessAttrs = ['aria-label', 'title', 'data-testid', 'data-test', 'data-cy', 'data-automation-id'];
  for (const attr of accessAttrs) {
    if (elem.hasAttribute(attr)) {
      const value = elem.getAttribute(attr).trim();
      if (value) return toCamelCase(value);
    }
  }
  
  // 2. Form element attributes
  const formAttrs = ['name', 'placeholder', 'value', 'id'];
  for (const attr of formAttrs) {
    if (elem.hasAttribute(attr)) {
      const value = elem.getAttribute(attr).trim();
      if (value) return toCamelCase(value);
    }
  }
  
  // 3. Text content (limited to short texts)
  const text = elem.textContent?.trim();
  if (text && text.length < 30) {
    return toCamelCase(text);
  } else if (text && text.length >= 30) {
    // For longer texts, use just the first few words
    const firstWords = text.substring(0, 30).split(' ').slice(0, 4).join(' ');
    return firstWords ? toCamelCase(firstWords) : '';
  }
  
  // 4. First class that actually describes the element.
  //    A class name is the weakest source there is, so anything generated,
  //    stateful, utility-shaped or hashed is discarded before we consider it.
  if (elem.classList && elem.classList.length) {
    const descriptiveClasses = Array.from(elem.classList).filter(isDescriptiveClass);
    if (descriptiveClasses.length) {
      return toCamelCase(descriptiveClasses[0]);
    }
  }
  
  return '';
}

/**
 * Document order for elements that have no name of their own, cached.
 *
 * WHY: the fallback below needs the element's position in the document, and it
 * used to get it with
 *     Array.from(document.querySelectorAll('*')).indexOf(elem)
 * — a full materialisation of every element on the page plus a linear search,
 * per element. Across a whole "Generate Selectors" scan that is quadratic, and
 * on a data-grid page with a few thousand elements it froze the tab for
 * seconds. One walk per scan answers every lookup instead.
 */
let positionIndex = null;
let positionStamp = 0;
const POSITION_TTL_MS = 2000;   // one scan's worth; the DOM may change after

function resetPositionIndex() {
  positionIndex = null;
  positionStamp = 0;
}

function documentPositionOf(elem) {
  const now = Date.now();
  if (!positionIndex || now - positionStamp > POSITION_TTL_MS) {
    positionIndex = new Map();
    positionStamp = now;
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) positionIndex.set(all[i], i);
  }
  const at = positionIndex.get(elem);
  return typeof at === 'number' ? at : 0;
}

/**
 * Generates an automation-friendly element name
 * @param {Element} elem - DOM element to name
 * @returns {string} - Automation-friendly element name
 */
function generateElementName(elem) {
  if (!elem || !elem.tagName) return "unknownElement";
  
  // Get the component prefix (like form_, nav_, etc.)
  const componentPrefix = getComponentPrefix(elem);
  
  // Get descriptive part of the element name
  const description = getElementDescription(elem);
  
  // Get the element type suffix (btn, txt, lbl, etc.)
  const typeSuffix = getElementTypeSuffix(elem);
  
  // Construct the final name
  if (description) {
    return `${componentPrefix}${description}${typeSuffix.charAt(0).toUpperCase() + typeSuffix.slice(1)}`;
  } else {
    // Use the element's DOM position index for a stable, deterministic name.
    // Math.random() was removed because it produced a different name for the
    // same element on every scan, breaking any test script that referenced it.
    const posIndex = documentPositionOf(elem);
    return `${componentPrefix}${typeSuffix}${posIndex}`;
  }
}

// Export for use in other modules
window.PalTechNaming = {
  generateElementName,
  isDescriptiveClass,
  resetPositionIndex
};

})();

// NOTE: this file previously created a throwaway <button> and ran the naming
// logic against it on every injection, just to log the result. That work is
// covered by run_tests.js now, so the per-injection DOM churn and console noise
// have been removed. 