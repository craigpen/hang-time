/**
 * Hang Time - Friend Management
 * Handles friend list operations and activity tracking
 */

import { Friend, FriendList, Activity } from '../types';
import { StorageManager } from './storage';

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
   * Add new friend
   */
  async addFriend(identifier: string, localName: string): Promise<Friend> {
    const existing = await this.getFriendByIdentifier(identifier);
    if (existing) {
      throw new Error(`Friend with identifier "${identifier}" already exists`);
    }

    const friend: Friend = {
      id: this._generateId(),
      identifier,
      local_name: localName,
      added_at: Date.now(),
      last_seen: Date.now(),
      muted: false,
      hidden_services: [],
    };

    await this.storage.addFriend(friend);
    console.debug('[FriendManager] Added friend:', localName);

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
    console.debug('[FriendManager] Removed friend:', friend.local_name);
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
    console.debug('[FriendManager] Renamed friend to:', newName);
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
    console.debug('[FriendManager] Muted friend:', friend.local_name);
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
    console.debug('[FriendManager] Unmuted friend:', friend.local_name);
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
    console.debug('[FriendManager] Hidden service from friend:', service);
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
    console.debug('[FriendManager] Shown service to friend:', service);
  }

  /**
   * Update friend's current activity
   */
  async updateFriendActivity(friendId: string, activity: Activity): Promise<void> {
    const friend = await this.getFriend(friendId);
    if (!friend) {
      throw new Error(`Friend not found: ${friendId}`);
    }

    await this.storage.updateFriend(friendId, {
      current_activity: activity,
      current_activity_timestamp: Date.now(),
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
   * Get active friends (with recent activity)
   */
  async getActiveFriends(maxAgeMs: number = 5 * 60 * 1000): Promise<Friend[]> {
    const friends = await this.getAllFriends();
    const now = Date.now();

    return friends.filter((friend) => {
      // Skip muted friends
      if (friend.muted) return false;

      // Must have activity
      if (!friend.current_activity) return false;

      // Activity must not be idle
      if (friend.current_activity.service === 'idle') return false;

      // Activity must be recent
      const activityAge = now - (friend.current_activity_timestamp ?? 0);
      return activityAge < maxAgeMs;
    });
  }

  private _generateId(): string {
    return Math.random().toString(36).substring(2, 15);
  }
}

// Singleton instance
export const friendManager = new FriendManager(require('./storage').storageManager);
