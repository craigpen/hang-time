/**
 * Hang Time - Background Service Worker
 * Main orchestration center for the extension
 * Handles: lifecycle, message routing, activity detection, Nostr subscriptions
 */

import * as pako from 'pako';
import { nip04, nip44, verifyEvent } from 'nostr-tools';
import { STORAGE_KEYS } from '../src/types';
import { RelayPool, relayPool } from '../src/modules/nostr';
import { StorageManager, storageManager } from '../src/modules/storage';
import { IdentityManager, initializeIdentityManager, getIdentityManager } from '../src/modules/identity';
import { FriendManager, initializeFriendManager, getFriendManager } from '../src/modules/friends';
import { MessagingManager, initializeMessagingManager, getMessagingManager } from '../src/modules/messaging';
import { NotificationManager, initializeNotificationManager, getNotificationManager } from '../src/modules/notifications';
import { initializeActivityDatastore, getActivityDatastore } from '../src/modules/activity-datastore';
import { initializeGameLibraryManager, GameLibraryManager } from '../src/modules/game-library';
import { JoinHandler } from '../src/modules/join-handler';
import { ActivityDetector } from '../src/modules/activity';
import { ActivityPublisher } from '../src/modules/publisher';
import { TabService } from '../src/modules/services/tabs';
import { SteamService } from '../src/modules/services/steam';
import { SpotifyService } from '../src/modules/services/spotify';
import { TwitchService } from '../src/modules/services/twitch';
import { initializeMetadataFetcher, metadataFetcher } from '../src/modules/metadata-fetcher';
import { getActivityVerb, generateActivityId } from '../src/modules/activity-utils';
import { ActivityDiagnostics } from '../src/modules/activity-diagnostics';
import { initializeFileLogger, getFileLogger } from '../src/modules/file-logger';
import { PublishQueue } from '../src/modules/publish-queue';
import { initializeCoWatcherDetector, getCoWatcherDetector } from '../src/modules/co-watcher-detection';
import { initializeSyncHandler, getSyncHandler } from '../src/modules/sync-handler';
import { Friend, NostrEvent, ExtensionMessage, ExtensionResponse, ServiceName, DEFAULT_RELAY_URLS, Message } from '../src/types';

// ============================================================================
// GLOBAL ERROR HANDLING
// ============================================================================

/**
 * Catch unhandled promise rejections from SimplePool/Nostr operations
 * These can occur when relay errors come back asynchronously
 */
globalThis.addEventListener?.('unhandledrejection', (event) => {
  const error = event.reason;
  const errorMsg = error instanceof Error ? error.message : String(error);

  // Log but don't crash on "replaced: have newer event" — it's expected for replaceable kinds
  if (errorMsg.includes('replaced') || errorMsg.includes('have newer event')) {
    console.debug(`[Background] Relay rejected replaceable event (already has newer): ${errorMsg}`);
    event.preventDefault(); // Prevent uncaught error
  } else if (errorMsg.includes('rate-limited')) {
    console.warn(`[Background] Relay rate-limited: ${errorMsg}`);
    event.preventDefault();
  } else {
    console.error(`[Background] Unhandled rejection: ${errorMsg}`, event.reason);
  }
});

// ============================================================================
// GLOBAL STATE (recreated on each service worker restart)
// ============================================================================

let initialized = false;
let activityDetector: ActivityDetector | null = null;
let activityPublisher: ActivityPublisher | null = null;
let messagingManager: MessagingManager | null = null;
let publishQueue: PublishQueue | null = null;
const activeSubscriptions = new Map<string, void>();

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Extension lifecycle: install/update
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[Background] Extension ${details.reason}`);

  if (details.reason === 'install') {
    // Initialize the extension first
    await initializeExtension();

    // First install: generate memorable identifier
    const profile = await storageManager.getUserProfile();
    if (!profile) {
      await getIdentityManager().generateIdentifier();
      console.log('[Background] Generated user identifier');
    }

    // Re-inject into existing tabs (e.g., tabs opened before extension was installed)
    console.log('[Background] Fresh install: re-injecting into any pre-existing tabs...');
    await _reinjectionContentScripts();
  } else if (details.reason === 'update') {
    console.log('[Background] Extension updated, re-injecting content scripts...');
    await _registerContentScripts();
    // Re-inject into all open tabs so new instances can take over
    await _reinjectionContentScripts();
  }
});

/**
 * Extension startup: service worker wakes up after browser restart
 * Re-inject content scripts to reconnect existing tabs
 */
chrome.runtime.onStartup?.addListener(async () => {
  console.log('[Background] Extension startup detected');
  // Re-initialize services on startup (service worker was terminated, globals are reset)
  await initializeExtension();
  console.log('[Background] Extension re-initialized after startup');
  await _reinjectionContentScripts();
});

/**
 * Service worker unload: flush cache to storage before shutdown
 * Ensures durability of recent changes
 */
globalThis.addEventListener?.('beforeunload', () => {
  console.debug('[Background] Service worker unloading, flushing state...');
  // Flush cache and event dedup state
  Promise.all([
    storageManager.forceSyncNow().catch(error => {
      console.error('[Background] Failed to sync cache on unload:', error);
    }),
    persistEventDeduplicatorState().catch(error => {
      console.error('[Background] Failed to persist event dedup on unload:', error);
    })
  ]).catch(() => {
    // Silently ignore errors during shutdown
  });
});

/**
 * Lock to prevent concurrent content script registration attempts
 */
let isRegisteringContentScripts = false;

/**
 * Lock to prevent concurrent initialization attempts
 */
let isInitializing = false;

/**
 * Promise that resolves when initialization completes
 * Allows concurrent calls to wait for the first initialization to finish
 */
let initializationPromise: Promise<void> | null = null;

/**
 * Track fresh content script connections per tab
 * Tab ID -> timestamp of last connection
 */
const freshConnectionTimestamps = new Map<number, number>();

/**
 * Check if content script reconnected after startup
 * If an activity exists but no fresh script has connected within 3 seconds, mark as disconnected
 */
async function _checkForOrphanedActivity(): Promise<void> {
  // Clear stale connections (older than 3 seconds)
  const now = Date.now();
  const staleCutoff = now - 3000;

  for (const [tabId, timestamp] of freshConnectionTimestamps.entries()) {
    if (timestamp < staleCutoff) {
      freshConnectionTimestamps.delete(tabId);
    }
  }

  // If we have no fresh connections at all, mark activity as disconnected
  if (freshConnectionTimestamps.size === 0) {
    try {
      const myActivities = await storageManager.getMyActivities();

      // Find video-tab activity
      const videoActivity = Object.values(myActivities).find(
        (activity: any) => activity?.service === 'video-tab'
      ) as any;

      if (videoActivity && videoActivity.state !== 'disconnected') {
        await _markActivityAsDisconnected(0);
      }
    } catch (err) {
      console.error('[Background] Error checking orphaned activity:', err);
    }
  }
}

/**
 * Register content scripts persistently for all tabs
 * Uses registerContentScripts() which survives extension restart/reload
 */
async function _registerContentScripts(): Promise<void> {
  // Prevent concurrent registration attempts
  if (isRegisteringContentScripts) {
    console.debug('[Background] Content script registration already in progress, skipping');
    return;
  }

  isRegisteringContentScripts = true;

  try {
    if (!chrome.scripting) {
      console.warn('[Background] chrome.scripting not available');
      return;
    }

    // Unregister existing scripts if they exist
    try {
      await chrome.scripting.unregisterContentScripts({
        ids: ['hang-time-video-tracker'],
      });
      console.debug('[Background] Unregistered existing content scripts');
    } catch (err) {
      // Scripts might not be registered yet, that's ok
      console.debug('[Background] No existing scripts to unregister');
    }

    // Register content scripts persistently
    await chrome.scripting.registerContentScripts([
      {
        id: 'hang-time-video-tracker',
        matches: ['https://*/*', 'http://*/*'],
        js: ['content-script.js'],
        runAt: 'document_end',
      },
    ]);

    console.log('[Background] âœ… Content scripts registered persistently');
  } catch (err) {
    console.error('[Background] âŒ Failed to register content scripts:', err instanceof Error ? err.message : String(err));
  } finally {
    isRegisteringContentScripts = false;
  }
}

/**
 * Re-inject content scripts into all open HTTP(S) tabs
 * Called on extension update and startup to ensure seamless reconnection
 * Programmatically executes the content script, triggering orphan detection in old instances
 * For suspended tabs, the injection API succeeds but execution is deferred until tab wakes up
 */
async function _reinjectionContentScripts(): Promise<void> {
  console.log('[Background] ðŸ”„ REINJECTION: Starting content script re-injection...');
  try {
    if (!chrome.scripting) {
      console.error('[Background] âŒ REINJECTION: chrome.scripting API not available');
      return;
    }

    const allTabs = await chrome.tabs.query({
      url: ['http://*/*', 'https://*/*'],
    });

    console.log(`[Background] REINJECTION: Found ${allTabs.length} eligible tabs`);
    if (allTabs.length === 0) {
      console.log('[Background] REINJECTION: No tabs to re-inject into');
      return;
    }

    let successCount = 0;
    let failureCount = 0;
    const suspendedTabs: number[] = [];

    for (const tab of allTabs) {
      if (!tab.id) continue;

      try {
        const tabStatus = tab.status || 'unknown';
        const tabUrl = tab.url || 'unknown';

        // Skip extension pages and special URLs that can't be injected into
        if (tabUrl.startsWith('chrome-extension://') ||
            tabUrl.startsWith('chrome://')) {
          console.debug(`[Background] REINJECTION: Skipping tab ${tab.id} (extension page) - ${tabUrl}`);
          continue;
        }

        console.log(`[Background] REINJECTION: Injecting into tab ${tab.id} (${tabStatus}) - ${tabUrl}`);

        const injectionPromise = chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-script.js'],
        });

        // Longer timeout for suspended tabs (they may take time to respond)
        const timeoutMs = tabStatus === 'unloaded' ? 10000 : 8000;
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Injection timeout after ${timeoutMs}ms`)), timeoutMs)
        );

        await Promise.race([injectionPromise, timeoutPromise]);

        // Note: on suspended tabs, executeScript() succeeds at API level but script runs after tab wakes up
        if (tabStatus === 'unloaded') {
          suspendedTabs.push(tab.id);
          console.log(`[Background] â¸ï¸  REINJECTION: Tab ${tab.id} is suspended - injection queued for when tab becomes active`);
        }

        successCount++;
        console.log(`[Background] âœ… REINJECTION: Successfully injected into tab ${tab.id}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Filter out expected errors that we shouldn't retry
        if (errMsg.includes('Cannot access contents of the page')) {
          console.debug(`[Background] REINJECTION: Tab ${tab.id} denied extension access (Netflix, etc.) - skipping`);
          continue;
        }

        failureCount++;
        console.warn(
          `[Background] âš ï¸  REINJECTION: Failed to inject into tab ${tab.id} (may retry on activation):`,
          errMsg
        );
      }
    }

    console.log(`[Background] ðŸ REINJECTION COMPLETE: ${successCount} successful, ${failureCount} failed${suspendedTabs.length > 0 ? ` (${suspendedTabs.length} suspended tabs queued)` : ''}`);

    // Set up listener to re-inject into suspended tabs when they become active
    if (suspendedTabs.length > 0) {
      const handleTabUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (suspendedTabs.includes(tabId) && changeInfo.status === 'complete') {
          console.log(`[Background] REINJECTION: Suspended tab ${tabId} is now active, content script already injected`);
          suspendedTabs.splice(suspendedTabs.indexOf(tabId), 1);
          if (suspendedTabs.length === 0) {
            chrome.tabs.onUpdated.removeListener(handleTabUpdated);
          }
        }
      };
      chrome.tabs.onUpdated.addListener(handleTabUpdated);
    }
  } catch (err) {
    console.error('[Background] âŒ REINJECTION: Routine failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Hook console methods to forward to FileLogger
 * Every console.log/error/warn/debug call now persists to storage
 */
function _hookConsoleToFileLogger(logger: any): void {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalDebug = console.debug;

  console.log = (...args: any[]) => {
    originalLog(...args);
    try {
      const message = args.map(arg =>
        typeof arg === 'string' ? arg : JSON.stringify(arg)
      ).join(' ');
      logger.log('Console', 'INFO', message);
    } catch {}
  };

  console.error = (...args: any[]) => {
    originalError(...args);
    try {
      const message = args.map(arg =>
        typeof arg === 'string' ? arg : JSON.stringify(arg)
      ).join(' ');
      logger.log('Console', 'ERROR', message);
    } catch {}
  };

  console.warn = (...args: any[]) => {
    originalWarn(...args);
    try {
      const message = args.map(arg =>
        typeof arg === 'string' ? arg : JSON.stringify(arg)
      ).join(' ');
      logger.log('Console', 'WARN', message);
    } catch {}
  };

  console.debug = (...args: any[]) => {
    originalDebug(...args);
    try {
      const message = args.map(arg =>
        typeof arg === 'string' ? arg : JSON.stringify(arg)
      ).join(' ');
      logger.log('Console', 'DEBUG', message);
    } catch {}
  };
}

/**
 * Service worker startup - initialize all systems
 */
async function initializeExtension(): Promise<void> {
  if (initialized) {
    console.debug('[Background] Already initialized');
    return;
  }

  if (isInitializing) {
    console.debug('[Background] Initialization already in progress, waiting...');
    // Return the existing promise so concurrent calls wait for initialization to complete
    if (initializationPromise) {
      return initializationPromise;
    }
  }

  isInitializing = true;

  // Create a promise that resolves when initialization completes
  initializationPromise = (async () => {
    try {
      console.log('[Background] Initializing extension...');

      // ========================================================================
      // PHASE 1: Bootstrap session ID (MUST happen before any namespaced storage)
      // ========================================================================
      try {
        console.debug('[Background] [BOOTSTRAP] Initializing storage...');
        await storageManager.initialize();
        console.debug('[Background] [BOOTSTRAP] Storage initialized');
      } catch (error) {
        console.error('[Background] Storage initialization failed:', error);
        throw error;
      }

      try {
        console.debug('[Background] [BOOTSTRAP] Initializing identity manager...');
        initializeIdentityManager(storageManager);
        console.debug('[Background] [BOOTSTRAP] Identity manager initialized');

        // Generate or load user identifier (which is the UUID)
        const identifier = await getIdentityManager().getIdentifier();
        console.debug(`[Background] [BOOTSTRAP] User identifier: ${identifier}`);

        // Set session ID for storage isolation - this MUST complete before other managers access storage
        await storageManager.setSessionId(identifier);
        console.debug('[Background] [BOOTSTRAP] ✅ Session ID ready - other managers can now access namespaced storage');
      } catch (error) {
        console.error('[Background] Identity initialization failed:', error);
        throw error;
      }

      // ========================================================================
      // PHASE 2: Initialize managers that depend on namespaced storage
      // ========================================================================
      console.debug('[Background] [PHASE 2] Starting manager initialization...');

      // Initialize file logger for debugging (captures console logs to storage)
      try {
        const userProfile = await storageManager.getUserProfile();
        const profileId = userProfile?.uuid || 'unknown';
        initializeFileLogger(profileId, storageManager);
        const logger = getFileLogger();
        _hookConsoleToFileLogger(logger);
      } catch (error) {
        console.error('[Background] File logger initialization failed:', error);
        // Don't fail extension startup if logger fails
      }

      // Re-inject content scripts if we detect orphaned scripts from before restart
      // Check if there's activity data in storage (indicates scripts were running before restart)
      // Register content scripts persistently on startup
      // This ensures scripts are available for all current and future tabs
      try {
        await _registerContentScripts();
      } catch (error) {
        console.error('[Background] Failed to register content scripts on startup:', error);
      }

      // Check after 3 seconds if fresh content script connected
      // If not, mark existing video-tab activity as disconnected (means it's from orphaned script)
      console.log('[Background] Scheduling orphaned activity check in 3 seconds...');
      setTimeout(async () => {
        console.log('[Background] 3-second timeout fired, checking for orphaned activity');
        await _checkForOrphanedActivity();
      }, 3000);

    // Initialize friend manager (depends on namespaced storage)
    initializeFriendManager(storageManager);
    console.debug('[Background] [PHASE 2] Friend manager initialized');

    // Initialize Nostr relay pool (required for messaging and activity sync)
    try {
      console.debug(`[Background] Connecting to Nostr relays...`);
      // Load relay configuration from user profile
      const profile = await storageManager.getUserProfile();
      let relayUrls: string[] = RelayPool.DEFAULT_RELAYS;

      // Ensure stored relays match DEFAULT_RELAYS (source of truth)
      if (profile && profile.publisher_config) {
        const expectedRelays = Object.fromEntries(
          DEFAULT_RELAY_URLS.map(url => [url.replace('wss://', '').replace('ws://', '').replace(/\/$/, ''), true])
        );

        // Check if stored relays differ from defaults
        const storedRelays = profile.publisher_config.relays || {};
        const needsSync = JSON.stringify(storedRelays) !== JSON.stringify(expectedRelays);

        if (needsSync) {
          console.debug(`[Background] Syncing relay config to defaults`);
          profile.publisher_config.relays = expectedRelays;
          await storageManager.setUserProfile(profile);
        }
      }

      if (profile && profile.publisher_config && profile.publisher_config.relays) {
        // Filter to only enabled relays
        const enabledRelays = Object.entries(profile.publisher_config.relays)
          .filter(([, enabled]) => enabled)
          .map(([domain]) => {
            // Convert domain to full relay URL
            if (domain.startsWith('wss://') || domain.startsWith('ws://')) {
              return domain;
            }
            return `wss://${domain}/`;
          });

        if (enabledRelays.length > 0) {
          relayUrls = enabledRelays;
          console.debug(`[Background] Using configured relays from publisher_config (${enabledRelays.length} relays)`);
        }
      }

      console.debug(`[Background] Relay URLs: ${JSON.stringify(relayUrls)}`);
      // Set storage manager for persisting subscription timestamps
      relayPool.setStorageManager(storageManager);
      await relayPool.connect(relayUrls);
      console.debug(`[Background] Connected to Nostr (${relayPool.getConnectedRelayCount()} relays)`);
    } catch (error) {
      console.warn('[Background] Failed to connect to relays, will retry in background:', error);
      // Continue initialization - relays will reconnect automatically
    }

    // Initialize messaging manager
    initializeMessagingManager(storageManager, getIdentityManager(), relayPool);
    messagingManager = getMessagingManager();
    console.debug('[Background] Messaging manager initialized');

    // Initialize notification manager
    initializeNotificationManager(storageManager);
    console.debug('[Background] Notification manager initialized');

    // Initialize event deduplicator (restores from storage to prevent duplicates after reload)
    await initializeEventDeduplicator();
    console.debug('[Background] Event deduplicator initialized');

    // Initialize activity datastore (validates all activity writes)
    initializeActivityDatastore(storageManager);
    console.debug('[Background] Activity datastore initialized');

    // Initialize game library manager
    initializeGameLibraryManager(storageManager);
    console.debug('[Background] Game library manager initialized');

    // Set Nostr dependencies for game library manager
    const gameLibraryManager = GameLibraryManager.getInstance(storageManager);
    gameLibraryManager.setNostrDependencies(relayPool, getIdentityManager());
    console.debug('[Background] Game library manager Nostr dependencies set');

    // Fetch user's game library (enabled by default for MVP)
    let userGames: any[] = [];
    try {
      userGames = await gameLibraryManager.fetchMyGameLibrary();
      console.debug('[Background] Fetched user game library');
    } catch (error) {
      console.warn('[Background] Failed to fetch game library:', error);
    }

    // Initialize metadata fetcher and start background fetcher
    initializeMetadataFetcher(storageManager);
    console.debug('[Background] Metadata fetcher initialized');
    await metadataFetcher.startBackgroundFetcher();
    console.debug('[Background] Metadata background fetcher started');

    // Check for games missing metadata and queue them
    if (userGames.length > 0) {
      const gamesNeedingMetadata = await _findGamesMissingMetadata(userGames);
      if (gamesNeedingMetadata.length > 0) {
        console.debug(`[Background] Found ${gamesNeedingMetadata.length}/${userGames.length} games missing metadata, scheduling fetch`);
        await metadataFetcher.scheduleBackgroundRefresh(gamesNeedingMetadata);
      } else {
        console.debug(`[Background] All ${userGames.length} games have metadata`);
      }
    }

    // Initialize activity detector
    activityDetector = new ActivityDetector(storageManager);

    // Register all service modules
    activityDetector.registerService('spotify-api', new SpotifyService(storageManager));
    activityDetector.registerService('twitch-api', new TwitchService(storageManager));
    activityDetector.registerService('steam-api', new SteamService(storageManager));
    // TODO: Register 'discord-api' when DiscordService is implemented
    // TabService now reads from storage (written by content scripts)
    activityDetector.registerService('tabs', new TabService(storageManager));

    console.debug('[Background] Services registered');

    await activityDetector.start();
    console.debug('[Background] Activity detector started');

    // Initialize activity publisher (publishes to Nostr)
    try {
      activityPublisher = new ActivityPublisher(relayPool, storageManager, getIdentityManager());
      console.debug('[Background] ActivityPublisher created');
      await activityPublisher.start();
      console.debug('[Background] Activity publisher started');
    } catch (error) {
      console.error('[Background] Failed to initialize activity publisher:', error);
    }

    // Initialize and start unified publish queue BEFORE publishing profile
    // This ensures all publishes go through the queue from startup
    try {
      const profile = await storageManager.getUserProfile();
      const publishIntervalMs = profile?.publisher_config?.rate_ms || 12000;
      publishQueue = new PublishQueue(relayPool, storageManager, publishIntervalMs);
      publishQueue.setIdentityManager(getIdentityManager());
      publishQueue.start();
      console.log('[Background] PublishQueue initialized and started');

      // Wire up managers to use the queue
      const msgMgr = getMessagingManager();
      msgMgr.setPublishQueue(publishQueue);
      console.debug('[Background] MessagingManager wired to PublishQueue');

      if (activityPublisher) {
        activityPublisher.setPublishQueue(publishQueue);
        publishQueue.setActivityPublisher(activityPublisher);
        console.debug('[Background] ActivityPublisher â†” PublishQueue wired bidirectionally');
      }

      const gameLibMgr = GameLibraryManager.getInstance(storageManager);
      gameLibMgr.setPublishQueue(publishQueue);
      console.debug('[Background] GameLibraryManager wired to PublishQueue');

      // Publish user profile on startup (now that queue is ready)
      if (activityPublisher) {
        await activityPublisher.publishProfile();
      }
    } catch (error) {
      console.error('[Background] Failed to initialize publish queue or publish profile:', error);
    }

    // Subscribe to all friends' activities
    console.log('[Background] ðŸ“§ About to subscribe to friends...');
    const friendManager = getFriendManager();
    const friends = await friendManager.getAllFriends();
    console.log(`[Background] ðŸ“§ Subscribing to ${friends.length} friends`);
    for (const friend of friends) {
      try {
        await _subscribeToFriend(friend.uuid);
      } catch (error) {
        console.warn(`[Background] Failed to subscribe to friend ${friend.uuid}:`, error);
      }
    }
    console.log('[Background] ðŸ“§ Done subscribing to friends');

    // Subscribe to friends' game libraries for discovery
    try {
      const friendPubkeys = friends.map((f) => friendManager.derivePubkeyFromIdentifier(f.uuid));
      if (friendPubkeys.length > 0) {
        await gameLibraryManager.subscribeToFriendGames(friendPubkeys);
        console.debug(`[Background] Subscribed to ${friendPubkeys.length} friends' game libraries`);
      }
    } catch (error) {
      console.warn('[Background] Failed to subscribe to friend game libraries:', error);
    }

    // Subscribe to incoming kind 1059 (encrypted DM) messages
    console.log('[Background] ðŸ”” Setting up incoming message subscription...');
    try {
      await _subscribeToIncomingMessages();
      console.log('[Background] âœ… Incoming message subscription active');
    } catch (error) {
      console.error('[Background] âŒ Failed to set up incoming message subscription:', error);
    }

    // Run initial integrity check
    try {
      const datastore = getActivityDatastore();
      const summary = await datastore.getSummary();
      console.log('[Background] Activity integrity:', summary);
    } catch (error) {
      console.warn('[Background] Could not run initial integrity check:', error);
    }

    // Initialize co-watcher detection (for overlay)
    try {
      initializeCoWatcherDetector(storageManager, friendManager);
      console.debug('[Background] Co-watcher detector initialized');
    } catch (error) {
      console.error('[Background] Failed to initialize co-watcher detector:', error);
    }

    // Initialize sync handler (for playback sync)
    try {
      initializeSyncHandler(relayPool, storageManager, getIdentityManager(), friendManager);
      if (publishQueue) {
        getSyncHandler().setPublishQueue(publishQueue);
      }
      console.debug('[Background] Sync handler initialized');
    } catch (error) {
      console.error('[Background] Failed to initialize sync handler:', error);
    }

    console.log('[Background] Initialization complete');

    // Register message handlers for debugging
    _registerMessageHandlers();

    // Start periodic integrity checks and cleanup
    _startPeriodicCleanup();

    // Start storage cache sync cycle
    _startCacheSyncCycle();

    // Start co-watcher detection cycle
    _startCoWatcherDetectionCycle();

    // Start integration health monitoring
    _startIntegrationHealthCheck();

      // Mark initialization as complete only after everything succeeds
      initialized = true;
    } catch (error) {
      console.error('[Background] Initialization failed:', error);
      throw error;
    } finally {
      isInitializing = false;
      initializationPromise = null;
    }
  })();

  // Wait for the initialization to complete
  return initializationPromise;
}

