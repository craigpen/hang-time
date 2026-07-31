/**
 * Hang Time - Notification Manager
 * Handles browser notifications for events (friend online, new message, etc.)
 */

import { StorageManager } from './storage';

export interface NotificationSettings {
  friend_online: boolean;
  new_message: boolean;
  join_suggestion: boolean;
}

export class NotificationManager {
  constructor(private storage: StorageManager) {}

  /**
   * Notify that friend came online
   */
  async notifyFriendOnline(friendId: string, friendName: string, activity: string): Promise<void> {
    try {
      const profile = await this.storage.getUserProfile();
      if (!profile?.notification_preferences?.friend_online) {
        return;
      }

      chrome.notifications.create(`friend_online_${friendId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('public/icons/icon48.png'),
        title: `${friendName} is online`,
        message: `Now playing: ${activity}`,
        contextMessage: 'Click to join',
        requireInteraction: true,
      });

      console.debug('[Notifications] Friend online notification sent for', friendName);
    } catch (error) {
      console.error('[Notifications] Failed to send friend online notification:', error);
    }
  }

  /**
   * Notify new message from friend
   */
  async notifyNewMessage(friendId: string, friendName: string, messagePreview: string): Promise<void> {
    try {
      console.debug(`[Notifications] notifyNewMessage called for ${friendName}`);
      const profile = await this.storage.getUserProfile();
      console.debug(`[Notifications] new_message setting:`, profile?.notification_preferences?.new_message);
      if (!profile?.notification_preferences?.new_message) {
        console.debug(`[Notifications] new_message disabled, returning`);
        return;
      }

      console.debug(`[Notifications] Creating notification with ID: new_message_${friendId}`);
      chrome.notifications.create(`new_message_${friendId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('public/icons/icon48.png'),
        title: `Message from ${friendName}`,
        message: messagePreview.length > 50 ? messagePreview.substring(0, 50) + '...' : messagePreview,
        contextMessage: 'Click to reply',
        requireInteraction: false,
      });

      console.debug('[Notifications] New message notification sent for', friendName);
    } catch (error) {
      console.error('[Notifications] Failed to send message notification:', error);
    }
  }

  /**
   * Suggest joining friend's activity
   */
  async suggestJoin(friendId: string, friendName: string, activity: string): Promise<void> {
    try {
      const profile = await this.storage.getUserProfile();
      if (!profile?.notification_preferences?.join_suggestion) {
        return;
      }

      chrome.notifications.create(`join_suggestion_${friendId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('public/icons/icon48.png'),
        title: `Join ${friendName}?`,
        message: `${friendName} is watching: ${activity}`,
        contextMessage: 'Click to join',
        requireInteraction: false,
        buttons: [{ title: 'Join Now' }, { title: 'Dismiss' }],
      });

      console.debug('[Notifications] Join suggestion sent for', friendName);
    } catch (error) {
      console.error('[Notifications] Failed to send join suggestion:', error);
    }
  }

  /**
   * Notify about a friend request
   */
  async notifyFriendRequest(friendId: string, senderDisplayName: string): Promise<void> {
    try {
      const profile = await this.storage.getUserProfile();
      console.debug('[Notifications] Checking friend request notification preference:', profile?.notification_preferences?.join_suggestion);
      if (!profile?.notification_preferences?.join_suggestion) {
        console.debug('[Notifications] Friend request notifications disabled');
        return;
      }

      const notificationId = `friend_request_${friendId}_${Date.now()}`;
      console.debug('[Notifications] Creating friend request notification:', notificationId);
      chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('public/icons/icon48.png'),
        title: `${senderDisplayName} sent you a friend request`,
        message: 'Open the extension to accept or decline',
        requireInteraction: true,
      }, (id) => {
        console.debug('[Notifications] Friend request notification created with id:', id);
      });

      console.debug('[Notifications] Friend request notification sent for', senderDisplayName);
    } catch (error) {
      console.error('[Notifications] Failed to send friend request notification:', error);
    }
  }

  /**
   * Notify about an invite with activity-specific verb and Discord coordination info
   * Verb: 'play' for games, 'watch' for video/streams, 'listen' for audio
   */
  async notifyInvite(
    friendId: string,
    friendName: string,
    activityName: string,
    verb: 'play' | 'watch' | 'listen',
    discordInfo?: { owner: string; link: string }
  ): Promise<void> {
    try {
      const profile = await this.storage.getUserProfile();
      if (!profile?.notification_preferences?.join_suggestion) {
        return;
      }

      const subject = `${friendName} invited you to ${verb} ${activityName}`;
      let bodyMessage = '';
      const buttons: Array<{ title: string }> = [];

      if (discordInfo) {
        const ownerText = discordInfo.owner === 'your' ? 'your' : `${discordInfo.owner}'s`;
        bodyMessage = `Coordinate on ${ownerText} Discord`;
        buttons.push({ title: 'Open Discord' });
      } else {
        bodyMessage = 'Configure Discord in settings for voice/chat coordination';
      }

      const notificationId = `invite_${friendId}_${Date.now()}`;
      chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('public/icons/icon48.png'),
        title: subject,
        message: bodyMessage,
        contextMessage: 'Click to join via Hang Time',
        buttons,
        requireInteraction: true,
      });

      // Setup button click handler if Discord link exists
      if (discordInfo) {
        chrome.notifications.onButtonClicked.addListener((clickedNotificationId, buttonIndex) => {
          if (clickedNotificationId === notificationId && buttonIndex === 0) {
            // Open Discord link
            chrome.tabs.create({ url: discordInfo.link, active: true });
            chrome.notifications.clear(notificationId);
          }
        });
      }

      console.debug('[Notifications] Invite notification sent for', friendName);
    } catch (error) {
      console.error('[Notifications] Failed to send invite notification:', error);
    }
  }

  /**
   * Generic notification
   */
  async notify(title: string, message: string, iconUrl?: string): Promise<void> {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: iconUrl || chrome.runtime.getURL('public/icons/icon48.png'),
        title,
        message,
        requireInteraction: false,
      });

      console.debug('[Notifications] Sent notification:', title);
    } catch (error) {
      console.error('[Notifications] Failed to send notification:', error);
    }
  }

  /**
   * Persistent notification (requires user interaction to dismiss)
   */
  async notifyPersistent(title: string, message: string, iconUrl?: string): Promise<void> {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: iconUrl || chrome.runtime.getURL('public/icons/icon48.png'),
        title,
        message,
        requireInteraction: true,
      });

      console.debug('[Notifications] Sent persistent notification:', title);
    } catch (error) {
      console.error('[Notifications] Failed to send persistent notification:', error);
    }
  }

}

// Singleton instance
let notificationManager: NotificationManager | null = null;

export function initializeNotificationManager(storage: StorageManager): void {
  notificationManager = new NotificationManager(storage);
}

export function getNotificationManager(): NotificationManager {
  if (!notificationManager) {
    throw new Error('NotificationManager not initialized');
  }
  return notificationManager;
}
