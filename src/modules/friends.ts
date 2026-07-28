/**
 * Hang Time - Friend Management
 * Handles friend list operations and activity tracking
 */

import { Friend, FriendList, Activity } from '../types';
import { StorageManager } from './storage';
import { secureLog, validateFriendName, generateSecureRandom, deriveKeypairFromIdentifier } from './security-utils';

export class FriendManager {
  constructor(private storage: StorageManager) {}

  /**
   * Get all friends
   */
  async getAllFriends(): Promise<FriendList> {
    return this.storage.getFriends();
  }

  /**
   * Get single friend by ID
   */
  async getFriend(friendId: string): Promise<Friend | undefined> {
    return this.storage.getFriend(friendId);
  }

  /**
   * Get friend by identifier (memorable ID)
   */
  async getFriendByIdentifier(identifier: string): Promise<Friend | undefined> {
    const friends = await this.getAllFriends();
    return friends.find((f) => f.identifier === identifier);
  }

  /**
   * Derive pubkey from identifier (for subscription)
   */
  derivePubkeyFromIdentifier(identifier: string): string {
    return this._derivePubkeyFromIdentifier(identifier);
  }

  /**
   * Add new friend
   */
  async addFriend(identifier: string, localName: string): Promise<Friend> {
    // Validate friend name
    const validation = validateFriendName(localName);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const existing = await this.getFriendByIdentifier(identifier);
    if (existing) {
      throw new Error(`Friend with identifier "${identifier}" already exists`);
    }

    // Derive pubkey deterministically from identifier using SHA-256
    const pubkey = this._derivePubkeyFromIdentifier(identifier);

    const friend: Friend = {
      id: this._generateId(),
      identifier,
      pubkey,
      local_name: localName,
      added_at: Date.now(),
      last_seen: Date.now(),
      muted: false,
      hidden_services: [],
      current_activities: {},
    };

    await this.storage.addFriend(friend);
    secureLog.debug('FriendManager', `Added friend: ${localName}`);

    return friend;
  }

  /**
   * Remove friend by ID
   */
  async removeFriend(friendId: string): Promise<void> {
    const friend = await this.getFriend(friendId);
    if (!friend) {
      throw new Error(`Friend not found: ${friendId}`);
    }

    await this.storage.removeFriend(friendId);
    secureLog.debug('FriendManager', `Removed friend: ${friend.local_name}`);
  }

  /**
   * Rename friend
   */
  async renameFriend(friendId: string, newName: string): Promise<void> {
    const friend = await this.getFriend(friendId);
    if (!friend) {
      throw new Error(`Friend not found: ${friendId}`);
    }

    await this.storage.updateFriend(friendId, { local_name: newName });
    secureLog.debug('FriendManager', `Renamed friend to: ${newName}`);
  }

  /**
   * Mute friend (hide their activity)
   */
  async muteFriend(friendId: string): Promise<void> {
    const friend = await this.getFriend(friendId);
    if (!friend) {
      throw new Error(`Friend not found: ${friendId}`);
    }

    await this.storage.updateFriend(friendId, { muted: true });
    secureLog.debug('FriendManager', `Muted friend: ${friend.local_name}`);
  }

  /**
   * Unmute friend
   */
  async unmuteFriend(friendId: string): Promise<void> {
    const friend = await this.getFriend(friendId);
    if (!friend) {
      throw new Error(`Friend not found: ${friendId}`);
    }

    await this.storage.updateFriend(friendId, { muted: false });
    secureLog.debug('FriendManager', `Unmuted friend: ${friend.local_name}`);
  }

  /**
   * Hide service from friend (don't share that service's activity with them)
   */
  async hideServiceFromFriend(friendId: string, service: string): Promise<void> {
    const friend = await this.getFriend(friendId);
    if (!friend) {
      throw new Error(`Friend not found: ${friendId}`);
    }

    const hidden = new Set(friend.hidden_services);
    hidden.add(service);

    await this.storage.updateFriend(friendId, { hidden_services: Array.from(hidden) });
    secureLog.debug('FriendManager', `Hidden service from friend: ${service}`);
  }

  /**
   * Show service to friend
   */
  async showServiceToFriend(friendId: string, service: string): Promise<void> {
    const friend = await this.getFriend(friendId);
    if (!friend) {
      throw new Error(`Friend not found: ${friendId}`);
    }

    const hidden = new Set(friend.hidden_services);
    hidden.delete(service);

    await this.storage.updateFriend(friendId, { hidden_services: Array.from(hidden) });
    secureLog.debug('FriendManager', `Shown service to friend: ${service}`);
  }

  /**
   * Update friend's current activity
   */
  async updateFriendActivity(friendId: string, activity: Activity): Promise<void> {
    const friend = await this.getFriend(friendId);
    if (!friend) {
      throw new Error(`Friend not found: ${friendId}`);
    }

    // Clean up old service name entries to prevent duplicates
    // (e.g., remove 'netflix' if we're adding 'netflix-tab')
    const cleanedActivities = { ...friend.current_activities };

    // Get the base service name (strip -api or -tab)
    const baseService = activity.service.replace('-api', '').replace('-tab', '');

    // Remove any old entries that use the base name without suffix
    Object.keys(cleanedActivities).forEach((key) => {
      const keyBase = key.replace('-api', '').replace('-tab', '');
      if (keyBase === baseService && key !== activity.service) {
        delete cleanedActivities[key as any];
      }
    });

    await this.storage.updateFriend(friendId, {
      current_activities: {
        ...cleanedActivities,
        [activity.service]: activity,
      },
      last_seen: Date.now(),
    });

    // Store in history
    await this.storage.addActivityToHistory(friendId, activity);
  }

  /**
   * Get activity history for friend
   */
  async getActivityHistory(friendId: string): Promise<Activity[]> {
    return this.storage.getActivityHistory(friendId);
  }

  /**
   * Get friends with published activities
   */
  async getActiveFriends(): Promise<Friend[]> {
    const friends = await this.getAllFriends();
    return friends.filter((friend) => {
      // Skip muted friends
      if (friend.muted) return false;
      // Show any friend with any activity
      return Object.keys(friend.current_activities || {}).length > 0;
    });
  }

  private _generateId(): string {
    return generateSecureRandom(16);
  }

  private _derivePubkeyFromIdentifier(identifier: string): string {
    // Use shared keypair derivation (same as identity.ts)
    const { pubkey } = deriveKeypairFromIdentifier(identifier);
    return pubkey;
  }
}

// Singleton instance with lazy initialization
let friendManagerInstance: FriendManager | null = null;

export function initializeFriendManager(storage: StorageManager): void {
  friendManagerInstance = new FriendManager(storage);
}

export function getFriendManager(): FriendManager {
  if (!friendManagerInstance) {
    throw new Error('FriendManager not initialized');
  }
  return friendManagerInstance;
}
