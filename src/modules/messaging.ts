/**
 * Hang Time - Messaging System
 * Handles sending and receiving encrypted messages via Nostr kind-4
 * Also handles invites via parameterized replaceable events (kind 30001)
 */

import { finalizeEvent, nip04 } from 'nostr-tools';
import { Activity, NostrEvent, Friend } from '../types';
import { RelayPool } from './nostr';
import { IdentityManager } from './identity';
import { StorageManager } from './storage';
import { generateActivityId } from './activity-utils';
import type { PublishQueue } from './publish-queue';

// Helper: Convert hex string to Uint8Array (for nostr-tools finalizeEvent)
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
}

// Singleton instance with lazy initialization
let instance: MessagingManager | null = null;

export interface ActivityMessage {
  type: 'chat' | 'invite' | 'join_accepted' | 'join_declined';
  activity_id: string;
  content?: string;
  timestamp: number;
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
   * Send a friend request notification (kind-30001, parameterized replaceable)
   * Only latest friend request per recipient is stored on relays
   */
  async sendFriendRequest(recipientIdentifier: string, recipientPubkey: string, recipientDisplayName: string): Promise<void> {
    const userProfile = await this.storageManager.getUserProfile();
    if (!userProfile) {
      throw new Error('User profile not found');
    }

    const pubkey = await this.identityManager.getPubkey();
    const secretKeyHex = await this.identityManager.getSecretKey();

    // Build tags with friend request metadata
    // The 'd' tag identifies this as a friend request to this specific recipient (parameterized replaceable)
    const tags = [
      ['d', `friend_request_${recipientPubkey}`], // Unique identifier per recipient
      ['is_notification', 'true'],
      ['type', 'friend_request'],
      ['recipient', recipientPubkey],
      ['sender_identifier', userProfile.memorable_identifier],
      ['sender_display_name', userProfile.nickname || userProfile.memorable_identifier],
    ];

    // Create kind-30001 parameterized replaceable friend request event
    // Note: created_at will be refreshed by PublishQueue at actual publish time
    const event = finalizeEvent({
      kind: 30001,
      tags,
      content: `${userProfile.nickname || userProfile.memorable_identifier} added you as a friend`,
      created_at: Math.floor(Date.now() / 1000), // Placeholder, will be refreshed at publish time
    }, hexToBytes(secretKeyHex)) as NostrEvent;

    // Queue or publish the event
    console.log(`[Messaging] 📤 Queuing friend request to ${recipientDisplayName} (${recipientPubkey.substring(0, 8)}...)`);
    if (this.publishQueue) {
      await this.publishQueue.enqueueUserAction(event, 'friend_request');
    } else {
      // Fallback if queue not initialized (shouldn't happen in normal flow)
      await this.relayPool.publish(event, userProfile.publisher_config);
    }
  }

  /**
   * Send an invite notification to a friend about an activity (kind-1, unencrypted)
   */
  async sendInvite(activity: Activity, recipientFriend: Friend): Promise<string> {
    const userProfile = await this.storageManager.getUserProfile();
    if (!userProfile) {
      throw new Error('User profile not found');
    }

    const pubkey = await this.identityManager.getPubkey();

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

    // Add 'd' tag for parameterized replaceable event (unique per activity+recipient combo)
    const activityIdForTag = activity.id || generateActivityId(activity.service, activity.url);
    tags.push(['d', `invite_${activityIdForTag}_${recipientFriend.pubkey}`]);

    const secretKeyHex = await this.identityManager.getSecretKey();

    // Create kind-30001 parameterized replaceable invite event
    // Note: created_at will be refreshed by PublishQueue at actual publish time
    const event = finalizeEvent({
      kind: 30001,
      tags,
      content: `Inviting ${recipientFriend.local_name} to ${activity.content || activity.service}`,
      created_at: Math.floor(Date.now() / 1000), // Placeholder, will be refreshed at publish time
    }, hexToBytes(secretKeyHex)) as NostrEvent;

    // Queue or publish the event
    console.log(`[Messaging] 📤 Queuing invite to ${recipientFriend.local_name} (${recipientFriend.pubkey.substring(0, 8)}...)`);
    if (this.publishQueue) {
      await this.publishQueue.enqueueUserAction(event, 'invite');
    } else {
      // Fallback if queue not initialized
      await this.relayPool.publish(event, userProfile.publisher_config);
    }

    return event.id; // Return event ID for tracking/retry
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
      timestamp: Date.now(),
    };

    const eventId = await this._sendActivityMessage(recipientFriend, message);
    console.debug('[Messaging] Sent join_declined for activity:', activity.service);
    return eventId;
  }

  /**
   * Send friend request message via kind-4 (encrypted)
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
          sender_identifier: userProfile.memorable_identifier,
          sender_display_name: userProfile.nickname || userProfile.memorable_identifier,
          sender_pubkey: pubkey,
        }),
        timestamp: Date.now(),
      };

      // Serialize and encrypt using nip04
      const plaintext = JSON.stringify(message);
      const encryptedContent = await nip04.encrypt(secretKey, recipientPubkey, plaintext);

      // Create kind-4 event with message_type tag
      const tags: Array<[string, string]> = [
        ['p', recipientPubkey],
        ['message_type', 'friend_request'],
      ];

      // Use finalizeEvent() for consistent event signing
      // Note: created_at will be refreshed by PublishQueue at actual publish time
      const event = finalizeEvent({
        kind: 4,
        tags,
        content: encryptedContent,
        created_at: Math.floor(Date.now() / 1000), // Placeholder, will be refreshed at publish time
      }, hexToBytes(secretKey)) as NostrEvent;

      // Queue or publish the event
      console.log(`[Messaging] 📤 Queuing kind-4 friend request to ${recipientPubkey.substring(0, 8)}...`);
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
   * Internal: send encrypted activity message via kind-4
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

      // Serialize message to JSON and encrypt using nip04 with recipient's pubkey
      const plaintext = JSON.stringify(message);
      const encryptedContent = await nip04.encrypt(secretKey, recipientFriend.pubkey, plaintext);

      // Create kind-4 event with recipient tag and message type
      const tags: Array<[string, string]> = [['p', recipientFriend.pubkey]];

      // Add message_type tag for routing (friend_request for accept/decline, chat for future chat)
      if (message.type === 'join_accepted' || message.type === 'join_declined') {
        tags.push(['message_type', 'friend_request']);
      } else if (message.type === 'chat') {
        tags.push(['message_type', 'chat']);
      }

      // Use finalizeEvent() for consistent event signing
      // Note: created_at will be refreshed by PublishQueue at actual publish time
      const event = finalizeEvent({
        kind: 4,
        tags,
        content: encryptedContent,
        created_at: Math.floor(Date.now() / 1000), // Placeholder, will be refreshed at publish time
      }, hexToBytes(secretKey)) as NostrEvent;

      // Queue or publish the event
      console.log(`[Messaging] 📤 Queuing kind-4 ${message.type} to ${recipientFriend.local_name} (${recipientFriend.pubkey.substring(0, 8)}...)`);
      if (this.publishQueue) {
        await this.publishQueue.enqueueUserAction(event, 'message');
      } else {
        // Fallback if queue not initialized
        const publishConfig = userProfile.publisher_config;
        await this.relayPool.publish(event, publishConfig);
      }

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

      const secretKey = await this.identityManager.getSecretKey();

      // Decrypt the message using nip04 with friend's pubkey (they sent it to us)
      const plaintext = await nip04.decrypt(secretKey, friend.pubkey, encryptedContent);

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
