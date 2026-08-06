# MESSAGE.TIMESTAMP SPECIFICATION

**Component**: Messaging System
**Status**: Specification (ready for implementation)
**Isolation Level**: High (2 dependencies only)

---

## SUMMARY
Immutable timestamp marking when a message was created by the sender. Used exclusively for message ordering in chat display and storage.

---

## DEFINITION

### Timestamp Name
`Message.timestamp`

### What It Represents
The precise moment when a chat message was created on the sender's device (milliseconds since Unix epoch).

### Who Sets It
- **messaging.ts** `sendChatMessage()` - when user types and sends message
- **messaging.ts** `sendInvite()` - when activity invite is sent
- **messaging.ts** `sendJoinAccepted()` - when join acceptance is sent
- **messaging.ts** `sendJoinDeclined()` - when join decline is sent
- **messaging.ts** `sendFriendRequestMessage()` - when friend request is sent

### When It's Set
**On message creation** (before any transmission or storage):
```typescript
// In messaging.ts, all send functions:
const message: ActivityMessage = {
  type: 'chat',
  content,
  timestamp: Date.now(),  // ← Set here, never changed
  ...otherFields
};
```

---

## SPECIFICATION

### Format
**Milliseconds** (not Unix seconds)
- Type: `number`
- Range: 0 to `Number.MAX_SAFE_INTEGER` (JavaScript limit)
- Example: `1722800000000` (2026-08-05 at some time)

### Immutability
**Immutable**: Yes, once set it never changes
- Set once at message creation
- Transmitted to friend via Nostr as-is
- Stored as-is in storage
- No modifications in transit or storage

### Timezone
**Absolute time** (not timezone-aware)
- Represents Unix epoch milliseconds
- No timezone information embedded
- Both sender and receiver see same numeric value

---

## PRODUCERS (Where It's Set)

| Function | File | Line | Message Type | Notes |
|----------|------|------|---|---|
| `sendChatMessage()` | messaging.ts | 97 | chat | User-sent text messages |
| `sendInvite()` | messaging.ts | 80 | activity_invite | Invitation to join activity |
| `sendJoinAccepted()` | messaging.ts | 114 | join_accepted | Acceptance response |
| `sendJoinDeclined()` | messaging.ts | 131 | join_declined | Decline response |
| `sendFriendRequestMessage()` | messaging.ts | 163 | friend_request | Friend request sent |

**Set value**: `Date.now()` (current time in milliseconds)

---

## CONSUMERS (Where It's Read)

| Consumer | File | Line | Purpose | How It's Used |
|----------|------|------|---------|---------------|
| Message storage | messaging.ts | 265, 343 | Preserve timestamp in storage | Passed through as-is |
| Message sorting | storage.ts | 429, 455 | Sort messages chronologically | `messages.sort((a, b) => a.timestamp - b.timestamp)` |
| Overlay display | overlay-ui.ts | 18 | Display in message list | Shown with message (optional visual formatting) |

---

## VALIDATION RULES

### Valid Message.timestamp
✅ Positive number (> 0)
✅ Less than current time + 5 seconds (clock skew tolerance)
✅ Greater than 2020-01-01 (sanity check)

### Invalid Message.timestamp
❌ 0 or negative
❌ undefined or null (must always be set)
❌ More than 5 seconds in future (indicates local clock wrong)
❌ Before 2020-01-01 (indicates local clock very wrong)

### Error Handling
If timestamp is invalid:
- **Log error**: `[TimestampMigration:Messaging] ❌ FAIL - Invalid message timestamp ${ts}`
- **Action**: Don't send message, prompt user to check system time
- **Don't fallback**: Never use current time as replacement

---

## DATA FLOW

```
User sends message
    ↓
sendChatMessage() creates message with timestamp: Date.now()
    ↓
Encrypt and publish to Nostr (timestamp included in payload)
    ↓
Friend receives Nostr event, parses message
    ↓
receiveMessage() stores message with timestamp as-is
    ↓
Storage.getActivityMessages() sorts by timestamp
    ↓
Overlay renders messages in chronological order
```

---

## IMPLEMENTATION CHECKLIST

### Add Logging (at boundaries)

**When setting (in messaging.ts send functions):**
```typescript
const message: ActivityMessage = {
  type: 'chat',
  content,
  timestamp: Date.now(),
};
console.debug(`[TimestampMigration:Messaging] SET message.timestamp=${message.timestamp} for ${type}`);
```

**When receiving (messaging.ts receiveMessage):**
```typescript
console.debug(`[TimestampMigration:Messaging] RECEIVED message.timestamp=${message.timestamp} from friend ${friendId}`);
```

**When sorting (storage.ts getActivityMessages):**
```typescript
messages.sort((a, b) => {
  console.debug(`[TimestampMigration:Messaging] CONSUME ts1=${a.timestamp} ts2=${b.timestamp}`);
  return a.timestamp - b.timestamp;
});
console.debug(`[TimestampMigration:Messaging] ✅ PASS - Sorted ${messages.length} messages by timestamp`);
```

### Validation (messaging.ts send functions)

Add before creating message:
```typescript
const now = Date.now();
if (!Number.isInteger(now) || now <= 0) {
  console.error(`[TimestampMigration:Messaging] ❌ FAIL - System timestamp invalid: ${now}`);
  throw new Error('System clock appears wrong, cannot send message');
}
```

### After Implementation

- [ ] Rebuild and verify no compilation errors
- [ ] Open console and filter `[TimestampMigration:Messaging`
- [ ] Send a test message and verify:
  - `SET message.timestamp=` logs appear
  - `RECEIVED message.timestamp=` logs appear when friend receives
  - `CONSUME` logs appear when sorting
  - `✅ PASS` checkpoint appears after sorting
- [ ] Verify messages display in correct chronological order
- [ ] Move to next component

---

## NOTES

### Why Not Store Server Time?
Messages are encrypted end-to-end; receiver never sees server time. Each device uses its own local clock.

### Clock Skew
If two devices have clocks that differ by 10 seconds, messages from one may sort "before" messages from the other even if sent later. This is acceptable for MVP—eventual consistency as devices sync.

### Future Enhancement
If clock skew becomes a problem, could:
1. Add server timestamp to Nostr event metadata (read-only)
2. Use Nostr event's `created_at` as secondary sort key
3. Implement time-sync protocol between friends

But for now: client-side timestamps only, sort by that.

---

## RELATED TIMESTAMPS

| Related Timestamp | Relationship | Notes |
|---|---|---|
| Activity.timestamp | Different purpose | Activity detection time, not message time |
| Nostr Event.created_at | Different purpose | Event publish time on relay, not message creation time |
| Message.timestamp | **This spec** | Chat message creation time ← You are here |

---

## MIGRATION STATUS
- **Phase**: 1 (Specification)
- **Status**: Complete
- **Next**: Implementation (migrate messaging.ts, storage.ts, overlay-ui.ts)
