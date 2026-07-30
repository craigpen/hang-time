/**
 * Hang Time - Messaging System
 * Handles sending and receiving encrypted messages via Nostr kind-4
 */

import { Activity, NostrEvent, Friend } from '../types';
import { RelayPool } from './nostr';
import { IdentityManager } from './identity';
import { StorageManager } from './storage';
import { encryptionManager } from './encryption';
import { generateActivityId } from './activity-utils';

// Singleton instance with lazy initialization
let instance: MessagingManager | null = null;

export interface ActivityMessage {
  type: 'chat' | 'invite' | 'join_accepted' | 'join_declined';
  activity_id: string;
  content?: string;
  timestamp: number;
}

export class MessagingManager {
  constructor(
    private relayPool: RelayPool,
    private identityManager: IdentityManager,
    private storageManager: StorageManager
  ) {}

  /**
   * Send a friend request notification (kind-1, unencrypted)
   * Published when user adds a friend to prompt reciprocal add
   */
  async sendFriendRequest(recipientIdentifier: string, recipientPubkey: string, recipientDisplayName: string): Promise<void> {
    const userProfile = await this.storageManager.getUserProfile();
    if (!userProfile) {
      throw new Error('User profile not found');
    }

    const pubkey = await this.identityManager.getPubkey();
    const created_at = Math.floor(Date.now() / 1000);

    // Build tags with friend request metadata
    const tags = [
      ['is_notification', 'true'],
      ['type', 'friend_request'],
      ['recipient', recipientPubkey],
      ['sender_identifier', userProfile.memorable_identifier],
      ['sender_display_name', userProfile.nickname || userProfile.memorable_identifier],
    ];

    // Create kind-1 friend request event
    const event: NostrEvent = {
      id: '',
      pubkey,
      created_at,
      kind: 1,
      tags,
      content: `${userProfile.nickname || userProfile.memorable_identifier} added you as a friend`,
    };

    // Compute event ID and sign
    const eventData = [0, pubkey, created_at, 1, event.tags, event.content];
    const canonicalJson = JSON.stringify(eventData);
    const eventId = await encryptionManager.sha256(canonicalJson);
    event.id = eventId.substring(0, 64);
    event.sig = encryptionManager.signEvent(event.id, await this.identityManager.getSecretKey());

    // Publish to relays
    console.log(`[Messaging] 📤 Publishing friend request to ${recipientDisplayName} (${recipientPubkey.substring(0, 8)}...)`);
    await this.relayPool.publish(event, userProfile.publisher_config);
  }

  /**
   * Send an invite notification to a friend about an activity (kind-1, unencrypted)
   */
  async sendInvite(activity: Activity, recipientFriend: Friend): Promise<void> {
    const userProfile = await this.storageManager.getUserProfile();
    if (!userProfile) {
      throw new Error('User profile not found');
    }

    const pubkey = await this.identityManager.getPubkey();
    const created_at = Math.floor(Date.now() / 1000);

    // Build tags with activity metadata and Discord link if available
    const tags = [
      ['is_notification', 'true'],
      ['type', 'invite'],
      ['activity_id', activity.id || generateActivityId(activity.service, activity.url)],
      ['activity_name', activity.content || activity.service],
      ['recipient', recipientFriend.pubkey],
      ['service', activity.service],
    ];

    if (activity.url) {
      tags.push(['url', activity.url]);
    }

    // Determine Discord link to include: prefer sender's, fall back to recipient's
    let discordLink: string | undefined;

    if (userProfile.discord_info) {
      // Sender has Discord configured
      discordLink = userProfile.discord_info;
    } else {
      // Sender doesn't have Discord, check if recipient has one
      const recipientProfile = await this.storageManager.getFriendProfile(recipientFriend.pubkey);
      if (recipientProfile?.discord_link) {
        discordLink = recipientProfile.discord_link;
      }
    }

    if (discordLink) {
      tags.push(['discord_link', discordLink]);
    }

    // Create kind-1 notification event
    const event: NostrEvent = {
      id: '',
      pubkey,
      created_at,
      kind: 1,
      tags,
      content: `Inviting ${recipientFriend.local_name} to ${activity.content || activity.service}`,
    };

    // Compute event ID and sign
    const eventData = [0, pubkey, created_at, 1, event.tags, event.content];
    const canonicalJson = JSON.stringify(eventData);
    const eventId = await encryptionManager.sha256(canonicalJson);
    event.id = eventId.substring(0, 64);
    event.sig = encryptionManager.signEvent(event.id, await this.identityManager.getSecretKey());

    // Publish to relays
    console.log(`[Messaging] 📤 Publishing kind-1 invite to ${recipientFriend.local_name} (${recipientFriend.pubkey.substring(0, 8)}...)`);
    await this.relayPool.publish(event, userProfile.publisher_config);
  }

