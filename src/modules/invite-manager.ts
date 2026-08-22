/**
 * Hang Time - Invite & Pending Message Manager
 * Handles outgoing/incoming activity invites, pending message retries, and acceptance/decline lifecycles
 */

import { Activity, Friend, NostrEvent, ExtensionResponse } from '../types';
import { storageManager } from './storage';
import { getFriendManager } from './friends';
import { getMessagingManager } from './messaging';
import { getNotificationManager } from './notifications';
import { relayPool } from './nostr';

export class InviteManager {
  private static instance: InviteManager | null = null;

  static getInstance(): InviteManager {
    if (!InviteManager.instance) {
      InviteManager.instance = new InviteManager();
    }
    return InviteManager.instance;
  }

  /**
   * Track a pending invite for retry on failure
   */
  async trackPendingInvite(eventId: string, activity: Activity, friendUuid: string): Promise<void> {
    const activityId = activity.id;
    await storageManager.upsertPendingInvite(activityId, {
      eventId,
      activity,
      friendUuid,
      state: 'pending',
      sentAt: Date.now(),
      retryCount: 0,
    });
  }

  /**
   * Mark invite relay acceptance
   */
  async markInvitePublished(activityId: string): Promise<void> {
    const invites = await storageManager.getPendingInvites();
    const invite = invites[activityId];
    if (invite) {
      invite.state = 'relay_accepted';
      invite.relay_accepted_at = Date.now();
      await storageManager.upsertPendingInvite(activityId, invite);
    }
  }

  /**
   * Mark invite publish as failed and schedule retry
   */
  async markInvitePublishFailed(activityId: string, error: string): Promise<void> {
    const invites = await storageManager.getPendingInvites();
    const invite = invites[activityId];
    if (invite) {
      invite.retryCount++;
      invite.lastRetryAt = Date.now();
      invite.lastError = error;

      // After 3 retries, mark as failed permanently
      if (invite.retryCount >= 3) {
        invite.state = 'failed';
        console.warn(`[InviteManager] Invite failed permanently after 3 retries: ${activityId}`);
      } else {
        invite.state = 'pending';
      }

      await storageManager.upsertPendingInvite(activityId, invite);
    }
  }

  /**
   * Mark invite as completed (friend responded)
   */
  async markInviteCompleted(activityId: string): Promise<void> {
    const invites = await storageManager.getPendingInvites();
    const invite = invites[activityId];
    if (invite) {
      invite.friend_responded_at = Date.now();
      await storageManager.upsertPendingInvite(activityId, invite);
    }
  }

  /**
   * Retry publishing pending invites on startup
   */
  async retryPendingInvites(): Promise<void> {
    const messagingManager = getMessagingManager();
    if (!relayPool || !messagingManager) return;

    const invites = await storageManager.getPendingInvites();
    let retryCount = 0;

    for (const [activityId, invite] of Object.entries(invites)) {
      if (invite.state === 'pending') {
        try {
          console.debug(`[InviteManager] Retrying invite for activity ${activityId}`);

          const friend = await getFriendManager().getFriend(invite.friendUuid);
          if (friend) {
            const newEventId = await messagingManager.sendInvite(invite.activity, friend);
            console.log(`[InviteManager] Successfully retried invite, new eventId: ${newEventId.substring(0, 16)}...`);
            await this.markInvitePublished(activityId);
            retryCount++;
          } else {
            console.warn(`[InviteManager] Friend not found for retry: ${invite.friendUuid}`);
            await this.markInvitePublishFailed(activityId, 'Friend not found');
          }
        } catch (error) {
          await this.markInvitePublishFailed(activityId, error instanceof Error ? error.message : 'Unknown error');
        }
      }
    }

    if (retryCount > 0) {
      console.log(`[InviteManager] Retried ${retryCount} pending invites`);
    }
  }

  /**
   * Track a pending kind-1059 message
   */
  async trackPendingMessage(
    eventId: string,
    messageType: 'join_accepted' | 'join_declined' | 'friend_request' | 'chat',
    friendUuid: string,
    activityId: string,
    content?: string
  ): Promise<void> {
    const messageId = `${messageType}_${friendUuid}_${activityId}`;
    await storageManager.upsertPendingMessage(messageId, {
      eventId,
      messageType,
      friendUuid,
      activityId,
      content,
      state: 'pending',
      sentAt: Date.now(),
      retryCount: 0,
    });
  }

