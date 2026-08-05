/**
 * Hang Time - Unified Publish Queue
 * Manages rate-limited publishing across all event types with three-tier priority:
 * 1. User actions (friend requests, invites, messages) - highest priority
 * 2. Profile & game library updates - medium priority
 * 3. Activities - base case, must publish at least every other cycle
 */

import { finalizeEvent } from 'nostr-tools';
import { NostrEvent } from '../types';
import { RelayPool, type PublishResults } from './nostr';
import { StorageManager } from './storage';
import { IdentityManager } from './identity';
import type { ActivityPublisher } from './publisher';

export interface PendingPublish {
  type: 'invite' | 'friend_request' | 'message';
  event: NostrEvent;
  retryCount: number;
  lastRetryAt: number;
  createdAt: number;
  acceptedByRelays?: string[]; // Track which relays accepted this handshake message
}

export class PublishQueue {
  private userActionQueue: PendingPublish[] = [];
  private profileUpdatePending = false;
  private profileUpdateEvent: NostrEvent | null = null;
  private gameLibraryDue = false;
  private gameLibraryEvent: NostrEvent | null = null;
  private lastEventReplacedActivity = false;
  private publishIntervalMs: number;
  private publishInterval: NodeJS.Timeout | null = null;
  private relayPool: RelayPool;
  private storageManager: StorageManager;
  private activityPublisher: ActivityPublisher | null = null;
  private identityManager: IdentityManager | null = null;
  private isPublishing = false; // Semaphore to prevent concurrent publishes

  // Retry configuration
  private readonly MAX_RETRIES = 10;
  private readonly RETRY_BACKOFF_MS = [1, 2, 4, 8, 16, 32, 60, 60, 60, 60].map(s => s * 1000); // exponential backoff, capped at 60s

  constructor(relayPool: RelayPool, storageManager: StorageManager, publishIntervalMs: number = 12000) {
    this.relayPool = relayPool;
    this.storageManager = storageManager;
    this.publishIntervalMs = publishIntervalMs;
  }

  /**
   * Set the IdentityManager (called from background.ts after initialization)
   */
  setIdentityManager(identityManager: IdentityManager): void {
    this.identityManager = identityManager;
    console.debug('[PublishQueue] IdentityManager wired');
  }

  /**
   * Enqueue a user action (friend request, invite, or message)
   * These have highest priority and must publish within configured interval
   */
  async enqueueUserAction(event: NostrEvent, type: 'invite' | 'friend_request' | 'message'): Promise<void> {
    const pendingPublish: PendingPublish = {
      type,
      event,
      retryCount: 0,
      lastRetryAt: Date.now(),
      createdAt: Date.now(),
    };

    this.userActionQueue.push(pendingPublish);
    console.log(`[PublishQueue] Enqueued ${type} (queue size: ${this.userActionQueue.length})`);

    // Persist to storage
    await this._persistQueue();
  }

  /**
   * Mark profile update as pending
   */
  markProfileUpdatePending(event: NostrEvent): void {
    this.profileUpdatePending = true;
    this.profileUpdateEvent = event;
    console.log('[PublishQueue] Profile update marked as pending');
  }

  /**
   * Mark game library as due for publishing
   */
  markGameLibraryDue(event: NostrEvent): void {
    this.gameLibraryDue = true;
    this.gameLibraryEvent = event;
    console.log('[PublishQueue] Game library marked as due');
  }

  /**
   * Set the ActivityPublisher instance (called from background.ts after initialization)
   */
  setActivityPublisher(publisher: ActivityPublisher): void {
    this.activityPublisher = publisher;
    console.debug('[PublishQueue] ActivityPublisher wired');
  }

  /**
   * Start the publish cycle timer
   */
  start(): void {
    if (this.publishInterval) {
      clearInterval(this.publishInterval);
    }

    console.log(`[PublishQueue] Starting publish cycle (${this.publishIntervalMs}ms intervals)`);

    this.publishInterval = setInterval(async () => {
      await this._publishCycle();
    }, this.publishIntervalMs);

    // Restore pending items from storage
    this._restoreQueue().catch(err => console.error('[PublishQueue] Failed to restore queue:', err));
  }

  /**
   * Stop the publish cycle timer
   */
  stop(): void {
    if (this.publishInterval) {
      clearInterval(this.publishInterval);
      this.publishInterval = null;
      console.log('[PublishQueue] Publish cycle stopped');
    }
  }

