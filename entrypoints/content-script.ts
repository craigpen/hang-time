/**
 * Hang Time - Generic Video Content Script
 * Detects any <video> element on any platform
 * Works with YouTube, Netflix, Twitch, and potentially any video site
 */

console.log('[ContentScript] Script loaded at:', window.location.href);

import { generateActivityId } from '../src/modules/activity-utils';

class GenericVideoTracker {
  private activeVideoElement: HTMLVideoElement | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private domObserver: MutationObserver | null = null;
  private eventListeners: Map<string, (evt: Event) => void> = new Map();
  private lastReportedTime: number = 0;
  private lastReportTimestamp: number = 0; // Rate limit duplicate reports
  private videoSearchTimeout: NodeJS.Timeout | null = null; // Debounce video search

  constructor() {
    console.log('[ContentScript] ✅ Generic video tracker initialized');
  }

  init(): void {
    // Set up DOM observer to find video elements
    this._setupDOMObserver();

    // Initial lookup for existing video elements
    this._findAndHookVideo();
  }

  private _setupDOMObserver(): void {
    // Watch the DOM for any injected <video> elements
    this.domObserver = new MutationObserver(() => {
      if (!this._isContextValid()) {
        this._cleanup();
        return;
      }

      // Debounce video search (max once per 500ms) to avoid repeated hooks
      if (this.videoSearchTimeout) {
        clearTimeout(this.videoSearchTimeout);
      }
      this.videoSearchTimeout = setTimeout(() => {
        this._findAndHookVideo();
        this.videoSearchTimeout = null;
      }, 500);
    });

    this.domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    console.log('[ContentScript] 📹 DOM observer started, watching for video elements');
  }

  private _findAndHookVideo(): void {
    // Find all video elements on the page
    const videoElements = Array.from(document.querySelectorAll('video'));

    if (videoElements.length === 0) {
      return; // No videos found
    }

    // Filter videos: prioritize by visibility, then by duration (skip ads < 60s)
    const visibleVideos = videoElements.filter((v) => v.offsetWidth > 0 && v.offsetHeight > 0);

    // Prefer videos with known duration > 60 seconds (skip ads)
    const mainContentVideos = visibleVideos.filter((v) => v.duration > 0 && v.duration >= 60);

    // Priority order:
    // 1. Main content video (visible, duration >= 60s)
    // 2. Fallback to any visible video (duration might not be loaded yet)
    // 3. Fallback to first video (worst case)
    const currentVideo = mainContentVideos[0] || visibleVideos[0] || videoElements[0];

    if (!currentVideo || currentVideo === this.activeVideoElement) {
      return; // Same video or none found
    }

    // Switched to a new video element - clean up old listeners
    if (this.activeVideoElement) {
      this._removeVideoListeners();
    }

    this.activeVideoElement = currentVideo;
    console.log('[ContentScript] 🎬 Video element detected and hooked');

    // Attach event listeners to video element
    const playHandler = () => this._sendPlaybackUpdate();
    const pauseHandler = () => {
      // Only send pause update if tab is in foreground (user explicitly paused)
      // Ignore pause events when backgrounded (browser-initiated pauses)
      if (!document.hidden) {
        this._sendPlaybackUpdate();
      }
    };
    const emptiedHandler = () => this._onVideoEmptied();

    this.activeVideoElement.addEventListener('play', playHandler);
    this.activeVideoElement.addEventListener('pause', pauseHandler);
    this.activeVideoElement.addEventListener('emptied', emptiedHandler);

    // Store handlers for cleanup
    this.eventListeners.set('play', playHandler);
    this.eventListeners.set('pause', pauseHandler);
    this.eventListeners.set('emptied', emptiedHandler);

    // Initial report for the currently loaded video
    this._sendPlaybackUpdate();

    // Set up polling for position updates while playing (efficient, only while playing)
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.pollingInterval = setInterval(() => {
      if (
        this.activeVideoElement &&
        !this.activeVideoElement.paused &&
        this._isContextValid()
      ) {
        this._sendPlaybackUpdate();
      }
    }, 2000);
  }

