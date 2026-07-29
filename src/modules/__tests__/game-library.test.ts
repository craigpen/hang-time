/**
 * Hang Time - Game Library Manager Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameLibraryManager, initializeGameLibraryManager } from '../game-library';
import { STORAGE_KEYS, OwnedGame } from '../../types';

describe('GameLibraryManager', () => {
  let gameLibraryManager: GameLibraryManager;
  let mockStorageManager: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStorageManager = {
      getUserProfile: vi.fn().mockResolvedValue({
        steam_config: {
          steam_id: '12345',
          api_key: 'test_key',
        },
      }),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    gameLibraryManager = GameLibraryManager.getInstance(mockStorageManager);
  });

  describe('fetchMyGameLibrary', () => {
    it('should fetch games from Steam API and cache them', async () => {
      const mockResponse = {
        response: {
          games: [
            { appid: 570, name: 'Dota 2' },
            { appid: 730, name: 'CS:GO' },
            { appid: 440, name: 'Team Fortress 2' },
          ],
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const games = await gameLibraryManager.fetchMyGameLibrary();

      expect(games).toHaveLength(3);
      expect(games[0].appId).toBe(570);
      expect(games[1].appId).toBe(730);
      expect(games[2].appId).toBe(440);
      expect(mockStorageManager.set).toHaveBeenCalledWith(
        STORAGE_KEYS.MY_GAME_LIBRARY,
        expect.objectContaining({
          ownedGames: expect.any(Array),
          lastFetched: expect.any(Number),
          steamId: '12345',
        })
      );
    });

    it('should handle Steam API errors gracefully', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      await expect(gameLibraryManager.fetchMyGameLibrary()).rejects.toThrow();
    });

    it('should return empty array if no Steam ID configured', async () => {
      mockStorageManager.getUserProfile.mockResolvedValueOnce({
        steam_config: null,
      });

      const games = await gameLibraryManager.fetchMyGameLibrary();

      expect(games).toEqual([]);
    });

    it('should handle empty game list from API', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: {
            games: [],
          },
        }),
      });

      const games = await gameLibraryManager.fetchMyGameLibrary();

      expect(games).toEqual([]);
    });
  });

  describe('getMyGameLibrary', () => {
    it('should return cached games if cache is fresh', async () => {
      const now = Date.now();
      const cachedData = {
        ownedGames: [
          { appId: 570, lastUpdated: now },
          { appId: 730, lastUpdated: now },
        ],
        lastFetched: now,
        steamId: '12345',
      };

      mockStorageManager.get.mockResolvedValueOnce(cachedData);

      const games = await gameLibraryManager.getMyGameLibrary();

      expect(games).toEqual(cachedData.ownedGames);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should fetch fresh data if cache is stale', async () => {
      const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const staleData = {
        ownedGames: [{ appId: 570, lastUpdated: sevenDaysAgo }],
        lastFetched: sevenDaysAgo,
        steamId: '12345',
      };

      mockStorageManager.get.mockResolvedValueOnce(staleData);

      const mockResponse = {
        response: {
          games: [
            { appid: 730, name: 'CS:GO' },
          ],
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const games = await gameLibraryManager.getMyGameLibrary();

      expect(games).toHaveLength(1);
      expect(games[0].appId).toBe(730);
      expect(mockStorageManager.set).toHaveBeenCalled();
    });

    it('should fetch if cache is missing', async () => {
      mockStorageManager.get.mockResolvedValueOnce(null);

      const mockResponse = {
        response: {
          games: [
            { appid: 570, name: 'Dota 2' },
          ],
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const games = await gameLibraryManager.getMyGameLibrary();

      expect(games).toHaveLength(1);
      expect(games[0].appId).toBe(570);
    });

    it('should return empty array on error', async () => {
      mockStorageManager.get.mockResolvedValueOnce(null);
      mockStorageManager.getUserProfile.mockResolvedValueOnce({
        steam_config: { steam_id: '12345' },
      });

      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const games = await gameLibraryManager.getMyGameLibrary();

      expect(games).toEqual([]);
    });
  });

  describe('getCommonGames', () => {
    it('should calculate common games between user and friend', async () => {
      const myGames: OwnedGame[] = [
        { appId: 570, lastUpdated: Date.now() },
        { appId: 730, lastUpdated: Date.now() },
        { appId: 440, lastUpdated: Date.now() },
      ];

      const friendPubkey = 'friend123';
      const now = Date.now();
      const friendLibraries = {
        [friendPubkey]: {
          pubkey: friendPubkey,
          appIds: [730, 440, 1091500], // Common: 730, 440
          lastUpdated: now,
        },
      };

      mockStorageManager.get
        .mockResolvedValueOnce({
          ownedGames: myGames,
          lastFetched: now,
          steamId: '12345',
        })
        .mockResolvedValueOnce(friendLibraries);

      const commonGames = await gameLibraryManager.getCommonGames(friendPubkey);

      expect(commonGames).toHaveLength(2);
      expect(commonGames.map(g => g.appId)).toEqual([730, 440]);
    });

    it('should return empty array if friend library is not cached', async () => {
      const myGames: OwnedGame[] = [
        { appId: 570, lastUpdated: Date.now() },
      ];

      mockStorageManager.get
        .mockResolvedValueOnce({
          ownedGames: myGames,
          lastFetched: Date.now(),
          steamId: '12345',
        })
        .mockResolvedValueOnce({});

      const commonGames = await gameLibraryManager.getCommonGames('unknownFriend');

      expect(commonGames).toEqual([]);
    });

    it('should return empty array if friend library cache is stale', async () => {
      const myGames: OwnedGame[] = [
        { appId: 570, lastUpdated: Date.now() },
      ];

      const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const friendPubkey = 'friend123';
      const staleFriendLibraries = {
        [friendPubkey]: {
          pubkey: friendPubkey,
          appIds: [570],
          lastUpdated: sevenDaysAgo,
        },
      };

      mockStorageManager.get
        .mockResolvedValueOnce({
          ownedGames: myGames,
          lastFetched: Date.now(),
          steamId: '12345',
        })
        .mockResolvedValueOnce(staleFriendLibraries);

      const commonGames = await gameLibraryManager.getCommonGames(friendPubkey);

      expect(commonGames).toEqual([]);
    });
  });

  describe('cacheFriendGameLibrary', () => {
    it('should cache friend game library', async () => {
      const friendPubkey = 'friend123';
      const appIds = [570, 730, 440];

      mockStorageManager.get.mockResolvedValueOnce({});

      await gameLibraryManager.cacheFriendGameLibrary(friendPubkey, appIds);

      expect(mockStorageManager.set).toHaveBeenCalledWith(
        STORAGE_KEYS.FRIEND_GAME_LIBRARIES,
        expect.objectContaining({
          [friendPubkey]: {
            pubkey: friendPubkey,
            appIds,
            lastUpdated: expect.any(Number),
          },
        })
      );
    });

    it('should merge with existing friend libraries', async () => {
      const friend1 = 'friend123';
      const friend2 = 'friend456';
      const appIds1 = [570, 730];
      const appIds2 = [440];

      const existingLibraries = {
        [friend1]: {
          pubkey: friend1,
          appIds: appIds1,
          lastUpdated: Date.now(),
        },
      };

      mockStorageManager.get.mockResolvedValueOnce(existingLibraries);

      await gameLibraryManager.cacheFriendGameLibrary(friend2, appIds2);

      expect(mockStorageManager.set).toHaveBeenCalledWith(
        STORAGE_KEYS.FRIEND_GAME_LIBRARIES,
        expect.objectContaining({
          [friend1]: existingLibraries[friend1],
          [friend2]: expect.objectContaining({
            pubkey: friend2,
            appIds: appIds2,
          }),
        })
      );
    });
  });

  describe('getFriendGameLibrary', () => {
    it('should return friend game library if cached and fresh', async () => {
      const friendPubkey = 'friend123';
      const now = Date.now();
      const friendLibraries = {
        [friendPubkey]: {
          pubkey: friendPubkey,
          appIds: [570, 730, 440],
          lastUpdated: now,
        },
      };

      mockStorageManager.get.mockResolvedValueOnce(friendLibraries);

      const games = await gameLibraryManager.getFriendGameLibrary(friendPubkey);

      expect(games).toHaveLength(3);
      expect(games?.map(g => g.appId)).toEqual([570, 730, 440]);
    });

    it('should return null if friend library not cached', async () => {
      mockStorageManager.get.mockResolvedValueOnce({});

      const games = await gameLibraryManager.getFriendGameLibrary('unknownFriend');

      expect(games).toBeNull();
    });

    it('should return null if friend library cache is stale', async () => {
      const friendPubkey = 'friend123';
      const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const staleFriendLibraries = {
        [friendPubkey]: {
          pubkey: friendPubkey,
          appIds: [570, 730],
          lastUpdated: sevenDaysAgo,
        },
      };

      mockStorageManager.get.mockResolvedValueOnce(staleFriendLibraries);

      const games = await gameLibraryManager.getFriendGameLibrary(friendPubkey);

      expect(games).toBeNull();
    });
  });

  describe('singleton pattern', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = GameLibraryManager.getInstance(mockStorageManager);
      const instance2 = GameLibraryManager.getInstance(mockStorageManager);

      expect(instance1).toBe(instance2);
    });

    it('should initialize via initializeGameLibraryManager', () => {
      initializeGameLibraryManager(mockStorageManager);
      expect(GameLibraryManager.getInstance(mockStorageManager)).toBeDefined();
    });
  });

  describe('cache TTL logic', () => {
    it('should consider cache fresh within 7 days', async () => {
      const now = Date.now();
      const sixDaysAgo = now - 6 * 24 * 60 * 60 * 1000;

      const cachedData = {
        ownedGames: [{ appId: 570, lastUpdated: now }],
        lastFetched: sixDaysAgo,
        steamId: '12345',
      };

      mockStorageManager.get.mockResolvedValueOnce(cachedData);

      const games = await gameLibraryManager.getMyGameLibrary();

      expect(games).toEqual(cachedData.ownedGames);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should consider cache stale after 7 days', async () => {
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

      const cachedData = {
        ownedGames: [{ appId: 570, lastUpdated: now }],
        lastFetched: eightDaysAgo,
        steamId: '12345',
      };

      mockStorageManager.get.mockResolvedValueOnce(cachedData);

      const mockResponse = {
        response: {
          games: [
            { appid: 730, name: 'CS:GO' },
          ],
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const games = await gameLibraryManager.getMyGameLibrary();

      expect(games[0].appId).toBe(730);
      expect(mockStorageManager.set).toHaveBeenCalled();
    });
  });

  describe('common app ID calculation', () => {
    it('should correctly calculate intersection of game lists', async () => {
      const myGames: OwnedGame[] = [
        { appId: 1, lastUpdated: Date.now() },
        { appId: 2, lastUpdated: Date.now() },
        { appId: 3, lastUpdated: Date.now() },
        { appId: 4, lastUpdated: Date.now() },
      ];

      const friendPubkey = 'friend123';
      const now = Date.now();
      const friendLibraries = {
        [friendPubkey]: {
          pubkey: friendPubkey,
          appIds: [2, 3, 5, 6], // Common: 2, 3
          lastUpdated: now,
        },
      };

      mockStorageManager.get
        .mockResolvedValueOnce({
          ownedGames: myGames,
          lastFetched: now,
          steamId: '12345',
        })
        .mockResolvedValueOnce(friendLibraries);

      const commonGames = await gameLibraryManager.getCommonGames(friendPubkey);

      expect(commonGames).toHaveLength(2);
      expect(commonGames.map(g => g.appId).sort()).toEqual([2, 3]);
    });

    it('should return empty intersection when no common games', async () => {
      const myGames: OwnedGame[] = [
        { appId: 1, lastUpdated: Date.now() },
        { appId: 2, lastUpdated: Date.now() },
      ];

      const friendPubkey = 'friend123';
      const now = Date.now();
      const friendLibraries = {
        [friendPubkey]: {
          pubkey: friendPubkey,
          appIds: [100, 200, 300], // No common
          lastUpdated: now,
        },
      };

      mockStorageManager.get
        .mockResolvedValueOnce({
          ownedGames: myGames,
          lastFetched: now,
          steamId: '12345',
        })
        .mockResolvedValueOnce(friendLibraries);

      const commonGames = await gameLibraryManager.getCommonGames(friendPubkey);

      expect(commonGames).toEqual([]);
    });
  });
});
