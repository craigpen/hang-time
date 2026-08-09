# Session Model - Integration Test Plan

**Status**: Ready for Testing (Commit 878e637)

## Test Categories

### 1. Session Lifecycle

#### 1.1: Session Creation
- [ ] **Two friends on same video**
  - User A and B both watching youtube/abc
  - Expected: Session created with co_watchers=[A, B]
  - Verify: Console logs "User session created/updated"
  
- [ ] **Single user watching**
  - User A watching alone
  - Expected: No session (or session with only self)
  - Verify: No CO_WATCH_UPDATE sent

- [ ] **Multiple activities**
  - User A watching youtube/abc, B watching netflix/xyz
  - Expected: No match, no session
  - Verify: No CO_WATCH_UPDATE

#### 1.2: Session Persistence
- [ ] **Activity changes**
  - A and B co-watching youtube/abc
  - A navigates to netflix/xyz
  - Expected: Session persists, overlay shows divergence
  - Verify: co_watcher_activities shows A on netflix, B on youtube

- [ ] **Both diverge**
  - A on netflix/xyz, B on twitch/def
  - Expected: Session persists, both activities shown
  - Verify: Both appear with join buttons

- [ ] **Rejoin**
  - A on netflix/xyz, then navigates back to youtube/abc
  - Expected: A rejoins B on youtube (no new session)
  - Verify: Session ID unchanged, co_watchers updated

#### 1.3: Session End
- [ ] **Explicit leave**
  - User clicks "Leave Session" button
  - Expected: Session cleared (is_active = false)
  - Verify: Overlay closes, SESSION_ENDED sent to content script

- [ ] **Last person**
  - Only A in session, clicks leave
  - Expected: Session deleted, overlay empty
  - Verify: "Waiting for co-watchers..." message appears

- [ ] **Timeout** (if implemented)
  - Session idle for 30+ mins
  - Expected: Auto-close
  - Verify: Session cleared

### 2. Divergence Display

#### 2.1: Divergence Rendering
- [ ] **Same activity**
  - A and B both on youtube/abc
  - Expected: Chips show normally (no join buttons)
  - Verify: Chip shows nickname only

- [ ] **Different activities**
  - A on youtube/abc, B on netflix/xyz
  - Expected: B's chip shows [Netflix favicon] "Show Title" [Join]
  - Verify: Favicon renders, title truncates properly

- [ ] **Multiple diverged**
  - A on youtube, B on netflix, C on twitch
  - Expected: All show with join buttons, wrap naturally
  - Verify: Layout doesn't break with long titles

- [ ] **Empty state**
  - Session with only user (no co-watchers)
  - Expected: "Waiting for co-watchers..." message
  - Verify: Message centered and styled correctly

#### 2.2: Join Button
- [ ] **Click join**
  - User clicks join button on B's diverged activity
  - Expected: Message sent to content script
  - Verify: Console shows "JOIN_GUEST_ACTIVITY" message

- [ ] **Navigation** (manual test)
  - After joining, browser navigates to guest's video
  - Expected: Overlay updates, session continues
  - Verify: User now on same activity as guest

### 3. Messaging

#### 3.1: Message Privacy
- [ ] **Messages visible**
  - A and B co-watching, exchange messages
  - Expected: Both see each other's messages
  - Verify: Message history includes both

- [ ] **Third party invisible**
  - A and B have old messages together
  - C joins (new co-watcher)
  - Expected: C doesn't see A-B's old messages
  - Verify: C only sees current messages, not history

- [ ] **History preserved**
  - A and B chat, then diverge
  - A on youtube/abc, B on netflix/xyz
  - Expected: Message history still visible to both
  - Verify: Old messages still in overlay

#### 3.2: Message Sending
- [ ] **During co-watch**
  - Send message while co-watching
  - Expected: Message appears in overlay
  - Verify: Timestamp, sender, content correct

- [ ] **During divergence**
  - A on youtube, B on netflix, A sends message
  - Expected: Message still sends to B
  - Verify: B receives via Nostr, stored locally

### 4. Regressions (Existing Features)

#### 4.1: Sync & Progress
- [ ] **Sync button**
  - User clicks sync button as guest
  - Expected: Seeks to host position (with interpolation)
  - Verify: Video jumps to correct position

