/**
 * Hang Time - Twitch Service
 * Detects if user is streaming via Twitch API
 */

import { Activity, IServiceModule, OAuthToken } from '../../types';
import { StorageManager } from '../storage';
import { configManager } from '../config';
import { generateSecureRandom, secureLog, validateOAuthToken } from '../security-utils';

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
      secureLog.debug('Twitch', 'No valid token available');
      return null;
    }

    try {
      const config = await configManager.getTwitchConfig();

      // Get user info first to get their ID
      const userResponse = await fetch(`${TwitchService.API_BASE}/users`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-ID': config.client_id,
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
          'Client-ID': config.client_id,
        },
      });

      if (!streamResponse.ok) {
        secureLog.error('Twitch', `Stream check failed: ${streamResponse.status}`);
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
      secureLog.error('Twitch', 'Failed to get stream info', error);
      return null;
    }
  }

  async hasToken(): Promise<boolean> {
    const token = await this.storage.getOAuthToken('twitch');
    return !!token;
  }

  async clearToken(): Promise<void> {
    await this.storage.clearOAuthToken('twitch');
    secureLog.debug('Twitch', 'Token cleared');
  }

  async getAuthUrl(): Promise<string> {
    try {
      // Use cryptographically secure random state
      const state = generateSecureRandom(32);

      // Store state for validation
      await this.storage.set('twitch_auth_state', state);

      // Get configuration securely
      const config = await configManager.getTwitchConfig();

      const params = new URLSearchParams({
        client_id: config.client_id,
        redirect_uri: TwitchService.REDIRECT_URI,
        response_type: 'code',
        scope: TwitchService.SCOPE,
        state,
      });

      return `${TwitchService.AUTH_BASE}?${params}`;
    } catch (error) {
      secureLog.error('Twitch', 'Failed to generate auth URL', error);
      throw error;
    }
  }

  async handleAuthCallback(code: string): Promise<void> {
    try {
      const config = await configManager.getTwitchConfig();

      const response = await fetch(TwitchService.TOKEN_BASE, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: config.client_id,
          client_secret: config.client_secret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: TwitchService.REDIRECT_URI,
        }),
      });

      if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.status}`);
      }

      const data = await response.json();

      // Validate token response
      const validation = validateOAuthToken(data);
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      const token: OAuthToken = {
        service: 'twitch',
        access_token: data.access_token,
        expires_at: Date.now() + data.expires_in * 1000,
        scopes: [TwitchService.SCOPE],
        stored_at: Date.now(),
      };

      await this.storage.setOAuthToken('twitch', token);
      secureLog.debug('Twitch', 'Token stored successfully');
    } catch (error) {
      secureLog.error('Twitch', 'Failed to handle auth callback', error);
      throw error;
    }
  }

  private async _getValidToken(): Promise<string | null> {
    const token = await this.storage.getOAuthToken('twitch');

    if (!token) return null;

    // Check if token is still valid (with 60-second buffer)
    const REFRESH_BUFFER_MS = 60000;
    if (token.expires_at > Date.now() + REFRESH_BUFFER_MS) {
      return token.access_token;
    }

    // Twitch tokens don't refresh - user must re-auth when expired
    // Token expired or about to expire
    await this.clearToken();
    return null;
  }
}