  private _removeVideoListeners(): void {
    if (!this.activeVideoElement) return;

    // Remove all attached listeners
    for (const [eventName, handler] of this.eventListeners) {
      this.activeVideoElement.removeEventListener(eventName, handler);
    }
    this.eventListeners.clear();

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    console.log('[ContentScript] ✓ Video listeners removed');
  }

  private _onVideoEmptied(): void {
    console.log('[ContentScript] Video emptied - ready to hook new video');
    this._removeVideoListeners();
    this.activeVideoElement = null;

    // Check for new video on next DOM update
    setTimeout(() => this._findAndHookVideo(), 100);
  }

  private _sendPlaybackUpdate(): void {
    if (!this._isContextValid()) {
      this._cleanup();
      return;
    }

    if (!this.activeVideoElement) {
      return;
    }

    // Get video metadata
    const title = this._getVideoTitle();
    const favicon = this._getFavicon();
    const domain = window.location.hostname;
    const url = window.location.href;
    const duration = Math.floor(this.activeVideoElement.duration || 0);
    const currentTime = Math.floor(this.activeVideoElement.currentTime || 0);
    const isPaused = this.activeVideoElement.paused;

    // Skip ads: if duration is known and < 60 seconds, this is likely an ad
    // Unhook from it and look for the next video
    if (duration > 0 && duration < 60) {
      console.debug('[ContentScript] Detected ad video (duration < 60s), unhoking and searching for main content:', {
        title,
        duration,
      });
      this._removeVideoListeners();
      this.activeVideoElement = null;
      // Search for the next video immediately
      setTimeout(() => this._findAndHookVideo(), 100);
      return;
    }

    // Rate limit position updates (max 1 per second), but allow state changes immediately
    const now = Date.now();
    const positionChanged = Math.abs(currentTime - this.lastReportedTime) >= 2;
    const timeSinceLastReport = now - this.lastReportTimestamp;

    // Skip if: same position, still playing, and reported recently
    if (!positionChanged && !isPaused && timeSinceLastReport < 1000) {
      return;
    }

    this.lastReportTimestamp = now;
    this.lastReportedTime = currentTime;

    // Skip Twitch homepage and non-stream pages (only report actual streams)
    if (url.includes('twitch.tv')) {
      const pathname = new URL(url).pathname;
      if (pathname === '/' || pathname === '' || pathname.startsWith('/search') || pathname.startsWith('/directory')) {
        console.debug('[ContentScript] Skipping Twitch non-stream page:', url);
        return;
      }
    }

    // Generate stable activity ID based on URL (same video = same ID)
    const activityId = generateActivityId('video-tab', url);

    const activity = {
      id: activityId,
      service: 'video-tab',
      content: title,
      state: isPaused ? 'paused' : 'playing',
      audio: 'on',
      timestamp: Date.now(),
      url: url,
      metadata: {
        duration,
        progress: currentTime,
        domain,
        favicon,
      },
    };

    // Send via port if available
    if ((window as any).hangTimePort) {
      try {
        (window as any).hangTimePort.postMessage({
          type: 'CONTENT_SCRIPT_ACTIVITY',
          data: {
            key: 'content_script_activity_video-tab',
            value: activity,
          },
        });
      } catch (err) {
        console.debug('[ContentScript] Port send failed:', err);
      }
    } else {
      console.warn('[ContentScript] ⚠️  Port not available for sending activity');
    }
  }

  private _getVideoTitle(): string {
    // Netflix needs special handling to extract title from DOM
    if (window.location.hostname.includes('netflix.com')) {
      return this._getNetflixTitle() || 'Netflix Video';
    }

    // For other platforms, use document.title
    let title = document.title;

    // Strip common platform branding
    title = title
      .replace(/ - YouTube$/, '')
      .replace(/ \| Netflix$/, '')
      .replace(/ on Twitch$/, '')
      .replace(/^▶ /, '');

    return title.trim() || 'Video';
  }

