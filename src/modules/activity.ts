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
          // Validate through datastore
          const validated = await datastore.createActivity({
            ...activity,
            provenance: 'LOCAL_TAB',
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
        return;
      }

      // Deduplication: only notify/store if activity IDs changed
      const newActivityIds = new Set(validatedActivities.map(a => a.id));
      const lastActivityIds = new Set(this.lastPublishedActivities.map(a => a.id));

      // Check if the set of activity IDs actually changed
      const activityIdsChanged =
        newActivityIds.size !== lastActivityIds.size ||
        Array.from(newActivityIds).some(id => !lastActivityIds.has(id));

      if (!activityIdsChanged) {
        // Same activities, only state/audio might have changed (oscillation)
        console.debug('[Activity] ℹ️  Activity IDs unchanged (state-only change, skipping notification)');
        // Still publish to Nostr via Publisher (which is rate-limited anyway)
        await this.storageManager.setMyActivities(activitiesByService);
        return;
      }

      // Meaningful change: activity IDs changed, notify popup
      console.debug('[Activity] Activity IDs changed, notifying popup');
      await this.storageManager.setMyActivities(activitiesByService);
      console.debug('[Activity] ✅ Stored in MY_ACTIVITIES');

      // Store most recent activity for backwards compatibility
      await this.storageManager.setCurrentActivity(allActivities[0]);

      // Notify popup that activities changed
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
      'netflix-tab': false,
      'youtube-tab': false,
      'twitch-tab': false,
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

    // Check browser tabs (Netflix, YouTube, Twitch)
    if (servicesEnabled['netflix-tab'] || servicesEnabled['youtube-tab'] || servicesEnabled['twitch-tab']) {
      const tabService = this.services.get('tabs') as any;
      if (tabService) {
        try {
          // Call getCurrentActivity first to populate the lastDetected map
          await tabService.getCurrentActivity();

          // Get Netflix activity
          if (servicesEnabled['netflix-tab']) {
            const netflixActivity = tabService.getDetectedActivity('netflix-tab');
            if (netflixActivity) {
              activities.push(netflixActivity);
              seenServices.add('netflix-tab');
            }
          }

          // Get YouTube activity
          if (servicesEnabled['youtube-tab']) {
            const youtubeActivity = tabService.getDetectedActivity('youtube-tab');
            if (youtubeActivity) {
              activities.push(youtubeActivity);
              seenServices.add('youtube-tab');
            }
          }

          // Get Twitch activity
          if (servicesEnabled['twitch-tab']) {
            const twitchActivity = tabService.getDetectedActivity('twitch-tab');
            if (twitchActivity) {
              activities.push(twitchActivity);
              seenServices.add('twitch-tab');
            }
          }
        } catch (error) {
          console.error('[Activity] ERROR detecting browser tabs:', error);
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



  private async _notifyPopup(message: ExtensionMessage): Promise<void> {
    try {
      // Try to send to popup if it's open
      await chrome.runtime.sendMessage(message);
    } catch (error) {
      // Popup not open, ignore
    }
  }
}
