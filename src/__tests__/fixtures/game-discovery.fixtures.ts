/**
 * Hang Time - Game Discovery Test Fixtures
 * Comprehensive test data for game discovery modules
 */

import { OwnedGame, GameMetadata, NostrEvent, Friend } from '../../types';

// ============================================================================
// GAME LIBRARY FIXTURES
// ============================================================================

export const SMALL_GAME_LIBRARY: OwnedGame[] = [
  { appId: 570, lastUpdated: Date.now() },
  { appId: 730, lastUpdated: Date.now() },
  { appId: 440, lastUpdated: Date.now() },
];

export const MEDIUM_GAME_LIBRARY: OwnedGame[] = [
  ...SMALL_GAME_LIBRARY,
  { appId: 220, lastUpdated: Date.now() },
  { appId: 330, lastUpdated: Date.now() },
  { appId: 1091500, lastUpdated: Date.now() },
  { appId: 262570, lastUpdated: Date.now() },
  { appId: 271590, lastUpdated: Date.now() },
  { appId: 239350, lastUpdated: Date.now() },
  { appId: 221100, lastUpdated: Date.now() },
];

export const LARGE_GAME_LIBRARY: OwnedGame[] = Array.from({ length: 500 }, (_, i) => ({
  appId: 100000 + i,
  lastUpdated: Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000,
}));

// ============================================================================
// STEAM API RESPONSE FIXTURES
// ============================================================================

export const STEAM_RESPONSE_PORTAL_2 = {
  330: {
    success: true,
    data: {
      name: 'Portal 2',
      genres: [{ description: 'Puzzle' }, { description: 'Adventure' }],
      categories: [
        { description: 'Single-player' },
        { description: 'Co-op' },
        { description: 'Steam Achievements' },
      ],
      platforms: { windows: true, mac: true, linux: false },
      metacritic: { score: 95 },
      header_image: 'https://cdn.akamai.steamstatic.com/steam/apps/330/header.jpg',
    },
  },
};

export const STEAM_RESPONSE_DOTA_2 = {
  570: {
    success: true,
    data: {
      name: 'Dota 2',
      genres: [{ description: 'Action' }, { description: 'Strategy' }],
      categories: [
        { description: 'Multiplayer' },
        { description: 'Online PvP' },
        { description: 'Free to Play' },
      ],
      platforms: { windows: true, mac: true, linux: true },
      metacritic: { score: 82 },
      header_image: 'https://cdn.akamai.steamstatic.com/steam/apps/570/header.jpg',
    },
  },
};

export const STEAM_RESPONSE_CSGO = {
  730: {
    success: true,
    data: {
      name: 'Counter-Strike: Global Offensive',
      genres: [{ description: 'Action' }],
      categories: [
        { description: 'Multiplayer' },
        { description: 'Online PvP' },
        { description: 'Free to Play' },
      ],
      platforms: { windows: true, mac: true, linux: true },
      metacritic: { score: 87 },
      header_image: 'https://cdn.akamai.steamstatic.com/steam/apps/730/header.jpg',
    },
  },
};

export const STEAM_RESPONSE_TEAM_FORTRESS_2 = {
  440: {
    success: true,
    data: {
      name: 'Team Fortress 2',
      genres: [{ description: 'Action' }],
      categories: [{ description: 'Multiplayer' }, { description: 'Free to Play' }],
      platforms: { windows: true, mac: true, linux: true },
      header_image: 'https://cdn.akamai.steamstatic.com/steam/apps/440/header.jpg',
    },
  },
};

export const STEAM_RESPONSE_MISSING_METADATA = {
  999999: {
    success: false,
  },
};

export const STEAM_RESPONSE_BATCH = {
  330: STEAM_RESPONSE_PORTAL_2[330],
  570: STEAM_RESPONSE_DOTA_2[570],
  730: STEAM_RESPONSE_CSGO[730],
};

// ============================================================================
// GAME METADATA FIXTURES
// ============================================================================

export const METADATA_PORTAL_2: GameMetadata = {
  appId: 330,
  name: 'Portal 2',
  genres: ['Puzzle', 'Adventure'],
  categories: ['Single-player', 'Co-op', 'Steam Achievements'],
  platforms: { windows: true, mac: true, linux: false },
  metacriticScore: 95,
  capsuleImageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/330/header.jpg',
  storePageUrl: 'https://store.steampowered.com/app/330/',
  lastFetched: Date.now(),
  isCrossPlayable: true,
};

export const METADATA_DOTA_2: GameMetadata = {
  appId: 570,
  name: 'Dota 2',
  genres: ['Action', 'Strategy'],
  categories: ['Multiplayer', 'Online PvP', 'Free to Play'],
  platforms: { windows: true, mac: true, linux: true },
  metacriticScore: 82,
  capsuleImageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/570/header.jpg',
  storePageUrl: 'https://store.steampowered.com/app/570/',
  lastFetched: Date.now(),
  isCrossPlayable: true,
};

