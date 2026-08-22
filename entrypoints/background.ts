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

async function _handleMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  switch (message.type) {
    case 'GET_STORAGE':
      return { success: true, data: await storageManager.get(message.data?.['key']) };

    case 'GET_CURRENT_ACTIVITY':
      return _getCurrentActivity(message.data?.['service']);

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
      return _getFriend(message.data?.['id']);

    case 'GET_FRIEND_ACTIVITY_HISTORY':
      return _getFriendActivityHistory(message.data?.['friendId']);

    case 'GET_USER_IDENTIFIER':
      return _getUserIdentifier();

    case 'ADD_FRIEND':
      return _addFriend(message.data?.['identifier'], message.data?.['localName']);

    case 'REMOVE_FRIEND':
      return _removeFriend(message.data?.['friendId']);

    case 'RENAME_FRIEND':
      return _renameFriend(message.data?.['friendId'], message.data?.['newName']);

    case 'ACCEPT_FRIEND_REQUEST':
      return _acceptFriendRequest(message.data?.['friendId']);

    case 'DECLINE_FRIEND_REQUEST':
      return _declineFriendRequest(message.data?.['friendId']);

    case 'SEND_MESSAGE':
      return _sendMessage(message.data?.['activity'], message.data?.['friendId'], message.data?.['content']);

    case 'TOGGLE_SERVICE':
      return _toggleService(message.data?.['service'], message.data?.['enabled']);

    case 'SAVE_SETTINGS':
      return _saveSettings(message.data);

    case 'GET_DIAGNOSTICS':
      return _getDiagnostics();

    case 'RESTORE_SETTINGS':
      return _restoreSettings(message.data);

    case 'MUTE_FRIEND':
      return _muteFriend(message.data?.['friendId'], message.data?.['mute']);

    case 'GET_DND_MODE':
      return _getDndMode();

    case 'SET_DND_MODE':
      return _setDndMode(message.data?.['enabled']);

    case 'GET_OAUTH_STATUS':
      return _getOAuthStatus(message.data?.['service']);

    case 'AUTHENTICATE_SERVICE':
      return _authenticateService(message.data?.['service']);

    case 'GET_NETFLIX_EXTRACTION_LOGS':
      return _getNetflixExtractionLogs();

    case 'GET_NETFLIX_DEBUG_CAPTURES':
      return _getNetflixDebugCaptures();

    case 'DISCONNECT_SERVICE':
      return _disconnectService(message.data?.['service']);

    case 'HANDLE_OAUTH_CALLBACK':
      return _handleOAuthCallback(message.data?.['service'], message.data?.['code']);

    case 'JOIN_ACTIVITY':
      return _joinActivity(message.data?.['friendId'], message.data?.['activity']);

    case 'SEND_INVITE':
      return inviteManager.sendInvite(message.data?.['activity'], message.data?.['friendId']);

    case 'DECLINE_INVITE':
      return inviteManager.declineInvite(message.data?.['activityId'], message.data?.['friendId'], message.data?.['activity']);

    case 'SEND_JOIN_NOTIFICATION':
      return inviteManager.sendJoinNotification(message.data?.['activity'], message.data?.['friendId'], message.data?.['accepted']);

    case 'TEST_NOTIFICATION':
      return _sendTestNotification();

    case 'REFRESH_GAME_LIBRARY':
      return _refreshGameLibrary();

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
              id: friends[0].uuid,
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
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================================
// DOMAIN DELEGATE HANDLERS
// ============================================================================

async function _getCurrentActivity(service?: string): Promise<ExtensionResponse> {
  if (!activityDetector) {
    return { success: false, error: 'Activity detector not initialized' };
  }
  if (service) {
    try {
      const serviceModule = activityDetector['services']?.get(service);
      if (serviceModule) {
        const activity = await serviceModule.getCurrentActivity();
        return { success: true, data: activity };
      }
      return { success: false, error: `Service not found: ${service}` };
    } catch (error) {
      return { success: false, error: `Failed to get ${service} activity` };
    }
  }
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
    const myActivities = await storageManager.getMyActivities();
    const friendManager = getFriendManager();
    const friends = await friendManager.getAllFriends();

    const friendsData = friends.map((friend) => ({
      uuid: friend.uuid,
      local_name: friend.local_name,
      current_activities: friend.current_activities || {},
      state: friend.state,
      dnd: friend.dnd ?? false,
      muted: friend.muted ?? false,
      initiated_by_me: friend.initiated_by_me,
      pubkey: friend.pubkey,
      last_seen: friend.last_seen,
    }));

    return {
      success: true,
      data: {
        myActivities,
        friends: friendsData,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get activities' };
  }
}

async function _getBrowserActivities(): Promise<ExtensionResponse> {
  if (!activityDetector) {
    return { success: true, data: { 'netflix-tab': null, 'youtube-tab': null, 'twitch-tab': null } };
  }
  const tabService = activityDetector.getService('tabs') as any;
  if (!tabService) {
    return { success: true, data: { 'netflix-tab': null, 'youtube-tab': null, 'twitch-tab': null } };
  }
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
    const activeFriends = await friendManager.getActiveFriends();
    return { success: true, data: activeFriends };
  } catch (error) {
    return { success: false, error: 'Failed to get active friends' };
  }
}

async function _getAllFriends(): Promise<ExtensionResponse> {
  try {
    const friendManager = getFriendManager();
    const friends = await friendManager.getAllFriends();
    return { success: true, data: friends };
  } catch (error) {
    return { success: false, error: 'Failed to get friends' };
  }
}

async function _getFriend(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) return { success: false, error: 'Friend ID required' };
  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendId);
    if (!friend) return { success: false, error: `Friend not found: ${friendId}` };
    return { success: true, data: friend };
  } catch (error) {
    return { success: false, error: 'Failed to get friend' };
  }
}

