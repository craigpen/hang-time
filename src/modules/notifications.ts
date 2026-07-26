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
      const settings = await this.storage.getSettings();
      if (!settings.notification_preferences?.friend_online) {
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
      console.log(`[Notifications] notifyNewMessage called for ${friendName}`);
      const settings = await this.storage.getSettings();
      console.log(`[Notifications] new_message setting:`, settings.notification_preferences?.new_message);
      if (!settings.notification_preferences?.new_message) {
        console.log(`[Notifications] new_message disabled, returning`);
        return;
      }

      console.log(`[Notifications] Creating notification with ID: new_message_${friendId}`);
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
      const settings = await this.storage.getSettings();
      if (!settings.notification_preferences?.join_suggestion) {
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
