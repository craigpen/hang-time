/**
 * Hang Time - Friends Message Router
 * Handles friend list queries, mutations, requests, rename, mute, and direct messaging
 */

import { ExtensionResponse, Activity } from '../../types';
import { storageManager } from '../storage';
import { getFriendManager } from '../friends';
import { getMessagingManager } from '../messaging';
import { getIdentityManager } from '../identity';
import { nostrSubscriptionManager } from '../nostr-subscription-manager';
import { inviteManager } from '../invite-manager';

export class FriendsRouter {
  static async getActiveFriends(): Promise<ExtensionResponse> {
    try {
      const friendManager = getFriendManager();
      const activeFriends = await friendManager.getActiveFriends();
      return { success: true, data: activeFriends };
    } catch (error) {
      return { success: false, error: 'Failed to get active friends' };
    }
  }

  static async getAllFriends(): Promise<ExtensionResponse> {
    try {
      const friendManager = getFriendManager();
      const friends = await friendManager.getAllFriends();
      return { success: true, data: friends };
    } catch (error) {
      return { success: false, error: 'Failed to get friends' };
    }
  }

  static async getFriend(friendId?: string): Promise<ExtensionResponse> {
    if (!friendId) return { success: false, error: 'Friend ID required' };
    try {
      const friendManager = getFriendManager();
      const friend = await friendManager.getFriend(friendId);
      if (!friend) return { success: false, error: `Friend not found: ${friendId}` };
      return { success: true, data: friend };
    } catch (error) {
      return { success: false, error: 'Failed to get friend' };
    }
  }

  static async getFriendActivityHistory(friendId?: string): Promise<ExtensionResponse> {
    if (!friendId) return { success: false, error: 'Friend ID required' };
    try {
      const history = await storageManager.getActivityHistory(friendId);
      return { success: true, data: history };
    } catch (error) {
      return { success: false, error: 'Failed to get history' };
    }
  }

  static async addFriend(identifier?: string, localName?: string): Promise<ExtensionResponse> {
    if (!identifier) return { success: false, error: 'Friend identifier required' };
    try {
      const friendManager = getFriendManager();
      const friend = await friendManager.addFriend(identifier, localName || 'Friend');
      await nostrSubscriptionManager.subscribeToFriend(friend.uuid);

      try {
        const messagingManager = getMessagingManager();
        const userProfile = await storageManager.getUserProfile();
        const myDisplayName = userProfile?.nickname || (await getIdentityManager().getIdentifier()) || '';
        const eventId = await messagingManager.sendFriendRequestMessage(friend.pubkey, myDisplayName);
        await inviteManager.trackPendingMessage(eventId, 'friend_request', friend.uuid, 'friend_request', myDisplayName);
      } catch (msgError) {
        console.warn('[FriendsRouter] Failed to send friend request notification message:', msgError);
      }

      return { success: true, data: friend };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add friend' };
    }
  }

  static async removeFriend(friendId?: string): Promise<ExtensionResponse> {
    if (!friendId) return { success: false, error: 'Friend ID required' };
    try {
      const friendManager = getFriendManager();
      await friendManager.removeFriend(friendId);
      return { success: true };
    } catch (error) {
      return { success: false, error: 'Failed to remove friend' };
    }
  }

  static async renameFriend(friendId?: string, newName?: string): Promise<ExtensionResponse> {
    if (!friendId || !newName) return { success: false, error: 'Friend ID and new name required' };
    try {
      const friendManager = getFriendManager();
      await friendManager.renameFriend(friendId, newName);
      const updated = await friendManager.getFriend(friendId);
      return { success: true, data: updated };
    } catch (error) {
      return { success: false, error: 'Failed to rename friend' };
    }
  }

  static async acceptFriendRequest(friendId?: string): Promise<ExtensionResponse> {
    if (!friendId) return { success: false, error: 'Friend ID required' };
    try {
      const friendManager = getFriendManager();
      const friend = await friendManager.getFriend(friendId);
      if (!friend) return { success: false, error: 'Friend not found' };

      await friendManager.acceptFriendRequest(friendId);
      const updated = await friendManager.getFriend(friendId);
      await nostrSubscriptionManager.subscribeToFriend(friend.uuid);

      try {
        const messagingManager = getMessagingManager();
        const syntheticActivity: Activity = {
          id: `friend-request-${friend.uuid}`,
          service: 'spotify-api',
          content: 'Friend Request',
          timestamp: Date.now(),
          freshness_timestamp: Date.now(),
          state: 'stopped',
          metadata: {},
        };
        await messagingManager.sendJoinAccepted(syntheticActivity, friend);
      } catch (msgError) {
        console.warn('[FriendsRouter] Failed to send accept DM to friend:', msgError);
      }

      return { success: true, data: updated };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to accept friend request' };
    }
  }

  static async declineFriendRequest(friendId?: string): Promise<ExtensionResponse> {
    if (!friendId) return { success: false, error: 'Friend ID required' };
    try {
      const friendManager = getFriendManager();
      await friendManager.removeFriend(friendId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to decline friend request' };
    }
  }

  static async muteFriend(friendId?: string, mute?: boolean): Promise<ExtensionResponse> {
    if (!friendId || mute === undefined) return { success: false, error: 'friendId and mute required' };
    try {
      const friendManager = getFriendManager();
      if (mute) {
        await friendManager.muteFriend(friendId);
      } else {
        await friendManager.unmuteFriend(friendId);
      }
      const updated = await friendManager.getFriend(friendId);
      return { success: true, data: updated };
    } catch (error) {
      return { success: false, error: 'Failed to update mute state' };
    }
  }

  static async sendMessage(activity?: any, friendId?: string, content?: string): Promise<ExtensionResponse> {
    if (!friendId || !content) return { success: false, error: 'friendId and content required' };
    try {
      const friendManager = getFriendManager();
      const friend = await friendManager.getFriend(friendId);
      if (!friend) return { success: false, error: `Friend not found: ${friendId}` };

      const messagingManager = getMessagingManager();
      const eventId = await messagingManager.sendChatMessage(activity || null, friend, content);

      const messageActivityId = activity?.id || 'chat';
      await inviteManager.trackPendingMessage(eventId, 'chat', friend.uuid, messageActivityId, content);

      return { success: true, data: { eventId } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to send message' };
    }
  }
  static async getMessages(friendId?: string): Promise<ExtensionResponse> {
    try {
      const allMessages = await storageManager.getAllMessages();
      const profile = await storageManager.getUserProfile();
      const myUuid = profile?.uuid || '';

      if (!friendId) {
        return { success: true, data: allMessages };
      }

      const filtered = allMessages.filter(m =>
        (m.from === friendId && (!m.recipients || m.recipients.includes(myUuid))) ||
        (m.from === myUuid && m.recipients && m.recipients.includes(friendId))
      );

      return { success: true, data: filtered };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get messages' };
    }
  }
}
