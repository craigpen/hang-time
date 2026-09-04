/**
 * Hang Time - Auth & OAuth Message Router
 * Handles identity retrieval, OAuth authentication, connection status, and callback handling
 */

import { ExtensionResponse, ServiceName } from '../../types';
import { storageManager } from '../storage';
import { getIdentityManager } from '../identity';
import { SpotifyService } from '../services/spotify';
import { TwitchService } from '../services/twitch';

export class AuthRouter {
  static async getUserIdentifier(): Promise<ExtensionResponse> {
    try {
      const profile = await storageManager.getUserProfile();
      const identifier = await getIdentityManager().getIdentifier();
      if (profile) {
        if (!profile.uuid) {
          profile.uuid = identifier;
        }
        return { success: true, data: profile };
      }
      return { success: true, data: { uuid: identifier, identifier } };
    } catch (error) {
      return { success: false, error: 'Failed to get user identifier' };
    }
  }

  static async getOAuthStatus(service?: string): Promise<ExtensionResponse> {
    if (!service) return { success: false, error: 'service required' };
    try {
      const serviceTyped = service as ServiceName;
      let hasToken = false;

      if (serviceTyped === 'spotify-api') {
        const spotifyService = new SpotifyService(storageManager);
        hasToken = await spotifyService.hasToken();
      } else if (serviceTyped === 'twitch-api') {
        const twitchService = new TwitchService(storageManager);
        hasToken = await twitchService.hasToken();
      }

      return { success: true, data: { service, hasToken } };
    } catch (error) {
      return { success: false, error: 'Failed to get OAuth status' };
    }
  }

  static async authenticateService(service?: string): Promise<ExtensionResponse> {
    if (!service) return { success: false, error: 'service required' };
    try {
      const serviceTyped = service as ServiceName;
      let authUrl: string | null = null;

      if (serviceTyped === 'spotify-api') {
        const spotifyService = new SpotifyService(storageManager);
        authUrl = await spotifyService.getAuthUrl();
      } else if (serviceTyped === 'twitch-api') {
        const twitchService = new TwitchService(storageManager);
        authUrl = await twitchService.getAuthUrl();
      } else {
        return { success: false, error: `OAuth not supported for ${service}` };
      }

      return { success: true, data: { authUrl } };
    } catch (error) {
      return { success: false, error: 'Failed to get auth URL' };
    }
  }

  static async disconnectService(service?: string): Promise<ExtensionResponse> {
    if (!service) return { success: false, error: 'service required' };
    try {
      const serviceTyped = service as ServiceName;

      if (serviceTyped === 'spotify-api') {
        const spotifyService = new SpotifyService(storageManager);
        await spotifyService.clearToken();
      } else if (serviceTyped === 'twitch-api') {
        const twitchService = new TwitchService(storageManager);
        await twitchService.clearToken();
      } else {
        return { success: false, error: `Cannot disconnect from ${service}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: 'Failed to disconnect' };
    }
  }

  static async handleOAuthCallback(service?: string, code?: string): Promise<ExtensionResponse> {
    if (!service || !code) return { success: false, error: 'service and code required' };
    try {
      const serviceStr = service as string;

      if (serviceStr === 'spotify' || serviceStr === 'spotify-api') {
        const spotifyService = new SpotifyService(storageManager);
        await spotifyService.handleAuthCallback(code);
      } else if (serviceStr === 'twitch' || serviceStr === 'twitch-api') {
        const twitchService = new TwitchService(storageManager);
        await twitchService.handleAuthCallback(code);
      } else {
        return { success: false, error: `OAuth callback not supported for ${service}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to handle OAuth callback' };
    }
  }
}