/**
 * Periodic cleanup: Run integrity checks and remove corrupted/ghost activities
 * Also removes expired invites (older than 2 hours) and stale Netflix titles (older than 24 hours)
 * Runs every 5 minutes to catch any data corruption that slips through validation
 */
function _startPeriodicCleanup(): void {
  const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  setInterval(async () => {
    try {
      const datastore = getActivityDatastore();
      const { corruptedRemoved, ghostsRemoved } = await datastore.cleanup();

      // Also remove expired invites (2+ hours old)
      const expiredInvites = await storageManager.removeExpiredInvites();

      // Remove stale Netflix titles (24+ hours old)
      const staleNetflixTitles = await storageManager.removeStaleNetflixTitle();

      // Persist event deduplicator state to storage
      const { getEventDeduplicator } = await import('../src/modules/event-deduplicator');
      const dedup = getEventDeduplicator();
      const processedEventIds = dedup.getProcessedEventIds();
      await storageManager.setProcessedEventIds(processedEventIds);

      if (corruptedRemoved > 0 || ghostsRemoved > 0 || expiredInvites > 0 || staleNetflixTitles > 0) {
        console.log('[Background] ðŸ§¹ Cleanup cycle complete:', {
          corruptedRemoved,
          ghostsRemoved,
          expiredInvites,
          staleNetflixTitles,
        });
      } else {
        console.debug('[Background] Cleanup cycle: no issues found');
      }
    } catch (error) {
      console.error('[Background] Cleanup cycle failed:', error);
    }
  }, CLEANUP_INTERVAL_MS);

  console.debug('[Background] Periodic cleanup started (every 5 minutes)');
}

/**
 * Storage Cache Sync Cycle
 * Relies on scheduleSyncToStorage() debouncing from writes
 * This function is a placeholder for future explicit sync needs
 */
function _startCacheSyncCycle(): void {
  // Sync is triggered by scheduleSyncToStorage() on cache writes
  // No need for a separate interval - the debouncing handles it
  console.debug('[Background] Storage cache sync ready (debounced on writes)');
}

/**
 * Co-Watcher Detection Cycle
 * Runs every 5 seconds to detect which friends are watching the same activity
 * Updates the overlay with co-watcher info and determines host
 */
function _startCoWatcherDetectionCycle(): void {
  const DETECTION_INTERVAL_MS = 5000; // 5 seconds, synced with activity detection

  let callCount = 0;
  setInterval(async () => {
    callCount++;
    if (callCount <= 3 || callCount % 100 === 0) {
      console.debug(`[Background] Co-watcher cycle #${callCount} firing`);
    }
    try {
      const detector = getCoWatcherDetector();
      const activitySession = await detector.detectCoWatchSession();
      let persistentSession = await detector.getCurrentCoWatchSession();

      // Send CO_WATCH_UPDATE if either:
      // 1. Activity match found (co-watchers on same video), OR
      // 2. Persistent session active (co-watchers diverged but still in session)
      // This ensures overlay stays active and messages flow even during divergence
      if (activitySession || persistentSession) {
        // If there's a new activity match, update the persistent session with it
        if (activitySession) {
          await detector.setCurrentCoWatchSession(activitySession);
          await detector.createOrUpdateUserSession(activitySession);
          // Reload persisted session to get updated co_watchers/activity info
          persistentSession = await detector.getCurrentCoWatchSession();
        }

        // Get the session to broadcast (use persistent session as source of truth)
        const coWatchSession = persistentSession;

        if (activitySession) {
          console.debug('[Background] Activity match found, updated session:', { activity_id: coWatchSession?.activity_id, co_watchers: coWatchSession?.co_watchers.length });
        } else {
          console.debug('[Background] No activity match, using persistent session for diverged state');
        }

        if (!coWatchSession) {
          console.warn('[Background] Session became null after update, skipping broadcast');
          return;
        }

        // Get host friend name and activity for overlay
        let hostName = '?';
        let hostFriend: any = null;

        if (coWatchSession.host_friend_uuid === 'self') {
          const profile = await storageManager.getUserProfile();
          // Use nickname if set, else uuid
          hostName = profile?.nickname || profile?.uuid || 'You';
        } else {
          hostFriend = await getFriendManager().getFriend(coWatchSession.host_friend_uuid);
          // Use local_name (the nickname the user gave this friend)
          hostName = hostFriend?.local_name || '?';
        }

        // Get activity title and position from host friend's activities
        let videoTitle = 'Loading video...';
        let hostPosition: number | undefined;
        let hostPositionTimestamp: number | undefined;
        let hostState: string | undefined;
        let videoDuration: number | undefined;

        let userPosition: number | undefined;
        let userActivity: any = undefined;
        const myActivities = await storageManager.getMyActivities();

        if (coWatchSession.host_friend_uuid === 'self') {
          // Host is self: use my activity from myActivities (where content script stores it)
          const hostActivity = myActivities?.[coWatchSession.activity_id];

          // Skip disconnected activities (no overlay should persist after tab closes)
          if (hostActivity?.state === 'disconnected') {
            console.debug(`[Background] Skipping disconnected activity: ${coWatchSession.activity_id}`);
            return;
          }

          if (hostActivity?.content) {
            videoTitle = hostActivity.content;
            videoDuration = hostActivity.metadata?.duration;
            hostState = hostActivity.state;
            // Use host's measurement time (progress_measured_at) so guests can accurately interpolate where host is now
            if (hostActivity?.metadata?.progress !== undefined) {
              hostPosition = hostActivity.metadata.progress;
              hostPositionTimestamp = hostActivity.metadata.progress_measured_at || Date.now(); // When host's content script measured their progress
            }
            // User position is same as host position when user is host
            userPosition = hostActivity.metadata?.progress;
            userActivity = hostActivity;
          }
        } else if (hostFriend?.current_activities) {
          // Host is friend: use friend's activity
          const hostActivity = Object.values(hostFriend.current_activities).find(a => a?.id === coWatchSession.activity_id);
          if (hostActivity && hostActivity.content) {
            videoTitle = hostActivity.content;
            videoDuration = hostActivity.metadata?.duration;
            hostState = hostActivity.state;
            // Use host's measurement time (progress_measured_at) so guests can accurately interpolate where host is now
            if (hostActivity?.metadata?.progress !== undefined) {
              hostPosition = hostActivity.metadata.progress;
              hostPositionTimestamp = hostActivity.metadata.progress_measured_at || Date.now(); // When host's content script measured their progress
            }
          }
          // Get user's position for this same activity from myActivities
          userActivity = myActivities?.[coWatchSession.activity_id];
          if (userActivity?.metadata?.progress !== undefined) {
            userPosition = userActivity.metadata.progress;
          }
        }

        // Build watching_together list: all co_watchers as UUIDs (for color mapping consistency)
        const watchingTogether: string[] = [];
        const friendManager = getFriendManager();
        const profile = await storageManager.getUserProfile();
        const selfUuid = profile?.uuid;
        const guestProgress: Record<string, number> = {}; // UUID -> progress in seconds

        for (const coWatcherId of coWatchSession.co_watchers) {
          // Check if this co-watcher is actually on the current activity
          let isOnCurrentActivity = false;

          if (coWatcherId === selfUuid) {
            // User is on current activity if they have matching activity
            isOnCurrentActivity = !!userActivity;
          } else {
            // Friend is on current activity if they're watching coWatchSession.activity_id
            const friend = await friendManager.getFriend(coWatcherId);
            if (friend?.current_activities) {
              const friendActivity = Object.values(friend.current_activities).find(a => a?.id === coWatchSession.activity_id);
              isOnCurrentActivity = !!friendActivity;
            }
          }

          // Only add to watching_together if on the same activity
          if (isOnCurrentActivity) {
            watchingTogether.push(coWatcherId);
          }

          // Collect guest progress for marker updates (only if on same activity)
          if (isOnCurrentActivity) {
            if (coWatcherId === selfUuid) {
              // User's progress
              if (userActivity?.metadata?.progress !== undefined) {
                guestProgress[coWatcherId] = userActivity.metadata.progress;
              }
            } else {
              // Guest progress from friend's current activity
              const friend = await friendManager.getFriend(coWatcherId);
              if (friend?.current_activities) {
                const guestActivity = Object.values(friend.current_activities).find(a => a?.id === coWatchSession.activity_id);
                if (guestActivity?.metadata?.progress !== undefined) {
                  guestProgress[coWatcherId] = guestActivity.metadata.progress;
                }
              }
            }
          }
        }

        // Get recent messages for this session (unified message model)
        const recentMessages: Array<{
          id: string;
          sender: string;
          sender_id: string;
          content: string;
          timestamp: number;
        }> = [];

        try {
          // Query all session messages (not activity-scoped)
          const userUuid = profile?.uuid;
          const sessionMessages = userUuid ? await storageManager.getVisibleMessages(userUuid, coWatchSession.co_watchers) : [];
          console.log('[Background] [MESSAGE_FLOW] CO_WATCH_UPDATE query: session_id=' + coWatchSession?.session_id + ' found=' + sessionMessages.length + ' visible messages');
          if (sessionMessages && sessionMessages.length > 0) {
            console.log('[Background] [MESSAGE_FLOW]   Messages found:', sessionMessages.map(m => ({
              from: m.from,
              content: m.content?.substring(0, 20)
            })));

            // Build a map of friend UUIDs to names for quick lookup
            const friendMap = new Map<string, string>();
            if (profile) {
              friendMap.set(profile.uuid, profile.nickname || 'You');
            }

            for (const coWatcherId of coWatchSession.co_watchers) {
              if (coWatcherId === profile?.uuid) continue;
              const friend = await friendManager.getFriend(coWatcherId);
              if (friend) {
                friendMap.set(friend.uuid, friend.local_name);
              }
            }

            // Filter messages and map to display format (keep last 20 messages)
            const recentSessionMessages = sessionMessages.slice(-20);
            for (const msg of recentSessionMessages) {
              const senderName = friendMap.get(msg.from) || msg.from || 'Unknown';
              recentMessages.push({
                id: msg.id,
                sender: senderName,
                sender_id: msg.from,
                content: msg.content,
                timestamp: msg.timestamp,
              });
            }
            console.log(`[Background] [MESSAGE_FLOW] CO_WATCH_UPDATE total messages: ${recentMessages.length}`);
          }

          // Sort by timestamp and deduplicate
          const deduped = new Map<string, any>();
          recentMessages.forEach(msg => {
            const key = `${msg.content}_${msg.timestamp}`; // Rough dedup
            if (!deduped.has(key)) {
              deduped.set(key, msg);
            }
          });
          recentMessages.length = 0;
          recentMessages.push(...Array.from(deduped.values()));
          recentMessages.sort((a, b) => a.timestamp - b.timestamp);

          // DEBUG: Log what messages are being broadcast
          if (recentMessages.length > 0) {
            console.log('[Background] [MESSAGE_FLOW] CO_WATCH_UPDATE total messages to broadcast: ' + recentMessages.length);
            console.debug('[Background] CO_WATCH_UPDATE messages:', recentMessages.map(m => ({
              sender: m.sender,
              sender_id: m.sender_id,
              content: m.content?.substring(0, 30),
              timestamp: m.timestamp
            })));
          }
        } catch (e) {
          console.debug('[Background] Failed to get messages for overlay:', e);
        }

        // Broadcast to all connected content scripts
        console.debug(`[Background] Broadcasting CO_WATCH_UPDATE to ${activeContentScriptPorts.size} content scripts`);
        for (const [tabId, port] of activeContentScriptPorts.entries()) {
          try {
            // Build nicknameMap to send to content-script (so it has complete participant info)
            const broadcastNicknameMap: Record<string, string> = {};
            if (profile) {
              broadcastNicknameMap[profile.uuid] = profile.nickname || 'You';
            }
            const allFriends = await friendManager.getAllFriends();
            console.log(`[Background] [MESSAGE_FLOW] Available friends in storage:`, allFriends.map(f => ({ uuid: f.uuid, local_name: f.local_name })));
            console.log(`[Background] [MESSAGE_FLOW] Building nicknameMap. self=${profile?.uuid}, co_watchers=[${coWatchSession.co_watchers.join(', ')}]`);

            for (const coWatcherId of coWatchSession.co_watchers) {
              if (coWatcherId === profile?.uuid) {
                console.debug(`[Background] [MESSAGE_FLOW] Skipping self in co_watchers: ${coWatcherId}`);
                continue;
              }
              const coWatcherFriend = await friendManager.getFriend(coWatcherId);
              console.log(`[Background] [MESSAGE_FLOW] Lookup co-watcher ${coWatcherId.slice(0, 20)}...`, {
                found: !!coWatcherFriend,
                local_name: coWatcherFriend?.local_name,
                uuid: coWatcherFriend?.uuid
              });

              if (coWatcherFriend) {
                broadcastNicknameMap[coWatcherId] = coWatcherFriend.local_name;
                console.debug(`[Background] [MESSAGE_FLOW] Added co-watcher to nicknameMap: ${coWatcherId} => ${coWatcherFriend.local_name}`);
              } else {
                console.warn(`[Background] [MESSAGE_FLOW] Friend lookup FAILED for co-watcher: ${coWatcherId.slice(0, 20)}... - not in friends list`);
              }
            }
            // Also add all message senders to the nicknameMap
            for (const msg of recentMessages) {
              if (msg.sender_id && !broadcastNicknameMap[msg.sender_id]) {
                const messageSenderFriend = await friendManager.getFriend(msg.sender_id);
                if (messageSenderFriend) {
                  broadcastNicknameMap[msg.sender_id] = messageSenderFriend.local_name;
                  console.debug(`[Background] [MESSAGE_FLOW] Added message sender to nicknameMap: ${msg.sender_id} => ${messageSenderFriend.local_name}`);
                } else {
                  console.warn(`[Background] [MESSAGE_FLOW] Friend lookup failed for message sender: ${msg.sender_id}`);
                }
              }
            }

            console.log('[Background] [MESSAGE_FLOW] CO_WATCH_UPDATE data:', {
              host_progress: hostPosition,
              host_progress_timestamp: hostPositionTimestamp,
              user_progress: userPosition,
              host_duration: videoDuration,
              is_user_host: coWatchSession.host_friend_uuid === 'self',
            });
            console.log(`[Background] [MESSAGE_FLOW] watching_together: [${watchingTogether.join(', ')}], co_watchers: [${coWatchSession.co_watchers.join(', ')}]`);
            // Get host friend's activity freshness for content-script first-show check
            let hostActivityFreshness: number | undefined;
            if (coWatchSession.host_friend_uuid !== 'self' && hostFriend?.current_activities) {
              const hostActivity = Object.values(hostFriend.current_activities).find(a => a?.id === coWatchSession.activity_id);
              hostActivityFreshness = hostActivity?.freshness_timestamp;
            }

            // Build co-watcher activities map for divergence display (includes self + others)
            const coWatcherActivities: Record<string, {activity_id: string; content: string; service?: string}> = {};

            // Add self's activity (needed when user is host, so host title can be shown)
            if (userActivity && selfUuid) {
              coWatcherActivities[selfUuid] = {
                activity_id: userActivity.id || '',
                content: userActivity.content || videoTitle || '',
                service: userActivity.service || '',
              };
            }

            for (const coWatcherId of coWatchSession.co_watchers) {
              if (coWatcherId === selfUuid) continue; // Skip self (already added above)

              const friend = await friendManager.getFriend(coWatcherId);
              if (friend?.current_activities) {
                // Get the friend's current activity (they might be on a different one than host)
                const friendActivities = Object.values(friend.current_activities);
                if (friendActivities.length > 0) {
                  const friendActivity = friendActivities[0]; // Most recent/only activity
                  if (friendActivity) {
                    coWatcherActivities[coWatcherId] = {
                      activity_id: friendActivity.id || '',
                      content: friendActivity.content || '',
                      service: friendActivity.service || '',
                    };
                  }
                }
              }
            }

            console.debug('[Background] [MESSAGE_FLOW] CO_WATCH_UPDATE broadcastNicknameMap:', broadcastNicknameMap);
            console.debug('[Background] [MESSAGE_FLOW] CO_WATCH_UPDATE watching_together:', watchingTogether);
            console.debug('[Background] [MESSAGE_FLOW] CO_WATCH_UPDATE co_watcher_activities:', Object.keys(coWatcherActivities));
            port.postMessage({
              type: 'CO_WATCH_UPDATE',
              data: {
                activity_id: coWatchSession.activity_id,
                host_nickname: hostName,
                watching_together: watchingTogether,
                host_progress: hostPosition,
                host_progress_timestamp: hostPositionTimestamp,
                host_state: hostState,
                host_duration: videoDuration,
                user_progress: userPosition,
                guest_progress: guestProgress,
                host_activity_freshness_timestamp: hostActivityFreshness,
                is_user_host: coWatchSession.host_friend_uuid === 'self',
                messages: recentMessages,
                nicknameMap: broadcastNicknameMap,
                co_watcher_activities: coWatcherActivities,
              },
            });
            console.log(`[Background] [MESSAGE_FLOW] ✅ Sent CO_WATCH_UPDATE with ${recentMessages.length} messages`);
          } catch (e) {
            console.debug(`[Background] Failed to send CO_WATCH_UPDATE to tab ${tabId}:`, e);
          }
        }

        console.debug('[Background] Co-watch session detected:', {
          activity_id: coWatchSession.activity_id,
          host: hostName,
          co_watchers_count: coWatchSession.co_watchers.length,
        });
      }
      // Note: We do NOT clear the persistent session when no activity match is found.
      // The session remains active even during divergence (when co-watchers are on different activities).
      // Only explicitly leaving (LEAVE_SESSION) clears it.
    } catch (error) {
      console.error('[Background] Co-watcher detection cycle error:', error);
    }
  }, DETECTION_INTERVAL_MS);

  console.debug('[Background] Co-watcher detection cycle started (every 5 seconds)');
}

