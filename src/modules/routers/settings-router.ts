/**
 * Hang Time - Settings & Storage Message Router
 * Handles settings persistence, DND mode, game library refresh, logs, and diagnostics
 */

import { ExtensionResponse, STORAGE_KEYS } from '../../types';
import { storageManager } from '../storage';
import { GameLibraryManager } from '../game-library';
import { metadataFetcher } from '../metadata-fetcher';
import { ActivityDiagnostics } from '../activity-diagnostics';
import { getNotificationManager } from '../notifications';
import { overlayCoordinator } from '../overlay-coordinator';
import { XboxService } from '../services/xbox';
import { PublishQueue } from '../publish-queue';
import { ActivityPublisher } from '../publisher';

export class SettingsRouter {
  static async saveSettings(
    data: any,
    publishQueue: PublishQueue | null,
    activityPublisher: ActivityPublisher | null,
    refreshLibraryCb: () => Promise<ExtensionResponse>
  ): Promise<ExtensionResponse> {
    if (!data) return { success: false, error: 'settings data required' };
    try {
      const profile = await storageManager.getUserProfile();
      if (!profile) return { success: false, error: 'user profile not found' };

      if (data.nickname !== undefined) profile.nickname = data.nickname;
      if (data.discord_info !== undefined) profile.discord_info = data.discord_info;
      if (data.services_enabled) profile.services_enabled = { ...profile.services_enabled, ...data.services_enabled };
      if (data.notification_preferences !== undefined) profile.notification_preferences = data.notification_preferences;
      if (data.steam_id !== undefined || data.steam_api_key !== undefined) {
        profile.steam_config = profile.steam_config || { enabled: false, connection_type: 'api_key' };
        if (data.steam_id !== undefined) profile.steam_config.steam_id = data.steam_id;
        if (data.steam_api_key !== undefined) profile.steam_config.api_key = data.steam_api_key;
        if (profile.steam_config.steam_id && profile.steam_config.api_key) {
          profile.steam_config.enabled = true;
        }
      }
      if (data.xbox_gamertag !== undefined || data.xbox_api_key !== undefined) {
        profile.xbox_config = profile.xbox_config || { enabled: false };
        if (data.xbox_gamertag !== undefined) profile.xbox_config.gamertag = data.xbox_gamertag;
        if (data.xbox_api_key !== undefined) profile.xbox_config.api_key = data.xbox_api_key;
        if (profile.xbox_config.api_key) {
          profile.xbox_config.enabled = true;
          profile.services_enabled = profile.services_enabled || {} as any;
          if (profile.services_enabled['xbox-api'] === undefined) {
            profile.services_enabled['xbox-api'] = true;
          }

          if (!profile.xbox_config.gamertag) {
            try {
              const xboxService = new XboxService(storageManager);
              const accountInfo = await xboxService.verifyApiKey(profile.xbox_config.api_key);
              if (accountInfo?.gamertag) {
                profile.xbox_config.gamertag = accountInfo.gamertag;
                profile.xbox_config.xuid = accountInfo.xuid;
              }
            } catch {
              // ignore verification error
            }
          }
        }
      }
      if (data.publisher_config !== undefined) {
        profile.publisher_config = { ...(profile.publisher_config || {}), ...data.publisher_config };
      }
      if (data.game_discovery_enabled !== undefined) profile.game_discovery_enabled = data.game_discovery_enabled;
      if (data.theme !== undefined) profile.theme = data.theme;

      await storageManager.setUserProfile(profile);
      await storageManager.forceSyncNow();

      if (data.publisher_config?.rate_ms !== undefined && publishQueue) {
        publishQueue.setPublishInterval(data.publisher_config.rate_ms);
      }

      const hasSteamConfigured = Boolean(profile.steam_config?.steam_id && profile.steam_config?.api_key);
      const hasXboxConfigured = Boolean(profile.xbox_config?.api_key);
      if ((data.steam_id !== undefined || data.steam_api_key !== undefined || data.xbox_api_key !== undefined || data.xbox_gamertag !== undefined) && (hasSteamConfigured || hasXboxConfigured)) {
        const gameLibraryManager = GameLibraryManager.getInstance(storageManager);
        gameLibraryManager.invalidateCache().catch(() => {});
        refreshLibraryCb().catch(() => {});
      }

      if (data.nickname !== undefined || data.discord_info !== undefined) {
        if (activityPublisher) {
          await activityPublisher.publishProfile().catch(() => {});
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save settings' };
    }
  }

  static async restoreSettings(data?: any): Promise<ExtensionResponse> {
    if (!data || !data.data) return { success: false, error: 'restore data required' };
    try {
      const profileData = data.data;
      if (!profileData.uuid && !profileData.pubkey && !profileData.identifier) {
        return { success: false, error: 'invalid backup format' };
      }

      const currentProfile = await storageManager.getUserProfile();
      if (!currentProfile) return { success: false, error: 'user profile not found' };

      const restoredProfile: any = { ...profileData };
      restoredProfile.uuid = currentProfile.uuid;
      restoredProfile.pubkey = currentProfile.pubkey;

      await storageManager.setUserProfile(restoredProfile);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to restore settings' };
    }
  }

  static async getDiagnostics(): Promise<ExtensionResponse> {
    try {
      const diagnostics = ActivityDiagnostics.getInstance(storageManager);
      const summary = await diagnostics.exportDiagnostics();
      return { success: true, data: summary };
    } catch (error) {
      return { success: false, error: 'Failed to get diagnostics' };
    }
  }

  static async getDndMode(): Promise<ExtensionResponse> {
    try {
      const profile = await storageManager.getUserProfile();
      return { success: true, data: { enabled: profile?.dnd_enabled ?? false } };
    } catch (error) {
      return { success: false, error: 'Failed to get DND mode' };
    }
  }

  static async setDndMode(enabled?: boolean, activityPublisher?: ActivityPublisher | null): Promise<ExtensionResponse> {
    if (enabled === undefined) return { success: false, error: 'enabled required' };
    try {
      const profile = await storageManager.getUserProfile();
      if (!profile) return { success: false, error: 'User profile not found' };

      profile.dnd_enabled = enabled;
      await storageManager.setUserProfile(profile);

      if (enabled) {
        await storageManager.clearActiveSession();
        overlayCoordinator.broadcastToContentScripts({
          type: 'CO_WATCH_UPDATE',
          data: {
            session_members: [],
            watching_together: [],
            messages: [],
            host_nickname: undefined,
            is_user_host: false,
            user_nickname: '',
            co_watcher_activities: {},
          },
        });
        overlayCoordinator.broadcastToContentScripts({ type: 'SESSION_ENDED' });
      }

      if (activityPublisher) {
        await activityPublisher.publishActivityIfAllowed().catch(() => {});
      }

      return { success: true, data: { enabled } };
    } catch (error) {
      return { success: false, error: 'Failed to set DND mode' };
    }
  }

  static async sendTestNotification(): Promise<ExtensionResponse> {
    try {
      const notificationManager = getNotificationManager();
      await notificationManager.notify('Test Notification', 'If you see this, notifications are working!');
      return { success: true };
    } catch (error) {
      return { success: false, error: 'Failed to send test notification' };
    }
  }

  static async refreshGameLibrary(): Promise<ExtensionResponse> {
    try {
      const gameLibraryManager = GameLibraryManager.getInstance(storageManager);
      const userGames = await gameLibraryManager.fetchMyGameLibrary();
      await gameLibraryManager.publishGameLibrary();

      const gamesNeedingMetadata = await this.findGamesMissingMetadata(userGames);
      if (gamesNeedingMetadata.length > 0) {
        await metadataFetcher.scheduleBackgroundRefresh(gamesNeedingMetadata);
        return { success: true, data: { gamesRefreshed: userGames.length, queuedForMetadata: gamesNeedingMetadata.length } };
      }
      return { success: true, data: { gamesRefreshed: userGames.length, queuedForMetadata: 0 } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to refresh game library' };
    }
  }

  static async findGamesMissingMetadata(games: any[]): Promise<(number | string)[]> {
    try {
      const metadataCache = await storageManager.get<Record<string | number, any>>(STORAGE_KEYS.GAME_METADATA_CACHE, {});
      const missing: (number | string)[] = [];

      for (const game of games) {
        const meta = metadataCache[game.appId];
        if (!meta || !meta.name) {
          missing.push(game.appId);
        } else {
          const textToCheck = (meta.genres || []).concat(meta.categories || []).concat([meta.name || '']).join(' ');
          if (/[\u0400-\u04FF]/.test(textToCheck)) {
            missing.push(game.appId);
          }
        }
      }

      return missing;
    } catch (error) {
      return [];
    }
  }

  static async getNetflixExtractionLogs(): Promise<ExtensionResponse> {
    try {
      const logs = await storageManager.get(STORAGE_KEYS.NETFLIX_EXTRACTION_LOGS, []);
      return { success: true, data: logs };
    } catch (error) {
      return { success: false, error: 'Failed to get Netflix logs' };
    }
  }

  static async getNetflixDebugCaptures(): Promise<ExtensionResponse> {
    try {
      const captures = await storageManager.get(STORAGE_KEYS.NETFLIX_DEBUG_CAPTURES, []);
      return { success: true, data: captures };
    } catch (error) {
      return { success: false, error: 'Failed to get Netflix captures' };
    }
  }

  static async debugStorage(): Promise<ExtensionResponse> {
    try {
      const profile = await storageManager.getUserProfile();
      const myActivities = await storageManager.getMyActivities();
      const friends = await storageManager.getFriends();
      return {
        success: true,
        data: {
          currentActivity: profile?.current_activity || null,
          myActivities: myActivities || {},
          friendsCount: friends?.length || 0,
          firstFriend: friends?.[0] ? {
            id: friends[0].uuid,
            name: friends[0].local_name,
            currentActivities: friends[0].current_activities || {},
          } : null,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to query storage',
      };
    }
  }
}
