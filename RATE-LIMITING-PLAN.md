# Rate Limiting & Event Consolidation Plan

## Problem Statement

Current publishing model exceeds safe relay rate limits (10/60 sec = 0.167 msg/s target):
- **Activities:** 1 event every 12s (0.083 msg/s) ✅ Within quota
- **Time-Sync:** 1 event every 5s when watching video (0.2 msg/s) ❌ Exceeds quota by 2.4x
- **Combined:** ~0.28 msg/s when watching video ❌ Exceeds relay limits

Goal: Stay under 5/60 sec (0.083 msg/s) to be safely under relay's 10/60 sec limit (50% safety margin).

---

## Phase 1: Fix Progress Change Detection

### Issue
When receiving friend's activity events, change detection (background.ts ~line 1845) only compares:
- `content`
- `audio` 
- `url`

Does NOT check `metadata.progress`, so progress bar updates don't trigger UI refreshes.

### Fix
**File:** `entrypoints/background.ts` line 1843-1851

Current:
```typescript
if (!oldActivity ||
    oldActivity.content !== activity.content ||
    oldActivity.audio !== activity.audio ||
    oldActivity.url !== activity.url) {
  changedServices.add(activity.service);
}
```

Updated:
```typescript
if (!oldActivity ||
    oldActivity.content !== activity.content ||
    oldActivity.audio !== activity.audio ||
    oldActivity.url !== activity.url ||
    oldActivity.metadata?.progress !== activity.metadata?.progress) {
  changedServices.add(activity.service);
}
```

### Impact
- ✅ Progress bar updates from friends will now trigger UI refresh
- ✅ No breaking changes
- ✅ No new storage or publishing required

---

## Phase 2: Remove TimeSyncManager (Dead Code Cleanup)

### What to Remove
1. **File:** `src/modules/time-sync.ts` — entire file
2. **Imports:** Remove from `entrypoints/background.ts`, `src/modules/__tests__/time-sync.test.ts`
3. **Tests:** Delete `src/modules/__tests__/time-sync.test.ts`
4. **Exports:** Remove from any barrel exports (index.ts files)

### What to Keep
- All time-sync data flow through `activity.metadata.progress` and `activity.metadata.duration`
- UI progress bar logic (uses `metadata.progress`)
- Content script video tracking (sets `metadata.progress`, `metadata.duration`)

### Impact
- ✅ Removes ~300 lines of unused code
- ✅ No functional impact (TimeSyncManager never called)
- ✅ Reduces cognitive load (one less manager to understand)
- ✅ Slightly reduces bundle size

---

## Phase 2.5: Remove Audio Field (Redundant with State)

### Issue
The `audio` field (on/off) duplicates information from `state` (playing/paused):
- `audio`: Indicates if tab is producing sound (speaker icon 🔊/🔇)
- `state`: Indicates if content is playing/paused (play ▶️/pause ⏸️)

Since `state` is already displayed and used for sorting, `audio` is redundant. Using `state` alone is sufficient.

### Changes

#### 1. Remove from Activity Type
**File:** `src/types.ts` line 152

Remove:
```typescript
audio: 'on' | 'off'; // Audio state detected from tab.audible (deprecated, kept for compatibility)
```

#### 2. Remove from Content Script
**File:** `entrypoints/content-script.ts` line 272 + line 279

Remove:
```typescript
audio: 'on',  // Don't set this anymore
```

And remove from metadata object being sent to background.

#### 3. Update UI (remove audio icon display)
**File:** `src/ui/popup.ts` lines 1265-1266, 1293-1305

Remove audio sorting logic:
```typescript
const aAudio = a.audio === 'on' ? 1 : 0;  // Remove this
const bAudio = b.audio === 'on' ? 1 : 0;  // Remove this
```

Remove audio icon from friend's activity display (lines 1293-1305):
```typescript
if (activity.state) {
  const audioIcon = document.createElement('span');
  audioIcon.className = `activity-audio-icon activity-audio-${activity.audio}`;
  audioIcon.textContent = activity.audio === 'on' ? '🔊' : '🔇';
  audioIcon.title = activity.audio === 'on' ? 'Audio On' : 'Audio Off';
  item.appendChild(audioIcon);
  // ... separator
}
```

Keep state icon (play/pause), remove audio icon section.

