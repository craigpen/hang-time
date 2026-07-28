# Game Discovery Implementation Plan

**Baseline Commit**: 4c8c6a2  
**Status**: Ready for implementation  
**Created**: 2026-07-28

---

## Overview

Implementation of game discovery feature across three main components:
1. **GameLibraryManager** — Manage game libraries (fetch, cache, intersections)
2. **MetadataFetcher** — Background metadata service with rate limiting
3. **Discovery Tab UI** — Filter panel, sort dropdown, result cards

All components integrate with existing architecture (StorageManager, RelayPool, Publisher, ServiceWorker).

---

## 1. Module Architecture & Interfaces

### 1.1 GameLibraryManager

**File**: `src/modules/game-library.ts`

```typescript
interface OwnedGame {
  appId: number;
  platformsOwned?: { windows?: boolean; mac?: boolean; linux?: boolean };
  lastUpdated: number;
}

interface GameLibrary {
  ownedGames: OwnedGame[];
  lastFetched: number;
  steamId?: string; // For Steam API tracking
}

class GameLibraryManager {
  private storageManager: StorageManager;
  private metadataFetcher: MetadataFetcher;
  private relayPool: RelayPool;
  
  // Lifecycle
  async initialize(): Promise<void>
  async start(): Promise<void>
  async stop(): Promise<void>
  
  // Own library
  async fetchMyGameLibrary(): Promise<OwnedGame[]>
  async getMyGameLibrary(): Promise<OwnedGame[]>
  async publishMyGameLibrary(): Promise<void>
  
  // Friend libraries
  async subscribeToFriendGames(friendPubkeys: string[]): Promise<void>
  async unsubscribeFromFriendGames(friendPubkeys: string[]): Promise<void>
  private handleGameLibraryEvent(event: NostrEvent): Promise<void>
  async getFriendGameLibrary(friendPubkey: string): Promise<OwnedGame[] | null>
  
  // Intersections
  async getCommonGames(friendPubkey: string): Promise<OwnedGame[]>
  async getCommonGamesFiltered(
    friendPubkey: string,
    appIds: number[]
  ): Promise<OwnedGame[]>
  
  // Background refresh
  private schedulePeriodicRefresh(): void
  private refreshLibraryIfStale(): Promise<void>
  
  // Error handling
  private handleFetchError(error: Error): Promise<void>
  private resetOnStorageError(): Promise<void>
}
```

**Responsibilities:**
- Fetch GetOwnedGames from Steam API (with auth token)
- Cache locally with 7-day TTL
- Publish to Nostr as kind 1 events (tag: "game-library")
- Subscribe to friends' game library kind 1 events
- Calculate common games with platform filtering
- Schedule periodic refreshes (every 6 hours)
- Handle errors gracefully

**Dependencies:**
- StorageManager (cache OwnedGames)
- MetadataFetcher (enrich with metadata)
- RelayPool (publish/subscribe)

---

### 1.2 MetadataFetcher

**File**: `src/modules/metadata-fetcher.ts`

```typescript
interface GameMetadata {
  appId: number;
  name: string;
  genres: string[];
  categories: string[];
  platforms: { windows: boolean; mac: boolean; linux: boolean };
  metacriticScore?: number;
  capsuleImageUrl: string;
  storePageUrl: string;
  lastFetched: number;
  isCrossPlayable?: boolean; // Cached on fetch
}

interface MetadataFetcherConfig {
  rate_limit_per_second: number; // Default: 1.5
  batch_size: number; // Default: 10
  cache_ttl_ms: number; // Default: 2592000000 (30 days)
  request_timeout_ms: number; // Default: 5000
  max_retries: number; // Default: 3
  backoff_base_ms: number; // Default: 1000
}

class MetadataFetcher {
  private storageManager: StorageManager;
  private config: MetadataFetcherConfig;
  private requestQueue: Queue<number>; // appIds to fetch
  private isProcessing: boolean = false;
  private lastRequestTime: number = 0;
  private failedAppIds: Map<number, number>; // appId -> retry count
  
  constructor(storageManager: StorageManager)
  
  // Public API
  async fetchMetadata(appId: number): Promise<GameMetadata | null>
  async batchFetchMetadata(appIds: number[]): Promise<Map<number, GameMetadata>>
  async getMetadata(appId: number): Promise<GameMetadata | null>
  async scheduleBackgroundRefresh(appIds: number[]): Promise<void>
  
  // Background service
  async startBackgroundFetcher(): Promise<void>
  async stopBackgroundFetcher(): Promise<void>
  private processQueue(): Promise<void>
  
  // Rate limiting
  private getRateLimitDelay(): number
  private enforceRateLimit(): Promise<void>
  private calculateBackoff(retryCount: number): number
  
  // Steam API
  private fetchFromSteamAPI(appId: number): Promise<any>
  private parseAppDetails(raw: any): GameMetadata
  
  // Cross-platform detection
  isCrossPlayable(metadata: GameMetadata): boolean
  
  // Cache management
  private getCachedMetadata(appId: number): GameMetadata | null
  private setCachedMetadata(appId: number, metadata: GameMetadata): Promise<void>
  private isCacheStale(metadata: GameMetadata): boolean
  private evictStaleCache(): Promise<void>
  
  // Error handling
  private handleFetchError(appId: number, error: Error): Promise<void>
  private shouldRetry(error: Error): boolean
}
```

