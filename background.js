// Background Service Worker - Handles searches and orchestrates content extraction

const STORAGE_KEY = 'edgeai_search_results';
const MAX_PAGES_PER_SEARCH = 3;

// Store for ongoing search operations
const activeSearches = new Map();
const apiStats = {
  inbound: { active: false, lastUsed: 0, totalRequests: 0 },
  outbound: { active: false, lastUsed: 0, totalRequests: 0 }
};

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
    apiStats.outbound.active = true;
    apiStats.outbound.lastUsed = Date.now();
    apiStats.outbound.totalRequests++;
    handleFetchJson(request.url, request.options).then(res => {
      apiStats.outbound.active = false;
      sendResponse(res);
    });
    return true;
  }

  if (request.type === 'CHAT_COMPLETIONS') {
    apiStats.inbound.active = true;
    apiStats.inbound.lastUsed = Date.now();
    apiStats.inbound.totalRequests++;
    handleInboundApiRequest(request.payload, request.apiKey).then(res => {
      apiStats.inbound.active = false;
      sendResponse(res);
    });
    return true;
  }
});

/**
 * Handle Inbound API request (OpenAI standard)
 * Finds the active Edge AI tab and forwards the request
 */
async function handleInboundApiRequest(payload, apiKey) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://edge.inled.es/*', 'http://localhost:4321/*'] });
    if (tabs.length === 0) {
      throw new Error('Edge AI tab not found or not active');
    }

    // Use the first available tab
    const targetTabId = tabs[0].id;
    const requestId = `api_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve) => {
      // Setup temporary listener for the response from this specific request
      const listener = (message, sender) => {
        if (sender.tab && sender.tab.id === targetTabId && message.requestId === requestId) {
          if (message.type === 'OPENAI_API_RESPONSE') {
            chrome.runtime.onMessage.removeListener(listener);
            resolve({ success: true, data: message.result || { done: true } });
          } else if (message.type === 'OPENAI_API_ERROR') {
            chrome.runtime.onMessage.removeListener(listener);
            resolve({ success: false, error: message.error });
          }
          // Note: Streaming chunks are handled separately if needed, 
          // but for simple external API calls, we might want to support streaming too.
          // For now, let's keep it simple or implement a callback system.
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      chrome.tabs.sendMessage(targetTabId, {
        type: 'OPENAI_API_REQUEST',
        requestId,
        payload,
        apiKey
      });

      // Timeout if no response
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ success: false, error: 'Request timeout' });
      }, 120000); // 2 minute timeout for inference
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_API_STATS') {
    sendResponse(apiStats);
    return false;
  }

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
      handleFetchJson(request.url, request.options).then(sendResponse);
      return true;
    }
   else if (request.type === 'CHECK_UPDATES_MANUAL') {
    checkForUpdates().then(found => sendResponse({ updateFound: found }));
    return true;
  }
});

/**
 * Handle generic fetch proxy to bypass CORS
 */
async function handleFetchJson(url, options = {}) {
  try {
    const { method = 'GET', headers = {}, body = null } = options;
    
    // Minimal headers to avoid triggering security blocks
    const finalHeaders = { ...headers };
    
    const fetchOptions = {
      method,
      headers: finalHeaders,
      cache: 'no-store',
      // 'omit' credentials and 'cors' mode is standard for extension proxies
      credentials: 'omit',
      mode: 'cors'
    };

    if (body && method !== 'GET') {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!finalHeaders['Content-Type']) {
        finalHeaders['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(url, fetchOptions);
    
    let text = '';
    try {
      text = await response.text();
    } catch (e) {}
    
    let data = null;
    if (text && text.trim()) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { message: text };
      }
    }
    
    if (!response.ok) {
      // If we get a 403, it's almost certainly OLLAMA_ORIGINS
      const errorMsg = response.status === 403 
        ? 'Error 403: Ollama bloquea la conexión. Configura OLLAMA_ORIGINS="*" en tu servidor.' 
        : (data && (data.error || data.message)) || `HTTP ${response.status}`;
        
      return { success: false, error: errorMsg, status: response.status };
    }

    return { success: true, data: data || { success: true } };
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
