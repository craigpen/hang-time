# Session Model - Co-Watch Architecture

**Status**: Design Complete (2026-08-09)

## Overview

A **session** is a user-controlled co-watch group. Sessions are independent of activity_id, allowing friends to navigate between videos while remaining connected.

**Key principle:** Users control when they join/leave. The session persists through divergence. Messages flow independently via P2P encryption.

## Data Model

### Session (Persistent Local Storage)

```typescript
interface CoWatchSession {
  session_id: string;           // UUID v4
  co_watchers: string[];        // Friend UUIDs (includes self)
  created_at: number;           // Unix ms
  is_active: boolean;           // User hasn't explicitly left
}

// Storage location: chrome.storage.local.active_session (null if none)
```

### Message (Persistent Local Storage)

```typescript
interface Message {
  id: string;                   // UUID for deduplication
  from: string;                 // Sender UUID
  recipients: string[];         // [B], [C], or [B, C] etc
  content: string;
  timestamp: number;            // Unix ms
  is_outbound?: boolean;        // true if I sent it
}

// Storage location: chrome.storage.local.messages
// Single array, all messages ever exchanged
```

### Activity (Nostr, Real-Time)

```typescript
// Detected by content script, published to Nostr
{
  id: string;                   // activity_id
  service: string;              // youtube, netflix, etc
  url: string;
  content: string;              // Video title
  contentTimestamp: number;     // When THIS video started (immutable, for host determination)
  metadata: {
    progress: number;           // Seconds into video
    progress_measured_at: number; // Unix ms when progress was measured (for sync interpolation)
    duration: number;
    state: 'playing' | 'paused';
  }
  timestamp: number;            // When activity record created
  freshness_timestamp: number;  // When data was last refreshed
}
```

## Session Lifecycle

### 1. Session Creation (Activity Detection)

**Trigger:** User A's activity_id matches Friend B's activity_id on Nostr.

```
Background (CoWatcherDetector):
1. Detect A and B both watching youtube/abc
2. Create session_id = UUID()
3. Store: active_session = {
     session_id,
     co_watchers: [B],           // B's UUID
     created_at: Date.now(),
     is_active: true
   }
4. Notify content script: "Overlay, open up!"

Content Script:
1. Create OverlayUI
2. Send GET_OVERLAY_STATE to background
3. Receive state with co_watchers, messages, host determination
4. Render overlay with Host (green) | Guest chips
```

### 2. Active Session (Normal Co-Watching)

**State:** `is_active: true`, co_watchers on same activity_id.

```
Overlay displays:
- Host: Friend with oldest contentTimestamp
- Guest: Other co_watchers
- Sync button (works if user is guest)
- Progress bars, state indicators
- Chat input (sends to all co_watchers)
- Manual "Leave Session" button

Background:
- Publishes user's activity every 12 seconds
- Detects friend activity changes via Nostr
- Updates co_watcher state
- Routes messages to/from Nostr kind-1059
```

### 3. Divergence (Searching for Next Video)

**Trigger:** One or more co_watchers navigate to different activity_id.

```
Example: A on youtube/X, B navigates to netflix/Y

A's overlay updates:
- (No host label - no one else on youtube/X)
- Guest: B | [Netflix favicon] Show Title | [Join]
- Chat history: still visible (all A-B messages)
- B can still send messages (will queue until A reads)

B's overlay updates:
- Host: B (only watcher on netflix/Y)
- Guest: A | [YouTube favicon] Video Title | [Join]
- Chat history: still visible

Session persists: is_active = true, co_watchers = [B]
Neither person has left, just looking for next thing to watch together.
```

### 4. Rejoining (Clicking Join)

**Trigger:** Co-watcher clicks join button on another's video chip.

```
B clicks join on A's [YouTube] chip

Background:
1. B's activity publishes: youtube/X
2. B's contentTimestamp = Date.now()
3. A's contentTimestamp = (earlier, when A started)

Overlay updates (for both):
- Host: A (older contentTimestamp on youtube/X)
- Guest: B
- Sync button active
- Progress bars sync'd
```

### 5. One Person Leaves Session

**Trigger:** Co-watcher closes overlay OR explicitly clicks "Leave Session".

```
Scenario A: Last co-watcher joins different activity permanently
  - A and B on netflix/Y
  - B navigates to twitch/Z and stays there
  - A's overlay: shows B [Twitch Z] | Join
  - Session: still active (A hasn't closed overlay)
  - A can click Join to follow, or wait

Scenario B: Only co-watcher closes overlay
  - A and B on netflix/Y
  - B closes overlay (just the UI)
  - B's activity: still netflix/Y (video still playing)
  - A's overlay: still shows B as co-watcher on netflix/Y
  - Session: still active
  - If B navigates: A's overlay updates

Scenario C: Explicit "Leave Session" button
  - A and B on netflix/Y
  - B clicks "Leave Session"
  - B's session_id cleared (is_active = false)
  - B's overlay closes
  - A's overlay: co-watchers empty, message: "Waiting for co-watchers"
  - Session: now has only A, but A's overlay stays open
```

