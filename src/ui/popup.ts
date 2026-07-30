/**
 * Hang Time - Popup UI Controller
 * Main extension popup showing active friends
 */

import { Friend, Activity, ExtensionResponse, STORAGE_KEYS } from '../types';
import { StorageManager } from '../modules/storage';
import { GameLibraryManager } from '../modules/game-library';
import { MetadataFetcher } from '../modules/metadata-fetcher';
import { DiscoveryTabController } from './discovery';
import { showInviteModal } from './invite-modal-builder';

/**
 * Simple toast notification manager
 */
class ToastManager {
  private container: HTMLElement | null = null;

  init(): void {
    this.container = document.getElementById('toast-container');
  }

  show(message: string, options?: { duration?: number; onClick?: () => void }): void {
    if (!this.container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;

    if (options?.onClick) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', options.onClick);
    }

    this.container.appendChild(toast);

    // Auto-remove after duration
    const duration = options?.duration || 4000;
    setTimeout(() => {
      toast.classList.add('toast-hide');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}

const toastManager = new ToastManager();

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
  private pendingInvitesByActivity: Map<string, string> = new Map(); // activityId -> friendId with pending invite
  private storage: StorageManager = new StorageManager();
  private discoveryTabController: DiscoveryTabController | null = null;

  static readonly MY_ACTIVITY_REFRESH_MS = 3000; // Keep "My Activity" responsive
  static readonly FALLBACK_FRIENDS_REFRESH_MS = 15000; // Safety net for missed Nostr messages

  async init(): Promise<void> {
    console.debug('[Popup] Initializing...');

    // Initialize toast manager
    toastManager.init();

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
    this._setupTabNavigation();
    this._setupDiscoveryController();
    this._setupMessageListener();
    this._setupStorageListener();
    await this._loadPendingInvites();
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
      // Reload pending invites from storage to refresh invite icon state
      await this._loadPendingInvites();

      const response = await chrome.runtime.sendMessage({
        type: 'GET_ALL_ACTIVITIES',
      });

      console.debug('[Popup] GET_ALL_ACTIVITIES response:', response);

      if (!response.success || !response.data) {
        this._showError(`Failed to load friends: ${response.error || 'Unknown error'}`);
        return;
      }

      const friends = response.data.friends || [];
      console.debug(`[Popup] Got ${friends.length} friends:`, friends);
      this._renderFriends(friends);
    } catch (error) {
      console.error('[Popup] Refresh error:', error);
      this._showError('Failed to load friends');
    }
  }

  async refreshAll(): Promise<void> {
    try {
      // Refresh My Activity
      await this._loadMyActivity();

      // Refresh Friends list
      await this.refreshFriends();

      // Refresh game library from Steam
      await chrome.runtime.sendMessage({
        type: 'REFRESH_GAME_LIBRARY',
      }).catch(() => {
        // Silently ignore if not available (non-critical)
      });

      // Refresh Settings if panel is open
      if (this.settingsPanel && this.settingsPanel.style.display !== 'none') {
        await this._loadSettingsPanel();
      }
    } catch (error) {
      console.error('[Popup] Complete refresh failed:', error);
      this._showError('Failed to refresh');
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
    const sortedUserActivities = this._sortActivitiesByType(this.userActivities);
    if (!selfElement) {
      // Create new self element
      selfElement = this._createFriendItem('self', 'My Activity', sortedUserActivities, selfExpanded);
      selfElement.classList.add('user-item');
      selfElement.setAttribute('data-friend-id', 'self');
      this.friendsList!.insertBefore(selfElement, this.friendsList!.firstChild);
    } else {
      // Update self element in place
      this._updateFriendItem(selfElement, 'self', 'My Activity', sortedUserActivities, selfExpanded);
    }
    selfElement.classList.toggle('expanded', selfExpanded);

    // Show "no friends" placeholder
    if (!friends || friends.length === 0) {
      this.noFriendsPlaceholder!.style.display = 'block';
      // Remove all existing friend elements (keep only self)
      existingElements.forEach((element, friendId) => {
        if (friendId !== 'self') {
          element.remove();
        }
      });
    } else {
      this.noFriendsPlaceholder!.style.display = 'none';

      // Update existing friends and add new ones
      for (const friend of friends) {
        const isExpanded = this.expandedFriendsState.get(friend.id) ?? true;
        // Aggressive deduplication: only show one activity per unique ID, prefer newest
        const dedupActivities = this._deduplicateActivities(Object.values(friend.current_activities || {}));
        // Sort by type: videos, streams, games, etc.
        const activities = this._sortActivitiesByType(dedupActivities);

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
          // For existing activities, only update progress bar and state (don't recreate entire row)
          const existingWrapper = Array.from(oldActivities).find(
            (el) => (el as HTMLElement).dataset.activityId === activityId
          ) as HTMLElement | undefined;
          if (existingWrapper && activity.id && friendId) {
            const row = existingWrapper.querySelector('.activity-item-row') as HTMLElement;
            if (row) {
              // Update progress bar CSS variable only
              if (activity.metadata?.progress !== undefined && activity.metadata?.duration && activity.metadata.duration > 0) {
                const progressPercent = Math.min(100, (activity.metadata.progress / activity.metadata.duration) * 100);
                row.style.setProperty('--progress-percent', `${progressPercent}%`);
              }

              // Update state icon and content text if state changed
              const stateIcon = row.querySelector('.activity-state-icon') as HTMLElement;
              const contentText = row.querySelector('.activity-content-text') as HTMLElement;

              if (stateIcon && activity.state) {
                // For Steam games, show controller emoji
                if (activity.service === 'steam-api') {
                  stateIcon.textContent = '🎮';
                  stateIcon.title = 'Playing';
                } else if (activity.state === 'disconnected') {
                  // Content script disconnected: show red exclamation mark
                  stateIcon.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="state-icon-svg">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"></path>
                    </svg>
                  `;
                  stateIcon.title = activity.metadata?.disconnected_reason || 'Disconnected - reload tab';

                  // Update content text to show disconnect message
                  if (contentText) {
                    contentText.textContent = 'Disconnected - reload tab';
                    contentText.style.fontStyle = 'italic';
                    contentText.style.opacity = '0.7';
                  }
                } else {
                  // Check if data is fresh from content script (for browser tabs)
                  const isDataFresh = activity.is_fresh !== false;

                  if (!isDataFresh) {
                    // Stale data: show moon icon in yellow
                    stateIcon.innerHTML = `
                      <svg viewBox="0 0 24 24" fill="none" stroke="#FEF3C7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="state-icon-svg">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                      </svg>
                    `;
                    stateIcon.title = 'Content script unavailable (tab may be backgrounded)';
                  } else if (activity.state === 'playing') {
                    // Fresh playing: green play icon
                    stateIcon.innerHTML = `
                      <svg viewBox="0 0 24 24" fill="#4CAF50" stroke="none" class="state-icon-svg">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                      </svg>
                    `;
                    stateIcon.title = 'Playing';
                  } else {
                    // Fresh paused: gray pause icon
                    stateIcon.innerHTML = `
                      <svg viewBox="0 0 24 24" fill="#9E9E9E" stroke="none" class="state-icon-svg">
                        <rect x="6" y="4" width="4" height="16"></rect>
                        <rect x="14" y="4" width="4" height="16"></rect>
                      </svg>
                    `;
                    stateIcon.title = 'Paused';
                  }

                  // Restore normal content text for non-disconnected states
                  if (contentText) {
                    contentText.textContent = this._truncateActivityContent(activity.content);
                    contentText.style.fontStyle = 'normal';
                    contentText.style.opacity = '1';
                  }
                }
              }
            }

            // Reload messages in case new ones arrived
            const messageList = existingWrapper.querySelector('.activity-message-list') as HTMLElement;
            const messageContainer = existingWrapper.querySelector('.activity-message-container') as HTMLElement;
            if (messageList && messageContainer) {
              messageList.innerHTML = ''; // Clear old messages before reloading
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

    // Buttons container (right-aligned, before status)
    const buttonsContainer = document.createElement('div');
    buttonsContainer.className = 'friend-header-buttons';

    // Only show buttons for actual friends, not for "My Activity" (self)
    if (id !== 'self') {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-friend-action btn-edit-friend';
      editBtn.textContent = '✎';
      editBtn.title = 'Rename friend';
      editBtn.onclick = (e) => {
        e.stopPropagation();
        this._handleEditFriend(id, name);
      };

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-friend-action btn-delete-friend';
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Remove friend';
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        this._handleDeleteFriend(id, name);
      };

      buttonsContainer.appendChild(editBtn);
      buttonsContainer.appendChild(deleteBtn);
    }

    const statusSpan = document.createElement('span');
    statusSpan.className = 'friend-status';
    statusSpan.textContent = statusText;

    header.appendChild(caret);
    header.appendChild(nameSpan);
    header.appendChild(buttonsContainer);
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
    try {
      const row = document.createElement('div');
      row.className = 'activity-item-row';

      // Set progress bar width
      console.debug('[Popup] Activity metadata:', {
        service: activity.service,
        content: activity.content,
        progress: activity.metadata?.progress,
        duration: activity.metadata?.duration,
        hasMetadata: !!activity.metadata,
      });
      if (activity.metadata?.progress !== undefined && activity.metadata?.duration && activity.metadata.duration > 0) {
        const progressPercent = Math.min(100, (activity.metadata.progress / activity.metadata.duration) * 100);
        console.log('[Popup] Setting progress bar:', progressPercent, '%');
        row.style.setProperty('--progress-percent', `${progressPercent}%`);
      }

    // State indicator (on the left) - FIRST
    if (activity.state) {
      const stateIcon = document.createElement('div');
      stateIcon.className = 'activity-state-icon';

      // For Steam games, show controller emoji instead of play/pause states
      if (activity.service === 'steam-api') {
        stateIcon.textContent = '🎮';
        stateIcon.title = 'Playing';
      } else if (activity.state === 'disconnected') {
        // Content script disconnected (e.g., after extension restart): show warning icon
        stateIcon.innerHTML = `
          <svg viewBox="0 0 24 24" fill="#EF4444" stroke="none" class="state-icon-svg">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12" stroke="#FFF" stroke-width="2"></line>
            <line x1="12" y1="16" x2="12.01" y2="16" stroke="#FFF" stroke-width="2"></line>
          </svg>
        `;
        stateIcon.title = activity.metadata?.disconnected_reason || 'Disconnected - reload tab';
      } else {
        // Check if data is fresh from content script (only for browser tabs)
        const isDataFresh = activity.is_fresh !== false; // Default to true if not set

        if (!isDataFresh) {
          // Stale data (content script unresponsive): show moon icon in subtle yellow
          stateIcon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="#FEF3C7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="state-icon-svg">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
            </svg>
          `;
          stateIcon.title = 'Content script unavailable (tab may be backgrounded)';
        } else if (activity.state === 'playing') {
          // Fresh playing: green play icon
          stateIcon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="#4CAF50" stroke="none" class="state-icon-svg">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
          `;
          stateIcon.title = 'Playing';
        } else {
          // Fresh paused: gray pause icon
          stateIcon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="#9E9E9E" stroke="none" class="state-icon-svg">
              <rect x="6" y="4" width="4" height="16"></rect>
              <rect x="14" y="4" width="4" height="16"></rect>
            </svg>
          `;
          stateIcon.title = 'Paused';
        }
      }

      row.appendChild(stateIcon);

      // Pipe separator
      const separator = document.createElement('span');
      separator.className = 'activity-separator';
      separator.textContent = ' | ';
      row.appendChild(separator);
    }

    // Favicon (dynamic from site or service icon) - SECOND
    const faviconDiv = document.createElement('div');
    faviconDiv.className = 'activity-item-favicon';
    const img = document.createElement('img');

    // Prefer dynamic favicon from metadata (for video-tab), fallback to static service icon
    const dynamicFavicon = activity.metadata?.favicon;
    const faviconUrl = dynamicFavicon ?
      (dynamicFavicon.startsWith('http') ? dynamicFavicon : `https:${dynamicFavicon}`) :
      this._getFaviconUrl(activity.service);

    img.src = faviconUrl;
    img.alt = activity.service;
    img.style.borderRadius = '4px'; // Round corners for site favicons
    img.onerror = () => {
      // Fallback to static icon if dynamic favicon fails
      img.src = this._getFaviconUrl(activity.service);
      img.onerror = null; // Prevent infinite loop
    };
    faviconDiv.appendChild(img);
    row.appendChild(faviconDiv);

    // Content text - THIRD
    const contentText = document.createElement('span');
    contentText.className = 'activity-content-text';
    // Show disconnect message if state is disconnected, otherwise show content
    if (activity.state === 'disconnected') {
      contentText.textContent = 'Disconnected - reload tab';
      contentText.style.fontStyle = 'italic';
      contentText.style.opacity = '0.7';
    } else {
      contentText.textContent = this._truncateActivityContent(activity.content);
    }
    row.appendChild(contentText);

    // Action buttons container
    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'activity-actions';

    const isSelfActivity = friendId === 'self';
    const hasPendingInvite = activity.id && this.pendingInvitesByActivity.has(activity.id);
    if (activity.id && !isSelfActivity) {
      console.debug('[Popup] Activity:', activity.service, 'id:', activity.id, 'pending:', hasPendingInvite, 'map:', Array.from(this.pendingInvitesByActivity.keys()));
    }

    // First button - Invite (for self) or Join/Accept (for friends)
    const firstBtn = document.createElement('button');
    firstBtn.className = 'activity-action-btn activity-action-join';

    if (isSelfActivity) {
      // Thin gray envelope for inviting friends
      firstBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="envelope-icon">
        <rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect>
        <path d="M 2 6 L 12 13 L 22 6"></path>
      </svg>`;
      firstBtn.style.color = '#999';
      firstBtn.title = 'Invite friends';
    } else if (hasPendingInvite) {
      // Bold green envelope for accepting invite
      firstBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="envelope-icon">
        <rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect>
        <path d="M 2 6 L 12 13 L 22 6"></path>
      </svg>`;
      firstBtn.style.color = '#4CAF50';
      firstBtn.title = 'Accept or decline invite';
    } else {
      // Play arrow for joining normally
      firstBtn.textContent = '▶';
      firstBtn.title = 'Join activity';
    }

    firstBtn.addEventListener('click', () => {
      const currentHasPending = activity.id ? this.pendingInvitesByActivity.has(activity.id) : false;
      console.debug('[Popup] Button clicked:', {
        service: activity.service,
        activityId: activity.id,
        isSelfActivity,
        hasPendingInvite,
        currentHasPending,
        mapKeys: Array.from(this.pendingInvitesByActivity.keys()),
      });

      if (isSelfActivity) {
        this._inviteToActivity(activity);
      } else if (currentHasPending) {
        console.debug('[Popup] Showing accept invite modal for:', friendId);
        this._showAcceptInviteModal(activity, friendId!);
      } else {
        this._joinActivity(activity, friendId);
      }
    });
    buttonsDiv.appendChild(firstBtn);

    // Separator before action buttons
    const actionSeparator = document.createElement('span');
    actionSeparator.className = 'activity-separator';
    actionSeparator.textContent = ' | ';
    row.appendChild(actionSeparator);

    row.appendChild(buttonsDiv);

      return row;
    } catch (error) {
      console.error('[Popup] Error creating activity row:', error);
      // Return a minimal row so we don't break the UI
      const errorRow = document.createElement('div');
      errorRow.className = 'activity-item-row';
      const errorText = document.createElement('span');
      errorText.textContent = `Error: ${activity.content}`;
      errorRow.appendChild(errorText);
      return errorRow;
    }
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

  private _handleDeleteFriend(friendId: string, friendName: string): void {
    const minimalFriend: Friend = {
      id: friendId,
      identifier: '',
      pubkey: '',
      local_name: friendName,
      added_at: 0,
      last_seen: 0,
      muted: false,
      hidden_services: [],
      current_activities: {},
    };
    this._handleRemoveFriend(minimalFriend);
  }

  private _handleEditFriend(friendId: string, currentName: string): void {
    const newName = prompt('Rename friend:', currentName);
    if (!newName || newName.trim() === '' || newName === currentName) {
      return;
    }

    chrome.runtime.sendMessage({
      type: 'RENAME_FRIEND',
      data: { friendId, newName: newName.trim() },
    }, (response) => {
      if (response?.success) {
        console.debug(`[Popup] Renamed friend to: ${newName}`);
        this.refreshFriends().catch(() => {});
      } else {
        this._showError(response?.error || 'Failed to rename friend');
      }
    });
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

  private async _loadPendingInvites(): Promise<void> {
    try {
      const pendingInvites = await this.storage.getPendingInvites();
      this.pendingInvitesByActivity.clear();
      for (const [activityId, inviteData] of Object.entries(pendingInvites)) {
        this.pendingInvitesByActivity.set(activityId, inviteData.friendId);
      }
      console.debug('[Popup] Loaded pending invites from storage:', Array.from(this.pendingInvitesByActivity.entries()));
    } catch (error) {
      console.error('[Popup] Failed to load pending invites:', error);
    }
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

      // Get all activities from unified storage
      const response = await chrome.runtime.sendMessage({
        type: 'GET_ALL_ACTIVITIES',
      });

      if (!response.success || !response.data) {
        console.error('[Popup] Failed to get all activities');
        return;
      }

      // Extract my activities from the unified storage format
      const myActivitiesMap = response.data.myActivities || {};
      const activities = Object.values(myActivitiesMap).filter((a) => a) as Activity[];
      this._renderMyActivity(activities);
    } catch (error) {
      console.error('[Popup] Failed to load my activity:', error);
    }
  }

  private _renderMyActivity(activities: Activity[]): void {
    // Sort activities: audio_on first, then by most recent accessed
    const sorted = [...activities].sort((a, b) => {
      // Prioritize activities with audio
      const aAudio = a.audio === 'on' ? 1 : 0;
      const bAudio = b.audio === 'on' ? 1 : 0;
      if (aAudio !== bAudio) {
        return bAudio - aAudio; // audio_on (1) comes before audio_off (0)
      }

      // Then sort by most recent (last accessed time)
      const aTime = (a.metadata?.lastAccessed as number) || a.timestamp || 0;
      const bTime = (b.metadata?.lastAccessed as number) || b.timestamp || 0;
      return bTime - aTime;
    });

    console.debug('[Popup] My Activity sorted order:', sorted.map(a => `${a.service}(audio:${a.audio})`).join(' → '));
    this.userActivities = sorted;

    // Re-render the friends list (including "My Activity" section) with updated activities
    // Get current friends to re-render with sorted My Activity
    this.refreshFriends().catch((error) => {
      console.error('[Popup] Failed to re-render after activity update:', error);
    });
  }

  private _createActivityItem(activity: Activity): HTMLElement {
    const item = document.createElement('div');
    item.className = 'activity-item-row';
    item.title = activity.content;

    // State indicator (on the left) - FIRST
    if (activity.state) {
      const audioIcon = document.createElement('span');
      audioIcon.className = `activity-audio-icon activity-audio-${activity.audio}`;
      audioIcon.textContent = activity.audio === 'on' ? '🔊' : '🔇';
      audioIcon.title = activity.audio === 'on' ? 'Audio On' : 'Audio Off';
      item.appendChild(audioIcon);

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
    // Check if we're watching together (same activity ID for same service)
    const myActivityForService = this.userActivities.find(a => a.service === activity.service);
    const isWatchingTogether = myActivityForService && myActivityForService.id === activity.id;

    const joinBtn = document.createElement('button');
    joinBtn.className = 'activity-action-btn activity-action-join';

    if (isWatchingTogether) {
      // Show "watching together" icon (solid play + people)
      joinBtn.innerHTML = `<svg viewBox="0 0 120 140" fill="none" style="width: 20px; height: 20px;">
        <rect x="10" y="10" width="100" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="3"/>
        <circle cx="60" cy="40" r="18" fill="currentColor"/>
        <polygon points="54,33 54,47 73,40" fill="white"/>
        <circle cx="30" cy="88" r="8" fill="currentColor"/>
        <path d="M20 100 Q20 98 22 98 L38 98 Q40 98 40 100 L40 120 L20 120 Z" fill="currentColor"/>
        <circle cx="60" cy="88" r="8" fill="currentColor"/>
        <path d="M50 100 Q50 98 52 98 L68 98 Q70 98 70 100 L70 120 L50 120 Z" fill="currentColor"/>
        <circle cx="90" cy="88" r="8" fill="currentColor"/>
        <path d="M80 100 Q80 98 82 98 L98 98 Q100 98 100 100 L100 120 L80 120 Z" fill="currentColor"/>
      </svg>`;
      joinBtn.title = 'Watching together';
      joinBtn.addEventListener('click', () => {
        // Can still invite more people from your own My Activity
        // This button is just for information, not actionable
        toastManager.show('You\'re already watching together!');
      });
    } else {
      // Show standard join arrow
      joinBtn.textContent = '▶';
      joinBtn.title = 'Join activity';
      joinBtn.addEventListener('click', () => this._joinActivity(activity));
    }

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
    if (['video-tab', 'spotify-api'].includes(activity.service)) {
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
    // Extract base service name from qualified name (e.g., 'spotify-api' -> 'spotify')
    const baseService = service.replace('-api', '').replace('-tab', '');
    const iconMap: Record<string, string> = {
      netflix: 'public/icons/netflix.png',
      youtube: 'public/icons/youtube.png',
      spotify: 'public/icons/spotify.png',
      twitch: 'public/icons/twitch.png',
      steam: 'public/icons/steam.png',
      discord: 'public/icons/discord.png',
    };
    const icon = iconMap[baseService];
    if (!icon) return '';
    return chrome.runtime.getURL(icon);
  }

  private _getServiceLabel(service: string): string {
    // Extract base service name from qualified name (e.g., 'spotify-api' -> 'spotify')
    const baseService = service.replace('-api', '').replace('-tab', '');
    const labels: Record<string, string> = {
      spotify: 'Spotify',
      twitch: 'Twitch',
      youtube: 'YouTube',
      netflix: 'Netflix',
      steam: 'Steam',
      discord: 'Discord',
    };
    return labels[baseService] || service;
  }

  private _truncateActivityContent(content: string): string {
    return content.length > 40 ? content.substring(0, 40) + '...' : content;
  }

  /**
   * Aggressively deduplicate activities by ID (keep only one per unique ID)
   * Also enforces: one activity per service type
   * Prefers most recent activity (by timestamp)
   */
  private _deduplicateActivities(activities: Activity[]): Activity[] {
    const seen = new Map<string, Activity>();
    const seenByService = new Map<string, Activity>();

    for (const activity of activities) {
      const id = activity.id || '';
      const service = activity.service;

      // Check for duplicate activity ID
      if (seen.has(id)) {
        const existing = seen.get(id)!;
        const isNewer = (activity.timestamp || 0) > (existing.timestamp || 0);
        if (isNewer) {
          seen.set(id, activity);
          console.warn(`[Popup] Duplicate activity ID ${id} detected; keeping newer version`);
        } else {
          console.warn(`[Popup] Duplicate activity ID ${id} detected; keeping existing version`);
        }
        continue;
      }

      // Check for duplicate service (should never happen but enforce it)
      if (seenByService.has(service)) {
        const existing = seenByService.get(service)!;
        const isNewer = (activity.timestamp || 0) > (existing.timestamp || 0);
        console.warn(
          `[Popup] Multiple activities for service ${service} detected; keeping ${isNewer ? 'newer' : 'existing'}`
        );
        if (isNewer) {
          // Remove old from seen map and use new one
          const oldId = existing.id || '';
          if (oldId) seen.delete(oldId);
          seen.set(id, activity);
          seenByService.set(service, activity);
        }
        continue;
      }

      seen.set(id, activity);
      seenByService.set(service, activity);
    }

    return Array.from(seen.values());
  }

  /**
   * Sort activities by type: videos first, streams second, games last
   */
  private _sortActivitiesByType(activities: Activity[]): Activity[] {
    const typeOrder: { [key: string]: number } = {
      // Videos first
      'youtube-tab': 0,
      'netflix-tab': 1,
      'video-tab': 2,
      // Streams second
      'twitch-tab': 3,
      'twitch-api': 4,
      // Music third
      'spotify-api': 5,
      // Games last
      'steam-api': 6,
      // Other
      'discord-api': 7,
    };

    return [...activities].sort((a, b) => {
      const orderA = typeOrder[a.service] ?? 99;
      const orderB = typeOrder[b.service] ?? 99;
      return orderA - orderB;
    });
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
      } else if (message.type === 'INVITE_RECEIVED') {
        // Mark activity as having pending invite
        const { activityId, friendId } = message.data;
        if (activityId && friendId) {
          console.debug('[Popup] Received invite for activity:', activityId, 'from friend:', friendId);
          this.pendingInvitesByActivity.set(activityId, friendId);
          console.debug('[Popup] Pending invites map:', Array.from(this.pendingInvitesByActivity.entries()));
          this.refreshFriends().catch((error) => {
            console.error('[Popup] Failed to refresh after invite:', error);
          });
        }
      }
    });
  }

  private _setupStorageListener(): void {
    // Listen for MY_ACTIVITIES changes in storage
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      // Listen for activity updates from MY_ACTIVITIES (single source of truth)
      if (changes[STORAGE_KEYS.MY_ACTIVITIES]) {
        console.debug('[Popup] Activity data changed, refreshing...');
        this._loadMyActivity().catch((error) => {
          console.error('[Popup] Failed to refresh after storage change:', error);
        });
      }
    });
  }

  private _setupEventListeners(): void {
    // Manual refresh button (both header and settings panel use same function)
    const refreshBtn = document.getElementById('refresh-friends-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.refreshAll().catch((error) => {
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

    // Settings panel refresh button (same as header refresh - complete refresh)
    const settingsRefreshBtn = document.getElementById('settings-refresh-btn');
    if (settingsRefreshBtn) {
      settingsRefreshBtn.addEventListener('click', () => {
        this.refreshAll().catch((error) => {
          console.error('[Popup] Settings panel refresh failed:', error);
        });
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

    // Test notification button
    const testNotificationBtn = document.getElementById('test-notification-btn');
    if (testNotificationBtn) {
      testNotificationBtn.addEventListener('click', async () => {
        try {
          await chrome.runtime.sendMessage({ type: 'TEST_NOTIFICATION' });
          toastManager.show('Test notification sent!');
        } catch (error) {
          console.error('[Popup] Test notification error:', error);
          toastManager.show('Test notification failed');
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

    // Add friend button
    const addFriendBtn = document.getElementById('add-friend-btn');
    if (addFriendBtn) {
      addFriendBtn.addEventListener('click', () => this._showAddFriendForm());
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

  private _setupTabNavigation(): void {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const tabId = button.getAttribute('data-tab');
        if (!tabId) return;

        // Deactivate all tabs and contents
        tabButtons.forEach((btn) => btn.classList.remove('active'));
        tabContents.forEach((content) => content.classList.remove('active'));

        // Activate selected tab
        button.classList.add('active');
        const tabContent = document.getElementById(tabId);
        if (tabContent) {
          tabContent.classList.add('active');

          // If this is the discovery tab, render it
          if (tabId === 'discovery-tab' && this.discoveryTabController) {
            this.discoveryTabController.render().catch((error) => {
              console.error('[Popup] Failed to render discovery tab:', error);
            });
          }

          // Resize popup to fit new content
          this._resizePopupToFitContent();
        }
      });
    });

    console.debug('[Popup] Tab navigation initialized');
  }

  private _setupDiscoveryController(): void {
    try {
      const popupElement = document.getElementById('popup-container');
      const storage = this.storage;
      const gameLibraryManager = GameLibraryManager.getInstance(storage);
      const metadataFetcher = MetadataFetcher.getInstance(storage);

      this.discoveryTabController = new DiscoveryTabController(popupElement, gameLibraryManager, metadataFetcher, storage);

      this.discoveryTabController.init().catch((error) => {
        console.error('[Popup] Failed to initialize discovery controller:', error);
      });

      console.debug('[Popup] Discovery controller initialized');
    } catch (error) {
      console.error('[Popup] Error setting up discovery controller:', error);
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

private async _updateIntegrationHealthDisplays(): Promise<void> {
    try {
      const profile = await this.storage.getUserProfile();
      if (!profile) return;

      const integrations = ['steam-api', 'spotify-api', 'twitch-api', 'discord-api'];
      for (const service of integrations) {
        const statusEl = document.getElementById(`status-${service}-popup`);
        if (!statusEl) continue;

        const isEnabled = profile.services_enabled?.[service as keyof typeof profile.services_enabled] ?? false;
        if (!isEnabled) {
          statusEl.textContent = 'Disabled';
          statusEl.style.color = '';
          continue;
        }

        // For Steam, show health status with personaname if available
        if (service === 'steam-api') {
          const health = await this.storage.getIntegrationHealth();
          const steamHealth = health['steam-api'];
          if (steamHealth) {
            const timeSinceLastPing = Date.now() - steamHealth.lastPing;
            const secondsAgo = Math.floor(timeSinceLastPing / 1000);
            const minutesAgo = Math.floor(timeSinceLastPing / (60 * 1000));
            const timeStr = secondsAgo < 60 ? `${secondsAgo}s ago` : `${minutesAgo}m ago`;
            const personaStr = steamHealth.personaname ? ` - ${steamHealth.personaname}` : '';

            if (steamHealth.alive) {
              statusEl.textContent = `✅ Active${personaStr} (${timeStr})`;
              statusEl.style.color = '#10b981';
            } else {
              statusEl.textContent = `⚠️ Unavailable${personaStr} (${timeStr})`;
              statusEl.style.color = '#ef4444';
            }
          } else {
            statusEl.textContent = 'Not configured';
            statusEl.style.color = '';
          }
        }
        // TODO: Add health display for Spotify, Twitch, Discord when implemented
      }
    } catch (error) {
      console.error('[Popup] Failed to update integration health displays:', error);
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

      // Load nickname
      const nicknameInput = document.getElementById('nickname-popup') as HTMLInputElement;
      if (nicknameInput && profile.nickname) {
        nicknameInput.value = profile.nickname;
      }

      // Load Discord info
      const discordInput = document.getElementById('discord-info-popup') as HTMLInputElement;
      if (discordInput && profile.discord_info) {
        discordInput.value = profile.discord_info;
      }

      // Load Steam configuration
      const steamIdInput = document.getElementById('steam-id-popup') as HTMLInputElement;
      const steamApiKeyInput = document.getElementById('steam-api-key-popup') as HTMLInputElement;
      if (steamIdInput && profile.steam_config?.steam_id) {
        steamIdInput.value = profile.steam_config.steam_id;
      }
      if (steamApiKeyInput && profile.steam_config?.api_key) {
        steamApiKeyInput.value = profile.steam_config.api_key;
      }

      // Load service toggles for browser tabs
      const tabServices = ['youtube-tab', 'netflix-tab', 'twitch-tab', 'video-tab'];
      for (const service of tabServices) {
        const toggle = document.getElementById(`service-${service}-popup`) as HTMLInputElement;
        if (toggle && profile.services_enabled) {
          toggle.checked = profile.services_enabled[service as keyof typeof profile.services_enabled] ?? false;
        }
      }

      // Load service toggles for OAuth integrations
      const oauthServices = ['spotify-api', 'twitch-api', 'steam-api', 'discord-api'];
      for (const service of oauthServices) {
        const toggle = document.getElementById(`service-${service}-enabled`) as HTMLInputElement;
        if (toggle && profile.services_enabled) {
          toggle.checked = profile.services_enabled[service as keyof typeof profile.services_enabled] ?? false;
          this.serviceIntegrationEnabled.set(service, toggle.checked);
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

      // Load publisher config
      const pubConfig = profile.publisher_config || {
        enabled: true,
        size: 'full',
        scope: 'updates',
        rate_ms: 12000,
        relays: { 'nos.lol': true, 'relay.damus.io': true, 'relay.snort.social': true, 'nostr.mom': true, 'relay.mostr.pub': true },
        retry_backoff_ms: 1000,
        compression: false,
        verbose_logging: false,
        delta_publishing: false,
      };

      // Basic settings
      const pubEnabled = document.getElementById('pub-enabled-popup') as HTMLInputElement;
      if (pubEnabled) pubEnabled.checked = pubConfig.enabled ?? true;

      const pubSize = document.getElementById('pub-size-popup') as HTMLSelectElement;
      if (pubSize) pubSize.value = pubConfig.size ?? 'full';

      const pubScope = document.getElementById('pub-scope-popup') as HTMLSelectElement;
      if (pubScope) pubScope.value = pubConfig.scope ?? 'updates';

      const pubRate = document.getElementById('pub-rate-popup') as HTMLInputElement;
      if (pubRate) pubRate.value = (pubConfig.rate_ms ?? 12000).toString();

      // Advanced settings
      const pubCompression = document.getElementById('pub-compression-popup') as HTMLInputElement;
      if (pubCompression) pubCompression.checked = pubConfig.compression ?? false;

      const pubDelta = document.getElementById('pub-delta-popup') as HTMLInputElement;
      if (pubDelta) pubDelta.checked = pubConfig.delta_publishing ?? false;

      const pubVerbose = document.getElementById('pub-verbose-popup') as HTMLInputElement;
      if (pubVerbose) pubVerbose.checked = pubConfig.verbose_logging ?? false;

      const pubRetry = document.getElementById('pub-retry-popup') as HTMLInputElement;
      if (pubRetry) pubRetry.value = (pubConfig.retry_backoff_ms ?? 1000).toString();

      // Relay selection
      document.querySelectorAll('input[data-relay]').forEach((checkbox) => {
        if (checkbox instanceof HTMLInputElement) {
          const relay = checkbox.dataset.relay as keyof typeof pubConfig.relays;
          checkbox.checked = pubConfig.relays?.[relay] ?? true;
        }
      });

      // Load OAuth status
      await this._loadOAuthStatusInPanel();

      // Load game discovery setting
      const gameDiscoveryToggle = document.getElementById('game-discovery-enabled-popup') as HTMLInputElement;
      if (gameDiscoveryToggle) {
        gameDiscoveryToggle.checked = profile.game_discovery_enabled ?? false;
      }

      // Update integration health status (Steam, Spotify, Twitch)
      await this._updateIntegrationHealthDisplays();

      // Update Steam status after loading
      await this._updateServiceStatus('steam');

      // Add event listeners for settings panel
      this._setupSettingsPanelListeners();
    } catch (error) {
      console.error('[Popup] Failed to load settings panel:', error);
    }
  }

  private async _loadOAuthStatusInPanel(): Promise<void> {
    const oauthServices = ['spotify-api', 'twitch-api'];
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

      const browserActivities = response.success && response.data ? response.data : { 'video-tab': null };

      for (const service of ['video-tab']) {
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

    // Game discovery toggle
    const gameDiscoveryToggle = document.getElementById('game-discovery-enabled-popup') as HTMLInputElement;
    if (gameDiscoveryToggle) {
      gameDiscoveryToggle.addEventListener('change', async () => {
        await this._saveSettingsPanel();
        if (gameDiscoveryToggle.checked) {
          console.debug('[Popup] Game discovery enabled - will start in background service worker');
        } else {
          console.debug('[Popup] Game discovery disabled');
        }
      });
    }

    // Steam configuration inputs
    const steamIdInput = document.getElementById('steam-id-popup') as HTMLInputElement;
    const steamApiKeyInput = document.getElementById('steam-api-key-popup') as HTMLInputElement;
    const steamToggleVisibility = document.getElementById('steam-toggle-key-visibility') as HTMLButtonElement;

    if (steamIdInput) {
      steamIdInput.addEventListener('change', () => this._saveSettingsPanel());
    }
    if (steamApiKeyInput) {
      steamApiKeyInput.addEventListener('change', () => this._saveSettingsPanel());
    }
    if (steamToggleVisibility) {
      steamToggleVisibility.addEventListener('click', () => {
        if (steamApiKeyInput) {
          steamApiKeyInput.type = steamApiKeyInput.type === 'password' ? 'text' : 'password';
        }
      });
    }

    // Theme selector
    document.querySelectorAll('input[name="theme-popup"]').forEach((radio) => {
      radio.addEventListener('change', (e: Event) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        const theme = e.target.value;
        this._setTheme(theme);
      });
    });

    // Nickname input changes
    const nicknameInput = document.getElementById('nickname-popup') as HTMLInputElement;
    if (nicknameInput) {
      nicknameInput.addEventListener('change', () => this._saveSettingsPanel());
    }

    // Discord input changes
    const discordInput = document.getElementById('discord-info-popup') as HTMLInputElement;

    if (discordInput) {
      discordInput.addEventListener('change', () => this._saveSettingsPanel());
    }

    // Notification checkboxes
    document.querySelectorAll('input[id*="notif-"][id*="-popup"]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => this._saveSettingsPanel());
    });

    // Publisher config controls
    const pubEnabled = document.getElementById('pub-enabled-popup') as HTMLInputElement;
    const pubSize = document.getElementById('pub-size-popup') as HTMLSelectElement;
    const pubScope = document.getElementById('pub-scope-popup') as HTMLSelectElement;
    const pubRate = document.getElementById('pub-rate-popup') as HTMLInputElement;
    const pubCompression = document.getElementById('pub-compression-popup') as HTMLInputElement;
    const pubDelta = document.getElementById('pub-delta-popup') as HTMLInputElement;
    const pubVerbose = document.getElementById('pub-verbose-popup') as HTMLInputElement;
    const pubRetry = document.getElementById('pub-retry-popup') as HTMLInputElement;

    if (pubEnabled) pubEnabled.addEventListener('change', () => this._saveSettingsPanel());
    if (pubSize) pubSize.addEventListener('change', () => this._saveSettingsPanel());
    if (pubScope) pubScope.addEventListener('change', () => this._saveSettingsPanel());
    if (pubRate) pubRate.addEventListener('change', () => this._saveSettingsPanel());
    if (pubCompression) pubCompression.addEventListener('change', () => this._saveSettingsPanel());
    if (pubDelta) pubDelta.addEventListener('change', () => this._saveSettingsPanel());
    if (pubVerbose) pubVerbose.addEventListener('change', () => this._saveSettingsPanel());
    if (pubRetry) pubRetry.addEventListener('change', () => this._saveSettingsPanel());

    // Relay checkboxes
    document.querySelectorAll('input[data-relay]').forEach((checkbox) => {
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

    // Check integration health status (for Steam and OAuth services)
    if (service === 'steam-api') {
      try {
        const health = await this.storage.getIntegrationHealth();
        const steamHealth = health['steam-api'];
        if (steamHealth) {
          const timeSinceLastPing = Date.now() - steamHealth.lastPing;
          const secondsAgo = Math.floor(timeSinceLastPing / 1000);
          const minutesAgo = Math.floor(timeSinceLastPing / (60 * 1000));
          let timeStr = secondsAgo < 60 ? `${secondsAgo}s ago` : `${minutesAgo}m ago`;

          if (steamHealth.alive) {
            statusDiv.textContent = `✅ Active (${timeStr})`;
            statusDiv.style.color = '#10b981';
          } else {
            statusDiv.textContent = `⚠️ Unavailable (${timeStr})`;
            statusDiv.style.color = '#ef4444';
          }
          return;
        }
      } catch (error) {
        console.error('[Popup] Failed to check Steam health:', error);
      }
    }

    // No current activity - check if service is configured (for OAuth services)
    let isConfigured = false;
    if (!['video-tab', 'steam-api'].includes(service)) {
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
    if (['video-tab'].includes(service)) {
      // Browser tab services with no activity just show "No activity"
      statusDiv.textContent = 'No activity';
    } else if (!isConfigured) {
      // OAuth/Steam services with no token show "Not configured"
      statusDiv.textContent = 'Not configured';
    } else {
      statusDiv.textContent = 'No activity';
    }
  }

  private async _saveSettingsPanel(): Promise<void> {
    try {
      const nicknameInput = (document.getElementById('nickname-popup') as HTMLInputElement)?.value.trim() || '';
      const discordInput = (document.getElementById('discord-info-popup') as HTMLInputElement)?.value || '';
      const steamIdInput = (document.getElementById('steam-id-popup') as HTMLInputElement)?.value.trim() || '';
      const steamApiKeyInput = (document.getElementById('steam-api-key-popup') as HTMLInputElement)?.value.trim() || '';

      console.debug('[Popup] Saving settings - discord:', discordInput, 'steam-id:', steamIdInput ? 'set' : 'empty', 'steam-key:', steamApiKeyInput ? 'set' : 'empty');

      // Collect service toggles for browser tabs
      const servicesEnabled: Record<string, boolean> = {};
      const tabServices = ['youtube-tab', 'netflix-tab', 'twitch-tab', 'video-tab'];
      for (const service of tabServices) {
        const toggle = document.getElementById(`service-${service}-popup`) as HTMLInputElement;
        servicesEnabled[service] = toggle?.checked ?? false;
      }

      // Collect service toggles for OAuth integrations
      const oauthServices = ['spotify-api', 'twitch-api', 'steam-api', 'discord-api'];
      for (const service of oauthServices) {
        const toggle = document.getElementById(`service-${service}-enabled`) as HTMLInputElement;
        servicesEnabled[service] = toggle?.checked ?? false;
      }

      // Collect notification preferences
      const notifFriendOnline = (document.getElementById('notif-friend-online-popup') as HTMLInputElement)?.checked ?? true;
      const notifJoinSuggestion = (document.getElementById('notif-join-suggestion-popup') as HTMLInputElement)?.checked ?? false;

      // Collect publisher config
      const pubEnabled = (document.getElementById('pub-enabled-popup') as HTMLInputElement)?.checked ?? true;
      const pubSize = (document.getElementById('pub-size-popup') as HTMLSelectElement)?.value ?? 'full';
      const pubScope = (document.getElementById('pub-scope-popup') as HTMLSelectElement)?.value ?? 'updates';
      const pubRate = parseInt((document.getElementById('pub-rate-popup') as HTMLInputElement)?.value ?? '12000', 10);
      const pubCompression = (document.getElementById('pub-compression-popup') as HTMLInputElement)?.checked ?? false;
      const pubDelta = (document.getElementById('pub-delta-popup') as HTMLInputElement)?.checked ?? false;
      const pubVerbose = (document.getElementById('pub-verbose-popup') as HTMLInputElement)?.checked ?? false;
      const pubRetry = parseInt((document.getElementById('pub-retry-popup') as HTMLInputElement)?.value ?? '1000', 10);

      // Collect relay selections
      const relays: Record<string, boolean> = {};
      document.querySelectorAll('input[data-relay]').forEach((checkbox) => {
        if (checkbox instanceof HTMLInputElement && checkbox.dataset.relay) {
          relays[checkbox.dataset.relay] = checkbox.checked;
        }
      });

      // Collect game discovery setting
      const gameDiscoveryEnabled = (document.getElementById('game-discovery-enabled-popup') as HTMLInputElement)?.checked ?? false;

      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        data: {
          nickname: nicknameInput || undefined,
          discord_info: discordInput,
          steam_id: steamIdInput || undefined,
          steam_api_key: steamApiKeyInput || undefined,
          services_enabled: servicesEnabled,
          notification_preferences: {
            friend_online: notifFriendOnline,
            join_suggestion: notifJoinSuggestion,
          },
          publisher_config: {
            enabled: pubEnabled,
            size: pubSize,
            scope: pubScope,
            rate_ms: pubRate,
            compression: pubCompression,
            verbose_logging: pubVerbose,
            delta_publishing: pubDelta,
            retry_backoff_ms: pubRetry,
            relays,
          },
          game_discovery_enabled: gameDiscoveryEnabled,
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
    console.debug('[Popup] Opening invite modal for:', activity.content);
    try {
      const friendsResponse = await chrome.runtime.sendMessage({
        type: 'GET_ALL_ACTIVITIES',
      });

      if (!friendsResponse.success || !friendsResponse.data) {
        this._showError('Failed to load friends');
        return;
      }

      const friends = (friendsResponse.data.friends || []) as Friend[];
      const activeFriends = friends.filter((f) => Object.keys(f.current_activities || {}).length > 0);

      if (activeFriends.length === 0) {
        this._showError('No active friends to invite');
        return;
      }

      await showInviteModal(activeFriends, {
        title: activity.content,
        onInvite: (friendIds) => this._sendInvitesToFriends(activity, friendIds),
      });
    } catch (error) {
      console.error('[Popup] Failed to open invite modal:', error);
      this._showError('Failed to open invite modal');
    }
  }

  private _showAcceptInviteModal(activity: Activity, friendId: string): void {
    console.debug('[Popup] _showAcceptInviteModal called:', {
      activityId: activity.id,
      service: activity.service,
      content: activity.content,
      friendId,
    });

    // Create modal overlay
    const modal = document.createElement('div');
    modal.className = 'invite-modal-overlay';

    const modalContent = document.createElement('div');
    modalContent.className = 'invite-modal-content';

    // Header
    const header = document.createElement('div');
    header.className = 'invite-modal-header';
    const title = document.createElement('h3');
    title.textContent = activity.content;
    const subtitle = document.createElement('p');
    subtitle.style.fontSize = '0.9em';
    subtitle.style.color = 'var(--text-tertiary)';
    subtitle.style.margin = '0';
    subtitle.textContent = `Join this ${activity.service} activity?`;
    header.appendChild(title);
    header.appendChild(subtitle);
    modalContent.appendChild(header);

    // Buttons
    const buttons = document.createElement('div');
    buttons.className = 'invite-modal-buttons';

    const declineBtn = document.createElement('button');
    declineBtn.className = 'btn-secondary';
    declineBtn.textContent = 'Decline';
    declineBtn.addEventListener('click', async () => {
      // Decline: revert button to join
      if (activity.id) {
        this.pendingInvitesByActivity.delete(activity.id);
        // Also remove from persistent storage
        const pendingInvites = await this.storage.getPendingInvites();
        delete pendingInvites[activity.id];
        await this.storage.setPendingInvites(pendingInvites);
        console.debug('[Popup] Declined invite for activity:', activity.id);
      }
      modal.remove();
      // Wait a tick to ensure storage is synced before reloading
      await new Promise(resolve => setTimeout(resolve, 50));
      await this.refreshFriends();
    });

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'btn-primary';
    acceptBtn.textContent = 'Accept & Join';
    acceptBtn.addEventListener('click', async () => {
      acceptBtn.disabled = true;
      acceptBtn.textContent = 'Opening...';

      // Accept: open activity and mark as joined
      await this._joinActivity(activity, friendId);

      // Clear pending invite from memory and storage
      if (activity.id) {
        this.pendingInvitesByActivity.delete(activity.id);
        // Also remove from persistent storage
        const pendingInvites = await this.storage.getPendingInvites();
        delete pendingInvites[activity.id];
        await this.storage.setPendingInvites(pendingInvites);
        console.debug('[Popup] Cleared pending invite for activity:', activity.id);
      }

      modal.remove();
      // Wait a tick to ensure storage is synced before reloading
      await new Promise(resolve => setTimeout(resolve, 50));
      await this.refreshFriends();
    });

    buttons.appendChild(declineBtn);
    buttons.appendChild(acceptBtn);
    modalContent.appendChild(buttons);

    modal.appendChild(modalContent);
    document.body.appendChild(modal);

    // Close on backdrop click
    modal.addEventListener('click', (e: MouseEvent) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  private async _sendInvitesToFriends(activity: Activity, friendIds: string[]): Promise<void> {
    try {
      for (const friendId of friendIds) {
        await chrome.runtime.sendMessage({
          type: 'SEND_INVITE',
          data: { activity, friendId },
        });
      }
      console.debug('[Popup] Sent invites to', friendIds.length, 'friends');
      const message = `Invited ${friendIds.length} friend${friendIds.length > 1 ? 's' : ''}`;
      toastManager.show(message);
    } catch (error) {
      console.error('[Popup] Failed to send invites:', error);
      toastManager.show('Failed to send invites');
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
