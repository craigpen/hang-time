/**
 * Hang Time - Session Model & Divergence Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageManager } from '../storage';
import { CoWatcherDetector } from '../co-watcher-detection';
import { FriendManager } from '../friends';
import { OverlayUI } from '../overlay-ui';
import { CoWatchSession, UserProfile, Friend, Activity, Message } from '../../types';

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
  tabs: {
    update: vi.fn(),
    create: vi.fn(),
  },
});

describe('Session Model & Divergence', () => {
  let storage: StorageManager;
  let friendManager: FriendManager;
  let detector: CoWatcherDetector;

  const mockUserProfile: UserProfile = {
    uuid: 'user-uuid-1234',
    pubkey: 'userpubkey1234',
    secret_key: 'usersecretkey1234',
    created_at: Date.now(),
    nickname: 'Alice',
    services_enabled: {
      'spotify-api': true,
      'twitch-api': true,
      'steam-api': true,
      'discord-api': false,
      'youtube-tab': true,
      'netflix-tab': true,
      'twitch-tab': true,
      'video-tab': true,
    },
    notification_preferences: {
      friend_online: true,
      new_message: true,
      join_suggestion: true,
    },
  };

  beforeEach(async () => {
    mockStorage.clear();
    vi.clearAllMocks();

    storage = new StorageManager();
    await storage.initialize();
    await storage.setUserProfile(mockUserProfile);

    friendManager = new FriendManager(storage);
    detector = new CoWatcherDetector(storage, friendManager);
  });

  describe('StorageManager Session Persistence', () => {
    it('returns null when no active session exists', async () => {
      const session = await storage.getActiveSession();
      expect(session).toBeNull();
    });

    it('stores and retrieves active session with members array', async () => {
      const session: CoWatchSession = {
        session_id: 'session-uuid-1',
        members: ['user-uuid-1234', 'friend-uuid-5678'],
        created_at: Date.now(),
        is_active: true,
        activity_id: 'youtube-vid-1',
        host_friend_uuid: 'self',
      };

      await storage.setActiveSession(session);
      const retrieved = await storage.getActiveSession();

      expect(retrieved).not.toBeNull();
      expect(retrieved?.session_id).toBe('session-uuid-1');
      expect(retrieved?.members).toEqual(['user-uuid-1234', 'friend-uuid-5678']);
      expect(retrieved?.is_active).toBe(true);
    });

    it('migrates legacy co_watchers property to members', async () => {
      const legacySession = {
        session_id: 'legacy-session-1',
        co_watchers: ['user-uuid-1234', 'friend-uuid-5678'],
        created_at: Date.now(),
        is_active: true,
        activity_id: 'youtube-vid-1',
      };

      await storage.set('hang_time_active_session', legacySession);
      const migrated = await storage.getActiveSession();

      expect(migrated).not.toBeNull();
      expect(migrated?.members).toEqual(['user-uuid-1234', 'friend-uuid-5678']);
      expect((migrated as any)?.co_watchers).toBeUndefined();
    });

    it('clears active session', async () => {
      const session: CoWatchSession = {
        session_id: 'session-to-clear',
        members: ['user-uuid-1234'],
        created_at: Date.now(),
        is_active: true,
      };

      await storage.setActiveSession(session);
      expect(await storage.getActiveSession()).not.toBeNull();

      await storage.clearActiveSession();
      expect(await storage.getActiveSession()).toBeNull();
    });
  });

  describe('StorageManager Message Visibility (getVisibleMessages)', () => {
    const userUuid = 'user-uuid-1234';
    const friendBUuid = 'friend-b-uuid';
    const friendCUuid = 'friend-c-uuid';
    const strangerUuid = 'stranger-uuid';

    beforeEach(async () => {
      // Setup messages
      const messages: Message[] = [
        {
          id: 'msg-1',
          from: userUuid,
          recipients: [friendBUuid],
          type: 'chat',
          content: 'Hello Friend B!',
          timestamp: 1000,
        },
        {
          id: 'msg-2',
          from: friendBUuid,
          recipients: [userUuid],
          type: 'chat',
          content: 'Hey Alice!',
          timestamp: 2000,
        },
        {
          id: 'msg-3',
          from: userUuid,
          recipients: [strangerUuid],
          type: 'chat',
          content: 'Secret chat with stranger',
          timestamp: 3000,
        },
        {
          id: 'msg-4',
          from: friendBUuid,
          recipients: [friendCUuid],
          type: 'chat',
          content: 'B and C private chat',
          timestamp: 4000,
        },
      ];

      for (const msg of messages) {
        await storage.addMessage(msg);
      }
    });

    it('returns messages involving user and session co-watchers', async () => {
      const coWatchers = [userUuid, friendBUuid];
      const visible = await storage.getVisibleMessages(userUuid, coWatchers);

      expect(visible.map(m => m.id)).toEqual(['msg-1', 'msg-2']);
    });

    it('excludes messages where user is not involved even if co-watchers are', async () => {
      const coWatchers = [userUuid, friendBUuid, friendCUuid];
      const visible = await storage.getVisibleMessages(userUuid, coWatchers);

      // msg-4 is between B and C (user not involved)
      expect(visible.some(m => m.id === 'msg-4')).toBe(false);
    });

    it('excludes messages with strangers not in the co-watchers list', async () => {
      const coWatchers = [userUuid, friendBUuid];
      const visible = await storage.getVisibleMessages(userUuid, coWatchers);

      // msg-3 is with strangerUuid
      expect(visible.some(m => m.id === 'msg-3')).toBe(false);
    });
  });

  describe('CoWatcherDetector Lifecycle & Divergence', () => {
    const activityId1 = 'yt-video-matrix';

    const createActivity = (id: string, service: any, title: string, contentTimestamp: number, progress: number, progressMeasuredAt: number, url?: string): Activity => ({
      id,
      service,
      content: title,
      url: url || `https://${service}.com/watch/${id}`,
      timestamp: progressMeasuredAt,
      freshness_timestamp: progressMeasuredAt,
      contentTimestamp,
      state: 'playing',
      metadata: {
        progress,
        progress_measured_at: progressMeasuredAt,
        duration: 3600,
      },
    });

    it('detects co-watch session and elects host with earliest contentTimestamp (User is host)', async () => {
      const now = Date.now();

      // User started watching at now - 60000ms
      const userActivity = createActivity(activityId1, 'youtube-tab', 'The Matrix', now - 60000, 60, now);
      await storage.setMyActivities({ [activityId1]: userActivity });

      // Friend Bob started watching at now - 30000ms (later)
      const friendBob: Friend = {
        uuid: 'friend-bob-uuid',
        pubkey: 'bobpubkey',
        local_name: 'Bob',
        added_at: now - 100000,
        last_seen: now,
        muted: false,
        hidden_services: [],
        state: 'active',
        current_activities: {
          'youtube-tab': createActivity(activityId1, 'youtube-tab', 'The Matrix', now - 30000, 30, now),
        },
      };
      await storage.setFriends([friendBob]);

      const detected = await detector.detectCoWatchSession();

      expect(detected).not.toBeNull();
      expect(detected?.activity_id).toBe(activityId1);
      expect(detected?.host_friend_uuid).toBe('self'); // User started earlier
      expect(detected?.co_watchers).toContain('user-uuid-1234');
      expect(detected?.co_watchers).toContain('friend-bob-uuid');
    });

    it('detects co-watch session and elects friend as host when friend started earlier', async () => {
      const now = Date.now();

      // User started watching at now - 10000ms (later)
      const userActivity = createActivity(activityId1, 'youtube-tab', 'The Matrix', now - 10000, 10, now);
      await storage.setMyActivities({ [activityId1]: userActivity });

      // Friend Bob started watching at now - 80000ms (earlier)
      const friendBob: Friend = {
        uuid: 'friend-bob-uuid',
        pubkey: 'bobpubkey',
        local_name: 'Bob',
        added_at: now - 100000,
        last_seen: now,
        muted: false,
        hidden_services: [],
        state: 'active',
        current_activities: {
          'youtube-tab': createActivity(activityId1, 'youtube-tab', 'The Matrix', now - 80000, 80, now),
        },
      };
      await storage.setFriends([friendBob]);

      const detected = await detector.detectCoWatchSession();

      expect(detected).not.toBeNull();
      expect(detected?.host_friend_uuid).toBe('friend-bob-uuid');
    });

    it('rejects stale activities older than 10 minutes', async () => {
      const now = Date.now();
      const elevenMinutesAgo = now - 11 * 60 * 1000;

      const userActivity = createActivity(activityId1, 'youtube-tab', 'The Matrix', now - 60000, 60, elevenMinutesAgo);
      await storage.setMyActivities({ [activityId1]: userActivity });

      const friendBob: Friend = {
        uuid: 'friend-bob-uuid',
        pubkey: 'bobpubkey',
        local_name: 'Bob',
        added_at: now - 100000,
        last_seen: now,
        muted: false,
        hidden_services: [],
        state: 'active',
        current_activities: {
          'youtube-tab': createActivity(activityId1, 'youtube-tab', 'The Matrix', now - 30000, 30, now),
        },
      };
      await storage.setFriends([friendBob]);

      const detected = await detector.detectCoWatchSession();
      expect(detected).toBeNull();
    });

    it('createOrUpdateUserSession appends new members without removing existing ones during divergence', async () => {
      const now = Date.now();

      // 1. Initial co-watch with Bob
      const initialActivitySession = {
        activity_id: activityId1,
        host_friend_uuid: 'self',
        co_watchers: ['user-uuid-1234', 'friend-bob-uuid'],
        detected_at: now,
      };

      const session1 = await detector.createOrUpdateUserSession(initialActivitySession);
      expect(session1.members).toEqual(['user-uuid-1234', 'friend-bob-uuid']);
      expect(session1.is_active).toBe(true);

      // 2. Charlie joins the co-watch
      const updatedActivitySession = {
        activity_id: activityId1,
        host_friend_uuid: 'self',
        co_watchers: ['user-uuid-1234', 'friend-bob-uuid', 'friend-charlie-uuid'],
        detected_at: now + 5000,
      };

      const session2 = await detector.createOrUpdateUserSession(updatedActivitySession);
      expect(session2.session_id).toBe(session1.session_id); // Session ID preserved
      expect(session2.members).toEqual(['user-uuid-1234', 'friend-bob-uuid', 'friend-charlie-uuid']);

      // 3. User navigates to different activity (Divergence)
      // When a member navigates, session remains active and members list persists
      const divergedStoredSession = await detector.getCurrentCoWatchSession();
      expect(divergedStoredSession?.is_active).toBe(true);
      expect(divergedStoredSession?.members).toEqual(['user-uuid-1234', 'friend-bob-uuid', 'friend-charlie-uuid']);
    });

    it('preserves sticky host when candidate host timestamp changes as long as incumbent host is still co-watching', async () => {
      const now = Date.now();

      // 1. Initial session where Bob is host
      const initialSession = {
        activity_id: activityId1,
        host_friend_uuid: 'friend-bob-uuid',
        co_watchers: ['user-uuid-1234', 'friend-bob-uuid'],
        detected_at: now,
      };

      const session = await detector.createOrUpdateUserSession(initialSession);
      expect(session.host_friend_uuid).toBe('friend-bob-uuid');

      // 2. Later update where detection algorithm nominated 'self' because of timestamp reload
      const reloadUpdate = {
        activity_id: activityId1,
        host_friend_uuid: 'self', // Candidate host flipped to self due to reload
        co_watchers: ['user-uuid-1234', 'friend-bob-uuid'],
        detected_at: now + 5000,
      };

      const updated = await detector.createOrUpdateUserSession(reloadUpdate);
      // Sticky host should still be Bob because Bob is still an active co-watcher
      expect(updated.host_friend_uuid).toBe('friend-bob-uuid');

      // 3. Host only transfers if incumbent host (Bob) leaves the co-watch
      const bobLeftUpdate = {
        activity_id: activityId1,
        host_friend_uuid: 'self',
        co_watchers: ['user-uuid-1234', 'friend-charlie-uuid'], // Bob left!
        detected_at: now + 10000,
      };

      const transferred = await detector.createOrUpdateUserSession(bobLeftUpdate);
      expect(transferred.host_friend_uuid).toBe('self');
    });
  });

  describe('OverlayUI Mode Switching & JOIN_GUEST_ACTIVITY', () => {
    let overlay: OverlayUI;
    let mockPort: any;

    beforeEach(() => {
      document.body.innerHTML = '';
      mockPort = {
        postMessage: vi.fn(),
      };
      overlay = new OverlayUI('user-uuid-1234');
      overlay.init();
      overlay.setPort(mockPort);
      overlay.setNicknameMap({
        'user-uuid-1234': 'Alice',
        'friend-bob-uuid': 'Bob',
      });
    });

    it('renders Mode A (Host Mode) when watching_together >= 2', () => {
      overlay.setState({
        session_members: ['user-uuid-1234', 'friend-bob-uuid'],
        watching_together: ['user-uuid-1234', 'friend-bob-uuid'],
        is_user_host: true,
        host_nickname: 'Alice',
        host_progress: 100,
        host_duration: 500,
        co_watcher_activities: {
          'user-uuid-1234': {
            activity_id: 'vid-1',
            content: 'The Matrix',
            url: 'https://youtube.com/watch?v=vid1',
            service: 'youtube-tab',
          },
        },
      });

      const watchingRow = document.getElementById('watching-together-row');
      const guestRowsContainer = document.getElementById('guest-rows-container');

      expect(watchingRow?.style.display).not.toBe('none');
      expect(guestRowsContainer?.innerHTML).toBe('');
    });

    it('renders Mode B (Divergence / Guest Mode) when watching_together < 2 and posts JOIN_GUEST_ACTIVITY on click', () => {
      const bobUrl = 'https://youtube.com/watch?v=vid2';
      overlay.setState({
        session_members: ['user-uuid-1234', 'friend-bob-uuid'],
        watching_together: [], // Diverged
        is_user_host: false,
        co_watcher_activities: {
          'user-uuid-1234': {
            activity_id: 'vid-1',
            content: 'The Matrix',
            url: 'https://youtube.com/watch?v=vid1',
            service: 'youtube-tab',
          },
          'friend-bob-uuid': {
            activity_id: 'vid-2',
            content: 'Inception',
            url: bobUrl,
            service: 'youtube-tab',
          },
        },
      });

      const watchingRow = document.getElementById('watching-together-row');
      const guestRowsContainer = document.getElementById('guest-rows-container');

      expect(watchingRow?.style.display).toBe('none');
      expect(guestRowsContainer?.innerHTML).toContain('Choose next:');
      expect(guestRowsContainer?.innerHTML).toContain('Inception');

      // Click the join button for Bob
      const joinBtn = guestRowsContainer?.querySelector('button[data-uuid="friend-bob-uuid"]') as HTMLElement;
      expect(joinBtn).not.toBeNull();

      joinBtn.click();

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: 'JOIN_GUEST_ACTIVITY',
        data: {
          guest_uuid: 'friend-bob-uuid',
          activity_id: 'vid-2',
          url: bobUrl,
        },
      });
    });
  });
});
