/**
 * Hang Time - Background Service Worker
 * Main orchestration center for the extension
 * Handles: lifecycle, message routing, activity detection, Nostr subscriptions
 */

import { RelayPool, relayPool } from '../src/modules/nostr';
import { StorageManager, storageManager } from '../src/modules/storage';
import { IdentityManager, initializeIdentityManager, identityManager } from '../src/modules/identity';
import { FriendManager, initializeFriendManager, getFriendManager } from '../src/modules/friends';
import { MessagingManager, initializeMessagingManager, getMessagingManager } from '../src/modules/messaging';
import { TimeSyncManager, initializeTimeSyncManager, getTimeSyncManager } from '../src/modules/time-sync';
import { NotificationManager, initializeNotificationManager, getNotificationManager } from '../src/modules/notifications';
import { JoinHandler } from '../src/modules/join-handler';
import { ActivityDetector } from '../src/modules/activity';
import { TabService } from '../src/modules/services/tabs';
import { SteamService } from '../src/modules/services/steam';
import { SpotifyService } from '../src/modules/services/spotify';
import { TwitchService } from '../src/modules/services/twitch';
import { Friend, NostrEvent, ExtensionMessage, ExtensionResponse, ServiceName } from '../src/types';

// ============================================================================
// GLOBAL STATE (recreated on each service worker restart)
// ============================================================================

let initialized = false;
let activityDetector: ActivityDetector | null = null;
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

    // First install: generate memorable identifier and open settings
    const profile = await storageManager.getUserProfile();
    if (!profile) {
      await identityManager.generateIdentifier();
      console.log('[Background] Generated user identifier');
    }

    // Open settings page for initial setup
    chrome.runtime.openOptionsPage();
  } else if (details.reason === 'update') {
    console.log('[Background] Extension updated');
  }
});

/**
 * Service worker startup - initialize all systems
 */
