# Hang Time Security Audit Report

**Date:** 2026-07-21  
**Version:** 0.1.0 MVP  
**Status:** In Progress  

---

## Executive Summary

Security audit of the Hang Time MVP extension covering OAuth, messaging, storage, and communication layers.

---

## Security Areas Reviewed

### 1. OAuth Token Handling
- [ ] Token storage security
- [ ] Token transmission security
- [ ] Token refresh handling
- [ ] Token expiration
- [ ] Credential leak prevention
- [ ] PKCE implementation
- [ ] State parameter validation

### 2. Message Encryption
- [ ] Nostr kind 4 encryption (NIP-04)
- [ ] Key derivation
- [ ] Plaintext storage checks
- [ ] Message tampering protection
- [ ] End-to-end encryption verification

### 3. Local Storage Security
- [ ] chrome.storage.local usage
- [ ] IndexedDB security
- [ ] Sensitive data handling
- [ ] Storage permissions
- [ ] Clearance on uninstall

### 4. Input Validation
- [ ] User input sanitization
- [ ] URL validation
- [ ] Event validation
- [ ] Message validation
- [ ] XSS prevention

### 5. Communication Security
- [ ] HTTPS/WSS enforcement
- [ ] Relay communication validation
- [ ] Man-in-the-middle protection
- [ ] Data integrity checks

### 6. Error Handling
- [ ] Information disclosure
- [ ] Stack traces in errors
- [ ] Sensitive data in logs
- [ ] User-facing error messages

### 7. Permissions & Access Control
- [ ] Minimum required permissions
- [ ] Content script isolation
- [ ] Message validation
- [ ] Service worker security

### 8. Build & Release Security
- [ ] Source map security
- [ ] Dependency audit
- [ ] Build reproducibility
- [ ] Code obfuscation

---

## Findings

### ⚠️ CRITICAL ISSUES

#### 1. Messages Not Encrypted (NIP-04)
**File:** `src/modules/messaging.ts:151`  
**Severity:** CRITICAL  
**Issue:** Messages are published to Nostr as plaintext instead of encrypted (NIP-04)  
**Risk:** All messages are visible to anyone on Nostr relays  
**Code:**
```typescript
// TODO: Encrypt using NIP-04
content: content, // PLAINTEXT!
```
**Recommendation:** Implement NIP-04 encryption using libsodium or TweetNaCl.js before MVP release.

#### 2. OAuth Client Secret in Source Code
**File:** `src/modules/services/spotify.ts:116` & `twitch.ts:126`  
**Severity:** CRITICAL  
**Issue:** Credentials marked as "TODO: Get from config" but still in source  
**Risk:** Credentials should never be in source code or distributed  
**Code:**
```typescript
client_secret: 'YOUR_SPOTIFY_CLIENT_SECRET', // TODO: Get from secure config
```
**Recommendation:** 
- Remove client IDs/secrets from source code entirely
- Implement backend OAuth proxy or use PKCE flow for browser
- For MVP: Use environment variables or secure config loading

---

### 🔴 HIGH PRIORITY ISSUES

#### 1. No Message Encryption in Local Storage
**File:** `src/modules/storage.ts:233` & `messaging.ts`  
**Severity:** HIGH  
**Issue:** Messages stored locally in plaintext  
**Risk:** Sensitive message content exposed if device compromised  
**Recommendation:** Encrypt messages before storing in chrome.storage.local

#### 2. Browser Extension Cannot Securely Store Client Secret
**File:** `src/modules/services/spotify.ts` & `twitch.ts`  
**Severity:** HIGH  
**Issue:** Browser extensions can't securely store OAuth client secrets (code is visible to users)  
**Risk:** Any user can extract secrets and abuse your OAuth app  
**Recommendation:** 
- Use PKCE (Proof Key for Code Exchange) flow
- Move token exchange to backend server
- Don't include client secret in extension code

