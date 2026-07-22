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

      // Check each service in priority order, using most recently accessed tab
      const netflixTab = this._findMostRecentTabByDomain(tabs, 'netflix');
      if (netflixTab) {
        const title = this._extractNetflixTitle(netflixTab.title || '');
        return {
          service: 'netflix',
          content: title || 'Netflix Content',
          url: netflixTab.url,
          timestamp: Date.now(),
          metadata: { title },
        };
      }

      const youtubeTab = this._findMostRecentTabByDomain(tabs, 'youtube');
      if (youtubeTab) {
        const title = this._extractYouTubeTitle(youtubeTab.title || '');
        return {
          service: 'youtube',
          content: title || 'YouTube Video',
          url: youtubeTab.url,
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
