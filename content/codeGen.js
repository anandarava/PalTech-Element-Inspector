/**
 * codeGen.js — Generates ready-to-paste code snippets for multiple test frameworks.
 * Given a Playwright locator string (e.g. page.getByRole('button', { name: 'Submit' }))
 * plus the raw CSS / XPath fallbacks, it produces equivalent snippets for:
 *   Playwright JS, Playwright Python, Cypress, Selenium Java, Selenium Python
 */

(function () {

  /**
   * Converts a Playwright JS locator to equivalent snippets for other frameworks.
   * @param {string} playwrightLocator  - e.g. "page.getByRole('button', { name: 'Submit' })"
   * @param {string} cssSelector        - raw CSS selector (fallback)
   * @param {string} xpath              - raw XPath expression (fallback)
   * @param {string} elementName        - automation-friendly name (used as variable name)
   * @returns {Object[]} Array of { framework, language, code }
   */
  function generateFrameworkSnippets(playwrightLocator, cssSelector, xpath, elementName) {
    const varName = elementName
      ? elementName.charAt(0).toLowerCase() + elementName.slice(1)
      : 'element';

    const snippets = [];

    // ── Playwright JS ─────────────────────────────────────────
    snippets.push({
      framework: 'Playwright',
      language: 'JavaScript',
      code: `const ${varName} = ${playwrightLocator};\nawait ${varName}.click();`
    });

    // ── Playwright Python ─────────────────────────────────────
    const pyLocator = convertToPlaywrightPython(playwrightLocator);
    snippets.push({
      framework: 'Playwright',
      language: 'Python',
      code: `${varName} = ${pyLocator}\n${varName}.click()`
    });

    // ── Cypress ───────────────────────────────────────────────
    const cypressSelector = cssSelector || xpath;
    const cypressLocator = cssSelector
      ? `cy.get('${cssSelector.replace(/'/g, "\\'")}')`
      : `cy.xpath('${(xpath || '').replace(/'/g, "\\'")}')`;
    snippets.push({
      framework: 'Cypress',
      language: 'JavaScript',
      code: `${cypressLocator}.click();`
    });

    // ── Selenium Java ─────────────────────────────────────────
    const javaBy = cssSelector
      ? `By.cssSelector("${cssSelector.replace(/"/g, '\\"')}")`
      : `By.xpath("${(xpath || '').replace(/"/g, '\\"')}")`;
    snippets.push({
      framework: 'Selenium',
      language: 'Java',
      code: `WebElement ${varName} = driver.findElement(${javaBy});\n${varName}.click();`
    });

    // ── Selenium Python ───────────────────────────────────────
    const pyBy = cssSelector
      ? `By.CSS_SELECTOR, "${cssSelector.replace(/"/g, '\\"')}"`
      : `By.XPATH, "${(xpath || '').replace(/"/g, '\\"')}"`;
    snippets.push({
      framework: 'Selenium',
      language: 'Python',
      code: `${varName} = driver.find_element(${pyBy})\n${varName}.click()`
    });

    return snippets;
  }

  /**
   * Rough conversion of a Playwright JS locator to its Python equivalent.
   * Handles the most common locator methods.
   * @param {string} js - Playwright JS locator string
   * @returns {string} - Playwright Python locator string
   */
  function convertToPlaywrightPython(js) {
    if (!js) return 'page.locator("")';

    return js
      // page.getByRole('button', { name: 'Submit' })  →  page.get_by_role("button", name="Submit")
      .replace(/page\.getByRole\('([^']+)',\s*\{\s*name:\s*'([^']*)'\s*\}\)/g,
        (_, role, name) => `page.get_by_role("${role}", name="${name}")`)
      .replace(/page\.getByRole\('([^']+)'\)/g,
        (_, role) => `page.get_by_role("${role}")`)
      // page.getByLabel('Email')  →  page.get_by_label("Email")
      .replace(/page\.getByLabel\('([^']*)'\)/g,
        (_, t) => `page.get_by_label("${t}")`)
      // page.getByPlaceholder('...')  →  page.get_by_placeholder("...")
      .replace(/page\.getByPlaceholder\('([^']*)'\)/g,
        (_, t) => `page.get_by_placeholder("${t}")`)
      // page.getByText('...', { exact: true })  →  page.get_by_text("...", exact=True)
      .replace(/page\.getByText\('([^']*)',\s*\{\s*exact:\s*true\s*\}\)/g,
        (_, t) => `page.get_by_text("${t}", exact=True)`)
      .replace(/page\.getByText\('([^']*)'\)/g,
        (_, t) => `page.get_by_text("${t}")`)
      // page.getByAltText / getByTitle / getByTestId
      .replace(/page\.getByAltText\('([^']*)'\)/g,
        (_, t) => `page.get_by_alt_text("${t}")`)
      .replace(/page\.getByTitle\('([^']*)'\)/g,
        (_, t) => `page.get_by_title("${t}")`)
      .replace(/page\.getByTestId\('([^']*)'\)/g,
        (_, t) => `page.get_by_test_id("${t}")`)
      // page.locator('css=...') / page.locator('xpath=...')
      .replace(/page\.locator\('([^']*)'\)/g,
        (_, s) => `page.locator("${s}")`);
  }

  window.PalTechCodeGen = { generateFrameworkSnippets };

})();
