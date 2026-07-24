/**
 * Hang Time - Tab Detection Service
 * Monitors active tabs for Netflix and YouTube
 */

import { Activity, IServiceModule } from '../../types';
import { StorageManager } from '../storage';

export class TabService implements IServiceModule {
  private lastDetected: Map<string, Activity> = new Map();
  private videoStates: Map<string, { isPlaying: boolean; timestamp: number }> = new Map();

  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return profile.services_enabled.netflix || profile.services_enabled.youtube || profile.services_enabled.twitch;
  }

  async getCurrentActivity(): Promise<Activity | null> {
    try {
      const tabs = await chrome.tabs.query({ windowType: 'normal' });
      console.debug(`[TabService] Found ${tabs.length} tabs`);

      // Detect ALL active services, not just the first one
      const detectedActivities: Activity[] = [];

      // Check for Netflix
      const netflixTab = this._findMostRecentTabByDomain(tabs, 'netflix');
      if (netflixTab && netflixTab.id) {
        // Try to get the actual title from the Netflix page via content script
        let title = await this.getNetflixTitleFromTab(netflixTab.id);
        // Fall back to parsing page title if content script fails
        if (!title) {
          title = this._extractNetflixTitle(netflixTab.title || '');
        }
        console.debug(`[TabService] Detected Netflix: ${title}`);
        // Use tab's audible property as initial state guess (if audio playing, likely video is playing)
        const netflixActivity: Activity = {
          service: 'netflix',
          content: title || 'Netflix',
          url: netflixTab.url,
          timestamp: Date.now(),
          state: netflixTab.audible ? 'playing' : 'paused',
          metadata: { title, lastAccessed: netflixTab.lastAccessed || 0 },
        };
        const netflixState = this._getVideoState('netflix');
        if (netflixState !== undefined) {
          netflixActivity.state = netflixState ? 'playing' : 'paused';
        }
        detectedActivities.push(netflixActivity);
      }

      // Check for YouTube
      const youtubeTab = this._findMostRecentTabByDomain(tabs, 'youtube');
      if (youtubeTab) {
        const title = this._extractYouTubeTitle(youtubeTab.title || '');
        console.debug(`[TabService] Detected YouTube: ${title}`);
        // Use tab's audible property as initial state guess (if audio playing, likely video is playing)
        const youtubeActivity: Activity = {
          service: 'youtube',
          content: title || 'YouTube Video',
          url: youtubeTab.url,
          timestamp: Date.now(),
          state: youtubeTab.audible ? 'playing' : 'paused',
          metadata: { title, lastAccessed: youtubeTab.lastAccessed || 0 },
        };
        const youtubeState = this._getVideoState('youtube');
        if (youtubeState !== undefined) {
          youtubeActivity.state = youtubeState ? 'playing' : 'paused';
        }
        detectedActivities.push(youtubeActivity);
      }

      // Check for Twitch
      const twitchTab = this._findMostRecentTabByDomain(tabs, 'twitch');
      if (twitchTab) {
        const title = this._extractTwitchTitle(twitchTab.title || '');
        console.debug(`[TabService] Detected Twitch: ${title}`);
        // Use tab's audible property as initial state guess (if audio playing, likely stream is playing)
        const twitchActivity: Activity = {
          service: 'twitch',
          content: title || 'Twitch Stream',
          url: twitchTab.url,
          timestamp: Date.now(),
          state: twitchTab.audible ? 'playing' : 'paused',
          metadata: { title, lastAccessed: twitchTab.lastAccessed || 0 },
        };
        const twitchState = this._getVideoState('twitch');
        if (twitchState !== undefined) {
          twitchActivity.state = twitchState ? 'playing' : 'paused';
        }
        detectedActivities.push(twitchActivity);
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
      return null;
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
  getDetectedActivity(service: 'netflix' | 'youtube' | 'twitch'): Activity | null {
    return this.lastDetected.get(service) || null;
  }

  /**
   * Update video play/pause state (called by background service worker)
   */
  setVideoState(service: string, isPlaying: boolean): void {
    this.videoStates.set(service, {
      isPlaying,
      timestamp: Date.now(),
    });
  }

  /**
   * Get video play/pause state
   */
  private _getVideoState(service: string): boolean | undefined {
    const state = this.videoStates.get(service);
    if (!state) return undefined;
    // Use state if it's recent (within 10 seconds)
    if (Date.now() - state.timestamp < 10000) {
      return state.isPlaying;
    }
    return undefined;
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
      if (domain === 'twitch') {
        return baseDomain === 'twitch.tv';
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
    // Format: "Video Title - YouTube" or "(123) Video Title - YouTube"
    let title = pageTitle;

    // Remove " - YouTube" suffix
    title = title.replace(/\s*-\s*YouTube\s*$/i, '').trim();

    // Remove leading numbers in parentheses like "(162)"
    title = title.replace(/^\(\d+\)\s*/, '').trim();

    return title || pageTitle;
  }

  private _isNetflixContent(url: string): boolean {
    return url.includes('netflix.com/watch') || url.includes('netflix.com/browse');
  }

  private _extractNetflixTitle(pageTitle: string): string {
    // Try to get title from the Netflix page content
    // Fall back to parsing page title if that fails
    // This will be enhanced by the netflix-content.js content script
    const cleaned = pageTitle
      .replace(/\s*Netflix\s*$/, '')
      .replace(/\s*-\s*Netflix\s*$/, '')
      .trim();

    return cleaned;
  }

  private _extractTwitchTitle(pageTitle: string): string {
    // Format: "channel_name - Twitch" or "channel_name playing game - Twitch"
    let title = pageTitle;

    // Remove " - Twitch" suffix
    title = title.replace(/\s*-\s*Twitch\s*$/i, '').trim();

    return title || pageTitle;
  }

  /**
   * Get Netflix title from content script via message passing
   * Called when we detect a Netflix tab
   */
  async getNetflixTitleFromTab(tabId: number): Promise<string | null> {
    // First try to get from storage (content script should have written it)
    try {
      const result = await chrome.storage.session.get('netflix_title');
      const storedTitle = result['netflix_title'];
      if (storedTitle && typeof storedTitle === 'string' && storedTitle.length > 0) {
        console.debug('[TabService] Got Netflix title from storage:', storedTitle);
        return storedTitle;
      }
    } catch (error) {
      console.debug('[TabService] Error reading Netflix title from storage:', error);
    }

    // Storage empty - use aggressive retry to get fresh extraction from content script
    const maxRetries = 10;
    const retryDelays = [500, 500, 500, 500, 1000, 1000, 1000, 1000, 1000, 1000]; // ms

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        console.debug(`[TabService] Requesting fresh Netflix title from tab (attempt ${attempt + 1}/${maxRetries})`);
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_NETFLIX_TITLE' });

        if (response && response.success && response.data && typeof response.data === 'string' && response.data.length > 0) {
          console.debug('[TabService] Got valid Netflix title from content script:', response.data);
          return response.data;
        }

        // Invalid response, retry if attempts left
        if (attempt < maxRetries - 1) {
          const delay = retryDelays[attempt];
          console.debug(`[TabService] No valid title in response, retrying in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        console.debug(`[TabService] Error on attempt ${attempt + 1}:`, error instanceof Error ? error.message : String(error));

        // Retry unless it's the last attempt
        if (attempt < maxRetries - 1) {
          const delay = retryDelays[attempt];
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted, return null (activity will show without title, but with play/pause state)
    console.debug('[TabService] Unable to get Netflix title after all retries');
    return null;
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
