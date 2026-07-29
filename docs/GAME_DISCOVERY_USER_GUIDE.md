# Game Discovery User Guide

Complete guide to using the Hang Time Game Discovery feature to find and discover games your friends own.

---

## What is Game Discovery?

Game Discovery allows you to:
- See all games your friends own on Steam
- Find common games you own with friends
- Filter and sort to find what to play together
- Get recommendations based on friend libraries

**Privacy**: Your game library is published encrypted via Nostr. Only your friends can see which games you own.

---

## Getting Started

### Enable Game Discovery

1. Open Hang Time extension
2. Click **Settings** (gear icon)
3. Scroll to "Game Discovery"
4. Toggle **Enable Game Discovery** to ON
5. Configure Steam API key (if not already set)

### Configure Steam

1. Go to [Steam Web API Key page](https://steamcommunity.com/dev/apikey)
2. Copy your API key
3. Paste in Hang Time settings
4. Click **Save**
5. Your library will automatically sync

### Add Friends

1. In the Friends tab, click **Add Friend**
2. Enter your friend's memorable identifier (e.g., "TenaciousTiger42")
3. Click **Add**
4. Friend's library appears in Discovery tab (if they have Game Discovery enabled)

---

## Using the Discovery Tab

### View Your Library

The Discovery tab shows your own Steam game library first. As you add friends, their libraries appear below.

**What you see**:
- Game name and thumbnail
- Genres and game modes
- Metacritic score (if available)
- Number of friends who also own it
- Platform availability (Windows/Mac/Linux)

### Browse by Friend

Expand a friend's section to see only their games. Common games are highlighted.

To expand/collapse:
- Click friend name
- Scroll within friend's library

---

## Filtering Games

### Filter Panel

Click **🔽 Filters** button to open filter panel.

### By Genre

Check multiple genres. Only games with **any** selected genre will show (OR logic).

**Available genres**:
- Action
- Adventure
- Strategy
- RPG
- Puzzle
- Shooter
- Indie
- Simulation
- Sports
- Racing

**Example**: Selecting "Action" and "RPG" shows action games OR RPG games.

### By Game Mode

Check gameplay types you're interested in.

**Available modes**:
- Single-player
- Multiplayer
- Co-op
- Online PvP
- Free to Play

**Example**: Selecting "Multiplayer" and "Co-op" shows games you can play together.

### By Playtime

Choose a timeframe for which games to show.

**Options**:
- **All time**: Shows all your games
- **This month**: Shows games you played in the last 30 days
- **This week**: Shows games you played in the last 7 days
- **Today**: Shows games you played today

**Use case**: Pick "This month" to focus on games you actively play.

### Combine Filters

Filters work together (AND logic):
- Filter by: Action games (genre)
- Filter by: Multiplayer (mode)
- Filter by: This month (playtime)

**Result**: Action multiplayer games you played this month

### Remove Filters

**Remove single filter**:
- Click the X on a filter chip

**Clear all filters**:
- Click **Clear all** button in filter panel

### Filter Chips

Active filters display as chips above the games list.

---

## Sorting Games

Click the **Sort** dropdown to change sort order.

### Most Friends Own It

Games sorted by number of friends who own them. Great for finding games to play together.

**Sorting order**: Most friends → least friends

**Use case**: "What should we all play together?"

### Highest User Score

Games sorted by Metacritic score (highest first). Find the best-rated games.

**Sorting order**: 95 → 50 → (no score)

**Note**: Games without Metacritic scores appear at bottom.

**Use case**: "What's worth playing?"

### Most Recently Played

Games sorted by when you last played them. Recent games appear first.

**Sorting order**: Played today → played last week → never played

**Use case**: "What was I playing?"

**Note**: Requires game activity tracking.

### Alphabetical

Games sorted A-Z by name.

**Sorting order**: A → Z

**Use case**: "Find a specific game quickly"

---

## Finding Common Games

Games that you AND a friend both own are highlighted with a **🎮 You own** badge.

To find common games:
1. Select one friend's library (expand their section)
2. Filter by genres/modes you both enjoy
3. Look for the **🎮 You own** badge
4. These are games you can play together!

**Pro tip**: Sort by "Highest User Score" to find the best common games.

---

## No Games Showing?

### "Configure Steam"

**Problem**: You haven't configured your Steam API key yet.

**Solution**:
1. Click "Configure Steam"
2. Follow the setup instructions
3. Return to Discovery tab

### "Loading..."

**Problem**: Discovery tab is fetching your game library or metadata.

**Solution**:
1. Wait for loading to complete
2. Games appear progressively
3. Check your internet connection

### "No friend libraries yet"

**Problem**: None of your friends have Game Discovery enabled.

**Solution**:
1. Ask friends to enable Game Discovery in their Hang Time settings
2. Wait for their libraries to sync (can take a few minutes)
3. Refresh the popup

### "No games match your filters"

**Problem**: No games match the filters you've applied.

**Solution**:
1. Click **Clear all** to remove filters
2. Check you have friends added
3. Check friends have games that match your criteria

---

## Settings

### Enable/Disable Game Discovery

Toggle in Settings → Game Discovery

**When enabled**:
- Your library is published to friends
- You can see friend libraries
- Background fetching of metadata

**When disabled**:
- Your library stops being published
- Discovery tab hides
- No background activity

### Notification Preferences

In Settings → Notifications:
- Friend library updated
- Common game discovered
- Metadata fetch complete

### Clear Cache

In Settings → Data Management:
- **Clear Game Discovery Cache**: Removes all cached game data (forces fresh fetch)
- **Clear Metadata Cache**: Removes cached game metadata
- **Clear Friend Libraries**: Removes cached friend libraries

**Use case**: If data seems out of date or you want to free up storage.

---

## Privacy & Security

### What's Shared

**Publicly (encrypted Nostr)**:
- Your game library (list of app IDs only)
- Friend relationships
- Basic metadata from Steam

**Not shared**:
- Your Steam username
- Personal game statistics
- Friends-only games (handled separately)
- Payment information
- Account details

### Who Can See

- **Your friends**: Can see your game library (if Discovery enabled)
- **Others**: Cannot see your library
- **Nostr network**: Sees encrypted data (cannot read without your key)

### Data Storage

- Games cached locally in IndexedDB
- Metadata cached for 30 days
- Friend libraries cached for 7 days
- All data cleared if you disable Discovery

---

## Troubleshooting

### Discovery Tab Missing

**Problem**: Don't see "Discovery" tab in popup.

**Solution**:
1. Check Settings: Is Game Discovery enabled?
2. Close and reopen popup
3. Check that friends are added
4. Restart browser

### Games Loading Very Slowly

**Problem**: Metadata taking a long time to appear.

**Solution**:
1. Wait longer (depends on your library size and internet speed)
2. Check internet connection speed
3. Close other apps using bandwidth
4. Check Steam API status

### Friend Libraries Not Appearing

**Problem**: Added friends, but don't see their games.

**Solution**:
1. Check friend has Game Discovery enabled (ask them)
2. Wait a few minutes for library to sync
3. Refresh popup (close and reopen)
4. Check internet connection to Nostr relays
5. Try re-adding the friend

### Filter/Sort Not Working

**Problem**: Filters or sort dropdown not responding.

**Solution**:
1. Close and reopen popup
2. Check browser console for errors
3. Clear Discovery cache in Settings
4. Restart browser

### Too Many Games Showing

**Problem**: Filter showing unexpected results.

**Solution**:
1. Check filter logic (multiple selections = OR, not AND)
2. Click **Clear all** to reset
3. Apply filters one at a time to debug
4. Check if metadata loaded correctly

### Steam API Error

**Problem**: "Steam API Error" message.

**Solutions**:
- **"Invalid API key"**: Check your key in Settings
- **"API limit exceeded"**: Wait 1 minute and try again
- **"Service unavailable"**: Steam API is down, wait and retry

### Out of Storage

**Problem**: "Out of storage space" error.

**Solution**:
1. Go to Settings → Data Management
2. Click **Clear Game Discovery Cache**
3. If still full, clear old friend libraries
4. Consider removing low-priority games from Steam

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `F` | Focus filters |
| `S` | Focus sort dropdown |
| `C` | Clear all filters |
| `/` | Focus search (if available) |
| `Esc` | Close filter panel |

---

## Tips & Tricks

### Find Games to Play Together

1. Add your friend to Hang Time
2. Open Discovery tab
3. Click their library
4. Sort by "Highest User Score"
5. Look for games you both own (🎮 badge)
6. Pick the highest-rated common game
7. Send them a message: "Let's play [game]!"

### Discover New Games

1. Check "Most friends own it" sort
2. Filter by genres you like
3. Look at games with high friend count
4. Check their score
5. Add to wishlist if interested

### Quick Genre Browse

1. Click **Filters**
2. Check one genre
3. Sort by score
4. See top-rated games in that genre

### Mobile Use

1. Responsive design works on mobile
2. Games scroll vertically
3. Filters wrap to new lines
4. All features available
5. Touch-friendly buttons

### Browser Extensions

**Other tabs**: You can keep Discovery tab open while browsing, send messages to friends about games.

**Comparison**: Open friend's profile + Discovery side-by-side to compare libraries.

---

## FAQ

**Q: How often does my library update?**  
A: Automatically every 7 days, or manually by clicking "Refresh Library"

**Q: Can I see friend libraries if they don't have Steam configured?**  
A: No, they must set up Steam API key first

**Q: What if a friend removes me?**  
A: Their library remains cached for 7 days, then clears

**Q: Can I hide certain games from friends?**  
A: Yes, in Friends tab: click friend → "Hide services" → Steam

**Q: Does this affect my Steam privacy settings?**  
A: No, Game Discovery uses your own API key and respects Steam privacy

**Q: Can I export my game list?**  
A: Currently no, but you can take screenshots

**Q: Will this slow down my browser?**  
A: No, runs in background with minimal overhead

**Q: Can I filter by price?**  
A: Not currently, but metadata includes Steam store URL

**Q: What if my library is huge (1000+ games)?**  
A: All features work, but may load slightly slower. Filtering/sorting optimized.

**Q: Can I sync game achievements?**  
A: No, only game libraries currently

---

## Feedback & Support

### Report Bugs

1. Open Chrome DevTools (F12)
2. Check Console tab for errors
3. Report issue on GitHub with:
   - Browser version
   - Steps to reproduce
   - Console errors
   - Screenshots

### Suggest Features

1. Open an issue on GitHub
2. Describe the feature
3. Explain the use case
4. Vote on existing feature requests

### Need Help?

1. Check this guide
2. Check troubleshooting section
3. Check FAQ
4. Open an issue on GitHub

---

**Last Updated**: 2026-07-28  
**Version**: 1.0.0  
**Compatible Browsers**: Chrome 90+, Firefox 91+, Edge 90+
