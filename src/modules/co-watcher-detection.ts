/**
 * Hang Time - Co-Watcher Detection
 * Detects which friends are watching the same activity, determines host
 */

import { StorageManager } from './storage';
import { FriendManager } from './friends';
import { CoWatchSession } from '../types';

// Activity-specific co-watch detection (separate from session)
export interface ActivityCoWatchSession {
  activity_id: string;
  host_friend_uuid: string;
  co_watchers: string[]; // All UUIDs watching this activity (including self) - needed for host determination. Filter self when sending messages.
  detected_at: number;
}

// Set of browser media services eligible for synchronized video co-watching
export const CO_WATCHABLE_SERVICES = new Set<string>([
  'youtube-tab',
  'netflix-tab',
  'twitch-tab',
  'video-tab',
]);

export class CoWatcherDetector {
  private detectCallCount = 0;

  constructor(
    private storage: StorageManager,
    private friendManager: FriendManager
  ) {}

  /**
   * Detect current co-watch session based on activity matching
   * Returns activity-specific co-watch info (host, co-watchers on same activity_id)
   * Returns null if user is not watching or no friends are watching same activity
   */
  async detectCoWatchSession(): Promise<ActivityCoWatchSession | null> {
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

      // If user has DND enabled, skip co-watch detection entirely
      if (userProfile.dnd_enabled) {
        console.debug('[CoWatcher] User has DND enabled, skipping co-watch detection');
        return null;
      }

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
        console.log(`[CoWatcher] [MESSAGE_FLOW]   Friend ${friend.local_name} (${friend.uuid}): ${actCount} activities (DND: ${friend.dnd ?? false})`);
        if (friend.current_activities) {
          for (const act of Object.values(friend.current_activities)) {
            console.log(`[CoWatcher] [MESSAGE_FLOW]     - ${act?.service} (${act?.id})`);
          }
        }
      }

      // Find matching activity ID across co-watchable video/media services
      let matchedActivityId: string | null = null;

