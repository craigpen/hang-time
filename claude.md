# Claude Development Notes - Hang Time

## Project Phase: MVP Development (Starting 2026-07-21)

### Overview
Hang Time is a decentralized browser extension for co-consuming content with friends via Nostr relays. This document tracks architectural decisions, implementation progress, and design notes as the project evolves.

### MVP Scope
**Features:**
- Activity detection (Spotify, Twitch, Steam, Netflix, YouTube)
- Friend management (memorable identifiers, local friend lists)
- Real-time activity display (active friends cards)
- Join actions (open content, time sync for video)
- Encrypted chat (via Nostr kind 4)
- Optional voice coordination (Discord link prompt)
- Settings UI (service toggles, auth, notification preferences)

**Out of Scope (MVP):**
- Console game detection
- Firefox support (planned post-MVP)
- P2P audio (WebRTC)
- Advanced analytics
- Mobile app

### Architectural Decisions

#### 1. Identity & Authentication (Not Implemented Yet)
- **Decision**: Use memorable identifiers (e.g., "VascillatingMonkeyCough") instead of real identities
- **Rationale**: Privacy, decentralization, no account requirement
- **Implementation**: Generate on first install, display in settings with copy button

#### 2. Data Storage (Not Implemented Yet)
- **Decision**: All data stored locally (IndexedDB + chrome.storage)
- **Rationale**: No backend needed, user privacy, decentralized
- **Structure**:
  - User profile (identifier, services, tokens, Discord info)
  - Friend list (local_name, identifier, muted, hidden_services)
  - Activity history (per friend)
  - Messages (encrypted, per friend)

#### 3. Nostr Integration (Not Implemented Yet)
- **Decision**: Connect to hardcoded list of public relays
- **Rationale**: Redundancy, decentralization, simple bootstrapping
- **Relays**: nostr.pub, relay.damus.io, nos.lol (configurable later)
- **Event kinds**:
  - Kind 1: Activity events (currently playing/streaming)
  - Kind 4: Encrypted DMs (chat messages)

### Implementation Progress

#### Session 1: Project Setup & Phase 1 (2026-07-21)
- [x] Initialize git repo with GitHub
- [x] Create GitHub project with 8 organized issues
- [x] Set up package.json and build pipeline
- [x] Configure agent validation pipeline (AGENTS.md)
- [x] Document development phases (PHASES.md)
- [x] Establish development conventions (CONVENTIONS.md)
- [x] **Phase 1: Architecture & Design** ✅ COMPLETE
  - [x] Design module hierarchy (11 core modules + services)
  - [x] Define data models (User, Friend, Activity, Message, Nostr)
  - [x] Architecture document (docs/ARCHITECTURE.md)
  - [x] Nostr integration strategy
  - [x] Service detection pattern
  - [x] UI architecture (popup + overlays)
  - [x] Security & privacy design
  - [x] Implementation priority (6-week schedule)
- [x] Phase 2: Build Core Infrastructure ✅ COMPLETE
  - [x] Week 1: Types, Storage, Identity, Build Pipeline ✅
  - [x] Week 2: Nostr Relay Pool, Activity Detector, Service Worker ✅
  - [x] Week 3: Service Detection (Spotify, Twitch, Steam, Tabs) ✅
  - [x] Validation: All 19 type safety issues fixed ✅
- [x] Phase 3: Implement MVP Features ✅ COMPLETE
  - [x] Friend management module
  - [x] OAuth 2.0 flows (Spotify & Twitch)
  - [x] Settings UI with OAuth status
  - [x] Encrypted messaging system
  - [x] Join/co-consume action handlers
  - [x] Popup UI with active friends display
  - [x] Message modal/overlay system
  - [x] Real-time activity updates
- [x] Phase 4: Co-Watching & Advanced Features (IN PROGRESS)
  - [x] Time-sync for YouTube/Netflix video
  - [x] Notification system (friend online, new message)
  - [x] Content script for video detection
  - [ ] Browse together mode
- [ ] Phase 5: Testing & Validation & Release

### Development Methodology

**Agent-Driven Development**: Each phase uses a targeted agent stack to design, build, validate, and test.

See **PHASES.md** for detailed phase breakdown, deliverables, and success criteria.

### Phase 3 Week 1 - MVP Features Implementation

**Completed So Far:**
- ✅ Friend Management Module (300+ lines)
  - getAllFriends(), getFriend(), addFriend(), removeFriend()
  - renameFriend(), muteFriend(), unmuteFriend()
  - hideServiceFromFriend(), showServiceToFriend()
  - updateFriendActivity(), getActivityHistory()
  - getActiveFriends() with timestamp filtering
  
- ✅ OAuth 2.0 Authorization (500+ lines)
  - Spotify OAuth 2.0 flow implementation
  - Twitch OAuth 2.0 flow implementation
  - OAuth callback handler with state validation
  - Token exchange and storage
  - Token refresh handling (Spotify)
  - Settings UI with auth status indicators
  - Connect/Reconnect/Disconnect buttons
  
