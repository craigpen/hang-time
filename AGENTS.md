# Antigravity & AI Agent Instructions

## Mandatory Invariants
1. **Commit and Push on Every Set of Changes**:
   - Always run verification (`npm run type-check`, `npm run test:run`, and `npm run build:all`).
   - Stage, commit with clear messages, and push to the remote branch with each set of changes.
   - Do not leave working directory dirty or unpushed commits behind.
2. **Follow Architectural Invariants**:
   - Adhere to storage abstraction via `StorageManager`.
   - Respect immutable `contentTimestamp` logic.
   - Manage content script cleanup via `INSTANCE_ID` + `CLEANUP_EVENT`.
   - Never log credentials, private keys, or sensitive tokens.
   - Route all Nostr publishing through priority `PublishQueue`.
