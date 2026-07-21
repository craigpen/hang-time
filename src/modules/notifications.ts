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
  private lastNotificationTime = new Map<string, number>();
  private readonly NOTIFICATION_COOLDOWN_MS = 30000; // Don't notify same friend within 30s

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

      // Check cooldown
      const lastTime = this.lastNotificationTime.get(`online_${friendId}`) || 0;
      if (Date.now() - lastTime < this.NOTIFICATION_COOLDOWN_MS) {
        return;
      }

      chrome.notifications.create(`friend_online_${friendId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('public/icon-48.png'),
        title: `${friendName} is online`,
        message: `Now playing: ${activity}`,
        contextMessage: 'Click to join',
        requireInteraction: false,
      });

      this.lastNotificationTime.set(`online_${friendId}`, Date.now());
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
      const settings = await this.storage.getSettings();
      if (!settings.notification_preferences?.new_message) {
        return;
      }

      // Check cooldown
      const lastTime = this.lastNotificationTime.get(`message_${friendId}`) || 0;
      if (Date.now() - lastTime < this.NOTIFICATION_COOLDOWN_MS) {
        return;
      }

      chrome.notifications.create(`new_message_${friendId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('public/icon-48.png'),
        title: `Message from ${friendName}`,
        message: messagePreview.length > 50 ? messagePreview.substring(0, 50) + '...' : messagePreview,
        contextMessage: 'Click to reply',
        requireInteraction: false,
      });

      this.lastNotificationTime.set(`message_${friendId}`, Date.now());
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

      // Check cooldown
      const lastTime = this.lastNotificationTime.get(`join_${friendId}`) || 0;
      if (Date.now() - lastTime < this.NOTIFICATION_COOLDOWN_MS) {
        return;
      }

      chrome.notifications.create(`join_suggestion_${friendId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('public/icon-48.png'),
        title: `Join ${friendName}?`,
        message: `${friendName} is watching: ${activity}`,
        contextMessage: 'Click to join',
        requireInteraction: false,
        buttons: [{ title: 'Join Now' }, { title: 'Dismiss' }],
      });

      this.lastNotificationTime.set(`join_${friendId}`, Date.now());
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
        iconUrl: iconUrl || chrome.runtime.getURL('public/icon-48.png'),
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
   * Clear cooldown for a friend
   */
  clearCooldown(friendId: string, type: string = 'all'): void {
    if (type === 'all') {
      this.lastNotificationTime.delete(`online_${friendId}`);
      this.lastNotificationTime.delete(`message_${friendId}`);
      this.lastNotificationTime.delete(`join_${friendId}`);
    } else {
      this.lastNotificationTime.delete(`${type}_${friendId}`);
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
