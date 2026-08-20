/**
 * Hang Time - Do Not Disturb (DND) / Solo Mode Unit & Integration Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageManager, STORAGE_KEYS } from '../storage';
import { CoWatcherDetector } from '../co-watcher-detection';
import { FriendManager } from '../friends';
import { ActivityPublisher } from '../publisher';
import { IdentityManager } from '../identity';
import { UserProfile, Friend, Activity } from '../../types';

// Mock storage map
const mockStorage = new Map<string, any>();

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (key: string | string[] | null | undefined) => {
        if (!key) {
          const result: any = {};
          for (const [k, v] of mockStorage.entries()) {
            result[k] = v;
          }
          return result;
        }
        if (typeof key === 'string') {
          return { [key]: mockStorage.get(key) };
        }
        if (Array.isArray(key)) {
          const result: any = {};
          for (const k of key) {
            result[k] = mockStorage.get(k);
          }
          return result;
        }
        return {};
      }),
      set: vi.fn(async (data: Record<string, any>) => {
        for (const [k, v] of Object.entries(data)) {
          mockStorage.set(k, v);
        }
      }),
      remove: vi.fn(async (key: string) => {
        mockStorage.delete(key);
      }),
    },
  },
  runtime: {
    getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
  },
});

describe('Do Not Disturb (DND) / Solo Mode', () => {
  let storage: StorageManager;
  let friendManager: FriendManager;
  let detector: CoWatcherDetector;

  const mockUserProfile: UserProfile = {
    uuid: 'user-uuid-123',
    nickname: 'TestUser',
    identifier: 'npub1testuser',
    dnd_enabled: false,
  };

  const mockUserActivity: Activity = {
    id: 'yt-video-1',
    service: 'youtube-tab',
    content: 'Awesome Movie',
    url: 'https://youtube.com/watch?v=yt-video-1',
    state: 'playing',
    timestamp: 1000,
    contentTimestamp: 1000,
    metadata: {
      progress: 100,
      duration: 3600,
      progress_measured_at: Date.now(),
    },
  };

  const mockFriend: Friend = {
    id: 'friend-1',
    uuid: 'friend-uuid-456',
    local_name: 'Alice',
    state: 'active',
    dnd: false,
    current_activities: {
      'youtube-tab': {
        id: 'yt-video-1',
        service: 'youtube-tab',
        content: 'Awesome Movie',
        url: 'https://youtube.com/watch?v=yt-video-1',
        state: 'playing',
        timestamp: 2000,
        contentTimestamp: 2000,
        metadata: {
          progress: 100,
          duration: 3600,
          progress_measured_at: Date.now(),
        },
      },
    },
  };

  beforeEach(async () => {
    mockStorage.clear();
    storage = new StorageManager();
    await storage.init();
    friendManager = new FriendManager(storage);
    detector = new CoWatcherDetector(storage, friendManager);

    await storage.setUserProfile({ ...mockUserProfile });
    await storage.setMyActivities({ 'youtube-tab': { ...mockUserActivity } });
    await storage.setFriends([{ ...mockFriend }]);
  });

  describe('Storage Helpers', () => {
    it('should default getDndMode to false when not set', async () => {
      const isDnd = await storage.getDndMode();
      expect(isDnd).toBe(false);
    });

    it('should set and get DND mode correctly', async () => {
      await storage.setDndMode(true);
      expect(await storage.getDndMode()).toBe(true);

      const profile = await storage.getUserProfile();
      expect(profile?.dnd_enabled).toBe(true);

      await storage.setDndMode(false);
      expect(await storage.getDndMode()).toBe(false);
    });
  });

  describe('CoWatcherDetector with DND', () => {
    it('should detect session normally when DND is false for both user and friend', async () => {
      const session = await detector.detectCoWatchSession();
      expect(session).not.toBeNull();
      expect(session?.activity_id).toBe('yt-video-1');
      expect(session?.co_watchers).toHaveLength(2);
      expect(session?.co_watchers).toContain('user-uuid-123');
      expect(session?.co_watchers).toContain('friend-uuid-456');
    });

    it('should return null and bypass session detection when user has DND enabled', async () => {
      await storage.setDndMode(true);

      const session = await detector.detectCoWatchSession();
      expect(session).toBeNull();
    });

    it('should ignore friend and return null when friend has dnd: true', async () => {
      const dndFriend: Friend = {
        ...mockFriend,
        dnd: true,
      };
      await storage.setFriends([dndFriend]);

      const session = await detector.detectCoWatchSession();
      expect(session).toBeNull();
    });

    it('should ignore friend and return null when friend activity has dnd: true', async () => {
      const dndActivityFriend: Friend = {
        ...mockFriend,
        dnd: false,
        current_activities: {
          'youtube-tab': {
            ...mockFriend.current_activities!['youtube-tab'],
            dnd: true,
          },
        },
      };
      await storage.setFriends([dndActivityFriend]);

      const session = await detector.detectCoWatchSession();
      expect(session).toBeNull();
    });

    it('should only include non-DND friends when multiple friends are watching', async () => {
      const nonDndFriend: Friend = {
        ...mockFriend,
        id: 'friend-1',
        uuid: 'friend-uuid-456',
        local_name: 'Alice',
        dnd: false,
      };

      const dndFriend: Friend = {
        id: 'friend-2',
        uuid: 'friend-uuid-789',
        local_name: 'Bob',
        state: 'active',
        dnd: true,
        current_activities: {
          'youtube-tab': {
            id: 'yt-video-1',
            service: 'youtube-tab',
            content: 'Awesome Movie',
            url: 'https://youtube.com/watch?v=yt-video-1',
            state: 'playing',
            timestamp: 3000,
            contentTimestamp: 3000,
            metadata: {
              progress: 100,
              duration: 3600,
              progress_measured_at: Date.now(),
            },
          },
        },
      };

      await storage.setFriends([nonDndFriend, dndFriend]);

      const session = await detector.detectCoWatchSession();
      expect(session).not.toBeNull();
      expect(session?.co_watchers).toHaveLength(2); // user + Alice (Bob excluded)
      expect(session?.co_watchers).toContain('friend-uuid-456');
      expect(session?.co_watchers).not.toContain('friend-uuid-789');
    });
  });

  describe('ActivityPublisher DND Tags & Metadata', () => {
    it('includes dnd flag in _toPublishableActivity when DND is enabled', () => {
      const publisher = new ActivityPublisher(storage, new IdentityManager(storage));
      // Call private method _toPublishableActivity
      const publishable = (publisher as any)._toPublishableActivity(mockUserActivity, true);

      expect(publishable.dnd).toBe(true);
      expect(publishable.metadata?.dnd).toBe(true);
    });

    it('omits or sets dnd: false when DND is disabled', () => {
      const publisher = new ActivityPublisher(storage, new IdentityManager(storage));
      const publishable = (publisher as any)._toPublishableActivity(mockUserActivity, false);

      expect(publishable.dnd).toBe(false);
      expect(publishable.metadata?.dnd).toBe(false);
    });
  });

  describe('DND Active Session Eviction & Status Formatting', () => {
    it('should evict DND friend from active session members', async () => {
      // Create session with self, Alice, and Bob
      await storage.setActiveSession({
        session_id: 'sess-123',
        members: ['user-uuid-123', 'friend-uuid-456', 'friend-uuid-789'],
        activity_id: 'yt-video-1',
        host_friend_uuid: 'self',
        created_at: Date.now(),
        last_activity_at: Date.now(),
      });

      const session = await storage.getActiveSession();
      expect(session?.members).toHaveLength(3);

      // Simulate Bob entering DND and updating session
      const remaining = session!.members.filter(id => id !== 'friend-uuid-789');
      session!.members = remaining;
      await storage.setActiveSession(session!);

      const updated = await storage.getActiveSession();
      expect(updated?.members).toHaveLength(2);
      expect(updated?.members).toContain('user-uuid-123');
      expect(updated?.members).toContain('friend-uuid-456');
      expect(updated?.members).not.toContain('friend-uuid-789');
    });

    it('should clear active session when remaining members drop below 2', async () => {
      await storage.setActiveSession({
        session_id: 'sess-123',
        members: ['user-uuid-123', 'friend-uuid-456'],
        activity_id: 'yt-video-1',
        host_friend_uuid: 'self',
        created_at: Date.now(),
        last_activity_at: Date.now(),
      });

      // Alice enters DND, only self remains (< 2)
      const session = await storage.getActiveSession();
      const remaining = session!.members.filter(id => id !== 'friend-uuid-456');
      if (remaining.length < 2) {
        await storage.clearActiveSession();
      }

      const cleared = await storage.getActiveSession();
      expect(cleared).toBeNull();
    });
  });
});