/**
 * Integration Health Monitoring (Steam, Spotify, Twitch, Discord)
 * Pings each configured integration every 30 seconds to check if working
 */
function _startIntegrationHealthCheck(): void {
  const HEALTH_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

  setInterval(async () => {
    try {
      const profile = await storageManager.getUserProfile();
      if (!profile) return;

      // Check Steam API
      if (profile.steam_config?.api_key) {
        try {
          const steamApiUrl = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/';

          // If we have a steamid, use it to get personaname
          let personaname: string | undefined;
          if (profile.steam_config.steam_id) {
            const response = await fetch(`${steamApiUrl}?key=${profile.steam_config.api_key}&steamids=${profile.steam_config.steam_id}`, {
              method: 'GET',
              mode: 'cors',
            });

            if (response.ok) {
              const data = await response.json();
              if (data.response?.players?.[0]) {
                personaname = data.response.players[0].personaname;
              }
            }
          } else {
            // No steamid, just verify key works
            const response = await fetch(`${steamApiUrl}?key=${profile.steam_config.api_key}&steamids=76561198`, {
              method: 'GET',
              mode: 'cors',
            });

            if (response.ok) {
              const data = await response.json();
              if (data.response) {
                // Key is valid
              }
            }
          }

          const isHealthy = true;
          await storageManager.updateIntegrationHealth('steam-api', isHealthy, personaname);
          console.debug(`[Background] Steam API health: âœ… Healthy${personaname ? ` (${personaname})` : ''}`);
        } catch (error) {
          await storageManager.updateIntegrationHealth('steam-api', false);
          console.debug(`[Background] Steam API check failed:`, error instanceof Error ? error.message : error);
        }
      }

      // TODO: Add Spotify, Twitch, Discord health checks later
    } catch (error) {
      console.error('[Background] Integration health check cycle failed:', error);
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  console.debug('[Background] Integration health monitoring started (every 30 seconds)');
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================
// PORT TRACKING - Track which tabs have active content script connections
// ============================================================================

const activeContentScriptPorts = new Map<number, chrome.runtime.Port>();
const connectedTabIds = new Set<number>(); // Track tabs that have successfully connected at least once
const failedInjectionAttempts = new Map<number, number>(); // Track retry attempts per tab

/**
 * Port-based connection handler for content script â†” background communication
 * Tracks connections and detects when content scripts disconnect (e.g., after extension restart)
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith('content-script-')) {
    const service = port.name.replace('content-script-', '');
    // MV3: tab info is nested under port.sender.tab, not port.sender.tabId
    const tabId = port.sender?.tab?.id;
    const url = port.sender?.url;

    if (tabId !== undefined) {
      activeContentScriptPorts.set(tabId, port);
      connectedTabIds.add(tabId); // Mark this tab as successfully connected
      failedInjectionAttempts.delete(tabId); // Clear any retry counter
      freshConnectionTimestamps.set(tabId, Date.now()); // Track this tab's fresh connection
      console.log(`[Background] âœ… Content script connected for tab ${tabId} (${service})`);
    } else {
      console.error(`[Background] âŒ Content script connected but no tab ID: ${service} (url: ${url?.substring(0, 60)})`);
    }

    port.onMessage.addListener(async (message) => {
      try {
        if (message.type === 'PING') {
          // Keep-alive ping from content script, reply with PONG
          try {
            port.postMessage({ type: 'PONG' });
          } catch (e) {
            console.debug(`[Background] Failed to send PONG:`, e);
          }
        } else if (message.type === 'GET_USER_ID') {
          // Content script requesting user ID for overlay
          try {
            const profile = await storageManager.getUserProfile();
            port.postMessage({ type: 'USER_ID', data: profile?.uuid || 'unknown' });
          } catch (e) {
            console.debug(`[Background] Failed to send USER_ID:`, e);
          }
        } else if (message.type === 'SYNC_REQUEST') {
          // Content script sync button was clicked
          try {
            const syncHandler = getSyncHandler();
            const detector = getCoWatcherDetector();
            const coWatchSession = await detector.getCurrentCoWatchSession();

            if (coWatchSession) {
              console.debug('[Background] Sending sync request for activity:', coWatchSession.activity_id);
              await syncHandler.sendSyncRequest(coWatchSession.host_friend_uuid, coWatchSession.activity_id);
            } else {
              console.debug('[Background] No co-watch session active for sync request');
            }
          } catch (e) {
            console.error('[Background] Failed to handle sync request:', e);
          }
        } else if (message.type === 'OPEN_DISCORD') {
          // Discord button was clicked
          try {
            const detector = getCoWatcherDetector();
            const hostDetails = await detector.getHostFriendDetails();
            if (hostDetails) {
              console.debug('[Background] Opening Discord for host:', hostDetails.local_name);
              // TODO: Get Discord link and open it
            }
          } catch (e) {
            console.error('[Background] Failed to handle Discord button:', e);
          }
        } else if (message.type === 'GET_ACTIVITY_CONTENT_TIMESTAMP') {
          // Content script is checking if we have an existing contentTimestamp for this activity in StorageManager
          const activityId = message.data?.activityId;
          if (activityId && port) {
            const myActivities = await storageManager.getMyActivities();
            const activity = myActivities?.[activityId];
            const timestamp = activity?.contentTimestamp || null;
            console.debug(`[TimestampMigration] GET_ACTIVITY_CONTENT_TIMESTAMP: activityId=${activityId}, found=${!!activity}, contentTimestamp=${timestamp}`);
            port.postMessage({
              type: 'ACTIVITY_CONTENT_TIMESTAMP',
              data: {
                activityId: activityId,
                contentTimestamp: timestamp,
              },
            });
          }
        } else if (message.type === 'GET_ACTIVITY_MESSAGES_FOR_OVERLAY') {
          // Content script requesting initial messages for activity (on page reload)
          const activityId = message.data?.activityId;
          if (activityId && port) {
            try {
              const recentMessages: any[] = [];
              const profile = await storageManager.getUserProfile();

              console.log('[Background] [MESSAGE_FLOW] GET_ACTIVITY_MESSAGES_FOR_OVERLAY: activityId=' + activityId);
              // Query ALL messages for this activity (activity-centric storage)
              const activityMessages = await storageManager.getActivityMessages(activityId);
              console.log('[Background] [MESSAGE_FLOW]   Found ' + (activityMessages?.length || 0) + ' messages');
              if (activityMessages && activityMessages.length > 0) {
                // Build a map of UUIDs to display names
                const nameMap = new Map<string, string>();
                if (profile) {
                  nameMap.set(profile.uuid, profile.nickname || 'You');
                }

                // Only fetch friends who are actually in messages for this activity (more efficient)
                const senderIds = new Set(activityMessages.map(msg => msg.sender_identifier));
                const friendManager = getFriendManager();
                for (const senderId of senderIds) {
                  if (senderId !== profile?.uuid) { // Skip self (already in map)
                    const friend = await friendManager.getFriend(senderId);
                    if (friend) {
                      nameMap.set(friend.uuid, friend.local_name);
                    }
                  }
                }

                // Map messages to display format (load all messages)
                for (const msg of activityMessages) {
                  const senderName = nameMap.get(msg.sender_identifier) || msg.sender_identifier || 'Unknown';
                  recentMessages.push({
                    id: msg.id,
                    sender: senderName,
                    sender_id: msg.sender_identifier,
                    content: msg.content,
                    timestamp: msg.timestamp,
                  });
                }
              }

              // Sort by timestamp
              recentMessages.sort((a, b) => a.timestamp - b.timestamp);

              console.debug('[Background] Sending', recentMessages.length, 'initial messages for activity', activityId);
              port.postMessage({
                type: 'ACTIVITY_MESSAGES',
                data: { messages: recentMessages },
              });
            } catch (e) {
              console.error('[Background] Error loading initial messages:', e);
            }
          }
        } else if (message.type === 'GET_OVERLAY_STATE') {
          // Content script requesting current overlay state for on-demand hydration
          try {
            // Ensure extension is initialized before accessing detector
            if (!initialized) {
              await initializeExtension();
            }
            const detector = getCoWatcherDetector();
            const coWatchSession = await detector.getCurrentCoWatchSession();

            if (!coWatchSession) {
              console.debug('[Background] GET_OVERLAY_STATE: No active co-watch session');
              port.postMessage({
                type: 'OVERLAY_STATE',
                data: null,
              });
              return;
            }

            console.log('[Background] GET_OVERLAY_STATE: Building state for activity', coWatchSession.activity_id);

            // Get co-watcher data (same as CO_WATCH_UPDATE builds)
            const friendManager = getFriendManager();
            const userProfile = await storageManager.getUserProfile();

            // Build overlay state (parallel to CO_WATCH_UPDATE logic)
            let hostName = '';
            let hostState = '';
            let hostPosition = 0;
            let hostPositionTimestamp = 0;
            let videoDuration = 0;
            let userPosition = 0;
            const guestProgress: Record<string, number> = {};
            const watchingTogether: string[] = [];

            const hostFriend = coWatchSession.host_friend_uuid === 'self'
              ? userProfile
              : await friendManager.getFriend(coWatchSession.host_friend_uuid);

            if (hostFriend) {
              hostName = hostFriend.nickname || hostFriend.local_name || coWatchSession.host_friend_uuid;
              const hostActivity = Object.values(hostFriend.current_activities || {}).find(
                a => a?.id === coWatchSession.activity_id
              );

              if (hostActivity) {
                hostState = hostActivity.state || 'unknown';
                videoDuration = hostActivity.metadata?.duration || 0;
                if (hostActivity?.metadata?.progress !== undefined) {
                  hostPosition = hostActivity.metadata.progress;
                  hostPositionTimestamp = hostActivity.metadata.progress_measured_at || Date.now(); // When host's content script measured their progress
                }
              }

              userPosition = hostActivity?.metadata?.progress || 0;

              // Collect guest progress
              for (const friendId of coWatchSession.co_watchers) {
                if (friendId === userProfile?.uuid) {
                  watchingTogether.push(friendId);
                  continue;
                }
                watchingTogether.push(friendId);
                const friend = await friendManager.getFriend(friendId);
                if (friend) {
                  const friendActivity = Object.values(friend.current_activities || {}).find(
                    a => a?.id === coWatchSession.activity_id
                  );
                  if (friendActivity?.metadata?.progress !== undefined) {
                    guestProgress[friendId] = friendActivity.metadata.progress;
                  }
                }
              }
            }

            // Build nickname map
            const nicknameMap: Record<string, string> = {};
            if (userProfile) {
              nicknameMap[userProfile.uuid] = userProfile.nickname || 'You';
            }
            for (const uuid of watchingTogether) {
              if (uuid !== userProfile?.uuid) {
                const friend = await friendManager.getFriend(uuid);
                if (friend) {
                  nicknameMap[uuid] = friend.local_name;
                }
              }
            }

            // Get recent messages (unified session model)
            const recentMessages: any[] = [];
            const sessionMessages = userProfile?.uuid ? await storageManager.getVisibleMessages(userProfile.uuid, coWatchSession.co_watchers) : [];
            if (sessionMessages && sessionMessages.length > 0) {
              for (const msg of sessionMessages) {
                const senderName = nicknameMap[msg.from] || msg.from || 'Unknown';
                recentMessages.push({
                  id: msg.id,
                  sender: senderName,
                  sender_id: msg.from,
                  content: msg.content,
                  timestamp: msg.timestamp,
                });
              }
              recentMessages.sort((a, b) => a.timestamp - b.timestamp);
            }

            // Build co-watcher activities map for divergence display (includes self + others)
            const coWatcherActivities: Record<string, {activity_id: string; content: string; service?: string}> = {};

            // Add self's activity (needed when user is host, so host title can be shown)
            if (userProfile?.uuid) {
              const myActivities = await storageManager.getMyActivities();
              const userActivity = myActivities?.[coWatchSession.activity_id];
              if (userActivity) {
                coWatcherActivities[userProfile.uuid] = {
                  activity_id: userActivity.id || '',
                  content: userActivity.content || '',
                  service: userActivity.service || '',
                };
              }
            }

            for (const coWatcherId of coWatchSession.co_watchers) {
              if (coWatcherId === userProfile?.uuid) continue; // Skip self (already added above)

              const friend = await friendManager.getFriend(coWatcherId);
              if (friend?.current_activities) {
                const friendActivities = Object.values(friend.current_activities);
                if (friendActivities.length > 0) {
                  const friendActivity = friendActivities[0];
                  if (friendActivity) {
                    coWatcherActivities[coWatcherId] = {
                      activity_id: friendActivity.id || '',
                      content: friendActivity.content || '',
                      service: friendActivity.service || '',
                    };
                  }
                }
              }
            }

            // Send overlay state
            port.postMessage({
              type: 'OVERLAY_STATE',
              data: {
                activity_id: coWatchSession.activity_id,
                host_nickname: hostName,
                watching_together: watchingTogether,
                host_progress: hostPosition,
                host_progress_timestamp: hostPositionTimestamp,
                host_state: hostState,
                host_duration: videoDuration,
                user_progress: userPosition,
                guest_progress: guestProgress,
                is_user_host: coWatchSession.host_friend_uuid === 'self',
                messages: recentMessages,
                nicknameMap: nicknameMap,
                co_watcher_activities: coWatcherActivities,
              },
            });

            console.log('[Background] GET_OVERLAY_STATE: Sent state with', recentMessages.length, 'messages');
          } catch (e) {
            console.error('[Background] Error building overlay state:', e);
            port.postMessage({
              type: 'OVERLAY_STATE',
              data: null,
            });
          }
        } else if (message.type === 'SEND_MESSAGE') {
          // Message sent from overlay, send to co-watchers
          console.log('[Background] [MESSAGE_FLOW] ✅ SEND_MESSAGE RECEIVED:', message.data?.content?.substring(0, 30));
          console.debug('[Background] Received SEND_MESSAGE from content-script:', message.data);
          try {
            const userProfile = await storageManager.getUserProfile();
            console.log('[Background] [MESSAGE_FLOW] SEND_MESSAGE sender UUID:', { uuid: userProfile?.uuid, nickname: userProfile?.nickname });

            const detector = getCoWatcherDetector();
            const coWatchSession = await detector.getCurrentCoWatchSession();

            console.log('[Background] [MESSAGE_FLOW] getCurrentCoWatchSession() returned:', coWatchSession ? { session_id: coWatchSession.session_id, co_watchers: coWatchSession.co_watchers.length } : null);

            if (!coWatchSession) {
              console.warn('[Background] No co-watch session active for message - cannot send');
              return;
            }

            console.log('[Background] [MESSAGE_FLOW] Co-watch session found. Activity:', coWatchSession.activity_id, 'Co-watchers:', coWatchSession.co_watchers);

            const friendManager = getFriendManager();
            const messagingManager = getMessagingManager();

            console.log('[Background] [MESSAGE_FLOW] SEND_MESSAGE details:', {
              activity_id: coWatchSession.activity_id,
              co_watchers: coWatchSession.co_watchers,
              self_uuid: userProfile?.uuid,
              is_user_host: coWatchSession.host_friend_uuid === 'self'
            });

            // Send to all co-watchers except self
            const recipientIds = coWatchSession.co_watchers.filter(id => id !== userProfile?.uuid);
            console.log('[Background] [MESSAGE_FLOW] Recipient IDs for message:', recipientIds.map(id => ({ id, truncated: id.slice(0, 8) })));

            // Store message in unified model (not activity-scoped)
            const newMessage: Message = {
              id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              from: userProfile?.uuid || '',
              recipients: recipientIds,
              content: message.data?.content,
              timestamp: Date.now(),
            };

            console.log('[Background] [MESSAGE_FLOW] Storing message:', {
              id: newMessage.id,
              from: newMessage.from,
              from_preview: newMessage.from.slice(0, 20),
              recipients: recipientIds.map(r => r.slice(0, 20))
            });

            await storageManager.addMessage(newMessage);
            console.log('[Background] [MESSAGE_FLOW] ✅ Message stored in unified model:', { id: newMessage.id, recipients: recipientIds.length });

            for (const friendId of recipientIds) {
              const friend = await friendManager.getFriend(friendId);
              if (!friend) {
                console.warn('[Background] [MESSAGE_FLOW] Friend not found for id:', friendId);
                continue;
              }

              // Create a minimal activity object for messaging (for Nostr encryption/relay)
              const activity: any = {
                id: coWatchSession.activity_id,
                service: 'co-watch',
                content: 'Co-watch message',
              };

              console.log('[Background] [MESSAGE_FLOW] Sending message to friend:', friend.local_name, '(', friend.uuid, ')');
              await messagingManager.sendChatMessage(activity, friend, message.data?.content);
              console.log('[Background] [MESSAGE_FLOW] ✅ Message queued for', friend.local_name);
            }
          } catch (e) {
            console.error('[Background] Failed to send message:', e);
          }
        } else if (message.type === 'LEAVE_SESSION') {
          try {
            // User clicked "Leave Session" button in overlay
            const detector = getCoWatcherDetector();
            await storageManager.clearActiveSession();
            console.log('[Background] User left co-watch session');

            // Notify all content scripts to close overlays
            for (const [, port] of activeContentScriptPorts) {
              try {
                port.postMessage({
                  type: 'SESSION_ENDED',
                });
              } catch (e) {
                console.warn('[Background] Failed to notify content script of session end:', e);
              }
            }
          } catch (e) {
            console.error('[Background] Failed to leave session:', e);
          }
        } else if (message.type === 'CONTENT_SCRIPT_ACTIVITY') {
          await _handleContentScriptActivity(message.data?.key, message.data?.value, tabId);
        } else if (message.type === 'CONTENT_SCRIPT_ORPHANED') {
          console.log(`[Background] Content script orphaned for tab ${tabId}`);
          _markActivityAsDisconnected(tabId);
        }
      } catch (error) {
        console.error(`[Background] Port message handler error:`, error);
      }
    });

    port.onDisconnect.addListener(() => {
      if (tabId !== undefined) {
        activeContentScriptPorts.delete(tabId);
        console.log(`[Background] ðŸ”Œ Content script disconnected (${service}) for tab ${tabId}`);
        // Mark the tab's activity as disconnected since the content script is gone
        _markActivityAsDisconnected(tabId);
      }
    });

    // Send a ping to confirm connection
    try {
      port.postMessage({ type: 'PONG' });
    } catch (error) {
      console.error(`[Background] Failed to send pong:`, error);
    }
  }
});

/**
 * Retry injection with exponential backoff (handles tabs that are active but not yet responsive)
 */
async function _retryInjectionWithBackoff(tabId: number, maxAttempts = 3): Promise<boolean> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[Background] Injection attempt ${attempt}/${maxAttempts} for tab ${tabId}...`);
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-script.js'],
      });

      console.log(`[Background] âœ… Injection succeeded for tab ${tabId} on attempt ${attempt}`);
      connectedTabIds.add(tabId);
      failedInjectionAttempts.delete(tabId);
      return true;
    } catch (err) {
      lastError = err as Error;
      console.warn(`[Background] Injection attempt ${attempt}/${maxAttempts} failed for tab ${tabId}: ${lastError.message}`);

      if (attempt < maxAttempts) {
        // Exponential backoff: 100ms, 200ms, 400ms
        const backoffMs = Math.pow(2, attempt - 1) * 100;
        console.debug(`[Background] Retrying in ${backoffMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  // All attempts failed
  console.warn(`[Background] âš ï¸  All ${maxAttempts} injection attempts failed for tab ${tabId}`);
  return false;
}

/**
 * Tab activation listener: retry injection on tabs that haven't connected yet
 * This ensures tabs with initial injection failures eventually get the content script
 * Retries with exponential backoff per activation with no hard limitâ€”if the tab wasn't ready before, it might be now
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only retry on status complete (tab is fully loaded)
  if (changeInfo.status === 'complete' && tab.url) {
    if (connectedTabIds.has(tabId)) {
      console.debug(`[Background] Tab ${tabId} already connected, skipping injection`);
      return;
    }

    // Skip special pages (cannot inject into browser UI or system URLs)
    if (
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('edge-extension://')
    ) {
      console.debug(`[Background] Skipping protected page: ${tab.url.substring(0, 60)}`);
      return;
    }

    const activationCount = (failedInjectionAttempts.get(tabId) || 0) + 1;
    failedInjectionAttempts.set(tabId, activationCount);
    console.log(`[Background] ðŸ”„ Tab ${tabId} activated (activation #${activationCount}): ${tab.url.substring(0, 60)}...`);

    await _retryInjectionWithBackoff(tabId, 3);
  }
});

/**
 * Message handler for popup â†” background communication
 */
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    (async () => {
      try {
        if (!message || !message.type) {
          sendResponse({ success: false, error: 'Invalid message format' });
          return;
        }

        console.debug(`[Background] Message: ${message.type}`);

        // Ensure initialized
        if (!initialized) {
          await initializeExtension();
        }

        const response: ExtensionResponse = await _handleMessage(message);
        sendResponse(response);
      } catch (error) {
        console.error(`[Background] Handler error:`, error);
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    })();

    // Return true to indicate we'll respond asynchronously
    return true;
  }
);

/**
 * Route message to appropriate handler
 */
async function _handleMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  switch (message.type) {
    case 'GET_STORAGE':
      // Handle OAuth handler requests for stored state/tokens
      return {
        success: true,
        value: await storageManager.get(message.data?.key),
      };

    case 'GET_CURRENT_ACTIVITY':
      return _getCurrentActivity(message.data?.service);

    case 'GET_ALL_ACTIVE_ACTIVITIES':
      return _getAllActiveActivities();

    case 'GET_ALL_ACTIVITIES':
      return _getAllActivities();

    case 'GET_BROWSER_ACTIVITIES':
      return _getBrowserActivities();

    case 'GET_ACTIVE_FRIENDS':
      return _getActiveFriends();

    case 'GET_ALL_FRIENDS':
      return _getAllFriends();

    case 'GET_FRIEND':
      return _getFriend(message.data?.id);

    case 'GET_FRIEND_ACTIVITY_HISTORY':
      return _getFriendActivityHistory(message.data?.friendId);

    case 'GET_USER_IDENTIFIER':
      return _getUserIdentifier();

    case 'GET_ACTIVITY_MESSAGES':
      return _getActivityMessages(message.data?.activityId);

    case 'ADD_FRIEND':
      return _addFriend(message.data?.identifier, message.data?.localName);

    case 'REMOVE_FRIEND':
      return _removeFriend(message.data?.friendId);

    case 'RENAME_FRIEND':
      return _renameFriend(message.data?.friendId, message.data?.newName);

    case 'ACCEPT_FRIEND_REQUEST':
      return _acceptFriendRequest(message.data?.friendId);

    case 'DECLINE_FRIEND_REQUEST':
      return _declineFriendRequest(message.data?.friendId);

    case 'SEND_MESSAGE':
      return _sendMessage(message.data?.activity, message.data?.friendId, message.data?.content);

    case 'TOGGLE_SERVICE':
      return _toggleService(message.data?.service, message.data?.enabled);

    case 'SAVE_SETTINGS':
      return _saveSettings(message.data);

    case 'GET_DIAGNOSTICS':
      return _getDiagnostics();

    case 'RESTORE_SETTINGS':
      return _restoreSettings(message.data);

    case 'MUTE_FRIEND':
      return _muteFriend(message.data?.friendId, message.data?.mute);

    case 'GET_OAUTH_STATUS':
      return _getOAuthStatus(message.data?.service);

    case 'AUTHENTICATE_SERVICE':
      return _authenticateService(message.data?.service);

    case 'GET_NETFLIX_EXTRACTION_LOGS':
      return _getNetflixExtractionLogs();

    case 'GET_NETFLIX_DEBUG_CAPTURES':
      return _getNetflixDebugCaptures();

    case 'DISCONNECT_SERVICE':
      return _disconnectService(message.data?.service);

    case 'HANDLE_OAUTH_CALLBACK':
      return _handleOAuthCallback(message.data?.service, message.data?.code);

    case 'JOIN_ACTIVITY':
      return _joinActivity(message.data?.friendId, message.data?.activity);

    case 'SEND_INVITE':
      return _sendInvite(message.data?.activity, message.data?.friendId);

    case 'SEND_JOIN_NOTIFICATION':
      return _sendJoinNotification(message.data?.activity, message.data?.friendId, message.data?.accepted);

    case 'TEST_NOTIFICATION':
      return _sendTestNotification();

    case 'REFRESH_GAME_LIBRARY':
      return _refreshGameLibrary();

    case 'CONTENT_SCRIPT_ACTIVITY':
      return _handleContentScriptActivity(message.data?.key, message.data?.value, message.data?.tabId);

    case 'CONTENT_SCRIPT_ORPHANED':
      // Orphaned content script notifying that it lost context
      await _markActivityAsDisconnected(0); // tabId unknown, but we only have one video-tab activity
      return { success: true };

    case 'DEBUG_STORAGE':
      try {
        const profile = await storageManager.getUserProfile();
        const myActivities = await storageManager.getMyActivities();
        const friends = await storageManager.getFriends();
        return {
          success: true,
          data: {
            currentActivity: profile?.current_activity || null,
            myActivities: myActivities || {},
            friendsCount: friends?.length || 0,
            firstFriend: friends?.[0] ? {
              id: friends[0].id,
              name: friends[0].local_name,
              currentActivities: friends[0].current_activities || {},
            } : null,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to query storage',
        };
      }

    default:
      return {
        success: false,
        error: `Unknown message type: ${message.type}`,
      };
  }
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

async function _getCurrentActivity(service?: string): Promise<ExtensionResponse> {
  if (!activityDetector) {
    return { success: false, error: 'Activity detector not initialized' };
  }

  // If a specific service is requested, get activity from that service
  if (service) {
    try {
      const serviceModule = activityDetector['services']?.get(service);
      if (serviceModule) {
        const activity = await serviceModule.getCurrentActivity();
        return { success: true, data: activity };
      } else {
        return { success: false, error: `Service not found: ${service}` };
      }
    } catch (error) {
      console.error(`[Background] Error getting ${service} activity:`, error);
      return { success: false, error: `Failed to get ${service} activity` };
    }
  }

  // Otherwise get the overall current activity
  const activity = await activityDetector.detectCurrentActivity();
  return { success: true, data: activity };
}

async function _getAllActiveActivities(): Promise<ExtensionResponse> {
  if (!activityDetector) {
    return { success: false, error: 'Activity detector not initialized' };
  }

  const activities = await activityDetector.detectAllActiveActivities();
  return { success: true, data: activities };
}

async function _getAllActivities(): Promise<ExtensionResponse> {
  try {
    // Get my activities from storage
    const myActivities = await storageManager.getMyActivities();

    // Debug: log what we're returning for video-tab activities
    Object.entries(myActivities).forEach(([id, activity]: [string, any]) => {
      if (activity && activity.service === 'video-tab') {
        console.log(`[Background] âœ… Returning video-tab activity: "${activity.content}"`, {
          state: activity.state,
          disconnected_reason: activity.metadata?.disconnected_reason,
          has_metadata: !!activity.metadata,
          progress: activity.metadata?.progress,
          duration: activity.metadata?.duration,
          favicon: activity.metadata?.favicon,
        });
      }
    });

    // Get all friends
    const friendManager = getFriendManager();
    const friends = await friendManager.getAllFriends();

    // Build unified response: { myActivities: {...}, friends: [{uuid, local_name, current_activities, state, initiated_by_me}, ...] }
    const friendsData = friends.map((friend) => ({
      uuid: friend.uuid,
      local_name: friend.local_name,
      current_activities: friend.current_activities || {},
      state: friend.state,
      initiated_by_me: friend.initiated_by_me,
      pubkey: friend.pubkey,
    }));

    return {
      success: true,
      data: {
        myActivities,
        friends: friendsData,
      },
    };
  } catch (error) {
    console.error('[Background] Error getting all activities:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get activities' };
  }
}

async function _getBrowserActivities(): Promise<ExtensionResponse> {
  // Get the TabService and retrieve detected activities for Netflix, YouTube, and Twitch.tv separately
  if (!activityDetector) {
    return { success: true, data: { 'netflix-tab': null, 'youtube-tab': null, 'twitch-tab': null } };
  }

  const tabService = activityDetector.getService('tabs') as any;
  if (!tabService) {
    return { success: true, data: { 'netflix-tab': null, 'youtube-tab': null, 'twitch-tab': null } };
  }

  // Call getCurrentActivity first to populate the lastDetected map
  await tabService.getCurrentActivity();

  return {
    success: true,
    data: {
      'netflix-tab': tabService.getDetectedActivity?.('netflix-tab') || null,
      'youtube-tab': tabService.getDetectedActivity?.('youtube-tab') || null,
      'twitch-tab': tabService.getDetectedActivity?.('twitch-tab') || null,
    },
  };
}

async function _getActiveFriends(): Promise<ExtensionResponse> {
  try {
    const friendManager = getFriendManager();
    const allFriends = await friendManager.getAllFriends();
    console.debug(`[Friend] Total friends: ${allFriends.length}`);
    for (const f of allFriends) {
      const services = Object.keys(f.current_activities || {});
      console.debug(`[Friend] ${f.local_name}: activities=${services.join(',') || 'none'}`);
    }
    const activeFriends = await friendManager.getActiveFriends();
    console.debug(`[Friend] Active friends after filter: ${activeFriends.length}`);
    return { success: true, data: activeFriends };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get active friends' };
  }
}

async function _getAllFriends(): Promise<ExtensionResponse> {
  try {
    const friendManager = getFriendManager();
    const allFriends = await friendManager.getAllFriends();
    return { success: true, data: allFriends };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get all friends' };
  }
}

async function _getFriendActivityHistory(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'friendId required' };
  }

  try {
    const friendManager = getFriendManager();
    const history = await friendManager.getActivityHistory(friendId);
    return { success: true, data: history };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get activity history' };
  }
}

async function _getUserIdentifier(): Promise<ExtensionResponse> {
  const profile = await storageManager.getUserProfile();
  if (!profile) {
    return { success: false, error: 'user profile not found' };
  }
  return { success: true, data: profile };
}

async function _getDiagnostics(): Promise<ExtensionResponse> {
  try {
    const diagnostics = ActivityDiagnostics.getInstance(storageManager);
    const exported = await diagnostics.exportDiagnostics();
    return { success: true, data: JSON.parse(exported) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to export diagnostics' };
  }
}

async function _getNetflixExtractionLogs(): Promise<ExtensionResponse> {
  try {
    const logs = await storageManager.getNetflixExtractionLogs();
    console.debug(`[Background] Retrieved ${logs.length} Netflix extraction logs`);
    return { success: true, data: logs };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get logs' };
  }
}

async function _getNetflixDebugCaptures(): Promise<ExtensionResponse> {
  try {
    const captures = await storageManager.getNetflixDebugCaptures();
    console.debug(`[Background] Retrieved ${captures.length} Netflix debug captures`);
    return { success: true, data: captures };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get captures' };
  }
}

async function _getActivityMessages(activityId?: string): Promise<ExtensionResponse> {
  if (!activityId) {
    return { success: false, error: 'activityId required' };
  }

  try {
    const messages = await storageManager.getActivityMessages(activityId);
    return { success: true, data: messages };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get activity messages' };
  }
}

async function _addFriend(identifier?: string, localName?: string): Promise<ExtensionResponse> {
  if (!identifier || !localName) {
    return { success: false, error: 'identifier and localName required' };
  }

  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.addFriend(identifier, localName);

    // Subscribe to friend's events (for receiving accept/decline responses)
    await _subscribeToFriend(identifier);

    // Publish friend request message (kind-1059, encrypted)
    try {
      console.log(`[Background] Sending friend request message to ${localName} (${friend.pubkey.substring(0, 8)}...)`);
      const messagingManager = getMessagingManager();
      const userProfile = await storageManager.getUserProfile();
      const senderDisplayName = userProfile?.nickname || userProfile?.uuid || 'Friend';
      const eventId = await messagingManager.sendFriendRequestMessage(friend.pubkey, senderDisplayName);
      const friendRequestActivityId = `friend_request_${Date.now()}`;
      await trackPendingMessage(eventId, 'friend_request', friend.uuid, friendRequestActivityId);
      await markMessagePublished(`friend_request_${friend.uuid}_${friendRequestActivityId}`);
      console.log(`[Background] ðŸ“¤ Friend request message sent to ${localName}`);
    } catch (error) {
      console.error('[Background] Failed to send friend request message:', error);
      // Track failed publish for retry
      const friendRequestActivityId = `friend_request_${Date.now()}`;
      await markMessagePublishFailed(`friend_request_${friend.uuid}_${friendRequestActivityId}`, error instanceof Error ? error.message : 'Failed to send friend request message');
      // Don't fail the add operation if message publish fails
    }

    return { success: true, data: friend };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add friend' };
  }
}

async function _removeFriend(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'friendId required' };
  }

  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendId);
    if (!friend) {
      return { success: false, error: 'Friend not found' };
    }

    await friendManager.removeFriend(friendId);
    activeSubscriptions.delete(friend.pubkey);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to remove friend' };
  }
}

