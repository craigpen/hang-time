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
- [ ] Phase 2: Build Core Infrastructure (Week 2 ✅ COMPLETE)
  - [x] Week 1: Types, Storage, Identity, Build Pipeline ✅
  - [x] Week 2: Nostr Relay Pool, Activity Detector, Service Worker ✅
  - [ ] Week 3: Service Detection (Spotify, Twitch, Steam, Tabs)
- [ ] Phase 3: Implement MVP Features
- [ ] Phase 4: Co-Watching & Advanced Features
- [ ] Phase 5: Testing & Validation & Release

### Development Methodology

**Agent-Driven Development**: Each phase uses a targeted agent stack to design, build, validate, and test.

See **PHASES.md** for detailed phase breakdown, deliverables, and success criteria.

### Phase 2 Week 2 Complete - Core Infrastructure Built

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
