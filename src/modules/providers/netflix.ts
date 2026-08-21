/**
 * Hang Time - Netflix Video Provider
 * Handles Netflix video detection, custom player UI selectors, and title extraction
 */

import { VideoProvider } from './types';
import { ServiceName } from '../../types';

export class NetflixProvider implements VideoProvider {
  readonly serviceName: ServiceName = 'netflix-tab';
  private cachedTitle: string | null = null;

  matches(url: URL): boolean {
    return url.hostname.toLowerCase().includes('netflix.com');
  }

  isValidWatchUrl(url: URL): boolean {
    return url.pathname.toLowerCase().includes('/watch');
  }

  findVideoElement(): HTMLVideoElement | null {
    const videoElements = Array.from(document.querySelectorAll('video'));
    if (videoElements.length === 0) return null;

    const visibleVideos = videoElements.filter((v) => v.offsetWidth > 0 && v.offsetHeight > 0);
    return visibleVideos[0] || videoElements[0] || null;
  }

  extractTitle(_videoElement: HTMLVideoElement | null): string {
    if (this.cachedTitle) {
      return this.cachedTitle;
    }

    const title = this._extractFromDom();
    if (title) {
      this.cachedTitle = title;
      return title;
    }

    let docTitle = document.title || '';
    docTitle = docTitle
      .replace(/ \| Netflix$/, '')
      .replace(/^▶ /, '')
      .trim();

    return docTitle || 'Netflix Video';
  }

  onVideoUnmounted(): void {
    this.cachedTitle = null;
  }

  getFavicon(): string | null {
    return 'https://assets.nflxext.com/us/ffe/siteui/common/icons/nficon2016.ico';
  }

  private _extractFromDom(): string | null {
    try {
      // Priority 1: data-uia='video-title' (used by Netflix player UI)
      const titleElements = document.querySelectorAll("[data-uia='video-title']");
      for (const elem of titleElements) {
        const parsed = this._parseNetflixTitleText(elem.textContent?.trim() || '');
        if (parsed && this._isValidNetflixTitle(parsed)) {
          return parsed;
        }
      }

      // Priority 2: Player title area
      const playerTitles = document.querySelectorAll("[data-uia='player-title'], [class*='player-title'], h2[role='heading']");
      for (const elem of playerTitles) {
        const text = elem.textContent?.trim();
        if (text && this._isValidNetflixTitle(text)) {
          return text;
        }
      }

      // Priority 3: h2 tags (skipping browse / menu containers)
      const h2Elements = document.querySelectorAll('h2');
      for (const h2 of h2Elements) {
        const text = h2.textContent?.trim();
        if (!text) continue;

        const parent = h2.closest('[class*="browse"], [class*="menu"], [data-uia*="menu"]');
        if (parent) continue;

        if (this._isValidNetflixTitle(text)) {
          return text;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private _parseNetflixTitleText(fullText: string): string | null {
    if (!fullText) return null;

    const parts = fullText.split(/\s+(?=Rated|Audio|Subtitles|CC|Closed|Available|IMDb|\d+%)/i);
    const firstPart = parts[0];
    if (!firstPart) return null;
    const title = firstPart.trim();

    if (/^Rated|^PG|^R$|^NC-17|^G$|^TV-|^\d+%|^IMDb|^Audio|^Subtitles|^CC|^Closed|^Available/i.test(title)) {
      return null;
    }

    return title || null;
  }

  private _isValidNetflixTitle(title: string): boolean {
    if (!title || title.length === 0 || title.length > 200) return false;

    const invalidPatterns = [
      /^netflix$/i,
      /^browse$/i,
      /^home$/i,
      /^my list$/i,
      /^search$/i,
      /^watch$/i,
      /^[0-9]+$/,
      /^[0-9]+m$/,
      /^[0-9]+h [0-9]+m$/,
      /^season [0-9]+/i,
      /^episode [0-9]+/i,
      /^rated /i,
      /^match /i,
      /^[0-9]+% match/i,
      /^hd$/i,
      /^ultra hd$/i,
      /^4k$/i,
      /^hdr$/i,
      /^spatial audio$/i,
      /^5\.1$/i,
      /^dolby/i,
      /^top 10/i,
      /^new$/i,
      /^recently added$/i,
      /^trending/i,
      /^popular/i,
      /^because you watched/i,
      /^continue watching/i,
    ];

    return !invalidPatterns.some((pattern) => pattern.test(title));
  }
}
