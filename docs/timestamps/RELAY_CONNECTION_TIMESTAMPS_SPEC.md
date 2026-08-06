# RELAY CONNECTION TIMESTAMPS SPECIFICATION

**Component**: Relay Connection Management (Nostr)
**Status**: Specification (ready for implementation)
**Isolation Level**: Very High (1 dependency: nostr.ts only)

---

## SUMMARY
Two related timestamps for monitoring relay connection health:
1. `lastHeartbeatTime` - tracks when relay last responded
2. `rateLimitedUntil` - tracks when rate-limit period expires

Both are internal to relay connection state, not transmitted or stored externally.

---

## COMPONENT 1: RelayConnection.lastHeartbeatTime

### What It Represents
The moment when the relay last sent a valid response to us (milliseconds since Unix epoch).

### Who Sets It
- **nostr.ts:49** - Initialized when RelayConnection created: `lastHeartbeatTime: number = Date.now()`
- **nostr.ts:579** - Reset when heartbeat starts: `this.lastHeartbeatTime = Date.now()`

### Who Updates It
- **nostr.ts:389** - In `_handleMessage()`, every time relay responds:
  ```typescript
  this.lastHeartbeatTime = Date.now();  // ← Updated here
  ```

### When It's Updated
Every time a message is received from relay (EOSE, OK, EVENT, etc.)

---

## COMPONENT 2: RelayConnection.rateLimitedUntil

### What It Represents
The moment when the relay's rate-limit period expires and we can resume publishing (milliseconds since Unix epoch).

### Who Sets It
- **nostr.ts:55** - Initialized: `rateLimitedUntil: number = 0` (not limited initially)

### Who Updates It
- **nostr.ts:421** - When relay sends "rate-limited" OK response:
  ```typescript
  // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 32s → 60s cap
  const backoffMs = Math.min(Math.pow(2, attempt) * 1000, 60000);
  this.rateLimitedUntil = Date.now() + backoffMs;  // ← Updated here
  ```

### When It's Updated
When relay explicitly tells us we're rate-limited via OK response with "rate-limited" message

---

## JOINT SPECIFICATION

| Property | lastHeartbeatTime | rateLimitedUntil |
|----------|---|---|
| **Format** | Milliseconds | Milliseconds |
| **Type** | `number` | `number` |
| **Initial Value** | `Date.now()` at connection | `0` (not limited) |
| **Updatable?** | Yes (frequently) | Yes (on rate-limit response) |
| **Update frequency** | Every relay message | Only on rate-limit |
| **Update trigger** | Any response from relay | "rate-limited" OK response |
| **Purpose** | Detect stale connections | Track rate-limit cooldown |

---

## CONSUMERS

### lastHeartbeatTime

| Consumer | File | Line | Purpose | Logic |
|----------|------|------|---------|-------|
| Heartbeat monitor | nostr.ts | 598 | Detect dead connections | If `(now - lastHeartbeatTime) > 50s`, reconnect |
| Debug logging | nostr.ts | N/A | Track connection health | Logged for diagnostics |

### rateLimitedUntil

| Consumer | File | Line | Purpose | Logic |
|----------|------|------|---------|-------|
| Publish gate | nostr.ts | 195 | Skip if rate-limited | `if (now < rateLimitedUntil) return` |
| Relay filter | nostr.ts | 721 | Filter relays before publish | Skip rate-limited relays from candidate list |

---

## VALIDATION RULES

### lastHeartbeatTime

✅ **Valid**:
- Positive number > 0
- Less than or equal to current time
- Greater than 2020-01-01 (sanity check)

❌ **Invalid**:
- 0 or negative
- In the future (more than current time)
- Before 2020-01-01

**Error handling**: Log warning, treat as stale connection

### rateLimitedUntil

✅ **Valid**:
- 0 (not rate-limited)
- Positive number (rate-limit expiry time)
- Less than 100 seconds in future (backoff cap is 60s)

❌ **Invalid**:
- Negative numbers
- More than 100 seconds in future (indicates backoff calculation error)

**Error handling**: Log error, reset to 0 (treat as not limited)

---

## OPERATION SEQUENCES

### Heartbeat Monitoring Sequence

```
Connection established
    ↓
lastHeartbeatTime = Date.now()
    ↓
[Every 50 seconds, check heartbeat]
    ↓
if (now - lastHeartbeatTime > 50s):
    → Connection appears stale
    → Close connection, reconnect
else:
    → OK, connection healthy
    ↓
[Any message from relay received]
    ↓
_handleMessage() called
    ↓
lastHeartbeatTime = Date.now()  ← Reset timer
    ↓
Continue monitoring
```

### Rate-Limit Sequence

```
Send message to relay
    ↓
Relay responds: "rate-limited"
    ↓
Calculate backoff: Math.min(Math.pow(2, attempt) * 1000, 60000)
    ↓
rateLimitedUntil = Date.now() + backoffMs
    ↓
[Next publish attempt]
    ↓
if (now < rateLimitedUntil):
    → Skip this relay (still rate-limited)
else:
    → rateLimitedUntil = 0 (reset)
    → Resume publishing to this relay
```

---

## DATA STRUCTURE

