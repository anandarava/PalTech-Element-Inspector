/**
 * bookmarks-tab.js — Manages the Bookmarks tab.
 *
 * Bookmarks are stored in chrome.storage.local under the key 'paltech_bookmarks'
 * as an array of { domain, pageUrl, elementName, data } objects.
 * They persist across browser sessions (unlike chrome.storage.session).
 */

class BookmarksTab {
  constructor() {
    this.container = document.getElementById('bookmarks-content');
    this.clearAllBtn = document.getElementById('clearAllBookmarks');

    if (this.clearAllBtn) {
      this.clearAllBtn.addEventListener('click', () => this._clearAll());
    }

    // Reload whenever the Bookmarks tab is clicked
    const tab = document.querySelector('[data-tab="bookmarks"]');
    if (tab) {
      tab.addEventListener('click', () => this.loadBookmarks());
    }

    this.loadBookmarks();
  }

  loadBookmarks() {
    window.PalTechUtils.readBookmarks((bookmarks, err) => {
      if (err) {
        this.container.innerHTML =
          `<p class="bm-empty">Could not read saved bookmarks: ${window.PalTechUtils.escapeHtml(err)}</p>`;
        return;
      }
      this.render(bookmarks);
    });
  }

  render(bookmarks) {
    if (!bookmarks.length) {
      this.container.innerHTML =
        '<p class="bm-empty">No bookmarks yet. Click ☆ on any element row to bookmark it.</p>';
      return;
    }

    // Group by domain
    const byDomain = {};
    bookmarks.forEach((bm, idx) => {
      const domain = bm.domain || 'unknown';
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push({ ...bm, _idx: idx });
    });

    let html = '';
    for (const [domain, items] of Object.entries(byDomain)) {
      html += `
        <div class="bm-domain-group">
          <div class="bm-domain-header">
            ${window.PalTechUtils.escapeHtml(domain)}
            <span class="bm-count">${items.length}</span>
          </div>
          <table class="bm-table">
            <thead><tr>
              <th>Name</th>
              <th>Playwright Locator</th>
              <th>XPath</th>
              <th></th>
            </tr></thead>
            <tbody>
      `;
      items.forEach((bm) => {
        const d = bm.data || {};
        const pw = d['Playwright Locator'] || '';
        const xpath = d['Relative XPath'] || '';
        const escapedPw = window.PalTechUtils.escapeForAttribute(pw);
        const escapedXpath = window.PalTechUtils.escapeForAttribute(xpath);
        html += `
          <tr class="bm-row">
            <td class="bm-name-cell">${window.PalTechUtils.escapeHtml(d['Element Name'] || '')}</td>
            <td class="bm-sel-cell">
              <div class="bm-sel-inner">
                <span class="selector-text playwright-locator-text"
                      title="${escapedPw}">${window.PalTechUtils.escapeHtml(pw)}</span>
                ${pw ? `<span class="copy-icon bm-copy" data-selector="${escapedPw}" title="Copy">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </span>` : ''}
              </div>
            </td>
            <td class="bm-sel-cell">
              <span class="selector-text" title="${escapedXpath}">${window.PalTechUtils.escapeHtml(xpath)}</span>
            </td>
            <td class="bm-actions-cell">
              <button class="delete-btn bm-delete-btn" data-idx="${bm._idx}"
                      data-id="${window.PalTechUtils.escapeForAttribute(bm.id || '')}"
                      title="Remove bookmark">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            </td>
          </tr>
        `;
      });
      html += `</tbody></table></div>`;
    }

    this.container.innerHTML = html;
    this._addEventListeners();
  }

  _addEventListeners() {
    this.container.querySelectorAll('.bm-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._deleteBookmark(btn.dataset.id || '', parseInt(btn.dataset.idx, 10));
      });
    });

    this.container.querySelectorAll('.bm-copy').forEach(btn => {
      btn.addEventListener('click', () => {
        window.PalTechUtils.copyToClipboard(btn.dataset.selector);
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
      });
    });
  }

  /**
   * Remove one bookmark.
   *
   * By id, not by position: the list on screen can be older than the list in
   * storage — another panel window, or a bookmark added from another tab — and
   * deleting by index then removed whichever record happened to sit there. The
   * index is still accepted as a fallback for bookmarks saved before ids
   * existed.
   *
   * @param {string} id
   * @param {number} idx - position in the rendered list
   */
  _deleteBookmark(id, idx) {
    window.PalTechUtils.readBookmarks((bookmarks, readErr) => {
      if (readErr) return;

      const at = id ? bookmarks.findIndex(b => b.id === id) : -1;
      if (at >= 0) {
        bookmarks.splice(at, 1);
      } else if (id) {
        this.loadBookmarks();      // already gone; just resync the view
        return;
      } else if (Number.isInteger(idx) && idx >= 0 && idx < bookmarks.length) {
        bookmarks.splice(idx, 1);  // pre-id bookmark
      } else {
        return;
      }

      window.PalTechUtils.writeBookmarks(bookmarks, (err) => {
        if (err) {
          this.container.insertAdjacentHTML('afterbegin',
            `<p class="bm-empty">Could not remove the bookmark: ${window.PalTechUtils.escapeHtml(err)}</p>`);
          return;
        }
        this.render(bookmarks);
      });
    });
  }

  _clearAll() {
    // Inline confirmation — avoids native confirm() dialog that freezes the Chrome window
    const existing = document.getElementById('bm-confirm-banner');
    if (existing) { existing.remove(); return; }

    const banner = document.createElement('div');
    banner.id = 'bm-confirm-banner';
    banner.className = 'bm-confirm-banner';
    banner.innerHTML =
      'Remove all bookmarks? ' +
      '<button id="bm-confirm-yes" class="restore-btn">Remove All</button>' +
      '<button id="bm-confirm-cancel" class="restore-dismiss-btn">Cancel</button>';

    this.container.insertAdjacentElement('beforebegin', banner);

    document.getElementById('bm-confirm-yes').addEventListener('click', () => {
      banner.remove();
      window.PalTechUtils.writeBookmarks([], (err) => {
        if (err) {
          this.container.insertAdjacentHTML('afterbegin',
            `<p class="bm-empty">Could not clear the bookmarks: ${window.PalTechUtils.escapeHtml(err)}</p>`);
          return;
        }
        this.render([]);
      });
    });
    document.getElementById('bm-confirm-cancel').addEventListener('click', () => banner.remove());
  }
}

window.bookmarksTab = new BookmarksTab();
