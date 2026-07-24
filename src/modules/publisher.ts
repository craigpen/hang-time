/**
 * Hang Time - Activity Publisher
 * Publishes local activity state to Nostr using round-robin per-service publishing
 * One atomic publish per second, cycling through services
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

  static readonly PUBLISH_INTERVAL_MS = 1000; // One publish per second

  constructor(
    private relayPool: RelayPool,
    private storageManager: StorageManager,
    private identityManager: IdentityManager
  ) {}

  async start(): Promise<void> {
    console.debug('[Publisher] Starting activity publisher (publish all services each cycle)');

    try {
      // Periodically publish all services in parallel
      this.publishInterval = setInterval(() => {
        this.publishAllServices().catch((error) => {
          console.error('[Publisher] Publish error:', error);
        });
      }, ActivityPublisher.PUBLISH_INTERVAL_MS);

      console.debug('[Publisher] Publish interval started (all services per cycle)');
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

  async publishAllServices(): Promise<void> {
    try {
      // Get current activities from storage once
      const currentActivities = await this.storageManager.getMyActivities();

      // Publish all services in parallel
      const publishPromises = SERVICES_TO_PUBLISH.map(async (service) => {
        const currentActivity = currentActivities[service];

        // Publish if activity exists (no "unchanged" check)
        if (currentActivity) {
          await this._publishActivity(currentActivity);
          this.lastPublishedState[service] = currentActivity;
          console.debug(`[Publisher] Published ${service}: ${currentActivity.content}`);
        } else {
          // Service has no activity, clear from last published state
          delete this.lastPublishedState[service];
        }
      });

      // Wait for all publishes to complete
      await Promise.all(publishPromises);
    } catch (error) {
      console.error('[Publisher] Failed to publish services:', error);
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
      current.state === last.state &&
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
