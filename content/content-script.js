/**
 * content-script.js - Main content script file
 *
 * Wrapped in an IIFE with a re-injection guard. This file is listed both in
 * manifest.json (auto-injected at document_idle) AND in the side panel's
 * executeScript fallback, so it can be evaluated twice on the same page.
 * Without the guard each evaluation added another chrome.runtime.onMessage
 * listener: every request was then handled N times, N-1 calls to sendResponse
 * threw "Could not send response", and a Generate Selectors click ran the full
 * page scan once per duplicate.
 */
(function () {

  if (window.PalTechContentScriptLoaded) {
    return;
  }
  window.PalTechContentScriptLoaded = true;

  console.log("Content script loaded. Available modules:", {
    PalTechNaming: !!window.PalTechNaming,
    PalTechSelectors: !!window.PalTechSelectors,
    PalTechHighlight: !!window.PalTechHighlight,
    PalTechInspection: !!window.PalTechInspection,
    PalTechRecorder: !!window.PalTechRecorder,
    PalTechPlaywright: !!window.PalTechPlaywright,
    PalTechCodeGen: !!window.PalTechCodeGen
  });

  /**
   * Reports a missing module back to the side panel instead of throwing.
   * A throw inside the listener means sendResponse is never called and the
   * panel hangs on "The message port closed before a response was received".
   */
  function moduleMissing(sendResponse, moduleName) {
    const message = `${moduleName} is not loaded on this page. Reload the page and try again.`;
    console.error("PalTech: " + message);
    sendResponse({ success: false, error: message });
  }

  // Listen for messages from the sidepanel
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    console.log("Message received:", request.action);

    try {
      if (request.action === "generateSelectors") {
        if (!window.PalTechSelectors) {
          sendResponse({ data: null, error: "Selector module is not loaded on this page. Reload the page and try again." });
          return true;
        }
        const data = window.PalTechSelectors.generateUISelectors();
        const truncated = window.PalTechSelectors.getLastScanTruncated
          ? window.PalTechSelectors.getLastScanTruncated()
          : 0;
        sendResponse({ data: data, truncated: truncated });

      } else if (request.action === "highlightElement") {
        if (!window.PalTechHighlight) return moduleMissing(sendResponse, "Highlighting module"), true;
        window.PalTechHighlight.highlightElement(request.selector);
        sendResponse({ success: true });

      } else if (request.action === "removeHighlight") {
        if (!window.PalTechHighlight) return moduleMissing(sendResponse, "Highlighting module"), true;
        window.PalTechHighlight.removeHighlight();
        sendResponse({ success: true });

      } else if (request.action === "startInspection") {
        if (!window.PalTechInspection) return moduleMissing(sendResponse, "Inspection module"), true;
        const success = window.PalTechInspection.startInspectionMode();
        sendResponse({ success: success });

      } else if (request.action === "stopInspection") {
        if (!window.PalTechInspection) return moduleMissing(sendResponse, "Inspection module"), true;
        const success = window.PalTechInspection.stopInspectionMode();
        sendResponse({ success: success });

      } else if (request.action === "ping") {
        // Ping to check if content script is alive
        sendResponse({ alive: true });

      } else if (request.action === "startRecording") {
        if (!window.PalTechRecorder) return moduleMissing(sendResponse, "Recorder module"), true;
        window.PalTechRecorder.start(request.options || {});
        sendResponse({ success: true });

      } else if (request.action === "stopRecording") {
        if (!window.PalTechRecorder) return moduleMissing(sendResponse, "Recorder module"), true;
        window.PalTechRecorder.stop();
        sendResponse({ success: true });

      } else if (request.action === "isRecording") {
        sendResponse({ recording: !!(window.PalTechRecorder && window.PalTechRecorder.isActive()) });
      }
    } catch (err) {
      console.error("PalTech: error handling " + request.action, err);
      sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
    }

    return true; // Keep the message channel open for async responses
  });

  // Clean up when the content script is unloaded.
  // 'pagehide' fires in cases where 'unload' does not (bfcache, mobile).
  function cleanup() {
    if (window.PalTechHighlight) {
      window.PalTechHighlight.removeHighlight();
    }
    if (window.PalTechInspection) {
      window.PalTechInspection.stopInspectionMode();
    }
    if (window.PalTechRecorder) {
      window.PalTechRecorder.stop();
    }
  }

  window.addEventListener('pagehide', cleanup);

})();
