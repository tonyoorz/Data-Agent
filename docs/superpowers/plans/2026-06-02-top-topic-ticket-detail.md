# Top Topic Ticket Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pinned Top Topic rows to the Full Picture Ticket Detail table that ignore Creation Time and Problem Finder Team dashboard filters, but still respect all other dashboard filters and frontend drilldown.

**Architecture:** Extend the tickets API payload with `priority_rows`, derive those rows from the same snapshot using a relaxed backend query, then adapt and prepend them on the frontend after drilldown narrowing. Keep total row counts and normal pagination semantics unchanged.

**Tech Stack:** FastAPI, SQLite snapshot reads, React Query, React, Vitest, Pytest

---

### Task 1: Backend tickets payload and query logic

**Files:**
- Modify: `backend/tests/test_analytics_full_picture_api.py`
- Modify: `backend/analytics/read_models.py`

- [ ] **Step 1: Write the failing backend tests**

Add API coverage for `priority_rows` on page 1, page 2, and other-filter exclusion.

- [ ] **Step 2: Run the focused backend tests and verify they fail**

Run: `py -3.11 -m pytest backend/tests/test_analytics_full_picture_api.py -q`
Expected: FAIL in the new Top Topic tickets assertions

- [ ] **Step 3: Implement minimal backend support**

Add `priority_rows` to the ticket payload, derive a relaxed query that clears only creation-time and problem-finder-team filters, and filter it to Top Topic requirements from the same snapshot.

- [ ] **Step 4: Run the focused backend tests and verify they pass**

Run: `py -3.11 -m pytest backend/tests/test_analytics_full_picture_api.py -q`
Expected: PASS

### Task 2: Frontend ticket page adaptation and rendering

**Files:**
- Modify: `src/test/main-dashboard/MainDashboardDataLoading.test.tsx`
- Modify: `src/components/dashboard/main-dashboard/mainDashboardTypes.ts`
- Modify: `src/components/dashboard/main-dashboard/mainDashboardAdapter.ts`
- Modify: `src/components/dashboard/pages/MainDashboard.tsx`
- Modify: `src/components/dashboard/main-dashboard/TicketDetailTable.tsx`

- [ ] **Step 1: Write the failing frontend tests**

Add page-level coverage for rendering pinned Top Topic rows first on page 1 and hiding them on page 2.

- [ ] **Step 2: Run the focused frontend tests and verify they fail**

Run: `& 'C:/nvm4w/nodejs/npm.cmd' test -- src/test/main-dashboard/MainDashboardDataLoading.test.tsx`
Expected: FAIL in the new pinned-row assertions

- [ ] **Step 3: Implement minimal frontend support**

Adapt `priority_rows`, apply drilldown to both row groups, prepend deduplicated pinned rows before normal rows, and show a lightweight pinned-row indicator.

- [ ] **Step 4: Run the focused frontend tests and verify they pass**

Run: `& 'C:/nvm4w/nodejs/npm.cmd' test -- src/test/main-dashboard/MainDashboardDataLoading.test.tsx`
Expected: PASS

### Task 3: Regression verification

**Files:**
- Modify: `backend/tests/test_analytics_full_picture_api.py`
- Modify: `src/test/main-dashboard/MainDashboardDataLoading.test.tsx`

- [ ] **Step 1: Run combined focused verification**

Run: `py -3.11 -m pytest backend/tests/test_analytics_full_picture_api.py -q ; & 'C:/nvm4w/nodejs/npm.cmd' test -- src/test/main-dashboard/MainDashboardDataLoading.test.tsx src/test/main-dashboard/TicketDetailTable.test.tsx`
Expected: all focused backend and frontend tests pass

- [ ] **Step 2: Run broader build verification**

Run: `& 'C:/nvm4w/nodejs/npm.cmd' run build`
Expected: build passes