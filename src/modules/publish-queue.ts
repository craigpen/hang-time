/**
 * Hang Time - Unified Publish Queue
 * Manages rate-limited publishing across all event types with three-tier priority:
 * 1. User actions (friend requests, invites, messages) - highest priority
 * 2. Profile & game library updates - medium priority
 * 3. Activities - base case, must publish at least every other cycle
 */

import { NostrEvent } from '../types';
import { RelayPool } from './nostr';
import { StorageManager } from './storage';
import type { ActivityPublisher } from './publisher';

export interface PendingPublish {
  type: 'invite' | 'friend_request' | 'message';
  event: NostrEvent;
  retryCount: number;
  lastRetryAt: number;
  createdAt: number;
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

  // Retry configuration
  private readonly MAX_RETRIES = 10;
  private readonly RETRY_BACKOFF_MS = [1, 2, 4, 8, 16, 32, 60, 60, 60, 60].map(s => s * 1000); // exponential backoff, capped at 60s

  constructor(relayPool: RelayPool, storageManager: StorageManager, publishIntervalMs: number = 12000) {
    this.relayPool = relayPool;
    this.storageManager = storageManager;
    this.publishIntervalMs = publishIntervalMs;
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
   * Main publish cycle - determines what to publish based on priority
   */
  private async _publishCycle(): Promise<void> {
    try {
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

      // If we have an event to publish, publish it
      if (eventToPublish) {
        await this.relayPool.publish(eventToPublish);

        // If this was a user action, remove from queue and retry on failure
        if (this.userActionQueue.length > 0) {
          const pending = this.userActionQueue[0];
          pending.retryCount++;

          if (pending.retryCount >= this.MAX_RETRIES) {
            // Exhausted retries, remove from queue
            this.userActionQueue.shift();
            console.warn(`[PublishQueue] Removed ${pending.type} after ${this.MAX_RETRIES} failed retries`);
          } else {
            // Schedule retry
            const backoffMs = this.RETRY_BACKOFF_MS[pending.retryCount - 1] || 60000;
            pending.lastRetryAt = Date.now() + backoffMs;
            console.log(`[PublishQueue] Scheduled retry for ${pending.type} in ${backoffMs}ms (attempt ${pending.retryCount}/${this.MAX_RETRIES})`);
          }

          // Persist updated queue
          await this._persistQueue();
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

      await this.storageManager.setData('pending_publishes', pending);
    } catch (error) {
      console.error('[PublishQueue] Failed to persist queue:', error);
    }
  }

  /**
   * Restore queue from storage after restart
   */
  private async _restoreQueue(): Promise<void> {
    try {
      const pending = await this.storageManager.getData('pending_publishes') as PendingPublish[] || [];

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
