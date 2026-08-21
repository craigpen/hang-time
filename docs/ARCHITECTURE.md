# Hang Time - Architecture & System Design

## 1. Executive Summary

Hang Time is a decentralized browser extension (Manifest V3) that enables real-time co-watching, co-gaming, and co-listening with friends via Nostr relays. It requires zero centralized backends, zero user accounts/databases, and stores all keys, tokens, and history locally in the browser.

---

## 2. Architectural Invariants

Every subsystem and AI agent working on Hang Time must strictly maintain these non-negotiable architectural invariants:

1. **Storage Abstraction via `StorageManager`**:
   - Never call raw `chrome.storage.local`, `localStorage`, or `sessionStorage` directly.
   - All persistence, multi-tab caching, dynamic namespaces, and profile access must route through `StorageManager` (`src/modules/storage.ts`).
2. **Immutable `contentTimestamp` Logic**:
   - `contentTimestamp` represents the exact Unix timestamp when a specific media item started playing on the client.
   - It is immutable for the lifetime of that media item and is deterministically used for peer host election (earliest `contentTimestamp` = host).
   - High-precision time sync uses `metadata.progress` + `metadata.progress_measured_at` to interpolate real-time playback position across peers.
3. **MV3 Content Script Cleanup Lifecycle**:
   - Every content script instance generates a unique `INSTANCE_ID` and registers a `CLEANUP_EVENT` listener on `window`.
   - Before mounting UI (`#hang-time-overlay`) or attaching DOM/port listeners, existing instances are signaled to clean up.
   - Ports and observers must be disconnected upon navigation or extension reloads (`docs/MV3_CONTENT_SCRIPT_LIFECYCLE.md`).
4. **Zero Credential Leakage & NIP-44 Encryption**:
   - OAuth tokens, private keys (nsec/hex), and sensitive IDs are strictly local and never logged or published.
   - Direct messages, friend requests, and invites use NIP-17 direct messages with NIP-44 authenticated encryption (Kind 1059 gift wraps).
5. **Rate-Limited 3-Tier `PublishQueue`**:
   - Never publish raw Nostr events ad-hoc from business logic.
   - All relay writes route through `PublishQueue` (`src/modules/publish-queue.ts`) enforcing:
     - **Priority 1 (Immediate)**: User Actions (Invites, Chat messages, Friend requests, DND state changes).
     - **Priority 2 (Standard)**: Profile updates, status changes.
     - **Priority 3 (Background)**: Activity updates (3-sec throttle) and Game Libraries (Kind 10003).
6. **Clean CSS & Design System**:
   - Zero inline `style="..."` attributes for static styling.
   - All UI elements use semantic CSS classes referencing variables in `src/styles/theme.css`.

---

## 3. System Architecture & Module Hierarchy

```
hang-time/
├── entrypoints/
│   ├── background.ts                  # Service worker orchestrator & message router
│   ├── content-script.ts              # In-page media monitor & overlay injector
│   └── oauth-handler.ts               # Spotify/Twitch OAuth callback listener
│
├── src/
│   ├── types.ts                       # Shared type definitions (Activity, Friend, CoWatchSession, etc.)
│   │
│   ├── modules/                       # Core business logic layer
│   │   ├── storage.ts                 # StorageManager: namespaced persistence & caching
│   │   ├── identity.ts                # IdentityManager: Nostr keys, npub/nsec, display names
│   │   ├── friends.ts                 # FriendManager: CRUD, nickname overrides, muting
│   │   ├── messaging.ts               # MessagingManager: NIP-17 / NIP-44 encrypted chat & invites
│   │   ├── nostr.ts                   # RelayPool & RelayConnection WebSocket pub/sub
│   │   ├── publish-queue.ts           # PublishQueue: 3-tier priority event queue & dispatch
│   │   ├── publisher.ts               # ActivityPublisher: serializes & bundles Nostr activities
│   │   ├── co-watcher-detection.ts    # CoWatcherDetector: matching, host election, freshness checks
│   │   ├── game-library.ts            # GameLibraryManager: Steam sync & Kind-10003 Nostr events
│   │   ├── metadata-fetcher.ts        # MetadataFetcher: Steam API metadata queue & cache
│   │   ├── overlay-ui.ts              # OverlayUI: in-page overlay rendering (Host vs Guest modes)
│   │   ├── providers/                 # Modular video platform adapters
│   │   │   ├── types.ts               # VideoProvider interface
│   │   │   ├── youtube.ts             # YouTubeProvider
│   │   │   ├── netflix.ts             # NetflixProvider
│   │   │   ├── twitch.ts              # TwitchProvider
│   │   │   ├── generic.ts             # GenericVideoProvider (HTML5 fallback)
│   │   │   └── registry.ts            # VideoProviderRegistry (URL resolver)
│   │   └── services/                  # Platform detection services
│   │       ├── activity-detector.ts   # Detection orchestrator across all services
│   │       ├── tabs.ts                # Tab detection service for active browser video tabs
│   │       ├── spotify.ts             # Spotify Web API poller & OAuth
│   │       ├── twitch.ts              # Twitch Helix API poller & OAuth
│   │       └── steam.ts               # Steam Web API poller
│   │
│   ├── ui/                            # Extension UI Controllers
│   │   ├── popup.ts                   # PopupController: My Activity, Friends list, DND toggle, Settings
│   │   ├── games.ts                   # GamesTabController: Steam games, filters, friend library comparison
│   │   └── invite-modal-builder.ts    # showInviteModal: shared invite modal for friends & games
│   │
│   └── styles/                        # CSS Themes and Layouts
│       ├── popup.css                  # Popup UI & Tabs styles
│       ├── overlay.css                # In-page overlay (Host Mode & Guest Mode) styles
│       └── theme.css                  # Light/Dark CSS design tokens
│
├── docs/                              # Technical Specifications & Guides
│   ├── ARCHITECTURE.md                # This document
│   ├── SESSION_MODEL.md               # Session lifecycle, divergence, DND, overlay modes
│   ├── GAME_DISCOVERY.md              # Steam game sync, Kind 10003 events, metadata fetching
│   ├── MV3_CONTENT_SCRIPT_LIFECYCLE.md# Content script DOM & port lifecycle patterns
│   ├── RATE_LIMITING.md               # PublishQueue priority rates & throttling specs
│   └── SESSION_TESTING_GUIDE.md       # Manual & automated testing procedures
│
└── scripts/
    ├── build.js                       # esbuild build pipeline (Chrome & Firefox MV3)
    ├── launch-dual-edge.js            # Automated dual-profile testing runner
    └── inspect-browsers.js            # Chrome DevTools protocol inspector
```

