/**
 * Hang Time - Overlay UI
 * Renders floating overlay panel for video co-watching
 */

export interface OverlayState {
  visible: boolean;
  pinned: boolean;
  opacity: number; // 0-100
  host_name?: string;
  co_watchers: string[]; // Friend local names
  messages: Array<{
    id: string;
    sender: string;
    sender_id: string;
    content: string;
    timestamp: number;
  }>;
  host_position?: number; // seconds
  user_position?: number; // seconds
  video_title?: string;
}

export class OverlayUI {
  private container: HTMLElement | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private state: OverlayState = {
    visible: false,
    pinned: false,
    opacity: 80,
    co_watchers: [],
    messages: [],
  };

  constructor(private userId: string) {}

  /**
   * Initialize overlay on page
   */
  init(): void {
    this.createOverlayContainer();
    this.setupEventListeners();
    console.debug('[OverlayUI] Initialized');
  }

  /**
   * Create overlay DOM structure
   */
  private createOverlayContainer(): void {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.id = 'hang-time-overlay';
    this.container.className = 'hidden'; // Start hidden, show only when co-watch detected
    this.container.innerHTML = `
      <style id="hang-time-overlay-styles">
        #hang-time-overlay {
          position: fixed;
          top: 20px;
          right: 20px;
          width: 320px;
          max-height: 80vh;
          background: rgba(0, 0, 0, 0.8);
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
          z-index: 9999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: white;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          transition: opacity 0.2s ease;
        }

        #hang-time-overlay.hidden {
          display: none;
        }

        .overlay-header {
          padding: 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .video-title {
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 8px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.5);
        }

        .progress-bar-container {
          width: 100%;
          height: 4px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 2px;
          overflow: hidden;
          position: relative;
        }

        .progress-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, #4da6ff, #1a7fff);
          width: 0%;
          transition: width 0.1s linear;
        }

        .progress-bar-marker {
          position: absolute;
          top: -2px;
          width: 8px;
          height: 8px;
          background: #ff6b6b;
          border-radius: 50%;
          border: 2px solid white;
          left: 0%;
          transition: left 0.1s linear;
          box-shadow: 0 0 4px rgba(255, 107, 107, 0.6);
        }

        .attendees-header {
          padding: 8px 12px;
          font-size: 12px;
          color: rgba(255, 255, 255, 0.7);
          background: rgba(255, 255, 255, 0.05);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          text-shadow: 1px 1px 1px rgba(0, 0, 0, 0.5);
        }

        .button-row {
          display: flex;
          gap: 8px;
          padding: 8px 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          align-items: center;
        }

        .overlay-button {
          flex: 1;
          padding: 6px 8px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: white;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
          transition: all 0.2s ease;
          white-space: nowrap;
          text-shadow: 1px 1px 1px rgba(0, 0, 0, 0.5);
        }

        .overlay-button:hover {
          background: rgba(255, 255, 255, 0.15);
          border-color: rgba(255, 255, 255, 0.3);
        }

        .overlay-button:active {
          background: rgba(255, 255, 255, 0.2);
        }

        .sync-button {
          background: rgba(45, 166, 255, 0.8);
          border-color: rgba(45, 166, 255, 1);
        }

        .sync-button:hover {
          background: rgba(45, 166, 255, 0.9);
        }

        .opacity-slider {
          width: 60px;
          height: 20px;
          cursor: pointer;
          accent-color: #2da6ff;
        }

        .chat-container {
          flex: 1;
          overflow-y: auto;
          padding: 8px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .chat-message {
          display: flex;
          gap: 6px;
          font-size: 13px;
          line-height: 1.3;
        }

        .message-user {
          flex-direction: row-reverse;
        }

        .message-content {
          max-width: 70%;
          padding: 6px 8px;
          border-radius: 4px;
          word-wrap: break-word;
        }

        .message-friend .message-content {
          background: rgba(255, 255, 255, 0.1);
          color: white;
        }

        .message-user .message-content {
          background: rgba(45, 166, 255, 0.8);
          color: white;
          text-align: right;
        }

        .message-sender {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.5);
          margin-bottom: 2px;
        }

        .message-user .message-sender {
          text-align: right;
        }
      </style>

      <div class="overlay-header">
        <div class="video-title" id="overlay-title">Loading...</div>
        <div class="progress-bar-container">
          <div class="progress-bar-fill" id="progress-bar-fill"></div>
          <div class="progress-bar-marker" id="progress-bar-marker"></div>
        </div>
      </div>

      <div class="attendees-header" id="attendees-header">
        Watching with: Loading...
      </div>

      <div class="button-row">
        <button class="overlay-button sync-button" id="sync-button">↻ Sync</button>
        <button class="overlay-button" id="pin-button">📌</button>
        <button class="overlay-button" id="discord-button">🎮</button>
        <input type="range" min="10" max="100" value="80" class="opacity-slider" id="opacity-slider" title="Overlay opacity">
      </div>

      <div class="chat-container" id="chat-container">
        <div style="text-align: center; color: rgba(255, 255, 255, 0.5); font-size: 12px;">No messages yet</div>
      </div>
    `;

    document.body.appendChild(this.container);
    this.setupOpacitySlider();
  }

