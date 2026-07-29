/**
 * Hang Time - Metadata Fetcher Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MetadataFetcher } from '../metadata-fetcher';
import { GameMetadata, STORAGE_KEYS } from '../../types';

describe('MetadataFetcher', () => {
  let metadataFetcher: MetadataFetcher;
  let mockStorage: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    // Mock global fetch
    global.fetch = vi.fn();

    metadataFetcher = new MetadataFetcher(mockStorage);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // BASIC FETCH AND CACHE TESTS
  // ============================================================================

  describe('fetchMetadata', () => {
    it('should fetch and cache metadata for a new app', async () => {
      const mockResponse = {
        330: {
          success: true,
          data: {
            name: 'Portal 2',
            genres: [{ description: 'Puzzle' }, { description: 'Action' }],
            categories: [{ description: 'Single-player' }, { description: 'Co-op' }],
            platforms: { windows: true, mac: true, linux: false },
            metacritic: { score: 95 },
            header_image: 'https://example.com/portal2.jpg',
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(330);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Portal 2');
      expect(result?.genres).toContain('Puzzle');
      expect(result?.metacriticScore).toBe(95);
      expect(mockStorage.set).toHaveBeenCalled();
    });

    it('should return cached metadata if fresh', async () => {
      const cachedMetadata: GameMetadata = {
        appId: 440,
        name: 'Team Fortress 2',
        genres: ['Shooter'],
        categories: ['Multiplayer'],
        platforms: { windows: true, mac: true, linux: true },
        capsuleImageUrl: 'https://example.com/tf2.jpg',
        storePageUrl: 'https://store.steampowered.com/app/440/',
        lastFetched: Date.now(),
        isCrossPlayable: true,
      };

      mockStorage.get.mockResolvedValueOnce({ 440: cachedMetadata });

      const result = await metadataFetcher.fetchMetadata(440);

      expect(result).toEqual(cachedMetadata);
      expect(global.fetch).not.toHaveBeenCalled(); // Should not call API
    });

    it('should refetch if cache is stale (> 30 days)', async () => {
      const staleCachedMetadata: GameMetadata = {
        appId: 570,
        name: 'Dota 2',
        genres: ['Strategy'],
        categories: ['Multiplayer'],
        platforms: { windows: true, mac: false, linux: true },
        capsuleImageUrl: 'https://example.com/dota2.jpg',
        storePageUrl: 'https://store.steampowered.com/app/570/',
        lastFetched: Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 days old
        isCrossPlayable: true,
      };

      mockStorage.get.mockResolvedValueOnce({ 570: staleCachedMetadata });

      const mockNewResponse = {
        570: {
          success: true,
          data: {
            name: 'Dota 2',
            genres: [{ description: 'Strategy' }],
            categories: [{ description: 'Multiplayer' }],
            platforms: { windows: true, mac: false, linux: true },
            metacritic: { score: 82 },
            header_image: 'https://example.com/dota2-new.jpg',
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockNewResponse),
      });

      const result = await metadataFetcher.fetchMetadata(570);

      expect(result?.name).toBe('Dota 2');
      expect(global.fetch).toHaveBeenCalled(); // Should call API for refresh
    });

    it('should return null if Steam API returns 404 (app not found)', async () => {
      const mockResponse = {
        999999: {
          success: false,
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(999999);

      expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      const result = await metadataFetcher.fetchMetadata(123);

      expect(result).toBeNull();
    });

    it('should return null on malformed JSON response', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockRejectedValueOnce(new SyntaxError('Invalid JSON')),
      });

      const result = await metadataFetcher.fetchMetadata(456);

      expect(result).toBeNull();
    });

    it('should handle fetch timeout (5 second timeout)', async () => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'AbortError';

      (global.fetch as any).mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(timeoutError), 100);
          })
      );

      const result = await metadataFetcher.fetchMetadata(789);

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // PARSING AND DATA EXTRACTION TESTS
  // ============================================================================

  describe('parseAppDetails', () => {
    it('should correctly extract all fields from Steam response', async () => {
      const mockResponse = {
        223530: {
          success: true,
          data: {
            name: 'Baldurs Gate 3',
            genres: [{ description: 'RPG' }, { description: 'Adventure' }],
            categories: [
              { description: 'Single-player' },
              { description: 'Multiplayer' },
              { description: 'Co-op' },
            ],
            platforms: { windows: true, mac: false, linux: false },
            metacritic: { score: 96 },
            header_image: 'https://example.com/bg3.jpg',
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(223530);

      expect(result?.name).toBe('Baldurs Gate 3');
      expect(result?.genres).toEqual(['RPG', 'Adventure']);
      expect(result?.categories).toContain('Single-player');
      expect(result?.categories).toContain('Multiplayer');
      expect(result?.metacriticScore).toBe(96);
      expect(result?.capsuleImageUrl).toBe('https://example.com/bg3.jpg');
      expect(result?.storePageUrl).toBe('https://store.steampowered.com/app/223530/');
    });

    it('should handle missing genres gracefully', async () => {
      const mockResponse = {
        111111: {
          success: true,
          data: {
            name: 'Game Without Genres',
            platforms: { windows: true, mac: true, linux: false },
            header_image: 'https://example.com/game.jpg',
            // No genres field
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(111111);

      expect(result?.genres).toEqual([]);
      expect(result?.name).toBe('Game Without Genres');
    });

    it('should handle missing categories gracefully', async () => {
      const mockResponse = {
        222222: {
          success: true,
          data: {
            name: 'Game Without Categories',
            genres: [{ description: 'Action' }],
            platforms: { windows: true, mac: false, linux: false },
            header_image: 'https://example.com/game.jpg',
            // No categories field
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(222222);

      expect(result?.categories).toEqual([]);
    });

    it('should handle missing Metacritic score gracefully', async () => {
      const mockResponse = {
        333333: {
          success: true,
          data: {
            name: 'Game Without Metacritic',
            genres: [{ description: 'Indie' }],
            platforms: { windows: true, mac: false, linux: false },
            header_image: 'https://example.com/game.jpg',
            // No metacritic field
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(333333);

      expect(result?.metacriticScore).toBeUndefined();
      expect(result?.name).toBe('Game Without Metacritic');
    });
  });

  // ============================================================================
  // CROSS-PLATFORM DETECTION TESTS
  // ============================================================================

  describe('cross-platform detection', () => {
    it('should mark game as cross-playable with 2+ platforms', async () => {
      const mockResponse = {
        261570: {
          success: true,
          data: {
            name: 'Half-Life 2',
            genres: [{ description: 'Shooter' }],
            categories: [{ description: 'Single-player' }],
            platforms: { windows: true, mac: true, linux: true }, // 3 platforms
            header_image: 'https://example.com/hl2.jpg',
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(261570);

      expect(result?.isCrossPlayable).toBe(true);
      expect(result?.platforms.windows).toBe(true);
      expect(result?.platforms.mac).toBe(true);
      expect(result?.platforms.linux).toBe(true);
    });

    it('should mark game as non-cross-playable with 1 platform', async () => {
      const mockResponse = {
        444444: {
          success: true,
          data: {
            name: 'Windows-only Game',
            genres: [{ description: 'Action' }],
            categories: [{ description: 'Single-player' }],
            platforms: { windows: true, mac: false, linux: false }, // Only Windows
            header_image: 'https://example.com/game.jpg',
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(444444);

      expect(result?.isCrossPlayable).toBe(false);
    });

    it('should detect Windows+Mac as cross-playable', async () => {
      const mockResponse = {
        555555: {
          success: true,
          data: {
            name: 'Cross-platform Game',
            genres: [{ description: 'Puzzle' }],
            categories: [{ description: 'Single-player' }],
            platforms: { windows: true, mac: true, linux: false }, // 2 platforms
            header_image: 'https://example.com/game.jpg',
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(555555);

      expect(result?.isCrossPlayable).toBe(true);
    });

    it('should detect Linux+Mac as cross-playable', async () => {
      const mockResponse = {
        666666: {
          success: true,
          data: {
            name: 'Unix Game',
            genres: [{ description: 'Strategy' }],
            categories: [{ description: 'Single-player' }],
            platforms: { windows: false, mac: true, linux: true }, // 2 platforms
            header_image: 'https://example.com/game.jpg',
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(666666);

      expect(result?.isCrossPlayable).toBe(true);
    });
  });

  // ============================================================================
  // BATCH FETCH TESTS
  // ============================================================================

  describe('batchFetchMetadata', () => {
    it('should fetch multiple games at once', async () => {
      const appIds = [330, 440, 570];
      const responses: any = {};

      appIds.forEach((appId) => {
        responses[appId] = {
          success: true,
          data: {
            name: `Game ${appId}`,
            genres: [{ description: 'Action' }],
            categories: [{ description: 'Single-player' }],
            platforms: { windows: true, mac: false, linux: false },
            header_image: 'https://example.com/game.jpg',
          },
        };
      });

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockImplementation(() => Promise.resolve(responses)),
      });

      const result = await metadataFetcher.batchFetchMetadata(appIds);

      expect(result.size).toBe(3);
      expect(result.has(330)).toBe(true);
      expect(result.has(440)).toBe(true);
      expect(result.has(570)).toBe(true);
    });

    it('should handle partial failures in batch fetch', async () => {
      const appIds = [330, 999999, 440]; // 999999 doesn't exist

      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes('999999')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                999999: { success: false },
              }),
          });
        }

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              [url.match(/appids=(\d+)/)?.[1]]: {
                success: true,
                data: {
                  name: `Game ${url.match(/appids=(\d+)/)?.[1]}`,
                  genres: [{ description: 'Action' }],
                  categories: [{ description: 'Single-player' }],
                  platforms: { windows: true, mac: false, linux: false },
                  header_image: 'https://example.com/game.jpg',
                },
              },
            }),
        });
      });

      const result = await metadataFetcher.batchFetchMetadata(appIds);

      // Should have 2 successful fetches
      expect(result.size).toBeGreaterThanOrEqual(2);
    });

    it('should return empty map if no games provided', async () => {
      const result = await metadataFetcher.batchFetchMetadata([]);

      expect(result.size).toBe(0);
    });
  });

  // ============================================================================
  // CACHE MANAGEMENT TESTS
  // ============================================================================

  describe('cache management', () => {
    it('should cache metadata with TTL information', async () => {
      const mockResponse = {
        750: {
          success: true,
          data: {
            name: 'Half-Life',
            genres: [{ description: 'Shooter' }],
            categories: [{ description: 'Single-player' }],
            platforms: { windows: true, mac: false, linux: false },
            header_image: 'https://example.com/hl.jpg',
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      await metadataFetcher.fetchMetadata(750);

      expect(mockStorage.set).toHaveBeenCalledWith(
        STORAGE_KEYS.GAME_METADATA_CACHE,
        expect.objectContaining({
          750: expect.objectContaining({
            appId: 750,
            name: 'Half-Life',
            lastFetched: expect.any(Number),
          }),
        })
      );
    });

    it('should maintain separate cache entries for different games', async () => {
      const mockResponse1 = {
        100: {
          success: true,
          data: {
            name: 'Game 1',
            genres: [],
            categories: [],
            platforms: { windows: true, mac: false, linux: false },
            header_image: 'https://example.com/game1.jpg',
          },
        },
      };

      const mockResponse2 = {
        200: {
          success: true,
          data: {
            name: 'Game 2',
            genres: [],
            categories: [],
            platforms: { windows: true, mac: false, linux: false },
            header_image: 'https://example.com/game2.jpg',
          },
        },
      };

      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValueOnce(mockResponse1),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValueOnce(mockResponse2),
        });

      await metadataFetcher.fetchMetadata(100);
      await metadataFetcher.fetchMetadata(200);

      expect(mockStorage.set).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // BACKGROUND REFRESH QUEUE TESTS
  // ============================================================================

  describe('scheduleBackgroundRefresh', () => {
    it('should queue app IDs for background refresh', async () => {
      const appIds = [100, 200, 300];

      await metadataFetcher.scheduleBackgroundRefresh(appIds);

      const queue = metadataFetcher.getBackgroundRefreshQueue();
      expect(queue).toContain(100);
      expect(queue).toContain(200);
      expect(queue).toContain(300);
    });

    it('should accumulate items in refresh queue', async () => {
      await metadataFetcher.scheduleBackgroundRefresh([100]);
      await metadataFetcher.scheduleBackgroundRefresh([200, 300]);

      const queue = metadataFetcher.getBackgroundRefreshQueue();
      expect(queue.length).toBe(3);
      expect(queue).toContain(100);
      expect(queue).toContain(200);
      expect(queue).toContain(300);
    });

    it('should handle empty refresh queue', async () => {
      await metadataFetcher.scheduleBackgroundRefresh([]);

      const queue = metadataFetcher.getBackgroundRefreshQueue();
      expect(queue.length).toBe(0);
    });

    it('should allow clearing refresh queue', async () => {
      await metadataFetcher.scheduleBackgroundRefresh([100, 200]);

      metadataFetcher.clearBackgroundRefreshQueue();

      const queue = metadataFetcher.getBackgroundRefreshQueue();
      expect(queue.length).toBe(0);
    });
  });

  // ============================================================================
  // GETMETADATA SHORTCUT TESTS
  // ============================================================================

  describe('getMetadata', () => {
    it('should be equivalent to fetchMetadata', async () => {
      const mockResponse = {
        400: {
          success: true,
          data: {
            name: 'Test Game',
            genres: [{ description: 'Action' }],
            categories: [{ description: 'Single-player' }],
            platforms: { windows: true, mac: false, linux: false },
            header_image: 'https://example.com/game.jpg',
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.getMetadata(400);

      expect(result?.name).toBe('Test Game');
      expect(result?.genres).toContain('Action');
    });
  });

  // ============================================================================
  // SINGLETON PATTERN TESTS
  // ============================================================================

  describe('singleton pattern', () => {
    it('should maintain singleton instance', () => {
      const instance1 = MetadataFetcher.getInstance(mockStorage);
      const instance2 = MetadataFetcher.getInstance(mockStorage);

      expect(instance1).toBe(instance2);
    });
  });

  // ============================================================================
  // ERROR HANDLING EDGE CASES
  // ============================================================================

  describe('error handling', () => {
    it('should handle Steam API HTTP error responses', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const result = await metadataFetcher.fetchMetadata(123);

      expect(result).toBeNull();
    });

    it('should gracefully handle empty Steam API response', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce({}),
      });

      const result = await metadataFetcher.fetchMetadata(555);

      expect(result).toBeNull();
    });

    it('should handle missing data field in Steam response', async () => {
      const mockResponse = {
        777: {
          success: true,
          // Missing data field
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await metadataFetcher.fetchMetadata(777);

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // CACHE TTL BEHAVIOR TESTS
  // ============================================================================

  describe('cache TTL behavior', () => {
    it('should consider cache fresh within 30 days', async () => {
      const freshCache: GameMetadata = {
        appId: 888,
        name: 'Fresh Game',
        genres: ['Action'],
        categories: ['Single-player'],
        platforms: { windows: true, mac: false, linux: false },
        capsuleImageUrl: 'https://example.com/game.jpg',
        storePageUrl: 'https://store.steampowered.com/app/888/',
        lastFetched: Date.now() - 29 * 24 * 60 * 60 * 1000, // 29 days old
        isCrossPlayable: false,
      };

      mockStorage.get.mockResolvedValueOnce({ 888: freshCache });

      const result = await metadataFetcher.fetchMetadata(888);

      expect(result).toEqual(freshCache);
      expect(global.fetch).not.toHaveBeenCalled(); // Should not refetch
    });

    it('should refetch cache exactly at 30-day boundary', async () => {
      const staleCache: GameMetadata = {
        appId: 999,
        name: 'Old Game',
        genres: ['Strategy'],
        categories: ['Single-player'],
        platforms: { windows: true, mac: false, linux: false },
        capsuleImageUrl: 'https://example.com/game.jpg',
        storePageUrl: 'https://store.steampowered.com/app/999/',
        lastFetched: Date.now() - 30 * 24 * 60 * 60 * 1000 - 1, // Just over 30 days
        isCrossPlayable: false,
      };

      mockStorage.get.mockResolvedValueOnce({ 999: staleCache });

      const mockResponse = {
        999: {
          success: true,
          data: {
            name: 'Old Game (Updated)',
            genres: [{ description: 'Strategy' }],
            categories: [{ description: 'Single-player' }],
            platforms: { windows: true, mac: false, linux: false },
            header_image: 'https://example.com/game.jpg',
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      await metadataFetcher.fetchMetadata(999);

      expect(global.fetch).toHaveBeenCalled(); // Should refetch
    });
  });
});
