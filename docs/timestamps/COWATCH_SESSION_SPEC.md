# COWATCHSESSION.DETECTED_AT SPECIFICATION

**Component**: Co-Watcher Detection
**Status**: Specification (ready for implementation)
**Isolation Level**: High (1 dependency: co-watcher-detection.ts only)

---

## SUMMARY
Timestamp marking when a co-watch session was detected (two or more friends watching same activity). Used to track session freshness and invalidate stale detections.

---

## DEFINITION

### Timestamp Name
`CoWatchSession.detected_at`

### What It Represents
The precise moment when the co-watcher detection algorithm successfully identified that two or more users (including current user) are watching the same activity (milliseconds since Unix epoch).

### Who Sets It
- **co-watcher-detection.ts:115** - In `detectCoWatchSession()` after finding co-watchers:
  ```typescript
  const session: CoWatchSession = {
    activity_id: matchedActivityId,
    host_friend_id: hostFriendId,
    co_watchers: otherCoWatchers,
    detected_at: Date.now(),  // ← Set here
  };
  ```

### When It's Set
**On successful co-watch detection** (once per detection cycle):
1. Algorithm compares user activities with all friend activities
2. Finds matching activity ID (same video/content)
3. Builds co-watcher list
4. Sets `detected_at = Date.now()`
5. Stores session in user profile

### Update Frequency
**On every detection cycle** (runs periodically as activities change):
- Detection runs whenever activities change (content script detects new video)
- If same activity ID still matches → new session with updated `detected_at`
- If no match → session cleared (set to null)

---

## SPECIFICATION

### Format
**Milliseconds** (not Unix seconds)
- Type: `number`
- Range: 0 to `Number.MAX_SAFE_INTEGER`
- Example: `1722800000000`

### Immutability
**Updatable**: Yes (refreshed on each detection cycle)
- Set to current time when co-watch is detected
- Updated every time detection runs and still finds co-watchers
- Cleared when co-watch session ends (no more matching activity)

### Timezone
**Absolute time** (not timezone-aware)
- Represents Unix epoch milliseconds
- No timezone information

---

## PRODUCERS

| Function | File | Line | Trigger | Notes |
|----------|------|------|---------|-------|
| `detectCoWatchSession()` | co-watcher-detection.ts | 115 | Co-watch detected | Set when 2+ users watching same activity |
| `setCurrentCoWatchSession()` | co-watcher-detection.ts | 134 | Store session | Persists session to profile |

**Set value**: `Date.now()` (current time when detection succeeds)

---

## CONSUMERS

| Consumer | File | Line | Purpose | How It's Used |
|----------|------|------|---------|---------------|
| Session freshness check | co-watcher-detection.ts | 157 | Validate session not stale | Check if detection is recent enough |
| Overlay refresh logic | background.ts | N/A | Decide when to update overlay | Only send CO_WATCH_UPDATE if session fresh |
| Session expiry (future) | N/A | N/A | Auto-clear old sessions | Could invalidate sessions older than 5 minutes |

---

## VALIDATION RULES

### Valid detected_at
✅ Positive number > 0
✅ Less than or equal to current time
✅ Not more than 5 minutes in the past (configurable freshness window)
✅ Greater than 2020-01-01 (sanity check)

### Invalid detected_at
❌ 0 or negative
❌ In the future (more than current time)
❌ Before 2020-01-01 (indicates system clock wrong)
❌ More than 5 minutes old (indicates stale session)

**Error handling**: If stale, invalidate session and start new detection

---

## DATA FLOW

```
User opens video
    ↓
ContentScript detects activity
    ↓
CoWatcherDetector.detectCoWatchSession() runs
    ↓
Compares user's activities with all friend activities
    ↓
Match found! (same activity ID)
    ↓
detected_at = Date.now()
    ↓
Session stored in UserProfile.current_co_watch_session
    ↓
Background broadcasts CO_WATCH_UPDATE to all content scripts
    ↓
Overlay renders with host info
    ↓
[Wait for activities to change]
    ↓
detectCoWatchSession() runs again
    ↓
Still same activity ID?
    → Update detected_at to new Date.now()
    → Session remains active
No match?
    → Clear session (set to null)
    → Overlay hides
```

---

## IMPLEMENTATION CHECKLIST

### Add Logging

**At detection success (co-watcher-detection.ts:115):**
```typescript
const session: CoWatchSession = {
  activity_id: matchedActivityId,
  host_friend_id: hostFriendId,
  co_watchers: otherCoWatchers,
  detected_at: Date.now(),
};
console.debug(`[TimestampMigration:CoWatcherDetection] SET detected_at=${session.detected_at} (activity=${matchedActivityId})`);
```

