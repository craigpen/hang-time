# Hang Time - Gaming Expansion Roadmap & Specification

## 1. Executive Summary & Vision

Hang Time aims to be the premier decentralized social layer for PC gamers. While the foundation currently provides **Steam library sync**, **Kind-10003 Nostr publishing**, and **Steam invite modals**, this roadmap outlines the architectural plan to expand into:
1. **Multi-Storefront PC Library Aggregation** (Steam + GOG.com + PC Xbox Game Pass).
2. **1-Click Game Launching & Deep Linking** (`steam://`, `goggalaxy://`).
3. **PC Emulation & Classic Gaming Presence** (RetroAchievements.org).
4. **Competitive PC Presence** (Riot Games - Valorant, League of Legends, TFT).
5. **In-Browser & Cloud Gaming Detection** (Lichess, Chess.com, GeForce NOW, Xbox Cloud).
6. **Smart Co-op Matchmaking** ("Mutual Co-op", Multi-friend library overlap).
7. **Decentralized Nostr LFG (Looking For Group) & Party Beacons**.

---

## 2. PC Storefronts & Library Aggregation (Zero-OAuth)

```
┌─────────────────────────────────────────────────────────────┐
│                 Hang Time Unified PC Library                │
└──────┬───────────────────────┬───────────────────────┬──────┘
       │                       │                       │
       ▼                       ▼                       ▼
 ┌───────────┐           ┌───────────┐           ┌───────────┐
 │   Steam   │           │  GOG.com  │           │ PC Game   │
 │ Web API   │           │  Public   │           │ Pass/Xbox │
 │ (SteamID) │           │ (Username)│           │ (OpenXBL) │
 └───────────┘           └───────────┘           └───────────┘
```

### 2.1 Steam *(Current Foundation)*
- **Configuration**: Steam ID (64-bit) + Steam Web API Key.
- **Capabilities**: Full library extraction (`IPlayerService/GetOwnedGames`), live playing presence, and Steam store metadata fetching.

### 2.2 GOG.com (Good Old Games / GOG Galaxy)
- **Configuration**: **GOG Username only** (Zero API Key required).
- **Endpoint**: `https://embed.gog.com/u/<username>/games/stats?sort=date_last_played` (requires public profile in GOG privacy settings).
- **Capabilities**:
  - Full native GOG PC game catalog.
  - Total playtime and recent sessions.
  - Normalized directly into `GameLibraryManager` to complement Steam games.

### 2.3 PC Xbox Game Pass / Microsoft Store
- **Configuration**: **Gamertag + OpenXBL API Key** (`xbl.io`).
- **Endpoints**:
  - Presence: `GET https://xbl.io/api/v2/presence`
  - Titles: `GET https://xbl.io/api/v2/titlehub/titles`
- **Capabilities**:
  - Live active game detection for titles running via the Windows Xbox App / Microsoft Store (Halo, Forza, Sea of Thieves, Starfield).
  - Highlights shared PC Game Pass games owned across friends.

---

## 3. 1-Click Game Launching & Deep Linking

Transform the extension from a passive tracker into an active PC game launcher by utilizing OS-registered protocol handlers:

| Platform | Protocol URI Pattern | Action |
| :--- | :--- | :--- |
| **Steam** | `steam://run/<appId>` | Launches game executable on PC directly. |
| **Steam Lobby** | `steam://joinlobby/<appId>/<lobbyId>/<steamId>` | Jumps directly into a friend's active multiplayer lobby. |
| **GOG Galaxy** | `goggalaxy://openGameView/<gameId>` | Opens game page or launches via GOG Galaxy. |
| **Xbox PC** | `ms-windows-store://pdp/?ProductId=<id>` | Launches or opens Microsoft Store / Game Pass title. |

### UI Integration:
- In the **Games tab** and **Invite Modal**, game cards display a **`[🚀 Launch]`** button.
- Clicking the button opens the protocol URL (`window.location.assign('steam://run/...')`), instantly launching the game on the user's desktop without switching windows manually.

---

## 4. PC Emulation & Classic Gaming (RetroAchievements)

For retro enthusiasts playing via emulators on PC (RetroArch, Dolphin, PCSX2, DuckStation, PPSSPP):

- **Configuration**: **Username + Web API Key** (generated in RetroAchievements account settings).
- **Endpoint**: `https://retroachievements.org/API/API_GetUserSummary.php?u=<user>&y=<apiKey>`.
- **Capabilities**:
  - **Live Presence**: Detects real-time active emulator session (e.g., *"Playing Super Mario 64 (N64) on RetroArch"*).
  - **Retro Library**: Tracks classic retro games played and unlocked achievements.
  - **Activity Feed**: Broadcasts milestone achievements to friends over Nostr.

