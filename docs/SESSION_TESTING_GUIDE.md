# Session Model & Co-Watch Testing Guide

## 1. Automated Test Suite

Hang Time contains over 290 automated unit and integration tests executing in `vitest`:

```bash
# Run the complete test suite
cmd /c npm run test:run

# Run specific domain test suites
cmd /c npx vitest run src/modules/__tests__/session-model.test.ts
cmd /c npx vitest run src/modules/__tests__/dnd-mode.test.ts
cmd /c npx vitest run src/modules/__tests__/game-library.test.ts
cmd /c npx vitest run src/modules/__tests__/metadata-fetcher.test.ts
cmd /c npx vitest run src/ui/__tests__/games.test.ts
```

---

## 2. Dual-Browser Manual Testing Setup

Manual verification requires two distinct browser instances representing two friends (**User A / test2** and **User B / test3**):

### 2.1 Launching Test Instances

Use distinct Chrome/Edge profiles so storage and Nostr keys do not collide:

```bash
# Launch Dual Instance Runner (Edge / Chrome)
npm run dev:dual
```

Or manually:
```bash
# Instance 1 (User A)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\tmp\chrome-profile-a" "chrome-extension://<EXT_ID>/popup.html"

# Instance 2 (User B)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\tmp\chrome-profile-b" "chrome-extension://<EXT_ID>/popup.html"
```

---

## 3. Core Test Scenarios

### Scenario 1: Initial Co-Watching (Host Mode)
1. **User A** opens YouTube video `https://www.youtube.com/watch?v=dQw4w9WgXcQ`.
2. **User B** navigates to the same YouTube video.
3. **Verify**:
   - Within 5 seconds, `#hang-time-overlay` mounts on both tabs.
   - User A (earlier timestamp) is designated Host.
   - User B sees the host position marker arrow on the progress bar.
   - Messages sent from either user appear in the overlay chat.

### Scenario 2: Divergence & Rejoining (Guest Mode)
1. Both users are co-watching video A.
2. **User B** navigates to YouTube video B.
3. **Verify**:
   - The session remains active on both browsers.
   - User A's overlay switches to **Mode B (Divergence / Guest Mode)** showing "Choose Next" and User B's new video title.
   - User A clicks the `[Join]` button on User B's card.
   - User A's browser navigates to video B.
   - Both overlays immediately transition back to **Mode A (Host Mode)**.

### Scenario 3: Do Not Disturb (DND) / Solo Mode
1. **User A** clicks the DND toggle button in the popup header (`⛔ Do Not Disturb`).
2. **Verify**:
   - Any active session on User A's browser is immediately terminated.
   - User A's overlay unmounts.
   - User B's overlay removes User A or terminates if User A was the only other member.
   - In User B's friends list, User A's badge displays `⛔ DND`.
   - User B cannot invite User A and the Join button (`▶`) is grayed out/inactive.

### Scenario 4: Steam Game Discovery & Library Comparison
1. In the popup, navigate to the **Games** tab.
2. Enter Steam ID and configure API key in Settings.
3. **Verify**:
   - Owned games load with English genres, categories, and cover artwork.
   - Multi-player games shared by friends display friend owner count chips.
   - Filters (e.g. Action, Co-op) and Sorting (Most friends own it, Score) function smoothly.
   - Clicking `[Invite]` opens the invite modal.
