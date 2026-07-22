/**
 * Hang Time - Tab Detection Service
 * Monitors active tabs for Netflix and YouTube
 */

import { Activity, IServiceModule } from '../../types';
import { StorageManager } from '../storage';

export class TabService implements IServiceModule {
  private lastDetected: Map<string, Activity> = new Map();

  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return profile.services_enabled.netflix || profile.services_enabled.youtube;
  }

  async getCurrentActivity(): Promise<Activity | null> {
    try {
      const tabs = await chrome.tabs.query({ windowType: 'normal' });
      console.debug(`[TabService] Found ${tabs.length} tabs`);

      // Detect ALL active services, not just the first one
      const detectedActivities: Activity[] = [];

      // Check for Netflix
      const netflixTab = this._findMostRecentTabByDomain(tabs, 'netflix');
      if (netflixTab) {
        const title = this._extractNetflixTitle(netflixTab.title || '');
        console.debug(`[TabService] Detected Netflix: ${title}`);
        detectedActivities.push({
          service: 'netflix',
          content: title || 'Netflix Content',
          url: netflixTab.url,
          timestamp: Date.now(),
          metadata: { title, lastAccessed: netflixTab.lastAccessed || 0 },
        });
      }

      // Check for YouTube
      const youtubeTab = this._findMostRecentTabByDomain(tabs, 'youtube');
      if (youtubeTab) {
        const title = this._extractYouTubeTitle(youtubeTab.title || '');
        console.debug(`[TabService] Detected YouTube: ${title}`);
        detectedActivities.push({
          service: 'youtube',
          content: title || 'YouTube Video',
          url: youtubeTab.url,
          timestamp: Date.now(),
          metadata: { title, lastAccessed: youtubeTab.lastAccessed || 0 },
        });
      }

      // Store all detected services for later retrieval
      this.lastDetected.clear();
      for (const activity of detectedActivities) {
        this.lastDetected.set(activity.service, activity);
      }

      // If activities detected, return the most recently accessed one
      if (detectedActivities.length > 0) {
        const mostRecent = detectedActivities.reduce((a, b) => {
          const aTime = (a.metadata?.lastAccessed as number) || 0;
          const bTime = (b.metadata?.lastAccessed as number) || 0;
          return aTime > bTime ? a : b;
        });

        console.debug(`[TabService] Detected ${detectedActivities.length} service(s), returning most recent: ${mostRecent.service}`);
        return mostRecent;
      }

      console.debug('[TabService] No video content found');
      // No video content found
      return { service: 'idle', content: 'Idle', timestamp: Date.now(), metadata: {} };
    } catch (error) {
      console.error('[TabService] Failed to query tabs:', error);
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
   * Called by settings UI to display each service's status separately
   */
  getDetectedActivity(service: 'netflix' | 'youtube'): Activity | null {
    return this.lastDetected.get(service) || null;
  }

  private _getBaseDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      let host = urlObj.hostname;
      // Remove www. prefix if present
      if (host.startsWith('www.')) {
        host = host.slice(4);
      }
      return host;
    } catch {
      return '';
    }
  }

  private _findMostRecentTabByDomain(tabs: chrome.tabs.Tab[], domain: string): chrome.tabs.Tab | null {
    const matchingTabs = tabs.filter((tab) => {
      if (!tab.url) return false;
      const baseDomain = this._getBaseDomain(tab.url);

      if (domain === 'youtube') {
        return baseDomain === 'youtube.com' || baseDomain === 'youtu.be';
      }
      if (domain === 'netflix') {
        return baseDomain === 'netflix.com';
      }
      return false;
    });

    if (matchingTabs.length === 0) return null;
    return this._getMostRecentTab(matchingTabs);
  }

  private _isYouTubeVideo(url: string): boolean {
    return url.includes('youtube.com/watch') || url.includes('youtu.be/') || url.includes('youtube.com/embed');
  }

  private _extractYouTubeTitle(pageTitle: string): string {
    // Format: "Video Title - YouTube"
    const match = pageTitle.match(/^(.+?)\s*-\s*YouTube/);
    return match ? match[1].trim() : pageTitle;
  }

  private _isNetflixContent(url: string): boolean {
    return url.includes('netflix.com/watch') || url.includes('netflix.com/browse');
  }

  private _extractNetflixTitle(pageTitle: string): string {
    // Netflix titles are usually just the show/movie name in tab title
    // Remove common suffixes
    const cleaned = pageTitle
      .replace(/\s*Netflix\s*$/, '')
      .replace(/\s*-\s*Netflix\s*$/, '')
      .trim();

    return cleaned || pageTitle;
  }

  private _getMostRecentTab(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab {
    // Find the tab with the most recent lastAccessed timestamp
    return tabs.reduce((most, current) => {
      const currentTime = current.lastAccessed || 0;
      const mostTime = most.lastAccessed || 0;
      return currentTime > mostTime ? current : most;
    });
  }
}
