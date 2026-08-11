# Session Persistence Model (MVP Approach)

**Status**: Current direction. Simpler alternative to Rooms concept. Validated through OVERLAY_BEHAVIOR.md.

## Problem Solved

Original ephemeral session model had poor UX: overlay disappeared whenever one person diverged to a different video, making co-watching feel disjointed and broken.

## Solution: Persistent Sessions + Activity-Based Visibility

### Core Principle

**Sessions persist in local storage and grow over time, but visibility is activity-based.**

- **Storage**: Session members are permanent, only added (never removed)
- **Display**: Members shown/hidden based on recent activity (presence detection)
- **No coordination**: Each user independently determines freshness; no server needed

### Session Lifecycle

**Session Creation**:
```
2+ people detected on same video
→ coWatchSession created with {session_id, members: [self, friend1, friend2], ...}
→ Stored in chrome.storage.local
```

**Member Growth**:
```
Friend3 joins video while session exists
→ members array grows: [self, friend1, friend2, friend3]
→ Permanent (friend1 cannot be removed from this session)
```

**No Explicit Deletion**:
```
Users navigate away, diverge, go offline
→ Session still exists in storage
→ Members still "in" session from storage perspective
→ But overlay rendering filters by activity freshness
```

### Visibility Logic (Overlay Rendering)

Member shown/hidden based on `activity.metadata.progress_measured_at` (when content script last detected progress):

| Activity Age | Display | Opacity | Rendered? |
|--------------|---------|---------|-----------|
| < 15 min | Active | 1.0 (full) | ✅ Yes |
| 15-60 min | AFK | 0.5 (gray) | ✅ Yes |
| > 60 min | Offline | — | ❌ Hidden |
| No activity | Unknown | — | ❌ Hidden |

**Exception**: Self ("You") always renders at full opacity, never hidden.

### Advantages

✅ **Decentralized**: No server needed to coordinate expiration
✅ **Simple**: No async cleanup, no state sync issues
✅ **Persistent**: Survives divergence, maintains community feel
✅ **Responsive**: Hides offline people automatically
✅ **Clean UI**: No user action needed ("leave session" button unnecessary)

### Known Limitations

- Sessions accumulate over months (never explicitly deleted)
  - Mitigation: Only show fresh sessions in overlay
  - Future: Rooms concept if this becomes a real problem
- No way to explicitly remove someone (session is immutable)
  - Mitigation: They disappear from view if offline
  - Future: Rooms would allow explicit management

### Implementation Details

**Freshness Detection**:
- Source: `activity.metadata.progress_measured_at`
- Set by: Content script when it detects video playback
- Behavior: Only updates when video is playing (not paused)
- Applies to: Self and friends (symmetric freshness)

**Session Storage** (chrome.storage.local):
```typescript
coWatchSession: {
  session_id: string,
  activity_id: string,
  members: string[],  // persistent, only grows
  created_at: number,
  host_friend_uuid: string,
  is_active: boolean
}
```

**Overlay State** (sent to content script):
```typescript
{
  session_members: string[],  // persistent (from coWatchSession.members)
  watching_together: string[],  // ephemeral (who's on same video now)
  co_watcher_activities: Record<uuid, Activity>,  // for divergence display
  nicknameMap: Record<uuid, string>,
  messages: Message[],
  ... (progress, state, etc.)
}
```

### Activity Freshness Thresholds

Current values (can be tuned):
- **AFK threshold**: 15 minutes (gray out, reduce opacity)
- **Offline threshold**: 60 minutes (hide completely)

Rationale:
- 15 min: Reasonable time to grab a coffee, pause video
- 60 min: Person is definitely gone or done watching

### Divergence Behavior (Two Modes)

**Host Mode** (2+ on same video):
- Show host chip with progress bar + guest markers
- Show guest chips for non-hosts
- Sync and Discord buttons available

**Guest Mode** (< 2 on same video):
- No host chip
- Show all session members as guest rows
- Each row shows: member name, icon/title, join button
- Members sorted with "You" first

**Session members are shown in both modes** regardless of divergence. The mode only affects how the ephemeral "watching_together" is displayed.

### What "Offline" Means

- No activity published in > 60 minutes
- Content script hasn't measured video position in > 60 minutes
- Could mean: user left page, browser tab closed, paused for extended time, or actually gone

Not distinguishable in practice, so all treated as "offline" for visibility purposes.

### Future Refinements

If accumulation becomes a problem:
1. **Archive old sessions**: Keep in storage but hide from UI
2. **Session history page**: Show past sessions separately
3. **Activity-based re-engagement**: Auto-show archived session if member becomes active again
4. **Rooms concept**: If multiple concurrent groups become necessary

---

## Summary

Persistent sessions provide community continuity and solve the "disappearing overlay" problem, while activity-based visibility keeps the UI responsive and clutter-free. No coordination needed in decentralized system; each client independently decides what's "fresh."