  /**
   * Send a chat message to a friend about an activity
   */
  async sendChatMessage(activity: Activity, recipientFriend: Friend, content: string): Promise<void> {
    const message: ActivityMessage = {
      type: 'chat',
      activity_id: activity.id || generateActivityId(activity.service, activity.url),
      content,
      timestamp: Date.now(),
    };

    await this._sendActivityMessage(recipientFriend, message);
    console.debug('[Messaging] Sent message to:', recipientFriend.local_name);
  }

  /**
   * Send join acceptance notification
   */
  async sendJoinAccepted(activity: Activity, recipientFriend: Friend): Promise<void> {
    const message: ActivityMessage = {
      type: 'join_accepted',
      activity_id: activity.id || generateActivityId(activity.service, activity.url),
      timestamp: Date.now(),
    };

    await this._sendActivityMessage(recipientFriend, message);
    console.debug('[Messaging] Sent join_accepted for activity:', activity.service);
  }

  /**
   * Send join decline notification
   */
  async sendJoinDeclined(activity: Activity, recipientFriend: Friend): Promise<void> {
    const message: ActivityMessage = {
      type: 'join_declined',
      activity_id: activity.id || generateActivityId(activity.service, activity.url),
      timestamp: Date.now(),
    };

    await this._sendActivityMessage(recipientFriend, message);
    console.debug('[Messaging] Sent join_declined for activity:', activity.service);
  }

  /**
   * Send friend request message via kind-4 (encrypted)
   * Used when adding a friend to notify them (works even if they haven't added us yet)
   */
  async sendFriendRequestMessage(recipientPubkey: string, senderDisplayName: string): Promise<void> {
    try {
      const userProfile = await this.storageManager.getUserProfile();
      if (!userProfile) {
        throw new Error('User profile not found');
      }

      const pubkey = await this.identityManager.getPubkey();
      const secretKey = await this.identityManager.getSecretKey();

      // Create friend request message
      const message: ActivityMessage = {
        type: 'friend_request',
        activity_id: `friend_request_${Date.now()}`,
        timestamp: Date.now(),
      };

      // Serialize and encrypt
      const plaintext = JSON.stringify(message);
      const encryptedContent = encryptionManager.encrypt(plaintext, recipientPubkey, secretKey);

      const created_at = Math.floor(Date.now() / 1000);
      const kind = 4;

      // Create kind-4 event with message_type tag
      const tags: Array<[string, string]> = [
        ['p', recipientPubkey],
        ['message_type', 'friend_request'],
      ];

      const event: NostrEvent = {
        id: '',
        pubkey,
        created_at,
        kind,
        tags,
        content: encryptedContent,
      };

      // Compute event ID and sign
      const eventData = [0, pubkey, created_at, kind, event.tags, encryptedContent];
      const canonicalJson = JSON.stringify(eventData);
      const eventId = await encryptionManager.sha256(canonicalJson);
      event.id = eventId.substring(0, 64);
      event.sig = encryptionManager.signEvent(event.id, secretKey);

      // Publish to relays
      const publishConfig = userProfile?.publisher_config;
      console.log(`[Messaging] 📤 Publishing kind-4 friend request to ${recipientPubkey.substring(0, 8)}...`);
      await this.relayPool.publish(event, publishConfig);

      console.debug('[Messaging] Friend request message sent');
    } catch (error) {
      console.error('[Messaging] Failed to send friend request message:', error);
      throw error;
    }
  }

