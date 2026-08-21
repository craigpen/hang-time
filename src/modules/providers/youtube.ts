/**
 * Hang Time - YouTube Video Provider
 * Handles YouTube video detection, ad filtering, and title extraction
 */

import { VideoProvider } from './types';
import { ServiceName } from '../../types';

export class YouTubeProvider implements VideoProvider {
  readonly serviceName: ServiceName = 'youtube-tab';

  matches(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return host.includes('youtube.com') || host.includes('youtu.be');
  }

  isValidWatchUrl(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    if (host.includes('youtu.be')) return true;
    const path = url.pathname.toLowerCase();
    return path.includes('/watch') || path.includes('/shorts/') || path.includes('/live/') || url.searchParams.has('v');
  }

  findVideoElement(): HTMLVideoElement | null {
    const videoElements = Array.from(document.querySelectorAll('video'));
    if (videoElements.length === 0) return null;

    const visibleVideos = videoElements.filter((v) => v.offsetWidth > 0 && v.offsetHeight > 0);

    // Filter out obvious YouTube ad players
    const mainContentVideos = visibleVideos.filter((v) => {
      // Small dimensions indicate preview/ad widget
      if (v.offsetWidth < 640 || v.offsetHeight < 360) return false;

      // Short duration while playing indicates ad
      if (v.duration > 0 && v.duration < 60) return false;

      // Ad container check
      if (v.className.toLowerCase().includes('ad')) return false;
      let parent = v.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const cls = parent.className.toLowerCase();
        if (cls.includes('ad-container') || cls.includes('video-ads') || cls.includes('ytp-ad-module')) {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    });

    return mainContentVideos[0] || visibleVideos[0] || videoElements[0] || null;
  }

  extractTitle(_videoElement: HTMLVideoElement | null): string {
    // 1. Try modern YouTube video title element
    const primaryTitle = document.querySelector('#title h1.ytd-watch-metadata yt-formatted-string');
    if (primaryTitle?.textContent?.trim()) {
      return primaryTitle.textContent.trim();
    }

    // 2. Try classic YouTube watch title
    const legacyTitle = document.querySelector('h1.title.style-scope.ytd-video-primary-info-renderer');
    if (legacyTitle?.textContent?.trim()) {
      return legacyTitle.textContent.trim();
    }

    // 3. Fallback to document title
    let title = document.title || '';
    title = title
      .replace(/ - YouTube$/, '')
      .replace(/^▶ /, '')
      .trim();

    return title || 'YouTube Video';
  }

  getFavicon(): string | null {
    return 'https://www.youtube.com/s/desktop/favicon.ico';
  }
}
