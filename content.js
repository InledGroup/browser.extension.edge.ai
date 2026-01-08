/**
 * Content Script - Edge.AI Browser Extension
 *
 * Responsibilities:
 * 1. Auto-detect Edge.AI webapp (edge.inled.es or localhost:4321)
 * 2. Establish connection with webapp via window.postMessage
 * 3. Listen for search requests from webapp
 * 4. Extract content from web pages for RAG processing
 */

// Configuration
const ALLOWED_ORIGINS = [
  'https://edge.inled.es',
  'http://localhost:4321',
  'https://localhost:4321',
  'https://hosted.inled.es'
];

let permissionMode = 'ask'; // 'ask' or 'permissive'
let isWebApp = false;

/**
 * Check if current page is the Edge.AI webapp
 */
function checkIfWebApp() {
  const currentOrigin = window.location.origin;
  isWebApp = ALLOWED_ORIGINS.some(origin => currentOrigin.startsWith(origin));

  if (isWebApp) {
    console.log('[EdgeAI Content] ✅ Running on Edge.AI webapp');
    establishConnection();
  } else {
    console.log('[EdgeAI Content] 📄 Running on regular page, ready for extraction');
  }

  return isWebApp;
}

/**
 * Establish connection with webapp
 */
function establishConnection() {
  // Load permission mode from storage
  chrome.storage.local.get(['permissionMode'], (result) => {
    permissionMode = result.permissionMode || 'ask';

    // Send CONNECTION_READY message to webapp
    window.postMessage({
      source: 'edgeai-extension',
      type: 'CONNECTION_READY',
      data: {
        permissionMode,
        version: chrome.runtime.getManifest().version
      }
    }, '*');

    console.log('[EdgeAI Content] 🔗 Connection established with webapp');
  });
}

/**
 * Listen for messages from webapp
 */
window.addEventListener('message', async (event) => {
  // Only accept messages from same window
  if (event.source !== window) return;

  const message = event.data;

  // Check if it's a webapp message
  if (!message || message.source !== 'edgeai-webapp') return;

  console.log('[EdgeAI Content] 📨 Received from webapp:', message.type);

  switch (message.type) {
    case 'PING':
      handlePing();
      break;

    case 'SEARCH_REQUEST':
      handleSearchRequest(message.data);
      break;

    case 'SEARCH_ONLY_REQUEST':
      handleSearchOnlyRequest(message.data);
      break;

    case 'EXTRACT_URLS_REQUEST':
      handleExtractUrlsRequest(message.data);
      break;
  }
});

/**
 * Handle PING from webapp
 */
function handlePing() {
  console.log('[EdgeAI Content] 🏓 Responding to PING');

  // Send PONG
  window.postMessage({
    source: 'edgeai-extension',
    type: 'PONG',
    data: {
      version: chrome.runtime.getManifest().version
    }
  }, '*');

  // Also send CONNECTION_READY to establish connection
  if (isWebApp) {
    window.postMessage({
      source: 'edgeai-extension',
      type: 'CONNECTION_READY',
      data: {
        permissionMode,
        version: chrome.runtime.getManifest().version
      }
    }, '*');
    console.log('[EdgeAI Content] 🔗 Sent CONNECTION_READY in response to PING');
  } else {
    // If not already connected, establish connection
    checkIfWebApp();
  }
}

/**
 * Handle search request from webapp
 */