export const METADATA_CSGO: GameMetadata = {
  appId: 730,
  name: 'Counter-Strike: Global Offensive',
  genres: ['Action'],
  categories: ['Multiplayer', 'Online PvP', 'Free to Play'],
  platforms: { windows: true, mac: true, linux: true },
  metacriticScore: 87,
  capsuleImageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/730/header.jpg',
  storePageUrl: 'https://store.steampowered.com/app/730/',
  lastFetched: Date.now(),
  isCrossPlayable: true,
};

export const METADATA_TF2: GameMetadata = {
  appId: 440,
  name: 'Team Fortress 2',
  genres: ['Action'],
  categories: ['Multiplayer', 'Free to Play'],
  platforms: { windows: true, mac: true, linux: true },
  metacriticScore: 0, // No metacritic score
  capsuleImageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/440/header.jpg',
  storePageUrl: 'https://store.steampowered.com/app/440/',
  lastFetched: Date.now(),
  isCrossPlayable: true,
};

export const METADATA_WINDOWS_ONLY: GameMetadata = {
  appId: 999,
  name: 'Windows Only Game',
  genres: ['Action'],
  categories: ['Single-player'],
  platforms: { windows: true, mac: false, linux: false },
  capsuleImageUrl: 'https://example.com/windows-only.jpg',
  storePageUrl: 'https://store.steampowered.com/app/999/',
  lastFetched: Date.now(),
  isCrossPlayable: false,
};

export const METADATA_NO_GENRES: GameMetadata = {
  appId: 111,
  name: 'Game Without Genres',
  genres: [],
  categories: ['Single-player'],
  platforms: { windows: true, mac: false, linux: false },
  capsuleImageUrl: 'https://example.com/no-genres.jpg',
  storePageUrl: 'https://store.steampowered.com/app/111/',
  lastFetched: Date.now(),
  isCrossPlayable: false,
};

export const METADATA_NO_CATEGORIES: GameMetadata = {
  appId: 222,
  name: 'Game Without Categories',
  genres: ['Action'],
  categories: [],
  platforms: { windows: true, mac: false, linux: false },
  capsuleImageUrl: 'https://example.com/no-cats.jpg',
  storePageUrl: 'https://store.steampowered.com/app/222/',
  lastFetched: Date.now(),
  isCrossPlayable: false,
};

// ============================================================================
// NOSTR EVENT FIXTURES
// ============================================================================

export const NOSTR_GAME_LIBRARY_EVENT_FRIEND_1: NostrEvent = {
  id: 'event-friend1-001',
  pubkey: 'friend1_pubkey_abc123def456',
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [
    ['t', 'game-library'],
    ['steam-id', 'friend1_steam_id'],
  ],
  content: JSON.stringify({
    appIds: [570, 730, 440, 220, 330],
    count: 5,
    timestamp: Date.now(),
  }),
};

export const NOSTR_GAME_LIBRARY_EVENT_FRIEND_2: NostrEvent = {
  id: 'event-friend2-001',
  pubkey: 'friend2_pubkey_xyz789abc123',
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [
    ['t', 'game-library'],
    ['steam-id', 'friend2_steam_id'],
  ],
  content: JSON.stringify({
    appIds: [730, 440, 1091500, 271590],
    count: 4,
    timestamp: Date.now(),
  }),
};

export const NOSTR_GAME_LIBRARY_EVENT_LARGE_LIBRARY: NostrEvent = {
  id: 'event-friend3-001',
  pubkey: 'friend3_pubkey_large_lib',
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [
    ['t', 'game-library'],
    ['steam-id', 'friend3_steam_id'],
  ],
  content: JSON.stringify({
    appIds: Array.from({ length: 200 }, (_, i) => 100000 + i),
    count: 200,
    timestamp: Date.now(),
  }),
};

export const NOSTR_EVENT_WRONG_TAG: NostrEvent = {
  id: 'event-invalid-001',
  pubkey: 'some_pubkey',
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [['t', 'activity']], // Wrong tag, not 'game-library'
  content: JSON.stringify({
    appIds: [570, 730],
    count: 2,
    timestamp: Date.now(),
  }),
};

export const NOSTR_EVENT_MALFORMED_JSON: NostrEvent = {
  id: 'event-malformed-001',
  pubkey: 'some_pubkey',
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [['t', 'game-library']],
  content: 'invalid json {{{',
};

export const NOSTR_EVENT_MISSING_APP_IDS: NostrEvent = {
  id: 'event-no-appids-001',
  pubkey: 'some_pubkey',
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [['t', 'game-library']],
  content: JSON.stringify({
    count: 0,
    timestamp: Date.now(),
    // Missing appIds field
  }),
};

