/**
 * Unit tests for UI tab controllers (FriendsTabController, SettingsTabController, MessagesTabController, ToastManager)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FriendsTabController } from '../friends';
import { SettingsTabController } from '../settings';
import { MessagesTabController } from '../messages';
import { ToastManager } from '../toast';
import { StorageManager } from '../../modules/storage';
import { Friend, Activity } from '../../types';

describe('UI Tab Controllers', () => {
  let mockStorage: StorageManager;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    mockStorage = new StorageManager();
  });

  describe('ToastManager', () => {
    it('should create and append toast element to container', () => {
      const container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);

      const toast = new ToastManager();
      toast.init();
      toast.show('Hello World', { duration: 10000 });

      const toastElement = container.querySelector('.toast');
      expect(toastElement).not.toBeNull();
      expect(toastElement?.textContent).toBe('Hello World');
    });

    it('should handle showSuccess and showError', () => {
      const container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);

      const toast = new ToastManager();
      toast.showSuccess('Operation successful');
      expect(container.textContent).toContain('Operation successful');

      toast.showError('Something went wrong');
      expect(container.textContent).toContain('Something went wrong');
    });
  });

  describe('MessagesTabController', () => {
    it('should format timestamps correctly', () => {
      const controller = new MessagesTabController();
      const now = Date.now();

      expect(controller.formatTime(now)).toBe('now');
      expect(controller.formatTime(now - 5 * 60 * 1000)).toBe('5m ago');
      expect(controller.formatTime(now - 2 * 60 * 60 * 1000)).toBe('2h ago');
      expect(controller.formatTime(now - 48 * 60 * 60 * 1000)).toBe('2d ago');
    });

    it('should render message modal with messages and close on close button', () => {
      const controller = new MessagesTabController();
      const friend: Friend = {
        uuid: 'friend-123',
        pubkey: 'pubkey-123',
        local_name: 'Alice',
        added_at: Date.now(),
        last_seen: Date.now(),
        muted: false,
        hidden_services: [],
        current_activities: {},
        state: 'active',
      };

      const messages = [
        { is_outbound: true, content: 'Hey Alice!', timestamp: Date.now() - 60000 },
        { is_outbound: false, content: 'Hi Bob!', timestamp: Date.now() },
      ];

      controller.showMessageModal(friend, messages);

      const modal = document.querySelector('.message-modal');
      expect(modal).not.toBeNull();
      expect(modal?.textContent).toContain('Alice');
      expect(modal?.textContent).toContain('Hey Alice!');
      expect(modal?.textContent).toContain('Hi Bob!');

      const closeBtn = modal?.querySelector('.btn-close-modal') as HTMLElement;
      closeBtn.click();
      expect(document.querySelector('.message-modal')).toBeNull();
    });
  });

  describe('FriendsTabController', () => {
    let friendsList: HTMLElement;
    let noFriendsPlaceholder: HTMLElement;
    let messagesController: MessagesTabController;
    let friendsController: FriendsTabController;

    beforeEach(() => {
      friendsList = document.createElement('div');
      friendsList.id = 'friends-list';
      noFriendsPlaceholder = document.createElement('div');
      noFriendsPlaceholder.id = 'no-friends';
      document.body.appendChild(friendsList);
      document.body.appendChild(noFriendsPlaceholder);

      messagesController = new MessagesTabController();
      friendsController = new FriendsTabController(mockStorage, messagesController, {
        friendsList,
        noFriendsPlaceholder,
      });
    });

    it('should correctly format status text for friends', () => {
      const activeFriend: Friend = {
        uuid: 'f-1',
        pubkey: 'pk-1',
        local_name: 'Active User',
        added_at: Date.now(),
        last_seen: Date.now(),
        muted: false,
        hidden_services: [],
        current_activities: {
          'youtube-tab': {
            id: 'yt-1',
            service: 'youtube-tab',
            content: 'Lo-Fi Girl Live',
            timestamp: Date.now(),
            freshness_timestamp: Date.now(),
            state: 'playing',
            metadata: {},
          },
        },
        state: 'active',
      };

      const dndFriend: Friend = {
        ...activeFriend,
        dnd: true,
      };

      const offlineFriend: Friend = {
        ...activeFriend,
        current_activities: {},
        last_seen: Date.now() - 40 * 24 * 60 * 60 * 1000,
      };

      expect(friendsController.getStatusText(activeFriend)).toBe('Active');
      expect(friendsController.getStatusText(dndFriend)).toBe('⛔ DND');
      expect(friendsController.getStatusText(offlineFriend)).toMatch(/Last seen 4\dd ago/);
    });

    it('should sort activities with video tabs prioritized before gaming', () => {
      const activities: Activity[] = [
        { id: 'a1', service: 'steam-api', content: 'Counter-Strike 2', timestamp: 100, freshness_timestamp: 100, metadata: {} },
        { id: 'a2', service: 'youtube-tab', content: 'Music Stream', timestamp: 200, freshness_timestamp: 200, metadata: {} },
      ];

      const sorted = friendsController.sortActivitiesByType(activities);
      expect(sorted[0]?.service).toBe('youtube-tab');
      expect(sorted[1]?.service).toBe('steam-api');
    });

    it('should render active friend with activity row', async () => {
      const friend: Friend = {
        uuid: 'friend-1',
        pubkey: 'pubkey-1',
        local_name: 'Charlie',
        added_at: Date.now(),
        last_seen: Date.now(),
        muted: false,
        hidden_services: [],
        current_activities: {
          'youtube-tab': {
            id: 'act-1',
            service: 'youtube-tab',
            content: 'Synthwave Radio',
            timestamp: Date.now(),
            freshness_timestamp: Date.now(),
            state: 'playing',
            metadata: {
              progress: 30,
              duration: 100,
            },
          },
        },
        state: 'active',
      };

      await friendsController.renderFriends([friend]);

      const friendElement = friendsList.querySelector('[data-friend-id="friend-1"]');
      expect(friendElement).not.toBeNull();
      expect(friendElement?.textContent).toContain('Charlie');
      expect(friendElement?.textContent).toContain('Synthwave Radio');
    });
  });

  describe('SettingsTabController', () => {
    let settingsPanel: HTMLElement;
    let popupContainer: HTMLElement;
    let settingsController: SettingsTabController;

    beforeEach(() => {
      settingsPanel = document.createElement('div');
      settingsPanel.id = 'settings-panel';
      popupContainer = document.createElement('div');
      popupContainer.id = 'popup-container';
      document.body.appendChild(settingsPanel);
      document.body.appendChild(popupContainer);

      settingsController = new SettingsTabController(mockStorage, {
        settingsPanel,
        popupContainer,
      });
    });

    it('should toggle theme and update documentElement data-theme attribute', () => {
      settingsController.setTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(localStorage.getItem('hang-time-theme')).toBe('dark');

      settingsController.setTheme('auto');
      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
      expect(localStorage.getItem('hang-time-theme')).toBe('auto');
    });

    it('should show and hide settings panel with body classes', async () => {
      settingsController.showSettingsPanel();
      expect(settingsPanel.style.display).toBe('flex');
      expect(document.body.classList.contains('settings-open')).toBe(true);

      await settingsController.hideSettingsPanel();
      expect(settingsPanel.style.display).toBe('none');
      expect(document.body.classList.contains('settings-open')).toBe(false);
    });
  });
});
