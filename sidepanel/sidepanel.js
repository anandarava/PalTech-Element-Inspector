/**
 * sidepanel.js - Main script for the sidepanel
 * Coordinates tab navigation and initializes components
 */

document.addEventListener('DOMContentLoaded', function() {
    // Tab navigation
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    // Initialize tab functionality
    tabs.forEach(tab => {
      tab.addEventListener('click', function() {
        // Remove active class from all tabs and contents
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.classList.remove('active'));

        // Add active class to clicked tab and corresponding content
        this.classList.add('active');
        const tabId = this.getAttribute('data-tab');
        // A button whose panel is missing must not take the whole panel down
        // with a TypeError — leave the tabs alone and say which one is broken.
        const panel = tabId ? document.getElementById(`${tabId}-tab`) : null;
        if (panel) {
          panel.classList.add('active');
        } else {
          console.warn(`PalTech: no panel found for tab "${tabId}"`);
        }
      });
    });

    // ── Stale-data banner ─────────────────────────────────────────────────
    // Background.js fires 'tabChanged' when the active tab or URL changes.
    // Show a banner so users know the displayed selectors belong to a
    // different page. Hide it again after a fresh Generate Selectors run.
    const staleBanner = document.getElementById('staleBanner');
    const generateBtn = document.getElementById('generate');

    chrome.runtime.onMessage.addListener((request) => {
      if (request.action === 'tabChanged' && staleBanner) {
        staleBanner.style.display = 'block';
      }
    });

    if (generateBtn && staleBanner) {
      generateBtn.addEventListener('click', () => {
        staleBanner.style.display = 'none';
      });
    }

    // ── Resume a recording the last panel document left running ───────────
    // Closing the side panel destroys this document, but not the recorder in
    // the page and not the service worker that re-arms it after every
    // navigation. Every tab class has registered by the time this file runs
    // (it is the last script in sidepanel.html), so the shared controller can
    // now hand the still-running session back to whichever tab started it —
    // without which the reopened panel showed a disabled Stop button over a
    // recorder that could no longer be stopped from the UI at all.
    if (window.PalTechUtils && window.PalTechUtils.RecordingController) {
      window.PalTechUtils.RecordingController.restore();
    }

    // ── Dark mode toggle ──────────────────────────────────────────────────
    const darkModeToggle = document.getElementById('darkModeToggle');

    function applyDark(on) {
      document.body.classList.toggle('dark', on);
      darkModeToggle.textContent = on ? '☀️' : '🌙';
    }

    // Restore saved preference
    chrome.storage.local.get(['darkMode'], (result) => {
      applyDark(!!result.darkMode);
    });

    darkModeToggle.addEventListener('click', () => {
      const isDark = document.body.classList.contains('dark');
      applyDark(!isDark);
      chrome.storage.local.set({ darkMode: !isDark });
    });
  });