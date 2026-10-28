/**
 * run_tests.js — test suite for the PalTech Element Inspector extension.
 *
 * The previous version of this file asserted things like
 *     ok(utils.includes('navigator.clipboard'), 'clipboard uses modern API')
 * i.e. it grepped the source text. Every one of those 21 checks passed while
 * the extension was badly broken, because a string being PRESENT in a file says
 * nothing about what the code DOES. This version actually executes the code.
 *
 * Three layers:
 *   1. PARSE     — every JS file is compiled (catches syntax errors)
 *   2. BEHAVIOUR — pure functions are loaded into a sandbox and called, with
 *                  assertions on their real return values
 *   3. WIRING    — cross-file invariants that no unit test can see (the manifest
 *                  matching the shared file list, script tags being present)
 *
 * Run with:  node run_tests.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = __dirname;

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { console.log('  PASS  ' + label); pass++; }
  else      { console.error('  FAIL  ' + label); fail++; failures.push(label); }
}

/**
 * Stringify for a failure message. DOM-shaped fixtures are circular (a child
 * knows its parent, a parent lists its children), so JSON.stringify throws on
 * them — and it threw while REPORTING, which turned one failed comparison into
 * a crash that hid every test after it.
 */
function show(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    if (value && value.tagName) {
      return '<' + String(value.tagName).toLowerCase() +
             (value.id ? '#' + value.id : '') + '>';
    }
    return String(value);
  }
}

function eq(actual, expected, label) {
  // Identity first: two references to the same element are equal, whatever
  // their shape, and comparing elements is most of what the DOM tests do.
  const same = actual === expected || show(actual) === show(expected);
  if (same) { console.log('  PASS  ' + label); pass++; }
  else {
    console.error('  FAIL  ' + label);
    console.error('          expected: ' + show(expected));
    console.error('          actual  : ' + show(actual));
    fail++; failures.push(label);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal DOM sandbox
//
// Enough of a browser for the extension's modules to load and for their pure
// logic to run. Anything that would need real layout or real CSS parsing is
// stubbed conservatively.
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeElement(tag) {
  const el = {
    nodeType: 1,
    tagName: (tag || 'div').toUpperCase(),
    id: '',
    className: '',
    style: {},
    dataset: {},
    children: [],
    attributes: [],
    _attrs: {},
    textContent: '',
    innerHTML: '',
    parentElement: null,
    parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); },
    getAttribute(name) { return this.hasAttribute(name) ? this._attrs[name] : null; },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
      if (name === 'class') this.className = String(value);
      if (name === 'id') this.id = String(value);
      this.attributes = Object.keys(this._attrs).map(n => ({ name: n, value: this._attrs[n] }));
    },
    removeAttribute(name) { delete this._attrs[name]; },
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    insertAdjacentElement() {},
    remove() {},
    /** As the DOM does it: an element contains itself and its descendants. */
    contains(node) {
      if (!node) return false;
      if (node === this) return true;
      const walk = (n) => (n.children || []).some(c => c === node || walk(c));
      return walk(this);
    },
    querySelector() { return null; },
    querySelectorAll() { return makeNodeList([]); },
    getBoundingClientRect() { return { top: 0, left: 0, width: 10, height: 10, right: 10, bottom: 10 }; },
    focus() {}, select() {}, click() {}
  };
  return el;
}

function makeNodeList(items) {
  const list = items.slice();
  list.forEach = Array.prototype.forEach.bind(list);
  return list;
}

/**
 * A fake DOM with WORKING parent links, shadow roots and a naive selector
 * matcher.
 *
 * The stubs above answer every query with nothing, which is fine for pure
 * functions but useless for content/shadow.js: its whole job is walking a tree
 * and looking through shadow boundaries, so there has to be a tree to walk.
 * The matcher understands only what these tests use — tag, #id, .class,
 * [attr], [attr="value"] and comma lists.
 */