- ✅ Encrypted Messaging System (220+ lines)
  - MessagingManager for send/receive
  - Message storage with metadata
  - Unread message tracking
  - Nostr kind 4 event publishing
  - Message receive from relay subscriptions
  - Read/unread status management
  
- ✅ Join/Co-Consume Actions (180+ lines)
  - JoinHandler for opening friend's activity
  - Service-specific join logic
  - Spotify: Search for track in Web Player
  - Twitch: Direct channel link
  - Steam: Game URL protocol
  - Netflix/YouTube: Video with time-sync metadata
  - Discord coordination prompts

**Build Status:** ✅ Chrome & Firefox both pass
**Type Safety:** ✅ All new code passes strict TypeScript
**Commits:** 7 major commits totaling 1,700+ lines of Phase 3 code

### Phase 4 Week 1 - Co-Watching Features Implementation

**Completed So Far:**
- ✅ Time Sync Module (300+ lines)
  - Publish time-sync events to Nostr with video position
  - Handle incoming time-sync from friends
  - Calculate recommended sync positions
  - Automatic cleanup of stale sync events
  - 2-second sync tolerance (configurable)
  
- ✅ Video Sync Content Script (250+ lines)
  - YouTube detection and monitoring
  - Netflix detection and monitoring
  - Real-time video element polling
  - Automatic sync publishing (every 5 seconds)
  - Listen for sync requests and auto-seek
  - Subtle sync notifications
  
- ✅ Notification System (180+ lines)
  - Friend came online notifications
  - New message notifications
  - Join suggestion notifications
  - 30-second cooldown to prevent spam
  - Preference-based control
  - Click-to-open functionality

**Build Status:** ✅ Chrome & Firefox both pass
**Commits:** 2 major commits totaling 730+ lines of Phase 4 code

### Phase 3 Complete Summary

**Total Lines of Code: 1,700+**
- Friend Management: 200 lines
- OAuth 2.0 Implementation: 500+ lines
- Encrypted Messaging: 220 lines
- Join Actions: 180 lines
- Popup UI: 330 lines
- UI Styling: 270+ lines

**Features Implemented:**
✅ Complete friend lifecycle management
✅ OAuth 2.0 for Spotify & Twitch with token refresh
✅ Settings page with service toggles and OAuth buttons
✅ Encrypted messaging system with Nostr integration
✅ Service-specific join/co-consume action handlers
✅ Interactive popup UI with active friends display
✅ Message modal with real-time chat
✅ Auto-refreshing friend activity (3-second intervals)
✅ Theme support (light/dark mode)
✅ Error handling and user feedback
✅ Type-safe throughout (strict TypeScript)

**Architecture:**
- Modular design with clear separation of concerns
- Background service worker coordinates all operations
- Messaging pattern for popup ↔ background communication
- Singleton instances for manager classes
- Lazy initialization to prevent circular dependencies

**Quality Metrics:**
- ✅ All builds pass (Chrome & Firefox)
- ✅ No type safety issues
- ✅ Security: No credential leaks, safe DOM operations
- ✅ UX: Responsive, theme-aware, accessible buttons
- ✅ Performance: Efficient refresh cycles, no blocking operations

### Phase 2 Complete - Core Infrastructure Built

**Week 1 Delivered:**
- ✅ types.ts: 450+ lines of type definitions
- ✅ StorageManager: Full chrome.storage.local abstraction
- ✅ IdentityManager: Memorable ID generation (Adjective+Animal+Number)
- ✅ Build pipeline: esbuild for Chrome/Firefox builds
- ✅ TypeScript strict mode: All type safety enabled
- ✅ UI scaffolding: popup.html, settings.html, theme.css, popup.css, settings.css

**Week 2 Delivered:**
- ✅ RelayPool: WebSocket connections to Nostr relays (4 default relays)
- ✅ RelayConnection: Individual relay management with reconnection logic
- ✅ ActivityDetector: Polls services and publishes to Nostr (5sec poll, 2sec rate limit)
- ✅ Background Service Worker: Extension orchestration, message routing, subscriptions
- ✅ PopupController: Display active friends with expandable cards
- ✅ SettingsController: Settings page with identifier display and service toggles

**Ready for Phase 2 Week 3:** Service Detection Modules
- Next: Implement Spotify, Twitch, Steam, Netflix/YouTube activity detection

### References

- **MVP Spec**: Hang Time MVP.txt.txt (in root)
- **Development Phases**: PHASES.md
- **Agent Pipeline**: AGENTS.md, AGENT_ORCHESTRATION.md
- **Architecture**: docs/ARCHITECTURE.md
- **Reference Project**: ../tab-lifecycle-manager