#### 4. Update Change Detection
**File:** `entrypoints/background.ts` line 1845-1851

Remove `audio` comparison (will be updated in Phase 1 anyway):
```typescript
// OLD:
oldActivity.audio !== activity.audio ||

// NEW (after Phase 1):
oldActivity.state !== activity.state ||
oldActivity.metadata?.progress !== activity.metadata?.progress
```

#### 5. Remove from Publisher Debug Logs
**File:** `src/modules/publisher.ts` lines 357, 422

Remove audio from debug output:
```typescript
// Remove: `${a.service}(audio:${a.audio})`
// Keep: `${a.service}`
```

### Note on Spotify/Twitch Fields
Preserve the following fields for future Spotify/Twitch API implementation:
- `metadata.artist` — For Spotify track metadata
- `metadata.thumbnailUrl` — For Spotify album art, Twitch thumbnails (not yet used in UI)

These will be useful when we fully implement and test Spotify/Twitch API integrations. For now they're stored but not published to friends (can add to Phase 3 minimalist payload decision).

### Impact
- ✅ Reduces event size by ~10-20B per event
- ✅ Simplifies Activity type (one less field)
- ✅ Play/pause state already shows activity status
- ✅ No functionality lost (state is more useful than audio on/off)
- ✅ Cleaner UI (fewer icons per activity row)
- ✅ Preserves Spotify/Twitch fields for future implementation

---

## Phase 3: Consolidate Activity + Time-Sync Publishing

### Current State (Separate Events)
```
t=0s:    Activity event published (300B)          [activity cycle]
t=5s:    Time-sync event published (350B)         [time-sync cycle]
t=10s:   Time-sync event published (350B)         [time-sync cycle]
t=12s:   Activity event published (300B)          [activity cycle]
t=15s:   Time-sync event published (350B)         [time-sync cycle]
t=20s:   Time-sync event published (350B)         [time-sync cycle]
t=24s:   Activity event published (300B)          [activity cycle]

Total in 24s: 2 activity + 4 time-sync = 6 events
Publishing rate: 0.25 msg/s (EXCEEDS 0.083 limit by 3x)
Total bandwidth: 1980B in 24s = 82.5B/s
```

### Desired State (Consolidated for Video Services)
```
t=0s:    Consolidated event (activity + time-sync) (450B) [activity cycle]
t=5s:    [DROPPED - rate limited]
t=10s:   [DROPPED - rate limited]
t=12s:   Consolidated event (activity + time-sync) (450B) [activity cycle]
t=15s:   [DROPPED - rate limited]
t=20s:   [DROPPED - rate limited]
t=24s:   Consolidated event (activity + time-sync) (450B) [activity cycle]

Total in 24s: 3 consolidated events
Publishing rate: 0.125 msg/s (WITHIN limit)
Total bandwidth: 1350B in 24s = 56.25B/s (32% reduction)
```

### Implementation Strategy

#### 3.1: Update Activity Type (if needed)
**File:** `src/types.ts`

Check if Activity.metadata already has all needed fields:
- `progress?: number` — current playback position (seconds)
- `duration?: number` — total video length (seconds)
- `tabId?: number` — Chrome tab ID
- `artist?: string` — for music (Spotify)
- Other existing fields

✅ Already present, no type changes needed

#### 3.2: Stop Time-Sync Publishing (After Phase 2)
Once TimeSyncManager is removed, time-sync stop being published as separate events.

#### 3.3: Ensure Activity Publishing Includes Time-Sync Data
**File:** `src/modules/publisher.ts`

The bundled activity publisher already serializes full Activity objects:
```typescript
const content = JSON.stringify(activities);
```

This ALREADY includes `metadata.progress` and `metadata.duration`. No changes needed here.

#### 3.4: Add Tags to Published Events for Video Services
**File:** `src/modules/publisher.ts` - `_publishBundledActivities()` method

When publishing activities, add tags to indicate time-sync data is embedded:
```typescript
const tags: Array<[string, string]> = [
  ['is_activity', 'true'],
  ['type', 'activity-state'],
  ['mode', mode === 'compressed' ? 'atomic' : mode],
  ['count', activities.length.toString()],
];

// For each activity, add service tag + optional time-sync indicator
for (const activity of activities) {
  tags.push(['service', activity.service]);
  
  // If this is a video service with time-sync data, tag it
  if (['youtube-tab', 'netflix-tab', 'twitch-tab', 'video-tab'].includes(activity.service) &&
      activity.metadata?.progress !== undefined &&
      activity.metadata?.duration !== undefined) {
    tags.push(['has_time_sync', 'true']);
  }
}
```

