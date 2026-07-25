/**
 * Hang Time - Activity Publisher
 * Publishes local activity state to Nostr using time-based scheduling
 * 5 publishes per 60 seconds: changed services at 12s, 24s, 36s, 48s + full refresh at 60s
 */

import { Activity, NostrEvent, ServiceName } from '../types';
import { RelayPool } from './nostr';
import { StorageManager } from './storage';
import { IdentityManager } from './identity';
import { encryptionManager } from './encryption';

const SERVICES_TO_PUBLISH: ServiceName[] = ['spotify', 'twitch', 'steam', 'netflix', 'youtube'];

export class ActivityPublisher {
  private lastPublishedState: Partial<Record<string, Activity>> = {};
  private publishInterval: NodeJS.Timeout | null = null;
  private publishCount = 0; // Increments every 12s, 5th publish (index 4) is full refresh
  private publishRateMs = 12000; // Default: publish every 12 seconds

  static readonly PUBLISH_INTERVAL_MS = 12000; // Default: publish every 12 seconds (5 per 60s)
  static readonly FULL_REFRESH_CYCLE = 5; // Every 5th publish is a full refresh

  constructor(
    private relayPool: RelayPool,
    private storageManager: StorageManager,
    private identityManager: IdentityManager
  ) {}

  private async _loadConfig(): Promise<void> {
    const profile = await this.storageManager.getUserProfile();
    if (profile?.publisher_config) {
      this.publishRateMs = profile.publisher_config.rate_ms || 12000;
    }
  }

