/**
 * Hang Time - Time Sync Manager Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TimeSyncManager } from '../time-sync';
import { NostrEvent } from '../../types';

describe('TimeSyncManager', () => {
  let timeSyncManager: TimeSyncManager;
  let mockRelayPool: any;
  let mockIdentityManager: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRelayPool = {
      publish: vi.fn().mockResolvedValue({ successes: 1, failures: 0 }),
    };
    mockIdentityManager = {
      getIdentifier: vi.fn().mockResolvedValue('TestIdentifier123'),
    };
    timeSyncManager = new TimeSyncManager(mockRelayPool, mockIdentityManager);
  });

  describe('publishTimeSync', () => {
    it('should publish time-sync event to relay pool', async () => {
      await timeSyncManager.publishTimeSync('video123', 150, 3600, true, 'youtube');

      expect(mockRelayPool.publish).toHaveBeenCalled();
      const event = mockRelayPool.publish.mock.calls[0][0];

      expect(event.kind).toBe(1);
      expect(event.tags).toContainEqual(['type', 'time-sync']);
      expect(event.tags).toContainEqual(['service', 'youtube']);
      expect(event.tags).toContainEqual(['video_id', 'video123']);
    });

    it('should include current time and duration in tags', async () => {
      await timeSyncManager.publishTimeSync('video123', 150, 3600, true, 'youtube');

      const event = mockRelayPool.publish.mock.calls[0][0];
      expect(event.tags).toContainEqual(['current_time', '150']);
      expect(event.tags).toContainEqual(['duration', '3600']);
    });
  });

  describe('handleTimeSyncEvent', () => {
    it('should parse time-sync event correctly', () => {
      const event: NostrEvent = {
        id: '1',
        pubkey: 'friend123',
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [
          ['type', 'time-sync'],
          ['service', 'youtube'],
          ['video_id', 'video123'],
          ['current_time', '150'],
          ['duration', '3600'],
          ['playing', 'true'],
        ],
        content: 'Watching youtube: video123 at 02:30/01:00:00',
      };

      const result = timeSyncManager.handleTimeSyncEvent(event);

      expect(result).toBeDefined();
      expect(result?.friendIdentifier).toBe('friend123');
      expect(result?.service).toBe('youtube');
      expect(result?.videoId).toBe('video123');
      expect(result?.currentTime).toBe(150);
      expect(result?.duration).toBe(3600);
      expect(result?.isPlaying).toBe(true);
    });

    it('should return null for non-time-sync events', () => {
      const event: NostrEvent = {
        id: '1',
        pubkey: 'friend123',
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [['service', 'spotify']],
        content: 'Playing music',
      };

      const result = timeSyncManager.handleTimeSyncEvent(event);

      expect(result).toBeNull();
    });

    it('should return null for malformed time-sync events', () => {
      const event: NostrEvent = {
        id: '1',
        pubkey: 'friend123',
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [['type', 'time-sync']],
        content: 'Incomplete event',
      };

      const result = timeSyncManager.handleTimeSyncEvent(event);

      expect(result).toBeNull();
    });
  });

  describe('getRecommendedSyncPosition', () => {
    it('should return null if no sync data for friend', () => {
      const result = timeSyncManager.getRecommendedSyncPosition('unknownFriend', 150);

      expect(result).toBeNull();
    });

    it('should return null if friend is not playing', () => {
      const event: NostrEvent = {
        id: '1',
        pubkey: 'friend123',
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [
          ['type', 'time-sync'],
          ['service', 'youtube'],
          ['video_id', 'video123'],
          ['current_time', '150'],
          ['duration', '3600'],
          ['playing', 'false'],
        ],
        content: 'Paused',
      };

      timeSyncManager.handleTimeSyncEvent(event);
      const result = timeSyncManager.getRecommendedSyncPosition('friend123', 150);

      expect(result).toBeNull();
    });

    it('should return position if difference is greater than tolerance', () => {
      const now = Date.now();
      const event: NostrEvent = {
        id: '1',
        pubkey: 'friend123',
        created_at: Math.floor(now / 1000),
        kind: 1,
        tags: [
          ['type', 'time-sync'],
          ['service', 'youtube'],
          ['video_id', 'video123'],
          ['current_time', '150'],
          ['duration', '3600'],
          ['playing', 'true'],
        ],
        content: 'Playing',
      };

      timeSyncManager.handleTimeSyncEvent(event);

      // Local position is 5 seconds behind (difference > 2s tolerance)
      const result = timeSyncManager.getRecommendedSyncPosition('friend123', 145);

      expect(result).toBeDefined();
      expect(result).toBeGreaterThan(0);
    });

    it('should return null if difference is within tolerance', () => {
      const now = Date.now();
      const event: NostrEvent = {
        id: '1',
        pubkey: 'friend123',
        created_at: Math.floor(now / 1000),
        kind: 1,
        tags: [
          ['type', 'time-sync'],
          ['service', 'youtube'],
          ['video_id', 'video123'],
          ['current_time', '150'],
          ['duration', '3600'],
          ['playing', 'true'],
        ],
        content: 'Playing',
      };

      timeSyncManager.handleTimeSyncEvent(event);

      // Local position is 0.5 seconds behind (difference < 2s tolerance)
      const result = timeSyncManager.getRecommendedSyncPosition('friend123', 149.5);

      expect(result).toBeNull();
    });
  });

  describe('startMonitoring', () => {
    it('should start cleanup interval', async () => {
      timeSyncManager.startMonitoring();

      expect(true).toBe(true); // Just verify it doesn't throw

      timeSyncManager.stopMonitoring();
    });
  });

  describe('stopMonitoring', () => {
    it('should stop cleanup interval', () => {
      timeSyncManager.startMonitoring();
      timeSyncManager.stopMonitoring();

      expect(true).toBe(true); // Just verify it doesn't throw
    });
  });
});