  /**
   * Mark message relay acceptance
   */
  async markMessagePublished(messageId: string): Promise<void> {
    const messages = await storageManager.getPendingMessages();
    const message = messages[messageId];
    if (message) {
      if (message.messageType === 'join_accepted' || message.messageType === 'join_declined') {
        await storageManager.removePendingMessage(messageId);
        console.log(`[InviteManager] Response message relayed and cleared: ${messageId}`);
      } else {
        message.state = 'relay_accepted';
        message.relay_accepted_at = Date.now();
        await storageManager.upsertPendingMessage(messageId, message);
      }
    }
  }

  /**
   * Mark message publish as failed and schedule retry
   */
  async markMessagePublishFailed(messageId: string, error: string): Promise<void> {
    const messages = await storageManager.getPendingMessages();
    const message = messages[messageId];
    if (message) {
      message.retryCount++;
      message.lastRetryAt = Date.now();
      message.lastError = error;

      if (message.retryCount >= 3) {
        message.state = 'failed';
        console.warn(`[InviteManager] Message failed permanently after 3 retries: ${messageId}`);
      } else {
        message.state = 'pending';
      }

      await storageManager.upsertPendingMessage(messageId, message);
    }
  }

  /**
   * Retry publishing pending messages on startup
   */
  async retryPendingMessages(): Promise<void> {
    const messagingManager = getMessagingManager();
    if (!relayPool || !messagingManager) return;

    const messages = await storageManager.getPendingMessages();
    let retryCount = 0;

    for (const [messageId, message] of Object.entries(messages)) {
      if (message.state === 'pending') {
        try {
          console.debug(`[InviteManager] Retrying message ${messageId}`);
          const friend = await getFriendManager().getFriend(message.friendUuid);
          if (friend) {
            if (message.messageType === 'chat' && message.content) {
              const newEventId = await messagingManager.sendChatMessage(
                message.activityId ? { id: message.activityId } as any : null,
                friend,
                message.content
              );
              console.log(`[InviteManager] Successfully retried chat, new eventId: ${newEventId.substring(0, 16)}...`);
              await this.markMessagePublished(messageId);
              retryCount++;
            }
          } else {
            console.warn(`[InviteManager] Friend not found for retry message: ${message.friendUuid}`);
            await this.markMessagePublishFailed(messageId, 'Friend not found');
          }
        } catch (error) {
          await this.markMessagePublishFailed(messageId, error instanceof Error ? error.message : 'Unknown error');
        }
      }
    }

    if (retryCount > 0) {
      console.log(`[InviteManager] Retried ${retryCount} pending messages`);
    }
  }

  /**
   * Send invite to a friend
   */
  async sendInvite(activity?: any, friendUuid?: string): Promise<ExtensionResponse> {
    if (!activity || !friendUuid) {
      return { success: false, error: 'Activity and friendUuid required' };
    }

    if (!activity.service) {
      console.error('[InviteManager] Cannot send invite: activity missing service', { activityId: activity.id, service: activity.service });
      return { success: false, error: 'Activity must have a service to invite' };
    }

    try {
      const friendManager = getFriendManager();
      const friend = await friendManager.getFriend(friendUuid);
      if (!friend) {
        return { success: false, error: `Friend not found: ${friendUuid}` };
      }

      const messagingManager = getMessagingManager();
      const eventId = await messagingManager.sendInvite(activity, friend);

      await this.trackPendingInvite(eventId, activity, friend.uuid);
      await this.markInvitePublished(activity.id);

      return { success: true };
    } catch (error) {
      console.error('[InviteManager] Error sending invite:', error);
      const activityId = activity?.id;
      if (activityId) {
        await this.markInvitePublishFailed(activityId, error instanceof Error ? error.message : 'Failed to send invite');
      }
      return { success: false, error: error instanceof Error ? error.message : 'Failed to send invite' };
    }
  }