async function handleSearchRequest(data) {
  const { requestId, query, maxResults } = data;

  console.log('[EdgeAI Content] 🔍 Search request:', query);

  try {
    // Check permission
    const allowed = await checkPermission(query);

    if (!allowed) {
      console.log('[EdgeAI Content] ❌ Search denied by user');
      window.postMessage({
        source: 'edgeai-extension',
        type: 'SEARCH_DENIED',
        data: {
          requestId,
          reason: 'User denied permission'
        }
      }, '*');
      return;
    }

    // Forward to background script to perform search
    console.log('[EdgeAI Content] 📤 Forwarding to background script...');
    chrome.runtime.sendMessage({
      type: 'SEARCH_AND_EXTRACT',
      query,
      requestId,
      maxResults: maxResults || 10
    }, (response) => {
      console.log('[EdgeAI Content] 📥 Response from background:', response);

      if (chrome.runtime.lastError) {
        console.error('[EdgeAI Content] Search error:', chrome.runtime.lastError);
        window.postMessage({
          source: 'edgeai-extension',
          type: 'SEARCH_ERROR',
          data: {
            requestId,
            error: chrome.runtime.lastError.message
          }
        }, '*');
        return;
      }

      if (response && response.success) {
        console.log('[EdgeAI Content] ✅ Search completed:', response.results.sources.length, 'results');
        window.postMessage({
          source: 'edgeai-extension',
          type: 'SEARCH_RESPONSE',
          data: {
            requestId,
            results: response.results.sources
          }
        }, '*');
      } else {
        console.error('[EdgeAI Content] Search failed:', response?.error);
        window.postMessage({
          source: 'edgeai-extension',
          type: 'SEARCH_ERROR',
          data: {
            requestId,
            error: response?.error || 'Unknown error'
          }
        }, '*');
      }
    });

  } catch (error) {
    console.error('[EdgeAI Content] Search request error:', error);

    let errorMessage = error.message;

    // Special handling for extension context invalidated
    if (error.message.includes('Extension context invalidated')) {
      errorMessage = 'Extension was reloaded. Please refresh this page to reconnect.';
      console.warn('[EdgeAI Content] ⚠️ Extension context invalidated - page needs refresh');
    }

    window.postMessage({
      source: 'edgeai-extension',
      type: 'SEARCH_ERROR',
      data: {
        requestId,
        error: errorMessage
      }
    }, '*');
  }
}

/**
 * Handle search only request (no confirmation needed usually as it doesn't open tabs)
 */
async function handleSearchOnlyRequest(data) {
  const { requestId, query } = data;
  console.log('[EdgeAI Content] 🔍 Search ONLY request:', query);

  try {
    chrome.runtime.sendMessage({
      type: 'SEARCH_ONLY',
      query,
      requestId
    }, (response) => {
      // Check for lastError (async errors)
      if (chrome.runtime.lastError) {
        console.error('[EdgeAI Content] Search error:', chrome.runtime.lastError);
        window.postMessage({
          source: 'edgeai-extension',
          type: 'SEARCH_ERROR',
          data: {
            requestId,
            error: chrome.runtime.lastError.message
          }
        }, '*');
        return;
      }

      if (response && response.success) {
        window.postMessage({
          source: 'edgeai-extension',
          type: 'SEARCH_RESPONSE',
          data: {
            requestId,
            results: response.results
          }
        }, '*');
      } else {
        window.postMessage({
          source: 'edgeai-extension',
          type: 'SEARCH_ERROR',
          data: { requestId, error: response?.error || 'Search failed' }
        }, '*');
      }
    });
  } catch (error) {
    // Catch synchronous errors (like Context Invalidated)
    console.error('[EdgeAI Content] Search request error:', error);
    const isInvalidated = error.message && error.message.includes('Extension context invalidated');
    
    window.postMessage({
      source: 'edgeai-extension',
      type: 'SEARCH_ERROR',
      data: {
        requestId,
        error: isInvalidated ? 'Extension was reloaded. Please refresh the page.' : error.message
      }
    }, '*');
  }
}

/**
 * Handle extraction request (needs permission if strict)
 */
async function handleExtractUrlsRequest(data) {
  const { requestId, urls } = data;
  console.log('[EdgeAI Content] 📄 Extract URLs request:', urls.length);

  try {
    chrome.runtime.sendMessage({
      type: 'EXTRACT_URLS',
      urls,
      requestId
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[EdgeAI Content] Extraction error:', chrome.runtime.lastError);
        window.postMessage({
          source: 'edgeai-extension',
          type: 'SEARCH_ERROR',
          data: {
            requestId,
            error: chrome.runtime.lastError.message
          }
        }, '*');
        return;
      }

      if (response && response.success) {
        window.postMessage({
          source: 'edgeai-extension',
          type: 'SEARCH_RESPONSE',
          data: {
            requestId,
            results: response.results.sources
          }
        }, '*');
      } else {
        window.postMessage({
          source: 'edgeai-extension',
          type: 'SEARCH_ERROR',
          data: { requestId, error: response?.error || 'Extraction failed' }
        }, '*');
      }
    });
  } catch (error) {
    console.error('[EdgeAI Content] Extraction request error:', error);
    const isInvalidated = error.message && error.message.includes('Extension context invalidated');

    window.postMessage({
      source: 'edgeai-extension',
      type: 'SEARCH_ERROR',
      data: {
        requestId,
        error: isInvalidated ? 'Extension was reloaded. Please refresh the page.' : error.message
      }
    }, '*');
  }
}