**Responsibilities:**
- Fetch game metadata from Steam API appdetails endpoint
- Cache locally with 30-day TTL
- Implement rate limiting (1-2 requests/second)
- Queue management for background fetching
- Exponential backoff on failures
- Cross-platform playability detection
- Evict stale cache entries

**Dependencies:**
- StorageManager (cache metadata)
- No external HTTP library (use fetch)

---

## 2. Integration with Existing Systems

### 2.1 ServiceWorker Integration

**File**: `src/background.ts`

```typescript
class ServiceWorkerBootstrap {
  private gameLibraryManager: GameLibraryManager;
  private metadataFetcher: MetadataFetcher;
  
  async onInstall() {
    // Initialize managers
    this.gameLibraryManager = new GameLibraryManager(storageManager);
    this.metadataFetcher = new MetadataFetcher(storageManager);
    
    // Start services
    await this.gameLibraryManager.start();
    await this.metadataFetcher.startBackgroundFetcher();
  }
  
  async onUninstall() {
    await this.gameLibraryManager.stop();
    await this.metadataFetcher.stopBackgroundFetcher();
  }
}
```

**Lifecycle:**
- On install: Initialize and start both managers
- On uninstall: Clean shutdown
- On message from popup: Route to appropriate manager

### 2.2 RelayPool Integration

**Current**: RelayPool handles kind 1 subscriptions (activity)

**Change**: Add game-library tag filter

```typescript
// In RelayPool.subscribe()
const filter = {
  kinds: [1],
  tags: { t: ["game-library", "activity"] }, // Subscribe to both
  authors: friendPubkeys,
};
```

**Event routing:**
```typescript
relayPool.on('event', (event: NostrEvent) => {
  if (hasTag(event, 't', 'game-library')) {
    gameLibraryManager.handleGameLibraryEvent(event);
  } else if (hasTag(event, 't', 'activity')) {
    activityDetector.handleActivityEvent(event);
  }
});
```

### 2.3 Publisher Integration

**Current**: ActivityPublisher sends kind 1 activity events

**Change**: Add game library publishing

```typescript
// In ActivityPublisher.publishCycle()
async publishCycle() {
  // ... existing activity publishing ...
  
  // Also publish game library (every 6 hours or on-demand)
  if (this.shouldPublishGameLibrary()) {
    const library = await gameLibraryManager.getMyGameLibrary();
    await this.publishGameLibrary(library);
  }
}

private publishGameLibrary(library: OwnedGame[]) {
  const event: NostrEvent = {
    kind: 1,
    tags: [
      ['t', 'game-library'],
      ['steam-id', userSteamId],
    ],
    content: JSON.stringify({
      appIds: library.map(g => g.appId),
      count: library.length,
      timestamp: Date.now(),
    }),
    created_at: Math.floor(Date.now() / 1000),
  };
  
  await this.relayPool.publish(event);
}
```

### 2.4 StorageManager Integration

**Current STORAGE_KEYS**: MY_ACTIVITIES, FRIEND_ACTIVITIES, etc.

