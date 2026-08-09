# Session Model Comprehensive Test Execution Guide

## Critical Pre-Flight Checklist

Before starting ANY test, complete these steps:

### 1. Build the Extension
```bash
npm run build
```
Verify both Chrome and Firefox builds succeed.

### 2. Prepare Browser Instances

You need TWO COMPLETELY SEPARATE Chrome instances (not just windows - use `--profile-directory`):

**test2 (Host Browser)**
```bash
# On Windows, open PowerShell and run:
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --profile-directory="Profile 1" "chrome-extension://[YOUR_EXTENSION_ID]/popup.html"
```

**test3 (Guest Browser)**
```bash
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --profile-directory="Profile 2" "chrome-extension://[YOUR_EXTENSION_ID]/popup.html"
```

### 3. Fresh Install for Each Major Test

- **Before Scenario 1**: Clear all storage in BOTH browsers
  - Settings → Extensions → Hang Time → Details → Clear data
  - Or: Open DevTools Console and run:
    ```javascript
    chrome.storage.local.clear(() => console.log('Storage cleared'));
    ```

- **Before Scenario 8**: Again, clear all storage in BOTH browsers

- **Between Scenario 2-7**: Do NOT clear storage (these scenarios build on each other)

### 4. Enable Console Logging

In BOTH test2 and test3, open Chrome DevTools:
- **Service Worker Console**: Extensions → Hang Time → Inspect views (background page)
- **Content Script Console**: YouTube tab → F12 → Console

Monitor these in parallel:

```
[Background]         = Service Worker logs
[ContentScript]      = Video page logs
[MESSAGE_FLOW]       = All message-related logs (critical for test 3, 5)
[CoWatcher]          = Session detection logs
[TimestampMigration] = Host determination logs
```

---

## Test Execution Guide

### Scenario 1: FRESH INSTALL - No Overlay Until Co-Watchers

**Duration**: 2-3 minutes

**Setup**:
- Fresh clear of all storage in test2
- No test3 running yet
- Close all tabs except Chrome

**Steps**:

1. **test2 opens YouTube**
   - Navigate to `youtube.com`
   - Click any video (e.g., any cat video, music, etc.)
   - Wait for page to load completely
   - **Verify**: Video is playing or paused (not important which)

2. **Check DevTools Console (test2)**
   - Open YouTube video's console (F12)
   - Search for `[ContentScript] Video element found` or similar
   - **Should NOT see** any "overlay showing" or "CO_WATCH_UPDATE" messages yet
   - **Verify**: Overlay div might exist in DOM but must be invisible (display: none or opacity: 0)

3. **Visually inspect the video page**
   - Look at the right side of the video player
   - **Should NOT see** any overlay panel, floating box, or indicator
   - If you see ANYTHING, this scenario **FAILS**

**Expected Console Logs**:
```
[ContentScript] Video detected on youtube.com
[ContentScript] Activity updated: {id: "xyz", service: "youtube-tab", ...}
```

**Should NOT see**:
```
[Background] CO_WATCH_UPDATE sent
[CoWatcher] Co-watch session detected
[OverlayUI] Showing overlay
```

**Assertion Checklist**:
- [ ] Overlay completely invisible (no visual elements on page)
- [ ] No console errors in either service worker or content script
- [ ] No "No co-watch session" warnings (should be silent)

**Status**: ✅ PASS / ❌ FAIL

---

### Scenario 2: CO-WATCH DETECTION - Both On Same Video

**Duration**: 3-5 minutes

**Setup**:
- test2 still on YouTube video A (from Scenario 1)
- DO NOT refresh or change anything on test2
- Storage is NOT cleared between Scenario 1 and 2

**Steps**:

1. **Add test3 (fresh browser)**
   - Open test3 browser with Chrome profile
   - Both browsers should see the extension installed
   - Navigate test3 to SAME EXACT YouTube URL as test2
   - Wait 5 seconds for page to load and activity to publish to Nostr

2. **Monitor Nostr publishing (background console, test2)**
   - Open test2's Service Worker console (Extensions → Hang Time → Inspect views)
   - Look for logs like:
     ```
     [Publisher] Publishing activity: youtube-tab/abc123
     [Publisher] ✅ Published to relay
     ```
   - This confirms test2's activity is on Nostr relays

