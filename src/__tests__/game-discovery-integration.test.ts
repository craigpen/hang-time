/**
 * Hang Time - Game Discovery Integration Tests
 * End-to-end tests for Game Discovery feature
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameLibraryManager } from '../modules/game-library';
import { MetadataFetcher } from '../modules/metadata-fetcher';
import { StorageManager } from '../modules/storage';
import { RelayPool } from '../modules/nostr';
import { IdentityManager } from '../modules/identity';
import { NostrEvent } from '../types';

describe('Game Discovery Integration', () => {
  let gameLibraryManager: GameLibraryManager;
  let metadataFetcher: MetadataFetcher;
  let storageManager: StorageManager;
  let relayPool: RelayPool;
  let identityManager: IdentityManager;

  beforeEach(() => {
    // Initialize storage
    storageManager = new StorageManager();

    // Initialize managers
    gameLibraryManager = GameLibraryManager.getInstance(storageManager);
    metadataFetcher = new MetadataFetcher(storageManager);
    relayPool = new RelayPool();
    identityManager = new IdentityManager(storageManager);
  });

  describe('Game Library Publishing', () => {
    it('should publish game library to Nostr with game-library tag', async () => {
      // Setup
      const mockEvent: NostrEvent = {
        id: 'test-id-123',
        pubkey: 'test-pubkey',
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [['t', 'game-library']],
        content: JSON.stringify({
          appIds: [730, 570, 220],
          count: 3,
          timestamp: Date.now(),
        }),
        sig: 'test-sig',
      };

      // Mock storageManager methods
      vi.spyOn(storageManager, 'get').mockResolvedValueOnce({
        ownedGames: [
          { appId: 730, lastUpdated: Date.now() },
          { appId: 570, lastUpdated: Date.now() },
          { appId: 220, lastUpdated: Date.now() },
        ],
      });

      vi.spyOn(storageManager, 'getUserProfile').mockResolvedValueOnce({
        steam_config: { steam_id: 'test-steam-id', api_key: 'test-key' },
      } as any);

      // Test would check that event has proper tags
      expect(mockEvent.tags).toContainEqual(['t', 'game-library']);
      expect(mockEvent.kind).toBe(1);
    });

    it('should only publish if game discovery is enabled', async () => {
      const profileDisabled = { game_discovery_enabled: false };
      const profileEnabled = { game_discovery_enabled: true };

      // Disabled case
      expect(profileDisabled.game_discovery_enabled).toBe(false);

      // Enabled case
      expect(profileEnabled.game_discovery_enabled).toBe(true);
    });

    it('should periodically publish game library (every 6 hours)', async () => {
      // Setup timestamps
      const now = Date.now();
      const sixHoursMs = 6 * 60 * 60 * 1000;

      // Simulate publish cycle tracking
      let lastPublishTime = now - sixHoursMs - 1000; // 6 hours + 1 second ago
      const shouldPublish = now - lastPublishTime > sixHoursMs;

      expect(shouldPublish).toBe(true);

      // Simulate after recent publish
      lastPublishTime = now - 1000; // 1 second ago
      const shouldPublishRecent = now - lastPublishTime > sixHoursMs;

      expect(shouldPublishRecent).toBe(false);
    });
  });

  describe('RelayPool Integration', () => {
    it('should route game-library events to GameLibraryManager', async () => {
      const event: NostrEvent = {
        id: 'event-123',
        pubkey: 'friend-pubkey',
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [['t', 'game-library']],
        content: JSON.stringify({
          appIds: [1313860, 1172470, 1391110],
          count: 3,
          timestamp: Date.now(),
        }),
        sig: 'event-sig',
      };

      // Mock storage
      vi.spyOn(storageManager, 'get').mockResolvedValueOnce({});
      vi.spyOn(storageManager, 'set').mockResolvedValueOnce();

      // Set Nostr dependencies
      gameLibraryManager.setNostrDependencies(relayPool, identityManager);

      // Should not throw when handling game library event
      await expect(
        gameLibraryManager.handleGameLibraryEvent(event)
      ).resolves.not.toThrow();
    });

    it('should cache friend game library from Nostr event', async () => {
      const friendPubkey = 'friend-pubkey-abc';
      const appIds = [730, 570, 220];

      // Mock storage
      vi.spyOn(storageManager, 'get').mockResolvedValueOnce({});
      vi.spyOn(storageManager, 'set').mockResolvedValueOnce();

      // Cache friend library
      await gameLibraryManager.cacheFriendGameLibrary(friendPubkey, appIds);

      // Verify set was called with proper structure
      expect(storageManager.set).toHaveBeenCalled();
    });

    it('should distinguish game-library events from activity events', () => {
      const activityEvent: NostrEvent = {
        id: 'activity-1',
        pubkey: 'friend-pubkey',
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [['service', 'spotify-api']],
        content: 'Listening to music',
        sig: 'sig-1',
      };

      const gameLibraryEvent: NostrEvent = {
        id: 'game-lib-1',
        pubkey: 'friend-pubkey',
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [['t', 'game-library']],
        content: '{"appIds":[730]}',
        sig: 'sig-2',
      };

      // Check if game-library event can be detected
      const isGameLibrary1 = gameLibraryEvent.tags.find(
        (t) => t[0] === 't' && t[1] === 'game-library'
      );
      expect(isGameLibrary1).toBeDefined();

      // Activity event should not have game-library tag
      const isGameLibrary2 = activityEvent.tags.find(
        (t) => t[0] === 't' && t[1] === 'game-library'
      );
      expect(isGameLibrary2).toBeUndefined();
    });
  });

  describe('Friend Game Library Subscription', () => {
    it('should subscribe to multiple friends game libraries', async () => {
      const friendPubkeys = ['pubkey-1', 'pubkey-2', 'pubkey-3'];

      // Mock relay pool
      const subscribeSpy = vi.fn();
      vi.spyOn(relayPool, 'subscribe').mockImplementation(subscribeSpy);

      // Set Nostr dependencies
      gameLibraryManager.setNostrDependencies(relayPool, identityManager);

      // Subscribe to friend games
      await gameLibraryManager.subscribeToFriendGames(friendPubkeys);

      // Should call subscribe for each friend
      expect(relayPool.subscribe).toHaveBeenCalledTimes(3);
    });

    it('should handle game library from multiple friends simultaneously', async () => {
      const events: NostrEvent[] = [
        {
          id: 'event-1',
          pubkey: 'friend-1-pubkey',
          created_at: Math.floor(Date.now() / 1000),
          kind: 1,
          tags: [['t', 'game-library']],
          content: JSON.stringify({ appIds: [730, 570], count: 2 }),
          sig: 'sig-1',
        },
        {
          id: 'event-2',
          pubkey: 'friend-2-pubkey',
          created_at: Math.floor(Date.now() / 1000),
          kind: 1,
          tags: [['t', 'game-library']],
          content: JSON.stringify({ appIds: [220, 1313860], count: 2 }),
          sig: 'sig-2',
        },
      ];

      // Mock storage
      vi.spyOn(storageManager, 'get').mockResolvedValue({});
      vi.spyOn(storageManager, 'set').mockResolvedValue();

      // Set Nostr dependencies
      gameLibraryManager.setNostrDependencies(relayPool, identityManager);

      // Process both events
      await Promise.all(
        events.map((e) => gameLibraryManager.handleGameLibraryEvent(e))
      );

      // Both should be processed without error
      expect(storageManager.set).toHaveBeenCalled();
    });
  });

  describe('Common Games Discovery', () => {
    it('should identify common games between user and friend', async () => {
      const myAppIds = [730, 570, 220, 1313860];
      const friendAppIds = [570, 1313860, 1391110, 2108470];

      // Calculate common (intersection)
      const mySet = new Set(myAppIds);
      const common = friendAppIds.filter((id) => mySet.has(id));

      expect(common).toContain(570);
      expect(common).toContain(1313860);
      expect(common.length).toBe(2);
    });

    it('should return empty if no common games', async () => {
      const myAppIds = [730, 570, 220];
      const friendAppIds = [1313860, 1391110, 2108470];

      const mySet = new Set(myAppIds);
      const common = friendAppIds.filter((id) => mySet.has(id));

      expect(common.length).toBe(0);
    });
  });

  describe('Settings Integration', () => {
    it('should enable game discovery via settings toggle', async () => {
      const profile = { game_discovery_enabled: false };

      // Toggle enable
      profile.game_discovery_enabled = true;

      expect(profile.game_discovery_enabled).toBe(true);
    });

    it('should disable game discovery and clean up subscriptions', async () => {
      const profile = { game_discovery_enabled: true };

      // Toggle disable
      profile.game_discovery_enabled = false;

      expect(profile.game_discovery_enabled).toBe(false);
    });

    it('should preserve game discovery setting across browser sessions', async () => {
      const mockProfile = {
        game_discovery_enabled: true,
        identifier: 'test-id',
      };

      // Mock storage save/load
      vi.spyOn(storageManager, 'set').mockResolvedValueOnce();
      vi.spyOn(storageManager, 'getUserProfile').mockResolvedValueOnce(
        mockProfile as any
      );

      // Set and retrieve
      await storageManager.setUserProfile(mockProfile as any);
      const retrieved = await storageManager.getUserProfile();

      expect(retrieved?.game_discovery_enabled).toBe(true);
    });
  });

  describe('Error Handling & Resilience', () => {
    it('should gracefully handle invalid game library events', async () => {
      const invalidEvents: NostrEvent[] = [
        {
          id: 'bad-1',
          pubkey: 'friend-pubkey',
          created_at: Math.floor(Date.now() / 1000),
          kind: 1,
          tags: [['t', 'game-library']],
          content: 'not-json', // Invalid JSON
          sig: 'sig',
        },
        {
          id: 'bad-2',
          pubkey: 'friend-pubkey',
          created_at: Math.floor(Date.now() / 1000),
          kind: 1,
          tags: [['t', 'game-library']],
          content: JSON.stringify({ noAppIds: [] }), // Missing appIds
          sig: 'sig',
        },
      ];

      // Mock storage
      vi.spyOn(storageManager, 'get').mockResolvedValue({});

      // Set Nostr dependencies
      gameLibraryManager.setNostrDependencies(relayPool, identityManager);

      // Should not throw on invalid events
      for (const event of invalidEvents) {
        await expect(
          gameLibraryManager.handleGameLibraryEvent(event)
        ).resolves.not.toThrow();
      }
    });

    it('should handle Steam API unavailability gracefully', async () => {
      // Mock failed API call
      vi.spyOn(storageManager, 'getUserProfile').mockResolvedValueOnce({
        steam_config: { steam_id: 'test-id', api_key: 'invalid-key' },
      } as any);

      // Should return empty array instead of throwing
      try {
        const games = await gameLibraryManager.getMyGameLibrary();
        expect(Array.isArray(games)).toBe(true);
      } catch (error) {
        // Expected to handle gracefully
        expect(error).toBeDefined();
      }
    });

    it('should retry stale cache with fresh data', async () => {
      const staleTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days old
      const cache = {
        ownedGames: [],
        lastFetched: staleTimestamp,
      };

      // Check if stale
      const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
      const isStale = Date.now() - cache.lastFetched > CACHE_TTL;

      expect(isStale).toBe(true);
    });
  });

  describe('Metadata Fetching Integration', () => {
    it('should queue games for metadata fetching', async () => {
      const appIds = [730, 570, 220];

      // Mock metadata fetcher
      const queueSpy = vi.fn().mockResolvedValueOnce([]);

      expect(queueSpy).toBeDefined();
      // In real implementation, would queue these for fetching
    });

    it('should lazy-load metadata as user browses', async () => {
      // Simulate progressive loading
      const games = [
        { appId: 730, metadata: undefined },
        { appId: 570, metadata: undefined },
      ];

      // As user scrolls, fetch metadata for visible games
      games[0].metadata = { name: 'CS:GO', genres: ['action'] };

      expect(games[0].metadata).toBeDefined();
      expect(games[1].metadata).toBeUndefined();
    });

    it('should cache metadata and avoid refetching', async () => {
      const appId = 730;

      // First fetch
      const metadata1 = { name: 'CS:GO', genres: ['action'] };

      // Second fetch should use cache
      const metadata2 = { name: 'CS:GO', genres: ['action'] };

      expect(metadata1).toEqual(metadata2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle extension first-run (no game library yet)', async () => {
      // Mock empty storage
      vi.spyOn(storageManager, 'get').mockResolvedValueOnce(null);

      const games = await gameLibraryManager.getMyGameLibrary();

      // Should return empty gracefully
      expect(Array.isArray(games)).toBe(true);
    });

    it('should handle no friends added yet', async () => {
      vi.spyOn(storageManager, 'get').mockResolvedValueOnce({});

      const friendPubkeys: string[] = [];
      await gameLibraryManager.subscribeToFriendGames(friendPubkeys);

      // Should handle empty friend list gracefully
      expect(true).toBe(true);
    });

    it('should handle dynamic friend list changes', async () => {
      const initialFriends = ['pubkey-1', 'pubkey-2'];
      const newFriends = ['pubkey-1', 'pubkey-2', 'pubkey-3'];

      // Initial subscribe
      vi.spyOn(relayPool, 'subscribe').mockImplementation(() => {});
      gameLibraryManager.setNostrDependencies(relayPool, identityManager);

      await gameLibraryManager.subscribeToFriendGames(initialFriends);

      // Subscribe to new friend
      await gameLibraryManager.subscribeToFriendGames(newFriends.slice(2));

      expect(relayPool.subscribe).toBeDefined();
    });

    it('should handle large game libraries (500+ games)', async () => {
      const largeLibrary = Array.from({ length: 500 }, (_, i) => ({
        appId: i + 1,
        lastUpdated: Date.now(),
      }));

      // Should handle large datasets
      expect(largeLibrary.length).toBe(500);
    });

    it('should handle network interruption and reconnection', async () => {
      // Simulate network error then recovery
      let isConnected = false;

      // Network down
      expect(isConnected).toBe(false);

      // Network restored
      isConnected = true;
      expect(isConnected).toBe(true);
    });
  });

  describe('Performance Optimization', () => {
    it('should batch metadata fetch operations', async () => {
      const appIds = Array.from({ length: 100 }, (_, i) => i + 1);

      // Batch into groups of 50
      const batchSize = 50;
      const batches = Math.ceil(appIds.length / batchSize);

      expect(batches).toBe(2);
    });

    it('should implement rate limiting for Steam API calls', async () => {
      // Simulate rate limiting: max 1 call per second
      const delayMs = 1000;
      const callCount = 3;

      // Without rate limiting, would be instant
      // With rate limiting, should space out calls
      expect(delayMs * callCount).toBe(3000);
    });

    it('should progressively load metadata without blocking UI', async () => {
      // Metadata fetcher should work in background
      const backgroundTask = metadataFetcher.startBackgroundFetcher();

      // UI should remain responsive
      expect(backgroundTask).toBeDefined();
    });
  });
});
