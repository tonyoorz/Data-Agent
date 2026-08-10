# Main Dashboard Top Topic Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin every ticket whose requirement contains `Top Topic` at the top of page 1, and reorder requirement display so important labels stay visible first.

**Architecture:** Keep the existing `priority_rows` flow in the backend ticket API and expand its candidate scope so all `Top Topic` tickets participate. Normalize requirement display ordering in the shared frontend adapter so the table receives a stable, user-facing string.

**Tech Stack:** Python analytics API, React/TypeScript main dashboard, Vitest, pytest.

---

### Task 1: Lock the behavior with focused tests

**Files:**
- Modify: `backend/tests/test_analytics_full_picture_api.py`
- Modify: `src/test/main-dashboard/mainDashboardAdapter.test.ts`

- [ ] **Step 1: Write a failing backend regression test**
- [ ] **Step 2: Run the focused pytest slice and verify the new assertion fails for current priority behavior**
- [ ] **Step 3: Write a failing frontend adapter regression test for reordered requirement labels**
- [ ] **Step 4: Run the focused vitest slice and verify the new assertion fails for current display order**

### Task 2: Expand Top Topic priority selection

**Files:**
- Modify: `backend/analytics/read_models.py`

- [ ] **Step 1: Keep page-1-only pinning, but stop excluding eligible Top Topic rows because of the relaxed candidate query shape**
- [ ] **Step 2: Preserve search, sort, and de-dup behavior for pinned rows**
- [ ] **Step 3: Re-run the focused pytest slice until green**

### Task 3: Reorder requirement display labels

**Files:**
- Modify: `src/components/dashboard/main-dashboard/mainDashboardAdapter.ts`

- [ ] **Step 1: Normalize requirement token order to `Top Topic`, then `DOC_PreCon_Prio_CN_26-11`, then remaining values**
- [ ] **Step 2: Keep null/empty handling unchanged for other rows**
- [ ] **Step 3: Re-run the focused vitest slice until green**

### Task 4: Final verification

**Files:**
- Modify: `docs/superpowers/plans/2026-06-03-main-dashboard-top-topic-priority.md`

- [ ] **Step 1: Run focused backend and frontend validation commands together**
- [ ] **Step 2: Record actual results in the final response instead of assuming success**