  private _getNetflixTitle(): string | null {
    try {
      // Try h2 tags first (React renders title here)
      const h2Elements = document.querySelectorAll('h2');
      for (const h2 of h2Elements) {
        const text = h2.textContent?.trim();
        if (text && this._isValidNetflixTitle(text)) {
          return text;
        }
      }

      // Fallback to data-uia attribute
      const titleElements = document.querySelectorAll("[data-uia='video-title']");
      for (const titleElement of titleElements) {
        const fullText = titleElement.textContent?.trim() || '';
        if (!fullText) continue;

        // Parse episode info from the text
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
          if (this._isValidNetflixTitle(result)) {
            return result;
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private _isValidNetflixTitle(title: string | null | undefined): boolean {
    if (!title || typeof title !== 'string') return false;
    if (title.length < 2 || title.length > 200) return false;

    const lower = title.toLowerCase();

    // Contamination checks
    if (title.includes('•')) return false;
    if (title.includes('invited you to')) return false;
    if (/[\x00-\x1F\x7F]/.test(title)) return false;

    if (lower.includes('error') || lower.includes('failed')) return false;

    // UI elements that aren't titles
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

  private _getFavicon(): string {
    // Try multiple favicon selectors in order of preference
    const selectors = [
      'link[rel="icon"][type="image/png"]',
      'link[rel="icon"][type="image/x-icon"]',
      'link[rel="icon"]',
      'link[rel="shortcut icon"]',
      'link[rel="apple-touch-icon"]',
      'link[rel="apple-touch-icon-precomposed"]',
    ];

    for (const selector of selectors) {
      const favicon = document.querySelector(selector);
      if (favicon && favicon.hasAttribute('href')) {
        const href = favicon.getAttribute('href') || '';
        if (href) {
          return href;
        }
      }
    }

    return '/favicon.ico';
  }


  private _isContextValid(): boolean {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  private _cleanup(): void {
    console.log('[ContentScript] 🧹 Cleaning up video tracker');

    // Disconnect DOM observer
    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = null;
    }

    // Remove video listeners
    this._removeVideoListeners();

    // Clear active video reference
    this.activeVideoElement = null;

    console.log('[ContentScript] ✅ Cleanup complete');
    (window as any).hangTimeExtensionLoaded = false;
  }
}

// ============================================================================
// GLOBAL INITIALIZATION
// ============================================================================

let globalMonitorInterval: NodeJS.Timeout | null = null;

function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// Handle duplicate injections from orphaned scripts
console.log('[ContentScript] Global flag at load:', !!(window as any).hangTimeExtensionLoaded);
if ((window as any).hangTimeExtensionLoaded) {
  console.log('[ContentScript] Old instance detected, dispatching cleanup');
  window.dispatchEvent(new CustomEvent('CLEANUP_VIDEO_TRACKER'));
} else {
  console.log('[ContentScript] Fresh instance, setting flag');
  (window as any).hangTimeExtensionLoaded = true;
}

// Cleanup signal for orphaned scripts
window.addEventListener('CLEANUP_VIDEO_TRACKER', () => {
  console.log('[ContentScript] Cleanup event RECEIVED');
  if (globalMonitorInterval) {
    clearInterval(globalMonitorInterval);
    globalMonitorInterval = null;
  }
  (window as any).hangTimeExtensionLoaded = false;
});

// Only initialize if context is valid (fresh injection)
if (isContextValid()) {
  console.log('[ContentScript] 🚀 Initializing generic video tracker');

  // Connect to background service worker
  const port = chrome.runtime.connect({
    name: 'content-script-video-tab',
  });

  (window as any).hangTimePort = port;

  port.onDisconnect.addListener(() => {
    console.warn('[ContentScript] Port disconnected');
    (window as any).hangTimePort = null;
  });

  // Start monitoring
  const tracker = new GenericVideoTracker();
  tracker.init();

  // Monitor context validity - cleanup if it becomes invalid
  globalMonitorInterval = setInterval(() => {
    if (!isContextValid()) {
      console.error('[ContentScript] Extension context lost—orphaned script detected');
      (window as any).hangTimeExtensionLoaded = false;

      // Background will detect this via _checkForOrphanedActivity() periodic check
      // Don't try to send message - extension context is already invalid
      if (globalMonitorInterval) {
        clearInterval(globalMonitorInterval);
        globalMonitorInterval = null;
      }
    }
  }, 5000);
} else {
  console.warn('[ContentScript] Extension context invalid, skipping initialization');
}
