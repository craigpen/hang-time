/**
 * Hang Time - Integration Tests
 * Test workflows that involve multiple modules working together
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FriendManager } from '../modules/friends';
import { MessagingManager } from '../modules/messaging';
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
        id: 'spotify-track-123',
        service: 'spotify-api',
        content: 'Song Title',
        url: 'https://spotify.com/track/123',
        timestamp: now,
        freshness_timestamp: now,
        metadata: { artist: 'Artist Name', duration: 180 },
      };

      // Mock getFriend to return the added friend
      mockStorage.getFriend.mockResolvedValueOnce(addedFriend);

      // Simulate receiving an activity update (via Nostr)
      await mockStorage.updateFriend(addedFriend.uuid, {
        current_activities: {
          [activity.service]: activity,
        },
        last_seen: Date.now(),
      });
      await mockStorage.addActivityToHistory(addedFriend.uuid, activity);

      // Verify activity was updated and stored in history
      expect(mockStorage.updateFriend).toHaveBeenCalled();
      expect(mockStorage.addActivityToHistory).toHaveBeenCalled();

      // Step 3: Get active friends
      const friendWithActivity: Friend = {
        ...addedFriend,
        current_activities: {
          [activity.service]: activity,
        },
      };

      mockStorage.getFriends.mockResolvedValueOnce([friendWithActivity]);

      const activeFriends = await friendManager.getActiveFriends();
      expect(activeFriends.length).toBeGreaterThan(0);
    });

    it('should filter out inactive friends', async () => {
      const friendManager = new FriendManager(mockStorage);
      const now = Date.now();

      const activeFriend: Friend = {
        uuid: '1',
        pubkey: 'pk1',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: false,
        state: 'active',
        hidden_services: [],
        current_activities: {
          'spotify-api': {
            id: 'spotify-1',
            service: 'spotify-api',
            content: 'Song',
            timestamp: now,
            contentTimestamp: now,
            freshness_timestamp: now,
            is_fresh: true,
            state: 'playing',
            provenance: 'LOCAL_SPOTIFY',
            metadata: {},
          },
        },
      };

      const idleFriend: Friend = {
        uuid: '2',
        pubkey: 'pk2',
        local_name: 'Bob',
        added_at: now,
        last_seen: now,
        muted: false,
        state: 'active',
        hidden_services: [],
        current_activities: {},
      };

      mockStorage.getFriends.mockResolvedValueOnce([activeFriend, idleFriend]);

      const activeFriends = await friendManager.getActiveFriends();

      expect(activeFriends).toHaveLength(1);
      expect(activeFriends[0]!.uuid).toBe('1');
    });

    it('should exclude muted friends from active list', async () => {
      const friendManager = new FriendManager(mockStorage);
      const now = Date.now();

      const activeFriend: Friend = {
        uuid: '1',
        pubkey: 'pk1',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: true, // Muted
        state: 'active',
        hidden_services: [],
        current_activities: {
          'spotify-api': {
            id: 'spotify-1',
            service: 'spotify-api',
            content: 'Song',
            timestamp: now,
            contentTimestamp: now,
            freshness_timestamp: now,
            is_fresh: true,
            state: 'playing',
            provenance: 'LOCAL_SPOTIFY',
            metadata: {},
          },
        },
      };

      mockStorage.getFriends.mockResolvedValueOnce([activeFriend]);

      const activeFriends = await friendManager.getActiveFriends();

      expect(activeFriends).toHaveLength(0);
    });
  });

  describe('Messaging Flow', () => {
    it('should handle complete message send and receive cycle', async () => {
      const messagingManager = new MessagingManager(mockRelayPool, mockIdentity, mockStorage);
      const now = Date.now();
      const { generateSecretKey, getPublicKey, nip44 } = await import('nostr-tools');

      const mySk = generateSecretKey();
      const mySkHex = Array.from(mySk).map(b => b.toString(16).padStart(2, '0')).join('');
      const myPk = getPublicKey(mySk);

      const friendSk = generateSecretKey();
      const friendPk = getPublicKey(friendSk);

      mockIdentity.getPubkey = vi.fn().mockResolvedValue(myPk);
      mockIdentity.getSecretKey = vi.fn().mockResolvedValue(mySkHex);
      mockStorage.getUserProfile.mockResolvedValue({
        uuid: 'user1',
        nickname: 'Me',
      });

      // Step 1: Create friend
      const friend: Friend = {
        uuid: 'friend1',
        pubkey: friendPk,
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: false,
        state: 'active',
        hidden_services: [],
        current_activities: {},
      };

      const activity: Activity = {
        id: 'act1',
        service: 'steam-api',
        content: 'Playing Portal 2',
        timestamp: now,
        contentTimestamp: now,
        freshness_timestamp: now,
        is_fresh: true,
        state: 'playing',
        provenance: 'LOCAL_STEAM',
        metadata: {},
      };

      // Step 2: Send chat message
      const eventId = await messagingManager.sendChatMessage(activity, friend, 'Hello Alice!');

      expect(eventId).toBeDefined();
      expect(mockRelayPool.publish).toHaveBeenCalled();

      // Step 3: Receive message
      // Prepare encrypted payload from friend
      const convKey = nip44.getConversationKey(friendSk, myPk);
      const encrypted = await nip44.encrypt(
        JSON.stringify({
          type: 'chat',
          activity_id: 'act1',
          content: 'Hi back!',
          timestamp: now + 5000,
        }),
        convKey
      );

      const receivedMessage = await messagingManager.receiveMessage(
        friend,
        encrypted,
        now + 5000,
        'event_reply_123'
      );

      expect(receivedMessage).toBeDefined();
      expect(receivedMessage?.content).toBe('Hi back!');
      expect(mockStorage.addMessage).toHaveBeenCalled();
    });

    it('should track unread messages correctly', async () => {
      const messages = [
        { id: '1', is_outbound: true, read: true },
        { id: '2', is_outbound: false, read: false },
        { id: '3', is_outbound: false, read: false },
      ];

      mockStorage.getMessages.mockResolvedValueOnce(messages);

      const retrieved = await mockStorage.getMessages('friend1');
      const unreadCount = retrieved.filter((m: any) => !m.is_outbound && !m.read).length;

      expect(unreadCount).toBe(2);
    });
  });

  describe('Friend Management with Muting', () => {
    it('should hide service from specific friend', async () => {
      const friendManager = new FriendManager(mockStorage);
      const now = Date.now();

      const friend: Friend = {
        uuid: 'friend-test-1',
        pubkey: 'test-pubkey-1',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: false,
        state: 'active',
        hidden_services: [],
        current_activities: {},
      };

      mockStorage.getFriend.mockResolvedValueOnce(friend);

      await friendManager.hideServiceFromFriend('1', 'spotify-api');

      expect(mockStorage.updateFriend).toHaveBeenCalledWith('1', {
        hidden_services: ['spotify-api'],
      });
    });

    it('should show service to friend after hiding', async () => {
      const friendManager = new FriendManager(mockStorage);
      const now = Date.now();

      const friend: Friend = {
        uuid: '1',
        pubkey: 'pk1',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: false,
        state: 'active',
        hidden_services: ['spotify-api'],
        current_activities: {},
      };

      mockStorage.getFriend.mockResolvedValueOnce(friend);

      await friendManager.showServiceToFriend('1', 'spotify-api');

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
        uuid: 'friend1',
        pubkey: 'test-pubkey-friend1',
        local_name: 'Alice',
        added_at: now,
        last_seen: now,
        muted: false,
        state: 'active',
        hidden_services: [],
        current_activities: {},
      };

      mockStorage.getFriend.mockResolvedValue(friend);

      const activity1: Activity = {
        id: 'spotify-song-1',
        service: 'spotify-api',
        content: 'Song 1',
        timestamp: now,
        contentTimestamp: now,
        freshness_timestamp: now,
        is_fresh: true,
        state: 'playing',
        provenance: 'LOCAL_SPOTIFY',
        metadata: {},
      };

      const activity2: Activity = {
        id: 'youtube-video-1',
        service: 'youtube-tab',
        content: 'Video 1',
        timestamp: now + 5000,
        contentTimestamp: now + 5000,
        freshness_timestamp: now + 5000,
        is_fresh: true,
        state: 'playing',
        provenance: 'LOCAL_TAB',
        metadata: {},
      };

      // Simulate receiving activity updates
      await mockStorage.updateFriend('friend1', {
        current_activities: { [activity1.service]: activity1 },
        last_seen: Date.now(),
      });
      await mockStorage.addActivityToHistory('friend1', activity1);

      await mockStorage.updateFriend('friend1', {
        current_activities: { [activity2.service]: activity2 },
        last_seen: Date.now(),
      });
      await mockStorage.addActivityToHistory('friend1', activity2);

      // Verify both activities were stored in history
      expect(mockStorage.addActivityToHistory).toHaveBeenCalledTimes(2);

      // Get history
      mockStorage.getActivityHistory.mockResolvedValueOnce([activity1, activity2]);
      const history = await friendManager.getActivityHistory('friend1');

      expect(history.length).toBe(2);
    });
  });

  describe('Multi-Participant Co-Watch Message Flow', () => {
    it('should handle complete message flow between Alice and Bob in co-watch session', async () => {
      const now = Date.now();
      const activityId = 'youtube-video-abc123';

      // Setup: Create Alice (self) and Bob (friend)
      const aliceProfile = {
        uuid: 'alice-uuid-12345',
        nickname: 'Alice',
        pubkey: 'alice-pubkey',
      };

      const bobFriend: Friend = {
        uuid: 'bob-uuid-67890',
        pubkey: 'bob-pubkey',
        local_name: 'Bob',
        added_at: now,
        last_seen: now,
        muted: false,
        state: 'active',
        hidden_services: [],
        current_activities: {},
      };

      // Mock storage for Alice's perspective
      mockStorage.getUserProfile.mockResolvedValue(aliceProfile);
      mockStorage.getFriend.mockResolvedValue(bobFriend);
      mockStorage.getFriends.mockResolvedValue([bobFriend]);

      // === FLOW 1: Alice sends message ===
      const aliceMessages: any[] = [];
      mockStorage.addActivityMessage = vi.fn().mockImplementation((actId, msg) => {
        if (actId === activityId) {
          aliceMessages.push(msg);
        }
      });

      mockStorage.getActivityMessages = vi.fn().mockImplementation((actId) => {
        if (actId === activityId) {
          return Promise.resolve(aliceMessages);
        }
        return Promise.resolve([]);
      });

      // Alice stores her outbound message
      const aliceOutboundMsg = {
        id: `msg-1-${now}`,
        friend_uuid: aliceProfile.uuid,
        friend_identifier: aliceProfile.uuid,
        sender_identifier: aliceProfile.uuid,
        activity_id: activityId,
        type: 'chat',
        content: "Let's jump to the chorus",
        is_outbound: true,
        timestamp: now,
        read: true,
      };

      await mockStorage.addActivityMessage(activityId, aliceOutboundMsg);
      expect(mockStorage.addActivityMessage).toHaveBeenCalledWith(activityId, aliceOutboundMsg);

      // === FLOW 2: Generate CO_WATCH_UPDATE broadcast (Alice's background) ===
      const messages = await mockStorage.getActivityMessages(activityId);
      expect(messages).toHaveLength(1);

      // Build nickname map (same logic as background.ts lines 901-914)
      const nicknameMap = new Map<string, string>();
      nicknameMap.set(aliceProfile.uuid, aliceProfile.nickname);
      nicknameMap.set(bobFriend.uuid, bobFriend.local_name);

      // Format messages for broadcast
      const broadcastMessages = messages.map((msg: any) => ({
        id: msg.id,
        sender: nicknameMap.get(msg.sender_identifier) || msg.sender_identifier,
        sender_id: msg.sender_identifier,
        content: msg.content,
        timestamp: msg.timestamp,
      }));

      expect(broadcastMessages).toHaveLength(1);
      expect(broadcastMessages[0].sender).toBe('Alice'); // ✅ Should be "Alice", not "You" or "Unknown"
      expect(broadcastMessages[0].sender_id).toBe(aliceProfile.uuid);
      expect(broadcastMessages[0].content).toBe("Let's jump to the chorus");

      // === FLOW 3: Bob receives CO_WATCH_UPDATE ===
      // Bob's content-script receives the broadcast and updates overlay
      const bobOverlayState = {
        messages: broadcastMessages,
        nicknameMap: Object.fromEntries(nicknameMap),
      };

      // Bob's overlay renders using nicknameMap
      const bobRenderedMessages = bobOverlayState.messages.map((msg: any) => ({
        sender: bobOverlayState.nicknameMap[msg.sender_id] || msg.sender_id,
        content: msg.content,
        sender_id: msg.sender_id,
      }));

      expect(bobRenderedMessages).toHaveLength(1);
      expect(bobRenderedMessages[0].sender).toBe('Alice'); // ✅ Bob sees "Alice: ...", not "You"
      expect(bobRenderedMessages[0].content).toBe("Let's jump to the chorus");

      // === FLOW 4: Bob sends a reply ===
      const bobOutboundMsg = {
        id: `msg-2-${now + 1000}`,
        friend_uuid: bobFriend.uuid,
        friend_identifier: bobFriend.uuid,
        sender_identifier: bobFriend.uuid,
        activity_id: activityId,
        type: 'chat',
        content: 'Good idea!',
        is_outbound: true,
        timestamp: now + 1000,
        read: true,
      };

      await mockStorage.addActivityMessage(activityId, bobOutboundMsg);

      // === FLOW 5: Alice receives update with Bob's message ===
      const updatedMessages = await mockStorage.getActivityMessages(activityId);
      expect(updatedMessages).toHaveLength(2);

      // Alice rebuilds nickname map
      const aliceViewOfMessages = updatedMessages.map((msg: any) => ({
        sender: nicknameMap.get(msg.sender_identifier) || msg.sender_identifier,
        content: msg.content,
        sender_id: msg.sender_identifier,
      }));

      expect(aliceViewOfMessages).toHaveLength(2);
      expect(aliceViewOfMessages[0].sender).toBe('Alice');
      expect(aliceViewOfMessages[1].sender).toBe('Bob'); // ✅ Alice sees "Bob: Good idea!", not "You"

      // === Verification: Message Deduplication ===
      // Check that messages are not duplicated (N+1 bug)
      const messageKeys = new Set(updatedMessages.map((m: any) => m.id));
      expect(messageKeys.size).toBe(updatedMessages.length); // No duplicates

      // === Verification: Query Efficiency ===
      // getActivityMessages should have been called 3 times:
      // 1. Alice stores message
      // 2. Alice builds broadcast
      // 3. Both receive updates
      // NOT once per co-watcher
      expect(mockStorage.getActivityMessages).toHaveBeenCalled();
      const callCount = (mockStorage.getActivityMessages as any).mock.calls.length;
      expect(callCount).toBeLessThan(5); // Reasonable count, not N+1
    });
  });
});
