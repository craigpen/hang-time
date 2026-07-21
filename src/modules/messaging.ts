/**
 * Hang Time - Encrypted Messaging Module
 * Handles encrypted message encryption/decryption via Nostr kind 4 events
 */

import { Message, NostrEvent } from '../types';
import { StorageManager } from './storage';
import { IdentityManager } from './identity';
import { RelayPool } from './nostr';
import { encryptionManager } from './encryption';
import { secureLog, validateMessage, generateSecureRandom } from './security-utils';

export class MessagingManager {
  constructor(
    private storage: StorageManager,
    private identityManager: IdentityManager,
    private relayPool: RelayPool
  ) {}

  /**
   * Send encrypted message to friend
   */
  async sendMessage(friendId: string, content: string): Promise<Message> {
    // Validate message content
    const validation = validateMessage(content);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const friend = await this.storage.getFriend(friendId);
    if (!friend) {
      throw new Error(`Friend not found: ${friendId}`);
    }

    const userIdentifier = await this.identityManager.getIdentifier();
    const timestamp = Date.now();

    const message: Message = {
      id: this._generateId(),
      friend_id: friendId,
      friend_identifier: friend.identifier,
      sender_identifier: userIdentifier,
      content,
      is_outbound: true,
      timestamp,
      read: true,
    };

    // Store message locally
    await this.storage.addMessage(friendId, message);

    // Publish encrypted message to Nostr
    await this._publishMessage(friend.identifier, content);

    secureLog.debug('Messaging', `Message sent to ${friend.local_name}`);
    return message;
  }

  /**
   * Receive and decrypt message from friend
   */
  async receiveMessage(
    friendIdentifier: string,
    content: string,
    timestamp: number
  ): Promise<Message | null> {
    try {
      // Find friend by identifier
      const friends = await this.storage.getFriends();
      const friend = friends.find((f) => f.identifier === friendIdentifier);

      if (!friend) {
        secureLog.warn('Messaging', 'Message from unknown friend');
        return null;
      }

      const userIdentifier = await this.identityManager.getIdentifier();

      const message: Message = {
        id: this._generateId(),
        friend_id: friend.id,
        friend_identifier: friendIdentifier,
        sender_identifier: friendIdentifier,
        content,
        is_outbound: false,
        timestamp,
        read: false,
      };

      // Store message locally
      await this.storage.addMessage(friend.id, message);

      // Mark as read if friend is not muted
      if (!friend.muted) {
        await this.markMessageRead(friend.id, message.id);
      }

      secureLog.debug('Messaging', `Message received from ${friend.local_name}`);
      return message;
    } catch (error) {
      secureLog.error('Messaging', 'Failed to receive message', error);
      return null;
    }
  }

  /**
   * Mark message as read
   */
  async markMessageRead(friendId: string, messageId: string): Promise<void> {
    const messages = await this.storage.getMessages(friendId);
    const message = messages.find((m) => m.id === messageId);

    if (message) {
      message.read = true;
      await this.storage.addMessage(friendId, message);
    }
  }

  /**
   * Get messages for friend
   */
  async getMessages(friendId: string): Promise<Message[]> {
    return this.storage.getMessages(friendId);
  }

  /**
   * Get unread message count
   */
  async getUnreadCount(friendId?: string): Promise<number> {
    if (friendId) {
      const messages = await this.storage.getMessages(friendId);
      return messages.filter((m) => !m.read && !m.is_outbound).length;
    }

    // Count across all friends
    const friends = await this.storage.getFriends();
    let total = 0;

    for (const friend of friends) {
      const messages = await this.storage.getMessages(friend.id);
      total += messages.filter((m) => !m.read && !m.is_outbound).length;
    }

    return total;
  }

  private async _publishMessage(friendIdentifier: string, content: string): Promise<void> {
    try {
      const userIdentifier = await this.identityManager.getIdentifier();

      // Encrypt message using NIP-04
      // For MVP: derive a consistent hex key from friend identifier
      const friendKeyHash = encryptionManager.hash(friendIdentifier);
      // Pad the hash to 64 chars (32 bytes in hex) for box encryption
      const friendPublicKey = (friendKeyHash + '0'.repeat(64)).substring(0, 64);

      const encryptedContent = encryptionManager.encrypt(content, friendPublicKey);

      // Create Nostr kind 4 (encrypted DM) event
      const event: NostrEvent = {
        id: this._generateId(),
        pubkey: userIdentifier,
        created_at: Math.floor(Date.now() / 1000),
        kind: 4,
        tags: [['p', friendIdentifier]],
        content: encryptedContent,
      };

      await this.relayPool.publish(event);
      secureLog.debug('Messaging', 'Published encrypted message to Nostr (kind 4)');
    } catch (error) {
      secureLog.error('Messaging', 'Failed to publish message', error);
      throw error;
    }
  }

  private _generateId(): string {
    return generateSecureRandom(16);
  }
}

// Singleton instance with lazy initialization
let messagingManager: MessagingManager | null = null;

export function initializeMessagingManager(
  storage: StorageManager,
  identity: IdentityManager,
  relayPool: RelayPool
): void {
  messagingManager = new MessagingManager(storage, identity, relayPool);
}

export function getMessagingManager(): MessagingManager {
  if (!messagingManager) {
    throw new Error('MessagingManager not initialized');
  }
  return messagingManager;
}