  async start(): Promise<void> {
    await this._loadConfig();

    const profile = await this.storageManager.getUserProfile();
    const config = profile?.publisher_config;

    if (config && !config.enabled) {
      console.debug('[Publisher] Publishing is disabled in config');
      return;
    }

    console.debug(`[Publisher] Starting activity publisher (rate: ${this.publishRateMs}ms, size: ${config?.size || 'full'}, scope: ${config?.scope || 'updates'})`);

    try {
      this.publishInterval = setInterval(() => {
        this.publishCycle().catch((error) => {
          console.error('[Publisher] Publish cycle error:', error);
        });
      }, this.publishRateMs);

      console.debug(`[Publisher] Publish interval started (every ${this.publishRateMs}ms)`);
    } catch (error) {
      console.error('[Publisher] Failed to start:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.publishInterval) {
      clearInterval(this.publishInterval);
      this.publishInterval = null;
    }
  }

  async publishCycle(): Promise<void> {
    try {
      const profile = await this.storageManager.getUserProfile();
      const config = profile?.publisher_config || { enabled: true, size: 'full', scope: 'updates', rate_ms: 12000 };

      const currentActivities = await this.storageManager.getMyActivities();
      const isFullRefreshCycle = this.publishCount % ActivityPublisher.FULL_REFRESH_CYCLE === (ActivityPublisher.FULL_REFRESH_CYCLE - 1);

      // Determine if we should do a full refresh based on scope config
      const doFullRefresh = config.scope === 'all' || isFullRefreshCycle;

      if (doFullRefresh) {
        // Full refresh: publish all active services
        console.debug('[Publisher] Full refresh cycle');
        await this._publishServices(currentActivities, config.size === 'atomic' ? 'atomic' : 'all');
        this.lastPublishedState = { ...currentActivities };
      } else {
        // Changed services only: publish only what changed since last publish
        const changedServices: Partial<Record<string, Activity>> = {};
        for (const service of SERVICES_TO_PUBLISH) {
          if (!this._activityUnchanged(currentActivities[service], this.lastPublishedState[service])) {
            changedServices[service] = currentActivities[service];
          }
        }

        if (Object.keys(changedServices).length > 0) {
          console.debug(`[Publisher] Changed services: ${Object.keys(changedServices).join(', ')}`);
          await this._publishServices(changedServices, 'changed');
          // Update last published state with what we just published
          this.lastPublishedState = { ...this.lastPublishedState, ...changedServices };
        } else {
          console.debug('[Publisher] No changes to publish');
        }
      }

      this.publishCount++;
    } catch (error) {
      console.error('[Publisher] Failed to publish cycle:', error);
    }
  }

  private async _publishServices(
    activities: Partial<Record<string, Activity>>,
    mode: 'changed' | 'all' | 'atomic'
  ): Promise<void> {
    const servicesToPublish = mode === 'all' || mode === 'atomic'
      ? SERVICES_TO_PUBLISH.filter(s => activities[s])
      : Object.keys(activities) as ServiceName[];

    // Collect activities to bundle
    const activitiesToPublish: Activity[] = servicesToPublish
      .map(service => activities[service])
      .filter((a): a is Activity => !!a);

    if (activitiesToPublish.length === 0) {
      console.debug('[Publisher] No activities to publish');
      return;
    }

    console.debug('[Publisher] Activities to publish:', activitiesToPublish.map(a => ({ service: a.service, audio: a.audio })));

    // Publish as individual events (atomic) or bundled (full)
    if (mode === 'atomic') {
      for (const activity of activitiesToPublish) {
        await this._publishActivity(activity);
      }
    } else {
      await this._publishBundledActivities(activitiesToPublish, mode);
    }
  }

  private async _publishBundledActivities(activities: Activity[], mode: 'changed' | 'all'): Promise<void> {
    try {
      const pubkey = await this.identityManager.getPubkey();
      const created_at = Math.floor(Date.now() / 1000);
      const kind = 1;

      // Create tags
      const tags: Array<[string, string]> = [
        ['type', 'activity-state'],
        ['mode', mode],
        ['count', activities.length.toString()],
      ];

      // Add service tags for each activity
      for (const activity of activities) {
        tags.push(['service', activity.service]);
      }

      // Serialize activities as JSON array in content
      const content = JSON.stringify(activities);

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

      // Log event details
      const eventJson = JSON.stringify(event);
      console.debug(`[Publisher] Bundled event (${mode}): ${activities.length} services, size=${eventJson.length}b`);
      console.debug(`[Publisher] Services: ${activities.map(a => `${a.service}(audio:${a.audio})`).join(', ')}`);

      await this.relayPool.publish(event);
      console.debug(`[Publisher] ✅ Published bundled event with ${activities.length} services`);
    } catch (error) {
      console.error('[Publisher] Failed to publish bundled activities:', error);
    }
  }

  private async _publishActivity(activity: Activity): Promise<void> {
    try {
      // Skip temporary guidance activities
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

      // Ensure content is valid
      const activityContent = (activity.content || '').trim();
      if (!activityContent || activityContent.includes('http') || activityContent === activity.url) {
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

      // Add URL tag
      if (activity.url) {
        tags.push(['url', activity.url]);
      }

      const content = this._buildEventContent(activity);

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
      console.error('[Publisher] Failed to publish activity:', error);
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

  private _activityUnchanged(current: Activity | undefined, last: Activity | undefined): boolean {
    // If either is undefined, they're different
    if (!current && !last) return true; // Both empty = unchanged
    if (!current || !last) return false; // One empty, one not = changed

    // Compare key fields
    return (
      current.content === last.content &&
      current.audio === last.audio &&
      current.url === last.url &&
      current.metadata?.progress === last.metadata?.progress
    );
  }

  private async _computeEventId(
    pubkey: string,
    created_at: number,
    kind: number,
    tags: Array<[string, string]>,
    content: string
  ): Promise<string> {
    // Nostr event ID = SHA-256 hash of canonical event format (NIP-01)
    const eventData = [0, pubkey, created_at, kind, tags, content];
    const canonicalJson = JSON.stringify(eventData);
    const hash256 = await encryptionManager.sha256(canonicalJson);
    return hash256.substring(0, 64);
  }
}
