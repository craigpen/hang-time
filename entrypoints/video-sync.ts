/**
 * Hang Time - Video Sync Content Script
 * Runs on YouTube and Netflix pages to detect and sync video playback
 */

interface VideoSyncState {
  videoId: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  lastPublished: number;
  lastPlayingState: boolean; // Track previous state to detect changes
}

class VideoSyncContentScript {
  private state: VideoSyncState = {
    videoId: null,
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    lastPublished: 0,
    lastPlayingState: false,
  };

  private pollInterval: NodeJS.Timeout | null = null;
  private readonly PUBLISH_INTERVAL_MS = 15000; // Publish every 15 seconds (relay rate limit)

  init(): void {
    console.debug('[VideoSync] Content script initialized');

    // Detect page type and start monitoring
    if (this._isYoutubePage()) {
      this._setupYoutubeMonitoring();
    } else if (this._isNetflixPage()) {
      this._setupNetflixMonitoring();
    } else if (this._isTwitchPage()) {
      this._setupTwitchMonitoring();
    }

    // Listen for sync requests from extension
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this._handleMessage(message, sendResponse);
    });
  }

  private _isYoutubePage(): boolean {
    return /youtube\.com|youtu\.be/.test(window.location.hostname);
  }

  private _isNetflixPage(): boolean {
    return /netflix\.com/.test(window.location.hostname);
  }

  private _isTwitchPage(): boolean {
    return /twitch\.tv/.test(window.location.hostname);
  }

  private _setupYoutubeMonitoring(): void {
    console.debug('[VideoSync] Setting up YouTube monitoring');

    // Extract video ID from URL
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('v');

    if (!videoId) {
      console.warn('[VideoSync] Could not extract YouTube video ID');
      return;
    }

    this.state.videoId = videoId;

    // Poll for video element and track state
    this.pollInterval = setInterval(() => {
      const video = document.querySelector('video') as HTMLVideoElement | null;

      if (video) {
        this.state.currentTime = video.currentTime;
        this.state.duration = video.duration;
        this.state.isPlaying = !video.paused;

        // Send UPDATE_VIDEO_STATE immediately if play/pause state changed
        if (this.state.isPlaying !== this.state.lastPlayingState) {
          this.state.lastPlayingState = this.state.isPlaying;
          chrome.runtime.sendMessage({
            type: 'UPDATE_VIDEO_STATE',
            data: {
              service: this._getService(),
              isPlaying: this.state.isPlaying,
            },
          });
          console.debug(`[VideoSync] State change: ${this.state.isPlaying ? 'playing' : 'paused'}`);
        }

        // Publish sync if enough time has passed
        if (Date.now() - this.state.lastPublished > this.PUBLISH_INTERVAL_MS) {
          this._publishSync();
        }
      }
    }, 500);

    // Listen for sync events
    this._setupSyncListener();
  }

  private _setupNetflixMonitoring(): void {
    console.debug('[VideoSync] Setting up Netflix monitoring');

    // Netflix video ID is in URL
    const match = window.location.pathname.match(/\/watch\/(\d+)/);
    const videoId = match?.[1];

    if (!videoId) {
      console.warn('[VideoSync] Could not extract Netflix video ID');
      return;
    }

    this.state.videoId = videoId;

    // Poll for Netflix video element
    this.pollInterval = setInterval(() => {
      const video = document.querySelector('video') as HTMLVideoElement | null;

      if (video) {
        this.state.currentTime = video.currentTime;
        this.state.duration = video.duration;
        this.state.isPlaying = !video.paused;

        // Send UPDATE_VIDEO_STATE immediately if play/pause state changed
        if (this.state.isPlaying !== this.state.lastPlayingState) {
          this.state.lastPlayingState = this.state.isPlaying;
          chrome.runtime.sendMessage({
            type: 'UPDATE_VIDEO_STATE',
            data: {
              service: this._getService(),
              isPlaying: this.state.isPlaying,
            },
          });
          console.debug(`[VideoSync] State change: ${this.state.isPlaying ? 'playing' : 'paused'}`);
        }

        // Publish sync if enough time has passed
        if (Date.now() - this.state.lastPublished > this.PUBLISH_INTERVAL_MS) {
          this._publishSync();
        }
      }
    }, 500);

    // Listen for sync events
    this._setupSyncListener();
  }

  private _setupTwitchMonitoring(): void {
    console.debug('[VideoSync] Setting up Twitch monitoring');

    // Twitch channel name is in URL
    const match = window.location.pathname.match(/^\/([a-z0-9_]+)/i);
    const channelName = match?.[1];

    if (!channelName) {
      console.warn('[VideoSync] Could not extract Twitch channel name');
      return;
    }

    this.state.videoId = channelName;

    // Poll for Twitch video element
    this.pollInterval = setInterval(() => {
      const video = document.querySelector('video') as HTMLVideoElement | null;

      if (video) {
        this.state.currentTime = video.currentTime;
        this.state.duration = video.duration;
        this.state.isPlaying = !video.paused;

        // Send UPDATE_VIDEO_STATE immediately if play/pause state changed
        if (this.state.isPlaying !== this.state.lastPlayingState) {
          this.state.lastPlayingState = this.state.isPlaying;
          chrome.runtime.sendMessage({
            type: 'UPDATE_VIDEO_STATE',
            data: {
              service: this._getService(),
              isPlaying: this.state.isPlaying,
            },
          });
          console.debug(`[VideoSync] State change: ${this.state.isPlaying ? 'playing' : 'paused'}`);
        }

        // Publish sync if enough time has passed
        if (Date.now() - this.state.lastPublished > this.PUBLISH_INTERVAL_MS) {
          this._publishSync();
        }
      }
    }, 500);

    // Listen for sync events
    this._setupSyncListener();
  }

  private _setupSyncListener(): void {
    // Listen for sync requests from extension
    const checkSync = () => {
      chrome.runtime.sendMessage(
        { type: 'CHECK_VIDEO_SYNC' },
        (response: any) => {
          if (response?.success && response.data?.recommendedPosition !== undefined) {
            this._syncToPosition(response.data.recommendedPosition);
          }
        }
      );
    };

    // Check for sync every 10 seconds (reduce relay load)
    setInterval(checkSync, 10000);
  }

  private _syncToPosition(targetTime: number): void {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (!video) return;

    const diff = Math.abs(video.currentTime - targetTime);

    // Only sync if difference is significant (>2 seconds)
    if (diff > 2) {
      console.debug(`[VideoSync] Syncing to ${this._formatTime(targetTime)}`);
      video.currentTime = targetTime;

      // Show sync notification
      this._showSyncNotification(targetTime);
    }
  }

  private _publishSync(): void {
    if (!this.state.videoId) return;

    chrome.runtime.sendMessage(
      {
        type: 'PUBLISH_VIDEO_SYNC',
        data: {
          videoId: this.state.videoId,
          currentTime: this.state.currentTime,
          duration: this.state.duration,
          isPlaying: this.state.isPlaying,
          service: this._getService(),
        },
      },
      (response: any) => {
        if (response?.success) {
          this.state.lastPublished = Date.now();
        }
      }
    );

    // Also report the current play/pause state for activity detection
    chrome.runtime.sendMessage({
      type: 'UPDATE_VIDEO_STATE',
      data: {
        service: this._getService(),
        isPlaying: this.state.isPlaying,
      },
    });
  }

  private _handleMessage(message: any, sendResponse: (response: any) => void): void {
    switch (message.type) {
      case 'GET_VIDEO_STATE':
        sendResponse({
          success: true,
          data: {
            videoId: this.state.videoId,
            currentTime: this.state.currentTime,
            duration: this.state.duration,
            isPlaying: this.state.isPlaying,
          },
        });
        break;

      case 'SYNC_VIDEO':
        this._syncToPosition(message.data?.targetTime);
        sendResponse({ success: true });
        break;

      default:
        // Don't respond to unknown message types - let other content scripts handle them
        return;
    }
  }

  private _showSyncNotification(targetTime: number): void {
    // Create subtle notification
    const notif = document.createElement('div');
    notif.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background-color: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 12px 16px;
      border-radius: 4px;
      font-size: 14px;
      z-index: 10000;
      pointer-events: none;
    `;
    notif.textContent = `🔄 Synced to ${this._formatTime(targetTime)}`;
    document.body.appendChild(notif);

    // Remove after 2 seconds
    setTimeout(() => notif.remove(), 2000);
  }

  private _getService(): string {
    if (this._isYoutubePage()) return 'youtube';
    if (this._isNetflixPage()) return 'netflix';
    if (this._isTwitchPage()) return 'twitch';
    return 'unknown';
  }

  private _formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  destroy(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const sync = new VideoSyncContentScript();
    sync.init();
  });
} else {
  const sync = new VideoSyncContentScript();
  sync.init();
}
