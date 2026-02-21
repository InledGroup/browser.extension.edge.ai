// Background Service Worker - Handles searches and orchestrates content extraction

const STORAGE_KEY = 'edgeai_search_results';
const MAX_PAGES_PER_SEARCH = 3;

// Store for ongoing search operations
const activeSearches = new Map();

// Listen for messages from web app and content scripts
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  if (request.type === 'PING') {
    sendResponse({ success: true, message: 'EdgeAI extension is running' });
    return false;
  }

  if (request.type === 'SEARCH_AND_EXTRACT') {
    handleSearchRequest(request.query, request.searchId).then(sendResponse);
    return true;
  }

  if (request.type === 'SEARCH_ONLY') {
    handleSearchOnly(request.query, request.searchId).then(sendResponse);
    return true;
  }

  if (request.type === 'EXTRACT_URLS') {
    handleExtractionRequest(request.urls, request.searchId).then(sendResponse);
    return true;
  }

  if (request.type === 'FETCH_JSON') {
    handleFetchJson(request.url).then(sendResponse);
    return true;
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CONTENT_EXTRACTED') {
    // Handled by dynamic listeners in openAndExtractContent
    return false;
  } else if (request.type === 'GET_RESULTS') {
    getStoredResults(request.searchId).then(sendResponse);
    return true;
  } else if (request.type === 'SEARCH_AND_EXTRACT') {
    handleSearchRequest(request.query, request.requestId).then(sendResponse);
    return true;
  } else if (request.type === 'SEARCH_ONLY') {
    handleSearchOnly(request.query, request.requestId).then(sendResponse);
    return true;
  } else if (request.type === 'EXTRACT_URLS') {
    handleExtractionRequest(request.urls, request.requestId).then(sendResponse);
    return true;
  } else if (request.type === 'FETCH_JSON') {
    handleFetchJson(request.url).then(sendResponse);
    return true;
  } else if (request.type === 'CHECK_UPDATES_MANUAL') {
    checkForUpdates().then(found => sendResponse({ updateFound: found }));
    return true;
  }
});

/**
 * Handle generic JSON fetch
 */
async function handleFetchJson(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Search only (no extraction)
 */
async function handleSearchOnly(query, searchId) {
  try {
    const [wikipediaUrls, duckduckgoUrls] = await Promise.all([
      searchWikipedia(query),
      searchDuckDuckGo(query)
    ]);

    const allUrls = [...new Set([...wikipediaUrls, ...duckduckgoUrls])];
    const results = allUrls.map(url => ({
      title: url,
      url: url,
      snippet: 'Source found via web search',
      source: url.includes('wikipedia') ? 'wikipedia' : 'duckduckgo'
    }));

    return { success: true, searchId, resultCount: results.length, results };
  } catch (error) {
    return { success: false, searchId, error: error.message };
  }
}

/**
 * Extract content from specific URLs
 */
async function handleExtractionRequest(urls, requestId) {
  try {
    const extractionPromises = urls.map(url => openAndExtractContent(url, requestId));
    const results = await Promise.allSettled(extractionPromises);
    const sources = [];

    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value) {
        sources.push(result.value);
      }
    });

    return { success: true, requestId, resultCount: sources.length, results: { sources } };
  } catch (error) {
    return { success: false, requestId, error: error.message };
  }
}

/**
 * Main search handler
 */
async function handleSearchRequest(query, searchId) {
  try {
    const [wikipediaUrls, duckduckgoUrls] = await Promise.all([
      searchWikipedia(query),
      searchDuckDuckGo(query)
    ]);

    const allUrls = [...new Set([...wikipediaUrls, ...duckduckgoUrls])];
    const urlsToOpen = allUrls.slice(0, MAX_PAGES_PER_SEARCH);

    const extractionPromises = urlsToOpen.map(url => openAndExtractContent(url, searchId));
    const results = await Promise.allSettled(extractionPromises);
    const sources = [];

    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value) {
        sources.push(result.value);
      }
    });

    const searchResults = { searchId, query, timestamp: Date.now(), sources, status: 'completed' };
    return { success: true, searchId, resultCount: sources.length, results: searchResults };
  } catch (error) {
    return { success: false, searchId, error: error.message };
  }
}

/**
 * Search Wikipedia
 */
async function searchWikipedia(query) {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&format=json&origin=*`;
    const response = await fetch(searchUrl);
    const data = await response.json();
    return data[3] || [];
  } catch (e) { return []; }
}

/**
 * Search DuckDuckGo Lite
 */
async function searchDuckDuckGo(query) {
  try {
    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl);
    if (!response.ok) return [];
    const html = await response.text();
    return extractUrlsFromDDGLite(html).slice(0, 3);
  } catch (e) { return []; }
}

function extractUrlsFromDDGLite(html) {
  const urls = [];
  const uddgRegex = /uddg=([^&"']+)/gi;
  let match;
  while ((match = uddgRegex.exec(html)) !== null) {
    try {
      const decodedUrl = decodeURIComponent(match[1]);
      if (decodedUrl.startsWith('http') && !decodedUrl.includes('duckduckgo.com')) {
        urls.push(decodedUrl);
      }
    } catch (e) {}
  }
  return [...new Set(urls)];
}

/**
 * Open URL and extract (Message-based, no storage)
 */
async function openAndExtractContent(url, requestId) {
  return new Promise(async (resolve, reject) => {
    let tabId = null;
    const timeout = setTimeout(() => {
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      reject(new Error(`Timeout extracting ${url}`));
    }, 25000);

    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;

      const listener = (request, sender) => {
        if (request.type === 'CONTENT_EXTRACTED' && sender.tab && sender.tab.id === tabId) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          chrome.tabs.remove(tabId).catch(() => {});
          resolve({
            url,
            title: request.data.title || url,
            content: request.data.content || '',
            extractedAt: Date.now(),
            wordCount: request.data.wordCount || 0
          });
        }
      };
      chrome.runtime.onMessage.addListener(listener);
    } catch (error) {
      clearTimeout(timeout);
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      reject(error);
    }
  });
}

// ============================================================================
// UPDATE CHECKER
// ============================================================================

const UPDATE_API_URL = 'https://extupdater.inled.es/api/updates.json';
const UPDATE_CHECK_INTERVAL = 600000; 

async function checkForUpdates() {
  try {
    const manifest = chrome.runtime.getManifest();
    const currentVersion = manifest.version;
    const matchId = `edgeai-v${currentVersion}`.toLowerCase();

    const response = await fetch(`${UPDATE_API_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return false;

    const updates = await response.json();
    const match = updates.find(u => u.id && u.id.toLowerCase().trim().includes(matchId));

    if (match) {
      const updateInfo = { id: match.id, url: match.url, detectedAt: Date.now() };
      try {
        await chrome.storage.local.set({ pendingUpdate: updateInfo });
      } catch (e) {
        console.warn('[EdgeAI] Quota error, clearing storage...');
        await chrome.storage.local.clear();
        await chrome.storage.local.set({ pendingUpdate: updateInfo });
      }

      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Actualización disponible',
        message: `Nueva versión o parche detectado: ${match.id}`,
        priority: 2
      });
      return true;
    }
    return false;
  } catch (error) {
    console.error('[EdgeAI] Update check failed:', error);
    return false;
  }
}

// Handle notification click
chrome.notifications.onClicked.addListener(async () => {
  const data = await chrome.storage.local.get(['pendingUpdate']);
  if (data.pendingUpdate && data.pendingUpdate.url) {
    chrome.tabs.create({ url: data.pendingUpdate.url });
  }
});

setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
checkForUpdates();

console.log('[EdgeAI] Background service worker initialized');
