/**
 * Hang Time - Shared Invite Modal Builder
 * Consolidates invite modal logic used by both friend panel and discovery tab
 */

import { Activity, Friend } from '../types';

export interface InviteModalOptions {
  title: string; // e.g., "Factorio" or "The Office"
  onInvite: (selectedFriendIds: string[]) => Promise<void>;
}

/**
 * Create and display a shared invite modal
 */
export async function showInviteModal(
  friends: Friend[],
  options: InviteModalOptions
): Promise<void> {
  // Create modal overlay
  const modal = document.createElement('div');
  modal.className = 'invite-modal-overlay';

  const modalContent = document.createElement('div');
  modalContent.className = 'invite-modal-content';

  // Header
  const header = document.createElement('div');
  header.className = 'invite-modal-header';
  const title = document.createElement('h3');
  title.textContent = `Invite friends to ${options.title}`;
  header.appendChild(title);
  modalContent.appendChild(header);

  // Friends list with checkboxes
  const friendsList = document.createElement('div');
  friendsList.className = 'invite-friends-list';

  const selectedFriends = new Set<string>();

  // Create buttons first so we can update them from checkbox changes
  const buttons = document.createElement('div');
  buttons.className = 'invite-modal-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => modal.remove());

  const inviteBtn = document.createElement('button');
  inviteBtn.className = 'btn-primary';
  inviteBtn.textContent = 'Invite';
  inviteBtn.disabled = true; // Disabled by default
  inviteBtn.addEventListener('click', async () => {
    if (selectedFriends.size > 0) {
      inviteBtn.disabled = true;
      inviteBtn.textContent = 'Sending...';
      await options.onInvite(Array.from(selectedFriends));
      modal.remove();
    }
  });

  // Create friend checkboxes
  for (const friend of friends) {
    const friendCheckbox = document.createElement('label');
    friendCheckbox.className = 'invite-friend-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = friend.id;
    checkbox.addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).checked) {
        selectedFriends.add(friend.id);
      } else {
        selectedFriends.delete(friend.id);
      }
      // Enable invite button when at least one friend is selected
      inviteBtn.disabled = selectedFriends.size === 0;
    });

    const nameSpan = document.createElement('span');
    nameSpan.textContent = friend.local_name;

    friendCheckbox.appendChild(checkbox);
    friendCheckbox.appendChild(nameSpan);
    friendsList.appendChild(friendCheckbox);
  }

  modalContent.appendChild(friendsList);

  buttons.appendChild(cancelBtn);
  buttons.appendChild(inviteBtn);
  modalContent.appendChild(buttons);

  modal.appendChild(modalContent);
  document.body.appendChild(modal);

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
}
