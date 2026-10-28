/**
 * recorder-tab.js — Manages the Recorder tab in the side panel.
 *
 * Flow:
 *   1. User clicks "Start Recording" → injectIfNeeded → sendMessage('startRecording')
 *   2. recorder.js fires chrome.runtime.sendMessage({ action:'stepRecorded', step })
 *   3. This class receives it, appends to steps[], re-renders the step list and code.
 *   4. User clicks "Stop Recording" → sendMessage('stopRecording')
 *   5. User can copy or download the generated test in any of 5 frameworks.
 *
 * Code generation covers:
 *   Playwright JS, Playwright Python, Cypress JS, Selenium Java, Selenium Python
 */

class RecorderTab {
  constructor() {
    this.steps      = [];
    this.isRecording = false;
    this.activeTabId = null;
    this.framework  = 'pw-js'; // default framework

    this._buildUI();
    this._bindStaticEvents();
    this._listenForSteps();
    this._updateActiveTab();
  }

  // ── UI Construction ─────────────────────────────────────────────────────────

  _buildUI() {
    const container = document.getElementById('recorder-tab');
    if (!container) return;

    container.innerHTML = `
      <div class="rec-toolbar">
        <button id="recStartBtn"  class="rec-start-btn">&#9654; Start Recording</button>
        <button id="recStopBtn"   class="rec-stop-btn"  disabled>&#9632; Stop</button>
        <button id="recClearBtn"  class="rec-clear-btn" disabled>&#128465; Clear</button>
      </div>

      <div id="recStatusBar" class="rec-status-bar" style="display:none;"></div>

      <div class="rec-options">
        <div class="rec-field">
          <label for="recTestName">Test name</label>
          <input type="text" id="recTestName" value="recorded-flow" autocomplete="off" />
        </div>
        <div class="rec-field">
          <label for="recFramework">Framework</label>
          <select id="recFramework">
            <option value="pw-js"       selected>Playwright JS</option>
            <option value="pw-py">Playwright Python</option>
            <option value="cypress">Cypress JS</option>
            <option value="sel-java">Selenium Java</option>
            <option value="sel-py">Selenium Python</option>
          </select>
        </div>
      </div>

      <div class="rec-section-header">
        Recorded Steps
        <span id="recStepCount" class="rec-step-count">0</span>
      </div>
      <div id="recStepList" class="rec-step-list">
        <p class="rec-empty">Click "Start Recording" then interact with the page.</p>
      </div>

      <div class="rec-section-header">
        Generated Code
        <div class="rec-code-actions">
          <button id="recCopyCode"     class="rec-action-btn" disabled>&#128203; Copy</button>
          <button id="recDownloadCode" class="rec-action-btn" disabled>&#8595; Download</button>
        </div>
      </div>
      <pre id="recCodeOutput" class="rec-code-output"><code class="rec-code-placeholder">// Code will appear here as you record steps.</code></pre>
    `;

    // Cache DOM refs
    this.startBtn    = document.getElementById('recStartBtn');
    this.stopBtn     = document.getElementById('recStopBtn');
    this.clearBtn    = document.getElementById('recClearBtn');
    this.statusBar   = document.getElementById('recStatusBar');
    this.testNameIn  = document.getElementById('recTestName');
    this.frameworkSel= document.getElementById('recFramework');
    this.stepList    = document.getElementById('recStepList');
    this.stepCount   = document.getElementById('recStepCount');
    this.codeOutput  = document.getElementById('recCodeOutput');
    this.copyBtn     = document.getElementById('recCopyCode');
    this.downloadBtn = document.getElementById('recDownloadCode');
  }

  _bindStaticEvents() {
    if (!this.startBtn) return;

    this.startBtn.addEventListener('click',  () => this._startRecording());
    this.stopBtn.addEventListener('click',   () => this._stopRecording());
    this.clearBtn.addEventListener('click',  () => this._clearSteps());
    this.copyBtn.addEventListener('click',   () => this._copyCode());
    this.downloadBtn.addEventListener('click', () => this._downloadCode());

    this.frameworkSel.addEventListener('change', () => {
      this.framework = this.frameworkSel.value;
      this._refreshCode();
    });

    this.testNameIn.addEventListener('input', () => this._refreshCode());
  }