  /**
   * Internal: send encrypted activity message via kind-4
   */
  private async _sendActivityMessage(recipientFriend: Friend, message: ActivityMessage): Promise<void> {
    try {
      const userProfile = await this.storageManager.getUserProfile();
      if (!userProfile) {
        throw new Error('User profile not found');
      }

      const pubkey = await this.identityManager.getPubkey();
      const secretKey = await this.identityManager.getSecretKey();

      // Serialize message to JSON and encrypt with recipient's pubkey
      const plaintext = JSON.stringify(message);
      const encryptedContent = encryptionManager.encrypt(plaintext, recipientFriend.pubkey, secretKey);

      const created_at = Math.floor(Date.now() / 1000);
      const kind = 4; // Kind 4 = encrypted direct message

      // Create kind-4 event with recipient tag and message type
      const tags: Array<[string, string]> = [['p', recipientFriend.pubkey]];

      // Add message_type tag for routing (friend_request for accept/decline, chat for future chat)
      if (message.type === 'join_accepted' || message.type === 'join_declined') {
        tags.push(['message_type', 'friend_request']);
      } else if (message.type === 'chat') {
        tags.push(['message_type', 'chat']);
      }

      const event: NostrEvent = {
        id: '', // Will be computed
        pubkey,
        created_at,
        kind,
        tags,
        content: encryptedContent,
      };

      // Compute event ID (SHA-256 of canonical JSON)
      const eventData = [0, pubkey, created_at, kind, event.tags, encryptedContent];
      const canonicalJson = JSON.stringify(eventData);
      const eventId = await encryptionManager.sha256(canonicalJson);
      event.id = eventId.substring(0, 64);

      // Sign event
      event.sig = encryptionManager.signEvent(event.id, secretKey);

      // Publish to relays with config
      const publishConfig = userProfile.publisher_config;
      console.log(`[Messaging] 📤 Publishing kind-4 ${message.type} to ${recipientFriend.local_name} (${recipientFriend.pubkey.substring(0, 8)}...)`);
      await this.relayPool.publish(event, publishConfig);

      // Store in local message history as outbound
      const localMessage = {
        id: event.id,
        friend_id: recipientFriend.id,
        friend_identifier: recipientFriend.identifier,
        sender_identifier: userProfile.memorable_identifier,
        activity_id: message.activity_id,
        type: message.type as 'chat' | 'invite' | 'join_accepted' | 'join_declined',
        content: message.content,
        is_outbound: true,
        timestamp: message.timestamp,
        read: true,
        nostr_event_id: event.id,
      };

      await this.storageManager.addActivityMessage(recipientFriend.id, message.activity_id, localMessage);
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

      const secretKey = await this.identityManager.getSecretKey();

      // Decrypt the message with user's secret key
      const plaintext = encryptionManager.decrypt(encryptedContent, userProfile.pubkey, secretKey);

      // Parse the ActivityMessage structure
      const message: ActivityMessage = JSON.parse(plaintext);

      // Validate message structure
      if (!message.type || !message.activity_id) {
        console.warn('[Messaging] Invalid message structure:', message);
        return null;
      }

      // Create message record
      const storedMessage = {
        id: `${friend.id}_${timestamp}`,
        friend_id: friend.id,
        friend_identifier: friend.identifier,
        sender_identifier: friend.identifier,
        activity_id: message.activity_id,
        type: message.type as 'chat' | 'invite' | 'join_accepted' | 'join_declined',
        content: message.content,
        is_outbound: false,
        timestamp: message.timestamp || timestamp,
        read: false,
      };

      // Store in IndexedDB
      await this.storageManager.addActivityMessage(friend.id, message.activity_id, storedMessage);

      console.debug('[Messaging] Received message from:', friend.identifier, 'type:', message.type);
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
