# Agent Orchestration System

This document explains how the agent validation pipeline works and how to trigger it.

## Overview

The Agent Orchestration System reads `AGENTS.md` and automatically orchestrates specialized agents to validate code changes. It ensures:

1. **Code compiles** (no syntax errors)
2. **Functions exist** (no broken references)
3. **Business rules enforced** (matrix, metadata schema)
4. **Tests pass** (regressions caught)
5. **Extensions build** (deliverables valid)

## How It Works

### 1. Configuration Read
- Reads `AGENTS.md` 
- Parses agent definitions, checks, and dependencies
- Builds execution plan (tiers and parallelization)

### 2. Tier-Based Execution
**Tier 1: Syntax & Type Safety** (Parallel)
- Code Builder: `npm run build:all` 
- Type Checker: Scan for broken references

Both must pass before proceeding.

**Tier 2: Business Logic** (Parallel)
- Matrix Compliance: Check tier transitions, metadata rules
- Metadata Schema: Check field consistency

Both must pass before proceeding.

**Tier 3: Tests** (Sequential)
- Test Runner: `npm test`
- Soft block (warns but doesn't stop pipeline)

**Tier 4: Integration** (Sequential)
- Extension Build Verification: Validate outputs

### 3. Results & Reporting

Each agent reports:
- ✅ **PASS** - Check succeeded
- ❌ **FAIL** - Check failed (blocking tier exits immediately)
- ⚠️ **WARN** - Soft check, progress continues

Pipeline status:
- 🟢 **PASS** - All tiers succeeded
- 🔴 **FAIL** - Blocker failed (indicates which agent/tier)
- 🟡 **WARN** - Non-blocking issues detected

## Invoking the Pipeline

### Method 1: Manual Invocation
```
User: Check code against agents
Assistant: Spawn orchestrator agent that reads AGENTS.md and runs validation pipeline
```

### Method 2: Pre-Commit Hook (Future)
Could be integrated as git pre-commit hook to auto-validate before commit.

### Method 3: CI/CD (Future)
Could be integrated into GitHub Actions/CI pipeline.

## Current Implementation

The system uses specialized agent types:

### Agent: Type Checker (Business Logic Validation)
```
Scans codebase for:
- Undefined function calls
- Method name consistency
- Orphaned references to renamed functions
- Type mismatches (where statically detectable)

Returns:
- List of issues found
- Locations and context
- Severity (error vs warning)
```

### Agent: Matrix Compliance (Domain Rules)
```
Validates metadata matrix rules:
- All tier transitions use 32-rule matrix
- browserFolderId always present in folder metadata
- UUID fields consistent
- keepForever flag transitions valid

Returns:
- Rule violations found
- Affected code locations
- Suggested fixes
```

### Agent: Metadata Schema (Domain Rules)
```
Validates metadata consistency:
- All required fields present
- Type correctness
- Referential integrity
- No orphaned metadata

Returns:
- Schema violations
- Data inconsistencies
- Integrity issues
```

## Extending for Your Project

To add a new validation agent:

1. **Define in AGENTS.md**
```markdown
#### Agent: Your Validator
- Responsibility: What to check
- Checks: List specific checks
- Blocking: YES/SOFT
- Timeout: 60s
```

2. **Implement Check Logic**
The orchestrator will spawn an agent with instructions to:
- Scan specific files
- Check specific rules
- Report results in standard format

3. **Integrate into Tier**
Add to appropriate tier (Syntax, Logic, Tests, Integration)

## For Multiple Projects

### Generic Setup

1. Create `AGENTS.md` in project root with your rules
2. Create similar `AGENT_ORCHESTRATION.md` explaining your agents
3. Orchestrator reads both and runs validation

### Template AGENTS.md Structure
```markdown
# Agent Configuration - [PROJECT_NAME]

## Agent Definitions

### Tier 1: Build & Syntax (Parallel)
#### Agent: Build
- Command: `your build command`
- Blocking: YES

### Tier 2: Domain Rules (Parallel)
#### Agent: Business Rule Checker
- Responsibility: Your domain rules
- Checks: List specific checks
- Blocking: YES

### Tier 3: Tests (Sequential)
#### Agent: Test Runner
- Command: `your test command`
- Blocking: SOFT

### Tier 4: Integration (Sequential)
#### Agent: Integration Verifier
- Checks: Your integration checks
- Blocking: YES
```

## Failure Recovery

If a validation fails:

1. **Read failure message** - Agent reports which check failed
2. **Find the fix** - Refer to "Common Failure Patterns" in AGENTS.md
3. **Make fix** - Apply code change
4. **Re-run pipeline** - Validation re-executes
5. **Gate progress** - Only proceed once all blockers pass

## Example Scenarios

### Scenario: Function Renamed
1. Rename `matrixTransition` → `matrixBookmarkTransition`
2. Update 2 callers but miss 1
3. Type Checker agent catches undefined reference
4. Pipeline fails at Tier 1
5. Developer fixes missed caller
6. Re-run validation
7. All agents pass
8. Can proceed with commit

### Scenario: Matrix Rule Violated
1. Add tier transition without matrix entry
2. Code builds fine (Tier 1 passes)
3. Matrix Compliance agent detects violation
4. Pipeline fails at Tier 2
5. Developer adds matrix rule
6. Re-run validation
7. Tiers 1-2 pass
8. Can proceed

### Scenario: Metadata Field Missing
1. Create folder metadata without browserFolderId
2. Builds and type checks pass (Tier 1)
3. Matrix compliance passes (not checking this yet)
4. Metadata Schema agent detects missing field
5. Pipeline fails at Tier 2
6. Developer adds required field
7. Re-run validation
8. All tiers pass
9. Can proceed

## Performance Notes

- **Parallel execution** (Tier 1 & 2) significantly reduces validation time
- **Early exit** on blocking failure prevents wasted checks
- **Typical run time**: 3-5 minutes for full pipeline
- **Optimal**: Run incrementally as you code, not just before commit

## Future Enhancements

Potential additions:
- Performance profiling agent
- Security scanning agent
- Documentation completeness agent
- Code coverage validation agent
- Integration test agent
- Deployment readiness agent

Each can be added to AGENTS.md and integrated into appropriate tier.

## Contact & Support

Issues with agents:
1. Check specific agent definition in AGENTS.md
2. Review "Common Failure Patterns" section
3. Verify files scanned exist
4. Check timeouts aren't too short

For generic system questions, refer to orchestration logic and tier definitions above.
