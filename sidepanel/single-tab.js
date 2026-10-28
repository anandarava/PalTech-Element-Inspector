/**
 * single-tab.js - Single Element Inspector tab functionality
 * With robust cleanup mechanisms for inspection mode
 */

class SingleInspectorTab {
  constructor() {
    // UI elements
    this.toggleInspectorBtn = document.getElementById('toggleInspector');
    this.inspectorMode = document.getElementById('inspectorMode');
    this.elementInfo = document.getElementById('elementInfo');
    this.elementTag = document.getElementById('elementTag');
    this.elementText = document.getElementById('elementText');
    this.elementName = document.getElementById('elementName');
    this.singleResults = document.getElementById('singleResults');
    this.addToListBtn      = document.getElementById('addToListBtn');
    this.bookmarkSingleBtn = document.getElementById('bookmarkSingleBtn');
    // State
    this.isInspecting = false;
    this.inspectedElement = null;
    this.activeTabId = null;
    this._activeTabUrl = '';

    // Bind event handlers
    this.toggleInspectorBtn.addEventListener('click', this.toggleInspector.bind(this));
    this.addToListBtn.addEventListener('click', this.addInspectedToList.bind(this));
    this.bookmarkSingleBtn.addEventListener('click', this.bookmarkInspectedElement.bind(this));

    // Get current active tab ID
    this.updateActiveTabId();

    // Listen for messages from content script
    this.setupMessageListener();

    // Ensure cleanup on unload
    window.addEventListener('beforeunload', this.forceCleanup.bind(this));
    window.addEventListener('unload', this.forceCleanup.bind(this));

    // Modify the initial inspector mode display to be more compact
    this.inspectorMode.classList.add('info-text');
    this.inspectorMode.innerHTML = '<small>👆 Click the button above to start inspection, then click on page elements to inspect them.</small>';
  }
  
