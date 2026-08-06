# TIMESTAMP REFACTOR PLAN

**Status**: Planning Phase
**Goal**: Establish reliable, well-documented timestamp system for co-watcher host determination and overlay progress sync
**Approach**: Full refactor with incremental component migration + comprehensive logging

---

## PHASE 1: FINALIZE TIMESTAMP SPECIFICATION
**Status**: In Progress

### Decisions Made

#### Decision 1: Scope & Approach
- **Choice**: Full refactor (not narrow fix)
- **Rationale**: Host determination is architecturally broken; fixing it requires understanding all timestamps. One-time investment pays dividends.
- **Timeline**: Weeks (vs days for narrow fix)
- **Risk Level**: Medium (touches many components)

#### Decision 2: Migration Strategy
- **Choice**: Incremental, one component at a time (fewest dependencies first)
- **No parallel/dual-write**: Immediate breakage detection preferred in single-dev environment
- **Logging**: CONSUME logs everywhere + SET logs at boundary crossings
- **Filter**: `[TimestampMigration:*]` for console validation

#### Decision 3: Timestamp Consolidation
- **OAuth timestamps**: PRESERVE (distinct values, not being tested, leave as-is)
- **Activity timestamps**: TBD (Activity.timestamp vs Activity.freshness_timestamp - need clarification on usage)
- **Publish state**: Consolidate PendingInvite.sentAt + relay_accepted_at + friend_responded_at into PublishMilestones object
- **Relay state**: Consolidate RelayConnection.lastHeartbeatTime + rateLimitedUntil into RelayState object
- **Format**: Standardize all to milliseconds (convert to Unix seconds only at Nostr boundary)

#### Decision 4: Migration Order
Components in order of fewest dependencies (most to least isolated):
1. **Message.timestamp** (2 dependencies: messaging, storage) ← STARTING HERE
2. RelayConnection timestamps (1 dependency: nostr)
3. CoWatchSession.detected_at (1 dependency: co-watcher-detection)
4. PendingInvite/Message lifecycle (3+ dependencies: publish-queue, messaging, storage)
5. Activity.timestamp (6+ dependencies: detection, storage, publishing, co-watcher, datastore)

---

## PHASE 2: COMPONENT-BY-COMPONENT MIGRATION

### Component 1: Message.timestamp
**Status**: Not started
**Scope**: Messaging system only
**Dependencies**: messaging.ts, storage.ts, overlay-ui.ts
**Plan**:
- [ ] Finalize spec for Message.timestamp (purpose, format, immutability)
- [ ] Update messaging.ts to add [TimestampMigration:Messaging] logs
- [ ] Verify logs show correct timestamp flow
- [ ] Test chat message ordering works correctly
- [ ] Move to next component

### Component 2: RelayConnection timestamps
**Status**: Not started
**Plan**: TBD after Component 1

### Component 3-5: TBD
**Status**: Not started
**Plan**: TBD after Component 1-2

---

## CRITICAL FINDINGS (From Audit)

### Issue: Host Determination is Unreliable
**Location**: `co-watcher-detection.ts:102-106`
**Problem**: Uses `Activity.timestamp` (detection time, not start-watching time)
- Detection time ≠ actual start time
- No way to know who started watching first
- Two users with same detection time → flaky host determination

**Example failure scenario:**
- User A opened YouTube at 10:00, went AFK
- User B opened YouTube at 10:05
- Both detectors run at 10:05 → same Activity.timestamp
- Whoever's detector runs first becomes "host" (wrong)

**Will be addressed in**: Activity.timestamp component (Component 5)

### Issue: Format Inconsistency
**Problem**: 20 timestamps use inconsistent formats
- 14 timestamps: milliseconds
- 3 timestamps: Unix seconds (Nostr Event.created_at, Subscription.since, OAuthToken.expires_at)

**Solution**: Standardize all to milliseconds internally, convert to Unix seconds only at Nostr boundaries

---

## AUDIT REFERENCE

Complete audit with all 20 timestamps: See inline table in conversation
- Full timestamp dependency map
- Sources and consumers identified
- Consolidation opportunities documented

---

## LOGGING STRATEGY

### Log Format
```
[TimestampMigration:ComponentName] <operation> - <details>
```

### Log Types
- **CONSUME/READ**: "Component reads timestamp successfully"
  ```typescript
  console.debug(`[TimestampMigration:CoWatcherDetection] READ user_contentTimestamp=${timestamp} ✅`);
  ```

- **SET at boundaries**: "Timestamp enters new system"
  ```typescript
  console.debug(`[TimestampMigration:Publishing] SET contentTimestamp=${ts} -> NOSTR_BOUNDARY`);
  ```

- **COMPARE/VALIDATE**: When timestamps are compared or validated
  ```typescript
  console.debug(`[TimestampMigration:CoWatcherDetection] COMPARE user=${ts1} vs friend=${ts2} -> host=${hostId}`);
  ```

- **PASS/FAIL**: Checkpoint validation
  ```typescript
  console.debug(`[TimestampMigration:Messaging] ✅ PASS - Sorted ${count} messages by timestamp`);
  console.debug(`[TimestampMigration:Messaging] ❌ FAIL - Missing timestamp on message ${id}`);
  ```

### Validation Checklist After Each Component
1. Rebuild (`npm run build`)
2. Open console, filter: `[TimestampMigration:ComponentName`
3. Verify:
   - ✅ All READ operations find timestamps
   - ✅ No ❌ FAIL logs
   - ✅ ✅ PASS checkpoints appear
4. Test actual feature (e.g., chat ordering, relay health)
5. Proceed to next component if clean

---

## NEXT STEPS
1. ✅ Audit complete (20 timestamps identified)
2. ✅ Consolidation opportunities mapped
3. ✅ Migration order determined
4. → Start Component 1: Message.timestamp specification
