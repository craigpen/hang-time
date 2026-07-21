/**
 * Hang Time - Background Service Worker
 * Main orchestration center for the extension
 * Handles: lifecycle, message routing, activity detection, Nostr subscriptions
 */

import { RelayPool, relayPool } from '../src/modules/nostr';
import { StorageManager, storageManager } from '../src/modules/storage';
import { IdentityManager, initializeIdentityManager, identityManager } from '../src/modules/identity';
import { ActivityDetector } from '../src/modules/activity';
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

    // Initialize Nostr relay pool
    const settings = await storageManager.getSettings();
    const relayUrls = settings.relay_urls || RelayPool.DEFAULT_RELAYS;

    console.debug(`[Background] Connecting to ${relayUrls.length} Nostr relays...`);
    await relayPool.connect(relayUrls);
    console.debug(`[Background] Connected to Nostr (${relayPool.getConnectedRelayCount()} relays)`);

    // Initialize activity detector
    activityDetector = new ActivityDetector(relayPool, storageManager, identityManager);
    await activityDetector.start();
    console.debug('[Background] Activity detector started');

    // Subscribe to all friends' activities
    const friends = await storageManager.getFriends();
    for (const friend of friends) {
      await _subscribeToFriend(friend.identifier);
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
  const friends = await storageManager.getFriends();
  const now = Date.now();

  const activeFriends = friends.filter((friend) => {
    if (friend.muted) return false;
    if (!friend.current_activity) return false;
    if (friend.current_activity.service === 'idle') return false;

    // Only show if activity is recent (< 5 min old)
    const activityAge = now - (friend.current_activity_timestamp ?? 0);
    return activityAge < 5 * 60 * 1000;
  });

  return { success: true, data: activeFriends };
}

async function _getFriendActivityHistory(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'friendId required' };
  }

  const history = await storageManager.getActivityHistory(friendId);
  return { success: true, data: history };
}

async function _getUserIdentifier(): Promise<ExtensionResponse> {
  const identifier = await identityManager.getIdentifier();
  return { success: true, data: { identifier } };
}

async function _getMessages(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'friendId required' };
  }

  const messages = await storageManager.getMessages(friendId);
  return { success: true, data: messages };
}

async function _addFriend(identifier?: string, localName?: string): Promise<ExtensionResponse> {
  if (!identifier || !localName) {
    return { success: false, error: 'identifier and localName required' };
  }

  const friend: Friend = {
    id: Math.random().toString(36).substring(7),
    identifier,
    local_name: localName,
    added_at: Date.now(),
    last_seen: Date.now(),
    muted: false,
    hidden_services: [],
  };

  await storageManager.addFriend(friend);
  await _subscribeToFriend(identifier);

  console.debug(`[Background] Added friend: ${localName} (${identifier})`);

  return { success: true, data: friend };
}

async function _removeFriend(friendId?: string): Promise<ExtensionResponse> {
  if (!friendId) {
    return { success: false, error: 'friendId required' };
  }

  const friend = await storageManager.getFriend(friendId);
  if (!friend) {
    return { success: false, error: 'Friend not found' };
  }

  await storageManager.removeFriend(friendId);
  activeSubscriptions.delete(friend.identifier);

  console.debug(`[Background] Removed friend: ${friend.local_name}`);

  return { success: true };
}

async function _renameFriend(friendId?: string, newName?: string): Promise<ExtensionResponse> {
  if (!friendId || !newName) {
    return { success: false, error: 'friendId and newName required' };
  }

  await storageManager.updateFriend(friendId, { local_name: newName });
  return { success: true };
}

async function _sendMessage(friendId?: string, content?: string): Promise<ExtensionResponse> {
  if (!friendId || !content) {
    return { success: false, error: 'friendId and content required' };
  }

  // TODO: Implement message encryption and publishing
  console.debug(`[Background] Message queued for ${friendId}`);

  return { success: true };
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

  await storageManager.updateFriend(friendId, { muted: mute });
  console.debug(`[Background] Friend ${friendId}: ${mute ? 'muted' : 'unmuted'}`);

  return { success: true };
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

  const activity = _parseActivityEvent(event);
  await storageManager.updateFriend(friend.id, {
    current_activity: activity,
    current_activity_timestamp: Date.now(),
    last_seen: Date.now(),
  });

  await storageManager.addActivityToHistory(friend.id, activity);

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
  // TODO: Implement message decryption and storage
  console.debug(`[Background] Message event from ${friendIdentifier}`);
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
