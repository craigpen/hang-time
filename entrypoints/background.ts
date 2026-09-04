/**
 * Hang Time - Background Service Worker
 * Main orchestration center for the extension
 * Handles: lifecycle, message routing, activity detection, service integrations
 */

import { STORAGE_KEYS, ExtensionMessage, ExtensionResponse, ServiceName, DEFAULT_RELAY_URLS, Activity } from '../src/types';
import { RelayPool, relayPool } from '../src/modules/nostr';
import { storageManager } from '../src/modules/storage';
import { initializeIdentityManager, getIdentityManager } from '../src/modules/identity';
import { initializeFriendManager, getFriendManager } from '../src/modules/friends';
import { initializeMessagingManager, getMessagingManager } from '../src/modules/messaging';
import { initializeNotificationManager, getNotificationManager } from '../src/modules/notifications';
import { initializeActivityDatastore, getActivityDatastore } from '../src/modules/activity-datastore';
import { initializeGameLibraryManager, GameLibraryManager } from '../src/modules/game-library';
import { joinHandler } from '../src/modules/join-handler';
import { ActivityDetector } from '../src/modules/activity';
import { ActivityPublisher } from '../src/modules/publisher';
import { TabService } from '../src/modules/services/tabs';
import { SteamService } from '../src/modules/services/steam';
import { XboxService } from '../src/modules/services/xbox';
import { SpotifyService } from '../src/modules/services/spotify';
import { TwitchService } from '../src/modules/services/twitch';
import { initializeMetadataFetcher, metadataFetcher } from '../src/modules/metadata-fetcher';
import { ActivityDiagnostics } from '../src/modules/activity-diagnostics';
import { initializeFileLogger, getFileLogger } from '../src/modules/file-logger';
import { PublishQueue } from '../src/modules/publish-queue';
import { initializeCoWatcherDetector, getCoWatcherDetector } from '../src/modules/co-watcher-detection';
import { initializeSyncHandler, getSyncHandler } from '../src/modules/sync-handler';
import { registerContentScripts, reinjectContentScripts } from '../src/modules/content-script-registry';
import { inviteManager } from '../src/modules/invite-manager';
import { overlayCoordinator } from '../src/modules/overlay-coordinator';
import { nostrSubscriptionManager } from '../src/modules/nostr-subscription-manager';

// ============================================================================
// GLOBAL ERROR HANDLING
// ============================================================================

globalThis.addEventListener?.('unhandledrejection', (event) => {
  const error = event.reason;
  const errorMsg = error instanceof Error ? error.message : String(error);

  if (errorMsg.includes('replaced') || errorMsg.includes('have newer event')) {
    console.debug(`[Background] Relay rejected replaceable event (already has newer): ${errorMsg}`);
    event.preventDefault();
  } else if (errorMsg.includes('rate-limited')) {
    console.warn(`[Background] Relay rate-limited: ${errorMsg}`);
    event.preventDefault();
  } else {
    console.error(`[Background] Unhandled rejection: ${errorMsg}`, event.reason);
  }
});

// ============================================================================
// GLOBAL STATE
// ============================================================================

let initialized = false;
let isInitializing = false;
let initializationPromise: Promise<void> | null = null;
let activityDetector: ActivityDetector | null = null;
let activityPublisher: ActivityPublisher | null = null;
let publishQueue: PublishQueue | null = null;

// ============================================================================
// EXTENSION LIFECYCLE
// ============================================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[Background] Extension ${details.reason}`);

  if (details.reason === 'install') {
    await initializeExtension();
    const profile = await storageManager.getUserProfile();
    if (!profile) {
      await getIdentityManager().generateIdentifier();
      console.log('[Background] Generated user identifier');
    }
    console.log('[Background] Fresh install: re-injecting into pre-existing tabs...');
    await reinjectContentScripts();
  } else if (details.reason === 'update') {
    console.log('[Background] Extension updated, re-injecting content scripts...');
    await registerContentScripts();
    await reinjectContentScripts();
  }
});

