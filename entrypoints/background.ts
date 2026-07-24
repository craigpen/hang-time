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
const videoStates = new Map<string, { isPlaying: boolean; timestamp: number }>();

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
      const settings = await storageManager.getSettings();
      const relayUrls = settings.relay_urls || RelayPool.DEFAULT_RELAYS;
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
      return _getCurrentActivity(message.data?.service);

    case 'GET_ALL_ACTIVE_ACTIVITIES':
      return _getAllActiveActivities();

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

    case 'UPDATE_VIDEO_STATE':
      return _updateVideoState(message.data);

    case 'SEND_INVITE':
      return _sendInvite(message.data?.activity, message.data?.friendId);

    case 'SEND_JOIN_NOTIFICATION':
      return _sendJoinNotification(message.data?.activity, message.data?.friendId, message.data?.accepted);

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

async function _getBrowserActivities(): Promise<ExtensionResponse> {
  // Get the TabService and retrieve detected activities for Netflix and YouTube separately
  if (!activityDetector) {
    return { success: true, data: { netflix: null, youtube: null } };
  }

  const tabService = activityDetector.getService('tabs') as any;
  if (!tabService) {
    return { success: true, data: { netflix: null, youtube: null } };
  }

  // Call getCurrentActivity first to populate the lastDetected map
  await tabService.getCurrentActivity();

  return {
    success: true,
    data: {
      netflix: tabService.getDetectedActivity?.('netflix') || null,
      youtube: tabService.getDetectedActivity?.('youtube') || null,
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

function _updateVideoState(data?: any): ExtensionResponse {
  if (!data?.service) {
    return { success: false, error: 'service required' };
  }

  const isPlaying = data.isPlaying === true;
  videoStates.set(data.service, {
    isPlaying,
    timestamp: Date.now(),
  });

  // Also update the TabService instance
  if (activityDetector) {
    const tabService = activityDetector.getService('tabs') as any;
    if (tabService && tabService.setVideoState) {
      tabService.setVideoState(data.service, isPlaying);
    }
    // Trigger immediate activity detection on state change so play/pause state is published
    activityDetector.detectAndPublish();
  }

  return { success: true };
}

// ============================================================================
// NOSTR INTEGRATION
// ============================================================================

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
  const wasActive = Object.keys(friend.current_activities || {}).length > 0;

  // Handle stopped activities (removal signal)
  if (activity.state === 'stopped') {
    console.debug(`[Friend] ${friend.local_name} stopped ${activity.service}`);
    const updatedActivities = { ...friend.current_activities };
    delete updatedActivities[activity.service];
    await storageManager.updateFriend(friend.id, {
      current_activities: updatedActivities,
      last_seen: Date.now(),
    });
    console.debug(`[Friend] ${friend.local_name} ${activity.service} activity removed`);
    return;
  }

  const oldService = friend.current_activities?.[activity.service];
  console.debug(`[Friend] Updating ${friend.local_name}: ${activity.service}=${oldService?.content || 'new'} -> ${activity.content}`);
  await storageManager.updateFriend(friend.id, {
    current_activities: {
      ...friend.current_activities,
      [activity.service]: activity,
    },
    last_seen: Date.now(),
  });
  console.debug(`[Friend] ${friend.local_name} ${activity.service} updated successfully`);

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
  const stateTag = event.tags.find((t) => t[0] === 'state')?.[1] as 'playing' | 'paused' | 'stopped' | undefined;

  const activity: Activity = {
    service: serviceTag,
    content: contentTag || event.content,
    url: urlTag,
    id: activityIdTag,
    timestamp: event.created_at * 1000,
    metadata: {},
  };

  if (stateTag) {
    activity.state = stateTag;
  }

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
