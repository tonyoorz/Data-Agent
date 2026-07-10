# QGate Weekly Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live Weekly Report page directly below QGate KPI Report and above AI Chat in the dashboard navigation, covering defect quality and test-case weekly status from the current SQLite source data.

**Architecture:** Keep the existing static QGate KPI iframe page intact. Add one analytics API payload builder for weekly report aggregations, expose it through FastAPI, then render compact Recharts cards in the standalone `QGateWeeklyReport` page.

**Tech Stack:** Python sqlite3/FastAPI, React 18, React Query, Recharts, Vitest, pytest.

---

### Task 1: Weekly Report Backend Payload

**Files:**
- Create: `backend/analytics/qgate_weekly_report.py`
- Create: `backend/tests/test_qgate_weekly_report.py`
- Modify: `backend/analytics/api.py`

- [x] Write a failing pytest for `build_qgate_weekly_report_payload(db_path=...)` that verifies defect quality rows, defect owner rows, recent test-week tendency, last-week status mix, and planned incoming rows.
- [x] Run `py -3.11 -m pytest backend/tests/test_qgate_weekly_report.py -q` and confirm it fails because the module is missing.
- [x] Implement the smallest SQLite-backed payload builder that passes the test.
- [x] Expose `GET /api/qgate-reports/weekly-report` in `backend/analytics/api.py`.
- [x] Re-run the focused pytest.

### Task 2: Standalone Weekly Report Page Integration

**Files:**
- Modify: `src/components/dashboard/pages/QGateKpiReport.tsx`
- Create: `src/components/dashboard/pages/QGateWeeklyReport.tsx`
- Modify: `src/components/dashboard/DashboardSidebar.tsx`
- Modify: `src/pages/Index.tsx`
- Modify: `src/test/qgate-report/QGateKpiReport.test.tsx`
- Create: `src/test/qgate-report/QGateWeeklyReport.test.tsx`

- [x] Write a failing Vitest case proving the QGate KPI page stays limited to its static iframe and the sidebar places Weekly Report between QGate KPI Report and AI Chat.
- [x] Run `C:\nvm4w\nodejs\node.exe .\node_modules\vitest\vitest.mjs run src/test/qgate-report/QGateKpiReport.test.tsx` and confirm the test fails for missing standalone navigation/page separation.
- [x] Add the standalone Weekly Report page using existing dashboard card and Recharts conventions.
- [x] Re-run the focused Vitest.

### Task 3: Verification

**Files:**
- Same as above.

- [x] Run the backend focused pytest.
- [x] Run the frontend focused Vitest.
- [x] Run a build or explain any existing build blocker if the repository state prevents it.