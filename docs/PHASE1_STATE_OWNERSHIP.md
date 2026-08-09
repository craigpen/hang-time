# Phase 1: Hybrid Overlay Architecture - State Ownership Model

**Status:** ✅ COMPLETE (Commit c37e3f2)

## Overview

The overlay operates as a hybrid system: background service worker owns all persistent state, content scripts inject UI and handle ephemeral state. This ensures state consistency across tab switches and extension reloads.

## State Ownership

### Background Service Worker (Persistent)
- **Co-watch sessions:** Who's watching together
- **Activity data:** Host, co-watchers, progress, state (playing/paused)
- **Messages:** All encrypted messages per activity
- **Friend data:** Nicknames, UUIDs

### Content Script (Ephemeral)
- **Overlay visibility:** Whether overlay is shown/hidden
- **Pin state:** Whether overlay is pinned to viewport
- **Opacity:** Slider position
- **Tab/window specific:** Not persisted across reloads

## Message Contracts

### Content Script → Background (Port Messages)

**GET_OVERLAY_STATE**
- Sent: On port connect (for immediate hydration)
- Purpose: Get current co-watch session state
- Used for: Initializing overlay without waiting for CO_WATCH_UPDATE cycle

```typescript
port.postMessage({ type: 'GET_OVERLAY_STATE' });
```

**SEND_MESSAGE**
- Sent: When user types in chat
- Purpose: Send encrypted message to friend
- Response: Background routes through Nostr and storage

### Background → Content Script (Port Messages)

**OVERLAY_STATE**
- Response to `GET_OVERLAY_STATE`
- Contains: Full co-watch state, messages, timestamps
- Used by: Overlay.setState() to hydrate on connect

**CO_WATCH_UPDATE**
- Sent: On each activity/co-watcher change (via relay subscription)
- Purpose: Real-time state updates
- Frequency: As Nostr events arrive (~every 12 seconds for activities)

Both `OVERLAY_STATE` and `CO_WATCH_UPDATE` send identical state structure:

```typescript
{
  activity_id: string;
  host_nickname: string;
  watching_together: string[];        // UUIDs of all co-watchers
  host_progress: number;              // seconds
  host_progress_timestamp: number;    // Date.now() when host measured progress (Unix ms)
  host_state: 'playing' | 'paused' | 'unknown';
  host_duration: number;              // seconds
  user_progress: number;              // seconds
  guest_progress: Record<string, number>; // UUID -> seconds
  is_user_host: boolean;
  messages: Message[];
  nicknameMap: Record<string, string>; // UUID -> display name
}
```

## Timestamp Fields (CRITICAL)

| Field | Purpose | Set By | Used For |
|-------|---------|--------|----------|
| `host_progress_timestamp` | When host's content script measured their progress | Content script (progress_measured_at) | Sync interpolation: `hostProgress + (now - timestamp) / 1000` |
| `contentTimestamp` | When this content item started playing (immutable per activity) | Content script on detection | Host determination (earliest = host) |
| `freshness_timestamp` | When activity data was last refreshed from Nostr | Activity detector | Staleness detection |

## Hydration Flow

### On-Demand (Page Load)
```
1. Content script injects OverlayUI
2. OverlayUI initializes with empty state
3. Content script connects port to background
4. Sends GET_OVERLAY_STATE message
5. Background queries co-watch session, friends, messages
6. Sends OVERLAY_STATE response with full state
7. OverlayUI.setState() merges and renders
```

### Real-Time (Ongoing)
```
1. Background subscribes to Nostr events
2. Activity detector publishes friend state changes
3. Co-watcher detector updates session
4. Publishes CO_WATCH_UPDATE to content script
5. OverlayUI.setState() merges updates and re-renders
```

Both paths converge on the same `setState()` mechanism, so state always flows through overlay consistently.

## Initialization Guard

Content scripts may request `GET_OVERLAY_STATE` before background finishes initialization. Guard ensures detector is ready:

```typescript
if (!initialized) {
  await initializeExtension();
}
const detector = getCoWatcherDetector();
```

## Benefits of This Model

1. **Single source of truth:** All persistent state in background, no duplication
2. **Resilient to reloads:** State persists in background, overlay re-hydrates on demand
3. **Real-time updates:** CO_WATCH_UPDATE provides instant feedback from Nostr
4. **Consistent:** Both hydration paths use identical state structure
5. **Tab isolation:** Ephemeral state never shared across tabs (visibility, opacity, pin)

## Future Enhancements

- **Session Model (Phase 2):** Overlay becomes independent of activity_id, tracks session across video changes
- **Diverged Guests UI:** Display guest video titles when watching different content
- **Tab Visibility:** Track which tab is active, hide overlay in background tabs
