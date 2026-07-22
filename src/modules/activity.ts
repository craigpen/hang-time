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

  static readonly PUBLISH_RATE_LIMIT_MS = 2000;
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
    console.debug(`[Activity] Registered service: ${name}`);
  }

  async start(): Promise<void> {
    console.debug('[Activity] Starting activity detector...');

    // Initial detection
    await this.detectAndPublish();

    // Poll every N seconds
    this.pollInterval = setInterval(() => {
      this.detectAndPublish().catch((error) => {
        console.error('[Activity] Detection error:', error);
      });
    }, ActivityDetector.POLL_INTERVAL_MS);

    console.debug('[Activity] Detector started');
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.debug('[Activity] Activity detector stopped');
  }

  async detectAndPublish(): Promise<void> {
    try {
      const currentActivity = await this.detectCurrentActivity();
      if (!currentActivity) return;

      // Skip if activity hasn't changed or rate limit not met
      if (!this._activityChanged(currentActivity)) {
        return;
      }

      if (Date.now() - this.lastPublishedTime < ActivityDetector.PUBLISH_RATE_LIMIT_MS) {
        return;
      }

      await this._publishActivity(currentActivity);
      this.lastPublishedActivity = currentActivity;
      this.lastPublishedTime = Date.now();

      // Store current activity
      await this.storageManager.setCurrentActivity(currentActivity);

      // Notify popup if it's open
      await this._notifyPopup({
        type: 'ACTIVITY_CHANGED',
        data: { activity: currentActivity },
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
    return { service: 'idle', content: 'Idle', timestamp: Date.now(), metadata: {} };
  }

  async detectAllActiveActivities(): Promise<Activity[]> {
    const profile = await this.storageManager.getUserProfile();
    if (!profile) {
      return [];
    }

    const activities: Activity[] = [];
    const seenServices = new Set<string>();

    console.debug('[Activity] Services enabled:', profile.services_enabled);

    // Check each enabled OAuth service (Spotify, Twitch, Steam)
    const oauthServices: ServiceName[] = ['spotify', 'twitch', 'steam'];
    for (const serviceName of oauthServices) {
      if (!profile.services_enabled[serviceName]) continue;

      const service = this.services.get(serviceName);
      if (!service) continue;

      try {
        console.debug(`[Activity] Checking ${serviceName}...`);
        const activity = await service.getCurrentActivity();
        if (activity && activity.service !== 'idle') {
          console.debug(`[Activity] Detected ${serviceName}: ${activity.content}`);
          activities.push(activity);
          seenServices.add(serviceName);
        }
      } catch (error) {
        console.error(`[Activity] ERROR detecting ${serviceName}:`, error);
      }
    }

    // Check browser tabs (Netflix, YouTube)
    if (profile.services_enabled.netflix || profile.services_enabled.youtube) {
      const tabService = this.services.get('tabs') as any;
      if (tabService) {
        try {
          console.debug('[Activity] Checking browser tabs...');

          // Call getCurrentActivity first to populate the lastDetected map
          await tabService.getCurrentActivity();

          // Get Netflix activity
          if (profile.services_enabled.netflix) {
            const netflixActivity = tabService.getDetectedActivity('netflix');
            if (netflixActivity && netflixActivity.service !== 'idle') {
              console.debug(`[Activity] Detected netflix: ${netflixActivity.content}`);
              activities.push(netflixActivity);
              seenServices.add('netflix');
            }
          }

          // Get YouTube activity
          if (profile.services_enabled.youtube) {
            const youtubeActivity = tabService.getDetectedActivity('youtube');
            if (youtubeActivity && youtubeActivity.service !== 'idle') {
              console.debug(`[Activity] Detected youtube: ${youtubeActivity.content}`);
              activities.push(youtubeActivity);
              seenServices.add('youtube');
            }
          }
        } catch (error) {
          console.error('[Activity] ERROR detecting browser tabs:', error);
        }
      }
    }

    // Sort by timestamp, most recent first
    activities.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    console.debug(`[Activity] Detected ${activities.length} active service(s)`);
    return activities;
  }

  private async _publishActivity(activity: Activity): Promise<void> {
    const pubkey = await this.identityManager.getPubkey();
    const created_at = Math.floor(Date.now() / 1000);
    const kind = 1;
    const tags: Array<[string, string]> = [
      ['service', activity.service],
      ['content', activity.content],
    ];

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
    console.debug(`[Activity] Published ${activity.service} activity to Nostr`);
  }

  private _buildEventContent(activity: Activity): string {
    const parts: string[] = [];

    if (activity.metadata?.artist) {
      parts.push(activity.metadata.artist);
    }

    parts.push(activity.content);

    return parts.filter((p) => p).join(' - ');
  }

  private _activityChanged(newActivity: Activity): boolean {
    if (!this.lastPublishedActivity) return true;

    return (
      newActivity.service !== this.lastPublishedActivity.service ||
      newActivity.content !== this.lastPublishedActivity.content
    );
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
