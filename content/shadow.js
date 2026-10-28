/**
 * shadow.js — one implementation of "look through shadow DOM", shared by the
 * recorder, the selector builders and inspection mode.
 *
 * WHY THIS FILE EXISTS
 * A web component keeps its markup in a shadow root, and the platform hides
 * that markup from every ordinary DOM API:
 *
 *   1. EVENTS ARE RETARGETED. A click on a <button> inside a shadow root
 *      arrives at the document with event.target rewritten to the component's
 *      HOST element. The recorder read e.target, so every click anywhere inside
 *      a component produced the same step — three different buttons in a chat
 *      widget all recorded as 'Click on "Paltech Chat Widget Host"', named
 *      after the host's id because the host itself carries no label.
 *      event.composedPath()[0] is the element that was actually clicked.
 *
 *   2. THE TREE IS BROKEN IN TWO. parentElement returns null at a shadow
 *      boundary and closest() stops there, so "which dialog / nav / toolbar is
 *      this in?" could never be answered for anything inside a component.
 *
 *   3. QUERIES DO NOT DESCEND. document.querySelectorAll never sees inside a
 *      root, and neither does a MutationObserver on document. Every measurement
 *      the Expected Result column is built from was therefore blind to
 *      component content: the panel opening, the dialog appearing, the reply
 *      text arriving — all of it read as "no page change was detected".
 *
 *   4. TWO EVENTS NEVER ESCAPE AT ALL. `change` and `submit` are
 *      composed: false, so a <select>, a checkbox or a form inside any web
 *      component was silently unrecorded no matter what the handler did.
 *
 * Nothing here knows about any particular application or widget. It is the
 * generic answer for every web component — design systems, embedded support
 * widgets, Salesforce/Ionic/Vaadin style component libraries, and anything else
 * that calls attachShadow.
 *
 * CLOSED ROOTS: attachShadow({ mode: 'closed' }) hides the root even from
 * composedPath(). content/shadowHook.js re-opens those at document_start,
 * before page scripts run; when it could not (a page already loaded), the
 * component is opaque and looksOpaque() below says so, so a step can be
 * flagged for a human instead of described wrongly.
 */
