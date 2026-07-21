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

#### Session 1: Project Setup (2026-07-21)
- [x] Initialize git repo
- [x] Create GitHub project
- [x] Set up package.json and build pipeline
- [x] Configure agent validation pipeline (AGENTS.md)
- [x] Document development phases (PHASES.md)
- [ ] **Phase 1: Architecture & Design** (in progress)
- [ ] Phase 2: Build Core Infrastructure
- [ ] Phase 3: Implement MVP Features
- [ ] Phase 4: Co-Watching & Advanced Features
- [ ] Phase 5: Testing & Validation & Release

### Development Methodology

**Agent-Driven Development**: Each phase uses a targeted agent stack to design, build, validate, and test.

See **PHASES.md** for detailed phase breakdown, deliverables, and success criteria.

### Known Issues & TODOs

Phase 1 (Current):
- [ ] Research reference projects for MV3 patterns
- [ ] Design Nostr relay pool architecture
- [ ] Design service detection modules
- [ ] Document data models (storage schema)
- [ ] Create data flow diagrams
- [ ] Get alignment before coding Phase 2

### References

- **MVP Spec**: Hang Time MVP.txt.txt (in root)
- **Development Phases**: PHASES.md
- **Agent Pipeline**: AGENTS.md, AGENT_ORCHESTRATION.md
- **Architecture**: docs/ARCHITECTURE.md
- **Reference Project**: ../tab-lifecycle-manager
