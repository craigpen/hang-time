/**
 * Hang Time - Overlay UI
 * Renders floating overlay panel for video co-watching
 */

import { storageManager } from './storage.js';

export interface OverlayState {
  visible: boolean;
  pinned: boolean;
  opacity: number; // 0-100
  host_nickname?: string;
  session_members: string[]; // all persistent session members (for divergence display)
  watching_together: string[]; // people on same activity (for mode A/B detection, progress markers)
  messages: Array<{
    id: string;
    sender: string;
    sender_id: string;
    content: string;
    timestamp: number;
  }>;
  host_progress?: number; // host's progress in seconds
  host_progress_timestamp?: number; // when host's progress was measured
  host_state?: string; // playing or paused
  host_duration?: number; // total duration in seconds
  user_progress?: number; // user's own progress in seconds
  guest_progress?: Record<string, number>; // UUID -> progress in seconds for each guest
  guest_progress_timestamp?: number; // when guest progress was last updated
  activity_id?: string; // current/host's activity_id
  is_user_host?: boolean; // true if the user is the host
  user_nickname?: string; // current user's nickname for sending messages
  co_watcher_activities?: Record<string, {activity_id: string; content: string; favicon?: string}>; // UUID -> current activity for divergence display
}

export class OverlayUI {
  private container: HTMLElement | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private progressUpdateInterval: NodeJS.Timeout | null = null;
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartLeft = 0;
  private dragStartTop = 0;
  private isResizing = false;
  private resizeStartX = 0;
  private resizeStartY = 0;
  private resizeStartWidth = 0;
  private resizeStartHeight = 0;
  private readonly MIN_WIDTH = 280;
  private readonly MAX_WIDTH = 650;
  private readonly MIN_HEIGHT = 300;
  private userColorMap: Map<string, string> = new Map(); // sender_uuid -> color
  private nicknameMap: Map<string, string> = new Map(); // sender_uuid -> display name
  private initialMouseMoveListener: ((e: MouseEvent) => void) | null = null; // Store listener reference for cleanup
  private _eventListenersSetup = false; // Guard to ensure listeners only set up once
  private hoverTimeout: NodeJS.Timeout | null = null; // Delay for hover detection
  private initTime = Date.now(); // Track when overlay was initialized
  private _state: OverlayState = {
    visible: false,
    pinned: false,
    opacity: 80,
    session_members: [],
    watching_together: [],
    messages: [],
  };
  private port: chrome.runtime.Port | null = null;

  constructor(private userId: string) {}

  /**
   * Set up nickname map for display name lookups
   * Call this after overlay init to map uuids to display names
   */
  setNicknameMap(map: Record<string, string>): void {
    this.nicknameMap.clear();
    for (const [uuid, nickname] of Object.entries(map)) {
      this.nicknameMap.set(uuid, nickname);
    }
  }

  /**
   * Set the port for sending messages to background
   */
  setPort(port: chrome.runtime.Port): void {
    this.port = port;
  }

  /**
   * Get current overlay state (read-only access)
   */
  get state(): Readonly<OverlayState> {
    return this._state as Readonly<OverlayState>;
  }

  /**
   * Initialize overlay on page
   */
  init(): void {
    const existingCount = document.querySelectorAll('#hang-time-overlay').length;
    console.debug(`[OverlayUI] init() - userId=${this.userId}, existing overlays=${existingCount}`);

    this.createOverlayContainer();
    this.startProgressAnimation();
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
          background: rgba(0, 0, 0, 0.95);
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
          z-index: 9999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: white;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          transition: opacity 0.2s ease;
          opacity: 0.8;
          pointer-events: auto;
        }

