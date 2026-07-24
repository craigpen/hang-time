/**
 * Hang Time - Netflix Content Script
 * Extracts the currently watching title from Netflix pages
 */

// Title cache - keeps most recent extracted title
let cachedTitle: string | null = null;
let cacheTimestamp: number = 0;

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_NETFLIX_TITLE') {
    // Return cached title if recent (within 30 seconds)
    if (cachedTitle && Date.now() - cacheTimestamp < 30000) {
      console.debug('[Netflix Content] Returning cached title:', cachedTitle);
      sendResponse({ success: true, data: cachedTitle });
      return;
    }

    // Fall back to request-time search if cache is stale
    const title = extractNetflixTitle();
    if (title) {
      cachedTitle = title;
      cacheTimestamp = Date.now();
    }
    sendResponse({ success: true, data: title });
  }
});

/**
 * Try to extract title from the Netflix player iframe
 */
function extractTitleFromPlayerIframe(): string | null {
  try {
    const iframe = document.querySelector('iframe');
    if (!iframe || !iframe.contentWindow) {
      return null;
    }

    const iframeDoc = iframe.contentWindow.document;
    if (!iframeDoc) {
      return null;
    }

    // Search for title in iframe
    // Look for h4 tags (Netflix uses these for titles in player)
    const h4Elements = iframeDoc.querySelectorAll('h4');
    for (const h4 of h4Elements) {
      const text = h4.textContent?.trim();
      if (text && text.length > 2 && text.length < 200) {
        console.debug('[Netflix Content] Found h4 in iframe:', text);
        return text;
      }
    }

    // Try data-uia attribute in iframe
    const videoTitleDivs = iframeDoc.querySelectorAll("[data-uia='video-title']");
    for (const div of videoTitleDivs) {
      const text = div.textContent?.trim();
      if (text && text.length > 2 && text.length < 200) {
        console.debug('[Netflix Content] Found video-title in iframe:', text);
        return text;
      }
    }

    // Search for any heading elements in iframe
    const headings = iframeDoc.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const heading of headings) {
      const text = heading.textContent?.trim();
      if (text && text.length > 2 && text.length < 200 && !text.toLowerCase().includes('netflix')) {
        console.debug('[Netflix Content] Found heading in iframe:', text);
        return text;
      }
    }

    return null;
  } catch (error) {
    console.debug('[Netflix Content] Error accessing iframe:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Extract the Netflix show/movie title from the page
 */
function extractNetflixTitle(): string | null {
  try {
    // Method 0: Try to access the player iframe
    const playerTitle = extractTitleFromPlayerIframe();
    if (playerTitle) {
      console.debug('[Netflix Content] Found in player iframe:', playerTitle);
      return playerTitle;
    }

    // Method 1: Use Netflix's data-uia attribute (most reliable)
    // Netflix marks the video title with data-uia='video-title'
    const titleElements = document.querySelectorAll("[data-uia='video-title']");
    for (const titleElement of titleElements) {
      let fullText = titleElement.textContent?.trim() || '';

      if (!fullText || fullText.length === 0) continue;

      console.debug('[Netflix Content] Raw text from element:', fullText);

      // Split by common Netflix metadata to extract just the title
      // Netflix format: "Title Rated PG-13 Audio description available" or "Title S01E01"
      // Split by known metadata keywords and take the first segment as title
      const parts = fullText.split(/\s+(?=Rated|Audio|Subtitles|CC|Closed|Available|IMDb|\d+%)/i);
      let title = parts[0].trim();

      // Filter out if the first part is metadata
      if (/^Rated|^PG|^R$|^NC-17|^G$|^TV-|^\d+%|^IMDb|^Audio|^Subtitles|^CC|^Closed|^Available/i.test(title)) {
        console.debug('[Netflix Content] First segment is metadata, skipping:', title);
        continue;
      }

      // Extract episode number if present: E01, S01E01, etc (with or without space)
      const episodeMatch = title.match(/\s*([SE]\d+(?:E\d+)?)\s*/i);
      const episode = episodeMatch ? episodeMatch[1] : null;

      // Take everything BEFORE the episode as the title
      if (episode) {
        title = title.substring(0, episodeMatch.index).trim();
      }

      // Remove any trailing duplicate of the first word
      const titleWords = title.split(/\s+/);
      if (titleWords.length > 1) {
        const firstWord = titleWords[0].toLowerCase();
        while (titleWords.length > 1 && titleWords[titleWords.length - 1].toLowerCase() === firstWord) {
          titleWords.pop();
        }
        title = titleWords.join(' ');
      }

      title = title.trim();

      if (title && title.length > 2) {
        const result = episode ? `${title} ${episode}` : title;
        console.debug('[Netflix Content] Extracted title:', result);
        return result;
      }
    }

    // Method 2: Search for title in any visible text elements (fallback)
    // Netflix renders the title in the page UI
    const titleSelectors = [
      // Player controls area
      '[class*="player-title"]',
      '[class*="PlayerTitle"]',
      '[class*="video-title"]',
      // Content info area
      '[class*="content-title"]',
      '[class*="ContentTitle"]',
      // Generic heading elements
      'h1:not([class*="logo"])',
      // Data test IDs Netflix uses
      '[data-testid*="title"]',
      '[data-testid="player-title"]',
      // Netflix sometimes puts it in specific divs
      'div[class*="Title"]',
    ];

    for (const selector of titleSelectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent?.trim();
          if (text && text.length > 3 && text.length < 300 && text !== 'Netflix') {
            console.debug('[Netflix Content] Found title via selector:', selector, '=', text);
            return text;
          }
        }
      } catch {
        // Continue to next selector
      }
    }

    // Method 2: Search all text nodes for likely titles
    // This is slower but can find titles in nested elements
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let node;
    const candidates: string[] = [];
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim();
      if (text && text.length > 5 && text.length < 200 && !text.includes('\n')) {
        // Skip common UI text
        if (
          !text.toLowerCase().includes('netflix') &&
          !text.includes('$') &&
          !text.includes('%') &&
          !text.includes('page') &&
          !text.includes('play') &&
          !text.includes('volume') &&
          !text.includes('fullscreen') &&
          !text.match(/^\d+%$/)
        ) {
          candidates.push(text);
        }
      }
    }

    // Return the first reasonable candidate (usually the title)
    if (candidates.length > 0) {
      console.debug('[Netflix Content] Found via text search:', candidates[0]);
      return candidates[0];
    }

    // Method 3: Try getting from window.netflix if available
    if ((window as any).netflix?.reactContext?.pageProps?.currentContent?.title) {
      const title = (window as any).netflix.reactContext.pageProps.currentContent.title;
      console.debug('[Netflix Content] Found in window.netflix:', title);
      return title;
    }

    console.debug('[Netflix Content] Could not extract title');
    return null;
  } catch (error) {
    console.error('[Netflix Content] Error extracting title:', error);
    return null;
  }
}

/**
 * Set up MutationObserver to proactively cache Netflix titles
 * Watches for title elements and updates cache whenever they appear
 */
function setupTitleCache(): void {
  try {
    const iframe = document.querySelector('iframe');
    if (!iframe || !iframe.contentWindow) {
      console.debug('[Netflix Content] No iframe found for MutationObserver');
      return;
    }

    const iframeDoc = iframe.contentWindow.document;
    const observer = new MutationObserver(() => {
      // When DOM changes, try to extract and cache the title
      const title = extractNetflixTitle();
      if (title && title !== cachedTitle) {
        cachedTitle = title;
        cacheTimestamp = Date.now();
        console.debug('[Netflix Content] Cache updated via MutationObserver:', title);
      }
    });

    // Watch for any DOM changes in the iframe
    observer.observe(iframeDoc.body || iframeDoc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    console.debug('[Netflix Content] MutationObserver active - watching for title changes');
  } catch (error) {
    console.debug('[Netflix Content] Could not set up MutationObserver:', error instanceof Error ? error.message : String(error));
  }
}

// Start caching titles when script loads
setupTitleCache();
