/**
 * Hang Time - Popup UI Controller
 * Main extension popup showing active friends
 */

import { Friend, Activity, ExtensionResponse } from '../types';

export class PopupController {
  private friendsContainer: HTMLElement | null = null;
  private myActivityList: HTMLElement | null = null;
  private noFriendsPlaceholder: HTMLElement | null = null;
  private expandedFriendId: string | null = null;
  private refreshInterval: NodeJS.Timeout | null = null;
  private addFriendForm: HTMLElement | null = null;
  private friendIdentifierInput: HTMLInputElement | null = null;
  private friendNicknameInput: HTMLInputElement | null = null;
  private showInactiveCheckbox: HTMLInputElement | null = null;
  private showInactiveFriends: boolean = false;
  private settingsPanel: HTMLElement | null = null;
  private popupContainer: HTMLElement | null = null;

  static readonly REFRESH_INTERVAL_MS = 3000;

  async init(): Promise<void> {
    console.debug('[Popup] Initializing...');

    this.friendsContainer = document.getElementById('friends-container');
    this.myActivityList = document.getElementById('my-activity-list');
    this.noFriendsPlaceholder = document.getElementById('no-friends');
    this.addFriendForm = document.getElementById('add-friend-form');
    this.friendIdentifierInput = document.getElementById('friend-identifier') as HTMLInputElement;
    this.friendNicknameInput = document.getElementById('friend-nickname') as HTMLInputElement;
    this.showInactiveCheckbox = document.getElementById('show-inactive-checkbox') as HTMLInputElement;
    this.settingsPanel = document.getElementById('settings-panel');
    this.popupContainer = document.getElementById('popup-container');

    if (!this.friendsContainer || !this.myActivityList) {
      console.error('[Popup] Required DOM elements not found');
      return;
    }

    this._setupEventListeners();
    await this._loadMyActivity();
    await this.refreshFriends();
    await this._loadSettingsPanel();

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
      // Always get all friends to check if toggle should show
      const allFriendsResponse = await chrome.runtime.sendMessage({
        type: 'GET_ALL_FRIENDS',
      });

      if (!allFriendsResponse.success || !Array.isArray(allFriendsResponse.data)) {
        this._showError(`Failed to load friends: ${allFriendsResponse.error || 'Unknown error'}`);
        return;
      }

      const allFriends = allFriendsResponse.data as Friend[];

      // Show toggle if there are any friends at all (active or inactive)
      if (this.showInactiveToggle) {
        this.showInactiveToggle.style.display = allFriends.length > 0 ? 'block' : 'none';
      }

      // Now get active or all based on toggle
      const messageType = this.showInactiveFriends ? 'GET_ALL_FRIENDS' : 'GET_ACTIVE_FRIENDS';
      const response = await chrome.runtime.sendMessage({
        type: messageType,
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

      const displayFriends = response.data as Friend[];
      this._renderFriends(displayFriends);
    } catch (error) {
      console.error('[Popup] Refresh error:', error);
      this._showError('Failed to load friends');
    }
  }

  private _renderFriends(friends: Friend[]): void {
    // Separate active and inactive friends
    const activeFriends = friends.filter((f) => f.current_activity && f.current_activity.service !== 'idle');
    const inactiveFriends = friends.filter((f) => !f.current_activity || f.current_activity.service === 'idle');

    // Show/hide based on toggle
    let displayFriends: Friend[] = activeFriends;
    if (this.showInactiveFriends && inactiveFriends.length > 0) {
      displayFriends = [...activeFriends, ...inactiveFriends];
    }

    if (!displayFriends || displayFriends.length === 0) {
      this.friendsContainer!.innerHTML = '';
      this.noFriendsPlaceholder!.style.display = 'block';
      this._resizePopupToFitContent();
      return;
    }

    this.noFriendsPlaceholder!.style.display = 'none';
    this.friendsContainer!.innerHTML = '';

    for (const friend of displayFriends) {
      const item = this._createFriendItem(friend);
      const isInactive = !friend.current_activity || friend.current_activity.service === 'idle';
      if (isInactive) {
        item.classList.add('inactive');
      }
      this.friendsContainer!.appendChild(item);
    }

    this._resizePopupToFitContent();
  }

  private _createFriendItem(friend: Friend): HTMLElement {
    const item = document.createElement('div');
    item.className = 'activity-item';
    item.dataset.friendId = friend.id;

    const activity = friend.current_activity;
    const isInactive = !activity || activity.service === 'idle';
    const statusText = isInactive ? 'Inactive' : 'Active';

    const header = document.createElement('div');
    header.className = 'activity-header';
    header.innerHTML = `
      <span class="activity-label">${this._escapeHtml(friend.local_name)}</span>
      <span class="activity-status">${statusText}</span>
    `;
    item.appendChild(header);

    // Collapsible content
    const content = document.createElement('div');
    content.className = 'activity-content';
    content.style.display = 'none';

    // Activities list
    const activitiesList = document.createElement('div');
    activitiesList.className = 'activity-items';

    // Get all active activities (should fetch all, not just current_activity)
    // For now, show current_activity
    if (!isInactive) {
      const activityItem = this._createActivityItemElement(activity);
      activitiesList.appendChild(activityItem);
    } else {
      activitiesList.innerHTML = '<div class="activity-item-text">Idle</div>';
    }

    content.appendChild(activitiesList);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'activity-actions';
    if (!isInactive) {
      actions.innerHTML = `
        <button class="btn-action btn-join" title="Join">Join Now</button>
        <button class="btn-action btn-message" title="Message">Message</button>
        <button class="btn-action btn-remove" title="Remove">Remove</button>
      `;
    } else {
      actions.innerHTML = `
        <button class="btn-action btn-message" title="Message">Message</button>
        <button class="btn-action btn-remove" title="Remove">Remove</button>
      `;
    }
    content.appendChild(actions);

    item.appendChild(content);

    // Toggle expand/collapse on header click
    header.addEventListener('click', () => {
      const isExpanded = content.style.display !== 'none';
      if (isExpanded) {
        content.style.display = 'none';
        item.classList.remove('expanded');
        this.expandedFriendId = null;
      } else {
        // Collapse other items
        document.querySelectorAll('.activity-item.expanded').forEach((el) => {
          const elContent = el.querySelector('.activity-content') as HTMLElement | null;
          if (elContent) elContent.style.display = 'none';
          el.classList.remove('expanded');
        });

        content.style.display = 'block';
        item.classList.add('expanded');
        this.expandedFriendId = friend.id;
      }
      this._resizePopupToFitContent();
    });

    // Attach action button listeners
    const joinBtn = actions.querySelector('.btn-join') as HTMLButtonElement | null;
    const msgBtn = actions.querySelector('.btn-message') as HTMLButtonElement | null;
    const removeBtn = actions.querySelector('.btn-remove') as HTMLButtonElement | null;

    if (joinBtn) {
      joinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._handleJoin(friend);
      });
    }

