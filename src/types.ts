/**
 * Hang Time - Shared Type Definitions
 * Central source of truth for all data models
 */

// Import game discovery types for re-export
import type {
  OwnedGame,
  GameLibrary,
  GameMetadata,
  MetadataFetcherConfig,
  DiscoveryUIState,
  GameDiscoveryConfig,
} from './types/game-discovery';

export type {
  OwnedGame,
  GameLibrary,
  GameMetadata,
  MetadataFetcherConfig,
  DiscoveryUIState,
  GameDiscoveryConfig,
};

// ============================================================================
// USER & IDENTITY
// ============================================================================

export interface UserProfile {
  memorable_identifier: string;
  pubkey: string; // Hex public key for Nostr (64 chars)
  secret_key: string; // Hex secret key for signing events (128 chars)
  created_at: number;
  nickname?: string; // Display name for friend requests (published in profile)
  discord_info?: string;
  steam_id?: string;
  services_enabled: {
    'spotify-api': boolean;
    'twitch-api': boolean;
    'steam-api': boolean;
    'discord-api': boolean;
    'youtube-tab': boolean;
    'netflix-tab': boolean;
    'twitch-tab': boolean;
    'video-tab': boolean;
  };
  notification_preferences: {
    friend_online: boolean;
    new_message: boolean;
    join_suggestion: boolean;
  };
  publisher_config?: {
    enabled: boolean;
    size: 'atomic' | 'full';
    scope: 'updates' | 'all';
    rate_ms: number;
    relays: {
      'nos.lol': boolean;
      'nostr.mom': boolean;
      'relay.mostr.pub': boolean;
      'relay.primal.net': boolean;
    };
    retry_backoff_ms: number;
    compression: boolean;
    verbose_logging: boolean;
    delta_publishing: boolean;
    low_bandwidth_mode?: boolean; // Enable compression + 0.5 msg/s
  };
  steam_config?: {
    enabled: boolean;
    connection_type: 'api_key' | 'oauth';
    api_key?: string;
    oauth_token?: OAuthToken;
    steam_id?: string;
    steam_username?: string;
    last_verified?: number;
  };
  game_discovery?: {
    enabled: boolean;
    last_library_sync: number;
    last_metadata_refresh: number;
  };
  metadata_fetcher_config?: {
    rate_limit_per_second: number;
    batch_size: number;
    cache_ttl_ms: number;
    request_timeout_ms: number;
    max_retries: number;
    backoff_base_ms: number;
  };
  discovery_ui_state?: {
    filters: {
      genres: string[];
      modes: string[];
      playtime: 'all' | 'month' | 'week';
    };
    sortBy: 'most-friends' | 'score' | 'recent' | 'alphabetical';
  };
}

export type ServiceName = 'spotify-api' | 'twitch-api' | 'steam-api' | 'discord-api'
  | 'youtube-tab' | 'netflix-tab' | 'twitch-tab' | 'video-tab';

// ============================================================================
// OAUTH & TOKENS
// ============================================================================

