/**
 * pageHooks.js — runs in the page's MAIN world (not the extension's isolated
 * world) and reports SPA navigations and native dialogs to the recorder.
 *
 * WHY THIS FILE EXISTS
 * Content scripts run in an isolated world: they share the DOM with the page but
 * get their own copy of the JS globals. recorder.js used to patch
 * history.pushState / window.alert / confirm / prompt directly, which only ever
 * replaced the *isolated world's* copies — the page's own calls went straight
 * through the originals, so SPA route changes and dialogs were never recorded
 * despite being listed as supported.
 *
 * Patching has to happen in the MAIN world, which is what this file does. It has
 * no access to chrome.* APIs, so it reports events by dispatching a DOM
 * CustomEvent that the isolated-world recorder listens for. The payload is
 * JSON-stringified because only primitives cross the world boundary reliably.
 *
 * Injected with chrome.scripting.executeScript({ world: 'MAIN' }).
 */
(function () {

  // Re-injection guard — patching twice would report every event twice
  if (window.__paltechPageHooksInstalled) return;
  window.__paltechPageHooksInstalled = true;

  var EVENT_NAME = 'paltech-page-event';

  function emit(payload) {
    try {
      document.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: JSON.stringify(payload)
      }));
    } catch (e) {
      // Never let reporting break the host page
    }
  }

  // ── History (SPA route changes) ───────────────────────────────────────────

  var origPushState    = history.pushState;
  var origReplaceState = history.replaceState;

  history.pushState = function () {
    var result = origPushState.apply(this, arguments);
    emit({ kind: 'navigate', url: location.href });
    return result;
  };

  history.replaceState = function () {
    var result = origReplaceState.apply(this, arguments);
    emit({ kind: 'navigate', url: location.href });
    return result;
  };

  window.addEventListener('popstate',   function () { emit({ kind: 'navigate', url: location.href }); });
  window.addEventListener('hashchange', function () { emit({ kind: 'navigate', url: location.href }); });

  // ── Network activity ──────────────────────────────────────────────────────
  //
  // WHY: the recorder decides what an action achieved by waiting for DOM
  // mutations to go quiet. A grid that reloads over XHR is quiet for the whole
  // round trip, so the wait ended before the new rows arrived and the step was
  // reported as "no page change was detected". Counting requests in flight lets
  // the recorder keep waiting while the app is still fetching.
  //
  // Reporting only — nothing here alters a request or its result.

  // Each request is reported individually. A count alone was not enough: an app
  // holding a long-poll open would look permanently busy, and every step would
  // then wait for the full timeout. Ids let the recorder ignore requests that
  // were already in flight before the tester acted.
  var netSeq = 0;

  function netStart() {
    var id = ++netSeq;
    emit({ kind: 'net', ev: 'start', id: id });
    return id;
  }

  function netEnd(id) {
    emit({ kind: 'net', ev: 'end', id: id });
  }

  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function () {
      var id = netStart();
      var settled = false;
      var done = function () { if (!settled) { settled = true; netEnd(id); } };
      try {
        var p = origFetch.apply(this, arguments);
        if (p && typeof p.then === 'function') {
          p.then(done, done);
          return p;
        }
        done();
        return p;
      } catch (e) {
        done();
        throw e;
      }
    };
  }

  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    var origSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var id = netStart();
      var settled = false;
      var done = function () { if (!settled) { settled = true; netEnd(id); } };
      try {
        xhr.addEventListener('loadend', done);
      } catch (e) {}
      try {
        return origSend.apply(xhr, arguments);
      } catch (e) {
        done();
        throw e;
      }
    };
  }

  // ── Native dialogs ────────────────────────────────────────────────────────

  var origAlert   = window.alert;
  var origConfirm = window.confirm;
  var origPrompt  = window.prompt;

  window.alert = function (msg) {
    emit({
      kind: 'dialog', dialog: 'alert',
      message: String(msg == null ? '' : msg),
      result: 'accept', value: ''
    });
    return origAlert.apply(window, arguments);
  };

  window.confirm = function (msg) {
    var result = origConfirm.apply(window, arguments);
    emit({
      kind: 'dialog', dialog: 'confirm',
      message: String(msg == null ? '' : msg),
      result: result ? 'accept' : 'dismiss', value: ''
    });
    return result;
  };

  window.prompt = function (msg) {
    var result = origPrompt.apply(window, arguments);
    emit({
      kind: 'dialog', dialog: 'prompt',
      message: String(msg == null ? '' : msg),
      result: result !== null ? 'accept' : 'dismiss',
      value: result == null ? '' : String(result)
    });
    return result;
  };

})();