    if (msgBtn) {
      msgBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._handleMessage(friend);
      });
    }

    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._handleRemoveFriend(friend);
      });
    }

    return item;
  }

  private _createActivityItemElement(activity: Activity): HTMLElement {
    const item = document.createElement('div');
    item.className = 'activity-item-row';

    const badge = this._getActivityBadge(activity.service);
    const content = this._escapeHtml(activity.content);

    item.innerHTML = `
      <span class="activity-badge">${badge}</span>
      <span class="activity-content-text">${content}</span>
    `;

    return item;
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
      const removeBtn = actionsDiv.querySelector('.btn-remove') as HTMLButtonElement | null;

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

      if (removeBtn) {
        removeBtn.onclick = (e: MouseEvent) => {
          e.stopPropagation();
          this._handleRemoveFriend(friend);
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

  private async _handleRemoveFriend(friend: Friend): Promise<void> {
    if (!confirm(`Remove friend "${friend.local_name}"?`)) {
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'REMOVE_FRIEND',
        data: { friendId: friend.id },
      });

      if (response.success) {
        console.debug(`[Popup] Removed friend: ${friend.local_name}`);
        await this.refreshFriends();
      } else {
        this._showError(response.error || 'Failed to remove friend');
      }
    } catch (error) {
      console.error('[Popup] Remove friend failed:', error);
      this._showError('Failed to remove friend');
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

      // Get all active activities (both OAuth and browser tabs)
      const response = await chrome.runtime.sendMessage({
        type: 'GET_ALL_ACTIVE_ACTIVITIES',
      });

      const activities = response.success && response.data ? response.data : [];
      this._renderMyActivity(activities);
    } catch (error) {
      console.error('[Popup] Failed to load my activity:', error);
    }
  }

  private _renderMyActivity(activities: Activity[]): void {
    if (!this.myActivityList) return;

    this.myActivityList.innerHTML = '';

    if (!activities || activities.length === 0) {
      const idleItem = document.createElement('div');
      idleItem.className = 'activity-item-row';
      idleItem.innerHTML = '<span style="color: var(--text-tertiary);">Idle</span>';
      this.myActivityList.appendChild(idleItem);
      return;
    }

    // Show all active activities (most recent first)
    for (const activity of activities) {
      this.myActivityList.appendChild(
        this._createActivityItem(activity)
      );
    }

    this._resizePopupToFitContent();
  }

  private _createActivityItem(activity: Activity): HTMLElement {
    const item = document.createElement('div');
    item.className = 'activity-item-row';
    item.title = activity.content;

    // Favicon with fallback
    const faviconDiv = document.createElement('div');
    faviconDiv.className = 'activity-item-favicon';
    const img = document.createElement('img');
    img.src = this._getFaviconUrl(activity.service);
    img.alt = activity.service;
    img.onerror = () => {
      img.style.display = 'none';
      const fallback = document.createElement('span');
      fallback.textContent = this._getActivityBadge(activity.service);
      faviconDiv.appendChild(fallback);
    };
    faviconDiv.appendChild(img);

    // Content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'activity-content-text';
    contentDiv.textContent = this._truncateActivityContent(activity.content);

    item.appendChild(faviconDiv);
    item.appendChild(contentDiv);

    return item;
  }

  private _getFaviconUrl(service: string): string {
    const iconMap: Record<string, string> = {
      netflix: 'icons/netflix.png',
      youtube: 'icons/youtube.png',
      spotify: 'icons/spotify.png',
      twitch: 'icons/twitch.png',
      steam: 'icons/steampowered.png',
    };
    const icon = iconMap[service];
    if (!icon) return '';
    return chrome.runtime.getURL(icon);
  }

  private _getServiceLabel(service: string): string {
    const labels: Record<string, string> = {
      spotify: 'Spotify',
      twitch: 'Twitch',
      youtube: 'YouTube',
      netflix: 'Netflix',
      steam: 'Steam',
    };
    return labels[service] || service;
  }

  private _truncateActivityContent(content: string): string {
    return content.length > 40 ? content.substring(0, 40) + '...' : content;
  }

  private _setupEventListeners(): void {
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        this._showSettingsPanel();
      });
    }

    // Settings panel close button
    const closeBtn = document.getElementById('settings-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this._hideSettingsPanel();
      });
    }

    // Close settings on ESC key
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.settingsPanel && this.settingsPanel.style.display !== 'none') {
        this._hideSettingsPanel();
      }
    });

    // Close settings on click outside
    if (this.settingsPanel) {
      this.settingsPanel.addEventListener('click', (e: Event) => {
        if (e.target === this.settingsPanel) {
          this._hideSettingsPanel();
        }
      });
    }

    // Settings panel refresh button
    const settingsRefreshBtn = document.getElementById('settings-refresh-btn');
    if (settingsRefreshBtn) {
      settingsRefreshBtn.addEventListener('click', () => {
        this._loadSettingsPanel();
      });
    }

    // Settings panel export button
    const exportBtn = document.getElementById('export-settings-popup-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this._exportSettingsPopup());
    }

    // Settings panel import button
    const importBtn = document.getElementById('import-settings-popup-btn');
    if (importBtn) {
      importBtn.addEventListener('click', () => {
        const fileInput = document.getElementById('import-file-popup-input') as HTMLInputElement;
        fileInput?.click();
      });
    }

    // Settings panel import file input
    const importFileInput = document.getElementById('import-file-popup-input') as HTMLInputElement;
    if (importFileInput) {
      importFileInput.addEventListener('change', (e: Event) => {
        const files = (e.target as HTMLInputElement).files;
        if (files && files.length > 0) {
          this._importSettingsPopup(files[0]);
        }
      });
    }

    // Settings panel service toggles
    document.querySelectorAll('input[data-service]').forEach((toggle) => {
      if (toggle.id.endsWith('-popup')) {
        toggle.addEventListener('change', (e: Event) => {
          if (!(e.target instanceof HTMLInputElement)) return;
          const service = e.target.dataset.service;
          if (service) {
            this._toggleService(service, e.target.checked);
          }
        });
      }
    });

    // Settings panel Discord input
    const discordInput = document.getElementById('discord-info-popup') as HTMLInputElement;
    if (discordInput) {
      discordInput.addEventListener('change', () => {
        this._saveSettingsPanel();
      });
    }

    // Settings panel notification checkboxes
    document.querySelectorAll('input[id*="notif-"][id*="-popup"]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        this._saveSettingsPanel();
      });
    });

    // Show inactive friends toggle
    if (this.showInactiveCheckbox) {
      this.showInactiveCheckbox.addEventListener('change', (e: Event) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        this.showInactiveFriends = e.target.checked;
        this.refreshFriends().catch((error) => {
          console.error('[Popup] Toggle refresh failed:', error);
        });
      });
    }

    // Refresh activity button
    const refreshBtn = document.getElementById('refresh-activity-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this._loadMyActivity());
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

  private _showSettingsPanel(): void {
    if (this.settingsPanel) {
      this.settingsPanel.style.display = 'flex';
      // Resize popup to fit settings content
      this._resizePopupToFitSettings();
    }
  }

  private async _hideSettingsPanel(): Promise<void> {
    await this._saveSettingsPanel();
    if (this.settingsPanel) {
      this.settingsPanel.style.display = 'none';
      // Resize popup back to fit main content
      this._resizePopupToFitContent();
    }
  }

  private _resizePopupToFitSettings(): void {
    const body = document.body;
    const settingsContent = document.querySelector('.settings-panel-content');

    if (settingsContent) {
      // Measure the settings content height
      const contentHeight = settingsContent.scrollHeight;
      // Add padding from settings-panel-content
      const computedStyle = window.getComputedStyle(settingsContent);
      const padding = parseFloat(computedStyle.paddingTop) + parseFloat(computedStyle.paddingBottom);

      // Add header height (settings-panel-header)
      const header = document.querySelector('.settings-panel-header');
      const headerHeight = header ? header.clientHeight : 40;

      const totalHeight = headerHeight + contentHeight + padding + 20; // 20px buffer
      body.style.minHeight = totalHeight + 'px';
      console.debug(`[Popup] Resized for settings: ${totalHeight}px`);
    }
  }

  private _resizePopupToFitContent(): void {
    const body = document.body;
    if (this.popupContainer) {
      // Measure the main popup content height
      const contentHeight = this.popupContainer.scrollHeight;
      body.style.minHeight = Math.max(100, contentHeight) + 'px';
      console.debug(`[Popup] Resized for content: ${contentHeight}px`);
    }
  }

  private async _loadSettingsPanel(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });

      if (!response.success || !response.data) return;

      const profile = response.data;

      // Load identifier
      const idDisplay = document.getElementById('user-identifier-popup');
      if (idDisplay) {
        idDisplay.textContent = profile.memorable_identifier;
      }

      // Load Discord info
      const discordInput = document.getElementById('discord-info-popup') as HTMLInputElement;
      if (discordInput && profile.discord_info) {
        discordInput.value = profile.discord_info;
      }

      // Load service toggles
      const services = ['netflix', 'youtube', 'spotify', 'twitch', 'steam'];
      for (const service of services) {
        const toggle = document.getElementById(`service-${service}-popup`) as HTMLInputElement;
        if (toggle && profile.services_enabled) {
          toggle.checked = profile.services_enabled[service as keyof typeof profile.services_enabled] ?? false;
        }
      }

      // Load Steam ID
      const steamInput = document.getElementById('steam-id-popup-input') as HTMLInputElement;
      console.debug('[Popup] Profile steam_id:', profile.steam_id);
      if (steamInput && profile.steam_id) {
        steamInput.value = profile.steam_id;
      }

      // Load notification preferences
      const notifFriendOnline = document.getElementById('notif-friend-online-popup') as HTMLInputElement;
      if (notifFriendOnline && profile.notification_preferences) {
        notifFriendOnline.checked = profile.notification_preferences.friend_online ?? true;
      }

      const notifNewMessage = document.getElementById('notif-new-message-popup') as HTMLInputElement;
      if (notifNewMessage && profile.notification_preferences) {
        notifNewMessage.checked = profile.notification_preferences.new_message ?? true;
      }

      const notifJoinSuggestion = document.getElementById('notif-join-suggestion-popup') as HTMLInputElement;
      if (notifJoinSuggestion && profile.notification_preferences) {
        notifJoinSuggestion.checked = profile.notification_preferences.join_suggestion ?? false;
      }

      // Load OAuth status
      await this._loadOAuthStatusInPanel();

      // Load browser activity status
      await this._loadBrowserStatusInPanel();

      // Add event listeners for settings panel
      this._setupSettingsPanelListeners();
    } catch (error) {
      console.error('[Popup] Failed to load settings panel:', error);
    }
  }

  private async _loadOAuthStatusInPanel(): Promise<void> {
    const oauthServices = ['spotify', 'twitch'];
    for (const service of oauthServices) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service },
        });

        const container = document.getElementById(`${service}-auth-popup-container`);
        if (!container) continue;

        container.innerHTML = '';
        const hasToken = response.success && response.data?.hasToken;
        const statusText = hasToken ? 'Reconnect' : 'Connect';

        const connectBtn = document.createElement('button');
        connectBtn.className = 'btn-oauth';
        connectBtn.textContent = statusText;
        connectBtn.addEventListener('click', () => this._authenticateServicePopup(service));
        container.appendChild(connectBtn);

        if (hasToken) {
          const disconnectBtn = document.createElement('button');
          disconnectBtn.className = 'btn-oauth-secondary';
          disconnectBtn.textContent = 'Disconnect';
          disconnectBtn.addEventListener('click', () => this._disconnectServicePopup(service));
          container.appendChild(disconnectBtn);
        }

        const statusDiv = document.getElementById(`status-${service}-popup`);
        if (statusDiv) {
          statusDiv.textContent = hasToken ? 'Connected' : 'Not Connected';
        }
      } catch (error) {
        console.error(`[Popup] Failed to load ${service} status:`, error);
      }
    }
  }

  private async _loadBrowserStatusInPanel(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_BROWSER_ACTIVITIES',
      });

      const browserActivities = response.success && response.data ? response.data : { netflix: null, youtube: null };

      for (const service of ['netflix', 'youtube']) {
        const statusDiv = document.getElementById(`status-${service}-popup`);
        if (statusDiv) {
          const activity = browserActivities[service as keyof typeof browserActivities];
          if (activity && activity.service !== 'idle') {
            statusDiv.textContent = this._truncateActivityContent(activity.content);
          } else {
            statusDiv.textContent = 'Idle';
          }
        }
      }
    } catch (error) {
      console.error('[Popup] Failed to load browser status:', error);
    }
  }

  private _setupSettingsPanelListeners(): void {
    // Copy identifier button
    const copyBtn = document.getElementById('copy-id-popup-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const text = document.getElementById('user-identifier-popup')?.textContent || '';
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            const originalText = copyBtn.textContent;
            copyBtn.textContent = '✓';
            setTimeout(() => {
              copyBtn.textContent = originalText;
            }, 2000);
          });
        }
      });
    }

    // Steam verify button
    const steamVerifyBtn = document.getElementById('steam-verify-popup-btn');
    if (steamVerifyBtn) {
      steamVerifyBtn.addEventListener('click', () => this._verifySteamIdPopup());
    }

    // Theme selector
    document.querySelectorAll('input[name="theme-popup"]').forEach((radio) => {
      radio.addEventListener('change', (e: Event) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        const theme = e.target.value;
        this._setTheme(theme);
      });
    });

    // Discord and Steam input changes
    const discordInput = document.getElementById('discord-info-popup') as HTMLInputElement;
    const steamInput = document.getElementById('steam-id-popup-input') as HTMLInputElement;

    if (discordInput) {
      discordInput.addEventListener('change', () => this._saveSettingsPanel());
    }
    if (steamInput) {
      steamInput.addEventListener('change', () => this._saveSettingsPanel());
    }

    // Notification checkboxes
    document.querySelectorAll('input[id*="notif-"][id*="-popup"]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => this._saveSettingsPanel());
    });
  }

  private async _authenticateServicePopup(service: string): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'AUTHENTICATE_SERVICE',
        data: { service },
      });

      if (response.success && response.data?.authUrl) {
        const authWindow = window.open(response.data.authUrl, 'auth', 'width=500,height=600');

        const checkInterval = setInterval(() => {
          if (authWindow?.closed) {
            clearInterval(checkInterval);
            setTimeout(() => this._loadOAuthStatusInPanel(), 500);
          }
        }, 500);
      }
    } catch (error) {
      console.error('[Popup] Authentication failed:', error);
    }
  }

  private async _disconnectServicePopup(service: string): Promise<void> {
    if (!confirm(`Disconnect from ${service}?`)) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'DISCONNECT_SERVICE',
        data: { service },
      });

      if (response.success) {
        await this._loadOAuthStatusInPanel();
      }
    } catch (error) {
      console.error('[Popup] Disconnect failed:', error);
    }
  }

  private async _verifySteamIdPopup(): Promise<void> {
    const steamInput = document.getElementById('steam-id-popup-input') as HTMLInputElement;
    if (!steamInput || !steamInput.value.trim()) {
      alert('Please enter a Steam ID');
      return;
    }

    const steamId = steamInput.value.trim();
    if (!/^\d+$/.test(steamId)) {
      alert('Steam ID must be numeric');
      return;
    }

    alert('Steam ID verified');
    await this._saveSettingsPanel();
  }

  private _setTheme(theme: string): void {
    localStorage.setItem('hang-time-theme', theme);
    const root = document.documentElement;
    if (theme === 'auto') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }

  private async _saveSettingsPanel(): Promise<void> {
    try {
      const discordInput = (document.getElementById('discord-info-popup') as HTMLInputElement)?.value || '';
      const steamIdInput = (document.getElementById('steam-id-popup-input') as HTMLInputElement)?.value || '';

      console.debug('[Popup] Saving settings - discord:', discordInput, 'steam_id:', steamIdInput);

      // Collect service toggles
      const servicesEnabled: Record<string, boolean> = {};
      const services = ['netflix', 'youtube', 'spotify', 'twitch', 'steam'];
      for (const service of services) {
        const toggle = document.getElementById(`service-${service}-popup`) as HTMLInputElement;
        servicesEnabled[service] = toggle?.checked ?? false;
      }

      // Collect notification preferences
      const notifFriendOnline = (document.getElementById('notif-friend-online-popup') as HTMLInputElement)?.checked ?? true;
      const notifNewMessage = (document.getElementById('notif-new-message-popup') as HTMLInputElement)?.checked ?? true;
      const notifJoinSuggestion = (document.getElementById('notif-join-suggestion-popup') as HTMLInputElement)?.checked ?? false;

      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        data: {
          discord_info: discordInput,
          steam_id: steamIdInput,
          services_enabled: servicesEnabled,
          notification_preferences: {
            friend_online: notifFriendOnline,
            new_message: notifNewMessage,
            join_suggestion: notifJoinSuggestion,
          },
        },
      });

      console.debug('[Popup] Settings saved');
    } catch (error) {
      console.error('[Popup] Failed to save settings:', error);
    }
  }

  private async _toggleService(service: string, enabled: boolean): Promise<void> {
    try {
      await chrome.runtime.sendMessage({
        type: 'TOGGLE_SERVICE',
        data: { service, enabled },
      });
    } catch (error) {
      console.error('[Popup] Failed to toggle service:', error);
    }
  }

  private async _exportSettingsPopup(): Promise<void> {
    try {
      const profileResponse = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });

      const friendsResponse = await chrome.runtime.sendMessage({
        type: 'GET_ALL_FRIENDS',
      });

      if (profileResponse.success && profileResponse.data) {
        const settings = {
          version: '1.0',
          exported_at: new Date().toISOString(),
          profile: profileResponse.data,
          friends: friendsResponse.success ? friendsResponse.data : [],
        };

        const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `hang-time-settings-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(url);

        console.debug('[Popup] Settings exported (including friends list)');
      }
    } catch (error) {
      console.error('[Popup] Export failed:', error);
      alert('Failed to export settings');
    }
  }

  private async _importSettingsPopup(file: File): Promise<void> {
    try {
      const text = await file.text();
      const backup = JSON.parse(text);

      if (!backup.data || !backup.data.identifier) {
        alert('Invalid backup file');
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: 'RESTORE_SETTINGS',
        data: backup,
      });

      if (response.success) {
        alert('Settings imported successfully');
        await this._loadSettingsPanel();
      } else {
        alert('Failed to import settings');
      }
    } catch (error) {
      console.error('[Popup] Import failed:', error);
      alert('Failed to parse settings file');
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
