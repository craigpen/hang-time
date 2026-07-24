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

export class ActivityDetector {
  private services: Map<string, IServiceModule> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;

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

      // Store detected activities locally (publishing handled by separate publisher)
      const activitiesByService: Partial<Record<string, any>> = {};
      for (const activity of allActivities) {
        activitiesByService[activity.service] = activity;
        console.debug(`[Activity]   - ${activity.service}: "${activity.content}" (${activity.state})`);
      }
      await this.storageManager.setMyActivities(activitiesByService);
      console.debug('[Activity] ✅ Stored in MY_ACTIVITIES');

      // Store most recent activity for backwards compatibility
      await this.storageManager.setCurrentActivity(allActivities[0]);

      // Notify popup that activities changed
      await this._notifyPopup({
        type: 'MY_ACTIVITIES_CHANGED',
        data: { activities: activitiesByService },
      });
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
      spotify: false,
      twitch: false,
      steam: false,
      netflix: false,
      youtube: false,
    };

    // Check each enabled OAuth service (Spotify, Twitch, Steam)
    const oauthServices: ServiceName[] = ['spotify', 'twitch', 'steam'];
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
    if (servicesEnabled.netflix || servicesEnabled.youtube || servicesEnabled.twitch) {
      const tabService = this.services.get('tabs') as any;
      if (tabService) {
        try {
          // Call getCurrentActivity first to populate the lastDetected map
          await tabService.getCurrentActivity();

          // Get Netflix activity
          if (servicesEnabled.netflix) {
            const netflixActivity = tabService.getDetectedActivity('netflix');
            if (netflixActivity) {
              activities.push(netflixActivity);
              seenServices.add('netflix');
            }
          }

          // Get YouTube activity
          if (servicesEnabled.youtube) {
            const youtubeActivity = tabService.getDetectedActivity('youtube');
            if (youtubeActivity) {
              activities.push(youtubeActivity);
              seenServices.add('youtube');
            }
          }

          // Get Twitch activity
          if (servicesEnabled.twitch) {
            const twitchActivity = tabService.getDetectedActivity('twitch');
            if (twitchActivity) {
              activities.push(twitchActivity);
              seenServices.add('twitch');
            }
          }
        } catch (error) {
          console.error('[Activity] ERROR detecting browser tabs:', error);
        }
      }
    }

    // Sort by last accessed time (for browser tabs) or timestamp (for APIs), most recent first
    activities.sort((a, b) => {
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
