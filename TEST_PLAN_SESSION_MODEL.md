# Session Model Comprehensive Test Plan

## Overview
Validate all expected flows for the persistent session model with divergence support, as documented in SESSION_MODEL.md.

## Test Environment Setup
- **test2** and **test3**: Two separate Chrome browser instances
- **Fresh install**: Clear all storage before each test
- **Video source**: YouTube (consistent activity detection)
- **Console monitoring**: Check background service worker and content script logs

---

## Core Test Scenarios

### 1. FRESH INSTALL - No Overlay Until Co-Watchers
**Objective**: Verify overlay doesn't show until co-watch detected

**Steps**:
1. Fresh install, test2 opens YouTube video
2. Verify: Overlay DOM exists but hidden (not visible to user)
3. Verify: No fade-out or empty overlay shown
4. Verify: Console shows "no co-watch detected"

**Expected**: Overlay completely invisible, no UI artifacts

**Assertions**:
- [ ] Overlay div exists in DOM but display:hidden or opacity:0
- [ ] No console errors about missing session
- [ ] No CO_WATCH_UPDATE sent to content script

---

### 2. CO-WATCH DETECTION - Both On Same Video
**Objective**: Verify session creation when matching activity found

**Steps**:
1. test2 on YouTube video A
2. test3 opens same video A (detected via Nostr activity publish)
3. Wait 5 seconds for detection cycle
4. Verify: Overlay appears on both

**Expected**: Both overlays show with correct participant info

**Assertions**:
- [ ] test2 overlay shows: Host: You, Guest: test3
- [ ] test3 overlay shows: Host: test2, Guest: You
- [ ] Session created with both co_watchers
- [ ] CO_WATCH_UPDATE sent with watching_together: [test2_uuid, test3_uuid]
- [ ] Progress bar visible and updating

---

### 3. MESSAGE EXCHANGE - Bidirectional Via Nostr
**Objective**: Verify messages flow both directions with correct sender attribution

**Steps**:
1. Both on same video (from test 2)
2. test2 sends message "Hello from test2"
3. Wait 2-3 seconds for Nostr delivery
4. Verify: Message appears on test3's overlay with correct sender
5. test3 sends message "Hello from test3"
6. Wait 2-3 seconds
7. Verify: Message appears on test2's overlay with correct sender

**Expected**: Both see each other's messages with correct names

**Assertions**:
- [ ] test2 overlay shows: "1 from test2 (You)"
- [ ] test3 overlay shows: "1 from test2 (not You)"
- [ ] test3 overlay shows: "2 from test3 (You)"
- [ ] test2 overlay shows: "2 from test3 (not You)"
- [ ] Each message has correct pubkey in Nostr event p-tag
- [ ] No sender name misattribution (test2 showing as test3, etc.)

**Console Checks**:
- [ ] [MESSAGE_FLOW] Storing message with correct from UUID
- [ ] [MESSAGE_FLOW] Encrypted message for each recipient
- [ ] [MESSAGE_FLOW] Event queued with matching pubkey in p-tag
- [ ] No "Friend lookup failed" warnings

---

### 4. DIVERGENCE - One Person Switches Videos
**Objective**: Verify session persists and divergence display works

**Steps**:
1. Both on video A, send messages 3 & 4
2. test3 navigates to different video B (different YouTube video)
3. Wait 5 seconds for detection cycle
4. Verify: test2's overlay still shows, with divergence UI for test3
5. Verify: test3's overlay still shows, session active

**Expected**: Session persists, divergence shown visually

**Assertions**:
- [ ] test2 overlay shows test3 with: [test3 chip] [video B favicon] [video B title] [Join button]
- [ ] test3 overlay shows test2 still on video A
- [ ] Persistent session remains active (session_id unchanged)
- [ ] No "session ended" messages in console
- [ ] CO_WATCH_UPDATE still sent (or none if no activity match, but session intact)

---

### 5. MESSAGES DURING DIVERGENCE - Continue Flowing
**Objective**: Verify messages delivered even when diverged

**Steps**:
1. test2 and test3 diverged (from test 4)
2. test2 sends message "5 from test2"
3. Wait 2 seconds
4. Verify: Appears on test3's overlay
5. test3 sends message "6 from test3" (while on different video)
6. Wait 2 seconds
7. Verify: Appears on test2's overlay

**Expected**: Messages flow across activity boundaries

**Assertions**:
- [ ] Message 5 appears on test3 overlay with sender "test2 (not You)"
- [ ] Message 6 appears on test2 overlay with sender "test3 (not You)"
- [ ] No "No co-watch session" warnings in console
- [ ] getCurrentCoWatchSession() returns session (not null)
- [ ] Both UUIDs in co_watchers list remain unchanged

---