**New STORAGE_KEYS**:
```typescript
const STORAGE_KEYS = {
  // ... existing ...
  MY_GAME_LIBRARY: "hang_time_my_game_library",
  FRIEND_GAME_LIBRARIES: "hang_time_friend_game_libraries",
  GAME_METADATA_CACHE: "hang_time_game_metadata_cache",
};
```

**All access through StorageManager**:
```typescript
// ✅ Correct
await storageManager.set(STORAGE_KEYS.MY_GAME_LIBRARY, library);

// ❌ Never
await chrome.storage.local.set({ [STORAGE_KEYS.MY_GAME_LIBRARY]: library });
```

---

## 3. Data Flow & Lifecycle

### 3.1 Initialization Flow

```
ServiceWorker starts
  ├─ GameLibraryManager.initialize()
  │  ├─ Load cached my_game_library from storage
  │  ├─ Load cached friend_game_libraries from storage
  │  └─ Schedule periodic refresh (6 hours)
  │
  ├─ MetadataFetcher.initialize()
  │  ├─ Load cached game_metadata from storage
  │  └─ Start background processing queue
  │
  ├─ RelayPool subscribes to friends' game-library kind 1 events
  │
  └─ ActivityPublisher adds game library publishing cycle
```

### 3.2 Fetch & Publish Flow

```
User enables game discovery in settings
  │
  ├─ GameLibraryManager.fetchMyGameLibrary()
  │  ├─ Call Steam API GetOwnedGames (with auth token)
  │  ├─ Parse and validate response
  │  ├─ Store in MY_GAME_LIBRARY cache (7-day TTL)
  │  └─ Return list of OwnedGames
  │
  ├─ MetadataFetcher.scheduleBackgroundRefresh()
  │  └─ Queue all appIds for metadata fetching
  │
  ├─ MetadataFetcher processes queue in background
  │  ├─ Fetch appdetails from Steam API (rate limited)
  │  ├─ Parse genres, categories, platforms, score
  │  ├─ Detect cross-platform support
  │  ├─ Store in GAME_METADATA_CACHE (30-day TTL)
  │  └─ Continue with backoff on failures
  │
  └─ ActivityPublisher publishes game library
     ├─ Create kind 1 event with appIds
     ├─ Tag with "game-library"
     └─ Publish to relays
```

### 3.3 Discovery Tab Display Flow

```
User opens Discovery tab
  │
  ├─ Detect local platform (windows/mac/linux)
  │
  ├─ Load from cache:
  │  ├─ MY_GAME_LIBRARY (my owned games)
  │  ├─ FRIEND_GAME_LIBRARIES (friends' owned games)
  │  └─ GAME_METADATA_CACHE (metadata for all)
  │
  ├─ Filter games:
  │  ├─ Platform support: Game must work on user's OS
  │  ├─ Multiplayer: Game must have multiplayer/co-op
  │  ├─ Cross-platform: If single-platform, user must own it
  │  └─ User filters: Genre, mode, playtime
  │
  ├─ Sort results:
  │  └─ By: most friends, score, recent, alphabetical
  │
  └─ Display result cards:
     ├─ Game name (clickable → Steam store)
     ├─ Genres (clickable → filter)
     ├─ User score
     └─ Friend list: "5 friends own: Alice, Bob, Carol"
```

### 3.4 Friend Library Update Flow

```
Friend publishes game library via Nostr kind 1
  │
  ├─ RelayPool receives event
  │
  ├─ Event dispatcher routes to GameLibraryManager
  │
  ├─ GameLibraryManager.handleGameLibraryEvent()
  │  ├─ Validate event structure
  │  ├─ Parse appIds from event content
  │  ├─ Store in FRIEND_GAME_LIBRARIES[friendPubkey]
  │  ├─ Set TTL to 7 days
  │  └─ Schedule metadata refresh for new appIds
  │
  └─ MetadataFetcher.scheduleBackgroundRefresh()
     └─ Queue any new appIds not in GAME_METADATA_CACHE
```

---

## 4. Error Handling Strategy

### 4.1 Steam API Errors

