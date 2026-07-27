/**
 * Hang Time - StorageManager Tests
 * Tests for new storage methods added in refactor
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageManager } from '../src/modules/storage';

// Mock chrome.storage.local
const mockStorage = new Map<string, any>();

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (key: string | string[]) => {
        if (typeof key === 'string') {
          return { [key]: mockStorage.get(key) };
        }
        const result: any = {};
        for (const k of key) {
          result[k] = mockStorage.get(k);
        }
        return result;
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
});

describe('StorageManager - New Methods', () => {
  let storage: StorageManager;

  beforeEach(() => {
    mockStorage.clear();
    storage = new StorageManager();
  });

  // ============================================================================
  // PENDING INVITES
  // ============================================================================

  describe('getPendingInvites / setPendingInvites', () => {
    it('returns empty object by default', async () => {
      const invites = await storage.getPendingInvites();
      expect(invites).toEqual({});
    });

    it('stores and retrieves pending invites with timestamps', async () => {
      const now = Date.now();
      const invites = {
        'activity-1': { friendId: 'friend-1', sentAt: now },
        'activity-2': { friendId: 'friend-2', sentAt: now - 1000 },
      };

      await storage.setPendingInvites(invites);
      const retrieved = await storage.getPendingInvites();

      expect(retrieved).toEqual(invites);
      expect(retrieved['activity-1'].sentAt).toBe(now);
    });

    it('preserves existing invites when updating', async () => {
      const now = Date.now();
      await storage.setPendingInvites({ 'activity-1': { friendId: 'friend-1', sentAt: now } });
      const current = await storage.getPendingInvites();
      current['activity-2'] = { friendId: 'friend-2', sentAt: now };
      await storage.setPendingInvites(current);

      const final = await storage.getPendingInvites();
      expect(Object.keys(final).length).toBe(2);
      expect(final['activity-1'].friendId).toBe('friend-1');
      expect(final['activity-2'].friendId).toBe('friend-2');
    });

    it('removes expired invites (2+ hours old)', async () => {
      const now = Date.now();
      const twoHoursMs = 2 * 60 * 60 * 1000;
      const invites = {
        'activity-1': { friendId: 'friend-1', sentAt: now }, // recent
        'activity-2': { friendId: 'friend-2', sentAt: now - twoHoursMs - 1000 }, // expired
        'activity-3': { friendId: 'friend-3', sentAt: now - twoHoursMs + 1000 }, // not quite expired
      };

      await storage.setPendingInvites(invites);
      const removed = await storage.removeExpiredInvites();

      expect(removed).toBe(1);
      const remaining = await storage.getPendingInvites();
      expect(Object.keys(remaining).length).toBe(2);
      expect(remaining['activity-2']).toBeUndefined();
    });
  });

  // ============================================================================
  // NOTIFIED INVITE IDS
  // ============================================================================

  describe('getNotifiedInviteIds / setNotifiedInviteIds', () => {
    it('returns empty map by default', async () => {
      const ids = await storage.getNotifiedInviteIds();
      expect(ids).toEqual(new Map());
    });

    it('stores and retrieves notified IDs with timestamps', async () => {
      const now = Date.now();
      const ids = new Map([
        ['event-1', now],
        ['event-2', now - 1000],
      ]);

      await storage.setNotifiedInviteIds(ids);
      const retrieved = await storage.getNotifiedInviteIds();

      expect(retrieved).toEqual(ids);
      expect(retrieved.get('event-1')).toBe(now);
      expect(retrieved.get('event-2')).toBe(now - 1000);
    });

    it('handles map size and iteration', async () => {
      const ids = new Map<string, number>();
      for (let i = 0; i < 10; i++) {
        ids.set(`event-${i}`, Date.now() - i * 1000);
      }

      await storage.setNotifiedInviteIds(ids);
      const retrieved = await storage.getNotifiedInviteIds();

      expect(retrieved.size).toBe(10);
      expect(retrieved.has('event-5')).toBe(true);
    });
  });

  // ============================================================================
  // OAUTH CONFIG
  // ============================================================================

  describe('getOAuthConfig / setOAuthConfig', () => {
    it('returns empty object by default', async () => {
      const config = await storage.getOAuthConfig();
      expect(config).toEqual({});
    });

    it('stores and retrieves OAuth config', async () => {
      const config = {
        spotify: {
          client_id: 'test-spotify-id',
          client_secret: 'test-spotify-secret',
        },
        twitch: {
          client_id: 'test-twitch-id',
          client_secret: 'test-twitch-secret',
        },
      };

      await storage.setOAuthConfig(config);
      const retrieved = await storage.getOAuthConfig();

      expect(retrieved).toEqual(config);
      expect(retrieved.spotify?.client_id).toBe('test-spotify-id');
    });
  });

  // ============================================================================
  // NETFLIX TITLE
  // ============================================================================

  describe('getNetflixTitle / setNetflixTitle', () => {
    it('returns null by default', async () => {
      const title = await storage.getNetflixTitle();
      expect(title).toBeNull();
    });

    it('stores and retrieves Netflix title with metadata', async () => {
      const testTitle = 'The Crown - Season 5';
      const now = Date.now();

      // Simulate content script storage with provenance data
      await mockStorage.set('netflix_title_data', {
        value: testTitle,
        extractedAt: now,
        source: 'h2-tag',
        confidence: 'high',
      });

      const retrieved = await storage.getNetflixTitle();
      expect(retrieved).toBe(testTitle);
    });

    it('returns null for stale titles (>24 hours old)', async () => {
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;

      // Store title from yesterday
      mockStorage.set('netflix_title_data', {
        value: 'Old Show',
        extractedAt: now - oneDayMs - 1000, // older than 24 hours
        source: 'h2-tag',
        confidence: 'high',
      });

      const retrieved = await storage.getNetflixTitle();
      expect(retrieved).toBeNull();

      // Should have been cleared
      const cleared = mockStorage.get('netflix_title_data');
      expect(cleared).toBeNull();
    });

    it('keeps fresh titles (< 24 hours old)', async () => {
      const now = Date.now();
      const testTitle = 'Fresh Show';

      mockStorage.set('netflix_title_data', {
        value: testTitle,
        extractedAt: now - 60000, // 1 minute old
        source: 'h2-tag',
        confidence: 'high',
      });

      const retrieved = await storage.getNetflixTitle();
      expect(retrieved).toBe(testTitle);
    });

    it('removeStaleNetflixTitle clears old titles', async () => {
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;

      mockStorage.set('netflix_title_data', {
        value: 'Stale Title',
        extractedAt: now - oneDayMs - 1000,
        source: 'fallback',
        confidence: 'low',
      });

      const removed = await storage.removeStaleNetflixTitle();
      expect(removed).toBe(1);

      const cleared = mockStorage.get('netflix_title_data');
      expect(cleared).toBeNull();
    });

    it('removeStaleNetflixTitle returns 0 for fresh titles', async () => {
      const now = Date.now();

      mockStorage.set('netflix_title_data', {
        value: 'Fresh Title',
        extractedAt: now,
        source: 'h2-tag',
        confidence: 'high',
      });

      const removed = await storage.removeStaleNetflixTitle();
      expect(removed).toBe(0);

      const data = mockStorage.get('netflix_title_data');
      expect(data).toBeDefined();
    });
  });

  // ============================================================================
  // NETFLIX EXTRACTION LOGS
  // ============================================================================

  describe('getNetflixExtractionLogs / addNetflixExtractionLog', () => {
    it('returns empty array by default', async () => {
      const logs = await storage.getNetflixExtractionLogs();
      expect(logs).toEqual([]);
    });

    it('adds and retrieves logs', async () => {
      await storage.addNetflixExtractionLog('Log entry 1');
      await storage.addNetflixExtractionLog('Log entry 2');

      const logs = await storage.getNetflixExtractionLogs();
      expect(logs.length).toBe(2);
      expect(logs).toContain('Log entry 1');
      expect(logs).toContain('Log entry 2');
    });

    it('limits logs to 100 entries', async () => {
      // Add 105 logs
      for (let i = 0; i < 105; i++) {
        await storage.addNetflixExtractionLog(`Log ${i}`);
      }

      const logs = await storage.getNetflixExtractionLogs();
      expect(logs.length).toBe(100);
      // Should keep last 100, so first entries should be Log 5 through Log 104
      expect(logs[0]).toBe('Log 5');
      expect(logs[99]).toBe('Log 104');
    });
  });

  // ============================================================================
  // NETFLIX DEBUG CAPTURES
  // ============================================================================

  describe('getNetflixDebugCaptures / setNetflixDebugCaptures', () => {
    it('returns empty array by default', async () => {
      const captures = await storage.getNetflixDebugCaptures();
      expect(captures).toEqual([]);
    });

    it('stores and retrieves debug captures', async () => {
      const captures = [
        { timestamp: 1000, data: 'capture-1' },
        { timestamp: 2000, data: 'capture-2' },
      ];

      await storage.setNetflixDebugCaptures(captures);
      const retrieved = await storage.getNetflixDebugCaptures();

      expect(retrieved).toEqual(captures);
    });

    it('handles complex capture objects', async () => {
      const captures = [
        {
          timestamp: Date.now(),
          url: 'https://netflix.com/watch/123',
          title: 'Show Title',
          metadata: { episode: 5, season: 2 },
        },
      ];

      await storage.setNetflixDebugCaptures(captures);
      const retrieved = await storage.getNetflixDebugCaptures();

      expect(retrieved[0].metadata.episode).toBe(5);
    });
  });
});
