import { VoiceMeshManager, WebRTCSignalPayload, AudioLevelEvent, VoiceParticipant } from './voice/index.js';
/**
 * Hang Time - Overlay UI
 * Renders floating overlay panel for video co-watching
 */

import { storageManager } from './storage.js';
import {
  formatTime,
  getParticipantColor,
  getOverlaySkeletonHtml,
  buildHostChipHtml,
  buildGuestChipsHtml,
  buildChooseNextRowsHtml,
  buildMessagesHtml,
  buildChatToastHtml,
} from './overlay/index.js';

export interface OverlayState {
  visible: boolean;
  pinned: boolean;
  opacity: number; // 0-100
  host_nickname?: string;
  host_uuid?: string; // UUID of the host
  user_uuid?: string; // UUID of the current local user
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
  user_nickname?: string;
  nicknameMap?: Record<string, string>;
}

export class OverlayUI {
  private container: HTMLElement | null = null;
  private hideTimer: number | null = null;
  private fadeTimeoutId: number | null = null;
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
  private syncInProgress = false; // Track if sync is pending completion
  private windowMessageHandler: ((event: MessageEvent) => void) | null = null; // Store for cleanup
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
  private toastContainer: HTMLElement | null = null;
  private activeToastTimeouts: Map<HTMLElement, NodeJS.Timeout> = new Map();
  private voiceManager: VoiceMeshManager = new VoiceMeshManager();
  private pttActive = false;


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
   * Update the user ID without recreating the overlay DOM
   */
  setUserId(userId: string): void {
    if (userId && userId !== this.userId) {
      this.userId = userId;
      this.render();
      if (this._state.session_members) {
        this.voiceManager.syncSessionMembers(this._state.session_members);
      }
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

    // Clean up any existing overlay element left in DOM from prior/orphaned scripts
    const existingOverlays = document.querySelectorAll('#hang-time-overlay');
    existingOverlays.forEach((el) => el.remove());

    this.container = document.createElement('div');
    this.container.id = 'hang-time-overlay';
    this.container.className = 'hidden'; // Start hidden, show only when co-watch detected
    this.container.innerHTML = getOverlaySkeletonHtml();

    // Wait for document.body if it's not ready yet
    if (!document.body) {
      console.debug('[OverlayUI] document.body not ready, deferring appendChild');
      const checkBody = setInterval(() => {
        if (document.body && this.container && !this.container.parentElement) {
          document.body.appendChild(this.container);
          this.restoreSizeFromStorage();
          this.setupOpacitySlider();
          this.setupEventListeners();
          this.startProgressAnimation();
          clearInterval(checkBody);
        }
      }, 50);
      return;
    }

    document.body.appendChild(this.container);
    this.restoreSizeFromStorage();
    this.setupOpacitySlider();
    this.setupEventListeners();
    this.startProgressAnimation();
    // Render any state that was set before the overlay was added to DOM
    if (this._state.session_members.length > 0) {
      this.render();
      if (this._state.session_members) {
        this.voiceManager.syncSessionMembers(this._state.session_members);
      }
    }
  }

  /**
   * Restore overlay size, opacity, and pinned state from storage
   */
  private restoreSizeFromStorage(): void {
    if (!this.container) return;
    storageManager.getUserProfile().then((userProfile) => {
      if (userProfile && this.container) {
        if (userProfile.overlay_size) {
          const { width, height } = userProfile.overlay_size;
          this.container.style.width = width + 'px';
          this.container.style.maxHeight = height + 'px';
        }
        if (userProfile.overlay_opacity !== undefined) {
          this._state.opacity = userProfile.overlay_opacity;
          const slider = this.container.querySelector('#opacity-slider') as HTMLInputElement;
          if (slider) slider.value = userProfile.overlay_opacity.toString();
          this.updateOpacity();
        }
        if (userProfile.overlay_pinned !== undefined) {
          this._state.pinned = userProfile.overlay_pinned;
          const pinButton = this.container.querySelector('#pin-button');
          if (pinButton) {
            if (this._state.pinned) {
              pinButton.classList.add('pinned');
              pinButton.setAttribute('title', 'Unpin overlay');
              this.show();
            } else {
              pinButton.classList.remove('pinned');
              pinButton.setAttribute('title', 'Pin overlay');
            }
          }
        }
      }
    }).catch(console.error);
  }

  /**
   * Setup opacity slider
   */
  private setupOpacitySlider(): void {
    const slider = this.container?.querySelector('#opacity-slider') as HTMLInputElement;
    if (!slider) return;

    slider.value = this._state.opacity.toString();

    slider.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    slider.addEventListener('input', (e) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      this._state.opacity = val;
      this.updateOpacity();
      storageManager.getUserProfile().then((profile) => {
        if (profile) {
          profile.overlay_opacity = val;
          storageManager.setUserProfile(profile).then(() => {
            storageManager.forceSyncNow().catch(console.error);
          }).catch(console.error);
        }
      }).catch(console.error);
    });
  }

