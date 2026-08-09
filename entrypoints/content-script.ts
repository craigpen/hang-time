/**
 * Hang Time - Generic Video Content Script with Lifecycle Management
 * Detects any <video> element on any platform with automatic recovery on extension reload
 * Works with YouTube, Netflix, Twitch, and potentially any video site
 * Injects overlay UI for co-watching coordination
 */

import { generateActivityId } from '../src/modules/activity-utils';
import { OverlayUI } from '../src/modules/overlay-ui';

// ============================================================================
// LIFECYCLE MANAGEMENT - Simple, top-level flag and cleanup event
// ============================================================================

const CLEANUP_EVENT = 'hang-time-content-script-cleanup';
const INSTANCE_ID = Math.random().toString(36).slice(2, 9);

console.log(`[ContentScript] 🆕 New instance spawned: ${INSTANCE_ID}`);

// If an older instance is running, signal it to destroy itself
if ((window as any).hangTimeScriptActive) {
  console.log(`[ContentScript] 🔄 Orphaned instance detected (${(window as any).hangTimeScriptActive}), triggering cleanup...`);
  window.dispatchEvent(new CustomEvent(CLEANUP_EVENT));
}

// Mark THIS instance as the active one (new owner)
(window as any).hangTimeScriptActive = INSTANCE_ID;
console.log(`[ContentScript] ✨ Instance ${INSTANCE_ID} is now active`);

// Track event listeners for cleanup
const trackedEventListeners: Array<{
  element: EventTarget;
  eventName: string;
  handler: EventListener;
}> = [];

// Port connection state
let port: chrome.runtime.Port | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_BACKOFF_MS = 500;
let reconnectTimeoutId: number | null = null;
let tracker: GenericVideoTracker | null = null;

// Overlay UI state
let overlayUI: OverlayUI | null = null;
let userId: string = ''; // Will be set from background message
let overlayHasBeenShown = false; // Track if overlay was shown once (to avoid hide/show flicker if Nostr updates are missed)

// ============================================================================
// GENERIC VIDEO TRACKER CLASS
// ============================================================================

class GenericVideoTracker {
  private activeVideoElement: HTMLVideoElement | null = null;
  private pollingInterval: number | null = null;
  private domObserver: MutationObserver | null = null;
  private eventListeners: Map<string, (evt: Event) => void> = new Map();
  private lastReportedTime: number = 0;
  private lastReportTimestamp: number = 0;
  private videoSearchTimeout: number | null = null;
  private cachedNetflixTitle: string | null = null;
  private currentActivityId: string | null = null;
  private currentActivityContentTimestamp: number | null = null;

  constructor() {}

  init(): void {
    this._setupDOMObserver();
    this._findAndHookVideo();
  }

  // Public method for external cleanup (called by forceGlobalTeardown)
  destroy(): void {
    this._cleanup();
  }