async function _getFriendActivityHistory(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) return { success: false, error: 'Friend ID required' };
  try {
    const history = await storageManager.getActivityHistory(friendId);
    return { success: true, data: history };
  } catch (error) {
    return { success: false, error: 'Failed to get history' };
  }
}

async function _getUserIdentifier(): Promise<ExtensionResponse> {
  try {
    const identifier = await getIdentityManager().getIdentifier();
    return { success: true, data: { identifier } };
  } catch (error) {
    return { success: false, error: 'Failed to get identifier' };
  }
}

async function _addFriend(identifier?: string, localName?: string): Promise<ExtensionResponse> {
  if (!identifier) return { success: false, error: 'Friend identifier required' };
  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.addFriend(identifier, localName || 'Friend');
    await nostrSubscriptionManager.subscribeToFriend(friend.uuid);

    try {
      const messagingManager = getMessagingManager();
      const userProfile = await storageManager.getUserProfile();
      const myDisplayName = userProfile?.nickname || (await getIdentityManager().getIdentifier()) || '';
      const eventId = await messagingManager.sendFriendRequestMessage(friend.pubkey, myDisplayName);
      await inviteManager.trackPendingMessage(eventId, 'friend_request', friend.uuid, 'friend_request', myDisplayName);
    } catch (msgError) {
      console.warn('[Background] Failed to send friend request notification message:', msgError);
    }

    return { success: true, data: friend };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add friend' };
  }
}

async function _removeFriend(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) return { success: false, error: 'Friend ID required' };
  try {
    const friendManager = getFriendManager();
    await friendManager.removeFriend(friendId);
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to remove friend' };
  }
}

async function _renameFriend(friendId?: string, newName?: string): Promise<ExtensionResponse> {
  if (!friendId || !newName) return { success: false, error: 'Friend ID and new name required' };
  try {
    const friendManager = getFriendManager();
    await friendManager.renameFriend(friendId, newName);
    const updated = await friendManager.getFriend(friendId);
    return { success: true, data: updated };
  } catch (error) {
    return { success: false, error: 'Failed to rename friend' };
  }
}

async function _acceptFriendRequest(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) return { success: false, error: 'Friend ID required' };
  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendId);
    if (!friend) return { success: false, error: 'Friend not found' };

    await friendManager.acceptFriendRequest(friendId);
    const updated = await friendManager.getFriend(friendId);
    await nostrSubscriptionManager.subscribeToFriend(friend.uuid);

    try {
      const messagingManager = getMessagingManager();
      const syntheticActivity: Activity = {
        id: `friend-request-${friend.uuid}`,
        service: 'spotify-api',
        content: 'Friend Request',
        timestamp: Date.now(),
        freshness_timestamp: Date.now(),
        state: 'stopped',
        metadata: {},
      };
      await messagingManager.sendJoinAccepted(syntheticActivity, friend);
    } catch (msgError) {
      console.warn('[Background] Failed to send accept DM to friend:', msgError);
    }

    return { success: true, data: updated };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to accept friend request' };
  }
}

async function _declineFriendRequest(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) return { success: false, error: 'Friend ID required' };
  try {
    const friendManager = getFriendManager();
    await friendManager.removeFriend(friendId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to decline friend request' };
  }
}

