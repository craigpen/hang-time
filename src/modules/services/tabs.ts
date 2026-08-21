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
   * Read all video tab activities from MY_ACTIVITIES (most recent of EACH browser tab service)
   */
  async getAllCurrentActivities(): Promise<Activity[]> {
    try {
      const myActivities = await this.storage.getMyActivities();
      const videoServices = ['youtube-tab', 'netflix-tab', 'twitch-tab', 'video-tab'];
      const mostRecentByService: Partial<Record<string, Activity>> = {};

      for (const activity of Object.values(myActivities)) {
        if (activity && videoServices.includes(activity.service)) {
          const service = activity.service;
          const existing = mostRecentByService[service];
          const actTime = (activity.metadata?.lastAccessed as number) || activity.timestamp || 0;
          const existingTime = existing ? ((existing.metadata?.lastAccessed as number) || existing.timestamp || 0) : -1;

          if (!existing || actTime > existingTime) {
            mostRecentByService[service] = activity;
          }
        }
      }

      return Object.values(mostRecentByService).filter((a): a is Activity => Boolean(a));
    } catch (error) {
      console.error('[TabService] Failed to read all activities from storage:', error);
      return [];
    }
  }

  /**
   * Read the single most recent video tab activity from generic video tracker via MY_ACTIVITIES
   */
  async getCurrentActivity(): Promise<Activity | null> {
    try {
      const allTabActivities = await this.getAllCurrentActivities();
      if (allTabActivities.length === 0) {
        return null;
      }

      // Sort by most recent
      allTabActivities.sort((a, b) => {
        const aTime = (a.metadata?.lastAccessed as number) || a.timestamp || 0;
        const bTime = (b.metadata?.lastAccessed as number) || b.timestamp || 0;
        return bTime - aTime;
      });

      this.detectedActivity = allTabActivities[0] || null;
      return this.detectedActivity;
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

  async handleAuthCallback(_code: string): Promise<void> {
    // No auth to handle
  }

  /**
   * Get the last detected activity
   */
  getDetectedActivity(_service?: string): Activity | null {
    return this.detectedActivity;
  }
}
