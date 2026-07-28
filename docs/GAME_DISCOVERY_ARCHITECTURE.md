# Game Discovery Architecture

**Phase**: MVP Feature (Phase 3 Week 2+)  
**Goal**: Help friends find common games to play together  
**Priority**: Medium (enhances core value proposition)

**MVP Scope**: DM-based discovery (uses existing kind 4 messaging)  
**Post-MVP**: Optional Nostr publishing (kind 30023) for async discovery

---

## Feature Overview

Show users which games they share with each friend, enabling:
- "You & Alice both own Factorio" → click to join her
- "You & Bob both own 5 games" → expand to see list
- Discovery of shared interests before starting co-playing

---

## Data Models

### GameLibrary
```typescript
interface GameLibrary {
  steamId: string;
  lastUpdated: number;
  games: {
    appId: number;
    name: string;
    playtimeForever: number;
    playtime2weeks: number;
    hasStats: boolean;
  }[];
}

// Stored: hang_time_game_libraries_{steamId}
// Updated: Weekly or on-demand
```

### GameIntersection (Cached)
```typescript
interface GameIntersection {
  friendId: string;
  commonGameIds: number[];
  lastCalculated: number;
  // Calculated client-side, not stored on Nostr
}
```

### Nostr Event (kind 1 - MVP)
```typescript
// Published: Condensed game library snapshot as kind 1 (same as activity)
{
  kind: 1, // Short-form content (reuse existing activity infrastructure)
  tags: [
    ["t", "game-library"], // Tag for filtering
    ["steam-id", steamId],
  ],
  content: JSON.stringify({
    appIds: [440, 221100, 427520, ...], // Just IDs, names looked up locally
    count: 150,
  }),
  created_at: timestamp,
  pubkey: userPubkey,
}
```

**Note**: Uses existing kind 1 infrastructure. No new event type needed for MVP.

---

## Module Structure

### 1. GameLibraryManager (New Module)
**Location**: `src/modules/game-library.ts`

```typescript
class GameLibraryManager {
  // Fetch owned games from Steam API
  async refreshGameLibrary(steamId: string): Promise<GameLibrary>
  
  // Get cached library
  async getGameLibrary(steamId: string): Promise<GameLibrary | null>
  
  // Get common games with friend
  async getCommonGames(friendSteamId: string): Promise<Game[]>
  
  // Calculate intersection
  private calculateIntersection(myGames: number[], friendGames: number[]): number[]
  
  // Cache management
  private isCacheStale(library: GameLibrary): boolean
  private readonly CACHE_TTL_MS = 604800000; // 7 days
}
```

**Responsibilities**:
- Fetch GetOwnedGames from Steam API
- Cache locally with 7-day TTL
- Calculate intersections efficiently
- Track which games are new/removed for delta publishing

### 2. GameLibraryManager Extensions (MVP)
**Location**: `src/modules/game-library.ts` (same module)

```typescript
class GameLibraryManager {
  // ... existing methods ...
  
  // Publish own game library as kind 1 event
  async publishGameLibrary(): Promise<void>
  
  // Subscribe to friends' game libraries (kind 1 events tagged with game-library)
  async subscribeToFriendGames(friendPubkeys: string[]): Promise<void>
  
  // Handle incoming game library events
  private async handleGameLibraryEvent(event: NostrEvent): Promise<void>
  
  // Cache received friend library
  async cacheFriendGameLibrary(friendPubkey: string, appIds: number[]): Promise<void>
  
  // Get common games filtered by appIds
  async getCommonGamesFiltered(friendPubkey: string, appIds?: number[]): Promise<Game[]>
}
```

**Responsibilities**:
- Publish own game library to Nostr as kind 1 (reuse existing publisher infrastructure)
- Subscribe to friends' game libraries via kind 1 events
- Cache received friend appIds locally
- Calculate intersections with optional filtering

### 3. MetadataFetcher (New Module)
**Location**: `src/modules/metadata-fetcher.ts`

```typescript
interface GameMetadata {
  appId: number;
  name: string;
  genres: string[];
  categories: string[]; // Include "Cross-Platform Multiplayer" check
  platforms: { windows: boolean; mac: boolean; linux: boolean };
  metacriticScore?: number;
  capsuleImageUrl: string; // Small thumbnail for display
  storePageUrl: string; // https://store.steampowered.com/app/{appId}/
  lastFetched: number;
}

class MetadataFetcher {
  // Fetch metadata for single game
  async fetchMetadata(appId: number): Promise<GameMetadata>
  
  // Batch fetch with rate limiting (~1-2 requests/second)
  async batchFetchMetadata(appIds: number[]): Promise<Map<number, GameMetadata>>
  
  // Schedule background metadata refresh
  async scheduleBackgroundRefresh(appIds: number[]): Promise<void>
  
  // Get cached metadata with fallback
  async getMetadata(appId: number): Promise<GameMetadata | null>
  
  // Check if game supports cross-platform play
  private isCrossPlayable(game: GameMetadata): boolean
  
  // Background update service
  private startBackgroundFetcher(): void
}
```