async function _renameFriend(friendId?: string, newName?: string): Promise<ExtensionResponse> {
  if (!friendId || !newName) {
    return { success: false, error: 'friendId and newName required' };
  }

  try {
    const friendManager = getFriendManager();
    await friendManager.renameFriend(friendId, newName);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to rename friend' };
  }
}

async function _acceptFriendRequest(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'friendId required' };
  }

  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendId);
    if (!friend) {
      return { success: false, error: 'Friend not found' };
    }

    // Handle based on current state
    if (friend.state === 'active') {
      // Already friends, just confirm
      console.log(`[Background] â„¹ï¸  ${friend.local_name} already in active state`);
      return { success: true, message: 'Already friends' };
    } else if (friend.state !== 'pending') {
      return { success: false, error: `Cannot accept friend in state: ${friend.state}` };
    }

    // Accept the friend request
    await friendManager.acceptFriendRequest(friendId);

    // Subscribe to friend's events (so we receive their game library, activities, etc.)
    await _subscribeToFriend(friend.uuid);

    // Send acceptance notification back to the friend
    const messagingManager = getMessagingManager();
    const dummyActivity: Activity = {
      id: `accept_${friendId}`,
      service: 'friend-request',
      content: 'Friend request acceptance',
      timestamp: Date.now(),
      freshness_timestamp: Date.now(),
      audio: 'off',
      metadata: {},
    };

    try {
      const eventId = await messagingManager.sendJoinAccepted(dummyActivity, friend);
      const messageId = `join_accepted_${friend.uuid}_${dummyActivity.id}`;
      await trackPendingMessage(eventId, 'join_accepted', friend.uuid, dummyActivity.id);
      await markMessagePublished(messageId);
    } catch (error) {
      console.error('[Background] Failed to send acceptance notification:', error);
      const messageId = `join_accepted_${friend.uuid}_${dummyActivity.id}`;
      await markMessagePublishFailed(messageId, error instanceof Error ? error.message : 'Failed to send acceptance');
    }

    console.log(`[Background] âœ… Accepted friend request from: ${friend.local_name}`);
    return { success: true };
  } catch (error) {
    console.error('[Background] Failed to accept friend request:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to accept friend request' };
  }
}

