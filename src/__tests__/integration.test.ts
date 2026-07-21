/**
 * Hang Time - Integration Tests
 * Test workflows that involve multiple modules working together
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FriendManager } from '../modules/friends';
import { MessagingManager } from '../modules/messaging';
import { TimeSyncManager } from '../modules/time-sync';
import { Activity, Friend } from '../types';

describe('Integration Tests', () => {
  let mockStorage: any;
  let mockRelayPool: any;
  let mockIdentity: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStorage = {
      getFriends: vi.fn().mockResolvedValue([]),
      getFriend: vi.fn(),
      getFriendByIdentifier: vi.fn(),
      addFriend: vi.fn(),
      removeFriend: vi.fn(),
      updateFriend: vi.fn(),
      addActivityToHistory: vi.fn(),
      getActivityHistory: vi.fn().mockResolvedValue([]),
      addMessage: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
      getUserProfile: vi.fn().mockResolvedValue(null),
      setUserProfile: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        notification_preferences: {
          friend_online: true,
          new_message: true,
          join_suggestion: false,
        },
      }),
    };

    mockRelayPool = {
      publish: vi.fn().mockResolvedValue({ successes: 1, failures: 0 }),
      subscribe: vi.fn(),
    };

    mockIdentity = {
      getIdentifier: vi.fn().mockResolvedValue('TestUser123'),
    };
  });

  describe('Friend Activity Flow', () => {
    it('should handle complete friend activity lifecycle', async () => {
      const friendManager = new FriendManager(mockStorage);
      const now = Date.now();

      // Step 1: Add friend
      const addedFriend = await friendManager.addFriend('FriendId123', 'Alice');
      expect(mockStorage.addFriend).toHaveBeenCalled();

      // Step 2: Update friend activity
      const activity: Activity = {
        service: 'spotify',
        content: 'Song Title',
        url: 'https://spotify.com/track/123',
        timestamp: now,
        metadata: { artist: 'Artist Name', duration: 180 },
      };

      // Mock getFriend to return the added friend
      mockStorage.getFriend.mockResolvedValueOnce(addedFriend);

      await friendManager.updateFriendActivity(addedFriend.id, activity);

      // Verify activity was updated and stored in history
      expect(mockStorage.updateFriend).toHaveBeenCalled();
      expect(mockStorage.addActivityToHistory).toHaveBeenCalled();

      // Step 3: Get active friends
      const friendWithActivity: Friend = {
        ...addedFriend,
        current_activity: activity,
        current_activity_timestamp: now,
      };

      mockStorage.getFriends.mockResolvedValueOnce([friendWithActivity]);

      const activeFriends = await friendManager.getActiveFriends();
      expect(activeFriends.length).toBeGreaterThan(0);
    });

    it('should filter out inactive friends', async () => {
      const friendManager = new FriendManager(mockStorage);
      const now = Date.now();

      const activeFriend: Friend = {
        id: '1',
        identifier: 'Active123',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: false,
        hidden_services: [],
        current_activity: {
          service: 'spotify',
          content: 'Song',
          timestamp: now,
          metadata: {},
        },
        current_activity_timestamp: now,
      };

      const idleFriend: Friend = {
        id: '2',
        identifier: 'Idle456',
        local_name: 'Bob',
        added_at: now,
        last_seen: now,
        muted: false,
        hidden_services: [],
        current_activity: {
          service: 'idle',
          content: 'Idle',
          timestamp: now,
          metadata: {},
        },
        current_activity_timestamp: now,
      };

      mockStorage.getFriends.mockResolvedValueOnce([activeFriend, idleFriend]);

      const activeFriends = await friendManager.getActiveFriends();

      expect(activeFriends).toHaveLength(1);
      expect(activeFriends[0].id).toBe('1');
    });

    it('should exclude muted friends from active list', async () => {
      const friendManager = new FriendManager(mockStorage);
      const now = Date.now();

      const activeFriend: Friend = {
        id: '1',
        identifier: 'Active123',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: true, // Muted
        hidden_services: [],
        current_activity: {
          service: 'spotify',
          content: 'Song',
          timestamp: now,
          metadata: {},
        },
        current_activity_timestamp: now,
      };

      mockStorage.getFriends.mockResolvedValueOnce([activeFriend]);

      const activeFriends = await friendManager.getActiveFriends();

      expect(activeFriends).toHaveLength(0);
    });
  });

  describe('Messaging Flow', () => {
    it('should handle complete message send and receive cycle', async () => {
      const messagingManager = new MessagingManager(mockStorage, mockIdentity, mockRelayPool);
      const now = Date.now();

      // Step 1: Create friend
      const friend: Friend = {
        id: 'friend1',
        identifier: 'FriendId123',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: false,
        hidden_services: [],
      };

      mockStorage.getFriend.mockResolvedValueOnce(friend);

      // Step 2: Send message
      const sentMessage = await messagingManager.sendMessage('friend1', 'Hello Alice!');

      expect(sentMessage).toBeDefined();
      expect(sentMessage.content).toBe('Hello Alice!');
      expect(sentMessage.is_outbound).toBe(true);
      expect(mockStorage.addMessage).toHaveBeenCalled();
      expect(mockRelayPool.publish).toHaveBeenCalled();

      // Step 3: Receive message
      // Mock getFriends for receiveMessage to find the friend
      mockStorage.getFriends.mockResolvedValueOnce([friend]);

      const receivedMessage = await messagingManager.receiveMessage(
        'FriendId123',
        'Hi back!',
        now + 5000
      );

      expect(receivedMessage).toBeDefined();
      expect(receivedMessage?.content).toBe('Hi back!');
      expect(receivedMessage?.is_outbound).toBe(false);
      expect(mockStorage.addMessage).toHaveBeenCalledTimes(2);

      // Step 4: Get conversation
      const messages = await messagingManager.getMessages('friend1');
      expect(messages).toBeDefined();
      expect(mockStorage.getMessages).toHaveBeenCalled();
    });

    it('should track unread messages correctly', async () => {
      const messagingManager = new MessagingManager(mockStorage, mockIdentity, mockRelayPool);

      const messages = [
        { id: '1', is_outbound: true, read: true },
        { id: '2', is_outbound: false, read: false },
        { id: '3', is_outbound: false, read: false },
      ];

      mockStorage.getMessages.mockResolvedValueOnce(messages);

      const unreadCount = await messagingManager.getUnreadCount('friend1');

      expect(unreadCount).toBe(2);
    });
  });

  describe('Time Sync Flow', () => {
    it('should handle complete time-sync cycle', async () => {
      const timeSyncManager = new TimeSyncManager(mockRelayPool, mockIdentity);
      const now = Date.now();

      // Step 1: User publishes their playback position
      await timeSyncManager.publishTimeSync('video123', 150, 3600, true, 'youtube');

      expect(mockRelayPool.publish).toHaveBeenCalled();
      const publishedEvent = mockRelayPool.publish.mock.calls[0][0];
      expect(publishedEvent.tags).toContainEqual(['current_time', '150']);

      // Step 2: Receive friend's sync event
      const friendSyncEvent = {
        id: '1',
        pubkey: 'friend123',
        created_at: Math.floor(now / 1000),
        kind: 1,
        tags: [
          ['type', 'time-sync'],
          ['service', 'youtube'],
          ['video_id', 'video123'],
          ['current_time', '155'],
          ['duration', '3600'],
          ['playing', 'true'],
        ],
        content: 'Watching at 02:35',
      };

      timeSyncManager.startMonitoring();
      const syncData = timeSyncManager.handleTimeSyncEvent(friendSyncEvent);

      expect(syncData).toBeDefined();
      expect(syncData?.currentTime).toBe(155);
      expect(syncData?.isPlaying).toBe(true);

      // Step 3: Calculate if sync is needed
      const recommendedPosition = timeSyncManager.getRecommendedSyncPosition('friend123', 150);

      // Should recommend sync since friend is 5 seconds ahead
      expect(recommendedPosition).toBeDefined();

      timeSyncManager.stopMonitoring();
    });

    it('should not recommend sync if within tolerance', () => {
      const timeSyncManager = new TimeSyncManager(mockRelayPool, mockIdentity);
      const now = Date.now();

      // Friend at 150s
      const friendSyncEvent = {
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

      timeSyncManager.handleTimeSyncEvent(friendSyncEvent);

      // Local at 150.5s (within 2s tolerance)
      const recommendedPosition = timeSyncManager.getRecommendedSyncPosition('friend123', 150.5);

      // Should NOT recommend sync
      expect(recommendedPosition).toBeNull();
    });
  });

  describe('Friend Management with Muting', () => {
    it('should hide service from specific friend', async () => {
      const friendManager = new FriendManager(mockStorage);
      const now = Date.now();

      const friend: Friend = {
        id: '1',
        identifier: 'Friend123',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: false,
        hidden_services: [],
      };

      mockStorage.getFriend.mockResolvedValueOnce(friend);

      await friendManager.hideServiceFromFriend('1', 'spotify');

      expect(mockStorage.updateFriend).toHaveBeenCalledWith('1', {
        hidden_services: ['spotify'],
      });
    });

    it('should show service to friend after hiding', async () => {
      const friendManager = new FriendManager(mockStorage);
      const now = Date.now();

      const friend: Friend = {
        id: '1',
        identifier: 'Friend123',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: false,
        hidden_services: ['spotify'],
      };

      mockStorage.getFriend.mockResolvedValueOnce(friend);

      await friendManager.showServiceToFriend('1', 'spotify');

      expect(mockStorage.updateFriend).toHaveBeenCalledWith('1', {
        hidden_services: [],
      });
    });
  });

  describe('Activity History', () => {
    it('should maintain activity history for each friend', async () => {
      const friendManager = new FriendManager(mockStorage);
      const now = Date.now();

      const friend: Friend = {
        id: 'friend1',
        identifier: 'FriendId123',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: false,
        hidden_services: [],
      };

      mockStorage.getFriend.mockResolvedValue(friend);

      const activity1: Activity = {
        service: 'spotify',
        content: 'Song 1',
        timestamp: now,
        metadata: {},
      };

      const activity2: Activity = {
        service: 'youtube',
        content: 'Video 1',
        timestamp: now + 5000,
        metadata: {},
      };

      await friendManager.updateFriendActivity('friend1', activity1);
      await friendManager.updateFriendActivity('friend1', activity2);

      // Verify both activities were stored in history
      expect(mockStorage.addActivityToHistory).toHaveBeenCalledTimes(2);

      // Get history
      mockStorage.getActivityHistory.mockResolvedValueOnce([activity1, activity2]);
      const history = await friendManager.getActivityHistory('friend1');

      expect(history.length).toBe(2);
    });
  });
});
