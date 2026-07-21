# Hang Time Development Conventions

Establish consistent patterns and standards across the codebase for readability, maintainability, and team alignment.

---

## Code Style & Structure

### File Organization
- **Naming**: Use camelCase for files (e.g., `serviceManager.ts`, `nostrRelay.ts`)
- **Folders**: Use kebab-case for directories (e.g., `src/modules/`, `src/ui/overlays/`)
- **One responsibility**: Each file should have a clear, single purpose

### Styling
- ✅ **CSS files only** - No inline `style` attributes in HTML
- ✅ **No minified source code** - Keep all source readable (build process minifies for release)
- 📄 **CSS organization**: One CSS file per major component/page
- 🎨 **Dark/Light mode**: Use `@media (prefers-color-scheme: light/dark)` for all styling
- 🎨 **No hardcoded colors in JS**: All colors defined in CSS variables

### TypeScript & JavaScript
- **Type strictness**: Enable `strict: true` in tsconfig.json
- **Explicit types**: All function parameters and return types must be typed (no implicit `any`)
- **Prefer `const`**: Use `const` by default, `let` only when reassignment needed
- **Async/await**: Prefer async/await over `.then()` chains
- **Error handling**: Always use try/catch for async operations, log errors with context
- **No `var`**: Never use `var`, always `const` or `let`

### Comments & Documentation
- **Comment when WHY is non-obvious**: Explain reasoning, not what the code does (code should be self-documenting)
- **No multi-line comment blocks**: Max one-line comments, use clear variable names instead
- **JSDoc for public APIs**: Document exported functions/types with JSDoc comments
- **TODO comments**: Mark temporary/incomplete work with `// TODO: [description]`

Example:
```typescript
// Good: explains why, not what
// Nostr relays may have different latencies; retry failed subscriptions
async function subscribeWithRetry(relayUrl: string): Promise<void> {
  // ...
}

// Bad: comments duplicate what code shows
// Set the identifier
const identifier = generateIdentifier();
```

---

## TypeScript Configuration

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noImplicitThis": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

---

## Module & Export Patterns

### Module Structure
- **Exports**: Use named exports by default, default export only for page entry points
- **Interfaces**: Define at top of file, prefix with `I` if using interface pattern (e.g., `INostrRelay`)
- **Constants**: Define at module level, use UPPER_SNAKE_CASE for constants
- **Private functions**: Use underscore prefix or export only public API

Example:
```typescript
// src/modules/nostr.ts
export interface IRelayConnection {
  url: string;
  isConnected: boolean;
  subscribe(eventType: string): void;
}

export const RELAY_TIMEOUT_MS = 5000;
export const DEFAULT_RELAYS = ['nostr.pub', 'relay.damus.io'];

export class RelayPool {
  private relays: IRelayConnection[] = [];

  // Public API
  connect(url: string): Promise<void> { /* ... */ }
  publish(event: NostrEvent): Promise<void> { /* ... */ }

  // Private helper
  private _validateEvent(event: NostrEvent): boolean { /* ... */ }
}
```

---

## Logging & Debugging

### Logging Convention
- **No `console.log()` in production code**: Use structured logging for observability
- **Debug logs**: Only in development/debugging context, use `console.debug()` with clear prefixes
- **Error logging**: Always include context (what operation, what data, what failed)
- **Sensitive data**: NEVER log passwords, tokens, bookmarkIds, or personal identifiers

Example:
```typescript
// Good: structured, prefixed, contextual
console.debug('[Nostr] Connecting to relay:', relayUrl);
console.error('[Activity] Failed to detect Spotify activity:', error.message, { userId });

// Bad: no context, too verbose
console.log('error');
console.log(password);
console.log(bookmarkId);
```

### Browser Extension Logging
- Use `[MODULE_NAME]` prefix for all logs: `[Nostr]`, `[ActivityDetector]`, `[UI]`
- Logs appear in:
  - Background: DevTools for service worker
  - Popup: DevTools for popup window
  - Content scripts: Page DevTools

---

## Security Conventions