  /**
   * Update the publish interval (rate change from settings)
   */
  setPublishInterval(intervalMs: number): void {
    this.publishIntervalMs = intervalMs;
    console.log(`[PublishQueue] Publish interval updated to ${intervalMs}ms`);

    // Restart with new interval
    if (this.publishInterval) {
      this.stop();
      this.start();
    }
  }

  /**
   * Refresh event timestamp to current time and re-finalize
   * Ensures replaceable/parameterized replaceable events always have strictly increasing created_at
   */
  private async _refreshEventTimestamp(event: NostrEvent): Promise<NostrEvent> {
    if (!this.identityManager) {
      console.warn('[PublishQueue] IdentityManager not available, publishing with stale timestamp');
      return event;
    }

    try {
      const secretKey = await this.identityManager.getSecretKey();
      const created_at = Math.floor(Date.now() / 1000);

      // Re-finalize the event with fresh timestamp
      const refreshedEvent = finalizeEvent({
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        created_at,
      }, this.hexToBytes(secretKey)) as NostrEvent;

      return refreshedEvent;
    } catch (error) {
      console.error('[PublishQueue] Failed to refresh event timestamp:', error);
      return event;
    }
  }

  /**
   * Helper: Convert hex string to Uint8Array (for nostr-tools finalizeEvent)
   */
  private hexToBytes(hex: string): Uint8Array {
    return new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  }

  /**
   * Main publish cycle - determines what to publish based on priority
   */
  private async _publishCycle(): Promise<void> {
    try {
      // Prevent concurrent publishes (replaceable events rely on monotonic timestamps)
      if (this.isPublishing) {
        console.debug('[PublishQueue] Already publishing, skipping cycle');
        return;
      }

      // Check if publishing is enabled globally
      const profile = await this.storageManager.getUserProfile();
      if (profile?.publisher_config && !profile.publisher_config.enabled) {
        console.debug('[PublishQueue] Publishing is disabled, skipping cycle');
        return;
      }

      this.isPublishing = true;

      let eventToPublish: NostrEvent | null = null;

      // Priority 1: User actions (always publish if pending)
      if (this.userActionQueue.length > 0) {
        const pending = this.userActionQueue[0];
        eventToPublish = pending.event;
        console.log(`[PublishQueue] Publishing priority 1: ${pending.type}`);
        this.lastEventReplacedActivity = false;
      }
      // Priority 2: Profile updates (if pending AND not replacing consecutively)
      else if (this.profileUpdatePending && !this.lastEventReplacedActivity && this.profileUpdateEvent) {
        eventToPublish = this.profileUpdateEvent;
        this.profileUpdatePending = false;
        this.profileUpdateEvent = null;
        console.log('[PublishQueue] Publishing priority 2: profile update');
        this.lastEventReplacedActivity = true;
      }
      // Priority 3: Game library (if due AND not replacing consecutively)
      else if (this.gameLibraryDue && !this.lastEventReplacedActivity && this.gameLibraryEvent) {
        eventToPublish = this.gameLibraryEvent;
        this.gameLibraryDue = false;
        this.gameLibraryEvent = null;
        console.log('[PublishQueue] Publishing priority 3: game library');
        this.lastEventReplacedActivity = true;
      }
      // Priority 4: Activities (always available, fills gaps, resets gap counter)
      // This is handled by caller (ActivityPublisher) who will call back

      // If we have an event to publish, refresh timestamp and publish it
      if (eventToPublish) {
        // Refresh created_at to current time for replaceable/parameterized replaceable events
        const eventToPublishWithFreshTimestamp = await this._refreshEventTimestamp(eventToPublish);
        try {
          const results = await this.relayPool.publish(eventToPublishWithFreshTimestamp);

          // Check if this is a handshake message (invite/friend_request) and if any relay accepted it
          if (this.userActionQueue.length > 0) {
            const pending = this.userActionQueue[0];
            const isHandshake = pending.type === 'invite' || pending.type === 'friend_request';

            if (isHandshake && results.overall_success) {
              // Track which relays accepted this handshake
              const acceptedRelays = results.relay_results
                .filter(r => r.success)
                .map(r => r.relay_url);

              if (acceptedRelays.length > 0) {
                if (!pending.acceptedByRelays) {
                  pending.acceptedByRelays = [];
                }
                pending.acceptedByRelays.push(...acceptedRelays);

                console.log(
                  `[PublishQueue] ✅ Handshake ${pending.type} accepted by ${acceptedRelays.length} relay(s), stopping retries (event: ${pending.event.id.substring(0, 16)}...)`
                );

                // Handshake accepted by at least one relay, remove from queue
                this.userActionQueue.shift();
                await this._persistQueue();
                return;
              }
            }

            // For non-handshake or if no relay accepted, treat as success and remove
            this.userActionQueue.shift();
            console.debug(`[PublishQueue] ✅ Successfully published ${pending.type}, removed from queue`);
            await this._persistQueue();
          }
        } catch (error) {
          // Publish failed, retry with backoff
          if (this.userActionQueue.length > 0) {
            const pending = this.userActionQueue[0];
            const isHandshake = pending.type === 'invite' || pending.type === 'friend_request';

            pending.retryCount++;

            if (pending.retryCount >= this.MAX_RETRIES) {
              // Exhausted retries, remove from queue
              this.userActionQueue.shift();
              const acceptedInfo = pending.acceptedByRelays?.length
                ? ` (accepted by ${pending.acceptedByRelays.length} relay/relays)`
                : '';
              console.warn(
                `[PublishQueue] ❌ Removed ${pending.type} after ${this.MAX_RETRIES} failed retries${acceptedInfo} (event: ${pending.event.id.substring(0, 16)}..., created: ${new Date(pending.createdAt).toISOString()})`
              );
            } else {
              // For handshakes, if no relay has accepted yet, keep retrying
              // For other messages, use standard backoff
              const backoffMs = this.RETRY_BACKOFF_MS[pending.retryCount - 1] || 60000;
              pending.lastRetryAt = Date.now() + backoffMs;
              console.log(
                `[PublishQueue] Scheduled retry for ${pending.type} in ${backoffMs}ms (attempt ${pending.retryCount}/${this.MAX_RETRIES}) after error: ${error instanceof Error ? error.message : String(error)}`
              );
            }

            // Persist updated queue
            await this._persistQueue();
          }
        }
      } else {
        // No high-priority event, publish activity
        this.lastEventReplacedActivity = false;
        if (this.activityPublisher) {
          await this.activityPublisher.publishActivityIfAllowed();
        } else {
          console.debug('[PublishQueue] ActivityPublisher not initialized, skipping activity publish');
        }
      }
    } catch (error) {
      console.error('[PublishQueue] Publish cycle failed:', error);
    } finally {
      // Always clear the publishing semaphore
      this.isPublishing = false;
    }
  }