  // ── Active tab tracking ─────────────────────────────────────────────────────

  _updateActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length) this.activeTabId = tabs[0].id;
    });
  }

  // ── Step listener (from recorder.js running in the page) ───────────────────

  _listenForSteps() {
    chrome.runtime.onMessage.addListener((request) => {
      if (request.action === 'stepRecorded' && request.step && this.isRecording) {
        this.steps.push(request.step);
        this._renderStepList();
        this._refreshCode();
        this._persistSteps();
      }
      if (request.action === 'tabChanged') {
        this._updateActiveTab();
      }
      if (request.action === 'recordingInterrupted' && this.isRecording) {
        // The page could not be re-armed after a navigation (chrome:// page,
        // Web Store, PDF viewer, tab closed). Say so instead of pretending.
        window.PalTechUtils.RecordingController.markInterrupted();
      }
    });

    // Reset this tab's UI when recording is stopped from the other tab, and
    // pick a recording back up when the panel is reopened while it is running.
    window.PalTechUtils.RecordingController.register(
      'recorder',
      (owner, interrupted) => {
        if (!this.isRecording) return;
        this._applyStoppedState();
        if (interrupted) {
          this._showStatus('Recording stopped — the page could not be recorded after navigating.', 'error');
        }
      },
      (tabId, savedSteps) => this._resumeRecording(tabId, savedSteps)
    );
  }

  /** Mirror the steps into session storage so closing the panel cannot lose them. */
  _persistSteps() {
    window.PalTechUtils.RecordingController.saveSteps('recorder', this.steps);
  }

  /**
   * Re-attach this tab to a recording that outlived the previous panel document.
   *
   * Without this the reopened panel showed Start enabled and Stop disabled over
   * a recorder that was still capturing, and there was no way to stop it short
   * of closing the tab.
   *
   * Steps performed while the panel was closed are genuinely gone — the page
   * sends each one to a panel that was not there to receive it — so say so
   * rather than presenting the list as a complete recording.
   */
  _resumeRecording(tabId, savedSteps) {
    if (!this.startBtn) return;

    this.activeTabId = tabId;
    this.isRecording = true;

    if (Array.isArray(savedSteps) && savedSteps.length && !this.steps.length) {
      this.steps = savedSteps;
      this._renderStepList();
      this._refreshCode();
    }

    this.startBtn.disabled = true;
    this.stopBtn.disabled  = false;
    this.clearBtn.disabled = false;
    this._showStatus(
      'Recording is still running on the page. Anything done while the panel was closed was not captured.',
      'recording'
    );
  }

  // ── Recording control ───────────────────────────────────────────────────────
  // All start/stop goes through the shared RecordingController (utils.js) so the
  // Recorder and Test Steps tabs can never both drive the single page recorder.

  _startRecording() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs.length) {
        this._showStatus('Could not determine the active tab.', 'error');
        return;
      }
      this.activeTabId = tabs[0].id;

      // isRecording is set BEFORE the start message goes out, because the
      // recorder emits its first "navigate" step synchronously inside start().
      this.isRecording = true;

      window.PalTechUtils.RecordingController.startRecording(
        'recorder',
        this.activeTabId,
        () => {
          this.startBtn.disabled = true;
          this.stopBtn.disabled  = false;
          this.clearBtn.disabled = false;
          this._showStatus('Recording… interact with the page.', 'recording');
        },
        (errMsg) => {
          this.isRecording = false;
          this._showStatus(errMsg, 'error');
        }
      );
    });
  }

  _applyStoppedState() {
    this.isRecording       = false;
    this.startBtn.disabled = false;
    this.stopBtn.disabled  = true;
    const count = this.steps.length;
    if (count > 0) {
      this.copyBtn.disabled     = false;
      this.downloadBtn.disabled = false;
    }
    return count;
  }

  _stopRecording() {
    window.PalTechUtils.RecordingController.stopRecording('recorder', () => {
      const count = this._applyStoppedState();
      this._showStatus(
        count > 0
          ? `Stopped. ${count} step${count > 1 ? 's' : ''} recorded.`
          : 'Stopped. No steps recorded.',
        count > 0 ? 'success' : 'idle'
      );
    });
  }

  _clearSteps() {
    this.steps = [];
    this._renderStepList();
    this._refreshCode();
    this._persistSteps();
    this.copyBtn.disabled     = true;
    this.downloadBtn.disabled = true;
    // Stay clickable while recording — more steps are still coming in
    this.clearBtn.disabled    = !this.isRecording;
    this._showStatus(this.isRecording ? 'Recording… interact with the page.' : '',
                     this.isRecording ? 'recording' : 'idle');
  }

  // ── Status bar ──────────────────────────────────────────────────────────────

  _showStatus(msg, type) {
    if (!this.statusBar) return;
    if (!msg) { this.statusBar.style.display = 'none'; return; }
    this.statusBar.textContent = msg;
    this.statusBar.className   = 'rec-status-bar rec-status-' + type;
    this.statusBar.style.display = 'block';
  }

  // ── Step list rendering ─────────────────────────────────────────────────────

  _renderStepList() {
    if (!this.stepList) return;
    this.stepCount.textContent = this.steps.length;

    if (!this.steps.length) {
      this.stepList.innerHTML =
        '<p class="rec-empty">Click "Start Recording" then interact with the page.</p>';
      return;
    }

    const ICONS = {
      navigate:   '🌐', click:     '🖱', dblclick:  '🖱🖱',
      rightClick: '🖱R', fill:     '⌨', select:    '📋',
      check:      '☑', uncheck:  '☐', press:     '⌨',
      hover:      '⟳', scroll:   '↕', fileUpload:'📁',
      submit:     '✉', dragDrop: '↔', tap:       '👆',
      dialog:     '💬'
    };

    let html = '';
    this.steps.forEach((step, idx) => {
      const icon = ICONS[step.type] || '•';
      const safe = window.PalTechUtils.escapeHtml(step.description || step.type);
      html += `
        <div class="rec-step-item" data-idx="${idx}">
          <span class="rec-step-num">${idx + 1}</span>
          <span class="rec-step-icon">${icon}</span>
          <span class="rec-step-desc">${safe}</span>
          <button class="rec-step-delete" data-idx="${idx}" title="Remove step">✕</button>
        </div>`;
    });

    this.stepList.innerHTML = html;

    this.stepList.querySelectorAll('.rec-step-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.steps.splice(parseInt(btn.dataset.idx), 1);
        this._renderStepList();
        this._refreshCode();
        this._persistSteps();
        if (!this.steps.length) {
          this.copyBtn.disabled = true;
          this.downloadBtn.disabled = true;
        }
      });
    });
  }

  // ── Code generation ─────────────────────────────────────────────────────────

  _refreshCode() {
    if (!this.codeOutput) return;
    const name  = (this.testNameIn?.value || 'recorded-flow').trim();
    const code  = this._generateCode(this.steps, this.framework, name);
    const safe  = window.PalTechUtils.escapeHtml(code);
    this.codeOutput.innerHTML = `<code>${safe}</code>`;
  }

  /**
   * Rewrite click-caused navigations as URL assertions.
   *
   * When a click navigates, the recorder emits both the click and a navigate
   * step. Replaying that literally means clicking the link AND then calling
   * goto() with the URL it already went to — a redundant second page load that
   * can also mask a broken link (the goto succeeds even if the click did not).
   * An assertion is what that navigation is actually worth in a test.
   */
  _foldNavigations(steps) {
    const NAV_WINDOW_MS = 3000;
    const CAUSES_NAV = ['click', 'dblclick', 'rightClick', 'tap', 'press', 'submit', 'select'];
    const out = [];

    steps.forEach(step => {
      if (step.type === 'navigate' && out.length > 0) {
        const prev = out[out.length - 1];
        const dt = (step.ts && prev.ts) ? (step.ts - prev.ts) : 0;
        const caused = CAUSES_NAV.includes(prev.type) ||
                       (prev.type === 'assertUrl' && prev._folded);
        if (caused && dt >= 0 && dt <= NAV_WINDOW_MS) {
          // Replace a previous assertion for the same flow, so a path followed
          // by the same path plus a query string yields one assertion
          if (prev.type === 'assertUrl') {
            out[out.length - 1] = { ...step, type: 'assertUrl', _folded: true };
          } else {
            out.push({ ...step, type: 'assertUrl', _folded: true });
          }
          return;
        }
      }
      out.push(step);
    });

    return out;
  }

  _generateCode(rawSteps, framework, testName) {
    if (!rawSteps.length) return '// No steps recorded yet.';
    const steps = this._foldNavigations(rawSteps);
    switch (framework) {
      case 'pw-js':    return this._genPlaywrightJS(steps, testName);
      case 'pw-py':    return this._genPlaywrightPython(steps, testName);
      case 'cypress':  return this._genCypress(steps, testName);
      case 'sel-java': return this._genSeleniumJava(steps, testName);
      case 'sel-py':   return this._genSeleniumPython(steps, testName);
      default:         return '// Unknown framework.';
    }
  }

  // ── Playwright JS ───────────────────────────────────────────────────────────

  _genPlaywrightJS(steps, name) {
    const lines = [
      `import { test, expect } from '@playwright/test';`,
      ``,
      `test('${esc(name)}', async ({ page }) => {`
    ];
    steps.forEach(s => {
      const line = this._stepToPwJS(s);
      if (line) lines.push('  ' + line);
    });
    lines.push(`});`);
    return lines.join('\n');
  }

  _stepToPwJS(s) {
    const loc = s.locator && s.locator !== 'page' ? s.locator : null;
    switch (s.type) {
      case 'navigate':   return `await page.goto('${esc(s.url)}');`;
      case 'assertUrl':  return `await expect(page).toHaveURL('${esc(s.url)}');`;
      case 'click':      return loc ? `await ${loc}.click();` : null;
      case 'dblclick':   return loc ? `await ${loc}.dblclick();` : null;
      case 'rightClick': return loc ? `await ${loc}.click({ button: 'right' });` : null;
      case 'fill':       return loc ? `await ${loc}.fill('${esc(s.value)}');` : null;
      case 'select':     return loc ? `await ${loc}.selectOption('${esc(s.value)}');` : null;
      case 'check':      return loc ? `await ${loc}.check();` : null;
      case 'uncheck':    return loc ? `await ${loc}.uncheck();` : null;
      case 'press': {
        if (!loc) return `await page.keyboard.press('${esc(s.value)}');`;
        return `await ${loc}.press('${esc(s.value)}');`;
      }
      case 'hover':      return loc ? `await ${loc}.hover();` : null;
      case 'scroll':     return `await page.mouse.wheel(0, ${parseInt(s.value) || 0});`;
      case 'fileUpload': return loc ? `await ${loc}.setInputFiles('${esc(s.value)}');` : null;
      case 'submit':     return loc ? `await ${loc}.evaluate(f => f.submit());` : null;
      case 'dragDrop':   return loc && s.targetLocator
        ? `await ${loc}.dragTo(${s.targetLocator});` : null;
      case 'tap':        return loc ? `await ${loc}.tap();` : null;
      case 'dialog': {
        const action = s.value === 'accept' ? 'accept()' : 'dismiss()';
        const reply  = s.displayValue ? `, '${esc(s.displayValue)}'` : '';
        return `page.once('dialog', d => d.${action.replace(')', reply + ')')});`;
      }
      default: return `// ${esc(s.description)}`;
    }
  }

  // ── Playwright Python ───────────────────────────────────────────────────────

  _genPlaywrightPython(steps, name) {
    const fnName = name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^[0-9]+/, '') || 'recorded_flow';
    const lines = [
      `import re`,
      `from playwright.sync_api import Page, expect`,
      ``,
      `def test_${fnName}(page: Page):`
    ];
    const headerLength = lines.length;
    steps.forEach(s => {
      const line = this._stepToPwPy(s);
      if (line) lines.push('    ' + line);
    });
    if (lines.length === headerLength) lines.push('    pass');
    return lines.join('\n');
  }

  _stepToPwPy(s) {
    // Use toPyLoc() directly. Routing this through generateFrameworkSnippets()
    // returned a whole assignment STATEMENT ("element = page.get_by_role(...)")
    // rather than a locator EXPRESSION, so every generated line came out as
    // `element = page.get_by_role(...).click()`. toPyLoc returns just the
    // expression, which is what every branch below appends a method call to.
    const loc = s.locator && s.locator !== 'page' ? toPyLoc(s.locator) : null;

    switch (s.type) {
      case 'navigate':   return `page.goto("${esc(s.url)}")`;
      case 'assertUrl':  return `expect(page).to_have_url("${esc(s.url)}")`;
      case 'click':      return loc ? `${loc}.click()` : null;
      case 'dblclick':   return loc ? `${loc}.dblclick()` : null;
      case 'rightClick': return loc ? `${loc}.click(button="right")` : null;
      case 'fill':       return loc ? `${loc}.fill("${esc(s.value)}")` : null;
      case 'select':     return loc ? `${loc}.select_option("${esc(s.value)}")` : null;
      case 'check':      return loc ? `${loc}.check()` : null;
      case 'uncheck':    return loc ? `${loc}.uncheck()` : null;
      case 'press': {
        if (!loc) return `page.keyboard.press("${esc(s.value)}")`;
        return `${loc}.press("${esc(s.value)}")`;
      }
      case 'hover':      return loc ? `${loc}.hover()` : null;
      case 'scroll':     return `page.mouse.wheel(0, ${parseInt(s.value) || 0})`;
      case 'fileUpload': return loc ? `${loc}.set_input_files("${esc(s.value)}")` : null;
      case 'submit':     return loc ? `${loc}.evaluate("f => f.submit()")` : null;
      case 'dragDrop': {
        if (!loc || !s.targetLocator) return null;
        const tgt = toPyLoc(s.targetLocator);
        return `${loc}.drag_to(${tgt})`;
      }
      case 'tap':        return loc ? `${loc}.tap()` : null;
      case 'dialog': {
        const method = s.value === 'accept' ? 'accept' : 'dismiss';
        return `page.once("dialog", lambda d: d.${method}())`;
      }
      default: return `# ${esc(s.description)}`;
    }
  }

  // ── Cypress JS ──────────────────────────────────────────────────────────────

  _genCypress(steps, name) {
    const lines = [
      `describe('${esc(name)}', () => {`,
      `  it('recorded flow', () => {`
    ];
    steps.forEach(s => {
      const line = this._stepToCypress(s);
      if (line) lines.push('    ' + line);
    });
    lines.push(`  });`);
    lines.push(`});`);
    return lines.join('\n');
  }

  _stepToCypress(s) {
    const sel = s.css
      ? `cy.get('${esc(s.css)}')`
      : s.xpath ? `cy.xpath('${esc(s.xpath)}')` : null;

    switch (s.type) {
      case 'navigate':   return `cy.visit('${esc(s.url)}');`;
      case 'assertUrl':  return `cy.url().should('eq', '${esc(s.url)}');`;
      case 'click':      return sel ? `${sel}.click();` : null;
      case 'dblclick':   return sel ? `${sel}.dblclick();` : null;
      case 'rightClick': return sel ? `${sel}.rightclick();` : null;
      case 'fill':       return sel ? `${sel}.clear().type('${esc(s.value)}');` : null;
      case 'select':     return sel ? `${sel}.select('${esc(s.value)}');` : null;
      case 'check':      return sel ? `${sel}.check();` : null;
      case 'uncheck':    return sel ? `${sel}.uncheck();` : null;
      case 'press': {
        const key = s.value.replace('Control+', 'ctrl+').toLowerCase();
        return sel ? `${sel}.type('{${key}}');` : `cy.focused().type('{${key}}');`;
      }
      case 'hover':      return sel ? `${sel}.trigger('mouseover');` : null;
      case 'scroll':     return `cy.scrollTo(0, ${parseInt(s.value) || 0});`;
      case 'fileUpload': return sel ? `${sel}.selectFile('${esc(s.value)}');` : null;
      case 'submit':     return sel ? `${sel}.submit();` : null;
      case 'dragDrop':   return sel && s.targetCss
        ? `${sel}.drag('${esc(s.targetCss)}');` : null;
      case 'tap':        return sel ? `${sel}.click();` : null;
      case 'dialog': {
        const stub = s.value === 'accept' ? 'true' : 'false';
        return `cy.on('window:confirm', () => ${stub});`;
      }
      default: return `// ${esc(s.description)}`;
    }
  }

  // ── Selenium Java ───────────────────────────────────────────────────────────

  _genSeleniumJava(steps, name) {
    const method = name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^[0-9]+/, '') || 'recordedFlow';
    const lines = [
      `import org.openqa.selenium.*;`,
      `import org.openqa.selenium.support.ui.Select;`,
      `import org.openqa.selenium.interactions.Actions;`,
      `import org.openqa.selenium.support.ui.WebDriverWait;`,
      `import org.openqa.selenium.support.ui.ExpectedConditions;`,
      `import java.time.Duration;`,
      `import org.testng.annotations.Test;`,
      ``,
      `@Test`,
      `public void ${method}() throws Exception {`
    ];
    steps.forEach(s => {
      const line = this._stepToSeleniumJava(s);
      if (line) lines.push('    ' + line);
    });
    lines.push(`}`);
    return lines.join('\n');
  }

  _stepToSeleniumJava(s) {
    const by  = s.css
      ? `By.cssSelector("${esc(s.css, '"')}")`
      : s.xpath ? `By.xpath("${esc(s.xpath, '"')}")` : null;
    const el  = by ? `driver.findElement(${by})` : null;

    switch (s.type) {
      case 'navigate':   return `driver.get("${esc(s.url, '"')}");`;
      case 'assertUrl':  return `new WebDriverWait(driver, Duration.ofSeconds(10)).until(ExpectedConditions.urlToBe("${esc(s.url, '"')}"));`;
      case 'click':      return el ? `${el}.click();` : null;
      case 'dblclick':   return el ? `new Actions(driver).doubleClick(${el}).perform();` : null;
      case 'rightClick': return el ? `new Actions(driver).contextClick(${el}).perform();` : null;
      case 'fill':       return el ? `${el}.clear();\n    ${el}.sendKeys("${esc(s.value, '"')}");` : null;
      case 'select':     return el
        ? `new Select(${el}).selectByVisibleText("${esc(s.displayValue || s.value, '"')}");` : null;
      case 'check':      return el
        ? `{ WebElement cb = ${el}; if (!cb.isSelected()) cb.click(); }` : null;
      case 'uncheck':    return el
        ? `{ WebElement cb = ${el}; if (cb.isSelected()) cb.click(); }` : null;
      case 'press': {
        const key = javaKey(s.value);
        return el ? `${el}.sendKeys(${key});` : `driver.switchTo().activeElement().sendKeys(${key});`;
      }
      case 'hover':      return el ? `new Actions(driver).moveToElement(${el}).perform();` : null;
      case 'scroll':     return `((JavascriptExecutor)driver).executeScript("window.scrollBy(0,${parseInt(s.value)||0})");`;
      case 'fileUpload': return el ? `${el}.sendKeys("${esc(s.value, '"')}");` : null;
      case 'submit':     return el ? `${el}.submit();` : null;
      case 'dragDrop': {
        const tgtBy = s.targetCss
          ? `By.cssSelector("${esc(s.targetCss, '"')}")`
          : s.targetXpath ? `By.xpath("${esc(s.targetXpath, '"')}")` : null;
        return el && tgtBy
          ? `new Actions(driver).dragAndDrop(${el}, driver.findElement(${tgtBy})).perform();` : null;
      }
      case 'tap':        return el ? `${el}.click();` : null;
      default: return `// ${esc(s.description, '"')}`;
    }
  }

  // ── Selenium Python ─────────────────────────────────────────────────────────

  _genSeleniumPython(steps, name) {
    const fnName = name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^[0-9]+/, '') || 'recorded_flow';
    const lines = [
      `from selenium import webdriver`,
      `from selenium.webdriver.common.by import By`,
      `from selenium.webdriver.common.keys import Keys`,
      `from selenium.webdriver.support.ui import Select`,
      `from selenium.webdriver.common.action_chains import ActionChains`,
      `from selenium.webdriver.support.ui import WebDriverWait`,
      `from selenium.webdriver.support import expected_conditions as EC`,
      ``,
      `def test_${fnName}(driver):`
    ];
    const headerLength = lines.length;
    steps.forEach(s => {
      const line = this._stepToSeleniumPy(s);
      if (line) lines.push('    ' + line);
    });
    // headerLength is captured before the steps are appended, so adding an
    // import above never silently breaks the "empty body needs pass" check
    if (lines.length === headerLength) lines.push('    pass');
    return lines.join('\n');
  }

  _stepToSeleniumPy(s) {
    const byStr = s.css
      ? `By.CSS_SELECTOR, "${esc(s.css, '"')}"`
      : s.xpath ? `By.XPATH, "${esc(s.xpath, '"')}"` : null;
    const el  = byStr ? `driver.find_element(${byStr})` : null;

    switch (s.type) {
      case 'navigate':   return `driver.get("${esc(s.url, '"')}")`;
      case 'assertUrl':  return `WebDriverWait(driver, 10).until(EC.url_to_be("${esc(s.url, '"')}"))`;
      case 'click':      return el ? `${el}.click()` : null;
      case 'dblclick':   return el ? `ActionChains(driver).double_click(${el}).perform()` : null;
      case 'rightClick': return el ? `ActionChains(driver).context_click(${el}).perform()` : null;
      case 'fill':       return el ? `${el}.clear()\n    ${el}.send_keys("${esc(s.value, '"')}")` : null;
      case 'select':     return el
        ? `Select(${el}).select_by_visible_text("${esc(s.displayValue || s.value, '"')}")` : null;
      case 'check':      return el ? `el = ${el}\nif not el.is_selected(): el.click()` : null;
      case 'uncheck':    return el ? `el = ${el}\nif el.is_selected(): el.click()` : null;
      case 'press': {
        const key = pyKey(s.value);
        return el ? `${el}.send_keys(${key})` : `driver.switch_to.active_element.send_keys(${key})`;
      }
      case 'hover':      return el ? `ActionChains(driver).move_to_element(${el}).perform()` : null;
      case 'scroll':     return `driver.execute_script("window.scrollBy(0, ${parseInt(s.value)||0})")`;
      case 'fileUpload': return el ? `${el}.send_keys("${esc(s.value, '"')}")` : null;
      case 'submit':     return el ? `${el}.submit()` : null;
      case 'dragDrop': {
        const tgtBy = s.targetCss
          ? `By.CSS_SELECTOR, "${esc(s.targetCss, '"')}"`
          : s.targetXpath ? `By.XPATH, "${esc(s.targetXpath, '"')}"` : null;
        return el && tgtBy
          ? `ActionChains(driver).drag_and_drop(${el}, driver.find_element(${tgtBy})).perform()` : null;
      }
      case 'tap':        return el ? `${el}.click()` : null;
      default: return `# ${esc(s.description)}`;
    }
  }

  // ── Copy & Download ─────────────────────────────────────────────────────────

  _copyCode() {
    const name = (this.testNameIn?.value || 'recorded-flow').trim();
    const code = this._generateCode(this.steps, this.framework, name);
    window.PalTechUtils.copyToClipboard(code);
    const orig = this.copyBtn.textContent;
    this.copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { this.copyBtn.textContent = orig; }, 1800);
  }

  _downloadCode() {
    const name = (this.testNameIn?.value || 'recorded-flow').trim();
    const code = this._generateCode(this.steps, this.framework, name);
    const EXT  = { 'pw-js':'spec.js','pw-py':'py','cypress':'cy.js','sel-java':'java','sel-py':'py' };
    const ext  = EXT[this.framework] || 'txt';
    const fname = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.' + ext;
    const blob = new Blob([code], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
}

// ── Module-level helpers (pure functions, no DOM dependency) ──────────────────

/** Escape a string for use inside a single-quoted (or double-quoted) JS/Python string literal. */
function esc(str, quoteChar) {
  if (!str) return '';
  if (quoteChar === '"') return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Convert a Playwright JS locator string to Python snake_case equivalent. */
function toPyLoc(js) {
  if (!js) return 'page.locator("")';
  return js
    .replace(/page\.getByRole\('([^']+)',\s*\{\s*name:\s*'([^']*)'\s*\}\)/g,
      (_, r, n) => `page.get_by_role("${r}", name="${n}")`)
    .replace(/page\.getByRole\('([^']+)'\)/g,
      (_, r) => `page.get_by_role("${r}")`)
    .replace(/page\.getByLabel\('([^']*)'\)/g,    (_, t) => `page.get_by_label("${t}")`)
    .replace(/page\.getByPlaceholder\('([^']*)'\)/g, (_, t) => `page.get_by_placeholder("${t}")`)
    .replace(/page\.getByText\('([^']*)',\s*\{\s*exact:\s*true\s*\}\)/g,
      (_, t) => `page.get_by_text("${t}", exact=True)`)
    .replace(/page\.getByText\('([^']*)'\)/g,     (_, t) => `page.get_by_text("${t}")`)
    .replace(/page\.getByAltText\('([^']*)'\)/g,  (_, t) => `page.get_by_alt_text("${t}")`)
    .replace(/page\.getByTitle\('([^']*)'\)/g,    (_, t) => `page.get_by_title("${t}")`)
    .replace(/page\.getByTestId\('([^']*)'\)/g,   (_, t) => `page.get_by_test_id("${t}")`)
    .replace(/page\.locator\('([^']*)'\)/g,        (_, s) => `page.locator("${s}")`);
}

