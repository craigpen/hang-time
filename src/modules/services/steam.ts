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
    if (!profile) return null;

    // For MVP, Steam requires user to provide their Steam ID
    // This is typically fetched from user settings
    // For now, return null - user must configure Steam ID in settings
    console.debug('[Steam] Steam ID required in settings');
    return null;
  }

  async hasToken(): Promise<boolean> {
    // Steam uses public API, no token needed
    // But we need to check if user has configured their Steam ID
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;

    // TODO: Check if Steam ID is configured in user profile
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
      const params = new URLSearchParams({
        key: 'YOUR_STEAM_API_KEY', // TODO: Get from configuration
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
        return { service: 'idle', content: 'Idle', timestamp: Date.now(), metadata: {} };
      }

      // Check if player is currently playing a game
      if (!player.gameid) {
        return { service: 'idle', content: 'Idle', timestamp: Date.now(), metadata: {} };
      }

      return {
        service: 'steam',
        content: player.gameextrainfo || `Game ID: ${player.gameid}`,
        url: `steam://run/${player.gameid}`,
        timestamp: Date.now(),
        metadata: {
          title: player.gameextrainfo,
          steamId: player.steamid,
        },
      };
    } catch (error) {
      console.error('[Steam] Failed to fetch game info:', error);
      return null;
    }
  }
}