  private _setupDOMObserver(): void {
    this.domObserver = new MutationObserver(() => {
      if (!this._isContextValid()) {
        forceGlobalTeardown();
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
  }

  private _findAndHookVideo(): void {
    const videoElements = Array.from(document.querySelectorAll('video'));

    if (videoElements.length === 0) {
      return;
    }

    const visibleVideos = videoElements.filter((v) => v.offsetWidth > 0 && v.offsetHeight > 0);

    // Filter for main content: not known ads AND not in ad containers
    const mainContentVideos = visibleVideos.filter((v) => {
      // Skip small videos (likely ads or widgets, not main content)
      if (v.offsetWidth < 640 || v.offsetHeight < 360) return false;

      // Skip if duration is known to be short (ad indicator)
      if (v.duration > 0 && v.duration < 60) return false;

      // Skip if in ad container (class or parent class indicates ad)
      if (v.className.toLowerCase().includes('ad')) return false;
      let parent = v.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.className.toLowerCase().includes('ad')) return false;
        parent = parent.parentElement;
      }
      return true;
    });

    // Priority order:
    // 1. Main content video (visible, passed ad filters)
    // 2. Fallback to any visible video (duration might not be loaded yet)
    // 3. Fallback to first video (worst case)
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

    // Generate activity ID to check if this is a new video
    const url = window.location.href;
    let service: 'youtube-tab' | 'netflix-tab' | 'twitch-tab' | 'video-tab' = 'video-tab';
    const domain = window.location.hostname;
    if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
      service = 'youtube-tab';
    } else if (domain.includes('netflix.com')) {
      service = 'netflix-tab';
    } else if (domain.includes('twitch.tv')) {
      service = 'twitch-tab';
    }
    const newActivityId = generateActivityId(service, url);

    // If this is a new activity, get or create the content timestamp from StorageManager
    if (newActivityId !== this.currentActivityId) {
      this.currentActivityId = newActivityId;
      this.currentActivityContentTimestamp = undefined; // Wait for response or timeout

      // Request existing contentTimestamp from background's StorageManager (primary memory storage)
      // This persists across page reloads in the same tab
      const requestTime = Date.now();
      if (port) {
        port.postMessage({
          type: 'GET_ACTIVITY_CONTENT_TIMESTAMP',
          data: { activityId: newActivityId },
        });
        console.log(`[TimestampMigration] REQUEST stored timestamp for activity ${newActivityId} at ${requestTime}`);
      }

      // Fallback: if no response in 500ms, use current time
      setTimeout(() => {
        if (this.currentActivityContentTimestamp === undefined) {
          this.currentActivityContentTimestamp = Date.now();
          console.log(`[TimestampMigration] FALLBACK after 500ms for activity ${newActivityId}: using ${this.currentActivityContentTimestamp}`);
        }
      }, 500);
    }

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
    this._removeVideoListeners();
    this.activeVideoElement = null;
    this.cachedNetflixTitle = null;
    // Don't clear currentActivityId or contentTimestamp - they persist if we re-hook the same video
    // (emptied fires during seeking/buffering, not just when video actually closes)
    console.log('[TimestampMigration:ContentTimestamp] Video emptied, searching for video again');
    setTimeout(() => this._findAndHookVideo(), 100);
  }

  private _sendPlaybackUpdate(): void {
    if (!this._isContextValid()) {
      console.warn('[ContentScript] Context invalid, terminating');
      forceGlobalTeardown();
      return;
    }

    if (!this.activeVideoElement) {
      console.warn('[ContentScript] No active video element');
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
      // Ad detected, unhook silently (already filtered in _findAndHookVideo)
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
        return;
      }
    }

