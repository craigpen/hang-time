# HANG TIME BROWSER EXTENSION - COMPREHENSIVE ARCHITECTURE DESIGN

## EXECUTIVE SUMMARY

Hang Time is a decentralized browser extension that enables real-time co-consumption of content with friends via Nostr relays. The architecture follows Manifest V3 patterns with clear module hierarchy, type-safe TypeScript, and security-first token handling.

**Key Architectural Principles:**
- **Modular Design**: Clear separation of concerns (activity detection, Nostr integration, UI, storage)
- **Type Safety**: All modules use strict TypeScript with explicit types
- **Security-First**: OAuth tokens stored locally, never logged, messages encrypted via Nostr kind 4
- **Decentralized**: No backend—all communication via public Nostr relays
- **Resilient**: Service worker state-less design; relays can reconnect automatically
- **Observable**: Structured logging with module prefixes for debugging

---

## 1. MODULE HIERARCHY

```
hang-time/
├── entrypoints/
│   └── background.ts               [Service worker main entry]
│       └── Orchestrates extension lifecycle, message routing
│
├── src/
│   ├── types.ts                    [Shared type definitions]
│   │   ├── User, Friend, Activity, Message types
│   │   ├── NostrEvent, OAuth token types
│   │   └── Storage schema types
│   │
│   ├── modules/                    [Business logic layer]
│   │   ├── nostr.ts               [Nostr relay pool]
│   │   │   └── RelayPool class, event pub/sub, relay management
│   │   │
│   │   ├── storage.ts             [Local data persistence]
│   │   │   └── StorageManager class, get/set/delete operations
│   │   │
│   │   ├── identity.ts            [Memorable identifier management]
│   │   │   └── Generate, store, retrieve user ID
│   │   │
│   │   ├── friends.ts             [Friend list & management]
│   │   │   └── Add, remove, rename, mute friends
│   │   │
│   │   ├── messages.ts            [Encrypted chat]
│   │   │   └── Send/receive encrypted Nostr kind 4 events
│   │   │
│   │   ├── services/               [Activity detection per platform]
│   │   │   ├── spotify.ts         [Spotify activity & OAuth]
│   │   │   ├── twitch.ts          [Twitch activity & OAuth]
│   │   │   ├── steam.ts           [Steam game detection]
│   │   │   ├── tabs.ts            [Netflix/YouTube tab monitoring]
│   │   │   └── types.ts           [Service types & interfaces]
│   │   │
│   │   ├── activity.ts            [Activity detection orchestrator]
│   │   │   └── Monitors all services, publishes changes to Nostr
│   │   │
│   │   └── notifications.ts       [Browser notifications]
│   │       └── Notify user of friend activity
│   │
│   ├── ui/                        [User interface layer]
│   │   ├── popup.ts              [Main popup controller]
│   │   │   └── Display active friends, handle clicks
│   │   │
│   │   ├── settings.ts           [Settings page controller]
│   │   │   └── Service toggles, auth, preferences
│   │   │
│   │   ├── overlays/             [Overlay components]
│   │   │   ├── chatOverlay.ts   [Chat box for co-watching]
│   │   │   ├── joinHandler.ts   [Handle join actions]
│   │   │   └── voicePrompt.ts   [Discord voice link]
│   │   │
│   │   └── components/
│   │       ├── friendCard.ts     [Friend activity card component]
│   │       ├── messageDisplay.ts [Chat message rendering]
│   │       └── settingsForm.ts   [Form helpers]
│   │
│   ├── utils/                    [Shared utilities]
│   │   ├── validation.ts         [Input validation, type guards]
│   │   ├── encryption.ts         [Message encryption/decryption]
│   │   ├── urls.ts               [URL parsing for content detection]
│   │   ├── errorHandling.ts      [Error logging and recovery]
│   │   └── constants.ts          [Global constants]
│   │
│   ├── styles/                   [CSS only—no inline styles]
│   │   ├── popup.css
│   │   ├── settings.css
│   │   ├── overlays.css
│   │   └── theme.css             [Dark/light mode variables]
│   │
│   ├── popup.html                [Popup UI]
│   ├── settings.html             [Settings UI]
│   └── overlay.html              [Overlay template]
│
├── scripts/
│   ├── build.js                  [esbuild pipeline]
│   └── create-zip.js             [Package for release]
│
├── docs/
│   ├── ARCHITECTURE.md           [This file]
│   ├── DATA_MODEL.md             [Storage schema details]
│   ├── MODULES.md                [Module interface specs]
│   └── DATA_FLOWS.md             [Sequence diagrams]
│
├── tests/                        [Test files]
│   ├── modules/
│   │   ├── nostr.test.ts
│   │   ├── storage.test.ts
│   │   ├── services/
│   │   └── activity.test.ts
│   ├── ui/
│   └── integration/
│
├── manifest.json                 [Extension manifest]
├── package.json
├── tsconfig.json                 [TypeScript config]
├── vitest.config.js
└── .claude/settings.json         [Claude Code config]
```

