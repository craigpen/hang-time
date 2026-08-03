# Hang Time Security Hardening Implementation Guide

## Overview

This guide provides step-by-step instructions for implementing all security fixes identified in the security audit. The fixes are organized by priority and implementation difficulty.

---

## CRITICAL FIXES (MUST IMPLEMENT)

### Fix 1: Use Secure Random State Generation
**File:** `src/modules/services/spotify.ts` and `twitch.ts`  
**Current Issue:** Uses `Math.random()` which is not cryptographically secure  
**Fix:** Use `generateSecureRandom()` from security-utils

**Implementation:**
```typescript
// OLD (INSECURE):
const state = Math.random().toString(36).substring(7);

// NEW (SECURE):
import { generateSecureRandom } from '../security-utils';
const state = generateSecureRandom(32);
```

**Location Updates:**
- spotify.ts line 89
- twitch.ts line 104
- oauth-handler.ts (validate state parameter)

---

### Fix 2: Remove OAuth Secrets from Source Code
**Files:** `src/modules/services/spotify.ts` and `twitch.ts`  
**Current Issue:** Hardcoded "YOUR_SPOTIFY_CLIENT_SECRET" in code  
**Fix:** Use ConfigManager to load from secure storage

**Implementation:**
```typescript
// OLD (INSECURE):
client_secret: 'YOUR_SPOTIFY_CLIENT_SECRET',

// NEW (SECURE):
import { configManager } from '../config';
const spotifyConfig = await configManager.getSpotifyConfig();
client_secret: spotifyConfig.client_secret,
```

**Steps:**
1. Import configManager in spotify.ts and twitch.ts
2. Replace all hardcoded credentials with configManager calls
3. Add error handling for missing configuration
4. Update admin setup instructions

**Admin Setup Instructions (in README):**
```javascript
// Run this ONCE after installation to configure OAuth:
const config = {
  spotify: {
    client_id: 'your_spotify_client_id',
    client_secret: 'your_spotify_client_secret'
  },
  twitch: {
    client_id: 'your_twitch_client_id',
    client_secret: 'your_twitch_client_secret'
  }
};
chrome.storage.local.set({ oauth_config: config });
```

---

### Fix 3: Implement NIP-04 Message Encryption
**Files:** `src/modules/messaging.ts`  
**Current Issue:** Messages sent as plaintext to Nostr  
**Fix:** Use EncryptionManager for NIP-04 encryption

**Implementation:**
```typescript
// OLD (INSECURE):
content: content, // TODO: Encrypt using NIP-04

// NEW (SECURE):
import { encryptionManager } from './encryption';
const encryptedContent = encryptionManager.encrypt(content, friendIdentifier);
content: encryptedContent,
```

**Key Changes:**
1. Import EncryptionManager in messaging.ts
2. Encrypt message before publishing to Nostr
3. Store recipient public key properly
4. Add decryption handling for received messages
5. Update message event structure with encrypted payload

---

## HIGH PRIORITY FIXES

### Fix 4: Encrypt Messages in Local Storage
**File:** `src/modules/storage.ts`  
**Issue:** Messages stored in plaintext  
**Fix:** Encrypt before storage, decrypt on retrieval

```typescript
// In addMessage():
const encryptedMessage = this._encryptMessage(message);
messages.push(encryptedMessage);

// In getMessages():
const decryptedMessages = messages.map(m => this._decryptMessage(m));
```

---

### Fix 5: Sanitize Error Logging
**Files:** All modules  
**Issue:** Errors may contain sensitive data  
**Fix:** Use `secureLog` wrapper instead of console

```typescript
// OLD (UNSAFE):
console.error('[Spotify] Failed to get current activity:', error);

// NEW (SAFE):
import { secureLog } from './security-utils';
secureLog.error('Spotify', 'Failed to get current activity', error);
```

**Modules to Update:**
- src/modules/services/spotify.ts (10+ console.error calls)
- src/modules/services/twitch.ts (5+ console.error calls)
- src/modules/messaging.ts (3+ console.error calls)
- All other modules with error logging

---

### Fix 6: Add Input Validation
**Files:** Various modules  
**Issue:** User input not validated  
**Fix:** Use validation functions from security-utils

**Locations:**
1. **Friend names** (friends.ts addFriend):
```typescript
import { validateFriendName } from './security-utils';
const validation = validateFriendName(localName);
if (!validation.valid) throw new Error(validation.error);
```

2. **Message content** (messaging.ts sendMessage):
```typescript
import { validateMessage } from './security-utils';
const validation = validateMessage(content);
if (!validation.valid) throw new Error(validation.error);
```

3. **OAuth responses** (services/spotify.ts, twitch.ts):
```typescript
import { validateOAuthToken } from './security-utils';
const validation = validateOAuthToken(data);
if (!validation.valid) throw new Error(validation.error);
```

---

