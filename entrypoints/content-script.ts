/**
 * Hang Time - Generic Video Content Script with Lifecycle Management
 * Detects any <video> element on any platform with automatic recovery on extension reload
 * Works with YouTube, Netflix, Twitch, and potentially any video site
 * Injects overlay UI for co-watching coordination
 */

import { generateActivityId } from '../src/modules/activity-utils';
import { OverlayUI, OverlayState } from '../src/modules/overlay-ui';
import { VideoProviderRegistry, VideoProvider } from '../src/modules/providers';

// ============================================================================
// LIFECYCLE MANAGEMENT - Simple, top-level flag and cleanup event
// ============================================================================

const CLEANUP_EVENT = 'hang-time-content-script-cleanup';
const INSTANCE_ID = Math.random().toString(36).slice(2, 9);

console.log(`[ContentScript] 🆕 New instance spawned: ${INSTANCE_ID}`);

// Signal any existing older instance to destroy itself across worlds
document.dispatchEvent(new CustomEvent(CLEANUP_EVENT));

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
let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
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
  private activeProvider: VideoProvider | null = null;
  private providerRegistry: VideoProviderRegistry = new VideoProviderRegistry();
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private domObserver: MutationObserver | null = null;
  private eventListeners: Map<string, (evt: Event) => void> = new Map();
  private lastReportedTime: number = 0;
  private lastReportTimestamp: number = 0;
  private videoSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  public currentActivityId: string | null = null;
  public currentActivityContentTimestamp: number | null = null;

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
    const currentUrl = new URL(window.location.href);
    const provider = this.providerRegistry.getProvider(currentUrl);

    // If on an unwatchable URL (e.g. search/directory), skip hooking
    if (!provider.isValidWatchUrl(currentUrl)) {
      return;
    }

    const currentVideo = provider.findVideoElement();

    if (!currentVideo || currentVideo === this.activeVideoElement) {
      return;
    }

    if (this.activeVideoElement) {
      this._removeVideoListeners();
      this.activeProvider?.onVideoUnmounted?.();
    }

    this.activeVideoElement = currentVideo;
    this.activeProvider = provider;
    this.activeProvider.onVideoHooked?.(currentVideo);
    console.log(`[ContentScript] 🎬 Video hooked with provider: ${provider.serviceName}`);

    // Generate activity ID to check if this is a new video
    const url = window.location.href;
    const service = provider.serviceName;
    const newActivityId = generateActivityId(service, url);

    // If this is a new activity, get or create the content timestamp from StorageManager / sessionStorage
    if (newActivityId !== this.currentActivityId) {
      this.currentActivityId = newActivityId;

      // Try synchronous sessionStorage first (survives tab reloads)
      let cachedTs: number | undefined = undefined;
      try {
        const storedStr = sessionStorage.getItem(`hang_time_content_ts_${newActivityId}`);
        if (storedStr) {
          cachedTs = parseInt(storedStr, 10);
        }
      } catch (e) {
        // Ignore sessionStorage restrictions
      }

      this.currentActivityContentTimestamp = cachedTs ?? null; // Set cached if available, otherwise wait for response or timeout

      // Request existing contentTimestamp from background's StorageManager (primary memory storage)
      const requestTime = Date.now();
      if (port) {
        port.postMessage({
          type: 'GET_ACTIVITY_CONTENT_TIMESTAMP',
          data: { activityId: newActivityId },
        });
        console.log(`[TimestampMigration] REQUEST stored timestamp for activity ${newActivityId} at ${requestTime}`);
      }

      // Fallback: if no response in 500ms and no cached timestamp, use current time
      setTimeout(() => {
        if (this.currentActivityContentTimestamp === undefined) {
          this.currentActivityContentTimestamp = Date.now();
          try {
            sessionStorage.setItem(`hang_time_content_ts_${newActivityId}`, this.currentActivityContentTimestamp.toString());
          } catch (e) {}
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
    this.activeProvider?.onVideoUnmounted?.();
    this.activeVideoElement = null;
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

    const currentUrl = new URL(window.location.href);
    const provider = this.activeProvider || this.providerRegistry.getProvider(currentUrl);

    if (!provider.isValidWatchUrl(currentUrl)) {
      return;
    }

    const title = provider.extractTitle(this.activeVideoElement);
    const favicon = (provider.getFavicon ? provider.getFavicon() : null) || this._getFavicon();
    const domain = window.location.hostname;
    const url = window.location.href;
    const duration = Math.floor(this.activeVideoElement.duration || 0);
    const currentTime = Math.floor(this.activeVideoElement.currentTime || 0);
    const isPaused = this.activeVideoElement.paused;

    if (duration > 0 && duration < 60) {
      // Ad detected - skip reporting, keep video hooked for when main content resumes
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

    const service = provider.serviceName;
    const activityId = generateActivityId(service, url);

    // Use stored contentTimestamp if this is the same activity, otherwise set it
    if (activityId !== this.currentActivityId) {
      this.currentActivityId = activityId;
      let cachedTs: number | undefined = undefined;
      try {
        const storedStr = sessionStorage.getItem(`hang_time_content_ts_${activityId}`);
        if (storedStr) cachedTs = parseInt(storedStr, 10);
      } catch (e) {}
      this.currentActivityContentTimestamp = cachedTs || Date.now();
      try {
        sessionStorage.setItem(`hang_time_content_ts_${activityId}`, this.currentActivityContentTimestamp.toString());
      } catch (e) {}
      console.log(`[TimestampMigration:ContentTimestamp] SET for activity ${activityId}: ${this.currentActivityContentTimestamp}`);
    } else if (!this.currentActivityContentTimestamp) {
      let cachedTs: number | undefined = undefined;
      try {
        const storedStr = sessionStorage.getItem(`hang_time_content_ts_${activityId}`);
        if (storedStr) cachedTs = parseInt(storedStr, 10);
      } catch (e) {}
      this.currentActivityContentTimestamp = cachedTs || Date.now();
      try {
        sessionStorage.setItem(`hang_time_content_ts_${activityId}`, this.currentActivityContentTimestamp.toString());
      } catch (e) {}
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
    } catch {
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
    this.activeProvider?.onVideoUnmounted?.();
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

    // Send initial requests to keep service worker awake and hydrate overlay state immediately
    try {
      port.postMessage({ type: 'PING' });
      port.postMessage({ type: 'GET_USER_ID' });
      port.postMessage({ type: 'GET_OVERLAY_STATE' });
    } catch (e) {
      // Ignore
    }

    // Setup message listeners for overlay updates
    port.onMessage.addListener((message) => {
      switch (message.type) {
        case 'ACTIVITY_CONTENT_TIMESTAMP':
          // Background returned stored contentTimestamp for this activity
          if (tracker && message.data?.activityId === tracker.currentActivityId) {
            const stored = message.data?.contentTimestamp;
            if (stored) {
              tracker.currentActivityContentTimestamp = stored;
              try {
                sessionStorage.setItem(`hang_time_content_ts_${message.data.activityId}`, stored.toString());
              } catch (e) {}
              console.log(`[TimestampMigration] RESPONSE for activity ${message.data.activityId}: REUSED stored=${stored}`);
            } else {
              console.log(`[TimestampMigration] RESPONSE for activity ${message.data.activityId}: not found in storage`);
            }
          } else {
            console.log(`[TimestampMigration] RESPONSE for activity ${message.data?.activityId}: mismatch with current=${tracker?.currentActivityId}`);
          }
          break;

        case 'USER_ID':
          // Store user ID for overlay
          userId = message.data;
          if (overlayUI) {
            overlayUI.setUserId(userId);
          }
          console.debug('[ContentScript] Received user ID:', userId);
          break;

        case 'OVERLAY_STATE':
        case 'CO_WATCH_UPDATE':
          console.log(`[ContentScript] [MESSAGE_FLOW] ${message.type} received with ${(message.data?.messages?.length || 0)} messages`);
          // Initialize overlay on-demand if it doesn't exist yet
          if (!overlayUI) {
            console.log(`[ContentScript] [MESSAGE_FLOW] ${message.type} triggered lazy overlay initialization`);
            overlayUI = new OverlayUI(userId || 'unknown');
            overlayUI.init();
            if (port) {
              overlayUI.setPort(port);
            }
          }
          // Update overlay with co-watch data
          if (message.data) {
            const incomingMessages = message.data.messages || [];
            const currentMessages = overlayUI.state.messages || [];

            // Merge messages: combine current and incoming, sort chronologically, and deduplicate
            const allCandidates = [...currentMessages, ...incomingMessages];
            allCandidates.sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));

            const mergedMessages: any[] = [];
            for (const msg of allCandidates) {
              if (!msg || !msg.content) continue;
              const isDupe = mergedMessages.some((existing) => {
                if (existing.id && msg.id && existing.id === msg.id) return true;
                if (existing.content === msg.content) {
                  return Math.abs((existing.timestamp || 0) - (msg.timestamp || 0)) < 10000;
                }
                return false;
              });
              if (!isDupe) {
                mergedMessages.push(msg);
              }
            }

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

            // Detect if user has diverged to a different activity than the session
            const sessionActivityId = message.data.activity_id;
            const userCurrentActivityId = tracker?.currentActivityId;
            const hasUserDiverged = userCurrentActivityId && userCurrentActivityId !== sessionActivityId;

            // If user diverged, use their current activity as the "primary" activity for display
            // This ensures all co-watchers show as guests with their activities relative to user's current video
            const displayActivityId = hasUserDiverged ? userCurrentActivityId : sessionActivityId;

            // Only update messages if we received them from backend or have no current messages
            const stateUpdate: Partial<OverlayState> = {
              activity_id: displayActivityId,
              host_nickname: message.data.host_nickname,
              watching_together: message.data.watching_together || [],
              session_members: message.data.session_members || [],
              host_progress: message.data.host_progress,
              host_progress_timestamp: message.data.host_progress_timestamp,
              host_state: message.data.host_state,
              host_duration: message.data.host_duration,
              user_progress: message.data.user_progress,
              guest_progress: message.data.guest_progress,
              guest_progress_timestamp: Date.now(),
              is_user_host: message.data.is_user_host,
              co_watcher_activities: message.data.co_watcher_activities,
            };

            // Only update messages if backend sent new messages or we're starting fresh
            if (incomingMessages.length > 0 || currentMessages.length === 0) {
              console.debug('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE: updating messages. incoming=', incomingMessages.length, 'current=', currentMessages.length, 'merged=', mergedMessages.length);
              stateUpdate.messages = mergedMessages;
            } else {
              console.debug('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE: NOT updating messages. incoming=', incomingMessages.length, 'current=', currentMessages.length);
            }

            // DEBUG: Log raw storage state
            console.log('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE INCOMING:', incomingMessages.length, incomingMessages.map((m: any) => ({ sender: m.sender, content: m.content?.substring(0, 20) })));
            console.log('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE CURRENT UI:', currentMessages.length, currentMessages.map((m: any) => ({ sender: m.sender, content: m.content?.substring(0, 20) })));
            console.log('[ContentScript] [MESSAGE_FLOW] CO_WATCH_UPDATE MERGED:', mergedMessages.length, mergedMessages.map((m: any) => ({ sender: m.sender, content: m.content?.substring(0, 20) })));

            overlayUI.setState(stateUpdate);
            if ((stateUpdate.session_members?.length || 0) === 0) {
              overlayHasBeenShown = false;
            } else if (!overlayHasBeenShown && (stateUpdate.session_members?.length || 0) >= 2) {
              overlayHasBeenShown = true;
              console.debug('[ContentScript] Showing overlay for first time from CO_WATCH_UPDATE');
              overlayUI.show();
              if (!overlayUI.state.pinned) {
                overlayUI.startFadeOut();
              }
            }
          }
          break;

        case 'SYNC_COMPLETE':
          if (!overlayUI) return;
          // Update progress after sync completes
          if (message.data) {
            const newPosition = message.data.position + message.data.elapsed;
            overlayUI.setState({
              user_progress: newPosition,
            });
            console.debug('[ContentScript] Sync complete, updated position to:', newPosition);
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
              user_progress: message.data.position,
            });
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
  document.removeEventListener(CLEANUP_EVENT, performCleanup);

  console.log('[ContentScript] ✅ Self-destruct complete, orphaned instance terminated');
}

// ============================================================================
// EXECUTION
// ============================================================================

// Register cleanup listener FIRST so old instances can clean up when signaled
document.addEventListener(CLEANUP_EVENT, performCleanup);

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