### Module Responsibilities

| Module | Responsibility | Dependencies | State |
|--------|-----------------|-------------|-------|
| **nostr** | Relay pool, event pub/sub | storage | Relay connections (reconnect on failure) |
| **storage** | Local data persistence | types | Direct chrome.storage.local access |
| **identity** | Memorable ID generation | storage | Single ID per extension |
| **friends** | Friend list management | storage, nostr, types | Friend list + last_seen times |
| **messages** | Encrypted chat | nostr, storage, encryption | Message history per friend |
| **services/** | Activity detection | storage, types | Service state (tokens, last activity) |
| **activity** | Orchestrate detection | services/, nostr, storage | Current activity state |
| **notifications** | Browser notifications | friends, activity | Recent notifications (avoid spam) |
| **popup** | Main UI controller | friends, activity, messages | UI state (expanded card, etc.) |
| **settings** | Settings management | storage, services/ | User preferences |
| **overlays/** | Chat/join overlays | messages, activity, urls | Overlay state (visible, position) |

---

## 2. DATA MODELS

### 2.1 Core Storage Schema

All data stored in `chrome.storage.local`:

```typescript
// User Profile
interface UserProfile {
  memorable_identifier: string;
  created_at: number;
  discord_info?: string;
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

// OAuth Token (stored per service, never logged)
interface OAuthToken {
  service: 'spotify' | 'twitch';
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scopes: string[];
}

// Friend
interface Friend {
  id: string;
  identifier: string;
  local_name: string;
  added_at: number;
  last_seen: number;
  muted: boolean;
  hidden_services: string[];
  current_activity?: Activity;
  current_activity_timestamp?: number;
}

// Activity
interface Activity {
  service: 'spotify' | 'twitch' | 'steam' | 'netflix' | 'youtube' | 'idle';
  content: string;
  url?: string;
  timestamp: number;
  metadata: {
    duration?: number;
    progress?: number;
    artist?: string;
    title?: string;
    thumbnailUrl?: string;
  };
}

// Message (encrypted chat)
interface Message {
  id: string;
  sender_identifier: string;
  recipient_identifier: string;
  content_encrypted: string;
  timestamp: number;
  read: boolean;
  nostr_event_id?: string;
}

// Nostr Event
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: [string, string][];
  content: string;
  sig?: string;
}

// Settings
interface Settings {
  theme: 'light' | 'dark' | 'auto';
  relay_urls: string[];
  activity_poll_interval_ms: number;
  publish_rate_limit_ms: number;
  show_offline_friends: boolean;
}
```

### 2.2 Storage Layout

```typescript
{
  "hang_time_user_profile": UserProfile,
  "hang_time_friends": Friend[],
  "hang_time_messages_[friend_id]": Message[],
  "hang_time_oauth_tokens": { [service]: OAuthToken }[],
  "hang_time_current_activity": Activity,
  "hang_time_settings": Settings,
  "hang_time_activity_history_[friend_id]": Activity[]
}
```

---

## 3. NOSTR INTEGRATION

### Relay Pool Architecture

```typescript
export interface IRelayConnection {
  url: string;
  isConnected: boolean;
  subscribe(identifier: string, callback: (event: NostrEvent) => void): void;
  publish(event: NostrEvent): Promise<void>;
  disconnect(): Promise<void>;
}

export class RelayPool {
  private relays: Map<string, IRelayConnection> = new Map();
  private subscriptions: Map<string, Set<Function>> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

  static readonly DEFAULT_RELAYS = [
    'wss://nostr.pub',
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relayable.org',
  ];
  static readonly RELAY_TIMEOUT_MS = 5000;
  static readonly RECONNECT_INTERVAL_MS = 10000;

  async connect(relayUrl: string): Promise<void> { /* ... */ }
  async publish(event: NostrEvent): Promise<{ successes: number; failures: number }> { /* ... */ }
  subscribe(identifier: string, callback: (event: NostrEvent) => void): void { /* ... */ }
  async disconnect(): Promise<void> { /* ... */ }
}
```

### Event Kinds

**Kind 1: Activity Events**
```typescript
{
  kind: 1,
  pubkey: user_identifier,
  content: "Listening to Song X on Spotify",
  tags: [
    ["service", "spotify"],
    ["content", "Song X"],
    ["url", "spotify:track:..."]
  ],
  created_at: timestamp
}
```

**Kind 4: Encrypted Direct Messages**
```typescript
{
  kind: 4,
  pubkey: sender_identifier,
  content: "<encrypted message>",
  tags: [["p", recipient_identifier]],
  created_at: timestamp
}
```

---

## 4. SERVICE DETECTION ARCHITECTURE

### Service Module Pattern

Each service implements `IServiceModule`:

```typescript
export interface IServiceModule {
  isEnabled(): Promise<boolean>;
  getCurrentActivity(): Promise<Activity | null>;
  hasToken(): Promise<boolean>;
  clearToken(): Promise<void>;
  getAuthUrl(): Promise<string>;
  handleAuthCallback(code: string): Promise<void>;
}
```

**Services:**
- **Spotify**: OAuth 2.0 + API query
- **Twitch**: OAuth 2.0 + API query
- **Steam**: Public API (no OAuth)
- **Netflix/YouTube**: Tab detection via chrome.tabs.query()

---

## 5. BACKGROUND SERVICE WORKER

### Initialization Lifecycle

```typescript
// entrypoints/background.ts

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await initializeExtension();
    chrome.runtime.openOptionsPage();
  }
});

