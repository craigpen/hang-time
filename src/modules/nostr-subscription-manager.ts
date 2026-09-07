/**
 * Hang Time - Nostr Subscription Manager
 * Handles Nostr subscriptions, event verification, activity ingestion, and message routing
 */

import * as pako from 'pako';
import { nip04, nip44, verifyEvent } from 'nostr-tools';
import { NostrEvent, Friend, Activity, ServiceName } from '../types';
import { storageManager } from './storage';
import { getIdentityManager } from './identity';
import { getFriendManager } from './friends';
import { getMessagingManager } from './messaging';
import { getNotificationManager } from './notifications';
import { getSyncHandler } from './sync-handler';
import { GameLibraryManager } from './game-library';
import { ActivityDiagnostics } from './activity-diagnostics';
import { getActivityVerb } from './activity-utils';
import { hexToBytes } from './security-utils';
import { relayPool } from './nostr';
import { inviteManager } from './invite-manager';
import { overlayCoordinator } from './overlay-coordinator';
import { getCoWatcherDetector } from './co-watcher-detection';

export class NostrSubscriptionManager {
  private static instance: NostrSubscriptionManager | null = null;

  private activeSubscriptions = new Map<string, void>();
  private latestFriendActivityTimestamps = new Map<string, number>();

  static getInstance(): NostrSubscriptionManager {
    if (!NostrSubscriptionManager.instance) {
      NostrSubscriptionManager.instance = new NostrSubscriptionManager();
    }
    return NostrSubscriptionManager.instance;
  }

  /**
   * Initialize EventDeduplicator from storage
   */
  async initializeEventDeduplicator(): Promise<void> {
    const { getEventDeduplicator } = await import('./event-deduplicator');
    const stored = await storageManager.getProcessedEventIds();
    const dedup = getEventDeduplicator();

    console.debug(`[NostrSubscriptionManager] Restoring event dedup state: found ${stored.size} stored event IDs`);
    if (stored.size > 0) {
      dedup.restoreFromStorage(stored);
      console.log(`[NostrSubscriptionManager] ✅ Loaded ${stored.size} processed event IDs`);
    }
  }

  /**
   * Persist EventDeduplicator state to storage
   */
  async persistEventDeduplicatorState(): Promise<void> {
    const { getEventDeduplicator } = await import('./event-deduplicator');
    const dedup = getEventDeduplicator();
    const processed = dedup.getProcessedEventIds();

    if (processed.size > 0) {
      await storageManager.setProcessedEventIds(processed);
      console.debug(`[NostrSubscriptionManager] Persisted ${processed.size} processed event IDs to storage`);
    }
  }

  /**
   * Subscribe to incoming encrypted messages (kind 1059)
   */
  async subscribeToIncomingMessages(): Promise<void> {
    try {
      const userPubkey = await getIdentityManager().getPubkey();
      console.log(`[NostrSubscriptionManager] 🔑 Subscribing to incoming messages for ${userPubkey.substring(0, 8)}...`);

      relayPool.subscribeToDirectMessages(userPubkey, async (event: NostrEvent) => {
        console.log(`[NostrSubscriptionManager] 📬 Received kind-1059 event, processing...`);

        if (event.pubkey === userPubkey) {
          console.debug(`[NostrSubscriptionManager] ℹ️ Ignoring echo of our own message`);
          return;
        }

        if (event.kind !== 1059) {
          console.debug(`[NostrSubscriptionManager] Ignoring non-kind-1059 event (kind ${event.kind})`);
          return;
        }

        const pTag = event.tags.find((t) => t[0] === 'p')?.[1];
        if (!pTag) {
          console.warn(`[NostrSubscriptionManager] Kind-1059 event missing required p-tag: ${event.id.substring(0, 8)}`);
          return;
        }
        if (pTag !== userPubkey) {
          console.debug(`[NostrSubscriptionManager] Ignoring kind-1059 event not meant for us (p-tag: ${pTag.substring(0, 8)})`);
          return;
        }

        console.log(`[NostrSubscriptionManager] 📨 Received kind-1059 from relay`);

        try {
          const { getEventDeduplicator } = await import('./event-deduplicator');
          const dedup = getEventDeduplicator();
          const isFirstTime = await dedup.checkAndMark(event.id);

          if (!isFirstTime) {
            console.debug(`[NostrSubscriptionManager] Already processed event ${event.id.substring(0, 8)}..., ignoring duplicate`);
            return;
          }

          await this.persistEventDeduplicatorState();

          const messageType = event.tags.find((t) => t[0] === 'message_type')?.[1];
          const friends = await storageManager.getFriends();
          const sender = friends.find((f) => f.pubkey === event.pubkey);
          console.debug(`[NostrSubscriptionManager] DM sender lookup: event.pubkey=${event.pubkey.substring(0, 8)}..., found=${!!sender}, messageType=${messageType}`);

          if (sender) {
            await this.handleMessageEvent(sender.uuid, event);
          } else if (messageType === 'friend_request') {
            console.log(`[NostrSubscriptionManager] 🔔 Friend Request: Received from ${event.pubkey.substring(0, 8)}...`);
            await this.handleFriendRequestFromUnknownSender(event);
          } else {
            console.debug(`[NostrSubscriptionManager] Ignoring message from unknown sender (type=${messageType}): ${event.pubkey.substring(0, 8)}...`);
          }
        } catch (error) {
          console.error(`[NostrSubscriptionManager] Error handling incoming message:`, error);
        }
      });

      console.debug(`[NostrSubscriptionManager] Subscribed to incoming kind-1059 messages for user ${userPubkey.substring(0, 8)}...`);
    } catch (error) {
      console.error(`[NostrSubscriptionManager] Failed to subscribe to incoming messages:`, error);
    }
  }

