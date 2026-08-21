/**
 * Hang Time - Steam Service
 * Detects currently playing game via Steam Web API
 */

import { Activity, IServiceModule } from '../../types';
import { StorageManager } from '../storage';
import { generateActivityId } from '../activity-utils';

export class SteamService implements IServiceModule {
  private static readonly API_BASE = 'https://api.steampowered.com';
  private static readonly CACHE_TTL_MS = 30000; // 30 second cache to reduce API calls
  private cachedResult: Activity | null = null;
  private cacheTimestamp: number = 0;

  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return Boolean(profile.services_enabled['steam-api'] && profile.steam_config?.enabled);
  }

  async getCurrentActivity(): Promise<Activity | null> {
    // Check cache first (30 second TTL to reduce API calls)
    const now = Date.now();
    if (this.cachedResult !== undefined && now - this.cacheTimestamp < SteamService.CACHE_TTL_MS) {
      console.debug('[Steam] Using cached result (age:', now - this.cacheTimestamp, 'ms)');
      return this.cachedResult;
    }

    const profile = await this.storage.getUserProfile();
    if (!profile?.steam_config?.steam_id) {
      console.debug('[Steam] Steam ID not configured');
      return null;
    }

    const result = await this._getCurrentlyPlayingGame(profile.steam_config.steam_id);

    // Update cache
    this.cachedResult = result;
    this.cacheTimestamp = Date.now();

    return result;
  }

  async hasToken(): Promise<boolean> {
    // For API key method, check if key is configured
    // For OAuth method (future), check if token exists
    const profile = await this.storage.getUserProfile();
    if (!profile?.steam_config) return false;

    if (profile.steam_config.connection_type === 'api_key') {
      return profile.steam_config.api_key ? true : false;
    } else if (profile.steam_config.connection_type === 'oauth') {
      return profile.steam_config.oauth_token ? true : false;
    }
    return false;
  }

  async clearToken(): Promise<void> {
    // No token to clear
  }

  async getAuthUrl(): Promise<string> {
    // Steam doesn't use OAuth for Web API
    // User provides their Steam ID directly
    return '';
  }

  async handleAuthCallback(_code: string): Promise<void> {
    // No OAuth callback to handle
  }

  /**
   * Get currently playing game for a Steam user
   * Requires the user's Steam ID to be configured
   *
   * Note: This requires "Public" game settings in Steam profile
   */
  private async _getCurrentlyPlayingGame(steamId: string): Promise<Activity | null> {
    const stored = await this.storage.getMyActivities();
    const storedSteam = stored['steam-api'];
    const profile = await this.storage.getUserProfile();

    console.debug('[Steam] Profile steam_config:', profile?.steam_config ? 'present' : 'missing');
    if (profile?.steam_config) {
      console.debug('[Steam] steam_id present:', !!profile.steam_config.steam_id);
      console.debug('[Steam] api_key present:', !!profile.steam_config.api_key);
    }

    try {
      const url = `${SteamService.API_BASE}/ISteamUser/GetPlayerSummaries/v0002/`;
      const params = new URLSearchParams({
        steamids: steamId,
      });

      // Add API key if configured
      if (profile?.steam_config?.api_key) {
        params.append('key', profile.steam_config.api_key);
        console.debug('[Steam] API key added to request');
      } else {
        console.warn('[Steam] No API key configured - steam_config:', profile?.steam_config);
      }

      const fullUrl = `${url}?${params}`;
      console.debug('[Steam] Calling API with steamid:', steamId.substring(0, 8) + '...');

      const response = await fetch(fullUrl);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Steam] API error:', response.status, errorText);
        // Fall back to stored activity on API error
        if (storedSteam) {
          return {
            ...storedSteam,
            is_fresh: false,
            freshness_timestamp: storedSteam.freshness_timestamp || Date.now(),
          };
        }
        return null;
      }

      const data = await response.json();
      console.debug('[Steam] API response:', data);
      const player = data.response?.players?.[0];

      if (!player) {
        console.debug('[Steam] Player not found');
        // Fall back to stored activity
        if (storedSteam) {
          return {
            ...storedSteam,
            is_fresh: false,
            freshness_timestamp: storedSteam.freshness_timestamp || Date.now(),
          };
        }
        return null;
      }

      console.debug('[Steam] Player data:', player);

      // Check if player is currently playing a game
      if (!player.gameid) {
        console.debug('[Steam] No game currently playing (gameid missing from response)');
        // No game playing - remove stored activity by returning null
        // (ActivityDetector will handle cleanup)
        return null;
      }

      const gameName = player.gameextrainfo || `Game (${player.gameid})`;
      console.debug('[Steam] Currently playing:', gameName);

      const now = Date.now();
      const steamUrl = `steam://run/${player.gameid}`;
      const activityId = generateActivityId('steam-api', steamUrl);
      const contentTimestamp = (storedSteam && storedSteam.id === activityId && storedSteam.contentTimestamp)
        ? storedSteam.contentTimestamp
        : now;

      return {
        id: activityId,
        service: 'steam-api',
        content: gameName,
        url: steamUrl,
        state: 'playing',
        timestamp: now,
        contentTimestamp: contentTimestamp,
        freshness_timestamp: now,
        is_fresh: true,
        metadata: {
          title: gameName,
          steamId: player.steamid,
          appid: player.gameid ? parseInt(player.gameid, 10) : undefined,
        },
      };
    } catch (error) {
      console.error('[Steam] Failed to fetch game info:', error);
      // Fall back to stored activity on error
      if (storedSteam) {
        return {
          ...storedSteam,
          is_fresh: false,
          freshness_timestamp: storedSteam.freshness_timestamp || Date.now(),
        };
      }
      return null;
    }
  }
}