---

## 5. Competitive PC Gaming Presence (Riot Games)

For PC games operating outside Steam (League of Legends, Valorant, Teamfight Tactics):

- **Configuration**: **Riot ID (`Name#Tag`) + Riot API Key**.
- **Endpoint**: `https://<region>.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/<id>`.
- **Capabilities**:
  - **Rich In-Match Status**: Displays current game mode, champion/agent, and elapsed match duration (`18:45`).
  - **"Match Finishing" Alert**: Friends can see when a match is near completion to prepare party queues.

---

## 6. In-Browser & Cloud Gaming Detection (Zero-Auth)

Utilize the existing **Provider Registry** (`src/modules/providers/`) in content scripts to monitor browser-based gaming tabs without requiring any API keys:

### 6.1 Cloud Gaming Web Clients
- **Xbox Cloud Gaming (`xbox.com/play`)**: Extracts active streaming game title and session duration from the DOM.
- **GeForce NOW (`play.geforcenow.com`)**: Monitors game stream state.

### 6.2 Browser Matches & Board Games
- **Lichess (`lichess.org`) & Chess.com (`chess.com`)**:
  - Detects active live games in browser tabs.
  - Exposes 1-click **`[Spectate]`** and **`[Challenge]`** buttons in the popup.
- **Board Game Arena (`boardgamearena.com`)**:
  - Detects active digital board game tables (Catan, Wingspan, Terraforming Mars) with join links.

---

## 7. Smart Co-op Matchmaking ("What Should We Play?")

Solve group choice paralysis in the **Games** tab:

### 7.1 "Mutual Co-op" Quick Filter
- Filters the catalog to only show games matching:
  `Both Own` AND (`Category: Co-op` OR `Category: Multi-player`).
- Instantly answers: *"What games can we play together right now?"*

### 7.2 Multi-Friend Group Overlap (3+ Players)
- When in an active session with multiple friends, compute the mathematical intersection of game libraries:
  - *"4/4 Friends Own: Left 4 Dead 2, Terraria"*
  - *"3/4 Friends Own: Helldivers 2, Deep Rock Galactic (Missing: @Bob)"*

### 7.3 Crossplay & Platform Badging
- Tag games with cross-platform indicators: `[PC]`, `[Steam ↔ GOG]`, `[Crossplay]`.

---

## 8. Decentralized Nostr LFG & Party Beacons

```mermaid
sequenceDiagram
    participant Host as Host User
    participant Nostr as Nostr Relays
    participant Friend as Friend (Popup / Overlay)

    Host->>Nostr: Publish Kind 30315 LFG Beacon ("Helldivers 2", 3/4 slots, Discord link)
    Nostr->>Friend: Relay broadcasts LFG event
    Friend->>Friend: Popup shows glowing "LFG Beacon" chip
    Friend->>Host: One-click [Join Party] (NIP-17 DM + Launches steam://run/...)
```

- **LFG Beacon Format**:
  - Published as Kind `30315` tagged `['t', 'lfg']`, `['game', title]`, `['app_id', appId]`, `['slots', '3/4']`, `['discord', voiceUrl]`.
- **Party Launching**:
  - Clicking `[Join Party]` sends an instant encrypted acceptance message, launches the game via protocol handler, and opens the Discord voice link in a single action.

---

## 9. Implementation Architecture & Phasing

### Phase 1: Immediate Usability Enhancements
- [ ] Add `steam://run/<appId>` 1-click launch button to game cards and invite modals.
- [ ] Add **"Mutual Co-op"** filter chip in the Games tab (filtering Steam category `Multi-player` / `Co-op`).

### Phase 2: Storefront & Library Expansion
- [ ] Implement `GOGService` (`src/modules/services/gog.ts`) querying public GOG profiles.
- [ ] Add GOG Username field in Popup Settings.
- [ ] Merge GOG games into `GameLibraryManager` and Kind 10003 Nostr events.

### Phase 3: Live Presence Providers
- [ ] Implement `RetroAchievementsService` for PC emulation presence.
- [ ] Implement browser game providers (Lichess / Chess.com / Xbox Cloud Gaming).
- [ ] Implement `XboxService` (OpenXBL) for PC Game Pass presence.

### Phase 4: Social LFG & Beacons
- [ ] Implement Nostr LFG Beacon publisher and subscriber.
- [ ] Add LFG party builder and Discord voice auto-linker.
