/**
 * Hang Time - Messaging System
 * Handles sending and receiving encrypted messages via Nostr kind-1059 (NIP-44)
 */

import { finalizeEvent, nip44, utils } from 'nostr-tools';
import { Activity, NostrEvent, Friend } from '../types';
import { RelayPool } from './nostr';
import { IdentityManager } from './identity';
import { StorageManager } from './storage';
import { generateActivityId } from './activity-utils';
import type { PublishQueue } from './publish-queue';

// Helper: Convert hex string to Uint8Array (for nostr-tools)
function hexToBytes(hex: string): Uint8Array {
  if (!hex || typeof hex !== 'string') {
    throw new Error(`hexToBytes: Expected hex string, got ${typeof hex}`);
  }
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: Hex string must have even length, got ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// Singleton instance with lazy initialization
let instance: MessagingManager | null = null;

export interface ActivityMessage {
  type: 'chat' | 'invite' | 'join_accepted' | 'join_declined' | 'sync_request' | 'sync_response';
  activity_id: string;
  service?: string;
  content?: string;
  timestamp: number;
  position?: number; // For sync_response: current playback position (seconds)
  sent_at?: number; // For sync_response: when host sent this response
}

export class MessagingManager {
  private publishQueue: PublishQueue | null = null;

  constructor(
    private relayPool: RelayPool,
    private identityManager: IdentityManager,
    private storageManager: StorageManager
  ) {}

  /**
   * Set the publish queue (called after queue is initialized)
   */
  setPublishQueue(queue: PublishQueue): void {
    this.publishQueue = queue;
  }

  /**
   * Send a friend request via encrypted kind-1059 (NIP-44)
   * Returns the event ID for tracking/retry purposes
   */
  async sendFriendRequest(recipientIdentifier: string, recipientPubkey: string, recipientDisplayName: string): Promise<string> {
    return this.sendFriendRequestMessage(recipientPubkey, recipientDisplayName);
  }

  /**
   * Send an invite via encrypted kind-1059 (NIP-44)
   * Returns the event ID for tracking/retry purposes
   */
  async sendInvite(activity: Activity, recipientFriend: Friend): Promise<string> {
    if (!activity.service) {
      throw new Error(`Cannot send invite: activity missing service. Activity: ${JSON.stringify({ id: activity.id, content: activity.content })}`);
    }

    const message: ActivityMessage = {
      type: 'invite',
      activity_id: activity.id || generateActivityId(activity.service, activity.url),
      service: activity.service,
      content: `${activity.content || activity.service}`,
      timestamp: Date.now(),
    };

    const eventId = await this._sendActivityMessage(recipientFriend, message);
    console.log('[Messaging] Sent invite for activity:', activity.service, 'to friend:', recipientFriend.local_name);
    return eventId;
  }

  /**
   * Send a chat message to a friend about an activity
   * Returns the event ID for tracking/retry purposes
   */
  async sendChatMessage(activity: Activity, recipientFriend: Friend, content: string): Promise<string> {
    const message: ActivityMessage = {
      type: 'chat',
      activity_id: activity.id || generateActivityId(activity.service, activity.url),
      content,
      timestamp: Date.now(),
    };

    const eventId = await this._sendActivityMessage(recipientFriend, message);
    console.debug('[Messaging] Sent message to:', recipientFriend.local_name);
    return eventId;
  }

  /**
   * Send join acceptance notification
   * Returns the event ID for tracking/retry purposes
   */
  async sendJoinAccepted(activity: Activity, recipientFriend: Friend): Promise<string> {
    const message: ActivityMessage = {
      type: 'join_accepted',
      activity_id: activity.id || generateActivityId(activity.service, activity.url),
      service: activity.service,
      timestamp: Date.now(),
    };

    const eventId = await this._sendActivityMessage(recipientFriend, message);
    console.debug('[Messaging] Sent join_accepted for activity:', activity.service);
    return eventId;
  }

  /**
   * Send join decline notification
   * Returns the event ID for tracking/retry purposes
   */
  async sendJoinDeclined(activity: Activity, recipientFriend: Friend): Promise<string> {
    const message: ActivityMessage = {
      type: 'join_declined',
      activity_id: activity.id || generateActivityId(activity.service, activity.url),
      service: activity.service,
      timestamp: Date.now(),
    };

    const eventId = await this._sendActivityMessage(recipientFriend, message);
    console.debug('[Messaging] Sent join_declined for activity:', activity.service);
    return eventId;
  }

  /**
   * Send friend request message via kind-1059 (NIP-44 encrypted)
   * Used when adding a friend to notify them (works even if they haven't added us yet)
   * Returns the event ID for tracking/retry purposes
   */
  async sendFriendRequestMessage(recipientPubkey: string, senderDisplayName: string): Promise<string> {
    try {
      const userProfile = await this.storageManager.getUserProfile();
      if (!userProfile) {
        throw new Error('User profile not found');
      }

      const pubkey = await this.identityManager.getPubkey();
      const secretKey = await this.identityManager.getSecretKey();

      // Create friend request message with sender info
      const message: ActivityMessage = {
        type: 'friend_request',
        activity_id: `friend_request_${Date.now()}`,
        content: JSON.stringify({
          sender_identifier: userProfile.uuid,
          sender_display_name: userProfile.nickname || userProfile.uuid,
          sender_pubkey: pubkey,
        }),
        timestamp: Date.now(),
      };

      // Serialize and encrypt using nip44
      const plaintext = JSON.stringify(message);
      const conversationKey = nip44.getConversationKey(hexToBytes(secretKey), recipientPubkey);
      const encryptedContent = await nip44.encrypt(plaintext, conversationKey);

      // Create kind-1059 event with message_type tag
      const tags: Array<[string, string]> = [
        ['p', recipientPubkey],
        ['message_type', 'friend_request'],
      ];

      // Use finalizeEvent() for consistent event signing
      // Note: created_at will be refreshed by PublishQueue at actual publish time
      const event = finalizeEvent({
        kind: 1059,
        tags,
        content: encryptedContent,
        created_at: Math.floor(Date.now() / 1000), // Placeholder, will be refreshed at publish time
      }, hexToBytes(secretKey)) as NostrEvent;

      // Queue or publish the event
      console.log(`[Messaging] 📤 Queuing kind-1059 friend request to ${recipientPubkey.substring(0, 8)}...`);
      if (this.publishQueue) {
        await this.publishQueue.enqueueUserAction(event, 'message');
      } else {
        // Fallback if queue not initialized
        const publishConfig = userProfile?.publisher_config;
        await this.relayPool.publish(event, publishConfig);
      }

      console.debug('[Messaging] Friend request message sent');
      return event.id; // Return event ID for tracking/retry
    } catch (error) {
      console.error('[Messaging] Failed to send friend request message:', error);
      throw error;
    }
  }

  /**
   * Internal: send encrypted activity message via kind-1059 (NIP-44)
   * Returns the event ID for tracking/retry purposes
   */
  private async _sendActivityMessage(recipientFriend: Friend, message: ActivityMessage): Promise<string> {
    try {
      const userProfile = await this.storageManager.getUserProfile();
      if (!userProfile) {
        throw new Error('User profile not found');
      }

      const pubkey = await this.identityManager.getPubkey();
      const secretKey = await this.identityManager.getSecretKey();

      // Serialize message to JSON and encrypt using nip44 with recipient's pubkey
      const plaintext = JSON.stringify(message);
      const conversationKey = nip44.getConversationKey(hexToBytes(secretKey), recipientFriend.pubkey);
      const encryptedContent = await nip44.encrypt(plaintext, conversationKey);

      // Create kind-1059 event with recipient tag and message type
      const tags: Array<[string, string]> = [['p', recipientFriend.pubkey]];

      // Add message_type tag for routing
      if (message.type === 'invite') {
        tags.push(['message_type', 'invite']);
      } else if (message.type === 'join_accepted' || message.type === 'join_declined') {
        tags.push(['message_type', 'friend_request']);
      } else if (message.type === 'chat') {
        tags.push(['message_type', 'chat']);
      }

      // Use finalizeEvent() for consistent event signing
      // Note: created_at will be refreshed by PublishQueue at actual publish time
      const event = finalizeEvent({
        kind: 1059,
        tags,
        content: encryptedContent,
        created_at: Math.floor(Date.now() / 1000), // Placeholder, will be refreshed at publish time
      }, hexToBytes(secretKey)) as NostrEvent;

      // Queue or publish the event
      console.log(`[Messaging] [MESSAGE_FLOW] 📤 Queuing kind-1059 ${message.type} to ${recipientFriend.local_name}`);
      if (this.publishQueue) {
        await this.publishQueue.enqueueUserAction(event, 'message');
      } else {
        // Fallback if queue not initialized
        const publishConfig = userProfile.publisher_config;
        await this.relayPool.publish(event, publishConfig);
      }

      // Store in local message history as outbound
      const localMessage: any = {
        id: event.id,
        friend_id: recipientFriend.uuid,
        friend_identifier: recipientFriend.uuid,
        sender_identifier: userProfile.uuid,
        activity_id: message.activity_id,
        service: message.service,
        type: message.type as 'chat' | 'invite' | 'join_accepted' | 'join_declined' | 'sync_request' | 'sync_response',
        content: message.content,
        is_outbound: true,
        timestamp: message.timestamp,
        read: true,
        nostr_event_id: event.id,
      };

      // Add sync-specific fields if present
      if (message.position !== undefined) {
        localMessage.position = message.position;
      }
      if (message.sent_at !== undefined) {
        localMessage.sent_at = message.sent_at;
      }

      await this.storageManager.addActivityMessage(message.activity_id, localMessage);

      return event.id; // Return event ID for tracking/retry
    } catch (error) {
      console.error('[Messaging] Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Receive and decrypt an incoming kind-4 message
   * Returns the parsed and stored message, or null if parsing fails
   */
  async receiveMessage(friend: Friend, encryptedContent: string, timestamp: number): Promise<any | null> {
    try {
      const userProfile = await this.storageManager.getUserProfile();
      if (!userProfile) {
        console.warn('[Messaging] User profile not found, cannot decrypt');
        return null;
      }

      if (!encryptedContent) {
        console.warn('[Messaging] Empty encrypted content, cannot decrypt');
        return null;
      }

      console.debug('[Messaging] Decrypting content type:', typeof encryptedContent, 'length:', encryptedContent?.length, 'first 50 chars:', encryptedContent?.substring(0, 50));

      const secretKey = await this.identityManager.getSecretKey();

      // Decrypt the message using nip44 with friend's pubkey (they sent it to us)
      let plaintext: string;
      try {
        const conversationKey = nip44.getConversationKey(hexToBytes(secretKey), friend.pubkey);
        plaintext = await nip44.decrypt(encryptedContent, conversationKey);
      } catch (decryptError) {
        console.error('[Messaging] Decryption failed - content may not be nip44-encrypted:', {
          errorMessage: decryptError instanceof Error ? decryptError.message : String(decryptError),
          contentType: typeof encryptedContent,
          contentLength: encryptedContent?.length,
          isSuspectedJSON: encryptedContent?.startsWith('{')
        });
        throw decryptError;
      }

      // Parse the ActivityMessage structure
      const message: ActivityMessage = JSON.parse(plaintext);

      // Validate message structure
      if (!message.type || !message.activity_id) {
        console.warn('[Messaging] Invalid message structure:', message);
        return null;
      }

      // Create message record
      const storedMessage: any = {
        id: `${friend.uuid}_${timestamp}`,
        friend_id: friend.uuid,
        friend_identifier: friend.uuid,
        sender_identifier: friend.uuid,
        activity_id: message.activity_id,
        service: message.service,
        type: message.type as 'chat' | 'invite' | 'join_accepted' | 'join_declined' | 'sync_request' | 'sync_response',
        content: message.content,
        is_outbound: false,
        timestamp: message.timestamp || timestamp,
        read: false,
      };

      // Add sync-specific fields if present
      if (message.position !== undefined) {
        storedMessage.position = message.position;
      }
      if (message.sent_at !== undefined) {
        storedMessage.sent_at = message.sent_at;
      }

      // Store in IndexedDB
      await this.storageManager.addActivityMessage(message.activity_id, storedMessage);

      console.debug('[Messaging] Received message from:', friend.uuid, 'type:', message.type);
      return storedMessage;
    } catch (error) {
      console.error('[Messaging] Failed to receive/decrypt message:', error);
      return null;
    }
  }
}

// ============================================================================
// SINGLETON PATTERN
// ============================================================================

export function initializeMessagingManager(
  storageManager: StorageManager,
  identityManager: IdentityManager,
  relayPool: RelayPool
): void {
  if (instance) {
    console.debug('[Messaging] Already initialized');
    return;
  }
  instance = new MessagingManager(relayPool, identityManager, storageManager);
  console.debug('[Messaging] Initialized');
}

export function getMessagingManager(): MessagingManager {
  if (!instance) {
    throw new Error('MessagingManager not initialized. Call initializeMessagingManager first.');
  }
  return instance;
}
