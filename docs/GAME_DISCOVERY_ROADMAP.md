# Game Discovery Roadmap

Future enhancements and improvements for the Hang Time Game Discovery feature.

---

## Phase 1: Game Discovery (Complete ✓)

**Status**: Complete - 2026-07-28

### Implemented Features
- [x] Fetch game library from Steam API
- [x] Publish library to Nostr relays
- [x] Subscribe to friend game libraries
- [x] Calculate common games
- [x] Filter by genres, modes, playtime
- [x] Sort by friend count, score, time, alphabetical
- [x] Progressive metadata loading
- [x] Metadata caching (30-day TTL)
- [x] Background queue processing
- [x] Rate limiting (1.5 req/sec)
- [x] Error handling and recovery
- [x] UI with dark/light theme
- [x] Responsive design
- [x] 100+ comprehensive tests
- [x] Full documentation

**Metrics**:
- Code: 3,500+ lines
- Tests: 100+ tests
- Coverage: >90%
- Performance: All targets met

---

## Phase 2: Game Activity & Playtime (Post-MVP)

**Timeline**: Q3 2026 (August-September)

### Goals
Track when friends are playing which games and show activity in real-time.

### Features

#### Game Activity Publishing
- [ ] Track game launch via Steam client API
- [ ] Publish game-activity events to Nostr (kind=30)
- [ ] Include playtime (current/total), achievement progress
- [ ] Update activity every 5 minutes
- [ ] Compress old activity events

**New Event Format**:
```json
{
  "kind": 30,
  "tags": [
    ["t", "game-activity"],
    ["appid", "570"],
    ["playtime", "120"],
    ["achievements", "15/50"]
  ],
  "content": "Playing Dota 2"
}
```

#### Game Activity Display
- [ ] Show "Friend is playing" badge in Discovery tab
- [ ] Activity history for each friend
- [ ] Time played this session / total time
- [ ] Progress on achievements
- [ ] "Join game" quick action
- [ ] Recent activity timeline view

#### Notifications
- [ ] Alert when friend starts playing common game
- [ ] "Let's play [game]" suggestion
- [ ] Achievement unlocked notification
- [ ] Game milestone (100 hours played) badge

### Implementation Details
- Extend Nostr event subscriptions to kind=30
- Activity datastore (similar to game library)
- Activity cleanup (remove >30 days old)
- Privacy: Hide activity if friend prefers

---

## Phase 3: Friend Activity Recommendations (Post-MVP)

**Timeline**: Q3 2026 (September-October)

### Goals
ML-based recommendations for what to play with friends.

### Features

#### Recommendation Algorithm
- [ ] Calculate recommendation score based on:
  - Number of friends who own game
  - Friend count who recently played
  - Average metacritic score
  - Genre preferences (based on library)
  - Recent activity patterns
  - Time since last played

**Score Formula**:
```
score = (friend_count * 0.4) + (recent_activity * 0.2) + (score/100 * 0.2) + (genre_preference * 0.2)
```

#### Recommendation UI
- [ ] "Recommended to play together" section
- [ ] Top 5-10 recommendations
- [ ] Reason for recommendation
- [ ] All friends rating (1-5 stars)
- [ ] "Add to wishlist" action
- [ ] Dismiss recommendation

#### Personalization
- [ ] Learn from user choices
- [ ] Adjust recommendations over time
- [ ] Genre preference weighting
- [ ] Playtime preferences (quick vs long)
- [ ] Multiplayer vs single-player
- [ ] Co-op vs competitive

### Implementation Details
- Recommendation engine in separate module
- Local ML model (no server needed)
- Privacy: Only uses local data
- Periodic update (hourly refresh)
- Caching of recommendations (1-hour TTL)

---

## Phase 4: Game Achievements Integration (Post-MVP)

**Timeline**: Q4 2026 (November-December)

### Goals
Display achievement progress and completion across friend group.

### Features

#### Achievement Tracking
- [ ] Fetch achievements from Steam API for each game
- [ ] Track achievement completion % per friend
- [ ] Show achievement list with icons
- [ ] Leaderboard of "most completed achievements"
- [ ] Achievement hunt challenges (get X achievement)

#### Achievement Sharing
- [ ] Publish achievement unlock events to Nostr
- [ ] Celebrate friend achievements (notification)
- [ ] Achievement comparison (friend A vs friend B)
- [ ] Achievement progress timeline

#### Gamification
- [ ] "Completion percentage" for each game
- [ ] Rarity: show how rare each achievement is
- [ ] Challenge friends to get specific achievement
- [ ] Leaderboard: who has most achievements unlocked

