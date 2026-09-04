/**
 * Hang Time - Xbox Service
 * Detects currently playing game and syncs game library via OpenXBL (xbl.io) API
 */

import { Activity, IServiceModule, OwnedGame } from '../../types';
import { StorageManager } from '../storage';
import { generateActivityId } from '../activity-utils';

export interface OpenXBLAccountInfo {
  xuid: string;
  gamertag: string;
  avatarUrl?: string;
}

export interface OpenXBLTitle {
  titleId: string;
  name: string;
  type?: string;
  devices?: string[];
  displayImage?: string;
  modernTitleId?: string;
  productId?: string;
}

export class XboxService implements IServiceModule {
  private static readonly API_BASE = 'https://xbl.io/api/v2';
  private static readonly CACHE_TTL_MS = 30000; // 30-second TTL
  private cachedResult: Activity | null = null;
  private cacheTimestamp: number = 0;

  constructor(private storage: StorageManager) {}

  async isEnabled(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    if (!profile) return false;
    return Boolean(profile.services_enabled['xbox-api'] && profile.xbox_config?.enabled);
  }

  async hasToken(): Promise<boolean> {
    const profile = await this.storage.getUserProfile();
    return Boolean(profile?.xbox_config?.api_key);
  }

  async clearToken(): Promise<void> {
    const profile = await this.storage.getUserProfile();
    if (profile && profile.xbox_config) {
      profile.xbox_config.enabled = false;
      profile.xbox_config.api_key = undefined;
      profile.xbox_config.xuid = undefined;
      await this.storage.setUserProfile(profile);
    }
  }

  async getAuthUrl(): Promise<string> {
    return 'https://xbl.io';
  }

  async handleAuthCallback(_code: string): Promise<void> {
    // OpenXBL uses direct user API keys, not standard redirect OAuth
  }

  /**
   * Verify OpenXBL API key and retrieve account details
   */
  async verifyApiKey(apiKey: string): Promise<OpenXBLAccountInfo | null> {
    try {
      const response = await fetch(`${XboxService.API_BASE}/account`, {
        headers: {
          'X-Authorization': apiKey,
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        console.warn(`[Xbox] API verification failed with status: ${response.status}`);
        return null;
      }

      const data = await response.json();
      const payload = data?.content ?? data;
      const profileUsers = payload?.profileUsers?.[0] || data?.profileUsers?.[0];
      if (!profileUsers) {
        return null;
      }

      const xuid = profileUsers.id;
      const gamertagSetting = profileUsers.settings?.find((s: any) => s.id === 'Gamertag');
      const gamertag = gamertagSetting?.value || 'Xbox User';

      return {
        xuid,
        gamertag,
      };
    } catch (error) {
      console.error('[Xbox] Error verifying OpenXBL API key:', error);
      return null;
    }
  }

  /**
   * Fetch currently playing game presence via OpenXBL
   */
  async getCurrentActivity(): Promise<Activity | null> {
    const now = Date.now();
    if (this.cachedResult !== null && now - this.cacheTimestamp < XboxService.CACHE_TTL_MS) {
      return this.cachedResult;
    }

    const profile = await this.storage.getUserProfile();
    const apiKey = profile?.xbox_config?.api_key;
    if (!apiKey) {
      return null;
    }

    try {
      const response = await fetch(`${XboxService.API_BASE}/presence`, {
        headers: {
          'X-Authorization': apiKey,
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        return null;
      }

      const rawData = await response.json();
      const payload = rawData?.content ?? rawData;
      const userPresence = Array.isArray(payload) ? payload[0] : (payload?.presence || payload);

      if (!userPresence || userPresence.state !== 'Online') {
        this.cachedResult = null;
        this.cacheTimestamp = now;
        return null;
      }

      // Look for active game in devices/title
      const title = userPresence.lastSeen?.titleName || userPresence.devices?.[0]?.titles?.[0]?.name;
      const titleId = userPresence.lastSeen?.titleId || userPresence.devices?.[0]?.titles?.[0]?.id;

      if (!title || title.toLowerCase() === 'home' || title.toLowerCase() === 'dashboard') {
        this.cachedResult = null;
        this.cacheTimestamp = now;
        return null;
      }

      const activity: Activity = {
        id: generateActivityId('xbox-api', titleId || title),
        service: 'xbox-api' as any,
        content: title,
        timestamp: Date.now(),
        freshness_timestamp: Date.now(),
        state: 'playing',
        metadata: {
          titleId,
          gamertag: profile?.xbox_config?.gamertag,
          storefront: 'xbox',
        },
      };

      this.cachedResult = activity;
      this.cacheTimestamp = now;
      return activity;
    } catch (error) {
      console.error('[Xbox] Failed to get presence:', error);
      return null;
    }
  }

  /**
   * Fetch owned game titles via OpenXBL (tries achievements, titles, and titlehub endpoints)
   */
  async fetchOwnedTitles(): Promise<OwnedGame[]> {
    const profile = await this.storage.getUserProfile();
    const apiKey = profile?.xbox_config?.api_key;
    if (!apiKey) {
      return [];
    }

    const candidateEndpoints = [
      `${XboxService.API_BASE}/achievements`,
      `${XboxService.API_BASE}/titles`,
      `${XboxService.API_BASE}/titlehub/titles`,
      `${XboxService.API_BASE}/player/title-history`,
    ];

    for (const endpoint of candidateEndpoints) {
      try {
        console.debug(`[Xbox] Fetching titles from: ${endpoint}`);
        const response = await fetch(endpoint, {
          headers: {
            'X-Authorization': apiKey,
            Accept: 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });

        if (!response.ok) {
          console.debug(`[Xbox] Endpoint ${endpoint} returned status: ${response.status}`);
          continue;
        }

        const data = await response.json();
        const payload = data?.content ?? data;
        const rawTitles: any[] = Array.isArray(payload)
          ? payload
          : payload?.titles || payload?.results || data?.titles || data?.results || [];

        if (!Array.isArray(rawTitles) || rawTitles.length === 0) {
          console.debug(`[Xbox] Endpoint ${endpoint} returned 0 titles`);
          continue;
        }

        const ownedGames: OwnedGame[] = [];
        const seenIds = new Set<string>();

        for (const title of rawTitles) {
          const name = title.name || title.titleName;
          if (!name || title.type === 'Application' || name === 'Home' || name === 'Dashboard') {
            continue;
          }

          const rawId = title.titleId || title.id || title.modernTitleId || title.productId || name;
          const titleId = String(rawId);

          if (seenIds.has(titleId)) {
            continue;
          }
          seenIds.add(titleId);

          const lastPlayedSec = title.titleHistory?.lastTimePlayed
            ? Math.floor(new Date(title.titleHistory.lastTimePlayed).getTime() / 1000)
            : title.lastUnlock
            ? Math.floor(new Date(title.lastUnlock).getTime() / 1000)
            : 0;

          ownedGames.push({
            appId: `xbox_${titleId}`,
            titleId,
            name,
            storefront: 'xbox',
            platformsOwned: {
              windows: true,
              xbox: true,
            },
            rtime_last_played: lastPlayedSec,
            lastUpdated: Date.now(),
          });
        }

        if (ownedGames.length > 0) {
          console.log(`[Xbox] Successfully fetched ${ownedGames.length} titles from ${endpoint}`);
          return ownedGames;
        }
      } catch (endpointError) {
        console.warn(`[Xbox] Error querying endpoint ${endpoint}:`, endpointError);
      }
    }

    console.warn('[Xbox] Could not retrieve any titles from OpenXBL endpoints');
    return [];
  }
}
