/**
 * Hang Time - Unified Content Script
 * Runs on Netflix, YouTube, Twitch
 * Detects service and runs appropriate handlers
 */

import { generateActivityId } from '../src/modules/activity-utils';

type Service = 'netflix-tab' | 'youtube-tab' | 'twitch-tab';

interface VideoState {
  videoId: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
}

class UnifiedContentScript {
  private service: Service | null = null;
  private port: chrome.runtime.Port | null = null;
  private lastReportedTime: number = 0;
  private lastReportedState: 'playing' | 'paused' = 'playing';
  private videoState: VideoState = {
    videoId: null,
    currentTime: 0,
    duration: 0,
    isPlaying: false,
  };

  constructor() {
    this.detectService();
  }

  private detectService(): void {
    const hostname = window.location.hostname;

    if (hostname.includes('netflix.com')) {
      this.service = 'netflix-tab';
    } else if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      this.service = 'youtube-tab';
    } else if (hostname.includes('twitch.tv')) {
      this.service = 'twitch-tab';
    }

    if (this.service) {
      console.log(`[ContentScript] ✅ Detected service: ${this.service}`);
    }
  }

  init(): void {
    if (!this.service) {
      console.debug('[ContentScript] Not a tracked video service, skipping');
      return;
    }

    console.debug(`[ContentScript] Initializing for ${this.service}`);

    // Set up health reporting to storage (visibility change + periodic heartbeat)
    this._setupHealthReporting();

    // Set up video state reporting to storage
    this._setupVideoStateReporting();

    // Start video monitoring for all services
    this._startVideoMonitoring();
  }


  private _setupHealthReporting(): void {
    // Report health to storage on tab visibility change (sleep/wake)
    document.addEventListener('visibilitychange', () => {
      console.log(`[ContentScript] Tab ${document.hidden ? 'hidden' : 'visible'}`);
      this._reportHealth();
    });

    // Periodic health heartbeat every 30 seconds
    setInterval(() => {
      this._reportHealth();
    }, 30000);

    // Initial health report
    this._reportHealth();
  }

  private async _reportHealth(): void {
    const healthKey = `content_script_health_${this.service}`;
    const health = {
      service: this.service,
      alive: true,
      timestamp: Date.now(),
      visibility: document.hidden ? 'hidden' : 'visible',
    };

    await this._sendActivityMessage(healthKey, health);
    console.debug(`[ContentScript] 📊 Reported health (${health.visibility})`);
  }

  private _setupVideoStateReporting(): void {
    // Write complete activity data to storage
    // Background monitors storage and uses for publishing
    this._reportActivity();

    // Update on visibility changes (tab wake-up)
    document.addEventListener('visibilitychange', () => {
      this._reportActivity();
    });

    // Periodic updates every 2 seconds
    setInterval(() => {
      this._reportActivity();
    }, 2000);
  }

  private async _reportActivity(): Promise<void> {
    const video = this._getVideoElement();
    if (!video) {
      console.debug(`[ContentScript] No video element found for ${this.service}`);
      return;
    }

    // Get title (Netflix needs special handling)
    let title = 'Video';
    if (this.service === 'netflix-tab') {
      // Try to get cached title first
      title = await this._getNetflixTitleFromStorage();
      // If no cached title, extract it from DOM
      if (!title) {
        title = await this._extractNetflixTitle();
        if (title) {
          await this._storeNetflixTitle(title);
        }
      }
      title = title || 'Netflix Video';
    } else if (this.service === 'youtube-tab') {
      title = document.title.replace(' - YouTube', '').trim() || 'YouTube Video';
    } else if (this.service === 'twitch-tab') {
      title = document.title.replace(' on Twitch', '').trim() || 'Twitch Stream';
    }

    const activityKey = `content_script_activity_${this.service}`;
    const isPlaying = this._isVideoPlaying(video);
    const state = isPlaying ? 'playing' : 'paused';
    this.lastReportedTime = video.currentTime;
    this.lastReportedState = state;

    // Use stable ID based on page URL, not timestamp
    // This ensures the same video always has the same activity ID
    const stableId = generateActivityId(this.service, window.location.href);

    // For live streams (duration = 0), use currentTime as duration to avoid validation errors
    const duration = video.duration || video.currentTime || 0;

    const activity = {
      id: stableId,
      service: this.service,
      content: title,
      state: state,
      audio: 'on',
      currentTime: video.currentTime,
      duration: duration,
      timestamp: Date.now(),
      url: window.location.href,
    };

    console.debug(`[ContentScript] 🎥 isPlaying=${isPlaying}, state=${state}, title=${title}`);

    await this._sendActivityMessage(activityKey, activity);
    console.debug(`[ContentScript] 📺 Activity: ${activity.content} (${state})`);
  }

  private async _getNetflixTitleFromStorage(): Promise<string | null> {
    return new Promise((resolve) => {
      chrome.storage.local.get('netflix_title_data', (result) => {
        const data = result['netflix_title_data'];
        resolve(data?.value || null);
      });
    });
  }

  private _handleGetVideoState(sendResponse: (response: any) => void): void {
    const video = this._getVideoElement();
    if (video) {
      sendResponse({
        success: true,
        data: {
          videoId: null,
          currentTime: video.currentTime,
          duration: video.duration,
          isPlaying: !video.paused,
        },
      });
    } else {
      sendResponse({
        success: true,
        data: {
          videoId: null,
          currentTime: 0,
          duration: 0,
          isPlaying: false,
        },
      });
    }
  }

  private _handleGetVideoPosition(sendResponse: (response: any) => void): void {
    const video = this._getVideoElement();
    if (video) {
      sendResponse({
        success: true,
        data: {
          currentTime: Math.floor(video.currentTime),
          duration: Math.floor(video.duration),
        },
      });
    } else {
      sendResponse({ success: true, data: { currentTime: 0, duration: 0 } });
    }
  }

  private _handleSyncVideo(targetTime: number | undefined, sendResponse: (response: any) => void): void {
    if (targetTime === undefined) {
      sendResponse({ success: false, error: 'No target time provided' });
      return;
    }

    const video = this._getVideoElement();
    if (video) {
      video.currentTime = targetTime;
      console.debug(`[ContentScript] Synced video to ${targetTime}s`);
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'No video element found' });
    }
  }

  private _handleGetNetflixTitle(sendResponse: (response: any) => void): void {
    if (this.service !== 'netflix-tab') {
      sendResponse({ success: true, data: null });
      return;
    }

    (async () => {
      try {
        const title = await this._extractNetflixTitle();
        if (title) {
          console.log(`[ContentScript] ✅ Extracted Netflix title: "${title}"`);
          await this._storeNetflixTitle(title);
          sendResponse({ success: true, data: title });
        } else {
          console.warn('[ContentScript] ⚠️  Failed to extract Netflix title from DOM after retries');
          sendResponse({ success: true, data: null });
        }
      } catch (error) {
        console.error('[ContentScript] Error extracting Netflix title:', error instanceof Error ? error.message : error);
        sendResponse({ success: true, data: null });
      }
    })();
  }

  private _getVideoElement(): HTMLVideoElement | null {
    return document.querySelector('video');
  }

  private async _sendActivityMessage(key: string, value: any): Promise<void> {
    try {
      return await new Promise<void>((resolve) => {
        console.debug(`[ContentScript] 📨 Sending message for key: ${key}`);
        chrome.runtime.sendMessage(
          { type: 'CONTENT_SCRIPT_ACTIVITY', data: { key, value } },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn(`[ContentScript] ⚠️  Message failed: ${chrome.runtime.lastError.message}`);
            } else if (response?.success) {
              console.debug(`[ContentScript] ✅ Background confirmed: ${key}`);
            } else {
              console.debug(`[ContentScript] Response received but not success: ${JSON.stringify(response)}`);
            }
            resolve();
          }
        );
      });
    } catch (error) {
      console.error(`[ContentScript] ❌ Failed to send message:`, error instanceof Error ? error.message : error);
    }
  }

  private _isVideoPlaying(video: HTMLVideoElement): boolean {
    // Primary: check paused property
    if (!video.paused) {
      return true;
    }

    // Fallback for live streams (Twitch): check if currentTime is advancing
    const currentTime = video.currentTime;
    const isAdvancing = currentTime > this.lastReportedTime;

    return isAdvancing;
  }

  private _startVideoMonitoring(): void {
    let lastVideoElement: HTMLVideoElement | null = null;
    let lastCurrentTime: number = 0;

    const pollInterval = setInterval(() => {
      const video = this._getVideoElement();
      if (!video) return;

      // Detect video element change or significant time reset (new content)
      if (video !== lastVideoElement || (lastCurrentTime > 10 && video.currentTime < 5)) {
        console.debug('[ContentScript] Detected new content (video element changed or time reset), clearing cached title');
        this._clearCachedNetflixTitle();
        lastVideoElement = video;
      }

      lastCurrentTime = video.currentTime;

      this.videoState = {
        videoId: null,
        currentTime: video.currentTime,
        duration: video.duration,
        isPlaying: !video.paused,
      };
    }, 500);
  }

  private async _clearCachedNetflixTitle(): Promise<void> {
    try {
      await chrome.storage.local.remove('netflix_title_data');
      console.debug('[ContentScript] Cleared cached Netflix title from storage');
    } catch (error) {
      console.error('[ContentScript] Failed to clear cached Netflix title:', error instanceof Error ? error.message : error);
    }
  }

  // Netflix-specific methods
  private async _extractNetflixTitle(): Promise<string | null> {
    try {
      // Try extraction with a small delay to let React render
      // First attempt: immediate
      let title = this._tryExtractTitle();
      if (title) return title;

      // Second attempt: wait 100ms and retry
      await new Promise(resolve => setTimeout(resolve, 100));
      title = this._tryExtractTitle();
      if (title) return title;

      // Third attempt: wait another 100ms and retry
      await new Promise(resolve => setTimeout(resolve, 100));
      title = this._tryExtractTitle();
      return title;
    } catch (error) {
      return null;
    }
  }

  private _tryExtractTitle(): string | null {
    try {
      // Look for h2 tags (React renders title here)
      const h2Elements = document.querySelectorAll('h2');
      for (const h2 of h2Elements) {
        const text = h2.textContent?.trim();
        if (text && this._isValidTitle(text)) {
          return text;
        }
      }

      // Fallback to data-uia attribute
      const titleElements = document.querySelectorAll("[data-uia='video-title']");
      for (const titleElement of titleElements) {
        const fullText = titleElement.textContent?.trim() || '';
        if (!fullText) continue;

        const parts = fullText.split(/\s+(?=Rated|Audio|Subtitles|CC|Closed|Available|IMDb|\d+%)/i);
        let title = parts[0].trim();

        if (/^Rated|^PG|^R$|^NC-17|^G$|^TV-|^\d+%|^IMDb|^Audio|^Subtitles|^CC|^Closed|^Available/i.test(title)) {
          continue;
        }

        const episodeMatch = title.match(/\s*([SE]\d+(?:E\d+)?)\s*/i);
        const episode = episodeMatch ? episodeMatch[1] : null;

        if (episode) {
          title = title.substring(0, episodeMatch.index).trim();
        }

        const titleWords = title.split(/\s+/);
        if (titleWords.length > 1) {
          const firstWord = titleWords[0].toLowerCase();
          while (titleWords.length > 1 && titleWords[titleWords.length - 1].toLowerCase() === firstWord) {
            titleWords.pop();
          }
          title = titleWords.join(' ');
        }

        title = title.trim();

        if (title && title.length > 2) {
          const result = episode ? `${title} ${episode}` : title;
          if (this._isValidTitle(result)) {
            return result;
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }


  private _isValidTitle(title: string | null | undefined): boolean {
    if (!title || typeof title !== 'string') return false;
    if (title.length < 2 || title.length > 200) return false;

    const lower = title.toLowerCase();

    // Contamination checks
    if (title.includes('•')) return false;
    if (title.includes('invited you to')) return false;
    if (/[\x00-\x1F\x7F]/.test(title)) return false;

    if (lower.includes('error') || lower.includes('failed')) return false;

    if (
      title === 'Netflix' ||
      title === 'Loading' ||
      title === '' ||
      lower === 'play' ||
      lower === 'pause' ||
      lower === 'skip' ||
      lower === 'replay'
    ) {
      return false;
    }

    if (
      lower.includes('audio description') ||
      lower.includes('closed captions') ||
      lower.includes('subtitles') ||
      lower.includes('cc available') ||
      lower.includes('dubbed') ||
      lower.includes('original audio') ||
      lower.includes('volume') ||
      lower.includes('fullscreen') ||
      lower.includes('settings') ||
      lower.includes('next episode') ||
      lower.includes('previous episode') ||
      lower.includes('privacy') ||
      lower.includes('preference') ||
      lower.includes('modal') ||
      lower.includes('dialog')
    ) {
      return false;
    }

    return true;
  }

  private async _storeNetflixTitle(title: string): Promise<void> {
    try {
      const now = Date.now();
      const titleData = {
        value: title,
        extractedAt: now,
        source: 'h2-tag',
        confidence: 'high',
      };
      await chrome.storage.local.set({ netflix_title_data: titleData });
    } catch (error) {
      console.error('[ContentScript] Failed to store title:', error instanceof Error ? error.message : error);
    }
  }

  private async _getStoredNetflixTitle(): Promise<string | null> {
    try {
      const result = await chrome.storage.local.get('netflix_title_data');
      const data = result['netflix_title_data'];
      if (data && data.value && this._isValidTitle(data.value)) {
        return data.value;
      }
      return null;
    } catch (error) {
      console.error('[ContentScript] Failed to get stored title:', error instanceof Error ? error.message : error);
      return null;
    }
  }
}

// Initialize on load
const script = new UnifiedContentScript();
script.init();
