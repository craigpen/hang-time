/**
 * Hang Time - Time Sync Module
 * Synchronizes playback position for video content (YouTube, Netflix, etc.)
 */

import { NostrEvent } from '../types';
import { RelayPool } from './nostr';
import { IdentityManager } from './identity';

export interface TimeSyncEvent {
  friendIdentifier: string;
  service: string;
  videoId: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  timestamp: number;
}

export class TimeSyncManager {
  private timeSyncSubscriptions = new Map<string, TimeSyncEvent>();
  private syncTolerance = 2000; // Allow 2 second difference
  private syncInterval: NodeJS.Timeout | null = null;

  static readonly SYNC_CHECK_INTERVAL_MS = 1000; // Check every 1 second

  constructor(
    private relayPool: RelayPool,
    private identityManager: IdentityManager
  ) {}

  /**
   * Publish time-sync event to Nostr
   */
  async publishTimeSync(
    videoId: string,
    currentTime: number,
    duration: number,
    isPlaying: boolean,
    service: string
  ): Promise<void> {
    try {
      const userIdentifier = await this.identityManager.getIdentifier();

      const event: NostrEvent = {
        id: this._generateId(),
        pubkey: userIdentifier,
        created_at: Math.floor(Date.now() / 1000),
        kind: 1, // Use kind 1 for time-sync events with special tags
        tags: [
          ['type', 'time-sync'],
          ['service', service],
          ['video_id', videoId],
          ['current_time', Math.floor(currentTime).toString()],
          ['duration', Math.floor(duration).toString()],
          ['playing', isPlaying ? 'true' : 'false'],
        ],
        content: `Watching ${service}: ${videoId} at ${this._formatTime(currentTime)}/${this._formatTime(duration)}`,
      };

      await this.relayPool.publish(event);
      console.debug(`[TimeSync] Published sync for ${videoId} at ${this._formatTime(currentTime)}`);
    } catch (error) {
      console.error('[TimeSync] Failed to publish time-sync:', error);
    }
  }

  /**
   * Handle incoming time-sync event from friend
   */
  handleTimeSyncEvent(event: NostrEvent): TimeSyncEvent | null {
    try {
      // Extract time-sync data from tags
      const typeTag = event.tags.find((t) => t[0] === 'type')?.[1];
      if (typeTag !== 'time-sync') {
        return null;
      }

      const service = event.tags.find((t) => t[0] === 'service')?.[1];
      const videoId = event.tags.find((t) => t[0] === 'video_id')?.[1];
      const currentTimeStr = event.tags.find((t) => t[0] === 'current_time')?.[1];
      const durationStr = event.tags.find((t) => t[0] === 'duration')?.[1];
      const playingStr = event.tags.find((t) => t[0] === 'playing')?.[1];

      if (!service || !videoId || !currentTimeStr || !durationStr) {
        return null;
      }

      const timeSyncEvent: TimeSyncEvent = {
        friendIdentifier: event.pubkey,
        service,
        videoId,
        currentTime: parseInt(currentTimeStr, 10),
        duration: parseInt(durationStr, 10),
        isPlaying: playingStr === 'true',
        timestamp: event.created_at * 1000,
      };

      this.timeSyncSubscriptions.set(event.pubkey, timeSyncEvent);
      console.debug(`[TimeSync] Received sync from ${event.pubkey.substring(0, 8)}: ${videoId}`);

      return timeSyncEvent;
    } catch (error) {
      console.error('[TimeSync] Failed to parse time-sync event:', error);
      return null;
    }
  }

  /**
   * Get current sync state for a friend
   */
  getTimeSyncForFriend(friendIdentifier: string): TimeSyncEvent | undefined {
    return this.timeSyncSubscriptions.get(friendIdentifier);
  }

  /**
   * Calculate recommended playback position based on friend's position
   */
  getRecommendedSyncPosition(friendIdentifier: string, currentLocalTime: number): number | null {
    const friendSync = this.timeSyncSubscriptions.get(friendIdentifier);
    if (!friendSync || !friendSync.isPlaying) {
      return null;
    }

    // Calculate time elapsed since friend's last sync
    const timeSinceSync = Date.now() - friendSync.timestamp;
    const estimatedFriendPosition = friendSync.currentTime + timeSinceSync / 1000;

    // Check if difference is within tolerance
    const diff = Math.abs(estimatedFriendPosition - currentLocalTime);
    if (diff > this.syncTolerance / 1000) {
      return estimatedFriendPosition;
    }

    return null;
  }

  /**
   * Start monitoring time-sync for a friend
   */
  startMonitoring(): void {
    if (this.syncInterval) {
      return;
    }

    this.syncInterval = setInterval(() => {
      // Clean up old sync events (older than 30 seconds)
      const now = Date.now();
      for (const [identifier, sync] of this.timeSyncSubscriptions.entries()) {
        if (now - sync.timestamp > 30000) {
          this.timeSyncSubscriptions.delete(identifier);
        }
      }
    }, TimeSyncManager.SYNC_CHECK_INTERVAL_MS);
  }

  /**
   * Stop monitoring time-sync
   */
  stopMonitoring(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  private _formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  private _generateId(): string {
    return Math.random().toString(36).substring(2, 15);
  }
}

// Singleton instance with lazy initialization
let timeSyncManager: TimeSyncManager | null = null;

export function initializeTimeSyncManager(relayPool: RelayPool, identity: IdentityManager): void {
  timeSyncManager = new TimeSyncManager(relayPool, identity);
}

export function getTimeSyncManager(): TimeSyncManager {
  if (!timeSyncManager) {
    throw new Error('TimeSyncManager not initialized');
  }
  return timeSyncManager;
}
