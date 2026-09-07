/**
 * Hang Time - Popup UI Controller
 * Main extension popup orchestrator coordinating Friends, Games, Messages, and Settings controllers
 */

import { Activity, STORAGE_KEYS, UserProfile } from '../types';
import { StorageManager } from '../modules/storage';
import { GameLibraryManager } from '../modules/game-library';
import { MetadataFetcher } from '../modules/metadata-fetcher';
import { GamesTabController } from './games';
import { FriendsTabController } from './friends';
import { SettingsTabController } from './settings';
import { MessagesTabController } from './messages';
import { toastManager } from './toast';

export class PopupController {
  private friendsList: HTMLElement | null = null;
  private noFriendsPlaceholder: HTMLElement | null = null;
  private myActivityInterval: NodeJS.Timeout | null = null;
  private fallbackFriendsInterval: NodeJS.Timeout | null = null;
  private addFriendForm: HTMLElement | null = null;
  private friendIdentifierInput: HTMLInputElement | null = null;
  private friendNicknameInput: HTMLInputElement | null = null;
  private settingsPanel: HTMLElement | null = null;
  private popupContainer: HTMLElement | null = null;
  private refreshPaused: boolean = false;
  private storage: StorageManager = new StorageManager();

  // Tab & Domain Controllers
  private gamesTabController: GamesTabController | null = null;
  private friendsTabController: FriendsTabController | null = null;
  private settingsTabController: SettingsTabController | null = null;
  private messagesTabController: MessagesTabController = new MessagesTabController();

  static readonly MY_ACTIVITY_REFRESH_MS = 3000;
  static readonly FALLBACK_FRIENDS_REFRESH_MS = 15000;

  async init(): Promise<void> {
    console.debug('[Popup] Initializing...');

    toastManager.init();
    await this.storage.init();

    this.friendsList = document.getElementById('friends-list');
    this.noFriendsPlaceholder = document.getElementById('no-friends');
    this.addFriendForm = document.getElementById('add-friend-form');
    this.friendIdentifierInput = document.getElementById('friend-identifier') as HTMLInputElement;
    this.friendNicknameInput = document.getElementById('friend-nickname') as HTMLInputElement;
    this.settingsPanel = document.getElementById('settings-panel');
    this.popupContainer = document.getElementById('popup-container');

    if (!this.friendsList) {
      console.error('[Popup] Required DOM elements not found');
      return;
    }

    // Initialize domain controllers
    this.friendsTabController = new FriendsTabController(
      this.storage,
      this.messagesTabController,
      {
        friendsList: this.friendsList,
        noFriendsPlaceholder: this.noFriendsPlaceholder,
        addFriendForm: this.addFriendForm,
        friendIdentifierInput: this.friendIdentifierInput,
        friendNicknameInput: this.friendNicknameInput,
        onResizeNeeded: () => {
          if (!this.settingsPanel || this.settingsPanel.style.display === 'none') {
            this.settingsTabController?.resizePopupToFitContent();
          }
        },
      }
    );

    this.settingsTabController = new SettingsTabController(this.storage, {
      settingsPanel: this.settingsPanel,
      popupContainer: this.popupContainer,
      getGamesTabController: () => this.gamesTabController,
    });

    const savedTheme = localStorage.getItem('hang-time-theme') || 'auto';
    this.settingsTabController.setTheme(savedTheme);

    this._setupEventListeners();
    this._setupTabNavigation();
    this._setupGamesController();
    this._setupMessageListener();
    this._setupStorageListener();

    await this.friendsTabController.loadPendingInvites();
    await this._loadMyActivity();
    await this.refreshFriends();
    await this.settingsTabController.loadSettingsPanel();

    // Auto-refresh "My Activity" only (every 3 seconds)
    this.myActivityInterval = setInterval(() => {
      if (!this.refreshPaused) {
        this._loadMyActivity().catch((error) => {
          console.error('[Popup] Activity refresh failed:', error);
        });
      }
    }, PopupController.MY_ACTIVITY_REFRESH_MS);

    // Fallback poll for friends
    this.fallbackFriendsInterval = setInterval(() => {
      if (!this.refreshPaused) {
        this.refreshFriends().catch((error) => {
          console.error('[Popup] Fallback friends refresh failed:', error);
        });
      }
    }, PopupController.FALLBACK_FRIENDS_REFRESH_MS);

    console.debug('[Popup] Initialization complete');
  }

