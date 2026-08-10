# Overlay Display Behavior

## Core Principle
Once a session is created with 2+ members, the overlay ALWAYS shows for all session members going forward, regardless of whether they diverge or change modes.

## Session Membership
- **Created when**: 2+ people detected on same video
- **Members**: Persistent list that ONLY grows (never removes people except explicit leave)
- **Persists through**: Video changes (divergence), mode switches, reconnections

## Display Rules

### Overlay Visibility (Show/Hide)
- **Show overlay if**:
  - Session exists AND 2+ members are online (activity < 1 hour old), OR
  - Overlay is pinned

- **Hide overlay if**:
  - Session doesn't exist, AND
  - Overlay is not pinned

### Member Display (Who Appears)
**All session members are displayed in the overlay, ALWAYS** (subject to activity status below)

For each session member:
- **Render at full opacity** if activity < 15 minutes old (active)
- **Render at 0.5 opacity (grayed)** if activity 15-60 minutes old (AFK)
- **Hide** if activity > 60 minutes old (offline)

**Special case: Self (You)**
- Always render at full opacity (1.0), regardless of inactivity
- Never hidden
- Labeled as "You"

### Layout: Host Mode (2+ on same video)
- Host chip + progress bar (position markers of guests if host, and arrow position marker for self if guest)
- Guest chips for all non-hosts on same video
- Sync + Discord buttons
- Messages below

### Layout: Guest Mode (<2 on same video after divergence)
- "Choose Next:" section
- Guest row for each person (icon, title, join button)
- Messages below

## Data Flow - Background → Overlay State
The background sends:
- `session_members`: All persistent session members
- `watching_together`: Members on same video (subset of session_members)
- `co_watcher_activities`: Map of UUID → {activity_id, content, service, timestamp, metadata}
- `nicknameMap`: UUID → display name
- Other fields (progress, host info, messages, etc.)

## Freshness Detection
Activity freshness determined by: `activity.metadata.progress_measured_at` (when content script last measured progress)
- Only updated when content script detects video activity
- Stops updating when video is paused
- Symmetric for self and friends

## Test Scenarios

### Scenario 1: Both on same video
- test2 and test3 watching same YouTube video
- **Expected**: Both see host mode with each other as guest chips
- **Expected**: Host sees host progress bar with markers for guest progress
- **Expected**: Guests see progress bar with arrow and marker for self with sync button
- **session_members**: [test2-uuid, test3-uuid]
- **watching_together**: [test2-uuid, test3-uuid]
- **Both overlays show**

### Scenario 2: One diverges
- test2 still on original YouTube video
- test3 navigates to different video
- **Expected**: Both overlays stay open
  - test2 overlay: guest mode, You and test3 visible as guest rows
  - test3 overlay: guest mode, You and test2 visible as guest rows
- **session_members**: [test2-uuid, test3-uuid] (unchanged)
- **watching_together**: [] (nobody on same video)

### Scenario 3: One goes offline (paused 1+ hour)
- test2 actively watching YouTube
- test3 paused on different video for 1+ hour
- **Expected**: 
  - test2 overlay: shows test3 grayed/hidden
  - test3 overlay: shows test3 at full opacity (self), test2 visible

## Known Bugs
1. **Test3 missing from both overlays after divergence/rejoin cycle**
   - Should be visible in both overlays at all times
   - Root cause: TBD - hypothesis being tested: inactivity hiding
   
2. **Overlay auto-hide doesn't reappear until reload**
   - When overlay hides (visibility = false), it doesn't reappear when show() is called again
   - Does NOT require offline users - can happen anytime overlay hides
   - Likely CSS issue (.hidden class not being removed, or display:none persisting)

## Testing: Disable Inactivity Hiding
To isolate bug 1, inactivity opacity/hiding (graying and hiding based on 15min/1hour thresholds) has been disabled.
- All session members now always render at full opacity (1.0)
- No members are hidden based on inactivity
- Self still always renders at full opacity (redundant with above)
- If bug 1 persists: inactivity logic is not the cause
- If bug 1 disappears: inactivity logic or freshness detection is the cause