  /**
   * Update overlay opacity
   */
  private updateOpacity(): void {
    if (!this.container) return;
    const opacityValue = (this._state.opacity / 100).toString();
    this.container.style.setProperty('--overlay-opacity', opacityValue);
  }

  /**
   * Setup interactive event listeners
   */
  private setupEventListeners(): void {
    // Guard: only set up once per overlay instance
    if (this._eventListenersSetup) {
      return;
    }
    this._eventListenersSetup = true;

    // Discovery listener - wakes overlay on user activity during co-watch session (or if pinned)
    if (!this.initialMouseMoveListener && this.container) {
      let lastWakeTime = 0;
      this.initialMouseMoveListener = (e: MouseEvent) => {
        if (!this.container) return;

        const hasSession = (this._state.session_members?.length || 0) >= 2;
        if (!hasSession && !this._state.pinned) return;

        const now = Date.now();
        if (now - lastWakeTime < 80) return; // Throttle to avoid excessive execution
        lastWakeTime = now;

        const rect = this.container.getBoundingClientRect();
        const isDirectlyOverOverlay = rect && rect.width > 0 && rect.height > 0 &&
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom;

        if (isDirectlyOverOverlay || this._state.pinned) {
          // Hovering directly over overlay or pinned: keep fully open, cancel any fade
          if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
          }
          if (this.fadeTimeoutId) {
            clearTimeout(this.fadeTimeoutId);
            this.fadeTimeoutId = null;
          }
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

      this.container.addEventListener('mouseenter', (_e) => {
        if (this.hideTimer) {
          clearTimeout(this.hideTimer);
          this.hideTimer = null;
        }
        if (this.fadeTimeoutId) {
          clearTimeout(this.fadeTimeoutId);
          this.fadeTimeoutId = null;
        }
        const hasSession = (this._state.session_members?.length || 0) >= 2;
        if (hasSession || this._state.pinned) {
          this.show();
        }
      });

      this.container.addEventListener('mousemove', (_e) => {
        if (this.hideTimer) {
          clearTimeout(this.hideTimer);
          this.hideTimer = null;
        }
        if (this.fadeTimeoutId) {
          clearTimeout(this.fadeTimeoutId);
          this.fadeTimeoutId = null;
        }
        if (this.container?.classList.contains('fading-out')) {
          this.show();
        }
      });

      this.container.addEventListener('mouseleave', (e: MouseEvent) => {
        if (this.container && e.relatedTarget && this.container.contains(e.relatedTarget as Node)) {
          return;
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
        storageManager.getUserProfile().then((profile) => {
          if (profile) {
            profile.overlay_size = {
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            };
            storageManager.setUserProfile(profile).catch(console.error);
          }
        }).catch(console.error);
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
    const pinButton = this.container?.querySelector('#pin-button');
    if (pinButton) {
      pinButton.addEventListener('click', () => this.togglePin());
    }

    // Discord button
    const discordButton = this.container?.querySelector('#discord-button') as HTMLElement;
    if (discordButton) {
      try {
        const iconUrl = chrome.runtime.getURL('public/icons/discord.png');
        discordButton.style.backgroundImage = `url('${iconUrl}')`;
      } catch (e) {
        console.debug('[OverlayUI] Could not load Discord icon:', e);
      }
      discordButton.addEventListener('click', () => this.onDiscordClick());
    }

    // Sync button (for non-hosts only)
    const syncButton = this.container?.querySelector('#progress-sync-button');
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
    const messageInput = this.container?.querySelector('#message-input') as HTMLTextAreaElement;
    const sendButton = this.container?.querySelector('#send-button');

    console.debug('[OverlayUI] Setup message handlers - input:', !!messageInput, 'button:', !!sendButton);

    if (messageInput) {
      // Auto-expand textarea as user types
      messageInput.addEventListener('input', (e) => {
        const textarea = e.target as HTMLTextAreaElement;
        textarea.style.height = 'auto';
        const newHeight = Math.max(32, Math.min(textarea.scrollHeight, 68));
        textarea.style.height = newHeight + 'px';
      });

      // Dedicated Voice Bar Controls (Solution A)
      const joinBtn = document.getElementById('voice-join-btn');
      const muteToggle = document.getElementById('voice-mute-toggle');
      const leaveBtn = document.getElementById('voice-leave-btn');

      if (joinBtn) {
        joinBtn.addEventListener('click', async () => {
          await this.voiceManager.joinVoice(this._state.session_members);
          this.voiceManager.setMuted(false);
        });
      }

      if (muteToggle) {
        muteToggle.addEventListener('click', () => {
          if (this.voiceManager.getInVoice()) {
            this.voiceManager.setMuted(!this.voiceManager.getIsMuted());
          }
        });
      }

      if (leaveBtn) {
        leaveBtn.addEventListener('click', () => {
          this.voiceManager.leaveVoice();
        });
      }

      // Push-to-Talk (Hold V when not in input)
      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyV' && !this.pttActive) {
          const activeTag = (document.activeElement?.tagName || '').toLowerCase();
          if (activeTag === 'input' || activeTag === 'textarea') return;
          if (this.voiceManager.getInVoice() && this.voiceManager.getIsMuted()) {
            this.pttActive = true;
            this.voiceManager.setMuted(false);
          }
        }
      });

      window.addEventListener('keyup', (e) => {
        if (e.code === 'KeyV' && this.pttActive) {
          this.pttActive = false;
          if (this.voiceManager.getInVoice()) {
            this.voiceManager.setMuted(true);
          }
        }
      });

      // Initialize voice manager
      this.voiceManager.initialize(
        this.userId,
        this._state.activity_id || '',
        (targetUuid, signal) => this.sendWebRTCSignal(targetUuid, signal),
        {
          onParticipantsChanged: (participants) => this.renderVoiceState(participants),
          onSpeakingChanged: (event) => this.handleSpeakingEvent(event),
        }
      );

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
    input.style.height = '32px';
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
   * Find the host's UUID
   */
  private getHostUuid(): string | undefined {
    if (this._state.host_uuid) {
      return this._state.host_uuid;
    }

    if (this._state.is_user_host) {
      return this.userId;
    }

    // Find the UUID in watching_together that has the host_nickname
    for (const uuid of this._state.watching_together || []) {
      if (this.nicknameMap.get(uuid) === this._state.host_nickname) {
        return uuid;
      }
    }

    // Fallback: first non-self member in watching_together or first member
    const watching = this._state.watching_together || [];
    const nonSelf = watching.find((id) => id !== this.userId && id !== 'unknown');
    return nonSelf || watching[0];
  }

  private getColor(uuid: string | undefined): string {
    return getParticipantColor(uuid, this.getHostUuid(), this.userId, this.userColorMap);
  }


  /**
   * Helper to check if overlay is currently open and visible to the user
   */
  private isOverlayFullyVisible(): boolean {
    if (!this.container || !this._state.visible) return false;
    if (this.container.classList.contains('hidden') || this.container.classList.contains('fading-out')) return false;
    return true;
  }

  /**
   * Create or attach toast container
   */
  private createToastContainer(): void {
    if (this.toastContainer && this.toastContainer.parentElement) return;
    const existing = document.getElementById('hang-time-toast-container');
    if (existing) existing.remove();

    this.toastContainer = document.createElement('div');
    this.toastContainer.id = 'hang-time-toast-container';
    if (document.body) {
      document.body.appendChild(this.toastContainer);
    }
    this.updateToastPosition();
  }

  /**
   * Position toast container to match overlay position and width
   */
  private updateToastPosition(): void {
    if (!this.toastContainer || !this.container) return;
    if (this.container.style.left && this.container.style.left !== 'auto') {
      this.toastContainer.style.left = this.container.style.left;
      this.toastContainer.style.right = 'auto';
    } else {
      this.toastContainer.style.right = this.container.style.right || '20px';
      this.toastContainer.style.left = 'auto';
    }
    this.toastContainer.style.top = this.container.style.top || '20px';
    this.toastContainer.style.width = this.container.style.width || '320px';
  }

  /**
   * Display floating ephemeral chat toast when overlay is hidden/faded
   */
  showChatToast(sender: string, senderId: string, content: string): void {
    if (this.isOverlayFullyVisible() || senderId === this.userId) {
      return;
    }

    if (!this.toastContainer || !this.toastContainer.parentElement) {
      this.createToastContainer();
    }
    if (!this.toastContainer) return;

    this.updateToastPosition();

    const senderColor = this.getColor(senderId);
    const displayName = this.nicknameMap.get(senderId) || sender || 'Friend';

    const toast = document.createElement('div');
    toast.className = 'hang-time-chat-toast';
    toast.innerHTML = buildChatToastHtml(displayName, senderColor, content);

    // Clicking toast opens full overlay
    toast.addEventListener('click', () => {
      this.show();
      this.clearChatToasts();
    });

    let fadeTimeout: NodeJS.Timeout | null = null;
    const scheduleFade = () => {
      fadeTimeout = setTimeout(() => {
        toast.classList.remove('toast-visible');
        toast.classList.add('toast-fading');
        setTimeout(() => {
          toast.remove();
          this.activeToastTimeouts.delete(toast);
        }, 300);
      }, 4000);
      this.activeToastTimeouts.set(toast, fadeTimeout);
    };

    toast.addEventListener('mouseenter', () => {
      if (fadeTimeout) clearTimeout(fadeTimeout);
      toast.classList.remove('toast-fading');
      toast.classList.add('toast-visible');
    });

    toast.addEventListener('mouseleave', () => {
      scheduleFade();
    });

    // Limit to max 3 toasts
    if (this.toastContainer.children.length >= 3) {
      const oldest = this.toastContainer.children[0] as HTMLElement;
      if (oldest) {
        const oldTimer = this.activeToastTimeouts.get(oldest);
        if (oldTimer) clearTimeout(oldTimer);
        oldest.remove();
        this.activeToastTimeouts.delete(oldest);
      }
    }

    this.toastContainer.appendChild(toast);
    void toast.offsetWidth; // Force reflow to ensure CSS transition fires reliably
    toast.classList.add('toast-visible');

    scheduleFade();
  }

  /**
   * Clear all active floating toasts (e.g. when opening overlay)
   */
  clearChatToasts(): void {
    if (!this.toastContainer) return;
    const toasts = Array.from(this.toastContainer.querySelectorAll('.hang-time-chat-toast')) as HTMLElement[];
    for (const toast of toasts) {
      const timer = this.activeToastTimeouts.get(toast);
      if (timer) clearTimeout(timer);
      toast.classList.remove('toast-visible');
      toast.classList.add('toast-fading');
      setTimeout(() => toast.remove(), 200);
    }
    this.activeToastTimeouts.clear();
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
    this.clearChatToasts();
    this.container.classList.remove('hidden');
    this.container.classList.remove('fading-out');
    this._state.visible = true;
    this.updateOpacity();
  }

  /**
   * Hide overlay (only if not pinned, unless force is true)
   */
  hide(force = false): void {
    if (!this.container) return;
    if (this._state.pinned && !force) return;

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
        if (!this.container || this._state.pinned) {
          if (this.container) this.container.classList.remove('fading-out');
          return;
        }
        this.hide();
        this.fadeTimeoutId = null;
        this.hideTimer = null;
      }, 3000);
    }, 3000);
  }

