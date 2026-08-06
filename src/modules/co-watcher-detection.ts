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
      // Get all user activities (not just current)
      const myActivities = await this.storage.getMyActivities();
      if (!myActivities || Object.keys(myActivities).length === 0) {
        console.debug('[CoWatcher] No user activities');
        return null;
      }

      const friends = await this.friendManager.getAllFriends();
      if (!friends || friends.length === 0) {
        console.debug('[CoWatcher] No friends to check');
        return null;
      }

      // Find matching activity ID across all user and friend activities
      let matchedActivityId: string | null = null;
      let matchedActivityTimestamp = 0;

      for (const userActivity of Object.values(myActivities)) {
        if (!userActivity?.id) continue;

        for (const friend of friends) {
          if (!friend.current_activities) continue;

          for (const friendActivity of Object.values(friend.current_activities)) {
            if (friendActivity?.id === userActivity.id) {
              console.debug(`[CoWatcher] ✅ Match found: ${userActivity.service} (${userActivity.id})`);
              matchedActivityId = userActivity.id;
              matchedActivityTimestamp = userActivity.timestamp || Date.now();
              break;
            }
          }
          if (matchedActivityId) break;
        }
        if (matchedActivityId) break;
      }

      if (!matchedActivityId) {
        console.debug('[CoWatcher] No matching activities found');
        return null;
      }

      // Find user's matched activity to get contentTimestamp
      let userActivity: any = null;
      for (const activity of Object.values(myActivities)) {
        if (activity?.id === matchedActivityId) {
          userActivity = activity;
          break;
        }
      }

      // Build co-watcher list for the matched activity
      const coWatchers: Array<{
        friend_id: string | null; // null for user
        timestamp: number; // contentTimestamp if available, fallback to timestamp
      }> = [
        {
          friend_id: null,
          timestamp: userActivity?.contentTimestamp || userActivity?.timestamp || matchedActivityTimestamp
        } // Include user
      ];

      for (const friend of friends) {
        if (!friend.current_activities) continue;

        for (const activity of Object.values(friend.current_activities)) {
          if (activity?.id === matchedActivityId) {
            coWatchers.push({
              friend_id: friend.id,
              timestamp: activity.contentTimestamp || activity.timestamp || 0,
            });
            console.debug(`[TimestampMigration:CoWatcherHost] friend=${friend.id} using timestamp=${activity.contentTimestamp ? 'contentTimestamp' : 'timestamp'} (value=${activity.contentTimestamp || activity.timestamp})`);
            break; // Only count each friend once per matched activity
          }
        }
      }

      if (coWatchers.length === 1) {
        // Only user watching this activity
        console.debug('[CoWatcher] No co-watchers found for activity', matchedActivityId);
        return null;
      }

      // Sort by contentTimestamp (or fallback to timestamp) to find host (earliest = host)
      coWatchers.sort((a, b) => {
        const diff = a.timestamp - b.timestamp;
        if (diff !== 0) {
          console.debug(`[TimestampMigration:CoWatcherHost] Sorting: a(${a.friend_id})=${a.timestamp} vs b(${b.friend_id})=${b.timestamp} => ${diff < 0 ? 'a is host' : 'b is host'}`);
        }
        return diff;
      });

      const hostEntry = coWatchers[0];
      const hostFriendId = hostEntry.friend_id === null ? 'self' : hostEntry.friend_id;
      const otherCoWatchers = coWatchers.slice(1)
        .filter(cw => cw.friend_id !== null)
        .map(cw => cw.friend_id as string);

      const session: CoWatchSession = {
        activity_id: matchedActivityId,
        host_friend_id: hostFriendId,
        co_watchers: otherCoWatchers,
        detected_at: Date.now(),
      };

      console.debug('[CoWatcher] Co-watch session detected:', {
        activity_id: session.activity_id,
        host: hostFriendId,
        co_watchers_count: otherCoWatchers.length,
      });
      console.debug(`[TimestampMigration:CoWatcherHost] ✅ Host determined: ${hostFriendId} with timestamp=${hostEntry.timestamp}`);

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
