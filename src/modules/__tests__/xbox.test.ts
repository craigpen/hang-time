import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { XboxService } from '../services/xbox';

describe('XboxService', () => {
  let xboxService: XboxService;
  let mockStorage: any;

  beforeEach(() => {
    mockStorage = {
      getUserProfile: vi.fn(),
      setUserProfile: vi.fn(),
    };
    xboxService = new XboxService(mockStorage as any);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isEnabled', () => {
    it('should return true when service is enabled and configured', async () => {
      mockStorage.getUserProfile.mockResolvedValue({
        services_enabled: { 'xbox-api': true },
        xbox_config: { enabled: true, api_key: 'test-key' },
      });

      const enabled = await xboxService.isEnabled();
      expect(enabled).toBe(true);
    });

    it('should return false when service is not enabled in profile', async () => {
      mockStorage.getUserProfile.mockResolvedValue({
        services_enabled: { 'xbox-api': false },
        xbox_config: { enabled: true, api_key: 'test-key' },
      });

      const enabled = await xboxService.isEnabled();
      expect(enabled).toBe(false);
    });
  });

  describe('hasToken', () => {
    it('should return true when api_key is present', async () => {
      mockStorage.getUserProfile.mockResolvedValue({
        xbox_config: { api_key: 'key-123' },
      });

      expect(await xboxService.hasToken()).toBe(true);
    });

    it('should return false when api_key is missing', async () => {
      mockStorage.getUserProfile.mockResolvedValue({
        xbox_config: {},
      });

      expect(await xboxService.hasToken()).toBe(false);
    });
  });

  describe('verifyApiKey', () => {
    it('should return account details on successful API call', async () => {
      const mockResponse = {
        profileUsers: [
          {
            id: '2533274812345678',
            settings: [
              { id: 'Gamertag', value: 'MasterChief117' },
            ],
          },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await xboxService.verifyApiKey('valid-key');
      expect(result).toEqual({
        xuid: '2533274812345678',
        gamertag: 'MasterChief117',
      });
    });

    it('should return null when API returns error', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const result = await xboxService.verifyApiKey('invalid-key');
      expect(result).toBeNull();
    });
  });

  describe('fetchOwnedTitles', () => {
    it('should return formatted owned titles from TitleHub', async () => {
      mockStorage.getUserProfile.mockResolvedValue({
        xbox_config: { api_key: 'test-key' },
      });

      const mockTitleHubResponse = {
        titles: [
          {
            titleId: '123456',
            name: 'Halo Infinite',
            type: 'Game',
          },
          {
            titleId: '789012',
            name: 'Sea of Thieves',
            type: 'Game',
          },
          {
            titleId: '000000',
            name: 'Home',
            type: 'Application',
          },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockTitleHubResponse),
      });

      const games = await xboxService.fetchOwnedTitles();
      expect(games).toHaveLength(2);
      expect(games[0]).toMatchObject({
        appId: 'xbox_123456',
        titleId: '123456',
        name: 'Halo Infinite',
        storefront: 'xbox',
      });
      expect(games[1]).toMatchObject({
        appId: 'xbox_789012',
        titleId: '789012',
        name: 'Sea of Thieves',
        storefront: 'xbox',
      });
    });
  });

  describe('getCurrentActivity', () => {
    it('should return active game presence when playing on Xbox', async () => {
      mockStorage.getUserProfile.mockResolvedValue({
        xbox_config: { api_key: 'test-key', gamertag: 'Spartan' },
      });

      const mockPresenceResponse = [
        {
          xuid: '2533274812345678',
          state: 'Online',
          lastSeen: {
            titleId: '123456',
            titleName: 'Halo Infinite',
          },
        },
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockPresenceResponse),
      });

      const activity = await xboxService.getCurrentActivity();
      expect(activity).not.toBeNull();
      expect(activity?.service).toBe('xbox-api');
      expect(activity?.content).toBe('Halo Infinite');
      expect(activity?.state).toBe('playing');
    });
  });
});