    if (url.includes('twitch.tv')) {
      const pathname = new URL(url).pathname;
      if (pathname === '/' || pathname === '' || pathname.startsWith('/search') || pathname.startsWith('/directory')) {
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

    // Use stored contentTimestamp if this is the same activity, otherwise set it
    if (activityId !== this.currentActivityId) {
      this.currentActivityId = activityId;
      this.currentActivityContentTimestamp = Date.now();
      console.log(`[TimestampMigration:ContentTimestamp] SET for activity ${activityId}`);
    }

    const activity = {
      id: activityId,
      service: service,
      content: title,
      state: isPaused ? 'paused' : 'playing',
      timestamp: Date.now(),
      url: url,
      contentTimestamp: this.currentActivityContentTimestamp || Date.now(), // Immutable start time for host determination
      metadata: {
        duration,
        progress: currentTime, // Current video position (seconds)
        progress_measured_at: Date.now(), // Timestamp of progress measurement (used for sync interpolation on guest side)
        domain,
        favicon,
      },
    };

    // Only send if we still own this tab
    if (!port) {
      console.warn('[ContentScript] No port connected');
      return;
    }
    if ((window as any).hangTimeScriptActive !== INSTANCE_ID) {
      console.warn('[ContentScript] Instance check failed: hangTimeScriptActive=' + (window as any).hangTimeScriptActive + ' vs INSTANCE_ID=' + INSTANCE_ID);
      return;
    }

    try {
      console.log('[ContentScript] 📤 Sending activity:', activity.id, activity.service);
      port.postMessage({
        type: 'CONTENT_SCRIPT_ACTIVITY',
        data: {
          key: 'content_script_activity_video-tab',
          value: activity,
        },
      });
    } catch (err) {
      console.error('[ContentScript] Failed to send activity:', err);
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
    // Priority 1: data-uia='video-title' (most reliable, used by player UI)
    const titleElements = document.querySelectorAll("[data-uia='video-title']");
    for (const titleElement of titleElements) {
      const title = this._parseNetflixTitleText(titleElement.textContent?.trim() || '');
      if (title && this._isValidNetflixTitle(title)) {
        return title;
      }
    }

    // Priority 2: Player title area (look for heading in player controls)
    const playerTitles = document.querySelectorAll("[data-uia='player-title'], [class*='player-title'], h2[role='heading']");
    for (const elem of playerTitles) {
      const text = elem.textContent?.trim();
      if (text && this._isValidNetflixTitle(text)) {
        return text;
      }
    }

    // Priority 3: h2 tags (but skip obvious UI sections by checking parent context)
    const h2Elements = document.querySelectorAll('h2');
    for (const h2 of h2Elements) {
      const text = h2.textContent?.trim();
      if (!text) continue;

      // Skip if in browse/menu context
      const parent = h2.closest('[class*="browse"], [class*="menu"], [data-uia*="menu"]');
      if (parent) continue;

      if (this._isValidNetflixTitle(text)) {
        return text;
      }
    }

    return null;
  }

  private _parseNetflixTitleText(fullText: string): string | null {
    if (!fullText) return null;

    // Split on common metadata separators
    const parts = fullText.split(/\s+(?=Rated|Audio|Subtitles|CC|Closed|Available|IMDb|\d+%)/i);
    if (!parts[0]) return null;
    let title = parts[0].trim();

    // Skip if starts with metadata
    if (/^Rated|^PG|^R$|^NC-17|^G$|^TV-|^\d+%|^IMDb|^Audio|^Subtitles|^CC|^Closed|^Available/i.test(title)) {
      return null;
    }

    // Extract episode if present (e.g., "S1:E1" or "Season 1 Episode 1")
    const episodeMatch = title.match(/\s*([SE]\d+(?:E\d+)?)\s*/i);
    const episode = episodeMatch ? episodeMatch[1] : null;

    if (episode && episodeMatch?.index !== undefined) {
      title = title.substring(0, episodeMatch.index).trim();
    }

    // Remove duplicate words at end (Netflix sometimes repeats first word)
    const titleWords = title.split(/\s+/);
    if (titleWords.length > 1 && titleWords[0]) {
      const firstWord = titleWords[0].toLowerCase();
      while (titleWords.length > 1) {
        const lastWord = titleWords[titleWords.length - 1];
        if (!lastWord || lastWord.toLowerCase() !== firstWord) break;
        titleWords.pop();
      }
      title = titleWords.join(' ');
    }

    title = title.trim();

    if (title && title.length > 2) {
      return episode ? `${title} ${episode}` : title;
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
      lower === 'replay' ||
      lower === 'your next watch' ||
      lower === 'top 10' ||
      lower === 'new & hot' ||
      lower === 'trending now'
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
      // Check if chrome API is available (dies when extension reloads)
      const chrome = (globalThis as any).chrome;
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        return false;
      }
      // If a newer script took over, this instance is dead
      if ((window as any).hangTimeScriptActive !== INSTANCE_ID) return false;
      return true;
    } catch (e) {
      // Any error accessing chrome = context is invalid
      return false;
    }
  }

  private _cleanup(): void {
    console.log('[ContentScript] 🧹 Cleaning up video tracker');

    // Stop all timers
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    if (this.videoSearchTimeout) {
      clearTimeout(this.videoSearchTimeout);
      this.videoSearchTimeout = null;
    }

    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = null;
    }

    this._removeVideoListeners();
    this.activeVideoElement = null;

    console.log('[ContentScript] ✅ Cleanup complete');
  }
}

// ============================================================================
// CONNECTION AND INITIALIZATION FUNCTIONS
// ============================================================================

// Called when tracker detects it's no longer the active instance
function forceGlobalTeardown(): void {
  console.log(`[ContentScript] 🛑 Instance ${INSTANCE_ID} detected context loss/ownership loss, forcefully terminating...`);

  // Don't clear hangTimeScriptActive - a new instance has already claimed it
  // Clearing it to false would break the new instance's lifecycle checks at line 292 and 504
  // Just proceed with cleanup without touching the instance flag

  performCleanup();
}

