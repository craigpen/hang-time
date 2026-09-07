/**
 * Format message timestamp into a clean time string (e.g. "10:42 PM")
 */
export function formatMessageTime(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Format timestamp for conversation section dividers (e.g. "Today 10:42 PM", "Yesterday 8:15 PM", "Sep 5, 2:30 PM")
 */
export function formatDividerDate(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return `Today ${timeStr}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  if (isYesterday) {
    return `Yesterday ${timeStr}`;
  }

  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
}


/**
 * Hang Time - Overlay UI Components
 * Pure rendering functions and HTML template generators for overlay UI
 */

import { CO_WATCHABLE_SERVICES } from '../co-watcher-detection.js';
import { VoiceParticipant } from '../voice/types.js';
import { getOverlayStyles } from './styles.js';

export interface RenderMessageItem {
  id: string;
  sender: string;
  sender_id: string;
  content: string;
  timestamp: number;
}

export interface ActivityInfo {
  activity_id: string;
  content: string;
  url?: string;
  service?: string;
  favicon?: string;
  freshness_timestamp?: number;
  timestamp?: number;
  metadata?: any;
}

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Linkify URLs in text while escaping for XSS safety
 */
export function linkifyContent(text: string): string {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const escaped = escapeHtml(text);
  return escaped.replace(urlRegex, (url) => {
    const safeUrl = escapeHtml(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color: #60a5fa; text-decoration: underline;">${safeUrl}</a>`;
  });
}

/**
 * Format seconds to mm:ss
 */
