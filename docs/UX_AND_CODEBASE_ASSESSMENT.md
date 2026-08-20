# Hang Time - Codebase & UX Assessment (August 2026)

## 1. Executive Summary
- **Project**: Hang Time — Decentralized browser extension for co-consuming media and discovering games with friends via Nostr.
- **Test Suite Status**: 100% Passing (265/265 tests across 11 test files).
- **Build Status**: Passing cleanly for Chrome and Firefox MV3 pipelines.

---

## 2. Code Quality & Architectural Observations

### Strengths
1. **Cryptographic Rigor**: Strict use of `@noble/curves`, `@noble/secp256k1`, `nostr-tools` with NIP-44 v2 encryption and 32-byte secp256k1 point validation.
2. **Storage Centralization**: State access is centralized in `StorageManager` with memory caching and namespace migration. Enforced by architectural unit tests.
3. **Data Integrity Gateway**: `ActivityDatastore` and `activity-validation.ts` sanitize and prevent corrupted data (bullet points, notification leaks, control characters, out-of-bounds progress).
3. **Publish Queue Priority System**: 3-tier event queueing (Instant user actions, Debounced playback positions, Bulk game library sync) preventing Nostr relay rate limiting.

### Tech Debt & Refactoring Targets
1. **Monolithic Files**:
   - `entrypoints/background.ts` (~4.3k lines): Candidate for splitting into `message-router.ts`, `tab-tracker.ts`, `nostr-subscriber.ts`.
   - `src/ui/popup.ts` (~3.0k lines): Candidate for extracting `friends.ts`, `chat.ts`, `settings.ts` tab controllers (following `games.ts` pattern).
   - `src/modules/overlay-ui.ts` (~1.6k lines): Floating video overlay DOM/event management.
2. **Type Safety for Inbound Payloads**: Add type guards/schema validation for inbound Nostr events (kinds 1059, 30315).

---

## 3. User Experience (UX) Assessment & Roadmap

### Standout UX Features
- **In-Video Floating Overlay**: Draggable, resizable, auto-dimming with pin option, opacity control (0-100%), progress bar with guest markers, 1-click sync drift correction, live chat, and session divergence ("Choose Next") display.
- **Game Discovery Tab**: Multi-filter system (genres, game modes, playtime) with active filter chips, sort options ("Most friends own it", Metacritic score), and friend ownership avatars.
- **Decentralized Privacy Controls**: Per-friend service muting/hiding, custom wildcard URL ignore lists, and zero-login setup.

### Recommended UX Enhancements
1. **Streamlined Friend Onboarding**:
   - Add a shareable invite link or QR code format that auto-populates the friend add dialog when opened.
2. **Side Panel / Expanded View (`chrome.sidePanel`)**:
   - Provide an option to expand the popup into Chrome's side panel or a full tab for browsing large game libraries and long chat histories.
3. **Interactive First-Run / Empty State**:
   - Replace static text placeholder with a "Quick Start" guide showing preview cards, "Add First Friend", and "Connect Steam" prompts.
4. **Instant Steam API Verification**:
   - Add inline check on Steam Web API key entry with visual feedback ("API Key Verified ✅").
5. **Accessibility (A11y)**:
   - Add `aria-label` to icon-only buttons (`🔄`, `⚙️`, `📋`, `👁️`) and ensure modal focus traps close on `Escape`.