### Fix 7: Implement OAuth Redirect Validation
**File:** `entrypoints/oauth-handler.ts`  
**Issue:** No CSRF validation on redirect origin  
**Fix:** Validate redirect comes from legitimate OAuth provider

```typescript
import { validateOAuthRedirect, validateState } from '../src/security-utils';

// Validate redirect origin
if (!validateOAuthRedirect(window.location.origin, 'https://accounts.spotify.com')) {
  throw new Error('Invalid redirect origin - CSRF attack detected');
}

// Validate state parameter
const storedState = await getFromStorage('oauth_state');
if (!validateState(params.get('state'), storedState)) {
  throw new Error('State mismatch - CSRF attack detected');
}
```

---

### Fix 8: Add Token Refresh Buffer
**Files:** `src/modules/services/spotify.ts` and `twitch.ts`  
**Issue:** Token refresh happens exactly at expiry  
**Fix:** Add buffer (refresh 60 seconds before expiry)

```typescript
// OLD (PROBLEMATIC):
if (token.expires_at > Date.now()) {
  return token.access_token;
}

// NEW (SAFE):
const REFRESH_BUFFER_MS = 60000; // 60 seconds
if (token.expires_at > Date.now() + REFRESH_BUFFER_MS) {
  return token.access_token;
}
```

---

### Fix 9: Implement Rate Limiting
**File:** `src/modules/services/*.ts`  
**Issue:** No rate limiting on API calls  
**Fix:** Add exponential backoff

```typescript
class RateLimiter {
  private lastCall = 0;
  private backoffMs = 1000;

  async wait(): Promise<void> {
    const elapsed = Date.now() - this.lastCall;
    if (elapsed < this.backoffMs) {
      await new Promise(resolve => setTimeout(resolve, this.backoffMs - elapsed));
    }
    this.lastCall = Date.now();
    this.backoffMs = Math.min(this.backoffMs * 1.5, 30000); // Max 30s backoff
  }

  reset(): void {
    this.backoffMs = 1000;
  }
}
```

---

## MEDIUM/LOW PRIORITY FIXES

### Fix 10: Add Content Security Policy
**File:** `manifest.json`  
**Add:**
```json
"content_security_policy": {
  "extension_pages": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
}
```

### Fix 11: Exclude Source Maps from Distribution
**File:** `scripts/build.js`  
**Change:**
```javascript
// Don't copy .map files to dist
if (!file.endsWith('.map')) {
  fs.copyFileSync(srcFile, destFile);
}
```

---

## Implementation Checklist

- [ ] Add TweetNaCl.js to package.json (`npm install`)
- [ ] Implement EncryptionManager (encryption.ts) ✅
- [ ] Implement ConfigManager (config.ts) ✅
- [ ] Implement SecurityUtils (security-utils.ts) ✅
- [ ] Update Spotify service with secure config and random
- [ ] Update Twitch service with secure config and random
- [ ] Update OAuth handler with CSRF validation
- [ ] Update messaging with NIP-04 encryption
- [ ] Update error logging with secureLog wrapper
- [ ] Add input validation to friend/message operations
- [ ] Add rate limiting to service calls
- [ ] Add token refresh buffer
- [ ] Add CSP to manifest
- [ ] Exclude source maps from build
- [ ] Run full test suite
- [ ] Manual security validation
- [ ] Update deployment documentation

---

## Testing Security Fixes

### Unit Tests to Add
```typescript
// test/security.test.ts
- Test message encryption/decryption
- Test secure random generation
- Test input validation boundaries
- Test constant-time comparison
- Test state parameter validation
- Test error sanitization
```

### Manual Security Testing
1. Verify messages are encrypted in storage
2. Verify messages are encrypted in Nostr events
3. Verify OAuth state changes on each auth attempt
4. Verify error logs don't contain secrets
5. Verify rate limiting prevents API spam
6. Verify token refresh happens with buffer

---

## Deployment Notes

**Before Release:**
1. Ensure ConfigManager is properly initialized
2. Document OAuth credential setup process
3. Test end-to-end OAuth flow
4. Verify message encryption/decryption works
5. Monitor logs for any exposed sensitive data

**For Administrators:**
- Provide secure credential management guide
- Document how to set OAuth configuration
- Explain security implications of each setting

---

## Security Compliance Checklist

After implementing all fixes, verify:
- [ ] No credentials in source code
- [ ] Messages encrypted with NIP-04
- [ ] Cryptographically secure randomness
- [ ] All error logs sanitized
- [ ] Input validation on all user input
- [ ] CSRF protection on OAuth
- [ ] Rate limiting implemented
- [ ] Token refresh with buffer
- [ ] CSP headers in place
- [ ] Source maps excluded from build
- [ ] All tests passing
- [ ] No security warnings from audits

---

## References

- NIP-04: https://github.com/nostr-protocol/nips/blob/master/04.md
- TweetNaCl.js: https://tweetnacl.js.org/
- OWASP XSS Prevention: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
- OWASP CSRF Prevention: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