/** Convert a key name to a Selenium Java Keys constant. */
function javaKey(key) {
  const MAP = {
    'Enter':'Keys.RETURN','Escape':'Keys.ESCAPE','Backspace':'Keys.BACK_SPACE',
    'Delete':'Keys.DELETE','ArrowUp':'Keys.ARROW_UP','ArrowDown':'Keys.ARROW_DOWN',
    'ArrowLeft':'Keys.ARROW_LEFT','ArrowRight':'Keys.ARROW_RIGHT',
    'Home':'Keys.HOME','End':'Keys.END','PageUp':'Keys.PAGE_UP','PageDown':'Keys.PAGE_DOWN',
    'Tab':'Keys.TAB','Control+A':'Keys.chord(Keys.CONTROL,"a")',
    'Control+C':'Keys.chord(Keys.CONTROL,"c")','Control+V':'Keys.chord(Keys.CONTROL,"v")',
    'Control+X':'Keys.chord(Keys.CONTROL,"x")','Control+Z':'Keys.chord(Keys.CONTROL,"z")',
    'Control+Y':'Keys.chord(Keys.CONTROL,"y")'
  };
  if (MAP[key]) return MAP[key];
  // F1-F12 are real Keys constants; anything else is safer as a literal string
  // than as Keys.<SOMETHING> that does not exist and will not compile.
  if (/^F([1-9]|1[0-2])$/.test(key)) return `Keys.${key.toUpperCase()}`;
  return JSON.stringify(String(key));
}

