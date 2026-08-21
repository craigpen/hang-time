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
  co_watcher_activities?: Record<string, {activity_id: string; content: string; url?: string; service?: string; favicon?: string; freshness_timestamp?: number; timestamp?: number; metadata?: any}>; // UUID -> current activity for divergence display
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
  private initTime = Date.now(); // Track when overlay was initialized
  private syncInProgress = false; // Track if sync is pending completion
  private windowMessageHandler: ((event: MessageEvent) => void) | null = null; // Store for cleanup
  private lastUserProgressUpdate: number = 0; // Track when user_progress was last set (for extrapolation)
  private markersVisible = false; // Track current visibility state for hysteresis
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
          background: rgba(15, 23, 42, 0.88);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
          z-index: 9999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
          color: white;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          transition: opacity 0.2s ease, transform 0.2s ease;
          opacity: var(--overlay-opacity, 0.85);
          pointer-events: auto;
        }

        #hang-time-overlay.hidden {
          opacity: 0 !important;
          pointer-events: none !important;
          visibility: hidden !important;
        }

        #hang-time-overlay.fading-out {
          transition: opacity 3s ease-out !important;
          opacity: 0 !important;
          pointer-events: auto;
        }

        #resize-handle {
          position: absolute;
          bottom: 0;
          right: 0;
          width: 18px;
          height: 18px;
          cursor: nwse-resize;
          user-select: none;
          background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.25) 50%);
          border-radius: 0 0 12px 0;
        }

        #resize-handle:hover {
          background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.5) 50%);
        }

        .overlay-header {
          padding: 10px 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          cursor: grab;
          user-select: none;
          background: rgba(255, 255, 255, 0.02);
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
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.3px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: rgba(255, 255, 255, 0.95);
          flex: 1;
        }

        .overlay-role-row {
          display: flex;
          align-items: center;
          gap: 6px;
          min-height: 20px;
        }

        .overlay-role-label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.45);
          min-width: 44px;
          flex-shrink: 0;
        }

        .video-title-row {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: rgba(255, 255, 255, 0.85);
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .media-title-text {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .progress-bar-wrapper {
          display: flex;
          gap: 8px;
          align-items: center;
          flex: 1;
        }

        .progress-bar-container {
          flex: 1;
          height: 6px;
          background: rgba(255, 255, 255, 0.15);
          border-radius: 3px;
          overflow: visible;
          position: relative;
          display: flex;
          align-items: center;
        }

        .progress-time-display {
          font-size: 10px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          color: rgba(255, 255, 255, 0.6);
          white-space: nowrap;
        }

        #progress-sync-button {
          display: none;
          padding: 2px 6px;
          background: rgba(255, 255, 255, 0.12);
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: white;
          border-radius: 4px;
          cursor: pointer;
          font-size: 11px;
          white-space: nowrap;
          transition: all 0.2s ease;
        }

        #progress-sync-button:hover {
          background: rgba(255, 255, 255, 0.22);
          border-color: rgba(255, 255, 255, 0.35);
        }

        .progress-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, #10b981, #059669);
          border-radius: 3px;
          width: 0%;
          transition: width 0.1s linear;
        }

        .progress-bar-marker {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          left: 0%;
          width: 14px;
          height: 16px;
          background: #f43f5e;
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
          height: 16px;
          background: #10b981;
          left: 0%;
          transition: left 0.1s linear;
          box-shadow: 0 0 6px rgba(16, 185, 129, 0.8);
          pointer-events: none;
        }

        .attendee-chip {
          display: inline-flex;
          align-items: center;
          padding: 2px 8px;
          border-radius: 9999px;
          font-size: 11px;
          color: white;
          font-weight: 600;
          letter-spacing: 0.2px;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
          transition: all 0.15s ease;
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
          height: 14px;
          left: 0%;
          border-radius: 1px;
          transition: left 0.1s linear;
        }

        .user-position-marker {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: 2px;
          height: 14px;
          background: #f43f5e;
          border-radius: 1px;
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
          background: #f43f5e;
          left: 0%;
          transition: left 0.1s linear, width 0.1s linear;
          pointer-events: none;
          z-index: 5;
        }

        .host-state-indicator {
          min-width: 18px;
          font-size: 11px;
          color: rgba(255, 255, 255, 0.6);
          text-align: center;
        }

        .host-state-indicator.host-state-playing {
          color: #10b981;
        }

        .icon-buttons {
          display: flex;
          gap: 6px;
          align-items: center;
          flex-shrink: 0;
        }

        .icon-button {
          width: 22px;
          height: 22px;
          padding: 0;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 6px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
          font-size: 11px;
          color: rgba(255, 255, 255, 0.7);
        }

        .icon-button:hover {
          background: rgba(255, 255, 255, 0.12);
          border-color: rgba(255, 255, 255, 0.3);
          color: white;
        }

        #pin-button.pinned {
          background: rgba(245, 158, 11, 0.2);
          border-color: rgba(245, 158, 11, 0.5);
          color: #fbbf24;
        }

        #discord-button {
          background-size: 16px 16px;
          background-position: center;
          background-repeat: no-repeat;
          font-size: 0;
        }

        #discord-button:hover {
          opacity: 0.9;
        }

        .opacity-slider {
          width: 55px;
          height: 4px;
          cursor: pointer;
          accent-color: #94a3b8;
          flex-shrink: 0;
          -webkit-appearance: none;
          appearance: none;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 2px;
          outline: none;
        }

        .opacity-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: #cbd5e1;
          cursor: pointer;
        }

        .opacity-slider::-moz-range-thumb {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: #cbd5e1;
          cursor: pointer;
          border: none;
        }

        .opacity-slider::-moz-range-track {
          background: transparent;
          border: none;
        }

        .divergence-join-btn {
          background: rgba(16, 185, 129, 0.15);
          border: 1px solid rgba(16, 185, 129, 0.3);
          color: #34d399;
          border-radius: 6px;
          width: 22px;
          height: 22px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s ease;
          padding: 0;
          flex-shrink: 0;
        }

        .divergence-join-btn:hover {
          background: rgba(16, 185, 129, 0.3);
          border-color: rgba(16, 185, 129, 0.6);
          color: #10b981;
          transform: scale(1.05);
        }

        #hang-time-chat-container {
          flex: 1;
          overflow-y: auto;
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .chat-message {
          display: flex;
          flex-direction: column;
          gap: 1px;
          font-size: 11.5px;
          line-height: 1.35;
          max-width: 85%;
        }

        .chat-message.message-user {
          align-self: flex-end;
          align-items: flex-end;
        }

        .chat-message.message-friend {
          align-self: flex-start;
          align-items: flex-start;
        }

        .message-content {
          padding: 3px 8px;
          border-radius: 9px;
          word-wrap: break-word;
          font-size: 11.5px;
          flex: 0 1 auto;
        }

        .message-friend .message-content {
          background: rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.95);
          border-bottom-left-radius: 3px;
        }

        .message-user .message-content {
          background: rgba(244, 63, 94, 0.25);
          border: 1px solid rgba(244, 63, 94, 0.35);
          color: white;
          border-bottom-right-radius: 3px;
        }

        .message-input-container {
          padding: 8px 10px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          gap: 6px;
          align-items: flex-end;
          background: rgba(255, 255, 255, 0.02);
        }

        #message-input {
          flex: 1;
          min-height: 20px;
          max-height: 60px;
          padding: 5px 8px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          color: white;
          font-size: 12px;
          font-family: inherit;
          resize: none;
          outline: none;
          overflow-y: auto;
          transition: border-color 0.2s ease, background 0.2s ease;
        }

        #message-input::placeholder {
          color: rgba(255, 255, 255, 0.35);
        }

        #message-input:focus {
          background: rgba(255, 255, 255, 0.09);
          border-color: rgba(244, 63, 94, 0.5);
        }

        #send-button {
          padding: 4px 8px;
          background: transparent;
          border: none;
          color: rgba(255, 255, 255, 0.5);
          cursor: pointer;
          font-size: 14px;
          transition: color 0.2s, transform 0.1s;
        }

        #send-button:hover {
          color: rgba(255, 255, 255, 0.9);
          transform: translateY(-1px);
        }

        #send-button:active {
          color: #34d399;
          transform: translateY(0);
        }
      </style>

      <div class="overlay-header">
        <div class="header-top">
          <div class="video-title" id="overlay-title">Hang Time</div>
          <div class="icon-buttons">
            <input type="range" min="10" max="100" value="80" class="opacity-slider" id="opacity-slider" title="Overlay opacity">
            <button class="icon-button" id="discord-button" title="Open Discord with host"></button>
            <button class="icon-button" id="pin-button" title="Pin overlay">📌</button>
          </div>
        </div>

        <!-- Mode A: Co-Watching Layout -->
        <div id="watching-together-section" style="display: flex; flex-direction: column; gap: 6px;">
          <!-- Line 1: Host Row (Includes inline Title) -->
          <div id="host-chip-container" class="overlay-role-row"></div>

          <!-- Line 2: Progress Bar + Time + Sync button -->
          <div class="watching-together-row" id="watching-together-row">
            <div class="progress-bar-wrapper">
              <div class="progress-bar-container">
                <div class="progress-bar-fill" id="progress-bar-fill"></div>
                <div class="guest-markers-container" id="guest-markers-container"></div>
                <div class="gap-indicator" id="gap-indicator" style="display: none;"></div>
                <div class="user-position-marker" id="user-position-marker" style="display: none;"></div>
                <div class="progress-bar-marker" id="progress-bar-marker"></div>
              </div>
              <div class="progress-bar-controls">
                <span class="progress-time-display" id="progress-time-display">0:00</span>
                <div class="host-state-indicator" id="host-state-indicator">-</div>
                <button id="progress-sync-button" title="Sync to host position">↻</button>
              </div>
            </div>
          </div>

          <!-- Line 3: Guest chips -->
          <div id="guest-chips-container" class="overlay-role-row"></div>
        </div>

        <!-- Mode B: Divergence display (< 2 watching together) -->
        <div id="guest-rows-container"></div>
      </div>


      <div class="hang-time-chat-container" id="hang-time-chat-container">
        <div style="text-align: center; color: rgba(255, 255, 255, 0.4); font-size: 11px; padding: 12px 0;">No messages yet</div>
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

    slider.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    slider.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value;
      this._state.opacity = parseInt(value);
      this.updateOpacity();
    });

    slider.addEventListener('change', (e) => {
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
    const opacity = this._state.opacity / 100;
    this.container.style.setProperty('--overlay-opacity', opacity.toString());
    this.container.style.opacity = '';
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

    // Discovery listener - only show overlay if there's an active co-watch session
    if (!this.initialMouseMoveListener && this.container) {
      this.initialMouseMoveListener = (e: MouseEvent) => {
        if (!this.container) return;

        const rect = this.container.getBoundingClientRect();
        const isOverlay = e.clientX >= rect.left && e.clientX <= rect.right &&
                         e.clientY >= rect.top && e.clientY <= rect.bottom;

        // Only show on hover if there's an active co-watch session (2+ members)
        if (isOverlay && this._state.session_members?.length >= 2) {
          if (this.container.classList.contains('hidden') || this.container.classList.contains('fading-out')) {
            this.show();
          }
        }
      };
      document.addEventListener('mousemove', this.initialMouseMoveListener);
    }


    // Delay hover listeners to avoid catching synthetic mouseenter events during initialization
    window.setTimeout(() => {
      console.log('[OverlayUI] Setting up hover listeners, container:', !!this.container);
      if (!this.container) return;

      this.container.addEventListener('mouseenter', (e) => {
        if (this.hideTimer) {
          clearTimeout(this.hideTimer);
          this.hideTimer = null;
        }
        if (this.fadeTimeoutId) {
          clearTimeout(this.fadeTimeoutId);
          this.fadeTimeoutId = null;
        }
        // Only show on hover if there's an active co-watch session (2+ members)
        if (this._state.session_members?.length >= 2) {
          this.show();
        }
      });

      this.container.addEventListener('mouseleave', (e) => {
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
          const target = e.target as HTMLElement;
          // Don't drag if clicking interactive controls (inputs, sliders, buttons, links, etc.)
          if (target && target.closest('input, button, a, textarea, #resize-handle, .join-button, #progress-sync-button')) {
            return;
          }
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

    // Window message listener for sync completion
    if (!this.windowMessageHandler) {
      this.windowMessageHandler = (event: MessageEvent) => {
        if (event.source !== window) return;

        if (event.data.type === 'HANG_TIME_SYNC_COMPLETE') {
          console.debug('[OverlayUI] Sync complete, updating user_progress to', event.data.data?.position);
          this._state.user_progress = event.data.data?.position;
          this.syncInProgress = false;
          this.render();
        }
      };
      window.addEventListener('message', this.windowMessageHandler);
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

    // Send message to background to navigate to guest's video
    this.port.postMessage({
      type: 'JOIN_GUEST_ACTIVITY',
      data: {
        guest_uuid: friendUuid,
        activity_id: guestActivity.activity_id,
        url: guestActivity.url,
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
   * Format seconds to mm:ss
   */
  private formatTime(totalSeconds: number): string {
    if (!totalSeconds || isNaN(totalSeconds) || totalSeconds < 0) return '0:00';
    const mins = Math.floor(totalSeconds / 60);
    const secs = Math.floor(totalSeconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Get participant color based on their role:
   * - Host: always mint / emerald (#10b981)
   * - Non-host self: vivid coral (#f43f5e)
   * - Others: fixed mapped pastel color
   */
  private getParticipantColor(uuid: string | undefined): string {
    if (!uuid) {
      return '#6b7280'; // Gray fallback
    }

    const hostUuid = this.getHostUuid();

    // Rule 1: Host is always green/emerald
    if (uuid === hostUuid) {
      return '#10b981';
    }

    // Rule 2: Current user (when guest) is vivid coral
    if (uuid === this.userId) {
      return '#f43f5e';
    }

    // Rule 3: Other guests get fixed mapped color
    if (this.userColorMap.has(uuid)) {
      return this.userColorMap.get(uuid)!;
    }

    // Deterministic curated color palette for other guests
    const guestColors = [
      '#06b6d4', // cyan
      '#f59e0b', // amber
      '#a855f7', // purple
      '#14b8a6', // teal
      '#3b82f6', // blue
      '#fb923c', // orange
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
   * Show overlay immediately
   */
  show(): void {
    if (!this.container) return;
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.fadeTimeoutId) {
      clearTimeout(this.fadeTimeoutId);
      this.fadeTimeoutId = null;
    }
    this.container.classList.remove('hidden');
    this.container.classList.remove('fading-out');
    this._state.visible = true;
    this.updateOpacity();
  }

  /**
   * Hide overlay
   */
  hide(): void {
    if (!this.container) return;
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.fadeTimeoutId) {
      clearTimeout(this.fadeTimeoutId);
      this.fadeTimeoutId = null;
    }
    this.container.classList.add('hidden');
    this.container.classList.remove('fading-out');
    this._state.visible = false;
  }

  /**
   * Fade out overlay: wait 3 seconds then fade over 3 seconds then hide
   */
  startFadeOut(): void {
    console.log('[OverlayUI] startFadeOut called, container:', !!this.container, 'pinned:', this._state.pinned);
    if (!this.container || this._state.pinned) return;

    // Cancel any existing timers
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.fadeTimeoutId) clearTimeout(this.fadeTimeoutId);

    console.log('[OverlayUI] Starting 3s delay before fade');
    // Wait 3 seconds before starting fade
    this.hideTimer = window.setTimeout(() => {
      console.log('[OverlayUI] hideTimer callback fired, container:', !!this.container);
      if (!this.container || this._state.pinned) {
        return;
      }

      // Set up CSS fade via class
      console.log('[OverlayUI] Adding fading-out class for fade animation');
      this.container.classList.add('fading-out');

      // Hide after fade completes (3 seconds)
      this.fadeTimeoutId = window.setTimeout(() => {
        this.hide();
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
      if (this.fadeTimeoutId) clearTimeout(this.fadeTimeoutId);
      this.show();
    } else {
      this.startFadeOut();
    }
    console.debug('[OverlayUI] Pin toggled:', this._state.pinned);
  }

  /**
   * Sync button clicked - send to content script, wait for actual video seek
   */
  private onSyncClick(): void {
    if (!this._state.host_progress_timestamp || this._state.host_progress === undefined) {
      return;
    }

    if (this.syncInProgress) {
      console.debug('[OverlayUI] Sync already in progress, ignoring click');
      return;
    }

    this.syncInProgress = true;
    console.debug('[OverlayUI] Sync initiated, waiting for video seek confirmation');

    // Send to content script to seek the video
    // Don't update overlay state yet - wait for HANG_TIME_SYNC_COMPLETE confirmation
    window.postMessage({ type: 'HANG_TIME_SYNC_REQUEST', data: { activity_id: this._state.activity_id } }, '*');

    // Set a timeout to reset syncInProgress flag if sync takes too long
    setTimeout(() => {
      if (this.syncInProgress) {
        console.warn('[OverlayUI] Sync confirmation timeout, resetting flag');
        this.syncInProgress = false;
      }
    }, 2000);
  }

  /**
   * Discord button clicked
   */
  private onDiscordClick(): void {
    console.debug('[OverlayUI] Discord button clicked');
    window.postMessage({ type: 'HANG_TIME_OPEN_DISCORD' }, '*');
  }

  /**
   * Get extrapolated user progress between CO_WATCH_UPDATE messages
   * Prevents arrow from looking "stuck" during playback
   */
  private getExtrapolatedUserProgress(): number {
    if (this._state.user_progress === undefined || this.lastUserProgressUpdate === 0) {
      return this._state.user_progress || 0;
    }

    // If host is paused, don't extrapolate
    if (this._state.host_state !== 'playing') {
      return this._state.user_progress;
    }

    // Extrapolate by adding elapsed time since last update
    const elapsedMs = Date.now() - this.lastUserProgressUpdate;
    const extrapolatedProgress = this._state.user_progress + (elapsedMs / 1000);

    return Math.min(extrapolatedProgress, this._state.host_duration || extrapolatedProgress);
  }

  /**
   * Update overlay state and rendering
   */
  setState(newState: Partial<OverlayState>): void {
    // Track when user_progress is updated for extrapolation
    if (newState.user_progress !== undefined) {
      this.lastUserProgressUpdate = Date.now();
    }

    this._state = { ...this._state, ...newState };

    // If co-watch session ended, hide the overlay
    if (this._state.session_members.length === 0) {
      this.hide();
    } else {
      // Just render state changes, don't auto-show
      // Visibility is controlled solely by hover events (mouseenter/mouseleave)
      this.render();
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
    const timeDisplayEl = document.getElementById('progress-time-display') as HTMLElement;

    // Update time display
    if (timeDisplayEl) {
      if (this._state.host_progress !== undefined && this._state.host_duration && this._state.host_duration > 0) {
        const cur = this.formatTime(this._state.host_progress);
        const dur = this.formatTime(this._state.host_duration);
        timeDisplayEl.textContent = `${cur} / ${dur}`;
        timeDisplayEl.style.display = 'inline';
      } else if (this._state.host_progress !== undefined) {
        timeDisplayEl.textContent = this.formatTime(this._state.host_progress);
        timeDisplayEl.style.display = 'inline';
      } else {
        timeDisplayEl.style.display = 'none';
      }
    }

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
        hostMarkerEl.style.background = this.getParticipantColor(this.getHostUuid());
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
        const elapsedSinceHostMeasureMs = Date.now() - this._state.host_progress_timestamp;
        const hostCurrentPosition = this._state.host_state === 'playing'
          ? this._state.host_progress + (elapsedSinceHostMeasureMs / 1000)
          : this._state.host_progress;

        // Use extrapolated user progress for smooth arrow movement between updates
        const extrapolatedUserProgress = this.getExtrapolatedUserProgress();
        const gap = Math.abs(extrapolatedUserProgress - hostCurrentPosition);
        const SHOW_THRESHOLD = 6; // Show when gap exceeds 6 seconds
        const HIDE_THRESHOLD = 4; // Hide when gap drops below 4 seconds

        console.debug('[OverlayUI] Arrow gap calculation:', {
          user_progress: this._state.user_progress,
          host_progress: this._state.host_progress,
          hostCurrentPosition,
          elapsedSinceHostMeasureMs: Date.now() - this._state.host_progress_timestamp,
          gap,
          markersVisible: this.markersVisible,
          host_state: this._state.host_state,
        });

        // Hysteresis: show at 6s, hide at 4s, stay in between
        let shouldShow = this.markersVisible; // Keep current state by default
        if (gap > SHOW_THRESHOLD) {
          shouldShow = true;
        } else if (gap < HIDE_THRESHOLD) {
          shouldShow = false;
        }

        if (shouldShow) {
          const userPercent = Math.min((extrapolatedUserProgress / this._state.host_duration) * 100, 100);
          markerEl.style.left = userPercent + '%';
          markerEl.style.background = this.getParticipantColor(this.userId);

          // Arrow points toward host (use current position, not old measurement)
          markerEl.classList.remove('arrow-left', 'arrow-right');
          if (extrapolatedUserProgress < hostCurrentPosition) {
            markerEl.classList.add('arrow-right'); // User behind, arrow points right (toward host ahead)
            console.debug('[OverlayUI] Arrow RIGHT: user behind', { user: extrapolatedUserProgress, host: hostCurrentPosition });
          } else if (extrapolatedUserProgress > hostCurrentPosition) {
            markerEl.classList.add('arrow-left'); // User ahead, arrow points left (toward host behind)
            console.debug('[OverlayUI] Arrow LEFT: user ahead', { user: extrapolatedUserProgress, host: hostCurrentPosition });
          }

          markerEl.style.display = 'block';
          console.debug('[OverlayUI] Arrow SHOWN at', userPercent + '%');
          this.markersVisible = true;
        } else {
          markerEl.style.display = 'none';
          console.debug('[OverlayUI] Arrow hidden: gap too small');
          this.markersVisible = false;
        }
      } else {
        markerEl.style.display = 'none';
        console.debug('[OverlayUI] Arrow hidden: condition not met');
      }
    }

    // Show host position marker (vertical line) for guests
    const hostPositionMarkerEl = document.getElementById('user-position-marker') as HTMLElement;
    const gapIndicatorEl = document.getElementById('gap-indicator') as HTMLElement;

    if (hostPositionMarkerEl || gapIndicatorEl) {
      if (!this._state.is_user_host && this._state.host_progress !== undefined && this._state.user_progress !== undefined && this._state.host_progress_timestamp !== undefined && this._state.host_duration && this._state.host_duration > 0) {
        // Calculate host's current position (same as arrow logic)
        const elapsedSinceHostMeasureMs = Date.now() - this._state.host_progress_timestamp;
        const hostCurrentPosition = this._state.host_state === 'playing'
          ? this._state.host_progress + (elapsedSinceHostMeasureMs / 1000)
          : this._state.host_progress;
        // Use extrapolated user progress for smooth marker movement
        const extrapolatedUserProgress = this.getExtrapolatedUserProgress();
        const gap = Math.abs(extrapolatedUserProgress - hostCurrentPosition);
        const SHOW_THRESHOLD = 6;
        const HIDE_THRESHOLD = 4;

        // Hysteresis: show at 6s, hide at 4s, stay in between (use same state as arrow)
        let shouldShow = this.markersVisible;
        if (gap > SHOW_THRESHOLD) {
          shouldShow = true;
        } else if (gap < HIDE_THRESHOLD) {
          shouldShow = false;
        }

        if (shouldShow) {
          const hostPercent = Math.min((hostCurrentPosition / this._state.host_duration) * 100, 100);
          const userPercent = Math.min((extrapolatedUserProgress / this._state.host_duration) * 100, 100);

          // Show host position marker
          if (hostPositionMarkerEl) {
            hostPositionMarkerEl.style.left = hostPercent + '%';
            hostPositionMarkerEl.style.background = this.getParticipantColor(this.userId);
            hostPositionMarkerEl.style.display = 'block';
          }

          // Show gap indicator line between user and host positions
          if (gapIndicatorEl) {
            const startPercent = Math.min(userPercent, hostPercent);
            const endPercent = Math.max(userPercent, hostPercent);
            const gapWidth = endPercent - startPercent;
            gapIndicatorEl.style.left = startPercent + '%';
            gapIndicatorEl.style.width = gapWidth + '%';
            gapIndicatorEl.style.background = this.getParticipantColor(this.userId);
            gapIndicatorEl.style.display = 'block';
          }

          console.debug('[OverlayUI] Host position marker shown at', hostPercent + '%, gap from', userPercent + '%');
        } else {
          if (hostPositionMarkerEl) hostPositionMarkerEl.style.display = 'none';
          if (gapIndicatorEl) gapIndicatorEl.style.display = 'none';
          console.debug('[OverlayUI] Host/gap markers hidden - gap too small:', gap);
        }
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
   * Simple two-mode rendering
   * Host Mode: 2+ watching same video → show host + media title + progress bar + guests
   * Guest Mode: <2 watching same video → show "Choose next:" + guest rows
   */
  private renderHostRow(): void {
    const watchingTogether = this._state.watching_together || [];
    const isHostMode = watchingTogether.length >= 2;
    const watchingRow = document.getElementById('watching-together-row');
    const watchingSection = document.getElementById('watching-together-section');
    const hostContainer = document.getElementById('host-chip-container');
    const guestContainer = document.getElementById('guest-chips-container');
    const guestRowsContainer = document.getElementById('guest-rows-container');

    if (!watchingRow || !hostContainer || !guestContainer || !guestRowsContainer) return;

    if (isHostMode) {
      // HOST MODE: 2+ watching same video
      if (watchingSection) watchingSection.style.display = 'flex';
      watchingRow.style.display = '';
      guestRowsContainer.innerHTML = ''; // Hide divergence rows

      // Render host chip + inline media title
      this.renderHostChip(hostContainer);

      // Render guest chips
      this.renderGuestChips(guestContainer);

      // Render guest markers if user is host
      if (this._state.is_user_host) {
        this.renderGuestMarkers();
      }
    } else {
      // GUEST MODE: <2 watching same video (divergence)
      if (watchingSection) watchingSection.style.display = 'none';
      watchingRow.style.display = 'none';
      hostContainer.innerHTML = '';
      guestContainer.innerHTML = '';

      // Render "Choose next:" with guest rows
      this.renderChooseNextRows(guestRowsContainer);
    }
  }

  /**
   * MODE A: Render host chip with inline activity title
   * Host is shown first followed inline by the video title being tracked
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

    // Build inline media title & icon
    let mediaHtml = '';
    const activity = this._state.co_watcher_activities?.[hostUuid];
    if (activity && activity.content) {
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
          iconHtml = '';
        }
      }

      const title = this.escapeHtml(activity.content);
      mediaHtml = `
        <div style="display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; flex: 1;">
          ${iconHtml}
          <span class="media-title-text" style="font-size: 11px; color: rgba(255, 255, 255, 0.85); font-weight: 500;" title="${title}">${title}</span>
        </div>
      `;
    }

    // Build host role row: label + pill + inline title
    container.innerHTML = `
      <span class="overlay-role-label">HOST</span>
      <div class="attendee-chip" style="background: ${hostColor}; flex-shrink: 0;"><span>${hostName}</span></div>
      ${mediaHtml}
    `;
  }

  /**
   * MODE A: Render guest chips (everyone except host)
   * Guests shown on separate row below progress bar
   */
  private getActivityFreshnessStyle(uuid: string): { opacity: number } {
    const activity = this._state.co_watcher_activities?.[uuid];
    const lastMeasuredAt = activity?.metadata?.progress_measured_at || activity?.timestamp;
    if (!lastMeasuredAt) {
      return { opacity: 1 };
    }

    const DIM_AFTER_MS = 5 * 60 * 1000;      // 5 minutes
    const timeSinceLastSeen = Date.now() - lastMeasuredAt;

    if (timeSinceLastSeen >= DIM_AFTER_MS) {
      return { opacity: 0.5 }; // Dimmed after 5 min inactivity
    }
    return { opacity: 1 }; // Active
  }

  private renderGuestChips(container: HTMLElement): void {
    const allCoWatchers = this._state.session_members || [];
    const hostUuid = this.getHostUuid();
    const chips: string[] = [];

    // Sort with self first
    const sorted = [...allCoWatchers].sort((a, b) => {
      if (a === this.userId) return -1;
      if (b === this.userId) return 1;
      return 0;
    });

    for (const uuid of sorted) {
      if (uuid === hostUuid) continue; // Skip host (shown separately)

      const { opacity } = this.getActivityFreshnessStyle(uuid);

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
      container.innerHTML = `
        <span class="overlay-role-label">GUESTS</span>
        <div style="display: flex; gap: 4px; flex-wrap: wrap; align-items: center;">${chips.join('')}</div>
      `;
    } else {
      container.innerHTML = '';
    }
  }

  /**
   * MODE B: Render "Choose next:" section with guest rows
   */
  private renderChooseNextRows(container: HTMLElement): void {
    const sessionMembers = this._state.session_members || [];
    const rows: string[] = [];

    // Add label (matching test expectation "Choose next:")
    rows.push('<div class="overlay-role-label" style="margin-bottom: 8px;">Choose next:</div>');

    // Sort with self first
    const sorted = [...sessionMembers].sort((a, b) => {
      if (a === this.userId) return -1;
      if (b === this.userId) return 1;
      return 0;
    });

    for (const uuid of sorted) {
      const { opacity } = this.getActivityFreshnessStyle(uuid);

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
        const isSelf = uuid === this.userId;
        const joinBtnHtml = isSelf ? '' : `
          <button class="divergence-join-btn join-button" data-uuid="${uuid}" title="Join activity">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width: 12px; height: 12px; pointer-events: none;">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
          </button>
        `;

        row = `
          <div class="divergence-row" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); margin-bottom: 4px; opacity: ${opacity};">
            <div style="display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;">
              <div class="attendee-chip" style="background: ${color}; flex-shrink: 0;"><span>${name}</span></div>
              <div style="display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden;">
                ${iconHtml}
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; color: rgba(255, 255, 255, 0.85);" title="${this.escapeHtml(activity.content)}">${title}</span>
              </div>
            </div>
            ${joinBtnHtml}
          </div>
        `;
      } else {
        row = `
          <div class="divergence-row" style="display: flex; align-items: center; gap: 6px; padding: 4px 6px; opacity: ${opacity}; margin-bottom: 4px;">
            <div class="attendee-chip" style="background: ${color}; flex-shrink: 0;"><span>${name}</span></div>
            <span style="font-size: 11px; color: rgba(255, 255, 255, 0.4); font-style: italic;">Browsing...</span>
          </div>
        `;
      }
      rows.push(row);
    }

    if (rows.length === 1) {
      container.innerHTML = '';
    } else {
      container.innerHTML = rows.join('');

      // Attach join listeners
      for (const btn of container.querySelectorAll('.join-button')) {
        btn.addEventListener('click', (e) => {
          const target = (e.target as HTMLElement).closest('.join-button') as HTMLElement;
          const uuid = target?.getAttribute('data-uuid') || (e.target as HTMLElement).getAttribute('data-uuid');
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
   * Render chat messages with consecutive message grouping and unified pill styling
   */
  private renderMessages(): void {
    const container = document.getElementById('hang-time-chat-container');
    if (!container) {
      console.warn('[OverlayUI] Chat container not found');
      return;
    }

    if (this._state.messages.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: rgba(255, 255, 255, 0.4); font-size: 11px; padding: 12px 0;">No messages yet</div>';
      return;
    }

    const validMessages = this._state.messages.filter(msg => msg && msg.content);

    if (validMessages.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: rgba(255, 255, 255, 0.4); font-size: 11px; padding: 12px 0;">No messages yet</div>';
      return;
    }

    let html = '';
    let lastSenderId: string | null = null;

    for (const msg of validMessages) {
      const isUser = msg.sender_id === this.userId;
      const userColor = this.getParticipantColor(msg.sender_id);
      const displayName = isUser ? 'You' : (this._state.nicknameMap?.[msg.sender_id] || msg.sender || 'Unknown');
      const { opacity } = this.getActivityFreshnessStyle(msg.sender_id);
      const isConsecutive = lastSenderId === msg.sender_id;
      lastSenderId = msg.sender_id;

      const headerHtml = !isConsecutive
        ? `<div class="attendee-chip" style="background: ${userColor}; opacity: ${opacity}; margin-bottom: 2px; font-size: 10px; padding: 1px 7px;">${this.escapeHtml(displayName)}</div>`
        : '';

      html += `
        <div class="chat-message ${isUser ? 'message-user' : 'message-friend'}" style="${isConsecutive ? 'margin-top: -3px;' : ''}">
          ${headerHtml}
          <div class="message-content">${this.linkifyContent(msg.content)}</div>
        </div>
      `;
    }

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
    if (this.initialMouseMoveListener) {
      document.removeEventListener('mousemove', this.initialMouseMoveListener);
      this.initialMouseMoveListener = null;
    }
    if (this.windowMessageHandler) {
      window.removeEventListener('message', this.windowMessageHandler);
      this.windowMessageHandler = null;
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