**At session storage (co-watcher-detection.ts:134):**
```typescript
await this.storage.updateUserProfile({
  ...profile,
  current_co_watch_session: session,
});
console.debug(`[TimestampMigration:CoWatcherDetection] STORE session.detected_at=${session.detected_at}`);
```

**At freshness check (co-watcher-detection.ts, new function):**
```typescript
async isSessionFresh(): Promise<boolean> {
  const session = await this.getCurrentCoWatchSession();
  if (!session) return false;
  
  const age = Date.now() - session.detected_at;
  const maxAge = 5 * 60 * 1000; // 5 minutes
  
  console.debug(`[TimestampMigration:CoWatcherDetection] CHECK session age=${age}ms (max=${maxAge}ms)`);
  
  if (age > maxAge) {
    console.debug(`[TimestampMigration:CoWatcherDetection] ⚠️ STALE - Session expired`);
    return false;
  }
  
  console.debug(`[TimestampMigration:CoWatcherDetection] ✅ FRESH - Session valid`);
  return true;
}
```

**At session refresh (co-watcher-detection.ts, in detectCoWatchSession):**
```typescript
const existingSession = await this.getCurrentCoWatchSession();
if (existingSession && existingSession.activity_id === matchedActivityId) {
  console.debug(`[TimestampMigration:CoWatcherDetection] REFRESH detected_at - same activity still active`);
} else {
  console.debug(`[TimestampMigration:CoWatcherDetection] NEW SESSION - different activity matched`);
}
```

**At session clear (co-watcher-detection.ts:134):**
```typescript
if (!session) {
  console.debug(`[TimestampMigration:CoWatcherDetection] CLEAR session.detected_at (no co-watchers found)`);
}
```

### Validation (co-watcher-detection.ts)

**At detection (detectCoWatchSession):**
```typescript
const now = Date.now();
if (now <= 0 || !Number.isInteger(now)) {
  console.error(`[TimestampMigration:CoWatcherDetection] ❌ FAIL - Invalid system timestamp: ${now}`);
  throw new Error('System clock invalid');
}
```

**At freshness check:**
```typescript
const age = Date.now() - session.detected_at;
if (age < 0) {
  console.error(`[TimestampMigration:CoWatcherDetection] ❌ FAIL - detected_at is in the future`);
  // Treat as stale, clear session
  await this.setCurrentCoWatchSession(null);
}
```

### After Implementation

- [ ] Rebuild and verify no compilation errors
- [ ] Open console and filter `[TimestampMigration:CoWatcherDetection`
- [ ] Open same video in two browser windows and verify:
  - `SET detected_at=` logs appear when co-watch detected
  - `STORE session.detected_at=` log appears
  - `✅ FRESH - Session valid` logs appear
  - Overlay appears on both sides
- [ ] Change video on one side and verify:
  - `CHECK session age=` logs appear
  - If still watching same activity: `REFRESH detected_at` log appears
  - If different activity: `CLEAR session.detected_at` log appears
- [ ] Wait 5+ minutes without activity change and verify:
  - `⚠️ STALE - Session expired` log appears
  - Session is invalidated
- [ ] No ❌ FAIL logs in console
- [ ] Move to Component 4

---

## NOTES

### Why 5-Minute Freshness Window?
- Activities are polled/published every 5-12 seconds
- If no activity received in 5 minutes, likely one user closed app/tab
- Conservative threshold ensures we don't show stale co-watch sessions

### Session vs Activity Timestamp
- **CoWatchSession.detected_at**: When we detected co-watchers (detection freshness)
- **Activity.timestamp**: When activity was detected locally (activity freshness)
- These are different: session freshness ≠ activity freshness

### Future Enhancement: Auto-Expiry
Currently, sessions only clear when activities change. Could add:
```typescript
// Auto-clear stale sessions every 5 minutes
setInterval(async () => {
  const session = await this.getCurrentCoWatchSession();
  if (session && !await this.isSessionFresh()) {
    await this.setCurrentCoWatchSession(null);
  }
}, 5 * 60 * 1000);
```

---

## RELATED TIMESTAMPS

| Related Timestamp | Relationship | Notes |
|---|---|---|
| Activity.timestamp | Different purpose | Activity detection time, not session detection time |
| CoWatchSession.detected_at | **This spec** | Session detection freshness ← You are here |

---

## MIGRATION STATUS
- **Phase**: 1 (Specification)
- **Status**: Complete
- **Next**: Implementation (migrate co-watcher-detection.ts)
