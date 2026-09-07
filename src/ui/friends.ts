/**
 * Hang Time - Friends Tab UI Controller
 * Manages friends list, presence indicators, invites, friend requests, and direct actions
 */

import { Friend, Activity } from '../types';
import { StorageManager } from '../modules/storage';
import { showInviteModal } from './invite-modal-builder';
import { toastManager, escapeHtml } from './toast';
import { MessagesTabController } from './messages';

export class FriendsTabController {
  private friendsList: HTMLElement | null = null;
  private noFriendsPlaceholder: HTMLElement | null = null;
  private addFriendForm: HTMLElement | null = null;
  private friendIdentifierInput: HTMLInputElement | null = null;
  private friendNicknameInput: HTMLInputElement | null = null;
  private storage: StorageManager;
  private messagesController: MessagesTabController;
  private expandedFriendsState: Map<string, boolean> = new Map();
  private pendingInvitesByActivity: Map<string, string> = new Map();
  private pendingInvitesData: Map<string, any> = new Map();
  private showInactiveFriends: boolean = true;
  private userActivities: Activity[] = [];
  private onResizeNeeded?: () => void;

  constructor(
    storage: StorageManager,
    messagesController: MessagesTabController,
    options?: {
      friendsList?: HTMLElement | null;
      noFriendsPlaceholder?: HTMLElement | null;
      addFriendForm?: HTMLElement | null;
      friendIdentifierInput?: HTMLInputElement | null;
      friendNicknameInput?: HTMLInputElement | null;
      onResizeNeeded?: () => void;
    }
  ) {
    this.storage = storage;
    this.messagesController = messagesController;
    this.friendsList = options?.friendsList ?? document.getElementById('friends-list');
    this.noFriendsPlaceholder = options?.noFriendsPlaceholder ?? document.getElementById('no-friends');
    this.addFriendForm = options?.addFriendForm ?? document.getElementById('add-friend-form');
    this.friendIdentifierInput = options?.friendIdentifierInput ?? (document.getElementById('friend-identifier') as HTMLInputElement);
    this.friendNicknameInput = options?.friendNicknameInput ?? (document.getElementById('friend-nickname') as HTMLInputElement);
    this.onResizeNeeded = options?.onResizeNeeded;
  }

  setUserActivities(activities: Activity[] | Record<string, Activity>): void {
    const rawActivities = activities || [];
    this.userActivities = (Array.isArray(rawActivities) ? rawActivities : Object.values(rawActivities)).filter((a) => a) as Activity[];
    const selfElement = this.friendsList?.querySelector('[data-friend-id="self"]') as HTMLElement;
    if (selfElement) {
      const selfExpanded = this.expandedFriendsState.get('self') ?? true;
      const sortedUserActivities = this.sortActivitiesByType(this.userActivities);
      this.updateFriendItem(selfElement, 'self', 'You', sortedUserActivities, selfExpanded);
    }
  }

