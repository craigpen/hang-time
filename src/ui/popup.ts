/**
 * Hang Time - Popup UI Controller
 * Main extension popup showing active friends
 */

import { Friend, Activity, ExtensionResponse } from '../types';

export class PopupController {
  private activeFriendsContainer: HTMLElement | null = null;
  private noActivityPlaceholder: HTMLElement | null = null;
  private expandedFriendId: string | null = null;
  private refreshInterval: NodeJS.Timeout | null = null;

  static readonly REFRESH_INTERVAL_MS = 3000;

  async init(): Promise<void> {
    console.debug('[Popup] Initializing...');

    this.activeFriendsContainer = document.getElementById('active-friends');
    this.noActivityPlaceholder = document.getElementById('no-activity');

    if (!this.activeFriendsContainer || !this.noActivityPlaceholder) {
      console.error('[Popup] Required DOM elements not found');
      return;
    }

    this._setupEventListeners();
    await this.refreshFriends();

    // Auto-refresh
    this.refreshInterval = setInterval(() => {
      this.refreshFriends().catch((error) => {
        console.error('[Popup] Refresh failed:', error);
      });
    }, PopupController.REFRESH_INTERVAL_MS);

    console.debug('[Popup] Initialization complete');
  }

  async refreshFriends(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_ACTIVE_FRIENDS',
      });

      if (!response.success || !response.data) {
        this._showError(`Failed to load friends: ${response.error || 'Unknown error'}`);
        return;
      }

      if (!Array.isArray(response.data)) {
        console.error('[Popup] Invalid response data type');
        this._showError('Failed to load friends');
        return;
      }

      const friends = response.data as Friend[];
      this._renderFriends(friends);
    } catch (error) {
      console.error('[Popup] Refresh error:', error);
      this._showError('Failed to load friends');
    }
  }

  private _renderFriends(friends: Friend[]): void {
    if (!friends || friends.length === 0) {
      this.activeFriendsContainer!.style.display = 'none';
      this.noActivityPlaceholder!.style.display = 'block';
      return;
    }

    this.activeFriendsContainer!.style.display = 'flex';
    this.noActivityPlaceholder!.style.display = 'none';
    this.activeFriendsContainer!.innerHTML = '';

    for (const friend of friends) {
      const card = this._createFriendCard(friend);
      this.activeFriendsContainer!.appendChild(card);
    }
  }

  private _createFriendCard(friend: Friend): HTMLElement {
    const card = document.createElement('div');
    card.className = 'friend-card';
    card.dataset.friendId = friend.id;

    const activity = friend.current_activity;
    if (!activity) {
      card.innerHTML = `<div class="friend-card-header"><span class="friend-name">${this._escapeHtml(friend.local_name)}</span></div>`;
      return card;
    }

    const badge = this._getActivityBadge(activity.service);
    const shortContent = activity.content.length > 30 ? activity.content.substring(0, 30) + '...' : activity.content;

    card.innerHTML = `
      <div class="friend-card-header">
        <span class="friend-name">${this._escapeHtml(friend.local_name)}</span>
        <span class="activity-badge">${badge} ${this._escapeHtml(shortContent)}</span>
      </div>
      <div class="friend-card-actions" style="display: none;">
        <button class="btn-join">Join Now</button>
        <button class="btn-message">Message</button>
      </div>
    `;

    // Click to expand
    const header = card.querySelector('.friend-card-header');
    if (header) {
      header.addEventListener('click', () => this._toggleCardExpanded(card, friend));
    }

    return card;
  }

  private _toggleCardExpanded(card: HTMLElement, friend: Friend): void {
    const actionsDiv = card.querySelector('.friend-card-actions') as HTMLElement | null;
    if (!actionsDiv) {
      console.error('[Popup] Actions div not found');
      return;
    }
    const isExpanded = actionsDiv.style.display !== 'none';

    if (isExpanded) {
      actionsDiv.style.display = 'none';
      this.expandedFriendId = null;
    } else {
      // Collapse other expanded cards
      if (this.expandedFriendId) {
        const otherCard = document.querySelector(`[data-friend-id="${this.expandedFriendId}"]`) as HTMLElement | null;
        if (otherCard) {
          const otherActions = otherCard.querySelector('.friend-card-actions') as HTMLElement | null;
          if (otherActions) otherActions.style.display = 'none';
        }
      }

      actionsDiv.style.display = 'flex';
      this.expandedFriendId = friend.id;

      // Attach action handlers
      const joinBtn = actionsDiv.querySelector('.btn-join') as HTMLButtonElement | null;
      const msgBtn = actionsDiv.querySelector('.btn-message') as HTMLButtonElement | null;

      if (joinBtn) {
        joinBtn.onclick = (e: MouseEvent) => {
          e.stopPropagation();
          this._handleJoin(friend);
        };
      }

      if (msgBtn) {
        msgBtn.onclick = (e: MouseEvent) => {
          e.stopPropagation();
          this._handleMessage(friend);
        };
      }
    }
  }

  private async _handleJoin(friend: Friend): Promise<void> {
    const activity = friend.current_activity;
    if (!activity || !activity.url) {
      console.warn('[Popup] No URL for join action');
      return;
    }

    try {
      chrome.tabs.create({ url: activity.url });
      console.debug(`[Popup] Opened ${activity.service} for ${friend.local_name}`);
    } catch (error) {
      console.error('[Popup] Join action failed:', error);
      this._showError('Failed to open content');
    }
  }

  private async _handleMessage(friend: Friend): Promise<void> {
    console.debug('[Popup] Message clicked for:', friend.local_name);
    // TODO: Implement message overlay
  }

  private _setupEventListeners(): void {
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
      });
    }
  }

  private _getActivityBadge(service: string): string {
    const badges: Record<string, string> = {
      spotify: '🎵',
      twitch: '📺',
      youtube: '📹',
      netflix: '🎬',
      steam: '🎮',
      idle: '•',
    };
    return badges[service] ?? '•';
  }

  private _escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private _showError(message: string): void {
    if (this.activeFriendsContainer) {
      this.activeFriendsContainer.innerHTML = `<div class="error">${this._escapeHtml(message)}</div>`;
      this.activeFriendsContainer.style.display = 'block';
    }
  }

  destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const controller = new PopupController();
  controller.init().catch((error) => {
    console.error('[Popup] Fatal error:', error);
  });

  // Clean up on unload
  window.addEventListener('beforeunload', () => {
    controller.destroy();
  });
});
