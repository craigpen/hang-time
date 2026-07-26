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
import { NotificationManager, initializeNotificationManager, getNotificationManager } from '../src/modules/notifications';
import { JoinHandler } from '../src/modules/join-handler';
import { ActivityDetector } from '../src/modules/activity';
import { ActivityPublisher } from '../src/modules/publisher';
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
let activityPublisher: ActivityPublisher | null = null;
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
      await identityManager.generateIdentifier();
      console.log('[Background] Generated user identifier');
    }
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

    try {
      console.debug('[Background] Initializing storage...');
      await storageManager.initialize();
      console.debug('[Background] Storage initialized');
    } catch (error) {
      console.error('[Background] Storage initialization failed:', error);
      throw error;
    }

    try {
      console.debug('[Background] Initializing identity manager...');
      initializeIdentityManager(storageManager);
      console.debug('[Background] Identity manager initialized');

      // Generate or load user identifier
      const identifier = await identityManager.getIdentifier();
      console.debug(`[Background] User identifier: ${identifier}`);
    } catch (error) {
      console.error('[Background] Identity initialization failed:', error);
      throw error;
    }

    // Initialize friend manager
    initializeFriendManager(storageManager);
    console.debug('[Background] Friend manager initialized');

    // Initialize Nostr relay pool (required for messaging and activity sync)
    try {
      console.debug(`[Background] Connecting to Nostr relays...`);
      // Load relay configuration from user profile
      const profile = await storageManager.getUserProfile();
      let relayUrls: string[] = RelayPool.DEFAULT_RELAYS;

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
      await relayPool.connect(relayUrls);
      console.debug(`[Background] Connected to Nostr (${relayPool.getConnectedRelayCount()} relays)`);
    } catch (error) {
      console.warn('[Background] Failed to connect to relays, will retry in background:', error);
      // Continue initialization - relays will reconnect automatically
    }

    // Initialize messaging manager
    initializeMessagingManager(storageManager, identityManager, relayPool);
    console.debug('[Background] Messaging manager initialized');

    // Initialize notification manager
    initializeNotificationManager(storageManager);
    console.debug('[Background] Notification manager initialized');

    // Initialize activity detector
    activityDetector = new ActivityDetector(storageManager);

    // Register all service modules
    activityDetector.registerService('spotify', new SpotifyService(storageManager));
    activityDetector.registerService('twitch', new TwitchService(storageManager));
    activityDetector.registerService('steam', new SteamService(storageManager));
    activityDetector.registerService('tabs', new TabService(storageManager));

    console.debug('[Background] Services registered');

    await activityDetector.start();
    console.debug('[Background] Activity detector started');

    // Initialize and start activity publisher (publishes to Nostr)
    try {
      activityPublisher = new ActivityPublisher(relayPool, storageManager, identityManager);
      console.debug('[Background] ActivityPublisher created');
      await activityPublisher.start();
      console.debug('[Background] Activity publisher started');
    } catch (error) {
      console.error('[Background] Failed to initialize activity publisher:', error);
    }

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

    // Subscribe to incoming kind 4 (encrypted DM) messages
    await _subscribeToIncomingMessages();

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
 * Port connection handler for content scripts (persistent connections)
 * Allows content scripts to reconnect after extension reload
 */
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  console.log(`[Background] 🔌 Port connected: ${port.name}`);

  // Handle messages coming through the port
  port.onMessage.addListener(async (message: any) => {
    try {
      if (!message || !message.type) {
        port.postMessage({ success: false, error: 'Invalid message format' });
        return;
      }

      console.debug(`[Background] Port message: ${message.type} (from ${port.name})`);

      // Ensure initialized
      if (!initialized) {
        await initializeExtension();
      }

      // Route through main message handler
      const response: ExtensionResponse = await _handleMessage(message as ExtensionMessage);
      port.postMessage(response);
    } catch (error) {
      console.error(`[Background] Port handler error:`, error);
      port.postMessage({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Handle disconnection
  port.onDisconnect.addListener(() => {
    console.log(`[Background] 🔌 Port disconnected: ${port.name}`);
  });
});

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

    case 'GET_MESSAGES':
      return _getMessages(message.data?.friendId);

    case 'GET_ACTIVITY_MESSAGES':
      return _getActivityMessages(message.data?.friendId, message.data?.activityId);

    case 'ADD_FRIEND':
      return _addFriend(message.data?.identifier, message.data?.localName);

    case 'REMOVE_FRIEND':
      return _removeFriend(message.data?.friendId);

    case 'RENAME_FRIEND':
      return _renameFriend(message.data?.friendId, message.data?.newName);

    case 'SEND_MESSAGE':
      return _sendMessage(message.data?.activity, message.data?.friendId, message.data?.content);

    case 'TOGGLE_SERVICE':
      return _toggleService(message.data?.service, message.data?.enabled);

    case 'SAVE_SETTINGS':
      return _saveSettings(message.data);

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

    case 'CHECK_VIDEO_SYNC':
      return _checkVideoSync(message.data);

    case 'SEND_INVITE':
      return _sendInvite(message.data?.activity, message.data?.friendId);

    case 'SEND_JOIN_NOTIFICATION':
      return _sendJoinNotification(message.data?.activity, message.data?.friendId, message.data?.accepted);

    case 'TEST_NOTIFICATION':
      return _sendTestNotification();

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

    // Get all friends
    const friendManager = getFriendManager();
    const friends = await friendManager.getAllFriends();

    // Build unified response: { myActivities: {...}, friends: [{id, identifier, local_name, current_activities}, ...] }
    const friendsData = friends.map((friend) => ({
      id: friend.id,
      identifier: friend.identifier,
      local_name: friend.local_name,
      current_activities: friend.current_activities || {},
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
    return { success: true, data: { netflix: null, youtube: null, twitch: null } };
  }

  const tabService = activityDetector.getService('tabs') as any;
  if (!tabService) {
    return { success: true, data: { netflix: null, youtube: null, twitch: null } };
  }

  // Call getCurrentActivity first to populate the lastDetected map
  await tabService.getCurrentActivity();

  return {
    success: true,
    data: {
      netflix: tabService.getDetectedActivity?.('netflix') || null,
      youtube: tabService.getDetectedActivity?.('youtube') || null,
      twitch: tabService.getDetectedActivity?.('twitch') || null,
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

async function _getMessages(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'friendId required' };
  }

  try {
    const messages = await storageManager.getMessages(friendId);
    return { success: true, data: messages };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get messages' };
  }
}

async function _getNetflixExtractionLogs(): Promise<ExtensionResponse> {
  try {
    const result = await chrome.storage.local.get('netflix_extraction_logs');
    const logs = result.netflix_extraction_logs || [];
    console.debug(`[Background] Retrieved ${logs.length} Netflix extraction logs`);
    return { success: true, data: logs };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get logs' };
  }
}

async function _getNetflixDebugCaptures(): Promise<ExtensionResponse> {
  try {
    const result = await chrome.storage.local.get('netflix_debug_captures');
    const captures = result.netflix_debug_captures || [];
    console.debug(`[Background] Retrieved ${captures.length} Netflix debug captures`);
    return { success: true, data: captures };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get captures' };
  }
}

async function _getActivityMessages(friendId?: string, activityId?: string): Promise<ExtensionResponse> {
  if (!friendId || !activityId) {
    return { success: false, error: 'friendId and activityId required' };
  }

  try {
    const messages = await storageManager.getActivityMessages(friendId, activityId);
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
    if (data.discord_info !== undefined) {
      profile.discord_info = data.discord_info;
    }
    if (data.services_enabled) {
      profile.services_enabled = { ...profile.services_enabled, ...data.services_enabled };
    }
    if (data.notification_preferences !== undefined) {
      profile.notification_preferences = data.notification_preferences;
    }
    if (data.steam_id !== undefined) {
      profile.steam_id = data.steam_id;
    }
    if (data.publisher_config !== undefined) {
      profile.publisher_config = data.publisher_config;
    }

    console.debug('[Background] Saving settings - profile.steam_id after update:', profile.steam_id);

    // Save updated profile
    await storageManager.setUserProfile(profile);
    console.debug('[Background] Settings saved');

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

async function _checkVideoSync(data?: any): Promise<ExtensionResponse> {
  // Note: Video position is now included in activity state (metadata.progress)
  // Content script has friend activities from Nostr and can extract position directly
  // This endpoint is kept for compatibility but sync is handled via activity state
  return { success: true, data: { recommendedPosition: undefined } };
}

// ============================================================================
// NOSTR INTEGRATION
// ============================================================================

/**
 * Subscribe to incoming encrypted messages (kind 4) sent to the user
 * Note: Uses a dedicated subscription identifier to listen for all kind 4 events
 * Filtering for recipient happens in the callback
 */
async function _subscribeToIncomingMessages(): Promise<void> {
  try {
    const userPubkey = await identityManager.getPubkey();
    const incomingMessagesId = `incoming-messages-${userPubkey}`;

    // Subscribe to all events with this identifier
    // The relay will send us events and we filter for kind 4 where we're the recipient
    relayPool.subscribe(incomingMessagesId, async (event: NostrEvent) => {
      // Filter for kind 4 (encrypted DMs) only
      if (event.kind !== 4) {
        return;
      }

      // Check if user is tagged as recipient (p tag)
      const recipientTag = event.tags.find((t) => t[0] === 'p');
      if (!recipientTag || recipientTag[1] !== userPubkey) {
        return;
      }

      console.debug(`[Message] Received kind-4 message from ${event.pubkey.substring(0, 8)}...`);

      try {
        // Find which friend this is from
        const friends = await storageManager.getFriends();
        const sender = friends.find((f) => f.pubkey === event.pubkey);

        if (sender) {
          await _handleMessageEvent(sender.identifier, event);
        } else {
          console.debug(`[Message] Message from unknown sender: ${event.pubkey.substring(0, 8)}...`);
        }
      } catch (error) {
        console.error(`[Message] Error handling incoming message:`, error);
      }
    });

    console.debug(`[Message] Subscribed to incoming kind-4 messages for user ${userPubkey.substring(0, 8)}...`);
  } catch (error) {
    console.error(`[Message] Failed to subscribe to incoming messages:`, error);
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
    return;
  }

  // Derive pubkey fresh from identifier (deterministic, ensures consistency)
  const pubkey = friendManager.derivePubkeyFromIdentifier(friendIdentifier);

  if (activeSubscriptions.has(pubkey)) {
    return;
  }

  relayPool.subscribe(pubkey, async (event: NostrEvent) => {
    console.debug(`[Friend] Event from ${friendIdentifier} (kind ${event.kind})`);
    console.debug(`[Friend] Details - pubkey: ${event.pubkey.substring(0, 8)}..., tags: ${JSON.stringify(event.tags.slice(0, 3))}`);

    try {
      if (event.kind === 1) {
        // Activity event
        await _handleActivityEvent(friendIdentifier, event);
      } else if (event.kind === 4) {
        // Chat message
        console.debug(`[Message] Handling incoming kind-4`);
        await _handleMessageEvent(friendIdentifier, event);
      } else {
        console.debug(`[Friend] Ignoring event with kind ${event.kind}`);
      }
    } catch (error) {
      console.error(`[Friend] Error handling event for ${friendIdentifier}:`, error);
    }
  });

  activeSubscriptions.set(pubkey, undefined);
  console.debug(`[Friend] Subscribed to: ${friendIdentifier} (pubkey: ${pubkey})`);
}

async function _handleActivityEvent(friendIdentifier: string, event: NostrEvent): Promise<void> {
  const friends = await storageManager.getFriends();
  const friend = friends.find((f) => f.identifier === friendIdentifier);

  if (!friend) {
    return;
  }

  // Check for notification events (invites, etc.)
  const isNotificationTag = event.tags.find((t) => t[0] === 'is_notification')?.[1];
  const isActivityTag = event.tags.find((t) => t[0] === 'is_activity')?.[1];
  const typeTag = event.tags.find((t) => t[0] === 'type')?.[1];

  if (isNotificationTag === 'true') {
    // Handle notification event
    console.debug(`[Background] Received invite notification from ${friend.local_name}`);
    if (typeTag === 'invite') {
      // Check if we've already notified for this invite
      if (hasNotifiedForInvite(event.id)) {
        console.debug(`[Background] Already notified for invite ${event.id.substring(0, 8)}..., skipping`);
        return;
      }

      const service = event.tags.find((t) => t[0] === 'service')?.[1] || 'an activity';
      const notificationManager = getNotificationManager();
      console.log(`[Background] 🔔 Invite: Firing notification for ${friend.local_name}`);
      await notificationManager.notify(`${friend.local_name} invited you`, `Join them on ${service}`);
      await markInviteNotified(event.id);
      console.log(`[Background] ✅ Invite: Notification fired for ${friend.local_name}`);
    }
    return;
  }

  if (isActivityTag === 'true' && typeTag === 'activity-state') {
    // Parse JSON array of activities
    try {
      const activities = JSON.parse(event.content) as Activity[];
      console.log('[Background] Received activities from Nostr:', activities.map(a => ({
        service: a.service,
        content: a.content,
        audio: a.audio,
        id: a.id,
        url: a.url,
      })));
      const wasActive = Object.keys(friend.current_activities || {}).length > 0;

      // Detect which activities changed
      const changedServices = new Set<ServiceName>();
      for (const activity of activities) {
        const oldActivity = friend.current_activities?.[activity.service];
        // Check if activity changed (content, audio, or URL)
        if (!oldActivity ||
            oldActivity.content !== activity.content ||
            oldActivity.audio !== activity.audio ||
            oldActivity.url !== activity.url) {
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

      // Store all activities atomically, merging with existing to preserve fields from delta publishing
      const newCurrentActivities: Partial<Record<ServiceName, Activity>> = {};
      for (const activity of activities) {
        const existingActivity = friend.current_activities?.[activity.service];

        // Check if new activity is incomplete (missing content) and we have a complete version
        const isIncomplete = !activity.content && existingActivity?.content;

        if (isIncomplete) {
          // Don't overwrite complete activity with incomplete delta - just update specific fields
          newCurrentActivities[activity.service] = {
            ...existingActivity,
            ...activity,
            // Preserve content from existing activity if new one is missing it
            content: existingActivity.content,
            id: activity.id || existingActivity?.id,
            service: activity.service,
          };
        } else {
          // Normal merge for complete activities
          newCurrentActivities[activity.service] = {
            ...existingActivity,
            ...activity,
            id: activity.id || existingActivity?.id,
            service: activity.service,
            content: activity.content || existingActivity?.content,
          };
        }
      }

      await storageManager.updateFriend(friend.id, {
        current_activities: newCurrentActivities,
        last_seen: Date.now(),
      });

      // Add changed activities to history
      for (const activity of activities) {
        if (changedServices.has(activity.service)) {
          await storageManager.addActivityToHistory(friend.id, activity);
        }
      }

      // Send notification if friend came online (transition from no activities to some)
      if (!wasActive && activities.length > 0) {
        try {
          const notificationManager = getNotificationManager();
          await notificationManager.notifyFriendOnline(friend.id, friend.local_name, activities[0].content);
        } catch (error) {
          console.error('[Background] Failed to send online notification:', error);
        }
      }

      // Only notify popup if something actually changed
      if (changedServices.size > 0) {
        try {
          await chrome.runtime.sendMessage({
            type: 'FRIEND_ACTIVITY_CHANGED',
            data: { friendId: friend.id, changedServices: Array.from(changedServices) },
          });
        } catch (error) {
          // Popup not open
        }
      }
      return;
    } catch (error) {
      console.error('[Background] Failed to parse complete activity state:', error);
      return;
    }
  }

  // Single activity event (legacy format or future use)
  const activity = _parseActivityEvent(event);
  const wasActive = Object.keys(friend.current_activities || {}).length > 0;

  // Handle stopped activities (removal signal)
  if (activity.state === 'stopped') {
    const updatedActivities = { ...friend.current_activities };
    delete updatedActivities[activity.service];
    await storageManager.updateFriend(friend.id, {
      current_activities: updatedActivities,
      last_seen: Date.now(),
    });
    return;
  }

  // Update single activity
  await storageManager.updateFriend(friend.id, {
    current_activities: {
      ...friend.current_activities,
      [activity.service]: activity,
    },
    last_seen: Date.now(),
  });

  await storageManager.addActivityToHistory(friend.id, activity);

  // Send notification if friend came online (any new activity)
  if (!wasActive) {
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
    const friends = await storageManager.getFriends();
    const friend = friends.find((f) => f.identifier === friendIdentifier);

    if (!friend) {
      console.warn('[Message] Friend not found for message:', friendIdentifier);
      return;
    }

    const messagingManager = getMessagingManager();
    const timestamp = event.created_at * 1000;

    const message = await messagingManager.receiveMessage(friend, event.content, timestamp);

    if (message) {
      // Send notification based on message type
      try {
        const notificationManager = getNotificationManager();
        if (message.type === 'invite') {
          await notificationManager.notifyNewMessage(friend.id, friend.local_name, `invited you to join`);
        } else if (message.type === 'join_accepted') {
          await notificationManager.notifyNewMessage(friend.id, friend.local_name, `joined your activity`);
        } else if (message.type === 'chat') {
          await notificationManager.notifyNewMessage(friend.id, friend.local_name, message.content || 'sent a message');
        }
      } catch (error) {
        console.error('[Message] Failed to send message notification:', error);
      }

      // Notify popup about new message
      try {
        await chrome.runtime.sendMessage({
          type: 'NEW_MESSAGE',
          data: { message, friendId: friend.id, activityId: message.activity_id },
        });
      } catch (error) {
        // Popup not open
      }
    }
  } catch (error) {
    console.error('[Message] Failed to handle message event:', error);
  }
}

function _parseActivityEvent(event: NostrEvent) {
  const serviceTag = event.tags.find((t) => t[0] === 'service')?.[1] ?? 'idle';
  const contentTag = event.tags.find((t) => t[0] === 'content')?.[1] ?? '';
  const urlTag = event.tags.find((t) => t[0] === 'url')?.[1];
  const activityIdTag = event.tags.find((t) => t[0] === 'activity_id')?.[1];
  const audioTag = event.tags.find((t) => t[0] === 'audio')?.[1] as 'on' | 'off' | undefined;

  // Use content tag, fallback to event.content, but never use URL as content
  let finalContent = (contentTag || event.content || '').trim();

  // Safety check: if content looks like a URL, use a generic fallback
  if (finalContent.includes('http') || finalContent.includes('youtube.com') || finalContent.includes('twitch.tv') || finalContent.includes('netflix.com') || finalContent.includes('spotify.com')) {
    finalContent = `Activity on ${serviceTag}`;
  }

  // If empty after all that, use fallback
  if (!finalContent) {
    finalContent = `Activity on ${serviceTag}`;
  }

  const activity: Activity = {
    service: serviceTag,
    content: finalContent,
    url: urlTag,
    id: activityIdTag,
    timestamp: event.created_at * 1000,
    audio: audioTag ?? 'off',
    metadata: {},
  };

  return activity;
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

async function _sendInvite(activity?: any, friendId?: string): Promise<ExtensionResponse> {
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
    await messagingManager.sendInvite(activity, friend);
    return { success: true };
  } catch (error) {
    console.error('[Background] Error sending invite:', error);
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
    if (accepted) {
      await messagingManager.sendJoinAccepted(activity, friend);
    } else {
      await messagingManager.sendJoinDeclined(activity, friend);
    }
    return { success: true };
  } catch (error) {
    console.error('[Background] Error sending join notification:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to send notification' };
  }
}

// ============================================================================
// NOTIFICATION DEDUPLICATION
// ============================================================================

const notifiedInviteIds = new Map<string, number>(); // eventId -> timestamp

async function initializeNotificationDedup(): Promise<void> {
  const stored = await chrome.storage.local.get('notified_invite_ids');
  if (stored.notified_invite_ids) {
    const entries = Object.entries(stored.notified_invite_ids) as [string, number][];
    const now = Date.now();
    const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);

    for (const [eventId, timestamp] of entries) {
      // Only keep recent entries (last 7 days)
      if (timestamp > oneWeekAgo) {
        notifiedInviteIds.set(eventId, timestamp);
      }
    }

    console.log(`[Background] Loaded ${notifiedInviteIds.size} cached notification IDs`);
  }
}

function hasNotifiedForInvite(eventId: string): boolean {
  return notifiedInviteIds.has(eventId);
}

async function markInviteNotified(eventId: string): Promise<void> {
  const now = Date.now();
  notifiedInviteIds.set(eventId, now);

  // Persist to storage
  const entries = Object.fromEntries(notifiedInviteIds);
  await chrome.storage.local.set({ notified_invite_ids: entries });
}

// ============================================================================
// STARTUP
// ============================================================================

console.log('[Background] Service worker loaded');

// Initialize on startup
(async () => {
  try {
    await initializeNotificationDedup();
    await initializeExtension();
  } catch (error) {
    console.error('[Background] Failed to initialize:', error);
  }
})();