export const NOSTR_EVENT_EMPTY_APP_IDS: NostrEvent = {
  id: 'event-empty-appids-001',
  pubkey: 'some_pubkey',
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [['t', 'game-library']],
  content: JSON.stringify({
    appIds: [],
    count: 0,
    timestamp: Date.now(),
  }),
};

// ============================================================================
// FRIEND LIST FIXTURES
// ============================================================================

export const FRIEND_1: Friend = {
  uuid: 'TenaciousTiger42',
  local_name: 'TenaciousTiger42',
  pubkey: 'friend1_pubkey_abc123def456',
  added_at: Date.now() - 30 * 24 * 60 * 60 * 1000,
  last_seen: Date.now(),
  hidden_services: [],
  current_activities: {},
  muted: false,
  state: 'active',
};

export const FRIEND_2: Friend = {
  uuid: 'LumiousLlama88',
  local_name: 'LumiousLlama88',
  pubkey: 'friend2_pubkey_xyz789abc123',
  added_at: Date.now() - 14 * 24 * 60 * 60 * 1000,
  last_seen: Date.now(),
  hidden_services: [],
  current_activities: {},
  muted: false,
  state: 'active',
};

export const FRIEND_3: Friend = {
  uuid: 'QuixoticQuokka77',
  local_name: 'QuixoticQuokka77',
  pubkey: 'friend3_pubkey_large_lib',
  added_at: Date.now() - 7 * 24 * 60 * 60 * 1000,
  last_seen: Date.now(),
  hidden_services: [],
  current_activities: {},
  muted: false,
  state: 'active',
};

export const FRIENDS_LIST: Friend[] = [FRIEND_1, FRIEND_2, FRIEND_3];

// ============================================================================
// CACHE DATA FIXTURES
// ============================================================================

export const CACHED_FRIEND_LIBRARIES = {
  friend1_pubkey_abc123def456: {
    pubkey: 'friend1_pubkey_abc123def456',
    appIds: [570, 730, 440, 220, 330],
    lastUpdated: Date.now(),
  },
  friend2_pubkey_xyz789abc123: {
    pubkey: 'friend2_pubkey_xyz789abc123',
    appIds: [730, 440, 1091500, 271590],
    lastUpdated: Date.now(),
  },
  friend3_pubkey_large_lib: {
    pubkey: 'friend3_pubkey_large_lib',
    appIds: Array.from({ length: 200 }, (_, i) => 100000 + i),
    lastUpdated: Date.now(),
  },
};

export const CACHED_METADATA = {
  330: METADATA_PORTAL_2,
  570: METADATA_DOTA_2,
  730: METADATA_CSGO,
  440: METADATA_TF2,
  999: METADATA_WINDOWS_ONLY,
  111: METADATA_NO_GENRES,
  222: METADATA_NO_CATEGORIES,
};

export const STALE_CACHED_METADATA = {
  330: {
    ...METADATA_PORTAL_2,
    lastFetched: Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 days old
  },
  570: {
    ...METADATA_DOTA_2,
    lastFetched: Date.now() - 40 * 24 * 60 * 60 * 1000, // 40 days old
  },
};

// ============================================================================
// EDGE CASE AND ERROR FIXTURES
// ============================================================================

export const API_ERROR_RESPONSES = {
  network_error: new Error('Network timeout'),
  invalid_json: new SyntaxError('Unexpected token'),
  timeout: Object.assign(new Error('Request timeout'), { name: 'AbortError' }),
  rate_limit: { status: 429, statusText: 'Too Many Requests', ok: false },
  server_error: { status: 500, statusText: 'Internal Server Error', ok: false },
  not_found: { status: 404, statusText: 'Not Found', ok: false },
};

// ============================================================================
// PERFORMANCE TEST FIXTURES
// ============================================================================

export const PERF_TEST_SMALL_BATCH = Array.from({ length: 10 }, (_, i) => 100000 + i);
export const PERF_TEST_MEDIUM_BATCH = Array.from({ length: 100 }, (_, i) => 200000 + i);
export const PERF_TEST_LARGE_BATCH = Array.from({ length: 500 }, (_, i) => 300000 + i);

// ============================================================================
// UI STATE FIXTURES
// ============================================================================

export const DISCOVERY_UI_STATE_DEFAULT = {
  filters: {
    genres: [],
    modes: [],
    playtime: 'all',
  },
  sortBy: 'most-friends',
};

export const DISCOVERY_UI_STATE_WITH_FILTERS = {
  filters: {
    genres: ['Action', 'RPG'],
    modes: ['Multiplayer', 'Co-op'],
    playtime: 'month',
  },
  sortBy: 'score',
};