### Token & Credential Handling
- **Storage**: OAuth tokens stored in `chrome.storage.local` (never in code, never logged)
- **Transmission**: Only send tokens to official service APIs (Spotify, Twitch, Steam)
- **Expiry**: Handle OAuth token expiration and refresh flows
- **Validation**: Always validate tokens are valid before using them

### Message Validation
- **Nostr messages**: Validate signature and event structure before processing
- **Chrome messages**: Validate sender is extension itself, check message format
- **No eval()**: Never use `eval()`, `Function()`, or dynamic code execution

### XSS Prevention
- **DOM updates**: Use `textContent` not `innerHTML` for untrusted data
- **DOM creation**: Prefer `createElement()` and `appendChild()` over HTML strings
- **Message content**: Always escape/sanitize before displaying

---

## Testing Conventions

### Test File Location
- Tests co-locate with source: `src/modules/nostr.ts` → `src/modules/nostr.test.ts`
- Alternative: `tests/` folder mirrors `src/` structure

### Test Naming
- File naming: `*.test.ts` or `*.spec.ts`
- Test names: Describe behavior in plain English
  - Good: `should retry failed Nostr subscriptions`
  - Bad: `test1`, `testNostr`

### Test Coverage Targets
- **Critical paths** (activity detection, Nostr publish/subscribe): ≥90% coverage
- **UI components**: ≥70% coverage
- **Utilities**: ≥80% coverage
- **Exception**: Chrome extension APIs are hard to test; mock them

---

## Git & Commit Conventions

### Commit Messages
- **Format**: `[type]: [description]`
- **Types**: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `build`
- **Description**: Clear, concise, explains what & why
- **Length**: First line ≤50 chars, details in body if needed
- **Co-authoring**: Always include `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`

Example:
```
feat: Add Nostr relay connection pool

Implement RelayPool class to manage connections to multiple
Nostr relays with automatic reconnection and failover.

Resolves: #6
Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>
```

### Branch Naming
- Feature branches: `feat/[issue-number]-[short-desc]`
  - Example: `feat/6-nostr-relay-pool`
- Bug fixes: `fix/[issue-number]-[short-desc]`
- Documentation: `docs/[short-desc]`

### Pull Requests
- **Title**: Same format as commit message
- **Description**: Reference GitHub issue, explain changes, note testing done
- **Code review**: All PRs require review + validation pipeline pass before merge

---

## Manifest V3 Conventions

### Permissions
- **Principle of least privilege**: Only request necessary permissions
- **host_permissions**: Be specific about URLs, avoid wildcards where possible
- **storage**: Use `storage` for persistent data, `tabs` for current browser state

### Service Worker Patterns
- **Startup**: Initialize on `chrome.runtime.onInstalled` (first install, update)
- **Message handlers**: Use `chrome.runtime.onMessage` for popup ↔ background communication
- **Tab detection**: Use `chrome.tabs.query()` for active tab checking
- **Error handling**: Service worker can restart; don't store state in memory (use storage)

### Content Scripts (if needed)
- **Isolation**: Content scripts run in page context; use message passing to background
- **Security**: Never trust page data; validate all received messages
- **Performance**: Keep content scripts small and fast

---

## Organization & Project Management

### Issue Tracking
- All work tracked in GitHub issues
- Link commits/PRs to issues: `Resolves #[number]`
- Use labels: `type:feat`, `type:bug`, `status:in-progress`, `priority:high`

### Code Review Checklist
- [ ] Follows conventions in this document
- [ ] TypeScript type safety checks pass
- [ ] No console.log() or debug code
- [ ] No hardcoded credentials or sensitive data
- [ ] Tests added/updated (if applicable)
- [ ] Documentation updated (if applicable)
- [ ] Validation pipeline passes (AGENTS.md)

---

## Questions or Additions?

This document should evolve as we build. If you find a pattern works well, add it here. If a convention doesn't make sense in context, call it out and we'll adjust.

**Key principle**: Conventions exist to make collaboration smoother and code more maintainable. Consistent > Perfect.