3. **Monitor detection cycle (test2 background)**
   - Keep watching test2's background console
   - Every 5 seconds you should see:
     ```
     [CoWatcher] detectCoWatchSession call #XX
     [CoWatcher] [MESSAGE_FLOW] Detecting: 1 user activities, 1 friends
     ```
   - After test3 publishes (~5-10 seconds), you should see:
     ```
     [CoWatcher] [MESSAGE_FLOW] ✅ Match found: youtube-tab/abc123 with test3
     [CoWatcher] ✅ Found co-watcher: test3 (uuid-xxx) watching activity=abc123
     ```

4. **Check overlay appearance on test2**
   - Look at test2's video page
   - On the right side of the video player, you should see a semi-transparent panel
   - Panel should show:
     ```
     Host: You
     Guest: test3
     ```
   - Below that: message input box, sync button
   - Progress bar showing video progress

5. **Check overlay appearance on test3**
   - Look at test3's video page
   - Similar panel on the right
   - Should show:
     ```
     Host: test2
     Guest: You
     ```

**Expected Detailed Console Logs**:

test2 Service Worker:
```
[CoWatcher] [MESSAGE_FLOW] ✅ Match found: youtube-tab/abc123 with test3
[CoWatcher] ✅ Found co-watcher: test3 watching activity=abc123
[CoWatcher] Created new user session: {session_id: "abc...", co_watchers: 2, activity_id: "abc123"}
[Background] CO_WATCH_UPDATE data: {
  host_progress: 45.5,
  is_user_host: true,
  watching_together: ["uuid-test2", "uuid-test3"]
}
[Background] ✅ Sent CO_WATCH_UPDATE with 0 messages
```

**Critical Assertion Checklist**:
- [ ] test2 overlay shows: Host: You, Guest: test3
- [ ] test3 overlay shows: Host: test2, Guest: You
- [ ] Both overlays have message input boxes
- [ ] Both overlays show progress bars
- [ ] No console errors (check for "Failed to send" or "Friend lookup failed")
- [ ] Both overlays update progress in real-time (watch for 2-3 seconds)

**Failure Investigation**:
- If overlays don't appear:
  - Check both service worker consoles for errors
  - Verify activities are being published (look for [Publisher] logs)
  - Verify co-watch detection ran (look for [CoWatcher] call count incrementing)
  - Check if activities have matching `activity_id` values in logs

- If names show as truncated UUIDs (e.g., "wild-coa"):
  - Look for "Friend lookup failed" warnings in logs
  - Verify friends were added correctly (should have local_name)

**Status**: ✅ PASS / ❌ FAIL

---

### Scenario 3: MESSAGE EXCHANGE - Bidirectional Via Nostr

**Duration**: 2-3 minutes

**Setup**:
- Both overlays visible (from Scenario 2)
- DO NOT clear storage
- DO NOT refresh pages

**Steps**:

1. **test2 sends first message**
   - Click message input box on test2's overlay
   - Type: `Hello from test2`
   - Press Enter
   - **Verify**: Message appears immediately in test2's overlay (from: "You")

2. **Monitor message flow in test2's service worker**
   - Watch console for:
     ```
     [Background] [MESSAGE_FLOW] ✅ SEND_MESSAGE RECEIVED: Hello from test2
     [Background] [MESSAGE_FLOW] Storing message: {id: "msg_...", from: "uuid-test2", recipients: ["uuid-test3"]}
     [Background] [MESSAGE_FLOW] ✅ Message stored in unified model
     [Background] [MESSAGE_FLOW] Sending message to friend: test3 (uuid-test3)
     [Background] [MESSAGE_FLOW] ✅ Message queued for test3
     ```
   - **Critical**: Verify `from` field shows test2's UUID (not truncated)
   - **Critical**: Verify `recipients` includes test3's UUID

3. **Wait for message delivery to test3**
   - Wait 2-3 seconds for Nostr relay delivery
   - Check test3's overlay
   - **Verify**: Message appears in test3's chat as:
     ```
     1 from test2 (not You): Hello from test2
     ```
   - Message sender name should be "test2" (local_name), NOT truncated UUID

