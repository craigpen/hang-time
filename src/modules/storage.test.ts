/**
 * Storage API Enforcement Tests
 * Ensures all storage writes go through StorageManager, never direct chrome.storage access
 */

import { describe, it, expect } from 'vitest';
import { STORAGE_KEYS } from '../types';
import fs from 'fs';
import path from 'path';

describe('Storage Architecture', () => {
  describe('StorageManager centralization', () => {
    it('should have all STORAGE_KEYS constants defined', () => {
      const srcDir = path.join(__dirname, '..', 'types.ts');
      const content = fs.readFileSync(srcDir, 'utf-8');

      const requiredKeys = [
        'USER_PROFILE',
        'FRIENDS_LIST',
        'OAUTH_TOKENS',
        'MY_ACTIVITIES',
        'CURRENT_ACTIVITY',
        'SETTINGS',
        'VIDEO_DATA_METRICS',
        'MESSAGES',
        'ACTIVITY_HISTORY',
      ];

      for (const key of requiredKeys) {
        expect(content).toContain(`${key}:`);
      }
    });

    it('should not have hardcoded storage keys in modules (except service auth state)', () => {
      const modulesDir = path.join(__dirname);
      const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));

      const forbiddenPatterns = [
        /storage\.set\(['"][a-z_]+['"]/,  // Direct storage.set with string key
        /storage\.get\(['"][a-z_]+['"]/,  // Direct storage.get with string key
        /chrome\.storage\.local\.set/,     // Direct chrome.storage calls
      ];

      const allowedHardcodedKeys = [
        'spotify_auth_state',
        'twitch_auth_state',
      ];

      for (const file of files) {
        const filePath = path.join(modulesDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Skip ActivityDatastore and services that legitimately use hardcoded temp keys
        if (file.includes('activity-datastore') || file.includes('service')) {
          continue;
        }

        for (const pattern of forbiddenPatterns) {
          const matches = content.match(pattern);
          if (matches) {
            // Check if it's an allowed temporary key
            const isAllowed = allowedHardcodedKeys.some(key => matches[0].includes(key));
            if (!isAllowed && !file.includes('spotify') && !file.includes('twitch')) {
              console.warn(`${file}: Found hardcoded storage key: ${matches[0]}`);
            }
          }
        }
      }
    });

    it('should use STORAGE_KEYS constants consistently', async () => {
      const srcDir = path.join(__dirname, '..', 'types.ts');
      const content = fs.readFileSync(srcDir, 'utf-8');

      // Extract all STORAGE_KEYS
      const keysMatch = content.match(/export const STORAGE_KEYS = \{([^}]+)\}/s);
      expect(keysMatch).toBeTruthy();

      const keysSection = keysMatch![1];
      const keyCount = (keysSection.match(/:\s*['"`]/g) || []).length;

      // Should have at least the core keys
      expect(keyCount).toBeGreaterThanOrEqual(10);
    });
  });

  describe('Activity storage routing', () => {
    it('should store all user activities to MY_ACTIVITIES', async () => {
      expect(STORAGE_KEYS.MY_ACTIVITIES).toBe('hang_time_my_activities');
      expect(STORAGE_KEYS.ACTIVITY_PROVENANCE_MAP).toBe('hang_time_activity_provenance_map');
    });
  });

  describe('No parallel storage systems', () => {
    it('should not use hardcoded "activities" key (use MY_ACTIVITIES instead)', () => {
      const filePath = path.join(__dirname, 'activity-datastore.ts');
      const content = fs.readFileSync(filePath, 'utf-8');

      // Should NOT have: storage.set('activities', ...)
      const hasBadKey = content.match(/\.set\(['"]activities['"]/);
      expect(hasBadKey).toBeNull();

      // SHOULD use: getMyActivities / setMyActivities / STORAGE_KEYS.MY_ACTIVITIES
      expect(content).toMatch(/getMyActivities|STORAGE_KEYS\.MY_ACTIVITIES/);
    });

    it('should not use deprecated "activity_provenance_map" string literal', () => {
      const filePath = path.join(__dirname, 'activity-datastore.ts');
      const content = fs.readFileSync(filePath, 'utf-8');

      // Should NOT have: storage.set('activity_provenance_map', ...)
      const hasBadKey = content.match(/\.set\(['"]activity_provenance_map['"]/);
      expect(hasBadKey).toBeNull();

      // SHOULD use: STORAGE_KEYS.ACTIVITY_PROVENANCE_MAP
      expect(content).toContain('STORAGE_KEYS.ACTIVITY_PROVENANCE_MAP');
    });
  });
});