export function formatTime(totalSeconds: number): string {
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
export function getParticipantColor(
  uuid: string | undefined,
  hostUuid: string | undefined,
  currentUserId: string,
  userColorMap: Map<string, string>
): string {
  if (!uuid) {
    return '#6b7280'; // Gray fallback
  }

  // Rule 1: Host is always green/emerald
  if (uuid === hostUuid) {
    return '#10b981';
  }

  // Rule 2: Current user (when guest) is vivid coral
  if (uuid === currentUserId) {
    return '#f43f5e';
  }

  // Rule 3: Other guests get fixed mapped color
  if (userColorMap.has(uuid)) {
    return userColorMap.get(uuid)!;
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

  const color = guestColors[Math.abs(hash) % guestColors.length] || '#FF6B6B';
  userColorMap.set(uuid, color);
  return color;
}

/**
 * Calculate freshness style for participant activity (dim after 5min of inactivity)
 */
export function getActivityFreshnessStyle(
  uuid: string,
  coWatcherActivities?: Record<string, ActivityInfo>
): { opacity: number } {
  const activity = coWatcherActivities?.[uuid];
  const lastMeasuredAt = activity?.metadata?.progress_measured_at || activity?.timestamp;
  if (!lastMeasuredAt) {
    return { opacity: 1 };
  }

  const DIM_AFTER_MS = 5 * 60 * 1000; // 5 minutes
  const timeSinceLastSeen = Date.now() - lastMeasuredAt;

  if (timeSinceLastSeen >= DIM_AFTER_MS) {
    return { opacity: 0.5 }; // Dimmed after 5 min inactivity
  }
  return { opacity: 1 }; // Active
}

/**
 * Render service icon HTML
 */
export function getServiceIconHtml(service?: string): string {
  const serviceMap: Record<string, string> = {
    'youtube': 'youtube.png',
    'youtube-tab': 'youtube.png',
    'twitch': 'twitch.png',
    'twitch-tab': 'twitch.png',
    'netflix': 'netflix.png',
    'netflix-tab': 'netflix.png',
    'video-tab': 'video.png',
  };

  if (service && serviceMap[service]) {
    try {
      const iconUrl = chrome.runtime.getURL(`public/icons/${serviceMap[service]}`);
      return `<img src="${iconUrl}" style="width: 14px; height: 14px; object-fit: contain; flex-shrink: 0;" alt="">`;
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Return root HTML skeleton including stylesheet, header, controls, and chat panels
 */
export function getOverlaySkeletonHtml(): string {
  return `
    ${getOverlayStyles()}

    <div class="overlay-header">
      <div class="header-top">
        <div class="video-title" id="overlay-title">
          <svg viewBox="0 0 16 16" width="14" height="14" class="overlay-brand-icon">
            <rect x="0.5" y="0.5" width="4.5" height="15" rx="2.25" fill="#a855f7" />
            <rect x="11" y="0.5" width="4.5" height="15" rx="2.25" fill="#a855f7" />
            <polygon points="5,2.5 12,8 5,13.5" fill="#10b981" />
          </svg>
          <span id="overlay-title-text">Hang Time</span>
        </div>
        <div class="icon-buttons">
          <div class="opacity-control" id="opacity-control">
            <button class="icon-button" id="opacity-button" title="Overlay opacity">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="opacity-icon">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor"></path>
              </svg>
            </button>
            <div class="opacity-popover" id="opacity-popover">
              <div class="opacity-popover-header">
                <span>Opacity</span>
                <span class="opacity-value-label" id="opacity-value-label">80%</span>
              </div>
              <input type="range" min="10" max="100" value="80" class="opacity-slider" id="opacity-slider">
            </div>
          </div>
          <button class="icon-button" id="discord-button" title="Open Discord with host"></button>
          <button class="icon-button" id="pin-button" title="Pin overlay">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="17" x2="12" y2="22"></line>
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
            </svg>
          </button>
        </div>
      </div>

      <!-- Mode A: Co-Watching Layout -->
      <div id="watching-together-section" style="display: flex; flex-direction: column; gap: 4px;">
        <!-- Unified Media Player Card (Lines 1 & 2) -->
        <div class="media-player-card">
          <!-- Line 1: Media Title -->
          <div id="media-title-container" class="media-title-container"></div>

          <!-- Line 2: Playback Bar (Time + Scrubber Bar + Sync button) -->
          <div class="watching-together-row" id="watching-together-row">
            <div class="progress-bar-wrapper">
              <div class="progress-bar-controls-left">
                <div class="host-state-indicator" id="host-state-indicator">-</div>
                <span class="progress-time-display" id="progress-time-display">0:00</span>
              </div>
              <div class="progress-bar-container">
                <div class="progress-bar-fill" id="progress-bar-fill"></div>
                <div class="guest-markers-container" id="guest-markers-container"></div>
                <div class="gap-indicator" id="gap-indicator" style="display: none;"></div>
                <div class="user-position-marker" id="user-position-marker" style="display: none;"></div>
                <div class="progress-bar-marker" id="progress-bar-marker"></div>
              </div>
              <button id="progress-sync-button" class="progress-sync-button" title="Sync to host position">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                  <path d="M3 3v5h5"/>
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                  <path d="M16 16h5v5"/>
                </svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Line 3: Consolidated Room Strip (Participants + Voice Controls) -->
        <div class="room-participants-strip" id="room-participants-strip">
          <div class="room-participants-chips" id="room-participants-chips"></div>
          <div class="room-voice-actions" id="room-voice-actions">
            <button class="room-voice-btn" id="voice-join-btn" title="Join voice chat">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="22"></line>
              </svg>
              <span id="voice-join-label">Voice</span>
            </button>
            <div class="voice-connected-strip" id="voice-connected-strip" style="display: none;">
              <button class="voice-action-btn voice-mute-toggle" id="voice-mute-toggle" title="Toggle Microphone (V)">
                <svg class="mic-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                  <line x1="12" y1="19" x2="12" y2="22"></line>
                </svg>
                <span id="voice-mute-label">Mute</span>
                <span class="voice-kbd-badge">V</span>
              </button>
              <button class="voice-action-btn voice-leave-btn" id="voice-leave-btn" title="Leave voice room">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 6 6 18"></path>
                  <path d="m6 6 12 12"></path>
                </svg>
              </button>
            </div>
          </div>
        </div>
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
}

/**
 * Render host chip with inline media title & icon HTML
 */
export function buildMediaTitleHtml(activity?: ActivityInfo): string {
  if (!activity || !activity.content || !activity.service || !CO_WATCHABLE_SERVICES.has(activity.service)) {
    return '';
  }
  const iconHtml = getServiceIconHtml(activity.service);
  const title = escapeHtml(activity.content);
  return `
    <div class="media-title-row">
      ${iconHtml}
      <span class="media-title-text" title="${title}">${title}</span>
    </div>
  `;
}

/**
 * Render consolidated room participants HTML (Host first with accent border, followed by guests, with live voice indicators)
 */
export function buildRoomParticipantsHtml(
  sessionMembers: string[],
  hostUuid: string | undefined,
  currentUserId: string,
  nicknameMap: Map<string, string>,
  getColorFn: (uuid: string) => string,
  voiceParticipants: VoiceParticipant[] = [],
  coWatcherActivities?: Record<string, ActivityInfo>
): string {
  const voiceMap = new Map<string, VoiceParticipant>();
  for (const p of voiceParticipants) {
    voiceMap.set(p.uuid, p);
  }

  // Sort participants: Host ALWAYS first, then Self (if not host), then other members
  const orderedUuids: string[] = [];
  if (hostUuid && sessionMembers.includes(hostUuid)) {
    orderedUuids.push(hostUuid);
  }
  if (currentUserId !== hostUuid && sessionMembers.includes(currentUserId)) {
    orderedUuids.push(currentUserId);
  }
  for (const uuid of sessionMembers) {
    if (!orderedUuids.includes(uuid)) {
      orderedUuids.push(uuid);
    }
  }

  const chips: string[] = [];

  for (const uuid of orderedUuids) {
    const isHost = uuid === hostUuid;
    const isSelf = uuid === currentUserId;
    const { opacity } = getActivityFreshnessStyle(uuid, coWatcherActivities);
    const color = getColorFn(uuid);

    let name: string;
    if (isSelf) {
      name = 'You';
    } else {
      name = nicknameMap.get(uuid) || (isHost ? 'Host' : 'Guest');
    }
    name = escapeHtml(name);

    const voiceState = voiceMap.get(uuid);
    let micHtml = '';
    if (voiceState) {
      if (voiceState.isMuted) {
        micHtml = `
          <svg class="chip-mic-svg muted" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" title="Muted">
            <line x1="2" y1="2" x2="22" y2="22"></line>
            <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"></path>
            <path d="M5 10v2a7 7 0 0 0 12 5"></path>
            <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"></path>
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12"></path>
            <line x1="12" y1="19" x2="12" y2="22"></line>
          </svg>
        `;
      } else {
        micHtml = `
          <svg class="chip-mic-svg active" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" title="In Voice">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" y1="19" x2="12" y2="22"></line>
          </svg>
        `;
      }
    }

    const hostClass = isHost ? ' host-chip' : '';
    chips.push(`
      <div class="attendee-chip${hostClass}" data-uuid="${escapeHtml(uuid)}" style="background: ${color}; opacity: ${opacity};" title="${isHost ? 'Session Host' : ''}">
        <span>${name}</span>
        ${micHtml}
      </div>
    `);
  }

  return chips.join('');
}

/**
 * Render Mode B "Choose next:" section with guest rows HTML
 */
export function buildChooseNextRowsHtml(
  sessionMembers: string[],
  currentUserId: string,
  nicknameMap: Map<string, string>,
  getColorFn: (uuid: string) => string,
  coWatcherActivities?: Record<string, ActivityInfo>
): string {
  const rows: string[] = [];

  // Add label (matching test expectation "Choose next:")
  rows.push('<div class="overlay-role-label" style="margin-bottom: 8px;">Choose next:</div>');

  // Sort with self first
  const sorted = [...sessionMembers].sort((a, b) => {
    if (a === currentUserId) return -1;
    if (b === currentUserId) return 1;
    return 0;
  });

  for (const uuid of sorted) {
    const { opacity } = getActivityFreshnessStyle(uuid, coWatcherActivities);

    let name: string;
    if (uuid === currentUserId) {
      name = 'You';
    } else {
      name = nicknameMap.get(uuid) || '';
      if (!name) continue;
      name = escapeHtml(name);
    }

    const color = getColorFn(uuid);
    const activity = coWatcherActivities?.[uuid];
    const isWatching = activity && activity.activity_id && activity.service && CO_WATCHABLE_SERVICES.has(activity.service);

    let row: string;
    if (isWatching) {
      const iconHtml = getServiceIconHtml(activity.service);
      const title = escapeHtml(activity.content.substring(0, 40));
      const isSelf = uuid === currentUserId;
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
              <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; color: rgba(255, 255, 255, 0.85);" title="${escapeHtml(activity.content)}">${title}</span>
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
    return '';
  }
  return rows.join('');
}

/**
 * Render Chat Messages HTML
 */
export function buildMessagesHtml(
  messages: RenderMessageItem[],
  currentUserId: string,
  nicknameMapRecord: Record<string, string> | undefined,
  getColorFn: (uuid: string) => string,
  coWatcherActivities?: Record<string, ActivityInfo>
): string {
  const validMessages = messages.filter(msg => msg && msg.content);

  if (validMessages.length === 0) {
    return '<div style="text-align: center; color: rgba(255, 255, 255, 0.4); font-size: 11px; padding: 12px 0;">No messages yet</div>';
  }

  // Sort messages strictly chronologically (ascending)
  const sorted = [...validMessages].sort((a, b) => a.timestamp - b.timestamp);

  // Deduplicate any echo/optimistic duplicates
  const deduped: typeof validMessages = [];
  for (const msg of sorted) {
    const isDupe = deduped.some((existing) => {
      if (existing.id && msg.id && existing.id === msg.id) return true;
      if (existing.content === msg.content) {
        return Math.abs(existing.timestamp - msg.timestamp) < 10000;
      }
      return false;
    });
    if (!isDupe) {
      deduped.push(msg);
    }
  }

  let html = '';

  for (let i = 0; i < deduped.length; i++) {
    const msg = deduped[i];
    if (!msg) continue;

    const prevMsg = i > 0 ? deduped[i - 1] : null;
    const nextMsg = i < deduped.length - 1 ? deduped[i + 1] : null;

    // Check if we need a time divider (first message, >15m gap, or new calendar day)
    const isNewDay = prevMsg ? new Date(msg.timestamp).toDateString() !== new Date(prevMsg.timestamp).toDateString() : false;
    const isTimeGap = prevMsg ? (msg.timestamp - prevMsg.timestamp > 15 * 60 * 1000) : false;
    if (i === 0 || isNewDay || isTimeGap) {
      html += `<div class="chat-time-divider">${escapeHtml(formatDividerDate(msg.timestamp))}</div>`;
    }

    const isUser = msg.sender_id === currentUserId;
    const userColor = getColorFn(msg.sender_id);
    const displayName = isUser ? 'You' : (nicknameMapRecord?.[msg.sender_id] || msg.sender || 'Unknown');
    const { opacity } = getActivityFreshnessStyle(msg.sender_id, coWatcherActivities);

    // Consecutive if same sender within 3 minutes and no time divider in between
    const isConsecutive = !!prevMsg &&
      prevMsg.sender_id === msg.sender_id &&
      (msg.timestamp - prevMsg.timestamp < 3 * 60 * 1000) &&
      !isNewDay && !isTimeGap;

    // Last in cluster if next message is different sender, >3 mins away, or end of list
    const isLastInCluster = !nextMsg ||
      nextMsg.sender_id !== msg.sender_id ||
      (nextMsg.timestamp - msg.timestamp >= 3 * 60 * 1000) ||
      (new Date(nextMsg.timestamp).toDateString() !== new Date(msg.timestamp).toDateString());

    const headerHtml = !isConsecutive
      ? `<div class="attendee-chip" style="background: ${userColor}; opacity: ${opacity}; margin-bottom: 2px; font-size: 10px; padding: 1px 7px;">${escapeHtml(displayName)}</div>`
      : '';

    const timeHtml = isLastInCluster
      ? `<div class="message-time">${escapeHtml(formatMessageTime(msg.timestamp))}</div>`
      : '';

    html += `
      <div class="chat-message ${isUser ? 'message-user' : 'message-friend'}" style="${isConsecutive ? 'margin-top: -2px;' : ''}">
        ${headerHtml}
        <div class="message-content">${linkifyContent(msg.content)}</div>
        ${timeHtml}
      </div>
    `;
  }

  return html;
}


/**
 * Render an individual chat toast HTML
 */
export function buildChatToastHtml(
  senderName: string,
  senderColor: string,
  content: string
): string {
  return `
    <div class="toast-header">
      <div class="attendee-chip" style="background: ${senderColor}; font-size: 10px; padding: 1px 7px;"><span>${escapeHtml(senderName)}</span></div>
    </div>
    <div class="toast-content">${linkifyContent(content)}</div>
  `;
}