export interface OAuthToken {
  service: 'spotify-api' | 'twitch-api' | 'steam-api' | 'discord-api';
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
  state: 'pending' | 'active'; // pending = invite sent, awaiting accept; active = mutual friends
  initiated_by_me?: boolean; // true if we sent the friend request, false if they sent it, undefined for active friends
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
  state?: 'playing' | 'paused' | 'stopped' | 'disconnected'; // Activity state: playing, paused, stopped, or disconnected (content script lost connection)
  audio: 'on' | 'off'; // Audio state detected from tab.audible (deprecated, kept for compatibility)
  timestamp: number; // When activity was detected
  freshness_timestamp: number; // When data was last refreshed (for calculating age and freshness)
  is_fresh?: boolean; // Whether data came from responsive content script (true) or stored/stale data (false)
  provenance?: 'LOCAL_TAB' | 'LOCAL_STEAM' | 'LOCAL_SPOTIFY' | 'LOCAL_TWITCH' | 'FRIEND' | 'TEST'; // Source of activity: user's tab, Steam/Spotify/Twitch API, friend's data, or test
  metadata: {
    lastAccessed?: number; // Browser tab's lastAccessed time (for sorting order on remote side)
    progress?: number; // Current position in video (seconds)
    duration?: number; // Total length of video/content (seconds)
    artist?: string; // For music: artist name
    thumbnailUrl?: string; // Image/thumbnail URL (for display)
    tabId?: number; // Chrome tab ID for tab-based services (netflix-tab, youtube-tab, twitch-tab)
    appid?: number; // Steam app ID for steam-api service
    disconnected_reason?: string; // Reason why content script disconnected (for state === 'disconnected')
    favicon?: string; // Dynamic favicon URL from content script
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

export interface PendingInvite {
  eventId: string; // Nostr event ID for deduplication
  activity: Activity; // The activity being invited to
  friendId: string; // Who we're inviting
  state: 'pending' | 'relay_accepted' | 'failed'; // unified state: pending (not yet confirmed by relay), relay_accepted (relay confirmed, awaiting friend response), failed (after max retries)
  sentAt: number; // When we first attempted to send
  relay_accepted_at?: number; // When relay confirmed receipt
  friend_responded_at?: number; // When friend's response was detected (marks completion)
  retryCount: number; // Number of retry attempts
  lastRetryAt?: number; // When we last retried
  lastError?: string; // Last error message from relay
}

export interface PendingMessage {
  eventId: string; // Nostr event ID for deduplication
  messageType: 'join_accepted' | 'join_declined' | 'friend_request' | 'chat'; // Type of message
  friendId: string; // Recipient friend ID
  activityId: string; // Associated activity ID
  content?: string; // Message content (for chat and friend_request)
  state: 'pending' | 'relay_accepted' | 'failed'; // unified state: pending (not yet confirmed by relay), relay_accepted (relay confirmed; completion depends on type), failed (after max retries)
  sentAt: number; // When we first attempted to send
  relay_accepted_at?: number; // When relay confirmed receipt
  friend_responded_at?: number; // When friend's response was detected (for handshake messages only)
  retryCount: number; // Number of retry attempts
  lastRetryAt?: number; // When we last retried
  lastError?: string; // Last error message from relay
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
// VIDEO DATA METRICS (Content script reliability)
// ============================================================================

export interface VideoDataFieldMetrics {
  undefined: number;
  invalid: number;
}

export interface ServiceVideoDataMetrics {
  total_requests: number;
  isPlaying: VideoDataFieldMetrics;
  duration: VideoDataFieldMetrics;
  currentTime: VideoDataFieldMetrics;
  netflix_title?: VideoDataFieldMetrics;
  last_reset: number;
}

export interface VideoDataMetrics {
  'netflix-tab'?: ServiceVideoDataMetrics;
  'youtube-tab'?: ServiceVideoDataMetrics;
  'twitch-tab'?: ServiceVideoDataMetrics;
}

// ============================================================================
// NOSTR RELAYS (Single source of truth)
// ============================================================================

export const DEFAULT_RELAY_URLS = [
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.mostr.pub',
  'wss://relay.primal.net',
];

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
  MY_ACTIVITIES: 'hang_time_my_activities',
  SETTINGS: 'hang_time_settings',
  VIDEO_DATA_METRICS: 'hang_time_video_data_metrics',
  PENDING_INVITES: 'hang_time_pending_invites',
  PENDING_MESSAGES: 'hang_time_pending_messages',
  NOTIFIED_INVITE_IDS: 'hang_time_notified_invite_ids',
  OAUTH_CONFIG: 'hang_time_oauth_config',
  NETFLIX_TITLE: 'hang_time_netflix_title',
  NETFLIX_TITLE_DATA: 'hang_time_netflix_title_data',
  CONTENT_SCRIPT_HEALTH: 'hang_time_content_script_health',
  INTEGRATION_HEALTH: 'hang_time_integration_health',
  NETFLIX_EXTRACTION_LOGS: 'hang_time_netflix_extraction_logs',
  NETFLIX_DEBUG_CAPTURES: 'hang_time_netflix_debug_captures',
  ACTIVITY_PROVENANCE_MAP: 'hang_time_activity_provenance_map',
  MY_GAME_LIBRARY: 'hang_time_my_game_library',
  FRIEND_GAME_LIBRARIES: 'hang_time_friend_game_libraries',
  GAME_METADATA_CACHE: 'hang_time_game_metadata_cache',
  FRIEND_PROFILES: 'hang_time_friend_profiles',
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