**Rate Limiting (429)**:
```typescript
if (error.status === 429) {
  const retryAfter = error.headers['retry-after'] || '60';
  const backoff = calculateBackoff(failedAppIds.get(appId) || 0);
  queue.delayRetry(appId, Math.max(parseInt(retryAfter) * 1000, backoff));
}
```

**Malformed Response (400, 404)**:
```typescript
if (error.status >= 400 && error.status < 500) {
  if (error.status === 404) {
    // App doesn't exist, skip permanently
    failedAppIds.delete(appId);
    return null;
  }
  // Other client error, skip with backoff
  queue.delayRetry(appId, backoff);
}
```

**Network Errors (timeout, connectivity)**:
```typescript
if (error instanceof TimeoutError || error instanceof NetworkError) {
  const retryCount = failedAppIds.get(appId) || 0;
  if (retryCount < config.max_retries) {
    queue.delayRetry(appId, calculateBackoff(retryCount + 1));
  } else {
    // Give up after max retries, log and continue
    logger.warn(`MetadataFetcher: gave up on appId ${appId} after ${config.max_retries} retries`);
  }
}
```

### 4.2 Storage Errors

**Quota exceeded**:
```typescript
async evictStaleCache(): Promise<void> {
  // Remove oldest entries until we have space
  const entries = await this.getAllCachedMetadata();
  const sorted = entries.sort((a, b) => a.lastFetched - b.lastFetched);
  
  for (const entry of sorted) {
    if (this.isCacheStale(entry)) {
      await storageManager.delete(entry.appId);
    }
  }
}
```

**Corruption detection**:
```typescript
private validateMetadata(data: any): GameMetadata {
  if (!data.appId || !data.name || !Array.isArray(data.genres)) {
    throw new Error(`Corrupt metadata for appId ${data.appId}`);
  }
  return data as GameMetadata;
}
```

### 4.3 Nostr Errors

**Event validation**:
```typescript
private validateGameLibraryEvent(event: NostrEvent): boolean {
  // Must have game-library tag
  if (!hasTag(event, 't', 'game-library')) return false;
  
  // Content must be valid JSON with appIds
  try {
    const content = JSON.parse(event.content);
    if (!Array.isArray(content.appIds)) return false;
    return true;
  } catch {
    return false;
  }
}
```

**Relay failures**: Already handled by RelayPool (reconnect, fallback)

---

## 5. Rate Limiting Implementation

### 5.1 Token Bucket Algorithm

```typescript
class RateLimiter {
  private tokens: number;
  private refillRate: number; // tokens per second
  private maxTokens: number;
  private lastRefillTime: number;
  
  constructor(rate: number) {
    this.refillRate = rate;
    this.maxTokens = rate * 10; // 10 second buffer
    this.tokens = this.maxTokens;
    this.lastRefillTime = Date.now();
  }
  
  async acquireToken(): Promise<void> {
    this.refill();
    
    while (this.tokens < 1) {
      const waitMs = (1 - this.tokens) / this.refillRate * 1000;
      await sleep(waitMs);
      this.refill();
    }
    
    this.tokens -= 1;
  }
  
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillTime) / 1000;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRate
    );
    this.lastRefillTime = now;
  }
}
```

### 5.2 Queue Management

```typescript
class FetchQueue {
  private queue: number[] = []; // appIds
  private processing: Map<number, number> = new Map(); // appId -> retry count
  private rateLimiter: RateLimiter;
  
  async process(callback: (appId: number) => Promise<void>): Promise<void> {
    while (this.queue.length > 0) {
      const appId = this.queue.shift()!;
      
      try {
        await this.rateLimiter.acquireToken();
        await callback(appId);
        this.processing.delete(appId);
      } catch (error) {
        const retryCount = (this.processing.get(appId) || 0) + 1;
        
        if (retryCount < MAX_RETRIES) {
          this.processing.set(appId, retryCount);
          const backoff = Math.pow(2, retryCount) * 1000; // Exponential
          setTimeout(() => this.queue.push(appId), backoff);
        } else {
          logger.warn(`Failed to fetch metadata for ${appId} after ${MAX_RETRIES} retries`);
          this.processing.delete(appId);
        }
      }
    }
  }
}
```

### 5.3 Monitoring

