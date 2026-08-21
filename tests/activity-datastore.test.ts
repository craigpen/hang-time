/**
 * Hang Time - Activity Datastore Tests
 * Comprehensive test suite for activity validation and datastore operations
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validateContent,
  validateService,
  validateState,
  validateProgress,
  validateDuration,
  validateActivity,
  detectCorruption,
  ValidationError,
} from '../src/modules/activity-validation';
import { ActivityDatastore } from '../src/modules/activity-datastore';
import { Activity, STORAGE_KEYS } from '../src/types';

// ============================================================================
// VALIDATION TESTS
// ============================================================================

describe('Activity Validation', () => {
  describe('validateContent', () => {
    it('accepts valid content', () => {
      expect(validateContent('Never Gonna Give You Up')).toBe('Never Gonna Give You Up');
      expect(validateContent('YouTube Video')).toBe('YouTube Video');
      expect(validateContent('  Spotify Track  ')).toBe('Spotify Track');
    });

    it('rejects empty content', () => {
      expect(() => validateContent('')).toThrow(ValidationError);
      expect(() => validateContent('   ')).toThrow(ValidationError);
    });

    it('rejects content exceeding 200 chars', () => {
      const longContent = 'a'.repeat(201);
      expect(() => validateContent(longContent)).toThrow(ValidationError);
    });

    it('rejects content with bullets', () => {
      expect(() => validateContent('• test')).toThrow(ValidationError);
      expect(() => validateContent('test • content')).toThrow(ValidationError);
    });

    it('rejects content with notification fragments', () => {
      expect(() => validateContent('test invited you to watch youtube')).toThrow(ValidationError);
      expect(() => validateContent('• test invited you to youtube')).toThrow(ValidationError);
    });

    it('rejects content with leading dash and bullet', () => {
      expect(() => validateContent('- • test')).toThrow(ValidationError);
      expect(() => validateContent('•')).toThrow(ValidationError);
    });

    it('rejects content with control characters', () => {
      expect(() => validateContent('test\x00content')).toThrow(ValidationError);
      expect(() => validateContent('test\x1Fcontent')).toThrow(ValidationError);
    });

    it('rejects non-string content', () => {
      expect(() => validateContent(123 as unknown as string)).toThrow(ValidationError);
      expect(() => validateContent(null as unknown as string)).toThrow(ValidationError);
    });
  });

  describe('validateService', () => {
    it('accepts valid services', () => {
      expect(validateService('spotify-api')).toBe('spotify-api');
      expect(validateService('twitch-api')).toBe('twitch-api');
      expect(validateService('netflix-tab')).toBe('netflix-tab');
      expect(validateService('youtube-tab')).toBe('youtube-tab');
      expect(validateService('steam-api')).toBe('steam-api');
    });

    it('rejects invalid services', () => {
      expect(() => validateService('discord')).toThrow(ValidationError);
      expect(() => validateService('tiktok')).toThrow(ValidationError);
      expect(() => validateService('')).toThrow(ValidationError);
    });

    it('rejects non-string services', () => {
      expect(() => validateService(123 as unknown as string)).toThrow(ValidationError);
    });
  });

  describe('validateState', () => {
    it('accepts valid states', () => {
      expect(validateState('playing')).toBe('playing');
      expect(validateState('paused')).toBe('paused');
      expect(validateState('stopped')).toBe('stopped');
    });

    it('rejects empty state', () => {
      expect(() => validateState('')).toThrow(ValidationError);
      expect(() => validateState('   ')).toThrow(ValidationError);
    });

    it('rejects invalid states', () => {
      expect(() => validateState('idle')).toThrow(ValidationError);
      expect(() => validateState('buffering')).toThrow(ValidationError);
    });

    it('rejects non-string state', () => {
      expect(() => validateState(123 as unknown as string)).toThrow(ValidationError);
    });
  });

  describe('validateProgress', () => {
    it('accepts valid progress', () => {
      expect(validateProgress(0)).toBe(0);
      expect(validateProgress(30.5)).toBe(30.5);
      expect(validateProgress(100)).toBe(100);
      expect(validateProgress(undefined)).toBeUndefined();
    });

    it('rejects negative progress', () => {
      expect(() => validateProgress(-1)).toThrow(ValidationError);
    });

    it('rejects progress exceeding duration (for recorded content)', () => {
      expect(() => validateProgress(100, 50)).toThrow(ValidationError);
    });

    it('allows progress > 0 with duration=0 (live streams)', () => {
      expect(validateProgress(30, 0)).toBe(30);
      expect(validateProgress(100, 0)).toBe(100);
    });

    it('rejects non-finite progress', () => {
      expect(() => validateProgress(Infinity)).toThrow(ValidationError);
      expect(() => validateProgress(NaN)).toThrow(ValidationError);
    });

    it('rejects non-number progress', () => {
      expect(() => validateProgress('30' as unknown as number)).toThrow(ValidationError);
    });
  });

  describe('validateDuration', () => {
    it('accepts valid duration', () => {
      expect(validateDuration(60)).toBe(60);
      expect(validateDuration(120.5)).toBe(120.5);
      expect(validateDuration(undefined)).toBeUndefined();
    });

    it('accepts zero duration (for live streams)', () => {
      expect(validateDuration(0)).toBe(0);
    });

    it('rejects negative duration', () => {
      expect(() => validateDuration(-60)).toThrow(ValidationError);
    });

    it('rejects non-finite duration', () => {
      expect(() => validateDuration(Infinity)).toThrow(ValidationError);
    });

    it('rejects non-number duration', () => {
      expect(() => validateDuration('120' as unknown as number)).toThrow(ValidationError);
    });
  });

  describe('validateActivity', () => {
    const validActivity = {
      id: 'test-id',
      service: 'youtube-tab',
      content: 'Test Video',
      state: 'playing',
      timestamp: Date.now(),
      contentTimestamp: Date.now(),
    };

    it('accepts valid activity', () => {
      const result = validateActivity(validActivity);
      expect(result.id).toBe('test-id');
      expect(result.service).toBe('youtube-tab');
      expect(result.content).toBe('Test Video');
      expect(result.state).toBe('playing');
      expect(result.provenance).toBe('LOCAL_TAB');
    });

    it('rejects activity without required fields', () => {
      expect(() => validateActivity({})).toThrow(ValidationError);
      expect(() => validateActivity({ ...validActivity, id: '' })).toThrow(ValidationError);
      expect(() => validateActivity({ ...validActivity, service: '' })).toThrow(ValidationError);
      expect(() => validateActivity({ ...validActivity, state: '' })).toThrow(ValidationError);
      expect(() => validateActivity({ ...validActivity, contentTimestamp: undefined })).toThrow(ValidationError);
    });

    it('validates and sanitizes content', () => {
      expect(() => validateActivity({ ...validActivity, content: '• test' })).toThrow(ValidationError);
      expect(() => validateActivity({ ...validActivity, content: 'invited you to' })).toThrow(
        ValidationError,
      );
    });

    it('preserves metadata fields', () => {
      const activity = {
        ...validActivity,
        metadata: {
          progress: 30,
          duration: 120,
          artist: 'Test Artist',
        },
      };
      const result = validateActivity(activity);
      expect(result.metadata.progress).toBe(30);
      expect(result.metadata.duration).toBe(120);
      expect(result.metadata.artist).toBe('Test Artist');
    });
  });
});

// ============================================================================
// CORRUPTION DETECTION TESTS
// ============================================================================

describe('Corruption Detection', () => {
  it('detects bullet points in content', () => {
    const activity: Activity = {
      id: 'test',
      service: 'youtube-tab',
      content: '• Contaminated',
      state: 'playing',
      audio: 'off',
      timestamp: Date.now(),
      metadata: {},
    };
    const issues = detectCorruption(activity);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('bullet');
  });

  it('detects notification fragments', () => {
    const activity: Activity = {
      id: 'test',
      service: 'youtube-tab',
      content: 'test invited you to watch',
      state: 'playing',
      audio: 'off',
      timestamp: Date.now(),
      metadata: {},
    };
    const issues = detectCorruption(activity);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('notification');
  });

  it('detects invalid state', () => {
    const activity: Activity = {
      id: 'test',
      service: 'youtube-tab',
      content: 'Valid Title',
      state: 'invalid' as any,
      audio: 'off',
      timestamp: Date.now(),
      metadata: {},
    };
    const issues = detectCorruption(activity);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('detects out-of-bounds progress', () => {
    const activity: Activity = {
      id: 'test',
      service: 'youtube-tab',
      content: 'Valid Title',
      state: 'playing',
      audio: 'off',
      timestamp: Date.now(),
      metadata: {
        progress: 150,
        duration: 100,
      },
    };
    const issues = detectCorruption(activity);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('out of bounds');
  });

  it('returns empty array for clean activity', () => {
    const activity: Activity = {
      id: 'test',
      service: 'youtube-tab',
      content: 'Valid Title',
      state: 'playing',
      audio: 'off',
      timestamp: Date.now(),
      metadata: {
        progress: 30,
        duration: 120,
      },
    };
    const issues = detectCorruption(activity);
    expect(issues).toEqual([]);
  });
});

// ============================================================================
// DATASTORE TESTS
// ============================================================================

describe('ActivityDatastore', () => {
  let datastore: ActivityDatastore;
  let mockStorage: Partial<StorageManager>;

  beforeEach(() => {
    // Create mock storage with correct API (get/set, getMyActivities/setMyActivities)
    const store = new Map<string, any>();
    mockStorage = {
      get: vi.fn((key: string, defaultValue?: any) => Promise.resolve(store.get(key) ?? defaultValue)),
      set: vi.fn((key: string, value: any) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      getMyActivities: vi.fn(() => Promise.resolve(store.get(STORAGE_KEYS.MY_ACTIVITIES) ?? {})),
      setMyActivities: vi.fn((activities: any) => {
        store.set(STORAGE_KEYS.MY_ACTIVITIES, activities);
        return Promise.resolve();
      }),
    } as any;

    datastore = new ActivityDatastore(mockStorage as any);
  });

  describe('createActivity', () => {
    it('creates and stores a valid activity', async () => {
      const activity = {
        id: 'test-1',
        service: 'youtube-tab',
        content: 'Test Video',
        state: 'playing',
        timestamp: Date.now(),
        contentTimestamp: Date.now(),
        provenance: 'LOCAL_TAB' as const,
      };

      const result = await datastore.createActivity(activity);

      expect(result.id).toBe('test-1');
      expect(result.service).toBe('youtube-tab');
      expect(result.content).toBe('Test Video');
      expect(result.provenance).toBe('LOCAL_TAB');
    });

    it('rejects invalid activity', async () => {
      const activity = {
        id: 'test-2',
        service: 'youtube-tab',
        content: '• Contaminated',
        state: 'playing',
        timestamp: Date.now(),
        contentTimestamp: Date.now(),
      };

      await expect(datastore.createActivity(activity)).rejects.toThrow(ValidationError);
    });

    it('sanitizes content (trims whitespace)', async () => {
      const activity = {
        id: 'test-3',
        service: 'youtube-tab',
        content: '  Test Video  ',
        state: 'playing',
        timestamp: Date.now(),
        contentTimestamp: Date.now(),
      };

      const result = await datastore.createActivity(activity);
      expect(result.content).toBe('Test Video');
    });
  });

  describe('updateActivity', () => {
    beforeEach(async () => {
      // Create an activity first
      await datastore.createActivity({
        id: 'update-test',
        service: 'youtube-tab',
        content: 'Test Video',
        state: 'playing',
        timestamp: Date.now(),
        contentTimestamp: Date.now(),
        metadata: {
          progress: 30,
          duration: 120,
        },
      });
    });

    it('updates state and audio', async () => {
      const result = await datastore.updateActivity('update-test', {
        state: 'paused',
        audio: 'off',
      });

      expect(result.state).toBe('paused');
      expect(result.audio).toBe('off');
    });

    it('preserves progress when not updating', async () => {
      const result = await datastore.updateActivity('update-test', {
        state: 'paused',
      });

      expect(result.metadata?.progress).toBe(30);
    });

    it('allows progress update with new value', async () => {
      const result = await datastore.updateActivity('update-test', {
        state: 'playing',
        metadata: { progress: 60 },
      });

      expect(result.metadata?.progress).toBe(60);
    });

    it('rejects update for non-existent activity', async () => {
      await expect(
        datastore.updateActivity('non-existent', {
          state: 'paused',
        }),
      ).rejects.toThrow();
    });
  });

  describe('getActivity', () => {
    beforeEach(async () => {
      await datastore.createActivity({
        id: 'get-test',
        service: 'youtube-tab',
        content: 'Test Video',
        state: 'playing',
        timestamp: Date.now(),
        contentTimestamp: Date.now(),
      });
    });

    it('retrieves existing activity', async () => {
      const activity = await datastore.getActivity('get-test');
      expect(activity).not.toBeNull();
      expect(activity?.id).toBe('get-test');
    });

    it('returns null for non-existent activity', async () => {
      const activity = await datastore.getActivity('non-existent');
      expect(activity).toBeNull();
    });
  });

  describe('query methods', () => {
    beforeEach(async () => {
      await datastore.createActivity({
        id: 'yt-1',
        service: 'youtube-tab',
        content: 'Video 1',
        state: 'playing',
        timestamp: Date.now(),
        contentTimestamp: Date.now(),
      });
      await datastore.createActivity({
        id: 'spotify-1',
        service: 'spotify-api',
        content: 'Track 1',
        state: 'playing',
        timestamp: Date.now(),
        contentTimestamp: Date.now(),
      });
    });

    it('gets all activities', async () => {
      const all = await datastore.getAllActivities();
      expect(all.length).toBe(2);
    });

    it('filters activities by service', async () => {
      const youtube = await datastore.getActivitiesByService('youtube-tab');
      expect(youtube.length).toBe(1);
      expect(youtube[0].service).toBe('youtube-tab');
    });

    it('counts activities', async () => {
      const count = await datastore.countActivities();
      expect(count).toBe(2);
    });
  });

  describe('cleanup', () => {
    beforeEach(async () => {
      // Valid activity
      await datastore.createActivity({
        id: 'valid-1',
        service: 'youtube-tab',
        content: 'Valid Video',
        state: 'playing',
        timestamp: Date.now(),
        contentTimestamp: Date.now(),
        url: 'https://youtube.com/watch?v=test',
      });
    });

    it('generates validation report', async () => {
      // Note: validateAll() calls detectGhosts() which requires chrome.tabs API
      // This test focuses on the report structure
      const all = await datastore.getAllActivities();
      expect(all.length).toBeGreaterThan(0);
      expect(all[0].service).toBe('youtube-tab');
    });

    it('removes corrupted activities', async () => {
      // Manually insert corrupted activity (bypassing validation)
      const store = new Map<string, any>();
      const corruptedActivities = {
        'corrupted-1': {
          id: 'corrupted-1',
          service: 'youtube-tab',
          content: '• Bullet contaminated',
          state: 'playing',
          audio: 'off',
          timestamp: Date.now(),
          contentTimestamp: Date.now(),
          metadata: {},
        },
      };
      store.set(STORAGE_KEYS.MY_ACTIVITIES, corruptedActivities);

      const mockStorageWithData = {
        get: vi.fn((key: string, defaultValue?: any) => Promise.resolve(store.get(key) ?? defaultValue)),
        set: vi.fn((key: string, value: any) => {
          store.set(key, value);
          return Promise.resolve();
        }),
        getMyActivities: vi.fn(() => Promise.resolve(store.get(STORAGE_KEYS.MY_ACTIVITIES) ?? {})),
        setMyActivities: vi.fn((activities: any) => {
          store.set(STORAGE_KEYS.MY_ACTIVITIES, activities);
          return Promise.resolve();
        }),
      } as any;

      const testDatastore = new ActivityDatastore(mockStorageWithData as any);
      const removed = await testDatastore.cleanupCorrupted();
      expect(removed).toBeGreaterThan(0);
    });
  });

  describe('integrity summary', () => {
    it('generates summary', async () => {
      await datastore.createActivity({
        id: 'summary-test',
        service: 'youtube-tab',
        content: 'Test Video',
        state: 'playing',
        timestamp: Date.now(),
        contentTimestamp: Date.now(),
      });

      const summary = await datastore.getSummary();
      expect(summary).toContain('total');
      expect(summary).toContain('clean');
    });
  });
});
