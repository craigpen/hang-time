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
   * Read activity from generic video tracker
   */
  async getCurrentActivity(): Promise<Activity | null> {
    try {
      const storage = await chrome.storage.local.get(null);

      // Check for generic video activity
      if (storage['content_script_activity_video-tab']) {
        const activity = this._buildActivity(storage['content_script_activity_video-tab']);
        if (activity) {
          this.detectedActivity = activity;
          return activity;
        }
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

  /**
   * Convert storage activity data to Activity object
   */
  private _buildActivity(data: any): Activity | null {
    if (!data || !data.content) {
      return null;
    }

    return {
      id: data.id || `video-tab-${Date.now()}`,
      service: 'video-tab',
      content: data.content,
      state: data.state || 'playing',
      audio: data.audio || 'on',
      timestamp: data.timestamp || Date.now(),
      freshness_timestamp: data.timestamp || Date.now(),
      is_fresh: true,
      url: data.url,
      provenance: 'LOCAL_TAB',
      metadata: {
        progress: data.metadata?.progress || 0,
        duration: data.metadata?.duration || 0,
        domain: data.metadata?.domain,
        favicon: data.metadata?.favicon,
      },
    };
  }
}