```typescript
class RateLimitMonitor {
  private stats = {
    requestsAttempted: 0,
    requestsSucceeded: 0,
    requestsFailed: 0,
    rateLimitHits: 0,
    totalBackoffTime: 0,
  };
  
  logRequest(result: 'success' | 'failure' | 'rate_limited'): void {
    this.stats.requestsAttempted++;
    
    if (result === 'success') {
      this.stats.requestsSucceeded++;
    } else if (result === 'rate_limited') {
      this.stats.rateLimitHits++;
    } else {
      this.stats.requestsFailed++;
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.requestsSucceeded / this.stats.requestsAttempted,
      rateLimitRate: this.stats.rateLimitHits / this.stats.requestsAttempted,
    };
  }
}
```

---

## 6. Background Service Lifecycle

### 6.1 Scheduling

```typescript
class MetadataFetcher {
  private processingIntervalId: NodeJS.Timeout | null = null;
  private refreshIntervalId: NodeJS.Timeout | null = null;
  
  async startBackgroundFetcher(): Promise<void> {
    // Process queued items continuously
    this.processingIntervalId = setInterval(
      () => this.processQueue(),
      100 // Check queue every 100ms
    );
    
    // Refresh stale cache every hour
    this.refreshIntervalId = setInterval(
      () => this.refreshStaleLibraries(),
      3600000 // 1 hour
    );
  }
  
  async stopBackgroundFetcher(): Promise<void> {
    if (this.processingIntervalId) {
      clearInterval(this.processingIntervalId);
    }
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }
  }
}
```

### 6.2 Graceful Shutdown

```typescript
// In ServiceWorker unload
window.addEventListener('beforeunload', async () => {
  // Allow in-flight requests to finish (up to 5 seconds)
  await Promise.race([
    metadataFetcher.stopBackgroundFetcher(),
    sleep(5000),
  ]);
});
```

### 6.3 Pause on Low Resources

```typescript
// Monitor memory and pause if needed
if (navigator.deviceMemory && navigator.deviceMemory < 2) {
  // Pause metadata fetching on low-memory devices
  await metadataFetcher.stopBackgroundFetcher();
}
```

---

## 7. UI State Management

### 7.1 Filter & Sort Persistence

```typescript
interface DiscoveryUIState {
  filters: {
    genres: string[];
    modes: string[];
    playtime: 'all' | 'month' | 'week';
  };
  sortBy: 'most-friends' | 'score' | 'recent' | 'alphabetical';
}

// Persist in UserProfile
await storageManager.setUserProfile({
  ...profile,
  discovery_ui_state: uiState,
});

// Load on tab open
const savedState = profile.discovery_ui_state || defaultState;
```

### 7.2 Loading States

```typescript
// While fetching metadata
<div class="game-card loading">
  <div class="skeleton-image"></div>
  <div class="skeleton-text"></div>
</div>

// Incremental loading
games.forEach((game, index) => {
  setTimeout(() => renderCard(game), index * 50); // Stagger rendering
});
```

### 7.3 Empty States

```
No games match your filters

Try removing some filters or enabling more services.

[Clear all filters] [Enable services]
```

### 7.4 Error States

```
Failed to load game metadata

We're having trouble fetching data from Steam.
We'll try again in the background.

[Retry now] [Dismiss]
```

---

## 8. Configuration & Tunables

### 8.1 UserProfile Extension

```typescript
interface UserProfile {
  // ... existing fields ...
  
  game_discovery: {
    enabled: boolean;
    last_library_sync: number;
    last_metadata_refresh: number;
  };
  
  metadata_fetcher_config: {
    rate_limit_per_second: 1.5;
    batch_size: 10;
    cache_ttl_ms: 2592000000; // 30 days
    request_timeout_ms: 5000;
    max_retries: 3;
  };
  
  discovery_ui_state: DiscoveryUIState;
}
```

### 8.2 Defaults

```typescript
const DEFAULT_CONFIG = {
  // Fetch every 6 hours
  GAME_LIBRARY_REFRESH_INTERVAL_MS: 6 * 60 * 60 * 1000,
  
  // Rate limit: 1-2 requests per second
  METADATA_FETCH_RATE_PER_SECOND: 1.5,
  
  // Retry failed metadata 3 times
  MAX_METADATA_RETRIES: 3,
  
  // Cache metadata for 30 days
  METADATA_CACHE_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  
  // Cache game libraries for 7 days
  GAME_LIBRARY_CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  
  // Steam API timeout
  STEAM_API_TIMEOUT_MS: 5000,
  
  // Background fetch delay
  BACKGROUND_FETCH_CHECK_INTERVAL_MS: 100,
};
```

