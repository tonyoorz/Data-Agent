# Data-Agent P0 Semantic Closure Implementation Plan

> **For Codex:** Execute this plan in the isolated worktree with `superpowers:executing-plans`. Apply `superpowers:test-driven-development` to every behavior change and run the verification commands exactly as listed.

**Goal:** Deliver one production-grade semantic analytics loop: governed aggregate/compare results create an `analysis_ref`; records drilldown reuses the same governed scope and source revision; the main Agent receives a machine-checkable Claim/Evidence envelope and fails closed when evidence is absent or stale.

**Architecture:** Keep one main Agent and the existing bounded tool loop. The hidden Semantic Kernel owns query validation, actor scope, source revision, records field allowlists, pagination, and continuation. Add a small SQLite-backed analysis-reference repository on the Python analytics side, a dedicated records primitive, and a deterministic evidence gate on the Node runtime side. Duplicate Search remains unchanged behind its existing tool adapter.

**Scope note:** User/account administration, tenant provisioning, and a new RBAC UI are intentionally out of scope. Existing actor-scope interfaces remain enforced so the internal deployment can add stricter policy later without redesign.

**Tech stack:** Python 3.11, FastAPI, SQLite, Vitest, Node.js ESM, LangGraph runtime.

---

## Baseline qualification

- Worktree: `/Users/tonyorz/Data-Agent/.worktrees/data-agent-p0-semantic-closure`
- Branch: `codex/data-agent-p0-semantic-closure`
- Node focused semantic baseline: 74 passed.
- Python semantic/Ontology baseline: 29 passed.
- Full-suite inherited failures are recorded separately; verification must prove this change introduces no new failures.
- The Ontology generated bundle is rebuilt from `ontology/v1`, including the three governed actions.

## Task 1: Define and persist the analysis-reference contract

**Files:**

- Create: `backend/analytics/semantic_analysis_store.py`
- Test: `backend/tests/test_semantic_analysis_store.py`
- Modify: `backend/analytics/config.py`
- Test: `backend/tests/test_analytics_outcomes.py`

1. Write failing tests for creating, loading, actor-scope isolation, expiry, and unknown refs.
2. Add `get_semantic_analysis_db_path()` using `VIZION_SEMANTIC_ANALYSIS_DB_PATH`, defaulting beside the hot serving database.
3. Implement a SQLite repository with an explicit schema, UTC timestamps, JSON serialization, expiry cleanup, and opaque `analysis-<uuid>` identifiers.
4. Store only the validated semantic query, actor scope hash, ontology version/fingerprint, source revision, and evidence summary. Do not store raw unrestricted prompts.
5. Run:

   ```bash
   /tmp/data-agent-p0-semantic-closure-venv/bin/python -m pytest backend/tests/test_semantic_analysis_store.py backend/tests/test_analytics_outcomes.py -q
   ```

## Task 2: Make aggregate execution snapshot-bound and issue evidence envelopes

**Files:**

- Modify: `backend/analytics/read_models.py`
- Modify: `backend/analytics/semantic_query.py`
- Modify: `backend/tests/test_semantic_query_api.py`

1. Add failing tests proving a defect aggregate returns a pinned source revision, an `analysisRef`, and an evidence envelope containing exact metric/group support.
2. Add a snapshot-bound defect dataset provider that uses the existing materialized snapshot path and accepts an optional requested snapshot revision.
3. Inject the analysis store into `execute_semantic_query`; after successful metric execution, persist the validated continuation and return `analysisRef` plus `evidence`.
4. Preserve the existing API response fields for backward compatibility.
5. Fail closed if a requested source revision is no longer active; never silently continue against a new snapshot.
6. Run:

   ```bash
   /tmp/data-agent-p0-semantic-closure-venv/bin/python -m pytest backend/tests/test_semantic_query_api.py -q
   ```

## Task 3: Implement the governed records primitive

**Files:**

- Modify: `backend/analytics/semantic_query.py`
- Modify: `backend/analytics/api.py`
- Modify: `backend/tests/test_semantic_query_api.py`

1. Write failing tests for direct list queries and aggregate-to-records continuation.
2. Define `/api/semantic/records` request validation with exactly one of:
   - a validated semantic list/drilldown query; or
   - an `analysisRef` plus one or more dimension-value selections.
3. Require a single record entity, allowlisted fields, `page`/`pageSize`, and a maximum page size from Ontology constraints.
4. Derive continuation filters from the stored query. A continuation may narrow the original result but may not remove policy/user filters, widen time, change metrics/entity, or change actor scope.
5. Re-read the source with the stored revision. Return HTTP 409 on stale continuation instead of mixing snapshots.
6. Return raw governed records, pagination metadata, the same `analysisRef`, source revision, scope, quality, and a record-set evidence envelope.
7. Apply sensitive-field policy to record properties, not only dimensions.
8. Run:

   ```bash
   /tmp/data-agent-p0-semantic-closure-venv/bin/python -m pytest backend/tests/test_semantic_query_api.py -q
   ```

