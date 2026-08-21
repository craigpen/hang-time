/**
 * Hang Time - Generic Video Provider
 * Fallback provider for any HTML5 <video> element on arbitrary websites
 */

import { VideoProvider } from './types';
import { ServiceName } from '../../types';

export class GenericVideoProvider implements VideoProvider {
  readonly serviceName: ServiceName = 'video-tab';

  matches(_url: URL): boolean {
    return true; // Match anything as fallback
  }

  isValidWatchUrl(_url: URL): boolean {
    return true;
  }

  findVideoElement(): HTMLVideoElement | null {
    const videoElements = Array.from(document.querySelectorAll('video'));
    if (videoElements.length === 0) return null;

    const visibleVideos = videoElements.filter((v) => v.offsetWidth > 0 && v.offsetHeight > 0);

    const mainContentVideos = visibleVideos.filter((v) => {
      // Small videos are likely previews, banners, or ads
      if (v.offsetWidth < 640 || v.offsetHeight < 360) return false;

      // Filter short ads
      if (v.duration > 0 && v.duration < 60) return false;

      if (v.className.toLowerCase().includes('ad')) return false;
      let parent = v.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.className.toLowerCase().includes('ad')) return false;
        parent = parent.parentElement;
      }
      return true;
    });

    return mainContentVideos[0] || visibleVideos[0] || videoElements[0] || null;
  }

  extractTitle(_videoElement: HTMLVideoElement | null): string {
    let title = document.title || '';
    title = title
      .replace(/^▶ /, '')
      .trim();

    return title || 'Video';
  }

  getFavicon(): string | null {
    const link = document.querySelector("link[rel*='icon']") as HTMLLinkElement | null;
    return link?.href || null;
  }
}
