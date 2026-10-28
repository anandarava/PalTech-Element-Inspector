/**
 * highlighting.js - Functions for highlighting elements on the page
 *
 * Wrapped in an IIFE with a re-injection guard, like every other content
 * script. Content scripts share the isolated world's global scope, so any
 * top-level const/let/class here throws "Identifier 'X' has already been
 * declared" the second time the file is injected — and it does get injected
 * twice: the manifest at document_idle, the side panel when its ping finds
 * nothing, the service worker after a navigation while recording.
 *
 * The body keeps its original indentation; re-indenting the whole file would
 * bury every real change in it.
 */
(function () {

if (window.PalTechHighlight) return;   // already evaluated on this page

/**
 * Highlights a specific element on the page
 * @param {Object} selector - Object containing selector information
 */
function highlightElement(selector) {
    try {
      // Try CSS selector first
      let element = null;
      
      if (selector['CSS Selector']) {
        try {
          element = document.querySelector(selector['CSS Selector']);
        } catch (e) {
          console.error("Error with CSS selector:", e);
        }
      }
      
      // If CSS selector fails, try XPath
      if (!element && selector['Relative XPath']) {
        try {
          const xpathResult = document.evaluate(
            selector['Relative XPath'],
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          );
          
          element = xpathResult.singleNodeValue;
        } catch (e) {
          console.error("Error with XPath selector:", e);
        }
      }
      
      if (element) {
        // Remove any existing highlight
        removeHighlight();
        
        // Store original styles to restore later
        const originalOutline = element.style.outline;
        const originalOutlineOffset = element.style.outlineOffset;
        const originalBoxShadow = element.style.boxShadow;
        const originalPosition = element.style.position;
        const originalZIndex = element.style.zIndex;
        
        // Create a data attribute to identify this element for removal
        element.setAttribute('data-selector-highlight', 'true');
        
        // Store original styles for restoration
        element.setAttribute('data-original-outline', originalOutline || '');
        element.setAttribute('data-original-outline-offset', originalOutlineOffset || '');
        element.setAttribute('data-original-box-shadow', originalBoxShadow || '');
        element.setAttribute('data-original-position', originalPosition || '');
        element.setAttribute('data-original-z-index', originalZIndex || '');
        
        // Apply highlight styles
        element.style.outline = '2px solid orange';
        element.style.outlineOffset = '2px';
        element.style.boxShadow = '0 0 10px rgba(255, 165, 0, 0.5)';
        
        // Ensure the element has a stacking context and is visible
        if (getComputedStyle(element).position === 'static') {
          element.style.position = 'relative';
        }
        element.style.zIndex = '10000';
        
        // Scroll element into view if needed
        element.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'center'
        });
      }
    } catch (error) {
      console.error("Error highlighting element:", error);
    }
  }
  
  /**
   * Removes highlight from previously highlighted element
   */
  function removeHighlight() {
    // Find any element with our highlight data attribute
    const highlightedElement = document.querySelector('[data-selector-highlight="true"]');
    
    if (highlightedElement) {
      // Restore original styles
      highlightedElement.style.outline = highlightedElement.getAttribute('data-original-outline') || '';
      highlightedElement.style.outlineOffset = highlightedElement.getAttribute('data-original-outline-offset') || '';
      highlightedElement.style.boxShadow = highlightedElement.getAttribute('data-original-box-shadow') || '';
      highlightedElement.style.position = highlightedElement.getAttribute('data-original-position') || '';
      highlightedElement.style.zIndex = highlightedElement.getAttribute('data-original-z-index') || '';
      
      // Remove our data attributes
      highlightedElement.removeAttribute('data-selector-highlight');
      highlightedElement.removeAttribute('data-original-outline');
      highlightedElement.removeAttribute('data-original-outline-offset');
      highlightedElement.removeAttribute('data-original-box-shadow');
      highlightedElement.removeAttribute('data-original-position');
      highlightedElement.removeAttribute('data-original-z-index');
    }
  }
  
  // Export functions to be used in other modules
  window.PalTechHighlight = {
    highlightElement,
    removeHighlight
  };

})();
