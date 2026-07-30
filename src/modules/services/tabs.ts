/**
 * Hang Time - Tab Detection Service
 * Reads tab activities from generic video tracker
 * Works with YouTube, Netflix, Twitch, and any video platform
 */

import { Activity, IServiceModule } from '../../types';
import { StorageManager } from '../storage';

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

      // Find the video-tab activity
      const videoActivity = myActivities['video-tab'];
      if (videoActivity && videoActivity.content) {
        this.detectedActivity = videoActivity;
        return videoActivity;
      }

      return null;
    } catch (error) {
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
