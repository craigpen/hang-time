# PUBLISH LIFECYCLE TIMESTAMPS SPECIFICATION

**Component**: Message Publishing & Retry (Nostr)
**Status**: Specification (ready for implementation)
**Isolation Level**: Medium (3+ dependencies: publish-queue.ts, messaging.ts, storage.ts)

---

## SUMMARY
Three related timestamps tracking the lifecycle of a message from creation through delivery:
1. `sentAt` - when we first tried to send
2. `relay_accepted_at` - when relay confirmed receipt  
3. `friend_responded_at` - when friend's response was received (handshakes only)

**Consolidation opportunity**: These should be unified into a single `PublishMilestones` object for clarity.

---

## CURRENT STATE (Before Refactor)

These timestamps are scattered across two interfaces:

```typescript
// types.ts - PendingInvite
interface PendingInvite {
  sentAt: number;           // ← Line 199
  relay_accepted_at?: number;     // ← Line 200 (not implemented yet)
  friend_responded_at?: number;   // ← Line 201 (not implemented yet)
  // ... other fields
}

// types.ts - PendingMessage  
interface PendingMessage {
  sentAt: number;           // ← Line 214
  relay_accepted_at?: number;     // ← Line 215 (not implemented yet)
  friend_responded_at?: number;   // ← Line 216 (not implemented yet)
  // ... other fields
}
```

**Problems with current state:**
- Timestamps mixed with other fields
- No structure communicating they're a lifecycle
- Optional fields scattered throughout the interface
- Difficult to see the publish progress at a glance

---

## PROPOSED REFACTOR

**New structure:**
```typescript
interface PublishMilestones {
  sentAt: number;                    // Initial send attempt
  milestones: {
    relayAccepted?: number;          // Relay confirmed receipt
    friendResponded?: number;        // Friend's response received (handshakes only)
  };
}

// Updated PendingInvite
interface PendingInvite {
  milestones: PublishMilestones;     // ← All lifecycle here
  // ... other fields
}

// Updated PendingMessage
interface PendingMessage {
  milestones: PublishMilestones;     // ← All lifecycle here
  // ... other fields
}
```

**Benefits:**
- Clear linear progression
- All timestamps in one object
- Easier to reason about state
- Future-proof for more milestones

---

## COMPONENT 1: sentAt

### What It Represents
The precise moment when we first attempted to send a message (milliseconds since Unix epoch).

### Who Sets It
- **publish-queue.ts:72** - In `enqueueUserAction()` (for invites):
  ```typescript
  const pending: PendingPublish = {
    createdAt: Date.now(),  // ← Set here as createdAt
    // ... other fields
  };
  ```

### When It's Set
**On first send attempt** (before any retry):
- When invite is created
- When message is queued for sending
- Never changes after initial set

---

## COMPONENT 2: relay_accepted_at

### What It Represents
The precise moment when at least one relay confirmed receipt of our message (milliseconds since Unix epoch).

### Who Sets It
- **publish-queue.ts:287-297** - In `_publishCycle()`, when relay responds with OK:
  ```typescript
  if (results.overall_success) {
    pending.relay_accepted_at = Date.now();  // ← Set here
  }
  ```

### When It's Set
**On first relay acceptance** (when at least one relay says "OK"):
- Relay sends success response (NIP-01 OK event)
- We mark the message as relay-accepted
- Sent only once (first relay to accept wins)

### Current Status
**Not yet implemented** - infrastructure exists but logic not wired up

---

## COMPONENT 3: friend_responded_at

### What It Represents
The precise moment when the friend's response to a handshake message was received (milliseconds since Unix epoch).

### Who Sets It
- **messaging.ts** - When friend's response event is processed (NOT YET IMPLEMENTED):
  ```typescript
  // Pseudo-code - to be implemented
  if (event.type === 'join_accepted' || event.type === 'join_declined') {
    pending.friend_responded_at = Date.now();  // ← Would be set here
  }
  ```

### When It's Set
**On receiving friend's response** (handshake completion):
- Friend sends accept/decline response
- Marks handshake as complete
- Only for handshake messages (invites, friend requests)
- Not for fire-and-forget messages (chat, activity updates)

### Current Status
**Not yet implemented** - infrastructure exists but logic not wired up

---

## UNIFIED SPECIFICATION

