/**
 * multi-tab.js - Multiple Elements tab functionality
 * Final fix for selector display issues
 */

class MultiElementsTab {
    constructor() {
      // UI elements
      this.generateBtn = document.getElementById('generate');
      this.exportBtn = document.getElementById('export');
      this.exportJsonBtn = document.getElementById('exportJson');
      this.exportPomBtn  = document.getElementById('exportPom');
      this.resultsDiv = document.getElementById('results');
      this.enableHighlightCheckbox = document.getElementById('enableHighlight');
      this.statusMessage = document.getElementById('statusMessage');
      
      // State
      this.selectorData = [];
      this.activeTabId = null;
      this.activeTabUrl = '';
      this._sortCol = null;   // currently sorted column key
      this._sortAsc = true;   // ascending direction
      
      // Search bar elements
      this.searchBar = document.getElementById('searchBar');
      this.searchFilter = document.getElementById('searchFilter');

      // Bind event handlers
      this.generateBtn.addEventListener('click', this.generateSelectors.bind(this));
      this.exportBtn.addEventListener('click', this.exportSelectors.bind(this));
      this.exportJsonBtn.addEventListener('click', this.exportSelectorsJson.bind(this));
      this.exportPomBtn.addEventListener('click', this.exportSelectorsPom.bind(this));
      this.searchFilter.addEventListener('input', this.filterResults.bind(this));
      
      // Get current active tab ID
      this.updateActiveTabId();
    }
    
