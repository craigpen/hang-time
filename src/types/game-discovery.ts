/**
 * Hang Time - Game Discovery Type Definitions
 * Types for game library management, metadata fetching, and discovery UI
 */

// ============================================================================
// GAME LIBRARY
// ============================================================================

/**
 * A game owned by the user on a given platform(s)
 */
export interface OwnedGame {
  appId: number;
  platformsOwned?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
  lastUpdated: number;
  rtime_last_played?: number; // Unix timestamp of last play time from Steam API
}

/**
 * User's game library (cached from Steam API)
 */
export interface GameLibrary {
  ownedGames: OwnedGame[];
  lastFetched: number;
  steamId?: string; // For Steam API tracking
}

// ============================================================================
// GAME METADATA
// ============================================================================

/**
 * Enriched metadata for a game from Steam API
 */
export interface GameMetadata {
  appId: number;
  name: string;
  genres: string[];
  categories: string[];
  platforms: {
    windows: boolean;
    mac: boolean;
    linux: boolean;
  };
  metacriticScore?: number;
  capsuleImageUrl: string;
  storePageUrl: string;
  lastFetched: number;
  isCrossPlayable?: boolean; // Cached on fetch
}

// ============================================================================
// METADATA FETCHER CONFIGURATION
// ============================================================================

/**
 * Configuration for the metadata fetching service
 */
export interface MetadataFetcherConfig {
  rate_limit_per_second: number; // Default: 1.5
  batch_size: number; // Default: 10
  cache_ttl_ms: number; // Default: 2592000000 (30 days)
  request_timeout_ms: number; // Default: 5000
  max_retries: number; // Default: 3
  backoff_base_ms: number; // Default: 1000
}

// ============================================================================
// DISCOVERY UI STATE
// ============================================================================

/**
 * Filter and sort preferences for the games tab
 */
export interface GamesUIState {
  filters: {
    genres: string[];
    modes: string[];
    playtime: 'all' | 'month' | 'week';
  };
  sortBy: 'most-friends' | 'score' | 'recent' | 'alphabetical';
}

// ============================================================================
// GAME DISCOVERY PROFILE FIELDS
// ============================================================================

/**
 * Game discovery configuration embedded in UserProfile
 */
export interface GameDiscoveryConfig {
  enabled: boolean;
  last_library_sync: number;
  last_metadata_refresh: number;
}