  /**
   * Handle friend request from unknown sender
   */
  async handleFriendRequestFromUnknownSender(event: NostrEvent): Promise<void> {
    try {
      const friendManager = getFriendManager();
      const secretKey = await getIdentityManager().getSecretKey();
      if (!secretKey) {
        console.warn('[NostrSubscriptionManager] Secret key not found, cannot decrypt');
        return;
      }

      let decrypted: string;
      try {
        decrypted = await nip04.decrypt(secretKey, event.pubkey, event.content);
      } catch (_nip04Err) {
        try {
          const conversationKey = nip44.getConversationKey(hexToBytes(secretKey), event.pubkey);
          decrypted = await nip44.decrypt(event.content, conversationKey);
        } catch {
          console.warn('[NostrSubscriptionManager] Failed to decrypt friend request:', event.pubkey.substring(0, 8));
          return;
        }
      }

      const message = JSON.parse(decrypted);
      if (message.type === 'friend_request') {
        const senderDisplayName = message.sender_name || `User-${event.pubkey.substring(0, 8)}`;
        console.log(`[NostrSubscriptionManager] 📥 Received friend request from: ${senderDisplayName}`);

        const friend = await friendManager.addFriend(event.pubkey, senderDisplayName);
        console.log(`[NostrSubscriptionManager] ✅ Created pending friend: ${friend.uuid} (${friend.local_name})`);

        await this.subscribeToFriend(friend.uuid);

        const notificationManager = getNotificationManager();
        await notificationManager.notify(
          'Friend Request Received',
          `${senderDisplayName} wants to be friends!`
        );

        try {
          await chrome.runtime.sendMessage({
            type: 'FRIEND_REQUEST_RECEIVED',
            data: { friendId: friend.uuid, senderDisplayName },
          }).catch(() => {});
        } catch (error) {
          console.debug('[NostrSubscriptionManager] Could not notify popup of friend request:', error);
        }
      }
    } catch (error) {
      console.error('[NostrSubscriptionManager] Failed to handle friend request from unknown sender:', error);
    }
  }