---

## 4. Subsystem Details

### 4.1 Nostr Protocol & Identity
- **Keys**: Every user has a standard secp256k1 keypair (`IdentityManager`). The user can import an existing `nsec` or auto-generate one.
- **Presence / Activity**: Published as Kind `30315` (or Kind `1` legacy replaceable) with tags `['d', 'hang-time-activity']`, `['t', service]`, `['c', contentTimestamp]`, `['dnd', 'true'|'false']`.
- **Game Library**: Published as Kind `10003` replaceable event tagged `['t', 'game-library']`, `['steam-id', steamId]` containing `{ appIds: number[], count: number, timestamp: number }`.
- **Direct Messaging & Invites**: Encapsulated in Kind `1059` Gift Wraps with NIP-44 encrypted payloads.

### 4.2 Session Model & Divergence
- **Persistent Sessions**: Sessions (`CoWatchSession`) persist in storage (`STORAGE_KEYS.ACTIVE_SESSION`). When two users watch the same video, a session is formed. If one user navigates to another video, the session remains active (**Divergence**).
- **Dual Mode Overlay**:
  - **Host Mode** (`watching_together >= 2`): Renders synchronized playback bar, position markers for guests, sync button, and chat.
  - **Guest / Divergence Mode** (`watching_together < 2`): Renders "Choose Next" card showing friend's video title and a `[Join]` button (`JOIN_GUEST_ACTIVITY`).
- **Do Not Disturb (DND) / Solo Mode**:
  - Suppresses automatic session detection.
  - Clears active sessions and broadcasts `SESSION_ENDED` to unmount overlays.
  - Excludes DND friends from invite modals and disables Join buttons in popup UI.

### 4.3 Content Script & Overlay Lifecycle
- Runs on supported video platforms (`*://*.youtube.com/*`, `*://*.netflix.com/*`, etc.).
- Measures playback progress, video duration, and state (`playing` / `paused`).
- Injects a shadow/isolated DOM overlay (`#hang-time-overlay`) communicating with the background service worker via Chrome runtime ports.

### 4.4 Steam Game Discovery
- Fetches user owned games from Steam Web API (`IPlayerService/GetOwnedGames`).
- Background worker fetches detailed metadata in English (`&l=english`) from Steam Store API with a 0.5 req/sec rate limiter.
- Matches owned games against friends' Kind-10003 game libraries to highlight common games and owner counts.

---

## 5. Verification & Testing Strategy

1. **Automated Unit & Integration Tests**:
   - `vitest` test suite covering storage, session model, divergence, DND mode, game libraries, metadata caching, and UI controllers.
   - Verification command: `cmd /c npm run test:run`.
2. **Build Pipeline**:
   - `scripts/build.js` compiles TypeScript via `esbuild` for both Chrome MV3 (`dist/chrome-mv3/`) and Firefox MV3 (`dist/firefox-mv3/`).
   - Verification command: `cmd /c npm run build:all`.
