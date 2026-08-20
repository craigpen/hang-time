# Active Task: Guidelines Setup & Test Suite Stabilization

## 🎯 Current Goal
Establish disciplined development guidelines and stabilize the automated test suite so that all unit and integration tests pass cleanly as our baseline for future feature development.

## 💡 Rationale & Architectural Context
- Development guidelines have been codified in `claude.md` to prevent amnesia, missed verifications, and architectural violations across AI sessions (both Antigravity and Claude).
- The test suite currently has 109 failing tests out of 265 due to minor naming mismatches (`DiscoveryTabController` vs `GamesTabController`) and Vitest timer handling in `metadata-fetcher.test.ts`. Stabilizing tests gives us a solid, verifiable baseline before proceeding with Session Model divergence features.

---

## 📋 Task Checklist

- [x] **Step 1: Codify Invariants and Operational Loop**
  - [x] Update `claude.md` with non-negotiable architectural invariants.
  - [x] Define mandatory 5-step operational loop (Anchor $\rightarrow$ Code $\rightarrow$ Verify $\rightarrow$ Commit $\rightarrow$ Sync).
  - [x] Create `ACTIVE_TASK.md` as the working memory anchor.

- [ ] **Step 2: Fix Test Suite Regressions**
  - [ ] Fix `src/ui/__tests__/games.test.ts` controller naming mismatch.
  - [ ] Fix `src/modules/__tests__/metadata-fetcher.test.ts` timer/rate-limiter tests.
  - [ ] Run full test suite and ensure 100% pass rate (`cmd /c npm run test:run`).
  - [ ] Fix duplicate class member `_showSuccess` warning in `src/ui/popup.ts`.

- [ ] **Step 3: Verification & Baseline Commit**
  - [ ] Verify Chrome and Firefox builds (`cmd /c npm run build:all`).
  - [ ] Commit all fixes to `feat/antigravity-dev` with atomic commit.
  - [ ] Push to origin.

---

## 📌 Next Immediate Step
Fix the `GamesTabController` import/class name mismatch in `src/ui/__tests__/games.test.ts` and resolve Vitest timer mocks in `src/modules/__tests__/metadata-fetcher.test.ts`.
