/**
 * Hang Time - Activity Detection Orchestrator
 * Monitors user's activity across all services and publishes to Nostr
 */

import {
  Activity,
  ServiceName,
  IServiceModule,
  NostrEvent,
  ExtensionResponse,
  ExtensionMessage,
} from '../types';
import { RelayPool } from './nostr';
import { StorageManager } from './storage';
import { IdentityManager } from './identity';
import { encryptionManager } from './encryption';

export class ActivityDetector {
  private services: Map<string, IServiceModule> = new Map();
  private lastPublishedActivity: Activity | null = null;
  private lastPublishedTime: number = 0;
  private pollInterval: NodeJS.Timeout | null = null;

  static readonly POLL_INTERVAL_MS = 5000;

  constructor(
    private relayPool: RelayPool,
    private storageManager: StorageManager,
    private identityManager: IdentityManager
  ) {
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
      const allActivities = await this.detectAllActiveActivities();
      if (allActivities.length === 0) return;

      // Skip if activities haven't changed
      if (!this._activitiesChanged(allActivities)) {
        return;
      }

      // Publish complete activity state as single atomic event
      await this._publishCompleteActivityState(allActivities);

      this.lastPublishedActivity = allActivities[0];
      this.lastPublishedTime = Date.now();

      // Store most recent activity locally
      await this.storageManager.setCurrentActivity(allActivities[0]);

      // Notify popup if it's open
      await this._notifyPopup({
        type: 'ACTIVITY_CHANGED',
        data: { activity: allActivities[0] },
      });
    } catch (error) {
      console.error('[Activity] Detection pipeline failed:', error);
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

  private async _publishActivity(activity: Activity): Promise<void> {
    // Skip temporary guidance activities (e.g., Netflix title not yet captured)
    if (activity.temporary) {
      return;
    }

    // Don't publish fallback/placeholder activities
    if (activity.content === '(Reload Netflix to identify title)') {
      return;
    }

    const pubkey = await this.identityManager.getPubkey();
    const created_at = Math.floor(Date.now() / 1000);
    const kind = 1;

    // Ensure content is never empty or a URL
    const activityContent = (activity.content || '').trim();
    if (!activityContent || activityContent.includes('http') || activityContent === activity.url) {
      // Content is empty or invalid - don't publish
      return;
    }

    const tags: Array<[string, string]> = [
      ['service', activity.service],
      ['content', activityContent],
      ['activity_id', activity.id],
    ];

    // Add state tag if present
    if (activity.state) {
      tags.push(['state', activity.state]);
    }

    // Add URL tag before computing event ID
    if (activity.url) {
      tags.push(['url', activity.url]);
    }

    const content = this._buildEventContent(activity);

    // Compute event ID from canonical event format (required by NIP-01)
    // Must be done AFTER all tags are added
    const id = await this._computeEventId(pubkey, created_at, kind, tags, content);

    // Sign the event with the user's secret key
    const secretKey = await this.identityManager.getSecretKey();
    const sig = encryptionManager.signEvent(id, secretKey);

    const event: NostrEvent = {
      id,
      pubkey,
      created_at,
      kind,
      tags,
      content,
      sig,
    };

    await this.relayPool.publish(event);
  }

  private async _publishCompleteActivityState(allActivities: Activity[]): Promise<void> {
    try {
      const pubkey = await this.identityManager.getPubkey();
      const created_at = Math.floor(Date.now() / 1000);
      const kind = 1;

      // Create tags with metadata about the state
      const tags: Array<[string, string]> = [
        ['type', 'activity-state'],
        ['count', allActivities.length.toString()],
        // Add service tags for filtering (friends can query by service)
        ...allActivities.map(a => ['service', a.service])
      ];

      // Serialize all activities as JSON in the content field
      const content = JSON.stringify(allActivities);

      // Compute event ID
      const id = await this._computeEventId(pubkey, created_at, kind, tags, content);

      // Sign the event
      const secretKey = await this.identityManager.getSecretKey();
      const sig = encryptionManager.signEvent(id, secretKey);

      const event: NostrEvent = {
        id,
        pubkey,
        created_at,
        kind,
        tags,
        content,
        sig,
      };

      await this.relayPool.publish(event);
    } catch (error) {
      console.error('[Activity] Failed to publish complete activity state:', error);
    }
  }

  private _buildEventContent(activity: Activity): string {
    const parts: string[] = [];

    if (activity.metadata?.artist) {
      parts.push(activity.metadata.artist);
    }

    parts.push(activity.content);

    return parts.filter((p) => p).join(' - ');
  }

  private _activitiesChanged(newActivities: Activity[]): boolean {
    if (!this.lastPublishedActivity) return true;

    // Check if any activity changed
    for (const newActivity of newActivities) {
      if (newActivity.service !== this.lastPublishedActivity.service ||
          newActivity.content !== this.lastPublishedActivity.content ||
          newActivity.state !== this.lastPublishedActivity.state) {
        return true;
      }
    }

    return false;
  }

  private _activityChanged(newActivity: Activity): boolean {
    if (!this.lastPublishedActivity) return true;

    // Check if core content changed
    if (newActivity.service !== this.lastPublishedActivity.service ||
        newActivity.content !== this.lastPublishedActivity.content) {
      return true;
    }

    // Check state change only if state exists on either activity
    if (newActivity.state || this.lastPublishedActivity.state) {
      if (newActivity.state !== this.lastPublishedActivity.state) {
        return true;
      }
    }

    return false;
  }

  private async _computeEventId(pubkey: string, created_at: number, kind: number, tags: Array<[string, string]>, content: string): Promise<string> {
    // Nostr event ID = SHA-256 hash of canonical event format (NIP-01)
    // Canonical format: [0, pubkey, created_at, kind, tags, content]
    const eventData = [0, pubkey, created_at, kind, tags, content];
    const canonicalJson = JSON.stringify(eventData);
    const hash256 = await encryptionManager.sha256(canonicalJson);
    return hash256.substring(0, 64);
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
