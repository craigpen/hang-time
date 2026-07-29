# Game Discovery Manual Test Checklist

Complete end-to-end manual testing for Hang Time Game Discovery feature.

## Setup Instructions
1. Ensure extension is built: `npm run build`
2. Load extension in Chrome: chrome://extensions > Load unpacked > dist/chrome
3. Configure Steam API key in settings
4. Add test friends to the friends list
5. Ensure friends have published their game libraries to Nostr relays

---

## Core Features

### Initial Setup and Configuration
- [ ] Extension loads without errors
- [ ] Settings page accessible from popup
- [ ] Steam API key configuration saves successfully
- [ ] Steam library fetches successfully (visible in Discovery tab)
- [ ] Steam library publishes to Nostr relays
- [ ] Console has no errors during setup

### Discovery Tab Display
- [ ] Discovery tab appears in popup
- [ ] Tab displays own game library initially
- [ ] Games display with thumbnails and metadata
- [ ] Game count matches Steam library size
- [ ] Loading states show while fetching metadata
- [ ] No games show "Configure Steam" prompt works

### Friend Libraries Display
- [ ] Friend libraries appear when received from Nostr
- [ ] Friend name displays correctly
- [ ] Game count for friend displays correctly
- [ ] Friend games appear progressively as metadata loads
- [ ] Offline friends' cached libraries still display
- [ ] Old cached libraries clear after expiration (7 days)

### Filtering: Genre
- [ ] Filter dropdown shows all available genres
- [ ] Single genre filter works (only games with that genre show)
- [ ] Multiple genre filter works (OR logic: games with any selected genre)
- [ ] Filter chip appears for each selected genre
- [ ] Removing genre chip updates results immediately
- [ ] "Clear all filters" removes all genre filters
- [ ] Filter state persists after popup reload

### Filtering: Game Mode
- [ ] Filter dropdown shows all available modes
- [ ] Single mode filter works (Multiplayer / Co-op / Single-player)
- [ ] Multiple mode filter works (OR logic)
- [ ] Mode chips appear correctly
- [ ] Combined genre + mode filters work together (AND logic)
- [ ] Mode filter persists across sessions

### Filtering: Playtime
- [ ] Playtime radio buttons show all options (All time / This month / etc)
- [ ] "All time" shows all games
- [ ] "This month" shows only recently played games
- [ ] Filter applies correctly without clearing other filters
- [ ] Playtime filter persists correctly

### Sorting: By Friend Count
- [ ] "Most friends own it" sorts by number of friends with game
- [ ] Game owned by 3 friends appears before game owned by 2 friends
- [ ] Sorting updates immediately when filter changes
- [ ] Sort order persists after popup reload

### Sorting: By Score (Metacritic)
- [ ] "Highest user score" shows highest Metacritic scores first
- [ ] Games without Metacritic score appear at bottom
- [ ] Sorting handles games with different score ranges
- [ ] Sort updates after metadata loads

### Sorting: By Recently Played
- [ ] "Most recently played" shows games by last playtime
- [ ] Recently played games appear first
- [ ] Old games appear last
- [ ] Sort works with playtime filter applied

### Sorting: Alphabetical
- [ ] "Alphabetical" sorts A-Z by game name
- [ ] Special characters handled correctly
- [ ] Case-insensitive sorting works
- [ ] Sort updates immediately

### Filter Chips and Display
- [ ] Active filter chips show under filter button
- [ ] Each chip has visible X button
- [ ] Clicking X removes that filter
- [ ] Multiple chips display inline without wrapping
- [ ] "Clear all" button appears when filters active
- [ ] Chips update immediately when filters change

### Large Library Handling
- [ ] Library with 500+ games loads without crash
- [ ] UI remains responsive with large libraries
- [ ] Scrolling is smooth
- [ ] Filtering large libraries completes in <500ms
- [ ] Sorting large libraries completes in <500ms
- [ ] Memory usage doesn't spike excessively

### Metadata Progressive Loading
- [ ] Games appear without metadata (placeholder)
- [ ] Metadata loads progressively in background
- [ ] Metadata appears in games without reload
- [ ] UI remains responsive during metadata load
- [ ] High-priority games (friends) load metadata first
- [ ] Background fetcher doesn't block UI