async function _sendMessage(activity?: any, friendId?: string, content?: string): Promise<ExtensionResponse> {
  if (!friendId || !content) return { success: false, error: 'friendId and content required' };
  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendId);
    if (!friend) return { success: false, error: `Friend not found: ${friendId}` };

    const messagingManager = getMessagingManager();
    const eventId = await messagingManager.sendChatMessage(activity || null, friend, content);

    const messageActivityId = activity?.id || 'chat';
    await inviteManager.trackPendingMessage(eventId, 'chat', friend.uuid, messageActivityId, content);

    return { success: true, data: { eventId } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send message' };
  }
}

async function _toggleService(service?: string, enabled?: boolean): Promise<ExtensionResponse> {
  if (!service || enabled === undefined) return { success: false, error: 'Service and enabled required' };
  try {
    const profile = await storageManager.getUserProfile();
    if (!profile) return { success: false, error: 'User profile not found' };

    const serviceTyped = service as keyof typeof profile.services_enabled;
    profile.services_enabled[serviceTyped] = enabled;
    await storageManager.setUserProfile(profile);

    return { success: true, data: { service, enabled } };
  } catch (error) {
    return { success: false, error: 'Failed to toggle service' };
  }
}

async function _saveSettings(data?: any): Promise<ExtensionResponse> {
  if (!data) return { success: false, error: 'settings data required' };
  try {
    const profile = await storageManager.getUserProfile();
    if (!profile) return { success: false, error: 'user profile not found' };

    if (data.nickname !== undefined) profile.nickname = data.nickname;
    if (data.discord_info !== undefined) profile.discord_info = data.discord_info;
    if (data.services_enabled) profile.services_enabled = { ...profile.services_enabled, ...data.services_enabled };
    if (data.notification_preferences !== undefined) profile.notification_preferences = data.notification_preferences;
    if (data.steam_id !== undefined || data.steam_api_key !== undefined) {
      profile.steam_config = profile.steam_config || { enabled: false, connection_type: 'api_key' };
      if (data.steam_id !== undefined) profile.steam_config.steam_id = data.steam_id;
      if (data.steam_api_key !== undefined) profile.steam_config.api_key = data.steam_api_key;
      if (profile.steam_config.steam_id && profile.steam_config.api_key) {
        profile.steam_config.enabled = true;
      }
    }
    if (data.publisher_config !== undefined) {
      profile.publisher_config = { ...(profile.publisher_config || {}), ...data.publisher_config };
    }
    if (data.game_discovery_enabled !== undefined) profile.game_discovery_enabled = data.game_discovery_enabled;
    if (data.theme !== undefined) profile.theme = data.theme;

    await storageManager.setUserProfile(profile);

    if (data.publisher_config?.rate_ms !== undefined && publishQueue) {
      publishQueue.setPublishInterval(data.publisher_config.rate_ms);
    }

    if ((data.steam_id !== undefined || data.steam_api_key !== undefined) && profile.steam_config?.steam_id && profile.steam_config?.api_key) {
      _refreshGameLibrary().catch(() => {});
    }

    if (data.nickname !== undefined || data.discord_info !== undefined) {
      if (activityPublisher) {
        await activityPublisher.publishProfile().catch(() => {});
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to save settings' };
  }
}

async function _restoreSettings(data?: any): Promise<ExtensionResponse> {
  if (!data || !data.data) return { success: false, error: 'restore data required' };
  try {
    const profileData = data.data;
    if (!profileData.uuid && !profileData.pubkey && !profileData.identifier) {
      return { success: false, error: 'invalid backup format' };
    }

    const currentProfile = await storageManager.getUserProfile();
    if (!currentProfile) return { success: false, error: 'user profile not found' };

    const restoredProfile: any = { ...profileData };
    restoredProfile.uuid = currentProfile.uuid;
    restoredProfile.pubkey = currentProfile.pubkey;

    await storageManager.setUserProfile(restoredProfile);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to restore settings' };
  }
}

async function _getDiagnostics(): Promise<ExtensionResponse> {
  try {
    const diagnostics = ActivityDiagnostics.getInstance(storageManager);
    const summary = await diagnostics.exportDiagnostics();
    return { success: true, data: summary };
  } catch (error) {
    return { success: false, error: 'Failed to get diagnostics' };
  }
}

async function _muteFriend(friendId?: string, mute?: boolean): Promise<ExtensionResponse> {
  if (!friendId || mute === undefined) return { success: false, error: 'friendId and mute required' };
  try {
    const friendManager = getFriendManager();
    if (mute) {
      await friendManager.muteFriend(friendId);
    } else {
      await friendManager.unmuteFriend(friendId);
    }
    const updated = await friendManager.getFriend(friendId);
    return { success: true, data: updated };
  } catch (error) {
    return { success: false, error: 'Failed to update mute state' };
  }
}

async function _getDndMode(): Promise<ExtensionResponse> {
  try {
    const profile = await storageManager.getUserProfile();
    return { success: true, data: { enabled: profile?.dnd_enabled ?? false } };
  } catch (error) {
    return { success: false, error: 'Failed to get DND mode' };
  }
}

async function _setDndMode(enabled?: boolean): Promise<ExtensionResponse> {
  if (enabled === undefined) return { success: false, error: 'enabled required' };
  try {
    const profile = await storageManager.getUserProfile();
    if (!profile) return { success: false, error: 'User profile not found' };

    profile.dnd_enabled = enabled;
    await storageManager.setUserProfile(profile);

    if (enabled) {
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
    }

    if (activityPublisher) {
      await activityPublisher.publishActivityIfAllowed().catch(() => {});
    }

    return { success: true, data: { enabled } };
  } catch (error) {
    return { success: false, error: 'Failed to set DND mode' };
  }
}

async function _getOAuthStatus(service?: string): Promise<ExtensionResponse> {
  if (!service) return { success: false, error: 'service required' };
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
    return { success: false, error: 'Failed to get OAuth status' };
  }
}

async function _authenticateService(service?: string): Promise<ExtensionResponse> {
  if (!service) return { success: false, error: 'service required' };
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
    return { success: false, error: 'Failed to get auth URL' };
  }
}

