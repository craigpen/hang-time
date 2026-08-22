/**
 * Hang Time - Overlay Coordinator
 * Manages in-page content script ports, co-watch broadcasts, and overlay state synchronization
 */

import { Activity, ExtensionResponse } from '../types';
import { storageManager } from './storage';
import { getFriendManager } from './friends';
import { getFileLogger } from './file-logger';
import { generateActivityId } from './activity-utils';
import { CO_WATCHABLE_SERVICES } from './co-watcher-detection';

export class OverlayCoordinator {
  private static instance: OverlayCoordinator | null = null;

  private activeContentScriptPorts = new Map<number, chrome.runtime.Port>();
  private freshConnectionTimestamps = new Map<number, number>();
  private connectedTabIds = new Set<number>();
  private failedInjectionAttempts = new Map<number, number>();

  static getInstance(): OverlayCoordinator {
    if (!OverlayCoordinator.instance) {
      OverlayCoordinator.instance = new OverlayCoordinator();
    }
    return OverlayCoordinator.instance;
  }

  getActivePorts(): Map<number, chrome.runtime.Port> {
    return this.activeContentScriptPorts;
  }

  getConnectedTabIds(): Set<number> {
    return this.connectedTabIds;
  }

  getFailedInjectionAttempts(): Map<number, number> {
    return this.failedInjectionAttempts;
  }

  /**
   * Check if content script reconnected after startup
   * If an activity exists but no fresh script has connected within 3 seconds, mark as disconnected
   */
  async checkForOrphanedActivity(): Promise<void> {
    const now = Date.now();
    const staleCutoff = now - 3000;

    for (const [tabId, timestamp] of this.freshConnectionTimestamps.entries()) {
      if (timestamp < staleCutoff) {
        this.freshConnectionTimestamps.delete(tabId);
      }
    }

    if (this.freshConnectionTimestamps.size === 0) {
      try {
        const myActivities = await storageManager.getMyActivities();
        const videoActivity = Object.values(myActivities).find(
          (activity: any) => activity?.service === 'video-tab'
        ) as any;

        if (videoActivity && videoActivity.state !== 'disconnected') {
          await this.markActivityAsDisconnected(0);
        }
      } catch (err) {
        console.error('[OverlayCoordinator] Error checking orphaned activity:', err);
      }
    }
  }

  /**
   * Mark a tab's content script activity as disconnected
   */
  async markActivityAsDisconnected(_tabId: number): Promise<void> {
    try {
      const myActivities = await storageManager.getMyActivities();
      console.log(`[OverlayCoordinator] Got ${Object.keys(myActivities).length} activities to check`);

      for (const [activityId, activity] of Object.entries(myActivities)) {
        if ((activity as any)?.service === 'video-tab') {
          console.log(`[OverlayCoordinator] Found video-tab activity with ID: ${activityId}, current state: ${(activity as any)?.state}`);

          const disconnectedActivity: Activity = {
            ...activity!,
            id: activity?.id || activityId,
            state: 'disconnected',
            metadata: {
              ...(activity as any)?.metadata,
              disconnected_reason: 'Disconnected - reload tab',
            },
          };

          await storageManager.updateMyActivity(activityId, disconnectedActivity);
          console.log(`[OverlayCoordinator] ✅ Marked video-tab activity as disconnected, new state: ${disconnectedActivity.state}`);
          return;
        }
      }
      console.log(`[OverlayCoordinator] No video-tab activity found to mark as disconnected`);
    } catch (err) {
      console.error(`[OverlayCoordinator] Failed to mark activity as disconnected:`, err);
    }
  }

