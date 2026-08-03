/**
 * Hang Time - Generic Video Content Script with Lifecycle Management
 * Detects any <video> element on any platform with automatic recovery on extension reload
 * Works with YouTube, Netflix, Twitch, and potentially any video site
 */

import { generateActivityId } from '../src/modules/activity-utils';

// Unique lifecycle event token for this script version
const LIFECYCLE_EVENT_TOKEN = 'HANG_TIME_CONTENT_SCRIPT_LIFECYCLE_V1';
const GLOBAL_FLAG_KEY = 'HANG_TIME_SCRIPT_ACTIVE_V1';

// IIFE wrapper for complete isolation and lifecycle management
(() => {
  console.log('[ContentScript] Script loaded at:', window.location.href);

  // Check if a previous instance is already active
  if ((window as any)[GLOBAL_FLAG_KEY]) {
    console.log('[ContentScript] Previous instance detected, signaling old instance to self-destruct');
    window.dispatchEvent(new CustomEvent(LIFECYCLE_EVENT_TOKEN));
    return; // Exit this initialization, let the old instance handle cleanup
  }

  // Mark this instance as active
  (window as any)[GLOBAL_FLAG_KEY] = true;

  // Tracker array: stores {element, eventName, handler} tuples for cleanup
  const trackedEventListeners: Array<{
    element: EventTarget;
    eventName: string;
    handler: EventListener;
  }> = [];

  // Port connection with reconnection logic
  let port: chrome.runtime.Port | null = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 10;
  const INITIAL_BACKOFF_MS = 500;
  let reconnectTimeoutId: NodeJS.Timeout | null = null;

  class GenericVideoTracker {
    private activeVideoElement: HTMLVideoElement | null = null;
    private pollingInterval: NodeJS.Timeout | null = null;
    private domObserver: MutationObserver | null = null;
    private eventListeners: Map<string, (evt: Event) => void> = new Map();
    private lastReportedTime: number = 0;
    private lastReportTimestamp: number = 0;
    private videoSearchTimeout: NodeJS.Timeout | null = null;
    private cachedNetflixTitle: string | null = null;

    constructor() {
      console.log('[ContentScript] ✅ Generic video tracker initialized');
    }

    init(): void {
      this._setupDOMObserver();
      this._findAndHookVideo();
    }

    private _setupDOMObserver(): void {
      this.domObserver = new MutationObserver(() => {
        if (!this._isContextValid()) {
          this._cleanup();
          return;
        }

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
      const videoElements = Array.from(document.querySelectorAll('video'));

      if (videoElements.length === 0) {
        return;
      }

      const visibleVideos = videoElements.filter((v) => v.offsetWidth > 0 && v.offsetHeight > 0);
      const mainContentVideos = visibleVideos.filter((v) => v.duration > 0 && v.duration >= 60);
      const currentVideo = mainContentVideos[0] || visibleVideos[0] || videoElements[0];

      if (!currentVideo || currentVideo === this.activeVideoElement) {
        return;
      }

      if (this.activeVideoElement) {
        this._removeVideoListeners();
        this.cachedNetflixTitle = null;
      }

      this.activeVideoElement = currentVideo;
      console.log('[ContentScript] 🎬 Video element detected and hooked');

      const playHandler = () => this._sendPlaybackUpdate();
      const pauseHandler = () => {
        if (!document.hidden) {
          this._sendPlaybackUpdate();
        }
      };
      const emptiedHandler = () => this._onVideoEmptied();

      this.activeVideoElement.addEventListener('play', playHandler);
      this.activeVideoElement.addEventListener('pause', pauseHandler);
      this.activeVideoElement.addEventListener('emptied', emptiedHandler);

      // Track all listeners for cleanup
      trackedEventListeners.push({
        element: this.activeVideoElement,
        eventName: 'play',
        handler: playHandler,
      });
      trackedEventListeners.push({
        element: this.activeVideoElement,
        eventName: 'pause',
        handler: pauseHandler,
      });
      trackedEventListeners.push({
        element: this.activeVideoElement,
        eventName: 'emptied',
        handler: emptiedHandler,
      });

      this.eventListeners.set('play', playHandler);
      this.eventListeners.set('pause', pauseHandler);
      this.eventListeners.set('emptied', emptiedHandler);

      this._sendPlaybackUpdate();

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
      this.cachedNetflixTitle = null;

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

      const title = this._getVideoTitle();
      const favicon = this._getFavicon();
      const domain = window.location.hostname;
      const url = window.location.href;
      const duration = Math.floor(this.activeVideoElement.duration || 0);
      const currentTime = Math.floor(this.activeVideoElement.currentTime || 0);
      const isPaused = this.activeVideoElement.paused;

      if (duration > 0 && duration < 60) {
        console.debug('[ContentScript] Detected ad video (duration < 60s), unhooking:', {
          title,
          duration,
        });
        this._removeVideoListeners();
        this.activeVideoElement = null;
        setTimeout(() => this._findAndHookVideo(), 100);
        return;
      }

      const now = Date.now();
      const positionChanged = Math.abs(currentTime - this.lastReportedTime) >= 2;
      const timeSinceLastReport = now - this.lastReportTimestamp;

      if (!positionChanged && !isPaused && timeSinceLastReport < 1000) {
        return;
      }

      this.lastReportTimestamp = now;
      this.lastReportedTime = currentTime;

      if (url.includes('youtube.com') || url.includes('youtu.be')) {
        if (!url.includes('watch?v=')) {
          console.debug('[ContentScript] Skipping YouTube non-watch page:', url);
          return;
        }
      }

      if (url.includes('twitch.tv')) {
        const pathname = new URL(url).pathname;
        if (pathname === '/' || pathname === '' || pathname.startsWith('/search') || pathname.startsWith('/directory')) {
          console.debug('[ContentScript] Skipping Twitch non-stream page:', url);
          return;
        }
      }

      let service: 'youtube-tab' | 'netflix-tab' | 'twitch-tab' | 'video-tab' = 'video-tab';
      if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
        service = 'youtube-tab';
      } else if (domain.includes('netflix.com')) {
        service = 'netflix-tab';
      } else if (domain.includes('twitch.tv')) {
        service = 'twitch-tab';
      }

      const activityId = generateActivityId(service, url);

      const activity = {
        id: activityId,
        service: service,
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

      if (port) {
        try {
          port.postMessage({
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
        console.warn('[ContentScript] ⚠️ Port not available for sending activity');
      }
    }

    private _getVideoTitle(): string {
      if (window.location.hostname.includes('netflix.com')) {
        if (this.cachedNetflixTitle) {
          return this.cachedNetflixTitle;
        }
        const title = this._getNetflixTitle();
        if (title) {
          this.cachedNetflixTitle = title;
          return title;
        }
        return 'Netflix Video';
      }

      let title = document.title;

      title = title
        .replace(/ - YouTube$/, '')
        .replace(/ \| Netflix$/, '')
        .replace(/ on Twitch$/, '')
        .replace(/^▶ /, '');

      return title.trim() || 'Video';
    }

    private _getNetflixTitle(): string | null {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const title = this._tryExtractNetflixTitle();
          if (title) return title;
        }
        return null;
      } catch (error) {
        return null;
      }
    }

    private _tryExtractNetflixTitle(): string | null {
      const h2Elements = document.querySelectorAll('h2');
      for (const h2 of h2Elements) {
        const text = h2.textContent?.trim();
        if (text && this._isValidNetflixTitle(text)) {
          return text;
        }
      }

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
          if (this._isValidNetflixTitle(result)) {
            return result;
          }
        }
      }

      return null;
    }

    private _isValidNetflixTitle(title: string | null | undefined): boolean {
      if (!title || typeof title !== 'string') return false;
      if (title.length < 2 || title.length > 200) return false;

      const lower = title.toLowerCase();

      if (title.includes('•')) return false;
      if (title.includes('invited you to')) return false;
      if (/[\x00-\x1F\x7F]/.test(title)) return false;

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

    private _getFavicon(): string {
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

      if (this.domObserver) {
        this.domObserver.disconnect();
        this.domObserver = null;
      }

      this._removeVideoListeners();
      this.activeVideoElement = null;

      console.log('[ContentScript] ✅ Cleanup complete');
    }
  }

  function isContextValid(): boolean {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function establishConnection(): void {
    if (port) {
      return; // Already connected
    }

    try {
      port = chrome.runtime.connect({
        name: 'content-script-video-tab',
      });

      port.onDisconnect.addListener(() => {
        console.warn('[ContentScript] Port disconnected from background');
        port = null;

        // Attempt reconnection with exponential backoff
        if ((window as any)[GLOBAL_FLAG_KEY] && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, reconnectAttempts);
          reconnectAttempts++;
          console.log(`[ContentScript] Attempting reconnection in ${backoff}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

          reconnectTimeoutId = setTimeout(() => {
            establishConnection();
          }, backoff);
        }
      });

      reconnectAttempts = 0; // Reset on successful connection
      console.log('[ContentScript] Connected to background service worker');
    } catch (err) {
      console.error('[ContentScript] Failed to establish connection:', err);
      // Schedule retry
      if ((window as any)[GLOBAL_FLAG_KEY] && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, reconnectAttempts);
        reconnectAttempts++;
        reconnectTimeoutId = setTimeout(() => {
          establishConnection();
        }, backoff);
      }
    }
  }

  function performCleanup(): void {
    console.log('[ContentScript] 🧹 SELF-DESTRUCT: Starting complete cleanup');

    // Clear global flag
    (window as any)[GLOBAL_FLAG_KEY] = false;

    // Disconnect port
    if (port) {
      try {
        port.disconnect();
      } catch (err) {
        console.debug('[ContentScript] Port disconnect error:', err);
      }
      port = null;
    }

    // Cancel reconnection attempt if pending
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }

    // Remove ALL tracked event listeners
    for (const { element, eventName, handler } of trackedEventListeners) {
      try {
        element.removeEventListener(eventName, handler);
      } catch (err) {
        console.debug('[ContentScript] Error removing listener:', err);
      }
    }
    trackedEventListeners.length = 0; // Clear array

    // Remove any extension-created UI nodes (if any were added in the future)
    const extensionElements = document.querySelectorAll('[data-hang-time-ui]');
    for (const el of extensionElements) {
      try {
        el.remove();
      } catch (err) {
        console.debug('[ContentScript] Error removing UI element:', err);
      }
    }

    // Unregister self-destruct listener
    window.removeEventListener(LIFECYCLE_EVENT_TOKEN, performCleanup);

    console.log('[ContentScript] ✅ Self-destruct complete, orphaned instance terminated');
  }

  // Register self-destruct listener
  window.addEventListener(LIFECYCLE_EVENT_TOKEN, performCleanup);

  // Initialize
  if (isContextValid()) {
    console.log('[ContentScript] 🚀 Initializing generic video tracker');

    establishConnection();

    const tracker = new GenericVideoTracker();
    tracker.init();

    // Monitor context validity
    const contextCheckInterval = setInterval(() => {
      if (!isContextValid()) {
        console.error('[ContentScript] Extension context lost—orphaned script detected');
        performCleanup();
        clearInterval(contextCheckInterval);
      }
    }, 5000);
  } else {
    console.warn('[ContentScript] Extension context invalid, skipping initialization');
  }
})();