  /**
   * Check if we should publish an activity this cycle
   * Returns false if we just published a high-priority event
   */
  shouldPublishActivity(): boolean {
    return !this.lastEventReplacedActivity;
  }

  /**
   * Persist queue to storage for recovery after restart
   */
  private async _persistQueue(): Promise<void> {
    try {
      // Only persist user actions (others are periodic and can be missed)
      const pending: PendingPublish[] = this.userActionQueue.filter(p => p.retryCount > 0 || Date.now() - p.createdAt < 5000);

      await this.storageManager.set('pending_publishes', pending);
    } catch (error) {
      console.error('[PublishQueue] Failed to persist queue:', error);
    }
  }

  /**
   * Restore queue from storage after restart
   */
  private async _restoreQueue(): Promise<void> {
    try {
      const pending = await this.storageManager.get<PendingPublish[]>('pending_publishes') || [];

      if (pending.length > 0) {
        this.userActionQueue = pending;
        console.log(`[PublishQueue] Restored ${pending.length} pending items from storage`);
      }
    } catch (error) {
      console.error('[PublishQueue] Failed to restore queue:', error);
    }
  }

  /**
   * Get current queue status (for debugging/monitoring)
   */
  getStatus(): {
    userActionsQueued: number;
    profilePending: boolean;
    gameLibraryDue: boolean;
    publishIntervalMs: number;
  } {
    return {
      userActionsQueued: this.userActionQueue.length,
      profilePending: this.profileUpdatePending,
      gameLibraryDue: this.gameLibraryDue,
      publishIntervalMs: this.publishIntervalMs,
    };
  }
}