  /**
   * Handle content script activity payload
   */
  async handleContentScriptActivity(key: string, value: any, tabId?: number, onActivityUpdate?: () => Promise<void>): Promise<ExtensionResponse> {
    try {
      if (key.startsWith('content_script_activity_') && value) {
        const requiredFields = ['id', 'service', 'content', 'state', 'timestamp'];
        const missingFields = requiredFields.filter(field => !(field in value));
        if (missingFields.length > 0) {
          getFileLogger().log('Background', 'WARN', 'Activity missing fields', { missingFields });
          console.warn(`[OverlayCoordinator] ⚠️  Activity missing fields: ${missingFields.join(', ')}`, value);
        }
      }

      const allActivities = await storageManager.getMyActivities();
      const tabServices = ['video-tab', 'youtube-tab', 'netflix-tab', 'twitch-tab'];

      for (const [activityId, activity] of Object.entries(allActivities)) {
        if (!activity) continue;

        if (activity.service === value.service && tabServices.includes(activity.service)) {
          if (activity.id !== value.id) {
            const isOlder = (activity.timestamp || 0) < (value.timestamp || 0);
            if (isOlder || tabId !== undefined) {
              console.debug(`[OverlayCoordinator] 🗑️  Removing old ${value.service} activity (id: ${activity.id}, timestamp: ${activity.timestamp})`);
              delete allActivities[activityId];
            }
          }
        }
      }

      await storageManager.setMyActivities(allActivities);

      const activityId = value.id || generateActivityId(value.service, value.url || '');
      if (tabId !== undefined) {
        value.metadata = value.metadata || {};
        value.metadata.tabId = tabId;
      }

      console.debug(`[TimestampMigration] STORE activity ${activityId}: contentTimestamp=${value.contentTimestamp}, timestamp=${value.timestamp}, state=${value.state}, tabId=${tabId}`);
      await storageManager.updateMyActivity(activityId, value);

      if (key.startsWith('content_script_activity_') && onActivityUpdate) {
        await onActivityUpdate();
      }

      return { success: true };
    } catch (error) {
      console.error('[OverlayCoordinator] Failed to handle content script activity:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Broadcast message to all connected content scripts
   */
  broadcastToContentScripts(message: any): void {
    for (const [tabId, port] of this.activeContentScriptPorts.entries()) {
      try {
        port.postMessage(message);
      } catch (e) {
        console.debug(`[OverlayCoordinator] Failed to send to content script on tab ${tabId}:`, e);
      }
    }
  }

  /**
   * Broadcast co-watch updates to content scripts
   */
  async broadcastCoWatchUpdate(detector: any, callCount = 0): Promise<void> {
    try {
      const activitySession = await detector.detectCoWatchSession();
      let persistentSession = await detector.getCurrentCoWatchSession();

      if (persistentSession) {
        const friendManager = getFriendManager();
        const profile = await storageManager.getUserProfile();
        const selfUuid = profile?.uuid;

        const validMembers: string[] = [];
        for (const memberId of persistentSession.members) {
          if (memberId === selfUuid) {
            if (!profile?.dnd_enabled) {
              validMembers.push(memberId);
            }
          } else {
            const friend = await friendManager.getFriend(memberId);
            if (friend && !friend.dnd) {
              validMembers.push(memberId);
            }
          }
        }

        const hasSelf = validMembers.includes(selfUuid || '');
        const hasFriend = validMembers.some(id => id !== selfUuid);

        if (validMembers.length < 2 || !hasSelf || !hasFriend) {
          await storageManager.clearActiveSession();
          console.log('[OverlayCoordinator] Session purged: only', validMembers.length, 'valid active non-DND member(s)');
          persistentSession = null;
        } else if (validMembers.length !== persistentSession.members.length) {
          persistentSession.members = validMembers;
          await storageManager.setActiveSession(persistentSession);
          console.log('[OverlayCoordinator] Session members updated:', validMembers);
        }
      }

      if (!activitySession && !persistentSession && callCount > 1) {
        console.log('[OverlayCoordinator] Broadcasting session cleared to close overlays');
        for (const tabId of this.activeContentScriptPorts.keys()) {
          try {
            const port = this.activeContentScriptPorts.get(tabId);
            if (port) {
              port.postMessage({
                type: 'CO_WATCH_UPDATE',
                data: {
                  session_members: [],
                  watching_together: [],
                  messages: [],
                  host_nickname: undefined,
                  is_user_host: false,
                  user_nickname: '',
                  co_watcher_activities: {},
                },
              });
              port.postMessage({ type: 'SESSION_ENDED' });
            }
          } catch (e) {
            console.debug(`[OverlayCoordinator] Failed to send session-cleared update to tab ${tabId}:`, e);
          }
        }
        return;
      }

      if (activitySession || persistentSession) {
        if (activitySession) {
          await detector.setCurrentCoWatchSession(activitySession);
          await detector.createOrUpdateUserSession(activitySession);
          persistentSession = await detector.getCurrentCoWatchSession();
        }

        const coWatchSession = persistentSession;
        if (!coWatchSession) {
          console.warn('[OverlayCoordinator] Session became null after update, skipping broadcast');
          return;
        }

        let hostName = '?';
        let hostFriend: any = null;

        if (coWatchSession.host_friend_uuid === 'self') {
          const profile = await storageManager.getUserProfile();
          hostName = profile?.nickname || profile?.uuid || 'You';
        } else if (coWatchSession.host_friend_uuid) {
          hostFriend = await getFriendManager().getFriend(coWatchSession.host_friend_uuid);
          hostName = hostFriend?.local_name || '?';
        }

        let videoTitle = 'Loading video...';
        let hostPosition: number | undefined;
        let hostPositionTimestamp: number | undefined;
        let hostState: string | undefined;
        let videoDuration: number | undefined;

        let userPosition: number | undefined;
        let userActivity: any = undefined;
        const myActivities = await storageManager.getMyActivities();

        if (coWatchSession.host_friend_uuid === 'self') {
          const hostActivity = coWatchSession.activity_id ? myActivities?.[coWatchSession.activity_id] : undefined;

          if (hostActivity?.state === 'disconnected') {
            console.debug(`[OverlayCoordinator] Skipping disconnected activity: ${coWatchSession.activity_id}`);
            return;
          }

          if (hostActivity?.content) {
            videoTitle = hostActivity.content;
            videoDuration = hostActivity.metadata?.duration;
            hostState = hostActivity.state;
            if (hostActivity?.metadata?.progress !== undefined) {
              hostPosition = hostActivity.metadata.progress;
              hostPositionTimestamp = hostActivity.metadata.progress_measured_at || Date.now();
            }
            userPosition = hostActivity.metadata?.progress;
            userActivity = hostActivity;
          }
        } else if (hostFriend?.current_activities) {
          const hostActivity = Object.values(hostFriend.current_activities).find(a => (a as Activity)?.id === coWatchSession.activity_id) as Activity | undefined;
          if (hostActivity && hostActivity.content) {
            videoTitle = hostActivity.content;
            videoDuration = hostActivity.metadata?.duration;
            hostState = hostActivity.state;
            if (hostActivity?.metadata?.progress !== undefined) {
              hostPosition = hostActivity.metadata.progress;
              hostPositionTimestamp = hostActivity.metadata.progress_measured_at || Date.now();
            }
          }
          userActivity = coWatchSession.activity_id ? myActivities?.[coWatchSession.activity_id] : undefined;
          if (userActivity?.metadata?.progress !== undefined) {
            userPosition = userActivity.metadata.progress;
          }
        }

        const watchingTogether: string[] = [];
        const friendManager = getFriendManager();
        const profile = await storageManager.getUserProfile();
        const selfUuid = profile?.uuid;
        const guestProgress: Record<string, number> = {};

        for (const coWatcherId of coWatchSession.members) {
          let isOnCurrentActivity = false;

          if (coWatcherId === selfUuid) {
            isOnCurrentActivity = !!userActivity;
          } else {
            const friend = await friendManager.getFriend(coWatcherId);
            if (friend?.current_activities) {
              const friendActivity = Object.values(friend.current_activities).find(a => a?.id === coWatchSession.activity_id);
              isOnCurrentActivity = !!friendActivity;
            }
          }

          if (isOnCurrentActivity) {
            watchingTogether.push(coWatcherId);
            if (coWatcherId === selfUuid) {
              if (userActivity?.metadata?.progress !== undefined) {
                guestProgress[coWatcherId] = userActivity.metadata.progress;
              }
            } else {
              const friend = await friendManager.getFriend(coWatcherId);
              if (friend?.current_activities) {
                const guestActivity = Object.values(friend.current_activities).find(a => a?.id === coWatchSession.activity_id);
                if (guestActivity?.metadata?.progress !== undefined) {
                  guestProgress[coWatcherId] = guestActivity.metadata.progress;
                }
              }
            }
          }
        }

        const recentMessages: Array<{
          id: string;
          sender: string;
          sender_id: string;
          content: string;
          timestamp: number;
        }> = [];

        try {
          const userUuid = profile?.uuid;
          const sessionMessages = userUuid ? await storageManager.getVisibleMessages(userUuid, coWatchSession.members) : [];
          if (sessionMessages && sessionMessages.length > 0) {
            const friendMap = new Map<string, string>();
            if (profile) {
              friendMap.set(profile.uuid, profile.nickname || 'You');
            }

            for (const coWatcherId of coWatchSession.members) {
              if (coWatcherId === profile?.uuid) continue;
              const friend = await friendManager.getFriend(coWatcherId);
              if (friend) {
                friendMap.set(friend.uuid, friend.local_name);
              }
            }

            const recentSessionMessages = sessionMessages.slice(-20);
            for (const msg of recentSessionMessages) {
              if (msg.type && msg.type !== 'chat') continue;

              const senderName = (msg.from ? friendMap.get(msg.from) : undefined) || msg.from || 'Unknown';
              recentMessages.push({
                id: msg.id,
                sender: senderName,
                sender_id: msg.from || '',
                content: msg.content || '',
                timestamp: msg.timestamp,
              });
            }
          }

          recentMessages.sort((a, b) => a.timestamp - b.timestamp);
          const deduped: typeof recentMessages = [];
          for (const msg of recentMessages) {
            const isDupe = deduped.some((existing) => {
              if (existing.id && msg.id && existing.id === msg.id) return true;
              if (existing.sender_id === msg.sender_id && existing.content === msg.content) {
                return Math.abs(existing.timestamp - msg.timestamp) < 10000;
              }
              return false;
            });
            if (!isDupe) {
              deduped.push(msg);
            }
          }
          recentMessages.length = 0;
          recentMessages.push(...deduped);
        } catch (e) {
          console.debug('[OverlayCoordinator] Failed to get messages for overlay:', e);
        }

        console.debug(`[OverlayCoordinator] Broadcasting CO_WATCH_UPDATE to ${this.activeContentScriptPorts.size} content scripts`);
        for (const [tabId, port] of this.activeContentScriptPorts.entries()) {
          try {
            const broadcastNicknameMap: Record<string, string> = {};
            if (profile) {
              broadcastNicknameMap[profile.uuid] = profile.nickname || 'You';
            }

            for (const coWatcherId of coWatchSession.members) {
              if (coWatcherId === profile?.uuid) continue;
              const coWatcherFriend = await friendManager.getFriend(coWatcherId);
              if (coWatcherFriend) {
                broadcastNicknameMap[coWatcherId] = coWatcherFriend.local_name;
              }
            }

            for (const msg of recentMessages) {
              if (msg.sender_id && !broadcastNicknameMap[msg.sender_id]) {
                const messageSenderFriend = await friendManager.getFriend(msg.sender_id);
                if (messageSenderFriend) {
                  broadcastNicknameMap[msg.sender_id] = messageSenderFriend.local_name;
                }
              }
            }

            let hostActivityFreshness: number | undefined;
            if (coWatchSession.host_friend_uuid !== 'self' && hostFriend?.current_activities) {
              const hostActivity = Object.values(hostFriend.current_activities).find(a => (a as Activity)?.id === coWatchSession.activity_id);
              hostActivityFreshness = (hostActivity as Activity)?.freshness_timestamp;
            }

            const coWatcherActivities: Record<string, {activity_id: string; content: string; url?: string; service?: string; freshness_timestamp?: number; timestamp?: number; metadata?: any}> = {};

            if (selfUuid) {
              const userCurrentActivity = Object.values(myActivities || {}).find(a => a && a.id === coWatchSession.activity_id) ||
                                          Object.values(myActivities || {}).find(a => a && CO_WATCHABLE_SERVICES.has(a.service));
              if (userCurrentActivity) {
                coWatcherActivities[selfUuid] = {
                  activity_id: userCurrentActivity.id || '',
                  content: userCurrentActivity.content || videoTitle || '',
                  url: userCurrentActivity.url,
                  service: userCurrentActivity.service || '',
                  freshness_timestamp: userCurrentActivity.freshness_timestamp || Date.now(),
                  timestamp: userCurrentActivity.timestamp,
                  metadata: userCurrentActivity.metadata,
                };
              }
            }

            for (const coWatcherId of coWatchSession.members) {
              if (coWatcherId === selfUuid) continue;
              const friend = await friendManager.getFriend(coWatcherId);
              if (friend?.current_activities) {
                const friendActivity = Object.values(friend.current_activities).find(a => a && (a as Activity).id === coWatchSession.activity_id) ||
                                       Object.values(friend.current_activities).find(a => a && CO_WATCHABLE_SERVICES.has((a as Activity).service));
                if (friendActivity) {
                  coWatcherActivities[coWatcherId] = {
                    activity_id: (friendActivity as Activity).id || '',
                    content: (friendActivity as Activity).content || '',
                    url: (friendActivity as Activity).url,
                    service: (friendActivity as Activity).service || '',
                    freshness_timestamp: (friendActivity as Activity).freshness_timestamp || Date.now(),
                    timestamp: (friendActivity as Activity).timestamp,
                    metadata: (friendActivity as Activity).metadata,
                  };
                }
              }
            }

            port.postMessage({
              type: 'CO_WATCH_UPDATE',
              data: {
                activity_id: coWatchSession.activity_id,
                host_friend_uuid: coWatchSession.host_friend_uuid,
                host_nickname: hostName,
                host_title: videoTitle,
                host_progress: hostPosition,
                host_progress_timestamp: hostPositionTimestamp,
                host_duration: videoDuration,
                host_state: hostState,
                user_progress: userPosition,
                guest_progress: guestProgress,
                watching_together: watchingTogether,
                session_members: coWatchSession.members,
                is_user_host: coWatchSession.host_friend_uuid === 'self',
                user_nickname: profile?.nickname || profile?.uuid || 'You',
                user_uuid: profile?.uuid,
                host_activity_freshness: hostActivityFreshness,
                nickname_map: broadcastNicknameMap,
                messages: recentMessages,
                co_watcher_activities: coWatcherActivities,
              },
            });
          } catch (e) {
            console.debug(`[OverlayCoordinator] Failed to broadcast CO_WATCH_UPDATE to tab ${tabId}:`, e);
          }
        }
      }
    } catch (e) {
      console.error('[OverlayCoordinator] Failed to broadcast co-watch update:', e);
    }
  }

  /**
   * Retry injection with backoff
   */
  async retryInjectionWithBackoff(tabId: number, maxAttempts = 3): Promise<boolean> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[OverlayCoordinator] Injection attempt ${attempt}/${maxAttempts} for tab ${tabId}...`);
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content-script.js'],
        });

        console.log(`[OverlayCoordinator] ✅ Injection succeeded for tab ${tabId} on attempt ${attempt}`);
        this.connectedTabIds.add(tabId);
        this.failedInjectionAttempts.delete(tabId);
        return true;
      } catch (err) {
        lastError = err as Error;
        console.warn(`[OverlayCoordinator] Injection attempt ${attempt}/${maxAttempts} failed for tab ${tabId}: ${lastError.message}`);

        if (attempt < maxAttempts) {
          const backoffMs = Math.pow(2, attempt - 1) * 100;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    return false;
  }
}

export const overlayCoordinator = OverlayCoordinator.getInstance();
