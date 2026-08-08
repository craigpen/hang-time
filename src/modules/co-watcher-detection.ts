/**
 * Hang Time - Co-Watcher Detection
 * Detects which friends are watching the same activity, determines host
 */

import { StorageManager } from './storage';
import { FriendManager } from './friends';

export interface CoWatchSession {
  activity_id: string;
  host_friend_uuid: string;
  co_watchers: string[]; // All UUIDs watching this activity (including self) - needed for host determination. Filter self when sending messages.
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
      // Get user profile to get self UUID
      const userProfile = await this.storage.getUserProfile();
      if (!userProfile?.uuid) {
        console.debug('[CoWatcher] User profile or UUID not found');
        return null;
      }
      const selfUuid = userProfile.uuid;

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

      console.log(`[CoWatcher] [MESSAGE_FLOW] Detecting: ${Object.keys(myActivities).length} user activities, ${friends.length} friends`);
      for (const friend of friends) {
        const actCount = friend.current_activities ? Object.keys(friend.current_activities).length : 0;
        console.log(`[CoWatcher] [MESSAGE_FLOW]   Friend ${friend.local_name} (${friend.uuid}): ${actCount} activities`);
        if (friend.current_activities) {
          for (const act of Object.values(friend.current_activities)) {
            console.log(`[CoWatcher] [MESSAGE_FLOW]     - ${act?.service} (${act?.id})`);
          }
        }
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
              console.log(`[CoWatcher] [MESSAGE_FLOW] ✅ Match found: ${userActivity.service} (${userActivity.id}) with ${friend.local_name}`);
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
        friend_uuid: string | null; // null for user
        timestamp: number; // contentTimestamp - immutable start time
      }> = [
        {
          friend_uuid: null,
          timestamp: userActivity?.contentTimestamp
        } // Include user
      ];

      for (const friend of friends) {
        if (!friend.current_activities) {
          console.log(`[CoWatcher] [MESSAGE_FLOW] Friend ${friend.local_name} (${friend.uuid}) has no current_activities`);
          continue;
        }

        for (const activity of Object.values(friend.current_activities)) {
          if (activity?.id === matchedActivityId) {
            if (activity.contentTimestamp) {
              coWatchers.push({
                friend_uuid: friend.uuid,
                timestamp: activity.contentTimestamp,
              });
              console.log(`[CoWatcher] [MESSAGE_FLOW] ✅ Found co-watcher: ${friend.local_name} (${friend.uuid}) watching activity=${matchedActivityId}`);
            } else {
              console.log(`[CoWatcher] [MESSAGE_FLOW] ❌ MISSING contentTimestamp for ${friend.local_name}, activity=${activity.id}`);
            }
            break; // Only count each friend once per matched activity
          }
        }
      }

      if (coWatchers.length === 1) {
        // Only user watching this activity
        console.debug('[CoWatcher] No co-watchers found for activity', matchedActivityId);
        return null;
      }

      // Log what's actually in coWatchers before sort
      console.debug(`[TimestampMigration] coWatchers before sort:`, coWatchers.map(cw => ({
        friend_uuid: cw.friend_uuid,
        timestamp: cw.timestamp,
        userContentTs: cw.friend_uuid === null ? userActivity?.contentTimestamp : undefined,
        userActualTs: cw.friend_uuid === null ? userActivity?.timestamp : undefined,
      })));

      // Sort by contentTimestamp (or fallback to timestamp) to find host (earliest = host)
      // Tiebreaker: if timestamps within 1 second, sort by friend_uuid for deterministic results
      coWatchers.sort((a, b) => {
        const diff = a.timestamp - b.timestamp;
        const TIMESTAMP_THRESHOLD = 1000; // 1 second

        if (Math.abs(diff) > TIMESTAMP_THRESHOLD) {
          // Timestamps far enough apart - use timestamp alone
          const result = diff < 0 ? -1 : 1;
          console.debug(`[TimestampMigration] SORT activity=${matchedActivityId}: a(${a.friend_uuid}/${a.timestamp}ms) vs b(${b.friend_uuid}/${b.timestamp}ms), diff=${diff}ms => winner=${result < 0 ? 'a' : 'b'}`);
          return diff;
        } else {
          // Timestamps within threshold - use friend_uuid as tiebreaker for stability
          const tiebreakerDiff = (a.friend_uuid || '').localeCompare(b.friend_uuid || '');
          console.debug(`[TimestampMigration] SORT (TIEBREAK) activity=${matchedActivityId}: within ${Math.abs(diff)}ms threshold, a(${a.friend_uuid}) vs b(${b.friend_uuid}) => winner=${tiebreakerDiff < 0 ? 'a' : tiebreakerDiff > 0 ? 'b' : 'equal'}`);
          return tiebreakerDiff;
        }
      });

      const hostEntry = coWatchers[0];
      const hostFriendUuid = hostEntry.friend_uuid === null ? 'self' : hostEntry.friend_uuid;

      // Get host's friendly name for logging
      let hostName = hostFriendUuid === 'self' ? 'You' : 'Unknown';
      if (hostFriendUuid !== 'self') {
        const hostFriend = friends.find(f => f.uuid === hostFriendUuid);
        if (hostFriend) {
          hostName = hostFriend.local_name;
        }
      }

      // Store ALL co-watchers (including self) for host determination
      // We need everyone's data to compute the host (earliest timestamp)
      // When sending messages, SEND_MESSAGE handler filters self out
      const allCoWatchers = coWatchers
        .map(cw => cw.friend_uuid === null ? selfUuid : cw.friend_uuid)
        .filter(uuid => uuid !== undefined);

      const session: CoWatchSession = {
        activity_id: matchedActivityId,
        host_friend_uuid: hostFriendUuid,
        co_watchers: allCoWatchers,
        detected_at: Date.now(),
      };

      console.debug('[CoWatcher] Co-watch session detected:', {
        activity_id: session.activity_id,
        host: hostName,
        co_watchers_count: allCoWatchers.length,
      });
      console.debug(`[TimestampMigration:CoWatcherHost] ✅ Host determined: ${hostName} (${hostFriendUuid}) with timestamp=${hostEntry.timestamp}`);

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

      const host = await this.storage.getFriend(session.host_friend_uuid);
      if (!host) return null;

      return {
        id: host.uuid,
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