async function initializeExtension(): Promise<void> {
  // 1. Initialize modules
  // 2. Generate memorable identifier
  // 3. Connect to Nostr relays
  // 4. Start activity detector
  // 5. Subscribe to all friends
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle popup ↔ background communication
  // Message types: GET_ACTIVE_FRIENDS, SEND_MESSAGE, ADD_FRIEND, etc.
});
```

---

## 6. UI ARCHITECTURE

### Popup

Main popup displays active friends as cards:
- Card shows: Friend name + activity badge (🎵 Spotify: Song X)
- Click to expand: Shows full details, actions (Join Now, Message)
- Settings button to access full settings page

### Settings Page

- Service toggles (Spotify, Twitch, Steam, Netflix, YouTube)
- Display user's memorable identifier (copy button)
- Connect buttons for OAuth services
- Discord username/invite link
- Notification preferences

### Overlays

- **Chat overlay**: Floating box for encrypted messages during co-watching
- **Voice prompt**: "Join [Friend]'s Discord?" with one-click link
- **Join handler**: Opens content, initiates time-sync if applicable

### Styling

- CSS files only (no inline styles)
- Dark/light mode support via `@media (prefers-color-scheme)`
- Reference: nas-download-helper popup for clean aesthetic

---

## 7. COMMUNICATION PATTERNS

### Background ↔ Popup (chrome.runtime.sendMessage)

| Type | Direction | Purpose |
|------|-----------|---------|
| GET_CURRENT_ACTIVITY | Popup→BG | Fetch current user activity |
| GET_ACTIVE_FRIENDS | Popup→BG | Fetch online friends list |
| ADD_FRIEND | Popup→BG | Add new friend |
| SEND_MESSAGE | Popup→BG | Send encrypted message |
| ACTIVITY_CHANGED | BG→Popup | Notify of user's activity change |
| FRIEND_ACTIVITY_UPDATED | BG→Popup | Notify of friend's activity |
| NEW_MESSAGE | BG→Popup | Notify of new message |

### Storage

All data persisted in `chrome.storage.local` via StorageManager abstraction:
```typescript
class StorageManager {
  async get(key: string, defaultValue?: any): Promise<any>;
  async set(key: string, value: any): Promise<void>;
  async update(key: string, updates: Record<string, any>): Promise<void>;
  async delete(key: string): Promise<void>;
}
```

---

## 8. SECURITY & PRIVACY

### OAuth Tokens
- **Storage**: `chrome.storage.local` only
- **Never logged**: No console.log() of tokens
- **Refresh handling**: Detect expiration, refresh before use
- **Scopes**: Only request necessary scopes

### Message Encryption
- **Nostr kind 4**: Standard NIP-04 encryption
- **Never plaintext**: All chat encrypted end-to-end
- **Decryption on receive**: Only recipient can decrypt

### XSS Prevention
- **No innerHTML**: Use `textContent` for user data
- **DOM creation**: Prefer `createElement()` over HTML strings
- **Input validation**: Validate all data before display

### Data Published to Nostr
- **Never logs**: Personal info, passwords, tokens
- **Only activity**: "Playing Song X", "Watching Twitch Stream Y"
- **Identifiers**: Memorable IDs, not real names

---

## 9. TYPESCRIPT CONFIGURATION

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noImplicitThis": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitReturns": true,
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "declaration": true,
    "sourceMap": true
  }
}
```

