# Hang Time Development Phases

This document outlines the phased approach to building the Hang Time extension MVP using agent-driven development.

---

## Phase 1: Architecture & Design (Target: 1-2 days)

**Objective**: Establish solid architectural foundation and design before coding.

### Goals
- Understand extension architecture patterns from reference projects
- Design Nostr module interface and relay pool strategy
- Design service modules for activity detection (Spotify, Twitch, Steam, etc.)
- Define data models for local storage (user profile, friends, activity, messages)
- Create data flow diagrams for key operations
- Design API boundaries between modules
- Establish validation constraints based on AGENTS.md

### Agent Stack
- **Explore agent**: Research tab-lifecycle-manager for MV3 patterns
- **Plan agent**: Design module hierarchy and APIs
- **Code guide agent**: Clarify best practices for Manifest V3

### Deliverables
- Architecture document (docs/ARCHITECTURE.md - enhanced)
- Data model specification (docs/DATA_MODEL.md)
- Module interface definitions (docs/MODULES.md)
- Data flow diagrams (Nostr flow, activity detection flow, etc.)
- Decision log (claude.md updated)

### Success Criteria
- ✅ Module interfaces defined (what each module exports)
- ✅ Data models documented (storage schema for all data types)
- ✅ Nostr protocol understood (event kinds, relay communication)
- ✅ Service detection patterns identified
- ✅ Everyone aligned on architecture before coding

---

## Phase 2: Build Core Infrastructure (Target: 2-3 days)

**Objective**: Set up build pipeline and implement essential extension components.

### Goals
- Implement esbuild compilation pipeline (Chrome/Firefox builds)
- Create background service worker entrypoint (initialization, message routing)
- Build Nostr module (relay connectivity, publish/subscribe)
- Implement memorable identifier generation and storage
- Set up storage (IndexedDB + chrome.storage)
- Create basic UI scaffolding (popup.html, settings.html)
- All code must pass AGENTS.md validation pipeline

### Agent Stack
- **Code Builder**: `npm run build:all` compilation
- **Type Safety**: Enforce TypeScript strictness in core modules
- **Architecture Validator**: Check module boundaries and layering
- **Security Scanner**: Validate storage and API handling

### Key Files to Create
- `scripts/build.js` - esbuild configuration
- `entrypoints/background.ts` - Service worker main
- `src/modules/nostr.ts` - Relay pool and event handling
- `src/modules/storage.ts` - Local data management
- `src/popup.html` - Main UI shell
- `src/settings.html` - Settings UI shell

### Success Criteria
- ✅ `npm run build:all` compiles without errors
- ✅ `npm run test` passes (even empty tests are ok for now)
- ✅ Background worker initializes on first install
- ✅ Memorable identifier generated and stored
- ✅ Nostr relays can be connected to
- ✅ All type safety checks pass
- ✅ Architecture validation passes

---

## Phase 3: Implement MVP Features (Target: 3-4 days)

**Objective**: Build core user-facing features for the MVP.

### Goals
- Implement activity detection for all services (Spotify, Twitch, Steam, Netflix, YouTube)
- Publish activity to Nostr
- Subscribe to friends' activity
- Display active friends cards in popup
- Build friend management (add, remove, mute, rename)
- Implement settings UI (service toggles, auth, preferences)
- Store OAuth tokens securely locally
- Run validation pipeline after each feature

### Agent Stack
- **Code Builder**: `npm run build:all` (after each major feature)
- **Type Safety**: Enforce types in service modules
- **Architecture Validator**: Ensure services don't violate layering
- **Security Scanner**: Validate OAuth token handling, no credential leaks
- **Test Runner**: Maintain test coverage

### Key Files to Create
- `src/modules/services/spotify.ts` - Spotify detection
- `src/modules/services/twitch.ts` - Twitch detection
- `src/modules/services/steam.ts` - Steam detection
- `src/modules/services/tabs.ts` - Netflix/YouTube detection
- `src/modules/friends.ts` - Friend list management
- `src/popup.ts` - Popup logic (display friends, handle clicks)
- `src/settings.ts` - Settings page logic

### Success Criteria
- ✅ Activity detection working for all 5 services
- ✅ Activity publishes to Nostr on changes
- ✅ Friends' activity displays in popup
- ✅ Friend management works (add/remove/rename)
- ✅ Settings page configures services and auth
- ✅ OAuth tokens stored securely (not logged)
- ✅ All validation agents pass
- ✅ No security warnings

---

## Phase 4: Co-Watching & Advanced Features (Target: 2-3 days)

**Objective**: Implement the interactive features that make "hanging out" together possible.

### Goals
- Implement time-sync for YouTube/generic HTML5 video
- Build encrypted chat system (Nostr kind 4)
- Add voice coordination prompt (Discord link)
- Implement browse together mode
- Create join action handlers for each service (open link, seek to time, etc.)
- Add notification system (friend comes online, etc.)

### Agent Stack
- **Code Builder**: Validate builds
- **Type Safety**: Enforce strict types in UI modules
- **Architecture Validator**: Ensure UI doesn't violate messaging patterns
- **Security Scanner**: Validate encryption, message handling