---

## 9. Testing Strategy

### 9.1 Unit Tests

**GameLibraryManager**:
- ✓ Fetch OwnedGames from mock Steam API
- ✓ Cache with TTL expiration
- ✓ Parse Nostr events
- ✓ Calculate common games
- ✓ Handle missing metadata
- ✓ Error handling (API failures, network errors)

**MetadataFetcher**:
- ✓ Fetch metadata from mock Steam API
- ✓ Parse appdetails response
- ✓ Detect cross-platform games
- ✓ Rate limiting (token bucket)
- ✓ Queue management
- ✓ Exponential backoff
- ✓ Cache TTL
- ✓ Error handling (429, 404, timeouts)

**Discovery UI**:
- ✓ Filter logic (genres, modes, playtime)
- ✓ Sort logic (friends, score, recent, alphabetical)
- ✓ State persistence
- ✓ Empty/error states

### 9.2 Integration Tests

- ✓ GameLibraryManager → StorageManager → cache
- ✓ MetadataFetcher → StorageManager → cache
- ✓ GameLibraryManager → RelayPool → Nostr events
- ✓ ActivityPublisher → GameLibrary publishing
- ✓ Discovery UI → GameLibraryManager → display

### 9.3 Mock Data & Fixtures

```typescript
// Mock Steam API response
const mockAppDetails = {
  440: {
    success: true,
    data: {
      type: 'game',
      name: 'Team Fortress 2',
      steam_appid: 440,
      platforms: { windows: true, mac: true, linux: true },
      genres: [
        { id: '1', description: 'Action' },
        { id: '37', description: 'Free To Play' },
      ],
      categories: [
        { id: '1', description: 'Multi-player' },
        { id: '27', description: 'Cross-Platform Multiplayer' },
      ],
      metacritic: { score: 92 },
      header_image: 'https://...',
    },
  },
};

// Mock Nostr event
const mockGameLibraryEvent: NostrEvent = {
  kind: 1,
  tags: [['t', 'game-library']],
  content: JSON.stringify({ appIds: [440, 221100], count: 2 }),
  created_at: Math.floor(Date.now() / 1000),
  pubkey: 'friend-pubkey',
  sig: 'mock-sig',
  id: 'mock-id',
};
```

---

## 10. Observability & Debugging

### 10.1 Logging

```typescript
// src/modules/game-library.ts
console.debug('[GameLibrary] Fetching owned games...');
console.log('[GameLibrary] ✓ Fetched 150 games');
console.warn('[GameLibrary] ⚠ Failed to fetch, retrying in 30s');
console.error('[GameLibrary] ❌ Fatal error:', error);

// src/modules/metadata-fetcher.ts
console.debug('[Metadata] Queue: 150 items, rate: 1.5/sec');
console.log('[Metadata] ✓ Fetched metadata for 50 games');
console.warn('[Metadata] Rate limited, backoff 60s');
```

### 10.2 Metrics

```typescript
class DiscoveryMetrics {
  gameLibraryFetched: number = 0;
  metadataFetched: number = 0;
  metadataFailed: number = 0;
  rateLimitHits: number = 0;
  cacheHits: number = 0;
  cacheMisses: number = 0;
  
  reportMetrics() {
    return {
      gameLibraryFetched: this.gameLibraryFetched,
      metadataSuccess: this.metadataFetched,
      metadataFailRate: this.metadataFailed / (this.metadataFetched + this.metadataFailed),
      rateLimitRate: this.rateLimitHits / this.metadataFetched,
      cacheHitRate: this.cacheHits / (this.cacheHits + this.cacheMisses),
    };
  }
}
```

---

## 11. Code Patterns & Conventions

### 11.1 Manager Singletons

```typescript
let instance: GameLibraryManager | null = null;

export function getGameLibraryManager(): GameLibraryManager {
  if (!instance) {
    instance = new GameLibraryManager(getStorageManager());
  }
  return instance;
}
```

