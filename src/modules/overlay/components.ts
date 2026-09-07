/**
 * Format message timestamp into a clean, human-readable string (e.g. "10:42 PM" or "Sep 6, 10:42 PM")
 */
export function formatMessageTime(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isToday) {
    return timeStr;
  }
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
}

/**
 * Hang Time - Overlay UI Components
 * Pure rendering functions and HTML template generators for overlay UI
 */

import { CO_WATCHABLE_SERVICES } from '../co-watcher-detection.js';
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
          <input type="range" min="10" max="100" value="80" class="opacity-slider" id="opacity-slider" title="Overlay opacity">
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
      <div id="watching-together-section" style="display: flex; flex-direction: column; gap: 6px;">
        <!-- Line 1: Host Row (Includes inline Title) -->
        <div id="host-chip-container" class="overlay-role-row"></div>

        <!-- Line 2: Left Controls (State + Time) + Progress Bar + Sync button -->
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
            <button id="progress-sync-button" title="Sync to host position">↻</button>
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
}

/**
 * Render host chip with inline media title & icon HTML
 */
export function buildHostChipHtml(
  hostUuid: string,
  isUserHost: boolean,
  hostNickname: string | undefined,
  nicknameMap: Map<string, string>,
  hostColor: string,
  activity?: ActivityInfo
): string {
  let hostName: string;
  if (isUserHost) {
    hostName = 'You';
  } else {
    hostName = nicknameMap.get(hostUuid) || hostNickname || 'Host';
  }
  hostName = escapeHtml(hostName);

  let mediaHtml = '';
  if (activity && activity.content && activity.service && CO_WATCHABLE_SERVICES.has(activity.service)) {
    const iconHtml = getServiceIconHtml(activity.service);
    const title = escapeHtml(activity.content);
    mediaHtml = `
      <div style="display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; flex: 1;">
        ${iconHtml}
        <span class="media-title-text" style="font-size: 11px; color: rgba(255, 255, 255, 0.85); font-weight: 500;" title="${title}">${title}</span>
      </div>
    `;
  }

  return `
    <span class="overlay-role-label">HOST</span>
    <div class="attendee-chip" style="background: ${hostColor}; flex-shrink: 0;"><span>${hostName}</span></div>
    ${mediaHtml}
  `;
}

/**
 * Render guest chips HTML
 */
export function buildGuestChipsHtml(
  sessionMembers: string[],
  hostUuid: string | undefined,
  currentUserId: string,
  nicknameMap: Map<string, string>,
  getColorFn: (uuid: string) => string,
  coWatcherActivities?: Record<string, ActivityInfo>
): string {
  const chips: string[] = [];

  // Sort with self first
  const sorted = [...sessionMembers].sort((a, b) => {
    if (a === currentUserId) return -1;
    if (b === currentUserId) return 1;
    return 0;
  });

  for (const uuid of sorted) {
    if (uuid === hostUuid) continue; // Skip host (shown separately)

    const { opacity } = getActivityFreshnessStyle(uuid, coWatcherActivities);

    let name: string;
    if (uuid === currentUserId) {
      name = 'You';
    } else {
      name = nicknameMap.get(uuid) || '';
      if (!name) continue; // Skip if no nickname
      name = escapeHtml(name);
    }

    const color = getColorFn(uuid);
    chips.push(`<div class="attendee-chip" style="background: ${color}; opacity: ${opacity};"><span>${name}</span></div>`);
  }

  if (chips.length > 0) {
    return `
      <span class="overlay-role-label">GUESTS</span>
      <div style="display: flex; gap: 4px; flex-wrap: wrap; align-items: center;">${chips.join('')}</div>
    `;
  }
  return '';
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
  let lastSenderId: string | null = null;

  for (const msg of deduped) {
    const isUser = msg.sender_id === currentUserId;
    const userColor = getColorFn(msg.sender_id);
    const displayName = isUser ? 'You' : (nicknameMapRecord?.[msg.sender_id] || msg.sender || 'Unknown');
    const { opacity } = getActivityFreshnessStyle(msg.sender_id, coWatcherActivities);
    const isConsecutive = lastSenderId === msg.sender_id;
    lastSenderId = msg.sender_id;

    const headerHtml = !isConsecutive
      ? `<div class="attendee-chip" style="background: ${userColor}; opacity: ${opacity}; margin-bottom: 2px; font-size: 10px; padding: 1px 7px;">${escapeHtml(displayName)}</div>`
      : '';

    const formattedTime = formatMessageTime(msg.timestamp);
    const dataTimeAttr = formattedTime ? ` data-time="${escapeHtml(formattedTime)}"` : '';

    html += `
      <div class="chat-message ${isUser ? 'message-user' : 'message-friend'}" style="${isConsecutive ? 'margin-top: -3px;' : ''}">
        ${headerHtml}
        <div class="message-content"${dataTimeAttr}>${linkifyContent(msg.content)}</div>
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
