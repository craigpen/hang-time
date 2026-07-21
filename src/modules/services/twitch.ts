/**
 * Hang Time - Twitch Service
 * Detects if user is streaming via Twitch API
 */

import { Activity, IServiceModule, OAuthToken } from '../../types';
import { StorageManager } from '../storage';

export class TwitchService implements IServiceModule {
  private static readonly API_BASE = 'https://api.twitch.tv/helix';
  private static readonly AUTH_BASE = 'https://id.twitch.tv/oauth2/authorize';
  private static readonly TOKEN_BASE = 'https://id.twitch.tv/oauth2/token';
  private static readonly SCOPE = 'user:read:email';
  private static readonly REDIRECT_URI = 'https://[EXTENSION_ID].chromiumapp.org/oauth';

  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return profile.services_enabled.twitch;
  }

  async getCurrentActivity(): Promise<Activity | null> {
    const token = await this._getValidToken();
    if (!token) {
      console.debug('[Twitch] No valid token');
      return null;
    }

    try {
      // Get user info first to get their ID
      const userResponse = await fetch(`${TwitchService.API_BASE}/users`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-ID': 'YOUR_TWITCH_CLIENT_ID', // TODO: Get from config
        },
      });

      if (!userResponse.ok) {
        if (userResponse.status === 401) {
          await this.clearToken();
          return null;
        }
        return null;
      }

      const userData = await userResponse.json();
      const userId = userData.data?.[0]?.id;

      if (!userId) {
        return { service: 'idle', content: 'Idle', timestamp: Date.now(), metadata: {} };
      }

      // Check if user is streaming
      const streamResponse = await fetch(`${TwitchService.API_BASE}/streams?user_id=${userId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-ID': 'YOUR_TWITCH_CLIENT_ID',
        },
      });

      if (!streamResponse.ok) {
        console.error('[Twitch] Stream check failed:', streamResponse.status);
        return null;
      }

      const streamData = await streamResponse.json();
      const stream = streamData.data?.[0];

      if (!stream || !stream.is_live) {
        return { service: 'idle', content: 'Idle', timestamp: Date.now(), metadata: {} };
      }

      return {
        service: 'twitch',
        content: stream.title || stream.game_name || 'Twitch Stream',
        url: `https://twitch.tv/${stream.user_name}`,
        timestamp: Date.now(),
        metadata: {
          title: stream.title,
          game: stream.game_name,
          viewers: stream.viewer_count,
          thumbnailUrl: stream.thumbnail_url,
        },
      };
    } catch (error) {
      console.error('[Twitch] Failed to get stream info:', error);
      return null;
    }
  }

  async hasToken(): Promise<boolean> {
    const token = await this.storage.getOAuthToken('twitch');
    return !!token;
  }

  async clearToken(): Promise<void> {
    await this.storage.clearOAuthToken('twitch');
    console.debug('[Twitch] Token cleared');
  }

  async getAuthUrl(): Promise<string> {
    const state = Math.random().toString(36).substring(7);

    // Store state for validation
    await this.storage.set('twitch_auth_state', state);

    const params = new URLSearchParams({
      client_id: 'YOUR_TWITCH_CLIENT_ID', // TODO: Get from config
      redirect_uri: TwitchService.REDIRECT_URI,
      response_type: 'code',
      scope: TwitchService.SCOPE,
      state,
    });

    return `${TwitchService.AUTH_BASE}?${params}`;
  }

  async handleAuthCallback(code: string): Promise<void> {
    try {
      const response = await fetch(TwitchService.TOKEN_BASE, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'YOUR_TWITCH_CLIENT_ID', // TODO: Get from config
          client_secret: 'YOUR_TWITCH_CLIENT_SECRET', // TODO: Get from secure config
          code,
          grant_type: 'authorization_code',
          redirect_uri: TwitchService.REDIRECT_URI,
        }),
      });

      if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.status}`);
      }

      const data = await response.json();

      const token: OAuthToken = {
        service: 'twitch',
        access_token: data.access_token,
        expires_at: Date.now() + data.expires_in * 1000,
        scopes: [TwitchService.SCOPE],
        stored_at: Date.now(),
      };

      await this.storage.setOAuthToken('twitch', token);
      console.debug('[Twitch] Token stored');
    } catch (error) {
      console.error('[Twitch] Failed to handle auth callback:', error);
      throw error;
    }
  }

  private async _getValidToken(): Promise<string | null> {
    const token = await this.storage.getOAuthToken('twitch');

    if (!token) return null;

    // Twitch tokens don't refresh - user must re-auth when expired
    if (token.expires_at > Date.now()) {
      return token.access_token;
    }

    // Token expired
    await this.clearToken();
    return null;
  }
}
