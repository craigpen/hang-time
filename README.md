# Hang Time - Browser Extension MVP

Hang out and consume content together. A decentralized browser extension for co-watching, co-playing, and co-listening with friends.

## What It Does

- **Detect what you're consuming**: Spotify, Twitch, Steam, Netflix, YouTube
- **See active friends in real-time**: Shows friends currently playing/watching/listening
- **Join them with one click**: Time-synced co-watching, encrypted chat, optional voice coordination
- **Fully decentralized**: No backend server, no user database—all via Nostr relays
- **Your data stays local**: OAuth tokens and activity history stored locally only

## Architecture

- **Frontend**: Browser extension (Manifest V3) for Chrome, Edge, Opera
- **Backend**: None—uses public Nostr relays for pub/sub
- **Storage**: Local (IndexedDB + chrome.storage)
- **Communication**: Nostr protocol (encrypted messages, activity events)

## Tech Stack

- Manifest V3 (Chrome, Edge, Opera)
- Chrome Extension Storage API
- Nostr.js (pub/sub via public relays)
- Spotify/Twitch/Steam Web APIs
- Browser Tab Detection (Netflix, YouTube)
- HTML5 Video API (time sync)

## Current Phase

**MVP Development** - Building core features for the first release.

See [claude.md](claude.md) for development progress and architectural decisions.

## Project Status

- ✅ MVP specification complete
- ✅ Agent validation pipeline configured
- ⏳ Project setup in progress
- 🚀 Development to follow

## Next Steps

1. Initialize project structure and dependencies
2. Set up Manifest V3 and build pipeline
3. Implement activity detection modules
4. Build extension UI (popup, settings, overlays)
5. Integrate Nostr pub/sub
6. Add co-watching features (time sync, chat, voice)
7. Test and release