(function () {

  // Re-injection guard — the side panel and the service worker both inject the
  // content scripts, and this file is evaluated again each time.
  if (window.PalTechShadow) return;

  var ELEMENT_NODE  = 1;
  var FRAGMENT_NODE = 11;         // ShadowRoot's nodeType
  var MAX_ROOTS     = 100;        // sane cap for pathological pages
  var MAX_DEPTH     = 40;         // ancestor walks
  var ROOTS_TTL_MS  = 200;        // one snapshot's worth of queries

  var rootsCache = null;
  var rootsStamp = 0;

  /** Is this node a ShadowRoot? */
  function isShadowRoot(node) {
    return !!node && node.nodeType === FRAGMENT_NODE && !!node.host;
  }

  /**
   * The element the user actually interacted with.
   *
   * composedPath() is the event's real route: for an event that started inside
   * an open shadow root its first entry is the inner element, while
   * event.target has been rewritten to the host. For a CLOSED root the path is
   * trimmed at the host as well, so this returns the host — which is the truth
   * of what is knowable, and looksOpaque() then reports it as unreadable.
   */
  function deepTarget(event) {
    if (!event) return null;
    try {
      var path = event.composedPath && event.composedPath();
      if (path && path.length) {
        // Text nodes never appear in composedPath, but be defensive: the first
        // ELEMENT on the path is what we want.
        for (var i = 0; i < path.length; i++) {
          if (path[i] && path[i].nodeType === ELEMENT_NODE) return path[i];
        }
      }
    } catch (_) {}
    return event.target || null;
  }

  /**
   * The parent in the FLAT tree — the tree as rendered, where a shadow root's
   * child is followed by the component's host rather than by nothing.
   * Slotted content resolves to the <slot> it is projected into, which is where
   * it visually sits.
   */
  function flatParent(node) {
    if (!node) return null;
    try {
      if (node.assignedSlot) return node.assignedSlot;
      // parentNode is the one that reveals a shadow boundary (it is the root
      // itself); parentElement is kept as a fallback so this works on any
      // node-like object that exposes only the element link.
      var parent = node.parentNode || node.parentElement;
      if (!parent) {
        // A detached-looking node at the top of a root: hop to the host
        var root = node.getRootNode && node.getRootNode();
        return isShadowRoot(root) ? root.host : null;
      }
      if (isShadowRoot(parent)) return parent.host;
      return parent.nodeType === ELEMENT_NODE ? parent : null;
    } catch (_) {
      return null;
    }
  }

  /** The element's ancestors in the flat tree, nearest first. */
  function flatAncestors(node, cap) {
    var out = [];
    var curr = flatParent(node);
    var max = cap || MAX_DEPTH;
    while (curr && out.length < max) {
      out.push(curr);
      curr = flatParent(curr);
    }
    return out;
  }

  /**
   * closest() that crosses shadow boundaries.
   * The element itself is tested first, exactly like the native method.
   */
  function deepClosest(node, selector) {
    var curr = node;
    for (var i = 0; i < MAX_DEPTH && curr; i++) {
      try {
        if (curr.nodeType === ELEMENT_NODE && curr.matches && curr.matches(selector)) return curr;
      } catch (_) {
        return null;                        // invalid selector — nothing matches
      }
      curr = flatParent(curr);
    }
    return null;
  }

  /** The document or shadow root this element lives in. */
  function rootOf(node) {
    try {
      var root = node && node.getRootNode && node.getRootNode();
      return root || document;
    } catch (_) {
      return document;
    }
  }

  /** Is this element inside a shadow root rather than the main document? */
  function inShadow(node) {
    return isShadowRoot(rootOf(node));
  }

  /** The host chain of an element, outermost first. [] for document content. */
  function hostChain(node) {
    var out = [];
    var root = rootOf(node);
    for (var i = 0; i < MAX_DEPTH && isShadowRoot(root); i++) {
      out.unshift(root.host);
      root = rootOf(root.host);
    }
    return out;
  }

  /**
   * Every OPEN shadow root on the page, outermost first, briefly cached.
   *
   * The cache exists because one snapshot of the page asks eight separate
   * questions ("any dialogs? any toasts? how many rows?") and each of them
   * needs the same list. It is deliberately short-lived: a root created by the
   * action being measured must be found by the NEXT snapshot.
   */
  function roots(maxAgeMs) {
    var ttl = (maxAgeMs === undefined) ? ROOTS_TTL_MS : maxAgeMs;
    if (rootsCache && (Date.now() - rootsStamp) <= ttl) return rootsCache;

    var found = [];
    var queue = [document];
    try {
      while (queue.length && found.length < MAX_ROOTS) {
        var scope = queue.shift();
        var all = scope.querySelectorAll('*');
        for (var i = 0; i < all.length && found.length < MAX_ROOTS; i++) {
          var sr = all[i].shadowRoot;
          if (sr) { found.push(sr); queue.push(sr); }
        }
      }
    } catch (_) {}

    rootsCache = found;
    rootsStamp = Date.now();
    return found;
  }

  /** Forget the cached root list — call after the DOM has certainly changed. */
  function resetCache() {
    rootsCache = null;
    rootsStamp = 0;
  }

  /**
   * querySelectorAll across the document AND every open shadow root.
   * @returns {Element[]} a plain array, capped
   */
  function queryAll(selector, cap) {
    var limit = cap || 500;
    var out = [];
    var take = function (scope) {
      if (out.length >= limit) return;
      try {
        var list = scope.querySelectorAll(selector);
        for (var i = 0; i < list.length && out.length < limit; i++) out.push(list[i]);
      } catch (_) {}
    };
    take(document);
    var list = roots();
    for (var i = 0; i < list.length; i++) take(list[i]);
    return out;
  }

  /** The first match anywhere, document first. */
  function query(selector) {
    var hits = queryAll(selector, 1);
    return hits.length ? hits[0] : null;
  }

  /**
   * How many elements a CSS selector matches, counted the way Playwright counts
   * them: its css= engine pierces open shadow roots, so a selector that is
   * unique inside a component IS unique as far as a test is concerned.
   *
   * Counting with document.querySelectorAll alone returned 0 for anything
   * inside a component, so every role/label/text locator was rejected as
   * "matches nothing" and the builder fell through to a CSS path or an XPath
   * that could never resolve.
   */
  function count(selector) {
    return queryAll(selector, 1000).length;
  }

  /** The element that really has focus, following it into shadow roots. */
  function activeElement() {
    try {
      var el = document.activeElement;
      for (var i = 0; i < MAX_DEPTH; i++) {
        if (!el || !el.shadowRoot || !el.shadowRoot.activeElement) break;
        el = el.shadowRoot.activeElement;
      }
      return el;
    } catch (_) {
      return null;
    }
  }

  /**
   * Visible text length of the page INCLUDING component content.
   *
   * document.body.textContent stops at every shadow boundary, so the generic
   * "something appeared" signal never moved for a component that rendered a
   * whole panel of text.
   */
  function textLength() {
    var total = 0;
    try {
      total = (document.body && document.body.textContent || '').length;
      var list = roots();
      for (var i = 0; i < list.length; i++) {
        total += (list[i].textContent || '').length;
      }
    } catch (_) {}
    return total;
  }

  /**
   * A Playwright pierce path for an element inside a shadow root:
   *   'css=div#chat-host >> css=button.cw_btn'
   *
   * Only needed to disambiguate — Playwright's css=, getByRole and getByText
   * engines already descend into open roots on their own. Returns '' for
   * elements that are not in a shadow root.
   */
  function piercePath(node) {
    if (!inShadow(node)) return '';
    var sel = window.PalTechSelectors;
    var ident = (sel && sel.cssEscapeIdent) ? sel.cssEscapeIdent : function (s) { return s; };

    var describe = function (el) {
      if (!el || !el.tagName) return '';
      var tag = el.tagName.toLowerCase();
      if (el.id) return tag + '#' + ident(el.id);
      var classes = [];
      try {
        classes = (sel && sel.getClassNames) ? sel.getClassNames(el) : [];
      } catch (_) {}
      return classes.length ? tag + '.' + classes.map(ident).join('.') : tag;
    };

    var parts = [];
    var chain = hostChain(node);
    for (var i = 0; i < chain.length; i++) {
      var d = describe(chain[i]);
      if (d) parts.push('css=' + d);
    }
    var own = describe(node);
    if (own) parts.push('css=' + own);
    return parts.length > 1 ? parts.join(' >> ') : '';
  }

  /**
   * An element that renders something but exposes nothing — the signature of a
   * CLOSED shadow root seen from outside: it takes up space on screen, yet has
   * no children, no text and no label of its own.
   *
   * There is no API that reveals a closed root, so the honest thing is to
   * detect that we are blind and say so on the step, rather than describing the
   * host element as if the tester had clicked it.
   */
  function looksOpaque(node) {
    try {
      if (!node || node.nodeType !== ELEMENT_NODE) return false;
      if (node.shadowRoot) return false;                 // open: we can read it
      if (node.childElementCount > 0) return false;
      if ((node.textContent || '').trim()) return false;
      if (node.getAttribute('aria-label') || node.getAttribute('title')) return false;
      var tag = node.tagName.toLowerCase();
      // Elements that are legitimately empty and perfectly describable
      if (/^(input|img|svg|use|path|br|hr|area|source|track|iframe|canvas|textarea|select|video|audio|embed|object)$/.test(tag)) {
        return false;
      }
      var box = node.getBoundingClientRect();
      return box.width > 8 && box.height > 8;
    } catch (_) {
      return false;
    }
  }

  window.PalTechShadow = {
    deepTarget, flatParent, flatAncestors, deepClosest,
    rootOf, inShadow, isShadowRoot, hostChain,
    roots, resetCache, queryAll, query, count,
    activeElement, textLength, piercePath, looksOpaque
  };

})();
