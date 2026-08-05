/**
 * Hang Time - Co-Watcher Detection
 * Detects which friends are watching the same activity, determines host
 */

import { StorageManager } from './storage';
import { FriendManager } from './friends';

export interface CoWatchSession {
  activity_id: string;
  host_friend_id: string;
  co_watchers: string[]; // Friend IDs of other co-watchers (excluding host)
  detected_at: number;
}

export class CoWatcherDetector {
  private detectCallCount = 0;

  constructor(
    private storage: StorageManager,
    private friendManager: FriendManager
  ) {}

  /**
   * Detect current co-watch session
   * Returns null if user is not watching or no friends are watching same activity
   */
  async detectCoWatchSession(): Promise<CoWatchSession | null> {
    this.detectCallCount++;
    // Log every call for debugging
    console.debug(`[CoWatcher] detectCoWatchSession call #${this.detectCallCount}`);
    try {
      const profile = await this.storage.getUserProfile();
      if (!profile?.current_activity) {
        console.debug('[CoWatcher] No current activity');
        return null;
      }

      const userActivityId = profile.current_activity.id;
      const friends = await this.friendManager.getAllFriends();

      if (!friends || friends.length === 0) {
        console.debug('[CoWatcher] No friends to check');
        return null;
      }

      // Find all friends watching the same activity
      const coWatchers: Array<{
        friend_id: string;
        timestamp: number;
      }> = [];

      for (const friend of friends) {
        if (!friend.current_activities) continue;

        for (const activity of Object.values(friend.current_activities)) {
          if (activity?.id === userActivityId) {
            coWatchers.push({
              friend_id: friend.id,
              timestamp: activity.timestamp || 0,
            });
            break; // Only count each friend once
          }
        }
      }

      if (coWatchers.length === 0) {
        console.debug('[CoWatcher] No co-watchers found for activity', userActivityId);
        return null;
      }

      // Sort by timestamp to find host (earliest = host)
      coWatchers.sort((a, b) => a.timestamp - b.timestamp);

      const hostFriendId = coWatchers[0].friend_id;
      const otherCoWatchers = coWatchers.slice(1).map(cw => cw.friend_id);

      const session: CoWatchSession = {
        activity_id: userActivityId,
        host_friend_id: hostFriendId,
        co_watchers: otherCoWatchers,
        detected_at: Date.now(),
      };

      console.debug('[CoWatcher] Co-watch session detected:', {
        activity_id: session.activity_id,
        host: hostFriendId,
        co_watchers_count: otherCoWatchers.length,
      });

      return session;
    } catch (error) {
      console.error('[CoWatcher] Detection failed:', error);
      return null;
    }
  }

  /**
   * Store current co-watch session
   */
  async setCurrentCoWatchSession(session: CoWatchSession | null): Promise<void> {
    try {
      const profile = await this.storage.getUserProfile();
      if (!profile) return;

      await this.storage.updateUserProfile({
        ...profile,
        current_co_watch_session: session,
      });

      if (session) {
        console.debug('[CoWatcher] Stored co-watch session:', session.activity_id);
      } else {
        console.debug('[CoWatcher] Cleared co-watch session');
      }
    } catch (error) {
      console.error('[CoWatcher] Failed to store session:', error);
    }
  }

  /**
   * Get current stored co-watch session
   */
  async getCurrentCoWatchSession(): Promise<CoWatchSession | null> {
    try {
      const profile = await this.storage.getUserProfile();
      return profile?.current_co_watch_session || null;
    } catch (error) {
      console.error('[CoWatcher] Failed to get session:', error);
      return null;
    }
  }

  /**
   * Get host friend details for current co-watch
   */
  async getHostFriendDetails(): Promise<{ id: string; local_name: string } | null> {
    try {
      const session = await this.getCurrentCoWatchSession();
      if (!session) return null;

      const host = await this.storage.getFriend(session.host_friend_id);
      if (!host) return null;

      return {
        id: host.id,
        local_name: host.local_name,
      };
    } catch (error) {
      console.error('[CoWatcher] Failed to get host details:', error);
      return null;
    }
  }
}

// Singleton instance
let instance: CoWatcherDetector | null = null;

export function initializeCoWatcherDetector(
  storage: StorageManager,
  friendManager: FriendManager
): void {
  instance = new CoWatcherDetector(storage, friendManager);
}

export function getCoWatcherDetector(): CoWatcherDetector {
  if (!instance) {
    throw new Error('CoWatcherDetector not initialized');
  }
  return instance;
}