### 6. Last Person in Session

**State:** Only one person left, no co_watchers.

```
Overlay behavior:
- Host/Guest labels: removed
- Co-watcher chips: empty
- Message: "Waiting for co-watchers..." (optional)
- Chat history: still visible
- Manual close button: available
- Can still type messages (queue to friends)

If someone rejoins:
- Their activity matches (e.g., same netflix/Y)
- Overlay updates: they reappear as co-watcher
- Session continues seamlessly

If user manually closes:
- session_id cleared
- active_session = null
- Overlay unmounts
```

## Message Model (Independent of Session)

### Message Storage

```typescript
// One global message array
chrome.storage.local.messages: Message[]

// Each message knows who it's from and who it's for
{
  id: 'uuid',
  from: 'friend_B_uuid',
  recipients: ['me_uuid'],
  content: "Hey, want to watch together?",
  timestamp: 1628000000000
}
```

### Message Privacy

- **Each person sees only messages they're involved in**
- When rendering overlay with co_watchers [B, C]:
  ```typescript
  const visibleMessages = allMessages.filter(m =>
    (m.from === myUUID || m.recipients.includes(myUUID)) &&
    m.recipients.some(r => co_watchers.includes(r) || r === myUUID) ||
    m.from in co_watchers
  )
  ```
- Messages between B and C (where I'm not involved) never appear locally
- Privacy is enforced at render time, not storage time

### Message Lifecycle

```
A and B co-watching netflix/Y
A: "Let's find something else"
B: "Ok, I'll look around"

→ Both messages in messages[] with from/recipients

B closes overlay or navigates to different video

A: "Still here?"
→ Message queued/sent to B (via Nostr kind-1059)
→ Stored in A's messages[] with recipients: [B]
→ B receives on Nostr when they check
→ B stores in their local messages[]

Later, B rejoins:
→ Overlay loads, messages[] filtered by co_watchers
→ Full thread visible: "Let's find something else" → "Ok" → "Still here?" → ...
→ Conversation continues naturally
```

## Overlay State (Ephemeral)

Overlay maintains ephemeral state in memory/React (not persisted):

```typescript
interface OverlayEphemeralState {
  visible: boolean;              // Show/hide overlay
  pinned: boolean;               // Pin to viewport or minimize
  opacity: number;               // Slider: 0-1
  messages_scrolled_to_bottom: boolean;
}
```

These are **UI preferences**, not core state. Lost on page reload (acceptable).

## State Ownership Summary

| State | Owner | Persistent | Purpose |
|-------|-------|-----------|---------|
| `active_session` | Background | Yes (chrome.storage) | Who's co-watching together |
| `messages` | Background | Yes (chrome.storage) | Full conversation history |
| `current_activities` | Background/Content Script | Via Nostr | What each friend is watching |
| Overlay ephemeral | Content Script | No (memory) | UI visibility, opacity, pin |
| `co_watchers` | CoWatcherDetector | Derived | Current mutual activities |
| Host determination | Overlay (runtime) | No | Based on contentTimestamp |

## Session End Conditions

1. **Explicit leave:** User clicks "Leave Session" button
2. **Manual close:** Last person closes overlay (optional timeout TBD)
3. **Navigate away:** (TBD - does closing browser tab end session?)

## Edge Cases

### Multiple Sessions?
- Only one `active_session` per user
- Starting new co-watch while in session: replaces old session
- (Future: session history for "continue with X")

### Message Encryption on Nostr
- When A sends message in [B, C] overlay:
  - Creates kind-1059 to B (encrypted with B's pubkey)
  - Creates kind-1059 to C (encrypted with C's pubkey)
  - Same content, same timestamp
  - Both events published to Nostr
- B receives and stores in local messages
- C receives and stores in local messages
- A stores both in local messages

### Clock Skew
- Host determined by `contentTimestamp` (oldest wins)
- If clocks are skewed, host role may flip
- Acceptable edge case (rare with modern OS)
- Sync interpolation still works because we use `progress_measured_at`

## Future Enhancements

- **Session timeout:** Auto-close after 30 mins of inactivity
- **Session history:** Archive sessions for "continue with friend" feature
- **Presence hints:** Show if friend's browser tab is active/idle
- **Read receipts:** Show when messages are read (optional, privacy tradeoff)
