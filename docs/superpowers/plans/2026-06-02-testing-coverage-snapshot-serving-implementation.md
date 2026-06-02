# Testing Coverage Snapshot Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move only the testing coverage analysis page to a published hot-snapshot read model with stable online reads.

**Architecture:** Source ingest remains unchanged in `database/source/qgate_raw.db`. A dedicated testing snapshot refresh publishes versioned coverage rows into the hot DB, and all coverage-analysis APIs read only the active published testing snapshot.

**Tech Stack:** Python, FastAPI, SQLite, React Query, Vitest, Pytest

---

### Task 1: Add testing snapshot metadata and versioned hot rows

**Files:**
- Modify: `backend/analytics/testing_coverage_hot.py`
- Test: `backend/tests/test_analytics_schema.py`

- [ ] Write failing pytest coverage for published testing snapshots and active pointer behavior.
- [ ] Run the focused pytest slice and verify it fails for missing snapshot-version support.
- [ ] Implement `snapshot_version` storage, testing snapshot state tables, and active-pointer activation in the hot refresh path.
- [ ] Re-run the focused pytest slice and verify it passes.

### Task 2: Move coverage read models to hot snapshot only

**Files:**
- Modify: `backend/analytics/testing_coverage_models.py`
- Test: `backend/tests/test_analytics_tap_coverage_api.py`

- [ ] Write failing pytest coverage for active-snapshot reads and `503` behavior when no snapshot is published.
- [ ] Run the focused pytest slice and verify it fails for current source fallback behavior.
- [ ] Implement active testing snapshot resolution and query only rows matching the published `snapshot_version`.
- [ ] Re-run the focused pytest slice and verify it passes.

### Task 3: Expose a stable testing refresh command

**Files:**
- Modify: `backend/analytics_cli.py`
- Test: `backend/tests/test_analytics_schema.py`

- [ ] Write failing pytest coverage for `refresh-testing-coverage-hot` using the new snapshot publish flow.
- [ ] Run the focused pytest slice and verify it fails if the CLI does not publish an active snapshot.
- [ ] Implement the CLI command and summary output for testing snapshot refresh.
- [ ] Re-run the focused pytest slice and verify it passes.

### Task 4: Keep the coverage page contract stable

**Files:**
- Modify: `src/components/dashboard/coverage-analysis/coverageAnalysisApi.ts` only if response handling needs metadata-safe updates.
- Test: `src/test/coverage-analysis/coverageAnalysisApi.test.ts`
- Test: `src/test/coverage-analysis/CoverageAnalysisPage.test.tsx`

- [ ] Add or adjust focused frontend tests only if backend behavior changes surface new ready/not-ready expectations.
- [ ] Run the focused Vitest slice and verify the page contract stays green.

### Task 5: Validate end-to-end focused slices

**Files:**
- Modify: none unless regressions appear.
- Test: `backend/tests/test_analytics_schema.py`
- Test: `backend/tests/test_analytics_tap_coverage_api.py`
- Test: `src/test/coverage-analysis/CoverageAnalysisPage.test.tsx`
- Test: `src/test/coverage-analysis/coverageAnalysisApi.test.ts`
- Test: `src/test/coverage-analysis/coverageAnalysisSelection.test.ts`

- [ ] Run `py -3.11 -m pytest backend/tests/test_analytics_schema.py backend/tests/test_analytics_tap_coverage_api.py -q`.
- [ ] Run `& 'C:/nvm4w/nodejs/npm.cmd' test -- src/test/coverage-analysis/CoverageAnalysisPage.test.tsx src/test/coverage-analysis/coverageAnalysisApi.test.ts src/test/coverage-analysis/coverageAnalysisSelection.test.ts`.
- [ ] If both pass, confirm the implementation is ready for live refresh testing against local data.