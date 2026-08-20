# Active Task: Session Model & Do Not Disturb (DND) / Solo Mode

## 🎯 Current Goal
Session Model & Do Not Disturb implementation:
1. Fix `StorageManager.getActiveSession()` async/await bug and message visibility filtering. ✅
2. Implement `JOIN_GUEST_ACTIVITY` navigation flow (pass URL and handle navigation). ✅
3. Implement Do Not Disturb (DND) / Solo Mode (suppresses auto co-watching, disables joins/invites, displays badges, persists status). ✅
4. Build automated unit & integration test suites for session lifecycle, divergence, and DND mode. ✅
5. Activity Freshness & Inactivity Hiding (deferred until after testing).

## 💡 Rationale & Architectural Context
- Sessions persist across media changes (divergence) so friends remain connected while browsing different videos.
- Overlay renders in two modes: Host Mode (when 2+ watch the same video) and Guest Mode ("Choose next:" when diverged).
- Clicking [Join] on a friend's diverged card navigates the current tab to that friend's video.
- DND / Solo Mode allows users to enjoy media privately without triggering overlay popups, while still publishing their activity to Nostr for friends to view in their friends list.

---

## 📋 Task Checklist

- [x] **Task 1: Fix StorageManager Session & Message Methods**
  - [x] Add missing `await` on `this.get(STORAGE_KEYS.ACTIVE_SESSION)` in `getActiveSession()`.
  - [x] Refine `getVisibleMessages()` to filter messages involving user and active session members only.
- [x] **Task 2: Implement JOIN_GUEST_ACTIVITY Flow**
  - [x] Propagate activity `url` in `coWatcherActivities` in `entrypoints/background.ts`.
  - [x] Update `OverlayState.co_watcher_activities` type and `handleJoinGuest()` in `src/modules/overlay-ui.ts`.
  - [x] Implement `JOIN_GUEST_ACTIVITY` message handler in `background.ts` to navigate via `chrome.tabs.update` / `chrome.tabs.create`.
- [x] **Task 3: Do Not Disturb (DND) / Solo Mode**
  - [x] Types: Add `dnd_enabled` to `UserProfile`, `dnd` to `Friend`, and `dnd` to `Activity` & metadata.
  - [x] Storage: Add `getDndMode()` and `setDndMode(enabled: boolean)` in `StorageManager`.
  - [x] Co-watcher Detection: Return `null` immediately if user is in DND; skip friends with `dnd: true` or `activity.dnd: true`.
  - [x] Activity Publisher: Include `dnd: profile.dnd_enabled` in Nostr published activity payload and tags.
  - [x] Background: Handle `GET_DND_MODE`, `SET_DND_MODE` (terminates active session + broadcasts `SESSION_ENDED`), extract friend `dnd` in `_processIncomingActivities`.
  - [x] Popup UI: Add `#dnd-toggle-btn` in header (`🟢 Available` / `⛔ Do Not Disturb`), show `⛔ DND` badge on friend cards, disable Join / Invite buttons for DND friends.
- [x] **Task 5: Automated Test Suite**
  - [x] Create `src/modules/__tests__/session-model.test.ts` with 13 comprehensive tests.
  - [x] Create `src/modules/__tests__/dnd-mode.test.ts` with 11 unit & integration tests.
  - [x] Add Steam language (`&l=english`) & Cyrillic cache invalidation tests in `metadata-fetcher.test.ts`.
  - [x] Verify all 293 tests passing across 14 test files.
  - [x] Verify Chrome and Firefox extension builds succeed.
- [x] **Task 6: Games Tab Metadata & Friend Library Synchronization**
  - [x] Force English metadata from Steam API (`&l=english`) and auto-repair non-English/Russian cached items.
  - [x] Publish game library as Nostr `kind: 10003` to match relay subscriptions and background filters.
  - [x] Auto-publish game library on extension startup and Steam settings change.
  - [x] Support friend lookup by `pubkey` and `uuid` in Games tab.
- [ ] **Task 4: Activity Freshness & Inactivity Thresholds (Deferred)**
  - [ ] Enable 15m AFK / 60m offline hiding per spec after manual testing.

---

## 📌 Next Immediate Step
Manual testing and feedback on DND Mode, Session Divergence, and Games Tab.