## Task 4: Split the Node metric and records tool contracts

**Files:**

- Modify: `server/mainAgentTools.mjs`
- Modify: `server/ontology/queryPlanner.mjs`
- Modify: `src/test/server/mainAgentTools.test.ts`
- Modify: `src/test/server/ontology/queryPlanner.test.ts`

1. Write failing tests proving `query_semantic_metrics` calls `/api/semantic/query` and `query_semantic_records` calls `/api/semantic/records`.
2. Add a strict records tool schema supporting direct query or `analysis_ref`, selections, allowlisted requested fields, page, and page size.
3. Make the query planner emit deterministic defaults for direct list questions. Continuation arguments remain model-visible but backend-validated.
4. Include `analysis_ref`, source revision, record pagination, exact returned rows, and evidence status in tool context.
5. Keep `query_traceability` on the existing query API and keep Duplicate Search untouched.
6. Run:

   ```bash
   npm test -- --run src/test/server/mainAgentTools.test.ts src/test/server/ontology/queryPlanner.test.ts
   ```

## Task 5: Add deterministic Claim/Evidence gating and thread continuation

**Files:**

- Modify: `server/mainAgentEvidence.mjs`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Modify: `server/mainAgentToolPlanning.mjs`
- Modify: `src/test/server/mainAgentToolLoop.test.ts`
- Modify: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

1. Write failing tests for evidence extraction, pass/block decisions, and preserving the most recent `analysis_ref` for an elliptical follow-up in the same thread.
2. Extend tool evidence with `analysisRef`, semantic scope, summary, and backend evidence envelope.
3. Add a deterministic gate:
   - PASS only when analytics output has ontology version, source revision, scope, quality, and evidence;
   - BLOCK numerical/record claims when those fields are absent, stale, denied, or incomplete beyond the returned warning contract.
4. Add the latest valid continuation to the next planning context for the same thread and scope hash. Do not treat it as permission; the backend revalidates it.
5. Reset turn-local LangGraph counters at the start of every invocation so checkpointer state cannot exhaust a later turn's tool budget.
6. Send the persisted AI Chat conversation ID as `threadId`, and inject one server-owned internal deployment principal so the browser cannot forge semantic scope while user/RBAC work remains deferred.
6. Run:

   ```bash
   npm test -- --run src/test/server/mainAgentToolLoop.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts
   ```

## Task 6: End-to-end acceptance and regression separation

**Files:**

- Create: `src/test/server/semanticAnalysisClosure.e2e.test.ts`
- Modify: `evals/main-agent/target/main-agent-golden.jsonl` only if a new governed acceptance case is required and verified.

1. Build an HTTP-fake end-to-end test for:
   - governed aggregate by candidate dimension;
   - anomaly selection;
   - records drilldown with `analysis_ref`;
   - same revision assertion;
   - evidence gate PASS;
   - follow-up context containing the valid ref.
2. Add negative cases for stale revision, widened filters, disallowed fields, and actor-scope mismatch.
3. Run focused qualification:

   ```bash
   npm run ontology:check
   npm test -- --run src/test/server/ontology src/test/server/mainAgentTools.test.ts src/test/server/mainAgentToolLoop.test.ts src/test/server/agentRuntime src/test/server/semanticAnalysisClosure.e2e.test.ts
   /tmp/data-agent-p0-semantic-closure-venv/bin/python -m pytest backend/tests/test_semantic_analysis_store.py backend/tests/test_semantic_query_api.py backend/tests/test_ontology_contract.py -q
   ```

4. Run full suites and compare failures with the captured baseline:

   ```bash
   npm test
   /tmp/data-agent-p0-semantic-closure-venv/bin/python -m pytest backend/tests -q
   ```

5. Report focused status, full-suite inherited failures, and any newly introduced failure separately. Do not claim repository-wide green if inherited failures remain.

## Definition of done

- Aggregate/compare results return a durable `analysis_ref` and explicit evidence.
- Records are raw allowlisted records, not grouped aggregates.
- Drilldown cannot widen scope or silently change source revision.
- Pagination, actor scope, property sensitivity, Ontology version, and audit evidence are enforced server-side.
- The main Agent uses one bounded loop and has a deterministic evidence pass/block state.
- Duplicate Search behavior is unchanged.
- Focused Node/Python suites and Ontology check pass; full-suite deltas are honestly reported.