#### 3.5: Simplify Receiving Logic (Remove Delta Handling)
**File:** `entrypoints/background.ts` lines 1863-1912

Remove the "incomplete activity" check that was designed for delta publishing:

**Current code:**
```typescript
// Delta publishing workaround - preserve old fields if new is incomplete
const isIncomplete = !activity.content && existingActivity?.content;
if (isIncomplete) {
  newCurrentActivities[service] = {
    ...existingActivity,
    ...activity,
    content: existingActivity.content,  // Preserve old content
  };
} else {
  // ... similar merge
}
```

**New code (always do targeted merge):**
```typescript
// Always merge published fields, preserve local-only fields
for (const [service, activity] of Object.entries(activitiesByService)) {
  const existingActivity = friend.current_activities?.[service as ServiceName];
  
  newCurrentActivities[service as ServiceName] = {
    ...existingActivity,              // Start with existing (has local fields)
    ...activity,                      // Override with published fields
    metadata: {
      ...existingActivity?.metadata,  // Preserve local metadata (tabId, etc)
      ...activity.metadata,           // Override with published metadata (progress, duration)
    }
  };
}
```

**Rationale:** With Phase 3b sending complete minimized payloads (never delta), incomplete activities won't occur. Removing the check simplifies code and exposes any issues instead of hiding them.

### Impact
- ✅ Publishing rate drops from 0.28 msg/s to 0.125 msg/s (within 0.083 limit)
- ✅ Bandwidth usage drops 32%
- ✅ Event size increases slightly (450B vs 300B) but still safe (<64KB relay limit)
- ✅ Consolidation is transparent to receivers (they get full activity + progress data)
- ✅ No breaking changes (tags are informational, not mandatory)

---

## Phase 3b: Minimize Published Payload (Only Send Required Fields)

### Issue
Currently publishing full Activity objects with 20+ fields. Many are local-only or unused by receivers.

### Implementation
**File:** `src/modules/publisher.ts` - create `toPublishableActivity()` function

**Only publish:**
```typescript
{
  id: string;
  service: ServiceName;
  content: string;
  url?: string;
  state?: 'playing' | 'paused' | 'stopped' | 'disconnected';
  timestamp: number;
  metadata?: {
    progress?: number;          // Progress bar numerator
    duration?: number;          // Progress bar denominator
    // Optionally add for Spotify (when API implemented):
    // artist?: string;
    // Optionally add for video services (nice-to-have):
    // favicon?: string;
  };
}
```

**Don't publish:**
- ❌ `audio` (being removed in Phase 2.5 anyway)
- ❌ `is_fresh` — local-only (indicates data freshness)
- ❌ `freshness_timestamp` — local-only (when data was last refreshed)
- ❌ `provenance` — receiver already knows it's from a friend
- ❌ `metadata.thumbnailUrl` — not displayed, can defer
- ❌ `metadata.tabId` — Chrome-specific, not useful for friends
- ❌ `metadata.appid` — Steam-only, not in activity publishing
- ❌ `metadata.disconnected_reason` — local diagnostics only

### Size Impact
- Current: ~900B (publishing everything)
- Minimized: ~280-320B (only essentials)
- **Reduction: 65-70%**

### Implementation Notes
- Create `toPublishableActivity()` wrapper in publisher
- Call it before `JSON.stringify()` in bundled publisher
- Receiving side: no changes needed (parses the minimized payload)
- Future: when Spotify/Twitch APIs are implemented, can add artist/thumbnail

### Impact
- ✅ Dramatically reduces event size (900B → 280B)
- ✅ Gives more breathing room for future metadata
- ✅ Cleaner events (only client-relevant data)
- ✅ No receiver breakage (they get all needed fields)

### 3b.2: Remove All Delta Publishing Code
**Rationale:** We decided to remove delta publishing entirely. This code was designed to send only changed fields, but causes complexity in merging logic and hidden assumptions.

**Files to Clean Up:**

