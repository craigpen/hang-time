# TIMESTAMP AUDIT SUMMARY & DECISION

**Date**: 2026-08-06
**Status**: Audit Complete, Full Refactor Tabled, Minimal Fix Identified
**Decision Maker**: Craig

---

## EXECUTIVE SUMMARY

Comprehensive timestamp audit identified 20 distinct timestamps across the system. Full refactor planned but deemed too large for current sprint. Root cause of host determination unreliability identified: using activity detection time instead of actual start-watching time. Minimal fix proposed: Add immutable `contentTimestamp` set by content script at first video detection.

---

## AUDIT COMPLETION STATUS

✅ **Phase 1 Complete**: Timestamp Specification
- 20 timestamps identified and catalogued
- All sources, modifications, and consumers mapped
- Consolidation opportunities identified
- Complete audit table created

📝 **Phase 2 Partial**: Component Specifications (4 of 5 written)
- Component 1: Message.timestamp ✅ 
- Component 2: RelayConnection timestamps ✅
- Component 3: CoWatchSession.detected_at ✅
- Component 4: PublishMilestones (proposed consolidation) ✅
- Component 5: Activity.timestamp (tabled - needs decision on approach)

---

## KEY FINDINGS FROM AUDIT

### Root Cause: Host Determination Unreliability

**The Problem**:
Location: `src/modules/co-watcher-detection.ts:102-106`
```typescript
coWatchers.sort((a, b) => a.timestamp - b.timestamp);
const hostEntry = coWatchers[0];  // Earliest timestamp = host
```

**Why It Fails**:
- `Activity.timestamp` represents **detection time** (when activity detector polled)
- Not **start-watching time** (when user actually opened the video)
- Activity detectors run on 500ms polling interval
- Two users watching same video often detected in same polling cycle → same timestamp
- Whoever's detector runs first becomes "host" (not who started watching first)

**Example Failure Scenario**:
```
10:00 - User A opens YouTube, starts watching video X
10:05 - User B opens YouTube, starts watching same video X
10:05:000ms - Both detectors run, both get timestamp = 10:05:000
10:05:001ms - A's detector completes first → A marked as host
10:05:002ms - B's detector completes → B marked as non-host
Result: A is "host" (correct), but only by milliseconds of detector timing
       If B's detector ran first, B would incorrectly be marked as host
```

### Timestamp Inconsistencies Identified

**Format Inconsistency** (14 timestamps use ms, 3 use Unix seconds):
- Milliseconds: Activity timestamps, Message timestamps, Friend timestamps, etc.
- Unix seconds: Nostr Event.created_at, Subscription.since, OAuthToken.expires_at
- **Risk**: Conversion errors, off-by-1000 bugs

**Consolidation Opportunities**:
1. Message lifecycle (sentAt, relay_accepted_at, friend_responded_at) → PublishMilestones object
2. Relay state (lastHeartbeatTime, rateLimitedUntil) → RelayState object
3. Activity timestamps (timestamp, freshness_timestamp) - clarification needed

**Scattered Ownership**:
- 20 timestamps across 10+ modules
- No central coordination
- Each module manages its own timestamps

---

## DECISION: TABLE FULL REFACTOR

### Why Not Doing It Now

**Scope**: 5 components, 6+ dependencies, estimated 2-3 weeks of implementation
- Component 1-3: Documentation + logging (low risk)
- Component 4: Interface restructuring (medium risk, affects 3+ files)
- Component 5: Activity.timestamp redesign (high risk, affects 6+ files + host determination)

**Current Priority**: Host determination fix (overlay progress bar working correctly)
- Full refactor is nice-to-have, not blocking
- Minimal fix solves the actual problem
- Can revisit full refactor in future sprint

**Risk Assessment**:
- Full refactor: High risk of breaking something in 6+ interconnected areas
- Minimal fix: Low risk, isolated to host determination logic + content script

### What We're Keeping

**Component Specifications (Created, Not Implemented)**:
- Component 1: Message.timestamp spec (documented current behavior)
- Component 2: RelayConnection timestamps spec (documented current behavior)
- Component 3: CoWatchSession.detected_at spec (documented current behavior)
- Component 4: PublishMilestones spec (proposed consolidation, not implemented)
- Component 5: Activity.timestamp spec (not written, tabled)

These live in `docs/timestamps/` for future reference and can be implemented incrementally in future sprints.

---

## ROOT CAUSE ANALYSIS: HOST DETERMINATION

### What We're Using Now (Broken)

```typescript
// co-watcher-detection.ts
coWatchers = [
  { friend_id: null, timestamp: userActivity.timestamp },  // Detection time
  { friend_id: friendA, timestamp: friendAActivity.timestamp },  // Detection time
]
coWatchers.sort((a, b) => a.timestamp - b.timestamp);  // Sort by detection time
const host = coWatchers[0];  // Earliest detector run = host (WRONG)
```

