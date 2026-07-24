/**
 * Hang Time - Shared Type Definitions
 * Central source of truth for all data models
 */

// ============================================================================
// USER & IDENTITY
// ============================================================================

export interface UserProfile {
  memorable_identifier: string;
  pubkey: string; // Hex public key for Nostr (64 chars)
  secret_key: string; // Hex secret key for signing events (128 chars)
  created_at: number;
  discord_info?: string;
  steam_id?: string;
  services_enabled: {
    spotify: boolean;
    twitch: boolean;
    steam: boolean;
    netflix: boolean;
    youtube: boolean;
  };
  notification_preferences: {
    friend_online: boolean;
    new_message: boolean;
    join_suggestion: boolean;
  };
}

export type ServiceName = 'spotify' | 'twitch' | 'steam' | 'netflix' | 'youtube';

// ============================================================================
// OAUTH & TOKENS
// ============================================================================

export interface OAuthToken {
  service: 'spotify' | 'twitch';
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scopes: string[];
  stored_at: number;
}

export interface OAuthTokens {
  spotify?: OAuthToken;
  twitch?: OAuthToken;
}

// ============================================================================
// FRIENDS & RELATIONSHIPS
// ============================================================================

export interface Friend {
  id: string;
  identifier: string;
  pubkey: string; // Nostr public key (64-char hex)
  local_name: string;
  added_at: number;
  last_seen: number;
  muted: boolean;
  hidden_services: ServiceName[];
  current_activities: Partial<Record<ServiceName, Activity>>;
}

export interface FriendList extends Array<Friend> {}

// ============================================================================
// ACTIVITY & CONTENT
// ============================================================================

export interface Activity {
  id: string; // Stable activity ID (deterministic hash of service + content URL) - generated at detection
  service: ServiceName;
  content: string; // The title/name of what's playing (single source of truth)
  url?: string; // Direct link to the content
  state?: 'playing' | 'paused' | 'stopped'; // Activity state
  timestamp: number; // When activity was detected
  metadata: {
    lastAccessed?: number; // Browser tab's lastAccessed time (for sorting order on remote side)
    progress?: number; // Current position in video (seconds)
    duration?: number; // Total length of video/content (seconds)
    artist?: string; // For music: artist name
    thumbnailUrl?: string; // Image/thumbnail URL (for display)
  };
}

export interface ActivityHistory {
  friend_id: string;
  activities: Activity[];
  updated_at: number;
}

// ============================================================================
// MESSAGES & CHAT
// ============================================================================

export interface Message {
  id: string;
  friend_id: string;
  friend_identifier: string;
  sender_identifier: string;
  activity_id: string; // Activity this message is about
  type: 'chat' | 'invite' | 'join_accepted' | 'join_declined'; // Message type
  content?: string; // Optional for invite/join messages
  is_outbound: boolean;
  timestamp: number;
  read: boolean;
  nostr_event_id?: string;
}

export interface MessageThread {
  friend_id: string;
  messages: Message[];
}

// ============================================================================
// NOSTR PROTOCOL
// ============================================================================

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: Array<[string, string]>;
  content: string;
  sig?: string;
}

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [key: string]: any;
}

// ============================================================================
// RELAY & CONNECTION
// ============================================================================

export interface RelayConfig {
  url: string;
  enabled: boolean;
  connected: boolean;
  last_connect_attempt?: number;
  last_error?: string;
  retry_count: number;
}

export interface RelayPool {
  relays: RelayConfig[];
  active_subscriptions: Map<string, RelaySubscription>;
}

export interface RelaySubscription {
  identifier: string;
  callback: (event: NostrEvent) => Promise<void>;
  subscription_id: string;
}

// ============================================================================
// SETTINGS & CONFIGURATION
// ============================================================================

export interface Settings {
  theme: 'light' | 'dark' | 'auto';
  relay_urls: string[];
  activity_poll_interval_ms: number;
  publish_rate_limit_ms: number;
  show_offline_friends: boolean;
  message_history_limit: number;
}

