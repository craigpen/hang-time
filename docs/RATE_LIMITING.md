# Nostr Publish Queue & Rate Limiting Specification

## 1. Overview

Hang Time interacts with multiple decentralized Nostr relays simultaneously. To prevent relay flooding, socket congestion, and rate-limit bans (HTTP 429 / WebSocket closures), all outgoing events are channeled through the priority-driven `PublishQueue` (`src/modules/publish-queue.ts`).

---

## 2. 3-Tier Priority Queue Architecture

Events are categorized into 3 strict priority tiers:

```
┌─────────────────────────────────────────────────────────────┐
│                    PublishQueue (FIFO Tiered)               │
├─────────────────────────────────────────────────────────────┤
│ Priority 1: User Actions (Invites, Messages, DND Toggle)    │  ──► Immediate Dispatch (< 100ms)
├─────────────────────────────────────────────────────────────┤
│ Priority 2: Profile Updates (Name, Steam ID, Status)        │  ──► Standard Dispatch (< 500ms)
├─────────────────────────────────────────────────────────────┤
│ Priority 3: Activity & Game Library (Presence, Kind 10003)  │  ──► Throttled Cycle (3000ms debounce)
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Priority Levels

1. **Priority 1: User Actions (`enqueueUserAction`)**
   - **Contents**: Encrypted direct messages, friend requests, activity invites, session join acceptances, and DND status changes.
   - **Execution**: Dispatched immediately with zero artificial delay.
2. **Priority 2: Profile Updates (`markProfileDue`)**
   - **Contents**: User display name changes, relay list updates, avatar changes.
   - **Execution**: Debounced to 500ms to batch rapid form typing.
3. **Priority 3: Background Activity & Game Libraries (`markActivityDue`, `markGameLibraryDue`)**
   - **Contents**: Real-time video progress, song playback changes, Steam owned games list (Kind 10003).
   - **Execution**: 3-second throttle cycle (`ACTIVITY_PUBLISH_INTERVAL_MS = 3000`). If media state changes rapidly (e.g. seeking), intermediate states are coalesced into the latest timestamp.

---

## 3. Burst Protection & Relay Reconnection

- **Per-Relay Health Tracking**: `RelayPool` monitors connection health. If a relay disconnects, events are buffered until reconnect or routed to healthy fallback relays.
- **Deduplication**: Processed event IDs are tracked in `STORAGE_KEYS.PROCESSED_EVENT_IDS` to avoid re-broadcasting identical payloads.
- **Gift Wrap Envelopes**: Kind 1059 gift wraps randomize timestamps within a narrow jitter window to prevent relay metadata correlation.