### 11.2 Async/Await Over Promises

```typescript
// ✓ Good
async function fetchGames() {
  const games = await gameLibraryManager.getMyGameLibrary();
  return games;
}

// ✗ Avoid
function fetchGames() {
  return gameLibraryManager.getMyGameLibrary()
    .then(games => games);
}
```

### 11.3 Error Propagation

```typescript
// ✓ Good - let caller handle
async function fetchMetadata(appId: number): Promise<GameMetadata> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// ✗ Bad - swallow errors
async function fetchMetadata(appId: number): Promise<GameMetadata | null> {
  try {
    return await fetch(url).then(r => r.json());
  } catch {
    return null; // Lost error info
  }
}
```

### 11.4 Type Safety

```typescript
// ✓ Use strict types
interface GameMetadata {
  appId: number;
  name: string;
  // ...
}

// ✗ Avoid any
function parseMetadata(data: any): any {
  return data;
}
```

---

## 12. Incremental Commits

Each feature should be a separate commit, small enough to review and revert independently.

### Suggested commit sequence:

1. **Core types & interfaces**
   - GameLibrary, GameMetadata, DiscoveryUIState types
   - STORAGE_KEYS constants
   - Commit: "feat: Add game discovery types and storage schema"

2. **GameLibraryManager (fetch & cache)**
   - fetchMyGameLibrary(), getMyGameLibrary()
   - Storage integration
   - TTL management
   - Commit: "feat: Implement GameLibraryManager core"

3. **GameLibraryManager (Nostr)**
   - publishMyGameLibrary()
   - subscribeToFriendGames()
   - handleGameLibraryEvent()
   - Commit: "feat: Add Nostr game library pub/sub"

4. **MetadataFetcher (basic)**
   - Steam API fetching
   - Cache storage
   - Cross-platform detection
   - Commit: "feat: Implement MetadataFetcher with caching"

5. **MetadataFetcher (advanced)**
   - Rate limiting
   - Queue management
   - Backoff/retry
   - Commit: "feat: Add rate limiting and queue to MetadataFetcher"

6. **Discovery Tab UI**
   - Filter panel component
   - Sort dropdown
   - Result cards
   - Commit: "feat: Implement Discovery Tab UI"

7. **Integration & polish**
   - ServiceWorker wiring
   - Publisher integration
   - RelayPool integration
   - Commit: "feat: Integrate game discovery with ServiceWorker"

8. **Tests**
   - Unit tests for each module
   - Integration tests
   - Commit: "test: Add comprehensive game discovery tests"

---

## 13. Known Issues & Limitations

- **Cold start**: Friend's library must be published before discovery works
- **Metadata latency**: First view of Discovery tab shows partial metadata if still fetching
- **Steam API key**: Requires user to provide Steam API key (existing requirement)
- **Rate limiting**: Metadata fetching is gradual, not instant for large libraries
- **No real-time sync**: Game library updates have 6-hour delay

---

## 14. Success Criteria

- ✓ All tests pass
- ✓ No type errors (strict TypeScript)
- ✓ All storage via StorageManager API
- ✓ Discovery tab displays games in < 500ms
- ✓ Metadata fetching respects rate limits (no 429 errors)
- ✓ Cache hit rate > 90%
- ✓ Kind 1 events < 2KB
- ✓ No relay rejections

---

## Agent Orchestration Recommendation

**Suggested approach: Parallel implementation team**

Since we have clear module boundaries and dependencies are well-defined, suggest using **multiple agents in parallel**:

1. **Agent 1: Core Modules** (GameLibraryManager, MetadataFetcher types & storage)
2. **Agent 2: Metadata Fetching** (Steam API, rate limiting, queue)
3. **Agent 3: UI Implementation** (Discovery Tab, filters, sort)
4. **Agent 4: Integration** (ServiceWorker, RelayPool, Publisher wiring)
5. **Agent 5: Testing** (Unit tests, integration tests, mocks)

Each agent works on its module, then we integrate sequentially in order 1→2→3→4→5.

**Alternative: Sequential single agent**
If complexity arises or we want tighter iteration, use a single agent for the whole feature with incremental commits.