async function initializeExtension(): Promise<void> {
  if (initialized) {
    console.debug('[Background] Already initialized');
    return;
  }

  try {
    console.log('[Background] Initializing extension...');

    // Initialize storage
    await storageManager.initialize();

    // Initialize identity manager
    initializeIdentityManager(storageManager);

    // Generate or load user identifier
    const identifier = await identityManager.getIdentifier();
    console.debug(`[Background] User identifier: ${identifier}`);

    // Initialize friend manager
    initializeFriendManager(storageManager);
    console.debug('[Background] Friend manager initialized');

    // Initialize Nostr relay pool (optional - extension works without relays)
    console.debug(`[Background] Connecting to Nostr relays...`);
    const settings = await storageManager.getSettings();
    const relayUrls = settings.relay_urls || RelayPool.DEFAULT_RELAYS;
    try {
      await relayPool.connect(relayUrls);
      console.debug(`[Background] Connected to Nostr (${relayPool.getConnectedRelayCount()} relays)`);
    } catch (error) {
      console.warn(`[Background] Nostr relay connection failed (optional):`, error);
      console.log('[Background] Extension will work in offline mode - relays unavailable');
    }

    // Initialize messaging manager
    initializeMessagingManager(storageManager, identityManager, relayPool);
    console.debug('[Background] Messaging manager initialized');

    // Initialize time-sync manager
    initializeTimeSyncManager(relayPool, identityManager);
    const timeSyncManager = getTimeSyncManager();
    timeSyncManager.startMonitoring();
    console.debug('[Background] Time sync manager initialized');

    // Initialize notification manager
    initializeNotificationManager(storageManager);
    console.debug('[Background] Notification manager initialized');

    // Initialize activity detector
    activityDetector = new ActivityDetector(relayPool, storageManager, identityManager);

    // Register all service modules
    activityDetector.registerService('spotify', new SpotifyService(storageManager));
    activityDetector.registerService('twitch', new TwitchService(storageManager));
    activityDetector.registerService('steam', new SteamService(storageManager));
    activityDetector.registerService('tabs', new TabService(storageManager));

    console.debug('[Background] Services registered');

    await activityDetector.start();
    console.debug('[Background] Activity detector started');

    // Subscribe to all friends' activities
    const friendManager = getFriendManager();
    const friends = await friendManager.getAllFriends();
    console.debug(`[Background] Subscribing to ${friends.length} friends`);
    for (const friend of friends) {
      try {
        await _subscribeToFriend(friend.identifier);
      } catch (error) {
        console.warn(`[Background] Failed to subscribe to friend ${friend.identifier}:`, error);
      }
    }

    console.log('[Background] Initialization complete');
    initialized = true;
  } catch (error) {
    console.error('[Background] Initialization failed:', error);
    throw error;
  }
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

/**
 * Message handler for popup ↔ background communication
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
    case 'GET_CURRENT_ACTIVITY':
      return _getCurrentActivity();

    case 'GET_ACTIVE_FRIENDS':
      return _getActiveFriends();

    case 'GET_FRIEND_ACTIVITY_HISTORY':
      return _getFriendActivityHistory(message.data?.friendId);

    case 'GET_USER_IDENTIFIER':
      return _getUserIdentifier();

    case 'GET_MESSAGES':
      return _getMessages(message.data?.friendId);

    case 'ADD_FRIEND':
      return _addFriend(message.data?.identifier, message.data?.localName);

    case 'REMOVE_FRIEND':
      return _removeFriend(message.data?.friendId);

    case 'RENAME_FRIEND':
      return _renameFriend(message.data?.friendId, message.data?.newName);

    case 'SEND_MESSAGE':
      return _sendMessage(message.data?.friendId, message.data?.content);

    case 'TOGGLE_SERVICE':
      return _toggleService(message.data?.service, message.data?.enabled);

    case 'MUTE_FRIEND':
      return _muteFriend(message.data?.friendId, message.data?.mute);

    case 'GET_OAUTH_STATUS':
      return _getOAuthStatus(message.data?.service);

    case 'AUTHENTICATE_SERVICE':
      return _authenticateService(message.data?.service);

    case 'DISCONNECT_SERVICE':
      return _disconnectService(message.data?.service);

    case 'HANDLE_OAUTH_CALLBACK':
      return _handleOAuthCallback(message.data?.service, message.data?.code);

    case 'JOIN_ACTIVITY':
      return _joinActivity(message.data?.friendId, message.data?.activity);

    case 'PUBLISH_VIDEO_SYNC':
      return _publishVideoSync(message.data);

    case 'CHECK_VIDEO_SYNC':
      return _checkVideoSync(message.data);

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

async function _getCurrentActivity(): Promise<ExtensionResponse> {
  if (!activityDetector) {
    return { success: false, error: 'Activity detector not initialized' };
  }

  const activity = await activityDetector.detectCurrentActivity();
  return { success: true, data: activity };
}

async function _getActiveFriends(): Promise<ExtensionResponse> {
  try {
    const friendManager = getFriendManager();
    const activeFriends = await friendManager.getActiveFriends();
    return { success: true, data: activeFriends };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get active friends' };
  }
}

async function _getFriendActivityHistory(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'friendId required' };
  }

  try {
    const history = await friendManager.getActivityHistory(friendId);
    return { success: true, data: history };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get activity history' };
  }
}

async function _getUserIdentifier(): Promise<ExtensionResponse> {
  const identifier = await identityManager.getIdentifier();
  return { success: true, data: { identifier } };
}

async function _getMessages(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'friendId required' };
  }

  try {
    const messagingManager = getMessagingManager();
    const messages = await messagingManager.getMessages(friendId);
    return { success: true, data: messages };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get messages' };
  }
}

async function _addFriend(identifier?: string, localName?: string): Promise<ExtensionResponse> {
  if (!identifier || !localName) {
    return { success: false, error: 'identifier and localName required' };
  }

  try {
    const friendManager = getFriendManager();
    const friend = await friendManager.addFriend(identifier, localName);
    await _subscribeToFriend(identifier);
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
    activeSubscriptions.delete(friend.identifier);
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

async function _sendMessage(friendId?: string, content?: string): Promise<ExtensionResponse> {
  if (!friendId || !content) {
    return { success: false, error: 'friendId and content required' };
  }

  try {
    const messagingManager = getMessagingManager();
    const message = await messagingManager.sendMessage(friendId, content);
    return { success: true, data: message };
  } catch (error) {
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

async function _getOAuthStatus(service?: string): Promise<ExtensionResponse> {
  if (!service) {
    return { success: false, error: 'service required' };
  }

  try {
    const serviceTyped = service as ServiceName;
    let hasToken = false;

    if (serviceTyped === 'spotify') {
      const spotifyService = new SpotifyService(storageManager);
      hasToken = await spotifyService.hasToken();
    } else if (serviceTyped === 'twitch') {
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

    if (serviceTyped === 'spotify') {
      const spotifyService = new SpotifyService(storageManager);
      authUrl = await spotifyService.getAuthUrl();
    } else if (serviceTyped === 'twitch') {
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

    if (serviceTyped === 'spotify') {
      const spotifyService = new SpotifyService(storageManager);
      await spotifyService.clearToken();
    } else if (serviceTyped === 'twitch') {
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

async function _publishVideoSync(data?: any): Promise<ExtensionResponse> {
  if (!data?.videoId || data.currentTime === undefined || data.duration === undefined) {
    return { success: false, error: 'videoId, currentTime, and duration required' };
  }

  try {
    const timeSyncManager = getTimeSyncManager();
    await timeSyncManager.publishTimeSync(
      data.videoId,
      data.currentTime,
      data.duration,
      data.isPlaying,
      data.service
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to publish video sync' };
  }
}

async function _checkVideoSync(data?: any): Promise<ExtensionResponse> {
  if (!data?.friendIdentifier || data.currentTime === undefined) {
    return { success: false, error: 'friendIdentifier and currentTime required' };
  }

  try {
    const timeSyncManager = getTimeSyncManager();
    const recommendedPosition = timeSyncManager.getRecommendedSyncPosition(
      data.friendIdentifier,
      data.currentTime
    );

    return { success: true, data: { recommendedPosition } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to check video sync' };
  }
}

// ============================================================================
// NOSTR INTEGRATION
// ============================================================================

/**
 * Subscribe to friend's activity and messages
 */
async function _subscribeToFriend(friendIdentifier: string): Promise<void> {
  if (activeSubscriptions.has(friendIdentifier)) {
    return;
  }

  relayPool.subscribe(friendIdentifier, async (event: NostrEvent) => {
    console.debug(`[Background] Event from ${friendIdentifier} (kind ${event.kind})`);

    if (event.kind === 1) {
      // Activity event
      await _handleActivityEvent(friendIdentifier, event);
    } else if (event.kind === 4) {
      // Chat message
      await _handleMessageEvent(friendIdentifier, event);
    }
  });

  activeSubscriptions.set(friendIdentifier, undefined);
  console.debug(`[Background] Subscribed to friend: ${friendIdentifier}`);
}

async function _handleActivityEvent(friendIdentifier: string, event: NostrEvent): Promise<void> {
  const friends = await storageManager.getFriends();
  const friend = friends.find((f) => f.identifier === friendIdentifier);

  if (!friend) {
    return;
  }

  // Check if this is a time-sync event
  const typeTag = event.tags.find((t) => t[0] === 'type')?.[1];
  if (typeTag === 'time-sync') {
    // Handle time-sync event
    const timeSyncManager = getTimeSyncManager();
    timeSyncManager.handleTimeSyncEvent(event);
    console.debug(`[Background] Time sync event from ${friendIdentifier.substring(0, 8)}`);
    return;
  }

  // Regular activity event
  const activity = _parseActivityEvent(event);
  const wasActive = friend.current_activity?.service !== 'idle';

  await storageManager.updateFriend(friend.id, {
    current_activity: activity,
    current_activity_timestamp: Date.now(),
    last_seen: Date.now(),
  });

  await storageManager.addActivityToHistory(friend.id, activity);

  // Send notification if friend came online
  if (!wasActive && activity.service !== 'idle') {
    try {
      const notificationManager = getNotificationManager();
      await notificationManager.notifyFriendOnline(friend.id, friend.local_name, activity.content);
    } catch (error) {
      console.error('[Background] Failed to send online notification:', error);
    }
  }

  // Notify popup
  try {
    await chrome.runtime.sendMessage({
      type: 'FRIEND_ACTIVITY_UPDATED',
      data: { friendId: friend.id, activity },
    });
  } catch (error) {
    // Popup not open
  }
}

async function _handleMessageEvent(friendIdentifier: string, event: NostrEvent): Promise<void> {
  try {
    const messagingManager = getMessagingManager();
    const timestamp = event.created_at * 1000;

    const message = await messagingManager.receiveMessage(friendIdentifier, event.content, timestamp);

    if (message) {
      // Send notification for new message
      try {
        const friends = await storageManager.getFriends();
        const friend = friends.find((f) => f.identifier === friendIdentifier);

        if (friend) {
          const notificationManager = getNotificationManager();
          await notificationManager.notifyNewMessage(friend.id, friend.local_name, event.content);
        }
      } catch (error) {
        console.error('[Background] Failed to send message notification:', error);
      }

      // Notify popup about new message
      try {
        await chrome.runtime.sendMessage({
          type: 'NEW_MESSAGE',
          data: { message },
        });
      } catch (error) {
        // Popup not open
      }
    }
  } catch (error) {
    console.error('[Background] Failed to handle message event:', error);
  }
}

function _parseActivityEvent(event: NostrEvent) {
  const serviceTag = event.tags.find((t) => t[0] === 'service')?.[1] ?? 'idle';
  const contentTag = event.tags.find((t) => t[0] === 'content')?.[1] ?? '';
  const urlTag = event.tags.find((t) => t[0] === 'url')?.[1];

  return {
    service: serviceTag,
    content: contentTag || event.content,
    url: urlTag,
    timestamp: event.created_at * 1000,
    metadata: {},
  };
}

// ============================================================================
// STARTUP
// ============================================================================

console.log('[Background] Service worker loaded');

// Initialize on startup
(async () => {
  try {
    await initializeExtension();
  } catch (error) {
    console.error('[Background] Failed to initialize:', error);
  }
})();
