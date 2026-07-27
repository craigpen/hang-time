/**
 * Hang Time - Tab Detection Service
 * Monitors active tabs for Netflix and YouTube
 */

import { Activity, IServiceModule } from '../../types';
import { StorageManager } from '../storage';
import { generateActivityId } from '../activity-utils';

export class TabService implements IServiceModule {
  private lastDetected: Map<string, Activity> = new Map();

  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return profile.services_enabled.netflix || profile.services_enabled.youtube || profile.services_enabled.twitch;
  }

  async getCurrentActivity(): Promise<Activity | null> {
    try {
      const tabs = await chrome.tabs.query({ windowType: 'normal' });

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

        if (title) {
          // We have a real title - create normal activity
          const netflixId = generateActivityId('netflix', netflixTab.url);
          // Query video data from content script for progress and play/pause state
          const videoData = await this.getVideoActivityDataFromTab(netflixTab.id, 'netflix');
          // Preserve previous data if current query fails
          const lastNetflixActivity = this.lastDetected.get('netflix');
          // Use content script's isPlaying state only, preserve previous if unavailable
          // (tab.audible is unreliable - removed fallback to prevent oscillation)
          let state = lastNetflixActivity?.state || 'paused';
          if (videoData?.isPlaying !== undefined) {
            state = videoData.isPlaying ? 'playing' : 'paused';
          }
          let audio = lastNetflixActivity?.audio || 'off';
          if (videoData?.isPlaying !== undefined) {
            audio = videoData.isPlaying ? 'on' : 'off';
          }
          const netflixActivity: Activity = {
            id: netflixId,
            service: 'netflix',
            content: title,
            url: netflixTab.url,
            state,
            audio,
            timestamp: Date.now(),
            metadata: {
              lastAccessed: netflixTab.lastAccessed || 0,
              progress: videoData?.currentTime ?? lastNetflixActivity?.metadata?.progress,
              duration: videoData?.duration ?? lastNetflixActivity?.metadata?.duration,
            },
          };
          detectedActivities.push(netflixActivity);
        }
        // Don't create guidance activities - skip publishing if no title found
        // Friends will see no Netflix activity rather than a confusing message
      }

      // Check for YouTube
      const youtubeTab = this._findMostRecentTabByDomain(tabs, 'youtube');
      if (youtubeTab) {
        const title = this._extractYouTubeTitle(youtubeTab.title || '');
        // Ensure content is never a URL - use fallback if title extraction failed
        const finalContent = (title && !title.includes('http')) ? title : 'YouTube Video';
        const youtubeId = generateActivityId('youtube', youtubeTab.url);
        // Query video data from content script for progress and play/pause state
        const videoData = await this.getVideoActivityDataFromTab(youtubeTab.id, 'youtube');
        // Preserve previous data if current query fails
        const lastYoutubeActivity = this.lastDetected.get('youtube');
        // Use content script's isPlaying state only, preserve previous if unavailable
        // (tab.audible is unreliable - removed fallback to prevent oscillation)
        let state = lastYoutubeActivity?.state || 'paused';
        if (videoData?.isPlaying !== undefined) {
          state = videoData.isPlaying ? 'playing' : 'paused';
        }
        let audio = lastYoutubeActivity?.audio || 'off';
        if (videoData?.isPlaying !== undefined) {
          audio = videoData.isPlaying ? 'on' : 'off';
        }
        const youtubeActivity: Activity = {
          id: youtubeId,
          service: 'youtube',
          content: finalContent,
          url: youtubeTab.url,
          state,
          audio,
          timestamp: Date.now(),
          metadata: {
            lastAccessed: youtubeTab.lastAccessed || 0,
            progress: videoData?.currentTime ?? lastYoutubeActivity?.metadata?.progress,
            duration: videoData?.duration ?? lastYoutubeActivity?.metadata?.duration,
          },
        };
        detectedActivities.push(youtubeActivity);
      }

      // Check for Twitch
      const twitchTab = this._findMostRecentTabByDomain(tabs, 'twitch');
      if (twitchTab) {
        const title = this._extractTwitchTitle(twitchTab.title || '');
        const twitchId = generateActivityId('twitch', twitchTab.url);
        // Query video data from content script for play/pause state
        const videoData = await this.getVideoActivityDataFromTab(twitchTab.id, 'twitch');
        // Preserve previous data if current query fails
        const lastTwitchActivity = this.lastDetected.get('twitch');
        // Use content script's isPlaying state only, preserve previous if unavailable
        // (tab.audible is unreliable - removed fallback to prevent oscillation)
        let state = lastTwitchActivity?.state || 'paused';
        if (videoData?.isPlaying !== undefined) {
          state = videoData.isPlaying ? 'playing' : 'paused';
        }
        let audio = lastTwitchActivity?.audio || 'off';
        if (videoData?.isPlaying !== undefined) {
          audio = videoData.isPlaying ? 'on' : 'off';
        }
        const twitchActivity: Activity = {
          id: twitchId,
          service: 'twitch',
          content: title || 'Twitch Stream',
          url: twitchTab.url,
          state,
          audio,
          timestamp: Date.now(),
          metadata: {
            lastAccessed: twitchTab.lastAccessed || 0,
            progress: videoData?.currentTime ?? lastTwitchActivity?.metadata?.progress,
            duration: videoData?.duration ?? lastTwitchActivity?.metadata?.duration,
          },
        };
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

        return mostRecent;
      }

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
   * Get video activity data (position and state) from content script
   * Called during activity detection for all video services
   */
  async getVideoActivityDataFromTab(tabId: number, service: string): Promise<{ currentTime?: number; duration?: number; isPlaying?: boolean } | null> {
    const maxRetries = 3;
    const retryDelays = [100, 200, 300]; // ms

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_STATE' });

        if (response && response.success && response.data) {
          return {
            currentTime: response.data.currentTime,
            duration: response.data.duration,
            isPlaying: response.data.isPlaying,
          };
        }

        // Invalid response, retry if attempts left
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        }
      } catch (error) {
        // Retry unless it's the last attempt
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        }
      }
    }

    return null;
  }

  /**
   * @deprecated Use getVideoActivityDataFromTab instead
   * Get video position (currentTime and duration) from content script
   * Called during activity detection for all video services
   */
  async getVideoPositionFromTab(tabId: number, service: 'netflix' | 'youtube'): Promise<{ currentTime?: number; duration?: number } | null> {
    const data = await this.getVideoActivityDataFromTab(tabId, service);
    if (data) {
      return {
        currentTime: data.currentTime,
        duration: data.duration,
      };
    }
    return null;
  }

  /**
   * Get Netflix title from content script via message passing
   * Called when we detect a Netflix tab
   */
  async getNetflixTitleFromTab(tabId: number): Promise<string | null> {
    // First try to get from storage (content script should have written it)
    try {
      const storedTitle = await this.storage.getNetflixTitle();
      if (storedTitle && typeof storedTitle === 'string' && storedTitle.length > 0) {
        return storedTitle;
      }
    } catch (error) {
      console.error('[TabService] Error reading Netflix title from storage:', error);
    }

    // Storage empty - use aggressive retry to get fresh extraction from content script
    const maxRetries = 10;
    const retryDelays = [500, 500, 500, 500, 1000, 1000, 1000, 1000, 1000, 1000]; // ms

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_NETFLIX_TITLE' });

        if (response && response.success && response.data && typeof response.data === 'string' && response.data.length > 0) {
          return response.data;
        }

        // Invalid response, retry if attempts left
        if (attempt < maxRetries - 1) {
          const delay = retryDelays[attempt];
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        // Retry unless it's the last attempt
        if (attempt < maxRetries - 1) {
          const delay = retryDelays[attempt];
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted, return null (activity will show without title, but with play/pause state)
    return null;
  }

  private _getMostRecentTab(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab {
    // Prioritize audible tabs (actively playing audio, including PiP)
    const audibleTab = tabs.find(tab => tab.audible);
    if (audibleTab) return audibleTab;

    // Then active tab
    const activeTab = tabs.find(tab => tab.active);
    if (activeTab) return activeTab;

    // Fall back to most recent by lastAccessed
    return tabs.reduce((most, current) => {
      const currentTime = current.lastAccessed || 0;
      const mostTime = most.lastAccessed || 0;
      return currentTime > mostTime ? current : most;
    });
  }
}
