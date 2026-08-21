/**
 * Hang Time - Video Provider Registry
 * Resolves the appropriate VideoProvider for any given URL
 */

import { VideoProvider } from './types';
import { YouTubeProvider } from './youtube';
import { NetflixProvider } from './netflix';
import { TwitchProvider } from './twitch';
import { GenericVideoProvider } from './generic';

export class VideoProviderRegistry {
  private providers: VideoProvider[] = [];

  constructor(customProviders?: VideoProvider[]) {
    if (customProviders && customProviders.length > 0) {
      this.providers = [...customProviders];
    } else {
      // Default registration order: specific streaming platforms first, generic fallback last
      this.providers = [
        new YouTubeProvider(),
        new NetflixProvider(),
        new TwitchProvider(),
        new GenericVideoProvider(),
      ];
    }
  }

  /**
   * Register a new video provider at the front of the list (higher priority than generic)
   */
  registerProvider(provider: VideoProvider): void {
    // Insert before the generic fallback (last item)
    const genericIndex = this.providers.findIndex((p) => p instanceof GenericVideoProvider);
    if (genericIndex >= 0) {
      this.providers.splice(genericIndex, 0, provider);
    } else {
      this.providers.unshift(provider);
    }
  }

  /**
   * Resolve the best matching VideoProvider for the URL
   */
  getProvider(url: URL | string): VideoProvider {
    const parsedUrl = typeof url === 'string' ? new URL(url) : url;
    for (const provider of this.providers) {
      if (provider.matches(parsedUrl)) {
        return provider;
      }
    }
    // Fallback if no provider matched
    return new GenericVideoProvider();
  }

  /**
   * Get all registered providers
   */
  getAllProviders(): VideoProvider[] {
    return [...this.providers];
  }
}
