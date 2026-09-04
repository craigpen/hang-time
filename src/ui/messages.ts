/**
 * Hang Time - Messages UI Controller
 * Manages direct messages, message modals, and thread viewing
 */

import { Friend, Activity } from '../types';
import { escapeHtml } from './toast';

export class MessagesTabController {
  /**
   * Display modal for messaging a friend
   */
  showMessageModal(friend: Friend, messages: any[], activity?: Activity): void {
    const modal = document.createElement('div');
    modal.className = 'message-modal';
    const headerText = activity ? `${escapeHtml(friend.local_name)} (${activity.service})` : escapeHtml(friend.local_name);
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
              <span class="message-content">${escapeHtml(msg.content)}</span>
              <span class="message-time">${this.formatTime(msg.timestamp)}</span>
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
      sendBtn.addEventListener('click', () => this.sendMessage(friend, input, modal));
      input.addEventListener('keypress', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          this.sendMessage(friend, input, modal);
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

  /**
   * Send direct message to a friend
   */
  async sendMessage(friend: Friend, input: HTMLInputElement, modal: HTMLElement): Promise<void> {
    const content = input.value.trim();
    if (!content) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_MESSAGE',
        data: { friendId: friend.uuid, content },
      });

      if (response.success) {
        input.value = '';
        console.debug('[Messages] Message sent');

        // Reload messages
        const messagesResponse = await chrome.runtime.sendMessage({
          type: 'GET_MESSAGES',
          data: { friendId: friend.uuid },
        });

        if (messagesResponse.success) {
          modal.remove();
          this.showMessageModal(friend, messagesResponse.data || []);
        }
      } else {
        console.error('[Messages] Failed to send message:', response.error);
      }
    } catch (error) {
      console.error('[Messages] Send message failed:', error);
    }
  }

  /**
   * Format message timestamp into a friendly relative time
   */
  formatTime(timestamp: number): string {
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
}
