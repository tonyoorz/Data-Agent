# Analytics Orchestrator Empty Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace brittle low-level analytics tool picking with a small high-level query and empty-result recovery path for main AI Chat.

**Architecture:** Keep the existing analytics APIs as the execution layer, but expose higher-level main-agent tools: `query_analytics` for governed defect aggregate/list-style questions and `diagnose_analytics_empty` for systematic no-data recovery. The main tool loop remains bounded and policy-gated; the planner is instructed to use diagnosis after empty or suspiciously small results before answering no data.

**Tech Stack:** Node ESM main-agent tools, Vitest server tests, existing Python analytics API `/api/analytics/defects/aggregate` and `/api/full-picture/dashboard/summary`.

---

### Task 1: High-Level Analytics Tools

**Files:**
- Modify: `server/mainAgentTools.mjs`
- Modify: `src/test/server/mainAgentTools.test.ts`

- [x] **Step 1: Write failing tests for high-level tool registration and execution**

Add tests that assert `MAIN_AGENT_TOOLS` exposes `query_analytics` and `diagnose_analytics_empty`, and that `query_analytics` posts a normalized defect aggregate payload to `/api/analytics/defects/aggregate`.

- [x] **Step 2: Run the tests to verify failure**

Run: `npx vitest run src/test/server/mainAgentTools.test.ts`

Expected: FAIL because the two high-level tools do not exist.

- [x] **Step 3: Implement minimal high-level tool definitions and executors**

Add `query_analytics` with a constrained schema: `dataset=defects`, metrics, dimensions, filters, time, order_by, limit. Add `diagnose_analytics_empty` with the same query shape plus optional `reason`. Implement both by reusing existing URL/POST helpers and aggregate payload formatting.

- [x] **Step 4: Run the focused tool tests**

Run: `npx vitest run src/test/server/mainAgentTools.test.ts`

Expected: PASS.

### Task 2: Empty-Result Diagnosis

**Files:**
- Modify: `server/mainAgentTools.mjs`
- Modify: `src/test/server/mainAgentTools.test.ts`

- [x] **Step 1: Write failing diagnosis test**

Add a test where `diagnose_analytics_empty` receives filters `{problem_finder_teams:["DTSV_China"], detected_by:["Size Li"]}` and the mock analytics API returns counts for baseline and relaxed variants.

- [x] **Step 2: Run the test to verify failure**

Run: `npx vitest run src/test/server/mainAgentTools.test.ts -t diagnose_analytics_empty`

Expected: FAIL because diagnosis execution is not implemented.

- [x] **Step 3: Implement filter relaxation probes**

Probe the original query, then one query per removable filter key. Keep time and years stable. Return `diagnostics.probes` with labels, filters, count, and recommendation text.

- [x] **Step 4: Run the diagnosis test**

Run: `npx vitest run src/test/server/mainAgentTools.test.ts -t diagnose_analytics_empty`

Expected: PASS.

### Task 3: Toolset and Planner Integration

**Files:**
- Modify: `server/mainAgentToolsets.mjs`
- Modify: `server/mainAgentToolLoop.mjs`
- Modify: `src/test/server/mainAgentToolLoop.test.ts`

- [x] **Step 1: Write failing planner tests**

Update metric, high-frequency, and legacy-dashboard toolset expectations so each data intent includes `query_analytics` and `diagnose_analytics_empty` while still keeping compact toolsets.

- [x] **Step 2: Run the loop tests to verify failure**

Run: `npx vitest run src/test/server/mainAgentToolLoop.test.ts`

Expected: FAIL because the compact toolsets do not expose the new high-level tools.

- [x] **Step 3: Add new tools to compact data toolsets and planning prompt**

Add `query_analytics` and `diagnose_analytics_empty` to `metric_query`, `record_query`, `high_frequency`, and `legacy_dashboard`. Update the planning context to prefer `query_analytics` for defect analytics and to call diagnosis before concluding that no data exists.

- [x] **Step 4: Run loop tests**

Run: `npx vitest run src/test/server/mainAgentToolLoop.test.ts`

Expected: PASS.

### Task 4: Regression Validation

**Files:**
- Validate: `server/mainAgentTools.mjs`
- Validate: `server/mainAgentToolLoop.mjs`
- Validate: `backend/tests/test_analytics_full_picture_api.py`

- [x] **Step 1: Run all focused Node agent tests**

Run: `npx vitest run src/test/server/mainAgentTools.test.ts src/test/server/mainAgentToolLoop.test.ts`

Expected: PASS.

- [x] **Step 2: Run focused backend detected_by tests**

Run: `.\.venv\Scripts\python.exe -m pytest backend/tests/test_analytics_full_picture_api.py -k detected_by`

Expected: PASS.

- [x] **Step 3: Run diff and diagnostics checks**

Run: `git diff --check -- server/mainAgentTools.mjs server/mainAgentToolLoop.mjs server/mainAgentToolsets.mjs src/test/server/mainAgentTools.test.ts src/test/server/mainAgentToolLoop.test.ts backend/tests/test_analytics_full_picture_api.py`

Expected: no output.

---

## Notes

- This plan deliberately keeps old low-level tools in place for compatibility.
- This plan does not introduce arbitrary SQL or broad schema mutation.
- A future phase can move `query_analytics` into a Python-side query planner endpoint once the Node tool contract is stable.