# Agent Orchestration Configuration

This file defines the validation pipeline for code changes. The system automatically orchestrates agents to validate changes before they're committed.

## System Overview

- **Agents execute in defined order** (sequential or parallel blocks)
- **Blocking agents** prevent progress if they fail
- **Advisory agents** warn but don't block
- **Early exit** stops pipeline on first blocker failure
- **Pre-work phase** (optional): Requirements Gathering agent establishes intent/outcomes BEFORE coding

---

## Pre-Work Phase: Requirements Gathering (Optional, Runs First)

### Agent: Requirements Gatherer
- **Responsibility**: Establish intent, success criteria, and requirements before work begins
- **When to use**: Spawn BEFORE starting any significant task or feature work
- **Process**:
  1. Clarify user intent: "What problem are we solving?" "Why does this matter?"
  2. Define success: "How will we know when this is done?" "What does success look like?"
  3. Document requirements: "What must be true?" "What are constraints?"
  4. Create requirements document with:
     - **Intent**: Clear statement of purpose and problem being solved
     - **Success Criteria**: Measurable outcomes that indicate completion
     - **Requirements**: Must-have, should-have, nice-to-have features/constraints
     - **Out of Scope**: What's explicitly NOT included
     - **Validation Plan**: How we'll verify success
  5. Get user sign-off before proceeding