      for (const userActivity of Object.values(myActivities)) {
        if (!userActivity?.id || !CO_WATCHABLE_SERVICES.has(userActivity.service)) continue;

        for (const friend of friends) {
          if (!friend.current_activities || friend.dnd || friend.muted) continue;

          for (const friendActivity of Object.values(friend.current_activities)) {
            if (!friendActivity || friendActivity.dnd || friendActivity.metadata?.dnd || !CO_WATCHABLE_SERVICES.has(friendActivity.service)) continue;

            if (friendActivity.id === userActivity.id) {
              console.log(`[CoWatcher] [MESSAGE_FLOW] ✅ Match found: ${userActivity.service} (${userActivity.id}) with ${friend.local_name}`);
              matchedActivityId = userActivity.id;
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
        if (!friend.current_activities || friend.dnd || friend.muted) {
          continue;
        }

        for (const activity of Object.values(friend.current_activities)) {
          if (activity?.dnd || activity?.metadata?.dnd) continue;

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

      // Check if both activities are fresh (not stale from idle period)
      // Only create session if both user and all co-watchers have recent activity
      const ACTIVITY_FRESHNESS_MS = 10 * 60 * 1000; // 10 minutes, same as purge timeout
      const now = Date.now();
      for (const coWatcher of coWatchers) {
        let activity;
        let lastSeen: number | undefined;
        if (coWatcher.friend_uuid === null) {
          activity = userActivity;
          lastSeen = userActivity?.metadata?.progress_measured_at || userActivity?.freshness_timestamp || userActivity?.timestamp;
        } else {
          const friend = friends.find(f => f.uuid === coWatcher.friend_uuid);
          activity = friend ? Object.values(friend.current_activities || {}).find(a => a?.id === matchedActivityId) : undefined;
          lastSeen = activity?.metadata?.progress_measured_at || activity?.freshness_timestamp || friend?.last_seen || activity?.timestamp;
        }

        const lastMeasuredAt = lastSeen || activity?.timestamp;
        if (!lastMeasuredAt || (now - lastMeasuredAt) >= ACTIVITY_FRESHNESS_MS) {
          console.debug('[CoWatcher] Activity too stale, blocking session creation:', {
            activity_id: matchedActivityId,
            member: coWatcher.friend_uuid === null ? 'self' : coWatcher.friend_uuid,
            lastMeasuredAt,
            ageMs: lastMeasuredAt ? now - lastMeasuredAt : 'unknown'
          });
          return null;
        }
      }

      // Log what's actually in coWatchers before sort
      console.debug(`[TimestampMigration] coWatchers before sort:`, coWatchers.map(cw => ({
        friend_uuid: cw.friend_uuid,
        timestamp: cw.timestamp,
        userContentTs: cw.friend_uuid === null ? userActivity?.contentTimestamp : undefined,
        userActualTs: cw.friend_uuid === null ? userActivity?.timestamp : undefined,
      })));

      // Store ALL co-watchers (including self) for host determination
      // We need everyone's data to compute the host (earliest timestamp)
      // When sending messages, SEND_MESSAGE handler filters self out
      const allCoWatchers = coWatchers
        .map(cw => cw.friend_uuid === null ? selfUuid : cw.friend_uuid)
        .filter(uuid => uuid !== undefined);

      console.log('[CoWatcher] DEBUG: allCoWatchers:', allCoWatchers.map(cw => ({ id: cw, length: cw.length, preview: cw.slice(0, 20) })));

      // Check if an existing active session has a sticky host still co-watching this activity
      const existingSession = await this.storage.getActiveSession();
      let hostFriendUuid: string;

      const incumbentHost = existingSession?.is_active ? existingSession.host_friend_uuid : undefined;
      const incumbentUuid = incumbentHost === 'self' ? selfUuid : incumbentHost;
      const incumbentStillWatching = incumbentUuid && allCoWatchers.includes(incumbentUuid);

      if (incumbentStillWatching && incumbentHost) {
        hostFriendUuid = incumbentHost;
        console.debug(`[TimestampMigration:CoWatcherHost] 🔒 Preserving sticky host: ${hostFriendUuid}`);
      } else {
        // Sort by contentTimestamp to elect new host (earliest = host)
        coWatchers.sort((a, b) => {
          const diff = a.timestamp - b.timestamp;
          console.debug(`[TimestampMigration] SORT activity=${matchedActivityId}: a(${a.friend_uuid}/${a.timestamp}ms) vs b(${b.friend_uuid}/${b.timestamp}ms), diff=${diff}ms => winner=${diff < 0 ? 'a' : diff > 0 ? 'b' : 'tie'}`);
          return diff;
        });
        const hostEntry = coWatchers[0];
        hostFriendUuid = hostEntry?.friend_uuid === null ? 'self' : (hostEntry?.friend_uuid ?? 'self');
        console.debug(`[TimestampMigration:CoWatcherHost] 👑 Newly elected host: ${hostFriendUuid} with timestamp=${hostEntry?.timestamp}`);
      }

      // Get host's friendly name for logging
      let hostName = hostFriendUuid === 'self' ? 'You' : 'Unknown';
      if (hostFriendUuid !== 'self') {
        const hostFriend = friends.find(f => f.uuid === hostFriendUuid);
        if (hostFriend) {
          hostName = hostFriend.local_name;
        }
      }

      const session: ActivityCoWatchSession = {
        activity_id: matchedActivityId,
        host_friend_uuid: hostFriendUuid,
        co_watchers: allCoWatchers,
        detected_at: Date.now(),
      };

      console.log('[CoWatcher] DEBUG: activity session co_watchers:', session.co_watchers.map(cw => ({ id: cw, length: cw.length })));

      console.debug('[CoWatcher] Co-watch session detected:', {
        activity_id: session.activity_id,
        host: hostName,
        co_watchers_count: allCoWatchers.length,
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
  async setCurrentCoWatchSession(session: ActivityCoWatchSession | null): Promise<void> {
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
   * Get current stored co-watch session (activity-specific, legacy model)
   * Used internally for host determination
   */
  async getCurrentActivityCoWatchSession(): Promise<ActivityCoWatchSession | null> {
    try {
      const profile = await this.storage.getUserProfile();
      return profile?.current_co_watch_session as ActivityCoWatchSession | undefined || null;
    } catch (error) {
      console.error('[CoWatcher] Failed to get session:', error);
      return null;
    }
  }

  /**
   * Get current user session (new model, independent of activity)
   * This session persists across activity changes
   */
  async getCurrentCoWatchSession(): Promise<CoWatchSession | null> {
    try {
      return await this.storage.getActiveSession();
    } catch (error) {
      console.error('[CoWatcher] Failed to get user session:', error);
      return null;
    }
  }

  /**
   * Create or update user session when co-watching is detected
   * Takes activity-specific co-watch info and creates a persistent session
   * Includes activity_id and host_friend_uuid for existing code flows (sync, messages, etc)
   */
  async createOrUpdateUserSession(activityCoWatch: ActivityCoWatchSession): Promise<CoWatchSession> {
    try {
      // Check if session already exists
      let session = await this.storage.getActiveSession();
      const userProfile = await this.storage.getUserProfile();
      const selfUuid = userProfile?.uuid || 'self';

      if (!session) {
        // Create new session with initial members (bootstrap from activity match)
        session = {
          session_id: this.generateSessionId(),
          members: activityCoWatch.co_watchers,
          created_at: Date.now(),
          is_active: true,
          activity_id: activityCoWatch.activity_id,
          host_friend_uuid: activityCoWatch.host_friend_uuid,
        };
        console.log('[CoWatcher] Created new user session:', { session_id: session.session_id, members: session.members.length, activity_id: session.activity_id });
      } else {
        // Update existing session: append any new co-watchers to persistent members
        // Only add people not already in the session
        const newCoWatchers = activityCoWatch.co_watchers.filter(uuid => !session!.members.includes(uuid));
        if (newCoWatchers.length > 0) {
          session.members.push(...newCoWatchers);
          console.log('[CoWatcher] Appended new members to session:', { session_id: session.session_id, new_members: newCoWatchers.length, total_members: session.members.length });
        }

        // Update activity context if there's a new matched activity
        if (activityCoWatch.co_watchers.length > 0) {
          session.activity_id = activityCoWatch.activity_id;
          
          // Sticky host logic: retain incumbent host if they are still actively co-watching this activity
          const incumbentHost = session.host_friend_uuid;
          const incumbentUuid = incumbentHost === 'self' ? selfUuid : incumbentHost;
          const incumbentStillWatching = incumbentUuid && activityCoWatch.co_watchers.includes(incumbentUuid);

          if (incumbentStillWatching && incumbentHost) {
            console.log('[CoWatcher] 🔒 Preserving sticky host:', incumbentHost);
          } else {
            const previousHost = session.host_friend_uuid;
            session.host_friend_uuid = activityCoWatch.host_friend_uuid;
            if (previousHost !== activityCoWatch.host_friend_uuid) {
              console.log('[CoWatcher] Host changed:', { from: previousHost, to: activityCoWatch.host_friend_uuid });
            }
          }
          console.log('[CoWatcher] Updated session activity context:', { session_id: session.session_id, activity_id: session.activity_id, host: session.host_friend_uuid });
        } else {
          // No current match, but keep session active for divergence tracking
          console.log('[CoWatcher] No activity match, keeping session active:', { session_id: session.session_id, current_activity: session.activity_id });
        }
        session.is_active = true;
      }

      console.log('[CoWatcher] DEBUG: Storing session.members:', session.members.map(cw => ({ id: cw, length: cw.length })));
      await this.storage.setActiveSession(session);

      // Verify what was stored
      const verified = await this.storage.getActiveSession();
      if (verified) {
        console.log('[CoWatcher] DEBUG: Retrieved stored session.members:', verified.members.map(cw => ({ id: cw, length: cw.length })));
      }

      return session;
    } catch (error) {
      console.error('[CoWatcher] Failed to create/update user session:', error);
      throw error;
    }
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    // Use random hex string (16 chars = 64 bits)
    const randomBytes = new Uint8Array(8);
    crypto.getRandomValues(randomBytes);
    return Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Get host friend details for current co-watch (activity-specific session)
   */
  async getHostFriendDetails(): Promise<{ id: string; local_name: string } | null> {
    try {
      const session = await this.getCurrentActivityCoWatchSession();
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