export const DISCOVERY_UI_STATE_ALL_GENRES = {
  filters: {
    genres: ['Action', 'Adventure', 'Strategy', 'RPG', 'Puzzle', 'Shooter'],
    modes: [],
    playtime: 'all',
  },
  sortBy: 'alphabetical',
};

// ============================================================================
// COMMON GAMES CALCULATION FIXTURES
// ============================================================================

export const COMMON_GAMES_ALL_THREE_FRIENDS = [730, 440]; // All 3 friends own these
export const COMMON_GAMES_FRIEND_1_AND_2 = [570, 730, 440, 220, 330]; // Friend 1's library
export const COMMON_GAMES_FRIEND_1_AND_3 = Array.from({ length: 5 }, (_, i) => 100000 + i); // Subset

// ============================================================================
// NOSTR SYNC STATE FIXTURES
// ============================================================================

export const NOSTR_SUBSCRIPTION_STATES = {
  subscribed: ['friend1_pubkey_abc123def456', 'friend2_pubkey_xyz789abc123'],
  unsubscribed: [] as string[],
  failed: [] as string[],
};

// ============================================================================
// BROWSER COMPATIBILITY FIXTURES
// ============================================================================

export const CHROME_MANIFEST_V3 = {
  manifest_version: 3,
  name: 'Hang Time',
  version: '0.1.0',
  permissions: ['storage', 'tabs', 'activeTab'],
  host_permissions: ['https://store.steampowered.com/*', 'wss://*.nostr/*'],
};

export const FIREFOX_MANIFEST_V3 = {
  manifest_version: 3,
  name: 'Hang Time',
  version: '0.1.0',
  permissions: ['storage', 'tabs', 'activeTab'],
  host_permissions: ['https://store.steampowered.com/*', 'wss://*.nostr/*'],
};

// ============================================================================
// HELPER FUNCTIONS FOR FIXTURE GENERATION
// ============================================================================

/**
 * Generate a mock game library of specified size
 */
export function generateGameLibrary(size: number): OwnedGame[] {
  return Array.from({ length: size }, (_, i) => ({
    appId: 100000 + i,
    lastUpdated: Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000,
  }));
}

/**
 * Generate mock metadata for a game
 */
export function generateGameMetadata(appId: number, overrides?: Partial<GameMetadata>): GameMetadata {
  return {
    appId,
    name: `Game ${appId}`,
    genres: ['Action', 'Adventure'],
    categories: ['Multiplayer'],
    platforms: { windows: true, mac: Math.random() > 0.5, linux: Math.random() > 0.5 },
    metacriticScore: Math.floor(Math.random() * 100),
    capsuleImageUrl: `https://example.com/${appId}.jpg`,
    storePageUrl: `https://store.steampowered.com/app/${appId}/`,
    lastFetched: Date.now(),
    isCrossPlayable: Math.random() > 0.5,
    ...overrides,
  };
}

/**
 * Generate a mock Nostr game library event
 */
export function generateNostrGameLibraryEvent(pubkey: string, appIds: number[]): NostrEvent {
  return {
    id: `event-${pubkey}-${Date.now()}`,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [
      ['t', 'game-library'],
      ['steam-id', `steam-${pubkey}`],
    ],
    content: JSON.stringify({
      appIds,
      count: appIds.length,
      timestamp: Date.now(),
    }),
  };
}

/**
 * Generate mock friend list
 */
export function generateFriendsList(count: number): Friend[] {
  const adjectives = ['Tenacious', 'Luminous', 'Quixotic', 'Effervescent', 'Magnificent'];
  const animals = ['Tiger', 'Llama', 'Quokka', 'Penguin', 'Dolphin'];

  return Array.from({ length: count }, (_, i) => ({
    uuid: `${adjectives[i % adjectives.length]}${animals[i % animals.length]}${Math.floor(Math.random() * 100)}`,
    local_name: `${adjectives[i % adjectives.length]}${animals[i % animals.length]}${Math.floor(Math.random() * 100)}`,
    pubkey: `pubkey_${i}_${Math.random().toString(36).substring(7)}`,
    added_at: Date.now() - (i + 1) * 7 * 24 * 60 * 60 * 1000,
    last_seen: Date.now(),
    hidden_services: [],
    current_activities: {},
    muted: false,
    state: 'active' as const,
  }));
}

/**
 * Create a mock storage response with friend game libraries
 */
export function createMockFriendLibrariesStorage(friends: Friend[]): Record<string, any> {
  const result: Record<string, any> = {};

  friends.forEach((friend) => {
    const libSize = Math.floor(Math.random() * 100) + 10;
    result[friend.pubkey] = {
      pubkey: friend.pubkey,
      appIds: Array.from({ length: libSize }, (_, i) => 100000 + i),
      lastUpdated: Date.now(),
    };
  });

  return result;
}