/** Convert a key name to a Selenium Python Keys constant. */
function pyKey(key) {
  const MAP = {
    'Enter':'Keys.RETURN','Escape':'Keys.ESCAPE','Backspace':'Keys.BACK_SPACE',
    'Delete':'Keys.DELETE','ArrowUp':'Keys.ARROW_UP','ArrowDown':'Keys.ARROW_DOWN',
    'ArrowLeft':'Keys.ARROW_LEFT','ArrowRight':'Keys.ARROW_RIGHT',
    'Home':'Keys.HOME','End':'Keys.END','PageUp':'Keys.PAGE_UP','PageDown':'Keys.PAGE_DOWN',
    'Tab':'Keys.TAB','Control+A':'Keys.CONTROL + "a"',
    'Control+C':'Keys.CONTROL + "c"','Control+V':'Keys.CONTROL + "v"',
    'Control+X':'Keys.CONTROL + "x"','Control+Z':'Keys.CONTROL + "z"',
    'Control+Y':'Keys.CONTROL + "y"'
  };
  if (MAP[key]) return MAP[key];
  if (/^F([1-9]|1[0-2])$/.test(key)) return `Keys.${key.toUpperCase()}`;
  return JSON.stringify(String(key));
}

window.recorderTab = new RecorderTab();