1. **src/modules/publisher.ts**
   - Remove any `delta` mode logic or conditional code paths
   - Remove `DELTA_PUBLISHING` constant (if present)
   - Remove any "atomic vs delta" mode selection logic
   - Keep only: publish full minimized payloads every time

2. **entrypoints/background.ts** 
   - Remove comment about "merging with existing to preserve fields from delta publishing" (line 1863)
   - Remove the "incomplete activity" check (lines 1894-1911) ✅ already covered in 3.5

3. **src/types.ts**
   - Check if any publisher_config fields relate to delta (already removed in types update)
   - Remove any delta-related comments or type definitions

4. **Documentation/Comments**
   - Search codebase for references to "delta" in comments
   - Remove/update any documentation mentioning delta publishing strategy

**Search Patterns to Find:**
- `delta`
- `DELTA`
- `atomic`
- `scope`
- `publishing strategy`
- `preserved fields`

---

## Critical Decisions (Before Phase 4)

### Queue Behavior Under Load
**Decision:** UI idle timeouts prevent action spam
- Invite button: 10s cooldown per click
- Add Friend button: 10s cooldown per click
- Messaging: defer (not implemented yet)
- Result: no need for max queue depth or drop policies

### Rate Limit Change Handling
**Decision:** Option A - finish current cycle before applying new rate
- User changes rate mid-cycle (e.g., 12s → 1s)
- Complete current 12s cycle with old rate
- Apply new rate starting next cycle
- Prevents arbitrary restarts from exceeding the cap
- User sees change take effect within one full cycle

### Publish Failure & Retry Strategy
**Decision:** Exponential backoff with 60s cap, 10 retries max

```
Retry Schedule (exponential backoff, capped at 60s):
1: 1s
2: 2s
3: 4s
4: 8s
5: 16s
6: 32s
7-10: 60s (capped)

Total max wait: ~5 minutes across all retries
```

**Behavior:**
- Friend invites + activity invites: critical, retry all 10 times
- Other events: retry up to 10 times
- **Constraint:** Always respect activity publish guarantee (at least every other cycle)
  - If a high-priority event fails and needs retry, but this cycle requires activity publish, publish activity instead
  - Re-queue failed event for retry on next available slot
- After 10 failed retries: drop event with notification to user

### Extension Restart & Persistence
**Decision:** Persist critical queue items, resume on restart

**Storage Structure:**
```typescript
pending_publishes: Array<{
  type: 'invite' | 'friend_request';
  event: NostrEvent;
  retryCount: number;
  lastRetryAt: number;
}>
```

**On Startup:**
- Load `pending_publishes` from storage
- Restore into PublishQueue as high-priority items
- Show notification: "Resuming X pending invites from last session"
- Always re-publish user profile (heartbeat)

**On Event Publish (Success):**
- Remove from `pending_publishes` storage

**On Event Retry Exhausted:**
- Remove from storage
- Log entry to activity diagnostics
- Notify user in UI

**Activities:** Never persist (transient, idempotent)
- Let activity detector publish current state fresh on restart

---

## Phase 4: Implement Unified Rate Limiting/Scheduling (Future)

### Strategy: Three-Tier Priority with Activity Gap Prevention

**Core Idea:** Publish exactly one event every N seconds (default 12s, user-configurable). Priority tiers handle different event types, with a constraint that activities must publish at least every other cycle (prevents starvation).

### Priority Tiers
| Priority | Event Type | Trigger | Constraint |
|----------|-----------|---------|-----------|
| **1 (Highest)** | User actions | On user action | Always replaces activity; resets gap counter |
| **2 (High)** | Profile | On change or 30m timer | Replaces activity, but not consecutively |
| **3 (Medium)** | Game library | 6h timer | Replaces activity, but not consecutively |
| **4 (Base)** | Activities | 12s timer | Fill all remaining slots; must publish every other cycle |