  async refreshFriends(): Promise<void> {
    if (this.friendsTabController) {
      await this.friendsTabController.refreshFriends();
    }
  }

  async refreshAll(): Promise<void> {
    try {
      await this._loadMyActivity();
      await this.refreshFriends();

      await chrome.runtime.sendMessage({
        type: 'REFRESH_GAME_LIBRARY',
      }).catch(() => {});

      if (this.gamesTabController) {
        await this.gamesTabController.refresh().catch((error) => {
          console.debug('[Popup] Games tab refresh skipped/failed:', error);
        });
      }

      if (this.settingsPanel && this.settingsPanel.style.display !== 'none') {
        await this.settingsTabController?.loadSettingsPanel();
      }
    } catch (error) {
      console.error('[Popup] Refresh all failed:', error);
    }
  }

  private async _loadMyActivity(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_ALL_ACTIVITIES',
      });

      if (response.success && response.data) {
        const rawActivities = response.data.userActivities || response.data.myActivities || {};
        const userActivities = (Array.isArray(rawActivities) ? rawActivities : Object.values(rawActivities)).filter((a) => a) as Activity[];
        this.friendsTabController?.setUserActivities(userActivities);
        this._renderMyActivity(userActivities);
      }
    } catch (error) {
      console.error('[Popup] Failed to load my activity:', error);
    }
  }

  private _renderMyActivity(activities: Activity[]): void {
    const activityDisplay = document.getElementById('my-activity-display');
    if (!activityDisplay) return;

    if (activities.length === 0) {
      activityDisplay.textContent = 'Idle';
      activityDisplay.classList.add('idle');
      return;
    }

    const primary = activities[0];
    if (!primary) {
      activityDisplay.textContent = 'Idle';
      activityDisplay.classList.add('idle');
      return;
    }

    activityDisplay.classList.remove('idle');
    const truncated = primary.content.length > 28 ? primary.content.substring(0, 28) + '...' : primary.content;
    activityDisplay.textContent = `${primary.service}: ${truncated}`;
  }

  private _setupGamesController(): void {
    const gamesContent = document.getElementById('games-content');
    if (gamesContent) {
      const gameLibraryManager = GameLibraryManager.getInstance(this.storage);
      const metadataFetcher = MetadataFetcher.getInstance(this.storage);
      this.gamesTabController = new GamesTabController(
        gamesContent,
        gameLibraryManager,
        metadataFetcher,
        this.storage
      );
      this.gamesTabController.init().catch((error) => {
        console.error('[Popup] Failed to initialize GamesTabController:', error);
      });
    }
  }

  private _setupTabNavigation(): void {
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const tabName = target.dataset['tab'];
        if (!tabName) return;

        tabButtons.forEach((b) => b.classList.remove('active'));
        target.classList.add('active');

        document.querySelectorAll('.tab-content').forEach((content) => {
          content.classList.remove('active');
        });

        const activeContent = document.getElementById(`${tabName}-content`);
        if (activeContent) {
          activeContent.classList.add('active');
        }

        if (tabName === 'games' && this.gamesTabController) {
          this.gamesTabController.render().catch((error) => {
            console.error('[Popup] Failed to render games tab:', error);
          });
        }

        this.settingsTabController?.resizePopupToFitContent();
      });
    });
  }

  private async _updateDndButtonDisplay(btn?: HTMLElement | null, isDnd?: boolean): Promise<void> {
    const dndBtn = btn || document.getElementById('dnd-toggle-btn');
    if (!dndBtn) return;

    let dndState = isDnd;
    if (dndState === undefined) {
      dndState = await this.storage.getDndMode();
    }

    if (dndState) {
      dndBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"></circle>
          <line x1="5.6" y1="5.6" x2="18.4" y2="18.4"></line>
        </svg>
      `;
      dndBtn.classList.add('dnd-active');
      dndBtn.title = 'Do Not Disturb';
    } else {
      dndBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"></circle>
        </svg>
      `;
      dndBtn.classList.remove('dnd-active');
      dndBtn.title = 'Available';
    }
  }

  private _setupEventListeners(): void {
    const addFriendBtn = document.getElementById('btn-add-friend');
    if (addFriendBtn) {
      addFriendBtn.addEventListener('click', () => {
        this.friendsTabController?.showAddFriendForm();
      });
    }

    const cancelAddFriendBtn = document.getElementById('cancel-add-friend');
    if (cancelAddFriendBtn) {
      cancelAddFriendBtn.addEventListener('click', () => {
        this.friendsTabController?.hideAddFriendForm();
      });
    }

    if (this.addFriendForm) {
      this.addFriendForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.friendsTabController?.handleAddFriendSubmit();
      });
    }

    const showInactiveBtn = document.getElementById('show-inactive-btn');
    if (showInactiveBtn) {
      showInactiveBtn.addEventListener('click', () => {
        this.friendsTabController?.toggleShowInactiveFriends();
      });
    }

    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        this.settingsTabController?.showSettingsPanel();
      });
    }

    const closeSettingsBtn = document.getElementById('close-settings-btn');
    if (closeSettingsBtn) {
      closeSettingsBtn.addEventListener('click', () => {
        this.settingsTabController?.hideSettingsPanel();
      });
    }

    const dndBtn = document.getElementById('dnd-toggle-btn');
    if (dndBtn) {
      this._updateDndButtonDisplay(dndBtn);
      dndBtn.addEventListener('click', async () => {
        const currentDnd = await this.storage.getDndMode();
        const newDnd = !currentDnd;
        await this.storage.setDndMode(newDnd);
        await this._updateDndButtonDisplay(dndBtn, newDnd);

        chrome.runtime.sendMessage({
          type: 'SET_DND_MODE',
          data: { dnd: newDnd },
        }).catch((err) => {
          console.debug('[Popup] Failed to notify background of DND change:', err);
        });

        toastManager.show(newDnd ? 'Do Not Disturb enabled' : 'Available mode enabled');
      });
    }

    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.refreshAll();
      });
    }
  }

  private _setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'REFRESH_FRIENDS_UI' || message.type === 'ACTIVITY_UPDATED') {
        this.refreshFriends().catch(() => {});
        this._loadMyActivity().catch(() => {});
        sendResponse({ success: true });
        return true;
      }

      if (message.type === 'INVITE_RECEIVED') {
        this.friendsTabController?.loadPendingInvites().then(() => {
          this.refreshFriends();
        });
        sendResponse({ success: true });
        return true;
      }

      if (message.type === 'DND_MODE_CHANGED') {
        this._updateDndButtonDisplay(null, message.data?.dnd);
        sendResponse({ success: true });
        return true;
      }

      return false;
    });
  }

  private _setupStorageListener(): void {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes[STORAGE_KEYS.RECEIVED_INVITES] || changes[STORAGE_KEYS.USER_PROFILE]) {
          this.friendsTabController?.loadPendingInvites().then(() => {
            this.refreshFriends();
          });
          if (changes[STORAGE_KEYS.USER_PROFILE]) {
            const newProfile = changes[STORAGE_KEYS.USER_PROFILE]?.newValue as UserProfile | undefined;
            if (newProfile && typeof newProfile.dnd_enabled === 'boolean') {
              this._updateDndButtonDisplay(null, newProfile.dnd_enabled);
            }
          }
        }
      }
    });
  }

  destroy(): void {
    if (this.myActivityInterval) {
      clearInterval(this.myActivityInterval);
    }
    if (this.fallbackFriendsInterval) {
      clearInterval(this.fallbackFriendsInterval);
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const controller = new PopupController();
  controller.init().catch((error) => {
    console.error('[Popup] Fatal error:', error);
  });

  window.addEventListener('beforeunload', () => {
    controller.destroy();
  });
});