  /**
   * Updates the active tab ID
   */
  updateActiveTabId() {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs && tabs.length > 0) {
        this.activeTabId = tabs[0].id;
      }
    });
  }
  
  /**
   * Shows an inline error message in the single-inspector tab.
   * Replaces alert() so the side panel never freezes the Chrome window.
   * @param {string} message
   */
  showError(message) {
    if (!message) return;
    const el = document.getElementById('singleErrorMessage');
    if (!el) return;
    el.textContent = message;
    el.style.display = 'block';
    clearTimeout(this._errorTimer);
    this._errorTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  /**
   * Toggles the inspection mode on/off
   */
  toggleInspector() {
    if (!this.isInspecting) {
      this.startInspection();
    } else {
      this.stopInspection();
    }
  }
  
  /**
   * Forces cleanup of inspection mode
   */
  forceCleanup() {
    if (this.activeTabId) {
      chrome.tabs.sendMessage(this.activeTabId, {
        action: "stopInspection"
      }).catch(() => {});
    }
    this.resetInspectionState();
  }
  
  /**
   * Starts the element inspection mode
   */
  startInspection() {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (!tabs || tabs.length === 0) {
        this.showError("Could not determine active tab. Try refreshing the page.");
        return;
      }
      this.activeTabId  = tabs[0].id;
      this._activeTabUrl = tabs[0].url || '';

      // Shared injector — see utils.js. Every tab must inject the same file set,
      // otherwise whichever tab injects first decides which features work.
      window.PalTechUtils.ensureContentScripts(this.activeTabId, () => {
        chrome.tabs.sendMessage(this.activeTabId, {action: "startInspection"}, (response) => {
          if (chrome.runtime.lastError) {
            this.showError("Error: " + chrome.runtime.lastError.message);
            return;
          }
          if (response && response.success) {
            this.isInspecting = true;
            this.toggleInspectorBtn.textContent = 'Stop Inspection';
            this.toggleInspectorBtn.style.backgroundColor = '#dc3545';
            this.inspectorMode.classList.add('active');
            this.inspectorMode.innerHTML = '<small>&#10024; Inspection mode active. Click on any page element to inspect it.</small>';
          } else {
            this.showError('Could not start inspection mode. Try reloading the page.');
          }
        });
      }, (errMsg) => {
        this.showError("Error: " + errMsg);
      });
    });
  }

  /**
   * Stops the element inspection mode
   */
  stopInspection() {
    if (!this.activeTabId) {
      this.resetInspectionState();
      return;
    }
    
    chrome.tabs.sendMessage(this.activeTabId, {action: "stopInspection"}, (response) => {
      if (chrome.runtime.lastError) {
        console.error("Error stopping inspection:", chrome.runtime.lastError);
        // Try force cleanup as a fallback
        this.forceCleanup();
      } else {
        console.log("Stop inspection response:", response);
        this.resetInspectionState();
      }
    });
  }
  
  /**
   * Resets the inspection state in the UI
   */
  resetInspectionState() {
    this.isInspecting = false;
    this.toggleInspectorBtn.textContent = 'Start Inspection Mode';
    this.toggleInspectorBtn.style.backgroundColor = '#4285f4';
    this.inspectorMode.classList.remove('active');
    this.inspectorMode.innerHTML = '<small>👆 Click the button above to start inspection, then click on page elements to inspect them.</small>';
  }
  
  /**
   * Pushes the currently inspected element into the Multiple Elements table.
   * Converts the single-inspector element data into the row format expected
   * by MultiElementsTab.addSelector().
   */
  addInspectedToList() {
    if (!this.inspectedElement) return;
    const el = this.inspectedElement;

    // Build a row object matching the multi-tab column keys
    const cssSelectors  = (el.alternativeSelectors || []).filter(s => s.type === 'css'   && s.count === 1);
    const xpathSelectors = (el.alternativeSelectors || []).filter(s => s.type === 'xpath' && s.count === 1);

    const row = {
      'Element Name':       el.name || el.tag,
      'Relative XPath':     xpathSelectors.length ? xpathSelectors[0].selector : '',
      'Xpath selectors Count': xpathSelectors.length ? xpathSelectors[0].count : 0,
      'CSS Selector':       cssSelectors.length  ? cssSelectors[0].selector  : '',
      'CSS selectors count': cssSelectors.length  ? cssSelectors[0].count    : 0,
      'jQuery Selector':    cssSelectors.length  ? `$("${cssSelectors[0].selector}")` : '',
      'Playwright Locator': el.playwrightLocator  || '',
      'Playwright Priority': el.playwrightPriority || 'N/A'
    };

    if (window.multiElementsTab) {
      window.multiElementsTab.addSelector(row);
      // Switch to the Multiple Elements tab so user sees the result
      document.querySelector('.tab[data-tab="multiple"]').click();
    }
  }

  /**
   * Saves the currently inspected element to chrome.storage.local bookmarks,
   * using the same format as MultiElementsTab.bookmarkSelector() so the
   * Bookmarks tab can display it correctly.
   */
  bookmarkInspectedElement() {
    if (!this.inspectedElement) return;
    const el = this.inspectedElement;

    const cssSelectors   = (el.alternativeSelectors || []).filter(s => s.type === 'css'   && s.count === 1);
    const xpathSelectors = (el.alternativeSelectors || []).filter(s => s.type === 'xpath' && s.count === 1);

    const data = {
      'Element Name':          el.name || el.tag,
      'Relative XPath':        xpathSelectors.length ? xpathSelectors[0].selector : '',
      'Xpath selectors Count': xpathSelectors.length ? xpathSelectors[0].count    : 0,
      'CSS Selector':          cssSelectors.length   ? cssSelectors[0].selector   : '',
      'CSS selectors count':   cssSelectors.length   ? cssSelectors[0].count      : 0,
      'jQuery Selector':       cssSelectors.length   ? `$("${cssSelectors[0].selector}")` : '',
      'Playwright Locator':    el.playwrightLocator  || '',
      'Playwright Priority':   el.playwrightPriority || 'N/A'
    };

    let domain = 'unknown';
    try { domain = new URL(this._activeTabUrl).hostname || 'unknown'; } catch (_) {}

    window.PalTechUtils.addBookmark({
      domain,
      pageUrl:     this._activeTabUrl,
      elementName: data['Element Name'],
      data
    }, (err) => {
      const errEl = document.getElementById('singleErrorMessage');

      // A failed write must not look like a saved bookmark
      if (err) {
        if (errEl) {
          errEl.textContent = `Could not save the bookmark: ${err}`;
          errEl.style.color = '';
          errEl.style.borderLeftColor = '';
          errEl.style.background = '';
          errEl.style.display = 'block';
        }
        return;
      }

      // Visual feedback — fill the star and disable to prevent duplicates
      this.bookmarkSingleBtn.textContent = '★ Bookmarked';
      this.bookmarkSingleBtn.disabled    = true;
      this.bookmarkSingleBtn.classList.add('bookmarked');
      // Notify the user where to find it
      if (errEl) {
        errEl.textContent  = `Bookmarked "${data['Element Name']}" — view it in the Bookmarks tab.`;
        errEl.style.color  = '#0f9d58';
        errEl.style.borderLeftColor = '#0f9d58';
        errEl.style.background = '#e6f4ea';
        errEl.style.display = 'block';
        clearTimeout(this._errorTimer);
        this._errorTimer = setTimeout(() => {
          errEl.style.display = 'none';
          errEl.style.color = '';
          errEl.style.borderLeftColor = '';
          errEl.style.background = '';
        }, 4000);
      }
    });
  }

  /**
   * Checks chrome.storage.local for whether the currently displayed element
   * is bookmarked and updates the bookmark button state accordingly.
   * Called on element display and whenever the bookmarks storage key changes.
   */
  _syncBookmarkState() {
    if (!this.inspectedElement) return;
    const name    = this.inspectedElement.name || this.inspectedElement.tag;
    const locator = this.inspectedElement.playwrightLocator || '';
    chrome.storage.local.get('paltech_bookmarks', (result) => {
      const bookmarks = result.paltech_bookmarks || [];
      const isBookmarked = bookmarks.some(b =>
        b.elementName === name &&
        b.data && b.data['Playwright Locator'] === locator
      );
      if (isBookmarked) {
        this.bookmarkSingleBtn.textContent = '★ Bookmarked';
        this.bookmarkSingleBtn.disabled    = true;
        this.bookmarkSingleBtn.classList.add('bookmarked');
      } else {
        this.bookmarkSingleBtn.textContent = '☆ Bookmark';
        this.bookmarkSingleBtn.disabled    = false;
        this.bookmarkSingleBtn.classList.remove('bookmarked');
      }
    });
  }

  /**
   * Sets up the message listener for element inspection
   */
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "elementInspected") {
        console.log("Element inspected, displaying details");
        this.displayInspectedElement(request.element);
        sendResponse({success: true});
      } else if (request.action === "inspectionStoppedByEscape") {
        // User pressed Escape on the page — reset the side panel button
        this.resetInspectionState();
        sendResponse({success: true});
      }
      return true;
    });

    // Keep bookmark button in sync when bookmarks are added/removed from any tab
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.paltech_bookmarks) {
        this._syncBookmarkState();
      }
    });
  }
  
  /**
   * Removes duplicate selectors from an array based on the selector property
   * @param {Array} selectors - Array of selector objects
   * @returns {Array} - Array with duplicates removed
   */
  removeDuplicateSelectors(selectors) {
    const seen = new Set();
    return selectors.filter(selector => {
      // Normalize the selector for comparison
      const normalizedSelector = selector.selector.trim();
      if (seen.has(normalizedSelector)) {
        return false; // This is a duplicate
      }
      seen.add(normalizedSelector);
      return true;
    });
  }
  
  /**
   * Displays the inspected element details
   * @param {Object} element - The element data
   */
  displayInspectedElement(element) {
    this.inspectedElement = element;

    // Sync bookmark button state with storage (handles already-bookmarked elements)
    this._syncBookmarkState();

    // Show element info
    this.elementInfo.style.display = 'block';
    this.elementTag.textContent = element.tag;
    this.elementText.textContent = element.text || '(no text)';
    this.elementName.textContent = element.name;
    
    // Filter and sort selectors by type and remove zero-count selectors
    const allSelectors = element.alternativeSelectors || [];
    
    // Remove duplicates, filter zero-count selectors, and sort by selector specificity 
    const xpathSelectors = this.removeDuplicateSelectors(
      allSelectors.filter(sel => sel.type === 'xpath' && !sel.error && sel.count > 0)
    ).sort((a, b) => a.count - b.count);
      
    const cssSelectors = this.removeDuplicateSelectors(
      allSelectors.filter(sel => sel.type === 'css' && !sel.error && sel.count > 0)
    ).sort((a, b) => a.count - b.count);
      
    const jquerySelectors = this.removeDuplicateSelectors(
      allSelectors.filter(sel => sel.type === 'jquery' && !sel.error && sel.count > 0)
    ).sort((a, b) => a.count - b.count);
    
    // Build HTML for sections - always include sections if they have selectors
    let html = '';
    
    // Fallback selectors use counts from the content script's alternativeSelectors
    // (NOT document.getElementsByTagName which would count elements in the side panel, not the inspected page)
    const tagXpathEntry = allSelectors.find(s => s.type === 'xpath' && s.selector === `//${element.tag}`);
    const tagSelector = {
      selector: `//${element.tag}`,
      count: tagXpathEntry ? tagXpathEntry.count : 0,
      type: 'xpath'
    };
    const defaultSelectors = tagSelector.count > 0 ? [tagSelector] : [];

    // XPath Selectors Section - only display if there are valid selectors
    if (xpathSelectors.length > 0) {
      html += this.createSelectorSection('XPath Selectors', xpathSelectors);
    } else if (defaultSelectors.length > 0) {
      html += this.createSelectorSection('XPath Selectors', defaultSelectors);
    }

    // CSS Selectors Section - only display if there are valid selectors
    if (cssSelectors.length > 0) {
      html += this.createSelectorSection('CSS Selectors', cssSelectors);
    } else {
      const cssTagEntry = allSelectors.find(s => s.type === 'css' && s.selector === element.tag);
      const cssTagSelector = {
        selector: element.tag,
        count: cssTagEntry ? cssTagEntry.count : 0,
        type: 'css'
      };
      if (cssTagSelector.count > 0) {
        html += this.createSelectorSection('CSS Selectors', [cssTagSelector]);
      }
    }

    // jQuery Selectors Section - only display if there are valid selectors
    if (jquerySelectors.length > 0) {
      html += this.createSelectorSection('jQuery Selectors', jquerySelectors);
    } else {
      const jQueryTagEntry = allSelectors.find(s => s.type === 'jquery' && s.selector === `$("${element.tag}")`);
      const jQueryTagSelector = {
        selector: `$("${element.tag}")`,
        count: jQueryTagEntry ? jQueryTagEntry.count : 0,
        type: 'jquery'
      };
      if (jQueryTagSelector.count > 0) {
        html += this.createSelectorSection('jQuery Selectors', [jQueryTagSelector]);
      }
    }
    
    // Inspection error (selector generation failed for this element)
    if (element.inspectError) {
      html = `<div class="selector-group">
        <div style="padding:8px;font-size:12px;color:#b71c1c;background:#fdecea;border-left:3px solid #d32f2f;">
          ${window.PalTechUtils.escapeHtml(element.inspectError)}
        </div>
      </div>` + html;
    }

    // iFrame note
    if (element.iframeNote) {
      html = `<div class="selector-group">
        <div style="padding:8px;font-size:12px;color:#856404;background:#fff3cd;border-left:3px solid #ffc107;">
          ${window.PalTechUtils.escapeHtml(element.iframeNote)}
        </div>
      </div>` + html;
    }

    // Shadow DOM pierce path (Web Components)
    if (element.shadowPiercePath) {
      const escapedPath = window.PalTechUtils.escapeForAttribute(element.shadowPiercePath);
      html = `<div class="selector-group shadow-group">
        <h3>Shadow DOM Pierce Path <span class="shadow-badge">Shadow</span></h3>
        <div class="selector-list">
          <div class="compact-selector">
            <span class="selector-text playwright-locator-text" title="${escapedPath}">${window.PalTechUtils.escapeHtml(element.shadowPiercePath)}</span>
            <div class="selector-actions">
              <span class="copy-icon" data-selector="${escapedPath}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </span>
            </div>
          </div>
        </div>
      </div>` + html;
    }

    // Playwright Locator Section
    if (element.playwrightLocator) {
      const priority = element.playwrightPriority || 'N/A';
      const level = parseInt((priority).replace('P', ''), 10);
      let badgeClass = 'priority-low';
      if (level >= 1 && level <= 3) badgeClass = 'priority-high';
      else if (level >= 4 && level <= 7) badgeClass = 'priority-medium';

      const escapedLocator = window.PalTechUtils.escapeForAttribute(element.playwrightLocator);
      html = `<div class="selector-group playwright-group">
        <h3>Playwright Locator <span class="priority-badge ${badgeClass}" title="${window.PalTechUtils.escapeHtml(priority)}">${window.PalTechUtils.escapeHtml(priority)}</span></h3>
        <div class="selector-list">
          <div class="compact-selector">
            <span class="selector-text playwright-locator-text" title="${escapedLocator}">${window.PalTechUtils.escapeHtml(element.playwrightLocator)}</span>
            <div class="selector-actions">
              <span class="copy-icon" data-selector="${escapedLocator}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </span>
            </div>
          </div>
        </div>
      </div>` + html;
    }

    // ── Code Snippets (multi-framework) ─────────────────────────────────
    if (element.playwrightLocator && window.PalTechCodeGen) {
      const cssFirst = (element.alternativeSelectors || [])
        .filter(s => s.type === 'css' && s.count === 1)[0];
      const xpFirst  = (element.alternativeSelectors || [])
        .filter(s => s.type === 'xpath' && s.count === 1)[0];
      const snippets = window.PalTechCodeGen.generateFrameworkSnippets(
        element.playwrightLocator,
        cssFirst ? cssFirst.selector : '',
        xpFirst  ? xpFirst.selector  : '',
        element.name
      );

      let snippetHtml = `<div class="selector-group code-snippet-group">
        <h3>Code Snippets
          <span class="framework-tabs" id="frameworkTabs">`;
      snippets.forEach((s, i) => {
        snippetHtml += `<button class="fw-tab${i === 0 ? ' fw-tab-active' : ''}" data-idx="${i}">${s.framework} ${s.language}</button>`;
      });
      snippetHtml += `</span></h3>
        <div class="snippet-container" id="snippetContainer">`;
      snippets.forEach((s, i) => {
        const escaped = window.PalTechUtils.escapeHtml(s.code);
        const escapedRaw = window.PalTechUtils.escapeForAttribute(s.code);
        snippetHtml += `<div class="snippet-pane${i === 0 ? '' : ' hidden'}" data-idx="${i}">
          <pre class="snippet-code">${escaped}</pre>
          <div class="snippet-actions">
            <span class="copy-icon" data-selector="${escapedRaw}" title="Copy snippet">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </span>
          </div>
        </div>`;
      });
      snippetHtml += `</div></div>`;
      html += snippetHtml;
    }

    // If no sections were added, show a message
    if (html === '') {
      html = '<p>No valid selectors found for this element. Try selecting a different element.</p>';
    }

    this.singleResults.innerHTML = html;
    
    this.addEventListeners();
  }
  
  /**
   * Creates a selector section with header and list of selectors
   * @param {string} title - The section title
   * @param {Array} selectors - Array of selector objects
   * @param {boolean} isGeneralized - Whether these are generalized selectors
   * @returns {string} - HTML for the section
   */
  createSelectorSection(title, selectors, isGeneralized = false) {
    return `<div class="selector-group">
      <h3>${title}</h3>
      <div class="selector-list">
        ${selectors.map(sel => this.createCompactSelector(sel, isGeneralized)).join('')}
      </div>
    </div>`;
  }
  
  /**
   * Creates a compact selector display
   * @param {Object} sel - The selector data
   * @param {boolean} isGeneralized - Whether this is a generalized selector
   * @returns {string} - HTML string for the selector display
   */
  createCompactSelector(sel, isGeneralized = false) {
    // Properly escape the selector for HTML attributes
    const escapedSelector = window.PalTechUtils.escapeForAttribute(sel.selector);
    
    // Use the selector's count
    const count = sel.count || 0;
    const description = sel.description || '';
    
    // Determine badge color based on count
    let badgeColor = '#4285f4'; // Default blue
    
    if (count === 1) {
      badgeColor = '#0f9d58'; // Green for unique selectors
    } else if (count >= 2 && count <= 5) {
      badgeColor = '#f4b400'; // Yellow/amber for somewhat specific selectors
    } else if (count >= 10) {
      badgeColor = '#db4437'; // Red for very general selectors
    }
    
    // Fragility score badge
    let fragilityHtml = '';
    if (window.PalTechUtils && window.PalTechUtils.scoreFragility) {
      const frag = window.PalTechUtils.scoreFragility(sel.selector, sel.type);
      const fragClass = frag.label === 'Stable' ? 'frag-stable'
                      : frag.label === 'Moderate' ? 'frag-moderate'
                      : 'frag-fragile';
      fragilityHtml = `<span class="frag-badge ${fragClass}" title="${window.PalTechUtils.escapeHtml(frag.reason)}">${frag.label}</span>`;
    }

    // Display the full selector - no truncation
    return `
      <div class="compact-selector">
        <span class="selector-text" title="${escapedSelector}">${window.PalTechUtils.escapeHtml(sel.selector)}</span>
        <div class="selector-actions">
          <span class="copy-icon" data-selector="${escapedSelector}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </span>
          ${fragilityHtml}
          <span class="count-badge" style="background-color: ${badgeColor};" data-count="${count >= 10 ? '10+' : count}">${count}</span>
        </div>
      </div>
      ${description ? `<div class="selector-description">${window.PalTechUtils.escapeHtml(description)}</div>` : ''}
    `;
  }
  
  /**
   * Adds event listeners to selector items
   */
  addEventListeners() {
    // Framework tab switching in Code Snippets section
    const fwTabs = this.singleResults.querySelector('#frameworkTabs');
    const snippetContainer = this.singleResults.querySelector('#snippetContainer');
    if (fwTabs && snippetContainer) {
      fwTabs.querySelectorAll('.fw-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          const idx = tab.dataset.idx;
          fwTabs.querySelectorAll('.fw-tab').forEach(t => t.classList.remove('fw-tab-active'));
          tab.classList.add('fw-tab-active');
          snippetContainer.querySelectorAll('.snippet-pane').forEach(p => {
            p.classList.toggle('hidden', p.dataset.idx !== idx);
          });
        });
      });
    }

    // Add event listeners for copy buttons
    this.singleResults.querySelectorAll('.copy-icon').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const selector = btn.dataset.selector;
        window.PalTechUtils.copyToClipboard(selector);
        
        // Show success indicator
        const originalContent = btn.innerHTML;
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;
        
        // Restore original content after delay
        setTimeout(() => {
          btn.innerHTML = originalContent;
        }, 1500);
      });
    });
  }
}

// Create global instance
window.singleInspectorTab = new SingleInspectorTab();