/**
 * Hang Time - Activity Utilities
 * Helper functions for activity processing (ID generation, parsing, etc.)
 */

/**
 * Fast non-cryptographic hash (FNV-1a)
 * Good for generating stable IDs without expensive crypto
 */
function fnv1aHash(str: string): string {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Extract stable identifier from URL based on service
 * Returns the core ID that won't change (video ID, track ID, app ID, channel name, etc.)
 */
function extractStableId(service: string, url?: string): string {
  if (!url) return '';

  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const search = urlObj.search;

    switch (service.toLowerCase()) {
      case 'youtube-tab':
        // Extract video ID from v parameter: watch?v=dQw4w9WgXcQ
        const videoIdMatch = search.match(/[?&]v=([^&]+)/);
        if (videoIdMatch && videoIdMatch[1]) return videoIdMatch[1];
        // Also try from URL path for youtu.be/xyz format
        const shortUrlMatch = pathname.match(/^\/([^/?]+)/);
        if (shortUrlMatch && shortUrlMatch[1]) return shortUrlMatch[1];
        break;

      case 'netflix-tab':
        // Extract title ID from path: /watch/80057281
        const netflixMatch = pathname.match(/\/watch\/(\d+)/);
        if (netflixMatch && netflixMatch[1]) return netflixMatch[1];
        break;

      case 'spotify-api':
        // Extract track/album ID from path: /track/3n3Ppam7vgaVa1iaRUc9Lp
        const spotifyMatch = pathname.match(/\/(track|album|playlist)\/([^/?]+)/);
        if (spotifyMatch && spotifyMatch[2]) return spotifyMatch[2];
        break;

      case 'twitch-api':
        // Extract channel name from path: /username
        const channelMatch = pathname.match(/^\/([^/?]+)/);
        if (channelMatch && channelMatch[1]) return channelMatch[1];
        break;

      case 'steam-api':
        // Extract app ID from steam:// URL: steam://run/730/
        const steamMatch = url.match(/steam:\/\/run\/(\d+)/);
        if (steamMatch && steamMatch[1]) return steamMatch[1];
        break;
    }
  } catch (error) {
    console.debug('[ActivityUtils] Failed to parse URL:', url, error);
  }

  return '';
}

/**
 * Generate a stable activity ID from service and URL
 * Used to uniquely identify activities across messages and storage
 * Synchronous, uses fast FNV-1a hash (not cryptographic)
 */
export function generateActivityId(service: string, url?: string): string {
  const stableId = extractStableId(service, url);
  if (!stableId) {
    // Fallback: use full URL if we couldn't extract a stable ID
    const fallback = `${service}:${url || 'unknown'}`;
    return fnv1aHash(fallback);
  }

  // Hash the service + stable ID to get the activity ID
  const input = `${service.toLowerCase()}:${stableId}`;
  return fnv1aHash(input);
}

/**
 * Check if two activities are the same based on their service and URL
 */
export function isSameActivity(activity1: { service: string; url?: string }, activity2: { service: string; url?: string }): boolean {
  if (activity1.service !== activity2.service) return false;
  if (!activity1.url || !activity2.url) return activity1.url === activity2.url;

  // Compare stable IDs instead of full URLs
  const id1 = extractStableId(activity1.service, activity1.url);
  const id2 = extractStableId(activity2.service, activity2.url);

  return id1 === id2 && id1 !== '';
}

/**
 * Get the action verb for an activity based on service type
 * Returns: 'play' for games, 'watch' for video/streams, 'listen' for audio
 */
export function getActivityVerb(service: string): 'play' | 'watch' | 'listen' {
  switch (service.toLowerCase()) {
    case 'steam-api':
      return 'play';
    case 'spotify-api':
      return 'listen';
    case 'youtube-tab':
    case 'youtube':
    case 'netflix-tab':
    case 'netflix':
    case 'twitch-api':
    case 'twitch-tab':
    case 'twitch':
      return 'watch';
    default:
      return 'watch';
  }
}
