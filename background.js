// Background Service Worker - Handles searches and orchestrates content extraction

const STORAGE_KEY = 'edgeai_search_results';
const MAX_PAGES_PER_SEARCH = 3;

// Store for ongoing search operations
const activeSearches = new Map();

// Listen for messages from web app and content scripts
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  if (request.type === 'PING') {
    sendResponse({ success: true, message: 'EdgeAI extension is running' });
    return true;
  }

  if (request.type === 'SEARCH_AND_EXTRACT') {
    handleSearchRequest(request.query, request.searchId).then(sendResponse);
    return true; // Keep channel open for async response
  }

  if (request.type === 'SEARCH_ONLY') {
    handleSearchOnly(request.query, request.searchId).then(sendResponse);
    return true;
  }

  if (request.type === 'EXTRACT_URLS') {
    handleExtractionRequest(request.urls, request.searchId).then(sendResponse);
    return true;
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CONTENT_EXTRACTED') {
    handleContentExtracted(request.data, sender.tab.id);
  } else if (request.type === 'GET_RESULTS') {
    getStoredResults(request.searchId).then(sendResponse);
    return true;
  } else if (request.type === 'SEARCH_AND_EXTRACT') {
    handleSearchRequest(request.query, request.requestId).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (request.type === 'SEARCH_ONLY') {
    handleSearchOnly(request.query, request.requestId).then(sendResponse);
    return true;
  } else if (request.type === 'EXTRACT_URLS') {
    handleExtractionRequest(request.urls, request.requestId).then(sendResponse);
    return true;
  }
});

/**
 * Search only (no extraction)
 */
async function handleSearchOnly(query, searchId) {
  try {
    console.log(`[EdgeAI] Starting search ONLY for: "${query}" (ID: ${searchId})`);

    // Perform searches in parallel
    const [wikipediaUrls, duckduckgoUrls] = await Promise.all([
      searchWikipedia(query),
      searchDuckDuckGo(query)
    ]);

    // Combine and deduplicate URLs
    const allUrls = [...new Set([...wikipediaUrls, ...duckduckgoUrls])];
    
    // Create basic search results format
    const results = allUrls.map(url => ({
      title: url, // Title might not be available yet
      url: url,
      snippet: 'Source found via web search',
      source: url.includes('wikipedia') ? 'wikipedia' : 'duckduckgo'
    }));

    return {
      success: true,
      searchId,
      resultCount: results.length,
      results: results
    };

  } catch (error) {
    console.error('[EdgeAI] Search error:', error);
    return {
      success: false,
      searchId,
      error: error.message
    };
  }
}

/**
 * Extract content from specific URLs
 */
async function handleExtractionRequest(urls, searchId) {
  try {
    console.log(`[EdgeAI] Starting extraction for ${urls.length} URLs (ID: ${searchId})`);

    const extractionPromises = urls.map(url =>
      openAndExtractContent(url, searchId)
    );

    const results = await Promise.allSettled(extractionPromises);
    const sources = [];

    // Process results
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        sources.push(result.value);
      } else {
        console.warn(`[EdgeAI] Failed to extract from ${urls[index]}:`, result.reason);
      }
    });

    return {
      success: true,
      searchId,
      resultCount: sources.length,
      results: { sources } // Match expected format for getStoredResults
    };

  } catch (error) {
    console.error('[EdgeAI] Extraction error:', error);
    return {
      success: false,
      searchId,
      error: error.message
    };
  }
}

/**
 * Main search handler - performs searches and opens pages in background
 */
async function handleSearchRequest(query, searchId) {
  try {
    console.log(`[EdgeAI] Starting search for: "${query}" (ID: ${searchId})`);

    const searchResults = {
      searchId,
      query,
      timestamp: Date.now(),
      sources: [],
      status: 'processing'
    };

    activeSearches.set(searchId, searchResults);

    // Perform searches in parallel
    const [wikipediaUrls, duckduckgoUrls] = await Promise.all([
      searchWikipedia(query),
      searchDuckDuckGo(query)
    ]);

    // Combine and deduplicate URLs
    const allUrls = [...new Set([...wikipediaUrls, ...duckduckgoUrls])];
    const urlsToOpen = allUrls.slice(0, MAX_PAGES_PER_SEARCH);

    console.log(`[EdgeAI] Found ${allUrls.length} URLs, opening top ${urlsToOpen.length}`);

    // Open pages in background and extract content
    const extractionPromises = urlsToOpen.map(url =>
      openAndExtractContent(url, searchId)
    );

    const results = await Promise.allSettled(extractionPromises);

    // Process results
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        searchResults.sources.push(result.value);
      } else {
        console.warn(`[EdgeAI] Failed to extract from ${urlsToOpen[index]}:`, result.reason);
      }
    });

    searchResults.status = 'completed';
    searchResults.completedAt = Date.now();

    // Store results
    await storeResults(searchId, searchResults);

    console.log(`[EdgeAI] Search completed with ${searchResults.sources.length} sources`);

    return {
      success: true,
      searchId,
      resultCount: searchResults.sources.length,
      results: searchResults
    };

  } catch (error) {
    console.error('[EdgeAI] Search error:', error);
    return {
      success: false,
      searchId,
      error: error.message
    };
  }
}