**Why it's broken**:
- Uses detection time as proxy for start time
- No correlation between the two
- Unreliable for determining who started watching

### What We Need (Fixed)

```typescript
// Proposed: Use content-script-captured timestamp for host determination
coWatchers = [
  { friend_id: null, timestamp: userActivity.contentTimestamp },  // Start time (when user opened video)
  { friend_id: friendA, timestamp: friendAActivity.contentTimestamp },  // Start time
]
coWatchers.sort((a, b) => a.timestamp - b.timestamp);  // Sort by actual start time
const host = coWatchers[0];  // User who actually opened video first (CORRECT)
```

**Why it works**:
- contentTimestamp set by content script when first detecting video on page
- Immutable—never changes
- Represents actual start-watching moment
- Reliable for determining actual host

---

## MINIMAL FIX: ADD contentTimestamp

### What to Implement

**1. Content Script Enhancement** (entrypoints/content-script.ts)
- When first detecting a new video (YouTube, Netflix, Twitch)
- Set `contentTimestamp = Date.now()` 
- Include in activity object sent to background
- Example:
  ```typescript
  // First time detecting this video
  const activity = {
    service: 'youtube-tab',
    id: videoId,
    contentTimestamp: Date.now(),  // ← NEW: When user actually opened this video
    timestamp: Date.now(),  // ← KEEP: For backward compatibility
    // ... other fields
  };
  ```

**2. Activity Datastore** (src/modules/activity-datastore.ts)
- Accept and store `contentTimestamp` field
- Preserve it through all state transitions
- Never overwrite it

**3. Activity Storage** (src/modules/storage.ts)
- Include `contentTimestamp` in Activity type
- Store and retrieve it
- Make it immutable in profile updates

**4. Co-Watcher Detection** (src/modules/co-watcher-detection.ts)
- Compare `contentTimestamp` instead of `timestamp` for host determination
- Fallback to `timestamp` if `contentTimestamp` missing (backward compat)
- Log which timestamp was used for debugging

**5. Logging** (all components)
- Add `[TimestampMigration:ContentTimestamp]` logs
- Verify contentTimestamp flows through pipeline
- Verify used for host determination

---

## MINIMAL FIX: IMPLEMENTATION PLAN

### Scope
- **Files to modify**: 4-5 (content-script, activity-datastore, storage, co-watcher-detection)
- **Risk level**: Low (additive change, backward compatible)
- **Estimated effort**: 2-3 days
- **Testing**: Manual overlay testing with two browsers

### Steps
1. Add `contentTimestamp` field to Activity type (types.ts)
2. Modify content script to capture and include contentTimestamp
3. Update activity datastore to preserve contentTimestamp
4. Update storage to handle contentTimestamp
5. Update co-watcher detection to use contentTimestamp for host determination
6. Add logging at each step
7. Test with two browsers watching same video
8. Verify host determination is now reliable

### Backward Compatibility
- If `contentTimestamp` missing (old activities), use `timestamp` as fallback
- Newly detected activities will always have `contentTimestamp`
- No breaking changes

---

## TIMESTAMP AUDIT ARTIFACTS

All audit artifacts created and stored in `docs/timestamps/`:

1. **TIMESTAMP_REFACTOR_PLAN.md** - Full 5-component refactor plan (reference for future)
2. **MESSAGE_TIMESTAMP_SPEC.md** - Component 1 spec (documented, not implemented)
3. **RELAY_CONNECTION_TIMESTAMPS_SPEC.md** - Component 2 spec (documented, not implemented)
4. **COWATCH_SESSION_SPEC.md** - Component 3 spec (documented, not implemented)
5. **PUBLISH_LIFECYCLE_SPEC.md** - Component 4 spec (consolidation proposal, not implemented)
6. **TIMESTAMP_AUDIT_SUMMARY.md** - This document

### Audit Table (20 Timestamps)
Available in earlier conversation or can be regenerated from audit agent output.

---

## WHAT'S NEXT

### Immediate (Minimal Fix)
1. ✅ Audit complete and documented
2. → Implement contentTimestamp addition (2-3 days)
3. → Test with overlay (host determination verification)
4. → Verify overlay progress bar works correctly

### Future (When Time Permits)
- Phase 2: Implement Component 1-3 logging improvements (low risk, high clarity)
- Phase 3: Implement Component 4 consolidation (medium risk, nice-to-have)
- Phase 4: Revisit Activity.timestamp component (high risk, can wait)

---

## APPROVAL & SIGN-OFF

**Audit Status**: ✅ Complete
**Root Cause Identified**: ✅ Yes (detection time vs start time)
**Minimal Fix Proposed**: ✅ Yes (contentTimestamp from content script)
**Full Refactor Decision**: ✅ Tabled (too large, not blocking)
**Next Step**: Implement minimal fix for host determination

---

**Decision Date**: 2026-08-06
**Decision Maker**: Craig
**Status**: Ready for implementation
