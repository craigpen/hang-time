/**
 * Hang Time - Unified Content Script
 * Runs on Netflix, YouTube, Twitch
 * Detects service and runs appropriate handlers
 */

type Service = 'netflix' | 'youtube' | 'twitch';

interface VideoState {
  videoId: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
}

class UnifiedContentScript {
  private service: Service | null = null;
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
      this.service = 'netflix';
    } else if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      this.service = 'youtube';
    } else if (hostname.includes('twitch.tv')) {
      this.service = 'twitch';
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

    // Set up message listeners
    this._setupMessageListener();

    // Start video monitoring for all services
    this._startVideoMonitoring();
  }

  private _setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
      console.debug(`[ContentScript] Message received: ${message?.type}`);

      try {
        switch (message.type) {
          case 'HEALTH_CHECK':
            this._handleHealthCheck(sendResponse);
            break;

          case 'GET_VIDEO_STATE':
            this._handleGetVideoState(sendResponse);
            break;

          case 'GET_VIDEO_POSITION':
            this._handleGetVideoPosition(sendResponse);
            break;

          case 'SYNC_VIDEO':
            this._handleSyncVideo(message.data?.targetTime, sendResponse);
            break;

          case 'GET_NETFLIX_TITLE':
            this._handleGetNetflixTitle(sendResponse);
            break;

          default:
            console.debug(`[ContentScript] Unknown message type: ${message.type}`);
            // Don't respond to unknown types
            return false;
        }

        return true; // Will respond asynchronously
      } catch (error) {
        console.error('[ContentScript] Error handling message:', error);
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        return true;
      }
    });
  }

  private _handleHealthCheck(sendResponse: (response: any) => void): void {
    sendResponse({
      success: true,
      service: this.service,
      timestamp: Date.now(),
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
    if (this.service !== 'netflix') {
      sendResponse({ success: true, data: null });
      return;
    }

    (async () => {
      try {
        const title = this._extractNetflixTitle();
        if (title) {
          await this._storeNetflixTitle(title);
          sendResponse({ success: true, data: title });
        } else {
          const stored = await this._getStoredNetflixTitle();
          sendResponse({ success: true, data: stored });
        }
      } catch (error) {
        const stored = await this._getStoredNetflixTitle();
        sendResponse({ success: true, data: stored });
      }
    })();
  }

  private _getVideoElement(): HTMLVideoElement | null {
    return document.querySelector('video');
  }

  private _startVideoMonitoring(): void {
    const pollInterval = setInterval(() => {
      const video = this._getVideoElement();
      if (!video) return;

      this.videoState = {
        videoId: null,
        currentTime: video.currentTime,
        duration: video.duration,
        isPlaying: !video.paused,
      };
    }, 500);
  }

  // Netflix-specific methods
  private _extractNetflixTitle(): string | null {
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