- **Output**: Requirements document that becomes the north star for all work
- **Blocking**: YES (don't start coding without clear intent/outcomes)
- **Timeout**: 30m (planning conversation)

---

## Agent Definitions

### Tier 1: Syntax & Type Safety (Parallel)

#### Agent: Code Builder
- **Responsibility**: Verify code compiles without errors
- **Command**: `npm run build:all`
- **Success Criteria**: Both Chrome and Firefox builds complete without errors
- **Blocking**: YES (code won't run if this fails)
- **Timeout**: 120s

#### Agent: Type Checker  
- **Responsibility**: Validate TypeScript/function signatures
- **Command**: Check for undefined function/variable references
- **Checks**:
  - All called functions exist in their modules
  - Method renames applied consistently
  - No orphaned references to old names
- **Blocking**: YES (indicates broken references)
- **Timeout**: 60s

#### Agent: Type Safety
- **Responsibility**: Enforce strict TypeScript typing and type safety rules
- **Checks**:
  - No use of `any` type in critical modules (metadataMatrix, folder, background handlers)
  - Public API functions have proper parameter type annotations
  - Return types explicitly declared on functions (not inferred)
  - Generic types properly constrained (not bare `<T>`)
  - Optional properties marked with `?` (not `| null | undefined`)
  - No implicit `any` from missing type imports
  - Object properties consistently typed (not `{ [key: string]: any }`)
  - Callback functions have proper typed signatures
  - Promise types properly declared (not bare `Promise`)
  - Critical modules use strict null checking patterns
- **Files to scan**: 
  - Critical: `entrypoints/background.ts`, `src/modules/metadataMatrix.js`, `src/modules/folder.js`
  - Important: `src/modules/metadataManager.js`, `src/modules/categorizer.js`
- **Acceptable `any` uses**:
  - Chrome API responses (browser types are loose)
  - Test mock data
  - Temporary migration code with TODO comment
- **Blocking**: YES (type safety prevents runtime errors)
- **Timeout**: 45s

### Tier 1.5: Security & Architecture (Parallel)

#### Agent: Security Scanner
- **Responsibility**: Detect security vulnerabilities and credential leaks
- **Checks**:
  - No hardcoded API keys, passwords, or tokens in code
  - No plaintext secrets in config files
  - No console.log() calls logging sensitive data (passwords, keys, tokens)
  - No eval() or dynamic code execution (Function constructor, setTimeout with strings)
  - No use of Math.random() for security/crypto purposes (should use crypto.getRandomValues)
  - Chrome API calls properly use content security policy compliant patterns
  - No innerHTML usage (use textContent or createElement)
  - No SQL-like injection vectors in metadata operations
  - No CORS bypasses or overly permissive permissions in manifest
- **Files to scan**: All source files, especially `entrypoints/background.ts`, `src/modules/`
- **Blocking**: YES (security is non-negotiable)
- **Timeout**: 60s
- **Example violations**:
  - `console.log(password)` or `console.log(bookmarkId)` in sensitive operations
  - API key stored as `const API_KEY = "sk-..."`
  - `eval(userInput)` or `new Function(userData)`

#### Agent: Architecture Validator
- **Responsibility**: Enforce architectural constraints and layering rules
- **Checks**:
  - No circular dependencies between modules
  - Background script doesn't directly import from UI modules (background.ts should not import sidebarController, settingsController)
  - UI modules don't directly import from background script (use messaging instead)
  - MetadataMatrix is the single source of truth for tier transitions (no direct metadata.tier assignments outside matrix)
  - Folder operations always go through folderMatrix (no direct folder metadata manipulation)
  - All async operations in background handlers properly error-handle (try/catch blocks)
  - Event handlers follow consistent pattern (log entry, perform work, log exit/error)
  - No cross-module state sharing (each module manages its own state)
  - Message handlers properly validate message format before processing
- **Files to scan**: `entrypoints/background.ts`, `src/ui/`, `src/modules/`
- **Module structure**:
  - `entrypoints/background.ts` (orchestrator)
  - `src/modules/` (business logic: metadataMatrix, folder, categorizer, etc.)
  - `src/ui/` (presentation: sidebarController, settingsController)
  - Communication: background → UI via chrome.tabs.sendMessage, UI → background via chrome.runtime.sendMessage
- **Blocking**: YES (architectural violations cause hard-to-debug issues later)
- **Timeout**: 45s

### Tier 2: Business Logic Validation (Parallel)

#### Agent: Matrix Compliance
- **Responsibility**: Verify metadata matrix rules aren't violated
- **Checks**:
  - All tier transitions use 32-transition matrix
  - browserFolderId always tracked in folder metadata
  - UUID fields present where required
  - keepForever flag transitions valid
- **Files to scan**: `src/modules/metadataMatrix.js`, `src/modules/folder.js`, `entrypoints/background.ts`
- **Blocking**: YES (matrix rules are non-negotiable)
- **Timeout**: 30s

#### Agent: Metadata Schema
- **Responsibility**: Ensure metadata consistency rules
- **Checks**:
  - Folder metadata has browserFolderId (required, non-empty)
  - Bookmark metadata has UUID (unique, required)
  - No orphaned folder references
  - parentFolderId links to existing folder metadata
- **Files to scan**: `src/modules/folder.js`, `src/modules/metadataMatrix.js`
- **Blocking**: YES (data integrity is critical)
- **Timeout**: 30s

### Tier 2.5: Quality & Deduplication (Sequential)

#### Agent: Code Deduplicator
- **Responsibility**: Identify duplicate patterns and suggest consolidation opportunities
- **Checks**:
  - Duplicate validation logic (e.g., multiple modules validating UUID format independently)
  - Repeated error handling patterns (same try/catch structure in 3+ places)
  - Similar functions with different names (e.g., two versions of URL normalization)
  - Boilerplate code that could be abstracted (e.g., repeated message handler setup)
  - Copy-paste code blocks (same 5+ line block appearing 2+ times)
  - Multiple implementations of the same operation (e.g., tier transition logic in multiple places)
- **Files to scan**: All source files, focus on:
  - `src/modules/*.js` (business logic duplication)
  - `entrypoints/background.ts` (handler duplication)
  - `src/ui/*.js` (UI pattern duplication)
- **Example findings**:
  - "Validation pattern for UUID appears in 3 modules - consider extracting to utils"
  - "matrixBookmarkUpdateFields and similar field-update operations could share pattern"
  - "Error logging pattern repeated 12 times - create standardized error handler"
- **Blocking**: NO (advisory - helps code quality but doesn't block)
- **Timeout**: 45s

### Tier 3: Testing (Sequential)

#### Agent: Test Runner
- **Responsibility**: Run full test suite
- **Command**: `npm test`
- **Success Criteria**: All tests pass (0 failures)
- **Known Issues**: 
  - Many tests are placeholder files with 0 actual tests
  - This is acceptable for now (legacy state)
  - Flag if NEW test files are broken
- **Blocking**: SOFT (warn if test count decreases)
- **Timeout**: 180s

#### Agent: Test Writer (Future)
- **Responsibility**: Generate test cases for critical code changes
- **Checks**:
  - Identify new or modified public API methods
  - Generate unit tests for new functions
  - Create integration tests for cross-module interactions
  - Cover happy path, error cases, and edge cases
  - Ensure test naming matches project conventions
- **Files to scan**: All modified files detected via git diff
- **Blocking**: NO (advisory - helps ensure test coverage but doesn't block)
- **Timeout**: 120s
- **Status**: Planned for future phases when automated test generation is needed

### Tier 4: Integration Check (Sequential)

#### Agent: Extension Build Verification
- **Responsibility**: Verify built extensions are valid
- **Checks**:
  - dist/chrome-mv3 contains all required files
  - dist/firefox-mv3 contains all required files
  - background.js is minified/bundled correctly
  - No console errors in built code
- **Blocking**: YES (must produce valid extensions)
- **Timeout**: 60s

## Execution Plan

```
┌────────────────────────────────────────────────┐
│ Pre-Work: Requirements Gathering (Optional)   │
│  └─ Requirements Gatherer                      │
│     (Establishes intent, success, requirements)
└──────────────┬─────────────────────────────────┘
               │ User sign-off required
               ▼
┌────────────────────────────────────────────────┐
│ Tier 1: Syntax & Type Safety (Parallel)       │
│  ├─ Code Builder                              │
│  ├─ Type Checker                              │
│  └─ Type Safety                               │
└──────────────┬─────────────────────────────────┘
               │ All must pass (blocking)
               ▼
┌────────────────────────────────────────────────┐
│ Tier 1.5: Security & Architecture (Parallel)   │
│  ├─ Security Scanner                           │
│  └─ Architecture Validator                     │
└──────────────┬─────────────────────────────────┘
               │ All must pass (blocking)
               ▼
┌────────────────────────────────────────────────┐
│ Tier 2: Business Logic Validation (Parallel)  │
│  ├─ Matrix Compliance                          │
│  └─ Metadata Schema                            │
└──────────────┬─────────────────────────────────┘
               │ All must pass (blocking)
               ▼
┌────────────────────────────────────────────────┐
│ Tier 2.5: Quality & Deduplication (Sequential) │
│  └─ Code Deduplicator                          │
└──────────────┬─────────────────────────────────┘
               │ Advisory only (no block)
               ▼
┌────────────────────────────────────────────────┐
│ Tier 3: Test Validation (Sequential)           │
│  └─ Test Runner                                │
└──────────────┬─────────────────────────────────┘
               │ Soft block (warn only)
               ▼
┌────────────────────────────────────────────────┐
│ Tier 4: Integration Check (Sequential)         │
│  └─ Extension Build Verification               │
└──────────────┬─────────────────────────────────┘
               │
               ▼
           ✅ PASS or ❌ FAIL
```

## Common Failure Patterns

### Type Safety Violations

#### "No `any` types in critical modules"
- **Cause**: Using `any` instead of proper types in background handlers
- **Agent**: Type Safety
- **Fix**: Replace with proper TypeScript types or use type guards

#### "Return types not explicitly declared"
- **Cause**: Relying on type inference instead of explicit return types
- **Agent**: Type Safety
- **Fix**: Add explicit `return type` to function signature

### Architecture Violations

#### "Circular dependency detected"
- **Cause**: Module A imports from B which imports from A
- **Agent**: Architecture Validator
- **Fix**: Identify the circular path and break it by moving shared code to utils

#### "UI module importing from background script"
- **Cause**: sidebarController or settingsController directly importing background.ts
- **Agent**: Architecture Validator
- **Fix**: Use chrome.runtime.sendMessage() instead of direct import

#### "Direct metadata.tier assignment outside matrix"
- **Cause**: Setting tier directly instead of using matrixBookmarkTransition()
- **Agent**: Architecture Validator
- **Fix**: Route through matrix to ensure keepForever and invariants are maintained

### Security Violations

#### "Hardcoded API key or secret found"
- **Cause**: Storing credentials in source code
- **Agent**: Security Scanner
- **Fix**: Move to environment variables or chrome.storage API with encryption

#### "console.log logging sensitive data"
- **Cause**: Logging passwords, keys, tokens, or bookmarkIds
- **Agent**: Security Scanner
- **Fix**: Remove or use debug.log with redaction for sensitive fields

#### "innerHTML usage detected"
- **Cause**: Using innerHTML instead of safe DOM methods
- **Agent**: Security Scanner
- **Fix**: Use textContent or createElement() instead

### Business Logic Violations

#### "Cannot create folder: browserFolderId is required"
- **Cause**: Folder creation missing browserFolderId parameter
- **Agent**: Matrix Compliance
- **Fix**: Ensure matrixFolderCreate(name, browserFolderId) has both params

#### "matrixXxx is not a function"
- **Cause**: Method name not updated after refactor
- **Agent**: Type Checker
- **Fix**: Check for method name consistency (matrixBookmark* prefix)

#### "browserFolderId must correspond to actual Chrome folder"
- **Cause**: Using stale/invalid folder IDs
- **Agent**: Metadata Schema
- **Fix**: Verify folder ID from current browser state

#### "No rule defined for: X->Y transition"
- **Cause**: Tier transition not in 32-rule matrix
- **Agent**: Matrix Compliance
- **Fix**: Add transition rule and validate it's correct

### Code Quality

#### "Code duplication opportunity: validation pattern"
- **Cause**: Same validation logic implemented multiple times
- **Agent**: Code Deduplicator
- **Fix**: Extract shared logic to utils module

## When to Use Requirements Gatherer

**Use when:**
- Starting a new feature or major refactor
- User describes problem without clear success criteria
- Scope is ambiguous or could grow unbounded
- Multiple possible interpretations of the request

**Skip when:**
- Fixing a specific bug with clear reproduction steps
- Making a small, well-scoped change
- Continuing work with established requirements
- User explicitly provides requirements document

**Example spawn command:**
```
User: "I need to refactor the metadata system"
Claude: [Spawn Requirements Gatherer to clarify intent before coding]
```

---

## Customization for Other Projects

To adapt this for a different project:

1. **Copy the structure** - Keep Tier 0 (Requirements) → Tiers 1-4 layout
2. **Replace agent checks** - Modify what each agent validates
3. **Adjust commands** - Use your project's build/test commands
4. **Define domain rules** - Replace matrix/metadata checks with your business rules
5. **Set timeouts** - Adjust for your project's speed
6. **Customize Requirements Gatherer** - Adjust clarifying questions for your domain

Example template:
```markdown
## Agent Definitions

### Tier 1: Build (Parallel)
#### Agent: Build
- Command: `your build command`
- Blocking: YES

#### Agent: Lint
- Command: `your lint command`  
- Blocking: YES

### Tier 2: Domain Rules (Parallel)
#### Agent: Business Rule Checker
- Responsibility: Check your domain-specific rules
- Checks: List your rules here
- Blocking: YES/SOFT
```

## Version History

- **2026-06-18 v2.0**: Enhanced agent configuration with security and architecture validation
  - Tier 1: Build & Type Safety (added Type Safety agent)
  - Tier 1.5: Security Scanner (new tier - critical vulnerability detection)
  - Tier 2: Business Logic (added Architecture Validator agent)
  - Tier 2.5: Quality & Deduplication (new tier - code quality advisory)
  - Tier 3: Tests
  - Tier 4: Integration
  - **Total agents**: 10 (up from 6)
  - **Blocking tiers**: 4 (1, 1.5, 2, 3-soft)
  - **Advisory tiers**: 1 (2.5)

- **2026-06-18 v1.0**: Initial agent configuration
  - Tier 1: Build & Type Safety
  - Tier 2: Matrix & Schema Validation  
  - Tier 3: Tests
  - Tier 4: Integration