**Responsibilities**:
- Fetch game metadata from Steam API (appdetails)
- Cache metadata locally with 30-day TTL
- Implement rate-limiting (~1-2 requests/second)
- Schedule background updates for game libraries
- Determine cross-platform playability
- Provide instant lookups from cache

### 4. Discovery Tab UI
**Location**: `src/ui/discovery.ts` (new)

Implements the filter + sort + chip UI with two states:

**Default State**:
```
[🔽 Filters] | [Sort: Most friends own it ▼]
```

**With Active Filters**:
```
[🔽 Filters] [Indie ✕] [Multiplayer ✕] [This week ✕] | [Sort: Most friends own it ▼]
```

**Filter Panel** (opens on click):
```
Genre: ☐ Action  ☐ Indie  ☐ Simulation  ☐ Strategy
Mode: ☐ Multiplayer  ☐ Co-op  ☐ Single-player
Playtime: ○ All time  ○ This month  ○ This week
Friend Status: ○ All  ○ Common only

[Apply] [Clear all]
```

**Sort Options**:
- Most friends own it (default)
- Highest user score
- Most recently played by friends
- Alphabetical

---

## Storage Schema

### New STORAGE_KEYS
```typescript
MY_GAME_LIBRARY: "hang_time_my_game_library",
// { appIds: number[], lastUpdated: number }

FRIEND_GAME_LIBRARIES: "hang_time_friend_game_libraries",
// { [friendPubkey]: { appIds: number[], lastUpdated: number } }

GAME_METADATA_CACHE: "hang_time_game_metadata_cache",
// { [appId]: { name, genres[], categories[], platforms, score, recommendations, lastFetched } }
// TTL: 30 days (metadata rarely changes)
```

### Update to UserProfile
```typescript
steam_config: {
  ...existing,
  game_discovery_enabled: boolean; // User opt-in
  last_game_library_sync: number;
  last_metadata_refresh: number; // Track background fetcher progress
}
```

---

## Publishing Strategy (MVP)

### Kind 1 Event Publishing
```
Size: ~300 bytes for 100 games (150 appIds as JSON)
Frequency: Every 1-6 hours (or on-demand when library changes)
Reuses: Existing activity publisher infrastructure

Nostr event:
{
  kind: 1,
  tags: [["t", "game-library"], ["steam-id", steamId]],
  content: JSON.stringify({
    appIds: [440, 221100, ..., 150 total],
    count: 150
  }),
  created_at: timestamp
}
```

**Advantages**:
- Reuses existing kind 1 publishing pipeline (no new event type)
- Small enough for relay acceptance (~300 bytes for 100 games)
- Friends can subscribe via relay subscription filter on content type
- Simple to integrate with ActivityPublisher

**Publishing Cadence**:
- Publish on startup (if enabled)
- Republish every 6 hours (or configurable interval)
- On-demand when user toggles game discovery setting

---

## Update Flow

### User Perspective
```
Day 1: User enables game discovery in settings
  → Fetch own game library from Steam API
  → Cache locally
  → Publish to Nostr as kind 1 event
  → Subscribe to friends' kind 1 events

Day 2: Friend Alice publishes her game library via kind 1
  → Your client receives the event
  → Cache her appIds locally
  → On next cycle, calculate intersection

Day N: User views friend "Alice"
  → Lookup locally: which appIds are in both libraries?
  → Look up cached game names for each appId
  → Display: "You & Alice own 5 common games: Factorio, DayZ, TF2"
  → Click game → Opens join dialog
```

### Timing

**Fetch Strategy**:
- On startup: Fetch own game library from Steam API
- Automatic refresh every 6 hours
- Refresh on-demand if user enables game discovery

**Publish Strategy**:
- On startup (after fetching)
- Every 6 hours (periodic republish to ensure delivery)
- On-demand if user manually triggers refresh

**Subscribe Strategy**:
- On startup: Subscribe to all friends' kind 1 game-library events
- On add friend: Subscribe to their library events
- Keep subscription open for session duration

---

## Discovery Tab UX Design

### Default View
Shows all user's games sorted by "most friends own it":