### Implementation Details
- Steam API: /ISteamUserStats/GetUserAchievements
- Achievement metadata caching
- Privacy: Only show if friend approved
- Rate limiting: Lower frequency than game updates

---

## Phase 5: Game Collections & Curation (Post-MVP)

**Timeline**: Q4 2026 (December-January)

### Goals
Create curated collections of games by theme or criteria.

### Features

#### Game Collections
- [ ] Create collections (e.g., "Co-op games", "Indie gems", "Quick games")
- [ ] Auto-populate from library based on criteria
- [ ] Manual game addition/removal
- [ ] Share collection with friends
- [ ] Vote on shared collections

#### Themed Collections
- [ ] System collections: Genre collections (Action, RPG, etc.)
- [ ] Time-based: "Games to play this month", "This week"
- [ ] Friend suggestions: "What friends recommend"
- [ ] Upcoming: "Wishlist", "To play next"

#### Discovery via Collections
- [ ] Browse collections by theme
- [ ] Filter games within collection
- [ ] Sort by various criteria
- [ ] Export collection list
- [ ] Print-friendly view

### Implementation Details
- Collection metadata stored in user profile
- Share via Nostr events (kind=31)
- Collaborative curation possible
- Cache collection memberships

---

## Phase 6: Voice Chat Integration (Post-MVP)

**Timeline**: Q1 2027 (February-March)

### Goals
Built-in voice coordination for gaming sessions.

### Features

#### Voice Chat Setup
- [ ] Discord integration: "Invite to Discord voice"
- [ ] Steam voice: Link to Steam voice channels
- [ ] Browser-based WebRTC (peer-to-peer)
- [ ] One-click setup for game sessions

#### In-Game Coordination
- [ ] Quick link to voice for common game
- [ ] Auto-join voice on game launch
- [ ] Voice chat UI overlay
- [ ] Screen share (experimental)
- [ ] Game audio routing (discord audio separate)

#### Session Management
- [ ] Create/join "game session" room
- [ ] Session persistence (survives game exit)
- [ ] Session history (when did we play together?)
- [ ] Scheduled sessions (calendar integration)

### Implementation Details
- WebRTC for peer-to-peer (if no Discord)
- Discord as primary option (existing integrations)
- Privacy: Only with opted-in friends
- Encryption: E2E for voice

---

## Phase 7: Cross-Platform Support (Future)

**Timeline**: Q2 2027 (April-May)

### Goals
Extend Game Discovery beyond Steam to other platforms.

### Features

#### Platform Support
- [ ] PlayStation Network integration
- [ ] Xbox Game Pass integration
- [ ] Epic Games Store
- [ ] GOG integration
- [ ] Itch.io support

#### Cross-Platform Discovery
- [ ] Cross-platform common games ("What we both own on any platform")
- [ ] Platform-specific filtering
- [ ] Multi-store search
- [ ] Platform comparison (same game, different prices)

#### Cross-Platform Play
- [ ] Show cross-play support status
- [ ] Filter by cross-play availability
- [ ] Highlight cross-platform titles
- [ ] Enable playing together across platforms

### Implementation Details
- Abstract platform adapters
- OAuth flow for each platform
- Unified game identifier system
- Cache management for multiple platforms

---

## Phase 8: Mobile App (Future)

**Timeline**: Q3 2027 (July-August)

### Goals
Native mobile apps for iOS and Android.

### Features

#### Core Features
- [ ] Full Game Discovery UI on mobile
- [ ] Friend library browsing
- [ ] Filter/sort functionality
- [ ] Offline mode (cached data)
- [ ] Push notifications

#### Mobile-Specific Features
- [ ] Camera input for friends (photo-based friend discovery)
- [ ] Barcode scanner (game UPC/QR code)
- [ ] Proximity discovery (friends nearby)
- [ ] Game reminders/notifications
- [ ] Share game recommendations via messaging

#### Cross-Device Sync
- [ ] Sync recommendations across devices
- [ ] Unified friend list
- [ ] Activity sync from mobile
- [ ] Bookmark/favorites sync

### Implementation Details
- React Native or Flutter for cross-platform
- Nostr SDK integration
- Local caching strategy
- Background sync service

---

## Phase 9: Analytics & Insights (Future)

**Timeline**: Q4 2027 (October-November)

### Goals
Provide insights into gaming habits and trends.

### Features

#### Personal Insights
- [ ] Gaming statistics dashboard
- [ ] Time spent per game/genre
- [ ] Achievement progress visualizations
- [ ] Most played games timeline
- [ ] Genre preferences over time

