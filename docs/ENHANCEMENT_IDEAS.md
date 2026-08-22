# Hang Time - Enhancement Ideas (Pre-Discussion)

## Status

Unlike `GAMING_EXPANSION_ROADMAP.md` and `BROWSER_PLATFORMS_ROADMAP.md`, nothing here is scoped or phased yet. These are proposals surfaced while auditing those two docs (2026-08-22) — each needs a design discussion before it earns a checklist and a phase. Listed as: the problem it solves, a rough approach sketch, and the open questions that need answers first. Do not start implementation from this doc directly; convert an idea to a proper roadmap doc (or a section in an existing one) once it's been discussed.

---

## 1. Encrypted Self-Backup & Restore

**Problem**: All data is `chrome.storage.local`-only (per the Storage Abstraction invariant). There is currently no way to move to a new browser or device without losing your identity, friend list, and message history. This is a reliability gap, not just a nice-to-have — one browser profile wipe and a user's entire social graph on Hang Time is gone.

**Sketch**: Periodically publish an encrypted-to-self snapshot (NIP-44, encrypted to the user's own pubkey) of friend list, settings, and identity to relays via the existing `publishQueue`. On fresh install, offer a "restore from backup" flow that fetches and decrypts the latest snapshot.

**Open questions**:
- What's in scope for the snapshot — friend list + identity only, or messages/activity history too (size/relay-limit implications)?
- Backup cadence and triggering (on every friend-list change? periodic like game library's 6-hour cycle?).
- Restore UX: how does a user prove "this is still my identity" without a password/passphrase to derive/protect the key?
- Does this need a new event kind, and if so, same collision-avoidance care as the LFG beacon kind issue (check the NIPs registry first).

---

## 2. Reactions (NIP-25)

**Problem**: The only way to acknowledge a friend's activity is opening a full chat thread. `types.ts:292` already has a comment reserving space for "chat, reactions, etc." — this was anticipated in the type design but never built.

**Sketch**: Lightweight emoji react on a friend's currently-playing/active card, published as a standard NIP-25 kind-7 reaction event referencing the friend's activity event id.

**Open questions**:
- Which activity events are reactable (all kind-1 activity broadcasts, or only ones from friends)?
- Where does the reaction render — card overlay, popup, both?
- Does this need rate-limiting/dedup consideration in the publish queue like other event types?

---

## 3. Scheduled Hangs (NIP-52 Calendar Events)

**Problem**: Everything today is live-presence-only — there's no way to plan a co-watch/co-play session in advance ("Friday 8pm, we're doing X"). Friend groups routinely need to coordinate ahead of time, not just react to who's currently online.

**Sketch**: Use NIP-52 time-based calendar events for "planned hangs." Friends RSVP over Nostr; a local notification fires near start time. Could optionally attach a game/activity and a Discord voice link, similar to the LFG beacon concept in the gaming roadmap.

**Open questions**:
- Relationship to the LFG Beacon idea in `GAMING_EXPANSION_ROADMAP.md` §8 — same feature from two angles (ad-hoc "join now" vs. planned "join later")? Should they share infrastructure?
- RSVP state tracking — same client-side state-tracking pattern as `PendingInvite`?
- How far ahead can events be scheduled, and how are stale/past events cleaned up locally?

---

## 4. User-Configurable Relay List

**Problem**: Relay URLs are currently hardcoded (confirmed in `src/modules/nostr.ts` — `connect(relayUrls: string[])` is called with a fixed list, no settings-driven source found). For a tool whose pitch is decentralization, users have no actual control over which relays they trust or depend on.

**Sketch**: Add a relay list section in Settings — add/remove/reorder relays, with the current hardcoded list as sane defaults.

**Open questions**:
- Minimum relay count to enforce (avoid a user footgunning themselves to zero relays)?
- Does removing a relay need to trigger resubscription/backfill from remaining relays, or just apply going forward?
- Validation — do we check reachability before adding, and if so, is that where `nip11-relay-info.ts` (see idea 5) plugs in?

---

## 5. Relay Health Visibility

**Problem**: `src/modules/nip11-relay-info.ts` already exists and parses NIP-11 relay metadata, but no settings UI surfaces it — this is unused infrastructure. Users currently have no visibility into whether their relays are connected, degraded, or silently failing.

**Sketch**: Small connection-status indicator per relay in Settings (connected / degraded / unreachable), backed by the existing NIP-11 module and `RelayConnection` reconnection logic.

**Open questions**:
- Is this purely a settings-page display, or does it also drive user-facing warnings elsewhere (e.g. "friends list may be stale — relay disconnected")?
- Natural pairing with idea 4 (configurable relays) — worth scoping as one settings-panel feature rather than two?

---

## 6. Shared Queue for Co-Watch Sessions

**Problem**: The Session Model (`docs/SESSION_MODEL.md`) already persists a group through divergence, but there's no way for the group to collaboratively line up "what's next" — it's one video at a time with no shared planning.

**Sketch**: Add a queue array to session state; any co-watcher can add/reorder items; host (or whoever's driving) advances to the next item.

**Open questions**:
- Interacts with the existing host-election / `contentTimestamp` logic — does adding a queue change who's considered host, or is it orthogonal?
- Per-platform feasibility — a queue makes sense for YouTube/Twitch but is murkier for Netflix (no direct-link-to-episode deep linking in all cases).
- Does this belong in Session Model state (background-owned) or overlay state (ephemeral)? Per the Phase 9 state-ownership split, this looks like background-owned persistent state.

---

## 7. Ephemeral Room Links for Non-Friends

**Problem**: Vote-based consensus joining for non-friends already exists (see `[[cowatch_join_mechanics]]`-style flow), but it requires the non-friend to already be discoverable/connectable. There's no lightweight way for two people who aren't Nostr-friends yet to spin up a session together (e.g. sharing a link in a Discord server or group chat outside Hang Time).

**Sketch**: Generate a one-time shareable link/code that, when opened by someone with the extension installed, joins them into the session directly — skipping the friend-request round trip.

**Open questions**:
- Security/spam surface — what stops a leaked link from letting strangers join indefinitely? Expiry, single-use, or both?
- Does joining via link create a temporary/scoped friend relationship, or is it session-only with no persistent friend record?
- How does this interact with the existing 100%-consensus requirement for non-friend joins — does link-joining bypass that vote, or still require it?

---

## 8. `chrome.idle`-Based Away Status

**Problem**: Presence is currently purely activity-detection-driven — a friend can show as "active" on a service even if they've stepped away from the keyboard.

**Sketch**: Use the `chrome.idle` extension API to detect browser-level inactivity and reflect an "away" state distinct from "active"/"offline."

**Open questions**:
- Idle threshold — what counts as "away" (Chrome's API supports configurable thresholds, default 60s)?
- Does "away" suppress activity broadcast entirely, or just add a visual indicator while still broadcasting?

---

## 9. On-Device AI Recap (Speculative)

**Problem/Opportunity**: When rejoining a session or coming back online, there's no quick way to catch up on what was discussed or played without scrolling full chat history.

**Sketch**: Use Chrome's built-in Prompt API (Gemini Nano, on-device) to generate a short local summary of session activity/chat while the user was away. Nothing leaves the browser, consistent with the privacy model.

**Open questions**:
- This API is experimental/behind flags as of last check — availability and stability need re-verification before any real scoping.
- Fallback behavior for users without the API available (older Chrome, Firefox, unsupported hardware)?
- Worth treating as an optional, clearly-labeled experimental feature rather than a dependency for core functionality.

**Status**: Lower confidence than the rest of this doc — treat as a bet to revisit, not a near-term idea.

---

## 10. Lightning Zaps (NIP-57) (Speculative)

**Problem/Opportunity**: No current way to act on Nostr-native monetary primitives during a co-watch session (e.g. tipping a Twitch streamer everyone's watching together).

**Sketch**: Optional zap button surfaced when co-watching a stream, using NIP-57 zap requests/receipts against the streamer's Nostr-linked lightning address (where one exists).

**Open questions**:
- Real user demand unclear — this is more "cool if someone's excited about it" than a solved user problem.
- Requires the streamer to have a Nostr identity + lightning address linked, which most Twitch streamers won't have — coverage would likely be low.
- Wallet/lightning integration adds a meaningfully different trust and security surface than anything else in this doc; would need its own dedicated security review before any implementation.

**Status**: Niche differentiator, not a roadmap candidate without clearer signal.

---

## Cross-Cutting Note

Ideas 2–5 all sit on top of Nostr primitives that are either already partially built (reactions type reservation, NIP-11 parsing) or natural extensions of existing patterns (`publishQueue`, `PendingInvite` state tracking). Ideas 1 and 3 overlap conceptually with existing/planned work (backup touches identity/storage invariants directly; scheduled hangs overlaps the LFG beacon in the gaming roadmap) — worth discussing those pairs together rather than in isolation.