### Publishing Cycle Algorithm
```typescript
class PublishQueue {
  private publishIntervalMs: number;
  private lastEventReplacedActivity: boolean = false;
  
  async publishCycle(): Promise<void> {
    let eventToPublish: NostrEvent | null = null;
    
    // Priority 1: User actions (always publish if pending)
    if (this.userActionQueue.length > 0) {
      eventToPublish = this.userActionQueue.shift();
      this.lastEventReplacedActivity = false;  // Reset counter
    }
    // Priority 2: Profile (publish if pending AND not replacing consecutively)
    else if (this.profileUpdatePending && !this.lastEventReplacedActivity) {
      eventToPublish = this.createProfileEvent();
      this.profileUpdatePending = false;
      this.lastEventReplacedActivity = true;
    }
    // Priority 3: Game library (publish if due AND not replacing consecutively)
    else if (this.gameLibraryDue && !this.lastEventReplacedActivity) {
      eventToPublish = await this.createGameLibraryEvent();
      this.gameLibraryLastPublished = Date.now();
      this.lastEventReplacedActivity = true;
    }
    // Priority 4: Activities (always publish, fills gaps)
    else {
      eventToPublish = await this.getActivityEvent();
      this.lastEventReplacedActivity = false;
    }
    
    if (eventToPublish) {
      await this.relayPool.publish(eventToPublish);
    }
  }
}
```

### Event Sources & Integration

**Priority 1 - User Actions (queued, always replaces activity):**
- Friend requests → `enqueueUserAction()` (via MessagingManager)
- Activity invites → `enqueueUserAction()` (via MessagingManager)
- Chat messages → `enqueueUserAction()` (via MessagingManager)

**Priority 2 - Profile (queued, replaces activity but not consecutively):**
- Profile updates (identifier, settings changes) → `markProfileUpdatePending()` (via UserManager)
- Publishes on 30-minute cycle or when changed

**Priority 3 - Game Library (queued, replaces activity but not consecutively):**
- Game library updates → `markGameLibraryDue()` (via GameLibraryManager)
- Publishes on 6-hour cycle
- Game library itself handles its own timer, PublishQueue just handles publishing slot

**Priority 4 - Activities (conditional, fills gaps):**
- Activity updates → published only if no higher-priority event is queued
- Time-sync → consolidated into activities (Phase 3) ✅ already handled
- Guaranteed to publish at least every other cycle (never starved)

### Behavior Examples
```
Rate cap: 12 events/min (1 every 12s, user-configurable)

Scenario 1: Normal activity flow (no user actions)
  t=0s:    Activity published (P4) ✅
  t=12s:   Activity published (P4) ✅
  t=24s:   Activity published (P4) ✅

Scenario 2: User actions only (no profile/game library)
  t=0s:    Activity published (P4, queue empty) ✅
  t=5s:    User sends friend request → enqueued (P1)
  t=12s:   Friend request published (P1, latency: 7s) ✅
  t=24s:   Activity published (P4, gap_counter=1) ✅
  
Scenario 3: Profile update + activities (not consecutive replacement)
  t=0s:    Activity published (P4, gap_counter=0) ✅
  t=12s:   Profile published (P2, gap_counter=1) ✅
  t=24s:   Activity published (P4, gap_counter=0) ✅ FORCED (not starved)
  t=36s:   Activity published (P4, gap_counter=0) ✅
  
Scenario 4: Game library + activities (not consecutive replacement)
  [6 hours later, game library is due]
  t=0s:    Activity published (P4) ✅
  t=12s:   Game library published (P3, gap_counter=1) ✅
  t=24s:   Activity published (P4, gap_counter=0) ✅ FORCED (not starved)
  t=36s:   Activity published (P4) ✅

Scenario 5: Multiple event types (priority matters)
  t=0s:    Activity published (P4, queue empty) ✅
  t=2s:    User sends message → enqueued (P1)
  t=5s:    Profile change detected → marked pending (P2)
  t=8s:    Game library due (timer) → marked due (P3)
  t=12s:   Message published (P1, latency: 10s) ✅ USER ACTION WINS
  t=24s:   Profile published (P2, latency: 19s) ✅ GAME LIBRARY SKIPPED
  t=36s:   Activity published (P4, gap_counter=0) ✅ ACTIVITY FORCED
  t=48s:   Game library published (P3) ✅ GAME LIBRARY NOW GETS SLOT
```

### Guarantees
- ✅ User actions always publish within 12s (Priority 1 always replaces)
- ✅ Activities publish at least every other cycle (never starved by consecutive replacements)
- ✅ Profile/Game library publish on schedule but respect activity frequency
- ✅ Global rate cap never exceeded (exactly 1 event per cycle)
- ✅ Simple, predictable behavior with clear priority ordering