// ============================================================================
// NOSTR RELAYS (Single source of truth)
// ============================================================================

export const DEFAULT_RELAY_URLS = ['wss://nos.lol'];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  relay_urls: DEFAULT_RELAY_URLS,
  activity_poll_interval_ms: 5000,
  publish_rate_limit_ms: 2000,
  show_offline_friends: false,
  message_history_limit: 100,
};

// ============================================================================
// STORAGE SCHEMA (chrome.storage.local keys)
// ============================================================================

export const STORAGE_KEYS = {
  USER_PROFILE: 'hang_time_user_profile',
  FRIENDS_LIST: 'hang_time_friends',
  OAUTH_TOKENS: 'hang_time_oauth_tokens',
  CURRENT_ACTIVITY: 'hang_time_current_activity',
  SETTINGS: 'hang_time_settings',
  MESSAGES: (friendId: string) => `hang_time_messages_${friendId}`,
  ACTIVITY_HISTORY: (friendId: string) => `hang_time_activity_history_${friendId}`,
} as const;

// ============================================================================
// EXTENSION MESSAGES (chrome.runtime.sendMessage)
// ============================================================================

export type ExtensionMessageType =
  | 'GET_CURRENT_ACTIVITY'
  | 'GET_ALL_ACTIVE_ACTIVITIES'
  | 'GET_BROWSER_ACTIVITIES'
  | 'GET_ACTIVE_FRIENDS'
  | 'GET_ALL_FRIENDS'
  | 'GET_FRIEND_ACTIVITY_HISTORY'
  | 'GET_USER_IDENTIFIER'
  | 'GET_MESSAGES'
  | 'GET_OAUTH_STATUS'
  | 'ADD_FRIEND'
  | 'REMOVE_FRIEND'
  | 'RENAME_FRIEND'
  | 'SEND_MESSAGE'
  | 'TOGGLE_SERVICE'
  | 'MUTE_FRIEND'
  | 'UNMUTE_FRIEND'
  | 'SAVE_SETTINGS'
  | 'RESTORE_SETTINGS'
  | 'AUTHENTICATE_SERVICE'
  | 'DISCONNECT_SERVICE'
  | 'HANDLE_OAUTH_CALLBACK'
  | 'JOIN_ACTIVITY'
  | 'PUBLISH_VIDEO_SYNC'
  | 'CHECK_VIDEO_SYNC'
  | 'ACTIVITY_CHANGED'
  | 'FRIEND_ACTIVITY_UPDATED'
  | 'NEW_MESSAGE'
  | 'FRIEND_CAME_ONLINE'
  | 'FRIEND_WENT_OFFLINE';

export interface ExtensionMessage {
  type: ExtensionMessageType;
  data?: Record<string, any>;
}

export interface ExtensionResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================================
// SERVICE DETECTION
// ============================================================================

export interface IServiceModule {
  isEnabled(): Promise<boolean>;
  getCurrentActivity(): Promise<Activity | null>;
  hasToken(): Promise<boolean>;
  clearToken(): Promise<void>;
  getAuthUrl(): Promise<string>;
  handleAuthCallback(code: string): Promise<void>;
}

export type ServiceModules = {
  spotify?: IServiceModule;
  twitch?: IServiceModule;
  steam?: IServiceModule;
  tabs?: IServiceModule;
};

// ============================================================================
// ERRORS
// ============================================================================

export class HangTimeError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = 'HangTimeError';
  }
}

export class StorageError extends HangTimeError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'STORAGE_ERROR', context);
    this.name = 'StorageError';
  }
}

export class NostrError extends HangTimeError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'NOSTR_ERROR', context);
    this.name = 'NostrError';
  }
}

export class AuthError extends HangTimeError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'AUTH_ERROR', context);
    this.name = 'AuthError';
  }
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;

export interface AsyncResult<T, E = Error> {
  success: boolean;
  data?: T;
  error?: E;
}

// ============================================================================
// LOGGING
// ============================================================================

export interface LogContext {
  module: string;
  operation: string;
  data?: Record<string, any>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
