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

- [x] **Step 2: Fix Test Suite Regressions**
  - [x] Fix `src/ui/__tests__/games.test.ts` controller naming mismatch.
  - [x] Fix `src/modules/__tests__/metadata-fetcher.test.ts` timer/rate-limiter tests and Steam API / SteamSpy mock sequencing.
  - [x] Fix `src/modules/__tests__/game-library.test.ts` singleton test pollution, hex keys, and publish fallback.
  - [x] Fix `src/modules/storage.test.ts` and `src/__tests__/integration.test.ts` messaging & storage mocks.
  - [x] Fix `tests/activity-datastore.test.ts`, `tests/invite-cleanup.test.ts`, and `tests/storage-manager.test.ts`.
  - [x] Run full test suite and ensure 100% pass rate (`cmd /c npm run test:run` — 265/265 tests passing across 11 files).
  - [x] Fix duplicate class member `_showSuccess` warning in `src/ui/popup.ts`.

- [x] **Step 3: Verification & Baseline Commit**
  - [x] Verify Chrome and Firefox builds (`cmd /c npm run build:all`).
  - [x] Commit all fixes to `feat/antigravity-dev` with atomic commit.
  - [x] Push to origin.

---

## 📌 Next Immediate Step
Ready for next task (Session Model divergence / feature development).
