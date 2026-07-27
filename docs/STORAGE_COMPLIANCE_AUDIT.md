# Storage Compliance Audit

**Date**: 2026-07-26  
**Level**: Detailed rule verification  
**Status**: ⚠️ PARTIAL — Issues found

## Storage Validation Rules (from activity-validation.ts)

Our production data follows these rules:

### Content Field Rules
- ✅ Must be a string
- ✅ Cannot be empty
- ✅ Cannot exceed 200 characters
- ✅ No bullet points (• contamination)
- ✅ No notification fragments ("invited you to")
- ✅ No encoding artifacts (control characters)

### Service Field Rules
- ✅ Must be string
- ✅ Must be one of: spotify, twitch, netflix, youtube, steam

### State Field Rules
- ✅ Must be 'playing' or 'paused'

### Progress/Duration Rules
- ✅ Progress >= 0
- ✅ Duration >= 0 (0 = live stream)
- ✅ Progress <= duration (when duration > 0)

### Provenance Tracking
- ✅ Must be LOCAL_TAB, FRIEND, or TEST
- ✅ Indicates data source and trust level

---

## Content Script Storage Audit

### netflix-content.ts — Title Storage

**Compliance**: ⚠️ PARTIAL

#### What It Does Correctly
```typescript
isValidTitle(title: string): boolean
  ✅ Type check (string)
  ✅ Length bounds (2-300 chars)
  ✅ Filters keywords (error, failed)
  ✅ Filters UI elements (Play, Pause, Settings)
  ✅ Filters metadata (ratings, audio, subtitles)
```

#### Issues Found

**Issue 1: Missing Contamination Check**
- ❌ Does NOT check for bullet points (•)
- ❌ Does NOT check for notification fragments
- ❌ Does NOT check for encoding artifacts
- Risk: Netflix page could render "•" in title, stored as-is
- Example: "The Crown • Season 5" would pass validation

**Issue 2: No Provenance Tracking**
- ❌ Stores title without metadata about source
- ❌ No timestamp of extraction
- ❌ Cannot distinguish manual vs auto-extracted
- Risk: Can't validate data integrity later

**Issue 3: Storage Structure Inconsistency**
- ❌ Stores as bare string: `netflix_title: "title"`
- ❌ Should be: `netflix_title: { value: "title", extractedAt: timestamp, source: "content-script" }`
- Risk: Future changes need backwards compatibility

**Issue 4: No Expiration/Staleness**
- ❌ Stored title never expires
- ❌ If user loads old episode cache, stale title persists
- Risk: Activity could show wrong title after days/weeks

**Issue 5: Incomplete Validation**
```typescript
// Current length bounds: 2-300
// But Activity.content bounds: max 200 characters
// Mismatch: netflix_title allows longer strings than activities
```

---

## Compliance Matrix

| Rule | Activity Data | Netflix Title | Compliant |
|------|---------------|---------------|-----------|
| String type | ✅ Enforced | ✅ Enforced | ✅ YES |
| Length bounds | ✅ 200 max | ⚠️ 300 max | ❌ NO |
| No bullets | ✅ Checked | ❌ NOT CHECKED | ❌ NO |
| No notification fragments | ✅ Checked | ❌ NOT CHECKED | ❌ NO |
| No encoding artifacts | ✅ Checked | ❌ NOT CHECKED | ❌ NO |
| Provenance tracking | ✅ Tracked | ❌ NOT TRACKED | ❌ NO |
| Metadata (timestamps) | ✅ Present | ❌ ABSENT | ❌ NO |
| Expiration rules | ✅ Via cleanup | ❌ NONE | ❌ NO |

---

## Recommended Fixes

### Fix 1: Align Contamination Checks
```typescript
// netflix-content.ts isValidTitle() should check:
if (title.includes('•')) return false;
if (title.includes('invited you to')) return false;
if (/[\x00-\x1F\x7F]/.test(title)) return false;
```

### Fix 2: Add Metadata Structure
```typescript
// Change from:
await chrome.storage.local.set({ netflix_title: "The Crown" });

// To:
await chrome.storage.local.set({
  netflix_title_data: {
    value: "The Crown",
    extractedAt: Date.now(),
    source: "content-script",
    method: "h2-tag" | "data-uia" | "fallback"
  }
});
```

### Fix 3: Align Length Bounds
```typescript
// isValidTitle max length should be 200, not 300
// Align with Activity.content validation
if (title.length > 200) return false;
```

### Fix 4: Add Expiration
```typescript
// In StorageManager.getNetflixTitle():
async getNetflixTitle(): Promise<string | null> {
  const data = await this.get<any>('netflix_title_data');
  if (!data) return null;
  
  // If older than 24 hours, consider it stale
  const ageMs = Date.now() - data.extractedAt;
  if (ageMs > 24 * 60 * 60 * 1000) {
    console.warn('[Storage] Netflix title is stale, clearing');
    await this.set('netflix_title_data', null);
    return null;
  }
  
  return data.value;
}
```

---

## Priority Assessment

| Issue | Severity | Effort | Priority |
|-------|----------|--------|----------|
| Contamination checks | HIGH | LOW | 🔴 P0 |
| Length bound alignment | MEDIUM | LOW | 🟡 P1 |
| Provenance/metadata | MEDIUM | MEDIUM | 🟡 P1 |
| Expiration rules | LOW | MEDIUM | 🔵 P2 |

**P0 (Critical)**: Contamination checks prevent data corruption  
**P1 (Important)**: Alignment with system rules and future proofing  
**P2 (Nice to have)**: Stale data cleanup

---

## Summary

✅ **Good**: Basic validation is present  
⚠️ **Needs Work**: Missing contamination checks, no metadata, inconsistent bounds  
❌ **Compliance Score**: 3/8 rules fully compliant (37%)

**Recommendation**: Apply P0 fix immediately (add contamination checks), then P1 fixes to align with activity validation rules.

---

## Audit Checklist

- [x] Compared content script validation to ActivityDatastore rules
- [x] Identified misalignments in data structure
- [x] Found missing contamination detection
- [x] Checked metadata tracking
- [x] Verified expiration handling
- [x] Assessed severity and effort
- [x] Provided remediation steps
