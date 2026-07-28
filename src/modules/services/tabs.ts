/**
 * Hang Time - Tab Detection Service
 * Monitors active tabs for Netflix and YouTube
 */

import { Activity, IServiceModule } from '../../types';
import { StorageManager } from '../storage';
import { generateActivityId } from '../activity-utils';
import { getActivityDatastore } from '../activity-datastore';

export class TabService implements IServiceModule {
  private lastDetected: Map<string, Activity> = new Map();
  private initialized = false;

  constructor(private storage: StorageManager) {}

  /**
   * Initialize lastDetected cache from stored activities on startup
   * Ensures progress bars persist across service worker restarts
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const activities = await this.storage.getMyActivities();
      Object.values(activities).forEach((activity) => {
        if (activity && (activity.service === 'netflix-tab' || activity.service === 'youtube-tab' || activity.service === 'twitch-tab')) {
          this.lastDetected.set(activity.service, activity);
        }
      });
      this.initialized = true;
      console.debug('[TabService] Initialized lastDetected cache with', this.lastDetected.size, 'activities');
    } catch (error) {
      console.error('[TabService] Failed to initialize lastDetected cache:', error);
    }
  }

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return profile.services_enabled.netflix || profile.services_enabled.youtube || profile.services_enabled.twitch;
  }

  async getCurrentActivity(): Promise<Activity | null> {
    try {
      // Initialize cache from storage on first call after restart
      if (!this.initialized) {
        await this.initialize();
      }

      const tabs = await chrome.tabs.query({ windowType: 'normal' });
      const stored = await this.storage.getMyActivities();
      const openTabIds = new Set(tabs.map(t => t.id));
      const datastore = getActivityDatastore();

      // Detect ALL active services, not just the first one
      const detectedActivities: Activity[] = [];
      const closedActivityIds: string[] = [];  // Track activities to remove

      // Check for Netflix
      const netflixTab = this._findMostRecentTabByDomain(tabs, 'netflix');
      if (netflixTab && netflixTab.id) {
        // Tab is open - try to get fresh data from content script
        let title = await this.getNetflixTitleFromTab(netflixTab.id);
        if (!title) {
          title = this._extractNetflixTitle(netflixTab.title || '');
        }

        if (title) {
          const netflixId = generateActivityId('netflix-tab', netflixTab.url);
          const videoData = await this.getVideoActivityDataFromTab(netflixTab.id, 'netflix-tab');
          const storedNetflix = stored['netflix-tab'];

          // Determine state based on content script responsiveness
          let state: 'playing' | 'paused' = 'paused';
          let audio: 'on' | 'off' = 'off';
          let freshness_timestamp = Date.now();
          let is_fresh = false;

          if (videoData?.isPlaying !== undefined) {
            // Content script responsive - use fresh data
            state = videoData.isPlaying ? 'playing' : 'paused';
            audio = videoData.isPlaying ? 'on' : 'off';
            freshness_timestamp = Date.now();
            is_fresh = true;
          } else if (storedNetflix) {
            // Content script not responsive - use stored data (preserve freshness from stored version)
            state = storedNetflix.state || 'paused';
            audio = storedNetflix.audio || 'off';
            freshness_timestamp = storedNetflix.freshness_timestamp || Date.now();
            is_fresh = false;
          }

          const netflixActivity: Activity = {
            id: netflixId,
            service: 'netflix-tab',
            content: title,
            url: netflixTab.url,
            state,
            audio,
            timestamp: Date.now(),
            freshness_timestamp,
            is_fresh,
            provenance: 'LOCAL_TAB',
            metadata: {
              lastAccessed: netflixTab.lastAccessed || 0,
              progress: videoData?.currentTime ?? storedNetflix?.metadata?.progress,
              duration: videoData?.duration ?? storedNetflix?.metadata?.duration,
              tabId: netflixTab.id,
            },
          };
          detectedActivities.push(netflixActivity);
        }
      } else if (stored['netflix-tab'] && stored['netflix-tab'].metadata?.tabId && !openTabIds.has(stored['netflix-tab'].metadata.tabId)) {
        // Netflix tab was closed - mark for removal
        if (stored['netflix-tab'].id) {
          closedActivityIds.push(stored['netflix-tab'].id);
        }
      }

      // Check for YouTube
      const youtubeTab = this._findMostRecentTabByDomain(tabs, 'youtube');
      if (youtubeTab && youtubeTab.id) {
        const title = this._extractYouTubeTitle(youtubeTab.title || '');
        const finalContent = (title && !title.includes('http')) ? title : 'YouTube Video';
        const youtubeId = generateActivityId('youtube-tab', youtubeTab.url);
        const videoData = await this.getVideoActivityDataFromTab(youtubeTab.id, 'youtube-tab');
        const storedYoutube = stored['youtube-tab'];

        // Determine state based on content script responsiveness
        let state: 'playing' | 'paused' = 'paused';
        let audio: 'on' | 'off' = 'off';
        let freshness_timestamp = Date.now();
        let is_fresh = false;

        if (videoData?.isPlaying !== undefined) {
          // Content script responsive - use fresh data
          state = videoData.isPlaying ? 'playing' : 'paused';
          audio = videoData.isPlaying ? 'on' : 'off';
          freshness_timestamp = Date.now();
          is_fresh = true;
        } else if (storedYoutube) {
          // Content script not responsive - use stored data (preserve freshness from stored version)
          state = storedYoutube.state || 'paused';
          audio = storedYoutube.audio || 'off';
          freshness_timestamp = storedYoutube.freshness_timestamp || Date.now();
          is_fresh = false;
        }

        const youtubeActivity: Activity = {
          id: youtubeId,
          service: 'youtube-tab',
          content: finalContent,
          url: youtubeTab.url,
          state,
          audio,
          timestamp: Date.now(),
          freshness_timestamp,
          is_fresh,
          provenance: 'LOCAL_TAB',
          metadata: {
            lastAccessed: youtubeTab.lastAccessed || 0,
            progress: videoData?.currentTime ?? storedYoutube?.metadata?.progress,
            duration: videoData?.duration ?? storedYoutube?.metadata?.duration,
            tabId: youtubeTab.id,
          },
        };
        detectedActivities.push(youtubeActivity);
      } else if (stored['youtube-tab'] && stored['youtube-tab'].metadata?.tabId && !openTabIds.has(stored['youtube-tab'].metadata.tabId)) {
        // YouTube tab was closed - mark for removal
        if (stored['youtube-tab'].id) {
          closedActivityIds.push(stored['youtube-tab'].id);
        }
      }

      // Check for Twitch
      const twitchTab = this._findMostRecentTabByDomain(tabs, 'twitch');
      if (twitchTab && twitchTab.id) {
        const title = this._extractTwitchTitle(twitchTab.title || '');
        const twitchId = generateActivityId('twitch-tab', twitchTab.url);
        const videoData = await this.getVideoActivityDataFromTab(twitchTab.id, 'twitch-tab');
        const storedTwitch = stored['twitch-tab'];

        // Determine state based on content script responsiveness
        let state: 'playing' | 'paused' = 'paused';
        let audio: 'on' | 'off' = 'off';
        let freshness_timestamp = Date.now();
        let is_fresh = false;

        if (videoData?.isPlaying !== undefined) {
          // Content script responsive - use fresh data
          state = videoData.isPlaying ? 'playing' : 'paused';
          audio = videoData.isPlaying ? 'on' : 'off';
          freshness_timestamp = Date.now();
          is_fresh = true;
        } else if (storedTwitch) {
          // Content script not responsive - use stored data
          state = storedTwitch.state || 'paused';
          audio = storedTwitch.audio || 'off';
          freshness_timestamp = storedTwitch.freshness_timestamp || Date.now();
          is_fresh = false;
        }

        const twitchActivity: Activity = {
          id: twitchId,
          service: 'twitch-tab',
          content: title || 'Twitch Stream',
          url: twitchTab.url,
          state,
          audio,
          timestamp: Date.now(),
          freshness_timestamp,
          is_fresh,
          provenance: 'LOCAL_TAB',
          metadata: {
            lastAccessed: twitchTab.lastAccessed || 0,
            progress: videoData?.currentTime ?? storedTwitch?.metadata?.progress,
            duration: videoData?.duration ?? storedTwitch?.metadata?.duration,
            tabId: twitchTab.id,
          },
        };
        detectedActivities.push(twitchActivity);
      } else if (stored['twitch-tab'] && stored['twitch-tab'].metadata?.tabId && !openTabIds.has(stored['twitch-tab'].metadata.tabId)) {
        // Twitch tab was closed - mark for removal
        if (stored['twitch-tab'].id) {
          closedActivityIds.push(stored['twitch-tab'].id);
        }
      }

      // Remove closed tab activities via datastore
      for (const activityId of closedActivityIds) {
        await datastore.deleteActivity(activityId);
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
  getDetectedActivity(service: 'netflix-tab' | 'youtube-tab' | 'twitch-tab'): Activity | null {
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
          const data = {
            currentTime: response.data.currentTime,
            duration: response.data.duration,
            isPlaying: response.data.isPlaying,
          };

          // Track metrics for this request
          await this.storage.recordVideoDataRequest(service as 'netflix-tab' | 'youtube-tab' | 'twitch-tab', {
            isPlaying: data.isPlaying,
            duration: data.duration,
            currentTime: data.currentTime,
          });

          return data;
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

    // Track failed request
    await this.storage.recordVideoDataRequest(service as 'netflix-tab' | 'youtube-tab' | 'twitch-tab', {
      isPlaying: undefined,
      duration: undefined,
      currentTime: undefined,
    });

    return null;
  }

  /**
   * @deprecated Use getVideoActivityDataFromTab instead
   * Get video position (currentTime and duration) from content script
   * Called during activity detection for all video services
   */
  async getVideoPositionFromTab(tabId: number, service: 'netflix-tab' | 'youtube-tab'): Promise<{ currentTime?: number; duration?: number } | null> {
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
    // Always try fresh extraction from content script first
    // Storage is only a fallback if content script extraction fails
    const maxRetries = 10;
    const retryDelays = [500, 500, 500, 500, 1000, 1000, 1000, 1000, 1000, 1000]; // ms

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_NETFLIX_TITLE' });

        if (response && response.success && response.data && typeof response.data === 'string' && response.data.length > 0) {
          // Track successful title
          await this.storage.recordVideoDataRequest('netflix-tab', {
            netflix_title: response.data,
          });
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

    // Content script extraction failed - fall back to storage as last resort
    try {
      const storedTitle = await this.storage.getNetflixTitle();
      if (storedTitle && typeof storedTitle === 'string' && storedTitle.length > 0) {
        console.debug('[TabService] Using stored Netflix title (content script extraction failed)');
        await this.storage.recordVideoDataRequest('netflix-tab', {
          netflix_title: storedTitle,
        });
        return storedTitle;
      }
    } catch (error) {
      console.error('[TabService] Error reading Netflix title from storage:', error);
    }

    // All retries exhausted and no fallback available
    await this.storage.recordVideoDataRequest('netflix-tab', {
      netflix_title: undefined,
    });

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