        #hang-time-overlay.hidden {
          opacity: 0;
          pointer-events: auto;
        }

        #resize-handle {
          position: absolute;
          bottom: 0;
          right: 0;
          width: 20px;
          height: 20px;
          cursor: nwse-resize;
          user-select: none;
          background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.2) 50%);
          border-radius: 0 0 8px 0;
        }

        #resize-handle:hover {
          background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.4) 50%);
        }

        .overlay-header {
          padding: 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          cursor: grab;
          user-select: none;
        }

        .overlay-header:active {
          cursor: grabbing;
        }

        .header-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }

        .video-title {
          font-size: 14px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.5);
          flex: 1;
        }

        .progress-bar-wrapper {
          display: flex;
          gap: 8px;
          align-items: center;
          flex: 1;
        }

        .progress-bar-container {
          flex: 1;
          height: 8px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          overflow: visible;
          position: relative;
          display: flex;
          align-items: center;
        }

        #progress-sync-button {
          display: none;
          padding: 4px 6px;
          background: rgba(255, 255, 255, 0.15);
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: white;
          border-radius: 3px;
          cursor: pointer;
          font-size: 11px;
          white-space: nowrap;
          transition: all 0.2s ease;
        }

        #progress-sync-button:hover {
          background: rgba(255, 255, 255, 0.25);
        }

        .progress-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, #10b981, #059669);
          width: 0%;
          transition: width 0.1s linear;
        }

        .progress-bar-marker {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          left: 0%;
          width: 16px;
          height: 20px;
          background: #ef4444;
          transition: left 0.1s linear;
          user-select: none;
          pointer-events: none;
        }

        .progress-bar-marker.arrow-right {
          clip-path: polygon(0% 0%, 0% 100%, 100% 50%);
        }

        .progress-bar-marker.arrow-left {
          clip-path: polygon(100% 0%, 100% 100%, 0% 50%);
        }

        .progress-bar-host-marker {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: 3px;
          height: 20px;
          background: #3b82f6;
          left: 0%;
          transition: left 0.1s linear;
          box-shadow: 0 0 4px rgba(59, 130, 246, 0.8);
          pointer-events: none;
        }

        .attendees-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          margin-bottom: 8px;
        }

        .attendees-label {
          color: rgba(255, 255, 255, 0.6);
          font-size: 11px;
          min-width: 38px;
          font-weight: 600;
        }

        #guest-chips-container {
          display: flex;
          gap: 6px;
          align-items: center;
          flex-wrap: wrap;
        }

        .attendee-chip {
          display: inline-flex;
          align-items: center;
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 12px;
          color: white;
          font-weight: 500;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
        }

        .progress-bar-controls {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .guest-markers-container {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
        }

        .guest-marker {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: 2px;
          height: 16px;
          left: 0%;
          transition: left 0.1s linear;
        }

        .user-position-marker {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: 2px;
          height: 16px;
          background: #ef4444;
          left: 0%;
          transition: left 0.1s linear;
          pointer-events: none;
          z-index: 10;
        }

        .gap-indicator {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          height: 2px;
          background: #ef4444;
          left: 0%;
          transition: left 0.1s linear, width 0.1s linear;
          pointer-events: none;
          z-index: 5;
        }

        .host-state-indicator {
          min-width: 24px;
          font-size: 11px;
          color: rgba(255, 255, 255, 0.6);
          text-align: center;
        }

        .host-state-indicator.host-state-playing {
          color: #4ade80;
        }

        .icon-buttons {
          display: flex;
          gap: 6px;
          align-items: center;
          flex-shrink: 0;
        }

        .icon-button {
          width: 20px;
          height: 20px;
          padding: 0;
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.4);
          border-radius: 2px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
          font-size: 12px;
        }

        .icon-button:hover {
          border-color: rgba(255, 255, 255, 0.7);
        }

        #pin-button.pinned {
          background: #ff6b6b;
          border-color: #ff6b6b;
        }

        #discord-button {
          width: 20px;
          height: 20px;
          padding: 0;
          background-size: 18px 18px;
          background-position: center;
          background-repeat: no-repeat;
          background-color: transparent;
          border: 1px solid rgba(255, 255, 255, 0.4);
          border-radius: 2px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        #discord-button:hover {
          border-color: rgba(255, 255, 255, 0.7);
          opacity: 0.9;
        }

        .opacity-slider {
          width: 60px;
          height: 6px;
          cursor: pointer;
          accent-color: #6b7280;
          flex-shrink: 0;
          -webkit-appearance: none;
          appearance: none;
          background: rgba(107, 114, 128, 0.3);
          border-radius: 3px;
          outline: none;
        }

        .opacity-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #6b7280;
          cursor: pointer;
        }

        .opacity-slider::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #6b7280;
          cursor: pointer;
          border: none;
        }

        .opacity-slider::-moz-range-track {
          background: transparent;
          border: none;
        }

        .sync-button:hover {
          background: rgba(45, 166, 255, 0.9);
        }

        #discord-button {
          background-size: 18px 18px;
          background-position: center;
          background-repeat: no-repeat;
          font-size: 0;
        }

        #discord-button:hover {
          opacity: 0.8;
        }

        .hang-time-chat-container {
          flex: 1;
          overflow-y: auto;
          padding: 8px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .chat-message {
          display: flex;
          gap: 4px;
          font-size: 13px;
          line-height: 1.4;
          align-items: baseline;
        }

        .message-user {
          flex-direction: row-reverse;
        }

        .message-content {
          max-width: 80%;
          padding: 4px 8px;
          border-radius: 3px;
          word-wrap: break-word;
          flex: 0 1 auto;
        }

        .message-friend .message-content {
          background: rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.9);
        }

        .message-user .message-content {
          background: rgba(96, 165, 250, 0.3);
          color: white;
        }

        .message-sender {
          font-size: 12px;
          font-weight: 600;
          white-space: nowrap;
          flex-shrink: 0;
        }

        .message-input-container {
          padding: 8px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          display: flex;
          gap: 6px;
          align-items: flex-end;
        }

        #message-input {
          flex: 1;
          min-height: 20px;
          max-height: 60px;
          padding: 4px 6px;
          background: rgba(255, 255, 255, 0.05);
          border: none;
          border-radius: 2px;
          color: white;
          font-size: 12px;
          font-family: inherit;
          resize: none;
          outline: none;
          overflow-y: auto;
        }

        #message-input::placeholder {
          color: rgba(255, 255, 255, 0.3);
        }

        #message-input:focus {
          background: rgba(255, 255, 255, 0.08);
        }

        #send-button {
          padding: 4px 8px;
          background: transparent;
          border: none;
          color: rgba(255, 255, 255, 0.5);
          cursor: pointer;
          font-size: 14px;
          transition: color 0.2s;
        }

        #send-button:hover {
          color: rgba(255, 255, 255, 0.8);
        }

        #send-button:active {
          color: #4ade80;
        }
      </style>

      <div class="overlay-header">
        <div class="header-top">
          <div class="video-title" id="overlay-title">Loading...</div>
          <div class="icon-buttons">
            <input type="range" min="10" max="100" value="80" class="opacity-slider" id="opacity-slider" title="Overlay opacity">
            <button class="icon-button" id="discord-button" title="Open Discord with host"></button>
            <button class="icon-button" id="pin-button" title="Pin overlay">📌</button>
          </div>
        </div>
        <!-- Line 1: Watching label + progress bar + sync button -->
        <div class="watching-together-row" id="watching-together-row" style="margin-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="watching-together-label" style="flex-shrink: 0;">Watching:</div>
            <div class="progress-bar-wrapper" style="flex: 1;">
              <div class="progress-bar-container">
                <div class="progress-bar-fill" id="progress-bar-fill"></div>
                <div class="guest-markers-container" id="guest-markers-container"></div>
                <div class="gap-indicator" id="gap-indicator" style="display: none;"></div>
                <div class="user-position-marker" id="user-position-marker" style="display: none;"></div>
                <div class="progress-bar-marker" id="progress-bar-marker"></div>
              </div>
              <div class="progress-bar-controls">
                <div class="host-state-indicator" id="host-state-indicator">-</div>
                <button id="progress-sync-button" title="Sync to host position">↻</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Line 2: Host chip + (host) | favicon title -->
        <div id="host-chip-container" style="margin-bottom: 8px;"></div>

        <!-- Line 3: Guest chips -->
        <div id="guest-chips-container" style="display: flex; gap: 4px; margin-bottom: 8px;"></div>

        <!-- Divergence display: for when < 2 watching together -->
        <div id="guest-rows-container"></div>
      </div>


      <div class="hang-time-chat-container" id="hang-time-chat-container">
        <div style="text-align: center; color: rgba(255, 255, 255, 0.5); font-size: 12px;">No messages yet</div>
      </div>

      <div class="message-input-container">
        <textarea id="message-input" placeholder="Send a message..." rows="1"></textarea>
        <button id="send-button" title="Send message">↑</button>
      </div>

      <div id="resize-handle" title="Drag to resize"></div>
    `;

    // Wait for document.body if it's not ready yet
    if (!document.body) {
      console.debug('[OverlayUI] document.body not ready, deferring appendChild');
      const checkBody = setInterval(() => {
        if (document.body && this.container && !this.container.parentElement) {
          document.body.appendChild(this.container);
          this.restoreSizeFromStorage();
          this.setupOpacitySlider();
          this.setupEventListeners();
          clearInterval(checkBody);
        }
      }, 50);
      return;
    }

    document.body.appendChild(this.container);
    this.restoreSizeFromStorage();
    this.setupOpacitySlider();
    this.setupEventListeners();
    // Render any state that was set before the overlay was added to DOM
    if (this._state.session_members.length > 0) {
      this.render();
    }
  }

  /**
   * Restore overlay size from storage
   */
  private restoreSizeFromStorage(): void {
    if (!this.container) return;
    const userProfile = storageManager.getUserProfile();
    if (userProfile && userProfile.overlay_size) {
      const { width, height } = userProfile.overlay_size;
      this.container.style.width = width + 'px';
      this.container.style.maxHeight = height + 'px';
    }
  }

  /**
   * Setup opacity slider
   */
  private setupOpacitySlider(): void {
    const slider = document.getElementById('opacity-slider') as HTMLInputElement;
    if (!slider) return;

    slider.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value;
      this._state.opacity = parseInt(value);
      this.updateOpacity();
    });

    this.updateOpacity();
  }

  /**
   * Update overlay opacity
   */
  private updateOpacity(): void {
    if (!this.container) return;
    // Don't apply opacity if overlay is hidden - let CSS hide rule take precedence
    if (this.container.classList.contains('hidden')) {
      return;
    }
    const opacity = this._state.opacity / 100;
    this.container.style.opacity = opacity.toString();
  }

  /**
   * Setup global event listeners
   */
  private setupEventListeners(): void {
    // Guard: only set up once per overlay instance
    if (this._eventListenersSetup) {
      return;
    }
    this._eventListenersSetup = true;

    // Always set up discovery listener - let show() decide visibility based on watching_together
    if (!this.initialMouseMoveListener && this.container) {
      this.initialMouseMoveListener = (e: MouseEvent) => {
        if (!this.container) return;

        const rect = this.container.getBoundingClientRect();
        const isOverlay = e.clientX >= rect.left && e.clientX <= rect.right &&
                         e.clientY >= rect.top && e.clientY <= rect.bottom;

        if (isOverlay) {
          this.show();
        }
      };
      document.addEventListener('mousemove', this.initialMouseMoveListener);
    }


    // Delay hover listeners to avoid catching synthetic mouseenter events during initialization
    window.setTimeout(() => {
      if (!this.container) return;

      this.container.addEventListener('mouseenter', (e) => {
        // Disable discovery listener permanently once user discovers overlay via hover
        // Only hover listeners (mouseenter/mouseleave) control visibility after discovery
        if (this.initialMouseMoveListener) {
          document.removeEventListener('mousemove', this.initialMouseMoveListener);
          this.initialMouseMoveListener = null;
        }
        // Delay show by 200ms to require actual hovering, not just a quick touch
        if (this.hoverTimeout) {
          clearTimeout(this.hoverTimeout);
        }
        this.hoverTimeout = window.setTimeout(() => {
          this.show();
          this.hoverTimeout = null;
        }, 200);
      });

      // Hide with fade when mouse leaves overlay
      this.container.addEventListener('mouseleave', (e) => {
        // Cancel pending hover-show if user leaves before 200ms
        if (this.hoverTimeout) {
          clearTimeout(this.hoverTimeout);
          this.hoverTimeout = null;
        }
        if (!this._state.pinned) {
          this.startFadeOut();
        }
      });
    }, 150);

    // Handle dragging and resizing
    document.addEventListener('mousemove', (e) => {
      if (this.isDragging && this.container) {
        const deltaX = e.clientX - this.dragStartX;
        const deltaY = e.clientY - this.dragStartY;
        this.container.style.left = (this.dragStartLeft + deltaX) + 'px';
        this.container.style.top = (this.dragStartTop + deltaY) + 'px';
        this.container.style.right = 'auto';
      }

      if (this.isResizing && this.container) {
        const deltaX = e.clientX - this.resizeStartX;
        const deltaY = e.clientY - this.resizeStartY;

        let newWidth = this.resizeStartWidth + deltaX;
        let newHeight = this.resizeStartHeight + deltaY;

        // Apply constraints
        newWidth = Math.max(this.MIN_WIDTH, Math.min(newWidth, this.MAX_WIDTH));
        newHeight = Math.max(this.MIN_HEIGHT, Math.min(newHeight, window.innerHeight - 80));

        this.container.style.width = newWidth + 'px';
        this.container.style.maxHeight = newHeight + 'px';
      }
    });

    // Stop dragging/resizing on mouse up
    document.addEventListener('mouseup', () => {
      if (this.isResizing && this.container) {
        this.isResizing = false;
        // Save size to storage
        const rect = this.container.getBoundingClientRect();
        const profile = storageManager.getUserProfile();
        if (profile) {
          profile.overlay_size = {
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
          storageManager.setUserProfile(profile);
        }
      }
      this.isDragging = false;
    });

    // Start dragging on header mouse down
    if (this.container) {
      const header = this.container.querySelector('.overlay-header') as HTMLElement;
      if (header) {
        header.addEventListener('mousedown', (e: MouseEvent) => {
          this.isDragging = true;
          this.dragStartX = e.clientX;
          this.dragStartY = e.clientY;
          const rect = this.container!.getBoundingClientRect();
          this.dragStartLeft = rect.left;
          this.dragStartTop = rect.top;
        });
      }

      // Start resizing on resize handle mouse down
      const resizeHandle = this.container.querySelector('#resize-handle') as HTMLElement;
      if (resizeHandle) {
        resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
          e.stopPropagation(); // Prevent triggering drag
          this.isResizing = true;
          this.resizeStartX = e.clientX;
          this.resizeStartY = e.clientY;
          const rect = this.container!.getBoundingClientRect();
          this.resizeStartWidth = rect.width;
          this.resizeStartHeight = rect.height;
        });
      }
    }

    // Pin button
    const pinButton = document.getElementById('pin-button');
    if (pinButton) {
      pinButton.addEventListener('click', () => this.togglePin());
    }

    // Discord button
    const discordButton = document.getElementById('discord-button');
    if (discordButton) {
      // Set Discord icon using chrome.runtime.getURL for proper extension URL
      try {
        const iconUrl = chrome.runtime.getURL('public/icons/discord.png');
        discordButton.style.backgroundImage = `url('${iconUrl}')`;
      } catch (e) {
        console.debug('[OverlayUI] Could not load Discord icon:', e);
      }
      discordButton.addEventListener('click', () => this.onDiscordClick());
    }

    // Sync button (for non-hosts only)
    const syncButton = document.getElementById('progress-sync-button');
    if (syncButton) {
      syncButton.addEventListener('click', () => this.onSyncClick());
    }

    // Message input and send button
    const messageInput = document.getElementById('message-input') as HTMLTextAreaElement;
    const sendButton = document.getElementById('send-button');

    console.debug('[OverlayUI] Setup message handlers - input:', !!messageInput, 'button:', !!sendButton);

    if (messageInput) {
      // Auto-expand textarea as user types
      messageInput.addEventListener('input', (e) => {
        const textarea = e.target as HTMLTextAreaElement;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 60) + 'px';
      });

      // Send on Enter (Shift+Enter for newline)
      messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          console.debug('[OverlayUI] Enter pressed, sending message');
          this.onSendMessage(messageInput);
        }
      });
    } else {
      console.warn('[OverlayUI] Message input not found');
    }

    if (sendButton) {
      sendButton.addEventListener('click', () => {
        console.debug('[OverlayUI] Send button clicked');
        this.onSendMessage(messageInput);
      });
    } else {
      console.warn('[OverlayUI] Send button not found');
    }
  }

  /**
   * Send message
   */
  private onSendMessage(input: HTMLTextAreaElement | null): void {
    if (!input || !this.port) return;

    const content = input.value.trim();
    if (!content) return;

    // Immediately add message to overlay for sender
    this.addMessage(this._state.user_nickname || 'You', this.userId, content);

    // Send message via port
    this.port.postMessage({
      type: 'SEND_MESSAGE',
      data: {
        content,
        activity_id: this._state.activity_id,
      }
    });

    // Clear input and reset height
    input.value = '';
    input.style.height = '20px';
  }

  /**
   * Handle join button click for diverged guest's video
   */
  private handleJoinGuest(friendUuid: string): void {
    if (!this.port) return;

    const guestActivity = this._state.co_watcher_activities?.[friendUuid];
    if (!guestActivity) {
      console.warn('[OverlayUI] No activity found for guest:', friendUuid);
      return;
    }

    console.log('[OverlayUI] User clicked join for guest:', friendUuid, 'activity:', guestActivity.activity_id);

    // Send message to content script to navigate to guest's video
    // Content script will handle opening the URL
    this.port.postMessage({
      type: 'JOIN_GUEST_ACTIVITY',
      data: {
        guest_uuid: friendUuid,
        activity_id: guestActivity.activity_id,
        url: guestActivity.content, // This might be title, not URL - backend will need to provide URL
      }
    });
  }

  /**
   * Find the host's UUID by matching their nickname in the nicknameMap
   */
  private getHostUuid(): string | undefined {
    if (this._state.is_user_host) {
      return this.userId;
    }

    // Find the UUID in watching_together that has the host_nickname
    for (const uuid of this._state.watching_together || []) {
      if (this.nicknameMap.get(uuid) === this._state.host_nickname) {
        return uuid;
      }
    }

    return undefined;
  }

  /**
   * Get participant color based on their role:
   * - Host: always green
   * - Non-host self: always red
   * - Others: fixed mapped color
   */
  private getParticipantColor(uuid: string | undefined): string {
    if (!uuid) {
      return '#6b7280'; // Gray fallback
    }

    const hostUuid = this.getHostUuid();

    // Rule 1: Host is always green
    if (uuid === hostUuid) {
      return '#10b981';
    }

    // Rule 2: Current user (not host) is always red
    if (uuid === this.userId) {
      return '#ef4444';
    }

    // Rule 3: Other guests get fixed mapped color
    if (this.userColorMap.has(uuid)) {
      return this.userColorMap.get(uuid)!;
    }

    // Deterministic color palette for other guests
    const guestColors = [
      '#f59e0b', // amber
      '#06b6d4', // cyan
      '#8b5cf6', // violet
      '#ec4899', // pink
      '#6366f1', // indigo
      '#14b8a6', // teal
      '#f97316', // orange
    ];

    let hash = 0;
    for (let i = 0; i < uuid.length; i++) {
      hash = ((hash << 5) - hash) + uuid.charCodeAt(i);
      hash = hash & hash;
    }

    const color = guestColors[Math.abs(hash) % guestColors.length];
    this.userColorMap.set(uuid, color);
    return color;
  }

  /**
   * Show overlay (only if there's an active co-watch session or pinned)
   */
  show(): void {
    if (!this.container) return;

    // Only show if:
    // 1. 2+ session members are online (have activity < 1 hour old)
    // 2. OR the overlay is pinned
    const ONE_HOUR_MS = 60 * 60 * 1000;
    let onlineMembers = 0;
    const sessionMembers = this._state.session_members || [];

    for (const uuid of sessionMembers) {
      const activity = this._state.co_watcher_activities?.[uuid];
      const lastMeasuredAt = activity?.metadata?.progress_measured_at || activity?.timestamp;
      if (lastMeasuredAt) {
        const timeSinceLastSeen = Date.now() - lastMeasuredAt;
        if (timeSinceLastSeen < ONE_HOUR_MS) {
          onlineMembers++;
        }
      }
    }

    const hasCoWatchSession = onlineMembers >= 2;
    if (!hasCoWatchSession && !this._state.pinned) {
      return;
    }

    // Cancel any pending fade-out
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.fadeTimeoutId) clearTimeout(this.fadeTimeoutId);
    this.hideTimer = null;
    this.fadeTimeoutId = null;

    // Show overlay - CSS handles opacity via .hidden class and slider
    this.container.style.transition = '';
    this.container.classList.remove('hidden');
    this._state.visible = true;
  }

  /**
   * Hide overlay
   */
  hide(): void {
    if (!this.container) return;
    this.container.classList.add('hidden');
    this._state.visible = false;
  }

  /**
   * Fade out overlay: wait 3 seconds then fade over 3 seconds then hide
   */
  private startFadeOut(): void {
    if (!this.container || this._state.pinned) return;

    // Cancel any existing timers
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.fadeTimeoutId) clearTimeout(this.fadeTimeoutId);

    // Wait 3 seconds before starting fade
    this.hideTimer = window.setTimeout(() => {
      if (!this.container) return;

      // Set up CSS transition for smooth fade (3 second fade)
      this.container.style.transition = 'opacity 3s ease-out';
      this.container.style.opacity = '0';

      // Hide after fade completes
      this.fadeTimeoutId = window.setTimeout(() => {
        this.hide();
        // Reset transition and timeouts
        if (this.container) {
          this.container.style.transition = '';
        }
        this.fadeTimeoutId = null;
        this.hideTimer = null;
      }, 3000);
    }, 3000);
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
    this._state.pinned = !this._state.pinned;
    const button = document.getElementById('pin-button');
    if (button) {
      if (this._state.pinned) {
        button.classList.add('pinned');
      } else {
        button.classList.remove('pinned');
      }
    }
    if (this._state.pinned) {
      if (this.hideTimer) clearTimeout(this.hideTimer);
    }
    console.debug('[OverlayUI] Pin toggled:', this._state.pinned);
  }

  /**
   * Sync button clicked
   */
  private onSyncClick(): void {
    console.debug('[OverlayUI] Sync button clicked, activity:', this._state.activity_id);
    window.postMessage({ type: 'HANG_TIME_SYNC_REQUEST', data: { activity_id: this._state.activity_id } }, '*');
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
    this._state = { ...this._state, ...newState };

    // If co-watch session ended (no more session members), hide the overlay
    // Use session_members (all members) not watching_together (only same activity)
    // so overlay stays visible even in divergence mode
    if (this._state.session_members.length === 0) {
      this.hide();
    } else {
      this.render();
      // Auto-show overlay when there's an active co-watch session
      // (user should see it immediately, not wait for mouse interaction)
      this.show();
    }
  }

  /**
   * Render all UI elements
   */
  private render(): void {
    // Guard: only render if overlay is in DOM (container has parent)
    if (!this.container || !this.container.parentElement) {
      console.debug('[OverlayUI] Overlay not yet in DOM, deferring render');
      return;
    }
    this.renderHeader();
    this.renderHostRow();
    this.renderGuestRow();
    this.renderMessages();
  }

  /**
   * Render header (title + progress bar)
   */
  private renderHeader(): void {
    const titleEl = document.getElementById('overlay-title');
    if (titleEl) {
      titleEl.textContent = 'Hang Time';
    }

    const fillEl = document.getElementById('progress-bar-fill') as HTMLElement;
    const hostMarkerEl = document.getElementById('progress-bar-host-marker') as HTMLElement;
    const markerEl = document.getElementById('progress-bar-marker') as HTMLElement;
    const syncBtn = document.getElementById('progress-sync-button') as HTMLElement;
    const stateIndicator = document.getElementById('host-state-indicator') as HTMLElement;

    // Update host state indicator
    if (stateIndicator) {
      stateIndicator.classList.remove('host-state-playing');
      if (this._state.host_state === 'playing') {
        stateIndicator.textContent = '▶';
        stateIndicator.classList.add('host-state-playing');
      } else if (this._state.host_state === 'paused') {
        stateIndicator.textContent = '⏸';
      } else {
        stateIndicator.textContent = '-';
      }
    }

    if (fillEl && this._state.host_progress !== undefined && this._state.host_duration && this._state.host_duration > 0) {
      // Simple calculation: progress / duration * 100
      const hostPercent = Math.min((this._state.host_progress / this._state.host_duration) * 100, 100);
      fillEl.style.width = hostPercent + '%';

      // Position host marker at host's current position
      if (hostMarkerEl) {
        hostMarkerEl.style.left = hostPercent + '%';
      }
    }

    // Show arrow marker only if user is NOT the host, has progress, and gap is > 5 seconds
    if (markerEl) {
      console.debug('[OverlayUI] Arrow render check:', {
        is_user_host: this._state.is_user_host,
        user_progress: this._state.user_progress,
        host_progress: this._state.host_progress,
        host_progress_timestamp: this._state.host_progress_timestamp,
        host_duration: this._state.host_duration,
      });

      if (!this._state.is_user_host && this._state.user_progress !== undefined && this._state.host_progress !== undefined && this._state.host_progress_timestamp !== undefined && this._state.host_duration && this._state.host_duration > 0) {
        // Calculate where host actually is now by adding elapsed time since their progress was measured
        // host_progress_timestamp = when host's content script measured their progress (progress_measured_at)
        // elapsed = time from measurement to now
        // Note: progress values are in seconds, elapsed is in ms. Convert ms to seconds for addition.
        // Only extrapolate forward if host is playing, not if paused
        const elapsedSinceHostMeasureMs = Date.now() - this._state.host_progress_timestamp;
        const hostCurrentPosition = this._state.host_state === 'playing'
          ? this._state.host_progress + (elapsedSinceHostMeasureMs / 1000)
          : this._state.host_progress;

        const gap = Math.abs(this._state.user_progress - hostCurrentPosition);
        const SYNC_THRESHOLD = 5; // 5 seconds (gap is in seconds)

        console.debug('[OverlayUI] Arrow gap calculation:', {
          user_progress: this._state.user_progress,
          host_progress: this._state.host_progress,
          hostCurrentPosition,
          elapsedSinceHostMeasureMs: Date.now() - this._state.host_progress_timestamp,
          gap,
          SYNC_THRESHOLD,
          host_state: this._state.host_state,
          showArrow: gap > SYNC_THRESHOLD,
        });

        if (gap > SYNC_THRESHOLD) {
          const userPercent = Math.min((this._state.user_progress / this._state.host_duration) * 100, 100);
          markerEl.style.left = userPercent + '%';

          // Arrow points toward host (use current position, not old measurement)
          markerEl.classList.remove('arrow-left', 'arrow-right');
          if (this._state.user_progress < hostCurrentPosition) {
            markerEl.classList.add('arrow-right'); // User behind, arrow points right (toward host ahead)
            console.debug('[OverlayUI] Arrow RIGHT: user behind', { user: this._state.user_progress, host: hostCurrentPosition });
          } else if (this._state.user_progress > hostCurrentPosition) {
            markerEl.classList.add('arrow-left'); // User ahead, arrow points left (toward host behind)
            console.debug('[OverlayUI] Arrow LEFT: user ahead', { user: this._state.user_progress, host: hostCurrentPosition });
          }

          markerEl.style.display = 'block';
          console.debug('[OverlayUI] Arrow SHOWN at', userPercent + '%');
        } else {
          markerEl.style.display = 'none';
          console.debug('[OverlayUI] Arrow hidden: gap too small');
        }
      } else {
        markerEl.style.display = 'none';
        console.debug('[OverlayUI] Arrow hidden: condition not met');
      }
    }

    // Show host position marker (blue vertical line at right edge of progress bar) for guests
    const hostPositionMarkerEl = document.getElementById('user-position-marker') as HTMLElement;
    const gapIndicatorEl = document.getElementById('gap-indicator') as HTMLElement;

    if (hostPositionMarkerEl || gapIndicatorEl) {
      if (!this._state.is_user_host && this._state.host_progress !== undefined && this._state.user_progress !== undefined && this._state.host_duration && this._state.host_duration > 0) {
        const hostPercent = Math.min((this._state.host_progress / this._state.host_duration) * 100, 100);
        const userPercent = Math.min((this._state.user_progress / this._state.host_duration) * 100, 100);

        // Show host position marker
        if (hostPositionMarkerEl) {
          hostPositionMarkerEl.style.left = hostPercent + '%';
          hostPositionMarkerEl.style.display = 'block';
        }

        // Show gap indicator line between user and host positions
        if (gapIndicatorEl) {
          const startPercent = Math.min(userPercent, hostPercent);
          const endPercent = Math.max(userPercent, hostPercent);
          const gapWidth = endPercent - startPercent;
          gapIndicatorEl.style.left = startPercent + '%';
          gapIndicatorEl.style.width = gapWidth + '%';
          gapIndicatorEl.style.display = 'block';
        }

        console.debug('[OverlayUI] Host position marker shown at', hostPercent + '%, gap from', userPercent + '%');
      } else {
        if (hostPositionMarkerEl) hostPositionMarkerEl.style.display = 'none';
        if (gapIndicatorEl) gapIndicatorEl.style.display = 'none';
        console.debug('[OverlayUI] Host position marker hidden - is_user_host:', this._state.is_user_host);
      }
    }

    // Show sync button only for non-hosts
    if (syncBtn) {
      if (!this._state.is_user_host) {
        syncBtn.style.display = 'block';
      } else {
        syncBtn.style.display = 'none';
      }
    }

    // Update guest marker positions each animation cycle (1s/1s interpolation)
    if (this._state.is_user_host) {
      this.updateGuestMarkers();
    }
  }

  /**
   * REFACTORED: Simple two-mode rendering
   * Host Mode: 2+ watching same video → show host + progress bar
   * Guest Mode: <2 watching same video → show "Choose next:" + guest rows
   */
  private renderHostRow(): void {
    // Determine which mode we're in: count active members on same video (exclude offline users)
    const ONE_HOUR_MS = 60 * 60 * 1000;
    let activeMembersOnSameVideo = 0;

    if (this._state.watching_together) {
      for (const uuid of this._state.watching_together) {
        const activity = this._state.co_watcher_activities?.[uuid];
        const lastMeasuredAt = activity?.metadata?.progress_measured_at || activity?.timestamp;
        if (lastMeasuredAt) {
          const timeSinceLastSeen = Date.now() - lastMeasuredAt;
          if (timeSinceLastSeen < ONE_HOUR_MS) {
            activeMembersOnSameVideo++;
          }
        }
      }
    }

    const isHostMode = activeMembersOnSameVideo >= 2;
    const watchingRow = document.getElementById('watching-together-row');
    const hostContainer = document.getElementById('host-chip-container');
    const guestContainer = document.getElementById('guest-chips-container');
    const guestRowsContainer = document.getElementById('guest-rows-container');

    if (!watchingRow || !hostContainer || !guestContainer || !guestRowsContainer) return;

    if (isHostMode) {
      // HOST MODE: 2+ watching same video
      watchingRow.style.display = '';
      guestRowsContainer.innerHTML = ''; // Hide divergence rows

      // Render host chip + activity
      this.renderHostChip(hostContainer);

      // Render guest chips
      this.renderGuestChips(guestContainer);

      // Render guest markers if user is host
      if (this._state.is_user_host) {
        this.renderGuestMarkers();
      }
    } else {
      // GUEST MODE: <2 watching same video (divergence)
      watchingRow.style.display = 'none';
      hostContainer.innerHTML = '';
      guestContainer.innerHTML = '';

      // Render "Choose next:" with guest rows
      this.renderChooseNextRows(guestRowsContainer);
    }
  }

  /**
   * MODE A: Render host chip with activity info
   * Host is always shown first with the title (associated with progress bar above)
   */
  private renderHostChip(container: HTMLElement): void {
    const hostUuid = this.getHostUuid();
    if (!hostUuid) return;

    let hostName: string;
    if (this._state.is_user_host) {
      hostName = 'You';
    } else {
      hostName = this.nicknameMap.get(hostUuid) || this._state.host_nickname || 'Host';
    }
    hostName = this.escapeHtml(hostName);

    const hostColor = this.getParticipantColor(hostUuid);

    // Build host row: chip | service icon + title (same line as progress bar's video)
    let html = `<div style="display: flex; align-items: center; gap: 8px;">`;
    html += `<div class="attendee-chip" style="background: ${hostColor};"><span>${hostName}</span></div>`;

    // Add host's activity info with service icon
    const activity = this._state.co_watcher_activities?.[hostUuid];
    if (activity) {
      // Map service to icon
      const serviceMap: Record<string, string> = {
        'youtube': 'youtube.png',
        'youtube-tab': 'youtube.png',
        'spotify': 'spotify.png',
        'twitch': 'twitch.png',
        'netflix': 'netflix.png',
        'steam': 'steam.png',
      };

      let iconHtml = '';
      if (activity.service) {
        const icon = serviceMap[activity.service];
        if (icon) {
          try {
            const iconUrl = chrome.runtime.getURL(`public/icons/${icon}`);
            iconHtml = `<img src="${iconUrl}" style="width: 14px; height: 14px; object-fit: contain;" alt="">`;
          } catch (e) {
            // Silent fallback
            iconHtml = '';
          }
        }
      }

      const title = this.escapeHtml(activity.content.substring(0, 40));
      html += `<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: #aaa;">${iconHtml}<span>${title}</span></span>`;
    }

    html += `</div>`;
    container.innerHTML = html;
  }

  /**
   * MODE A: Render guest chips (everyone except host)
   * Guests shown on separate row below host
   */
  private getActivityFreshnessStyle(uuid: string): { shouldHide: boolean; opacity: number } {
    const activity = this._state.co_watcher_activities?.[uuid];

    // Always show self (You) at full opacity, regardless of inactivity
    if (uuid === this.userId) {
      return { shouldHide: false, opacity: 1 };
    }

    // For friends, check progress_measured_at (when content script last ran) for inactivity
    const lastMeasuredAt = activity?.metadata?.progress_measured_at || activity?.timestamp;
    if (!lastMeasuredAt) {
      return { shouldHide: false, opacity: 1 };
    }

    const timeSinceLastSeen = Date.now() - lastMeasuredAt;
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    const ONE_HOUR_MS = 60 * 60 * 1000;

    if (timeSinceLastSeen >= ONE_HOUR_MS) {
      return { shouldHide: true, opacity: 0 }; // Offline - hide
    } else if (timeSinceLastSeen >= FIFTEEN_MIN_MS) {
      return { shouldHide: false, opacity: 0.5 }; // AFK - desaturate
    }
    return { shouldHide: false, opacity: 1 }; // Active - normal
  }

  private renderGuestChips(container: HTMLElement): void {
    // Show all session members (same as Guest Mode)
    // Host/Guest Mode difference is only in the TOP section, not in who's displayed
    const allCoWatchers = this._state.session_members || [];
    const hostUuid = this.getHostUuid();
    const chips: string[] = [];

    for (const uuid of allCoWatchers) {
      if (uuid === hostUuid) continue; // Skip host (shown separately)

      const { shouldHide, opacity } = this.getActivityFreshnessStyle(uuid);
      if (shouldHide) continue; // Hide if offline (10+ min no activity)

      let name: string;
      if (uuid === this.userId) {
        name = 'You';
      } else {
        name = this.nicknameMap.get(uuid) || '';
        if (!name) continue; // Skip if no nickname
        name = this.escapeHtml(name);
      }

      const color = this.getParticipantColor(uuid);
      chips.push(`<div class="attendee-chip" style="background: ${color}; opacity: ${opacity};"><span>${name}</span></div>`);
    }

    if (chips.length > 0) {
      // Wrap guest chips in a flex container for proper spacing
      container.innerHTML = `<div style="display: flex; gap: 4px; flex-wrap: wrap;">${chips.join('')}</div>`;
    } else {
      container.innerHTML = '';
    }
  }

  /**
   * MODE B: Render "Choose next:" section with guest rows
   */
  private renderChooseNextRows(container: HTMLElement): void {
    // Use persistent session members, not ephemeral co_watcher_activities keys
    const sessionMembers = this._state.session_members || [];
    const rows: string[] = [];

    // Add label
    rows.push('<div style="font-size: 12px; color: #aaa; margin-bottom: 8px;">Choose next:</div>');

    for (const uuid of sessionMembers) {
      const { shouldHide, opacity } = this.getActivityFreshnessStyle(uuid);
      if (shouldHide) continue; // Hide if offline (10+ min no activity)

      let name: string;
      if (uuid === this.userId) {
        name = 'You';
      } else {
        name = this.nicknameMap.get(uuid) || '';
        if (!name) continue;
        name = this.escapeHtml(name);
      }

      const color = this.getParticipantColor(uuid);
      const activity = this._state.co_watcher_activities?.[uuid];
      const isWatching = activity && activity.activity_id;

      let row: string;
      if (isWatching) {
        // Get service icon
        const serviceMap: Record<string, string> = {
          'youtube': 'youtube.png',
          'youtube-tab': 'youtube.png',
          'spotify': 'spotify.png',
          'twitch': 'twitch.png',
          'netflix': 'netflix.png',
          'steam': 'steam.png',
        };
        let iconHtml = '';
        if (activity.service && serviceMap[activity.service]) {
          try {
            const iconUrl = chrome.runtime.getURL(`public/icons/${serviceMap[activity.service]}`);
            iconHtml = `<img src="${iconUrl}" style="width: 14px; height: 14px; object-fit: contain; flex-shrink: 0;" alt="">`;
          } catch (e) {
            // Silent fallback
          }
        }

        const title = this.escapeHtml(activity.content.substring(0, 40));
        row = `
          <div style="display: grid; grid-template-columns: 60px 14px 1fr 14px; align-items: center; gap: 8px; height: 24px; font-size: 12px; opacity: ${opacity};">
            <div class="attendee-chip" style="background: ${color};"><span>${name}</span></div>
            <div style="display: flex; align-items: center; justify-content: center; width: 14px;">
              ${iconHtml}
            </div>
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #aaa;">${title}</span>
            <button class="join-button" data-uuid="${uuid}" style="background: none; border: none; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center;">
              <svg viewBox="0 0 24 24" fill="#4CAF50" stroke="none" style="width: 14px; height: 14px;">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </button>
          </div>
        `;
      } else {
        row = `<div style="padding: 2px 0; opacity: ${opacity};"><div class="attendee-chip" style="background: ${color};"><span>${name}</span></div></div>`;
      }
      rows.push(row);
    }

    if (rows.length === 1) {
      // Only label, no guests
      container.innerHTML = '';
    } else {
      container.innerHTML = rows.join('');

      // Attach join listeners
      for (const btn of container.querySelectorAll('.join-button')) {
        btn.addEventListener('click', (e) => {
          const uuid = (e.target as HTMLElement).getAttribute('data-uuid');
          if (uuid) this.handleJoinGuest(uuid);
        });
      }
    }
  }

  /**
   * Render colored markers for each guest on the progress bar (host view only)
   */
  private renderGuestMarkers(): void {
    const container = document.getElementById('guest-markers-container');
    if (!container || !this._state.watching_together) return;

    container.innerHTML = '';

    for (const uuid of this._state.watching_together) {
      if (uuid === this.userId) continue;

      // Skip offline members (10+ min no activity)
      const { shouldHide } = this.getActivityFreshnessStyle(uuid);
      if (shouldHide) continue;

      const color = this.getParticipantColor(uuid);
      const marker = document.createElement('div');
      marker.className = 'guest-marker';
      marker.style.background = color;
      marker.id = `guest-marker-${uuid}`;
      container.appendChild(marker);
    }

    this.updateGuestMarkers();
  }

  /**
   * Update positions of guest markers based on their progress (called from CO_WATCH_UPDATE handler)
   */
  private updateGuestMarkers(): void {
    if (!this._state.guest_progress || !this._state.watching_together || !this._state.host_duration || this._state.host_duration <= 0) {
      return;
    }

    const hostUuid = this.getHostUuid();

    for (const uuid of this._state.watching_together) {
      // Skip self and host
      if (uuid === this.userId || uuid === hostUuid) continue;

      const baseProgress = this._state.guest_progress[uuid];
      if (baseProgress === undefined) continue;

      const marker = document.getElementById(`guest-marker-${uuid}`) as HTMLElement;
      if (!marker) continue;

      // Calculate guest's current position with interpolation
      // Only extrapolate if host is playing (guests move with host's playback state)
      const elapsedMs = this._state.guest_progress_timestamp ? Date.now() - this._state.guest_progress_timestamp : 0;
      const guestCurrentPosition = this._state.host_state === 'playing'
        ? baseProgress + (elapsedMs / 1000)
        : baseProgress;

      // Calculate position percentage
      const guestPercent = Math.min((guestCurrentPosition / this._state.host_duration) * 100, 100);
      marker.style.left = guestPercent + '%';
    }
  }

  /**
   * Simplified guest row rendering (delegated to renderHostRow)
   */
  private renderGuestRow(): void {
    // All logic moved to renderHostRow which handles both modes
    // This method is called from render() to maintain consistency
  }

  /**
   * Render chat messages
   */
  private renderMessages(): void {
    const container = document.getElementById('hang-time-chat-container');
    if (!container) {
      console.warn('[OverlayUI] Chat container not found');
      return;
    }

    if (this._state.messages.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: rgba(255, 255, 255, 0.5); font-size: 12px;">No messages yet</div>';
      return;
    }

    const validMessages = this._state.messages.filter(msg => msg && msg.content);

    if (validMessages.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: rgba(255, 255, 255, 0.5); font-size: 12px;">No messages yet</div>';
      return;
    }

    const html = validMessages
      .map(msg => {
        const isUser = msg.sender_id === this.userId;
        // Get color using participant color rules - same as chips
        const userColor = this.getParticipantColor(msg.sender_id);
        // Use "You" for user's own messages, otherwise lookup display name from state nicknameMap
        const displayName = isUser ? 'You' : (this._state.nicknameMap?.[msg.sender_id] || msg.sender || 'Unknown');
        return `
          <div class="chat-message ${isUser ? 'message-user' : 'message-friend'}">
            <div class="attendee-chip" style="background: ${userColor}; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);">${this.escapeHtml(displayName)}</div>
            <div class="message-content" style="background: rgba(255, 255, 255, 0.08); color: white;">${this.linkifyContent(msg.content)}</div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = html;

    // Auto-scroll to bottom
    if (container.scrollHeight > 0) {
      container.scrollTop = container.scrollHeight;
    }
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
   * Linkify URLs in text while escaping for XSS safety
   */
  private linkifyContent(text: string): string {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const escaped = this.escapeHtml(text);
    return escaped.replace(urlRegex, (url) => {
      const safeUrl = this.escapeHtml(url);
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color: #60a5fa; text-decoration: underline;">${safeUrl}</a>`;
    });
  }

  /**
   * Add message to chat
   */
  addMessage(sender: string, senderId: string, content: string): void {
    this._state.messages.push({
      id: Date.now().toString(),
      sender,
      sender_id: senderId,
      content,
      timestamp: Date.now(),
    });

    // Keep only last 50 messages
    if (this._state.messages.length > 50) {
      this._state.messages = this._state.messages.slice(-50);
    }

    this.renderMessages();
  }

  /**
   * Start progress bar animation loop (updates every second to simulate 1sec/1sec playback)
   */
  private startProgressAnimation(): void {
    if (this.progressUpdateInterval) {
      clearInterval(this.progressUpdateInterval);
    }
    this.progressUpdateInterval = setInterval(() => {
      this.renderHeader();
    }, 1000);
  }

  /**
   * Destroy overlay
   */
  destroy(): void {
    console.debug('[OverlayUI] destroy() called for userId:', this.userId);
    // Clean up event listeners and timers
    if (this.initialMouseMoveListener) {
      document.removeEventListener('mousemove', this.initialMouseMoveListener);
      this.initialMouseMoveListener = null;
    }
    if (this.hoverTimeout) {
      clearTimeout(this.hoverTimeout);
      this.hoverTimeout = null;
    }
    if (this.container) {
      console.debug('[OverlayUI] Removing container from DOM');
      this.container.remove();
      this.container = null;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
    }
    if (this.fadeTimeoutId) {
      clearTimeout(this.fadeTimeoutId);
    }
    if (this.progressUpdateInterval) {
      clearInterval(this.progressUpdateInterval);
    }
    console.debug('[OverlayUI] Destroy complete');
  }
}