  /**
   * Decline an invite
   */
  async declineInvite(activityId?: string, friendId?: string, activity?: any): Promise<ExtensionResponse> {
    if (!activityId) {
      return { success: false, error: 'activityId required' };
    }

    try {
      console.debug(`[InviteManager] Declining invite for activity ${activityId} from friend ${friendId || 'unknown'}`);
      await storageManager.removeReceivedInvite(activityId);
      await storageManager.markInviteDeclined(activityId);

      if (friendId) {
        try {
          const friendManager = getFriendManager();
          const friend = await friendManager.getFriend(friendId);
          if (friend) {
            const messagingManager = getMessagingManager();
            const activityToDecline: Activity = activity || {
              id: activityId,
              service: 'video-tab',
              content: 'Activity invitation',
              timestamp: Date.now(),
              freshness_timestamp: Date.now(),
              state: 'stopped',
              metadata: {},
            };
            await messagingManager.sendJoinDeclined(activityToDecline, friend);
            console.debug(`[InviteManager] Sent join_declined notification to friend ${friend.local_name}`);
          }
        } catch (err) {
          console.warn('[InviteManager] Failed to send join_declined over Nostr:', err);
        }
      }

      await storageManager.forceSyncNow();
      return { success: true };
    } catch (error) {
      console.error('[InviteManager] Failed to decline invite:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to decline invite' };
    }
  }

  /**
   * Send join accepted/declined response notification
   */
  async sendJoinNotification(activity?: any, friendId?: string, accepted?: boolean): Promise<ExtensionResponse> {
    if (!activity || !friendId) {
      return { success: false, error: 'Activity and friendId required' };
    }

    try {
      const friendManager = getFriendManager();
      const friend = await friendManager.getFriend(friendId);
      if (!friend) {
        return { success: false, error: `Friend not found: ${friendId}` };
      }

      const messagingManager = getMessagingManager();
      const messageType = accepted ? 'join_accepted' : 'join_declined';

      try {
        const eventId = accepted
          ? await messagingManager.sendJoinAccepted(activity, friend)
          : await messagingManager.sendJoinDeclined(activity, friend);

        const messageId = `${messageType}_${friend.uuid}_${activity.id}`;
        await this.trackPendingMessage(eventId, messageType as 'join_accepted' | 'join_declined', friend.uuid, activity.id);
        await this.markMessagePublished(messageId);
      } catch (error) {
        console.error('[InviteManager] Error sending join notification:', error);
        const messageId = `${messageType}_${friend.uuid}_${activity.id}`;
        await this.markMessagePublishFailed(messageId, error instanceof Error ? error.message : 'Failed to send notification');
        return { success: false, error: error instanceof Error ? error.message : 'Failed to send notification' };
      }

      return { success: true };
    } catch (error) {
      console.error('[InviteManager] Error in join notification handler:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to send notification' };
    }
  }

  /**
   * Handle activity invitation acceptance from friend
   */
  async handleActivityAccepted(friend: Friend, _event: NostrEvent, message: any): Promise<void> {
    try {
      if (!message.activity_id) {
        console.warn('[InviteManager] Activity acceptance missing activity_id');
        return;
      }

      const alreadyNotified = await storageManager.hasNotifiedActivityAcceptance(message.activity_id);
      if (!alreadyNotified) {
        await storageManager.recordActivityAcceptance({
          activityId: message.activity_id,
          firstAcceptorUuid: friend.uuid,
          acceptedAt: Date.now(),
          notifiedAt: Date.now(),
        });

        const notificationManager = getNotificationManager();
        await notificationManager.notify(
          'Friend Joined Activity',
          `${friend.local_name} is joining your activity!`
        );

        console.log(`[InviteManager] 🎉 ${friend.local_name} accepted your activity invitation`);
      } else {
        console.debug(`[InviteManager] Activity ${message.activity_id} acceptance already notified, skipping duplicate`);
      }
    } catch (error) {
      console.error('[InviteManager] Failed to handle activity acceptance:', error);
    }
  }

  /**
   * Handle activity invitation decline from friend
   */
  async handleActivityDeclined(friend: Friend, _event: NostrEvent, message: any): Promise<void> {
    try {
      if (!message.activity_id) {
        console.warn('[InviteManager] Activity decline missing activity_id');
        return;
      }

      console.log(`[InviteManager] 👋 ${friend.local_name} declined your activity invitation for ${message.activity_id.substring(0, 8)}...`);

      const declinedKey = `activity_declined_${message.activity_id}_${friend.uuid}`;
      await storageManager.set(declinedKey, {
        activityId: message.activity_id,
        friendId: friend.uuid,
        declinedAt: Date.now(),
      });

      try {
        await chrome.runtime.sendMessage({
          type: 'ACTIVITY_DECLINED',
          data: { activityId: message.activity_id, friendId: friend.uuid },
        }).catch(() => {});
      } catch (error) {
        console.debug('[InviteManager] Could not notify popup of activity decline:', error);
      }
    } catch (error) {
      console.error('[InviteManager] Failed to handle activity decline:', error);
    }
  }
}

export const inviteManager = InviteManager.getInstance();