async function _declineFriendRequest(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'friendId required' };
  }

  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendId);
    if (!friend) {
      return { success: false, error: 'Friend not found' };
    }

    // Remove the friend from the list (decline is silent, no message sent)
    await friendManager.removeFriend(friendId);
    activeSubscriptions.delete(friend.pubkey);

    console.log(`[Background] âŒ Declined friend request from: ${friend.local_name}`);
    return { success: true };
  } catch (error) {
    console.error('[Background] Failed to decline friend request:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to decline friend request' };
  }
}

async function _sendMessage(activity?: any, friendId?: string, content?: string): Promise<ExtensionResponse> {
  if (!activity || !friendId || !content) {
    return { success: false, error: 'activity, friendId and content required' };
  }

  try {
    console.debug('[Background] Sending message:', { activity, friendId, content });
    const messagingManager = getMessagingManager();
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendId);
    if (!friend) {
      console.error('[Background] Friend not found:', friendId);
      return { success: false, error: 'Friend not found' };
    }

    console.debug('[Background] Friend found, sending via messaging manager');
    await messagingManager.sendChatMessage(activity, friend, content);
    console.debug('[Background] Message sent successfully');
    return { success: true };
  } catch (error) {
    console.error('[Background] Error sending message:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send message' };
  }
}

async function _toggleService(service?: string, enabled?: boolean): Promise<ExtensionResponse> {
  if (!service || typeof enabled !== 'boolean') {
    return { success: false, error: 'service and enabled required' };
  }

  // Type-safe cast since we've validated above
  const serviceTyped = service as ServiceName;
  await storageManager.setServiceEnabled(serviceTyped, enabled);
  console.debug(`[Background] Service ${service}: ${enabled ? 'enabled' : 'disabled'}`);

  return { success: true };
}