chrome.runtime.onStartup?.addListener(async () => {
  console.log('[Background] Extension startup detected');
  await initializeExtension();

  const session = await storageManager.getActiveSession();
  if (session?.stale_at) {
    console.log('[Background] Stale session found on startup, purging');
    await storageManager.clearActiveSession();
  }

  await reinjectContentScripts();
});

globalThis.addEventListener?.('beforeunload', () => {
  console.debug('[Background] Service worker unloading, flushing state...');
  Promise.all([
    storageManager.forceSyncNow().catch(error => {
      console.error('[Background] Failed to sync cache on unload:', error);
    }),
    nostrSubscriptionManager.persistEventDeduplicatorState().catch(error => {
      console.error('[Background] Failed to persist event dedup on unload:', error);
    })
  ]).catch(() => {});
});

function _hookConsoleToFileLogger(logger: any): void {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalDebug = console.debug;

  console.log = (...args: any[]) => {
    originalLog(...args);
    try {
      const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
      logger.log('Console', 'INFO', message);
    } catch {}
  };

  console.error = (...args: any[]) => {
    originalError(...args);
    try {
      const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
      logger.log('Console', 'ERROR', message);
    } catch {}
  };

  console.warn = (...args: any[]) => {
    originalWarn(...args);
    try {
      const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
      logger.log('Console', 'WARN', message);
    } catch {}
  };

  console.debug = (...args: any[]) => {
    originalDebug(...args);
    try {
      const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
      logger.log('Console', 'DEBUG', message);
    } catch {}
  };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeExtension(): Promise<void> {
  if (initialized) {
    return;
  }

  if (isInitializing) {
    if (initializationPromise) {
      return initializationPromise;
    }
  }

  isInitializing = true;

  initializationPromise = (async () => {
    try {
      console.log('[Background] Initializing extension...');

      await storageManager.initialize();
      initializeIdentityManager(storageManager);

      const identifier = await getIdentityManager().getIdentifier();
      await storageManager.setSessionId(identifier);

      try {
        const userProfile = await storageManager.getUserProfile();
        const profileId = userProfile?.uuid || 'unknown';
        initializeFileLogger(profileId, storageManager);
        const logger = getFileLogger();
        _hookConsoleToFileLogger(logger);
      } catch (error) {
        console.error('[Background] File logger initialization failed:', error);
      }

      try {
        await registerContentScripts();
      } catch (error) {
        console.error('[Background] Failed to register content scripts on startup:', error);
      }

      setTimeout(async () => {
        await overlayCoordinator.checkForOrphanedActivity();
      }, 3000);

      initializeFriendManager(storageManager);

      try {
        const profile = await storageManager.getUserProfile();
        let relayUrls: string[] = RelayPool.DEFAULT_RELAYS;

        if (profile && profile.publisher_config) {
          const expectedRelays: Record<string, boolean> = {};
          DEFAULT_RELAY_URLS.forEach(url => {
            const domain = url.replace(/^wss?:\/\//, '').replace(/\/$/, '');
            expectedRelays[domain] = true;
          });

          const storedRelays = profile.publisher_config['relays'] || {};
          const needsSync = JSON.stringify(storedRelays) !== JSON.stringify(expectedRelays);

          if (needsSync) {
            profile.publisher_config['relays'] = expectedRelays;
            await storageManager.setUserProfile(profile);
          }
        }

        if (profile && profile.publisher_config && profile.publisher_config['relays']) {
          const enabledRelays = Object.entries(profile.publisher_config['relays'])
            .filter(([, enabled]) => enabled)
            .map(([domain]) => {
              if (domain.startsWith('wss://') || domain.startsWith('ws://')) {
                return domain;
              }
              return `wss://${domain}/`;
            });

          if (enabledRelays.length > 0) {
            relayUrls = enabledRelays;
          }
        }

        relayPool.setStorageManager(storageManager);
        await relayPool.connect(relayUrls);
      } catch (error) {
        console.warn('[Background] Failed to connect to relays, will retry in background:', error);
      }

      initializeMessagingManager(storageManager, getIdentityManager(), relayPool);
      initializeNotificationManager(storageManager);
      await nostrSubscriptionManager.initializeEventDeduplicator();
      initializeActivityDatastore(storageManager);
      initializeGameLibraryManager(storageManager);

      const gameLibraryManager = GameLibraryManager.getInstance(storageManager);
      gameLibraryManager.setNostrDependencies(relayPool, getIdentityManager());

      let userGames: any[] = [];
      try {
        userGames = await gameLibraryManager.fetchMyGameLibrary();
        if (userGames.length > 0) {
          await gameLibraryManager.publishGameLibrary();
        }
      } catch (error) {
        console.warn('[Background] Failed to fetch/publish game library:', error);
      }

      initializeMetadataFetcher(storageManager);
      await metadataFetcher.startBackgroundFetcher();

      if (userGames.length > 0) {
        const gamesNeedingMetadata = await _findGamesMissingMetadata(userGames);
        if (gamesNeedingMetadata.length > 0) {
          await metadataFetcher.scheduleBackgroundRefresh(gamesNeedingMetadata);
        }
      }

      activityDetector = new ActivityDetector(storageManager);
      activityDetector.registerService('spotify-api', new SpotifyService(storageManager));
      activityDetector.registerService('twitch-api', new TwitchService(storageManager));
      activityDetector.registerService('steam-api', new SteamService(storageManager));
      activityDetector.registerService('xbox-api', new XboxService(storageManager));
      activityDetector.registerService('tabs', new TabService(storageManager));

      await activityDetector.start();

      try {
        activityPublisher = new ActivityPublisher(relayPool, storageManager, getIdentityManager());
        await activityPublisher.start();
      } catch (error) {
        console.error('[Background] Failed to initialize activity publisher:', error);
      }

      try {
        const profile = await storageManager.getUserProfile();
        const publishIntervalMs = profile?.publisher_config?.rate_ms || 12000;
        publishQueue = new PublishQueue(relayPool, storageManager, publishIntervalMs);
        publishQueue.setIdentityManager(getIdentityManager());
        publishQueue.start();

        const msgMgr = getMessagingManager();
        msgMgr.setPublishQueue(publishQueue);

        if (activityPublisher) {
          activityPublisher.setPublishQueue(publishQueue);
          publishQueue.setActivityPublisher(activityPublisher);
        }

        const gameLibMgr = GameLibraryManager.getInstance(storageManager);
        gameLibMgr.setPublishQueue(publishQueue);

        if (activityPublisher) {
          await activityPublisher.publishProfile();
        }
      } catch (error) {
        console.error('[Background] Failed to initialize publish queue or publish profile:', error);
      }

      const friendManager = getFriendManager();
      const friends = await friendManager.getAllFriends();
      for (const friend of friends) {
        try {
          await nostrSubscriptionManager.subscribeToFriend(friend.uuid);
        } catch (error) {
          console.warn(`[Background] Failed to subscribe to friend ${friend.uuid}:`, error);
        }
      }

      try {
        const friendPubkeys = friends.map((f) => friendManager.derivePubkeyFromIdentifier(f.uuid));
        if (friendPubkeys.length > 0) {
          await gameLibraryManager.subscribeToFriendGames(friendPubkeys);
        }
      } catch (error) {
        console.warn('[Background] Failed to subscribe to friend game libraries:', error);
      }

      try {
        await nostrSubscriptionManager.subscribeToIncomingMessages();
      } catch (error) {
        console.error('[Background] Failed to set up incoming message subscription:', error);
      }

      try {
        const datastore = getActivityDatastore();
        const summary = await datastore.getSummary();
        console.log('[Background] Activity integrity:', summary);
      } catch (error) {
        console.warn('[Background] Could not run initial integrity check:', error);
      }

      try {
        initializeCoWatcherDetector(storageManager, friendManager);
      } catch (error) {
        console.error('[Background] Failed to initialize co-watcher detector:', error);
      }

      try {
        initializeSyncHandler(relayPool, storageManager, getIdentityManager(), friendManager);
        if (publishQueue) {
          getSyncHandler().setPublishQueue(publishQueue);
        }
      } catch (error) {
        console.error('[Background] Failed to initialize sync handler:', error);
      }

      _registerMessageHandlers();
      _startPeriodicCleanup();
      _startCoWatcherDetectionCycle();

      initialized = true;
    } catch (error) {
      console.error('[Background] Initialization failed:', error);
      throw error;
    } finally {
      isInitializing = false;
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

// ============================================================================
// CO-WATCHER DETECTION & CLEANUP CYCLES
// ============================================================================

function _startPeriodicCleanup(): void {
  const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  setInterval(async () => {
    try {
      const datastore = getActivityDatastore();
      const { corruptedRemoved, ghostsRemoved } = await datastore.cleanup();
      const expiredInvites = await storageManager.removeExpiredInvites();
      const staleNetflixTitles = await storageManager.removeStaleNetflixTitle();

      const { getEventDeduplicator } = await import('../src/modules/event-deduplicator');
      const dedup = getEventDeduplicator();
      const processedEventIds = dedup.getProcessedEventIds();
      await storageManager.setProcessedEventIds(processedEventIds);

      if (corruptedRemoved > 0 || ghostsRemoved > 0 || expiredInvites > 0 || staleNetflixTitles > 0) {
        console.log('[Background] 🧹 Cleanup cycle complete:', {
          corruptedRemoved,
          ghostsRemoved,
          expiredInvites,
          staleNetflixTitles,
        });
      }
    } catch (error) {
      console.error('[Background] Cleanup cycle failed:', error);
    }
  }, CLEANUP_INTERVAL_MS);
}

function _startCoWatcherDetectionCycle(): void {
  const DETECTION_INTERVAL_MS = 5000;
  let callCount = 0;

  setInterval(async () => {
    callCount++;
    try {
      const detector = getCoWatcherDetector();
      await overlayCoordinator.broadcastCoWatchUpdate(detector, callCount);
    } catch (e) {
      console.error('[Background] Co-watcher detection cycle error:', e);
    }
  }, DETECTION_INTERVAL_MS);
}

// ============================================================================
// PORT & TAB CONNECTIONS
// ============================================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith('content-script-')) {
    const tabId = port.sender?.tab?.id;
    const activePorts = overlayCoordinator.getActivePorts();
    const connectedTabs = overlayCoordinator.getConnectedTabIds();

    if (tabId !== undefined) {
      activePorts.set(tabId, port);
      connectedTabs.add(tabId);
    }

    port.onMessage.addListener(async (message) => {
      try {
        if (message.type === 'PING') {
          try {
            port.postMessage({ type: 'PONG' });
          } catch (e) {}
        } else if (message.type === 'GET_USER_ID') {
          const profile = await storageManager.getUserProfile();
          port.postMessage({ type: 'USER_ID', data: profile?.uuid || 'unknown' });
        } else if (message.type === 'GET_OVERLAY_STATE') {
          const detector = getCoWatcherDetector();
          await overlayCoordinator.broadcastCoWatchUpdate(detector);
        } else if (message.type === 'LEAVE_SESSION') {
          await storageManager.clearActiveSession();
          overlayCoordinator.broadcastToContentScripts({
            type: 'CO_WATCH_UPDATE',
            data: {
              session_members: [],
              watching_together: [],
              messages: [],
              host_nickname: undefined,
              is_user_host: false,
              user_nickname: '',
              co_watcher_activities: {},
            },
          });
          overlayCoordinator.broadcastToContentScripts({ type: 'SESSION_ENDED' });
        } else if (message.type === 'JOIN_GUEST_ACTIVITY') {
          try {
            const { guest_uuid, activity_id, url } = message.data || {};
            let targetUrl = url;

            if (!targetUrl && guest_uuid) {
              const friend = await getFriendManager().getFriend(guest_uuid);
              if (friend?.current_activities) {
                const friendActivity = Object.values(friend.current_activities).find(a => !activity_id || (a as Activity)?.id === activity_id) || Object.values(friend.current_activities)[0];
                targetUrl = (friendActivity as Activity)?.url;
              }
            }

            if (targetUrl) {
              if (tabId !== undefined && tabId !== -1) {
                await chrome.tabs.update(tabId, { url: targetUrl });
              } else {
                await chrome.tabs.create({ url: targetUrl, active: true });
              }
            }
          } catch (e) {
            console.error('[Background] Failed to handle JOIN_GUEST_ACTIVITY:', e);
          }
        } else if (message.type === 'CONTENT_SCRIPT_ACTIVITY') {
          await overlayCoordinator.handleContentScriptActivity(message.data?.key, message.data?.value, tabId, async () => {
            if (activityDetector) {
              await activityDetector.detectAndPublish();
            }
          });
        } else if (message.type === 'CONTENT_SCRIPT_ORPHANED') {
          await overlayCoordinator.markActivityAsDisconnected(tabId || 0);
        }
      } catch (error) {
        console.error(`[Background] Port message handler error:`, error);
      }
    });

    port.onDisconnect.addListener(() => {
      if (tabId !== undefined) {
        activePorts.delete(tabId);
        overlayCoordinator.markActivityAsDisconnected(tabId);
      }
    });

    try {
      port.postMessage({ type: 'PONG' });
    } catch (error) {}
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    if (overlayCoordinator.getConnectedTabIds().has(tabId)) {
      return;
    }

    if (
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('edge-extension://')
    ) {
      return;
    }

    const failedAttempts = overlayCoordinator.getFailedInjectionAttempts();
    const activationCount = (failedAttempts.get(tabId) || 0) + 1;
    failedAttempts.set(tabId, activationCount);

    await overlayCoordinator.retryInjectionWithBackoff(tabId, 3);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const allActivities = await storageManager.getMyActivities();
    let removed = false;

    for (const [activityId, activity] of Object.entries(allActivities)) {
      if (activity?.metadata?.tabId === tabId) {
        const isTabActivity = activity?.service?.includes('-tab') || activity?.service === 'video-tab';
        if (isTabActivity) {
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
// MESSAGE ROUTER (chrome.runtime.onMessage)
// ============================================================================

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    (async () => {
      try {
        if (!message || !message.type) {
          sendResponse({ success: false, error: 'Invalid message format' });
          return;
        }

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

    return true;
  }
);

import { AuthRouter, FriendsRouter, ActivityRouter, SettingsRouter } from '../src/modules/routers';

async function _handleMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  switch (message.type) {
    case 'GET_STORAGE':
      return { success: true, data: await storageManager.get(message.data?.['key']) };

    case 'GET_CURRENT_ACTIVITY':
      return ActivityRouter.getCurrentActivity(activityDetector, message.data?.['service']);

    case 'GET_ALL_ACTIVE_ACTIVITIES':
      return ActivityRouter.getAllActiveActivities(activityDetector);

    case 'GET_ALL_ACTIVITIES':
      return ActivityRouter.getAllActivities();

    case 'GET_BROWSER_ACTIVITIES':
      return ActivityRouter.getBrowserActivities(activityDetector);

    case 'GET_ACTIVE_FRIENDS':
      return FriendsRouter.getActiveFriends();

    case 'GET_ALL_FRIENDS':
      return FriendsRouter.getAllFriends();

    case 'GET_FRIEND':
      return FriendsRouter.getFriend(message.data?.['id']);

    case 'GET_FRIEND_ACTIVITY_HISTORY':
      return FriendsRouter.getFriendActivityHistory(message.data?.['friendId']);

    case 'GET_USER_IDENTIFIER':
      return AuthRouter.getUserIdentifier();

    case 'ADD_FRIEND':
      return FriendsRouter.addFriend(message.data?.['identifier'], message.data?.['localName']);

    case 'REMOVE_FRIEND':
      return FriendsRouter.removeFriend(message.data?.['friendId']);

    case 'RENAME_FRIEND':
      return FriendsRouter.renameFriend(message.data?.['friendId'], message.data?.['newName']);

    case 'ACCEPT_FRIEND_REQUEST':
      return FriendsRouter.acceptFriendRequest(message.data?.['friendId']);

    case 'DECLINE_FRIEND_REQUEST':
      return FriendsRouter.declineFriendRequest(message.data?.['friendId']);

    case 'SEND_MESSAGE':
      return FriendsRouter.sendMessage(message.data?.['activity'], message.data?.['friendId'], message.data?.['content']);

    case 'TOGGLE_SERVICE':
      return ActivityRouter.toggleService(message.data?.['service'], message.data?.['enabled']);

    case 'SAVE_SETTINGS':
      return SettingsRouter.saveSettings(message.data, publishQueue, activityPublisher, () => SettingsRouter.refreshGameLibrary());

    case 'GET_DIAGNOSTICS':
      return SettingsRouter.getDiagnostics();

    case 'RESTORE_SETTINGS':
      return SettingsRouter.restoreSettings(message.data);

    case 'MUTE_FRIEND':
      return FriendsRouter.muteFriend(message.data?.['friendId'], message.data?.['mute']);

    case 'GET_DND_MODE':
      return SettingsRouter.getDndMode();

    case 'SET_DND_MODE':
      return SettingsRouter.setDndMode(message.data?.['enabled'], activityPublisher);

    case 'GET_OAUTH_STATUS':
      return AuthRouter.getOAuthStatus(message.data?.['service']);

    case 'AUTHENTICATE_SERVICE':
      return AuthRouter.authenticateService(message.data?.['service']);

    case 'GET_NETFLIX_EXTRACTION_LOGS':
      return SettingsRouter.getNetflixExtractionLogs();

    case 'GET_NETFLIX_DEBUG_CAPTURES':
      return SettingsRouter.getNetflixDebugCaptures();

    case 'DISCONNECT_SERVICE':
      return AuthRouter.disconnectService(message.data?.['service']);

    case 'HANDLE_OAUTH_CALLBACK':
      return AuthRouter.handleOAuthCallback(message.data?.['service'], message.data?.['code']);

    case 'JOIN_ACTIVITY':
      return ActivityRouter.joinActivity(message.data?.['friendId'], message.data?.['activity']);

    case 'SEND_INVITE':
      return inviteManager.sendInvite(message.data?.['activity'], message.data?.['friendId']);

    case 'DECLINE_INVITE':
      return inviteManager.declineInvite(message.data?.['activityId'], message.data?.['friendId'], message.data?.['activity']);

    case 'SEND_JOIN_NOTIFICATION':
      return inviteManager.sendJoinNotification(message.data?.['activity'], message.data?.['friendId'], message.data?.['accepted']);

    case 'TEST_NOTIFICATION':
      return SettingsRouter.sendTestNotification();

    case 'REFRESH_GAME_LIBRARY':
      return SettingsRouter.refreshGameLibrary();

    case 'CONTENT_SCRIPT_ACTIVITY':
      return overlayCoordinator.handleContentScriptActivity(message.data?.['key'], message.data?.['value'], message.data?.['tabId'], async () => {
        if (activityDetector) {
          await activityDetector.detectAndPublish();
        }
      });

    case 'CONTENT_SCRIPT_ORPHANED':
      await overlayCoordinator.markActivityAsDisconnected(0);
      return { success: true };

    case 'DEBUG_STORAGE':
      return SettingsRouter.debugStorage();

    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

async function dumpHangTimeLogs(): Promise<{ success: boolean; profiles: string[] }> {
  try {
    await storageManager.forceSyncNow();
    const logs = await storageManager.getAllFileLogs();
    await storageManager.set(STORAGE_KEYS.LOGS_EXPORT, logs);
    await storageManager.forceSyncNow();
    return { success: true, profiles: Object.keys(logs) };
  } catch (error) {
    console.error('[Background] Failed to prepare logs:', error);
    throw error;
  }
}

function _registerMessageHandlers(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'DUMP_LOGS') {
      dumpHangTimeLogs()
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: String(error) }));
      return true;
    }
    return false;
  });
}

// Cleanup on unload
async function cleanupOnUnload(): Promise<void> {
  try {
    if (activityDetector) {
      await activityDetector.stop();
    }
    await metadataFetcher.stopBackgroundFetcher();
  } catch (error) {
    console.error('[Background] Error during cleanup:', error);
  }
}

chrome.runtime.onSuspend?.addListener(async () => {
  await cleanupOnUnload();
});

// Auto-run startup
(async () => {
  try {
    await initializeExtension();
    await inviteManager.retryPendingInvites();
    await inviteManager.retryPendingMessages();
  } catch (error) {
    console.error('[Background] Failed to initialize:', error);
  }
})();
