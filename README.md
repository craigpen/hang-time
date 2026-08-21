# Hang Time 📺🎮🎵

Hang out and consume content together. A decentralized browser extension for real-time co-watching, co-gaming, and co-listening with friends via Nostr.

---

## 🌟 Key Features

- **Decentralized Social Discovery**: Connect peer-to-peer over public Nostr relays. No central servers, no user database, and zero credential leakage.
- **Real-Time Activity Sharing**: Automatic presence detection across YouTube, Netflix, Spotify, Steam, and Twitch.
- **Session Model with Divergence**: Friends stay connected in a co-watch session even when browsing different media. Easily hop over to what a friend is watching with one click (`JOIN_GUEST_ACTIVITY`).
- **Interactive In-Page Overlay**:
  - **Host Mode**: Appears when 2+ people watch the same video, featuring synchronized progress bars, guest position markers, and chat.
  - **Guest / Divergence Mode**: Displays "Choose Next" cards for friends browsing different videos with instant [Join] navigation.
- **Do Not Disturb (DND) / Solo Mode**: Toggle DND in one click (`🟢 Available` / `⛔ Do Not Disturb`). Suppresses auto-session joining, hides overlay popups, and disables invites while preserving background activity publishing.
- **Steam Game Discovery & Library Sharing**: Compares your Steam games against your friends' libraries (Nostr `kind: 10003`) with automated English metadata fetching (`&l=english`), filtering, and sorting.
- **Private Encrypted Messaging**: NIP-17 direct messaging with NIP-44 encryption for friend requests, activity invites, and in-overlay chat.

---

## 🏗️ Architecture

- **Extension Target**: WebExtension Manifest V3 (Chrome & Firefox).
- **Network Protocol**: Nostr (NIP-01, NIP-17, NIP-44, NIP-59, kind `10003` game libraries, kind `30315` user presence/activity).
- **Rate-Limited Publishing**: 3-tier priority `PublishQueue` (User Actions > Profile Updates > Activities & Game Libraries).
- **Deterministic Sync**: Immutable `contentTimestamp` for host election + `progress_measured_at` for high-precision time interpolation.
- **Storage Layer**: Unified local persistence and cache abstraction via `StorageManager`.

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- npm

### Installation & Build
```bash
# Clone the repository
git clone git@github.com:craigpen/hang-time.git
cd hang-time

# Install dependencies
npm install

# Build for Chrome (MV3)
npm run build:chrome

# Build for Firefox (MV3)
npm run build:firefox

# Build both targets
npm run build:all
```

The extension bundles will be generated in `dist/chrome-mv3/` and `dist/firefox-mv3/`.

### Running Verification
```bash
# Run type check
npm run type-check

# Run unit & integration test suite (310+ tests)
npm run test:run

# Run interactive watch mode
npm run test
```

### Loading in Browser (Chrome / Edge / Brave)
1. Navigate to `chrome://extensions/`
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/chrome-mv3` directory.

---

## 📚 Documentation

- [Architecture Guide](docs/ARCHITECTURE.md): Master system architecture, data models, and network protocols.
- [Session Model Specification](docs/SESSION_MODEL.md): Persistent sessions, divergence handling, overlay modes, and DND behavior.
- [Game Discovery Specification](docs/GAME_DISCOVERY.md): Steam library sync, Nostr kind-10003 events, and metadata caching.
- [Content Script Lifecycle](docs/MV3_CONTENT_SCRIPT_LIFECYCLE.md): DOM management, port teardown, and `INSTANCE_ID` cleanup patterns.
- [Rate Limiting & Queueing](docs/RATE_LIMITING.md): Priority queue architecture, relay dispatch, and burst handling.
- [Session Testing Guide](docs/SESSION_TESTING_GUIDE.md): Dual-browser manual testing and verification workflows.
- [AI Agent Instructions](AGENTS.md): Mandatory invariants and pair-programming guidelines.

---

## 📄 License
MIT
