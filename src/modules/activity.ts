/**
 * Hang Time - Activity Detection Orchestrator
 * Monitors user's activity across all services and publishes to Nostr
 */

import {
  Activity,
  ServiceName,
  IServiceModule,
  ExtensionMessage,
} from '../types';
import { StorageManager } from './storage';
import { getActivityDatastore } from './activity-datastore';

export class ActivityDetector {
  private services: Map<string, IServiceModule> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private lastPublishedActivities: Activity[] = []; // Track for deduplication

  static readonly POLL_INTERVAL_MS = 500;

  constructor(private storageManager: StorageManager) {
    // Services will be registered separately via registerService()
  }

  registerService(name: string, service: IServiceModule): void {
    this.services.set(name, service);
  }

  getService(name: string): IServiceModule | undefined {
    return this.services.get(name);
  }

  async start(): Promise<void> {
    // Initial detection
    await this.detectAndPublish();

    // Poll every N seconds
    this.pollInterval = setInterval(() => {
      this.detectAndPublish().catch((error) => {
        console.error('[Activity] Detection error:', error);
      });
    }, ActivityDetector.POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async detectAndPublish(): Promise<void> {
    try {
      console.debug('[Activity] Detection cycle starting...');
      const allActivities = await this.detectAllActiveActivities();

      if (allActivities.length === 0) {
        console.debug('[Activity] No active activities detected');
        return;
      }

      console.log(`[Activity] 🎬 Detected ${allActivities.length} active service(s): ${allActivities.map(a => a.service).join(', ')}`);

      // Validate activities through datastore before storing
      const datastore = getActivityDatastore();
      const validatedActivities: Activity[] = [];
      const activitiesByService: Partial<Record<string, any>> = {};

      for (const activity of allActivities) {
        try {
          // Determine provenance based on service
          let provenance: 'LOCAL_TAB' | 'LOCAL_STEAM' | 'LOCAL_SPOTIFY' | 'LOCAL_TWITCH' = 'LOCAL_TAB';
          if (activity.service === 'steam-api') {
            provenance = 'LOCAL_STEAM';
          } else if (activity.service === 'spotify-api') {
            provenance = 'LOCAL_SPOTIFY';
          } else if (activity.service === 'twitch-api') {
            provenance = 'LOCAL_TWITCH';
          }

          // Validate through datastore (createActivity handles create-or-replace)
          const validated = await datastore.createActivity({
            ...activity,
            provenance,
          });
          validatedActivities.push(validated);
          activitiesByService[activity.service] = validated;
          console.debug(`[Activity]   - ${activity.service}: "${activity.content}" (audio: ${activity.audio})`);
        } catch (error) {
          // Activity failed validation - log and skip it
          console.warn(`[Activity] ⚠️  Validation failed for ${activity.service}:`, error instanceof Error ? error.message : error);
        }
      }

      if (validatedActivities.length === 0) {
        console.debug('[Activity] No activities passed validation');
        // Clean up ghost activities from closed tabs
        const ghostsRemoved = await datastore.cleanupGhosts();
        if (ghostsRemoved > 0) {
          console.debug('[Activity] Cleaned up', ghostsRemoved, 'ghost activities');
          // Update my_activities after cleanup
          await this._updateMyActivitiesFromDatastore();
        }
        return;
      }

      // Deduplication: only notify/store if activity IDs changed
      const newActivityIds = new Set(validatedActivities.map(a => a.id));
      const lastActivityIds = new Set(this.lastPublishedActivities.map(a => a.id));

      // Check if the set of activity IDs actually changed
      const activityIdsChanged =
        newActivityIds.size !== lastActivityIds.size ||
        Array.from(newActivityIds).some(id => !lastActivityIds.has(id));

      // Clean up ghost activities from closed tabs before updating my_activities
      await datastore.cleanupGhosts();

      // Clean up stale API activities (from services that are enabled but didn't return anything)
      const profile = await this.storageManager.getUserProfile();
      if (profile) {
        await this._cleanupStaleApiActivities(validatedActivities, profile);
      }

      // Populate my_activities from datastore (single source of truth)
      await this._updateMyActivitiesFromDatastore();

      // Store most recent activity for backwards compatibility
      await this.storageManager.setCurrentActivity(allActivities[0]);

      if (!activityIdsChanged) {
        // Same activities, only state/audio might have changed (oscillation)
        console.debug('[Activity] ℹ️  Activity IDs unchanged (state-only change, skipping notification)');
        return;
      }

      // Meaningful change: activity IDs changed, notify popup
      console.debug('[Activity] Activity IDs changed, notifying popup');
      await this._notifyPopup({
        type: 'MY_ACTIVITIES_CHANGED',
        data: { activities: activitiesByService },
      });

      // Update last published for next comparison
      this.lastPublishedActivities = validatedActivities;
    } catch (error) {
      console.error('[Activity] ❌ Detection pipeline failed:', error);
    }
  }

  async detectCurrentActivity(): Promise<Activity | null> {
    const allActivities = await this.detectAllActiveActivities();
    // Return the most recent activity for publishing to Nostr
    if (allActivities.length > 0) {
      return allActivities[0];
    }
    // Don't publish idle - just return null to skip publishing
    return null;
  }

  async detectAllActiveActivities(): Promise<Activity[]> {
    const profile = await this.storageManager.getUserProfile();
    if (!profile) {
      return [];
    }

    const activities: Activity[] = [];
    const seenServices = new Set<string>();

    // Ensure services_enabled exists (defensive check for profiles that might be missing it)
    const servicesEnabled = profile.services_enabled || {
      'spotify-api': false,
      'twitch-api': false,
      'steam-api': false,
      'discord-api': false,
      'video-tab': true, // Default enabled for browser video detection
    };

    // Check each enabled OAuth service (Spotify, Twitch, Steam, Discord)
    const oauthServices: ServiceName[] = ['spotify-api', 'twitch-api', 'steam-api', 'discord-api'];
    for (const serviceName of oauthServices) {
      if (!servicesEnabled[serviceName]) continue;

      const service = this.services.get(serviceName);
      if (!service) continue;

      try {
        const activity = await service.getCurrentActivity();
        if (activity) {
          activities.push(activity);
          seenServices.add(serviceName);
        }
      } catch (error) {
        console.error(`[Activity] ERROR detecting ${serviceName}:`, error);
      }
    }

    // Check browser tabs (generic video detection)
    if (servicesEnabled['video-tab']) {
      const tabService = this.services.get('tabs') as any;
      if (tabService) {
        try {
          const videoActivity = await tabService.getCurrentActivity();
          if (videoActivity) {
            activities.push(videoActivity);
            seenServices.add('video-tab');
          }
        } catch (error) {
          console.error('[Activity] ERROR detecting browser videos:', error);
        }
      }
    }

    // Sort: audio on first, then by last accessed time (for browser tabs) or timestamp (for APIs)
    activities.sort((a, b) => {
      // Prioritize activities with audio
      const aAudio = a.audio === 'on' ? 1 : 0;
      const bAudio = b.audio === 'on' ? 1 : 0;
      if (aAudio !== bAudio) {
        return bAudio - aAudio; // on (1) comes before off (0)
      }

      // Then sort by last accessed time
      const aTime = (a.metadata?.lastAccessed as number) || a.timestamp || 0;
      const bTime = (b.metadata?.lastAccessed as number) || b.timestamp || 0;
      return bTime - aTime;
    });

    return activities;
  }



  private async _updateMyActivitiesFromDatastore(): Promise<void> {
    try {
      const datastore = getActivityDatastore();
      const allActivities = await datastore.getAllActivities();

      // Include all user-detected activities (LOCAL_TAB, LOCAL_STEAM, etc), exclude FRIEND/TEST
      // Use activity ID as key (consistent with ActivityDatastore)
      const myActivities: Partial<Record<string, any>> = {};
      for (const activity of allActivities) {
        // Include all local activities (user's own detected activities), exclude friend/test data
        if (activity.provenance !== 'FRIEND' && activity.provenance !== 'TEST') {
          myActivities[activity.id] = activity;
        }
      }

      await this.storageManager.setMyActivities(myActivities);
      console.debug('[Activity] Updated MY_ACTIVITIES from datastore with', Object.keys(myActivities).length, 'activities');
    } catch (error) {
      console.error('[Activity] Failed to update my_activities from datastore:', error);
    }
  }

  private async _cleanupStaleApiActivities(currentActivities: Activity[], profile: UserProfile): Promise<void> {
    const datastore = getActivityDatastore();
    const allActivities = await datastore.getAllActivities();

    // API services that were enabled
    const enabledApiServices = new Set<string>();
    if (profile.services_enabled['steam-api']) enabledApiServices.add('steam-api');
    if (profile.services_enabled['spotify-api']) enabledApiServices.add('spotify-api');
    if (profile.services_enabled['twitch-api']) enabledApiServices.add('twitch-api');

    for (const service of enabledApiServices) {
      const currentActivity = currentActivities.find(a => a.service === service);

      if (!currentActivity) {
        // Service is enabled but didn't return an activity - remove all stale activities
        const staleActivities = allActivities.filter(a => a.service === service && a.provenance !== 'FRIEND' && a.provenance !== 'TEST');
        for (const activity of staleActivities) {
          console.debug(`[Activity] Removing stale ${service} activity: ${activity.content}`);
          await datastore.deleteActivity(activity.id);
        }
      } else {
        // Service returned an activity - but remove any OTHER activities from the same service
        // (APIs like Steam only return the most recent activity; any other stored are stale)
        const otherActivities = allActivities.filter(
          a => a.service === service &&
               a.id !== currentActivity.id &&
               a.provenance !== 'FRIEND' &&
               a.provenance !== 'TEST'
        );
        for (const activity of otherActivities) {
          console.debug(`[Activity] Removing duplicate ${service} activity (keeping current): ${activity.content}`);
          await datastore.deleteActivity(activity.id);
        }
      }
    }
  }

  private async _notifyPopup(message: ExtensionMessage): Promise<void> {
    try {
      // Try to send to popup if it's open
      await chrome.runtime.sendMessage(message);
    } catch (error) {
      // Popup not open, ignore
    }
  }
}
