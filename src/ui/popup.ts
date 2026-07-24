/**
 * Hang Time - Popup UI Controller
 * Main extension popup showing active friends
 */

import { Friend, Activity, ExtensionResponse } from '../types';

export class PopupController {
  private friendsList: HTMLElement | null = null;
  private noFriendsPlaceholder: HTMLElement | null = null;
  private myActivityInterval: NodeJS.Timeout | null = null; // My Activity only (3 sec)
  private fallbackFriendsInterval: NodeJS.Timeout | null = null; // Fallback poll for friends (30 sec)
  private addFriendForm: HTMLElement | null = null;
  private friendIdentifierInput: HTMLInputElement | null = null;
  private friendNicknameInput: HTMLInputElement | null = null;
  private settingsPanel: HTMLElement | null = null;
  private popupContainer: HTMLElement | null = null;
  private userIdentifier: string | null = null;
  private userActivities: Activity[] = [];
  private expandedFriendsState: Map<string, boolean> = new Map();
  private serviceIntegrationEnabled: Map<string, boolean> = new Map();
  private currentServiceActivities: Map<string, Activity | null> = new Map();
  private refreshPaused: boolean = false;

  static readonly MY_ACTIVITY_REFRESH_MS = 3000; // Keep "My Activity" responsive
  static readonly FALLBACK_FRIENDS_REFRESH_MS = 30000; // Safety net for missed Nostr messages