async function _muteFriend(friendId?: string, mute?: boolean): Promise<ExtensionResponse> {
  if (!friendId || mute === undefined) {
    return { success: false, error: 'friendId and mute required' };
  }

  try {
    const friendManager = getFriendManager();
    if (mute) {
      await friendManager.muteFriend(friendId);
    } else {
      await friendManager.unmuteFriend(friendId);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to mute/unmute friend' };
  }
}

async function _saveSettings(data?: any): Promise<ExtensionResponse> {
  if (!data) {
    return { success: false, error: 'settings data required' };
  }

  try {
    const profile = await storageManager.getUserProfile();
    if (!profile) {
      return { success: false, error: 'user profile not found' };
    }

    console.debug('[Background] Saving settings - received steam_id:', data.steam_id);

    // Update profile with new settings
    if (data.nickname !== undefined) {
      profile.nickname = data.nickname;
    }
    if (data.discord_info !== undefined) {
      profile.discord_info = data.discord_info;
    }
    if (data.services_enabled) {
      profile.services_enabled = { ...profile.services_enabled, ...data.services_enabled };
    }
    if (data.notification_preferences !== undefined) {
      profile.notification_preferences = data.notification_preferences;
    }
    if (data.steam_id !== undefined || data.steam_api_key !== undefined) {
      profile.steam_config = profile.steam_config || {};
      if (data.steam_id !== undefined) {
        profile.steam_config.steam_id = data.steam_id;
      }
      if (data.steam_api_key !== undefined) {
        profile.steam_config.api_key = data.steam_api_key;
      }
      // Mark Steam as enabled if both ID and key are now present
      if (profile.steam_config.steam_id && profile.steam_config.api_key) {
        profile.steam_config.enabled = true;
      }
    }
    if (data.publisher_config !== undefined) {
      profile.publisher_config = {
        ...(profile.publisher_config || {}),
        ...data.publisher_config,
      };
    }
    if (data.game_discovery_enabled !== undefined) {
      profile.game_discovery_enabled = data.game_discovery_enabled;
    }

    console.debug('[Background] Saving settings - steam_config:', profile.steam_config);

    // Save updated profile
    await storageManager.setUserProfile(profile);
    console.debug('[Background] Settings saved');

    // If publisher config rate changed, update the queue
    if (data.publisher_config?.rate_ms !== undefined && publishQueue) {
      publishQueue.setPublishInterval(data.publisher_config.rate_ms);
      console.log(`[Background] Updated publish queue rate to ${data.publisher_config.rate_ms}ms`);
    }

    // If nickname or discord info changed, republish profile to Nostr
    if (data.nickname !== undefined || data.discord_info !== undefined) {
      try {
        if (activityPublisher) {
          await activityPublisher.publishProfile();
        }
      } catch (error) {
        console.warn('[Background] Failed to publish profile after settings change:', error);
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to save settings' };
  }
}

async function _restoreSettings(data?: any): Promise<ExtensionResponse> {
  if (!data || !data.data) {
    return { success: false, error: 'restore data required' };
  }

  try {
    const profileData = data.data;
    if (!profileData.identifier) {
      return { success: false, error: 'invalid backup format' };
    }

    // Get current profile to preserve identifier (don't override user identity)
    const currentProfile = await storageManager.getUserProfile();
    if (!currentProfile) {
      return { success: false, error: 'user profile not found' };
    }

    // Merge backup data with current profile, preserving identifier
    const restoredProfile: any = { ...profileData };
    restoredProfile.identifier = currentProfile.identifier;

    // Save merged profile
    await storageManager.setUserProfile(restoredProfile);
    console.debug('[Background] Settings restored');

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to restore settings' };
  }
}

async function _getOAuthStatus(service?: string): Promise<ExtensionResponse> {
  if (!service) {
    return { success: false, error: 'service required' };
  }

  try {
    const serviceTyped = service as ServiceName;
    let hasToken = false;

    if (serviceTyped === 'spotify-api') {
      const spotifyService = new SpotifyService(storageManager);
      hasToken = await spotifyService.hasToken();
    } else if (serviceTyped === 'twitch-api') {
      const twitchService = new TwitchService(storageManager);
      hasToken = await twitchService.hasToken();
    }

    return { success: true, data: { service, hasToken } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get OAuth status' };
  }
}

async function _authenticateService(service?: string): Promise<ExtensionResponse> {
  if (!service) {
    return { success: false, error: 'service required' };
  }

  try {
    const serviceTyped = service as ServiceName;
    let authUrl: string | null = null;

    if (serviceTyped === 'spotify-api') {
      const spotifyService = new SpotifyService(storageManager);
      authUrl = await spotifyService.getAuthUrl();
    } else if (serviceTyped === 'twitch-api') {
      const twitchService = new TwitchService(storageManager);
      authUrl = await twitchService.getAuthUrl();
    } else {
      return { success: false, error: `OAuth not supported for ${service}` };
    }

    return { success: true, data: { authUrl } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get auth URL' };
  }
}

async function _disconnectService(service?: string): Promise<ExtensionResponse> {
  if (!service) {
    return { success: false, error: 'service required' };
  }

  try {
    const serviceTyped = service as ServiceName;

    if (serviceTyped === 'spotify-api') {
      const spotifyService = new SpotifyService(storageManager);
      await spotifyService.clearToken();
    } else if (serviceTyped === 'twitch-api') {
      const twitchService = new TwitchService(storageManager);
      await twitchService.clearToken();
    } else {
      return { success: false, error: `Cannot disconnect from ${service}` };
    }

    console.debug(`[Background] Disconnected from ${service}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to disconnect' };
  }
}

async function _handleOAuthCallback(service?: string, code?: string): Promise<ExtensionResponse> {
  if (!service || !code) {
    return { success: false, error: 'service and code required' };
  }

  try {
    const serviceTyped = service as ServiceName;

    if (serviceTyped === 'spotify') {
      const spotifyService = new SpotifyService(storageManager);
      await spotifyService.handleAuthCallback(code);
    } else if (serviceTyped === 'twitch') {
      const twitchService = new TwitchService(storageManager);
      await twitchService.handleAuthCallback(code);
    } else {
      return { success: false, error: `OAuth callback not supported for ${service}` };
    }

    console.log(`[Background] OAuth callback handled for ${service}`);
    return { success: true };
  } catch (error) {
    console.error(`[Background] OAuth callback error:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to handle OAuth callback' };
  }
}

async function _joinActivity(friendId?: string, activity?: any): Promise<ExtensionResponse> {
  if (!friendId || !activity) {
    return { success: false, error: 'friendId and activity required' };
  }

  try {
    const joinHandler = new JoinHandler(storageManager);
    await joinHandler.joinActivity(friendId, activity);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to join activity' };
  }
}


// ============================================================================
// NOSTR INTEGRATION
// ============================================================================

/**
 * Subscribe to incoming encrypted messages (kind 1059) sent to the user
 * Note: Uses a dedicated subscription identifier to listen for all kind 1059 events
 * Filtering for recipient happens in the callback
 */
async function _subscribeToIncomingMessages(): Promise<void> {
  try {
    const userPubkey = await getIdentityManager().getPubkey();
    console.log(`[Message] ðŸ”§ Subscribing to incoming messages for ${userPubkey.substring(0, 8)}...`);

    // Subscribe to kind-1059 events where user's pubkey is in the 'p' tag
    // RelayPool handles filtering server-side via #p filter
    relayPool.subscribeToDirectMessages(userPubkey, async (event: NostrEvent) => {
      console.log(`[Message] ðŸ“¨ Received kind-1059 event, processing...`);

      // Skip messages we published ourselves (relay echo)
      if (event.pubkey === userPubkey) {
        console.debug(`[Message] â„¹ï¸  Ignoring echo of our own message`);
        return;
      }

      // Validate event is kind-1059 (already filtered by relay, but verify)
      if (event.kind !== 1059) {
        console.debug(`[Message] Ignoring non-kind-1059 event (kind ${event.kind})`);
        return;
      }

      // Validate our pubkey is in the 'p' tag (required per NIP-17)
      const pTag = event.tags.find((t) => t[0] === 'p')?.[1];
      if (!pTag) {
        console.warn(`[Message] Kind-1059 event missing required p-tag: ${event.id.substring(0, 8)}`);
        return;
      }
      if (pTag !== userPubkey) {
        console.debug(`[Message] Ignoring kind-1059 event not meant for us (p-tag: ${pTag.substring(0, 8)})`);
        return;
      }

      console.log(`[Background] [MESSAGE_FLOW] 📨 Received kind-1059 from relay`);

      try {
        // Atomically check and mark to prevent race condition with multiple relay deliveries
        const { getEventDeduplicator } = await import('../src/modules/event-deduplicator');
        const dedup = getEventDeduplicator();
        const isFirstTime = await dedup.checkAndMark(event.id);

        if (!isFirstTime) {
          console.debug(`[Message] Already processed event ${event.id.substring(0, 8)}..., ignoring duplicate`);
          return;
        }

        // Check message type tag
        const messageType = event.tags.find((t) => t[0] === 'message_type')?.[1];

        // Find which friend this is from
        const friends = await storageManager.getFriends();
        const sender = friends.find((f) => f.pubkey === event.pubkey);
        console.debug(`[Message] DM sender lookup: event.pubkey=${event.pubkey.substring(0, 8)}..., found=${!!sender}, messageType=${messageType}, friendsList.length=${friends.length}`);

        if (sender) {
          // Known friend - handle normally
          await _handleMessageEvent(sender.uuid, event);
        } else if (messageType === 'friend_request') {
          // Friend request from unknown sender - create as pending friend
          console.log(`[Message] ðŸ”” Friend Request: Received from ${event.pubkey.substring(0, 8)}...`);
          await _handleFriendRequestFromUnknownSender(event);
        } else {
          // Unknown message type from unknown sender - ignore
          console.debug(`[Message] Ignoring message from unknown sender (type=${messageType}): ${event.pubkey.substring(0, 8)}...`);
        }
      } catch (error) {
        console.error(`[Message] Error handling incoming message:`, error);
      }
    });

    console.debug(`[Message] Subscribed to incoming kind-1059 messages for user ${userPubkey.substring(0, 8)}...`);
  } catch (error) {
    console.error(`[Message] Failed to subscribe to incoming messages:`, error);
  }
}

/**
 * Handle friend request from unknown sender
 * Creates sender as pending friend and shows notification
 */
async function _handleFriendRequestFromUnknownSender(event: NostrEvent): Promise<void> {
  try {
    const messagingManager = getMessagingManager();
    const friendManager = getFriendManager();

    // Decrypt the message to get sender info
    try {
      const userProfile = await storageManager.getUserProfile();
      if (!userProfile) {
        console.warn('[Message] User profile not found, cannot decrypt');
        return;
      }

      const secretKey = await getIdentityManager().getSecretKey();
      // Decrypt using nip44 with conversation key derived from our secret key and sender's pubkey
      const hexToBytes = (hex: string) => new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
      const conversationKey = nip44.getConversationKey(hexToBytes(secretKey), event.pubkey);
      const plaintext = await nip44.decrypt(event.content, conversationKey);
      const message = JSON.parse(plaintext);

      if (message.type !== 'friend_request') {
        console.warn('[Message] Invalid message type for friend request');
        return;
      }

      // Extract sender info from the decrypted message
      const senderInfo = JSON.parse(message.content);
      const senderIdentifier = senderInfo.sender_identifier;
      const senderDisplayName = senderInfo.sender_display_name || senderInfo.sender_identifier;

      if (!senderIdentifier) {
        console.warn('[Message] Friend request missing sender_identifier');
        return;
      }

      console.log(`[Message] ðŸ”” Friend Request from ${senderDisplayName} (${senderIdentifier})`);

      const existingFriend = await friendManager.getFriendByIdentifier(senderIdentifier);
      if (existingFriend) {
        console.log(`[Message] â„¹ï¸  Friend already exists: ${senderIdentifier}`);
        return;
      }

      // Create as pending friend (they initiated the request)
      const newFriend = await friendManager.addFriend(senderIdentifier, senderDisplayName, false);
      console.log(`[Message] âœ… Created pending friend from request: ${senderDisplayName}`);

      // Subscribe to new friend
      await _subscribeToFriend(senderIdentifier);

      // Show notification (EventDeduplicator prevents duplicates from multiple relays)
      const notificationManager = getNotificationManager();
      await notificationManager.notifyFriendRequest(newFriend.uuid, senderDisplayName);

      // Notify popup
      try {
        await chrome.runtime.sendMessage({
          type: 'FRIEND_REQUEST_RECEIVED',
          data: { friendId: newFriend.uuid, senderDisplayName },
        }).catch(() => {
          // Popup not open
        });
      } catch (error) {
        console.debug('[Message] Could not notify popup:', error instanceof Error ? error.message : error);
      }
    } catch (decryptError) {
      console.error('[Message] Failed to decrypt friend request:', decryptError);
      return;
    }
  } catch (error) {
    console.error('[Message] Failed to handle friend request from unknown sender:', error);
  }
}

/**
 * Subscribe to friend's activity and messages
 */
async function _subscribeToFriend(friendIdentifier: string): Promise<void> {
  const friendManager = getFriendManager();
  const friend = await friendManager.getFriendByIdentifier(friendIdentifier);
  if (!friend) {
    console.error(`[Background] Friend not found: ${friendIdentifier}`);
    try {
} catch {}
    return;
  }

  // Derive pubkey fresh from identifier (deterministic, ensures consistency)
  const pubkey = friendManager.derivePubkeyFromIdentifier(friendIdentifier);

  if (activeSubscriptions.has(pubkey)) {
    return;
  }

  // Mark as subscribed BEFORE calling subscribe() to prevent race conditions
  activeSubscriptions.set(pubkey, undefined);

  relayPool.subscribe(pubkey, async (event: NostrEvent) => {
    console.debug(`[Friend] Event from ${friendIdentifier} (kind ${event.kind})`);
    console.debug(`[Friend] Details - pubkey: ${event.pubkey.substring(0, 8)}..., tags: ${JSON.stringify(event.tags.slice(0, 3))}`);

    try {
      // Verify event signature using nostr-tools
      const isValid = verifyEvent(event);
      console.debug(`[Friend] Event signature validation: ${isValid ? '✅ VALID' : '❌ INVALID'} (kind ${event.kind}, id: ${event.id.substring(0, 8)}...)`);

      if (!isValid) {
        console.warn(`[Friend] ❌ Event signature verification failed for ${friendIdentifier} (kind ${event.kind}, id: ${event.id.substring(0, 8)}...)`);
        return;
      }

      // Fetch current friend state to check if active or pending
      const currentFriend = await friendManager.getFriendByIdentifier(friendIdentifier);
      const isPending = currentFriend?.state === 'pending';
      console.debug(`[Friend] Friend state: ${currentFriend?.local_name} (state: ${currentFriend?.state})`);
      console.debug(`[Friend] Event kind: ${event.kind}, will process: ${event.kind === 0 || !isPending ? 'YES' : 'NO (pending friend)'}`);

      if (event.kind === 0) {
        // Profile event (always accept for both pending and active)
        await _handleProfileEvent(event);
      } else if (event.kind === 1059) {
        // Kind-1059 messages (always accept for both pending and active)
        console.debug(`[Message] Handling incoming kind-1059`);

        // Deduplicate at friend handler level (prevent duplicate processing from DM subscription)
        const { getEventDeduplicator } = await import('../src/modules/event-deduplicator');
        const dedup = getEventDeduplicator();
        const isFirstTime = await dedup.checkAndMark(event.id);

        if (!isFirstTime) {
          console.debug(`[Message] Already processed event ${event.id.substring(0, 8)}... (from friend handler), ignoring duplicate`);
          return;
        }

        await _handleMessageEvent(friendIdentifier, event);
      } else if (event.kind === 10003) {
        // Kind-10003 replaceable activities - only process if friend is active
        if (!isPending) {
          // Check if this is a game-library event (tag t=game-library)
          const isGameLibraryEvent = event.tags.find((t) => t[0] === 't' && t[1] === 'game-library');

          if (isGameLibraryEvent) {
            // Route to game library manager
            const gameLibraryManager = GameLibraryManager.getInstance(storageManager);
            await gameLibraryManager.handleGameLibraryEvent(event);
          } else {
            // Activity event
            await _handleActivityEvent(friendIdentifier, event);
          }
        } else {
          console.debug(`[Friend] Skipping kind-10003 from pending friend ${friendIdentifier}`);
        }
      } else {
        console.debug(`[Friend] Ignoring event with kind ${event.kind}`);
      }
    } catch (error) {
      console.error(`[Friend] Error handling event for ${friendIdentifier}:`, error);
    }
  });

  console.debug(`[Friend] Subscribed to: ${friendIdentifier} (pubkey: ${pubkey})`);
}

async function _handleProfileEvent(event: NostrEvent): Promise<void> {
  try {
    // Extract Discord link from profile event tags
    const discordLink = event.tags.find((t) => t[0] === 'discord_link')?.[1];

    if (discordLink) {
      // Store the friend's Discord info
      await storageManager.setFriendProfile(event.pubkey, { discord_link: discordLink });
      console.debug(`[Profile] Stored Discord link for friend ${event.pubkey.substring(0, 8)}...`);
    }
  } catch (error) {
    console.error('[Profile] Error handling profile event:', error);
  }
}

async function _handleActivityEvent(friendIdentifier: string, event: NostrEvent): Promise<void> {
  console.log(`[Background] ðŸ”¨ Received event from friend ${friendIdentifier.substring(0, 8)}... kind=${event.kind} tags=${event.tags.map(t => t[0]).join(',')}`);


  const friends = await storageManager.getFriends();
  const friend = friends.find((f) => f.uuid === friendIdentifier);

  if (!friend) {
    console.debug(`[Background] Friend ${friendIdentifier} not found in local list, ignoring event`);
    return;
  }

  // Check for notification events (invites, etc.)
  const isNotificationTag = event.tags.find((t) => t[0] === 'is_notification')?.[1];
  const isActivityTag = event.tags.find((t) => t[0] === 'is_activity')?.[1];
  const typeTag = event.tags.find((t) => t[0] === 'type')?.[1];

  console.debug(`[Background] Activity event from ${friend.local_name}: is_notification=${isNotificationTag}, type=${typeTag}, tags=${JSON.stringify(event.tags)}`);

  if (isNotificationTag === 'true') {
    // Handle notification event
    console.debug(`[Background] Received invite notification from ${friend.local_name}`);

    // Deduplicate across relays
    const { getEventDeduplicator } = await import('../src/modules/event-deduplicator');
    const dedup = getEventDeduplicator();
    const isFirstTime = await dedup.checkAndMark(event.id);

    if (!isFirstTime) {
      console.debug(`[Background] Notification ${event.id.substring(0, 8)}... duplicate from relay, skipping`);
      return;
    }

    if (typeTag === 'friend_request') {
      // Friend request notification - prompt user to accept/decline
      const senderDisplayName = event.tags.find((t) => t[0] === 'sender_display_name')?.[1] || friend.local_name;

      console.log(`[Background] ðŸ”” Friend Request: Received from ${senderDisplayName} (state=${friend.state})`);

      // Only show notification if friend is pending (not if already active)
      if (friend.state === 'pending') {
        const notificationManager = getNotificationManager();
        await notificationManager.notifyFriendRequest(friend.uuid, senderDisplayName);
        console.log(`[Background] âœ… Showing friend request notification for ${senderDisplayName}`);
      } else if (friend.state === 'active') {
        // Already friends - just log it
        console.debug(`[Background] â„¹ï¸  Friend request from ${senderDisplayName}, but already friends (active)`);
      }

      // Try to notify popup if it's open
      try {
        await chrome.runtime.sendMessage({
          type: 'FRIEND_REQUEST_RECEIVED',
          data: { friendId: friend.uuid, senderDisplayName },
        }).catch((error) => {
          console.debug('[Background] Popup not open for friend request notification');
        });
      } catch (error) {
        console.debug('[Background] Could not notify popup of friend request:', error instanceof Error ? error.message : error);
      }
    } else if (typeTag === 'invite') {
      // First: deduplicate across relays (prevent processing same event twice)
      const { getEventDeduplicator } = await import('../src/modules/event-deduplicator');
      const dedup = getEventDeduplicator();
      const isFirstTime = await dedup.checkAndMark(event.id);

      if (!isFirstTime) {
        console.debug(`[Background] Invite ${event.id.substring(0, 8)}... duplicate from relay, skipping`);
        return;
      }

      // EventDeduplicator prevents duplicate processing from multiple relays
      const service = event.tags.find((t) => t[0] === 'service')?.[1] || 'an activity';
      const activityName = event.tags.find((t) => t[0] === 'activity_name')?.[1] || service;
      const activityId = event.tags.find((t) => t[0] === 'activity_id')?.[1];
      const notificationManager = getNotificationManager();
      
      // Determine verb based on service
      const verb = getActivityVerb(service);
      
      // Get Discord info: try sender's Discord first, fall back to recipient's
      let discordInfo: { owner: string; link: string } | undefined;

      // Try to get sender's Discord from the event
      const initiatorDiscord = event.tags.find((t) => t[0] === 'discord_link')?.[1];
      if (initiatorDiscord) {
        discordInfo = {
          owner: friend.local_name,
          link: initiatorDiscord,
        };
      } else {
        // Fallback: use recipient's Discord if available
        const userProfile = await storageManager.getUserProfile();
        if (userProfile?.discord_info) {
          discordInfo = {
            owner: 'your',
            link: userProfile.discord_info,
          };
        }
      }
      
      console.log(`[Background] ðŸ”” Invite: Firing notification for ${friend.local_name}`);
      await notificationManager.notifyInvite(
        friend.uuid,
        friend.local_name,
        activityName,
        verb,
        discordInfo
      );
      console.log(`[Background] âœ… Invite: Notification fired for ${friend.local_name}`);

      // Store received invite in persistent storage with timestamp
      if (activityId) {
        console.debug(`[Background] ðŸ”” Invite: Storing received invite - activityId: ${activityId}, friendId: ${friend.uuid}`);
        await storageManager.upsertReceivedInvite(activityId, {
          friendId: friend.uuid,
          sentAt: Date.now(),
        });

        // Also try to notify popup if it's open
        try {
          await chrome.runtime.sendMessage({
            type: 'INVITE_RECEIVED',
            data: { activityId, friendId: friend.uuid },
          }).catch((error) => {
            // Popup not open, that's fine - it will load from storage
            console.debug('[Background] Popup not open, stored invite in storage:', error?.message);
          });
        } catch (error) {
          console.debug('[Background] Could not notify popup (not open), stored in storage:', error instanceof Error ? error.message : error);
        }
      } else {
        console.debug('[Background] ðŸ”” Invite: No activityId found in tags');
      }
    }
    return;
  }

  if (isActivityTag === 'true' && typeTag === 'activity-state') {
    // Parse JSON array of activities
    try {
      // Check if event content is compressed
      let content = event.content;
      const isCompressed = event.tags.find(t => t[0] === 'compression')?.[1] === 'gzip';

      if (isCompressed) {
        try {
          const binary = Buffer.from(content, 'base64');
          content = pako.ungzip(binary, { to: 'string' });
          console.debug(`[Background] Decompressed activity event (${event.content.length}b â†’ ${content.length}b)`);
        } catch (error) {
          console.error('[Background] Gzip decompression failed, treating as uncompressed:', error);
        }
      }

      const activities = JSON.parse(content) as Activity[];
      const diagnostics = ActivityDiagnostics.getInstance(storageManager);
      const userProfile = await storageManager.getUserProfile();

      console.log('[Background] ✅ Successfully parsed activities from event (kind 10003):', activities.map(a => ({
        service: a.service,
        content: a.content,
        audio: a.audio,
        id: a.id,
      })));

      // Debug: log contentTimestamp for each activity
      for (const activity of activities) {
        console.debug(`[TimestampMigration:ActivityReceiver] Received activity ${activity.id} with contentTimestamp=${activity.contentTimestamp} (timestamp=${activity.timestamp})`);
      }

      // Record reception for each activity
      for (const activity of activities) {
        await diagnostics.recordReception(
          activity.id,
          event.tags.find(t => t[0] === 'relay')?.[1] || 'unknown',
          event.id,
          event.tags,
          friend.uuid
        );
      }
      const wasActive = Object.keys(friend.current_activities || {}).length > 0;

      // Detect which activities changed
      const changedServices = new Set<ServiceName>();
      for (const activity of activities) {
        const oldActivity = friend.current_activities?.[activity.service];
        // Check if activity changed (content, URL, state, or progress)
        if (!oldActivity ||
            oldActivity.content !== activity.content ||
            oldActivity.url !== activity.url ||
            oldActivity.state !== activity.state ||
            oldActivity.metadata?.progress !== activity.metadata?.progress) {
          changedServices.add(activity.service);
        }
      }

      // Check for removed activities (services that were active but aren't now)
      if (friend.current_activities) {
        for (const service of Object.keys(friend.current_activities) as ServiceName[]) {
          if (!activities.find(a => a.service === service)) {
            changedServices.add(service);
          }
        }
      }

      // Store all activities atomically, merging with existing to preserve local metadata
      // Only include activities from the published event (removes closed tabs/services)
      // When multiple activities have same service (e.g. multiple youtube tabs), keep the most recent
      const newCurrentActivities: Partial<Record<ServiceName, Activity>> = {};

      // Process new activities, keeping only the most recent per service
      const activitiesByService: Partial<Record<ServiceName, Activity>> = {};
      for (const activity of activities) {
        const existing = activitiesByService[activity.service];
        // Keep this activity if: no existing, or this one is newer (later timestamp)
        const shouldKeep = !existing || ((activity.timestamp || 0) > (existing.timestamp || 0));

        if (shouldKeep) {
          activitiesByService[activity.service] = activity;
        }
      }

      // Merge new activities with any that were preserved
      // Always update published fields, preserve local-only fields
      for (const [service, activity] of Object.entries(activitiesByService)) {
        const existingActivity = friend.current_activities?.[service as ServiceName];

        const merged = {
          ...existingActivity,  // Start with existing (preserves local fields)
          ...activity,          // Override with published fields
          metadata: {
            ...existingActivity?.metadata,  // Preserve local metadata
            ...activity.metadata,           // Override with published metadata
          }
        };

        console.debug(`[TimestampMigration:ActivityMerge] Merged activity ${activity.id}: contentTimestamp=${merged.contentTimestamp} (from published=${activity.contentTimestamp})`);
        newCurrentActivities[service as ServiceName] = merged;
      }

      console.debug(`[Background] 📦 Storing activities for ${friend.local_name}: ${Object.keys(newCurrentActivities).join(', ')}`);
      await storageManager.updateFriend(friend.uuid, {
        current_activities: newCurrentActivities,
        last_seen: Date.now(),
      });
      console.log(`[Background] ✅ Stored ${Object.keys(newCurrentActivities).length} activities for ${friend.local_name}`);

      // Record processing success for each activity
      for (const activity of activities) {
        await diagnostics.recordProcessing(
          activity.id,
          ['parse', 'validate', 'merge', 'store'],
          undefined, // no validation errors
          undefined, // no filtering applied
          undefined  // not rejected
        );
      }

      // Clean up orphaned invites: if friend no longer has an activity, remove the invite for it
      await cleanupOrphanedInvites(friend.uuid, newCurrentActivities);

      // Add changed activities to history
      for (const activity of activities) {
        if (changedServices.has(activity.service)) {
          await storageManager.addActivityToHistory(friend.uuid, activity);
        }
      }

      // Send notification if friend came online (transition from no activities to some)
      if (!wasActive && activities.length > 0) {
        try {
          const notificationManager = getNotificationManager();
          await notificationManager.notifyFriendOnline(friend.uuid, friend.local_name, activities[0].content);
        } catch (error) {
          console.error('[Background] Failed to send online notification:', error);
        }
      }

      // Only notify popup if something actually changed
      if (changedServices.size > 0) {
        try {
          await chrome.runtime.sendMessage({
            type: 'FRIEND_ACTIVITY_CHANGED',
            data: { friendId: friend.uuid, changedServices: Array.from(changedServices) },
          });
        } catch (error) {
          // Popup not open
        }
      }
      return;
    } catch (error) {
      console.error('[Background] Failed to parse complete activity state:', error);
      // Record rejection if we have an activity ID from tags
      const activityId = event.tags.find(t => t[0] === 'activity_id')?.[1];
      if (activityId) {
        const diagnostics = ActivityDiagnostics.getInstance(storageManager);
        await diagnostics.recordProcessing(
          activityId,
          ['parse'],
          [error instanceof Error ? error.message : String(error)],
          undefined,
          `Parse error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }
  }
  // All activities are published as bulk events; no legacy single-activity fallback
}

async function _handleMessageEvent(friendIdentifier: string, event: NostrEvent): Promise<void> {
  try {
    const friends = await storageManager.getFriends();
    const friend = friends.find((f) => f.uuid === friendIdentifier);

    if (!friend) {
      console.warn('[Message] Friend not found for message:', friendIdentifier);
      return;
    }

    // Decrypt and check the actual message type
    const messagingManager = getMessagingManager();
    const timestamp = event.created_at * 1000;

    const message = await messagingManager.receiveMessage(friend, event.content, timestamp, event.id);

    // Route based on the actual message type, not just the event tag
    if (message?.type === 'friend_request') {
      // Incoming friend request - friend is already pending, user will accept/decline in UI
      console.log(`[Message] â„¹ï¸  Friend request from ${friend.local_name} already created and awaiting user response`);
      return;
    }

    if (message?.type === 'join_accepted') {
      // Route to appropriate handler based on message service
      if (message.service === 'friend-request') {
        await _handleFriendRequestAccepted(friend, event, message);
      } else {
        await _handleActivityAccepted(friend, event, message);
      }
      return;
    }

    if (message?.type === 'join_declined') {
      await _handleActivityDeclined(friend, event, message);
      return;
    }

    if (message?.type === 'sync_request') {
      // Host receives sync request from guest
      const syncHandler = getSyncHandler();
      await syncHandler.handleSyncRequest(friend.uuid, message.activity_id);
      return;
    }

    if (message?.type === 'sync_response') {
      // Guest receives sync response from host
      const syncHandler = getSyncHandler();
      if (message.position !== undefined && message.sent_at !== undefined) {
        await syncHandler.handleSyncResponse(friend.uuid, message.activity_id, message.position, message.sent_at);
      } else {
        console.warn('[Message] Sync response missing position or sent_at:', message);
      }
      return;
    }

    if (message) {
      // Send notification based on message type (if not already handled by early returns above)
      try {
        const notificationManager = getNotificationManager();
        if (message.type === 'invite') {
          // No notification for invites (handled by notifyInvite elsewhere)
        } else if (message.type === 'chat') {
          // No notification for chat messages
        }
      } catch (error) {
        console.error('[Message] Failed to send message notification:', error);
      }

      // Chat messages are already stored by messaging.ts receiveMessage(), no need to store again

      // Store pending invite and notify popup
      if (message.type === 'invite' && message.activity_id) {
        try {
          // EventDeduplicator prevents duplicate processing from multiple relays
          console.debug(`[Message] 💌 Invite: Storing pending invite - activityId: ${message.activity_id}, service: ${message.service}, friendId: ${friend.uuid}`);

          // Find the friend's activity that matches this invite
          // Activities are stored by SERVICE in friend.current_activities, so search by activity_id
          let activity = undefined;
          if (friend.current_activities) {
            for (const act of Object.values(friend.current_activities)) {
              if (act?.id === message.activity_id) {
                activity = act;
                break;
              }
            }
          }

          if (!activity) {
            console.warn(`[Message] Activity not found in friend's current activities for ID: ${message.activity_id}`);
          }

          // Store received invite separately from outgoing invite tracking
          console.log(`[STORAGE_DEBUG_START] About to upsert invite ${message.activity_id.substring(0, 8)}`);

          await storageManager.upsertReceivedInvite(message.activity_id, {
            friendId: friend.uuid,
            activity: activity || {
              id: message.activity_id,
              service: message.service || 'unknown',
              content: message.content || 'unknown activity',
              timestamp: Date.now(),
              freshness_timestamp: Date.now(),
              audio: 'off',
              metadata: {},
            },
            sentAt: Date.now(),
          });
          console.log(`[STORAGE_DEBUG] Upsert complete, syncing...`);

          // Ensure immediate persistence before notifying popup (don't rely on batched sync)
          await storageManager.forceSyncNow();

          // Verify it made it to storage
          const verifyInvites = await storageManager.getReceivedInvites();
          const hasInvite = message.activity_id in verifyInvites;
          console.log(`[STORAGE_DEBUG] RECEIVED_INVITES has ${Object.keys(verifyInvites).length} entries. Has this invite? ${hasInvite}`);
          if (!hasInvite) {
            console.error(`[STORAGE_BUG] Invite ${message.activity_id.substring(0, 8)} NOT in storage after upsert!`);
          }

          // Fire notification for encrypted invite (same as kind-1 handler)
          const notificationManager = getNotificationManager();
          const activityName = message.content || message.service || 'an activity';
          const verb = getActivityVerb(message.service || 'unknown');

          // Get Discord info: try friend's Discord first, fall back to recipient's
          let discordInfo: { owner: string; link: string } | undefined;
          if (friend.discord_info) {
            discordInfo = {
              owner: friend.local_name,
              link: friend.discord_info,
            };
          } else {
            // Fallback: use recipient's Discord if available
            const userProfile = await storageManager.getUserProfile();
            if (userProfile?.discord_info) {
              discordInfo = {
                owner: 'your',
                link: userProfile.discord_info,
              };
            }
          }

          console.log(`[Message] 🔔 Invite: Firing notification for ${friend.local_name}`);
          await notificationManager.notifyInvite(
            friend.uuid,
            friend.local_name,
            activityName,
            verb,
            discordInfo
          );
          console.log(`[Message] ✅ Invite: Notification fired for ${friend.local_name}`);

          // Notify popup if it's open
          try {
            await chrome.runtime.sendMessage({
              type: 'INVITE_RECEIVED',
              data: { activityId: message.activity_id, friendId: friend.uuid },
            }).catch((error) => {
              console.debug('[Message] Popup not open, stored invite in storage:', error instanceof Error ? error.message : error);
            });
          } catch (error) {
            console.debug('[Message] Could not notify popup (not open), stored in storage:', error instanceof Error ? error.message : error);
          }
        } catch (error) {
          console.error('[Message] Failed to store pending invite:', error);
        }
      }

      // Notify popup about new message
      try {
        await chrome.runtime.sendMessage({
          type: 'NEW_MESSAGE',
          data: { message, friendId: friend.uuid, activityId: message.activity_id },
        });
      } catch (error) {
        // Popup not open
      }
    }
  } catch (error) {
    console.error('[Message] Failed to handle message event:', error);
  }
}

/**
 * Handle friend request acceptance (when friend accepts our friend request)
 */
async function _handleFriendRequestAccepted(friend: Friend, event: NostrEvent, message: any): Promise<void> {
  try {
    const friendManager = getFriendManager();

    // Friend accepted the request - transition from pending to active (if not already)
    if (friend.state === 'pending') {
      await friendManager.acceptFriendRequest(friend.uuid);
    }
    console.log(`[FriendRequest] ✅ ${friend.local_name} accepted your friend request`);

    // Notify the user (EventDeduplicator prevents duplicates from multiple relays)
    const notificationManager = getNotificationManager();
    await notificationManager.notify(
      `${friend.local_name} accepted your friend request`,
      'You are now friends!'
    );
  } catch (error) {
    console.error('[FriendRequest] Failed to handle friend request acceptance:', error);
  }
}

/**
 * Handle activity invitation acceptance (when friend accepts our activity invite)
 */
async function _handleActivityAccepted(friend: Friend, event: NostrEvent, message: any): Promise<void> {
  try {
    if (!message.activity_id) {
      console.warn('[Activity] Activity acceptance missing activity_id');
      return;
    }

    // Check if we've already notified about this activity being accepted
    const alreadyNotified = await storageManager.hasNotifiedActivityAcceptance(message.activity_id);

    if (!alreadyNotified) {
      // Show Discord coordination prompt if available
      await _showDiscordCoordinationPrompt(friend);

      // Record that we've notified about this activity
      await storageManager.recordActivityAcceptance({
        activityId: message.activity_id,
        firstAcceptorId: friend.uuid,
        acceptedAt: Date.now(),
        notifiedAt: Date.now(),
      });

      console.log(`[Activity] 🎉 ${friend.local_name} accepted your activity invitation`);
    } else {
      console.debug(`[Activity] Activity ${message.activity_id} acceptance already notified, skipping duplicate`);
    }
  } catch (error) {
    console.error('[Activity] Failed to handle activity acceptance:', error);
  }
}

/**
 * Handle activity invitation decline (when friend declines our activity invite)
 * Updates envelope from green to gray, no notification
 */
async function _handleActivityDeclined(friend: Friend, event: NostrEvent, message: any): Promise<void> {
  try {
    if (!message.activity_id) {
      console.warn('[Activity] Activity decline missing activity_id');
      return;
    }

    console.log(`[Activity] 👋 ${friend.local_name} declined your activity invitation for ${message.activity_id.substring(0, 8)}...`);

    // Track that friend declined this activity (for envelope state)
    const declinedKey = `activity_declined_${message.activity_id}_${friend.uuid}`;
    await storageManager.setStorage(declinedKey, {
      activityId: message.activity_id,
      friendId: friend.uuid,
      declinedAt: Date.now(),
    });

    // Notify popup to update envelope state
    try {
      await chrome.runtime.sendMessage({
        type: 'ACTIVITY_DECLINED',
        data: { activityId: message.activity_id, friendId: friend.uuid },
      }).catch(() => {
        // Popup not open, that's fine
      });
    } catch (error) {
      console.debug('[Activity] Could not notify popup of activity decline:', error instanceof Error ? error.message : error);
    }
  } catch (error) {
    console.error('[Activity] Failed to handle activity decline:', error);
  }
}

/**
 * Handle friend request acceptance/decline responses (LEGACY - deprecated, kept for reference)
 */
async function _handleFriendRequestResponse(friend: Friend, event: NostrEvent): Promise<void> {
  try {
    const messagingManager = getMessagingManager();
    const timestamp = event.created_at * 1000;

    // Decrypt the message to get the response type
    const message = await messagingManager.receiveMessage(friend, event.content, timestamp, event.id);

    if (!message) {
      console.warn('[FriendRequest] Failed to decrypt friend request response from', friend.local_name);
      return;
    }

    if (message.type === 'join_accepted') {
      await _handleFriendRequestAccepted(friend, event, message);
    } else {
      console.warn('[FriendRequest] Unexpected message type in friend request:', message.type);
    }
  } catch (error) {
    console.error('[FriendRequest] Failed to handle friend request response:', error);
  }
}

async function _handleContentScriptActivity(key: string, value: any, tabId?: number): Promise<ExtensionResponse> {
  try {
    // Verify we have all required fields before writing
    if (key.startsWith('content_script_activity_') && value) {
      const requiredFields = ['id', 'service', 'content', 'state', 'timestamp'];
      const missingFields = requiredFields.filter(field => !(field in value));
      if (missingFields.length > 0) {
        logger.log('Background', 'WARN', 'Activity missing fields', { missingFields });
        console.warn(`[Background] âš ï¸  Activity missing fields: ${missingFields.join(', ')}`, value);
      }
    }

    // Remove any existing activities for this service to keep only the most recent
    const allActivities = await storageManager.getMyActivities();
    const tabServices = ['video-tab', 'youtube-tab', 'netflix-tab', 'twitch-tab'];

    for (const [activityId, activity] of Object.entries(allActivities)) {
      if (!activity) continue;

      // Remove if same service (regardless of tab) with older timestamp
      if (activity.service === value.service && tabServices.includes(activity.service)) {
        if (activity.id !== value.id) {
          const isOlder = (activity.timestamp || 0) < (value.timestamp || 0);
          if (isOlder || tabId !== undefined) {
            // Remove: either older timestamp, or from different tab (keep current tab's newer activity)
            console.debug(`[Background] ðŸ—‘ï¸  Removing old ${value.service} activity (id: ${activity.id}, timestamp: ${activity.timestamp})`);
            delete allActivities[activityId];
          }
        }
      }
    }

    await storageManager.setMyActivities(allActivities);

    // Store content script activity directly in MY_ACTIVITIES collection (single source of truth)
    const activityId = value.id || generateActivityId(value.service, value.url || '');

    // Add tabId to metadata for duplicate detection
    if (tabId !== undefined) {
      value.metadata = value.metadata || {};
      value.metadata.tabId = tabId;
    }

    console.debug(`[TimestampMigration] STORE activity ${activityId}: contentTimestamp=${value.contentTimestamp}, timestamp=${value.timestamp}, state=${value.state}, tabId=${tabId}`);

    await storageManager.updateMyActivity(activityId, value);
    console.debug(`[Background] âœ… Stored activity in MY_ACTIVITIES:`, {
      id: activityId,
      service: value?.service,
      content: value?.content?.substring(0, 50),
      tabId: tabId
    });

    // If this is an activity update, trigger detection cycle to process it
    if (key.startsWith('content_script_activity_')) {
      console.debug(`[Background] ðŸ”„ Triggering activity detection from content script update`);
      try {
        // Ensure extension is initialized before accessing activityDetector
        if (!initialized) {
          await initializeExtension();
        }
        if (activityDetector) {
          await activityDetector.detectAndPublish();
          // Verify current_activity was set
          const profile = await storageManager.getUserProfile();
          console.debug(`[Background] ✅ detectAndPublish complete. Current activity now:`, profile?.current_activity?.id);
        } else {
          console.warn('[Background] activityDetector not available after initialization');
        }
      } catch (error) {
        console.error('[Background] Error in detectAndPublish:', error);
      }
    }

    return { success: true };
  } catch (error) {
    console.error('[Background] Failed to handle content script activity:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Mark a tab's content script activity as disconnected
 * Called when the content script port disconnects (e.g., extension restart, context lost)
 */
async function _markActivityAsDisconnected(tabId: number): Promise<void> {
  try {
    // Get all activities from MY_ACTIVITIES collection
    const myActivities = await storageManager.getMyActivities();
    console.log(`[Background] Got ${Object.keys(myActivities).length} activities to check`);

    // Find video-tab activity by service type
    for (const [activityId, activity] of Object.entries(myActivities)) {
      if ((activity as any)?.service === 'video-tab') {
        console.log(`[Background] Found video-tab activity with ID: ${activityId}, current state: ${(activity as any)?.state}`);

        // Mark as disconnected
        const disconnectedActivity: Activity = {
          ...activity,
          state: 'disconnected',
          metadata: {
            ...(activity as any)?.metadata,
            disconnected_reason: 'Disconnected - reload tab',
          },
        };

        console.log(`[Background] Updating activity to state: disconnected`);

        // Update using StorageManager
        await storageManager.updateMyActivity(activityId, disconnectedActivity);
        console.log(`[Background] âœ… Marked video-tab activity as disconnected, new state: ${disconnectedActivity.state}`);
        return;
      }
    }
    console.log(`[Background] No video-tab activity found to mark as disconnected`);
  } catch (err) {
    console.error(`[Background] Failed to mark activity as disconnected:`, err);
  }
}

async function _getFriend(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'Friend ID required' };
  }

  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendId);
    if (!friend) {
      return { success: false, error: `Friend not found: ${friendId}` };
    }
    return { success: true, data: friend };
  } catch (error) {
    console.error('[Background] Error getting friend:', error);
    return { success: false, error: 'Failed to get friend' };
  }
}

async function _sendInvite(activity?: any, friendUuid?: string): Promise<ExtensionResponse> {
  if (!activity || !friendUuid) {
    return { success: false, error: 'Activity and friendUuid required' };
  }

  if (!activity.service) {
    console.error('[Invite] Cannot send invite: activity missing service', { activityId: activity.id, service: activity.service });
    return { success: false, error: 'Activity must have a service to invite' };
  }

  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendUuid);
    if (!friend) {
      return { success: false, error: `Friend not found: ${friendUuid}` };
    }

    const messagingManager = getMessagingManager();

    // Send invite and get event ID for tracking
    const eventId = await messagingManager.sendInvite(activity, friend);

    // Track pending invite for retry on failure
    await trackPendingInvite(eventId, activity, friend.uuid);

    // Mark as published successfully
    await markInvitePublished(activity.id);

    return { success: true };
  } catch (error) {
    console.error('[Background] Error sending invite:', error);

    // Track failed publish for retry
    const activityId = activity?.id;
    if (activityId) {
      await markInvitePublishFailed(activityId, error instanceof Error ? error.message : 'Failed to send invite');
    }

    return { success: false, error: error instanceof Error ? error.message : 'Failed to send invite' };
  }
}

async function _sendTestNotification(): Promise<ExtensionResponse> {
  try {
    const notificationManager = getNotificationManager();
    await notificationManager.notify('Test Notification', 'If you see this, notifications are working!');
    return { success: true };
  } catch (error) {
    console.error('[Background] Test notification error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send test notification' };
  }
}

async function _refreshGameLibrary(): Promise<ExtensionResponse> {
  try {
    console.debug('[Background] Refreshing game library from Steam');
    const gameLibraryManager = GameLibraryManager.getInstance(storageManager);
    const userGames = await gameLibraryManager.fetchMyGameLibrary();
    console.debug(`[Background] Fetched ${userGames.length} games from Steam`);

    // Publish game library to Nostr
    await gameLibraryManager.publishMyGameLibrary();

    // Check which games are missing metadata and queue only those
    const gamesNeedingMetadata = await _findGamesMissingMetadata(userGames);
    if (gamesNeedingMetadata.length > 0) {
      console.debug(`[Background] Queuing ${gamesNeedingMetadata.length}/${userGames.length} games missing metadata for fetching`);
      await metadataFetcher.scheduleBackgroundRefresh(gamesNeedingMetadata);
      return { success: true, data: { gamesRefreshed: userGames.length, queuedForMetadata: gamesNeedingMetadata.length } };
    } else {
      console.debug(`[Background] All ${userGames.length} games already have metadata`);
      return { success: true, data: { gamesRefreshed: userGames.length, queuedForMetadata: 0 } };
    }
  } catch (error) {
    console.error('[Background] Game library refresh error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to refresh game library' };
  }
}

/**
 * Find games that are missing metadata (name, genres, etc.)
 * Used to resume interrupted metadata fetching after extension reload
 */
async function _findGamesMissingMetadata(games: any[]): Promise<number[]> {
  try {
    // Get cached metadata from storage
    const metadataCache = await storageManager.get<Record<number, any>>(
      STORAGE_KEYS.GAME_METADATA_CACHE,
      {}
    );

    // Find games missing metadata (no entry or missing name)
    const missing: number[] = [];
    for (const game of games) {
      const meta = metadataCache[game.appId];
      if (!meta || !meta.name) {
        missing.push(game.appId);
      }
    }

    if (missing.length > 0) {
      console.debug(`[Background] ${missing.length} games missing metadata: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`);
    }

    return missing;
  } catch (error) {
    console.warn('[Background] Error checking for games missing metadata:', error);
    // On error, return empty list (don't interrupt initialization)
    return [];
  }
}

async function _sendJoinNotification(activity?: any, friendId?: string, accepted?: boolean): Promise<ExtensionResponse> {
  if (!activity || !friendId) {
    return { success: false, error: 'Activity and friendId required' };
  }

  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendId);
    if (!friend) {
      return { success: false, error: `Friend not found: ${friendId}` };
    }

    const messagingManager = getMessagingManager();
    const messageType = accepted ? 'join_accepted' : 'join_declined';

    try {
      const eventId = accepted
        ? await messagingManager.sendJoinAccepted(activity, friend)
        : await messagingManager.sendJoinDeclined(activity, friend);

      const messageId = `${messageType}_${friend.uuid}_${activity.id}`;
      await trackPendingMessage(eventId, messageType as 'join_accepted' | 'join_declined', friend.uuid, activity.id);
      await markMessagePublished(messageId);
    } catch (error) {
      console.error('[Background] Error sending join notification:', error);
      const messageId = `${messageType}_${friend.uuid}_${activity.id}`;
      await markMessagePublishFailed(messageId, error instanceof Error ? error.message : 'Failed to send notification');
      return { success: false, error: error instanceof Error ? error.message : 'Failed to send notification' };
    }

    return { success: true };
  } catch (error) {
    console.error('[Background] Error in join notification handler:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send notification' };
  }
}

