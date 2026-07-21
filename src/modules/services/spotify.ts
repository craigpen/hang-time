/**
 * Hang Time - Spotify Service
 * Detects currently playing track via Spotify Web API
 */

import { Activity, IServiceModule, OAuthToken } from '../../types';
import { StorageManager } from '../storage';
import { configManager } from '../config';
import { generateSecureRandom, secureLog, validateOAuthToken } from '../security-utils';

export class SpotifyService implements IServiceModule {
  private static readonly API_BASE = 'https://api.spotify.com/v1';
  private static readonly AUTH_BASE = 'https://accounts.spotify.com/authorize';
  private static readonly TOKEN_BASE = 'https://accounts.spotify.com/api/token';
  private static readonly SCOPES = ['user-read-currently-playing', 'user-read-playback-state'];
  private static readonly REDIRECT_URI = 'https://[EXTENSION_ID].chromiumapp.org/oauth';

  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return profile.services_enabled.spotify;
  }

  async getCurrentActivity(): Promise<Activity | null> {
    const token = await this._getValidToken();
    if (!token) {
      secureLog.debug('Spotify', 'No valid token available');
      return null;
    }

    try {
      const response = await fetch(`${SpotifyService.API_BASE}/me/player/currently-playing`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          // Token expired
          await this.clearToken();
          return null;
        }
        secureLog.error('Spotify', `API error: ${response.status}`);
        return null;
      }

      const data = await response.json();

      // No track currently playing
      if (!data.item) {
        return { service: 'idle', content: 'Idle', timestamp: Date.now(), metadata: {} };
      }

      const track = data.item;
      const artist = track.artists?.[0]?.name || 'Unknown Artist';

      return {
        service: 'spotify',
        content: `${track.name}`,
        url: track.external_urls?.spotify,
        timestamp: Date.now(),
        metadata: {
          title: track.name,
          artist,
          duration: track.duration_ms,
          progress: data.progress_ms,
          thumbnailUrl: track.album?.images?.[0]?.url,
        },
      };
    } catch (error) {
      secureLog.error('Spotify', 'Failed to get current activity', error);
      return null;
    }
  }

  async hasToken(): Promise<boolean> {
    const token = await this.storage.getOAuthToken('spotify');
    return !!token;
  }

  async clearToken(): Promise<void> {
    await this.storage.clearOAuthToken('spotify');
    secureLog.debug('Spotify', 'Token cleared');
  }

  async getAuthUrl(): Promise<string> {
    try {
      // Use cryptographically secure random state
      const state = generateSecureRandom(32);
      const scopes = SpotifyService.SCOPES.join(' ');

      // Store state for validation
      await this.storage.set('spotify_auth_state', state);

      // Get configuration securely
      const config = await configManager.getSpotifyConfig();

      const params = new URLSearchParams({
        client_id: config.client_id,
        response_type: 'code',
        redirect_uri: SpotifyService.REDIRECT_URI,
        scope: scopes,
        state,
      });

      return `${SpotifyService.AUTH_BASE}?${params}`;
    } catch (error) {
      secureLog.error('Spotify', 'Failed to generate auth URL', error);
      throw error;
    }
  }

  async handleAuthCallback(code: string): Promise<void> {
    try {
      const config = await configManager.getSpotifyConfig();

      const response = await fetch(SpotifyService.TOKEN_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: SpotifyService.REDIRECT_URI,
          client_id: config.client_id,
          client_secret: config.client_secret,
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
        service: 'spotify',
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
        scopes: SpotifyService.SCOPES,
        stored_at: Date.now(),
      };

      await this.storage.setOAuthToken('spotify', token);
      secureLog.debug('Spotify', 'Token stored successfully');
    } catch (error) {
      secureLog.error('Spotify', 'Failed to handle auth callback', error);
      throw error;
    }
  }

  private async _getValidToken(): Promise<string | null> {
    const token = await this.storage.getOAuthToken('spotify');

    if (!token) return null;

    // Check if token is still valid (with 60-second buffer)
    const REFRESH_BUFFER_MS = 60000;
    if (token.expires_at > Date.now() + REFRESH_BUFFER_MS) {
      return token.access_token;
    }

    // Token expired or about to expire, try to refresh
    if (token.refresh_token) {
      try {
        await this._refreshToken(token.refresh_token);
        const newToken = await this.storage.getOAuthToken('spotify');
        return newToken?.access_token ?? null;
      } catch (error) {
        secureLog.error('Spotify', 'Token refresh failed', error);
        await this.clearToken();
        return null;
      }
    }

    // No refresh token, clear and return null
    await this.clearToken();
    return null;
  }

  private async _refreshToken(refreshToken: string): Promise<void> {
    try {
      const config = await configManager.getSpotifyConfig();

      const response = await fetch(SpotifyService.TOKEN_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: config.client_id,
          client_secret: config.client_secret,
        }),
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status}`);
      }

      const data = await response.json();

      // Validate token response
      const validation = validateOAuthToken(data);
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      const token: OAuthToken = {
        service: 'spotify',
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        expires_at: Date.now() + data.expires_in * 1000,
        scopes: SpotifyService.SCOPES,
        stored_at: Date.now(),
      };

      await this.storage.setOAuthToken('spotify', token);
      secureLog.debug('Spotify', 'Token refreshed successfully');
    } catch (error) {
      secureLog.error('Spotify', 'Token refresh error', error);
      throw error;
    }
  }
}
