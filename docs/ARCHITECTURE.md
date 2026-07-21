# Hang Time - Architecture

## System Overview

This document describes the architecture of the Hang Time browser extension.

### Components

#### 1. Background Service Worker (entrypoints/background.js)
- Orchestrates extension lifecycle
- Manages Nostr connections
- Detects user activity (monitors APIs, tabs)
- Publishes activity to Nostr
- Handles message routing

#### 2. UI Components
- **Popup** (src/popup.html/js): Main extension popup showing active friends
- **Settings** (src/settings.html/js): Configure services, auth, notifications
- **Overlays**: Chat/voice prompts when co-watching

#### 3. Modules (src/modules/)
- **Nostr**: Relay connectivity, pub/sub
- **Services**: OAuth flows, API queries (Spotify, Twitch, Steam)
- **ActivityDetector**: Monitors tabs, APIs for current activity
- **Friends**: Friend list management
- **Messages**: Encrypted chat via Nostr kind 4

### Data Flow

```
User Action (play song, open tab)
    ↓
Activity Detector (monitors Spotify, tabs, etc.)
    ↓
Activity Updated in Local Storage
    ↓
Publish to Nostr Relays
    ↓
Friends Subscribe to User's Activity
    ↓
Friend Updates Display
```

### Manifest V3 Design

- Service Worker runs on-demand (not always active)
- Popup dynamically queries latest activity
- No content scripts needed initially (tab detection via chrome.tabs)
- Minimal permissions required

### To Be Implemented

- [ ] Nostr relay connection pool
- [ ] OAuth flows for Spotify/Twitch
- [ ] Activity detection modules
- [ ] UI components
- [ ] Message encryption/decryption
- [ ] Settings storage and retrieval