### Friend List Updates
- [ ] Adding friend updates Discovery tab
- [ ] Removing friend updates Discovery tab immediately
- [ ] New friend's library fetches automatically
- [ ] Removed friend's library still cached until expiration

### Network Interruption and Recovery
- [ ] Temporarily disconnect internet
- [ ] Discovery tab still shows cached data
- [ ] Friend libraries remain displayed
- [ ] Metadata for cached games displays
- [ ] Reconnect internet
- [ ] App automatically fetches fresh data
- [ ] No crashes or console errors

### Nostr Relay Connection Loss
- [ ] Simulate relay connection loss
- [ ] Friend libraries from last sync still visible
- [ ] UI shows loading/stale indicator
- [ ] Relay reconnects automatically
- [ ] Fresh friend libraries fetch when reconnected
- [ ] No console errors during disconnect/reconnect

### Steam API Temporary Outage
- [ ] Steam API returns 503 temporarily
- [ ] Library still displays from cache
- [ ] Error message shows (if applicable)
- [ ] Automatic retry happens in background
- [ ] Steam API comes back online
- [ ] Fresh data fetches successfully
- [ ] No user intervention required

### Metadata Fetch Queue
- [ ] Queue processes games in priority order
- [ ] UI doesn't freeze while processing queue
- [ ] Games with more friends get priority
- [ ] Background processing continues across tabs
- [ ] Failed fetches retry with exponential backoff
- [ ] Max retries limit prevents infinite loops

### Settings Toggle
- [ ] Enable/disable Game Discovery in settings
- [ ] Disabled state stops library publishing
- [ ] Disabled state stops fetching friend libraries
- [ ] Discovery tab disabled/grayed out when off
- [ ] Re-enabling resumes normal operation
- [ ] No errors when toggling on/off

### Dark Theme UI
- [ ] Dark theme applies to Discovery tab
- [ ] Game cards readable in dark mode
- [ ] Filter buttons visible and clickable
- [ ] Chips display correctly
- [ ] Metadata text readable
- [ ] No harsh contrast or unreadable text

### Light Theme UI
- [ ] Light theme applies to Discovery tab
- [ ] Game cards readable in light mode
- [ ] Filter buttons visible and clickable
- [ ] Chips display correctly
- [ ] Metadata text readable
- [ ] No harsh contrast or unreadable text

### Mobile/Responsive UI
- [ ] Set viewport to mobile size (375x812)
- [ ] Discovery tab displays without horizontal scroll
- [ ] Filter button remains accessible
- [ ] Game cards stack vertically
- [ ] Chips wrap to next line if needed
- [ ] Text remains readable at mobile size
- [ ] Scroll performance acceptable

### Tablet Responsive UI
- [ ] Set viewport to tablet size (768x1024)
- [ ] Grid layout shows 2+ columns
- [ ] Filter controls accessible
- [ ] Game cards display nicely
- [ ] All functionality works
- [ ] No unnecessary scrolling

### Performance: First Load
- [ ] Measure time to display Discovery tab first time
- [ ] Should complete in <1000ms
- [ ] Loading indicator shows during fetch
- [ ] User can see content as it loads

### Performance: Filter/Sort
- [ ] Measure time to filter/sort 500+ games
- [ ] Should complete in <300ms
- [ ] UI remains responsive during filter
- [ ] No stutter or jank in animation

### Performance: Metadata Refresh
- [ ] Measure time to fetch 100 metadata entries
- [ ] Background fetcher keeps UI responsive
- [ ] CPU usage remains under 20%
- [ ] No memory leaks after hour of operation

### Memory Usage
- [ ] Check memory usage with 500 games + metadata
- [ ] Should not exceed 50MB
- [ ] Memory stable after filtering multiple times
- [ ] No memory leaks after toggling settings on/off

### Security: No Credential Leaks
- [ ] Steam API key never appears in Nostr events
- [ ] Steam user ID not exposed to friends
- [ ] Personal game library not leaked to non-friends
- [ ] Network tab shows no credential leaks