/**
 * Check if user grants permission for search
 */
async function checkPermission(query) {
  // If in permissive mode, always allow
  if (permissionMode === 'permissive') {
    console.log('[EdgeAI Content] ✅ Permissive mode enabled, auto-allowing');
    return true;
  }

  // Ask user for permission
  return new Promise((resolve) => {
    const confirmed = confirm(
      `Edge.AI wants to perform a web search:\n\n"${query}"\n\n` +
      `This will:\n` +
      `• Search Google for relevant pages\n` +
      `• Extract content from those pages\n` +
      `• Send content to the AI for analysis\n\n` +
      `Allow this search?`
    );

    resolve(confirmed);
  });
}

/**
 * Extract page content for RAG processing
 */
function extractPageContent() {
  const result = {
    title: document.title,
    url: window.location.href,
    content: '',
    wordCount: 0,
    extractedAt: Date.now()
  };

  try {
    // Get the main content
    const content = extractMainContent();

    // Clean and process the text
    result.content = cleanText(content);
    result.wordCount = countWords(result.content);

    console.log(`[EdgeAI Content] Extracted ${result.wordCount} words from ${result.url}`);

    return result;

  } catch (error) {
    console.error('[EdgeAI Content] Extraction error:', error);
    return result;
  }
}

/**
 * Extract main content using multiple strategies
 */
function extractMainContent() {
  let content = '';

  // Strategy 1: Look for main content areas (semantic HTML)
  const mainSelectors = [
    'main',
    'article',
    '[role="main"]',
    '.main-content',
    '#main-content',
    '#content',
    '.content',
    '.article-content',
    '.post-content'
  ];

  for (const selector of mainSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      content = extractTextFromElement(element);
      if (content.length > 500) {
        return content;
      }
    }
  }

  // Strategy 2: Wikipedia-specific extraction
  if (window.location.hostname.includes('wikipedia.org')) {
    const wikiContent = document.querySelector('#mw-content-text');
    if (wikiContent) {
      return extractTextFromElement(wikiContent);
    }
  }

  // Strategy 3: Remove common non-content elements and extract from body
  const body = document.body.cloneNode(true);

  const removeSelectors = [
    'script', 'style', 'nav', 'header', 'footer', 'aside',
    '.navigation', '.nav', '.menu', '.sidebar', '.ads',
    '.advertisement', '.social-share', '.comments', '.related-posts',
    '[role="navigation"]', '[role="complementary"]',
    '[role="banner"]', '[role="contentinfo"]'
  ];

  removeSelectors.forEach(selector => {
    body.querySelectorAll(selector).forEach(el => el.remove());
  });

  content = extractTextFromElement(body);
  return content;
}

/**
 * Extract text from an element
 */
function extractTextFromElement(element) {
  if (!element) return '';

  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }

        const tagName = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript'].includes(tagName)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (node.textContent.trim().length > 0) {
          return NodeFilter.FILTER_ACCEPT;
        }

        return NodeFilter.FILTER_REJECT;
      }
    }
  );

  const textParts = [];
  let node;

  while (node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (text) {
      textParts.push(text);
    }
  }

  return textParts.join(' ');
}

/**
 * Clean text
 */
function cleanText(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Count words
 */
function countWords(text) {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

/**
 * Send extracted content to background script
 */
function sendToBackground(data) {
  chrome.runtime.sendMessage({
    type: 'CONTENT_EXTRACTED',
    data: data
  });
}

// Initialize
checkIfWebApp();

// Auto-extract if not on webapp
if (!isWebApp) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        const extracted = extractPageContent();
        sendToBackground(extracted);
      }, 1000);
    });
  } else {
    setTimeout(() => {
      const extracted = extractPageContent();
      sendToBackground(extracted);
    }, 1000);
  }
}

// Listen for manual extraction requests and permission mode changes
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'EXTRACT_NOW') {
    const extracted = extractPageContent();
    sendResponse(extracted);
    return true;
  }

  if (request.type === 'PERMISSION_MODE_CHANGED') {
    permissionMode = request.mode;
    console.log('[EdgeAI Content] Permission mode updated:', permissionMode);

    // Notify webapp if we're on the webapp
    if (isWebApp) {
      window.postMessage({
        source: 'edgeai-extension',
        type: 'CONNECTION_READY',
        data: {
          permissionMode,
          version: chrome.runtime.getManifest().version
        }
      }, '*');
    }
  }
});

console.log('[EdgeAI Content] Content script loaded');
