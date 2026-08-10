# Semantic Closure Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the semantic-analysis closure with the local governed semantic-planning work without losing snapshot-bound drilldown or claim-evidence enforcement.

**Architecture:** Keep the remote branch as the execution baseline: Python owns `analysisRef`, source revisions, governed record continuations, and evidence envelopes. Layer the local deterministic analysis planner, compact candidate catalog, business-rule-aware resolver, and final citation contract onto the existing single LangGraph tool loop. No new agent roles, arbitrary SQL, or arbitrary code execution are introduced.

**Tech Stack:** Node.js ESM, Vitest, FastAPI, SQLite, existing compiled ontology.

---

### Task 1: Establish Governance Regression Tests

**Files:**
- Create: `src/test/server/ontology/analysisPlanner.test.ts`
- Create: `src/test/server/ontology/semanticCandidate.test.ts`
- Create: `src/test/server/answerValidator.test.ts`

- [x] **Step 1: Add the existing intended-contract tests before importing the implementation**

Copy the local tests unchanged so the clean semantic-closure branch demonstrates the missing contract at import time.

- [x] **Step 2: Verify the tests fail for the expected missing modules**

Run:

```powershell
npm test -- --run src/test/server/ontology/analysisPlanner.test.ts src/test/server/ontology/semanticCandidate.test.ts src/test/server/answerValidator.test.ts
```

Expected: imports fail only because `analysisPlanner.mjs` and `answerValidator.mjs` are absent, and candidate catalog exports are absent.

### Task 2: Restore Deterministic Semantic Planning

**Files:**
- Create: `server/ontology/analysisPlanner.mjs`
- Modify: `server/ontology/semanticCandidate.mjs`
- Modify: `server/aiAnalyticsContext.mjs`
- Modify: `server/ontology/queryPlanner.mjs`
- Modify: `server/ontology/resolver.mjs`

- [x] **Step 1: Add `createGovernedAnalysisPlanner()` and schema validation**

The planner must accept a validated `SemanticFrame` and `QueryPlan`, bind the plan ID and execution fingerprint, cap row budgets by visualization, and return `needs_clarification` rather than an executable analysis plan for invalid source plans.

- [x] **Step 2: Reuse one compact candidate catalog for the schema and prompt**

`createSemanticCandidateCatalog({ registry, query })` must select matched metrics, dimensions, entities, and vocabulary terms, while retaining full-catalog fallback for unmatched queries.

- [x] **Step 3: Attach the validated analysis plan to semantic context and shadow observation**

`resolveAiAnalyticsContext()` must return `analysisPlan` and render a governed plan section without adding executable code or SQL tools.

- [x] **Step 4: Verify the focused ontology tests pass**

Run:

```powershell
npm test -- --run src/test/server/ontology/analysisPlanner.test.ts src/test/server/ontology/semanticCandidate.test.ts src/test/server/ontology/queryPlanner.test.ts src/test/server/aiAnalyticsContext.test.ts
```

Expected: all tests pass.

### Task 3: Bind Semantic Evidence to Final Answers