// ============================================================================
// EVENT DEDUPLICATION (Nostr events from relays)
// ============================================================================

/**
 * Initialize EventDeduplicator from storage (survives extension reload)
 */
async function initializeEventDeduplicator(): Promise<void> {
  const { getEventDeduplicator } = await import('../src/modules/event-deduplicator');
  const stored = await storageManager.getProcessedEventIds();
  const dedup = getEventDeduplicator();

  console.debug(`[Background] Restoring event dedup state: found ${stored.size} stored event IDs`);

  // Restore processed events from storage
  if (stored.size > 0) {
    dedup.restoreFromStorage(stored);
    console.log(`[Background] ✅ Loaded ${stored.size} processed event IDs`);
  }
}

/**
 * Persist EventDeduplicator state to storage (called after major message processing)
 */
async function persistEventDeduplicatorState(): Promise<void> {
  const { getEventDeduplicator } = await import('../src/modules/event-deduplicator');
  const dedup = getEventDeduplicator();
  const processed = dedup.getProcessedEventIds();

  if (processed.size > 0) {
    await storageManager.setProcessedEventIds(processed);
    console.debug(`[Dedup] Persisted ${processed.size} processed event IDs to storage`);
  }
}

/**
 * Mark a message as processed
 */
async function markMessageProcessed(eventId: string): Promise<void> {
  const now = Date.now();
  notifiedInviteIds.set(eventId, now);
  await storageManager.setNotifiedInviteIds(notifiedInviteIds);
}

