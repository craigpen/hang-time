(function() {
  console.log('[ContentScript] >>>>>> SCRIPT EXECUTING AT:', window.location.href, 'time:', new Date().toISOString());
})();

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

    // Prioritize visible videos over hidden ones (handles ads, previews)
    const currentVideo =
      videoElements.find((v) => v.offsetWidth > 0 && v.offsetHeight > 0) ||
      videoElements[0];

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
    const pauseHandler = () => this._sendPlaybackUpdate();
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

    // Filter out ads and very short videos (typically < 60 seconds)
    if (duration > 0 && duration < 60) {
      console.debug('[ContentScript] Skipping short video (likely ad):', {
        title,
        duration,
      });
      return;
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
        console.log(
          `[ContentScript] ✅ Sent activity: ${title} (${currentTime}/${duration}s) favicon: ${favicon}`,
          {
            metadata: activity.metadata,
            hasDuration: activity.metadata?.duration !== undefined,
            hasProgress: activity.metadata?.progress !== undefined,
            hasFavicon: activity.metadata?.favicon !== undefined,
          }
        );
      } catch (err) {
        console.debug('[ContentScript] Port send failed:', err);
      }
    } else {
      console.warn('[ContentScript] ⚠️  Port not available for sending activity');
    }
  }

  private _getVideoTitle(): string {
    // Try to get a meaningful title from the page
    let title = document.title;

    // Strip common platform branding
    title = title
      .replace(/ - YouTube$/, '')
      .replace(/ \| Netflix$/, '')
      .replace(/ on Twitch$/, '')
      .replace(/^▶ /, '');

    return title.trim() || 'Video';
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
          console.debug('[ContentScript] Found favicon:', href);
          return href;
        }
      }
    }

    // Fallback to common favicon location
    console.debug('[ContentScript] Using fallback favicon: /favicon.ico');
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

      // Notify background that this script is going orphaned via sendMessage (more reliable than port)
      try {
        chrome.runtime.sendMessage(
          {
            type: 'CONTENT_SCRIPT_ORPHANED',
            data: {
              service: 'video-tab',
              timestamp: Date.now(),
            },
          },
          () => {
            // Ignore response - this is fire-and-forget
          }
        );
      } catch (err) {
        console.debug('[ContentScript] Failed to notify background of orphaned state:', err);
      }

      if (globalMonitorInterval) {
        clearInterval(globalMonitorInterval);
        globalMonitorInterval = null;
      }
    }
  }, 5000);
} else {
  console.warn('[ContentScript] Extension context invalid, skipping initialization');
}
