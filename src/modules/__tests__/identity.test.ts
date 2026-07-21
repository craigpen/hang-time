/**
 * Hang Time - Identity Manager Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IdentityManager } from '../identity';

// Mock chrome.storage
const mockStorage = {
  local: {
    get: vi.fn(),
    set: vi.fn(),
  },
};

global.chrome = {
  storage: mockStorage,
} as any;

describe('IdentityManager', () => {
  let identityManager: IdentityManager;
  let mockStorageManager: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageManager = {
      getUserProfile: vi.fn().mockResolvedValue(null),
      setUserProfile: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      set: vi.fn(),
    };
    identityManager = new IdentityManager(mockStorageManager);
  });

  describe('generateIdentifier', () => {
    it('should generate a memorable identifier', async () => {
      const id = await identityManager.generateIdentifier();

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(/^[A-Z][a-z]+[A-Z][a-z]+\d+$/.test(id)).toBe(true);
    });

    it('should generate different identifiers on multiple calls', async () => {
      const id1 = await identityManager.generateIdentifier();
      const id2 = await identityManager.generateIdentifier();

      expect(id1).not.toBe(id2);
    });

    it('should store identifier in storage', async () => {
      await identityManager.generateIdentifier();

      expect(mockStorageManager.setUserProfile).toHaveBeenCalled();
    });
  });

  describe('getIdentifier', () => {
    it('should return generated identifier', async () => {
      const id = await identityManager.getIdentifier();

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(/^[A-Z][a-z]+[A-Z][a-z]+\d+$/.test(id)).toBe(true);
    });

    it('should generate new identifier if none exists', async () => {
      mockStorageManager.getUserProfile.mockResolvedValueOnce(null);

      const id = await identityManager.getIdentifier();

      expect(id).toBeDefined();
      expect(mockStorageManager.setUserProfile).toHaveBeenCalled();
    });
  });

  describe('isValidIdentifier', () => {
    it('should validate correct identifier format', () => {
      expect(identityManager.isValidIdentifier('VascillatingMonkey42')).toBe(true);
      expect(identityManager.isValidIdentifier('HappyTiger123')).toBe(true);
    });

    it('should reject invalid identifier format', () => {
      expect(identityManager.isValidIdentifier('invalid')).toBe(false);
      expect(identityManager.isValidIdentifier('123')).toBe(false);
      expect(identityManager.isValidIdentifier('')).toBe(false);
    });
  });

  describe('clearIdentifier', () => {
    it('should clear stored identifier', async () => {
      const profile = {
        user_id: 'test',
        memorable_identifier: 'TestIdentifier123',
        services_enabled: { spotify: false, twitch: false, steam: false, netflix: false, youtube: false },
      };
      mockStorageManager.getUserProfile.mockResolvedValueOnce(profile);

      await identityManager.clearIdentifier();

      expect(mockStorageManager.setUserProfile).toHaveBeenCalled();
    });
  });
});
