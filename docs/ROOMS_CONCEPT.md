# Rooms Concept (Future Architecture)

**Status**: Exploration only. Not planned for MVP. Revisit when session accumulation becomes a real problem.

## Problem Statement

Current session model:
- One implicit session per user
- Auto-creates when 2+ people detected on same video
- Persists and grows (no cleanup)
- Creates accumulation problem in decentralized system (no server to coordinate expiration)

## Proposed Solution: Rooms

Rooms are **explicit, intentional groups** that users create and manage, replacing the implicit auto-created sessions.

### Core Model

```typescript
Room = {
  room_id: string,
  members: string[],  // persistent list of UUIDs
  created_at: number,
  archived: boolean,
  messages: Message[]
}
```

### Key Characteristics

- **Explicit creation**: Users create rooms either in advance (invite) or opportunistically (from overlay)
- **Multiple concurrent**: User can have many rooms active at once (solves 1-session-per-user constraint)
- **User-controlled lifecycle**: Create, Preserve (archive), Remove (delete)
- **Messaging is room-scoped**: Messages automatically go to room members, no ambiguity
- **Activity publishing independent**: Activity still publishes to Nostr, but overlay shows based on room membership

### Creation Flows

**Opportunistic** (from overlay):
```
Two people watching same video
→ "Create Room with Bob?"
→ Room created, both in it, overlay persists through divergence
```

**Planned** (from settings):
```
Settings → "Create Room"
→ Enter name, invite members via code/link
→ Room exists, awaiting others to join
```

### State Management

**Active Room**: 
- Member is watching or has activity < 7 days old
- Overlay visible
- Accepts new messages

**Archived Room**:
- "Preserve" action taken, or no activity for N days
- Kept in storage for history
- Overlay hidden
- Can be reactivated

**Removed Room**:
- User clicked "Remove"
- Deleted from local storage
- No recovery

### Decentralized Sync

- Room metadata published to Nostr (so members know it exists)
- Messages published to Nostr, scoped to room_id
- No coordination needed (each user independently decides to create/remove)
- Natural expiration: if all members remove, room vanishes from all clients

### Comparison: Sessions vs Rooms

| Aspect | Sessions | Rooms |
|--------|----------|-------|
| Creation | Auto, on co-watch detection | Explicit, user-initiated |
| Scope | One per user | Multiple per user |
| Persistence | Implicit, permanent | Explicit, user-controlled |
| Expiration | Auto-cleanup on idle (coordination problem) | Manual delete (no sync issues) |
| Messaging | Activity-scoped | Room-scoped |
| Decentralized? | Problematic (no server to decide expiration) | Clean (explicit delete is local-only) |

### Implementation Complexity

**High** (~3-4 weeks):
- Storage refactor (sessions → rooms)
- New Nostr event types for room state
- Overlay logic rewrite (activity-detection → room-based)
- Message routing refactor
- Settings UI for room management
- Backward compat handling

### When to Revisit

- When single sessions start accumulating 20+ people
- When users complain about clutter/stale groups
- When MVP usage patterns become clear
- When activity-based visibility proves insufficient

### Alternative: Simpler Approach (Current Direction)

Keep implicit sessions, but hide old ones (activity < 7 days).
- Solves clutter without refactor
- Decentralized (no expiration coordination)
- Same UX benefit (overlay doesn't feel cluttered)
- Revisit Rooms if this breaks down

---

**Proposal**: Document this for future reference, validate simpler approach first.