### Security: Safe DOM Operations
- [ ] Game names from API don't cause XSS
- [ ] User input in search doesn't cause XSS
- [ ] Friend names displayed safely
- [ ] Console has no security warnings

### Backwards Compatibility
- [ ] Existing Friends tab still works
- [ ] Existing activity detection unaffected
- [ ] Existing settings unchanged
- [ ] Old user profiles migrate gracefully
- [ ] No type errors in console

---

## Browser Compatibility

### Chrome Testing
- [ ] Discovery tab renders correctly
- [ ] All filters work
- [ ] Sorting works
- [ ] Theme toggle works
- [ ] Responsive design works
- [ ] No console errors
- [ ] Performance acceptable

### Firefox Testing
- [ ] Discovery tab renders correctly
- [ ] All filters work
- [ ] Sorting works
- [ ] Theme toggle works
- [ ] Responsive design works
- [ ] No console errors
- [ ] Performance acceptable

### Edge Testing
- [ ] Discovery tab renders correctly
- [ ] All filters work
- [ ] Sorting works
- [ ] No console errors

---

## Edge Cases

### Empty States
- [ ] No games owned: shows helpful message
- [ ] No metadata cached yet: shows loading, then appears
- [ ] No friends with libraries: shows empty friend section
- [ ] All friends removed: Discovery tab shows nothing
- [ ] No common games with friend: search returns nothing

### Large Result Sets
- [ ] 200+ games from single search: renders all
- [ ] 5+ friends with 100+ common games: responsive
- [ ] Sorting 500 games: completes in <500ms
- [ ] Filtering 500 games: completes in <300ms

### Concurrent Operations
- [ ] Changing filters while metadata loading: correct results
- [ ] Adding friend while friend libraries loading: no crash
- [ ] Toggling settings while background fetching: no crash
- [ ] Multiple tab/window open: no duplicate fetches

### Data Corruption
- [ ] Corrupted cache file: app handles gracefully
- [ ] Malformed Nostr event: ignored safely
- [ ] Partial Steam API response: displays available data
- [ ] Missing metadata fields: displays with fallbacks

### Boundary Conditions
- [ ] Game with 0 metacritic score: displays
- [ ] Game with extremely long name: truncates/wraps correctly
- [ ] Game with no genres: displays as "Unclassified"
- [ ] Game with 100 genres: displays limited set

---

## Regression Testing

### Friend Management
- [ ] Add friend still works
- [ ] Remove friend still works
- [ ] Rename friend still works
- [ ] Mute/unmute friend still works
- [ ] Friend activity still displays

### Activity Detection
- [ ] Spotify activity detection works
- [ ] Twitch activity detection works
- [ ] Steam activity detection works
- [ ] YouTube activity detection works
- [ ] Activity publishes to Nostr

### Messaging
- [ ] Send message to friend works
- [ ] Receive message from friend works
- [ ] Message history displays
- [ ] Unread count accurate

### Settings
- [ ] Settings page loads
- [ ] OAuth buttons work (Spotify/Twitch)
- [ ] Theme toggle works
- [ ] Notification settings work
- [ ] Service toggles work

---

## Documentation Review

- [ ] User guide is clear and complete
- [ ] Architecture summary is accurate
- [ ] API documentation is comprehensive
- [ ] Troubleshooting guide covers common issues
- [ ] Examples are working and clear

---

## Final Sign-Off

**Tester**: ________________  
**Date**: ________________  
**All tests passed?** YES / NO  
**Known issues**: 

---

**Notes**:
- Record any crashes or unexpected behavior
- Time performance-critical operations
- Test with real friend accounts if possible
- Check console regularly for errors
- Take screenshots of any visual issues
- Document steps to reproduce any bugs

**Performance Targets**:
- Discovery tab first load: < 1 second
- Filter/sort 500 games: < 300ms
- Metadata fetch for 100 games: < 5 seconds
- Memory usage: < 50MB
- CPU usage: < 20% during background fetch

**Test Environment**:
- Browser: Chrome / Firefox / Edge
- OS: Windows 10/11 / macOS / Linux
- Connection: [Network type and speed]
- Friend count: [Number of friends with libraries]
- Game library size: [Number of owned games]