async function _disconnectService(service?: string): Promise<ExtensionResponse> {
  if (!service) return { success: false, error: 'service required' };
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

    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to disconnect' };
  }
}

async function _handleOAuthCallback(service?: string, code?: string): Promise<ExtensionResponse> {
  if (!service || !code) return { success: false, error: 'service and code required' };
  try {
    const serviceStr = service as string;

    if (serviceStr === 'spotify' || serviceStr === 'spotify-api') {
      const spotifyService = new SpotifyService(storageManager);
      await spotifyService.handleAuthCallback(code);
    } else if (serviceStr === 'twitch' || serviceStr === 'twitch-api') {
      const twitchService = new TwitchService(storageManager);
      await twitchService.handleAuthCallback(code);
    } else {
      return { success: false, error: `OAuth callback not supported for ${service}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to handle OAuth callback' };
  }
}

async function _joinActivity(friendId?: string, activity?: any): Promise<ExtensionResponse> {
  if (!friendId || !activity) return { success: false, error: 'friendId and activity required' };
  try {
    await joinHandler.joinActivity(friendId, activity);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to join activity' };
  }
}

async function _sendTestNotification(): Promise<ExtensionResponse> {
  try {
    const notificationManager = getNotificationManager();
    await notificationManager.notify('Test Notification', 'If you see this, notifications are working!');
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to send test notification' };
  }
}

async function _refreshGameLibrary(): Promise<ExtensionResponse> {
  try {
    const gameLibraryManager = GameLibraryManager.getInstance(storageManager);
    const userGames = await gameLibraryManager.fetchMyGameLibrary();
    await gameLibraryManager.publishGameLibrary();

    const gamesNeedingMetadata = await _findGamesMissingMetadata(userGames);
    if (gamesNeedingMetadata.length > 0) {
      await metadataFetcher.scheduleBackgroundRefresh(gamesNeedingMetadata);
      return { success: true, data: { gamesRefreshed: userGames.length, queuedForMetadata: gamesNeedingMetadata.length } };
    }
    return { success: true, data: { gamesRefreshed: userGames.length, queuedForMetadata: 0 } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to refresh game library' };
  }
}

async function _findGamesMissingMetadata(games: any[]): Promise<number[]> {
  try {
    const metadataCache = await storageManager.get<Record<number, any>>(STORAGE_KEYS.GAME_METADATA_CACHE, {});
    const missing: number[] = [];

    for (const game of games) {
      const meta = metadataCache[game.appId];
      if (!meta || !meta.name) {
        missing.push(game.appId);
      } else {
        const textToCheck = (meta.genres || []).concat(meta.categories || []).concat([meta.name || '']).join(' ');
        if (/[\u0400-\u04FF]/.test(textToCheck)) {
          missing.push(game.appId);
        }
      }
    }

    return missing;
  } catch (error) {
    return [];
  }
}

async function _getNetflixExtractionLogs(): Promise<ExtensionResponse> {
  try {
    const logs = await storageManager.get(STORAGE_KEYS.NETFLIX_EXTRACTION_LOGS, []);
    return { success: true, data: logs };
  } catch (error) {
    return { success: false, error: 'Failed to get Netflix logs' };
  }
}

async function _getNetflixDebugCaptures(): Promise<ExtensionResponse> {
  try {
    const captures = await storageManager.get(STORAGE_KEYS.NETFLIX_DEBUG_CAPTURES, []);
    return { success: true, data: captures };
  } catch (error) {
    return { success: false, error: 'Failed to get Netflix captures' };
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