    /**
     * Updates the active tab ID, then checks session storage for a prior scan
     * on this tab. If found, offers to restore it via the status bar.
     */
    updateActiveTabId() {
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (tabs && tabs.length > 0) {
          this.activeTabId = tabs[0].id;
          this.activeTabUrl = tabs[0].url || '';
          this._tryRestoreSession(this.activeTabId);
        }
      });
    }

    /**
     * Saves the current selectorData to session storage keyed by tab ID.
     * Uses chrome.storage.session so data survives panel close/reopen
     * but is cleared when Chrome restarts.
     * @param {number} tabId
     */
    _saveSession(tabId) {
      if (!tabId || !this.selectorData || !this.selectorData.length) return;
      const key = `scan_${tabId}`;
      chrome.storage.session.set({ [key]: this.selectorData }).catch(() => {});
    }

    /**
     * Checks session storage for a prior scan on tabId. If found and the
     * current table is empty, shows a "Restore last scan?" prompt in the
     * status bar — user can click to reload without re-scanning.
     * @param {number} tabId
     */
    _tryRestoreSession(tabId) {
      if (!tabId) return;
      const key = `scan_${tabId}`;
      chrome.storage.session.get(key, (result) => {
        const saved = result && result[key];
        if (!saved || !saved.length) return;
        if (this.selectorData && this.selectorData.length) return; // already have data

        this.statusMessage.innerHTML =
          `Restore last scan? (${saved.length} elements) &nbsp;` +
          `<button class="restore-btn" id="restoreSessionBtn">Restore</button>` +
          `<button class="restore-dismiss-btn" id="dismissRestoreBtn">Dismiss</button>`;

        document.getElementById('restoreSessionBtn').addEventListener('click', () => {
          this.selectorData = saved;
          this.displayResults();
          this.exportBtn.disabled = false;
          this.exportJsonBtn.disabled = false;
          this.exportPomBtn.disabled = false;
          this.statusMessage.textContent = `Restored ${saved.length} elements from last scan.`;
        });
        document.getElementById('dismissRestoreBtn').addEventListener('click', () => {
          this.statusMessage.textContent = '';
          chrome.storage.session.remove(key).catch(() => {});
        });
      });
    }
    
    /**
     * Generates selectors for all UI elements on the page
     */
    generateSelectors() {
      this.resultsDiv.innerHTML = '<div class="loading">Analyzing page elements...</div>';
      this.exportBtn.disabled = true;
      this.exportJsonBtn.disabled = true;
      this.exportPomBtn.disabled = true;
      this.statusMessage.textContent = "Scanning page for UI elements...";
      
      this.updateActiveTabId();
      
      if (!this.activeTabId) {
        this.resultsDiv.innerHTML = '<p>Error: Could not determine active tab.</p>';
        this.statusMessage.textContent = "Failed to analyze page.";
        return;
      }
      
      // Ping first: only inject scripts if they are not already loaded.
      // Re-injecting on every click causes duplicate listeners and race conditions.
      // The file list lives in utils.js so every tab injects exactly the same set.
      window.PalTechUtils.ensureContentScripts(this.activeTabId, () => {
        // Send message to generate selectors
        chrome.tabs.sendMessage(this.activeTabId, {action: "generateSelectors"}, (response) => {
          if (chrome.runtime.lastError) {
            this.resultsDiv.innerHTML = `<p>Error: ${window.PalTechUtils.escapeHtml(chrome.runtime.lastError.message)}</p>`;
            this.statusMessage.textContent = "Failed to get selectors.";
            return;
          }
          
          if (response && response.data) {
            this.selectorData = response.data;
            this.displayResults();
            this.exportBtn.disabled = false;
            this.exportJsonBtn.disabled = false;
            this.exportPomBtn.disabled = false;
            this.statusMessage.textContent = response.truncated
              ? `Showing the first ${this.selectorData.length} of ${response.truncated} ` +
                `candidate elements — scan stopped to keep the page responsive.`
              : `Found ${this.selectorData.length} UI elements.`;
            this._saveSession(this.activeTabId);
          } else {
            // The content script reports why it failed (usually a module that
            // did not load) — show it instead of a bare "Error".
            const detail = (response && response.error)
              ? response.error
              : 'The page did not return any selectors.';
            this.resultsDiv.innerHTML =
              `<p>Error generating selectors: ${window.PalTechUtils.escapeHtml(detail)}</p>`;
            this.statusMessage.textContent = "Failed to generate selectors.";
          }
        });
      }, (errMsg) => {
        this.resultsDiv.innerHTML = `<p>Error: ${window.PalTechUtils.escapeHtml(errMsg)}</p>`;
        this.statusMessage.textContent = "Failed to analyze page.";
      });
    }
    
    /**
     * Exports selectors to CSV
     */
    exportSelectors() {
      window.PalTechUtils.exportToCSV(this.selectorData, 'ui_elements_xpaths.csv');
    }

    /**
     * Exports selectors to JSON — handles commas and special chars safely
     */
    exportSelectorsJson() {
      window.PalTechUtils.exportToJSON(this.selectorData, 'ui_elements_selectors.json');
    }

    /**
     * Exports selectors as a Playwright TypeScript Page Object Model class.
     * Prompts for a class name to keep the API simple (no extra UI needed).
     */
    exportSelectorsPom() {
      const className = window.prompt('Enter Page Object class name:', 'GeneratedPage');
      if (className === null) return; // user cancelled
      window.PalTechUtils.exportToPOM(this.selectorData, className || 'GeneratedPage');
    }
    
    /**
     * Adds a selector to the table
     * @param {Object} newSelectorData - The selector data to add
     */
    addSelector(newSelectorData) {
      // Initialize selectorData if empty
      if (!this.selectorData || this.selectorData.length === 0) {
        this.selectorData = [];
      }
      
      // Add the new selector data
      this.selectorData.push(newSelectorData);
      
      // Display the updated results
      this.displayResults();
      this.exportBtn.disabled = false;
      this.exportJsonBtn.disabled = false;
      this.exportPomBtn.disabled = false;
      this.statusMessage.textContent = `Added element. Total: ${this.selectorData.length} UI elements.`;
    }
    
    /**
     * Deletes a selector from the table, with a 5-second undo toast.
     * @param {number} index - The index of the selector to delete
     */
    deleteSelector(index) {
      const deleted = this.selectorData.splice(index, 1)[0];
      this.displayResults();
      this.statusMessage.textContent = `Deleted. Total: ${this.selectorData.length} UI elements.`;

      if (this.selectorData.length === 0) {
        this.exportBtn.disabled = true;
        this.exportJsonBtn.disabled = true;
        this.exportPomBtn.disabled = true;
      }

      // Show undo toast
      this._showUndoToast(deleted, index);
    }

    /**
     * Shows an undo toast for a deleted row and restores it if undo is clicked.
     * @param {Object} deleted - The row that was removed
     * @param {number} index   - Original index (used for re-insertion)
     */
    _showUndoToast(deleted, index) {
      // Remove any existing toast first
      const existing = document.getElementById('undoToast');
      if (existing) existing.remove();
      clearTimeout(this._undoTimer);

      const toast = document.createElement('div');
      toast.id = 'undoToast';
      toast.className = 'undo-toast';
      toast.innerHTML = `Row deleted. <button class="undo-btn">Undo</button>`;
      document.body.appendChild(toast);

      toast.querySelector('.undo-btn').addEventListener('click', () => {
        clearTimeout(this._undoTimer);
        // Re-insert at original position (clamped to current length)
        const restoreIndex = Math.min(index, this.selectorData.length);
        this.selectorData.splice(restoreIndex, 0, deleted);
        this.displayResults();
        this.exportBtn.disabled = false;
        this.exportJsonBtn.disabled = false;
        this.exportPomBtn.disabled = false;
        this.statusMessage.textContent = `Restored. Total: ${this.selectorData.length} UI elements.`;
        toast.remove();
      });

      this._undoTimer = setTimeout(() => toast.remove(), 5000);
    }

    /**
     * Saves a selector row to chrome.storage.local bookmarks, keyed by domain.
     * @param {number} index - Index in selectorData
     * @param {HTMLElement} btn - The star button element (for visual feedback)
     */
    bookmarkSelector(index, btn) {
      const item = this.selectorData[index];
      if (!item) return;

      let domain = 'unknown';
      try { domain = new URL(this.activeTabUrl).hostname || 'unknown'; } catch (_) {}

      window.PalTechUtils.addBookmark({
        domain,
        pageUrl: this.activeTabUrl,
        elementName: item['Element Name'],
        data: item
      }, (err) => {
        if (err) {
          // Leave the star empty: nothing was saved
          this.statusMessage.textContent = `Could not save the bookmark: ${err}`;
          return;
        }
        btn.textContent = '★';
        btn.classList.add('bookmarked');
        btn.title = 'Bookmarked!';
        btn.disabled = true;
        this.statusMessage.textContent =
          `Bookmarked "${item['Element Name']}" — view in the Bookmarks tab.`;
      });
    }

    /**
     * Creates a compact selector display with count badge and optional fragility badge.
     * @param {string} selector - The selector string
     * @param {number} count    - The number of elements matched by this selector
     * @param {Object} [health] - { label, cls, reason } from scoreFragility — optional
     * @returns {string} - HTML string for the selector display
     */
    createSelectorWithCount(selector, count, health) {
      const escapedSelector = window.PalTechUtils.escapeForAttribute(selector);
      const healthBadge = health
        ? `<span class="frag-badge ${health.cls}" title="${window.PalTechUtils.escapeForAttribute(health.reason)}">${health.label[0]}</span>`
        : '';

      return `
        <div class="selector-text-container">
          ${healthBadge}
          <span class="selector-text" title="${escapedSelector}">${window.PalTechUtils.escapeHtml(selector)}</span>
          <div class="selector-actions">
            <span class="copy-icon" data-selector="${escapedSelector}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </span>
            <span class="count-badge">${count || '0'}</span>
          </div>
        </div>
      `;
    }
    
    /**
     * Gets a compact display version of a selector
     * @param {string} selector - The full selector
     * @returns {string} - A compact display version
     */
    getCompactDisplay(selector) {
      // For table display, show the full selector without truncation
      return selector;
    }
    
    /**
     * Truncates text with ellipsis if needed
     * @param {string} text - The text to truncate
     * @param {number} maxLength - Maximum length before truncation
     * @returns {string} - Truncated text
     */
    truncateText(text, maxLength) {
      // No truncation for XPath and other selectors
      return text;
    }
    
    /**
     * Formats an element name for display in the table
     * @param {string} elementName - Raw element name
     * @returns {string} - Formatted element name for display
     */
    formatElementName(elementName) {
      if (!elementName) return '';
      
      // Maximum length for display
      const MAX_NAME_LENGTH = 20;
      
      // Helper function to shorten names while preserving type suffix
      const shortenName = (name) => {
        if (name.length <= MAX_NAME_LENGTH) return name;
        
        // Find the type suffix using regex (Btn|Link|Txt|etc.)
        const match = name.match(/([a-z][a-zA-Z0-9_]*)([A-Z][a-z]+)$/);
        
        if (match) {
          const [_, prefix, suffix] = match;
          
          if (prefix.length > 10) {
            // Keep the first 7 chars and last 3 chars of prefix, plus the suffix
            const start = prefix.substring(0, 7);
            const end = prefix.substring(prefix.length - 3);
            return `${start}...${end}${suffix}`;
          } else {
            // If prefix isn't long enough to justify this shortening
            return `${prefix.substring(0, 10)}...${suffix}`;
          }
        }
        
        // If no suffix pattern found, simple truncation
        return name.substring(0, 17) + '...';
      };
      
      // If the name already follows our automation naming convention (camelCase with type suffix)
      if (/^([a-z][a-zA-Z0-9_]*)(Btn|Link|Txt|Fld|Drp|Chk|Rad|Email|Lbl|Heading|List|Menu|Container)$/.test(elementName)) {
        // Keep original camelCase format without adding spaces but shorten if needed
        const formatted = shortenName(elementName);
        
        // Return the possibly shortened name
        return this.addElementTypeIcon(formatted, elementName);
      }
      
      // Convert snake_case to camelCase but maintain camelCase format
      if (elementName.includes('_')) {
        const parts = elementName.split('_');
        // Check if the last part might be an element type
        const lastPart = parts[parts.length - 1].toLowerCase();
        const elementTypes = ['btn', 'button', 'input', 'link', 'label', 'text', 'checkbox', 'radio', 'select', 'dropdown'];
        
        // If last part indicates element type, maintain original format
        if (elementTypes.includes(lastPart)) {
          // Keep the original camelCase format but shorten if needed
          const formatted = shortenName(elementName.replace(/_/g, ''));
          
          // Return the possibly shortened name
          return this.addElementTypeIcon(formatted, elementName);
        }
      }
      
      // Handle inline truncated names with ellipsis
      if (elementName.endsWith('...')) {
        return elementName;
      }
      
      // For other names, shorten if needed
      return shortenName(elementName);
    }
    
    /**
     * Previously added icons based on element type, now simply returns the name
     * @param {string} formattedName - Formatted element name
     * @param {string} rawName - Raw element name
     * @returns {string} - Name without icon
     */
    addElementTypeIcon(formattedName, rawName) {
      // Simply return the formatted name without adding icons
      return formattedName;
    }
    
    /**
     * Returns a CSS class for the priority badge based on the priority label.
     * @param {string} priority - e.g. "P1 - getByRole"
     * @returns {string} - CSS class name
     */
    getPriorityBadgeClass(priority) {
      const level = parseInt((priority || '').replace('P', ''), 10);
      if (level >= 1 && level <= 3) return 'priority-high';
      if (level >= 4 && level <= 7) return 'priority-medium';
      return 'priority-low';
    }

    /**
     * Creates the Playwright locator cell HTML with a priority badge and copy button.
     * @param {string} locator
     * @param {string} priority
     * @param {string} badgeClass
     * @returns {string} - HTML
     */
    createPlaywrightLocatorCell(locator, priority, badgeClass) {
      const escapedLocator = window.PalTechUtils.escapeForAttribute(locator);
      return `
        <div class="selector-text-container">
          <span class="selector-text playwright-locator-text" title="${escapedLocator}">${window.PalTechUtils.escapeHtml(locator)}</span>
          <div class="selector-actions">
            <span class="copy-icon" data-selector="${escapedLocator}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </span>
            <span class="priority-badge ${badgeClass}" title="${window.PalTechUtils.escapeHtml(priority)}">${window.PalTechUtils.escapeHtml(priority.split(' - ')[0])}</span>
          </div>
        </div>
      `;
    }

    /**
     * Sorts selectorData by the given column key and re-renders.
     * Clicking the same column again toggles ascending / descending.
     * @param {string} colKey - The data property key to sort by
     */
    sortBy(colKey) {
      if (this._sortCol === colKey) {
        this._sortAsc = !this._sortAsc;
      } else {
        this._sortCol = colKey;
        this._sortAsc = true;
      }
      this.selectorData.sort((a, b) => {
        const va = (a[colKey] || '').toLowerCase();
        const vb = (b[colKey] || '').toLowerCase();
        if (va < vb) return this._sortAsc ? -1 : 1;
        if (va > vb) return this._sortAsc ? 1 : -1;
        return 0;
      });
      this.displayResults();
    }

    /**
     * Filters table rows live as the user types in the search bar.
     */
    filterResults() {
      const term = (this.searchFilter.value || '').toLowerCase();
      this.resultsDiv.querySelectorAll('tr.data-row').forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
      });
    }

    /**
     * Displays the selector results in the table
     */
    displayResults() {
      if (!this.selectorData || this.selectorData.length === 0) {
        this.resultsDiv.innerHTML = '<p>No elements found.</p>';
        this.searchBar.style.display = 'none';
        return;
      }
      // Show search bar and clear any previous filter term
      this.searchBar.style.display = 'block';
      this.searchFilter.value = '';
      
      const sortArrow = (col) => {
        if (this._sortCol !== col) return ' <span class="sort-arrow">⇅</span>';
        return this._sortAsc
          ? ' <span class="sort-arrow active">▲</span>'
          : ' <span class="sort-arrow active">▼</span>';
      };

      let tableHtml = `
        <table>
          <thead>
            <tr>
              <th class="sortable-th" data-col="Element Name">Element Name${sortArrow('Element Name')}</th>
              <th>XPath</th>
              <th>CSS Selector</th>
              <th>jQuery Selector</th>
              <th class="sortable-th" data-col="Playwright Locator">Playwright Locator${sortArrow('Playwright Locator')}</th>
              <th>Act.</th>
            </tr>
          </thead>
          <tbody>
      `;

      // Add data rows with enhanced display
      this.selectorData.forEach((item, index) => {
        const elementName = this.formatElementName(item['Element Name'] || '');

        const pwLocator = item['Playwright Locator'] || '';
        const pwPriority = item['Playwright Priority'] || 'N/A';
        const pwBadgeClass = this.getPriorityBadgeClass(pwPriority);

        tableHtml += `
          <tr class="data-row" data-index="${index}">
            <td class="element-name-cell">${window.PalTechUtils.escapeHtml(elementName)}</td>
            <td class="selector-cell">
              ${item['Relative XPath'] ? this.createSelectorWithCount(item['Relative XPath'], item['Xpath selectors Count'], item['XPath Health']) : ''}
            </td>
            <td class="selector-cell">
              ${item['CSS Selector'] ? this.createSelectorWithCount(item['CSS Selector'], item['CSS selectors count'], item['CSS Health']) : ''}
            </td>
            <td class="selector-cell">
              ${item['jQuery Selector'] ? this.createSelectorWithCount(item['jQuery Selector'], item['jQuery selectors count'] ?? '?') : ''}
            </td>
            <td class="selector-cell playwright-cell">
              ${pwLocator ? this.createPlaywrightLocatorCell(pwLocator, pwPriority, pwBadgeClass) : ''}
            </td>
            <td class="actions-cell">
              <div class="actions-cell-inner">
                <button class="bookmark-btn" data-index="${index}" title="Bookmark this element">☆</button>
                <button class="delete-btn" data-index="${index}" title="Delete row">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>
                </button>
              </div>
            </td>
          </tr>
        `;
      });
      
      tableHtml += '</tbody></table>';
      this.resultsDiv.innerHTML = tableHtml;
      
      this.addEventListeners();
    }
    
    /**
     * Adds event listeners to the elements in the results table
     */
    addEventListeners() {
      // Sortable column headers
      this.resultsDiv.querySelectorAll('.sortable-th').forEach(th => {
        th.addEventListener('click', () => this.sortBy(th.dataset.col));
      });

      // Add event listeners for copy buttons
      this.resultsDiv.querySelectorAll('.copy-icon').forEach(btn => {
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
      
      // Add event listeners for bookmark buttons
      this.resultsDiv.querySelectorAll('.bookmark-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const index = parseInt(btn.dataset.index);
          this.bookmarkSelector(index, btn);
        });
      });

      // Add event listeners for delete buttons
      this.resultsDiv.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const index = parseInt(btn.dataset.index);
          this.deleteSelector(index);
        });
      });
      
      // Add event listeners to rows for highlighting
      const rows = this.resultsDiv.querySelectorAll('tr.data-row');
      rows.forEach(row => {
        row.addEventListener('mouseenter', () => {
          if (this.enableHighlightCheckbox.checked && this.activeTabId) {
            const index = parseInt(row.getAttribute('data-index'));
            const selector = this.selectorData[index];
            
            // Send message to content script to highlight element
            chrome.tabs.sendMessage(this.activeTabId, {
              action: "highlightElement",
              selector: selector
            });
          }
        });
        
        row.addEventListener('mouseleave', () => {
          if (this.enableHighlightCheckbox.checked && this.activeTabId) {
            // Send message to content script to remove highlight
            chrome.tabs.sendMessage(this.activeTabId, {
              action: "removeHighlight"
            });
          }
        });
      });
    }
  }
  
  // Create global instance
  window.multiElementsTab = new MultiElementsTab();