### Format
**All milliseconds** (not Unix seconds)
- Type: `number`
- Range: 0 to `Number.MAX_SAFE_INTEGER`
- Example: `1722800000000`

### Immutability

| Timestamp | Immutable? | Why |
|-----------|-----------|-----|
| `sentAt` | Yes | Set once at creation, never changes |
| `relay_accepted_at` | Yes | Set once on first relay success, never changes |
| `friend_responded_at` | Yes | Set once on friend response, never changes |

### Timeline
```
sentAt  ← When we create & queue message
  ↓
  [Wait for relay response]
  ↓
relay_accepted_at  ← When at least one relay says OK (happens ~100ms later)
  ↓
  [Wait for friend to receive and respond]
  ↓
friend_responded_at  ← When friend sends response (minutes to hours later)
  ↓
Complete: Message fully acknowledged
```

---

## PRODUCERS

| Component | Function | File | Line | Timestamp | Trigger |
|-----------|----------|------|------|-----------|---------|
| Messaging | Send invite | messaging.ts | 80 | `sentAt` | User creates invite |
| Messaging | Send message | messaging.ts | 97 | `sentAt` | User sends chat message |
| Publishing | Process success | publish-queue.ts | 287 | `relay_accepted_at` | Relay sends OK response |
| Messaging | Receive response | messaging.ts | N/A | `friend_responded_at` | Friend sends response (NOT YET WIRED) |

---

## CONSUMERS

| Consumer | File | Purpose | How Used |
|----------|------|---------|----------|
| Retry logic | publish-queue.ts | Determine if expired | If `now - sentAt > 24h`, give up |
| Relay tracking | publish-queue.ts | Logging failure state | Report which relays accepted |
| Handshake completion | publish-queue.ts | Mark as complete | If `friend_responded_at` set, done |
| Storage cleanup | storage.ts | Expire old invites | Delete if older than 24 hours |

---

## VALIDATION RULES

### sentAt

✅ **Valid**:
- Positive number > 0
- Less than or equal to current time
- Greater than 2020-01-01

❌ **Invalid**:
- 0, negative, undefined, null
- In the future
- Before 2020-01-01

**Error handling**: Don't queue message, log error

### relay_accepted_at

✅ **Valid**:
- `undefined` (not yet accepted)
- Positive number > `sentAt`
- Less than or equal to current time

❌ **Invalid**:
- Before `sentAt`
- More than 10 minutes after `sentAt`
- More than current time (in future)

**Error handling**: Treat as not accepted, retry

### friend_responded_at