---

## 10. BUILD PIPELINE

**esbuild Configuration** (`scripts/build.js`):
- Compile TypeScript to JavaScript
- Bundle modules (no tree-shaking, keep readable)
- Separate entry points:
  - `entrypoints/background.ts` → `dist/[browser]-mv3/background.js`
  - `src/ui/popup.ts` → `dist/[browser]-mv3/popup.js`
  - `src/ui/settings.ts` → `dist/[browser]-mv3/settings.js`
- Copy static files (HTML, CSS, manifest)
- Generate Chrome and Firefox builds

**Build Commands**:
```bash
npm run build:chrome   # Build Chrome extension
npm run build:firefox  # Build Firefox extension  
npm run build:all      # Build both
npm run zip            # Package for release
```

---

## 11. IMPLEMENTATION PRIORITY (PHASE 2)

### Week 1: Core Infrastructure
1. **Types Module** - Data structure definitions
2. **Storage Manager** - Local persistence layer
3. **Identity Manager** - Memorable ID generation
4. **Build Pipeline** - esbuild configuration

### Week 2: Nostr Integration
5. **Relay Pool** - WebSocket connections, pub/sub
6. **Background Service Worker** - Orchestration, message routing

### Week 3: Activity Detection
7. **Service Interfaces** - IServiceModule contract
8. **Tab Service** - Netflix/YouTube detection
9. **Activity Orchestrator** - Polls services, publishes to Nostr

### Week 4: UI & User Interaction
10. **Friend Manager** - Friend list operations
11. **Popup UI** - Display active friends
12. **Settings UI** - Configuration

### Week 5: OAuth & Advanced Services
13. **Spotify Service** - OAuth + API
14. **Twitch Service** - OAuth + API
15. **Steam Service** - Public API

### Week 6: Chat & Polish
16. **Encryption Manager** - Message encryption
17. **Message Manager** - Encrypted messaging
18. **Chat Overlay** - Co-watching chat

---

## 12. VALIDATION CHECKPOINTS

Each module must pass:
- ✅ **Type Safety**: All functions typed, no `any` in critical modules
- ✅ **Security**: No credential logging, message validation
- ✅ **Architecture**: No circular dependencies, proper layering
- ✅ **Tests**: Unit tests for critical paths

See AGENTS.md for full validation pipeline.

---

## 13. KNOWN CONSTRAINTS

### Manifest V3
- Service worker can restart; no in-memory state
- Use `chrome.storage.local` for all persistence
- Message handling must be async-safe

### Nostr
- No guaranteed event ordering
- Relays may have high latency
- Implement retry logic for failed subscriptions

### OAuth
- Handle token refresh before expiration
- User may revoke tokens in service settings
- Graceful degradation if OAuth fails

### Browser Compatibility
- MVP targets Chrome/Edge/Opera (MV3)
- Firefox support planned post-MVP
- Use webextension-polyfill for API compatibility

---

## 14. SUCCESS CRITERIA FOR PHASE 1

✅ Architecture document complete and reviewed  
✅ Module hierarchy clearly defined  
✅ Data models documented  
✅ API boundaries established  
✅ Passes AGENTS.md Architecture Validator constraints  
✅ Team aligned before Phase 2 coding begins  

This architecture is ready for implementation. See PHASES.md for Phase 2 development sequence.