```typescript
// Current RelayConnection class has these as instance properties:
class RelayConnection {
  lastHeartbeatTime: number = Date.now();  // Set at init, updated on every message
  rateLimitedUntil: number = 0;             // 0 = not limited, else = expiry timestamp
  
  // ... other properties
}
```

No consolidation needed—these are already in the same object.

---

## IMPLEMENTATION CHECKLIST

### Add Logging (lastHeartbeatTime)

**At init (nostr.ts:49):**
```typescript
this.lastHeartbeatTime = Date.now();
console.debug(`[TimestampMigration:RelayConnection] SET lastHeartbeatTime=${this.lastHeartbeatTime} on init`);
```

**At heartbeat reset (nostr.ts:579):**
```typescript
this.lastHeartbeatTime = Date.now();
console.debug(`[TimestampMigration:RelayConnection] SET lastHeartbeatTime=${this.lastHeartbeatTime} heartbeat restart`);
```

**At message received (nostr.ts:389):**
```typescript
this.lastHeartbeatTime = Date.now();
console.debug(`[TimestampMigration:RelayConnection] CONSUME lastHeartbeatTime=${this.lastHeartbeatTime} (message received)`);
```

**At heartbeat check (nostr.ts:598):**
```typescript
const elapsed = now - this.lastHeartbeatTime;
console.debug(`[TimestampMigration:RelayConnection] CHECK lastHeartbeatTime - elapsed=${elapsed}ms (threshold=50000ms)`);
if (elapsed > 50000) {
  console.debug(`[TimestampMigration:RelayConnection] ⚠️ STALE - Reconnecting (no message for ${elapsed}ms)`);
}
```

### Add Logging (rateLimitedUntil)

**At rate-limit response (nostr.ts:421):**
```typescript
const backoffMs = Math.min(Math.pow(2, attempt) * 1000, 60000);
this.rateLimitedUntil = Date.now() + backoffMs;
console.debug(`[TimestampMigration:RelayConnection] SET rateLimitedUntil=${this.rateLimitedUntil} (backoff=${backoffMs}ms)`);
```

**At publish gate (nostr.ts:195):**
```typescript
if (now < this.rateLimitedUntil) {
  console.debug(`[TimestampMigration:RelayConnection] CONSUME rateLimitedUntil - still rate-limited for ${this.rateLimitedUntil - now}ms`);
  return; // Skip this relay
}
```

**At rate-limit expiry (nostr.ts:721):**
```typescript
if (now >= this.rateLimitedUntil && this.rateLimitedUntil > 0) {
  this.rateLimitedUntil = 0;
  console.debug(`[TimestampMigration:RelayConnection] ✅ PASS - Rate-limit expired, resuming publishes`);
}
```

### Validation (nostr.ts)

**At init:**
```typescript
if (!Number.isInteger(Date.now()) || Date.now() <= 0) {
  console.error(`[TimestampMigration:RelayConnection] ❌ FAIL - Invalid system timestamp`);
  throw new Error('System clock invalid');
}
```

**At rate-limit calculation:**
```typescript
const backoffMs = Math.min(Math.pow(2, attempt) * 1000, 60000);
const expiry = Date.now() + backoffMs;
if (expiry > Date.now() + 100000) {
  console.error(`[TimestampMigration:RelayConnection] ❌ FAIL - Rate-limit expiry too far in future: ${expiry - Date.now()}ms`);
  throw new Error('Backoff calculation error');
}
```

### After Implementation

- [ ] Rebuild and verify no compilation errors
- [ ] Open console and filter `[TimestampMigration:RelayConnection`
- [ ] Connect to relay and verify:
  - `SET lastHeartbeatTime=` logs appear
  - `CONSUME` logs appear on message receipt
  - `CHECK` logs appear during heartbeat monitor
  - No `⚠️ STALE` logs (connection healthy)
- [ ] Manually trigger rate-limit (if possible) and verify:
  - `SET rateLimitedUntil=` log appears
  - `CONSUME rateLimitedUntil - still rate-limited` logs appear
  - `✅ PASS - Rate-limit expired` appears after cooldown
- [ ] Verify relay reconnects if heartbeat goes stale (50+ seconds)
- [ ] No ❌ FAIL logs in console
- [ ] Move to Component 3

---

## NOTES

### Why Not Consolidate with Other Relay State?
These two timestamps are the only time-based state in RelayConnection. Other state (url, ws, status) is not time-based, so consolidation doesn't add clarity.

### Clock Skew Implications
If system clock jumps backwards:
- `lastHeartbeatTime` might be in the future
- `rateLimitedUntil` might expire unexpectedly early

**Mitigation**: Treat as stale if future (clock went backward), reconnect.

### Backoff Strategy
Current implementation uses exponential backoff capping at 60 seconds. This is appropriate for Nostr relays which typically rate-limit at:
- First attempt: 1s cooldown
- Second attempt: 2s
- Third attempt: 4s
- ... (doubling each time)
- Capped at 60s max

---

## MIGRATION STATUS
- **Phase**: 1 (Specification)
- **Status**: Complete
- **Next**: Implementation (migrate nostr.ts heartbeat and rate-limit logic)
