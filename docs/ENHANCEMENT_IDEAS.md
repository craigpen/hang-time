# Hang Time — Enhancement Ideas & Technical Expansion

This document compiles prioritized enhancement ideas, architectural expansions, and feature opportunities for **Hang Time**. 

---

## 1. 🔑 Onboarding & Credential UX (Zero-Config / 1-Click Verification)

### Problem
Setting up Steam and Xbox Web API keys can be confusing or tedious for non-technical users, and invalid or revoked keys currently fail silently without clear diagnostic feedback.

### Proposed Solutions
1. **1-Click Connection Test Buttons:**
   - Add direct "Test Connection" buttons in Settings next to Steam, Xbox, Spotify, and Twitch inputs.
   - Instantly validate credentials against their respective APIs and show a green success badge or descriptive error message (e.g. "Invalid API Key", "Profile is Private").
2. **Zero-API-Key Steam Fallback:**
   - Allow users to enter only their Steam Vanity URL or SteamID64 (e.g., `https://steamcommunity.com/id/username`).
   - Fetch public game libraries without requiring a Steam Web API key.
3. **Inline Setup Tooltips & Deep Links:**
   - Add direct links to API key creation pages (`steamcommunity.com/dev/apikey`, `xbl.io`) with inline step-by-step instructions.

---

## 2. ⚡ Relay Pool Health Scoring & Low-Latency Auto-Failover

### Problem
Public Nostr relays can experience silent connection drops, rate-limiting, or intermittent latency spikes. Ephemeral video co-watch synchronization requires high responsiveness (sub-100ms) to prevent video drift.

### Proposed Solutions
1. **NIP-11 Health & Latency Tracking:**
   - Utilize [`nip11-relay-info.ts`](file:///c:/Users/craig/Documents/Git/hang-time/src/modules/nip11-relay-info.ts) and periodic lightweight ping checks to monitor round-trip latency and packet loss per relay.
2. **Dynamic Event Routing:**
   - Automatically route high-frequency ephemeral co-watch events (Kinds 30078/20000) to the 2–3 fastest and most reliable relays.
   - Use broader public relays for persistent Kind-1 activity broadcasts and Kind-10003 game library sync.
3. **Connection Status Indicators:**
   - Surface visual relay health indicators (Green / Amber / Red with latency in ms) in Settings.

---

## 3. 🎮 Multi-Storefront Gaming & 1-Click Launchers

### Problem
PC gamers often have libraries split across Steam, Xbox, GOG, and itch.io. Currently, users must manually find and launch the game outside the extension.

### Proposed Solutions
1. **GOG.com Zero-OAuth Aggregation:**
   - Ingest GOG public game libraries via public stats endpoints (`embed.gog.com/u/<user>/games/stats`).
2. **itch.io API Key Support:**
   - Allow users to optionally input an itch.io API key to sync indie game collections.
3. **1-Click Game Launchers (Protocol Handlers):**
   - Add 1-click launch buttons directly on game cards using local OS protocol handlers:
     - Steam: `steam://run/<appId>`
     - GOG: `goggalaxy://openGameView/<gameId>`
     - Xbox: `ms-windows-store://pdp/?productid=<titleId>`

---

## 4. 📢 Decentralized Nostr LFG (Looking For Group)

### Problem
Friends may own the same co-op games but have no lightweight way to announce they want to play right now without messaging everyone individually.

### Proposed Solutions
1. **Ephemeral LFG Beacons:**
   - Publish ephemeral Nostr events (using Kind 30315 or custom LFG tags) linked to a specific game's normalized ID.
2. **Party Formation UI:**
   - Show an active "LFG Beacon" indicator next to friends in the popup who are looking for players.
   - One-click "Join Party" response that sends an encrypted notification and optional Discord voice channel link.

---

## 5. 🎬 Self-Hosted & Local Media Providers (Plex & Jellyfin)

### Problem
Many friend groups and long-distance couples self-host their own media libraries on Plex, Jellyfin, or Emby, but cannot currently synchronize playback using Hang Time.

### Proposed Solutions
1. **Plex / Jellyfin Web Provider Adapters:**
   - Implement `PlexProvider` and `JellyfinProvider` conforming to the [`VideoProvider`](file:///c:/Users/craig/Documents/Git/hang-time/src/modules/providers/types.ts) interface.
   - Detect active playback in `app.plex.tv` or local/custom Jellyfin web domains.
   - Synchronize play, pause, and seek commands across friends viewing the same title.

---

## 6. 🎵 Web Audio & Music Presence (YouTube Music & SoundCloud)

### Problem
Hang Time currently supports Spotify Web API for music presence, but many users listen on YouTube Music or SoundCloud tabs.

### Proposed Solutions
1. **YouTube Music Tab Provider:**
   - Extract track title, artist, album art, and progress from `music.youtube.com`.
2. **SoundCloud Tab Provider:**
   - Extract active stream metadata from `soundcloud.com`.
3. **"Listening Together" Mode:**
   - Allow friends to tune into the host's music track or radio queue.

---

## 7. ⚡ Nostr Lightning Zaps & Micro-Tipping (NIP-57)

### Problem
There is currently no native way for users to support the developer, tip streamers, or send micropayments to friends within the extension.

### Proposed Solutions
1. **In-Overlay & Popup Zapping:**
   - Integrate NIP-57 Lightning zap requests for friends who have a Lightning Address or lud16 tag configured in their Nostr profile.
2. **"Zap the Developer" / Tip Jar:**
   - Optional tip button in Settings or popup header for community support.

---

## 8. 🔒 Encrypted Self-Backup & Cloud Sync (NIP-44)

### Problem
All data is stored exclusively in `chrome.storage.local`. If a browser profile is wiped or a user switches devices, their friend list and settings are lost.

### Proposed Solutions
1. **Encrypted-to-Self Snapshot:**
   - Periodically publish an encrypted snapshot (NIP-44 encrypted to the user's own pubkey) of friend list and configuration to Nostr relays.
2. **Restore Flow:**
   - Offer a "Restore from Nostr Backup" option during onboarding using the user's nsec or NIP-07 extension.

---

## 9. 💬 Reactions (NIP-25) & Shared Co-Watch Queue

### Problem
Acknowledging a friend's stream or game requires opening a full direct message thread. Additionally, watching multiple videos in a row requires manual link sharing each time.

### Proposed Solutions
1. **NIP-25 Emoji Reactions:**
   - Quick emoji reactions on friend activity cards in the popup or overlay.
2. **Collaborative Watch Queue:**
   - A shared playlist/queue in the co-watching overlay where participants can queue up the next YouTube/Twitch video.

---

## 10. 💤 Browser Idle-Based Away Detection

### Problem
Activity detection currently marks a service as active even if the user has stepped away from their computer.

### Proposed Solutions
1. **`chrome.idle` Integration:**
   - Use the `chrome.idle` API to detect when the system is locked or idle (>5 minutes).
   - Transition presence state to "Away" without completely unpublishing their game/media status.
