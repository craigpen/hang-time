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
        },
      });

      if (!response.ok) {
        console.warn(`[Xbox] API verification failed with status: ${response.status}`);
        return null;
      }

      const data = await response.json();
      const profileUsers = data?.profileUsers?.[0];
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
        },
      });

      if (!response.ok) {
        return null;
      }

      const presenceData = await response.json();
      const userPresence = Array.isArray(presenceData) ? presenceData[0] : presenceData;

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
   * Fetch owned game titles via OpenXBL TitleHub
   */
  async fetchOwnedTitles(): Promise<OwnedGame[]> {
    const profile = await this.storage.getUserProfile();
    const apiKey = profile?.xbox_config?.api_key;
    if (!apiKey) {
      return [];
    }

    try {
      const response = await fetch(`${XboxService.API_BASE}/titlehub/titles`, {
        headers: {
          'X-Authorization': apiKey,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        console.warn(`[Xbox] Titlehub fetch failed with status: ${response.status}`);
        return [];
      }

      const data = await response.json();
      const titles: OpenXBLTitle[] = data?.titles || [];
      const ownedGames: OwnedGame[] = [];

      for (const title of titles) {
        // Filter out system apps and dashboards
        if (!title.name || title.type === 'Application' || title.name === 'Home' || title.name === 'Dashboard') {
          continue;
        }

        const titleId = title.titleId || title.modernTitleId || title.productId || String(title.name);

        ownedGames.push({
          appId: `xbox_${titleId}`,
          titleId,
          name: title.name,
          storefront: 'xbox',
          platformsOwned: {
            windows: true,
            xbox: true,
          },
          lastUpdated: Date.now(),
        });
      }

      return ownedGames;
    } catch (error) {
      console.error('[Xbox] Error fetching owned titles:', error);
      return [];
    }
  }
}
