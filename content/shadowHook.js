/**
 * shadowHook.js — runs in the page's MAIN world at document_start and makes
 * closed shadow roots readable.
 *
 * WHY THIS FILE EXISTS
 * attachShadow({ mode: 'closed' }) hides a component's markup from everything
 * outside it — including event.composedPath(), which is trimmed at the host.
 * A recorder outside the component therefore cannot know WHICH button was
 * clicked; every interaction anywhere inside the widget looks identical,
 * because the only element it is allowed to see is the host.
 *
 * Re-opening the root gives the same access the browser's own devtools have.
 * Nothing is read here and nothing is reported — the single line below only
 * changes how the page's own components are created, and content/shadow.js in
 * the isolated world does the rest.
 *
 * TIMING IS THE WHOLE POINT. This has to be a DECLARED content script at
 * run_at: document_start, world: MAIN — it must replace attachShadow before
 * the page's own scripts call it. content/pageHooks.js is injected with
 * chrome.scripting.executeScript when recording starts, which is far too late:
 * by then the components have long since built their roots.
 *
 * COMPATIBILITY: a component that tests `el.shadowRoot === null` to detect
 * tampering will see an open root instead. That is the known cost, and it is
 * the same cost every DOM-inspection tool pays. Everything else behaves
 * identically: mode is the only field changed, and the return value the page
 * receives is the real root.
 */
(function () {

  // Re-injection guard — patching twice is harmless but pointless
  if (window.__paltechShadowHookInstalled) return;
  window.__paltechShadowHookInstalled = true;

  try {
    var original = Element.prototype.attachShadow;
    if (typeof original !== 'function') return;

    Element.prototype.attachShadow = function (init) {
      var opts = init;
      try {
        if (init && init.mode === 'closed') {
          opts = {};
          for (var key in init) opts[key] = init[key];
          opts.mode = 'open';
        }
      } catch (e) {
        opts = init;
      }
      return original.call(this, opts);
    };

    // Keep the patch invisible to feature-detection that stringifies the method
    try {
      Element.prototype.attachShadow.toString = function () {
        return original.toString();
      };
    } catch (e) {}
  } catch (e) {
    // Never let this break the host page — a page with no shadow DOM at all
    // must behave exactly as before.
  }

})();
