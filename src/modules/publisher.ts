/**
 * Hang Time - Activity Publisher
 * Publishes local activity state to Nostr
 * Separates detection (local storage) from publishing concerns
 */

import { Activity, NostrEvent } from '../types';
import { RelayPool } from './nostr';
import { StorageManager } from './storage';
import { IdentityManager } from './identity';
import { encryptionManager } from './encryption';

export class ActivityPublisher {
  private lastPublishedState: Partial<Record<string, Activity>> | null = null;
  private publishInterval: NodeJS.Timeout | null = null;

  static readonly PUBLISH_INTERVAL_MS = 5000; // Match detection cycle

  constructor(
    private relayPool: RelayPool,
    private storageManager: StorageManager,
    private identityManager: IdentityManager
  ) {}

  async start(): Promise<void> {
    console.debug('[Publisher] Starting activity publisher');

    try {
      // Publish immediately
      console.debug('[Publisher] Initial publish attempt');
      await this.publishIfChanged();
      console.debug('[Publisher] Initial publish complete');

      // Then periodically check and publish
      this.publishInterval = setInterval(() => {
        this.publishIfChanged().catch((error) => {
          console.error('[Publisher] Publish error:', error);
        });
      }, ActivityPublisher.PUBLISH_INTERVAL_MS);

      console.debug('[Publisher] Publish interval started');
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

  async publishIfChanged(): Promise<void> {
    try {
      const currentActivities = await this.storageManager.getMyActivities();

      // Check if state changed
      if (!this._activitiesChanged(currentActivities)) {
        return;
      }

      // Convert to array for publishing
      const activitiesArray = Object.values(currentActivities).filter((a) => a) as Activity[];
      if (activitiesArray.length === 0) {
        return;
      }

      // Publish complete activity state
      await this._publishCompleteActivityState(activitiesArray);
      this.lastPublishedState = currentActivities;

      console.debug(`[Publisher] Published ${activitiesArray.length} activities`);
    } catch (error) {
      console.error('[Publisher] Failed to publish:', error);
    }
  }

  private async _publishCompleteActivityState(allActivities: Activity[]): Promise<void> {
    try {
      const pubkey = await this.identityManager.getPubkey();
      const created_at = Math.floor(Date.now() / 1000);
      const kind = 1;

      // Create tags with metadata about the state
      let tags: Array<[string, string]> = [
        ['type', 'activity-state'],
        ['count', allActivities.length.toString()],
        // Add service tags for filtering (friends can query by service)
        ...allActivities.map((a) => ['service', a.service]),
      ];

      // Serialize all activities as JSON in the content field
      const content = JSON.stringify(allActivities);

      // Compute PoW to meet nos.lol requirements (28 bits)
      console.debug('[Publisher] Computing PoW for large event...');
      const nonce = await this._computePoW(pubkey, created_at, kind, tags, content, 28);
      tags = [...tags, ['nonce', nonce.toString()]];

      // Compute event ID with nonce
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
      console.error('[Publisher] Failed to publish complete activity state:', error);
    }
  }

  private _activitiesChanged(newActivities: Partial<Record<string, Activity>>): boolean {
    if (!this.lastPublishedState) return true;

    // Check if any service's activity changed
    const services = new Set([
      ...Object.keys(newActivities),
      ...Object.keys(this.lastPublishedState),
    ]);

    for (const service of services) {
      const oldActivity = this.lastPublishedState[service];
      const newActivity = newActivities[service];

      // Check if activity was added, removed, or changed
      if (!oldActivity && newActivity) return true; // Added
      if (oldActivity && !newActivity) return true; // Removed
      if (oldActivity && newActivity) {
        if (
          oldActivity.content !== newActivity.content ||
          oldActivity.state !== newActivity.state ||
          oldActivity.url !== newActivity.url ||
          oldActivity.metadata?.progress !== newActivity.metadata?.progress
        ) {
          return true; // Changed
        }
      }
    }

    return false;
  }

  private async _computePoW(
    pubkey: string,
    created_at: number,
    kind: number,
    tags: Array<[string, string]>,
    content: string,
    targetBits: number = 28
  ): Promise<number> {
    let nonce = 0;
    const maxAttempts = 1000000; // Prevent infinite loops

    while (nonce < maxAttempts) {
      const tagsWithNonce = [...tags, ['nonce', nonce.toString()]];
      const eventData = [0, pubkey, created_at, kind, tagsWithNonce, content];
      const canonicalJson = JSON.stringify(eventData);
      const hash = await encryptionManager.sha256(canonicalJson);

      // Count leading zero bits
      let leadingZeros = 0;
      for (let i = 0; i < hash.length; i += 2) {
        const byte = parseInt(hash.substring(i, i + 2), 16);
        if (byte === 0) {
          leadingZeros += 8;
        } else {
          // Count zero bits in this byte
          for (let bit = 7; bit >= 0; bit--) {
            if ((byte & (1 << bit)) === 0) {
              leadingZeros++;
            } else {
              break;
            }
          }
          break;
        }
      }

      if (leadingZeros >= targetBits) {
        console.debug(`[Publisher] Found PoW nonce: ${nonce} with ${leadingZeros} bits`);
        return nonce;
      }

      nonce++;

      // Log progress every 1000 attempts
      if (nonce % 1000 === 0) {
        console.debug(`[Publisher] PoW search in progress: ${nonce} attempts, best so far: ${leadingZeros} bits`);
      }
    }

    console.warn(`[Publisher] Failed to find ${targetBits}-bit PoW within ${maxAttempts} attempts`);
    return nonce;
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