### 6. RE-CONVERGENCE - Back To Same Video
**Objective**: Verify session updates when co-watchers reunite on same activity

**Steps**:
1. test2 and test3 diverged (from test 5)
2. test3 navigates back to video A (same as test2)
3. Wait 5 seconds for detection cycle
4. Verify: test2's overlay no longer shows divergence for test3
5. Verify: No divergence chip with favicon/title

**Expected**: Divergence UI removed, showing as same video

**Assertions**:
- [ ] test2 overlay: Guest shows as plain chip (no favicon/title/join button)
- [ ] Persistent session still active (session_id unchanged)
- [ ] activity_id in session updated to video A's activity_id
- [ ] host_friend_uuid updated if host changed

---

### 7. PERSISTENT SESSION - Across Multiple Divergences
**Objective**: Verify session ID and co_watchers remain stable through multiple divergences

**Steps**:
1. test2 & test3 on video A (initial)
2. test3 → video B (diverge)
3. Send messages (test 5) 
4. test3 → video C (different divergence)
5. Send more messages
6. test3 → video A (re-converge)
7. Send final message

**Expected**: Same session throughout, all messages delivered

**Assertions**:
- [ ] session_id remains constant from start to end
- [ ] co_watchers list unchanged: [test2_uuid, test3_uuid]
- [ ] All 8+ messages eventually appear on both overlays
- [ ] No "session ended" or "session created" between steps

---

### 8. EXPLICIT LEAVE - User Clicks Leave Session
**Objective**: Verify only explicit leave action clears session

**Steps**:
1. test2 & test3 on video A
2. test2 clicks "Leave Session" button in overlay
3. Verify: test2's overlay closes/hides
4. Verify: test3's overlay shows empty/waiting (no co-watchers)
5. test2 navigates to video B
6. Wait 5 seconds
7. Verify: No session resumes (fresh start if test3 joins)

**Expected**: Leave is permanent for that session

**Assertions**:
- [ ] test2: SESSION_ENDED message received by content script
- [ ] test2: Overlay hides immediately
- [ ] test3: CO_WATCH_UPDATE with watching_together: [] received
- [ ] test3: Overlay hides (no co-watchers)
- [ ] storageManager.getActiveSession() returns null for both
- [ ] Next co-watch detection creates new session_id

---

### 9. EDGE CASE - Rapid Message Sending
**Objective**: Verify messages don't drop under load

**Steps**:
1. Both on same video
2. test2 sends 5 messages rapidly (no delay)
3. test3 sends 5 messages rapidly (overlapping)
4. Wait 5 seconds for all Nostr delivery
5. Count total messages on each overlay

**Expected**: All 10 messages delivered without loss

**Assertions**:
- [ ] test2 overlay shows all 10 messages
- [ ] test3 overlay shows all 10 messages
- [ ] No duplicate messages
- [ ] Correct sender attribution for all

---

### 10. EDGE CASE - Session Persistence After Tab Close/Reload
**Objective**: Verify session survives page navigation

**Steps**:
1. Both on video A
2. test2 navigates to different YouTube video (same tab)
3. Wait 2 seconds
4. test2 navigates back to video A
5. Verify: Overlay reappears, session still active

**Expected**: Session persists across tab navigation

**Assertions**:
- [ ] Session ID unchanged after navigation
- [ ] Overlay re-initializes with correct state
- [ ] No new CO_WATCH_UPDATE needed (session still there)
- [ ] Can continue messaging

---

## Validation Checklist

### Console Logs to Verify
- [ ] No "No co-watch session" warnings during messaging
- [ ] No "Friend lookup failed" warnings
- [ ] No "Failed to send message" errors
- [ ] Correct [MESSAGE_FLOW] logging for each send
- [ ] "getCurrentCoWatchSession() returned" shows session exists during messaging

### UI Validation
- [ ] No truncated UUIDs shown (no "wild-coa" style names)
- [ ] All names match expected (test2, test3)
- [ ] Divergence chip shows correct video favicon + title
- [ ] No empty overlays showing
- [ ] No unexpected fade-outs

### Data Validation  
- [ ] Messages stored in unified model with from/recipients
- [ ] Each Nostr event has correct p-tag for recipient
- [ ] No duplicate messages
- [ ] Message order preserved by timestamp
- [ ] session_id remains stable across operations

---

## Known Issues to Track

- [ ] Initial message sender attribution (historical messages may show wrong sender)
- [ ] Game discovery UI not yet implemented
- [ ] Firefox support planned post-MVP

---

## Pass/Fail Criteria

**PASS**: All 10 core scenarios + edge cases pass without workarounds
**FAIL**: Any scenario requires console error ignoring or has data loss
**REVIEW**: Edge cases pass but with unexpected warnings/logs