  /**
   * Subscribe to events from a specific friend
   */
  async subscribeToFriend(friendId: string): Promise<void> {
    const friendManager = getFriendManager();
    const friend = await friendManager.getFriend(friendId);
    if (!friend) {
      console.warn('[NostrSubscriptionManager] Friend not found for subscription:', friendId);
      return;
    }

    const pubkey = friend.pubkey;
    const friendIdentifier = friend.local_name || pubkey.substring(0, 8);

    if (this.activeSubscriptions.has(pubkey)) {
      console.debug(`[NostrSubscriptionManager] Already subscribed to ${friendIdentifier}, skipping`);
      return;
    }

    console.log(`[NostrSubscriptionManager] Subscribing to friend events: ${friendIdentifier} (${pubkey.substring(0, 8)}...)`);
    this.activeSubscriptions.set(pubkey, undefined);

    relayPool.subscribe(pubkey, async (event: NostrEvent) => {
      console.debug(`[NostrSubscriptionManager] Event from ${friendIdentifier} (kind ${event.kind})`);

      try {
        const isValid = verifyEvent(event as any);
        if (!isValid) {
          console.warn(`[NostrSubscriptionManager] ❌ Event signature verification failed for ${friendIdentifier}`);
          return;
        }

        const currentFriend = await friendManager.getFriendByIdentifier(friendIdentifier);
        const isPending = currentFriend?.state === 'pending';

        if (event.kind === 0) {
          await this.handleProfileEvent(event);
        } else if (event.kind === 1059) {
          const { getEventDeduplicator } = await import('./event-deduplicator');
          const dedup = getEventDeduplicator();
          const isFirstTime = await dedup.checkAndMark(event.id);

          if (!isFirstTime) {
            return;
          }

          await this.handleMessageEvent(friendIdentifier, event);
        } else if (event.kind === 10004) {
          if (!isPending) {
            const gameLibraryManager = GameLibraryManager.getInstance(storageManager);
            await gameLibraryManager.handleGameLibraryEvent(event);
          }
        } else if (event.kind === 10003) {
          if (!isPending) {
            const isGameLibraryEvent = event.tags.find((t) => t[0] === 't' && t[1] === 'game-library');
            if (isGameLibraryEvent) {
              const gameLibraryManager = GameLibraryManager.getInstance(storageManager);
              await gameLibraryManager.handleGameLibraryEvent(event);
            } else {
              await this.handleActivityEvent(friendIdentifier, event);
            }
          }
        }
      } catch (error) {
        console.error(`[NostrSubscriptionManager] Error handling event for ${friendIdentifier}:`, error);
      }
    });
  }

  /**
   * Handle kind-0 profile events
   */
  async handleProfileEvent(event: NostrEvent): Promise<void> {
    try {
      const discordLink = event.tags.find((t) => t[0] === 'discord_link')?.[1];
      if (discordLink) {
        await storageManager.setFriendProfile(event.pubkey, { discord_link: discordLink });
        console.debug(`[NostrSubscriptionManager] Stored Discord link for friend ${event.pubkey.substring(0, 8)}...`);
      }
    } catch (error) {
      console.error('[NostrSubscriptionManager] Error handling profile event:', error);
    }
  }

