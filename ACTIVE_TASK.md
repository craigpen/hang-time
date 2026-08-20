# Active Task: Session Model & Divergence

## 🎯 Current Goal
Complete the Session Model & Divergence implementation:
1. Fix `StorageManager.getActiveSession()` async/await bug and message visibility filtering.
2. Implement `JOIN_GUEST_ACTIVITY` navigation flow (pass URL and handle navigation).
3. Add "Leave Session" UI controls (pending discussion).
4. Activity Freshness & Inactivity Hiding (deferred until after testing).
5. Build automated unit & integration test suite for session lifecycle, divergence, and join actions.

## 💡 Rationale & Architectural Context
- Sessions persist across media changes (divergence) so friends remain connected while browsing different videos.
- Overlay renders in two modes: Host Mode (when 2+ watch the same video) and Guest Mode ("Choose next:" when diverged).
- Clicking [Join] on a friend's diverged card navigates the current tab to that friend's video.

---

## 📋 Task Checklist

- [x] **Task 1: Fix StorageManager Session & Message Methods**
  - [x] Add missing `await` on `this.get(STORAGE_KEYS.ACTIVE_SESSION)` in `getActiveSession()`.
  - [x] Refine `getVisibleMessages()` to filter messages involving user and active session members only.
- [x] **Task 2: Implement JOIN_GUEST_ACTIVITY Flow**
  - [x] Propagate activity `url` in `coWatcherActivities` in `entrypoints/background.ts`.
  - [x] Update `OverlayState.co_watcher_activities` type and `handleJoinGuest()` in `src/modules/overlay-ui.ts`.
  - [x] Implement `JOIN_GUEST_ACTIVITY` message handler in `background.ts` to navigate via `chrome.tabs.update` / `chrome.tabs.create`.
- [x] **Task 5: Automated Test Suite**
  - [x] Create `src/modules/__tests__/session-model.test.ts` with 13 comprehensive tests.
  - [x] Verify all 281 tests passing across 13 test files.
  - [x] Verify Chrome and Firefox extension builds succeed.
- [ ] **Task 3: "Leave Session" UI Control (Next to discuss)**
  - [ ] Decide placement and UX for "Leave Session" in overlay or popup.
  - [ ] Connect "Leave Session" action to dispatch `LEAVE_SESSION` over port.
- [ ] **Task 4: Activity Freshness & Inactivity Thresholds (Deferred)**
  - [ ] Enable 15m AFK / 60m offline hiding per spec after manual testing.

---

## 📌 Next Immediate Step
Discuss Task 3: "Leave Session" UI design and placement.