function makeDomKit(ctx) {
  const all = [];

  function matchesOne(el, sel) {
    sel = sel.trim();
    if (!sel) return false;
    if (sel === '*') return true;
    const parts = sel.match(/^([a-z0-9-]*)((?:[#.\[][^#.\[]*)*)$/i);
    if (!parts) return false;
    if (parts[1] && el.tagName.toLowerCase() !== parts[1].toLowerCase()) return false;
    const rest = parts[2] || '';
    const tokens = rest.match(/[#.]\S+?(?=[#.\[]|$)|\[[^\]]*\]/g) || [];
    for (const tok of tokens) {
      if (tok[0] === '#') {
        if (el.id !== tok.slice(1)) return false;
      } else if (tok[0] === '.') {
        if (String(el.className || '').split(/\s+/).indexOf(tok.slice(1)) === -1) return false;
      } else {
        const m = tok.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (!m) return false;
        if (!el.hasAttribute(m[1])) return false;
        if (m[2] !== undefined && el.getAttribute(m[1]) !== m[2]) return false;
      }
    }
    return true;
  }

  function descendants(node) {
    const out = [];
    (function walk(n) {
      (n.children || []).forEach(c => { out.push(c); walk(c); });
    })(node);
    return out;
  }

  function queryAll(node, selector) {
    const sels = String(selector).split(',');
    return makeNodeList(descendants(node).filter(el => sels.some(s => matchesOne(el, s))));
  }

  function el(tag, attrs, text) {
    const e = makeFakeElement(tag);
    Object.keys(attrs || {}).forEach(k => {
      e.setAttribute(k, attrs[k]);
      if (k === 'class') e.className = attrs[k];
    });
    e._text = text || '';
    Object.defineProperty(e, 'textContent', {
      configurable: true,
      get() { return this._text + (this.children || []).map(c => c.textContent).join(''); },
      set(v) { this._text = v; }
    });
    Object.defineProperty(e, 'childElementCount', {
      configurable: true,
      get() { return (this.children || []).length; }
    });
    e.matches = (sel) => String(sel).split(',').some(s => matchesOne(e, s));
    e.querySelectorAll = (sel) => queryAll(e, sel);
    e.querySelector = (sel) => { const hits = queryAll(e, sel); return hits.length ? hits[0] : null; };
    e.getRootNode = function () {
      let n = this;
      while (n) {
        if (n.nodeType === 11) return n;
        const up = n.parentNode || n.parentElement;
        if (!up) return ctx.document;
        n = up;
      }
      return ctx.document;
    };
    e.getBoundingClientRect = () => ({
      top: 0, left: 0, width: e._w === undefined ? 40 : e._w,
      height: e._h === undefined ? 20 : e._h,
      right: 40, bottom: 20
    });
    e.getClientRects = () => [{ width: 40, height: 20 }];
    all.push(e);
    return e;
  }

  /** Append, keeping BOTH links the DOM keeps. */
  function add(parent, child) {
    child.parentNode = parent;
    child.parentElement = (parent && parent.nodeType === 1) ? parent : null;
    (parent.children = parent.children || []).push(child);
    return child;
  }

  /** Append into a shadow root: parentNode is the ROOT, parentElement null. */
  function addToRoot(root, child) {
    child.parentNode = root;
    child.parentElement = null;
    root.children.push(child);
    return child;
  }

  /** attachShadow, as far as these tests are concerned. */
  function attachShadow(host) {
    const root = {
      nodeType: 11,
      host,
      children: [],
      querySelectorAll: (sel) => queryAll(root, sel),
      querySelector: (sel) => { const h = queryAll(root, sel); return h.length ? h[0] : null; },
      getRootNode() { return root; }
    };
    Object.defineProperty(root, 'textContent', {
      configurable: true,
      get() { return root.children.map(c => c.textContent).join(''); }
    });
    host.shadowRoot = root;
    return root;
  }

  /** Point the sandbox's document at this tree. */
  function install(rootEl) {
    ctx.document.body = rootEl;
    ctx.document.documentElement = rootEl;
    ctx.document.querySelectorAll = (sel) => queryAll(rootEl, sel);
    ctx.document.querySelector = (sel) => { const h = queryAll(rootEl, sel); return h.length ? h[0] : null; };
    ctx.document.activeElement = null;
    rootEl.getRootNode = () => ctx.document;
  }

  /**
   * A composedPath()-style event.
   *
   * `target` is what the browser reports to a document listener: for an event
   * that crossed a shadow boundary that is the component HOST, not the element
   * clicked and not the document. Defaults to the outermost host on the path.
   */
  function event(path, target) {
    let reported = target;
    if (!reported) {
      reported = path[path.length - 1];
      for (let i = path.length - 1; i >= 0; i--) {
        if (path[i] && path[i].shadowRoot) { reported = path[i]; break; }
      }
    }
    return { target: reported, composedPath: () => path.slice() };
  }

  return { el, add, addToRoot, attachShadow, install, event, matchesOne };
}

function createSandbox() {
  const documentStub = {
    body: makeFakeElement('body'),
    head: makeFakeElement('head'),
    documentElement: makeFakeElement('html'),
    // Return a fake element for any id so panel classes can construct
    getElementById: (id) => makeFakeElement('div'),
    querySelector: () => null,
    querySelectorAll: () => makeNodeList([]),
    getElementsByTagName: () => makeNodeList([]),
    createElement: (tag) => makeFakeElement(tag),
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return true; },
    evaluate: () => ({ snapshotLength: 0, snapshotItem: () => null, singleNodeValue: null }),
    execCommand: () => true
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Math, Date, RegExp, Set, Map, WeakMap, Array, Object, String, Number, Boolean, Error,
    document: documentStub,
    // Content scripts register page-lifecycle listeners at load time
    addEventListener() {}, removeEventListener() {},
    // Enough of the page's own globals for pageHooks.js, which patches them
    location: { href: 'https://example.test/start', pathname: '/start', search: '' },
    history: { pushState() {}, replaceState() {} },
    fetch: () => Promise.resolve({ ok: true }),
    XMLHttpRequest: class { open() {} send() {} addEventListener() {} },
    alert() {}, confirm() { return true; }, prompt() { return null; },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7, FIRST_ORDERED_NODE_TYPE: 9 },
    CSS: {
      // Real CSS.escape semantics for the characters that matter here
      escape: (s) => String(s).replace(/([^\w-]|^(?=\d))/g, '\\$&')
    },
    URL,   // Node's real URL — the code relies on genuine pathname/search parsing
    Blob: class { constructor(parts) { this.parts = parts; } },
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener() {} },
        sendMessage: () => Promise.resolve()
      },
      tabs: { query() {}, sendMessage() {}, onUpdated: { addListener() {} }, onActivated: { addListener() {} } },
      storage: {
        local:   { get() {}, set() {}, remove() {}, onChanged: { addListener() {} } },
        session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
        onChanged: { addListener() {} }
      },
      scripting: { executeScript() {} },
      sidePanel: { setPanelBehavior: () => Promise.resolve(), open() {} }
    }
  };

  sandbox.window = sandbox;
  sandbox.self   = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

function loadInto(ctx, rel) {
  vm.runInContext(read(rel), ctx, { filename: rel });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PARSE — every JS file must compile
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== 1. PARSE ===');

const JS_FILES = [
  'background.js',
  'shared/contentScriptFiles.js',
  'content/elementNaming.js',
  'content/playwright.js',
  'content/selectors.js',
  'content/highlighting.js',
  'content/inspection.js',
  'content/codeGen.js',
  'content/recorder.js',
  'content/pageHooks.js',
  'content/content-script.js',
  'sidepanel/utils.js',
  'sidepanel/multi-tab.js',
  'sidepanel/single-tab.js',
  'sidepanel/bookmarks-tab.js',
  'sidepanel/recorder-tab.js',
  'sidepanel/test-steps-tab.js',
  'sidepanel/sidepanel.js'
];

JS_FILES.forEach(f => {
  let compiled = true;
  try { new vm.Script(read(f), { filename: f }); } catch (e) { compiled = false; console.error('        ' + e.message); }
  ok(compiled, `${f} parses`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. RE-INJECTION — every content script must survive being evaluated twice
//
// Content scripts share the isolated world's global scope, so a top-level
// const/let/class in a file that gets injected a second time throws
// "Identifier 'X' has already been declared". This is not hypothetical: the
// manifest auto-injects at document_idle, the side panel injects when its ping
// finds nothing, and the service worker re-injects after a navigation while
// recording. elementNaming.js was unguarded and threw on the second pass.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== 1b. RE-INJECTION SAFETY ===');

const reinjectCtx = createSandbox();
loadInto(reinjectCtx, 'shared/contentScriptFiles.js');
reinjectCtx.self.PALTECH_CONTENT_SCRIPT_FILES
  .concat([reinjectCtx.self.PALTECH_PAGE_HOOK_FILE])
  .forEach(f => {
  const ctx = createSandbox();
  let twice = true, msg = '';
  try {
    loadInto(ctx, f);
    loadInto(ctx, f);
  } catch (e) {
    twice = false;
    msg = e.message;
  }
  ok(twice, `${f} can be injected twice` + (msg ? ' — ' + msg : ''));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. BEHAVIOUR
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== 2. BEHAVIOUR: selectors.js helpers ===');

const selCtx = createSandbox();
loadInto(selCtx, 'content/selectors.js');
const Sel = selCtx.window.PalTechSelectors;

{
  // The scan stops after a fixed number of elements so an enormous page cannot
  // freeze the tab; the panel reads this to say so instead of quietly showing a
  // partial list.
  ok(typeof Sel.getLastScanTruncated === 'function',
     'selectors.js reports whether a scan stopped early');
  eq(Sel.getLastScanTruncated(), 0, 'and reports 0 before any scan has run');
}

ok(!!Sel, 'PalTechSelectors is exported');

// getClassNames — the SVG crash that emptied the results table
{
  const div = makeFakeElement('div');
  div.className = 'alpha  beta   gamma';
  eq(Sel.getClassNames(div), ['alpha', 'beta', 'gamma'], 'getClassNames splits a normal class string');

  // SVG elements expose className as an SVGAnimatedString object
  const svg = makeFakeElement('svg');
  svg.className = { baseVal: 'icon icon-home', animVal: 'icon icon-home' };
  eq(Sel.getClassNames(svg), ['icon', 'icon-home'],
     'getClassNames reads SVGAnimatedString instead of throwing');

  const none = makeFakeElement('span');
  none.className = '';
  eq(Sel.getClassNames(none), [], 'getClassNames returns [] for no classes');

  let threw = false;
  try { Sel.getClassNames(null); } catch (e) { threw = true; }
  ok(!threw, 'getClassNames tolerates null');
}

// cssEscapeIdent — the Tailwind / numeric-id crash
{
  ok(Sel.cssEscapeIdent('md:flex').includes('\\:'),
     'cssEscapeIdent escapes the colon in a Tailwind class');
  ok(Sel.cssEscapeIdent('w-1/2').includes('\\/'),
     'cssEscapeIdent escapes the slash in a Tailwind class');
  eq(Sel.cssEscapeIdent('plain-class'), 'plain-class',
     'cssEscapeIdent leaves a plain class untouched');
}

// escapeXpathString — apostrophes in page text
{
  eq(Sel.escapeXpathString("Save"), "'Save'", 'escapeXpathString quotes a plain string');
  eq(Sel.escapeXpathString("Don't"), '"Don\'t"',
     'escapeXpathString switches to double quotes when the value has an apostrophe');
  ok(Sel.escapeXpathString(`He said "it's"`).startsWith('concat('),
     'escapeXpathString falls back to concat() when both quote types are present');
}

// scoreFragility — the badge class that was missing
{
  const stable = Sel.scoreFragility('[data-testid="submit"]', 'css');
  ok(stable.cls === 'frag-stable', 'scoreFragility returns cls for a stable selector');
  // positional index (40) + state-dependent class (25) = 65 -> Fragile
  const fragile = Sel.scoreFragility("//div[contains(@class, 'active')][3]", 'xpath');
  eq(fragile.cls, 'frag-fragile', 'scoreFragility returns cls for a fragile selector');

  const moderate = Sel.scoreFragility('//div[3]/span[2]', 'xpath');
  eq(moderate.cls, 'frag-moderate', 'scoreFragility returns cls for a moderate selector');

  [stable, moderate, fragile].forEach(r => {
    ok(['frag-stable', 'frag-moderate', 'frag-fragile'].includes(r.cls),
       `scoreFragility cls "${r.cls}" is a real CSS class`);
    ok(typeof r.label === 'string' && r.label.length > 0,
       `scoreFragility label "${r.label}" is present`);
  });
}

console.log('\n=== 2. BEHAVIOUR: elementNaming.js ===');

const nameCtx = createSandbox();
loadInto(nameCtx, 'content/elementNaming.js');
const Naming = nameCtx.window.PalTechNaming;

{
  const btn = makeFakeElement('button');
  btn.setAttribute('name', 'test_button');
  btn.textContent = 'Test Button';
  const generated = Naming.generateElementName(btn);
  ok(/Btn$/.test(generated), `generateElementName appends a type suffix (got "${generated}")`);

  // Determinism — the Math.random() bug meant the same element got a new name
  // on every scan, which broke any script referencing it.
  const again = Naming.generateElementName(btn);
  eq(again, generated, 'generateElementName is deterministic for the same element');

  const input = makeFakeElement('input');
  input.setAttribute('type', 'password');
  input.setAttribute('name', 'user_password');
  ok(/Pwd$/.test(Naming.generateElementName(input)),
     'generateElementName uses the input type for the suffix');

  ok(Naming.generateElementName(null) === 'unknownElement',
     'generateElementName handles a null element');

  // --- Naming an unnamed element must not walk the whole document ---
  // The fallback name is the element's position in the document, which used to
  // be found with Array.from(document.querySelectorAll('*')).indexOf(elem) —
  // once per element, so quadratic across a scan. The index is built once and
  // reset at the start of each scan.
  ok(typeof Naming.resetPositionIndex === 'function',
     'the position index can be reset at the start of a scan');
  const bare = makeFakeElement('div');
  const first = Naming.generateElementName(bare);
  Naming.resetPositionIndex();
  eq(Naming.generateElementName(bare), first,
     'and an unnamed element keeps the same name across scans');
}

{
  // --- Page text inside GENERATED CODE has to be escaped ---
  // A label containing an apostrophe produced a locator that will not compile:
  //     getByRole('div', { name: 'Employee's name' })
  const pwCtx = createSandbox();
  loadInto(pwCtx, 'content/selectors.js');
  loadInto(pwCtx, 'content/playwright.js');
  const PW = pwCtx.window.PalTechPlaywright;

  ok(typeof PW.escLit === 'function' && typeof PW.attrValue === 'function',
     'playwright.js exports its escapers so other modules need not reinvent them');
  eq(PW.escLit("Employee's name"), "Employee\\'s name",
     'a quote inside a single-quoted literal is escaped');
  eq(PW.escLit('back\\slash'), 'back\\\\slash', 'and so is a backslash');
  eq(PW.attrValue('say "hi"'), 'say \\"hi\\"',
     'a quote inside a double-quoted attribute value is escaped');
  eq(PW.escLit(null), '', 'a missing value escapes to nothing');

  // inspection.js builds iframe locators itself; it must use those escapers
  const insp = read('content/inspection.js');
  ok(/getByRole\('\$\{escLit\(innerTag\)\}', \{ name: '\$\{escLit\(label\)\}' \}\)/.test(insp),
     'the iframe role locator escapes the name it read off the page');
  ok(!/name: '\$\{label\}'/.test(insp),
     'and no longer interpolates it raw');
}

{
  // --- CSV export: a cell must never be able to end the row ---
  // Only commas and quotes were quoted, so a selector or label containing a
  // newline split the rest of its row into a row of its own.
  const csvCtx = createSandbox();
  let written = '';
  csvCtx.Blob = class { constructor(parts) { written = parts.join(''); } };
  csvCtx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  loadInto(csvCtx, 'sidepanel/utils.js');
  const CSV = csvCtx.window.PalTechUtils;

  CSV.exportToCSV([
    { Name: 'plain', Sel: "div#a" },
    { Name: 'has, comma', Sel: 'span[title="x"]' },
    { Name: 'has\nnewline', Sel: 'p' },
    { Name: 'zero', Sel: 0 }
  ], 'x.csv');

  const body = written.replace(/^﻿/, '');
  const rows = body.split('\r\n').filter(Boolean);
  eq(rows.length, 5, 'a newline inside a cell does not add a row');
  eq(rows[0], 'Name,Sel', 'the header comes first');
  ok(rows[2].startsWith('"has, comma"'), 'a comma is quoted');
  ok(rows[3].startsWith('"has\nnewline"'), 'a newline is quoted, keeping the row intact');
  eq(rows[4], 'zero,0', 'a legitimate 0 is exported, not blanked');
  ok(/^﻿/.test(written), 'the file carries a UTF-8 BOM so Excel reads accents');

  // A quote inside a cell is doubled, and the whole cell quoted
  written = '';
  CSV.exportToCSV([{ Sel: 'a[title="hi"]' }], 'y.csv');
  ok(written.includes('"a[title=""hi""]"'), 'quotes inside a cell are doubled');
}

console.log('\n=== 2. BEHAVIOUR: bookmark storage ===');

{
  // A storage stub that can be made to fail, because failing silently is the
  // bug being fixed: chrome.storage.local holds 10MB and every bookmark
  // carries a whole selector row, so the quota is reachable.
  const bmCtx = createSandbox();
  const store = {};
  let failWith = null;
  bmCtx.chrome.runtime.lastError = null;
  bmCtx.chrome.storage.local = {
    get(key, cb) {
      bmCtx.chrome.runtime.lastError = failWith ? { message: failWith } : null;
      cb(failWith ? {} : { [key]: store[key] });
    },
    set(obj, cb) {
      bmCtx.chrome.runtime.lastError = failWith ? { message: failWith } : null;
      if (!failWith) Object.assign(store, obj);
      cb();
    }
  };
  loadInto(bmCtx, 'sidepanel/utils.js');
  const U = bmCtx.window.PalTechUtils;

  let saved = null;
  U.addBookmark({ domain: 'app.example.com', elementName: 'Save', data: {} },
                (err) => { saved = err; });
  eq(saved, null, 'a bookmark is saved and reports no error');

  let list = null;
  U.readBookmarks((bookmarks) => { list = bookmarks; });
  eq(list.length, 1, 'and reads back');
  ok(!!list[0].id, 'carrying an id of its own, not just a position in the array');

  U.addBookmark({ domain: 'app.example.com', elementName: 'Delete', data: {} }, () => {});
  U.readBookmarks((bookmarks) => { list = bookmarks; });
  eq(list.length, 2, 'a second bookmark is appended');
  ok(list[0].id !== list[1].id, 'with a different id');

  // Deleting by id survives a stale view; deleting by index did not
  const keep = list[0].id;
  const gone = list[1].id;
  U.writeBookmarks(list.filter(b => b.id !== gone), () => {});
  U.readBookmarks((bookmarks) => { list = bookmarks; });
  eq(list.length, 1, 'removing by id removes exactly one');
  eq(list[0].id, keep, 'and it is the right one');

  // --- A write that fails must say so ---
  failWith = 'QUOTA_BYTES quota exceeded';
  let addErr = 'not called';
  U.addBookmark({ domain: 'x', elementName: 'y', data: {} }, (err) => { addErr = err; });
  eq(addErr, 'QUOTA_BYTES quota exceeded',
     'a full storage quota is reported, not swallowed behind "Bookmarked!"');

  let writeErr = 'not called';
  U.writeBookmarks([], (err) => { writeErr = err; });
  eq(writeErr, 'QUOTA_BYTES quota exceeded', 'and so is a failed write of the whole list');

  let readErr = 'not called';
  U.readBookmarks((bookmarks, err) => { readErr = err; list = bookmarks; });
  eq(readErr, 'QUOTA_BYTES quota exceeded', 'a failed read is reported too');
  eq(list.length, 0, 'and hands back an empty list rather than undefined');

  failWith = null;
  U.readBookmarks((bookmarks) => { list = bookmarks; });
  eq(list.length, 1, 'nothing was lost while the storage was failing');
}

console.log('\n=== 2. BEHAVIOUR: codeGen.js ===');

const cgCtx = createSandbox();
loadInto(cgCtx, 'content/codeGen.js');
const CodeGen = cgCtx.window.PalTechCodeGen;

{
  const snippets = CodeGen.generateFrameworkSnippets(
    "page.getByRole('button', { name: 'Sign In' })", 'button.login', '//button', 'signInBtn'
  );
  eq(snippets.length, 5, 'generateFrameworkSnippets returns all five frameworks');
  const py = snippets.find(s => s.framework === 'Playwright' && s.language === 'Python');
  ok(py.code.includes('get_by_role("button", name="Sign In")'),
     'Playwright JS locator converts to the Python API');
  const java = snippets.find(s => s.language === 'Java');
  ok(java.code.includes('By.cssSelector("button.login")'),
     'Selenium Java uses the CSS selector');
}

console.log('\n=== 2. BEHAVIOUR: sidepanel/utils.js ===');

const utilCtx = createSandbox();
loadInto(utilCtx, 'shared/contentScriptFiles.js');
loadInto(utilCtx, 'sidepanel/utils.js');
const Utils = utilCtx.window.PalTechUtils;

{
  eq(Utils.escapeHtml('<img src=x onerror=alert(1)>'),
     '&lt;img src=x onerror=alert(1)&gt;',
     'escapeHtml neutralises angle brackets');

  // The attribute-injection hole: '&' had to be escaped FIRST
  const evil = '&quot; onmouseover=alert(1) x=&quot;';
  const escaped = Utils.escapeForAttribute(evil);
  ok(escaped.includes('&amp;quot;') && !/(^|[^&a-z])&quot;/.test(escaped),
     'escapeForAttribute escapes & so page text cannot break out of an attribute');
  eq(Utils.escapeForAttribute('a"b'), 'a&quot;b', 'escapeForAttribute still escapes quotes');

  ok(Array.isArray(Utils.CONTENT_SCRIPT_FILES) && Utils.CONTENT_SCRIPT_FILES.length > 0,
     'utils exposes the shared content script list');
  ok(typeof Utils.ensureContentScripts === 'function',
     'utils exposes the shared injector');
  ok(typeof Utils.ensurePageHooks === 'function',
     'utils exposes the MAIN-world page hook injector');
  ok(Utils.RecordingController && typeof Utils.RecordingController.startRecording === 'function',
     'utils exposes the shared RecordingController');
  ok(Utils.RecordingController.isActive() === false,
     'RecordingController starts idle');
  ok(typeof Utils.RecordingController.restore === 'function',
     'RecordingController can restore a session a closed panel left running');
}

console.log('\n=== 2. BEHAVIOUR: recording survives the panel being closed ===');

{
  // Closing the side panel destroys the panel document — its RecordingController
  // ownership, its step list, everything — while the page recorder keeps going
  // and the service worker keeps re-arming it after each navigation. The
  // reopened panel then showed Start enabled and Stop DISABLED over a live
  // recorder, so nothing in the UI could stop it. These tests drive a fresh
  // panel document against a session that is still running in the page.

  /**
   * @param {Object} stored     - what the previous panel left in session storage
   * @param {*}      pageAnswer - what the page replies to { action:'isRecording' },
   *                              or null for a tab that cannot be reached at all
   */
  function reopenedPanel(stored, pageAnswer) {
    const ctx = createSandbox();
    const session = Object.assign({}, stored);
    ctx.chrome.storage.session = {
      // A thenable that settles synchronously. chrome.storage.session really
      // returns a Promise, but this suite is synchronous — an eager thenable
      // keeps restore() honest (it must go through .then) while letting the
      // assertions below run in order.
      get: (keys) => {
        const out = {};
        [].concat(keys).forEach(k => { if (k in session) out[k] = session[k]; });
        return { then(cb) { cb(out); return { catch() {} }; } };
      },
      set: (obj) => { Object.assign(session, obj); return Promise.resolve(); },
      remove: (keys) => {
        [].concat(keys).forEach(k => { delete session[k]; });
        return Promise.resolve();
      }
    };
    ctx.chrome.tabs.sendMessage = (tabId, msg, cb) => {
      ctx.chrome.runtime.lastError = pageAnswer === null ? { message: 'no receiving end' } : null;
      if (typeof cb === 'function') cb(pageAnswer === null ? undefined : pageAnswer);
    };
    loadInto(ctx, 'shared/contentScriptFiles.js');
    loadInto(ctx, 'content/codeGen.js');
    loadInto(ctx, 'sidepanel/utils.js');
    loadInto(ctx, 'sidepanel/recorder-tab.js');
    loadInto(ctx, 'sidepanel/test-steps-tab.js');
    return { ctx, session, Utils: ctx.window.PalTechUtils };
  }

  const TAB_KEY   = utilCtx.PALTECH_RECORDING_KEY;
  const OWNER_KEY = utilCtx.PALTECH_RECORDING_OWNER_KEY;
  const STEPS     = utilCtx.PALTECH_RECORDING_STEPS_PREFIX;

  ok(!!OWNER_KEY && !!STEPS,
     'the shared file names the owner and step keys a reopened panel restores from');

  // --- A recording still running in the page is handed back to its tab ---
  {
    const savedSteps = [
      { id: 1, type: 'navigate', url: 'https://example.com/login', locator: 'page' },
      { id: 2, type: 'click', locator: "page.getByRole('button', { name: 'Sign In' })",
        css: 'button.login', xpath: '//button', description: 'Click "Sign In"' }
    ];
    const { ctx, session, Utils: U } = reopenedPanel(
      { [TAB_KEY]: 42, [OWNER_KEY]: 'recorder', [STEPS + 'recorder']: savedSteps },
      { recording: true }
    );

    const tab = ctx.window.recorderTab;
    eq(tab.isRecording, false, 'a reopened panel starts out believing nothing is recording');

    let resumed = 'not called';
    U.RecordingController.restore((r) => { resumed = r; });

    eq(resumed, true, 'restore() finds the recording the closed panel left running');
    eq(tab.isRecording, true, 'the Recorder tab takes ownership of it again');
    eq(tab.stopBtn.disabled, false,
       'Stop is enabled again — the bug was a disabled Stop over a live recorder');
    eq(tab.startBtn.disabled, true, 'and Start is not offered a second time');
    eq(tab.steps.length, 2, 'the steps recorded before the panel closed come back');
    eq(U.RecordingController.currentTabId(), 42, 'on the tab that was being recorded');

    // ...and pressing Stop now really does reach the page
    let stopped = null;
    ctx.chrome.tabs.sendMessage = (tabId, msg, cb) => {
      ctx.chrome.runtime.lastError = null;
      if (msg.action === 'stopRecording') stopped = tabId;
      if (typeof cb === 'function') cb({ success: true });
    };
    tab._stopRecording();
    eq(stopped, 42, 'pressing Stop sends stopRecording to the recorded tab');
    eq(tab.isRecording, false, 'and the tab returns to idle');
    eq(U.RecordingController.isActive(), false, 'with the shared session released');
    eq(session[TAB_KEY], undefined, 'the session tab key is cleared');
    eq(session[OWNER_KEY], undefined, 'and so is the owner');
    eq(session[STEPS + 'recorder'], undefined, 'and the mirrored steps');
  }

  // --- A session owned by the Test Steps tab goes back to THAT tab ---
  {
    const { ctx, Utils: U } = reopenedPanel(
      { [TAB_KEY]: 7, [OWNER_KEY]: 'teststeps',
        [STEPS + 'teststeps']: [{ id: 1, type: 'navigate', url: 'https://example.com' }] },
      { recording: true }
    );
    U.RecordingController.restore();
    eq(ctx.window.testStepsTab.isRecording, true, 'the Test Steps tab resumes its own recording');
    eq(ctx.window.recorderTab.isRecording, false, 'and the Recorder tab is left alone');
  }

  // --- Stale keys must never claim a recording that is not running ---
  {
    const { ctx, session, Utils: U } = reopenedPanel(
      { [TAB_KEY]: 9, [OWNER_KEY]: 'recorder' },
      { recording: false }
    );
    let resumed = 'not called';
    U.RecordingController.restore((r) => { resumed = r; });
    eq(resumed, false, 'a page whose recorder has stopped does not resume');
    eq(ctx.window.recorderTab.isRecording, false, 'the panel stays idle');
    eq(session[TAB_KEY], undefined, 'and the stale session keys are cleared');
  }

  // --- A tab that cannot be reached (closed, chrome://, the PDF viewer) ---
  {
    const { ctx, session, Utils: U } = reopenedPanel(
      { [TAB_KEY]: 11, [OWNER_KEY]: 'teststeps' },
      null
    );
    let resumed = 'not called';
    U.RecordingController.restore((r) => { resumed = r; });
    eq(resumed, false, 'an unreachable tab does not resume');
    eq(ctx.window.testStepsTab.isRecording, false, 'the panel stays idle');
    eq(session[TAB_KEY], undefined, 'and the keys pointing at it are cleared');
  }

  // --- Nothing stored: an ordinary first open ---
  {
    const { ctx, Utils: U } = reopenedPanel({}, { recording: true });
    let resumed = 'not called';
    U.RecordingController.restore((r) => { resumed = r; });
    eq(resumed, false, 'a first open with no stored session resumes nothing');
    eq(ctx.window.recorderTab.isRecording, false, 'and starts idle');
  }

  // --- Steps are mirrored as they arrive, which is what makes resume useful ---
  {
    const { ctx, session, Utils: U } = reopenedPanel({}, { recording: true });
    ctx.chrome.tabs.query = (q, cb) => cb([{ id: 5 }]);
    ctx.chrome.tabs.sendMessage = (tabId, msg, cb) => {
      ctx.chrome.runtime.lastError = null;
      if (typeof cb === 'function') cb({ success: true, alive: true });
    };
    ctx.chrome.scripting.executeScript = (opts, cb) => { if (cb) cb(); };

    const tab = ctx.window.recorderTab;
    tab._startRecording();
    eq(U.RecordingController.isOwnedBy('recorder'), true, 'starting claims the shared session');
    eq(session[OWNER_KEY], 'recorder', 'and records WHICH panel tab owns it');

    tab.steps.push({ id: 1, type: 'click', locator: 'page' });
    tab._persistSteps();
    eq((session[STEPS + 'recorder'] || []).length, 1,
       'each recorded step is mirrored, so closing the panel cannot lose it');
  }
}

console.log('\n=== 2. BEHAVIOUR: recorder-tab.js code generation ===');

const recCtx = createSandbox();
loadInto(recCtx, 'shared/contentScriptFiles.js');
loadInto(recCtx, 'content/codeGen.js');
loadInto(recCtx, 'sidepanel/utils.js');
loadInto(recCtx, 'sidepanel/recorder-tab.js');
const recTab = recCtx.window.recorderTab;

{
  ok(!!recTab, 'RecorderTab instantiates without a real DOM');

  const steps = [
    { type: 'navigate', url: 'https://example.com/login', locator: 'page', value: '' },
    { type: 'fill',  locator: "page.getByLabel('Email')", css: '#email', xpath: '//input[@id="email"]', value: 'a@b.com' },
    { type: 'click', locator: "page.getByRole('button', { name: 'Sign In' })", css: 'button.login', xpath: '//button', value: '' }
  ];

  const js = recTab._generateCode(steps, 'pw-js', 'login flow');
  ok(js.includes("await page.goto('https://example.com/login');"),
     'Playwright JS output includes the navigate step');
  ok(js.includes(".fill('a@b.com')"), 'Playwright JS output includes the fill step');
  ok(js.includes('.click()'), 'Playwright JS output includes the click step');

  const py = recTab._generateCode(steps, 'pw-py', 'login flow');
  ok(py.includes('page.goto("https://example.com/login")'), 'Playwright Python output navigates');
  ok(py.startsWith('import re'), 'Playwright Python output has imports');
  ok(py.includes('page.get_by_label("Email").fill("a@b.com")'),
     'Playwright Python emits a locator expression, not an assignment statement');
  ok(!/^\s*element\s*=/m.test(py),
     'Playwright Python output contains no stray "element =" assignment');

  const cy = recTab._generateCode(steps, 'cypress', 'login flow');
  ok(cy.includes("cy.visit('https://example.com/login');"), 'Cypress output visits the URL');

  const java = recTab._generateCode(steps, 'sel-java', 'login flow');
  ok(java.includes('driver.get("https://example.com/login");'), 'Selenium Java output navigates');

  // Values containing quotes must not break out of the generated string literal
  const quoteStep = [{ type: 'fill', locator: "page.getByLabel('Name')", css: '#n', xpath: '//i', value: "O'Brien" }];
  const quoted = recTab._generateCode(quoteStep, 'pw-js', 't');
  ok(quoted.includes("\\'"), 'generated code escapes apostrophes in recorded values');

  // Key mapping — an unmapped key used to emit Keys.<GARBAGE> that will not compile
  const javaKey = recCtx.javaKey;
  eq(javaKey('Enter'), 'Keys.RETURN', 'javaKey maps Enter');
  eq(javaKey('F5'), 'Keys.F5', 'javaKey maps function keys');
  ok(javaKey('Control+Y').includes('Keys.chord'), 'javaKey maps Control+Y');
  eq(javaKey('SomeWeirdKey'), '"SomeWeirdKey"',
     'javaKey falls back to a string literal rather than an invalid constant');
}

console.log('\n=== 2. BEHAVIOUR: test-steps-tab.js English generation ===');

const tsCtx = createSandbox();
loadInto(tsCtx, 'shared/contentScriptFiles.js');
loadInto(tsCtx, 'content/codeGen.js');
loadInto(tsCtx, 'sidepanel/utils.js');
loadInto(tsCtx, 'sidepanel/test-steps-tab.js');
const tsTab = tsCtx.window.testStepsTab;

{
  ok(!!tsTab, 'TestStepsTab instantiates without a real DOM');

  eq(tsTab._humanizeName('signInBtn'), 'Sign In', '_humanizeName strips the Btn suffix');
  eq(tsTab._humanizeName('attendanceContainer'), 'Attendance', '_humanizeName strips Container');
  eq(tsTab._humanizeName('menu_menuNameTxt'), 'Menu Name', '_humanizeName de-duplicates repeated words');

  const parsed = tsTab._parseLocator("page.getByRole('button', { name: 'Sign In' })");
  eq(parsed, { role: 'button', label: 'Sign In' }, '_parseLocator reads role and name');
  eq(tsTab._parseLocator('page'), null, '_parseLocator ignores the bare page locator');

  // --- Action sentences are written from the tester's point of view, and any
  //     value the tester must supply is split into the Test Data column ---
  const act = (step, isFirst) => tsTab._describeAction(step, isFirst);

  eq(act({ type: 'click', locator: "page.getByRole('button', { name: 'Save' })",
           description: 'Click "Save"', role: 'button' }).action,
     'Click on the "Save" button', 'a click reads as an instruction');

  eq(act({ type: 'click', locator: "page.getByRole('button', { name: 'Save' })",
           description: 'Click "Save"', role: 'button', region: 'the page header' }).action,
     'Click on the "Save" button in the page header',
     'the action says WHERE on the page the control is');

  const navStep = act({ type: 'navigate', url: 'https://example.com/hrms',
                        outcome: { kind: 'screen', heading: 'Dashboard' } }, true);
  eq(navStep.action, 'Launch the browser and open the "Dashboard" page of the application',
     'the opening step reads like the first line of a manual test case');
  eq(navStep.testData, 'https://example.com/hrms',
     'the URL goes in the Test Data column, not the action text');

  const fillStep = act({ type: 'fill', locator: "page.getByLabel('Search Document')",
                         value: 'anand', displayValue: 'anand', role: 'field' });
  eq(fillStep.action, 'Enter the search text in the "Search Document" field',
     'a fill names what the tester types, not the literal value');
  eq(fillStep.testData, 'anand', 'the typed value goes in the Test Data column');

  const emailStep = act({ type: 'fill', locator: "page.getByLabel('Email')",
                          value: 'a@b.com', displayValue: 'a@b.com' });
  eq(emailStep.action, 'Enter the email address in the "Email" field',
     'the field name decides how the instruction is worded');

  eq(act({ type: 'hover', locator: "page.getByRole('link', { name: 'Me' })", role: 'link' }).action,
     'Move the mouse pointer over the "Me" link', 'a hover reads as a physical action');

  eq(act({ type: 'select', locator: "page.getByLabel('Department')",
           value: 'eng', displayValue: 'Engineering' }).testData, 'Engineering',
     'the chosen option goes in the Test Data column');

  // Passwords must never appear in a shared test document
  const pwd = act({
    type: 'fill', locator: "page.getByLabel('Password')",
    value: 'hunter2', displayValue: '•••••••', isPassword: true
  });
  ok(!pwd.action.includes('hunter2') && !pwd.testData.includes('hunter2'),
     'the masked value is used for passwords in both columns');

  // --- Junk labels never reach the document ---
  ok(tsTab._isJunkLabel('Txt'),   'a bare type abbreviation is rejected as a label');
  ok(tsTab._isJunkLabel('svg'),   'an SVG tag name is rejected as a label');
  ok(tsTab._isJunkLabel('Footer Logo Svg S0Fill'),
     'a label built from CSS class soup is rejected');
  ok(!tsTab._isJunkLabel('Leave Policies'), 'a real label is kept');
  eq(tsTab._tidyLabel('projects'), 'Projects',
     'an attribute-derived label is title-cased');
  eq(tsTab._tidyLabel('Leave Policies'), 'Leave Policies',
     'a label that already has capitals is left alone');

  // --- Screen names come from the most specific part of a title ---
  eq(tsTab._cleanScreenName('Me | Timesheet'), 'Timesheet',
     'the app prefix is stripped from a document title');

  // --- Results that follow from the action need no observation ---
  eq(tsTab._implicitExpected({ type: 'fill', locator: "page.getByLabel('Search')",
                               value: 'anand', displayValue: 'anand' }),
     'The value "anand" is entered and displayed in the "Search" field',
     'typing a value has a self-evident expected result');
  eq(tsTab._implicitExpected({ type: 'click', locator: "page.getByLabel('Search')",
                               role: 'field' }),
     'The "Search" field receives focus and the cursor is ready for input',
     'clicking into a field has a self-evident expected result');
  eq(tsTab._implicitExpected({ type: 'click', locator: "page.getByRole('button', { name: 'Save' })",
                               role: 'button' }), null,
     'clicking a button has NO self-evident result — it stays flagged rather than invented');
}

console.log('\n=== 2. BEHAVIOUR: recorder targeting + outcome diffing ===');

const recorderCtx = createSandbox();
loadInto(recorderCtx, 'content/selectors.js');
loadInto(recorderCtx, 'content/recorder.js');
const Rec = recorderCtx.window.PalTechRecorder;

{
  ok(!!Rec && !!Rec.__internals, 'recorder exposes internals for testing');
  const { getInteractiveTarget, isInteractive, diffSnapshots, isSvgNode, outcomeStrength,
          controlForLabel } = Rec.__internals;

  // --- SVG targeting: the "Path120" bug ---
  const navLink = makeFakeElement('a');
  navLink.setAttribute('href', '/organization');
  const svg  = makeFakeElement('svg');
  const path = makeFakeElement('path');
  // Mark the SVG subtree the way the DOM does
  svg.ownerSVGElement  = null;
  path.ownerSVGElement = svg;
  svg.parentElement  = navLink;
  path.parentElement = svg;

  ok(isSvgNode(path), 'isSvgNode detects an element inside an <svg>');
  ok(isSvgNode(svg),  'isSvgNode detects the <svg> itself');
  ok(!isInteractive(path), 'an SVG <path> is never treated as interactive');
  eq(getInteractiveTarget(path), navLink,
     'clicking an icon <path> resolves to the enclosing link, not the path');
  eq(getInteractiveTarget(svg), navLink,
     'clicking the <svg> itself resolves to the enclosing link');

  const plainButton = makeFakeElement('button');
  eq(getInteractiveTarget(plainButton), plainButton,
     'a plain button resolves to itself');

  // --- Two-pass targeting ---
  // <a href="/me"><span class="menu-icon ng-star-inserted"></span>Me</a>
  // Every element reports cursor:pointer, exactly as in a real component app.
  recorderCtx.getComputedStyle = () => ({ cursor: 'pointer' });

  const anchor = makeFakeElement('a');
  anchor.setAttribute('href', '/me');
  const iconSpan = makeFakeElement('span');
  iconSpan.setAttribute('class', 'menu-icon ng-star-inserted');
  iconSpan.parentElement = anchor;

  eq(getInteractiveTarget(iconSpan), anchor,
     'a click on a styled wrapper resolves to the enclosing link, not the wrapper');

  // A genuinely div-based control still resolves, through the styling fallback
  const divControl = makeFakeElement('div');
  eq(getInteractiveTarget(divControl), divControl,
     'a div styled as clickable is still accepted when there is no real control');

  // A landmark role must never swallow the click
  recorderCtx.getComputedStyle = () => ({ cursor: 'auto' });
  const mainRegion = makeFakeElement('div');
  mainRegion.setAttribute('role', 'main');
  const plainSpan = makeFakeElement('span');
  plainSpan.parentElement = mainRegion;
  eq(getInteractiveTarget(plainSpan), plainSpan,
     'a landmark role is not treated as a control');

  const tabDiv = makeFakeElement('div');
  tabDiv.setAttribute('role', 'tab');
  const tabLabel = makeFakeElement('span');
  tabLabel.parentElement = tabDiv;
  eq(getInteractiveTarget(tabLabel), tabDiv,
     'a non-landmark role IS treated as a control');

  // --- Outcome ladder ---
  const base = {
    url: 'https://app/a', title: 'App', heading: 'Employees', breadcrumb: '',
    dialogs: [], alerts: [], list: { count: 10, first: 'Alpha', last: 'Zeta' },
    focus: '', target: null
  };
  const clone = (over) => Object.assign({}, base, over);

  eq(diffSnapshots(base, clone({ dialogs: ['Add Document'] })).kind, 'dialogOpened',
     'a new dialog outranks everything else');
  eq(diffSnapshots(clone({ dialogs: ['Add Document'] }), base).kind, 'dialogClosed',
     'a disappearing dialog is reported as closed');
  eq(diffSnapshots(base, clone({ alerts: ['Saved successfully'] })).kind, 'message',
     'a new toast/alert is reported as a message');

  const screenDiff = diffSnapshots(base, clone({ heading: 'Time Sheet', url: 'https://app/b' }));
  eq(screenDiff.kind, 'screen', 'a heading change is reported as a screen change');
  eq(screenDiff.heading, 'Time Sheet', 'the screen outcome carries the new heading');

  eq(diffSnapshots(base, clone({ list: { count: 3, first: 'Alpha', last: 'Beta' } })).kind,
     'listCountChanged', 'a row-count change is reported as filtering');

  // --- A field being emptied ---
  // The × inside a search box, a chip's remove icon, a Clear or Reset button:
  // all of them empty something, and nothing else in a snapshot could see it.
  // The value's own diff only fires for a value ARRIVING, so the ladder used to
  // fall through to whatever the clearing knocked over — pressing the × in a
  // search box was reported as "the content under Close Icon is hidden".
  // A search box with its own × inside, and a card somewhere else on the page —
  // the shape of every "clear" control there is.
  const searchWrap  = makeFakeElement('div');
  const searchInput = makeFakeElement('input');
  const clearIcon   = makeFakeElement('span');
  searchWrap.children = [searchInput, clearIcon];
  searchInput.parentElement = searchWrap;
  clearIcon.parentElement   = searchWrap;
  const farAwayCard = makeFakeElement('div');

  const filled = clone({ fields: [{ key: 'Search', name: 'Search', filled: true, el: searchInput }] });
  const empty  = clone({ fields: [{ key: 'Search', name: 'Search', filled: false, el: searchInput }] });
  const pressedClear = { target: clearIcon };

  const clearedOutcome = diffSnapshots(filled, empty, pressedClear);
  eq(clearedOutcome.kind, 'valueCleared', 'a field going empty is reported as cleared');
  eq(clearedOutcome.name, 'Search', 'and names the field that was emptied');
  eq(diffSnapshots(filled, empty, { target: searchInput }).kind, 'valueCleared',
     'pressing the field itself counts too — some widgets clear on click');
  eq(diffSnapshots(empty, filled, pressedClear).kind, 'none',
     'a field being FILLED is not a clearing — that is the fill step’s own business');

  // It outranks everything the clearing knocks over, because those are its
  // consequences: the results list shrinking back, the suggestions closing,
  // the page getting shorter.
  eq(diffSnapshots(filled, Object.assign({}, empty, {
       list: { count: 40, first: 'Alpha', last: 'Zeta' },
       panels: [], page: { h: 600, y: 0 }
     }), pressedClear).kind, 'valueCleared',
     'clearing the field is the outcome, not the list rebounding to 40 rows');

  // --- But it must never steal another step's outcome ---
  // An autocomplete resets its search box when a suggestion is picked. The
  // click that picked it opened a details card, and THAT is its outcome; the
  // box being reset is not something that click did to that box.
  eq(diffSnapshots(filled, Object.assign({}, empty, {
       panels: ['Employee details'], list: { count: 10, first: 'Alpha', last: 'Zeta' }
     }), { target: farAwayCard }).kind, 'panelOpened',
     'a click elsewhere is credited with what IT did, not with the box that reset');

  // Typing is never a clearing. The same reset lands inside the fill's own
  // measurement window, and reported "Enter the search text" as "the field is
  // cleared and is empty" — the opposite of what the step did.
  eq(diffSnapshots(filled, empty, { target: searchInput, actionType: 'fill' }).kind,
     'none', 'a fill step is never reported as clearing the field it filled');

  // But a navigation, a dialog closing or a save all empty fields for reasons
  // of their own, and each is already reported ahead of this.
  eq(diffSnapshots(filled, Object.assign({}, empty, { heading: 'Time Sheet' }), pressedClear).kind,
     'screen', 'a page change still outranks the fields it emptied on the way out');
  eq(diffSnapshots(Object.assign({}, filled, { dialogs: ['Add Document'] }), empty, pressedClear).kind,
     'dialogClosed', 'and so does the dialog whose fields went with it');
  eq(diffSnapshots(filled, Object.assign({}, empty, { alerts: ['Saved successfully'] }), pressedClear).kind,
     'message', 'and so does the confirmation of a save that reset the form');

  // A field that has gone from the page entirely was not cleared — the row it
  // lived in was removed, or the panel holding it closed.
  eq(diffSnapshots(filled, clone({ fields: [] }), pressedClear).kind, 'none',
     'a field that no longer exists is not a field that was cleared');

  eq(diffSnapshots(filled, empty, { target: clearIcon, actionType: 'hover' }).kind,
     'none', 'moving the mouse never clears anything, so a hover is not credited with it');
  eq(diffSnapshots(base, clone({ list: { count: 10, first: 'Zeta', last: 'Alpha' } })).kind,
     'listReordered', 'a first-row change at the same count is reported as re-sorting');

  const expandedDiff = diffSnapshots(
    clone({ target: { expanded: 'false', selected: null, checked: null, active: false, value: '', disabled: false } }),
    clone({ target: { expanded: 'true',  selected: null, checked: null, active: false, value: '', disabled: false } })
  );
  eq(expandedDiff.kind, 'expanded', 'aria-expanded false->true is reported as expanded');

  // URL must be the LAST resort, never chosen when something better is present
  const urlOnly = diffSnapshots(base, clone({ url: 'https://app/b' }));
  eq(urlOnly.kind, 'url', 'a bare URL change falls through to the url outcome');
  ok(diffSnapshots(base, clone({ url: 'https://app/b', heading: 'Time Sheet' })).kind === 'screen',
     'a URL change AND a heading change reports the heading, not the URL');

  eq(diffSnapshots(base, clone({})).kind, 'none',
     'an action that changed nothing reports "none"');

  // --- Content appearing in place (accordions, detail panels) ---
  const withText = clone({ textLength: 500 });
  const moreText = clone({ textLength: 900 });
  eq(diffSnapshots(withText, moreText, { mutatedInsideTarget: true }).kind, 'contentExpanded',
     'text appearing beside the clicked element is reported as content expanding');
  eq(diffSnapshots(moreText, withText, { mutatedInsideTarget: true }).kind, 'contentCollapsed',
     'text disappearing is reported as content collapsing');
  eq(diffSnapshots(withText, moreText, { mutatedInsideTarget: false }).kind, 'none',
     'a text change elsewhere on the page is NOT attributed to this step');

  // --- A page load is not a control being operated ---
  // The empty "before" a navigation is measured against used to fall through
  // the ladder to whatever else had appeared, reporting the act of opening a
  // page as "the menu opens and its options are listed".
  const emptyBefore = {
    url: '', title: '', heading: '', breadcrumb: '',
    dialogs: [], alerts: [], panels: [], list: { count: 0, first: '', last: '' },
    focus: '', target: null
  };
  const loaded = clone({ url: 'https://app/dashboard', panels: ['Control Room'] });
  eq(diffSnapshots(emptyBefore, loaded, { actionType: 'navigate' }).kind, 'screen',
     'a navigation that rendered its heading is reported as a screen');
  eq(diffSnapshots(emptyBefore, clone({ url: 'https://app/dashboard', heading: '', title: '',
                                        panels: ['Control Room'] }),
                   { actionType: 'navigate' }).kind, 'url',
     'a navigation with no heading yet reports the URL, never a panel opening');
  eq(diffSnapshots(emptyBefore, clone({ url: '', heading: '', title: '' }),
                   { actionType: 'navigate' }).kind, 'none',
     'a navigation with nothing to show reports none');

  // --- A label resolves to the control it operates ---
  // Otherwise a click on a checkbox's label is recorded as its own step, and
  // the click that the browser forwards to the checkbox becomes a second one.
  const checkbox = makeFakeElement('input');
  checkbox.setAttribute('type', 'checkbox');
  const cbLabel = makeFakeElement('label');
  cbLabel.control = checkbox;          // what the browser itself reports
  const labelText = makeFakeElement('span');
  labelText.parentElement = cbLabel;

  eq(controlForLabel(cbLabel), checkbox, 'a label resolves to the control it operates');
  eq(controlForLabel(checkbox), null, 'a control is not a label');
  eq(getInteractiveTarget(cbLabel), checkbox,
     'clicking the label targets the checkbox, so the click is not recorded twice');
  eq(getInteractiveTarget(labelText), checkbox,
     'clicking the text inside the label targets the checkbox too');

  const forLabel = makeFakeElement('label');
  forLabel.setAttribute('for', 'nothing-here');
  eq(getInteractiveTarget(forLabel), forLabel,
     'a label pointing at nothing is left as itself rather than dropped');

  // --- Signals for changes that add no text and no nodes ---
  // A submenu toggled with CSS changes no text (textContent counts hidden text
  // too) and adds no nodes, so only geometry and selection marks can see it.
  const marked = clone({ marks: ['Reports'] });
  eq(diffSnapshots(clone({ marks: [] }), marked).kind, 'selectionChanged',
     'a nav item being marked current is reported as a selection change');
  eq(diffSnapshots(clone({ marks: [] }), marked, { actionType: 'hover' }).kind, 'none',
     'the same mark is NOT credited to a hover');

  const boxed  = { h: 20, w: 100, ph: 40,  pw: 200 };
  const opened = { h: 20, w: 100, ph: 260, pw: 200 };
  eq(diffSnapshots(clone({ box: boxed }), clone({ box: opened })).kind, 'contentExpanded',
     'a container growing under the clicked control is reported as content appearing');
  eq(diffSnapshots(clone({ box: opened }), clone({ box: boxed })).kind, 'contentCollapsed',
     'the same container shrinking is reported as content hiding');

  const shortPage = clone({ page: { h: 1000, y: 0 } });
  eq(diffSnapshots(shortPage, clone({ page: { h: 1600, y: 0 } })).kind, 'contentExpanded',
     'the page itself getting taller is reported, at the bottom of the ladder');
  eq(diffSnapshots(shortPage, clone({ page: { h: 1000, y: 800 } })).kind, 'scrolled',
     'a click that scrolled the page is reported as a scroll');
  eq(diffSnapshots(shortPage, clone({ page: { h: 1000, y: 800 } }), { actionType: 'scroll' }).kind,
     'none', 'the tester scrolling is not reported as an outcome of their own scroll');
  eq(diffSnapshots(shortPage, clone({ page: { h: 1600, y: 0 }, heading: 'Time Sheet' })).kind,
     'screen', 'a page that got taller AND changed heading reports the heading');

  // --- Outcome strength decides whether a late re-check corrects a step ---
  ok(outcomeStrength({ kind: 'screen' }) > outcomeStrength({ kind: 'panelOpened' }),
     'a screen outranks a panel opening, so a slow render corrects an early read');
  ok(outcomeStrength({ kind: 'panelOpened' }) > outcomeStrength({ kind: 'url' }),
     'a panel opening outranks a bare URL change');
  ok(outcomeStrength({ kind: 'url' }) > outcomeStrength({ kind: 'none' }),
     'anything observed outranks nothing observed');
}

// -----------------------------------------------------------------------------
// 2. BEHAVIOUR: shadow.js  (web components)
//
// The bug this covers: a chat widget mounted in a shadow root recorded three
// different buttons as three identical steps, all named after the component's
// host element, all with a flagged Expected Result. Events are retargeted to
// the host, parentElement dead-ends at the boundary, document queries never
// descend, and a MutationObserver sees none of it.
// -----------------------------------------------------------------------------

console.log('\n=== 2. BEHAVIOUR: shadow.js (web components) ===');

const shadowCtx = createSandbox();
const KIT = makeDomKit(shadowCtx);
{
  // A page with one web component in it, the shape the chat widget has:
  //   body > div#chat-host  --shadow-->  div.cw_window > button[aria-label]
  const body    = KIT.el('body');
  const header  = KIT.el('header', { class: 'page-header' });
  const outside = KIT.el('button', { 'aria-label': 'Search' }, 'Search');
  KIT.add(body, header);
  KIT.add(header, outside);

  const host = KIT.el('div', { id: 'chat-host' });
  KIT.add(body, host);
  const root = KIT.attachShadow(host);

  const win = KIT.el('div', { class: 'cw_window', role: 'dialog', 'aria-label': 'Chat Support' });
  KIT.addToRoot(root, win);

  const guidelines = KIT.el('button', { class: 'cw_quickLink' }, 'Guidelines');
  const handbook   = KIT.el('a', { class: 'cw_handbook', href: '/policies' }, 'Handbook');
  KIT.add(win, guidelines);
  KIT.add(win, handbook);

  KIT.install(body);
  loadInto(shadowCtx, 'content/selectors.js');
  loadInto(shadowCtx, 'content/shadow.js');
  const S = shadowCtx.window.PalTechShadow;
  ok(!!S, 'shadow.js exposes PalTechShadow');
  S.resetCache();

  // --- The click target -----------------------------------------------------
  // This is the whole bug: the browser rewrites target to the host, so every
  // click inside the widget looked like the same element.
  const retargeted = KIT.event([guidelines, win, host, body]);
  eq(retargeted.target, host, 'the browser retargets the event to the host (the old reading)');
  eq(S.deepTarget(retargeted), guidelines,
     'deepTarget reads composedPath and returns the button actually clicked');
  eq(S.deepTarget(KIT.event([handbook, win, host, body])), handbook,
     'so a second control in the same component is a DIFFERENT step');
  eq(S.deepTarget({ target: outside }), outside,
     'an event with no composedPath falls back to target');
  eq(S.deepTarget(null), null, 'and no event is no target');

  // --- The tree is walkable across the boundary ------------------------------
  eq(win.parentElement, null, 'parentElement is null at a shadow boundary (the old dead end)');
  eq(S.flatParent(win), host, 'flatParent hops from the root to the component host');
  eq(S.flatParent(guidelines), win, 'and behaves normally inside the root');
  eq(S.flatParent(host), body, 'and normally outside it');
  ok(S.flatAncestors(guidelines).indexOf(body) >= 0,
     'the ancestor walk reaches the page body from inside a component');

  eq(S.deepClosest(guidelines, '[role="dialog"]'), win,
     'deepClosest finds the dialog the control sits in');
  eq(S.deepClosest(guidelines, 'div#chat-host'), host,
     'and keeps going past the boundary to the host');
  eq(S.deepClosest(guidelines, 'nav'), null, 'with nothing matching it returns null');

  // --- Root identity --------------------------------------------------------
  ok(S.inShadow(guidelines), 'a control inside a component reports as in shadow');
  ok(!S.inShadow(outside), 'and one in the page does not');
  eq(S.rootOf(guidelines), root, 'rootOf returns the shadow root, which is the query scope');
  eq(S.hostChain(guidelines).length, 1, 'the host chain is one component deep');
  eq(S.hostChain(guidelines)[0], host, 'and it names the host');
  eq(S.hostChain(outside).length, 0, 'page content has no host chain');

  // --- Queries descend ------------------------------------------------------
  S.resetCache();
  eq(shadowCtx.document.querySelectorAll('button').length, 1,
     'document sees only the page button — a root is invisible to it');
  eq(S.queryAll('button').length, 2,
     'queryAll sees the component button too, which is what Playwright sees');
  eq(S.count('button.cw_quickLink'), 1,
     'and counting a component selector no longer returns zero');
  eq(S.queryAll('[role="dialog"]').length, 1,
     'the dialog inside the component is measurable, so opening it is an outcome');
  ok(S.textLength() > (body.textContent || '').length,
     'page text includes component content, so rendering one is a detectable change');

  // --- Focus ----------------------------------------------------------------
  shadowCtx.document.activeElement = host;
  root.activeElement = guidelines;
  eq(S.activeElement(), guidelines, 'focus is followed into the component');
  root.activeElement = null;
  eq(S.activeElement(), host, 'and stops where the trail ends');

  // --- Addressing it in a test ----------------------------------------------
  const pierce = S.piercePath(guidelines);
  ok(/^css=div#chat-host >> css=/.test(pierce),
     'piercePath addresses the component first, then the control inside it');
  eq(S.piercePath(outside), '', 'page content needs no pierce path');

  // --- Being honest about a closed root -------------------------------------
  // A closed root cannot be read at all, and composedPath stops at the host.
  // The signature is a host that renders something but exposes nothing.
  const closedHost = KIT.el('div', { id: 'opaque-widget' });
  KIT.add(body, closedHost);
  closedHost._w = 60; closedHost._h = 60;
  ok(S.looksOpaque(closedHost),
     'a sized element with no children, text or label is a component we cannot read');
  ok(!S.looksOpaque(host), 'an OPEN component is readable, so it is not opaque');
  ok(!S.looksOpaque(outside), 'a labelled button is never opaque');
  const emptyInput = KIT.el('input', { placeholder: 'Search' });
  KIT.add(body, emptyInput);
  emptyInput._w = 200; emptyInput._h = 30;
  ok(!S.looksOpaque(emptyInput), 'an <input> is legitimately empty and perfectly describable');

  // --- XPath is not an option inside a component ----------------------------
  const Sel = shadowCtx.window.PalTechSelectors;
  eq(Sel.getRelativeXpath(guidelines), null,
     'no XPath is offered for shadow content — none can ever resolve there');

  // --- A selector for the control resolves in ITS OWN root ------------------
  const css = Sel.getCssSelector(guidelines);
  ok(!!css, 'a component control still gets a CSS selector');
  eq(root.querySelectorAll(css).length, 1,
     'and it matches exactly one element inside the component');
}

// The recorder has to USE all of the above, not merely have it available.
console.log('\n=== 2. BEHAVIOUR: recorder inside web components ===');

const recShadowCtx = createSandbox();
const KIT2 = makeDomKit(recShadowCtx);
{
  const body = KIT2.el('body');
  const host = KIT2.el('div', { id: 'chat-host' });
  KIT2.add(body, host);
  const root = KIT2.attachShadow(host);

  const wrap = KIT2.el('div', { class: 'cw_inputRow' });
  KIT2.addToRoot(root, wrap);

  const button = KIT2.el('button', { 'aria-label': 'Send message' });
  const icon   = KIT2.el('svg');
  const line   = KIT2.el('path');
  KIT2.add(wrap, button);
  KIT2.add(button, icon);
  KIT2.add(icon, line);
  icon.ownerSVGElement = null;
  line.ownerSVGElement = icon;

  KIT2.install(body);
  loadInto(recShadowCtx, 'content/shadow.js');
  loadInto(recShadowCtx, 'content/selectors.js');
  loadInto(recShadowCtx, 'content/recorder.js');
  const R = recShadowCtx.window.PalTechRecorder;
  const { getInteractiveTarget } = R.__internals;

  // Clicking the icon inside a button inside a component: two boundaries at
  // once, the SVG jump and the shadow boundary.
  eq(getInteractiveTarget(line), button,
     'an icon click inside a component resolves to that component\u2019s button');
  eq(getInteractiveTarget(button), button,
     'and the button itself resolves to itself');
}

// -----------------------------------------------------------------------------
// 2. BEHAVIOUR: when a typed value becomes a step
//
// A fill is only emitted on blur or Enter, and three ordinary situations mean
// neither ever happens: Stop pressed with the cursor still in the field, a
// control that keeps focus on the field it acts on (chat and search widgets do
// this deliberately), and a focused field removed with the dialog around it.
// The value was lost in all three, and the click that followed then reported
// the typed text as ITS own result.
// -----------------------------------------------------------------------------

console.log('\n=== 2. BEHAVIOUR: when a typed value becomes a step ===');

const fillCtx = createSandbox();
const KIT3 = makeDomKit(fillCtx);
{
  const body  = KIT3.el('body');
  const input = KIT3.el('input', { 'aria-label': 'Message', placeholder: 'Type your message' });
  const send  = KIT3.el('button', { 'aria-label': 'Send message' }, 'Send');
  KIT3.add(body, input);
  KIT3.add(body, send);
  KIT3.install(body);

  // Outcome measurement runs on timers; nothing here waits for it, and a live
  // timer would keep the test process alive for its full 9-second re-check.
  fillCtx.setTimeout  = () => 0;
  fillCtx.clearTimeout = () => {};
  fillCtx.getComputedStyle = () => ({ cursor: 'auto' });

  loadInto(fillCtx, 'content/shadow.js');
  loadInto(fillCtx, 'content/elementNaming.js');
  loadInto(fillCtx, 'content/playwright.js');
  loadInto(fillCtx, 'content/selectors.js');
  loadInto(fillCtx, 'content/recorder.js');

  const steps = [];
  fillCtx.chrome.runtime.sendMessage = (msg) => {
    if (msg && msg.action === 'stepRecorded') steps.push(msg.step);
    return Promise.resolve();
  };

  const R = fillCtx.window.PalTechRecorder;
  const H = R.__internals;
  const ev = (target, extra) => Object.assign(
    { target, composedPath: () => [target], preventDefault() {}, stopPropagation() {} },
    extra || {}
  );
  const fills = () => steps.filter(st => st.type === 'fill');
  const presses = () => steps.filter(st => st.type === 'press');

  R.start();
  ok(R.isActive(), 'the recorder is running for these cases');

  // --- The ordinary path still works ---------------------------------------
  input.value = 'hello';
  H.handleInput(ev(input));
  H.handleBlur(ev(input));
  eq(fills().length, 1, 'a value typed and blurred is recorded');
  eq(fills()[0].value, 'hello', 'with what was typed');

  // --- Re-entering the SAME value is a second step -------------------------
  // The guard that stops Enter and blur double-emitting one entry used to last
  // for the life of the page: search "hello", clear it, search "hello" again,
  // and the second search was silently dropped.
  input.value = 'hello';
  H.handleInput(ev(input));
  H.handleBlur(ev(input));
  eq(fills().length, 2, 'typing the same value again in a new run is recorded again');

  // --- ...but Enter and blur together are still ONE step -------------------
  input.value = 'once';
  H.handleInput(ev(input));
  H.handleKeydown(ev(input, { key: 'Enter', ctrlKey: false, metaKey: false, altKey: false }));
  H.handleBlur(ev(input));
  eq(fills().filter(f => f.value === 'once').length, 1,
     'Enter emits the value and blur does not emit it a second time');

  // --- A control that keeps focus no longer swallows the value -------------
  // Nothing blurs the field here, which is exactly what a chat widget's Send
  // button does.
  const before = fills().length;
  input.value = 'kept focus';
  H.handleInput(ev(input));
  H.handleClick(ev(send));
  eq(fills().length, before + 1,
     'clicking a control that keeps focus flushes the typed value first');
  const flushed = fills()[fills().length - 1];
  eq(flushed.value, 'kept focus', 'and the step carries the value');
  ok(steps.indexOf(flushed) < steps.length - 1,
     'the typing is recorded BEFORE the click, which is the order it happened in');

  // --- Tab is a step of its own --------------------------------------------
  H.handleKeydown(ev(input, { key: 'Tab', ctrlKey: false, metaKey: false, altKey: false }));
  const lastPress = presses()[presses().length - 1];
  eq(lastPress && lastPress.value, 'Tab',
     'Tab is recorded — "press Tab to move to the next field" is an instruction');

  // --- Stop must not lose what is still in the field -----------------------
  const beforeStop = fills().length;
  input.value = 'typed then stopped';
  H.handleInput(ev(input));
  R.stop();
  eq(fills().length, beforeStop + 1,
     'a value still being typed when Stop is pressed is recorded, not lost');
  eq(fills()[fills().length - 1].value, 'typed then stopped',
     'and it is the value that was on screen');
  ok(!R.isActive(), 'and the recorder has stopped');
}

// -----------------------------------------------------------------------------
// 2. BEHAVIOUR: a press that never becomes a click
//
// Search for something, pick a result from the dropdown it offers, and the
// result click was missing from the recording. An autocomplete commits on
// MOUSEDOWN and closes its list there — it has to, because touching the list
// blurs the input and blur would close it — so the item is gone by mouseup and
// the browser never dispatches a click at all. The recording held the field
// click and the typed value (both from events that did fire) and nothing for
// the result the tester actually chose.
// -----------------------------------------------------------------------------

console.log('\n=== 2. BEHAVIOUR: a press that never becomes a click ===');

const pressCtx = createSandbox();
const KIT4 = makeDomKit(pressCtx);
{
  const body   = KIT4.el('body');
  const search = KIT4.el('input', { 'aria-label': 'Search', placeholder: 'Search…' });
  const list   = KIT4.el('ul', { role: 'listbox' });
  const option = KIT4.el('li', { role: 'option' }, 'Timesheet Outlier Report');
  const plain  = KIT4.el('div', { class: 'page-body' }, 'just text');
  KIT4.add(body, search);
  KIT4.add(body, list);
  KIT4.add(list, option);
  KIT4.add(body, plain);
  KIT4.install(body);

  // A clock we drive by hand: the fallback is a timer, and the point of every
  // case below is what happens before or after it fires.
  const timers = [];
  pressCtx.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  pressCtx.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  const tick = () => timers.splice(0).forEach(t => { if (t.fn) { try { t.fn(); } catch (e) {} } });
  pressCtx.getComputedStyle = () => ({ cursor: 'auto' });

  loadInto(pressCtx, 'content/shadow.js');
  loadInto(pressCtx, 'content/elementNaming.js');
  loadInto(pressCtx, 'content/playwright.js');
  loadInto(pressCtx, 'content/selectors.js');
  loadInto(pressCtx, 'content/recorder.js');

  const steps = [];
  pressCtx.chrome.runtime.sendMessage = (msg) => {
    if (msg && msg.action === 'stepRecorded') steps.push(msg.step);
    return Promise.resolve();
  };

  const R = pressCtx.window.PalTechRecorder;
  const H = R.__internals;
  const ev = (target, extra) => Object.assign(
    { target, button: 0, composedPath: () => [target], preventDefault() {}, stopPropagation() {} },
    extra || {}
  );
  const clicks = () => steps.filter(st => st.type === 'click');

  R.start();
  tick();                                   // let start()'s own timers go

  // --- The case that was silently dropped ----------------------------------
  let before = clicks().length;
  H.handleMouseDown(ev(option));
  eq(clicks().length, before, 'a press alone records nothing yet — a click may still come');
  H.handleMouseUp(ev(option));
  eq(clicks().length, before, 'and nothing on release either, until the wait is up');
  tick();
  eq(clicks().length, before + 1,
     'with no click following, the press IS the step: the option was removed under the pointer');
  eq(clicks()[clicks().length - 1].locator.indexOf('page.') === 0, true,
     'and it carries a real locator for the option');

  // --- A press followed by its click is ONE step ---------------------------
  before = clicks().length;
  H.handleMouseDown(ev(option));
  H.handleMouseUp(ev(option));
  H.handleClick(ev(option));
  tick();
  eq(clicks().length, before + 1, 'a press and the click it produced are one step, not two');

  // --- A SLOW click is still one step --------------------------------------
  // The regression that put four identical "Click on the Search field" rows in
  // a recording: the wait used to run from the press, so holding the button
  // down longer than the window recorded the press, and the click that arrived
  // afterwards found no press left to claim and recorded a second row. Nothing
  // is decided until the button comes back up.
  before = clicks().length;
  H.handleMouseDown(ev(option));
  tick();                                   // the tester is still holding it down
  eq(clicks().length, before, 'holding the button down records nothing on its own');
  H.handleMouseUp(ev(option));
  H.handleClick(ev(option));
  tick();
  eq(clicks().length, before + 1,
     'a click held for a while is ONE step, however long it was held');

  // --- ...even when the click lands somewhere else -------------------------
  // The element pressed can be gone by mouseup, and the browser then dispatches
  // the click at a surviving ancestor. That is still one physical press.
  before = clicks().length;
  H.handleMouseDown(ev(option));
  H.handleMouseUp(ev(list));
  H.handleClick(ev(list));
  tick();
  eq(clicks().length, before + 1,
     'a click on an ancestor still accounts for the press that preceded it');

  // --- A drag is not a click -----------------------------------------------
  before = clicks().length;
  H.handleMouseDown(ev(option));
  H.handleDragstart(ev(option));
  H.handleMouseUp(ev(option));
  tick();
  eq(clicks().length, before, 'a press that turns into a drag records no click');

  // --- Only controls -------------------------------------------------------
  // Dragging a scrollbar or selecting text never ends in a click on what was
  // pressed either, and must not invent a step for it.
  before = clicks().length;
  H.handleMouseDown(ev(plain));
  H.handleMouseUp(ev(plain));
  tick();
  eq(clicks().length, before, 'a press on ordinary page content is not a step');

  // --- Only the primary button ---------------------------------------------
  before = clicks().length;
  H.handleMouseDown(ev(option, { button: 2 }));
  H.handleMouseUp(ev(option, { button: 2 }));
  tick();
  eq(clicks().length, before, 'a right-click press is left to the contextmenu handler');

  // --- Stopping cancels a press in flight ----------------------------------
  before = clicks().length;
  H.handleMouseDown(ev(option));
  H.handleMouseUp(ev(option));
  R.stop();
  tick();
  eq(clicks().length, before, 'a press outstanding when Stop is pressed is dropped, not recorded late');
}

// -----------------------------------------------------------------------------
// 2. BEHAVIOUR: naming a control that wraps a whole card
//
// An org-tree node is one <a> around four lines of information: a person's
// name, their job title, their department, where they sit. getVisibleName took
// the element's whole textContent and cut it at 60 characters, so the step read
//   Click on the "Nikhila Marupally Software Engineer Quality Engineering
//   Equi" link
// and the expected result quoted that same blob as the name of a page. The
// guard against exactly this already existed in ownShortText (bail above eight
// descendants or forty characters) — being on the tag whitelist skipped it.
// -----------------------------------------------------------------------------

console.log('\n=== 2. BEHAVIOUR: naming a control that wraps a whole card ===');

const cardCtx = createSandbox();
const KIT5 = makeDomKit(cardCtx);
{
  const body = KIT5.el('body');

  // The card: a link wrapping a heading and three lines of detail
  const card  = KIT5.el('a', { href: '/employee/1950' });
  const name  = KIT5.el('h4', {}, 'Nikhila Marupally');
  const role  = KIT5.el('div', {}, 'Software Engineer');
  const dept  = KIT5.el('div', {}, 'Quality Engineering');
  const site  = KIT5.el('span', {}, 'Equinox');
  KIT5.add(body, card);
  [name, role, dept, site].forEach(el => KIT5.add(card, el));

  // An ordinary nav link, which is what every earlier recording clicked
  const navLink = KIT5.el('a', { href: '/me' }, 'Me');
  KIT5.add(body, navLink);

  // A card with no heading element at all — just a stack of divs
  const plainCard = KIT5.el('li', {});
  const firstLine = KIT5.el('div', {}, 'Sravani Kanchamreddy');
  const secondLine = KIT5.el('div', {}, 'Engineering Manager, Quality Engineering, Equinox');
  KIT5.add(body, plainCard);
  KIT5.add(plainCard, firstLine);
  KIT5.add(plainCard, secondLine);

  // A card with nothing to narrow to: one long run of text, no children
  const blobLink = KIT5.el('a', { href: '/n' },
    'Poojitha Yerukala Associate Software Engineer G1 Quality Engineering Equinox K89');
  KIT5.add(body, blobLink);

  KIT5.install(body);
  cardCtx.getComputedStyle = () => ({ cursor: 'auto' });

  loadInto(cardCtx, 'content/shadow.js');
  loadInto(cardCtx, 'content/elementNaming.js');
  loadInto(cardCtx, 'content/playwright.js');
  loadInto(cardCtx, 'content/selectors.js');
  loadInto(cardCtx, 'content/recorder.js');
  const N = cardCtx.window.PalTechRecorder.__internals;

  // --- Short text is still the name, exactly as before --------------------
  eq(N.getVisibleName(navLink), 'Me',
     'a nav link is named by its own text, which is what it always was');

  // --- A card is named by its heading -------------------------------------
  eq(N.getVisibleName(card), 'Nikhila Marupally',
     'a card link is named by its heading, not by everything inside it');
  eq(N.headlineText(card), 'Nikhila Marupally', 'which is what headlineText finds');
  ok(!/Quality Engineering/.test(N.getVisibleName(card)),
     'the job title and department are not part of the name');
  ok(!/Equi$/.test(N.getVisibleName(card)),
     'and nothing is cut off in the middle of a word');

  // --- No heading: the first short line of the stack ----------------------
  eq(N.getVisibleName(plainCard), 'Sravani Kanchamreddy',
     'with no heading element the first short line names the card');

  // --- Nothing to narrow to: cut on a word boundary -----------------------
  const blobName = N.getVisibleName(blobLink);
  ok(blobName.length <= 61, 'a card with nothing to narrow to is still cut to a readable length');
  ok(/…$/.test(blobName), 'and says so, rather than pretending to be complete');
  ok(!/\bEqui$|\bAssocia$|\bQualit$/.test(blobName),
     'the cut lands between words, never inside one');

  // --- The cutter itself --------------------------------------------------
  eq(N.trimToWords('Short name', 60), 'Short name', 'a short name is untouched');
  eq(N.trimToWords('Nikhila Marupally Software Engineer Quality Engineering Equinox', 60),
     'Nikhila Marupally Software Engineer Quality Engineering…',
     'a long one is cut at the last whole word');
  eq(N.trimToWords('Averyverylongsinglewordwithnospacesatallanywhereinit', 20),
     'Averyverylongwordwit…'.replace('Averyverylongwordwit', 'Averyverylongsinglew'),
     'a single unbroken word is cut where it must be');
}

console.log('\n=== 2. BEHAVIOUR: expected results + noise removal ===');

{
  const T = tsTab; // loaded above

  // --- Outcome -> English ---
  const say = (outcome, step) => T._outcomeToEnglish(outcome, step || { locator: 'page' });
  eq(say({ kind: 'screen', heading: 'Time Sheet' }), 'The "Time Sheet" page is displayed',
     'screen outcome reads as a page being displayed');
  eq(say({ kind: 'dialogOpened', title: 'Add Document' }), 'The "Add Document" dialog opens',
     'dialog outcome names the dialog');
  eq(say({ kind: 'message', text: 'Saved successfully' }),
     'The message "Saved successfully" is displayed', 'message outcome quotes the text');
  eq(say({ kind: 'url', url: 'https://app/hrms/me/time-sheet?x=1' }),
     'The /hrms/me/time-sheet page is displayed',
     'a bare URL change is reported as a page, not as an address bar value');
  eq(say({ kind: 'url', url: 'https://app/hrms/me/time-sheet?x=1', samePath: true }),
     'The /hrms/me/time-sheet page reloads with the updated parameters',
     'a query-only change is reported as a reload, not as a new page');
  eq(say({ kind: 'none' }), null, 'a "none" outcome yields no sentence');

  const filterStep = { locator: "page.getByLabel('Search Document')", type: 'fill', value: 'ananda', displayValue: 'ananda' };
  eq(say({ kind: 'listCountChanged', from: 40, to: 3 }, filterStep),
     'The list filters to 3 results matching "ananda"',
     'a row-count change after typing reads as a filter result');

  // --- Noise removal + navigation folding, on a replica of the reported flow ---
  const t0 = 1000;
  T.steps = [
    { id: 1, ts: t0,       type: 'navigate', url: 'https://apps.pal.tech/hrms/dashboard', locator: 'page',
      outcome: { kind: 'screen', heading: 'Dashboard' } },
    { id: 2, ts: t0 + 500, type: 'click', locator: "page.getByRole('link', { name: 'Home' })",
      description: 'Click "Home"', outcome: { kind: 'none' } },
    // hover fired AFTER the click on the same element - pure mouse travel
    { id: 3, ts: t0 + 900, type: 'hover', locator: "page.getByRole('link', { name: 'Home' })",
      description: 'Hover over "Home"', outcome: { kind: 'none' } },
    { id: 4, ts: t0 + 2000, type: 'click', locator: "page.getByRole('link', { name: 'Me' })",
      description: 'Click "Me"', outcome: { kind: 'none' } },
    // two navigations caused by that one click - the app appends a default query
    { id: 5, ts: t0 + 2200, type: 'navigate', url: 'https://apps.pal.tech/hrms/me/time-sheet', locator: 'page',
      outcome: { kind: 'screen', heading: 'Time Sheet' } },
    { id: 6, ts: t0 + 2400, type: 'navigate', url: 'https://apps.pal.tech/hrms/me/time-sheet?timesheetDate=2026-09-03',
      locator: 'page', outcome: { kind: 'screen', heading: 'Time Sheet' } }
  ];

  const prepared = T._prepareSteps();
  eq(prepared.length, 3,
     '6 recorded steps collapse to 3 real steps (hover dropped, 2 navigations folded)');
  ok(!prepared.some(v => v.step.type === 'hover'),
     'the hover that changed nothing and duplicated a click is removed');
  eq(prepared[0].action, 'Launch the browser and open the "Dashboard" page of the application',
     'the opening navigation is kept as a real step');
  eq(prepared[0].testData, 'https://apps.pal.tech/hrms/dashboard',
     'the opening URL is carried in the Test Data column');
  eq(prepared[0].expected, 'The "Dashboard" page is displayed',
     'the opening navigation gets the screen it landed on as its expected result');
  eq(prepared[2].action, 'Click on the "Me" link',
     'the click on Me survives');
  eq(prepared[2].expected, 'The "Time Sheet" page is displayed',
     'the navigation it caused becomes its expected result, named by heading not URL');
  ok(prepared[1].flagged,
     'a click with no detectable change is flagged for manual completion');
  ok(prepared[1].inferred,
     'and is marked as inferred, because the sentence was read off the control');

  // --- A component the recorder could not see into says so ---
  // A closed shadow root cannot be read from outside, so there is nothing to
  // describe and nothing to infer: the host has no label of its own. Guessing
  // from the wrapper is what produced three identical rows for three different
  // buttons, so the row states the real problem instead.
  const opaqueExp = T._expectedFor({
    step: { id: 900, type: 'click', locator: "page.locator('#chat-host')",
            tagName: 'div', opaque: true, outcome: { kind: 'none' } }
  });
  ok(opaqueExp.flagged, 'a step inside an unreadable component is flagged');
  ok(/component the recorder cannot read/.test(opaqueExp.text),
     'and says that is why, rather than "no page change was detected"');
  const seenExp = T._expectedFor({
    step: { id: 901, type: 'click', locator: "page.locator('#other')",
            tagName: 'div', outcome: { kind: 'none' } }
  });
  ok(!/cannot read/.test(seenExp.text),
     'an ordinary step with no outcome keeps the ordinary wording');


  // --- Clicking a field and typing into it are two instructions ------------
  // This is the shape the chat widget produced: click the message box, type,
  // press Send. The click used to be deleted in favour of the fill; now both
  // rows stand, and the click must NOT claim the typed value as its result.
  const stepsBeforeSplit = T.steps;
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByLabel('Message')",
      role: 'field', region: 'the "Assistant" dialog',
      // measured while the tester was typing INTO the field
      outcome: { kind: 'valueSet', value: 'an' } },
    { id: 2, ts: 3000, startedAt: 1200, type: 'fill', locator: "page.getByLabel('Message')",
      value: 'an', displayValue: 'an', role: 'field',
      outcome: { kind: 'none' } },
    { id: 3, ts: 3200, type: 'click', locator: "page.getByLabel('Send message')",
      role: 'button', region: 'the "Assistant" dialog',
      outcome: { kind: 'message', text: 'Here is your profile information' } }
  ];
  const split = T._prepareSteps();
  eq(split.length, 3, 'click, type and send are three rows');
  eq(split[0].action, 'Click on the "Message" field in the "Assistant" dialog',
     'the click that puts the cursor in the field survives');
  eq(split[0].expected,
     'The "Message" field receives focus and the cursor is ready for input',
     'and its result is the cursor arriving \u2014 NOT the text typed afterwards');
  ok(!/contains/.test(split[0].expected),
     'the value typed next is never reported as the click\u2019s own outcome');
  eq(split[1].action, 'Enter the value in the "Message" field',
     'the typing is a step of its own');
  eq(split[1].testData, 'an', 'carrying the value in the Test Data column');
  eq(split[2].action, 'Click on the "Send message" button in the "Assistant" dialog',
     'and pressing Send is the third');

  // Ticking a checkbox stays ONE step: clicking the label IS how it is ticked
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByText('I agree to the terms')",
      role: 'label', outcome: { kind: 'none' } },
    { id: 2, ts: 1100, type: 'check', locator: "page.getByLabel('I agree to the terms')",
      value: 'true', role: 'checkbox', outcome: { kind: 'checked' } }
  ];
  eq(T._prepareSteps().length, 1,
     'a label click and the box it ticks are one physical action, so one row');

  // A step arriving just after Stop is still accepted: it is the value that was
  // still in a field when the tester pressed Stop, which no blur will report.
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByLabel('Search')",
      role: 'field', outcome: { kind: 'focused' } }
  ];
  T.isRecording = false;
  T._stoppedAt = Date.now();
  const lateAccepted = !T.isRecording && T._stoppedAt &&
    (Date.now() - T._stoppedAt) <= T.constructor.LATE_STEP_MS;
  ok(lateAccepted, 'a step is still accepted for a moment after recording stops');
  T._stoppedAt = Date.now() - (T.constructor.LATE_STEP_MS + 500);
  const staleRejected = !(!T.isRecording && T._stoppedAt &&
    (Date.now() - T._stoppedAt) <= T.constructor.LATE_STEP_MS);
  ok(staleRejected, 'but not indefinitely — a stale recorder cannot append later');
  T.steps     = stepsBeforeSplit;   // the tests below build on the recording above
  T._stoppedAt = 0;


  // --- Clicking a field that already has the cursor is not a second step ---
  // A recording of a search box held four consecutive "Click on the Search
  // field" rows. Two came from a duplicate the recorder has since stopped
  // producing; the other two were a field clicked twice, and each measured
  // "the field receives focus" — true both times, and an instruction only once.
  const stepsBeforeRepeat = T.steps;
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByLabel('Search')",
      role: 'field', region: 'the page header',
      outcome: { kind: 'focused', label: 'Search' } },
    { id: 2, ts: 1400, type: 'click', locator: "page.getByLabel('Search')",
      role: 'field', region: 'the page header',
      outcome: { kind: 'focused', label: 'Search' } }
  ];
  eq(T._prepareSteps().length, 1,
     'clicking a field that is already focused adds no row');

  // A control clicked twice with a REAL result each time keeps both rows: two
  // presses of a toggle are two instructions, and the results differ.
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByRole('button', { name: 'Filters' })",
      role: 'button', outcome: { kind: 'expanded' } },
    { id: 2, ts: 1400, type: 'click', locator: "page.getByRole('button', { name: 'Filters' })",
      role: 'button', outcome: { kind: 'collapsed' } }
  ];
  eq(T._prepareSteps().length, 2,
     'but a toggle opened and then closed is still two instructions');
  T.steps = stepsBeforeRepeat;

  // --- Search, then pick a result from the list it offers ------------------
  // The whole sequence, as the recorder now produces it: the field click, the
  // typed value (emitted on blur, dated to when typing began), the result
  // pressed in the dropdown (recorded from the press, because the widget
  // removed it on mousedown and no click was ever dispatched), and the
  // navigation that press caused.
  const stepsBeforeSearch = T.steps;
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByLabel('Search')",
      role: 'field', outcome: { kind: 'focused', label: 'Search' } },
    { id: 2, ts: 2600, startedAt: 1200, type: 'fill', locator: "page.getByLabel('Search')",
      value: 'outlier', displayValue: 'outlier', role: 'field',
      outcome: { kind: 'listCountChanged', from: 0, to: 4 } },
    { id: 3, ts: 2650, type: 'click',
      locator: "page.getByRole('option', { name: 'Timesheet Outlier Report' })",
      role: 'option', region: 'the dropdown list', outcome: { kind: 'none' } },
    { id: 4, ts: 2900, type: 'navigate', locator: 'page',
      url: 'https://apps.pal.tech/hrms/reports/timesheet-outlier',
      outcome: { kind: 'screen', heading: 'Timesheet Outlier Report',
                 url: 'https://apps.pal.tech/hrms/reports/timesheet-outlier' } }
  ];
  const flow = T._prepareSteps();
  eq(flow.length, 3, 'four events read as three instructions');
  eq(flow[0].action, 'Click on the "Search" field',
     'clicking into the search field is a step');
  eq(flow[1].action, 'Enter the search text in the "Search" field',
     'typing the search term is a step');
  eq(flow[1].testData, 'outlier', 'with the term in the Test Data column');
  eq(flow[2].action,
     'Click on the "Timesheet Outlier Report" option in the dropdown list',
     'and choosing the result is a step of its own \u2014 it used to be missing entirely');
  eq(flow[2].expected, 'The "Timesheet Outlier Report" page is displayed',
     'with the page the choice opened as its expected result');
  T.steps = stepsBeforeSearch;

  // --- One nav item clicked once must not produce two steps ---
  const savedSteps = T.steps;
  T.steps = [
    { id: 1, ts: 100, type: 'click', locator: "page.locator('css=a.nav span')",
      description: 'Click "Me"', outcome: { kind: 'none' } },
    { id: 2, ts: 400, type: 'click', locator: "page.getByRole('link', { name: 'Me' })",
      description: 'Click "Me"', role: 'link',
      outcome: { kind: 'screen', heading: 'Timesheet' } }
  ];
  const dupPrepared = T._prepareSteps();
  eq(dupPrepared.length, 1,
     'a click registered twice by nested markup collapses to one step');
  eq(dupPrepared[0].expected, 'The "Timesheet" page is displayed',
     'the surviving step keeps the outcome that actually happened');
  T.steps = savedSteps;

  // --- Table export: 3 columns, one row per step ---
  const rows = T._buildRows();
  eq(rows.length, 3, 'the export has one row per rendered step');
  eq(rows[0].length, 4, 'every row has exactly four columns');
  eq(rows[0][0], '1', 'the first column is the serial number');
  eq(rows[0][1], 'Launch the browser and open the "Dashboard" page of the application',
     'the second column is the action performed');
  eq(rows[0][2], 'https://apps.pal.tech/hrms/dashboard',
     'the third column is the test data');
  eq(rows[0][3], 'The "Dashboard" page is displayed',
     'the fourth column is the expected result');
  eq(rows[1][3], 'The dashboard is displayed',
     'a step with no measurable outcome falls back to what its own name implies');
  ok(!rows[1][3].includes('TO BE CONFIRMED'),
     'nothing is inlined around that sentence — it is the whole signal');
  eq(rows[1][2], '', 'a step needing no input has an empty Test Data cell');

  const tsv = T._buildTSV();
  const tsvLines = tsv.split('\n');
  eq(tsvLines[0], 'S.No\tAction Performed\tTest Data\tExpected Result',
     'the TSV starts with the four column headers');
  eq(tsvLines.length, 4, 'the TSV has a header row plus one row per step');
  ok(tsvLines.every(l => l.split('\t').length === 4),
     'every TSV line has exactly four tab-separated cells');

  const csv = T._buildCSV();
  ok(csv.startsWith('"S.No","Action Performed","Test Data","Expected Result"'),
     'the CSV starts with quoted column headers');
  ok(csv.includes('\r\n'), 'the CSV uses CRLF line endings');
  ok(csv.includes('""Dashboard""'),
     'quotes inside a CSV cell are doubled rather than breaking the row');

  // Tabs and newlines inside a cell would corrupt a pasted table
  T.steps[1].expectedOverride = 'Line one\tand\nline two';
  ok(T._buildTSV().split('\n').length === 4,
     'a multi-line expected result cannot add rows to the pasted table');

  // --- A user override always wins ---
  T.steps[1].expectedOverride = 'The Home dashboard widgets reload';
  const prepared2 = T._prepareSteps();
  const homeStep = prepared2.find(v => v.step.id === 2);
  eq(homeStep.expected, 'The Home dashboard widgets reload',
     'a manually entered expected result replaces the generated one');
  ok(!homeStep.flagged, 'a manually completed step is no longer flagged');

  // --- Labels ---
  eq(T._humanizeName('Svg167'), '', 'an index-only element name yields no label');
  eq(T._humanizeName('Path120'), '', 'Path120 yields no label rather than "Path"');
  eq(T._extractDescriptionText({ description: 'Hover over "svg"' }), '',
     'a bare SVG tag name is rejected as a label');
  eq(T._extractDescriptionText({ description: 'Hover over "path"' }), '',
     'a bare <path> tag name is rejected as a label');
  eq(T._inferRole({ type: 'click', elementName: 'organizationTreeContainer', css: '', xpath: '' }), '',
     'a clicked element is never described as a "section"');

  // --- Framework-generated labels are rejected across stacks, not just one ---
  ok(T._isJunkLabel('Menu Icon Ng Star Inserted'),
     'an Angular class-derived label is rejected');
  ok(T._isJunkLabel('Button Mat Focus Indicator'),
     'a Material class-derived label is rejected');
  ok(T._isJunkLabel('Wrapper Sc Hkmtzm'),
     'a styled-components class-derived label is rejected');
  ok(!T._isJunkLabel('Leave Policy Summary'),
     'a real multi-word label is still kept');

  // --- Wording for controls that expand a list, and for accordions ---
  eq(T._outcomeToEnglish({ kind: 'listCountChanged', from: 9, to: 18 },
                             { locator: "page.getByRole('link', { name: 'Show All' })", type: 'click' }),
     'The full list of 18 items is displayed (9 were shown before)',
     'a "Show All" control reads as expanding the list, not as a row count');

  eq(T._outcomeToEnglish({ kind: 'contentExpanded', delta: 300 },
                             { locator: "page.getByRole('button', { name: 'Leave Policy Summary' })" }),
     'Additional content is displayed under "Leave Policy Summary"',
     'an accordion expanding reads as content appearing');

  // --- A URL is never an element label ---
  // The recorder describes a navigation as Navigate to "https://…". That quoted
  // URL was read as the element's name, so the first row of a recording said
  //   The "https://prod ireland automation test.example.com/Home/…" menu opens
  ok(T._isJunkLabel('https://prod-ireland-automation-test.example.com/Home/Dashboard'),
     'a full URL is rejected as a label');
  ok(T._isJunkLabel('/Home/ComplianceOfficerDashboardNew'),
     'a bare path is rejected as a label');
  ok(T._isJunkLabel('app.example.com'), 'a bare host name is rejected as a label');
  eq(T._extractDescriptionText({ description: 'Navigate to "https://app.example.com/Home/X"' }), '',
     'the URL quoted in a navigate description is not used as a label');
  ok(!T._isJunkLabel('Requests to Review'), 'a real label with spaces is still kept');

  // --- Icon-font class names name a glyph, not a control ---
  ok(T._isJunkLabel('Fa Angle Right I'),
     'a Font Awesome class-derived label is rejected');
  ok(T._isJunkLabel('Glyphicon Chevron Down'),
     'a Glyphicon class-derived label is rejected');

  // --- The role is not repeated when the label already ends in it ---
  eq(T._describeAction({ type: 'click', locator: "page.getByRole('button', { name: 'Csi Button' })",
                         role: 'button' }).action,
     'Click on the "Csi Button"',
     'a label ending in its own role does not produce "the Csi Button button"');

  // --- A selected dropdown option has no content to show ---
  eq(T._outcomeToEnglish({ kind: 'selected' },
                         { locator: "page.getByRole('option', { name: 'Contains' })", role: 'option' }),
     '"Contains" is shown as the selected option',
     'a chosen dropdown option is not described as revealing content');
  eq(T._outcomeToEnglish({ kind: 'selected' },
                         { locator: "page.getByRole('tab', { name: 'Personal' })", role: 'tab' }),
     '"Personal" becomes the selected tab and its content is shown',
     'a selected tab DOES reveal content');

  // --- Screens are named, and the product name is stripped ---
  T.steps = [
    { id: 1, ts: 1000, type: 'navigate', url: 'https://app/Home/Dashboard', locator: 'page',
      outcome: { kind: 'screen', heading: 'Compliance Officer Dashboard - ComplySci',
                 url: 'https://app/Home/Dashboard' } },
    { id: 2, ts: 2000, type: 'click', locator: "page.getByRole('link', { name: 'Personal' })",
      role: 'link',
      outcome: { kind: 'screen', heading: 'Staff Member Dashboard - ComplySci',
                 url: 'https://app/Home/Staff' } },
    // Back to the first page, evidenced only by the URL
    { id: 3, ts: 3000, type: 'click', locator: "page.getByRole('link', { name: 'Company' })",
      role: 'link', outcome: { kind: 'url', url: 'https://app/Home/Dashboard' } }
  ];
  const named = T._prepareSteps();
  eq(named[0].expected, 'The "Compliance Officer Dashboard" page is displayed',
     'the product name shared by every title is stripped from the screen name');
  eq(named[1].expected, 'The "Staff Member Dashboard" page is displayed',
     'a spaced hyphen before the product name is handled, not split blindly');
  eq(named[2].expected, 'The "Compliance Officer Dashboard" page is displayed',
     'a step whose only evidence is a URL is named by the page seen at that path');

  // --- A page load cannot open a menu ---
  T.steps = [
    { id: 1, ts: 1000, type: 'navigate', url: 'https://app/Home/Dashboard', locator: 'page',
      description: 'Navigate to "https://app/Home/Dashboard"',
      outcome: { kind: 'panelOpened', label: 'Control Room' } }
  ];
  const navOnly = T._prepareSteps();
  ok(!/menu opens/.test(navOnly[0].expected),
     'an outcome measured across a page load is never reported as a menu opening');
  eq(navOnly[0].expected, 'The application page at /Home/Dashboard is loaded',
     'a page load with no screen name falls back to the page that was loaded');

  // --- Noise: hovers, submits and unnamed icons ---
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByRole('link', { name: 'Filter' })",
      role: 'link', outcome: { kind: 'panelOpened', label: 'Filter' } },
    // The icon inside the Filter button registers its own click
    { id: 2, ts: 1200, type: 'click', locator: "page.locator('css=i.fa-filter')",
      elementName: 'i12', outcome: { kind: 'none' } },
    { id: 3, ts: 2000, type: 'click', locator: "page.getByRole('button', { name: 'Filter' })",
      role: 'button', outcome: { kind: 'none' } },
    // The same press of that button, seen again as a form submit
    { id: 4, ts: 2100, type: 'submit', locator: "page.locator('form')",
      outcome: { kind: 'listCountChanged', from: 40, to: 3 } },
    // Pointer leaving the panel it had opened
    { id: 5, ts: 2600, type: 'hover', locator: "page.locator('css=span.k-icon')",
      role: 'image', outcome: { kind: 'panelClosed', label: 'Filter' } }
  ];
  const cleaned = T._prepareSteps();
  eq(cleaned.length, 2,
     'the nested icon click, the duplicate submit and the drifting hover all go');
  eq(cleaned[1].action, 'Click on the "Filter" button',
     'the button the tester presses is the step that survives');
  eq(cleaned[1].expected, 'The list narrows to 3 rows (was 40)',
     'the folded submit carries its outcome onto the click that caused it');

  // --- Typing is placed where the tester did it, not where it was recorded ---
  // A fill can only be emitted once the value is final, which is when focus
  // leaves the field — usually the very click that follows. So the recording
  // holds the click FIRST, and the table used to read:
  //   Click on the "QaAuto Allow" option / Enter the value in the field
  // startedAt is when the first character was typed, and ordering by it undoes
  // that inversion.
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByLabel('Employee')",
      role: 'combobox', outcome: { kind: 'expanded' } },
    // typed at 1500, but only recorded at 4000 when the option click blurred it
    { id: 2, ts: 4000, startedAt: 1500, type: 'fill', locator: "page.getByLabel('Employee')",
      value: 'QaAuto', displayValue: 'QaAuto', role: 'field',
      outcome: { kind: 'listCountChanged', from: 40, to: 2 } },
    { id: 3, ts: 3900, type: 'click',
      locator: "page.getByRole('option', { name: 'QaAuto Allow (qa@comply.com)' })",
      role: 'option', region: 'the dropdown list',
      outcome: { kind: 'panelClosed', label: 'QaAuto Allow (qa@comply.com)' } }
  ];
  const typed = T._prepareSteps();
  // Clicking the field and typing into it are kept apart: a tester following
  // the case has to be told where the cursor goes before being told what to
  // enter, and collapsing the two also hid the typing whenever the fill went
  // missing (a control that keeps focus, or Stop pressed mid-word).
  eq(typed.length, 3,
     'clicking the field, typing, and choosing from the list are three instructions');
  eq(typed[0].action, 'Click on the "Employee" dropdown',
     'the click that put the cursor in the field is a step of its own');
  eq(typed[1].action, 'Enter the value in the "Employee" field',
     'the typing comes before the option click, because that is when it happened');
  eq(typed[1].testData, 'QaAuto', 'and it carries what was actually typed');
  eq(typed[2].action,
     'Click on the "QaAuto Allow (qa@comply.com)" option in the dropdown list',
     'choosing from the list it filtered comes last');
  eq(typed[2].expected,
     '"QaAuto Allow (qa@comply.com)" is selected and the list of options closes',
     'and reads as a selection');

  // --- Clear the field, THEN type, THEN pick from the list ---
  // Backspace edits the field, so it fires input events of its own. The typing
  // mark is therefore cleared by every recorded keypress, and the value is
  // dated to the first character typed AFTER the last of them — which is what
  // keeps the four Backspaces above the value they made room for.
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByLabel('Employee')",
      role: 'combobox', outcome: { kind: 'expanded' } },
    { id: 2, ts: 2000, type: 'press', value: 'Backspace', displayValue: 'Backspace',
      locator: "page.getByLabel('Employee')", outcome: { kind: 'none' } },
    { id: 3, ts: 2300, type: 'press', value: 'Backspace', displayValue: 'Backspace',
      locator: "page.getByLabel('Employee')", outcome: { kind: 'none' } },
    { id: 4, ts: 2600, type: 'press', value: 'Backspace', displayValue: 'Backspace',
      locator: "page.getByLabel('Employee')", outcome: { kind: 'none' } },
    { id: 5, ts: 2900, type: 'press', value: 'Backspace', displayValue: 'Backspace',
      locator: "page.getByLabel('Employee')", outcome: { kind: 'none' } },
    // typed after the last Backspace, but only recorded when the option click
    // took the focus away
    { id: 6, ts: 5000, startedAt: 3200, type: 'fill', locator: "page.getByLabel('Employee')",
      value: 'QaAuto', displayValue: 'QaAuto', role: 'field',
      outcome: { kind: 'listCountChanged', from: 40, to: 2 } },
    { id: 7, ts: 4900, type: 'click',
      locator: "page.getByRole('option', { name: 'QaAuto Allow (qa@comply.com)' })",
      role: 'option', region: 'the dropdown list',
      outcome: { kind: 'panelClosed', label: 'QaAuto Allow (qa@comply.com)' } }
  ];
  const cleared = T._prepareSteps();
  eq(cleared.length, 4, 'seven events read as four instructions');
  eq(cleared[0].action, 'Click on the "Employee" dropdown',
     'opening the dropdown is its own step, because keys were pressed next');
  eq(cleared[1].action,
     'Press the Backspace key 4 times while focus is in the "Employee" field',
     'clearing the field comes second, as one counted instruction');
  eq(cleared[2].action, 'Enter the value in the "Employee" field',
     'the value typed after the Backspaces comes THIRD, not before them');
  eq(cleared[2].testData, 'QaAuto', 'with what was actually typed');
  eq(cleared[3].action,
     'Click on the "QaAuto Allow (qa@comply.com)" option in the dropdown list',
     'and picking from the filtered list comes last');

  // --- The value a dropdown writes into its own input is not a step ---
  // Picking an option makes the widget put the option's text in the input. With
  // no typing of their own, that produced a phantom "Enter the value..." step.
  T.steps = [
    { id: 1, ts: 1000, type: 'click',
      locator: "page.getByRole('option', { name: 'QaAuto Allow (qa@comply.com)' })",
      role: 'option', region: 'the dropdown list',
      outcome: { kind: 'panelClosed', label: 'QaAuto Allow (qa@comply.com)' } },
    { id: 2, ts: 1100, type: 'fill', locator: "page.getByLabel('Employee')",
      value: 'QaAuto Allow (qa@comply.com)', displayValue: 'QaAuto Allow (qa@comply.com)',
      role: 'field', outcome: { kind: 'valueSet', value: 'QaAuto Allow (qa@comply.com)' } }
  ];
  const echoed = T._prepareSteps();
  eq(echoed.length, 1, 'the widget echoing the chosen option is not a second step');
  eq(echoed[0].step.id, 1, 'the step that survives is the click on the option');

  // A value the tester typed is NOT an echo, even next to an option click
  T.steps = [
    { id: 1, ts: 1000, startedAt: 900, type: 'fill', locator: "page.getByLabel('Employee')",
      value: 'QaAuto', displayValue: 'QaAuto', role: 'field', outcome: { kind: 'none' } },
    { id: 2, ts: 1100, type: 'click',
      locator: "page.getByRole('option', { name: 'QaAuto Allow (qa@comply.com)' })",
      role: 'option', outcome: { kind: 'panelClosed', label: 'QaAuto Allow (qa@comply.com)' } }
  ];
  eq(T._prepareSteps().length, 2,
     'a few characters typed to filter the list stay as their own step');

  // --- A step added by hand keeps its place under that ordering ---
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByRole('link', { name: 'One' })",
      role: 'link', outcome: { kind: 'message', text: 'First' } },
    { id: 2, ts: 2000, type: 'click', locator: "page.getByRole('link', { name: 'Two' })",
      role: 'link', outcome: { kind: 'message', text: 'Second' } },
    { id: 3, ts: 3000, type: 'click', locator: "page.getByRole('link', { name: 'Three' })",
      role: 'link', outcome: { kind: 'message', text: 'Third' } }
  ];
  T._renderStepList();
  T._insertManualStep(0);
  const placed = T._prepareSteps();
  eq(placed.length, 4, 'the added step is in the table');
  eq(placed[1].step.type, 'manual',
     'and it stays directly below the row it was added from, not at the bottom');

  // --- Keys: what the browser does with them is not a guess ---
  const key = (k, label) => T._implicitExpected({
    type: 'press', value: k,
    locator: label ? "page.getByLabel('" + label + "')" : 'page'
  });
  eq(key('Backspace', 'Employee'),
     'The character before the cursor is deleted in the "Employee" field',
     'Backspace has a defined result, so the step is never left blank');
  eq(key('Backspace'), 'The character before the cursor is deleted',
     'and it reads sensibly with no field to name');
  eq(key('Delete', 'Employee'),
     'The character after the cursor is deleted in the "Employee" field',
     'Delete deletes forwards');
  eq(key('Control+A', 'Employee'),
     'All the text in the "Employee" field is selected',
     'Ctrl+A selects the text');
  eq(key('Control+C'), 'The selected text is copied to the clipboard',
     'Ctrl+C copies');
  eq(T._inferredExpected({ type: 'press', value: 'ArrowDown', locator: 'page' }),
     'The next option in the list is highlighted',
     'an arrow key moves through a list — a convention, so it stays flagged');

  // Four Backspaces to clear a field is ONE instruction
  T.steps = [
    { id: 1, ts: 1000, type: 'press', value: 'Backspace', displayValue: 'Backspace',
      locator: "page.getByLabel('Employee')", outcome: { kind: 'none' } },
    { id: 2, ts: 1300, type: 'press', value: 'Backspace', displayValue: 'Backspace',
      locator: "page.getByLabel('Employee')", outcome: { kind: 'none' } },
    { id: 3, ts: 1600, type: 'press', value: 'Backspace', displayValue: 'Backspace',
      locator: "page.getByLabel('Employee')", outcome: { kind: 'none' } },
    { id: 4, ts: 1900, type: 'press', value: 'Backspace', displayValue: 'Backspace',
      locator: "page.getByLabel('Employee')", outcome: { kind: 'none' } }
  ];
  const runs = T._prepareSteps();
  eq(runs.length, 1, 'a run of the same key collapses to one step');
  eq(runs[0].action, 'Press the Backspace key 4 times while focus is in the "Employee" field',
     'and the step says how many times');
  ok(!runs[0].flagged, 'the collapsed step has a real expected result, not a blank');
  // The table is rebuilt on every render and every export, so it has to come
  // out the same each time
  eq(T._prepareSteps().length, 1, 'collapsing is stable when the table is rebuilt');
  eq(T._prepareSteps()[0].action,
     'Press the Backspace key 4 times while focus is in the "Employee" field',
     'and the count does not drift between renders');

  // A different key, or the same key much later, is a separate instruction
  T.steps = [
    { id: 1, ts: 1000, type: 'press', value: 'Backspace',
      locator: "page.getByLabel('Employee')", outcome: { kind: 'none' } },
    { id: 2, ts: 9000, type: 'press', value: 'Backspace',
      locator: "page.getByLabel('Employee')", outcome: { kind: 'none' } }
  ];
  eq(T._prepareSteps().length, 2,
     'the same key pressed again much later is its own step');

  // --- The same screen must not be re-reported against the next click ---
  // A click step carries no URL of its own, which used to defeat the path
  // comparison and credit the previous page to whatever was clicked next.
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByRole('link', { name: 'Certifications' })",
      role: 'link',
      outcome: { kind: 'screen', heading: 'Certifications', url: 'https://app/Certifications' } },
    { id: 2, ts: 3000, type: 'click', locator: "page.getByText('Data Records')",
      region: 'the navigation menu',
      outcome: { kind: 'screen', heading: 'Certifications' } }
  ];
  const repeated = T._prepareSteps();
  eq(repeated[0].expected, 'The "Certifications" page is displayed',
     'the click that opened the page reports the page');
  ok(repeated[1].expected !== 'The "Certifications" page is displayed',
     'the NEXT click is not credited with the page that was already open');
  eq(repeated[1].expected, 'The "Data Records" tab is selected and its content is shown',
     'it is reported as an in-page switch instead');

  // --- An icon names the control, not the menu it opened ---
  eq(T._outcomeToEnglish({ kind: 'panelOpened' }, { locator: "page.getByText('save icon')" }),
     'The menu opens and its options are listed',
     'a menu opened by an icon is not called the "Save Icon" menu');

  // --- Choosing an option closes the list ---
  eq(T._outcomeToEnglish({ kind: 'panelClosed' },
                         { locator: "page.getByRole('option', { name: 'QaAuto Allow' })",
                           role: 'option' }),
     '"QaAuto Allow" is selected and the list of options closes',
     'picking an option is reported as a selection, not as that option closing');

  // --- Inference knows the remaining kinds of control ---
  eq(T._inferredExpected({ type: 'click', locator: "page.getByLabel('Select case type')",
                           role: 'combobox' }),
     'The list of options in the "Select case type" dropdown opens',
     'clicking a dropdown opens its options');

  // --- One physical click on a checkbox's label is ONE step ---
  // Clicking a label makes the browser click its control, so the recording
  // holds a click on the label AND a change on the checkbox. Two rows for one
  // click, and the first row invented an expected result of its own.
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByText('Edit Accounts')",
      role: 'label', region: 'the form', outcome: { kind: 'none' } },
    { id: 2, ts: 1060, type: 'check', locator: "page.getByLabel('Edit Accounts')",
      role: 'checkbox', region: 'the form', outcome: { kind: 'checked' } }
  ];
  const oneClick = T._prepareSteps();
  eq(oneClick.length, 1, 'the label click and the checkbox change collapse to one step');
  eq(oneClick[0].action, 'Select the "Edit Accounts" checkbox in the form',
     'the surviving step is the one that names what the tester actually did');
  eq(oneClick[0].expected, 'The "Edit Accounts" checkbox is ticked',
     'and it keeps the outcome that was measured');

  // A click and a change on genuinely different controls stay separate
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByRole('button', { name: 'Select all' })",
      role: 'button', outcome: { kind: 'none' } },
    { id: 2, ts: 1060, type: 'check', locator: "page.getByLabel('Edit Accounts')",
      role: 'checkbox', outcome: { kind: 'checked' } }
  ];
  eq(T._prepareSteps().length, 2,
     'a click on a DIFFERENT control is not swallowed by the change that followed');

  // Nor when the two are far enough apart to be two deliberate actions
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByText('Edit Accounts')",
      role: 'label', outcome: { kind: 'none' } },
    { id: 2, ts: 9000, type: 'check', locator: "page.getByLabel('Edit Accounts')",
      role: 'checkbox', outcome: { kind: 'checked' } }
  ];
  eq(T._prepareSteps().length, 2,
     'the same label clicked seconds earlier is a separate step, not a duplicate');

  // --- Deleting a row removes every event it was built from ---
  // A row can stand for several recorded events. Removing only the first left
  // the rest to re-form: pressing × on "Press the Backspace key 4 times" put a
  // row saying "3 times" in its place.
  T.steps = [1, 2, 3, 4].map((n, i) => ({
    id: n, ts: 1000 + i * 300, type: 'press', value: 'Backspace',
    displayValue: 'Backspace', locator: "page.getByLabel('Employee')",
    outcome: { kind: 'none' }
  }));
  T._renderStepList();
  eq(T._prepared.length, 1, 'four presses are one row');
  eq(T._prepared[0].ids.length, 4, 'and the row knows all four events behind it');
  T._removeRow(0);
  eq(T._prepareSteps().length, 0, 'deleting that row removes all four');

  // A click and the form submit it fired
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByRole('button', { name: 'Filter' })",
      role: 'button', outcome: { kind: 'none' } },
    { id: 2, ts: 1100, type: 'submit', locator: "page.locator('form')",
      outcome: { kind: 'listCountChanged', from: 40, to: 3 } }
  ];
  T._renderStepList();
  T._removeRow(0);
  eq(T._prepareSteps().length, 0,
     'deleting the click takes the submit with it, instead of leaving "Submit the form"');

  // A label click, the checkbox it ticked, and a navigation folded in as the
  // expected result of the row after it
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByText('Edit Accounts')",
      role: 'label', outcome: { kind: 'none' } },
    { id: 2, ts: 1060, type: 'check', locator: "page.getByLabel('Edit Accounts')",
      role: 'checkbox', outcome: { kind: 'checked' } },
    { id: 3, ts: 3000, type: 'click', locator: "page.getByRole('link', { name: 'Save' })",
      role: 'link', outcome: { kind: 'none' } },
    { id: 4, ts: 3200, type: 'navigate', url: 'https://app/Roles', locator: 'page',
      outcome: { kind: 'screen', heading: 'Roles', url: 'https://app/Roles' } }
  ];
  T._renderStepList();
  eq(T._prepared.length, 2, 'four events, two rows');
  T._removeRow(0);
  const afterFirst = T._prepareSteps();
  eq(afterFirst.length, 1,
     'deleting the checkbox row takes the label click with it');
  eq(afterFirst[0].action, 'Click on the "Save" link', 'and leaves the other row alone');
  T._removeRow(0);
  eq(T._prepareSteps().length, 0,
     'deleting the click takes the navigation folded into it as well');

  // --- The editor's hint comes from the recording, not from one product ---
  T.steps = [
    { id: 1, ts: 1000, type: 'navigate', url: 'https://app/Membership/CreateRole', locator: 'page',
      outcome: { kind: 'screen', heading: 'Create Role - ComplySci',
                 url: 'https://app/Membership/CreateRole' } },
    { id: 2, ts: 2000, type: 'navigate', url: 'https://app/Membership/Roles', locator: 'page',
      outcome: { kind: 'screen', heading: 'Company Roles - ComplySci',
                 url: 'https://app/Membership/Roles' } }
  ];
  const onScreen = T._prepareSteps();
  eq(onScreen[0].screen, 'Create Role', 'each row knows the page it is carried out on');
  eq(T.constructor.EDITABLE.action.placeholder(onScreen[0]),
     'What does the tester do on the "Create Role" page?',
     'so the hint names that page, with no product-specific example in it');
  eq(T.constructor.EDITABLE.exp.placeholder(onScreen[1]),
     'What should happen on the "Company Roles" page after this step?',
     'and the expected-result hint does the same');
  eq(T.constructor.EDITABLE.action.placeholder({}),
     'What does the tester do at this point?',
     'with no page known it stays generic rather than guessing');
  ok(!/Compliance Officer/.test(T.constructor.EDITABLE.action.placeholder({})),
     'no example from any one application is baked into the hint');

  // --- The status line counts what the table shows ---
  // Events and steps are deliberately different numbers, so reporting
  // this.steps.length announced "3 steps recorded" over a table of 2.
  T.steps = [
    { id: 1, ts: 1000, type: 'navigate', url: 'https://app/Membership/ViewCompanyRole',
      locator: 'page',
      outcome: { kind: 'screen', heading: 'View Role', url: 'https://app/Membership/ViewCompanyRole' } },
    { id: 2, ts: 2000, type: 'click', locator: "page.getByRole('link', { name: 'Conflict Check' })",
      role: 'link', outcome: { kind: 'none' } },
    // the navigation that click caused — the click's expected result, not a step
    { id: 3, ts: 2200, type: 'navigate', url: 'https://app/ControlRoom/ConflictChecking',
      locator: 'page', outcome: { kind: 'url', url: 'https://app/ControlRoom/ConflictChecking' } }
  ];
  const stopped = T._applyStoppedState();
  eq(stopped.shown, 2, 'the table shows two steps');
  eq(stopped.recorded, 3, 'built from three recorded events');
  eq(T._stoppedMessage(stopped.shown, stopped.recorded),
     'Stopped. 2 steps recorded (3 events, 1 merged).',
     'and the status line says so, instead of contradicting the table');
  eq(T._stoppedMessage(2, 2), 'Stopped. 2 steps recorded.',
     'with nothing merged there is nothing to explain');
  eq(T._stoppedMessage(1, 1), 'Stopped. 1 step recorded.', 'one step is singular');
  eq(T._stoppedMessage(0, 0), 'Stopped. No steps recorded.', 'and none is none');

  // --- Steps the tester adds by hand ---
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByRole('button', { name: 'Save' })",
      role: 'button', outcome: { kind: 'message', text: 'Saved successfully' } }
  ];
  T._renderStepList();

  T._insertManualStep(0);
  eq(T.steps.length, 2, 'the + button adds a step to the recording');
  const withManual = T._prepareSteps();
  eq(withManual.length, 2, 'the added step is rendered as its own row');
  eq(withManual[1].step.type, 'manual', 'the added step goes BELOW the row it was added from');
  eq(withManual[1].action, '', 'a hand-written step starts with no action text');
  eq(withManual[1].expected, '',
     'a hand-written step starts with no expected result');
  ok(!withManual[1].flagged,
     'an empty hand-written step is not flagged as an undetected outcome');

  // The tester fills it in — every column is correctable, not just the last one
  const manualStep = T.steps[1];
  manualStep.actionOverride   = 'Log in as a Compliance Officer';
  manualStep.testDataOverride = 'officer@example.com';
  manualStep.expectedOverride = 'The Compliance Officer Dashboard is displayed';
  const filled = T._buildRows();
  eq(filled[1][1], 'Log in as a Compliance Officer',
     'the action text the tester wrote is exported');
  eq(filled[1][2], 'officer@example.com', 'the test data the tester wrote is exported');
  eq(filled[1][3], 'The Compliance Officer Dashboard is displayed',
     'the expected result the tester wrote is exported');

  // An override wins over a recorded sentence too
  T.steps[0].actionOverride = 'Press Save on the toolbar';
  eq(T._buildRows()[0][1], 'Press Save on the toolbar',
     'a correction replaces the generated action sentence');
  delete T.steps[0].actionOverride;

  // A row opened for editing has to be settled before another can be added.
  // The new row starts with its Action cell open, so a second + used to stack
  // a second blank row under a table that cannot redraw while editing.
  T._editingIdx   = 1;
  T._editingField = 'action';
  T._insertManualStep(0);
  eq(T.steps.length, 2, '+ is inert while a cell is open — no second blank row');
  T._removeRow(0);
  eq(T.steps.length, 2, 'and so is x, which would strand the open editor');
  T._editingIdx   = null;
  T._editingField = null;
  T._insertManualStep(0);
  eq(T.steps.length, 3, 'once the cell is settled + adds a row again');

  // Appending with no row to point at — the case where the table is empty
  T.steps = [];
  T._insertManualStep();
  eq(T.steps.length, 1, 'a step can be added when nothing has been recorded');
  eq(T._prepareSteps()[0].step.type, 'manual', 'that step is a hand-written one');

  // --- Recording into a parked row ---------------------------------------
  // Adding half a dozen steps by hand is a chore. Parking one row and then
  // recording puts the new steps THERE, instead of underneath everything
  // recorded so far.

  // Order is overridden by `after`, never by rewriting timestamps: the merge
  // heuristics read the real gaps between events.
  const orderIds = (list) => T._inTesterOrder(list).map(s => s.id).join(',');
  eq(orderIds([{ id: 1, ts: 1000 }, { id: 2, ts: 2000 }, { id: 9, ts: 9000, after: 1 }]),
     '1,9,2', 'a placed step hangs under its anchor, not at its own recorded time');
  eq(orderIds([{ id: 1, ts: 1000 }, { id: 2, ts: 2000 },
               { id: 9, ts: 9000, after: 1 }, { id: 10, ts: 9500, after: 9 }]),
     '1,9,10,2', 'a run of them chains in the order it was carried out');
  eq(orderIds([{ id: 1, ts: 1000 }, { id: 2, ts: 2000 }, { id: 9, ts: 9000, after: 77 }]),
     '1,2,9', 'an anchor that no longer exists falls back to the recorded time');
  eq(orderIds([{ id: 1, ts: 1000, after: 2 }, { id: 2, ts: 2000, after: 1 }]).split(',').length,
     2, 'a cycle in the anchors still shows both steps rather than dropping them');
  eq(orderIds([{ id: 1, ts: 1000 }, { id: 9, ts: 9000, after: T.constructor.TOP }]),
     '9,1', 'a step pinned to the top sits above everything recorded');

  const recorded = (id, ts, name) => ({
    id, ts, type: 'click', role: 'button',
    locator: `page.getByRole('button', { name: '${name}' })`,
    outcome: { kind: 'message', text: `${name} done` }
  });
  const threeSteps = () => [recorded(1, 1000, 'One'), recorded(2, 2000, 'Two'),
                            recorded(3, 3000, 'Three')];

  T.steps = threeSteps();
  T._renderStepList();
  T._insertManualStep(0);                       // park a row under step One
  const parked = T.steps.find(s => s.type === 'manual');
  eq(T._insertAfterId, parked.id, 'the parked row is where the next steps will go');
  eq(T._insertRowNumber(), 2, 'and the status line can say which row that is');
  eq(T._recordingMessage(2), 'Recording… new steps are being added at step 2.',
     'so the tester is told, rather than wondering where their steps went');
  eq(T._recordingMessage(0), 'Recording… interact with the page.',
     'with nothing parked the message is the plain one');

  // Recorded much later than everything in the table — the case that used to
  // send them to the bottom
  T._placeRecordedStep(recorded(20, 50000, 'Alpha'));
  T._placeRecordedStep(recorded(21, 51000, 'Beta'));
  eq(T._prepareSteps().map(v => v.step.id).join(','), '1,20,21,2,3',
     'steps recorded after parking a row land there, in the order they happened');
  eq(T.steps.filter(s => s.type === 'manual').length, 0,
     'the blank parked row was only a marker, so the first real step took its place');
  eq(T._insertAfterId, 21, 'the insertion point follows the run as it is recorded');

  // A parked row the tester actually wrote in is a step, not a marker
  T.steps = threeSteps();
  T._renderStepList();
  T._insertManualStep(0);
  const written = T.steps.find(s => s.type === 'manual');
  written.actionOverride = 'Log in as a Compliance Officer';
  T._placeRecordedStep(recorded(30, 50000, 'Gamma'));
  eq(T._prepareSteps().map(v => v.step.id).join(','), `1,${written.id},30,2,3`,
     'a hand-written step stays and the recording carries on below it');

  // Nothing parked — recording appends, exactly as it always did
  T.steps = threeSteps();
  T._insertAfterId = null;
  T._placeRecordedStep(recorded(40, 50000, 'Delta'));
  eq(T._prepareSteps().map(v => v.step.id).join(','), '1,2,3,40',
     'with no insertion point a recorded step goes on the end');

  // The insertion point lasts for one recording
  T.steps = threeSteps();
  T._renderStepList();
  T._insertManualStep(0);
  T._applyStoppedState();
  eq(T._insertAfterId, null, 'stopping the recording disarms the insertion point');
  T._insertManualStep(0);
  T._clearSteps();
  eq(T._insertAfterId, null, 'and so does clearing the table');

  // Deleting the row a group was placed under keeps the group where it is
  T.steps = threeSteps();
  T._renderStepList();
  T._insertManualStep(0);
  T._placeRecordedStep(recorded(50, 50000, 'Epsilon'));
  T._renderStepList();
  T._removeRow(0);                              // delete step One, the anchor
  eq(T._prepareSteps().map(v => v.step.id).join(','), '50,2,3',
     'with nothing left above it the group is pinned to the top, not flung to the bottom');

  T.steps = threeSteps();
  T._renderStepList();
  T._insertManualStep(1);                       // park under step Two
  T._placeRecordedStep(recorded(51, 50000, 'Zeta'));
  T._renderStepList();
  T._removeRow(1);                              // delete step Two
  eq(T._prepareSteps().map(v => v.step.id).join(','), '1,51,3',
     'otherwise it is re-hung on the row above the deleted one');

  // Merging still reads the real gaps between events, inserted run or not
  T.steps = threeSteps();
  T._renderStepList();
  T._insertManualStep(0);
  T._placeRecordedStep({ id: 60, ts: 50000, type: 'click', role: 'link',
    locator: "page.getByRole('link', { name: 'Conflict Check' })",
    outcome: { kind: 'none' } });
  T._placeRecordedStep({ id: 61, ts: 50200, type: 'navigate', locator: 'page',
    url: 'https://app/ControlRoom/ConflictChecking',
    outcome: { kind: 'url', url: 'https://app/ControlRoom/ConflictChecking' } });
  const inserted = T._prepareSteps();
  eq(inserted.map(v => v.step.id).join(','), '1,60,2,3',
     'a navigation caused by an inserted click still folds into it as its result');
  ok(/ConflictChecking/.test(inserted[1].expected),
     'and it is that navigation which supplies the expected result');

  // --- A parked row must not open its own editor ---------------------------
  //
  // The Action cell of a newly parked row used to open for editing straight
  // away, and _renderStepList suppresses every redraw while a cell is open. So
  // the tester parked a row, went off to perform the steps that belonged there,
  // and the table showed none of them until they came back and closed the cell.
  {
    const realList = T.stepList;

    // The sandbox's fake element answers every query with null, which is
    // exactly the case _beginEdit gives up on — so hand it a cell it can
    // really attach to, or this test would pass on a technicality.
    const noNodes = []; noNodes.forEach = Array.prototype.forEach.bind(noNodes);
    const fakeInput = { value: '', focus() {}, setSelectionRange() {}, addEventListener() {} };
    const fakeCell = {
      classList: { add() {}, remove() {} }, innerHTML: '',
      // The real cell is a <td title="Click to edit"> — see _renderStepList
      title: 'Click to edit', addEventListener() {}, focus() {},
      removeAttribute(name) { if (name === 'title') this.title = ''; },
      querySelector: () => fakeInput, querySelectorAll: () => noNodes
    };
    const fieldCells = [fakeCell];
    fieldCells.forEach = Array.prototype.forEach.bind(fieldCells);
    T.stepList = {
      classList: { add() {}, remove() {} }, innerHTML: '',
      querySelector: () => fakeCell,
      // _beginEdit clears the "Click to edit" tooltip off every cell, not just
      // the one it opens — the others are inert while it is up
      querySelectorAll: (sel) => (sel === '[data-field]' ? fieldCells : noNodes)
    };

    T.steps       = threeSteps();
    T.isRecording = true;
    T._editingIdx = null;
    T._renderStepList();

    // The control: given a cell to attach to, an edit really can be opened
    T._beginEdit(0, 'action');
    eq(T._editingIdx, 0, 'clicking a cell opens the inline editor');
    // A title is inherited by every child that has none of its own, so the
    // cell's kept tooltip was the one shown over Save, Cancel and the textarea
    eq(fakeCell.title, '',
       'the cell drops its "Click to edit" tooltip while the editor is open');
    T._activeEditor.finish();
    eq(T._editingIdx, null, 'and closing it releases the table');

    T._insertManualStep(0);
    eq(T._editingIdx, null, 'parking a row leaves it inactive — no cell is opened');
    eq(T._activeEditor, null, 'so no open editor is holding the table frozen');
    eq(T.statusBar.textContent, 'Recording… new steps are being added at step 2.',
       'the status line now says where the parked row will collect steps');

    // ...which is the whole point: what is recorded next shows up at once
    const before = T.stepList.innerHTML;
    T._placeRecordedStep(recorded(70, 60000, 'Eta'));
    T._renderStepList();
    ok(T.stepList.innerHTML !== before,
       'a step recorded after parking a row redraws the table straight away');
    eq(T.stepCount.textContent, T._prepareSteps().length,
       'and the step count keeps up with it');

    // The freeze itself is deliberate and still there for a cell the tester
    // opened on purpose — it is only the parked row that no longer starts one.
    T._renderStepList();
    T._beginEdit(0, 'action');
    const frozen = T.stepCount.textContent;
    T._placeRecordedStep(recorded(71, 61000, 'Theta'));
    T._renderStepList();
    eq(T.stepCount.textContent, frozen,
       'a cell the tester opened still holds the redraw, so nothing is typed over');
    T._activeEditor.finish();
    eq(T.stepCount.textContent, T._prepareSteps().length,
       'and closing it flushes everything recorded meanwhile');

    T.isRecording  = false;
    T.stepList     = realList;
    T._editingIdx  = null;
    T._activeEditor = null;
  }

  // --- Only one cell may be open at a time ---------------------------------
  //
  // Two cells could be opened at once. The table cannot redraw while an editor
  // is up, so the first cell kept its textarea and buttons on screen while
  // _activeEditor had already moved on to the second — and Save or Cancel on
  // either re-rendered everything, taking the other one's buttons and whatever
  // had been typed into it with them.
  {
    const realList = T.stepList;

    const noNodes = []; noNodes.forEach = Array.prototype.forEach.bind(noNodes);
    const openInput = { value: '', focus() {}, setSelectionRange() {}, addEventListener() {} };
    const cells = {};
    const cellFor = (idx) => {
      if (!cells[idx]) {
        cells[idx] = {
          classList: { add() {}, remove() {} }, innerHTML: '',
          title: 'Click to edit', focus() {}, addEventListener() {},
          removeAttribute(name) { if (name === 'title') this.title = ''; },
          querySelector: () => openInput, querySelectorAll: () => noNodes
        };
      }
      return cells[idx];
    };
    const allCells = () => {
      const list = [0, 1, 2].map(cellFor);
      list.forEach = Array.prototype.forEach.bind(list);
      return list;
    };

    T.stepList = {
      classList: { add() {}, remove() {} }, innerHTML: '', focus() {},
      querySelector: (sel) => {
        const m = /data-idx="(\d+)"/.exec(sel);
        return m ? cellFor(Number(m[1])) : openInput;
      },
      querySelectorAll: (sel) => (sel === '[data-field]' ? allCells() : noNodes)
    };

    T.steps = threeSteps();
    T.isRecording  = false;
    T._editingIdx  = null;
    T._activeEditor = null;
    T._renderStepList();

    T._beginEdit(0, 'action');
    const firstEditor = T._activeEditor;
    eq(T._editingIdx, 0, 'the first cell opens');
    ok(!!firstEditor, 'and holds the live editor');
    eq(cellFor(1).title, '',
       'every other cell stops offering "Click to edit" while it is open');

    // The bug: this used to open a second editor on top of the first
    T._beginEdit(1, 'exp');
    eq(T._editingIdx, 0, 'clicking another cell does NOT move the editor');
    eq(T._editingField, 'action', 'the open cell keeps the field it was opened on');
    ok(T._activeEditor === firstEditor,
       'and the first editor is still the one Save and Cancel will act on');
    eq(cellFor(1).innerHTML, '',
       'no second textarea is written into the other cell');

    // Re-clicking the cell that is already open must not wipe what is in it
    cellFor(0).innerHTML = 'HALF TYPED';
    T._beginEdit(0, 'action');
    eq(cellFor(0).innerHTML, 'HALF TYPED',
       'and re-clicking the open cell does not rebuild it over what was typed');

    // Settling the open one hands the table back
    T._activeEditor.finish();
    eq(T._editingIdx, null, 'closing the open cell releases the table');
    T._beginEdit(1, 'exp');
    eq(T._editingIdx, 1, 'after which another cell can be edited as usual');
    eq(T._editingField, 'exp', 'on the field that was clicked');
    T._activeEditor.finish();

    T.stepList      = realList;
    T._editingIdx   = null;
    T._activeEditor = null;
  }

  // --- Rendered table ---
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByRole('button', { name: 'Save' })",
      role: 'button', outcome: { kind: 'message', text: 'Saved successfully' } }
  ];
  T._renderStepList();
  const markup = T.stepList.innerHTML;
  eq((markup.match(/<col\b/g) || []).length, 4,
     'the table declares a width for each of the four columns');
  ok(/width:52px/.test(markup),
     'the "#" column is sized in the colgroup, where the global table rules cannot reach it');
  ok(/class="ts-row-add"/.test(markup), 'every row offers a + to insert a step');
  ok(/class="ts-row-del"/.test(markup), 'every row still offers an x to remove it');
  ok(/data-field="action"/.test(markup) && /data-field="data"/.test(markup) &&
     /data-field="exp"/.test(markup),
     'all three text columns are click-to-edit');
  ok(/title="Click to edit"/.test(markup),
     'and each says so on hover — a fresh render is what puts that tooltip back '
     + 'after an edit removed it');

  // --- What a control's own name implies, when nothing could be measured ---
  const infer = (step) => T._inferredExpected(step);

  eq(infer({ type: 'click', locator: "page.getByRole('button', { name: 'Save' })", role: 'button' }),
     'The changes are saved and a confirmation message is displayed',
     'a Save button implies its changes are saved');
  eq(infer({ type: 'click', locator: "page.getByText('save icon')", region: 'the dialog' }),
     'The changes are saved and a confirmation message is displayed',
     'an icon-only save control is read from the icon vocabulary');
  eq(infer({ type: 'click', locator: "page.getByText('menu icon')" }),
     'The navigation menu opens and its options are listed',
     'a hamburger icon implies the navigation menu opens');
  eq(infer({ type: 'click', locator: "page.getByRole('button', { name: 'Close' })",
             region: 'the dialog' }),
     'The dialog closes and the previous content is shown again',
     'Close inside a dialog closes the dialog, not a panel');
  eq(infer({ type: 'click', locator: "page.getByRole('button', { name: 'Close' })" }),
     'The panel closes and the previous content is shown again',
     'the same control outside a dialog is worded as a panel');
  eq(infer({ type: 'click', locator: "page.getByRole('button', { name: 'Delete' })", role: 'button' }),
     'The selected record is deleted and no longer appears in the list',
     'Delete implies the record goes');
  eq(infer({ type: 'click', locator: "page.getByRole('link', { name: 'Certifications' })",
             role: 'link' }),
     'The "Certifications" page is displayed',
     'an unrecognised link name still implies its page is displayed');
  eq(infer({ type: 'click', locator: "page.getByText('Reports')", region: 'the navigation menu' }),
     'The "Reports" section is displayed',
     'where the control lives is used when its kind is unknown');
  eq(infer({ type: 'rightClick', locator: "page.getByRole('row', { name: 'Alpha' })" }),
     'The context menu for "Alpha" opens with its options listed',
     'a right-click implies a context menu');
  eq(infer({ type: 'press', locator: "page.getByLabel('Search')", value: 'Enter' }),
     'The entered value is submitted and the result is shown',
     'Enter implies the value is submitted');
  eq(infer({ type: 'click', locator: "page.locator('css=div.x')" }), null,
     'a control with no name at all is never given an invented result');
  eq(infer({ type: 'fill', locator: "page.getByLabel('Search')" }), null,
     'inference only applies to controls that were pressed');

  // Scrolling always has the same result, and it is not a guess
  eq(T._implicitExpected({ type: 'scroll', value: '415' }),
     'The page scrolls down and the content further down the page is displayed',
     'a scroll down has a self-evident result');
  eq(T._implicitExpected({ type: 'scroll', value: '-200' }),
     'The page scrolls up and the content higher up the page is displayed',
     'a scroll up has a self-evident result');
  eq(T._implicitExpected({ type: 'press', locator: 'page', value: 'Tab' }),
     'Focus moves to the next control on the page',
     'Tab moving focus is self-evident');

  // --- A navigation folded into a click is guarded like any navigation ---
  T.steps = [
    { id: 1, ts: 1000, type: 'click', locator: "page.getByRole('link', { name: 'Company' })",
      role: 'link', outcome: { kind: 'none' } },
    { id: 2, ts: 1300, type: 'navigate', url: 'https://app/Home/Company', locator: 'page',
      description: 'Navigate to "https://app/Home/Company"',
      outcome: { kind: 'panelOpened', label: 'Page' } }
  ];
  const folded = T._prepareSteps();
  eq(folded.length, 1, 'the navigation is still folded into the click that caused it');
  ok(!/menu opens/.test(folded[0].expected),
     'a menu rendered while the new page loaded is not reported as the click opening a menu');
  eq(folded[0].expected, 'The /Home/Company page is displayed',
     'the folded navigation is reported as the page that was reached');

  // --- New wording for the new signals ---
  eq(T._outcomeToEnglish({ kind: 'selectionChanged', label: 'Reports' }, { locator: 'page' }),
     '"Reports" is highlighted as the current selection',
     'something else on the page being marked current is reported');
  eq(T._outcomeToEnglish({ kind: 'contentExpanded', delta: 200, page: true },
                         { locator: "page.getByRole('button', { name: 'Menu' })" }),
     'Additional content is displayed on the page',
     'a page-level size change is never pinned on the control that was pressed');
  eq(T._outcomeToEnglish({ kind: 'scrolled', dy: 300 }, { locator: 'page' }),
     'The page scrolls down to the content the control points to',
     'a click that scrolled the page says so');

  // --- A rejected label must not leave a stutter behind ---
  // The generated id below is not a label, so the sentence has to fall back to
  // the KIND of control: 'the checkbox', never 'the "checkbox" checkbox'.
  const junkCheckbox = {
    type: 'check', locator: "page.getByLabel('checkboxuof7wufzhoc23qjqszvhuwreportChk')",
    region: 'the dialog'
  };
  eq(T._describeAction(junkCheckbox).action, 'Select the checkbox in the dialog',
     'an unnamed checkbox is described by its kind, without a quoted placeholder');
  eq(T._implicitExpected(junkCheckbox), 'The checkbox is ticked',
     'and its expected result reads the same way');
  eq(T._outcomeToEnglish({ kind: 'checked' }, junkCheckbox), 'The checkbox is ticked',
     'a measured tick on an unnamed checkbox reads the same way');
  eq(T._outcomeToEnglish({ kind: 'panelOpened' }, { locator: "page.locator('css=div.x')" }),
     'The menu opens and its options are listed',
     'an unnamed panel is not reported as the "menu" menu');
  eq(T._outcomeToEnglish({ kind: 'valueSet', value: 'audit' },
                         { locator: "page.locator('css=input.x')" }),
     'The field contains "audit"',
     'an unnamed field is not reported as the "field" field');
  eq(T._describeAction({ type: 'select', locator: "page.locator('css=select.x')" }).action,
     'Select an option from the dropdown',
     'an unnamed dropdown is described by its kind');

  // --- A card's accessible name is not a name for a sentence ---------------
  // A link's accessible name is every word inside it, which is correct for the
  // LOCATOR — it is how Playwright finds the link — and useless in an
  // instruction when the link wraps a person's whole card. The recorder now
  // resolves the card's heading live and sends it in the description, so that
  // is what the sentence uses.
  const cardStep = {
    type: 'click',
    locator: "page.getByRole('link', { name: 'Nikhila Marupally Software Engineer Quality Engineering Equinox' })",
    role: 'link',
    description: 'Click "Nikhila Marupally"',
    elementName: 'nikhilaMarupallyLnk'
  };
  eq(T._elemLabel(cardStep), 'Nikhila Marupally',
     'the card is named by its heading, not by everything the link contains');
  eq(T._describeAction(cardStep).action, 'Click on the "Nikhila Marupally" link',
     'so the step reads as an instruction a tester can follow');

  // With no narrower name available it is cut, on a word boundary. Seven words
  // is what the real recording produced, and it slipped under the eight-word
  // rule that _isJunkLabel uses to catch concatenated class names.
  const blobStep = {
    type: 'click',
    locator: "page.getByRole('link', { name: 'Nikhila Marupally Software Engineer Quality Engineering Equinox' })",
    role: 'link'
  };
  const blobLabel = T._elemLabel(blobStep);
  ok(blobLabel.length <= T.constructor.NAME_MAX + 1,
     'a name with nothing narrower behind it is cut to a readable length');
  ok(/…$/.test(blobLabel), 'and marked as cut rather than passed off as complete');
  ok(!/\bEngin$|\bQualit$|\bEqui$/.test(blobLabel.replace(/…$/, '')),
     'never through the middle of a word — a half-word cannot be found on the page');

  // Beyond eight words it was already rejected outright, and still is: the step
  // falls back to naming the KIND of control, which is honest.
  eq(T._elemLabel({
       type: 'click', role: 'link',
       locator: "page.getByRole('link', { name: 'Poojitha Yerukala Associate Software Engineer G1 Quality Engineering Equinox' })"
     }), '',
     'a nine-word blob is no name at all, as the existing word-count rule says');

  // An ordinary label of any normal length is untouched
  eq(T._elemLabel({ type: 'click', locator: "page.getByLabel('I agree with these terms')" }),
     'I agree with these terms', 'a real label is left exactly as it is');

  // --- A cleared field names the FIELD, not the control that cleared it ---
  // The control pressed is an × named "close icon" from the icon vocabulary, so
  // wording this from the clicked element produced "The content under 'Close
  // Icon' is hidden" for what is plainly a search box being emptied.
  eq(T._outcomeToEnglish({ kind: 'valueCleared', name: 'Search', count: 1 },
                         { locator: "page.getByText('close icon')" }),
     'The "Search" field is cleared and is empty',
     'the field that was emptied is the one reported');
  // With no field name measured it stays generic. It must NOT fall back to the
  // control that was pressed: that wrote 'The "Associate Software Engineer G1"
  // field is cleared' for a click on a person's card in a details panel.
  eq(T._outcomeToEnglish({ kind: 'valueCleared', name: '', count: 1 },
                         { locator: "page.getByLabel('Search')" }),
     'The entered value is cleared and the field is empty',
     'an unnamed clearing never borrows the pressed control’s label');
  eq(T._outcomeToEnglish({ kind: 'valueCleared', name: 'Employee', count: 3 },
                         { locator: "page.getByRole('button', { name: 'Reset' })" }),
     'The entered values are cleared and the fields are empty',
     'a Reset that emptied a whole form says so, rather than naming one field');

  // Nothing measurable: a control named from the clear vocabulary still reads
  // as clearing, not as a panel closing. Generic wording, no application in it.
  eq(T._inferredExpected({ type: 'click',
                           locator: "page.getByRole('button', { name: 'Clear' })",
                           role: 'button' }),
     'The entered value is cleared and the field is empty',
     'a Clear control implies what it does when nothing could be measured');
  eq(T._inferredExpected({ type: 'click', locator: "page.getByText('erase icon')" }),
     'The entered value is cleared and the field is empty',
     'and so does an icon-only one, read from the icon vocabulary');

  // Labelled controls are untouched by that fallback
  eq(T._outcomeToEnglish({ kind: 'checked' },
                         { locator: "page.getByLabel('I agree with these terms')" }),
     'The "I agree with these terms" checkbox is ticked',
     'a real label is still quoted');

  // --- A file name is a label, a host name is not ---
  ok(!T._isJunkLabel('Report.pdf'), 'a file name is a label a tester can read');
  ok(!T._isJunkLabel('Contract.docx'), 'and so is a document name');
  ok(!T._isJunkLabel('index.html'), 'one dot and no slash is never a host name');
  ok(T._isJunkLabel('app.example.com'), 'two dots and no spaces still is one');
  ok(T._isJunkLabel('example.com/reports'), 'and so is anything carrying a path');
  ok(T._isJunkLabel('https://app.example.com/x'), 'a full URL is still rejected');

  // --- "to" inside a field name does not make it a date field ---
  eq(T._valueNoun('Notes to reviewer'), 'text',
     'a note is asking for text, whatever words are in its name');
  eq(T._valueNoun('Report to manager'), 'value',
     'and an unrecognised field is not asking for a date either');
  eq(T._valueNoun('To'), 'date', 'a range field named To still asks for a date');
  eq(T._valueNoun('From'), 'date', 'as does one named From');
  eq(T._valueNoun('Start Date'), 'date', 'and anything with date in its name');
  eq(T._valueNoun('Due'), 'date', 'a due field asks for a date');

  // --- Generated ids are not labels ---
  ok(T._isJunkLabel('checkboxuof7wufzhoc23qjqszvhuwreportChk'),
     'a generated checkbox id is rejected as a label');
  ok(!T._isJunkLabel('Acknowledgements'),
     'a long real word is still a perfectly good label');
  ok(!T._isJunkLabel('Certification History'),
     'a long real label is kept');

  // A hover that REVEALED something is still a step
  T.steps = [
    { id: 1, ts: 1000, type: 'hover', locator: "page.getByRole('link', { name: 'Control Room' })",
      role: 'link', outcome: { kind: 'panelOpened', label: 'Control Room', hover: true } }
  ];
  const hovers = T._prepareSteps();
  eq(hovers.length, 1, 'a hover that opened a submenu is kept');
  eq(hovers[0].expected, 'The "Control Room" submenu opens and its options are listed',
     'the submenu wording is used for a hover');

  T.steps = [];
}

