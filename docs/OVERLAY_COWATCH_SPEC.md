# Overlay Co-Watch Display Specification

**Status**: Living Reference Document  
**Last Updated**: 2026-08-06

## Core Principle

**The overlay displays who is co-watching the same activity with the user, with the host's progress bar shown to all participants.**

All logic is deterministic: every participant (host and co-watchers) should arrive at the same host determination and display.

---

## Data Sources (Already Implemented)

- **My activities**: `StorageManager.getMyActivities()` → `myActivities[activity_id]`
- **Friend activities**: `friend.current_activities[activity_id]`
- **Progress**: `activity.metadata.progress` (in seconds, accurate)
- **Start time**: `activity.contentTimestamp` (immutable, set by content script at first detection)

All data flows through StorageManager (primary in-memory storage).

---

## Overlay Logic (Sequential Steps)

### 1. Detect Co-Watch Session
```
For each of my activities:
  For each friend:
    If friend.current_activities[my_activity_id] exists:
      → Match found! This is a co-watch session
```

**Implementation**: `CoWatcherDetector.detectCoWatchSession()` (already exists)

### 2. Determine Host (Deterministic)
```
Collect all watchers watching this activity_id:
  - Me (myActivities[activity_id])
  - Each friend (friend.current_activities[activity_id])

Sort by contentTimestamp ascending (earliest = host)
→ All participants see same host because contentTimestamps are identical across Nostr
```

**Implementation**: Sort by `contentTimestamp`, take first entry as host

### 3. Build Watcher List
```
Host: Get host's local_name (or user's nickname if I'm host)
Co-watchers: Get all other watchers' local_names
Format: "<host_name> (host), <friend1>, <friend2>, ..."
```

**Implementation**: Iterate co_watchers, lookup names, format display

### 4. Calculate Host's Progress Bar
```
If I'm the host:
  hostProgress = myActivities[activity_id].metadata.progress
  hostContentTimestamp = myActivities[activity_id].contentTimestamp

If friend is the host:
  hostProgress = friend.current_activities[activity_id].metadata.progress
  hostContentTimestamp = friend.current_activities[activity_id].contentTimestamp

elapsedSeconds = (now - hostContentTimestamp) / 1000
hostCurrentPosition = hostProgress + elapsedSeconds
progressPercent = (hostCurrentPosition / max_duration) * 100
→ Display this to ALL participants
```

**Implementation**: All overlays show host's calculated position, not their own

---

## Key Architectural Constraints

1. **Single source of truth**: StorageManager primary storage (in-memory)
   - No secondary storage reads for live data
   - No sessionStorage, localStorage, or direct chrome.storage
   - Background stores, content script queries via port messages

2. **Immutable contentTimestamp**
   - Set once by content script when first detecting video
   - Persisted through StorageManager
   - Never overwritten, reused on page reload
   - Published to friends via Nostr
   - Used for deterministic host calculation

3. **Deterministic host determination**
   - Same contentTimestamp values everywhere (via Nostr)
   - Same sort logic everywhere (earliest wins)
   - All participants arrive at identical host ID

4. **Consistent progress display**
   - Every overlay shows host's progress (not own progress)
   - Same progress value for all watchers (host publishes it)
   - Calculation: progress + elapsed time since contentTimestamp

---

## Implementation Checklist

- [ ] **co-watcher-detection.ts**: Detect co-watch, determine host by contentTimestamp, return co-watchers list
- [ ] **background.ts**: Fetch host activity (from myActivities if self, from friend.current_activities if friend), extract progress + contentTimestamp
- [ ] **overlay-ui.ts**: Display "<host> (host), <friends>" with host highlighted; show host's progress bar to all
- [ ] **Logging**: Add [OverlayDebug] tags to trace data flow and verify host determination

---

## Do NOT

- ❌ Use profile.current_activity for host activity lookup (wrong data)
- ❌ Look up activity twice or in different places (use same source)
- ❌ Create new timestamps (contentTimestamp is immutable)
- ❌ Show each person's own progress (always show host's)
- ❌ Use timestamps other than contentTimestamp for host sort
- ❌ Bypass StorageManager with direct storage calls