function isContextValid(): boolean {
  try {
    // Check if chrome API is available first (handles suspended tabs where context isn't ready)
    if (typeof chrome === 'undefined' || !chrome.runtime) {
      return false;
    }
    return !!chrome.runtime.id;
  } catch {
    return false;
  }
}

function establishConnection(): void {
  // Skip if we're no longer the active instance (new script took over)
  if ((window as any).hangTimeScriptActive !== INSTANCE_ID) {
    return;
  }

  if (port) {
    return; // Already connected
  }

  // Guard against suspended tabs where chrome APIs aren't ready yet
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    console.debug('[ContentScript] Chrome runtime not available yet (suspended tab?), will retry');
    if ((window as any).hangTimeScriptActive === INSTANCE_ID && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, reconnectAttempts);
      reconnectAttempts++;
      reconnectTimeoutId = setTimeout(() => {
        establishConnection();
      }, backoff);
    }
    return;
  }

  try {
    port = chrome.runtime.connect({
      name: 'content-script-video-tab',
    });

    port.onDisconnect.addListener(() => {
      console.warn('[ContentScript] Port disconnected from background');
      port = null;

      // Only reconnect if we're still the active instance
      if ((window as any).hangTimeScriptActive === INSTANCE_ID && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, reconnectAttempts);
        reconnectAttempts++;

        reconnectTimeoutId = setTimeout(() => {
          establishConnection();
        }, backoff);
      }
    });

    reconnectAttempts = 0; // Reset on successful connection
    console.log('[ContentScript] ✅ Connected to background service worker');

    // Send initial ping to keep service worker awake
    try {
      port.postMessage({ type: 'PING' });
    } catch (e) {
      // Ignore ping failures
    }

    // Setup message listeners for overlay updates
    port.onMessage.addListener((message) => {
      switch (message.type) {
        case 'ACTIVITY_CONTENT_TIMESTAMP':
          // Background returned stored contentTimestamp for this activity
          if (message.data?.activityId === tracker?.['currentActivityId']) {
            const stored = message.data?.contentTimestamp;
            if (stored) {
              tracker['currentActivityContentTimestamp'] = stored;
              console.log(`[TimestampMigration] RESPONSE for activity ${message.data.activityId}: REUSED stored=${stored}`);
            } else {
              console.log(`[TimestampMigration] RESPONSE for activity ${message.data.activityId}: not found in storage`);
            }
          } else {
            console.log(`[TimestampMigration] RESPONSE for activity ${message.data?.activityId}: mismatch with current=${tracker?.['currentActivityId']}`);
          }
          break;

        case 'USER_ID':
          // Store user ID for overlay
          userId = message.data;
          if (overlayUI) {
            // Recreate overlay with correct user ID
            overlayUI.destroy();
            overlayUI = new OverlayUI(userId);
            overlayUI.init();
            // Re-attach port after recreation
            if (port) {
              overlayUI.setPort(port);
            }
          }
          console.debug('[ContentScript] Received user ID:', userId);
          break;

        case 'CO_WATCH_UPDATE':
          console.log('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE received with ' + (message.data?.messages?.length || 0) + ' messages');
          // Initialize overlay on-demand if it doesn't exist yet
          if (!overlayUI) {
            console.log('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE triggered lazy overlay initialization');
            overlayUI = new OverlayUI(userId || 'unknown');
            overlayUI.init();
            if (port) {
              overlayUI.setPort(port);
            }
          }
          // Update overlay with co-watch data
          if (message.data) {
            // On first show only: check if host friend's data is fresh enough
            // This prevents showing incorrect host during reload when friend's contentTimestamp is stale
            if (!overlayHasBeenShown && !message.data.is_user_host) {
              const FRIEND_FRESHNESS_THRESHOLD_MS = 13000; // 13 seconds (allow Nostr cycle to complete)
              const hostFreshnessTimestamp = message.data.host_activity_freshness_timestamp;
              if (hostFreshnessTimestamp) {
                const hostActivityAge = Date.now() - hostFreshnessTimestamp;
                if (hostActivityAge > FRIEND_FRESHNESS_THRESHOLD_MS) {
                  console.debug(`[ContentScript] Host friend data too stale (${hostActivityAge}ms > ${FRIEND_FRESHNESS_THRESHOLD_MS}ms), waiting for fresh Nostr update...`);
                  return; // Don't show overlay yet
                }
              }
            }

            // Mark overlay as shown once we pass freshness check
            if (!overlayHasBeenShown) {
              overlayHasBeenShown = true;
              console.debug('[ContentScript] Overlay will be shown for first time');
            }

            // Merge messages instead of replacing - preserve locally added messages
            const incomingMessages = message.data.messages || [];
            const currentMessages = overlayUI.state.messages || [];

            // Deduplicate and merge: use content+sender_id as key
            // (same message from same person, regardless of display name or timestamp variation)
            const merged = new Map();
            for (const msg of currentMessages) {
              const key = `${msg.content}_${msg.sender_id}`;
              merged.set(key, msg);
            }
            for (const msg of incomingMessages) {
              const key = `${msg.content}_${msg.sender_id}`;
              // Only add from backend if not already present (prefer local "You" over display name)
              if (!merged.has(key)) {
                merged.set(key, msg);
              }
            }

            // Sort by timestamp
            const mergedMessages = Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp);

            // Use nicknameMap from background (has complete participant info), fallback to extracting from messages
            let nicknameMapObj: Record<string, string> = message.data.nicknameMap || {};
            if (Object.keys(nicknameMapObj).length === 0) {
              // Fallback: build from messages (less complete, but works if map not sent)
              for (const msg of mergedMessages) {
                if (msg.sender_id && msg.sender) {
                  nicknameMapObj[msg.sender_id] = msg.sender;
                }
              }
            }
            // Set the nickname map on overlay
            if (Object.keys(nicknameMapObj).length > 0) {
              overlayUI.setNicknameMap(nicknameMapObj);
            }

            // Only update messages if we received them from backend or have no current messages
            const stateUpdate: Partial<OverlayState> = {
              activity_id: message.data.activity_id,
              host_nickname: message.data.host_nickname,
              watching_together: message.data.watching_together || [],
              host_progress: message.data.host_progress,
              host_progress_timestamp: message.data.host_progress_timestamp,
              host_state: message.data.host_state,
              host_duration: message.data.host_duration,
              user_progress: message.data.user_progress,
              guest_progress: message.data.guest_progress,
              guest_progress_timestamp: Date.now(),
              is_user_host: message.data.is_user_host,
            };

            // Only update messages if backend sent new messages or we're starting fresh
            if (incomingMessages.length > 0 || currentMessages.length === 0) {
              console.debug('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE: updating messages. incoming=', incomingMessages.length, 'current=', currentMessages.length, 'merged=', mergedMessages.length);
              stateUpdate.messages = mergedMessages;
            } else {
              console.debug('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE: NOT updating messages. incoming=', incomingMessages.length, 'current=', currentMessages.length);
            }

            // DEBUG: Log raw storage state
            console.log('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE INCOMING:', incomingMessages.length, incomingMessages.map(m => ({ sender: m.sender, content: m.content?.substring(0, 20) })));
            console.log('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE CURRENT UI:', currentMessages.length, currentMessages.map(m => ({ sender: m.sender, content: m.content?.substring(0, 20) })));
            console.log('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE MERGED:', mergedMessages.length, mergedMessages.map(m => ({ sender: m.sender, content: m.content?.substring(0, 20) })));

            overlayUI.setState(stateUpdate);
          }
          break;

        case 'SYNC_COMPLETE':
          if (!overlayUI) return;
          // Update progress after sync completes
          if (message.data) {
            const newPosition = message.data.position + message.data.elapsed;
            overlayUI.setState({
              user_position: newPosition,
            });
            console.debug('[ContentScript] Sync complete, updated position to:', newPosition);
          }
          break;

        case 'ACTIVITY_MESSAGES':
          if (!overlayUI) return;
          // Load initial messages for this activity (on page reload)
          const initialMessages = message.data?.messages || [];
          if (initialMessages.length > 0) {
            console.debug('[ContentScript] Loaded', initialMessages.length, 'initial messages for activity');
            overlayUI.setState({ messages: initialMessages });
          }
          break;

        case 'CHAT_MESSAGE':
          if (!overlayUI) return;
          // Add message to overlay chat
          if (message.data) {
            overlayUI.addMessage(
              message.data.sender,
              message.data.sender_id,
              message.data.content
            );
          }
          break;

        case 'ACTIVITY_UPDATE':
          if (!overlayUI) return;
          // Update overlay with current activity info
          if (message.data) {
            overlayUI.setState({
              video_title: message.data.title,
              user_position: message.data.position,
            });
          }
          break;

        case 'OVERLAY_STATE':
          // Response to GET_OVERLAY_STATE request with current co-watch state
          if (!overlayUI) return;
          if (message.data) {
            console.debug('[ContentScript] Received OVERLAY_STATE with', message.data.messages?.length || 0, 'messages');
            overlayUI.setState(message.data);
          }
          break;
      }
    });

    // Initialize overlay UI and get user ID
    try {
      // Request user ID from background
      port.postMessage({ type: 'GET_USER_ID' });
      // Request current overlay state for immediate hydration
      port.postMessage({ type: 'GET_OVERLAY_STATE' });
    } catch (e) {
      console.warn('[ContentScript] Failed to request initialization:', e);
    }

    // Send frequent pings to keep service worker from suspending
    // MV3 service workers can suspend after ~30 seconds of inactivity,
    // so we ping every 5 seconds to keep it alive
    const pingInterval = setInterval(() => {
      if (port && (window as any).hangTimeScriptActive === INSTANCE_ID) {
        try {
          port.postMessage({ type: 'PING' });
        } catch (e) {
          clearInterval(pingInterval);
        }
      } else {
        clearInterval(pingInterval);
      }
    }, 5000); // Every 5 seconds (matches context check frequency)
  } catch (err) {
    const errMsg = (err as Error).message || String(err);
    console.error('[ContentScript] Failed to establish connection:', errMsg);

    // If context is invalid, stop trying. The old script's context is dead.
    // Background will re-inject a new instance when ready.
    if (errMsg.includes('Extension context invalidated')) {
      console.warn('[ContentScript] Extension context invalidated—stopping retry loop. Awaiting re-injection.');
      performCleanup();
      return;
    }

    // For other transient errors (including Chrome API unavailability), retry with exponential backoff
    if ((window as any).hangTimeScriptActive === INSTANCE_ID && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, reconnectAttempts);
      reconnectAttempts++;
      console.debug(`[ContentScript] Retrying connection in ${backoff}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      reconnectTimeoutId = setTimeout(() => {
        establishConnection();
      }, backoff);
    }
  }
}

function performCleanup(): void {
  console.log('[ContentScript] 🧹 SELF-DESTRUCT: Starting complete cleanup');

  // Don't touch hangTimeScriptActive - new instance already claimed it and needs it for lifecycle checks
  // Clearing it would break the new instance's ability to send activities and perform its duties

  // Stop the video tracker (kills polling interval and observers)
  if (tracker) {
    tracker.destroy();
  }

  // Destroy overlay UI
  if (overlayUI) {
    overlayUI.destroy();
    overlayUI = null;
  }

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
      // Ignore errors if element already removed
    }
  }
  trackedEventListeners.length = 0;

  // Unregister self-destruct listener
  window.removeEventListener(CLEANUP_EVENT, performCleanup);

  console.log('[ContentScript] ✅ Self-destruct complete, orphaned instance terminated');
}

// ============================================================================
// EXECUTION
// ============================================================================

// Register cleanup listener FIRST so old instances can clean up when signaled
window.addEventListener(CLEANUP_EVENT, performCleanup);

// Initialize with a brief delay to give old instance time to cleanup
setTimeout(() => {
  if (!isContextValid()) {
    setTimeout(() => {
      if (isContextValid()) {
        establishConnection();
        tracker = new GenericVideoTracker();
        tracker.init();
        initializeOverlay();
      }
    }, 2000);
    return;
  }

  establishConnection();
  tracker = new GenericVideoTracker();
  tracker.init();
  initializeOverlay();
}, 100);

/**
 * Initialize overlay UI on video pages
 */
function initializeOverlay(): void {
  console.debug('[ContentScript] initializeOverlay called');
  if (overlayUI) return; // Already initialized

  console.debug('[ContentScript] Initializing overlay UI (may be hidden until video loads)', {
    instanceId: INSTANCE_ID,
    isActiveInstance: (window as any).hangTimeScriptActive === INSTANCE_ID,
    userId,
    hasVideoElement: document.querySelector('video') !== null
  });

  // Initialize overlay regardless of whether video is present
  // This ensures CO_WATCH_UPDATE messages can show it immediately when needed
  // If no video, overlay just stays hidden until one appears
  overlayUI = new OverlayUI(userId || 'unknown');
  overlayUI.init();

  // Pass port to overlay for direct messaging
  if (port) {
    overlayUI.setPort(port);
    // Request initial messages for this activity (to restore chat on page reload)
    if (tracker && (tracker as any).currentActivityId) {
      port.postMessage({
        type: 'GET_ACTIVITY_MESSAGES_FOR_OVERLAY',
        data: { activityId: (tracker as any).currentActivityId },
      });
    }
  }

  // Listen for overlay interactions
  console.debug('[ContentScript] Setting up window message listener');
  window.addEventListener('message', (event) => {
    console.debug('[ContentScript] Window message event received:', event.data?.type);
    if (event.source !== window) {
      console.debug('[ContentScript] Ignoring message from different source');
      return;
    }

    if (event.data.type === 'HANG_TIME_SYNC_REQUEST') {
      // Sync button was clicked - calculate and seek locally
      if (overlayUI && overlayUI.state) {
        const hostProgress = overlayUI.state.host_progress;
        const hostProgressTimestamp = overlayUI.state.host_progress_timestamp;

        if (hostProgress !== undefined && hostProgressTimestamp !== undefined) {
          const videoElement = document.querySelector('video') as HTMLVideoElement;
          if (videoElement) {
            // Calculate synced position: host_progress + elapsed time since host's content script measured their progress
            // hostProgressTimestamp = progress_measured_at from host's activity
            // elapsedSeconds = time from when host measured to when we sync (now)
            const elapsedSeconds = (Date.now() - hostProgressTimestamp) / 1000;
            const syncedPosition = hostProgress + elapsedSeconds;

            console.log(`[ContentScript] 🔄 Syncing video: host was at ${hostProgress}s, measured ${elapsedSeconds.toFixed(1)}s ago, seeking to ${syncedPosition.toFixed(1)}s`);
            videoElement.currentTime = syncedPosition;

            // Notify overlay of sync completion
            window.postMessage({ type: 'HANG_TIME_SYNC_COMPLETE', data: { position: syncedPosition } }, '*');
          } else {
            console.warn('[ContentScript] Cannot sync - no video element found');
          }
        } else {
          console.warn('[ContentScript] Cannot sync - missing host progress or timestamp data');
        }
      }
    } else if (event.data.type === 'HANG_TIME_SEND_MESSAGE') {
      // Message was sent from overlay, forward to background
      if (port) {
        console.debug('[ContentScript] Forwarding HANG_TIME_SEND_MESSAGE to background', {
          content: event.data.data?.content,
          activity_id: event.data.data?.activity_id,
        });
        port.postMessage({
          type: 'SEND_MESSAGE',
          data: {
            content: event.data.data?.content,
            activity_id: event.data.data?.activity_id,
          },
        });
        console.debug('[ContentScript] SEND_MESSAGE posted to port');
      } else {
        console.warn('[ContentScript] No port available to send message');
      }
    } else if (event.data.type === 'HANG_TIME_OPEN_DISCORD') {
      // Discord button was clicked, send to background
      if (port) {
        port.postMessage({
          type: 'OPEN_DISCORD',
        });
      }
    } else if (event.data.type === 'HANG_TIME_SYNC_COMPLETE') {
      // Sync response received from host, update playback position
      const { activity_id, position, elapsed } = event.data.data;
      console.debug('[ContentScript] Sync complete for activity:', activity_id, 'position:', position, 'elapsed:', elapsed, 'ms');
      // UI/overlay can handle visual feedback of sync completion
      // Position update already applied by sync handler in background
    }
  });

  console.debug('[ContentScript] Overlay UI initialized');
}