/**
 * Search Wikipedia for relevant articles
 */
async function searchWikipedia(query) {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&format=json&origin=*`;

    const response = await fetch(searchUrl);
    const data = await response.json();

    // OpenSearch returns: [query, [titles], [descriptions], [urls]]
    const urls = data[3] || [];

    console.log(`[EdgeAI] Wikipedia found ${urls.length} results`);
    return urls;
  } catch (error) {
    console.error('[EdgeAI] Wikipedia search error:', error);
    return [];
  }
}

/**
 * Search DuckDuckGo Lite for relevant pages
 */
async function searchDuckDuckGo(query) {
  try {
    // Use DuckDuckGo Lite HTML version for easier parsing
    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

    console.log(`[EdgeAI] Fetching DuckDuckGo: ${searchUrl}`);
    const response = await fetch(searchUrl);

    if (!response.ok) {
      console.error(`[EdgeAI] DuckDuckGo fetch failed: ${response.status} ${response.statusText}`);
      return [];
    }

    const html = await response.text();
    console.log(`[EdgeAI] DuckDuckGo HTML length: ${html.length} chars`);

    // Debug: Log first 500 chars to see structure
    console.log('[EdgeAI] DuckDuckGo HTML preview:', html.substring(0, 500));

    // Parse HTML to extract result URLs
    const urls = extractUrlsFromDDGLite(html);

    console.log(`[EdgeAI] DuckDuckGo found ${urls.length} results:`, urls);
    return urls.slice(0, 3);
  } catch (error) {
    console.error('[EdgeAI] DuckDuckGo search error:', error);
    return [];
  }
}

/**
 * Extract URLs from DuckDuckGo Lite HTML
 */
function extractUrlsFromDDGLite(html) {
  const urls = [];

  // DuckDuckGo Lite uses a different structure - look for the result links
  // They appear to use //duckduckgo.com/l/?uddg= format which needs to be decoded

  // First, try to find uddg= encoded URLs (DuckDuckGo's redirect links)
  const uddgRegex = /uddg=([^&"']+)/gi;
  let match;

  while ((match = uddgRegex.exec(html)) !== null) {
    try {
      const decodedUrl = decodeURIComponent(match[1]);
      console.log('[EdgeAI] Found uddg URL:', decodedUrl);

      if (decodedUrl.startsWith('http') &&
          !decodedUrl.includes('duckduckgo.com')) {
        urls.push(decodedUrl);
      }
    } catch (e) {
      console.warn('[EdgeAI] Failed to decode URL:', match[1]);
    }
  }

  // If no uddg URLs found, try direct links
  if (urls.length === 0) {
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;

    while ((match = linkRegex.exec(html)) !== null) {
      let url = match[1];

      // Decode HTML entities
      url = url.replace(/&amp;/g, '&')
             .replace(/&quot;/g, '"')
             .replace(/&#39;/g, "'");

      // Skip DuckDuckGo internal links and relative URLs
      if (url.startsWith('http') &&
          !url.includes('duckduckgo.com') &&
          !url.includes('/?q=') &&
          !url.includes('/lite/')) {
        urls.push(url);
      }
    }
  }

  // Remove duplicates
  const uniqueUrls = [...new Set(urls)];
  console.log('[EdgeAI] Extracted unique URLs:', uniqueUrls);

  return uniqueUrls;
}

/**
 * Open URL in background tab and extract content
 */
async function openAndExtractContent(url, searchId) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`[EdgeAI] Opening ${url}`);

      // Create background tab
      const tab = await chrome.tabs.create({
        url: url,
        active: false // Open in background
      });

      // Set timeout for extraction
      const timeout = setTimeout(() => {
        chrome.tabs.remove(tab.id);
        reject(new Error('Extraction timeout'));
      }, 30000); // 30 second timeout

      // Wait for page to load and content script to extract
      const checkInterval = setInterval(async () => {
        try {
          const results = await chrome.storage.local.get([`extract_${tab.id}`]);
          const extractedData = results[`extract_${tab.id}`];

          if (extractedData) {
            clearTimeout(timeout);
            clearInterval(checkInterval);

            // Clean up storage
            await chrome.storage.local.remove([`extract_${tab.id}`]);

            // Close tab
            chrome.tabs.remove(tab.id);

            resolve({
              url: url,
              title: extractedData.title,
              content: extractedData.content,
              extractedAt: Date.now(),
              wordCount: extractedData.wordCount
            });
          }
        } catch (error) {
          // Tab might have been closed
          clearTimeout(timeout);
          clearInterval(checkInterval);
          reject(error);
        }
      }, 1000); // Check every second

    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Handle extracted content from content script
 */
function handleContentExtracted(data, tabId) {
  // Store in local storage for retrieval
  chrome.storage.local.set({
    [`extract_${tabId}`]: data
  });
}

/**
 * Store search results
 */
async function storeResults(searchId, results) {
  const key = `${STORAGE_KEY}_${searchId}`;
  await chrome.storage.local.set({ [key]: results });

  // Also update active searches
  activeSearches.set(searchId, results);
}

/**
 * Retrieve stored results
 */
async function getStoredResults(searchId) {
  const key = `${STORAGE_KEY}_${searchId}`;
  const results = await chrome.storage.local.get([key]);
  return results[key] || null;
}

// Clean up old results (older than 1 hour)
setInterval(async () => {
  const allKeys = await chrome.storage.local.get(null);
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  Object.keys(allKeys).forEach(async (key) => {
    if (key.startsWith(STORAGE_KEY)) {
      const data = allKeys[key];
      if (data.timestamp && (now - data.timestamp) > oneHour) {
        await chrome.storage.local.remove([key]);
      }
    }
  });
}, 5 * 60 * 1000); // Run every 5 minutes

// ============================================================================
// UPDATE CHECKER
// ============================================================================

const UPDATE_API_URL = 'https://extupdater.inled.es/api/updates.json';
const UPDATE_CHECK_INTERVAL = 600000; // 600 seconds
const EXTENSION_ID_MATCH = 'edgeai-v2'; // Keyword to match in update ID
let lastNotifiedUpdateId = null;

async function checkForUpdates() {
  try {
    console.log('[EdgeAI Updater] Checking for updates...');
    
    const response = await fetch(UPDATE_API_URL);
    if (!response.ok) {
      console.warn('[EdgeAI Updater] API response not OK:', response.status);
      return;
    }

    const updates = await response.json();
    console.log('[EdgeAI Updater] Updates received:', updates);
    
    // Find matching update
    // Format: [{ "id": "edgeai-v1.2", "url": "..." }]
    const match = updates.find(update => 
      update.id && update.id.toLowerCase().includes(EXTENSION_ID_MATCH)
    );

    if (match) {
      console.log('[EdgeAI Updater] Found matching update:', match);

      // Check if we already notified about this specific version ID
      // DEBUG: Removing check to force notification for testing
      // if (match.id !== lastNotifiedUpdateId) {
        console.log('[EdgeAI Updater] 🚀 New update found:', match.id);
        
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon.png',
          title: 'Edge.AI Update Available',
          message: `A new version is available: ${match.id}. Click to download.`,
          priority: 2,
          requireInteraction: true
        }, (notificationId) => {
          if (chrome.runtime.lastError) {
            console.error('[EdgeAI Updater] Notification error:', chrome.runtime.lastError);
          } else {
            console.log('[EdgeAI Updater] Notification created ID:', notificationId);
          }
        });

        // Update state to avoid spamming (Re-enable this later)
        lastNotifiedUpdateId = match.id;
        
        // Save URL to storage for popup or click handler
        chrome.storage.local.set({ 
          pendingUpdate: {
            id: match.id,
            url: match.url,
            detectedAt: Date.now()
          }
        });
      // }
    } else {
      console.log('[EdgeAI Updater] No matching updates found.');
    }
  } catch (error) {
    console.error('[EdgeAI Updater] Check failed:', error);
  }
}

// Handle notification click
chrome.notifications.onClicked.addListener(async () => {
  const data = await chrome.storage.local.get(['pendingUpdate']);
  if (data.pendingUpdate && data.pendingUpdate.url) {
    chrome.tabs.create({ url: data.pendingUpdate.url });
  }
});

// Start checking
setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
checkForUpdates(); // Initial check

console.log('[EdgeAI] Background service worker initialized');