```
┌─────────────────────────────────────────┐
│ [🔽 Filters] | [Sort: Most friends ▼] │
├─────────────────────────────────────────┤
│ [🎮] Factorio                            │
│      Genres: Simulation, Indie, Co-op    │
│      ⭐ 90/100                           │
│      5 friends own: Alice, Bob, Carol    │
│                                          │
│ [🎮] DayZ                                │
│      Genres: Survival, Multiplayer       │
│      ⭐ 79/100                           │
│      3 friends own: Dan, Eve, Frank      │
│                                          │
│ [🎮] Team Fortress 2                     │
│      Genres: Action, Multiplayer         │
│      ⭐ 92/100                           │
│      8 friends own: Grace, Henry (+5)    │
└─────────────────────────────────────────┘
```

### Filters Panel (Click "🔽 Filters")

```
┌─ Filter Options ─────────────────────────┐
│ Genre:                                   │
│   ☐ Action  ☐ Adventure  ☐ Casual       │
│   ☐ Indie   ☐ Simulation  ☐ Strategy    │
│                                          │
│ Game Mode:                               │
│   ☐ Single-player  ☐ Multiplayer        │
│   ☐ Co-op          ☐ Cross-Platform     │
│                                          │
│ Playtime (Friends):                      │
│   ○ All time  ○ This month  ○ This week │
│                                          │
│ Friend Status:                           │
│   ○ All friends  ○ Friends with common   │
│                                          │
│ [Apply] [Clear all]                      │
└──────────────────────────────────────────┘
```

### With Active Filters

Top bar shows active filters as removable chips:

```
[🔽 Filters] [Multiplayer ✕] [Co-op ✕] [This week ✕]
| [Sort: Most friends own it ▼]
```

**Interactions**:
- Click chip ✕ → removes that filter, results update immediately
- Click "Filters" again → panel reopens with selections highlighted
- Click sort dropdown → changes sort order
- Filters are preserved across sessions (stored in UserProfile)

### Sort Options

Available sort options:
1. **Most friends own it** (default) — best for finding co-play opportunities
2. **Highest user score** — find well-reviewed games
3. **Most recently played by friends** — see what's trending
4. **Alphabetical** — browse by name

### Result Cards

Each game card displays:
- **Game name** + capsule image (clickable to open Steam store)
- **Genres** (tags, clickable to filter)
- **User score** (⭐ X/100 from Metacritic or Steam reviews)
- **Friend info** (X friends own: Name1, Name2, Name3)

**Interaction:**
- Click game name or image → opens Steam store page
- Click genre tag → filters by that genre
- Click friend name → shows their profile/activity (existing behavior)

**Notes:**
- Platforms are filtered locally; only displaying games compatible with user's OS
- Cost is hidden (user already owns these games)
- Join/coordination handled by existing invite system (Phase 2)
- Cards sorted by user's selected option (most friends, score, recent, alphabetical)

---

## Integration with Existing Systems

### ActivityDetector
- No changes needed (already detects current game)
- Game discovery is separate concern

### Publisher (ActivityPublisher)
- Reuse existing kind 1 publishing pipeline
- Add game library publishing to publishCycle()
- Publish as separate kind 1 event tagged with "game-library"
- No new infrastructure needed

### RelayPool (Subscriptions)
- Add subscription filter for kind 1 events with "game-library" tag from friends
- Handle incoming events via existing event listener
- Route to GameLibraryManager.handleGameLibraryEvent()

### MetadataFetcher (Background Service)
- Start background service in ServiceWorker.onInstall
- Triggered on startup and every N hours
- Fetches metadata for: own games + all friends' games
- Respects rate limits to avoid Steam API rejection
- Updates cache asynchronously without blocking UI

