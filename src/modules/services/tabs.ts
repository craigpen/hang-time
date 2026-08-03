/**
 * Hang Time - Tab Detection Service
 * Reads tab activities from generic video tracker
 * Works with YouTube, Netflix, Twitch, and any video platform
 */

import { Activity, IServiceModule } from '../../types';
import { StorageManager } from '../storage';
import { getFileLogger } from '../file-logger';

export class TabService implements IServiceModule {
  private detectedActivity: Activity | null = null;

  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    // Check if any video-based tab detection is enabled
    return profile.services_enabled['video-tab'] ?? true; // Enabled by default
  }

  /**
   * Read activity from generic video tracker via MY_ACTIVITIES
   */
  async getCurrentActivity(): Promise<Activity | null> {
    try {
      // Read from MY_ACTIVITIES (single source of truth)
      const myActivities = await this.storage.getMyActivities();
      try {
        const logger = getFileLogger();
        logger.log('TabService', 'DEBUG', 'Read MY_ACTIVITIES', { keys: Object.keys(myActivities) });
      } catch {}

      // Search for video tab activity by service type (not by hardcoded key)
      const videoServices = ['video-tab', 'youtube-tab', 'netflix-tab', 'twitch-tab'];
      for (const [activityId, activity] of Object.entries(myActivities)) {
        if (activity && videoServices.includes(activity.service)) {
          try {
            const logger = getFileLogger();
            logger.log('TabService', 'INFO', `Found ${activity.service} activity`, {
              id: activityId,
              content: activity.content?.substring(0, 50)
            });
          } catch {}
          this.detectedActivity = activity;
          return activity;
        }
      }

      try {
        const logger = getFileLogger();
        logger.log('TabService', 'DEBUG', 'No video-tab activity found in storage');
      } catch {}
      return null;
    } catch (error) {
      try {
        const logger = getFileLogger();
        logger.log('TabService', 'ERROR', 'Failed to read activities from storage', { error: String(error) });
      } catch {}
      console.error('[TabService] Failed to read activities from storage:', error);
      return null;
    }
  }

  async hasToken(): Promise<boolean> {
    // Tab detection doesn't require tokens
    return true;
  }

  async clearToken(): Promise<void> {
    // No token to clear
  }

  async getAuthUrl(): Promise<string> {
    // No auth needed
    return '';
  }

  async handleAuthCallback(code: string): Promise<void> {
    // No auth to handle
  }

  /**
   * Get the last detected activity
   */
  getDetectedActivity(service: string): Activity | null {
    return this.detectedActivity;
  }
}
