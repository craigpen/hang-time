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
- [ ] Create Manifest V3 and entrypoints
- [ ] Build basic popup UI
- [ ] Implement settings page
- [ ] Add activity detection logic

### Known Issues & TODOs

- [ ] Need to finalize build script (esbuild setup)
- [ ] Plan OAuth flows for Spotify/Twitch
- [ ] Design folder/file structure for modules
- [ ] Test Nostr relay connectivity

### References

- **MVP Spec**: Hang Time MVP.txt.txt (in root)
- **Agent Pipeline**: AGENTS.md, AGENT_ORCHESTRATION.md
- **Reference Project**: ../tab-lifecycle-manager