  async openMessageModal(friend: Friend, activity?: Activity): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_MESSAGES',
        data: { friendId: friend.uuid },
      });
      const messages = response.success ? (response.data || []) : [];
      this.messagesController.showMessageModal(friend, messages, activity);
    } catch (error) {
      console.error('[Friends] Failed to open messages modal:', error);
    }
  }

  async loadPendingInvites(): Promise<void> {
    try {
      const receivedInvites = await this.storage.getReceivedInvites();
      this.pendingInvitesByActivity.clear();
      this.pendingInvitesData.clear();
      for (const [activityId, inviteData] of Object.entries(receivedInvites)) {
        this.pendingInvitesByActivity.set(activityId, inviteData.friendId);
        this.pendingInvitesData.set(activityId, inviteData);
      }
    } catch (error) {
      console.error('[Friends] Failed to load received invites:', error);
    }
  }

  async refreshFriends(): Promise<void> {
    try {
      await this.loadPendingInvites();

      const response = await chrome.runtime.sendMessage({
        type: 'GET_ALL_ACTIVITIES',
      });

      if (!response.success || !response.data) {
        toastManager.showError(`Failed to load friends: ${response.error || 'Unknown error'}`);
        return;
      }

      const rawActivities = response.data.userActivities || response.data.myActivities || {};
      this.userActivities = (Array.isArray(rawActivities) ? rawActivities : Object.values(rawActivities)).filter((a) => a) as Activity[];

      const friends = response.data.friends || [];
      await this.renderFriends(friends);
    } catch (error) {
      console.error('[Friends] Refresh error:', error);
      toastManager.showError('Failed to load friends');
    }
  }

  async renderFriends(friends: Friend[]): Promise<void> {
    if (!this.friendsList) return;

    const existingElements = new Map<string, HTMLElement>();
    this.friendsList.querySelectorAll('[data-friend-id]').forEach((el) => {
      const friendId = (el as HTMLElement).dataset['friendId'];
      if (friendId) {
        existingElements.set(friendId, el as HTMLElement);
      }
    });

    // Handle "You" (self)
    let selfElement = existingElements.get('self');
    const selfExpanded = this.expandedFriendsState.get('self') ?? true;
    const sortedUserActivities = this.sortActivitiesByType(this.userActivities);
    if (!selfElement) {
      selfElement = this.createFriendItem('self', 'You', sortedUserActivities, selfExpanded);
      selfElement.classList.add('user-item');
      selfElement.setAttribute('data-friend-id', 'self');
      this.friendsList.insertBefore(selfElement, this.friendsList.firstChild);
    } else {
      this.updateFriendItem(selfElement, 'self', 'You', sortedUserActivities, selfExpanded);
    }
    selfElement.classList.toggle('expanded', selfExpanded);

    // Filter friends if showInactiveFriends is false
    let displayFriends = friends;
    if (!this.showInactiveFriends && friends) {
      displayFriends = friends.filter(f => f.state === 'pending' || Object.keys(f.current_activities || {}).length > 0);
    }

    if (!displayFriends || displayFriends.length === 0) {
      if (this.noFriendsPlaceholder) {
        this.noFriendsPlaceholder.style.display = 'block';
      }
      existingElements.forEach((element, friendId) => {
        if (friendId !== 'self') {
          element.remove();
        }
      });
    } else {
      if (this.noFriendsPlaceholder) {
        this.noFriendsPlaceholder.style.display = 'none';
      }

      const pendingFriends = displayFriends.filter(f => f.state === 'pending');
      const activeFriends = displayFriends.filter(f => f.state === 'active');
      const sortedFriends = [...pendingFriends, ...activeFriends];

      for (const friend of sortedFriends) {
        const isExpanded = this.expandedFriendsState.get(friend.uuid) ?? true;

        if (friend.state === 'pending') {
          let friendElement = existingElements.get(friend.uuid);
          if (!friendElement) {
            friendElement = this.createPendingFriendItem(friend.uuid, friend.local_name, friend.initiated_by_me !== false);
            friendElement.setAttribute('data-friend-id', friend.uuid);
            this.friendsList.appendChild(friendElement);
          } else {
            if (!friendElement.classList.contains('pending')) {
              friendElement.remove();
              existingElements.delete(friend.uuid);
              friendElement = this.createPendingFriendItem(friend.uuid, friend.local_name, friend.initiated_by_me !== false);
              friendElement.setAttribute('data-friend-id', friend.uuid);
              this.friendsList.appendChild(friendElement);
            }
          }
          friendElement.classList.add('pending');
        } else {
          const activities = friend.dnd ? [] : this.sortActivitiesByType(Object.values(friend.current_activities || {}));
          let friendElement = existingElements.get(friend.uuid);
          if (!friendElement) {
            friendElement = this.createFriendItem(friend.uuid, friend.local_name, activities, isExpanded, friend);
            friendElement.setAttribute('data-friend-id', friend.uuid);
            this.friendsList.appendChild(friendElement);
          } else {
            if (friendElement.classList.contains('pending')) {
              friendElement.remove();
              existingElements.delete(friend.uuid);
              friendElement = this.createFriendItem(friend.uuid, friend.local_name, activities, isExpanded, friend);
              friendElement.setAttribute('data-friend-id', friend.uuid);
              this.friendsList.appendChild(friendElement);
            } else {
              this.updateFriendItem(friendElement, friend.uuid, friend.local_name, activities, isExpanded, friend);
            }
          }

          const isIdle = friend.dnd || Object.keys(friend.current_activities || {}).length === 0;
          friendElement.classList.toggle('idle', isIdle);
          friendElement.classList.toggle('expanded', isExpanded);
          friendElement.classList.remove('pending');
        }
      }

      existingElements.forEach((element, friendId) => {
        if (friendId !== 'self' && !friends.find((f) => f.uuid === friendId)) {
          element.remove();
        }
      });
    }

    if (this.onResizeNeeded) {
      this.onResizeNeeded();
    }
  }

  updateFriendItem(
    element: HTMLElement,
    friendId: string,
    _name: string,
    activities: Activity[],
    _isExpanded: boolean,
    friend?: Friend
  ): void {
    if (friend) {
      const statusSpan = element.querySelector('.friend-status') as HTMLElement;
      if (statusSpan) {
        const statusText = this.getStatusText(friend);
        statusSpan.textContent = statusText;
        statusSpan.classList.toggle('last-seen', statusText.includes('Last seen'));
        statusSpan.classList.toggle('dnd-status', !!friend.dnd);
      }
      element.classList.toggle('dnd-friend', !!friend.dnd);
    }

    const activitiesContainer = element.querySelector('.friend-activities') as HTMLElement;
    if (activitiesContainer) {
      const oldWrappers = Array.from(activitiesContainer.querySelectorAll<HTMLElement>('.activity-item-wrapper'));
      const oldWrapperMap = new Map<string, HTMLElement>();
      oldWrappers.forEach((el) => {
        const activityId = el.dataset['activityId'];
        if (activityId) oldWrapperMap.set(activityId, el);
      });

      const newActivityIds = new Set(activities.map((a) => a.id || ''));

      oldWrappers.forEach((el) => {
        const activityId = el.dataset['activityId'];
        if (activityId && !newActivityIds.has(activityId)) {
          el.remove();
          oldWrapperMap.delete(activityId);
        }
      });

      for (const activity of activities) {
        const activityId = activity.id || '';
        let wrapper = oldWrapperMap.get(activityId);

        if (!wrapper) {
          wrapper = this.createActivityItemWithMessages(activity, friendId);
          activitiesContainer.appendChild(wrapper);
        } else {
          this.updateExistingActivityRow(wrapper, activity, friendId, friend);
          activitiesContainer.appendChild(wrapper);
        }
      }

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

  updateExistingActivityRow(
    wrapper: HTMLElement,
    activity: Activity,
    friendId: string,
    friend?: Friend
  ): void {
    const row = wrapper.querySelector('.activity-item-row') as HTMLElement;
    if (!row) return;

    if (activity.metadata?.progress !== undefined && activity.metadata?.duration && activity.metadata.duration > 0) {
      const progressPercent = Math.min(100, Math.max(0, (activity.metadata.progress / activity.metadata.duration) * 100));
      row.style.setProperty('--progress-percent', `${progressPercent}%`);
      row.setAttribute('data-has-progress', 'true');
    } else {
      row.removeAttribute('data-has-progress');
    }

    const stateIcon = row.querySelector('.activity-state-icon') as HTMLElement;
    const contentText = row.querySelector('.activity-content-text') as HTMLElement;

    if (stateIcon && activity.state) {
      if (activity.service === 'steam-api') {
        stateIcon.textContent = '🎮';
        stateIcon.title = 'Playing';
      } else if (activity.state === 'disconnected') {
        stateIcon.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2" stroke-linecap="round" class="state-icon-svg">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="5" y1="19" x2="19" y2="5"></line>
          </svg>
        `;
        stateIcon.title = 'Connection lost - reload tab';

        if (contentText) {
          contentText.style.opacity = '0.5';
          contentText.style.textDecoration = 'line-through';
        }
      } else {
        const isDataFresh = activity.is_fresh !== false;

        if (!isDataFresh) {
          stateIcon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="#FEF3C7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="state-icon-svg">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
            </svg>
          `;
          stateIcon.title = 'Content script unavailable (tab may be backgrounded)';
        } else if (activity.state === 'playing') {
          stateIcon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="#4CAF50" stroke="none" class="state-icon-svg">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
          `;
          stateIcon.title = 'Playing';
        } else {
          stateIcon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="#9E9E9E" stroke="none" class="state-icon-svg">
              <rect x="6" y="4" width="4" height="16"></rect>
              <rect x="14" y="4" width="4" height="16"></rect>
            </svg>
          `;
          stateIcon.title = 'Paused';
        }

        if (contentText) {
          contentText.textContent = this.truncateActivityContent(activity.content);
          contentText.style.fontStyle = 'normal';
          contentText.style.opacity = '1';
        }
      }
    }

    const isDnd = friend?.dnd || activity.dnd || activity.metadata?.dnd;
    const joinBtn = row.querySelector('.activity-action-join') as HTMLElement;
    if (joinBtn && friendId !== 'self') {
      if (isDnd) {
        joinBtn.textContent = '▶';
        joinBtn.title = 'Friend is in Do Not Disturb mode';
        joinBtn.classList.add('disabled');
      } else {
        joinBtn.classList.remove('disabled');
        const hasPendingInvite = activity.id ? this.pendingInvitesByActivity.has(activity.id) : false;
        if (hasPendingInvite) {
          joinBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="envelope-icon">
            <rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect>
            <path d="M 2 6 L 12 13 L 22 6"></path>
          </svg>`;
          joinBtn.style.color = '#4CAF50';
          joinBtn.title = 'Accept or decline invite';
        } else {
          joinBtn.textContent = '▶';
          joinBtn.title = 'Join activity';
          joinBtn.style.color = '';
        }
      }
    }
  }

  getStatusText(friend: Friend): string {
    if (friend.dnd) {
      return '⛔ DND';
    }
    const daysSinceLastSeen = Math.ceil((Date.now() - friend.last_seen) / (1000 * 60 * 60 * 24));
    if (daysSinceLastSeen >= 30) {
      return `Last seen ${daysSinceLastSeen}d ago`;
    }
    const isActive = Object.keys(friend.current_activities || {}).length > 0;
    return isActive ? 'Active' : 'Inactive';
  }

  createFriendItem(id: string, name: string, activities: Activity[], isExpanded: boolean, friend?: Friend): HTMLElement {
    const item = document.createElement('div');
    item.className = 'friend-item';
    item.dataset['friendId'] = id;

    const isInactive = activities.length === 0;
    const statusText = friend ? this.getStatusText(friend) : (isInactive ? 'Inactive' : 'Active');

    const header = document.createElement('div');
    header.className = 'friend-header';

    const caret = document.createElement('span');
    caret.className = 'friend-caret';
    caret.textContent = isExpanded ? '▼' : '▶';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'friend-name';
    nameSpan.textContent = escapeHtml(name);

    const buttonsContainer = document.createElement('div');
    buttonsContainer.className = 'friend-header-buttons';

    if (id !== 'self') {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-friend-action btn-edit-friend';
      editBtn.textContent = '✎';
      editBtn.title = 'Rename friend';
      editBtn.onclick = (e) => {
        e.stopPropagation();
        this.handleEditFriend(id, name);
      };

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-friend-action btn-delete-friend';
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Remove friend';
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        this.handleDeleteFriend(id, name);
      };

      buttonsContainer.appendChild(editBtn);
      buttonsContainer.appendChild(deleteBtn);
    }

    const statusSpan = document.createElement('span');
    statusSpan.className = 'friend-status';
    if (statusText.includes('Last seen')) {
      statusSpan.classList.add('last-seen');
    }
    if (friend?.dnd) {
      statusSpan.classList.add('dnd-status');
      item.classList.add('dnd-friend');
    }
    statusSpan.textContent = statusText;

    header.appendChild(caret);
    header.appendChild(nameSpan);
    header.appendChild(buttonsContainer);
    header.appendChild(statusSpan);
    item.appendChild(header);

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
        const activityWrapper = this.createActivityItemWithMessages(activity, id);
        activitiesContainer.appendChild(activityWrapper);
      }
    }

    item.appendChild(activitiesContainer);

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
      if (this.onResizeNeeded) {
        this.onResizeNeeded();
      }
    });

    return item;
  }

  createPendingFriendItem(id: string, name: string, initiatedByMe: boolean = true): HTMLElement {
    const item = document.createElement('div');
    item.className = 'friend-item pending-friend-item';
    item.dataset['friendId'] = id;

    const header = document.createElement('div');
    header.className = 'friend-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'friend-name';
    nameSpan.textContent = escapeHtml(name);

    const statusSpan = document.createElement('span');
    statusSpan.className = 'friend-status pending-status';
    statusSpan.textContent = 'Pending';

    header.appendChild(nameSpan);
    header.appendChild(statusSpan);
    item.appendChild(header);

    if (!initiatedByMe) {
      const messageContainer = document.createElement('div');
      messageContainer.className = 'pending-message-container';

      const message = document.createElement('div');
      message.className = 'pending-message';
      message.textContent = `${name} added you as a friend`;

      const buttonsContainer = document.createElement('div');
      buttonsContainer.className = 'pending-buttons';

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'btn-accept-friend';
      acceptBtn.textContent = 'Accept';
      acceptBtn.onclick = (e) => {
        e.stopPropagation();
        this.handleAcceptFriendRequest(id, name);
      };

      const declineBtn = document.createElement('button');
      declineBtn.className = 'btn-decline-friend';
      declineBtn.textContent = 'Decline';
      declineBtn.onclick = (e) => {
        e.stopPropagation();
        this.handleDeclineFriendRequest(id, name);
      };

      buttonsContainer.appendChild(acceptBtn);
      buttonsContainer.appendChild(declineBtn);

      messageContainer.appendChild(message);
      messageContainer.appendChild(buttonsContainer);
      item.appendChild(messageContainer);
    }

    return item;
  }

  createActivityItemWithMessages(activity: Activity, friendId?: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'activity-item-wrapper';
    wrapper.dataset['activityId'] = activity.id || '';

    const row = this.createActivityRow(activity, friendId);
    wrapper.appendChild(row);

    return wrapper;
  }

  createActivityRow(activity: Activity, friendId?: string): HTMLElement {
    try {
      const row = document.createElement('div');
      row.className = 'activity-item-row';

      if (activity.metadata?.progress !== undefined && activity.metadata?.duration && activity.metadata.duration > 0) {
        const progressPercent = Math.min(100, Math.max(0, (activity.metadata.progress / activity.metadata.duration) * 100));
        row.style.setProperty('--progress-percent', `${progressPercent}%`);
        row.setAttribute('data-has-progress', 'true');
      } else {
        row.removeAttribute('data-has-progress');
      }

      if (activity.state) {
        const stateIcon = document.createElement('div');
        stateIcon.className = 'activity-state-icon';

        if (activity.service === 'steam-api') {
          stateIcon.textContent = '🎮';
          stateIcon.title = 'Playing';
        } else if (activity.state === 'disconnected') {
          stateIcon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2" stroke-linecap="round" class="state-icon-svg">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="5" y1="19" x2="19" y2="5"></line>
            </svg>
          `;
          stateIcon.title = 'Connection lost - reload tab';
        } else {
          const isDataFresh = activity.is_fresh !== false;

          if (!isDataFresh) {
            stateIcon.innerHTML = `
              <svg viewBox="0 0 24 24" fill="none" stroke="#FEF3C7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="state-icon-svg">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            `;
            stateIcon.title = 'Content script unavailable (tab may be backgrounded)';
          } else if (activity.state === 'playing') {
            stateIcon.innerHTML = `
              <svg viewBox="0 0 24 24" fill="#4CAF50" stroke="none" class="state-icon-svg">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            `;
            stateIcon.title = 'Playing';
          } else {
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
      }

      const faviconDiv = document.createElement('div');
      faviconDiv.className = 'activity-item-favicon';
      const img = document.createElement('img');

      const dynamicFavicon = activity.metadata?.favicon;
      const faviconUrl = dynamicFavicon ?
        (dynamicFavicon.startsWith('http') ? dynamicFavicon : `https:${dynamicFavicon}`) :
        this.getFaviconUrl(activity.service);

      img.src = faviconUrl;
      img.alt = activity.service;
      img.style.borderRadius = '4px';
      img.onerror = () => {
        img.src = this.getFaviconUrl(activity.service);
        img.onerror = null;
      };
      faviconDiv.appendChild(img);
      row.appendChild(faviconDiv);

      const contentText = document.createElement('span');
      contentText.className = 'activity-content-text';
      if (activity.state === 'disconnected') {
        contentText.textContent = 'Disconnected - reload tab';
        contentText.style.fontStyle = 'italic';
        contentText.style.opacity = '0.7';
      } else {
        contentText.textContent = this.truncateActivityContent(activity.content);
      }
      row.appendChild(contentText);

      if (activity.metadata?.['in_voice'] || activity.metadata?.['voice_count']) {
        const voiceBadge = document.createElement('span');
        voiceBadge.className = 'activity-voice-badge';
        const count = activity.metadata?.['voice_count'] ? ` (${activity.metadata['voice_count']})` : '';
        voiceBadge.innerHTML = `<span class="voice-badge-dot"></span>🎙️${count}`;
        voiceBadge.title = 'In voice room together';
        row.appendChild(voiceBadge);
      }

      const isDnd = activity.dnd || activity.metadata?.dnd;
      const buttonsDiv = document.createElement('div');
      buttonsDiv.className = 'activity-actions';

      const isSelfActivity = friendId === 'self';
      const hasPendingInvite = activity.id && this.pendingInvitesByActivity.has(activity.id);

      const firstBtn = document.createElement('button');
      firstBtn.className = 'activity-action-btn activity-action-join';

      if (isSelfActivity) {
        firstBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="envelope-icon" width="14" height="14">
          <rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect>
          <path d="M 2 6 L 12 13 L 22 6"></path>
        </svg>`;
        firstBtn.style.color = '#999';
        firstBtn.title = 'Invite friends';
      } else if (isDnd) {
        firstBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="join-icon" width="13" height="13">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>`;
        firstBtn.title = 'Friend is in Do Not Disturb mode';
        firstBtn.classList.add('disabled');
      } else if (hasPendingInvite) {
        firstBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="envelope-icon" width="14" height="14">
          <rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect>
          <path d="M 2 6 L 12 13 L 22 6"></path>
        </svg>`;
        firstBtn.style.color = '#4CAF50';
        firstBtn.title = 'Accept or decline invite';
      } else {
        firstBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="join-icon" width="13" height="13">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>`;
        firstBtn.title = 'Join activity';
      }

      firstBtn.addEventListener('click', () => {
        const currentHasPending = activity.id ? this.pendingInvitesByActivity.has(activity.id) : false;
        if (isSelfActivity) {
          this.inviteToActivity(activity);
        } else if (isDnd) {
          toastManager.show('Friend is in Do Not Disturb mode');
        } else if (currentHasPending) {
          this.showAcceptInviteModal(activity, friendId!);
        } else {
          this.joinActivity(activity, friendId);
        }
      });
      buttonsDiv.appendChild(firstBtn);
      row.appendChild(buttonsDiv);

      return row;
    } catch (error) {
      console.error('[Friends] Error creating activity row:', error);
      const errorRow = document.createElement('div');
      errorRow.className = 'activity-item-row';
      const errorText = document.createElement('span');
      errorText.textContent = `Error: ${activity.content}`;
      errorRow.appendChild(errorText);
      return errorRow;
    }
  }

  async handleRemoveFriend(friend: Friend): Promise<void> {
    if (!confirm(`Remove friend "${friend.local_name}"?`)) {
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'REMOVE_FRIEND',
        data: { friendId: friend.uuid },
      });

      if (response.success) {
        console.debug(`[Friends] Removed friend: ${friend.local_name}`);
        await this.refreshFriends();
      } else {
        toastManager.showError(response.error || 'Failed to remove friend');
      }
    } catch (error) {
      console.error('[Friends] Remove friend failed:', error);
      toastManager.showError('Failed to remove friend');
    }
  }

  handleDeleteFriend(friendId: string, friendName: string): void {
    const minimalFriend: Friend = {
      uuid: friendId,
      pubkey: '',
      local_name: friendName,
      added_at: 0,
      last_seen: 0,
      muted: false,
      hidden_services: [],
      current_activities: {},
      state: 'active',
    };
    this.handleRemoveFriend(minimalFriend);
  }

  handleEditFriend(friendId: string, currentName: string): void {
    const newName = prompt('Rename friend:', currentName);
    if (!newName || newName.trim() === '' || newName === currentName) {
      return;
    }

    chrome.runtime.sendMessage({
      type: 'RENAME_FRIEND',
      data: { friendId, newName: newName.trim() },
    }, (response) => {
      if (response?.success) {
        console.debug(`[Friends] Renamed friend to: ${newName}`);
        this.refreshFriends().catch(() => {});
      } else {
        toastManager.showError(response?.error || 'Failed to rename friend');
      }
    });
  }

  handleAcceptFriendRequest(friendId: string, friendName: string): void {
    chrome.runtime.sendMessage({
      type: 'ACCEPT_FRIEND_REQUEST',
      data: { friendId },
    }, (response) => {
      if (response?.success) {
        console.debug(`[Friends] Accepted friend request from: ${friendName}`);
        toastManager.showSuccess(`You're now friends with ${friendName}!`);
        this.refreshFriends().catch(() => {});
      } else {
        toastManager.showError(response?.error || 'Failed to accept friend request');
      }
    });
  }

  handleDeclineFriendRequest(friendId: string, friendName: string): void {
    chrome.runtime.sendMessage({
      type: 'DECLINE_FRIEND_REQUEST',
      data: { friendId },
    }, (response) => {
      if (response?.success) {
        console.debug(`[Friends] Declined friend request from: ${friendName}`);
        toastManager.showSuccess(`Declined friend request from ${friendName}`);
        this.refreshFriends().catch(() => {});
      } else {
        toastManager.showError(response?.error || 'Failed to decline friend request');
      }
    });
  }

  showAcceptInviteModal(activity: Activity, friendId: string): void {
    const modal = document.createElement('div');
    modal.className = 'invite-modal-overlay';

    const modalContent = document.createElement('div');
    modalContent.className = 'invite-modal-content';

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

    const buttons = document.createElement('div');
    buttons.className = 'invite-modal-buttons';

    const declineBtn = document.createElement('button');
    declineBtn.className = 'btn-secondary';
    declineBtn.textContent = 'Decline';
    declineBtn.addEventListener('click', async () => {
      declineBtn.disabled = true;
      declineBtn.textContent = 'Declining...';
      if (activity.id) {
        this.pendingInvitesByActivity.delete(activity.id);
        this.pendingInvitesData.delete(activity.id);
        await this.storage.removeReceivedInvite(activity.id);
        await this.storage.forceSyncNow();
        try {
          await chrome.runtime.sendMessage({
            type: 'DECLINE_INVITE',
            data: { activityId: activity.id, friendId, activity },
          });
        } catch (err) {
          console.debug('[Friends] Could not notify background of decline:', err);
        }
      }
      modal.remove();
      await this.refreshFriends();
    });

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'btn-primary';
    acceptBtn.textContent = 'Accept & Join';
    acceptBtn.addEventListener('click', async () => {
      acceptBtn.disabled = true;
      acceptBtn.textContent = 'Opening...';

      await this.joinActivity(activity, friendId);

      if (activity.id) {
        this.pendingInvitesByActivity.delete(activity.id);
        this.pendingInvitesData.delete(activity.id);
        await this.storage.removeReceivedInvite(activity.id);
        await this.storage.forceSyncNow();
      }

      modal.remove();
      await this.refreshFriends();
    });

    buttons.appendChild(declineBtn);
    buttons.appendChild(acceptBtn);
    modalContent.appendChild(buttons);
    modal.appendChild(modalContent);
    document.body.appendChild(modal);

    modal.addEventListener('click', (e: MouseEvent) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  async inviteToActivity(activity: Activity): Promise<void> {
    try {
      const friendsResponse = await chrome.runtime.sendMessage({
        type: 'GET_ALL_ACTIVITIES',
      });

      if (!friendsResponse.success || !friendsResponse.data) {
        toastManager.showError('Failed to load friends');
        return;
      }

      const friends = (friendsResponse.data.friends || []) as Friend[];
      const activeFriends = friends.filter((f) => !f.dnd && Object.keys(f.current_activities || {}).length > 0);

      if (activeFriends.length === 0) {
        toastManager.showError('No active friends to invite');
        return;
      }

      await showInviteModal(activeFriends, {
        title: activity.content,
        onInvite: (friendIds) => this.sendInvitesToFriends(activity, friendIds),
      });
    } catch (error) {
      console.error('[Friends] Failed to open invite modal:', error);
      toastManager.showError('Failed to open invite modal');
    }
  }

  async joinActivity(activity: Activity, friendId?: string): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'JOIN_ACTIVITY',
        data: { activity, friendId },
      });

      if (!response.success) {
        toastManager.showError(response.error || 'Failed to join activity');
        return;
      }

      if (friendId && friendId !== 'self') {
        await chrome.runtime.sendMessage({
          type: 'SEND_JOIN_NOTIFICATION',
          data: { activity, friendId, accepted: true },
        });
      }
    } catch (error) {
      console.error('[Friends] Failed to join activity:', error);
      toastManager.showError('Failed to join activity');
    }
  }

  async sendInvitesToFriends(activity: Activity, friendIds: string[]): Promise<void> {
    try {
      for (const friendId of friendIds) {
        await chrome.runtime.sendMessage({
          type: 'SEND_INVITE',
          data: { activity, friendId },
        });
      }
      const message = `Invited ${friendIds.length} friend${friendIds.length > 1 ? 's' : ''}`;
      toastManager.show(message);
    } catch (error) {
      console.error('[Friends] Failed to send invites:', error);
      toastManager.show('Failed to send invites');
    }
  }

  showAddFriendForm(): void {
    if (this.addFriendForm) {
      this.addFriendForm.style.display = 'block';
      if (this.friendIdentifierInput) {
        this.friendIdentifierInput.focus();
      }
    }
  }

  hideAddFriendForm(): void {
    if (this.addFriendForm) {
      this.addFriendForm.style.display = 'none';
    }
    this.refreshFriends().catch((error) => {
      console.error('[Friends] Refresh failed:', error);
    });
  }

  async handleAddFriendSubmit(): Promise<void> {
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
        if (this.friendIdentifierInput) this.friendIdentifierInput.value = '';
        if (this.friendNicknameInput) this.friendNicknameInput.value = '';
        this.hideAddFriendForm();
        await this.refreshFriends();
      } else {
        alert(`Failed to add friend: ${response.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Friends] Add friend failed:', error);
      alert('Failed to add friend');
    }
  }

  toggleShowInactiveFriends(): void {
    this.showInactiveFriends = !this.showInactiveFriends;
    const btn = document.getElementById('show-inactive-btn');
    if (btn) {
      btn.classList.toggle('inactive-hidden', !this.showInactiveFriends);
      btn.title = this.showInactiveFriends ? 'Hide offline friends' : 'Show offline friends';
      btn.style.opacity = this.showInactiveFriends ? '1' : '0.4';
    }
    this.refreshFriends().catch((error) => {
      console.error('[Friends] Failed to refresh friends:', error);
    });
  }

  sortActivitiesByType(activities: Activity[]): Activity[] {
    const typeOrder = ['video-tab', 'youtube-tab', 'netflix-tab', 'twitch-tab', 'steam-api', 'xbox-api', 'spotify-api', 'twitch-api'];
    return [...activities].sort((a, b) => {
      const aIndex = typeOrder.indexOf(a.service);
      const bIndex = typeOrder.indexOf(b.service);
      const aOrder = aIndex === -1 ? 999 : aIndex;
      const bOrder = bIndex === -1 ? 999 : bIndex;
      return aOrder - bOrder;
    });
  }

  getFaviconUrl(service: string): string {
    const baseService = service.replace('-api', '').replace('-tab', '');
    const iconMap: Record<string, string> = {
      netflix: 'public/icons/netflix.png',
      youtube: 'public/icons/youtube.png',
      spotify: 'public/icons/spotify.png',
      twitch: 'public/icons/twitch.png',
      steam: 'public/icons/steam.png',
      xbox: 'public/icons/xbox.png',
      discord: 'public/icons/discord.png',
    };
    const icon = iconMap[baseService];
    if (!icon) return '';
    return chrome.runtime.getURL(icon);
  }

  truncateActivityContent(content: string): string {
    const maxLength = 25;
    return content.length > maxLength ? content.substring(0, maxLength) + '...' : content;
  }
}