  async init(): Promise<void> {
    console.debug('[Popup] Initializing...');

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

    this._setupEventListeners();
    this._setupMessageListener();
    await this._loadMyActivity();
    await this.refreshFriends();
    await this._loadSettingsPanel();

    // Auto-refresh "My Activity" only (every 3 seconds)
    // Friends refresh only on Nostr notifications or fallback poll
    this.myActivityInterval = setInterval(() => {
      if (!this.refreshPaused) {
        this._loadMyActivity().catch((error) => {
          console.error('[Popup] Activity refresh failed:', error);
        });
      }
    }, PopupController.MY_ACTIVITY_REFRESH_MS);

    // Fallback poll for friends in case Nostr messages are missed (every 30 seconds)
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
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_ALL_FRIENDS',
      });

      console.debug('[Popup] GET_ALL_FRIENDS response:', response);

      if (!response.success || !Array.isArray(response.data)) {
        this._showError(`Failed to load friends: ${response.error || 'Unknown error'}`);
        return;
      }

      const friends = response.data as Friend[];
      console.debug(`[Popup] Got ${friends.length} friends:`, friends);
      this._renderFriends(friends);
    } catch (error) {
      console.error('[Popup] Refresh error:', error);
      this._showError('Failed to load friends');
    }
  }

  private async _renderFriends(friends: Friend[]): Promise<void> {
    // Don't resize if settings panel is open
    const shouldResize = !this.settingsPanel || this.settingsPanel.style.display === 'none';

    // Create a map of existing friend elements by ID for targeted updates
    const existingElements = new Map<string, HTMLElement>();
    this.friendsList!.querySelectorAll('[data-friend-id]').forEach((el) => {
      const friendId = (el as HTMLElement).dataset.friendId;
      if (friendId) {
        existingElements.set(friendId, el as HTMLElement);
      }
    });

    // Handle "My Activity" (self)
    let selfElement = existingElements.get('self');
    const selfExpanded = this.expandedFriendsState.get('self') ?? true;
    if (!selfElement) {
      // Create new self element
      selfElement = this._createFriendItem('self', 'My Activity', this.userActivities, selfExpanded);
      selfElement.classList.add('user-item');
      selfElement.setAttribute('data-friend-id', 'self');
      this.friendsList!.insertBefore(selfElement, this.friendsList!.firstChild);
    } else {
      // Update self element in place
      this._updateFriendItem(selfElement, 'self', 'My Activity', this.userActivities, selfExpanded);
    }
    selfElement.classList.toggle('expanded', selfExpanded);

    // Show "no friends" placeholder
    if (!friends || friends.length === 0) {
      this.noFriendsPlaceholder!.style.display = 'block';
    } else {
      this.noFriendsPlaceholder!.style.display = 'none';

      // Update existing friends and add new ones
      for (const friend of friends) {
        const isExpanded = this.expandedFriendsState.get(friend.id) ?? true;
        const activities = Object.values(friend.current_activities || {});

        let friendElement = existingElements.get(friend.id);
        if (!friendElement) {
          // Create new friend element
          friendElement = this._createFriendItem(friend.id, friend.local_name, activities, isExpanded);
          friendElement.setAttribute('data-friend-id', friend.id);
          this.friendsList!.appendChild(friendElement);
        } else {
          // Update existing friend element in place
          this._updateFriendItem(friendElement, friend.id, friend.local_name, activities, isExpanded);
        }

        const isIdle = Object.keys(friend.current_activities || {}).length === 0;
        friendElement.classList.toggle('idle', isIdle);
        friendElement.classList.toggle('expanded', isExpanded);
      }

      // Remove friends that are no longer displayed
      existingElements.forEach((element, friendId) => {
        if (friendId !== 'self' && !friends.find((f) => f.id === friendId)) {
          element.remove();
        }
      });
    }

    if (shouldResize) {
      this._resizePopupToFitContent();
    }
  }

  private _updateFriendItem(
    element: HTMLElement,
    friendId: string,
    name: string,
    activities: Activity[],
    isExpanded: boolean
  ): void {
    // Update the activities container only if content changed
    const activitiesContainer = element.querySelector('.friend-activities') as HTMLElement;
    if (activitiesContainer) {
      // Update activities in place
      const oldActivities = activitiesContainer.querySelectorAll('.activity-item-wrapper');
      const newActivityIds = activities.map((a) => a.id || '');

      // Remove old activities not in new list
      oldActivities.forEach((el) => {
        const activityId = (el as HTMLElement).dataset.activityId;
        if (!newActivityIds.includes(activityId)) {
          el.remove();
        }
      });

      // Add new activities and reload messages for all existing activities
      const existingActivityIds = Array.from(oldActivities).map((el) => (el as HTMLElement).dataset.activityId);
      for (const activity of activities) {
        const activityId = activity.id || '';
        if (!existingActivityIds.includes(activityId)) {
          const activityWrapper = this._createActivityItemWithMessages(activity, friendId);
          activitiesContainer.appendChild(activityWrapper);
        } else {
          // Even for existing activities, reload messages in case new ones arrived
          const existingWrapper = Array.from(oldActivities).find(
            (el) => (el as HTMLElement).dataset.activityId === activityId
          ) as HTMLElement | undefined;
          if (existingWrapper && activity.id && friendId) {
            const messageList = existingWrapper.querySelector('.activity-message-list') as HTMLElement;
            const messageContainer = existingWrapper.querySelector('.activity-message-container') as HTMLElement;
            if (messageList && messageContainer) {
              this._loadActivityMessages(friendId, activity.id, messageList, messageContainer);
            }
          }
        }
      }

      // Handle idle state
      if (activities.length === 0) {
        if (!activitiesContainer.querySelector('.activity-row')) {
          const idleRow = document.createElement('div');
          idleRow.className = 'activity-row';
          idleRow.textContent = 'Idle';
          activitiesContainer.appendChild(idleRow);
        }
      } else {
        const idleRow = activitiesContainer.querySelector('.activity-row');
        if (idleRow && idleRow.textContent === 'Idle') {
          idleRow.remove();
        }
      }
    }
  }

  private _createFriendItem(id: string, name: string, activities: Activity[], isExpanded: boolean): HTMLElement {
    const item = document.createElement('div');
    item.className = 'friend-item';
    item.dataset.friendId = id;

    const isInactive = activities.length === 0;
    const statusText = isInactive ? 'Inactive' : 'Active';

    // Header with caret
    const header = document.createElement('div');
    header.className = 'friend-header';

    const caret = document.createElement('span');
    caret.className = 'friend-caret';
    caret.textContent = isExpanded ? '▼' : '▶';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'friend-name';
    nameSpan.textContent = this._escapeHtml(name);

    const statusSpan = document.createElement('span');
    statusSpan.className = 'friend-status';
    statusSpan.textContent = statusText;

    header.appendChild(caret);
    header.appendChild(nameSpan);
    header.appendChild(statusSpan);
    item.appendChild(header);

    // Activities list (collapsed by default, except for user)
    const activitiesContainer = document.createElement('div');
    activitiesContainer.className = 'friend-activities';
    activitiesContainer.style.display = isExpanded ? 'block' : 'none';

    if (activities.length === 0) {
      const idleRow = document.createElement('div');
      idleRow.className = 'activity-row';
      idleRow.textContent = 'Idle';
      activitiesContainer.appendChild(idleRow);
    } else {
      for (const activity of activities) {
        const activityWrapper = this._createActivityItemWithMessages(activity, id);
        activitiesContainer.appendChild(activityWrapper);
      }
    }

    item.appendChild(activitiesContainer);

    // Toggle expand/collapse on header click (independent for each friend)
    header.addEventListener('click', () => {
      const isCurrentlyExpanded = activitiesContainer.style.display !== 'none';
      if (isCurrentlyExpanded) {
        activitiesContainer.style.display = 'none';
        caret.textContent = '▶';
        item.classList.remove('expanded');
        this.expandedFriendsState.set(id, false);
      } else {
        activitiesContainer.style.display = 'block';
        caret.textContent = '▼';
        item.classList.add('expanded');
        this.expandedFriendsState.set(id, true);
      }
      // Only resize if settings panel is not open
      if (!this.settingsPanel || this.settingsPanel.style.display === 'none') {
        this._resizePopupToFitContent();
      }
    });

    return item;
  }

  /**
   * Create activity item wrapper with row + message container
   */
  private _createActivityItemWithMessages(activity: Activity, friendId?: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'activity-item-wrapper';
    wrapper.dataset.activityId = activity.id || '';
    console.debug('[Popup] Creating activity item with ID:', activity.id, 'service:', activity.service, 'friend:', friendId);

    // Activity row (with favicon, content, buttons)
    const row = this._createActivityRow(activity, friendId);
    wrapper.appendChild(row);

    // Message container (scrollable messages + reply field)
    // Only show if there are messages or user clicks message button
    const messageContainer = document.createElement('div');
    messageContainer.className = 'activity-message-container';
    messageContainer.style.display = 'none'; // Hidden by default

    // Messages list
    const messageList = document.createElement('div');
    messageList.className = 'activity-message-list';
    messageContainer.appendChild(messageList);

    // Reply field (only show for friends' activities, not for own)
    if (friendId && friendId !== 'self') {
      const replyField = document.createElement('input');
      replyField.className = 'activity-message-input';
      replyField.type = 'text';
      replyField.placeholder = 'Reply...';
      replyField.addEventListener('keypress', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && replyField.value.trim()) {
          this._sendActivityMessage(activity, friendId, replyField.value.trim());
          replyField.value = '';
          // Resume refresh after a short delay so message can be loaded and displayed
          setTimeout(() => {
            this.refreshPaused = false;
          }, 1500);
        }
      });
      messageContainer.appendChild(replyField);
    }

    wrapper.appendChild(messageContainer);

    // Load messages for this activity from the friend
    // If messages exist, show the container
    if (friendId && friendId !== 'self' && activity.id) {
      this._loadActivityMessages(friendId, activity.id, messageList, messageContainer);
    }

    return wrapper;
  }

  /**
   * Load and render messages for an activity
   * Shows the message container if messages exist
   */
  private async _loadActivityMessages(
    friendId: string,
    activityId: string,
    messageListElement: HTMLElement,
    messageContainer: HTMLElement
  ): Promise<void> {
    try {
      console.debug('[Popup] Loading messages for activity:', activityId, 'friend:', friendId);
      // Load messages from storage
      const messagesResponse = await chrome.runtime.sendMessage({
        type: 'GET_ACTIVITY_MESSAGES',
        data: { friendId, activityId },
      });

      console.debug('[Popup] Messages response:', messagesResponse);
      if (messagesResponse.success && messagesResponse.data?.length > 0) {
        console.debug('[Popup] Found', messagesResponse.data.length, 'messages for activity', activityId);
        // Render messages
        for (const message of messagesResponse.data) {
          this._renderMessage(messageListElement, message);
        }
        // Show container if there are messages
        messageContainer.style.display = 'block';
      } else {
        console.debug('[Popup] No messages found for activity:', activityId);
      }
    } catch (error) {
      console.error('[Popup] Error loading messages:', error);
    }
  }

  /**
   * Render a single message in the message list
   */
  private _renderMessage(messageListElement: HTMLElement, message: any): void {
    const msgEl = document.createElement('div');
    msgEl.className = `activity-message ${message.type}`;

    // Format message text based on type
    if (message.type === 'invite') {
      msgEl.textContent = `${message.sender_identifier} invited you to join`;
    } else if (message.type === 'join_accepted') {
      msgEl.textContent = `${message.sender_identifier} joined ✓`;
    } else if (message.type === 'join_declined') {
      msgEl.textContent = `${message.sender_identifier} declined`;
    } else if (message.type === 'chat') {
      msgEl.textContent = `${message.sender_identifier}: ${message.content}`;
    }

    messageListElement.appendChild(msgEl);
  }

  private _createActivityRow(activity: Activity, friendId?: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'activity-item-row';

    // State indicator (on the left) - FIRST
    if (activity.state) {
      const stateIcon = document.createElement('span');
      stateIcon.className = `activity-state-icon activity-state-${activity.state}`;
      stateIcon.textContent = activity.state === 'playing' ? '▶' : '⏸';
      stateIcon.title = activity.state === 'playing' ? 'Playing' : 'Paused';
      row.appendChild(stateIcon);

      // Pipe separator
      const separator = document.createElement('span');
      separator.className = 'activity-separator';
      separator.textContent = ' | ';
      row.appendChild(separator);
    }

    // Favicon (service icon) - SECOND
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
    row.appendChild(faviconDiv);

    // Content text - THIRD
    const contentText = document.createElement('span');
    contentText.className = 'activity-content-text';
    contentText.textContent = this._truncateActivityContent(activity.content);
    row.appendChild(contentText);

    // Action buttons container
    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'activity-actions';

    const isSelfActivity = friendId === 'self';

    // First button - Join/Invite
    const firstBtn = document.createElement('button');
    firstBtn.className = 'activity-action-btn activity-action-join';
    firstBtn.textContent = isSelfActivity ? '📤' : '▶';
    firstBtn.title = isSelfActivity ? 'Invite friends' : 'Join activity';
    firstBtn.addEventListener('click', () => {
      if (isSelfActivity) {
        this._inviteToActivity(activity);
      } else {
        this._joinActivity(activity, friendId);
      }
    });
    buttonsDiv.appendChild(firstBtn);

    // Message button
    const msgBtn = document.createElement('button');
    msgBtn.className = 'activity-action-btn activity-action-message';
    msgBtn.textContent = '💬';
    msgBtn.title = 'Send message';
    msgBtn.addEventListener('click', () => {
      // Toggle message container visibility
      const wrapper = row.closest('.activity-item-wrapper');
      if (wrapper) {
        const messageContainer = wrapper.querySelector('.activity-message-container') as HTMLElement;
        if (messageContainer) {
          const isShowing = messageContainer.style.display === 'none';
          messageContainer.style.display = isShowing ? 'block' : 'none';
          // Pause refresh while message box is open
          this.refreshPaused = isShowing;
          // Focus the input if showing
          if (isShowing) {
            const input = messageContainer.querySelector('.activity-message-input') as HTMLInputElement;
            if (input) input.focus();
            // Reload messages when opening
            if (friendId && activity.id) {
              const messageList = messageContainer.querySelector('.activity-message-list') as HTMLElement;
              if (messageList) {
                this._loadActivityMessages(friendId, activity.id, messageList, messageContainer);
              }
            }
          }
        }
      }
    });
    buttonsDiv.appendChild(msgBtn);

    // Sync button (video/music only)
    if (['youtube', 'netflix', 'spotify'].includes(activity.service)) {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'activity-action-btn activity-action-sync';
      syncBtn.textContent = '🕐';
      syncBtn.title = 'Sync playback';
      syncBtn.addEventListener('click', () => this._syncActivity(activity, friendId));
      buttonsDiv.appendChild(syncBtn);
    }

    row.appendChild(buttonsDiv);

    return row;
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
    const activities = Object.values(friend.current_activities || {});
    const activity = activities[0];
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

  private _showMessageModal(friend: Friend, messages: any[], activity?: Activity): void {
    const modal = document.createElement('div');
    modal.className = 'message-modal';
    const headerText = activity ? `${this._escapeHtml(friend.local_name)} (${activity.service})` : this._escapeHtml(friend.local_name);
    modal.innerHTML = `
      <div class="message-modal-content">
        <div class="message-modal-header">
          <span>${headerText}</span>
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
      this.userIdentifier = identifier;

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
    this.userActivities = activities;
    // Only resize if settings panel is not open
    if (!this.settingsPanel || this.settingsPanel.style.display === 'none') {
      this._resizePopupToFitContent();
    }
  }

  private _createActivityItem(activity: Activity): HTMLElement {
    const item = document.createElement('div');
    item.className = 'activity-item-row';
    item.title = activity.content;

    // State indicator (on the left) - FIRST
    if (activity.state) {
      const stateIcon = document.createElement('span');
      stateIcon.className = `activity-state-icon activity-state-${activity.state}`;
      stateIcon.textContent = activity.state === 'playing' ? '▶' : '⏸';
      stateIcon.title = activity.state === 'playing' ? 'Playing' : 'Paused';
      item.appendChild(stateIcon);

      // Pipe separator
      const separator = document.createElement('span');
      separator.className = 'activity-separator';
      separator.textContent = ' | ';
      item.appendChild(separator);
    }

    // Favicon with fallback - SECOND
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
    item.appendChild(faviconDiv);

    // Content text - THIRD
    const contentText = document.createElement('span');
    contentText.className = 'activity-content-text';
    contentText.textContent = this._truncateActivityContent(activity.content);
    item.appendChild(contentText);

    // Action buttons container
    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'activity-actions';

    // Join button
    const joinBtn = document.createElement('button');
    joinBtn.className = 'activity-action-btn activity-action-join';
    joinBtn.textContent = '▶';
    joinBtn.title = 'Join activity';
    joinBtn.addEventListener('click', () => this._joinActivity(activity));
    buttonsDiv.appendChild(joinBtn);

    // Message button
    const msgBtn = document.createElement('button');
    msgBtn.className = 'activity-action-btn activity-action-message';
    msgBtn.textContent = '💬';
    msgBtn.title = 'Send message';
    msgBtn.addEventListener('click', () => {
      // Toggle message container visibility
      const wrapper = item.closest('.activity-item-wrapper');
      if (wrapper) {
        const messageContainer = wrapper.querySelector('.activity-message-container') as HTMLElement;
        if (messageContainer) {
          messageContainer.style.display = messageContainer.style.display === 'none' ? 'block' : 'none';
          // Focus the input if showing
          if (messageContainer.style.display === 'block') {
            const input = messageContainer.querySelector('.activity-message-input') as HTMLInputElement;
            if (input) input.focus();
          }
        }
      }
      this._openMessageForActivity(activity, friendId);
    });
    buttonsDiv.appendChild(msgBtn);

    // Sync button (video/music only)
    if (['youtube', 'netflix', 'spotify'].includes(activity.service)) {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'activity-action-btn activity-action-sync';
      syncBtn.textContent = '🕐';
      syncBtn.title = 'Sync playback';
      syncBtn.addEventListener('click', () => this._syncActivity(activity));
      buttonsDiv.appendChild(syncBtn);
    }

    item.appendChild(buttonsDiv);

    return item;
  }

  private _getFaviconUrl(service: string): string {
    const iconMap: Record<string, string> = {
      netflix: 'public/icons/netflix.png',
      youtube: 'public/icons/youtube.png',
      spotify: 'public/icons/spotify.png',
      twitch: 'public/icons/twitch.png',
      steam: 'public/icons/steam.png',
      discord: 'public/icons/discord.png',
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

  private _setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'NEW_MESSAGE') {
        const { message: msg, friendId, activityId } = message.data;
        // Update message list if the activity container is visible
        if (activityId) {
          const wrapper = document.querySelector(`[data-activity-id="${activityId}"]`) as HTMLElement;
          if (wrapper) {
            const messageList = wrapper.querySelector('.activity-message-list') as HTMLElement;
            if (messageList) {
              this._renderMessage(messageList, msg);
              // Show message container if it's not already
              const messageContainer = wrapper.querySelector('.activity-message-container') as HTMLElement;
              if (messageContainer && messageContainer.style.display === 'none') {
                messageContainer.style.display = 'block';
              }
            }
          }
        }
      } else if (message.type === 'FRIEND_ACTIVITY_CHANGED') {
        // Friend's activities changed - refresh immediately
        this.refreshFriends().catch((error) => {
          console.error('[Popup] Failed to refresh friends after activity change:', error);
        });
      }
    });
  }

  private _setupEventListeners(): void {
    // Manual refresh button
    const refreshBtn = document.getElementById('refresh-friends-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.refreshFriends().catch((error) => {
          console.error('[Popup] Manual refresh failed:', error);
        });
      });
    }

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


    // Copy ID button (in settings panel)
    const copyIdBtn = document.getElementById('copy-id-popup-btn');
    if (copyIdBtn) {
      copyIdBtn.addEventListener('click', () => this._handleCopyId());
    }

    // Add friend button from empty state
    const addFriendBtnEmpty = document.getElementById('add-friend-btn-empty');
    if (addFriendBtnEmpty) {
      addFriendBtnEmpty.addEventListener('click', () => this._showAddFriendForm());
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

      // Load Steam ID and initialize state
      const steamInput = document.getElementById('steam-id-popup-input') as HTMLInputElement;
      const steamEditBtn = document.getElementById('steam-edit-popup-btn');
      const steamVerifyBtn = document.getElementById('steam-verify-popup-btn');

      console.debug('[Popup] Profile steam_id:', profile.steam_id);
      if (steamInput) {
        if (profile.steam_id) {
          steamInput.value = profile.steam_id;
          steamInput.disabled = true;
          if (steamEditBtn) steamEditBtn.style.display = 'inline-block';
          if (steamVerifyBtn) steamVerifyBtn.style.display = 'none';
        } else {
          steamInput.disabled = false;
          if (steamEditBtn) steamEditBtn.style.display = 'none';
          if (steamVerifyBtn) steamVerifyBtn.style.display = 'inline-block';
        }
      }

      // Load service integration enable/disable state from profile
      const integrationServices = ['spotify', 'twitch', 'steam'];
      for (const service of integrationServices) {
        const isEnabled = profile.services_enabled?.[service as keyof typeof profile.services_enabled] ?? false;
        this.serviceIntegrationEnabled.set(service, isEnabled);
        const enableToggle = document.getElementById(`service-${service}-enabled`) as HTMLInputElement;
        if (enableToggle) {
          enableToggle.checked = isEnabled;
        }
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

      // Update Steam status after loading
      await this._updateServiceStatus('steam');

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
        console.debug(`[Popup] Loading OAuth status for ${service}`);
        const response = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service },
        });

        const container = document.getElementById(`${service}-auth-popup-container`);
        console.debug(`[Popup] Container for ${service}:`, container);
        if (!container) {
          console.warn(`[Popup] No container found for ${service}`);
          continue;
        }

        container.innerHTML = '';
        const hasToken = response.success && response.data?.hasToken;
        const statusText = hasToken ? 'Reconnect' : 'Connect';

        const connectBtn = document.createElement('button');
        connectBtn.className = 'btn-oauth';
        connectBtn.textContent = statusText;
        connectBtn.dataset.service = service;
        console.debug(`[Popup] Created ${service} button:`, connectBtn);

        connectBtn.addEventListener('click', (e) => {
          console.debug(`[Popup] ${service} button clicked!`, e);
          this._authenticateServicePopup(service);
        });

        container.appendChild(connectBtn);
        console.debug(`[Popup] Appended ${service} button to container`);

        if (hasToken) {
          const disconnectBtn = document.createElement('button');
          disconnectBtn.className = 'btn-oauth-secondary';
          disconnectBtn.textContent = 'Disconnect';
          disconnectBtn.addEventListener('click', () => this._disconnectServicePopup(service));
          container.appendChild(disconnectBtn);
        }

        // Update status display (enable toggle already set from profile)
        await this._updateServiceStatus(service);
      } catch (error) {
        console.error(`[Popup] Failed to load ${service} status:`, error);
      }
    }
  }

  private async _loadBrowserStatusInPanel(): Promise<void> {
    try {
      // Get profile for enabled state
      const profileResponse = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });
      const profile = profileResponse.success && profileResponse.data ? profileResponse.data : null;

      const response = await chrome.runtime.sendMessage({
        type: 'GET_BROWSER_ACTIVITIES',
      });

      const browserActivities = response.success && response.data ? response.data : { netflix: null, youtube: null, twitch: null };

      for (const service of ['netflix', 'youtube', 'twitch']) {
        const statusDiv = document.getElementById(`status-${service}-popup`);
        if (statusDiv && profile) {
          const isEnabled = profile.services_enabled?.[service as keyof typeof profile.services_enabled] ?? false;

          if (!isEnabled) {
            statusDiv.textContent = 'Disabled';
          } else {
            const activity = browserActivities[service as keyof typeof browserActivities];
            if (activity) {
              statusDiv.textContent = this._truncateActivityContent(activity.content);
            } else {
              statusDiv.textContent = 'Idle';
            }
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

    // Service integration enable/disable checkboxes
    document.querySelectorAll('input.service-enable-toggle').forEach((toggle) => {
      if (toggle instanceof HTMLInputElement) {
        toggle.addEventListener('change', (e: Event) => {
          const service = toggle.dataset.service;
          if (service) {
            const isEnabled = toggle.checked;
            this.serviceIntegrationEnabled.set(service, isEnabled);
            this._saveSettingsPanel();
            this._updateServiceStatus(service);
          }
        });
      }
    });

    // Browser tab service toggles (Netflix/YouTube)
    document.querySelectorAll('input.service-toggle').forEach((toggle) => {
      if (toggle instanceof HTMLInputElement) {
        toggle.addEventListener('change', () => {
          this._saveSettingsPanel();
          this._loadBrowserStatusInPanel();
        });
      }
    });

    // Steam edit button
    const steamEditBtn = document.getElementById('steam-edit-popup-btn');
    if (steamEditBtn) {
      steamEditBtn.addEventListener('click', () => this._editSteamId());
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
    console.debug(`[Popup] Authenticating ${service}...`);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'AUTHENTICATE_SERVICE',
        data: { service },
      });

      console.debug(`[Popup] Auth response:`, response);

      if (response.success && response.data?.authUrl) {
        console.debug(`[Popup] Opening auth window for ${service}`);
        const authWindow = window.open(response.data.authUrl, `${service}-auth`, 'width=500,height=600');

        if (!authWindow) {
          console.error(`[Popup] Failed to open auth window - popup blocker?`);
          alert('Popup window blocked. Please allow popups for this extension.');
          return;
        }

        const checkInterval = setInterval(() => {
          if (authWindow?.closed) {
            clearInterval(checkInterval);
            console.debug(`[Popup] Auth window closed, reloading status`);
            setTimeout(() => this._loadOAuthStatusInPanel(), 500);
          }
        }, 500);
      } else {
        console.error(`[Popup] Auth failed:`, response.error);
        alert(`Authentication failed: ${response.error}`);
      }
    } catch (error) {
      console.error('[Popup] Authentication failed:', error);
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

    await this._saveSettingsPanel();
    alert('Steam ID verified');

    // Hide verify button, show edit button, disable input
    const steamEditBtn = document.getElementById('steam-edit-popup-btn');
    const steamVerifyBtn = document.getElementById('steam-verify-popup-btn');
    if (steamEditBtn && steamVerifyBtn) {
      steamEditBtn.style.display = 'inline-block';
      steamVerifyBtn.style.display = 'none';
      steamInput.disabled = true;
    }

    // Update status display
    await this._updateServiceStatus('steam');
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

  private async _updateServiceStatus(service: string): Promise<void> {
    const isEnabled = this.serviceIntegrationEnabled.get(service) ?? true;
    const statusDiv = document.getElementById(`status-${service}-popup`);
    console.debug(`[Popup] _updateServiceStatus(${service}) - statusDiv id: status-${service}-popup, found:`, !!statusDiv);
    if (!statusDiv) {
      console.debug(`[Popup] No statusDiv found for ${service}`);
      return;
    }

    // Check if not enabled - show "Disabled"
    if (!isEnabled) {
      statusDiv.textContent = 'Disabled';
      return;
    }

    // Try to get current activity first (works for browser tabs and OAuth services)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_CURRENT_ACTIVITY',
        data: { service },
      });

      if (response.success && response.data) {
        const activity = response.data as Activity;
        statusDiv.textContent = this._truncateActivityContent(activity.content);
        return;
      }
    } catch (error) {
      // Continue to check configuration status
    }

    // No current activity - check if service is configured (for OAuth and Steam)
    let isConfigured = false;
    if (service === 'steam') {
      const steamInput = document.getElementById('steam-id-popup-input') as HTMLInputElement;
      const steamId = steamInput?.value?.trim();
      isConfigured = !!steamId;
      console.debug('[Popup] Checking Steam status - steamId:', steamId, 'configured:', isConfigured);
    } else if (!['netflix', 'youtube', 'twitch'].includes(service)) {
      // For OAuth services (not browser tab services), check if they have a token
      try {
        const authResponse = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service },
        });
        isConfigured = authResponse.success && authResponse.data?.hasToken;
      } catch (error) {
        console.error(`[Popup] Failed to check ${service} OAuth status:`, error);
      }
    }

    // Show appropriate status message
    if (['netflix', 'youtube', 'twitch'].includes(service)) {
      // Browser tab services with no activity just show "No activity"
      statusDiv.textContent = 'No activity';
    } else if (!isConfigured) {
      // OAuth/Steam services with no token show "Not configured"
      statusDiv.textContent = 'Not configured';
    } else {
      statusDiv.textContent = 'No activity';
    }
  }

  private _editSteamId(): void {
    const steamInput = document.getElementById('steam-id-popup-input') as HTMLInputElement;
    const steamEditBtn = document.getElementById('steam-edit-popup-btn');
    const steamVerifyBtn = document.getElementById('steam-verify-popup-btn');

    if (steamInput && steamEditBtn && steamVerifyBtn) {
      steamInput.disabled = false;
      steamInput.focus();
      steamEditBtn.style.display = 'none';
      steamVerifyBtn.style.display = 'inline-block';
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

  private async _joinActivity(activity: Activity, friendId?: string): Promise<void> {
    console.debug('[Popup] Joining activity:', activity.service, 'from friend:', friendId);
    try {
      // Open the activity (service-specific handler)
      await chrome.runtime.sendMessage({
        type: 'JOIN_ACTIVITY',
        data: { activity, friendId },
      });

      // Send join_accepted notification to friend who invited
      if (friendId && friendId !== 'self') {
        await chrome.runtime.sendMessage({
          type: 'SEND_JOIN_NOTIFICATION',
          data: { activity, friendId, accepted: true },
        });
      }
    } catch (error) {
      console.error('[Popup] Failed to join activity:', error);
    }
  }

  private async _inviteToActivity(activity: Activity): Promise<void> {
    console.debug('[Popup] Opening invite dialog for:', activity.service);
    // TODO: Show friend selector modal to invite multiple friends
    // For now, show temporary dialog
    const friendName = prompt('Enter friend name to invite:');
    if (friendName) {
      // Get all friends to find matching one
      try {
        const friendsResponse = await chrome.runtime.sendMessage({
          type: 'GET_ALL_FRIENDS',
        });
        if (friendsResponse.success && friendsResponse.data) {
          const friends = friendsResponse.data as Friend[];
          const friend = friends.find((f) => f.local_name.toLowerCase() === friendName.toLowerCase());
          if (friend) {
            await chrome.runtime.sendMessage({
              type: 'SEND_INVITE',
              data: { activity, friendId: friend.id },
            });
            console.debug('[Popup] Sent invite to:', friendName);
          } else {
            alert('Friend not found');
          }
        }
      } catch (error) {
        console.error('[Popup] Failed to send invite:', error);
      }
    }
  }

  private async _openMessageForActivity(activity: Activity, friendId?: string): Promise<void> {
    console.debug('[Popup] Opening message for activity:', activity.service, 'friend:', friendId);
    try {
      if (friendId && friendId !== 'self') {
        // Just toggle message container visibility (already handled by message button)
        // This is a no-op since the message button already does the toggle
      } else {
        // Self activity - open invite friends modal instead
        this._inviteToActivity(activity);
      }
    } catch (error) {
      console.error('[Popup] Failed to open message:', error);
    }
  }

  private async _syncActivity(activity: Activity, friendId?: string): Promise<void> {
    console.debug('[Popup] Syncing activity:', activity.service, 'friend:', friendId);
    try {
      await chrome.runtime.sendMessage({
        type: 'SYNC_ACTIVITY',
        data: { activity, friendId },
      });
    } catch (error) {
      console.error('[Popup] Failed to sync activity:', error);
    }
  }

  private async _sendActivityMessage(activity: Activity, friendId?: string, content: string): Promise<void> {
    console.debug('[Popup] Sending activity message:', activity.service, 'friend:', friendId, 'content:', content);
    try {
      // Get user identifier first
      const identifierResponse = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });
      const userIdentifier = typeof identifierResponse.data === 'string' ? identifierResponse.data : 'You';
      console.debug('[Popup] User identifier:', userIdentifier, 'type:', typeof userIdentifier);

      // Find the message list for this activity (search by service and content as fallback)
      const messageContainers = document.querySelectorAll('.activity-message-container');
      let targetMessageList: HTMLElement | null = null;

      for (const container of messageContainers) {
        const wrapper = container.closest('.activity-item-wrapper');
        if (wrapper) {
          // Try to match by activity ID first
          if (activity.id && wrapper.dataset.activityId === activity.id) {
            targetMessageList = container.querySelector('.activity-message-list') as HTMLElement;
            break;
          }
          // Fallback: check if this is a message container visible in the UI (the one the user just opened)
          if ((container as HTMLElement).style.display !== 'none') {
            targetMessageList = container.querySelector('.activity-message-list') as HTMLElement;
            // Don't break, keep looking in case we find an exact ID match
          }
        }
      }

      // Optimistically render message if we found the target
      if (targetMessageList) {
        this._renderMessage(targetMessageList, {
          type: 'chat',
          sender_identifier: userIdentifier,
          content,
          is_outbound: true,
        });
      }

      // Send message to background
      await chrome.runtime.sendMessage({
        type: 'SEND_MESSAGE',
        data: { activity, friendId, content },
      });
    } catch (error) {
      console.error('[Popup] Failed to send message:', error);
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
    const idDisplay = document.getElementById('user-identifier-popup');
    if (idDisplay && idDisplay.textContent) {
      navigator.clipboard.writeText(idDisplay.textContent).then(() => {
        console.debug('[Popup] Identifier copied');
        // Visual feedback
        const copyBtn = document.getElementById('copy-id-popup-btn');
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
    if (this.friendsList) {
      this.friendsList.innerHTML = `<div class="error">${this._escapeHtml(message)}</div>`;
      this.friendsList.style.display = 'block';
    }
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

  // Clean up on unload
  window.addEventListener('beforeunload', () => {
    controller.destroy();
  });
});