  /**
   * Setup opacity slider
   */
  private setupOpacitySlider(): void {
    const slider = document.getElementById('opacity-slider') as HTMLInputElement;
    if (!slider) return;

    slider.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value;
      this.state.opacity = parseInt(value);
      this.updateOpacity();
    });

    this.updateOpacity();
  }

  /**
   * Update overlay opacity
   */
  private updateOpacity(): void {
    if (!this.container) return;
    const opacity = this.state.opacity / 100;
    this.container.style.opacity = opacity.toString();
  }

  /**
   * Setup global event listeners
   */
  private setupEventListeners(): void {
    // Show overlay on mouse move
    document.addEventListener('mousemove', () => this.show());

    // Hide overlay after inactivity (unless pinned)
    document.addEventListener('mousemove', () => {
      if (!this.state.pinned) {
        this.resetHideTimer();
      }
    });

    // Pin button
    const pinButton = document.getElementById('pin-button');
    if (pinButton) {
      pinButton.addEventListener('click', () => this.togglePin());
    }

    // Sync button
    const syncButton = document.getElementById('sync-button');
    if (syncButton) {
      syncButton.addEventListener('click', () => this.onSyncClick());
    }

    // Discord button
    const discordButton = document.getElementById('discord-button');
    if (discordButton) {
      discordButton.addEventListener('click', () => this.onDiscordClick());
    }
  }

  /**
   * Show overlay (only if there's an active co-watch session or pinned)
   */
  show(): void {
    if (!this.container) return;

    // Only show if:
    // 1. There's an active co-watch session (has host_name or co_watchers)
    // 2. OR the overlay is pinned
    const hasCoWatchSession = this.state.host_name || this.state.co_watchers.length > 0;
    if (!hasCoWatchSession && !this.state.pinned) {
      return;
    }

    this.container.classList.remove('hidden');
    this.state.visible = true;
    if (!this.state.pinned) {
      this.resetHideTimer();
    }
  }

  /**
   * Hide overlay
   */
  hide(): void {
    if (!this.container) return;
    this.container.classList.add('hidden');
    this.state.visible = false;
  }

  /**
   * Reset auto-hide timer
   */
  private resetHideTimer(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), 3000);
  }

  /**
   * Toggle pin state
   */
  togglePin(): void {
    this.state.pinned = !this.state.pinned;
    const button = document.getElementById('pin-button');
    if (button) {
      button.textContent = this.state.pinned ? '📌' : '📌';
      button.style.opacity = this.state.pinned ? '1' : '0.6';
    }
    if (this.state.pinned) {
      if (this.hideTimer) clearTimeout(this.hideTimer);
    }
    console.debug('[OverlayUI] Pin toggled:', this.state.pinned);
  }

  /**
   * Sync button clicked
   */
  private onSyncClick(): void {
    console.debug('[OverlayUI] Sync button clicked');
    // This will be wired to send sync_request message
    window.postMessage({ type: 'HANG_TIME_SYNC_REQUEST' }, '*');
  }

  /**
   * Discord button clicked
   */
  private onDiscordClick(): void {
    console.debug('[OverlayUI] Discord button clicked');
    window.postMessage({ type: 'HANG_TIME_OPEN_DISCORD' }, '*');
  }

  /**
   * Update overlay state and rendering
   */
  setState(newState: Partial<OverlayState>): void {
    this.state = { ...this.state, ...newState };
    this.render();
  }

  /**
   * Render all UI elements
   */
  private render(): void {
    this.renderHeader();
    this.renderAttendees();
    this.renderMessages();
  }

  /**
   * Render header (title + progress bar)
   */
  private renderHeader(): void {
    const titleEl = document.getElementById('overlay-title');
    if (titleEl) {
      titleEl.textContent = this.state.video_title || 'Loading video...';
    }

    const fillEl = document.getElementById('progress-bar-fill') as HTMLElement;
    const markerEl = document.getElementById('progress-bar-marker') as HTMLElement;

    if (fillEl && markerEl && this.state.host_position !== undefined && this.state.user_position !== undefined) {
      // Assume 2 hour max video for progress calculation
      const maxDuration = 7200;
      const hostPercent = Math.min((this.state.host_position / maxDuration) * 100, 100);
      const userPercent = Math.min((this.state.user_position / maxDuration) * 100, 100);

      fillEl.style.width = hostPercent + '%';
      markerEl.style.left = userPercent + '%';
    }
  }

  /**
   * Render attendees list
   */
  private renderAttendees(): void {
    const header = document.getElementById('attendees-header');
    if (!header) return;

    const host = this.state.host_name || '?';
    const others = this.state.co_watchers.length > 0 ? `, ${this.state.co_watchers.join(', ')}` : '';
    header.textContent = `Watching with: ${host}${others}`;
  }

  /**
   * Render chat messages
   */
  private renderMessages(): void {
    const container = document.getElementById('chat-container');
    if (!container) return;

    if (this.state.messages.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: rgba(255, 255, 255, 0.5); font-size: 12px;">No messages yet</div>';
      return;
    }

    container.innerHTML = this.state.messages
      .map(msg => {
        const isUser = msg.sender_id === this.userId;
        return `
          <div class="chat-message ${isUser ? 'message-user' : 'message-friend'}">
            <div>
              <div class="message-sender">${msg.sender}</div>
              <div class="message-content">${this.escapeHtml(msg.content)}</div>
            </div>
          </div>
        `;
      })
      .join('');

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Add message to chat
   */
  addMessage(sender: string, senderId: string, content: string): void {
    this.state.messages.push({
      id: Date.now().toString(),
      sender,
      sender_id: senderId,
      content,
      timestamp: Date.now(),
    });

    // Keep only last 50 messages
    if (this.state.messages.length > 50) {
      this.state.messages = this.state.messages.slice(-50);
    }

    this.renderMessages();
  }

  /**
   * Destroy overlay
   */
  destroy(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
    }
  }
}
