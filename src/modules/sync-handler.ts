/**
 * Hang Time - Sync Handler
 * Handles sync request/response messages for playback synchronization
 */

import { NostrEvent } from '../types';
import { RelayPool } from './nostr';
import { StorageManager } from './storage';
import { IdentityManager } from './identity';
import { FriendManager } from './friends';
import type { PublishQueue } from './publish-queue';
import { finalizeEvent } from 'nostr-tools';

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
}

export class SyncHandler {
  private publishQueue: PublishQueue | null = null;

  constructor(
    private relayPool: RelayPool,
    private storageManager: StorageManager,
    private identityManager: IdentityManager,
    private friendManager: FriendManager
  ) {}

  /**
   * Set publish queue (called after initialization)
   */
  setPublishQueue(queue: PublishQueue): void {
    this.publishQueue = queue;
  }

  /**
   * Guest: Send sync request to host asking for current position
   */
  async sendSyncRequest(hostFriendId: string, activityId: string): Promise<void> {
    try {
      const host = await this.friendManager.getFriend(hostFriendId);
      if (!host) {
        throw new Error(`Host friend not found: ${hostFriendId}`);
      }

      const profile = await this.storageManager.getUserProfile();
      if (!profile) {
        throw new Error('No user profile');
      }

      const secretKeyHex = await this.identityManager.getSecretKey();

      // Create sync_request event (kind 1059 encrypted to host)
      const messageContent = JSON.stringify({
        type: 'sync_request',
        activity_id: activityId,
        requested_at: Math.floor(Date.now() / 1000),
      });

      // For now, publish as kind 1 (unencrypted) for simplicity
      // TODO: Encrypt with NIP-44 when available
      const event = finalizeEvent({
        kind: 1,
        tags: [
          ['activity', activityId],
          ['type', 'sync_request'],
          ['p', host.pubkey], // Tag the host
        ],
        content: messageContent,
        created_at: Math.floor(Date.now() / 1000),
      }, hexToBytes(secretKeyHex)) as unknown as NostrEvent;

      // Enqueue as immediate (highest priority)
      if (this.publishQueue) {
        await this.publishQueue.enqueueImmediate(event, 'sync_request');
      } else {
        // Fallback: publish directly
        await this.relayPool.publish(event);
      }

      console.debug('[SyncHandler] Sync request sent to', host.local_name, 'for activity', activityId);
    } catch (error) {
      console.error('[SyncHandler] Failed to send sync request:', error);
      throw error;
    }
  }

  /**
   * Host: Receive sync request and send response with current position
   */
  async handleSyncRequest(fromFriendId: string, activityId: string): Promise<void> {
    try {
      const friend = await this.friendManager.getFriend(fromFriendId);
      if (!friend) {
        console.debug('[SyncHandler] Friend not found for sync request:', fromFriendId);
        return;
      }

      const profile = await this.storageManager.getUserProfile();
      const currentActivity = (profile as any)?.current_activity;
      if (!currentActivity || currentActivity.id !== activityId) {
        console.debug('[SyncHandler] Host not watching this activity:', activityId);
        return;
      }

      // Get current playback position
      const position = currentActivity?.metadata?.progress || 0;

      await this.sendSyncResponse(fromFriendId, activityId, position);
      console.debug('[SyncHandler] Sync response sent to', friend.local_name);
    } catch (error) {
      console.error('[SyncHandler] Failed to handle sync request:', error);
    }
  }

  /**
   * Host: Send sync response with current playback position
   */
  async sendSyncResponse(guestFriendId: string, activityId: string, position: number): Promise<void> {
    try {
      const guest = await this.friendManager.getFriend(guestFriendId);
      if (!guest) {
        throw new Error(`Guest friend not found: ${guestFriendId}`);
      }

      const secretKeyHex = await this.identityManager.getSecretKey();

      const messageContent = JSON.stringify({
        type: 'sync_response',
        activity_id: activityId,
        position,
        sent_at: Math.floor(Date.now() / 1000),
      });

      const event = finalizeEvent({
        kind: 1,
        tags: [
          ['activity', activityId],
          ['type', 'sync_response'],
          ['p', guest.pubkey],
        ],
        content: messageContent,
        created_at: Math.floor(Date.now() / 1000),
      }, hexToBytes(secretKeyHex)) as unknown as NostrEvent;

      if (this.publishQueue) {
        await this.publishQueue.enqueueImmediate(event, 'sync_response');
      } else {
        await this.relayPool.publish(event);
      }

      console.debug('[SyncHandler] Sync response sent to', guest.local_name, 'position:', position);
    } catch (error) {
      console.error('[SyncHandler] Failed to send sync response:', error);
    }
  }

  /**
   * Guest: Handle sync response and update activity with fresh position
   */
  async handleSyncResponse(fromFriendId: string, activityId: string, position: number, sentAt: number): Promise<void> {
    try {
      const friend = await this.friendManager.getFriend(fromFriendId);
      if (!friend) {
        console.debug('[SyncHandler] Friend not found for sync response:', fromFriendId);
        return;
      }

      // Update friend's activity with fresh position and timestamp
      const activity = friend.current_activities
        ? Object.values(friend.current_activities).find(act => act?.id === activityId)
        : undefined;

      if (!activity) {
        console.debug('[SyncHandler] Activity not found in friend data:', activityId);
        return;
      }

      // Update with fresh position and timestamp
      if (activity.metadata) {
        activity.metadata.progress = position;
      }
      activity.freshness_timestamp = sentAt * 1000; // Convert to milliseconds

      await this.storageManager.updateFriend(fromFriendId, {
        current_activities: friend.current_activities,
      });

      console.debug('[SyncHandler] Sync response processed - activity position updated to', position, 'seconds');

      // Notify UI of sync completion
      window.postMessage({
        type: 'HANG_TIME_SYNC_COMPLETE',
        data: {
          activity_id: activityId,
          position,
          elapsed: (Date.now() - sentAt * 1000) / 1000,
        },
      }, '*');
    } catch (error) {
      console.error('[SyncHandler] Failed to handle sync response:', error);
    }
  }

  /**
   * Calculate seek position accounting for latency
   * seekPosition = hostPosition + (now - sentAt)
   */
  static calculateSeekPosition(hostPosition: number, sentAtTimestamp: number): number {
    const now = Date.now();
    const elapsedSeconds = (now - sentAtTimestamp) / 1000;
    return hostPosition + elapsedSeconds;
  }
}

// Singleton instance
let instance: SyncHandler | null = null;

export function initializeSyncHandler(
  relayPool: RelayPool,
  storageManager: StorageManager,
  identityManager: IdentityManager,
  friendManager: FriendManager
): void {
  instance = new SyncHandler(relayPool, storageManager, identityManager, friendManager);
}

export function getSyncHandler(): SyncHandler {
  if (!instance) {
    throw new Error('SyncHandler not initialized');
  }
  return instance;
}