console.log('\n=== 2. BEHAVIOUR: recorder-tab navigation assertions ===');

{
  const t0 = 5000;
  const steps = [
    { id: 1, ts: t0,        type: 'navigate', url: 'https://app/login', locator: 'page' },
    { id: 2, ts: t0 + 500,  type: 'click', locator: "page.getByRole('button', { name: 'Sign In' })",
      css: 'button.login', xpath: '//button' },
    { id: 3, ts: t0 + 900,  type: 'navigate', url: 'https://app/dashboard', locator: 'page' }
  ];

  const js = recTab._generateCode(steps, 'pw-js', 'login');
  ok(js.includes("await page.goto('https://app/login');"),
     'the opening navigation still generates a goto');
  ok(js.includes("await expect(page).toHaveURL('https://app/dashboard');"),
     'a click-caused navigation becomes a URL assertion, not a second goto');
  ok((js.match(/page\.goto/g) || []).length === 1,
     'only one goto is emitted for the whole flow');

  const cy = recTab._generateCode(steps, 'cypress', 'login');
  ok(cy.includes("cy.url().should('eq', 'https://app/dashboard');"),
     'Cypress gets a url assertion for the click-caused navigation');

  const py = recTab._generateCode(steps, 'pw-py', 'login');
  ok(py.includes('expect(page).to_have_url("https://app/dashboard")'),
     'Playwright Python gets a url assertion');

  const selPy = recTab._generateCode(steps, 'sel-py', 'login');
  ok(selPy.includes('EC.url_to_be("https://app/dashboard")'),
     'Selenium Python gets an explicit wait on the URL');
  ok(selPy.includes('from selenium.webdriver.support import expected_conditions as EC'),
     'Selenium Python imports expected_conditions for that wait');

  const selJava = recTab._generateCode(steps, 'sel-java', 'login');
  ok(selJava.includes('ExpectedConditions.urlToBe("https://app/dashboard")'),
     'Selenium Java gets an explicit wait on the URL');
  ok(selJava.includes('import org.openqa.selenium.support.ui.WebDriverWait;'),
     'Selenium Java imports WebDriverWait for that wait');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. WIRING — cross-file invariants
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== 3. WIRING ===');

const manifest = JSON.parse(read('manifest.json'));
const sharedCtx = createSandbox();
loadInto(sharedCtx, 'shared/contentScriptFiles.js');
const SHARED_FILES = sharedCtx.self.PALTECH_CONTENT_SCRIPT_FILES;

// This is the invariant whose violation broke Inspection Mode.
eq(manifest.content_scripts[0].js, SHARED_FILES,
   'manifest content_scripts matches the shared content script list exactly');

// Every referenced file must exist
SHARED_FILES.concat([
  sharedCtx.self.PALTECH_PAGE_HOOK_FILE,
  sharedCtx.self.PALTECH_SHADOW_HOOK_FILE
]).forEach(f => {
  ok(fs.existsSync(path.join(ROOT, f)), `${f} exists on disk`);
});

// shadow.js has to come FIRST: every other module asks it how to see through a
// web component, and a module that loads before it silently falls back to
// document-only behaviour.
eq(SHARED_FILES[0], 'content/shadow.js',
   'the shadow DOM helpers load before the modules that use them');

// The closed-root hook is useless unless it replaces attachShadow BEFORE the
// page builds its components — which means declared in the manifest at
// document_start in the MAIN world, not injected when recording starts.
const shadowEntry = (manifest.content_scripts || [])
  .find(e => (e.js || []).indexOf(sharedCtx.self.PALTECH_SHADOW_HOOK_FILE) !== -1);
ok(!!shadowEntry, 'the manifest declares the shadow hook as a content script');
eq(shadowEntry.run_at, 'document_start',
   'and runs it before the page scripts that call attachShadow');
eq(shadowEntry.world, 'MAIN',
   'in the page world, because patching the isolated world changes nothing the page calls');
ok(shadowEntry.all_frames === true, 'and in every frame, since components live in iframes too');
ok(shadowEntry !== manifest.content_scripts[0],
   'kept separate from the isolated-world list so neither disturbs the other');

// The hook must not read or report anything — it exists only to widen access
const hookSrc  = read(sharedCtx.self.PALTECH_SHADOW_HOOK_FILE);
// Comments explain why the OTHER hook is injected differently, so compare code
const hookCode = hookSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(/attachShadow/.test(hookCode), 'the hook patches attachShadow');
ok(!/chrome\.|sendMessage|dispatchEvent|fetch\(|XMLHttpRequest/.test(hookCode),
   'and sends nothing anywhere — it only changes the mode of the page’s own roots');
ok(fs.existsSync(path.join(ROOT, manifest.background.service_worker)),
   'service worker file exists');
ok(fs.existsSync(path.join(ROOT, manifest.side_panel.default_path)),
   'side panel HTML exists');

// No tab may carry its own hard-coded injection list any more
['sidepanel/multi-tab.js', 'sidepanel/single-tab.js',
 'sidepanel/recorder-tab.js', 'sidepanel/test-steps-tab.js'].forEach(f => {
  const src = read(f);
  ok(!src.includes("'content/selectors.js'"),
     `${f} does not hard-code its own injection list`);
  ok(src.includes('PalTechUtils.ensureContentScripts') ||
     src.includes('RecordingController'),
     `${f} uses the shared injector / controller`);
});

// The panel must actually load the scripts it depends on
{
  const html = read('sidepanel/sidepanel.html');
  ok(html.includes('../content/codeGen.js'),
     'sidepanel.html loads codeGen.js (Code Snippets section depends on it)');
  ok(html.includes('../shared/contentScriptFiles.js'),
     'sidepanel.html loads the shared constants');
  // Every <script src> in the panel must resolve to a real file
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  srcs.forEach(src => {
    ok(fs.existsSync(path.resolve(ROOT, 'sidepanel', src)), `sidepanel script "${src}" exists`);
  });
}

// Re-injection guards: these files are evaluated more than once per page
[['content/content-script.js', 'PalTechContentScriptLoaded'],
 ['content/inspection.js',     'PalTechInspection'],
 ['content/recorder.js',       'PalTechRecorder'],
 ['content/pageHooks.js',      '__paltechPageHooksInstalled']].forEach(([f, guard]) => {
  ok(read(f).includes(`if (window.${guard})`),
     `${f} guards against double injection (${guard})`);
});

// The service worker needs the shared list to re-arm the recorder
{
  const bg = read('background.js');
  ok(bg.includes("importScripts('shared/contentScriptFiles.js')"),
     'background.js imports the shared file list');
  ok(bg.includes('onUpdated') && bg.includes('rearmRecorder'),
     'background.js re-arms the recorder after a navigation');
}

// The isolated world cannot patch the page's own history/dialogs
{
  const rec = read('content/recorder.js');
  ok(!rec.includes('history.pushState ='),
     'recorder.js no longer patches history from the isolated world (ineffective)');
  ok(!rec.includes('window.alert ='),
     'recorder.js no longer patches dialogs from the isolated world (ineffective)');
  ok(rec.includes("addEventListener('paltech-page-event'"),
     'recorder.js listens for MAIN-world page events instead');
}

// Page-lifecycle cleanup must use pagehide: unload is deprecated and is skipped
// entirely when a page enters the back/forward cache, which left the inspection
// overlay and its listeners behind on a page the tester had navigated away from.
{
  const inspectionSrc = read('content/inspection.js');
  ok(inspectionSrc.includes("addEventListener('pagehide'"),
     'inspection.js cleans up on pagehide');
  ok(!inspectionSrc.includes("addEventListener('unload'"),
     'inspection.js no longer relies on the deprecated unload event');
  ok(read('content/content-script.js').includes("addEventListener('pagehide'"),
     'content-script.js cleans up on pagehide');
}

// Every tab button needs a panel: clicking one whose panel is missing used to
// throw a TypeError out of the click handler and leave the panel half-switched.
{
  const panelHtml = read('sidepanel/sidepanel.html');
  const tabIds = (panelHtml.match(/data-tab="[a-z-]+"/g) || [])
    .map(m => m.slice('data-tab="'.length, -1));
  ok(tabIds.length > 0, 'the panel declares tab buttons');
  tabIds.forEach(id => {
    ok(panelHtml.includes('id="' + id + '-tab"'), 'tab "' + id + '" has a panel to show');
  });
  const panelJs = read('sidepanel/sidepanel.js');
  ok(/const panel = tabId \? document\.getElementById/.test(panelJs),
     'and the click handler checks the panel exists before touching it');
}

// ─────────────────────────────────────────────────────────────────────────────

console.log('\n==============================');
console.log('  Results: ' + pass + ' PASS  ' + fail + ' FAIL');
if (fail === 0) {
  console.log('  All tests passed.');
} else {
  console.error('  ' + fail + ' test(s) failed:');
  failures.forEach(f => console.error('    - ' + f));
}
process.exit(fail > 0 ? 1 : 0);
