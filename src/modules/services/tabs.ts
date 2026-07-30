/**
 * Hang Time - Tab Detection Service
 * Reads tab activities from storage (written by content scripts)
 */

import { Activity, IServiceModule } from '../../types';
import { StorageManager } from '../storage';

export class TabService implements IServiceModule {
  private detectedActivities: Map<string, Activity> = new Map();

  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return profile.services_enabled['netflix-tab'] || profile.services_enabled['youtube-tab'] || profile.services_enabled['twitch-tab'];
  }

  /**
   * Read activities from storage written by content scripts
   * Returns the most recently updated activity
   */
  async getCurrentActivity(): Promise<Activity | null> {
    try {
      // Read all activity storage keys from content scripts
      const storage = await chrome.storage.local.get(null);
      const activities: Activity[] = [];

      // Check for Netflix activity
      if (storage['content_script_activity_netflix-tab']) {
        const activity = this._buildActivity(storage['content_script_activity_netflix-tab'], 'netflix-tab');
        if (activity) {
          activities.push(activity);
          this.detectedActivities.set('netflix-tab', activity);
        }
      }

      // Check for YouTube activity
      if (storage['content_script_activity_youtube-tab']) {
        const activity = this._buildActivity(storage['content_script_activity_youtube-tab'], 'youtube-tab');
        if (activity) {
          activities.push(activity);
          this.detectedActivities.set('youtube-tab', activity);
        }
      }

      // Check for Twitch activity
      if (storage['content_script_activity_twitch-tab']) {
        const activity = this._buildActivity(storage['content_script_activity_twitch-tab'], 'twitch-tab');
        if (activity) {
          activities.push(activity);
          this.detectedActivities.set('twitch-tab', activity);
        }
      }

      // Return most recently updated activity
      if (activities.length > 0) {
        return activities.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
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
   * Get the last detected activity for a specific service
   */
  getDetectedActivity(service: 'netflix-tab' | 'youtube-tab' | 'twitch-tab'): Activity | null {
    return this.detectedActivities.get(service) || null;
  }

  /**
   * Convert storage activity data to Activity object
   */
  private _buildActivity(data: any, service: 'netflix-tab' | 'youtube-tab' | 'twitch-tab'): Activity | null {
    if (!data || !data.content) {
      return null;
    }

    return {
      id: data.id || `${service}-${Date.now()}`,
      service,
      content: data.content,
      state: data.state || 'playing',
      audio: data.audio || 'on',
      timestamp: data.timestamp || Date.now(),
      freshness_timestamp: data.timestamp || Date.now(),
      is_fresh: true,
      url: data.url,
      provenance: 'LOCAL_TAB',
      metadata: {
        progress: data.currentTime || 0,
        duration: data.duration || 0,
      },
    };
  }
}
