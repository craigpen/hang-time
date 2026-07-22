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
  private addFriendForm: HTMLElement | null = null;
  private friendIdentifierInput: HTMLInputElement | null = null;
  private friendNicknameInput: HTMLInputElement | null = null;

  static readonly REFRESH_INTERVAL_MS = 3000;

  async init(): Promise<void> {
    console.debug('[Popup] Initializing...');

    this.activeFriendsContainer = document.getElementById('active-friends');
    this.noActivityPlaceholder = document.getElementById('no-activity');
    this.addFriendForm = document.getElementById('add-friend-form');
    this.friendIdentifierInput = document.getElementById('friend-identifier') as HTMLInputElement;
    this.friendNicknameInput = document.getElementById('friend-nickname') as HTMLInputElement;

    if (!this.activeFriendsContainer || !this.noActivityPlaceholder) {
      console.error('[Popup] Required DOM elements not found');
      return;
    }

    this._setupEventListeners();
    await this._loadMyActivity();
    await this.refreshFriends();

    // Auto-refresh
    this.refreshInterval = setInterval(() => {
      this._loadMyActivity().catch((error) => {
        console.error('[Popup] Activity refresh failed:', error);
      });
      this.refreshFriends().catch((error) => {
        console.error('[Popup] Friends refresh failed:', error);
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
    if (!activity) {
      console.warn('[Popup] No activity for join action');
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'JOIN_ACTIVITY',
        data: { friendId: friend.id, activity },
      });

      if (response.success) {
        console.debug(`[Popup] Successfully joined ${friend.local_name}'s activity`);
      } else {
        this._showError(response.error || 'Failed to join activity');
      }
    } catch (error) {
      console.error('[Popup] Join action failed:', error);
      this._showError('Failed to join activity');
    }
  }

  private async _handleMessage(friend: Friend): Promise<void> {
    try {
      // Get messages from background
      const response = await chrome.runtime.sendMessage({
        type: 'GET_MESSAGES',
        data: { friendId: friend.id },
      });

      if (!response.success) {
        this._showError('Failed to load messages');
        return;
      }

      // Open message modal
      this._showMessageModal(friend, response.data || []);
    } catch (error) {
      console.error('[Popup] Message load failed:', error);
      this._showError('Failed to load messages');
    }
  }

  private _showMessageModal(friend: Friend, messages: any[]): void {
    const modal = document.createElement('div');
    modal.className = 'message-modal';
    modal.innerHTML = `
      <div class="message-modal-content">
        <div class="message-modal-header">
          <span>${this._escapeHtml(friend.local_name)}</span>
          <button class="btn-close-modal">×</button>
        </div>
        <div class="message-list">
          ${messages.length === 0 ? '<div class="no-messages">No messages yet</div>' : ''}
          ${messages.map((msg) => `
            <div class="message ${msg.is_outbound ? 'outbound' : 'inbound'}">
              <span class="message-content">${this._escapeHtml(msg.content)}</span>
              <span class="message-time">${this._formatTime(msg.timestamp)}</span>
            </div>
          `).join('')}
        </div>
        <div class="message-input-area">
          <input type="text" class="message-input" placeholder="Type a message...">
          <button class="btn-send-message">Send</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Close button handler
    const closeBtn = modal.querySelector('.btn-close-modal');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modal.remove();
      });
    }

    // Send button handler
    const sendBtn = modal.querySelector('.btn-send-message');
    const input = modal.querySelector('.message-input') as HTMLInputElement | null;
    if (sendBtn && input) {
      sendBtn.addEventListener('click', () => this._sendMessage(friend, input, modal));
      input.addEventListener('keypress', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          this._sendMessage(friend, input, modal);
        }
      });
    }

    // Close on backdrop click
    modal.addEventListener('click', (e: MouseEvent) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  private async _sendMessage(friend: Friend, input: HTMLInputElement, modal: HTMLElement): Promise<void> {
    const content = input.value.trim();
    if (!content) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_MESSAGE',
        data: { friendId: friend.id, content },
      });

      if (response.success) {
        input.value = '';
        console.debug('[Popup] Message sent');

        // Reload messages
        const messagesResponse = await chrome.runtime.sendMessage({
          type: 'GET_MESSAGES',
          data: { friendId: friend.id },
        });

        if (messagesResponse.success) {
          modal.remove();
          this._showMessageModal(friend, messagesResponse.data || []);
        }
      } else {
        console.error('[Popup] Failed to send message:', response.error);
      }
    } catch (error) {
      console.error('[Popup] Send message failed:', error);
    }
  }

  private _formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMinutes = Math.floor((now.getTime() - date.getTime()) / 60000);

    if (diffMinutes < 1) return 'now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  private async _loadMyActivity(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_CURRENT_ACTIVITY',
      });

      const identifierResponse = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });

      if (!identifierResponse.success || !identifierResponse.data) {
        console.error('[Popup] Failed to get user identifier');
        return;
      }

      const identifier = identifierResponse.data.identifier;
      const idDisplay = document.getElementById('my-id-display');
      if (idDisplay) {
        idDisplay.textContent = identifier;
      }

      const activity = response.success && response.data ? response.data : null;
      this._renderMyActivity(activity);
    } catch (error) {
      console.error('[Popup] Failed to load my activity:', error);
    }
  }

  private _renderMyActivity(activity: Activity | null): void {
    const activityBadge = document.getElementById('activity-badge');
    if (activityBadge) {
      if (!activity || activity.service === 'idle') {
        activityBadge.textContent = 'Idle';
        activityBadge.className = 'status-idle';
      } else {
        const badge = this._getActivityBadge(activity.service);
        activityBadge.textContent = `${badge} ${this._escapeHtml(activity.content)}`;
        activityBadge.className = 'status-active';
      }
    }

    const servicesList = document.getElementById('my-services');
    if (servicesList) {
      // For now, we'll show a simple list of services
      // In a full implementation, this would show enabled services with their current status
      servicesList.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85em; margin: 0;">Services are displayed on Settings page</p>';
    }
  }

  private _setupEventListeners(): void {
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
      });
    }

    // Copy ID button
    const copyIdBtn = document.getElementById('copy-id-btn');
    if (copyIdBtn) {
      copyIdBtn.addEventListener('click', () => this._handleCopyId());
    }

    // Add friend button from empty state
    const addFriendBtnAlt = document.getElementById('add-friend-btn-alt');
    if (addFriendBtnAlt) {
      addFriendBtnAlt.addEventListener('click', () => this._showAddFriendForm());
    }

    // Form submit button
    const submitBtn = document.getElementById('friend-submit-btn');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this._handleAddFriendSubmit());
    }

    // Form cancel button
    const cancelBtn = document.getElementById('friend-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this._hideAddFriendForm());
    }

    // Allow Enter key to submit form
    if (this.friendNicknameInput) {
      this.friendNicknameInput.addEventListener('keypress', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          this._handleAddFriendSubmit();
        }
      });
    }
  }

  private _handleCopyId(): void {
    const idDisplay = document.getElementById('my-id-display');
    if (idDisplay && idDisplay.textContent) {
      navigator.clipboard.writeText(idDisplay.textContent).then(() => {
        console.debug('[Popup] Identifier copied');
        // Visual feedback
        const copyBtn = document.getElementById('copy-id-btn');
        if (copyBtn) {
          const originalText = copyBtn.textContent;
          copyBtn.textContent = '✓ Copied';
          setTimeout(() => {
            copyBtn.textContent = originalText;
          }, 2000);
        }
      });
    }
  }

  private _showAddFriendForm(): void {
    if (this.addFriendForm) {
      this.addFriendForm.style.display = 'block';
      if (this.friendIdentifierInput) {
        this.friendIdentifierInput.focus();
      }
    }
    if (this.noActivityPlaceholder) {
      this.noActivityPlaceholder.style.display = 'none';
    }
  }

  private _hideAddFriendForm(): void {
    if (this.addFriendForm) {
      this.addFriendForm.style.display = 'none';
    }
    // Only show empty state if no friends
    this.refreshFriends().catch((error) => {
      console.error('[Popup] Refresh failed:', error);
    });
  }

  private async _handleAddFriendSubmit(): Promise<void> {
    const identifier = this.friendIdentifierInput?.value.trim();
    const localName = this.friendNicknameInput?.value.trim();

    if (!identifier || !localName) {
      alert('Please fill in both identifier and nickname');
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ADD_FRIEND',
        data: { identifier, localName },
      });

      if (response.success) {
        console.debug('[Popup] Friend added successfully');
        // Clear form
        if (this.friendIdentifierInput) this.friendIdentifierInput.value = '';
        if (this.friendNicknameInput) this.friendNicknameInput.value = '';
        this._hideAddFriendForm();
        await this.refreshFriends();
      } else {
        alert(`Failed to add friend: ${response.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Popup] Add friend failed:', error);
      alert('Failed to add friend');
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