### Key Files to Create
- `src/modules/chat.ts` - Encrypted messaging
- `src/modules/timeSync.ts` - Video synchronization
- `src/ui/chatOverlay.ts` - Chat UI component
- `src/ui/joinHandler.ts` - Join action handlers
- `src/modules/notifications.ts` - Browser notifications

### Success Criteria
- ✅ Time sync works for YouTube (join friend → seek to same timestamp)
- ✅ Encrypted chat displays and sends messages
- ✅ Voice coordination prompt shows Discord link
- ✅ Browse together shows real-time updates
- ✅ Join actions open correct URLs/content
- ✅ All validation agents pass
- ✅ End-to-end join flow works

---

## Phase 5: Testing & Validation (Target: 2 days)

**Objective**: Comprehensive testing and final validation before MVP release.

### Goals
- Write unit tests for all critical modules
- Create integration tests for major flows (activity detection → publish → display)
- End-to-end testing (full join flow from friend notification to co-watching)
- Security audit (OAuth, encryption, message handling)
- Performance testing (no freezes, relays stay connected)
- Final extension build verification
- Manual testing on Chrome and Firefox

### Agent Stack
- **Test Writer**: Generate test cases for critical code
- **Security Scanner**: Full security audit
- **Test Runner**: `npm test` comprehensive suite
- **Extension Build Verifier**: Validate final build outputs
- **Code Deduplicator**: Clean up any duplication before release

### Deliverables
- Complete test suite (>80% coverage on critical modules)
- Security audit report
- Test results and coverage metrics
- Release-ready builds (Chrome & Firefox)
- Deployment checklist

### Success Criteria
- ✅ All tests pass (`npm test` succeeds)
- ✅ No security vulnerabilities found
- ✅ Extension builds for Chrome and Firefox
- ✅ Manual testing confirms all features work
- ✅ Performance acceptable (no hangs, relays stable)
- ✅ Ready for initial release

---

## Phase Progression Gates

Each phase must complete its success criteria before moving to the next:

```
Phase 1 (Design)
    ↓ [Architecture documented & approved]
Phase 2 (Infrastructure)
    ↓ [Build pipeline working, core modules tested]
Phase 3 (Features)
    ↓ [All features working, validation passing]
Phase 4 (Advanced)
    ↓ [Co-watching features tested]
Phase 5 (Testing & Release)
    ↓ [All tests pass, security audit clean]
🚀 Release v0.1.0 MVP
```

---

## Agent Orchestration During Development

### Validation Pipeline (from AGENTS.md)

For each commit/major change, run the agent stack in order:

**Tier 1: Syntax & Type Safety** (Parallel)
- Code Builder: `npm run build:all`
- Type Checker: Scan for broken references
- Type Safety: Enforce TypeScript strictness

**Tier 1.5: Security & Architecture** (Parallel)
- Security Scanner: No credential leaks, safe DOM ops
- Architecture Validator: No circular deps, proper messaging

**Tier 2: Business Logic** (Parallel)
- Matrix Compliance: (Not applicable to Hang Time)
- Metadata Schema: (Not applicable to Hang Time)

**Tier 2.5: Quality** (Sequential)
- Code Deduplicator: Identify duplication opportunities

**Tier 3: Testing** (Sequential)
- Test Runner: `npm test`

**Tier 4: Integration** (Sequential)
- Extension Build Verifier: Validate dist/ outputs

### When to Run
- ✅ After each new module implementation
- ✅ Before committing to main
- ✅ After major refactors
- ✅ When adding new features

---

## Implementation Notes

### Parallel Work (Multiple Branches)
If implementing with multiple team members, use feature branches:
- `feat/phase-1-architecture` → PR with design docs
- `feat/phase-2-build-pipeline` → PR with build scripts
- `feat/phase-3-activity-detection` → PR with service modules
- etc.

Each PR must pass full validation pipeline before merging.

### Quick Iteration (Single Developer)
Work in main or short-lived branches, run validation pipeline frequently:
1. Implement feature
2. Run validation agents
3. Fix any issues
4. Commit
5. Move to next feature

### Checkpoints
- **After Phase 1**: Architecture approved → proceed to Phase 2
- **After Phase 2**: Build works, core modules in place → proceed to Phase 3
- **After Phase 3**: Features working, no validation errors → proceed to Phase 4
- **After Phase 4**: All features complete, tests written → proceed to Phase 5
- **After Phase 5**: Tests pass, security audit clean → release

---

## Reference: Phase Timeline

| Phase | Duration | Focus | Agent Stack |
|-------|----------|-------|------------|
| 1: Design | 1-2d | Architecture | Explore, Plan, Code Guide |
| 2: Infrastructure | 2-3d | Build, Core Modules | Builder, Type Safety, Arch, Security |
| 3: Features | 3-4d | Activity Detection, UI | Builder, Type Safety, Security, Tests |
| 4: Advanced | 2-3d | Co-watching, Chat | Builder, Type Safety, Arch, Security |
| 5: Testing | 2d | Tests, Audit, Release | Tests, Security, Builder, Dedup |
| **Total** | **10-14 days** | Full MVP | All agents |