/**
 * Track a pending invite for retry on failure
 */
async function trackPendingInvite(eventId: string, activity: Activity, friendUuid: string): Promise<void> {
  const activityId = activity.id;
  await storageManager.upsertPendingInvite(activityId, {
    eventId,
    activity,
    friendUuid,
    state: 'pending',
    sentAt: Date.now(),
    retryCount: 0,
  });
}

/**
 * Mark invite relay acceptance (relay confirmed receipt, awaiting friend response for completion)
 */
async function markInvitePublished(activityId: string): Promise<void> {
  const invites = await storageManager.getPendingInvites();
  const invite = invites[activityId];
  if (invite) {
    invite.state = 'relay_accepted';
    invite.relay_accepted_at = Date.now();
    await storageManager.upsertPendingInvite(activityId, invite);
  }
}

/**
 * Mark invite publish as failed and schedule retry
 */
async function markInvitePublishFailed(activityId: string, error: string): Promise<void> {
  const invites = await storageManager.getPendingInvites();
  const invite = invites[activityId];
  if (invite) {
    invite.retryCount++;
    invite.lastRetryAt = Date.now();
    invite.lastError = error;

    // After 3 retries, mark as failed permanently
    if (invite.retryCount >= 3) {
      invite.state = 'failed';
      console.warn(`[Background] Invite failed permanently after 3 retries: ${activityId}`);
    } else {
      invite.state = 'pending';
    }

    await storageManager.upsertPendingInvite(activityId, invite);
  }
}

/**
 * Mark invite as completed (friend responded)
 */
async function markInviteCompleted(activityId: string): Promise<void> {
  const invites = await storageManager.getPendingInvites();
  const invite = invites[activityId];
  if (invite) {
    invite.friend_responded_at = Date.now();
    await storageManager.upsertPendingInvite(activityId, invite);
  }
}

/**
 * Retry publishing pending invites on startup
 */
async function retryPendingInvites(): Promise<void> {
  if (!relayPool || !messagingManager) return;

  const invites = await storageManager.getPendingInvites();
  let retryCount = 0;

  for (const [activityId, invite] of Object.entries(invites)) {
    if (invite.state === 'pending') {
      try {
        console.debug(`[Background] Retrying invite for activity ${activityId}`);

        // Get the friend and retry sending
        const friend = await getFriendManager().getFriend(invite.friendId);
        if (friend) {
          try {
            // Retry sending the invite (this will attempt to publish again)
            const newEventId = await messagingManager.sendInvite(invite.activity, friend);
            console.log(`[Background] Successfully retried invite, new eventId: ${newEventId.substring(0, 16)}...`);
            await markInvitePublished(activityId);
            retryCount++;
          } catch (error) {
            // Publish failed again, increment retry count
            throw error;
          }
        } else {
          console.warn(`[Background] Friend not found for retry: ${invite.friendId}`);
          await markInvitePublishFailed(activityId, 'Friend not found');
        }
      } catch (error) {
        await markInvitePublishFailed(activityId, error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }

  if (retryCount > 0) {
    console.log(`[Background] Retried ${retryCount} pending invites`);
  }
}

/**
 * Track a pending kind-1059 message (chat, accept, decline, friend_request)
 */
async function trackPendingMessage(eventId: string, messageType: 'join_accepted' | 'join_declined' | 'friend_request' | 'chat', friendUuid: string, activityId: string, content?: string): Promise<void> {
  const messageId = `${messageType}_${friendUuid}_${activityId}`;
  await storageManager.upsertPendingMessage(messageId, {
    eventId,
    messageType,
    friendUuid,
    activityId,
    content,
    state: 'pending',
    sentAt: Date.now(),
    retryCount: 0,
  });
}

/**
 * Mark message relay acceptance (relay confirmed receipt)
 * For handshake messages (friend_request, accept/decline), awaiting friend response for completion
 * For response messages (join_accepted/declined), relay acceptance marks completion
 */
async function markMessagePublished(messageId: string): Promise<void> {
  const messages = await storageManager.getPendingMessages();
  const message = messages[messageId];
  if (message) {
    message.state = 'relay_accepted';
    message.relay_accepted_at = Date.now();
    await storageManager.upsertPendingMessage(messageId, message);
  }
}

/**
 * Mark message publish as failed and schedule retry
 */
async function markMessagePublishFailed(messageId: string, error: string): Promise<void> {
  const messages = await storageManager.getPendingMessages();
  const message = messages[messageId];
  if (message) {
    message.retryCount++;
    message.lastRetryAt = Date.now();
    message.lastError = error;

    // After 3 retries, mark as failed permanently
    if (message.retryCount >= 3) {
      message.state = 'failed';
      console.warn(`[Background] Message failed permanently after 3 retries: ${messageId}`);
    } else {
      message.state = 'pending';
    }

    await storageManager.upsertPendingMessage(messageId, message);
  }
}

/**
 * Mark handshake message as completed (friend responded)
 * Only applies to: friend_request, accept/decline friend request
 */
async function markMessageCompleted(messageId: string): Promise<void> {
  const messages = await storageManager.getPendingMessages();
  const message = messages[messageId];
  if (message) {
    message.friend_responded_at = Date.now();
    await storageManager.upsertPendingMessage(messageId, message);
  }
}

/**
 * Retry publishing pending messages on startup
 */
async function retryPendingMessages(): Promise<void> {
  if (!relayPool || !messagingManager) return;

  const messages = await storageManager.getPendingMessages();
  let retryCount = 0;

  for (const [messageId, message] of Object.entries(messages)) {
    if (message.state === 'pending') {
      try {
        console.debug(`[Background] Retrying message ${messageId}`);

        // Get the friend and retry sending
        const friend = await getFriendManager().getFriend(message.friendId);
        if (!friend) {
          console.warn(`[Background] Friend not found for retry: ${message.friendId}`);
          await markMessagePublishFailed(messageId, 'Friend not found');
          continue;
        }

        // Get the activity (for accept/decline)
        const activities = await storageManager.getMyActivities();
        const activity = Object.values(activities).find(a => a.id === message.activityId);

        try {
          let newEventId: string;

          // Retry based on message type
          if (message.messageType === 'join_accepted' && activity) {
            newEventId = await messagingManager.sendJoinAccepted(activity, friend);
          } else if (message.messageType === 'join_declined' && activity) {
            newEventId = await messagingManager.sendJoinDeclined(activity, friend);
          } else if (message.messageType === 'chat' && activity) {
            newEventId = await messagingManager.sendChatMessage(activity, friend, message.content || '');
          } else if (message.messageType === 'friend_request') {
            newEventId = await messagingManager.sendFriendRequestMessage(friend.pubkey, '');
          } else {
            throw new Error(`Unknown message type: ${message.messageType}`);
          }

          console.log(`[Background] Successfully retried message, new eventId: ${newEventId.substring(0, 16)}...`);
          await markMessagePublished(messageId);
          retryCount++;
        } catch (error) {
          // Publish failed again, increment retry count
          throw error;
        }
      } catch (error) {
        await markMessagePublishFailed(messageId, error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }

  if (retryCount > 0) {
    console.log(`[Background] Retried ${retryCount} pending messages`);
  }
}

/**
 * Show Discord coordination prompt when someone joins your activity
 * Uses the same selection algorithm as the joiner: inviter first, then invitees
 */
async function _showDiscordCoordinationPrompt(friend: Friend): Promise<void> {
  try {
    const { selectDiscordServer } = await import('../modules/activity-utils');
    const profile = await storageManager.getUserProfile();
    if (!profile) return;

    // Get friend's Discord info from stored profile (keyed by pubkey)
    const friendProfile = await storageManager.getFriendProfile(friend.pubkey);
    const friendDiscordInfo = friendProfile?.discord_link;

    // Determine which Discord to use: friend's first, then user's
    const discordInfo = selectDiscordServer(friendDiscordInfo, [
      { identifier: profile.uuid, discord_info: profile.discord_info },
    ]);

    if (!discordInfo) return;

    // Parse the Discord URL
    let discordUrl = discordInfo;
    if (!discordUrl.startsWith('http')) {
      if (discordUrl.includes('discord.gg/')) {
        discordUrl = `https://${discordUrl}`;
      } else {
        return; // Can't parse as URL
      }
    }

    // Show notification with Discord button
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('public/icon-48.png'),
      title: 'Ready to Coordinate',
      message: `${friend.local_name} joined! Want to chat on Discord?`,
      buttons: [{ title: 'Open Discord' }, { title: 'Dismiss' }],
      requireInteraction: false,
    });

    // Listen for button clicks
    chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
      if (buttonIndex === 0 && discordUrl) {
        chrome.tabs.create({ url: discordUrl, active: true });
      }
    });
  } catch (error) {
    console.debug('[Background] Discord coordination prompt failed:', error);
  }
}

/**
 * Clean up invites for activities the friend is no longer doing
 * If a friend stops watching something, any pending invite for that activity expires
 */
async function cleanupOrphanedInvites(
  friendId: string,
  currentActivities: Partial<Record<ServiceName, Activity>>
): Promise<void> {
  const pendingInvites = await storageManager.getPendingInvites();
  let removed = 0;

  for (const [activityId, inviteData] of Object.entries(pendingInvites)) {
    // Only check invites for this friend
    if (inviteData.friendId !== friendId) {
      continue;
    }

    // Check if friend still has this activity
    const friendHasActivity = Object.values(currentActivities).some(a => a?.id === activityId);

    if (!friendHasActivity) {
      // Friend no longer has this activity, remove the invite
      delete pendingInvites[activityId];
      removed++;
      console.debug(`[Background] Removed orphaned invite for activity ${activityId}`);
    }
  }

  if (removed > 0) {
    await storageManager.setPendingInvites(pendingInvites);
    console.debug(`[Background] Cleaned up ${removed} orphaned invite(s) for friend ${friendId}`);
  }
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Clean up background processes when service worker unloads
 */
async function cleanupOnUnload(): Promise<void> {
  try {
    if (activityDetector) {
      await activityDetector.stop();
      console.debug('[Background] Activity detector stopped');
    }


    // Stop metadata fetcher background processing
    await metadataFetcher.stopBackgroundFetcher();
    console.debug('[Background] Metadata fetcher stopped');

    console.log('[Background] Service worker cleanup complete');
  } catch (error) {
    console.error('[Background] Error during cleanup:', error);
  }
}

// Register unload handler
chrome.runtime.onSuspend?.addListener(async () => {
  console.log('[Background] Service worker suspending');
  await cleanupOnUnload();
});

// Clean up activities when tabs are closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const allActivities = await storageManager.getMyActivities();
    let removed = false;

    for (const [activityId, activity] of Object.entries(allActivities)) {
      if (activity?.metadata?.tabId === tabId) {
        // Clean up any tab-based video/stream activity (youtube-tab, netflix-tab, twitch-tab, video-tab)
        const isTabActivity = activity?.service?.includes('-tab') || activity?.service === 'video-tab';
        if (isTabActivity) {
          console.debug(`[Background] Removing ${activity.service} activity for closed tab ${tabId}: ${activity.id}`);
          delete allActivities[activityId];
          removed = true;
        }
      }
    }

    if (removed) {
      await storageManager.setMyActivities(allActivities);
    }
  } catch (error) {
    console.error(`[Background] Error cleaning up activity for closed tab ${tabId}:`, error);
  }
});

// ============================================================================
// STARTUP
// ============================================================================

console.log('[Background] Service worker loaded');

// Initialize on startup
/**
 * Export all logs from both profiles to storage for download
 * Uses chrome.storage to make logs accessible to popup for download
 */
async function dumpHangTimeLogs() {
  try {
    // Force sync all pending changes to storage (FileLogger writes via StorageManager which batches every 5s)
    await storageManager.forceSyncNow();

    // Get all file logs via StorageManager abstraction
    const logs = await storageManager.getAllFileLogs();

    console.log('[Background] Preparing logs for export...');

    // Store logs in a special key that the popup can access and download
    await storageManager.set(STORAGE_KEYS.LOGS_EXPORT, logs);
    // Ensure immediate persistence (popup reads this 500ms later)
    await storageManager.forceSyncNow();

    console.log('[Background] Logs prepared in storage for export');
    console.log('[Background] Profiles found:', Object.keys(logs).join(', '));

    return { success: true, profiles: Object.keys(logs) };
  } catch (error) {
    console.error('[Background] Failed to prepare logs:', error);
    throw error;
  }
}

/**
 * Register all message handlers for debugging and extension communication
 */
function _registerMessageHandlers(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DUMP_LOGS') {
      console.log('[Background] DUMP_LOGS request received');
      dumpHangTimeLogs()
        .then(() => {
          console.log('[Background] Logs dumped successfully');
          sendResponse({ success: true });
        })
        .catch((error) => {
          console.error('[Background] Failed to dump logs:', error);
          sendResponse({ success: false, error: String(error) });
        });
      return true; // Keep channel open for async response
    }
  });
  console.debug('[Background] Message handlers registered');
}

(async () => {
  try {
    await initializeExtension();
    await retryPendingInvites();
    await retryPendingMessages();
  } catch (error) {
    console.error('[Background] Failed to initialize:', error);
  }
})();