#### Group Analytics
- [ ] Friend group statistics
- [ ] Common gaming times
- [ ] Shared game interests
- [ ] Group achievement leaderboard
- [ ] Gaming trends in friend group

#### Recommendations Based on Analytics
- [ ] "You're into Action games" → recommend similar
- [ ] "Your group plays co-op 20 hours/week" → suggest co-op games
- [ ] "Best games for your group" (by engagement)
- [ ] Seasonal trends ("Summer games")

### Implementation Details
- Privacy-first: no data sent to servers
- Local computation only
- Aggregated statistics (never personal details shared)
- Opt-in analytics

---

## Phase 10: Community & Social (Future)

**Timeline**: Q1 2028 (January-February)

### Goals
Build community features for gamers to connect.

### Features

#### Game Clubs
- [ ] Create game clubs around titles
- [ ] Organize group play sessions
- [ ] Share game reviews/tips
- [ ] Event calendar for club members
- [ ] Club leaderboards

#### Global Insights
- [ ] "Currently trending games"
- [ ] "Most played games in your region"
- [ ] "Games other players like you enjoy"
- [ ] Community reviews and ratings
- [ ] Event discovery

#### Moderation
- [ ] Community guidelines
- [ ] Report functionality
- [ ] Trusted relays only
- [ ] Reputation system
- [ ] Spam prevention

### Implementation Details
- Nostr-based decentralized community
- Reputation tracked on-chain (via Nostr events)
- Content moderation by community
- No central servers (fully decentralized)

---

## Technical Debt & Optimization (Ongoing)

### Performance
- [ ] Implement virtual scrolling for 1000+ games
- [ ] Move filter/sort to web worker
- [ ] Service worker for offline support
- [ ] IndexedDB query optimization
- [ ] Implement cache eviction LRU

### Code Quality
- [ ] Increase test coverage to 95%
- [ ] Performance regression tests
- [ ] Accessibility audit (WCAG 2.1)
- [ ] Browser compatibility testing
- [ ] Security audit (pen testing)

### Developer Experience
- [ ] API documentation
- [ ] Architecture guide
- [ ] Contribution guide
- [ ] Development setup guide
- [ ] Debugging guide

### User Experience
- [ ] A/B testing framework
- [ ] User feedback surveys
- [ ] Analytics dashboard
- [ ] Heatmap tracking
- [ ] Session recording (opt-in)

---

## Dependencies & Blockers

### External Dependencies
- Steam API availability
- Nostr relay network stability
- Browser WebRTC support
- IndexedDB quota limits

### Known Limitations
- Steam API rate limiting (1.5 req/sec)
- Nostr relay latency (varies by relay)
- Browser storage quota (50MB typical)
- Metadata completeness (not all games have data)

### Future Improvements Waiting For
- Web Standards (SharedArrayBuffer for workers)
- Browser APIs (file system access)
- Platform APIs (game launch detection)

---

## Success Metrics

### User Adoption
- Target: 10K active users in Q4 2026
- Target: 50K active users by Q2 2027

### Feature Adoption
- Game Discovery: 80% of users
- Recommendations: 60% of users
- Achievements: 40% of users
- Voice Chat: 30% of users

### Performance
- Discovery tab load: <1s (maintain)
- Filter/sort: <300ms (maintain)
- Memory: <50MB (improve to <30MB)

### Quality
- Test coverage: 90% → 95%
- Crash rate: <0.1%
- Bug resolution: <24 hours

### Community
- GitHub stars: 100+
- Contributors: 10+
- Issues resolved: 95%

---

## Timeline Summary

```
Phase 1: Game Discovery       ✓ July 2026 (COMPLETE)
Phase 2: Game Activity        August 2026
Phase 3: Recommendations      September 2026
Phase 4: Achievements         November 2026
Phase 5: Collections          December 2026
Phase 6: Voice Chat           February 2027
Phase 7: Cross-Platform       April 2027
Phase 8: Mobile App           July 2027
Phase 9: Analytics            October 2027
Phase 10: Community           January 2028
```

---

## Feedback & Prioritization

This roadmap is dynamic. Features may be:
- **Accelerated** if high demand from users
- **Delayed** if dependencies block progress
- **Reordered** based on user feedback
- **Removed** if deemed out of scope

**To contribute**: Open an issue on GitHub with feature requests and use cases.

---

**Last Updated**: 2026-07-28  
**Version**: 1.0.0  
**Status**: Under development
