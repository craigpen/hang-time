/**
 * Hang Time - Activity Publisher Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActivityPublisher } from '../publisher';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

describe('ActivityPublisher', () => {
  let publisher: ActivityPublisher;
  let mockRelayPool: any;
  let mockStorageManager: any;
  let mockIdentityManager: any;
  let testSecretKeyHex: string;
  let testPubkey: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    const sk = generateSecretKey();
    testSecretKeyHex = Buffer.from(sk).toString('hex');
    testPubkey = getPublicKey(sk);

    mockRelayPool = {
      publish: vi.fn().mockResolvedValue({ overall_success: true, relay_results: [] }),
    };

    mockStorageManager = {
      getUserProfile: vi.fn().mockResolvedValue({
        pubkey: testPubkey,
        secret_key: testSecretKeyHex,
        nickname: 'Alice',
        publisher_config: {
          enabled: true,
          rate_ms: 12000,
        },
      }),
      getMyActivities: vi.fn().mockResolvedValue({}),
      getUserActivities: vi.fn().mockResolvedValue([]),
    };

    mockIdentityManager = {
      getPubkey: vi.fn().mockResolvedValue(testPubkey),
      getSecretKey: vi.fn().mockResolvedValue(testSecretKeyHex),
    };

    publisher = new ActivityPublisher(mockRelayPool, mockStorageManager, mockIdentityManager);
  });

  describe('publishActivityIfAllowed', () => {
    it('should publish empty activity bundle when user has 0 activities (idle state)', async () => {
      mockStorageManager.getMyActivities.mockResolvedValue({});

      await publisher.publishActivityIfAllowed();

      expect(mockRelayPool.publish).toHaveBeenCalledTimes(1);
      const publishedEvent = mockRelayPool.publish.mock.calls[0][0];

      expect(publishedEvent.kind).toBe(10003);
      expect(publishedEvent.content).toBe('[]');
      expect(publishedEvent.tags).toEqual(
        expect.arrayContaining([
          ['type', 'bundled'],
          ['count', '0'],
        ])
      );
    });

    it('should publish bundled activities when user has active media', async () => {
      const activeVideo = {
        id: 'act1',
        service: 'youtube-tab',
        content: 'Epic Video',
        url: 'https://youtube.com/watch?v=123',
        state: 'playing',
        timestamp: Date.now(),
        metadata: { duration: 300, progress: 10 },
      };

      mockStorageManager.getMyActivities.mockResolvedValue({
        act1: activeVideo,
      });

      await publisher.publishActivityIfAllowed();

      expect(mockRelayPool.publish).toHaveBeenCalledTimes(1);
      const publishedEvent = mockRelayPool.publish.mock.calls[0][0];

      expect(publishedEvent.kind).toBe(10003);
      const parsedContent = JSON.parse(publishedEvent.content);
      expect(parsedContent).toHaveLength(1);
      expect(parsedContent[0].service).toBe('youtube-tab');
      expect(parsedContent[0].content).toBe('Epic Video');
    });

    it('should skip publishing if publisher is disabled in config', async () => {
      mockStorageManager.getUserProfile.mockResolvedValue({
        publisher_config: { enabled: false },
      });

      await publisher.publishActivityIfAllowed();

      expect(mockRelayPool.publish).not.toHaveBeenCalled();
    });
  });
});
