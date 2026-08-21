/**
 * Hang Time - Video Providers Unit Test Suite
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  VideoProviderRegistry,
  YouTubeProvider,
  NetflixProvider,
  TwitchProvider,
  GenericVideoProvider,
  VideoProvider,
} from '../index';

describe('Video Providers & Registry', () => {
  beforeEach(() => {
    document.title = 'Test Video Page';
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('YouTubeProvider', () => {
    const provider = new YouTubeProvider();

    it('matches youtube.com and youtu.be domains', () => {
      expect(provider.matches(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe(true);
      expect(provider.matches(new URL('https://youtu.be/dQw4w9WgXcQ'))).toBe(true);
      expect(provider.matches(new URL('https://m.youtube.com/watch?v=123'))).toBe(true);
      expect(provider.matches(new URL('https://netflix.com/watch/123'))).toBe(false);
      expect(provider.matches(new URL('https://vimeo.com/12345'))).toBe(false);
    });

    it('validates watch URLs', () => {
      expect(provider.isValidWatchUrl(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe(true);
      expect(provider.isValidWatchUrl(new URL('https://youtu.be/dQw4w9WgXcQ'))).toBe(true);
      expect(provider.isValidWatchUrl(new URL('https://www.youtube.com/shorts/abcdef12345'))).toBe(true);
      expect(provider.isValidWatchUrl(new URL('https://www.youtube.com/live/xyz123'))).toBe(true);
      expect(provider.isValidWatchUrl(new URL('https://www.youtube.com/feed/subscriptions'))).toBe(false);
    });

    it('extracts title from primary metadata element', () => {
      document.body.innerHTML = `
        <div id="title">
          <h1 class="ytd-watch-metadata">
            <yt-formatted-string>Never Gonna Give You Up</yt-formatted-string>
          </h1>
        </div>
      `;
      expect(provider.extractTitle(null)).toBe('Never Gonna Give You Up');
    });

    it('falls back to document title with YouTube suffix stripped', () => {
      document.title = '▶ Rick Astley - Video - YouTube';
      expect(provider.extractTitle(null)).toBe('Rick Astley - Video');
    });
  });

  describe('NetflixProvider', () => {
    const provider = new NetflixProvider();

    beforeEach(() => {
      provider.onVideoUnmounted();
    });

    it('matches netflix.com domain', () => {
      expect(provider.matches(new URL('https://www.netflix.com/watch/80057281'))).toBe(true);
      expect(provider.matches(new URL('https://youtube.com/watch?v=123'))).toBe(false);
    });

    it('validates watch URLs', () => {
      expect(provider.isValidWatchUrl(new URL('https://www.netflix.com/watch/80057281'))).toBe(true);
      expect(provider.isValidWatchUrl(new URL('https://www.netflix.com/browse'))).toBe(false);
    });

    it('extracts title from data-uia video-title element and cleans metadata', () => {
      document.body.innerHTML = `
        <div data-uia="video-title">
          Stranger Things S1:E1 Rated TV-14 4K Ultra HD
        </div>
      `;
      const title = provider.extractTitle(null);
      expect(title).toBe('Stranger Things S1:E1');
    });

    it('caches extracted title until video unmount', () => {
      document.body.innerHTML = `
        <div data-uia="video-title">
          Breaking Bad S1:E1
        </div>
      `;
      expect(provider.extractTitle(null)).toBe('Breaking Bad S1:E1');

      // Clear DOM to simulate UI hiding
      document.body.innerHTML = '';
      // Still returns cached title
      expect(provider.extractTitle(null)).toBe('Breaking Bad S1:E1');

      // After unmounted hook, cache is cleared
      provider.onVideoUnmounted();
      document.title = 'Breaking Bad | Netflix';
      expect(provider.extractTitle(null)).toBe('Breaking Bad');
    });
  });

  describe('TwitchProvider', () => {
    const provider = new TwitchProvider();

    it('matches twitch.tv domain', () => {
      expect(provider.matches(new URL('https://www.twitch.tv/shroud'))).toBe(true);
      expect(provider.matches(new URL('https://youtube.com/watch?v=123'))).toBe(false);
    });

    it('validates watch URLs against directory and search paths', () => {
      expect(provider.isValidWatchUrl(new URL('https://www.twitch.tv/shroud'))).toBe(true);
      expect(provider.isValidWatchUrl(new URL('https://www.twitch.tv/directory/game/Valorant'))).toBe(false);
      expect(provider.isValidWatchUrl(new URL('https://www.twitch.tv/search?term=fps'))).toBe(false);
      expect(provider.isValidWatchUrl(new URL('https://www.twitch.tv/'))).toBe(false);
    });

    it('extracts title from stream title heading', () => {
      document.body.innerHTML = `
        <h2 data-a-target="stream-title">RANK 1 VALORANT GRIND</h2>
      `;
      expect(provider.extractTitle(null)).toBe('RANK 1 VALORANT GRIND');
    });

    it('falls back to document title without on Twitch suffix', () => {
      document.title = 'shroud playing VALORANT on Twitch';
      expect(provider.extractTitle(null)).toBe('shroud playing VALORANT');
    });
  });

  describe('GenericVideoProvider', () => {
    const provider = new GenericVideoProvider();

    it('matches any URL and watch URL as universal fallback', () => {
      expect(provider.matches(new URL('https://vimeo.com/123456'))).toBe(true);
      expect(provider.matches(new URL('https://disneyplus.com/video/123'))).toBe(true);
      expect(provider.isValidWatchUrl(new URL('https://vimeo.com/123456'))).toBe(true);
    });

    it('extracts clean title from document title', () => {
      document.title = '▶ Big Buck Bunny 4K';
      expect(provider.extractTitle(null)).toBe('Big Buck Bunny 4K');
    });
  });

  describe('VideoProviderRegistry', () => {
    it('resolves correct provider by domain in priority order', () => {
      const registry = new VideoProviderRegistry();

      const yt = registry.getProvider('https://www.youtube.com/watch?v=123');
      expect(yt.serviceName).toBe('youtube-tab');
      expect(yt).toBeInstanceOf(YouTubeProvider);

      const netflix = registry.getProvider('https://www.netflix.com/watch/123');
      expect(netflix.serviceName).toBe('netflix-tab');
      expect(netflix).toBeInstanceOf(NetflixProvider);

      const twitch = registry.getProvider('https://www.twitch.tv/shroud');
      expect(twitch.serviceName).toBe('twitch-tab');
      expect(twitch).toBeInstanceOf(TwitchProvider);

      const generic = registry.getProvider('https://vimeo.com/12345');
      expect(generic.serviceName).toBe('video-tab');
      expect(generic).toBeInstanceOf(GenericVideoProvider);
    });

    it('supports registering new custom providers ahead of generic fallback', () => {
      const registry = new VideoProviderRegistry();

      class DisneyPlusProvider implements VideoProvider {
        readonly serviceName = 'video-tab' as const;
        matches(url: URL) {
          return url.hostname.includes('disneyplus.com');
        }
        isValidWatchUrl(url: URL) {
          return url.pathname.includes('/video/');
        }
        findVideoElement() {
          return null;
        }
        extractTitle() {
          return 'The Mandalorian';
        }
      }

      registry.registerProvider(new DisneyPlusProvider());

      const disney = registry.getProvider('https://www.disneyplus.com/video/abcdef');
      expect(disney).toBeInstanceOf(DisneyPlusProvider);
      expect(disney.extractTitle(null)).toBe('The Mandalorian');

      // Generic fallback still works for others
      const generic = registry.getProvider('https://vimeo.com/999');
      expect(generic).toBeInstanceOf(GenericVideoProvider);
    });
  });
});