- [ ] **Progress bars**
  - Host and guest progress displayed
  - Expected: Markers show correct positions
  - Verify: No overlapping, smooth updates

- [ ] **Host determination**
  - Multiple people on same video
  - Expected: Earliest contentTimestamp is host
  - Verify: Green indicator on correct person

#### 4.2: State Accuracy
- [ ] **Playing/Paused state**
  - Host pauses video
  - Expected: Guests see paused indicator
  - Verify: State icon updates (▶ ⏸)

- [ ] **Video duration**
  - Video with known duration
  - Expected: Progress bar respects duration
  - Verify: No overflow at 100%

#### 4.3: Overlays (if multiple tabs)
- [ ] **Single overlay visible**
  - Multiple co-watcher tabs open
  - Expected: Only active tab shows overlay
  - Verify: No duplicate overlays

### 5. Edge Cases

#### 5.1: Timing Issues
- [ ] **Simultaneous diverge**
  - A and B both navigate at same time
  - Expected: Session updates, both activities shown
  - Verify: No race conditions, consistent state

- [ ] **Rapid activity changes**
  - User rapidly clicks between videos
  - Expected: Overlay updates smoothly
  - Verify: No errors, state consistent

#### 5.2: Network Issues
- [ ] **Relay lag**
  - Slow Nostr relay (simulate delay)
  - Expected: Session still works, updates delayed
  - Verify: No crashes, graceful handling

- [ ] **Offline**
  - User goes offline temporarily
  - Expected: Session persists locally
  - Verify: Reconnect shows updated state

#### 5.3: Browser Issues
- [ ] **Tab close**
  - User closes co-watch video tab
  - Expected: Activity stops publishing
  - Verify: Overlay shows "offline" or similar

- [ ] **Extension reload**
  - User reloads extension while co-watching
  - Expected: Session restores (if persistent)
  - Verify: Overlay reopens with state

#### 5.4: Multiple Sessions
- [ ] **Two separate co-watches**
  - (Future) A watches with B, then with C
  - Expected: Only one active session (B or C)
  - Verify: Clean transition

## Console Checks

All tests should verify:
- [ ] No red error messages
- [ ] "User session created/updated" logs on co-watch detection
- [ ] "User left co-watch session" logs on leave
- [ ] Message flow logs show MESSAGE_FLOW tags
- [ ] No infinite loops or repeated messages

## Manual Testing Checklist

### Setup
- [ ] Two browsers open (or profiles)
- [ ] Both on hang-time/test network
- [ ] Both have video sites loaded (YouTube, Netflix)
- [ ] DevTools open to monitor console

### Flow Test
1. [ ] Load video in Browser A
2. [ ] Load same video in Browser B
3. [ ] Verify session creates (console logs)
4. [ ] Overlay appears on both
5. [ ] Send message from A → appears in B
6. [ ] Send message from B → appears in A
7. [ ] B navigates to different video
8. [ ] Verify B's activity shows with join button
9. [ ] A clicks join on B's video
10. [ ] Verify A navigates to B's video
11. [ ] Both back in sync, session continues
12. [ ] A clicks "Leave Session"
13. [ ] Overlay shows "Waiting for co-watchers"
14. [ ] B still sees co-watch session (A left)
15. [ ] Message history preserved for both

### Regression Check
- [ ] Sync button works (seek to host position)
- [ ] Progress bars show correctly
- [ ] Host determination correct (green indicator)
- [ ] No console errors
- [ ] No duplicate overlays
- [ ] Messages don't leak between sessions

## Success Criteria

✅ **Pass** if:
- All session lifecycle tests pass
- All divergence display tests pass
- All message privacy tests pass
- No regressions in existing features
- No console errors in normal use
- Manual testing flow completes without issues

⚠️ **Known Limitations**:
- JOIN_GUEST_ACTIVITY handler not yet implemented in content script
- Session timeout not yet implemented
- Multiple simultaneous sessions not yet supported

## Next Steps After Testing

If all tests pass:
1. Document findings
2. Create known-good checkpoint
3. Move to Phase 2 (Session-independent UI refinements)

If issues found:
1. Log bug reports
2. Create minimal reproduction cases
3. Fix in targeted commits
4. Re-test affected areas