**Files:**
- Create: `server/answerValidator.mjs`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Modify: `server/companyChat.mjs`
- Modify: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`
- Modify: `src/test/server/companyChat.test.ts`

- [x] **Step 1: Add the answer citation contract implementation**

Use ontology constraint `answer.claim_evidence_binding` to validate tool-call citations and construct a prompt-safe citation contract from remote evidence envelopes.

- [x] **Step 2: Carry the contract through the LangGraph final context**

Final model context must contain both the remote semantic evidence gate and the citation contract. It must retain the single bounded model-tool loop.

- [x] **Step 3: Emit answer-validation before SSE completion**

The stream must validate final visible citations against collected evidence and emit an `answer-validation` event before `[DONE]`.

- [x] **Step 4: Verify answer and runtime tests pass**

Run:

```powershell
npm test -- --run src/test/server/answerValidator.test.ts src/test/server/companyChat.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts src/test/server/mainAgentEvidence.test.ts src/test/server/semanticAnalysisClosure.e2e.test.ts
```

Expected: all tests pass, including same-revision aggregate-to-records drilldown.

### Task 4: Reconcile Ontology Runtime Assets

**Files:**
- Create: `ontology/schema/business_rules.schema.json`
- Modify: `ontology/v1/business_rules.json`
- Modify: `scripts/compileOntology.mjs`
- Modify: `server/ontology/registry.mjs`
- Modify: `server/ontology/validator.mjs`
- Test: `src/test/server/ontology/compiler.test.ts`
- Test: `src/test/server/ontology/registry.test.ts`

- [x] **Step 1: Restore business-rule schema and source asset without changing governance status**

The merge preserves existing approved/draft states; no metric becomes executable solely because it is imported.

- [x] **Step 2: Compile rules into the generated ontology and expose them through the registry**

`npm run ontology:check` must validate sources instead of accepting a generated artifact disconnected from source rules.

- [x] **Step 3: Verify ontology and semantic closure regressions**

Run:

```powershell
npm run ontology:check
npm test -- --run src/test/server/ontology src/test/server/mainAgentTools.test.ts src/test/server/mainAgentToolLoop.test.ts src/test/server/agentRuntime src/test/server/semanticAnalysisClosure.e2e.test.ts
```

Expected: ontology compilation succeeds and Node semantic-closure behavior remains green.

### Task 5: Verify Python Closure Contracts

**Files:**
- Test: `backend/tests/test_semantic_analysis_store.py`
- Test: `backend/tests/test_semantic_query_api.py`

- [x] **Step 1: Verify analysis-reference store lifecycle and scope isolation**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_semantic_analysis_store.py -q
```

Expected: analysis references expire and cannot cross actor scopes.

- [x] **Step 2: Verify aggregate-to-records continuation against a pinned revision**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_semantic_query_api.py -q
```

Expected: records continuations cannot widen filters or silently move to a new source revision.

### Task 6: Harden Runtime Failure Boundaries

**Files:**
- Create: `server/mainAgentDirectIntent.mjs`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Modify: `server/agentRuntime/langGraphChatHandler.mjs`
- Modify: `server/companyChat.mjs`
- Test: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`
- Test: `src/test/server/agentRuntime/langGraphChatHandler.test.ts`
- Test: `src/test/server/companyChat.test.ts`

- [x] **Step 1: Bypass model and tools for deterministic greeting and out-of-scope responses**

Direct-response classification is bounded to predefined chitchat and out-of-scope patterns; all analytics requests continue through the normal LangGraph tool loop.

- [x] **Step 2: Persist valid analysis-plan provenance and terminal runtime failures**

Only schema-valid, compact analysis plans enter checkpoints and runtime events. Graph errors append an `agent-runtime-failed` event with run, thread, actor scope, and error metadata.

- [x] **Step 3: Retry transient model transport failures with a bounded timeout**

The company model client retries only 408, 429, and 5xx responses or transient network/timeout errors, using `DUPSEARCH_CHAT_MAX_ATTEMPTS`, `DUPSEARCH_CHAT_TIMEOUT_MS`, and `DUPSEARCH_CHAT_RETRY_DELAY_MS`.

- [x] **Step 4: Verify direct, audit, and retry behavior**

Run:

```powershell
npm test -- --run src/test/server/agentRuntime/langGraphChatRuntime.test.ts src/test/server/agentRuntime/langGraphChatHandler.test.ts src/test/server/companyChat.test.ts
```

Expected: direct replies bypass model completion, failures are audited, and one retry recovers a retryable upstream error.

### Scope Boundaries

- Do not approve draft ontology metrics or rules without a subject-matter decision.
- Do not add a second planner, supervisor, multi-agent system, raw SQL fallback, or sandboxed code runner.
- Defer Context Build Plane, verified-analysis repository expansion, formal multi-user persistence, and P2 performance work until P0 tests prove the runtime closure.