  /**
   * Handle kind-10003 activity events
   */
  async handleActivityEvent(friendIdentifier: string, event: NostrEvent): Promise<void> {
    console.log(`[NostrSubscriptionManager] 🔨 Received event from friend ${friendIdentifier.substring(0, 8)}... kind=${event.kind}`);

    const friends = await storageManager.getFriends();
    const friend = friends.find((f) => f.uuid === friendIdentifier || f.local_name === friendIdentifier || f.pubkey === event.pubkey);

    if (!friend) {
      console.debug(`[NostrSubscriptionManager] Friend ${friendIdentifier} not found in local list, ignoring`);
      return;
    }

    const isNotificationTag = event.tags.find((t) => t[0] === 'is_notification')?.[1];
    const typeTag = event.tags.find((t) => t[0] === 'type')?.[1];

    if (isNotificationTag === 'true') {
      const { getEventDeduplicator } = await import('./event-deduplicator');
      const dedup = getEventDeduplicator();
      const isFirstTime = await dedup.checkAndMark(event.id);

      if (!isFirstTime) {
        return;
      }

      await this.persistEventDeduplicatorState();

      if (typeTag === 'friend_request') {
        const senderDisplayName = event.tags.find((t) => t[0] === 'sender_display_name')?.[1] || friend.local_name;
        if (friend.state === 'pending') {
          const notificationManager = getNotificationManager();
          await notificationManager.notifyFriendRequest(friend.uuid, senderDisplayName);
        }

        try {
          await chrome.runtime.sendMessage({
            type: 'FRIEND_REQUEST_RECEIVED',
            data: { friendId: friend.uuid, senderDisplayName },
          }).catch(() => {});
        } catch (error) {}
      } else if (typeTag === 'invite') {
        const service = event.tags.find((t) => t[0] === 'service')?.[1] || 'an activity';
        const activityName = event.tags.find((t) => t[0] === 'activity_name')?.[1] || service;
        const activityId = event.tags.find((t) => t[0] === 'activity_id')?.[1];
        const notificationManager = getNotificationManager();
        const verb = getActivityVerb(service);

        let discordInfo: { owner: string; link: string } | undefined;
        const initiatorDiscord = event.tags.find((t) => t[0] === 'discord_link')?.[1];
        if (initiatorDiscord) {
          discordInfo = { owner: friend.local_name, link: initiatorDiscord };
        } else {
          const userProfile = await storageManager.getUserProfile();
          if (userProfile?.discord_info) {
            discordInfo = { owner: 'your', link: userProfile.discord_info };
          }
        }

        console.log(`[NostrSubscriptionManager] 🔔 Invite: Firing notification for ${friend.local_name}`);
        await notificationManager.notifyInvite(friend.uuid, friend.local_name, activityName, verb, discordInfo);

        if (activityId) {
          await storageManager.upsertReceivedInvite(activityId, {
            friendId: friend.uuid,
            sentAt: Date.now(),
          });

          try {
            await chrome.runtime.sendMessage({
              type: 'INVITE_RECEIVED',
              data: { activityId, friendId: friend.uuid },
            }).catch(() => {});
          } catch (error) {}
        }
      }
      return;
    }

    if (event.kind === 10003) {
      const currentLatest = Math.max(friend.last_event_created_at || 0, this.latestFriendActivityTimestamps.get(friend.uuid) || 0);
      if (event.created_at < currentLatest) {
        console.log(`[NostrSubscriptionManager] ⏳ Discarding stale out-of-order kind-10003 event for ${friend.local_name}`);
        return;
      }
      this.latestFriendActivityTimestamps.set(friend.uuid, event.created_at);

      try {
        let content = event.content;
        const isCompressed = event.tags.find(t => t[0] === 'compression')?.[1] === 'gzip';

        if (isCompressed) {
          try {
            const binary = Buffer.from(content, 'base64');
            content = new TextDecoder().decode(pako.ungzip(binary));
          } catch (error) {
            console.error('[NostrSubscriptionManager] Gzip decompression failed:', error);
          }
        }

        const parsedData = JSON.parse(content);
        if (!Array.isArray(parsedData)) {
          if (parsedData && Array.isArray(parsedData.appIds)) {
            const gameLibraryManager = GameLibraryManager.getInstance(storageManager);
            await gameLibraryManager.handleGameLibraryEvent(event);
          }
          return;
        }

        const activities = parsedData as Activity[];
        const diagnostics = ActivityDiagnostics.getInstance(storageManager);

        for (const activity of activities) {
          await diagnostics.recordReception(
            activity.id,
            event.tags.find(t => t[0] === 'relay')?.[1] || 'unknown',
            event.id,
            event.tags,
            friend.uuid
          );
        }
        const wasActive = Object.keys(friend.current_activities || {}).length > 0;

        const changedServices = new Set<ServiceName>();
        for (const activity of activities) {
          const oldActivity = friend.current_activities?.[activity.service as ServiceName];
          if (!oldActivity ||
              oldActivity.content !== activity.content ||
              oldActivity.url !== activity.url ||
              oldActivity.state !== activity.state ||
              oldActivity.metadata?.progress !== activity.metadata?.progress) {
            changedServices.add(activity.service as ServiceName);
          }
        }

        if (friend.current_activities) {
          for (const service of Object.keys(friend.current_activities) as ServiceName[]) {
            if (!activities.find(a => a.service === service)) {
              changedServices.add(service);
            }
          }
        }

        const isBundled = event.tags.some(t => t[0] === 'type' && t[1] === 'bundled');
        const newCurrentActivities: Partial<Record<ServiceName, Activity>> = isBundled
          ? {}
          : { ...(friend.current_activities || {}) };

        const activitiesByService: Partial<Record<ServiceName, Activity>> = {};
        for (const activity of activities) {
          const existing = activitiesByService[activity.service as ServiceName];
          const shouldKeep = !existing || ((activity.timestamp || 0) > (existing.timestamp || 0));
          if (shouldKeep) {
            activitiesByService[activity.service as ServiceName] = activity;
          }
        }

        for (const [service, activity] of Object.entries(activitiesByService)) {
          const existingActivity = friend.current_activities?.[service as ServiceName];
          const merged = {
            ...existingActivity,
            ...activity,
            metadata: {
              ...existingActivity?.metadata,
              ...activity?.metadata,
            }
          };
          newCurrentActivities[service as ServiceName] = merged as Activity;
        }

        const isFriendDnd = event.tags.some(t => t[0] === 'dnd' && t[1] === 'true') || activities.some(a => a.dnd || a.metadata?.dnd);
        if (isFriendDnd) {
          // When friend has DND enabled, wipe active activities from memory and storage
          for (const service of Object.keys(newCurrentActivities)) {
            delete newCurrentActivities[service as ServiceName];
          }
        } else {
          for (const act of Object.values(newCurrentActivities)) {
            if (act) {
              act.dnd = false;
              if (act.metadata) {
                act.metadata.dnd = false;
              }
            }
          }
        }

        await storageManager.updateFriend(friend.uuid, {
          current_activities: isFriendDnd ? {} : newCurrentActivities,
          dnd: isFriendDnd,
          last_seen: Date.now(),
          last_event_created_at: event.created_at,
        });

        if (isFriendDnd) {
          const activeSession = await storageManager.getActiveSession();
          if (activeSession && activeSession.members.includes(friend.uuid)) {
            const remaining = activeSession.members.filter(id => id !== friend.uuid);
            const userProf = await storageManager.getUserProfile();
            const selfId = userProf?.uuid;
            if (remaining.length < 2 || (selfId && !remaining.includes(selfId))) {
              await storageManager.clearActiveSession();
              overlayCoordinator.broadcastToContentScripts({
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
              overlayCoordinator.broadcastToContentScripts({ type: 'SESSION_ENDED' });
            } else {
              activeSession.members = remaining;
              await storageManager.setActiveSession(activeSession);
              overlayCoordinator.broadcastToContentScripts({
                type: 'CO_WATCH_UPDATE',
                data: {
                  session_members: remaining,
                  watching_together: remaining,
                },
              });
            }
          }
        }

        for (const activity of activities) {
          await diagnostics.recordProcessing(
            activity.id,
            ['parse', 'validate', 'merge', 'store'],
            undefined,
            undefined,
            undefined
          );
        }

        await this.cleanupOrphanedInvites(friend.uuid, newCurrentActivities);

        for (const activity of activities) {
          if (changedServices.has(activity.service)) {
            await storageManager.addActivityToHistory(friend.uuid, activity);
          }
        }

        if (!wasActive && activities.length > 0 && !isFriendDnd && activities[0]) {
          try {
            const notificationManager = getNotificationManager();
            await notificationManager.notifyFriendOnline(friend.uuid, friend.local_name, activities[0].content);
          } catch (error) {}
        }

        try {
          await chrome.runtime.sendMessage({
            type: 'FRIEND_ACTIVITY_CHANGED',
            data: { friendId: friend.uuid, changedServices: Array.from(changedServices), dnd: isFriendDnd },
          });
        } catch (error) {}
      } catch (error) {
        console.error('[NostrSubscriptionManager] Failed to parse activity state:', error);
      }
    }
  }

  /**
   * Handle kind-1059 message events
   */
  async handleMessageEvent(friendIdentifier: string, event: NostrEvent): Promise<void> {
    try {
      const friends = await storageManager.getFriends();
      const friend = friends.find((f) => f.uuid === friendIdentifier || f.local_name === friendIdentifier || f.pubkey === event.pubkey);

      if (!friend) {
        console.warn('[NostrSubscriptionManager] Friend not found for message:', friendIdentifier);
        return;
      }

      const messagingManager = getMessagingManager();
      const timestamp = event.created_at * 1000;
      const message = await messagingManager.receiveMessage(friend, event.content, timestamp, event.id);

      if (message?.type === 'friend_request') {
        return;
      }

      if (message?.type === 'join_accepted') {
        if (message.service === 'friend-request') {
          await this.handleFriendRequestAccepted(friend, event, message);
        } else {
          await inviteManager.handleActivityAccepted(friend, event, message);
        }
        return;
      }

      if (message?.type === 'join_declined') {
        await inviteManager.handleActivityDeclined(friend, event, message);
        return;
      }

      if (message?.type === 'sync_request') {
        const syncHandler = getSyncHandler();
        await syncHandler.handleSyncRequest(friend.uuid, message.activity_id);
        return;
      }

      if (message?.type === 'sync_response') {
        const syncHandler = getSyncHandler();
        if (message.position !== undefined && message.sent_at !== undefined) {
          await syncHandler.handleSyncResponse(friend.uuid, message.activity_id, message.position, message.sent_at);
        }
        return;
      }

      if (message?.type === 'webrtc_signal' && message.signal) {
        overlayCoordinator.broadcastToContentScripts({
          type: 'CO_WATCH_WEBRTC_SIGNAL',
          data: {
            sender_uuid: friend.uuid,
            activity_id: message.activity_id,
            signal: message.signal,
          },
        });
        return;
      }

      if (message) {
        if (message.type === 'invite' && message.activity_id) {
          try {
            let activity = undefined;
            if (friend.current_activities) {
              for (const act of Object.values(friend.current_activities)) {
                if (act?.id === message.activity_id) {
                  activity = act;
                  break;
                }
              }
            }

            await storageManager.upsertReceivedInvite(message.activity_id, {
              friendId: friend.uuid,
              activity: activity || {
                id: message.activity_id,
                service: message.service || 'unknown',
                content: message.content || 'unknown activity',
                timestamp: Date.now(),
                freshness_timestamp: Date.now(),
                audio: 'off',
                metadata: {},
              },
              sentAt: Date.now(),
            });

            await storageManager.forceSyncNow();

            const notificationManager = getNotificationManager();
            const activityName = message.content || message.service || 'an activity';
            const verb = getActivityVerb(message.service || 'unknown');

            let discordInfo: { owner: string; link: string } | undefined;
            if (friend.discord_info) {
              discordInfo = { owner: friend.local_name, link: friend.discord_info };
            } else {
              const userProfile = await storageManager.getUserProfile();
              if (userProfile?.discord_info) {
                discordInfo = { owner: 'your', link: userProfile.discord_info };
              }
            }

            console.log(`[NostrSubscriptionManager] 🔔 Invite: Firing notification for ${friend.local_name}`);
            await notificationManager.notifyInvite(friend.uuid, friend.local_name, activityName, verb, discordInfo);

            try {
              await chrome.runtime.sendMessage({
                type: 'INVITE_RECEIVED',
                data: { activityId: message.activity_id, friendId: friend.uuid },
              }).catch(() => {});
            } catch (error) {}
          } catch (error) {
            console.error('[NostrSubscriptionManager] Failed to store pending invite:', error);
          }
        }

        try {
          await chrome.runtime.sendMessage({
            type: 'NEW_MESSAGE',
            data: { message, friendId: friend.uuid, activityId: message.activity_id },
          }).catch(() => {});
        } catch (error) {}

        try {
          const detector = getCoWatcherDetector();
          await overlayCoordinator.broadcastCoWatchUpdate(detector);
        } catch (error) {}
      }
    } catch (error) {
      console.error('[NostrSubscriptionManager] Failed to handle message event:', error);
    }
  }

  /**
   * Handle friend request acceptance
   */
  async handleFriendRequestAccepted(friend: Friend, _event: NostrEvent, _message: any): Promise<void> {
    try {
      const friendManager = getFriendManager();
      if (friend.state === 'pending') {
        await friendManager.acceptFriendRequest(friend.uuid);
      }

      const pendingMessages = await storageManager.getPendingMessages();
      for (const [messageId, msg] of Object.entries(pendingMessages)) {
        if (msg.messageType === 'friend_request' && msg.friendUuid === friend.uuid) {
          await storageManager.removePendingMessage(messageId);
          console.log(`[NostrSubscriptionManager] ✅ Cleared pending friend_request message: ${messageId}`);
          break;
        }
      }

      console.log(`[NostrSubscriptionManager] ✅ ${friend.local_name} accepted your friend request`);
      const notificationManager = getNotificationManager();
      await notificationManager.notify(
        `${friend.local_name} accepted your friend request`,
        'You are now friends!'
      );
    } catch (error) {
      console.error('[NostrSubscriptionManager] Failed to handle friend request acceptance:', error);
    }
  }

  /**
   * Clean up orphaned invites
   */
  async cleanupOrphanedInvites(
    friendId: string,
    currentActivities: Partial<Record<ServiceName, Activity>>
  ): Promise<void> {
    const pendingInvites = await storageManager.getPendingInvites();
    let removed = 0;

    for (const [activityId, inviteData] of Object.entries(pendingInvites)) {
      if (inviteData.friendUuid !== friendId) {
        continue;
      }

      const friendHasActivity = Object.values(currentActivities).some(a => a?.id === activityId);
      if (!friendHasActivity) {
        delete pendingInvites[activityId];
        removed++;
      }
    }

    if (removed > 0) {
      await storageManager.setPendingInvites(pendingInvites);
    }
  }
}

export const nostrSubscriptionManager = NostrSubscriptionManager.getInstance();
