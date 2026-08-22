# Hang Time - Browser Tab Platforms Roadmap (Zero-OAuth Specification)

## 1. Executive Summary & Zero-OAuth Philosophy

Hang Time's browser tab monitoring architecture is built around a **Zero-OAuth, Zero-Friction** principle:
- **No API Keys or Developer Accounts**: Users should not need to register on third-party developer portals or configure OAuth redirect URIs.
- **Pure In-Tab DOM Extraction**: By running within the content script context on open browser tabs, Hang Time can inspect the DOM, media player elements (`<video>` / `<audio>`), and player UI states directly.
- **Universal Privacy**: Presence and playback states are extracted locally in the browser sandbox and shared peer-to-peer over Nostr without routing through centralized analytics or proxy servers.

---

## 2. Platform Expansion by Category

```
┌────────────────────────────────────────────────────────────────────────┐
│               Hang Time Content Script Provider Registry               │
│                     (src/modules/providers/registry.ts)                │
└──────┬──────────────────────┬────────────────────┬─────────────────────┘
       │                      │                    │
       ▼                      ▼                    ▼
 ┌───────────────┐     ┌──────────────┐     ┌──────────────┐
 │ Video & Anime │     │ Audio/Music  │     │ E-Learning & │
 │ Streaming     │     │ (Zero-OAuth) │     │ Podcasts     │
 └───────────────┘     └──────────────┘     └──────────────┘
```

---

## 3. Video & Anime Streaming Providers

All video providers implement the `VideoProvider` interface (`src/modules/providers/types.ts`), detecting playback position, duration, and title directly from the DOM:

| Platform | Domain Match | Target Player & Title Selectors | Notes |
| :--- | :--- | :--- | :--- |
| **YouTube** *(Active)* | `youtube.com/watch` | `.html5-main-video`, `#title h1` | Skips ad intervals |
| **Netflix** *(Active)* | `netflix.com/watch` | Cadmium video player, `.video-title` | Extracts series + episode |
| **Twitch** *(Active)* | `twitch.tv/*` | `.video-player video`, `[data-a-target="stream-title"]` | Live channel stream presence |
| **Crunchyroll** | `crunchyroll.com/watch/*` | `#vilos-player video`, `.current-media-parent-title`, `.show-title-link` | #1 Anime platform (Series, Season, Episode title) |
| **Disney+** | `disneyplus.com/video/*` | `.btm-media-client-element video`, `.title-field` | Widevine player + title overlay |
| **Amazon Prime Video** | `primevideo.com/detail/*`, `amazon.com/gp/video/*` | `.webPlayerUIContainer video`, `.xrayQuickView .title` | X-Ray title overlay extraction |
| **Max (HBO Max)** | `max.com/video/watch/*` | `video[data-testid="player-video"]`, `.player-metadata-title` | Movies and episodic content |
| **Hulu** | `hulu.com/watch/*` | `.video-player video`, `.PlayerMetadata__title` | Series/Season/Episode |
| **Apple TV+** | `tv.apple.com/*/episode/*` | `video.video-tag`, `.video-title` | Web playback player |
| **Odysee & PeerTube** | `odysee.com/*`, `peertube.*` | HTML5 `<video>`, `.claim-title` | Decentralized video platforms |
| **Internet Archive** | `archive.org/details/*` | `.jw-video`, `#maincontent h1` | Classic movies & public domain |
| **Jellyfin** | User-configured server URL | Native `<video>` element, `.itemName` / `.pageTitle` | Self-hosted, no DRM, stable un-hashed selectors |
| **Plex Web** | `app.plex.tv/*` | `video[data-testid="video-element"]`, `.MetadataPosterTitle-title` | Self-hosted, no DRM |

> **Why these matter**: Self-hosted media servers avoid the DRM/anti-scraping arms race that makes Crunchyroll/Disney+/Max/Prime/Hulu high-maintenance (see note above), and their userbase — people running their own media server specifically to avoid corporate streaming platforms — is an unusually strong philosophical match for a decentralized, privacy-first tool. Worth prioritizing above the DRM-heavy platforms in Phase 1, not just tacking on at the end. Jellyfin's server URL is user-supplied rather than a fixed domain match, unlike every other provider in this table — the matcher needs to account for that.

> **Maintenance note**: Crunchyroll, Disney+, Prime Video, Max, and Hulu use build-hashed/dynamic CSS class names that shift on redeploy, unlike YouTube/Netflix/Twitch's comparatively stable selectors (already proven in production). Expect these five to need selector updates far more often than the "Active" row — sequence them last within Phase 1 and budget for ongoing upkeep rather than treating them as equal-effort to the rest.

---

## 4. Zero-OAuth Music & Audio Streaming

Replaces the need for OAuth developer apps by reading persistent web player bars directly in browser tabs:

### 4.1 YouTube Music (`music.youtube.com`)
- **URL Pattern**: `music.youtube.com/*`
- **DOM Selectors**:
  - Player: `ytmusic-player-bar video`
  - Track Title: `ytmusic-player-bar .title.ytmusic-player-bar`
  - Artist & Album: `ytmusic-player-bar .byline.ytmusic-player-bar a`
  - Artwork: `ytmusic-player-bar .image.ytmusic-player-bar`
- **Output**: Real-time track, artist, album art, duration, and playback progress.

### 4.2 SoundCloud (`soundcloud.com`)
- **URL Pattern**: `soundcloud.com/*`
- **DOM Selectors**:
  - Track & Artist: `.playControls__soundBadge .playbackSoundBadge__titleLink`, `.playbackSoundBadge__lightLink`
  - Progress: Extracted from `.playbackTimeline__progressWrapper` or bottom audio element.
  - Playback State: Checked via `.playControl.playing`.

### 4.3 Bandcamp (`bandcamp.com`)
- **URL Pattern**: `bandcamp.com/*`, `*.bandcamp.com/album/*`, `*.bandcamp.com/track/*`
- **DOM Selectors**:
  - Track Title: `.track_info .title`
  - Artist / Album: `#name-section .albumTitle`, `span[itemprop="byArtist"]`
  - Audio: Native HTML5 `<audio>` element with duration and currentTime.

### 4.4 Spotify Web Player (`open.spotify.com`) — *Zero-OAuth In-Tab Mode*
- **URL Pattern**: `open.spotify.com/*`
- **DOM Selectors**:
  - Track: `[data-testid="now-playing-widget"] [data-testid="context-item-info-title"]`
  - Artist: `[data-testid="now-playing-widget"] [data-testid="context-item-info-artist"]`
  - Playback State: `[data-testid="control-button-playpause"]` (checking SVG / aria-label)
  - Time & Progress: `[data-testid="playback-position"]`, `[data-testid="playback-duration"]`

### 4.5 Apple Music Web (`music.apple.com`) & Tidal Web (`listen.tidal.com`)
- **DOM Selectors**: Bottom persistent player bars exposing track title, artist, and playback timeline.

---

## 5. Podcasts & Audiobooks ("Listen Together")

| Platform | Target Domain | Extraction Details |
| :--- | :--- | :--- |
| **Pocket Casts Web** | `play.pocketcasts.com/*` | Podcast series name, episode title, and playback timestamp from player bar. |
| **Audible Web Player** | `audible.com/webplayer*` | Audiobook title, author, current chapter (`Chapter 5`), and progress. |

---

## 6. E-Learning & "Study Together"

Enables study groups and technical cohorts to co-watch lectures and courses together:

- **Coursera (`coursera.org/learn/*`)**:
  - Detects Course Name + Lecture Title (`"Machine Learning - Week 2: Linear Regression"`).
  - Syncs lecture video progress across study group members.
- **Udemy (`udemy.com/course/*/learn/lecture/*`)**:
  - Extracts course title and current lecture video element.
- **edX (`edx.org/learn/*`) & TED Talks (`ted.com/talks/*`)**:
  - Lecture video detection and duration.

---

## 7. Interactive Co-Watching & Tab Sync Features

1. **Host-Driven Play/Pause Broadcast (Leader-Follower)**:
   - When the Host plays or pauses their tab video, guests receive an immediate NIP-17 event to play/pause their local video player element.
2. **One-Click Media Navigation (`JOIN_GUEST_ACTIVITY`)**:
   - For all supported tab platforms, clicking `[Join]` in the overlay or popup navigates the tab (`chrome.tabs.update`) directly to the friend's exact video or song URL.
3. **Picture-in-Picture (PiP) Overlay Alignment**:
   - Support rendering sync status and chat notifications during native Picture-in-Picture playback.

---

## 8. Phased Implementation Roadmap

### Phase 1: High-Volume Video & Anime (Immediate)
- [ ] Implement `JellyfinProvider` (`src/modules/providers/jellyfin.ts`) — no DRM, stable selectors, strong philosophical fit; do first.
- [ ] Implement `PlexProvider` (`src/modules/providers/plex.ts`).
- [ ] Implement `CrunchyrollProvider` (`src/modules/providers/crunchyroll.ts`).
- [ ] Implement `DisneyPlusProvider` (`src/modules/providers/disneyplus.ts`).
- [ ] Implement `PrimeVideoProvider` (`src/modules/providers/primevideo.ts`).

### Phase 2: Zero-OAuth Music Streaming
- [ ] Implement `YouTubeMusicProvider` (`src/modules/providers/youtube-music.ts`).
- [ ] Implement `SoundCloudProvider` (`src/modules/providers/soundcloud.ts`).
- [ ] Implement `SpotifyWebProvider` (`src/modules/providers/spotify-web.ts`).

### Phase 3: Podcasts & E-Learning
- [ ] Implement `PocketCastsProvider` (`src/modules/providers/pocketcasts.ts`).
- [ ] Implement `UdemyProvider` and `CourseraProvider`.

### Phase 4: Leader-Follower Sync
- [ ] Implement optional Host auto-play/pause sync broadcast for active co-watch sessions.