4. **test3 sends response**
   - Click message input on test3's overlay
   - Type: `Hello from test3`
   - Press Enter

5. **Monitor message flow in test3's service worker**
   - Look for identical logging pattern as step 2
   - Verify `from: uuid-test3` and `recipients: ["uuid-test2"]`

6. **Verify message appears on test2**
   - Check test2's overlay
   - **Verify**: Message appears as:
     ```
     2 from test3 (not You): Hello from test3
     ```

**Critical Assertions**:
- [ ] test2 sees message #1 from itself as "You"
- [ ] test3 sees message #1 from test2 (shows "test2", not "You")
- [ ] test3 sees message #2 from itself as "You"
- [ ] test2 sees message #2 from test3 (shows "test3", not "You")
- [ ] No "Friend lookup failed" warnings in either service worker console
- [ ] No message sender attribution confusion (no messages showing as "You" when they're from the other person)
- [ ] Both messages have timestamps (should be close but test2 msg < test3 msg)

**Console Log Verification**:

test2 background should show:
```
[Background] [MESSAGE_FLOW] SEND_MESSAGE sender UUID: {uuid: "test2-long-uuid", nickname: "test2"}
[Background] [MESSAGE_FLOW] Recipient IDs for message: ["test3-long-uuid"]
```

test3 background should show:
```
[Background] [MESSAGE_FLOW] SEND_MESSAGE sender UUID: {uuid: "test3-long-uuid", nickname: "test3"}
[Background] [MESSAGE_FLOW] Recipient IDs for message: ["test2-long-uuid"]
```

**Failure Investigation**:
- If message doesn't arrive on recipient's side after 5 seconds:
  - Check recipient's background console for "No co-watch session" warning
  - Check Nostr relay logs (might be rate-limited)
  - Verify `recipients` array has correct UUID in sender's logs
  - Check if message was actually queued by MessagingManager

- If sender shows wrong on recipient:
  - Look at CO_WATCH_UPDATE's nicknameMap in logs
  - Verify friend lookup succeeded (should see "Added co-watcher to nicknameMap" or "Added message sender to nicknameMap")

**Status**: ✅ PASS / ❌ FAIL

---

### Scenario 4: DIVERGENCE - One Person Switches Videos

**Duration**: 3-5 minutes

**Setup**:
- Both on same video from Scenario 2-3
- DO NOT clear storage
- Both overlays visible with messages

**Steps**:

1. **test3 navigates to different YouTube video (Video B)**
   - Find URL of a different YouTube video
   - Paste into test3's address bar
   - Wait for page to load (5-10 seconds)
   - Video should start playing

2. **Monitor activity publishing on test3**
   - Open test3's background console
   - Look for:
     ```
     [Activity] Detected new activity on youtube-tab
     [Publisher] Publishing activity: youtube-tab/video-B-id
     [Publisher] ✅ Published to relay
     ```

3. **Check test2's overlay after divergence detection (wait 5-10 seconds)**
   - test2's background should detect:
     ```
     [CoWatcher] [MESSAGE_FLOW] ✅ Match found: youtube-tab/video-B-id with test3
     [CoWatcher] No activity match, keeping session active for divergence
     ```
   - test2's overlay should NOW show divergence UI for test3:
     ```
     Host: You (on Video A)
     ---
     test3 is on: [Video B Favicon] "Video B Title" [Join Button]
     ```
   - **Critical**: Session should NOT end, overlay should still be visible

4. **Verify session persists (test2 background)**
   - Look for log:
     ```
     [CoWatcher] Updated existing user session activity context
     ```
   - This shows session was NOT recreated, just activity context updated

5. **Check test3's overlay**
   - test3's overlay should still show:
     ```
     Host: test2 (on Video A)
     Guest: You (watching Video B)
     ```
   - Or possibly just empty if no activity match detected (acceptable)
   - **Verify**: Session is still active (not closed/hidden)

**Critical Assertions**:
- [ ] test2's overlay shows divergence UI: test3 name + Video B favicon + title + Join button
- [ ] test2's overlay does NOT close or hide
- [ ] Session session_id remains unchanged (same as Scenario 2)
- [ ] No "session ended" messages in logs
- [ ] No "No co-watch session" warnings during this step

**Console Verification**:

test2 background:
```
[CoWatcher] [MESSAGE_FLOW] ✅ Match found: youtube-tab/video-B-id with test3
[CoWatcher] [MESSAGE_FLOW] ❌ No friends watching video-A-id with you
[CoWatcher] No activity match, keeping session active for divergence
[Background] User session created/updated: {session_id: "SAME_ID_AS_BEFORE", ...}
```

**Failure Investigation**:
- If overlays close instead of showing divergence:
  - Check if session was cleared (should see "clearActiveSession")
  - Verify divergence UI is implemented in overlay-ui.ts
  - Check coWatcherActivities building logic in background.ts line ~1041

- If test2 shows truncated UUID instead of "test3":
  - Check Friend lookup logs
  - Verify test3's friend record has local_name set

**Status**: ✅ PASS / ❌ FAIL

---

### Scenario 5: MESSAGES DURING DIVERGENCE - Continue Flowing

**Duration**: 2-3 minutes

**Setup**:
- test2 on Video A, test3 on Video B (diverged from Scenario 4)
- Overlays both visible
- Session still active

**Steps**:

1. **test2 sends message 5 to test3 (still on different videos)**
   - Type: `Message 5 while diverged`
   - Press Enter
   - Wait 2 seconds

2. **Verify message appears on test3's overlay**
   - test3's overlay should show:
     ```
     5 from test2 (not You): Message 5 while diverged
     ```
   - **Critical**: Message delivered DESPITE divergence

3. **Monitor logs on test2**
   - Should see:
     ```
     [Background] [MESSAGE_FLOW] getCurrentCoWatchSession() returned: {session_id: "ABC", co_watchers: 2}
     [Background] [MESSAGE_FLOW] Co-watch session found. Activity: video-A-id
     ```
   - Message queued for test3 successfully

4. **test3 sends message 6 from Video B**
   - Type: `Message 6 from different video`
   - Press Enter
   - Wait 2 seconds

5. **Verify message appears on test2**
   - test2's overlay should show:
     ```
     6 from test3 (not You): Message 6 from different video
     ```

**Critical Assertions**:
- [ ] Message 5 appears on test3 with correct sender (test2)
- [ ] Message 6 appears on test2 with correct sender (test3)
- [ ] No "No co-watch session" warnings in either background console
- [ ] No message delivery timeouts or failures
- [ ] getCurrentCoWatchSession() returns session (not null)
- [ ] Recipients include correct UUIDs in logs

**Console Verification**:

test2 background when sending message 5:
```
[Background] [MESSAGE_FLOW] getCurrentCoWatchSession() returned: {session_id: "...", co_watchers: 2}
[Background] [MESSAGE_FLOW] Co-watch session found. Activity: video-A-id, Co-watchers: ["test2-uuid", "test3-uuid"]
[Background] [MESSAGE_FLOW] Recipient IDs for message: ["test3-uuid"]
[Background] [MESSAGE_FLOW] ✅ Message stored in unified model
```

test3 background when sending message 6:
```
[Background] [MESSAGE_FLOW] getCurrentCoWatchSession() returned: {session_id: "...", co_watchers: 2}
[Background] [MESSAGE_FLOW] Recipient IDs for message: ["test2-uuid"]
```

**Status**: ✅ PASS / ❌ FAIL

---

### Scenario 6: RE-CONVERGENCE - Back To Same Video

**Duration**: 3-5 minutes

**Setup**:
- test2 on Video A, test3 on Video B (diverged)
- Overlays showing divergence UI
- Messages flowing

**Steps**:

1. **test3 navigates back to Video A (same as test2)**
   - Go back to Video A URL (can use browser back button or paste URL)
   - Wait for page to load
   - Wait 5-10 seconds for activity detection and Nostr publishing

2. **Monitor re-convergence on test2 (background console)**
   - Should see:
     ```
     [CoWatcher] [MESSAGE_FLOW] ✅ Match found: youtube-tab/video-A-id with test3
     ```
   - Instead of showing divergence, now matches same activity

3. **Check test2's overlay after re-convergence**
   - Divergence UI should DISAPPEAR
   - Should now show simple co-watcher chip:
     ```
     Host: You
     Guest: test3
     ```
   - No Video B favicon, title, or Join button

4. **Verify session_id is same**
   - Session_id should NOT change
   - Look in logs:
     ```
     [CoWatcher] Updated existing user session activity context: {session_id: "SAME_ID_AS_BEFORE"}
     ```

**Critical Assertions**:
- [ ] test2's overlay no longer shows divergence UI for test3
- [ ] Simple co-watcher chip shows (just name, no video info)
- [ ] Session session_id unchanged
- [ ] No new CO_WATCH_UPDATE needed (session already there)
- [ ] activity_id in session updated to video-A-id

**Console Verification**:

test2 background:
```
[CoWatcher] [MESSAGE_FLOW] ✅ Match found: youtube-tab/video-A-id with test3
[CoWatcher] Updated existing user session activity context: {session_id: "SAME_FROM_SCENARIO_2", activity_id: "video-A-id"}
```

**Status**: ✅ PASS / ❌ FAIL

---

### Scenario 7: PERSISTENT SESSION - Across Multiple Divergences

**Duration**: 5-8 minutes

**Setup**:
- test2 & test3 on Video A (re-converged from Scenario 6)
- Session active, session_id stable
- Messages working

**Steps**:

1. **test3 switches to Video C (different from A and B)**
   - Navigate to a third different YouTube video
   - Wait 5-10 seconds for detection
   - **Verify**: test2's overlay shows divergence UI for test3 on Video C

2. **Send messages while on Video C**
   - test2: Send `Message 7`
   - test3: Send `Message 8`
   - **Verify**: Both arrive correctly
   - Log session_id and note it down: `SESSION_ID_A`

3. **test3 switches to Video D (yet another different video)**
   - Navigate to fourth different YouTube video
   - Wait 5-10 seconds for detection
   - **Verify**: test2's overlay updates divergence UI for Video D

4. **Send more messages on Video D**
   - test2: Send `Message 9`
   - test3: Send `Message 10`
   - **Verify**: Both arrive

5. **test3 goes back to Video A (original)**
   - Navigate back to Video A
   - Wait 5-10 seconds for re-convergence detection
   - **Verify**: Divergence UI disappears

6. **Send final message**
   - test2: Send `Message 11`
   - **Verify**: Arrives on test3

7. **Verify session_id stayed the same throughout**
   - Compare SESSION_ID_A (from step 2) with current session_id in logs
   - Should be identical
   - **Verify**: Only 1 session created (not 4 different sessions)

**Critical Assertions**:
- [ ] Session_id from Scenario 2 = Session_id through all divergences = Session_id now
- [ ] co_watchers list unchanged: [test2-uuid, test3-uuid]
- [ ] All 11 messages eventually appear on both overlays
- [ ] No "session ended" or "session created" messages between divergences (only "Updated existing")
- [ ] Message timestamps are in order (7 < 8 < 9 < 10 < 11)

**Console Verification**:

test2 background logs should show:
```
# Step 1: Diverge to Video C
[CoWatcher] Updated existing user session activity context: {session_id: "SESSION_ID_A", activity_id: "video-C-id"}

# Step 3: Diverge to Video D
[CoWatcher] Updated existing user session activity context: {session_id: "SESSION_ID_A", activity_id: "video-D-id"}

# Step 5: Re-converge to Video A
[CoWatcher] Updated existing user session activity context: {session_id: "SESSION_ID_A", activity_id: "video-A-id"}
```

**Note**: session_id should NEVER show "Created new user session" after Scenario 2

**Status**: ✅ PASS / ❌ FAIL

---

### Scenario 8: EXPLICIT LEAVE - User Clicks Leave Session

**Duration**: 3-5 minutes

**Setup**:
- Fresh clear of storage in BOTH browsers
- test2 and test3 on same YouTube video
- Overlays visible with session active

**Steps**:

1. **Establish session (quick repeat of Scenario 2)**
   - test2 navigates to YouTube video
   - test3 navigates to SAME video
   - Wait 5-10 seconds for detection
   - **Verify**: Both overlays show co-watchers

2. **test2 clicks "Leave Session" button**
   - Find button in test2's overlay (should be near bottom)
   - Click it
   - **Verify**: test2's overlay closes/disappears immediately

3. **Monitor test2's background console**
   - Should see:
     ```
     [Background] User left co-watch session
     [Background] ✅ SESSION_ENDED notification sent to content script
     ```

4. **Monitor test2's content script console**
   - Should see:
     ```
     [OverlayUI] SESSION_ENDED received
     [OverlayUI] Hiding overlay
     ```

5. **Check test3's overlay**
   - test3's overlay should now show empty/waiting state
   - No co-watchers listed
   - Message input might be disabled or overlay hidden

6. **Monitor test3's background console**
   - Should see:
     ```
     [Background] CO_WATCH_UPDATE with watching_together: []
     ```

7. **test2 navigates to different video**
   - Go to Video B
   - Wait 5-10 seconds
   - **Verify**: No new session created

8. **test3 clicks on test2's new activity in popup (if shown)**
   - If notification shows "test2 is watching Video B"
   - Click to join
   - **Verify**: Creates NEW session_id (not same as before)
   - Logs should show: `Created new user session: {session_id: "NEW_ID_DIFFERENT_FROM_SCENARIO_2"}`

**Critical Assertions**:
- [ ] test2 session cleared immediately (overlay hidden)
- [ ] test3 receives CO_WATCH_UPDATE with watching_together: []
- [ ] test3 overlay shows no co-watchers or hides
- [ ] storageManager.getActiveSession() returns null on test2
- [ ] Next co-watch detection creates new session_id
- [ ] New session_id != old session_id

**Console Verification**:

test2 background:
```
[Background] User left co-watch session
[Background] ✅ SESSION_ENDED notification sent to content script
```

test2 content script:
```
[OverlayUI] SESSION_ENDED received
[OverlayUI] Hiding overlay
```

test3 background:
```
[Background] CO_WATCH_UPDATE with watching_together: []
```

When test2 later rejoins (step 8):
```
[CoWatcher] Created new user session: {session_id: "NEW_UUID_HERE", ...}
```

**Failure Investigation**:
- If test2's overlay doesn't close:
  - Check for errors in SESSION_ENDED handling
  - Verify LEAVE_SESSION message type is correct
  - Check storage.clearActiveSession() is called

- If test3's overlay doesn't update:
  - Check CO_WATCH_UPDATE is sent after leave
  - Verify watching_together array is empty in broadcast

**Status**: ✅ PASS / ❌ FAIL

---

### Scenario 9: EDGE CASE - Rapid Message Sending

**Duration**: 3-4 minutes

**Setup**:
- Fresh session (both on same video)
- Overlays visible
- Clean message history

**Steps**:

1. **test2 sends 5 messages rapidly (no waiting)**
   - Message 1: `Rapid 1`
   - Message 2: `Rapid 2`
   - Message 3: `Rapid 3`
   - Message 4: `Rapid 4`
   - Message 5: `Rapid 5`
   - Send all within 2-3 seconds (fast clicking)

2. **test3 sends 5 messages rapidly (overlapping)**
   - While test2's messages are in flight
   - Message 6: `Fast 1`
   - Message 7: `Fast 2`
   - Message 8: `Fast 3`
   - Message 9: `Fast 4`
   - Message 10: `Fast 5`

3. **Wait 5 seconds for all Nostr delivery**
   - Watch both overlays for messages to appear

4. **Count messages on test2's overlay**
   - Should see all 10:
     - Rapid 1-5 (from test2, marked as "You")
     - Fast 1-5 (from test3)
   - **Verify**: All 10 present, none missing

5. **Count messages on test3's overlay**
   - Should see all 10:
     - Rapid 1-5 (from test2)
     - Fast 1-5 (from test3, marked as "You")
   - **Verify**: All 10 present, none missing

6. **Check for duplicates**
   - Scroll through message history
   - **Verify**: No message appears twice
   - Each message unique (check timestamps)

7. **Verify order is correct**
   - Messages should be sorted by timestamp
   - Rapid 1 timestamp < Rapid 2 < ... < Fast 5
   - test2 messages should have earlier timestamps than test3 (test2 sent first)

**Critical Assertions**:
- [ ] test2 overlay shows exactly 10 messages
- [ ] test3 overlay shows exactly 10 messages
- [ ] No duplicates (count unique id values)
- [ ] No message loss (all senders match expected: 5 from test2, 5 from test3)
- [ ] Correct sender attribution (Rapid X from test2, Fast X from test3)
- [ ] Timestamps in ascending order
- [ ] No Nostr rate-limit errors in logs

**Console Verification**:

test2 background should show 5 separate SEND_MESSAGE logs:
```
[Background] [MESSAGE_FLOW] ✅ SEND_MESSAGE RECEIVED: Rapid 1
[Background] [MESSAGE_FLOW] ✅ SEND_MESSAGE RECEIVED: Rapid 2
...
```

test3 background should show 5 separate SEND_MESSAGE logs at overlapping time

**Failure Investigation**:
- If messages missing:
  - Check for "Failed to send message" errors
  - Check if relay was rate-limited
  - Verify all messages were queued (check MESSAGE_FLOW logs for all 10)

- If duplicates:
  - Check message deduplication logic in CO_WATCH_UPDATE (line ~964 in background.ts)
  - Verify message id is unique for each send

- If wrong sender attribution:
  - Check from field and recipients field in logs
  - Verify nicknameMap in CO_WATCH_UPDATE broadcast

**Status**: ✅ PASS / ❌ FAIL

---

### Scenario 10: EDGE CASE - Session Persistence After Navigation

**Duration**: 3-4 minutes

**Setup**:
- Fresh session (both on Video A)
- Overlays visible

**Steps**:

1. **test2 navigates to different YouTube video (Video B)**
   - Click on a different video or paste new URL
   - Wait for page load
   - New activity should be detected and published

2. **Wait 5-10 seconds for activity update**
   - test2's background should detect new activity
   - test3's background should detect test2 switched to Video B
   - test3's overlay should show divergence UI (test2 on Video B)

3. **test2 navigates BACK to Video A**
   - Use browser back button or paste Video A URL again
   - Wait for page load and activity re-detection
   - Wait 5-10 seconds

4. **Verify session still active**
   - Session_id should be SAME as step 1
   - Check logs:
     ```
     [CoWatcher] Updated existing user session: {session_id: "SAME_ID"}
     ```

5. **Verify overlays work**
   - test2 overlay should be visible
   - test3 overlay should be visible (back to showing co-watcher normally, not divergence)
   - Both should show co-watchers again

6. **Send message to confirm session is alive**
   - test2: Send `After navigation`
   - test3: Receive within 2-3 seconds
   - **Verify**: Message delivered successfully

**Critical Assertions**:
- [ ] Session_id unchanged after navigation
- [ ] Overlay re-initializes with correct state
- [ ] No new CO_WATCH_UPDATE needed (session already there)
- [ ] Messages still work after navigation
- [ ] No "session ended" messages in logs
- [ ] Overlay renders correctly on re-entry to Video A

**Console Verification**:

test2 background (step 3-4):
```
[Activity] New activity detected: youtube-tab/video-B-id
[Publisher] Publishing activity: youtube-tab/video-B-id
```

Then (step 4-5):
```
[Activity] New activity detected: youtube-tab/video-A-id
[Publisher] Publishing activity: youtube-tab/video-A-id
[CoWatcher] Updated existing user session: {session_id: "ORIGINAL_ID", activity_id: "video-A-id"}
```

**Failure Investigation**:
- If session_id changes:
  - Session was recreated instead of reused
  - Check storage.getActiveSession() logic
  - Might be clearing on page navigation

- If overlay doesn't appear:
  - Content script might not be connecting
  - Check GET_OVERLAY_STATE handler
  - Verify port is still connected after navigation

**Status**: ✅ PASS / ❌ FAIL

---

## Summary & Reporting Template

After completing all scenarios, fill in this summary:

```markdown
## Test Run Summary - [DATE/TIME]

### Critical Path (Scenarios 1-4)
- Scenario 1: ✅ PASS / ❌ FAIL
- Scenario 2: ✅ PASS / ❌ FAIL
- Scenario 3: ✅ PASS / ❌ FAIL
- Scenario 4: ✅ PASS / ❌ FAIL

**Critical Path Result**: ✅ ALL PASS / ❌ BLOCKING ISSUES

### Main Features (Scenarios 5-8)
- Scenario 5: ✅ PASS / ❌ FAIL
- Scenario 6: ✅ PASS / ❌ FAIL
- Scenario 7: ✅ PASS / ❌ FAIL
- Scenario 8: ✅ PASS / ❌ FAIL

**Main Features Result**: ✅ ALL PASS / ❌ ISSUES FOUND

### Edge Cases (Scenarios 9-10)
- Scenario 9: ✅ PASS / ❌ FAIL
- Scenario 10: ✅ PASS / ❌ FAIL

**Edge Cases Result**: ✅ ALL PASS / ⚠️ MINOR ISSUES

### Overall Result
- **PASS**: All 10 scenarios pass without workarounds
- **REVIEW**: Scenarios pass but with unexpected warnings/logs
- **FAIL**: Any scenario has data loss, wrong attribution, or console errors

### Key Findings
[List any bugs, issues, unexpected behavior, or console errors found]

### Recommendations
[Suggest fixes or improvements based on findings]
```

---

## Debugging Toolkit

### Quick Checks

**Is the extension connected?**
```javascript
// In background console:
chrome.storage.local.get(['active_session'], (result) => {
  console.log('Active session:', result.active_session);
});
```

**Are messages stored?**
```javascript
// In background console:
chrome.storage.local.get(['messages'], (result) => {
  console.log('All messages:', result.messages);
});
```

**What's the current activity?**
```javascript
// In background console:
chrome.storage.local.get(['hang_time_my_activities'], (result) => {
  console.log('My activities:', result);
});
```

**Are friends loaded?**
```javascript
// In background console:
chrome.storage.local.get(['hang_time_friends'], (result) => {
  const friends = result['hang_time_friends'];
  console.log('Friends count:', friends?.length);
  friends?.forEach(f => console.log(`  - ${f.local_name} (${f.uuid})`));
});
```

### Log Filtering

**Show only MESSAGE_FLOW logs**:
In DevTools, use filter: `[MESSAGE_FLOW]`

**Show only errors**:
In DevTools, click the error badge or filter: `error:`

**Follow a specific message ID**:
Search console for the message ID (from logs like `id: msg_12345...`)

### Common Failure Patterns

| Issue | Likely Cause | Debug Step |
|-------|--------------|-----------|
| No overlay appears | Co-watch not detected | Check [CoWatcher] logs, verify activities match |
| Message doesn't arrive | Session not found | Verify getCurrentCoWatchSession() in logs |
| Wrong sender name | Friend lookup failed | Look for "Friend lookup FAILED" warning |
| Truncated UUID shown | Missing local_name on friend | Verify friend.local_name is set |
| Session recreated | Session cleared unexpectedly | Search logs for "clearActiveSession" |
| Divergence UI doesn't show | coWatcherActivities not built | Check lines ~1041 in background.ts |

---

## Success Criteria

### All Green (Perfect Run)
- [ ] All 10 scenarios pass
- [ ] No console errors
- [ ] No "Friend lookup failed" warnings
- [ ] All messages arrive (no loss)
- [ ] Sender attribution is correct for all messages
- [ ] Session IDs stable (not recreated unexpectedly)
- [ ] Divergence UI displays correctly
- [ ] Leave session works as expected

### Review Needed (Acceptable with Notes)
- [ ] 9-10 scenarios pass
- [ ] Warnings present but no data loss
- [ ] Unexpected log patterns but not breaking functionality

### Blocking Issues (Fail)
- [ ] Any console error (red ❌)
- [ ] Message loss (fewer messages than sent)
- [ ] Sender confusion (wrong name/UUID)
- [ ] Data corruption (invalid session states)
- [ ] Overlay crashes or becomes unresponsive

---

## Next Steps After Testing

1. **If all pass**: Create summary document and mark implementation complete
2. **If warnings**: Investigate and fix issues, re-test critical scenarios
3. **If blocking**: Debug root cause using console logs and code inspection
4. **Document findings**: Update CLAUDE.md with test results and any known issues