### Implementation Notes
- Queue lives in background service worker
- User actions trigger immediate enqueue (via MessagingManager)
- Profile/Game library updates trigger pending flags (via managers)
- Gap counter prevents consecutive replacements of activities
- Settings UI controls publishIntervalMs (default 12000ms)
- Game library manager handles its own 6h timer; PublishQueue just handles publishing slot
- No persistence needed (ephemeral queue, events retry on relay failure via existing logic)

---

## Phase 2.7: Add Low Bandwidth Mode with Gzip Compression

### Implementation
**Files:** `src/types.ts`, `src/modules/publisher.ts`, `entrypoints/background.ts`, `src/ui/popup.ts`

Add optional gzip compression for bandwidth-constrained users:

**User Profile Setting:**
```typescript
low_bandwidth_mode?: boolean;  // Optional toggle, default false
```

**Publishing (publisher.ts):**
```typescript
if (userProfile.low_bandwidth_mode && event.content) {
  // Compress payload
  const compressed = await gzip(event.content);
  event.content = base64Encode(compressed);
  event.tags.push(['compression', 'gzip']);
}
```

**Receiving (background.ts):**
```typescript
const isCompressed = event.tags.find(t => t[0] === 'compression')?.[1] === 'gzip';
if (isCompressed) {
  const decompressed = await gunzip(base64Decode(event.content));
  event.content = decompressed;
}
// Parse as normal JSON after decompression
```

### Benefits
- ~50% payload reduction (900B → 450B per event)
- Saves ~2.15 MB/hour (vs 4.3 MB/hour uncompressed)
- Fully backward compatible (receivers check tags)
- Helps users on capped data plans
- Low complexity: just tag signaling, standard gzip

### Tradeoff
- CPU overhead at publish/receive (negligible for 1 event/12s)
- Default OFF (users opt-in if needed)
- Can defer if time-constrained, but trivial to add

### Impact
- ✅ Ship with MVP (optional toggle, helps users)
- ✅ Adds 1 setting to popup UI
- ✅ Minimal code complexity
- ✅ No receiver breakage (checks tag before decompressing)

---

## Summary: Work Breakdown

| Phase | Task | Files | Risk | Benefit |
|-------|------|-------|------|---------|
| 1 | Fix progress change detection | background.ts | Low | Enables UI progress bar updates from friends |
| 2 | Remove TimeSyncManager | time-sync.ts + imports | Low | Code cleanup, reduce complexity |
| 2.5 | Remove audio field | types.ts, content-script.ts, popup.ts, publisher.ts, background.ts | Low | Reduces event size by 10-20B, simplifies UI |
| 2.7 | Add Low Bandwidth Mode (gzip) | types.ts, publisher.ts, background.ts, popup.ts | Low | Optional toggle, 50% compression for capped users |
| 3 | Consolidate activity + time-sync | publisher.ts | Medium | Reduces rate from 0.28→0.125 msg/s |
| 3b | Minimize published payload | publisher.ts | Low | 65-70% size reduction (900B → 280B) |
| 4 | Unified rate limiting | New PublishQueue module | High | Handles all event types safely (future) |

---

## Dependencies & Order

**Must do in order:**
1. Phase 1 (fix change detection) — prerequisite for phase 2+
2. Phase 2 (remove TimeSyncManager) — prerequisite for phase 3
3. Phase 2.5 (remove audio field) — simplifies data model before consolidation
4. Phase 2.7 (add low bandwidth mode) — optional, can be any time before shipping
5. Phase 3 (consolidate) — solves rate limiting for video services
6. Phase 3b (minimize payload) — after consolidation, strip unused fields
7. Phase 4 (unified scheduling) — handles remaining event types (future)

**Safe to do independently:**
- Can do Phase 2.5 (remove audio) in parallel with Phase 2 (remove TimeSyncManager)
- Can do Phase 2.7 (low bandwidth mode) in parallel with phase 2/2.5 or anytime before shipping
- Can add progress tags to events (phase 3.4) before removing TimeSyncManager
- Can test phases 1-3 separately

---

## MVP Settings UI (Settings Page)

Based on decisions above, the MVP settings page will have:

**Service Detection Toggles:**
- [ ] Detect Spotify (API key only, defer OAuth testing)
- [ ] Detect Twitch (API key only, defer OAuth testing)
- [ ] Detect Steam (API key only, defer OAuth testing)
- [ ] Detect Discord
- [ ] Detect YouTube
- [ ] Detect Netflix
- [ ] Detect video sites
- [ ] Game Discovery

**Notification Preferences:**
- [ ] Friend came online
- [ ] New message received
- [ ] Join suggestion

**Publishing Controls:**
- [ ] **Enable Publishing** (toggle) — global on/off switch
- **Max Publish Rate (events/min):** [text input, default 12]
- [ ] **Low Bandwidth Mode** (toggle) — gzip compression for capped data

### Simplify publisher_config

Instead of 10 fields, keep only:
```typescript
publisher_config?: {
  enabled: boolean;           // User toggle
  rate_ms: number;            // User-configurable (default 12000)
  low_bandwidth_mode?: boolean;
  
  // Hardcoded (not user-configurable):
  // - relays: canonical list [nos.lol, nostr.mom, relay.mostr.pub, relay.primal.net]
  // - size: 'full'
  // - scope: 'all'
  // - compression: false (unless low_bandwidth_mode)
  // - delta_publishing: false (removed entirely)
  // - verbose_logging: false
  // - retry_backoff_ms: 1000
};
```

### Implementation Notes
- Rate limit input: validate 1-60 events/min range
- Default 12/min = 1 event per 12 seconds
- When disabled, no publishing at all
- Low bandwidth mode: optional, default off

---

## Deferred Decisions (Test Integrations First)

1. **Steam auth** — Keep API key only for MVP. Test OAuth integration separately before enabling.
2. **Spotify auth** — Keep API key only for MVP. Test OAuth integration separately before enabling.
3. **Twitch auth** — Keep API key only for MVP. Test OAuth integration separately before enabling.

---

## Final MVP Publishing Strategy

### Hardcoded (Internal Constants)
```typescript
// Never user-configurable
const CANONICAL_RELAYS = ['wss://nos.lol', 'wss://nostr.mom', 'wss://relay.mostr.pub', 'wss://relay.primal.net'];
const PUBLISH_SIZE_STRATEGY = 'full';        // All activities every time
const PUBLISH_SCOPE = 'all';                 // All fields every time
const DELTA_PUBLISHING = false;              // Removed entirely
const COMPRESSION_DEFAULT = false;           // Off by default
const VERBOSE_LOGGING = false;               // Development only
const RETRY_BACKOFF_MS = 1000;              // Default retry strategy
```

### User-Configurable (Settings UI)
```typescript
publisher_config: {
  enabled: boolean;              // Default: true
  rate_ms: number;               // Default: 12000 (12/min), input range 1000-60000 (60/min to 1/min)
  low_bandwidth_mode?: boolean;  // Default: false, enables gzip compression
}
```

### Published Event Structure
```typescript
{
  id: string;
  service: ServiceName;
  content: string;
  url?: string;
  state?: 'playing' | 'paused' | 'stopped' | 'disconnected';
  timestamp: number;
  metadata?: {
    progress?: number;
    duration?: number;
  }
}
// Size: 280-320B (uncompressed), 140-160B (with gzip)
```

### Rate Limiting Guarantee
- Hard limit: configurable via UI (default 12/min = 1 event/12s)
- Applies to ALL event types (activities, time-sync, game library, user actions)
- Unified queue will enforce across all sources
- Emergency off-switch via "Enable Publishing" toggle

---

## Complete Phase List (MVP Shipping)

| # | Phase | Task | Risk | Status |
|---|-------|------|------|--------|
| 1 | Phase 1 | Fix progress change detection | Low | Ready |
| 2 | Phase 2 | Remove TimeSyncManager | Low | Ready |
| 3 | Phase 2.5 | Remove audio field | Low | Ready |
| 4 | Phase 2.7 | Add Low Bandwidth Mode (gzip) | Low | Ready |
| 5 | Phase 3 | Consolidate activity + time-sync | Medium | Ready |
| 6 | Phase 3b | Minimize published payload | Low | Ready |
| 7 | Phase 4 | Unified rate limiting queue | High | Future |

**Total scope:** 6 phases for MVP (phases 1-3b), ~2-3 days of work
**Future:** Phase 4 (unified scheduling) for robust rate limiting across all event types