#### 3. Random State Generation Too Weak
**File:** `src/modules/services/spotify.ts:89`  
**Severity:** HIGH  
**Issue:** State parameter uses `Math.random()` which is not cryptographically secure  
**Code:**
```typescript
const state = Math.random().toString(36).substring(7);
```
**Recommendation:** Use `crypto.getRandomValues()` for secure randomness

#### 4. No CSRF Protection Verification
**File:** `entrypoints/oauth-handler.ts`  
**Severity:** HIGH  
**Issue:** OAuth callback validates state but doesn't verify redirect origin  
**Recommendation:** Validate that redirect comes from expected OAuth provider

---

### 🟠 MEDIUM PRIORITY ISSUES

#### 1. Debug Logging May Leak Sensitive Info
**Files:** Various  
**Severity:** MEDIUM  
**Issue:** `console.debug()` and `console.error()` may log sensitive information  
**Examples:**
- `console.error('[Spotify] Failed to get current activity:', error)`
- Error objects may contain sensitive data
**Recommendation:** 
- Sanitize error messages before logging
- Remove detailed error logging in production
- Never log tokens, secrets, or personal data

#### 2. No Rate Limiting on API Calls
**Files:** `src/modules/services/*.ts`  
**Severity:** MEDIUM  
**Issue:** No rate limiting on Spotify/Twitch API calls  
**Risk:** Could hit rate limits and degrade user experience  
**Recommendation:** Implement local rate limiting with exponential backoff

#### 3. Token Expiration Check Lacks Margin
**File:** `src/modules/services/spotify.ts:149`  
**Severity:** MEDIUM  
**Issue:** Token refresh happens exactly at expiry, no buffer  
**Code:**
```typescript
if (token.expires_at > Date.now()) {
```
**Recommendation:** Add 30-60 second buffer before expiry:
```typescript
if (token.expires_at > Date.now() + 60000) {
```

#### 4. No Input Validation on Friend Names
**File:** `src/modules/friends.ts:46`  
**Severity:** MEDIUM  
**Issue:** Friend local_name not validated for length/characters  
**Recommendation:** Add validation:
- Max length: 50 characters
- No control characters
- No null bytes

---

### 🟡 LOW PRIORITY ISSUES

#### 1. Overly Permissive Permissions
**File:** `manifest.json`  
**Severity:** LOW  
**Issue:** Requests "tabs" and "webRequest" permissions broadly  
**Recommendation:** Request minimal permissions, specify hosts

#### 2. No Subresource Integrity (SRI)
**Files:** External resources  
**Severity:** LOW  
**Issue:** No SRI on external CDN resources (though currently none used)  
**Recommendation:** When adding external resources, use SRI checksums

#### 3. Source Maps Included in Distribution
**Files:** `dist/` (if distributed)  
**Severity:** LOW  
**Issue:** Source maps expose full source code  
**Recommendation:** Exclude `.map` files from distribution builds

---

### ✅ SECURITY STRENGTHS

#### 1. XSS Prevention
- ✅ Uses `_escapeHtml()` with `textContent` (safe)
- ✅ No direct `innerHTML` with user input
- ✅ Proper DOM API usage

#### 2. CSRF Protection (OAuth)
- ✅ State parameter implemented
- ✅ State validation on callback

#### 3. Token Refresh
- ✅ Refresh token flow implemented
- ✅ Automatic token rotation
- ✅ Expired token cleanup

#### 4. Content Security Policy
- ✅ Can be added to manifest for additional protection

#### 5. Permission Minimization
- ✅ Doesn't request excessive permissions
- ✅ Specific host permissions for APIs

---

### Recommendations

---

## Priority Remediation Plan

### BEFORE MVP RELEASE (CRITICAL)
1. **Remove OAuth Secrets from Source**
   - Remove hardcoded "YOUR_SPOTIFY_CLIENT_SECRET" strings
   - Implement PKCE flow or backend OAuth proxy
   - Time: 2-3 hours

2. **Implement Message Encryption (NIP-04)**
   - Add libsodium.js or TweetNaCl.js library
   - Encrypt messages before publishing to Nostr
   - Encrypt messages in local storage
   - Time: 3-4 hours

