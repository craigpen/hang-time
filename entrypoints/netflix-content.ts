/**
 * Hang Time - Netflix Content Script
 * Waits for React to render title, then extracts and stores in chrome.storage.local
 */

const STORAGE_KEY = 'netflix_title';

function isValidTitle(title: string | null | undefined): boolean {
  if (!title || typeof title !== 'string') return false;
  if (title.length < 2 || title.length > 300) return false;

  const lower = title.toLowerCase();

  if (lower.includes('error') || lower.includes('failed')) return false;

  if (
    title === 'Netflix' ||
    title === 'Loading' ||
    title === '' ||
    lower === 'play' ||
    lower === 'pause' ||
    lower === 'skip' ||
    lower === 'replay'
  ) {
    return false;
  }

  if (
    lower.includes('audio description') ||
    lower.includes('closed captions') ||
    lower.includes('subtitles') ||
    lower.includes('cc available') ||
    lower.includes('dubbed') ||
    lower.includes('original audio') ||
    lower.includes('volume') ||
    lower.includes('fullscreen') ||
    lower.includes('settings') ||
    lower.includes('next episode') ||
    lower.includes('previous episode') ||
    lower.includes('privacy') ||
    lower.includes('preference') ||
    lower.includes('modal') ||
    lower.includes('dialog')
  ) {
    return false;
  }

  return true;
}

async function writeValidTitle(title: string | null): Promise<void> {
  try {
    if (isValidTitle(title)) {
      await chrome.storage.local.set({ [STORAGE_KEY]: title });
    }
  } catch (error) {
    console.error('[NetflixContent] Failed to write title to storage:', error instanceof Error ? error.message : error);
    // Extension context invalidated - will reconnect automatically
  }
}

async function getStoredTitle(): Promise<string | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY];
    if (isValidTitle(stored)) {
      return stored;
    }
    return null;
  } catch (error) {
    console.error('[NetflixContent] Failed to read title from storage:', error instanceof Error ? error.message : error);
    // Extension context invalidated - will reconnect automatically
    return null;
  }
}