### Friend Management
- When friend added: Subscribe to their game library kind 1 events + queue metadata fetch
- When friend removed: No need to unsubscribe (they're friend pubkeys, not a special subscription)

### Storage
- Add MY_GAME_LIBRARY, FRIEND_GAME_LIBRARIES, GAME_METADATA_CACHE via StorageManager
- Implement 7-day TTL for friend libraries
- Implement 30-day TTL for game metadata (rarely changes)
- All access through StorageManager API (no direct chrome.storage calls)

---

## Storage Implementation Pattern

**Critical**: All game library data must use StorageManager API (never direct `chrome.storage` calls).

```typescript
// ✅ Correct pattern
const storage = new StorageManager();
await storage.set('GAME_LIBRARIES', myLibrary);

// ❌ Never do this
await chrome.storage.local.set({ 'GAME_LIBRARIES': myLibrary });
```

**Why**: Ensures consistency, prevents duplicate data across storage keys, allows future migration, and maintains single source of truth. See activity-datastore.ts for reference.

---

## Privacy & Opt-in

**User Control**:
```typescript
settings.game_discovery_enabled: boolean

If disabled:
  - Don't fetch own game library
  - Don't publish to Nostr
  - Still receive friends' libraries (but don't use)
```

**Data Sensitivity**:
- Game library = non-sensitive (already public on Steam)
- Only published if user opts in
- Can be disabled per settings toggle

---

## Trade-offs & Decisions

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| **Game Library Fetch** | On startup + every 6 hours | Balance freshness vs API calls; don't spam Steam API |
| **Library Cache TTL** | 7 days | Typical install/uninstall cadence for games |
| **Metadata Fetch** | Background service with rate limiting | Avoid blocking UI; respect Steam API rate limits |
| **Metadata Cache TTL** | 30 days | Game metadata rarely changes |
| **Publishing** | Kind 1 events | Reuse existing activity pipeline; simple and proven |
| **Publishing Frequency** | Every 6 hours | Keep friends' libraries fresh without excessive load |
| **Storage** | All via StorageManager | Single source of truth; prevents duplication |
| **Discovery UX** | Filter panel + sort dropdown | Balance power users (advanced filters) with simplicity |
| **Privacy** | Opt-in required | Respects user choice; library is already public on Steam |

---

## Implementation Phases

### Phase 1: MVP - Game Discovery with Kind 1 (1-2 weeks)

**Week 1: Core Modules**

- **Day 1-2**: GameLibraryManager module
  - [ ] Fetch GetOwnedGames from Steam API (with auth token)
  - [ ] Cache locally with 7-day TTL
  - [ ] Calculate intersection logic for common games
  - [ ] Handle friend library subscriptions (kind 1 events)
  
- **Day 3**: MetadataFetcher module
  - [ ] Create background metadata fetcher service
  - [ ] Implement rate-limited Steam API calls (~1-2/sec)
  - [ ] Cache metadata with 30-day TTL
  - [ ] Schedule periodic background updates
  
- **Day 4**: Storage & Publishing
  - [ ] Add STORAGE_KEYS constants (MY_GAME_LIBRARY, FRIEND_GAME_LIBRARIES, GAME_NAMES_CACHE)
  - [ ] Integrate GameLibraryManager with ActivityPublisher for kind 1 events
  - [ ] Subscribe RelayPool to friends' game-library kind 1 events

**Week 2: UI & Polish**

- **Day 1-2**: Discovery Tab UI
  - [ ] Create Discovery tab in popup
  - [ ] Implement filter panel (Genre, Mode, Playtime, Friend status)
  - [ ] Implement active filter chips with ✕ removal
  - [ ] Implement sort dropdown (most friends, score, recent, alphabetical)
  
- **Day 3**: Display & Interaction
  - [ ] Show filtered/sorted common games
  - [ ] Display game metadata (genres, platforms, recommendations)
  - [ ] Quick-join buttons for each game
  - [ ] Settings toggle for game discovery
  
- **Day 4**: Testing & Polish
  - [ ] Unit tests for GameLibraryManager
  - [ ] Unit tests for MetadataFetcher (rate limiting, caching)
  - [ ] Integration test with friend activity flow
  - [ ] E2E test of filter/sort workflow

### Phase 2: Post-MVP - Optimization & Enhancement (Future)
- [ ] Switch to kind 30023 (addressable events, better for Nostr archives)
- [ ] Implement delta publishing for game library changes (only publish new/removed games)
- [ ] Add game recommendation engine (ML-based on friend preferences)
- [ ] Cross-platform support (Epic Games, GOG)

---

## Success Metrics (MVP)

- [ ] Common games calculate in < 100ms
- [ ] Game library cache hit rate > 95%
- [ ] Kind 1 events consistently < 500 bytes
- [ ] 0 relay rejections for game library events
- [ ] Discovery tab loads in < 300ms
- [ ] Game names lookup hits > 90% (local cache)

---

## Known Limitations & Future Work

### MVP Limitations
- **Steam-only**: No Epic Games, GOG, PlayStation Network support
- **Cold start**: Friend's library must be published before you can discover common games
- **Metadata latency**: First view of Discovery tab might show partial metadata if background fetcher is still running
- **One-way**: Only your library is published; friends must enable discovery for bidirectional sync
- **Rate limiting**: MetadataFetcher respects Steam API limits, so metadata updates are gradual (not instant)

### Post-MVP Enhancements
- **Kind 30023**: Switch to addressable events (more efficient for Nostr archives, better for followers)
- **Delta publishing**: Only publish new/removed games (reduces Nostr event size)
- **Game stats**: Include playtime, achievement counts, last played timestamps
- **Cross-platform**: Add Epic Games, GOG, PlayStation Network, Xbox Game Pass
- **Smart discovery**: ML-based recommendations ("Your friends with similar taste also own...")
- **Browse together**: "Play with me" mode for co-browsing Steam store