### STRONGLY RECOMMENDED (HIGH)
3. **Fix State Parameter Generation**
   - Replace `Math.random()` with `crypto.getRandomValues()`
   - Time: 0.5 hours

4. **Add Message Local Encryption**
   - Use Web Crypto API or libsodium for storage encryption
   - Time: 2 hours

5. **Sanitize Error Logging**
   - Review all console.error/debug calls
   - Remove sensitive data from error messages
   - Time: 1 hour

### RECOMMENDED (MEDIUM)
6. **Add Input Validation**
   - Validate friend names (length, characters)
   - Validate activity URLs
   - Validate message content length
   - Time: 1-2 hours

7. **Implement Rate Limiting**
   - Add exponential backoff for API calls
   - Time: 1-2 hours

8. **Add Token Refresh Buffer**
   - Refresh 30-60 seconds before expiry
   - Time: 0.5 hours

### OPTIONAL (LOW)
9. **Add Content Security Policy**
   - Add CSP header to manifest
   - Restrict resource loading
   - Time: 1 hour

10. **Exclude Source Maps from Build**
    - Configure build to exclude `.map` files
    - Time: 0.5 hours

---

## Detailed Analysis

### Test Coverage for Security Issues
- [ ] Unit test for message encryption
- [ ] Unit test for secure state generation
- [ ] Unit test for token refresh with buffer
- [ ] Integration test for OAuth flow
- [ ] Integration test for message send/receive encryption

### Browser Extension Security Best Practices Met
- ✅ No unsafe-eval in CSP
- ✅ No dangerous permissions
- ✅ XSS protection (HTML escaping)
- ✅ Content script isolation
- ✅ Message validation between contexts

---

## Conclusion

### Overall Security Rating: 🟡 **MEDIUM** (with critical issues to fix)

**Current State:**
- ✅ Good XSS prevention practices
- ✅ OAuth state protection implemented
- ✅ No dangerous permissions requested
- ❌ **CRITICAL: Messages not encrypted**
- ❌ **CRITICAL: OAuth secrets in source**
- ❌ **HIGH: Weak random state generation**
- ⚠️ **MEDIUM: Message storage not encrypted**
- ⚠️ **MEDIUM: Debug logging may leak info**

**Before MVP Release:**
- Must fix CRITICAL issues (encrypted messaging, remove OAuth secrets)
- Should fix HIGH issues (PKCE implementation, sanitize logging)
- Strongly recommended to address MEDIUM issues

**Timeline Estimate:**
- **CRITICAL fixes:** 5-7 hours
- **HIGH priority:** 2-3 hours
- **MEDIUM priority:** 4-5 hours
- **Total to full compliance:** 11-15 hours

**Risk Assessment:**
- **Current MVP risk level:** HIGH (unencrypted messages + exposed secrets)
- **Post-CRITICAL-fixes risk level:** MEDIUM (acceptable for MVP with warnings)
- **Post-all-fixes risk level:** LOW (production-ready)

**Deployment Recommendation:**
🚫 **DO NOT RELEASE** until:
1. Messages are encrypted (NIP-04)
2. OAuth secrets are removed from source
3. State parameter uses crypto RNG

After these three fixes, MVP is acceptable for beta testing with the following warnings:
- Users should not send sensitive information yet
- Expect security improvements in next release
- Do not use with real financial data

---

## Security Checklist

### Pre-Release
- [ ] Remove all hardcoded credentials from source
- [ ] Implement NIP-04 message encryption
- [ ] Use crypto.getRandomValues() for state
- [ ] Sanitize all error logs
- [ ] Review all console output for sensitive data
- [ ] Test encryption with actual messages
- [ ] Verify token refresh works correctly
- [ ] Test OAuth flow end-to-end

### Post-Release Improvements
- [ ] Implement CSP headers
- [ ] Add rate limiting
- [ ] Encrypt local message storage
- [ ] Add comprehensive security logging
- [ ] Conduct third-party security audit
- [ ] Add security policy document