✅ **Valid**:
- `undefined` (friend hasn't responded yet)
- Positive number > `relay_accepted_at`
- Less than or equal to current time

❌ **Invalid**:
- Before `relay_accepted_at`
- More than 7 days after `sentAt`
- More than current time (in future)

**Error handling**: Treat as incomplete, retry

---

## MESSAGE LIFECYCLE EXAMPLES

### Example 1: Activity Invite (Handshake - Expects Response)
```
14:32:00.000 - User clicks "Join Activity"
14:32:00.500 - sentAt = 1722800000500
14:32:00.600 - Message queued, retry counter = 0
14:32:00.750 - Relay responds OK
14:32:00.752 - relay_accepted_at = 1722800000752
[Waiting for friend to receive and respond...]
14:35:30.000 - Friend sends join_accepted response
14:35:30.150 - friend_responded_at = 1722800000150
[Complete: handshake finished]
```

### Example 2: Chat Message (Fire & Forget - No Response Expected)
```
14:40:00.000 - User types message
14:40:00.200 - sentAt = 1722800200200
14:40:00.300 - Message queued, retry counter = 0
14:40:00.450 - Relay responds OK
14:40:00.452 - relay_accepted_at = 1722800200452
[No friend response expected for chat]
[Complete: message sent]
```

### Example 3: Retry After Relay Rejection
```
14:45:00.000 - sentAt = 1722800500000
14:45:00.200 - Relay responds: rate-limited (rejection)
14:45:00.300 - retry counter = 1, lastRetryAt = now + 1s backoff
14:45:01.300 - Retry attempt 1
14:45:01.450 - Relay responds OK
14:45:01.452 - relay_accepted_at = 1722800501452 (updated timestamp of successful relay acceptance)
[Continue waiting for friend response if handshake]
```

---

## IMPLEMENTATION CHECKLIST

### Migration Phase 1: Create PublishMilestones Type

**In types.ts:**
```typescript
interface PublishMilestones {
  sentAt: number;                    // When we first tried to send
  milestones: {
    relayAccepted?: number;          // When relay confirmed receipt
    friendResponded?: number;        // When friend's response received (handshakes only)
  };
}

// Update PendingInvite
interface PendingInvite {
  milestones: PublishMilestones;     // ← Add this
  // Keep existing fields for now (backward compat)
  sentAt?: number;                   // ← Mark as deprecated
}

// Update PendingMessage
interface PendingMessage {
  milestones: PublishMilestones;     // ← Add this
  // Keep existing fields for now (backward compat)
  sentAt?: number;                   // ← Mark as deprecated
}
```

### Migration Phase 2: Update Creation Points

**In messaging.ts (all send functions):**
```typescript
const pending: PendingInvite = {
  milestones: {
    sentAt: Date.now(),              // ← New structure
  },
  // ... other fields
};
console.debug(`[TimestampMigration:Publishing] SET sentAt=${pending.milestones.sentAt}`);
```

**In publish-queue.ts (relay success):**
```typescript
if (results.overall_success) {
  pending.milestones.milestones.relayAccepted = Date.now();  // ← Update
  console.debug(`[TimestampMigration:Publishing] SET relayAccepted=${pending.milestones.milestones.relayAccepted}`);
}
```

### Migration Phase 3: Implement Friend Response Tracking

**In messaging.ts (friend response handler):**
```typescript
if (event.type === 'join_accepted' || event.type === 'join_declined') {
  pending.milestones.milestones.friendResponded = Date.now();  // ← Implement this
  console.debug(`[TimestampMigration:Publishing] SET friendResponded=${pending.milestones.milestones.friendResponded}`);
}
```

### Add Logging

**At send (messaging.ts):**
```typescript
console.debug(`[TimestampMigration:Publishing] SET sentAt=${pending.milestones.sentAt} (message type=${type})`);
```

**At relay acceptance (publish-queue.ts):**
```typescript
console.debug(`[TimestampMigration:Publishing] SET relayAccepted=${pending.milestones.milestones.relayAccepted} (relay=${relayUrl})`);
```

**At friend response (messaging.ts):**
```typescript
console.debug(`[TimestampMigration:Publishing] SET friendResponded=${pending.milestones.milestones.friendResponded}`);
```

**At expiry check (storage.ts):**
```typescript
const age = Date.now() - invite.milestones.sentAt;
console.debug(`[TimestampMigration:Publishing] CHECK age=${age}ms (max=86400000ms)`);
if (age > 86400000) {
  console.debug(`[TimestampMigration:Publishing] ✅ PASS - Expired, removing invite`);
}
```

### After Implementation

- [ ] Rebuild and verify no compilation errors
- [ ] Create and send invite, filter `[TimestampMigration:Publishing`
- [ ] Verify:
  - `SET sentAt=` log appears
  - `SET relayAccepted=` appears ~100ms later
  - Friend receives and responds
  - `SET friendResponded=` appears (if wired up)
- [ ] Check old invites are cleaned up after 24 hours
- [ ] No ❌ FAIL logs in console
- [ ] Move to Component 5

---

## NOTES

### Why Consolidate?
Three timestamps represent one logical progression (send → relay → friend). Consolidating makes the progression obvious and prevents scattered state.

### Backward Compatibility
Keep old `sentAt` fields temporarily to avoid breaking existing code. Remove after Component 5 complete.

### Future Extensions
Could add more milestones:
```typescript
interface PublishMilestones {
  sentAt: number;
  milestones: {
    relayAccepted?: number;
    friendResponded?: number;
    friendSeen?: number;        // Future: when friend opened message
    friendReplied?: number;     // Future: when friend replied
  };
}
```

---

## RELATED TIMESTAMPS

| Related Timestamp | Relationship | Notes |
|---|---|---|
| Message.timestamp | Different purpose | Chat message creation time, not publish lifecycle |
| PublishMilestones | **This spec** | Message publish lifecycle ← You are here |

---

## MIGRATION STATUS
- **Phase**: 1 (Specification)
- **Status**: Complete
- **Next**: Implementation (migrate publish-queue.ts, messaging.ts, storage.ts)
