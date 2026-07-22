/**
 * Hang Time - Tab Detection Service
 * Monitors active tabs for Netflix and YouTube
 */

import { Activity, IServiceModule } from '../../types';
import { StorageManager } from '../storage';

export class TabService implements IServiceModule {
  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return profile.services_enabled.netflix || profile.services_enabled.youtube;
  }

  async getCurrentActivity(): Promise<Activity | null> {
    try {
      const tabs = await chrome.tabs.query({ windowType: 'normal' });

      // Group tabs by domain and find most recently accessed for each
      const youTubeTabs = tabs.filter((t) => t.url && this._isYouTubeVideo(t.url));
      const netflixTabs = tabs.filter((t) => t.url && this._isNetflixContent(t.url));

      // Check Netflix first (arbitrary priority), then YouTube
      if (netflixTabs.length > 0) {
        const mostRecent = this._getMostRecentTab(netflixTabs);
        const title = this._extractNetflixTitle(mostRecent.title || '');
        return {
          service: 'netflix',
          content: title || 'Netflix Content',
          url: mostRecent.url,
          timestamp: Date.now(),
          metadata: { title },
        };
      }

      if (youTubeTabs.length > 0) {
        const mostRecent = this._getMostRecentTab(youTubeTabs);
        const title = this._extractYouTubeTitle(mostRecent.title || '');
        return {
          service: 'youtube',
          content: title || 'YouTube Video',
          url: mostRecent.url,
          timestamp: Date.now(),
          metadata: { title },
        };
      }

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