  /**
   * Toggle pin state
   */
  togglePin(): void {
    this._state.pinned = !this._state.pinned;
    const button = this.container?.querySelector('#pin-button');
    if (button) {
      if (this._state.pinned) {
        button.classList.add('pinned');
        button.setAttribute('title', 'Unpin overlay');
      } else {
        button.classList.remove('pinned');
        button.setAttribute('title', 'Pin overlay');
      }
    }
    if (this._state.pinned) {
      if (this.hideTimer) clearTimeout(this.hideTimer);
      if (this.fadeTimeoutId) clearTimeout(this.fadeTimeoutId);
      this.hideTimer = null;
      this.fadeTimeoutId = null;
      this.show();
    } else {
      this.startFadeOut();
    }
    storageManager.getUserProfile().then((profile) => {
      if (profile) {
        profile.overlay_pinned = this._state.pinned;
        storageManager.setUserProfile(profile).then(() => {
          storageManager.forceSyncNow().catch(console.error);
        }).catch(console.error);
      }
    }).catch(console.error);
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
    const hostUuid = this.getHostUuid();
    window.postMessage({
      type: 'HANG_TIME_OPEN_DISCORD',
      data: {
        host_uuid: hostUuid,
      },
    }, '*');
  }

  /**
   * Update overlay state and rendering
   */
  setState(newState: Partial<OverlayState>): void {
    // Update userId if provided in state
    if (newState.user_uuid && newState.user_uuid !== this.userId && newState.user_uuid !== 'unknown') {
      this.userId = newState.user_uuid;
    }

    // Check for new incoming messages from other participants to display as floating toasts if overlay is hidden
    if (newState.messages && Array.isArray(newState.messages) && this._state.messages) {
      const existingIds = new Set(this._state.messages.map(m => m.id || `${m.sender_id}_${m.timestamp}_${m.content}`));
      const newIncoming = newState.messages.filter(m => {
        if (!m || !m.content) return false;
        if (m.sender_id === this.userId) return false; // Don't toast self messages
        const id = m.id || `${m.sender_id}_${m.timestamp}_${m.content}`;
        return !existingIds.has(id);
      });

      if (!this.isOverlayFullyVisible() && newIncoming.length > 0) {
        const now = Date.now();
        for (const msg of newIncoming) {
          // Only toast recent messages (sent within last 30s) to avoid spam on initial load
          if (!msg.timestamp || (now - msg.timestamp) < 30000) {
            this.showChatToast(msg.sender, msg.sender_id, msg.content);
          }
        }
      }
    }

    // Check if this is only a playback progress update (avoids expensive DOM re-renders of chat/participants)
    const progressOnlyKeys = new Set(['user_progress', 'host_progress', 'host_progress_timestamp', 'host_state', 'guest_progress', 'guest_progress_timestamp']);
    const isProgressOnly = Object.keys(newState).length > 0 && Object.keys(newState).every(k => progressOnlyKeys.has(k));

    // Preserve local client state (pinned, opacity, visible) if not explicitly overridden by incoming payload
    const preservedPinned = this._state.pinned;
    const preservedOpacity = this._state.opacity;
    const preservedVisible = this._state.visible;

    this._state = {
      ...this._state,
      ...newState,
      pinned: newState.pinned !== undefined ? newState.pinned : preservedPinned,
      opacity: newState.opacity !== undefined ? newState.opacity : preservedOpacity,
      visible: newState.visible !== undefined ? newState.visible : preservedVisible,
    };

    // If co-watch session ended, hide the overlay
    if (this._state.session_members.length === 0) {
      this.hide();
    } else if (isProgressOnly) {
      // Lightweight progress update: only update progress bar elements without tearing down/re-rendering list DOM
      this.renderHeader();
    } else {
      this.render();
      if (this._state.session_members) {
        this.voiceManager.syncSessionMembers(this._state.session_members);
      }
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
    this.renderGuestMarkers();
    this.renderMessages();
  }

  /**
   * Render header (title + progress bar)
   */
  private renderHeader(): void {
    const titleTextEl = document.getElementById('overlay-title-text');
    if (titleTextEl && titleTextEl.textContent !== 'Hang Time') {
      titleTextEl.textContent = 'Hang Time';
    }

    const pinBtn = this.container?.querySelector('#pin-button');
    if (pinBtn) {
      if (this._state.pinned) {
        pinBtn.classList.add('pinned');
        pinBtn.setAttribute('title', 'Unpin overlay');
      } else {
        pinBtn.classList.remove('pinned');
        pinBtn.setAttribute('title', 'Pin overlay');
      }
    }

    const fillEl = document.getElementById('progress-bar-fill') as HTMLElement;
    const hostMarkerEl = document.getElementById('progress-bar-host-marker') as HTMLElement;
    const syncBtn = document.getElementById('progress-sync-button') as HTMLElement;
    const stateIndicator = document.getElementById('host-state-indicator') as HTMLElement;
    const timeDisplayEl = document.getElementById('progress-time-display') as HTMLElement;

    // Calculate current host progress (extrapolated if playing and not local host)
    let currentHostProgress = this._state.host_progress;
    if (!this._state.is_user_host && this._state.host_state === 'playing' && this._state.host_progress_timestamp && this._state.host_progress !== undefined) {
      const elapsedSinceHostMeasure = (Date.now() - this._state.host_progress_timestamp) / 1000;
      currentHostProgress = Math.min(this._state.host_progress + elapsedSinceHostMeasure, this._state.host_duration || (this._state.host_progress + elapsedSinceHostMeasure));
    }

    // Update time display
    if (timeDisplayEl) {
      let targetTimeText = '';
      if (currentHostProgress !== undefined && this._state.host_duration && this._state.host_duration > 0) {
        const cur = formatTime(currentHostProgress);
        const dur = formatTime(this._state.host_duration);
        targetTimeText = `${cur} / ${dur}`;
      } else if (currentHostProgress !== undefined) {
        targetTimeText = formatTime(currentHostProgress);
      }

      if (timeDisplayEl.textContent !== targetTimeText) {
        timeDisplayEl.textContent = targetTimeText;
      }
      const targetDisplay = targetTimeText ? 'inline-flex' : 'none';
      if (timeDisplayEl.style.display !== targetDisplay) {
        timeDisplayEl.style.display = targetDisplay;
      }
    }

    // Update host state indicator (guarded to prevent DOM thrashing)
    if (stateIndicator) {
      const nextText = this._state.host_state === 'playing' ? '▶' : (this._state.host_state === 'paused' ? '⏸' : '-');
      const isPlaying = this._state.host_state === 'playing';
      if (stateIndicator.textContent !== nextText) {
        stateIndicator.textContent = nextText;
      }
      if (stateIndicator.classList.contains('host-state-playing') !== isPlaying) {
        stateIndicator.classList.toggle('host-state-playing', isPlaying);
      }
    }

    if (fillEl && currentHostProgress !== undefined && this._state.host_duration && this._state.host_duration > 0) {
      // Simple calculation: progress / duration * 100
      const hostPercent = Math.min((currentHostProgress / this._state.host_duration) * 100, 100);
      const widthStr = hostPercent + '%';
      if (fillEl.style.width !== widthStr) {
        fillEl.style.width = widthStr;
      }

      // Position host marker at host's current position
      if (hostMarkerEl) {
        if (hostMarkerEl.style.left !== widthStr) {
          hostMarkerEl.style.left = widthStr;
        }
        const color = this.getColor(this.getHostUuid());
        if (hostMarkerEl.style.background !== color) {
          hostMarkerEl.style.background = color;
        }
      }
    }

    // For Guests: Manage user's position marker (always visible), arrow marker (gap > 6s), and horizontal gap line
    const userPositionMarkerEl = document.getElementById('user-position-marker') as HTMLElement;
    const markerEl = document.getElementById('progress-bar-marker') as HTMLElement;
    const gapIndicatorEl = document.getElementById('gap-indicator') as HTMLElement;

    if (!this._state.is_user_host && this._state.user_progress !== undefined && this._state.host_duration && this._state.host_duration > 0) {
      const userProgress = this._state.user_progress;
      const userPercent = Math.min((userProgress / this._state.host_duration) * 100, 100);
      const userColor = this.getColor(this.userId);

      // 1. Guest's vertical marker: ALWAYS visible showing position of "You"
      if (userPositionMarkerEl) {
        userPositionMarkerEl.style.left = userPercent + '%';
        userPositionMarkerEl.style.background = userColor;
        if (userPositionMarkerEl.style.display !== 'block') {
          userPositionMarkerEl.style.display = 'block';
        }
      }

      // 2. Calculate gap against host's current (extrapolated) position
      if (currentHostProgress !== undefined) {
        const gap = Math.abs(userProgress - currentHostProgress);
        const SHOW_THRESHOLD = 6; // Show when gap exceeds 6 seconds
        const HIDE_THRESHOLD = 4; // Hide when gap drops below 4 seconds

        // Hysteresis: show at 6s, hide at 4s, stay in between
        let shouldShow = this.markersVisible;
        if (gap > SHOW_THRESHOLD) {
          shouldShow = true;
        } else if (gap < HIDE_THRESHOLD) {
          shouldShow = false;
        }
        this.markersVisible = shouldShow;

        if (shouldShow) {
          const hostPercent = Math.min((currentHostProgress / this._state.host_duration) * 100, 100);

          // Arrow marker
          if (markerEl) {
            markerEl.style.left = userPercent + '%';
            markerEl.style.background = userColor;
            markerEl.classList.remove('arrow-left', 'arrow-right');
            if (userProgress < currentHostProgress) {
              markerEl.classList.add('arrow-right'); // User behind host, arrow points right towards host
            } else if (userProgress > currentHostProgress) {
              markerEl.classList.add('arrow-left'); // User ahead of host, arrow points left towards host
            }
            if (markerEl.style.display !== 'block') {
              markerEl.style.display = 'block';
            }
          }

          // Horizontal gap indicator line between user and host
          if (gapIndicatorEl) {
            const startPercent = Math.min(userPercent, hostPercent);
            const endPercent = Math.max(userPercent, hostPercent);
            const gapWidth = endPercent - startPercent;
            gapIndicatorEl.style.left = startPercent + '%';
            gapIndicatorEl.style.width = gapWidth + '%';
            gapIndicatorEl.style.background = userColor;
            if (gapIndicatorEl.style.display !== 'block') {
              gapIndicatorEl.style.display = 'block';
            }
          }
        } else {
          if (markerEl && markerEl.style.display !== 'none') markerEl.style.display = 'none';
          if (gapIndicatorEl && gapIndicatorEl.style.display !== 'none') gapIndicatorEl.style.display = 'none';
        }
      } else {
        if (markerEl && markerEl.style.display !== 'none') markerEl.style.display = 'none';
        if (gapIndicatorEl && gapIndicatorEl.style.display !== 'none') gapIndicatorEl.style.display = 'none';
      }
    } else {
      if (userPositionMarkerEl && userPositionMarkerEl.style.display !== 'none') userPositionMarkerEl.style.display = 'none';
      if (markerEl && markerEl.style.display !== 'none') markerEl.style.display = 'none';
      if (gapIndicatorEl && gapIndicatorEl.style.display !== 'none') gapIndicatorEl.style.display = 'none';
    }

    // Show sync button only for non-hosts (with stable flex display)
    if (syncBtn) {
      const targetSyncDisplay = !this._state.is_user_host ? 'inline-flex' : 'none';
      if (syncBtn.style.display !== targetSyncDisplay) {
        syncBtn.style.display = targetSyncDisplay;
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
      const hostUuid = this.getHostUuid();
      if (hostUuid) {
        const hostHtml = buildHostChipHtml(
          hostUuid,
          !!this._state.is_user_host,
          this._state.host_nickname,
          this.nicknameMap,
          this.getColor(hostUuid),
          this._state.co_watcher_activities?.[hostUuid]
        );
        if (hostContainer.innerHTML !== hostHtml) {
          hostContainer.innerHTML = hostHtml;
        }
      }

      // Render guest chips
      const guestHtml = buildGuestChipsHtml(
        this._state.session_members || [],
        this.getHostUuid(),
        this.userId,
        this.nicknameMap,
        (uuid) => this.getColor(uuid),
        this._state.co_watcher_activities
      );
      if (guestContainer.innerHTML !== guestHtml) {
        guestContainer.innerHTML = guestHtml;
      }

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
      const divergenceHtml = buildChooseNextRowsHtml(
        this._state.session_members || [],
        this.userId,
        this.nicknameMap,
        (uuid) => this.getColor(uuid),
        this._state.co_watcher_activities
      );

      if (guestRowsContainer.innerHTML !== divergenceHtml) {
        guestRowsContainer.innerHTML = divergenceHtml;

        // Attach join listeners
        for (const btn of guestRowsContainer.querySelectorAll('.join-button')) {
          btn.addEventListener('click', (e) => {
            const target = (e.target as HTMLElement).closest('.join-button') as HTMLElement;
            const uuid = target?.getAttribute('data-uuid') || (e.target as HTMLElement).getAttribute('data-uuid');
            if (uuid) this.handleJoinGuest(uuid);
          });
        }
      }
    }
  }

  /**
   * Render colored markers for each guest on the progress bar (host view only)
   */
  private renderGuestMarkers(): void {
    const container = document.getElementById('guest-markers-container');
    if (!container) return;

    if (!this._state.is_user_host || !this._state.watching_together) {
      if (container.innerHTML !== '') {
        container.innerHTML = '';
      }
      return;
    }

    const hostUuid = this.getHostUuid();
    let markersHtml = '';

    for (const uuid of this._state.watching_together) {
      if (uuid === this.userId || uuid === hostUuid) continue;

      const color = this.getColor(uuid);
      markersHtml += `<div class="guest-marker" id="guest-marker-${uuid}" style="background: ${color};"></div>`;
    }

    if (container.innerHTML !== markersHtml) {
      container.innerHTML = markersHtml;
    }

    this.updateGuestMarkers();
  }

  /**
   * Update positions of guest markers based on their progress (called from CO_WATCH_UPDATE handler)
   */
  private updateGuestMarkers(): void {
    if (!this._state.is_user_host || !this._state.guest_progress || !this._state.watching_together || !this._state.host_duration || this._state.host_duration <= 0) {
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
   * Render chat messages with consecutive message grouping and unified pill styling
   */
  private renderMessages(): void {
    const container = document.getElementById('hang-time-chat-container');
    if (!container) {
      console.warn('[OverlayUI] Chat container not found');
      return;
    }

    const messagesHtml = buildMessagesHtml(
      this._state.messages,
      this.userId,
      this._state.nicknameMap,
      (uuid) => this.getColor(uuid),
      this._state.co_watcher_activities
    );

    if (container.innerHTML !== messagesHtml) {
      container.innerHTML = messagesHtml;

      // Auto-scroll to bottom
      if (container.scrollHeight > 0) {
        container.scrollTop = container.scrollHeight;
      }
    }
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

    // Trigger toast if overlay is not fully open
    if (!this.isOverlayFullyVisible()) {
      this.showChatToast(sender, senderId, content);
    }
  }

  /**
   * Start progress bar animation loop (updates every second to simulate 1sec/1sec playback)
   */
  private startProgressAnimation(): void {
    if (this.progressUpdateInterval) {
      clearInterval(this.progressUpdateInterval);
    }
    this.progressUpdateInterval = setInterval(() => {
      // Only interpolate progress during active playback
      if (this._state.host_state === 'playing') {
        this.renderHeader();
      }
    }, 1000);
  }

  /**
   * Destroy overlay
   */

  /**
   * Handle incoming WebRTC signaling message from background
   */
  public handleWebRTCSignal(senderUuid: string, signal: WebRTCSignalPayload): void {
    this.voiceManager.handleSignal(senderUuid, signal);
  }

  /**
   * Send WebRTC signal to a peer via background port
   */
  private sendWebRTCSignal(targetUuid: string, signal: WebRTCSignalPayload): void {
    if (this.port) {
      this.port.postMessage({
        type: 'SEND_WEBRTC_SIGNAL',
        data: {
          target_uuid: targetUuid,
          activity_id: this._state.activity_id,
          signal,
        },
      });
    } else {
      window.postMessage({
        type: 'HANG_TIME_WEBRTC_SIGNAL',
        data: {
          target_uuid: targetUuid,
          activity_id: this._state.activity_id,
          signal,
        },
      }, '*');
    }
  }

  /**
   * Update speaking glow animation on attendee chips
   */
  private handleSpeakingEvent(event: AudioLevelEvent): void {
    const targetUuid = event.uuid === 'self' ? this.userId : event.uuid;
    const chips = document.querySelectorAll(`.attendee-chip[data-uuid="${targetUuid}"]`);
    chips.forEach(chip => {
      if (event.isSpeaking) {
        chip.classList.add('speaking');
      } else {
        chip.classList.remove('speaking');
      }
    });
  }

  /**
   * Update voice status indicator and mic button state
   */
  private renderVoiceState(participants: VoiceParticipant[]): void {
    const joinBtn = document.getElementById('voice-join-btn');
    const connectedStrip = document.getElementById('voice-connected-strip');
    const liveText = document.getElementById('voice-live-text');
    const muteToggle = document.getElementById('voice-mute-toggle');
    const muteLabel = document.getElementById('voice-mute-label');

    const inVoice = this.voiceManager.getInVoice();
    const isMuted = this.voiceManager.getIsMuted();

    if (joinBtn && connectedStrip) {
      if (inVoice) {
        joinBtn.style.display = 'none';
        connectedStrip.style.display = 'flex';
        if (liveText) {
          liveText.textContent = `Voice (${participants.length})`;
        }
      } else {
        joinBtn.style.display = 'inline-flex';
        connectedStrip.style.display = 'none';
      }
    }

    if (muteToggle && muteLabel) {
      if (isMuted) {
        muteToggle.classList.remove('active');
        muteToggle.classList.add('muted');
        muteLabel.textContent = 'Unmute (V)';
        muteToggle.title = 'Unmute Microphone (V)';
      } else {
        muteToggle.classList.remove('muted');
        muteToggle.classList.add('active');
        muteLabel.textContent = 'Mute (V)';
        muteToggle.title = 'Mute Microphone (V)';
      }
    }
  }

  destroy(): void {
    this.voiceManager.leaveVoice();
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
    this.clearChatToasts();
    if (this.toastContainer) {
      this.toastContainer.remove();
      this.toastContainer = null;
    }
    console.debug('[OverlayUI] Destroy complete');
  }
}
