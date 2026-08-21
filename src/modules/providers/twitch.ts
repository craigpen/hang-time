/**
 * Hang Time - Twitch Video Provider
 * Handles Twitch live stream and VOD detection, filtering directory paths
 */

import { VideoProvider } from './types';
import { ServiceName } from '../../types';

export class TwitchProvider implements VideoProvider {
  readonly serviceName: ServiceName = 'twitch-tab';

  matches(url: URL): boolean {
    return url.hostname.toLowerCase().includes('twitch.tv');
  }

  isValidWatchUrl(url: URL): boolean {
    const pathname = url.pathname.toLowerCase();
    if (
      pathname === '/' ||
      pathname === '' ||
      pathname.startsWith('/search') ||
      pathname.startsWith('/directory') ||
      pathname.startsWith('/settings')
    ) {
      return false;
    }
    return true;
  }

  findVideoElement(): HTMLVideoElement | null {
    const videoElements = Array.from(document.querySelectorAll('video'));
    if (videoElements.length === 0) return null;

    const visibleVideos = videoElements.filter((v) => v.offsetWidth > 0 && v.offsetHeight > 0);
    return visibleVideos[0] || videoElements[0] || null;
  }

  extractTitle(_videoElement: HTMLVideoElement | null): string {
    // Try stream title heading in channel layout
    const streamTitleElem = document.querySelector("h2[data-a-target='stream-title']");
    if (streamTitleElem?.textContent?.trim()) {
      return streamTitleElem.textContent.trim();
    }

    let docTitle = document.title || '';
    docTitle = docTitle
      .replace(/ on Twitch$/, '')
      .replace(/ - Twitch$/, '')
      .replace(/^▶ /, '')
      .trim();

    return docTitle || 'Twitch Stream';
  }

  getFavicon(): string | null {
    return 'https://static.twitchcdn.net/assets/favicon-32-e29e246c124e4304bc93.png';
  }
}