function extractNetflixTitle(): string | null {
  try {
    // Look for h2 tags (Netflix renders title here after React hydration)
    const h2Elements = document.querySelectorAll('h2');
    for (const h2 of h2Elements) {
      const text = h2.textContent?.trim();
      if (text && isValidTitle(text)) {
        return text;
      }
    }

    // Fallback to data-uia attribute if h2 not found
    const titleElements = document.querySelectorAll("[data-uia='video-title']");
    for (const titleElement of titleElements) {
      const fullText = titleElement.textContent?.trim() || '';
      if (!fullText) continue;

      const parts = fullText.split(/\s+(?=Rated|Audio|Subtitles|CC|Closed|Available|IMDb|\d+%)/i);
      let title = parts[0].trim();

      if (/^Rated|^PG|^R$|^NC-17|^G$|^TV-|^\d+%|^IMDb|^Audio|^Subtitles|^CC|^Closed|^Available/i.test(title)) {
        continue;
      }

      const episodeMatch = title.match(/\s*([SE]\d+(?:E\d+)?)\s*/i);
      const episode = episodeMatch ? episodeMatch[1] : null;

      if (episode) {
        title = title.substring(0, episodeMatch.index).trim();
      }

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
        if (isValidTitle(result)) {
          return result;
        }
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

function getNetflixVideoPosition(): { currentTime?: number; duration?: number } {
  try {
    const video = document.querySelector('video') as HTMLVideoElement;
    if (video) {
      return {
        currentTime: Math.floor(video.currentTime),
        duration: Math.floor(video.duration),
      };
    }
  } catch (error) {
    console.debug('[Netflix Content] Could not get video position:', error);
  }
  return {};
}

// Persistent port connection (survives extension reload)
let port: chrome.runtime.Port | null = null;

function connectToExtension(): void {
  try {
    port = chrome.runtime.connect({ name: 'netflix-content' });
    console.log('[NetflixContent] ✅ Connected to extension');

    port.onMessage.addListener((message: any) => {
      if (message.type === 'GET_NETFLIX_TITLE') {
        console.debug('[NetflixContent] Received GET_NETFLIX_TITLE query');
        (async () => {
          try {
            const freshTitle = extractNetflixTitle();
            if (isValidTitle(freshTitle)) {
              await writeValidTitle(freshTitle);
              console.debug(`[NetflixContent] Responding with fresh title: "${freshTitle}"`);
              port?.postMessage({ type: 'GET_NETFLIX_TITLE', success: true, data: freshTitle });
            } else {
              const storedTitle = await getStoredTitle();
              console.debug(`[NetflixContent] Fresh title invalid, using stored: "${storedTitle}"`);
              port?.postMessage({ type: 'GET_NETFLIX_TITLE', success: true, data: storedTitle });
            }
          } catch (error) {
            const storedTitle = await getStoredTitle();
            console.debug(`[NetflixContent] Error extracting, using stored: "${storedTitle}"`);
            port?.postMessage({ type: 'GET_NETFLIX_TITLE', success: true, data: storedTitle });
          }
        })();
      }
    });

    port.onDisconnect.addListener(() => {
      console.warn('[NetflixContent] ⚠️  Disconnected from extension (extension reload?), attempting reconnect in 1s...');
      port = null;
      setTimeout(() => connectToExtension(), 1000);
    });
  } catch (error) {
    console.error('[NetflixContent] ❌ Failed to connect to extension:', error);
    console.log('[NetflixContent] Retrying connection in 1s...');
    setTimeout(() => connectToExtension(), 1000);
  }
}

// Establish initial connection
connectToExtension();

// onMessage listener for TabService queries (chrome.tabs.sendMessage)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_NETFLIX_TITLE') {
    (async () => {
      try {
        const freshTitle = extractNetflixTitle();
        if (isValidTitle(freshTitle)) {
          await writeValidTitle(freshTitle);
          sendResponse({ success: true, data: freshTitle });
        } else {
          const storedTitle = await getStoredTitle();
          sendResponse({ success: true, data: storedTitle });
        }
      } catch (error) {
        const storedTitle = await getStoredTitle();
        sendResponse({ success: true, data: storedTitle });
      }
    })();
    return true;
  } else if (message.type === 'GET_VIDEO_STATE') {
    // Handle GET_VIDEO_STATE like video-sync does
    (async () => {
      try {
        const video = document.querySelector('video') as HTMLVideoElement;
        if (video) {
          sendResponse({
            success: true,
            data: {
              videoId: null, // Netflix doesn't expose video ID easily
              currentTime: video.currentTime,
              duration: video.duration,
              isPlaying: !video.paused,
            },
          });
        } else {
          sendResponse({ success: true, data: { currentTime: 0, duration: 0, isPlaying: false } });
        }
      } catch (error) {
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    })();
    return true;
  } else if (message.type === 'GET_VIDEO_POSITION') {
    const videoData = getNetflixVideoPosition();
    sendResponse({ success: true, data: videoData });
    return false;
  }
});

// Watch for h2 elements being added to DOM (React rendering title)
function watchForTitle(): void {
  const observer = new MutationObserver(async (mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' || mutation.type === 'characterData') {
        // Check if h2 now exists
        const h2 = document.querySelector('h2');
        if (h2) {
          const text = h2.textContent?.trim();
          if (isValidTitle(text)) {
            const storedTitle = await getStoredTitle();
            // Only write if different from what's stored
            if (text !== storedTitle) {
              await writeValidTitle(text);
            }
          }
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

// Start watching for title
watchForTitle();

// Debug: expose extraction via console for manual testing
(window as any).__netflixDebug = {
  extractTitle: () => extractNetflixTitle(),
  getStored: async () => {
    const result = await chrome.storage.local.get('netflix_title');
    return result.netflix_title || null;
  },
  clearStorage: async () => {
    await chrome.storage.local.remove('netflix_title');
    console.log('[Netflix Content] Cleared stored title');
  },
};
