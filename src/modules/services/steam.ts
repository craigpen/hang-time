/**
 * Hang Time - Steam Service
 * Detects currently playing game via Steam Web API
 */

import { Activity, IServiceModule } from '../../types';
import { StorageManager } from '../storage';

export class SteamService implements IServiceModule {
  private static readonly API_BASE = 'https://api.steampowered.com';
  private lastActivityTime: number = 0;
  private lastActivity: Activity | null = null;

  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return profile.services_enabled.steam;
  }

  async getCurrentActivity(): Promise<Activity | null> {
    const profile = await this.storage.getUserProfile();
    if (!profile || !profile.steam_id) {
      console.debug('[Steam] Steam ID not configured');
      return null;
    }

    return this._getCurrentlyPlayingGame(profile.steam_id);
  }

  async hasToken(): Promise<boolean> {
    // Steam uses public API, no token needed
    // Check if user has configured their Steam ID
    const profile = await this.storage.getUserProfile();
    return profile?.steam_id ? true : false;
  }

  async clearToken(): Promise<void> {
    // No token to clear
  }

  async getAuthUrl(): Promise<string> {
    // Steam doesn't use OAuth for Web API
    // User provides their Steam ID directly
    return '';
  }

  async handleAuthCallback(code: string): Promise<void> {
    // No OAuth callback to handle
  }

  /**
   * Get currently playing game for a Steam user
   * Requires the user's Steam ID to be configured
   *
   * Note: This requires "Public" game settings in Steam profile
   */
  private async _getCurrentlyPlayingGame(steamId: string): Promise<Activity | null> {
    try {
      const url = `${SteamService.API_BASE}/ISteamUser/GetPlayerSummaries/v0002/`;
      // Try with API key first if available, otherwise without
      const params = new URLSearchParams({
        steamids: steamId,
      });

      const response = await fetch(`${url}?${params}`);
      if (!response.ok) {
        console.error('[Steam] API error:', response.status);
        return null;
      }

      const data = await response.json();
      const player = data.response?.players?.[0];

      if (!player) {
        console.debug('[Steam] Player not found');
        return null;
      }

      // Check if player is currently playing a game
      if (!player.gameid) {
        console.debug('[Steam] No game currently playing');
        return null;
      }

      const gameName = player.gameextrainfo || `Game (${player.gameid})`;
      console.debug('[Steam] Currently playing:', gameName);

      return {
        service: 'steam',
        content: gameName,
        url: `steam://run/${player.gameid}`,
        timestamp: Date.now(),
        metadata: {
          title: gameName,
          steamId: player.steamid,
        },
      };
    } catch (error) {
      console.error('[Steam] Failed to fetch game info:', error);
      return null;
    }
  }
}
