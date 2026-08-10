# Governed Analysis Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a deterministic, read-only analysis and visualization plan to every valid governed semantic query without permitting arbitrary Python, SQL, or unbounded result processing.

**Architecture:** A new ontology-layer planner will accept only a validated `SemanticFrame` plus its `QueryPlan`. It will map the governed intent to one fixed operation and visualization kind, apply a capped row budget, bind itself to the source query plan, and emit explicit guardrails. `resolveAiAnalyticsContext` will attach this plan to the model context and returned shadow observation; no new tool or code-execution endpoint is introduced.

**Tech Stack:** Node.js ESM, AJV 2020, Vitest, existing ontology resolver/query planner.

---

### Task 1: Define the Read-Only Analysis Plan Contract

**Files:**
- Create: `src/test/server/ontology/analysisPlanner.test.ts`
- Create: `server/ontology/analysisPlanner.mjs`

- [x] **Step 1: Write the failing trend-plan test**

```ts
const analysisPlan = analysisPlanner.createPlan({ frame, queryPlan });

expect(analysisPlan).toMatchObject({
  status: "ready",
  sourcePlanId: queryPlan.planId,
  operation: "time_series",
  visualization: "line",
});
expect(analysisPlan.maxRows).toBeLessThanOrEqual(50);
expect(analysisPlan.guardrails).toEqual(expect.arrayContaining([
  "READ_ONLY_SOURCE_PLAN",
  "NO_ARBITRARY_CODE",
  "NO_ARBITRARY_SQL",
]));
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/test/server/ontology/analysisPlanner.test.ts`

Expected: FAIL because `analysisPlanner.mjs` does not exist.

- [x] **Step 3: Implement the validated analysis planner**

```js
export function createGovernedAnalysisPlanner() {
  return Object.freeze({
    createPlan({ frame, queryPlan }) {
      // Map only validated intents to a fixed analysis operation and rendering kind.
      // Bind the output to queryPlan.planId and cap rows by rendering type.
    },
  });
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/test/server/ontology/analysisPlanner.test.ts`

Expected: PASS.

### Task 2: Handle Clarification and High-Risk Semantics

**Files:**
- Modify: `src/test/server/ontology/analysisPlanner.test.ts`
- Modify: `server/ontology/analysisPlanner.mjs`

- [x] **Step 1: Add failing blocked-plan tests**

```ts
expect(analysisPlanner.createPlan({ frame: ambiguousFrame, queryPlan: ambiguousQueryPlan }))
  .toMatchObject({ status: "needs_clarification", operation: "none", visualization: "none", maxRows: 0 });

expect(analysisPlanner.createPlan({ frame: similarityFrame, queryPlan: similarityQueryPlan }).guardrails)
  .toContain("SIMILARITY_NOT_POPULATION_STATISTIC");
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/test/server/ontology/analysisPlanner.test.ts`

Expected: FAIL until clarification and similarity rules are implemented.

- [x] **Step 3: Implement the minimum safe profiles**

Use `needs_clarification`/`none` for non-valid source plans and add the similarity guardrail without enabling unsupported statistical inference.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/test/server/ontology/analysisPlanner.test.ts`

Expected: PASS.

### Task 3: Attach the Plan to Agent Context

**Files:**
- Modify: `src/test/server/aiAnalyticsContext.test.ts`
- Modify: `server/aiAnalyticsContext.mjs`

- [x] **Step 1: Add a failing context assertion**

```ts
expect(resolved.contextText).toContain("# Governed analysis plan");
expect(resolved.analysisPlan).toMatchObject({ operation: "ranked_comparison", visualization: "bar" });
```

- [x] **Step 2: Run the context test to verify it fails**

Run: `npm test -- src/test/server/aiAnalyticsContext.test.ts`

Expected: FAIL because the plan is not yet attached to context.

- [x] **Step 3: Attach only the deterministic plan**

```js
analysisPlan = createGovernedAnalysisPlanner().createPlan({ frame: semanticFrame, queryPlan: semanticPlan });
semanticContext = governedContext(semanticFrame, semanticPlan, ontologyRegistry, analysisPlan);
```

Do not add an execution tool, Python runtime, arbitrary SQL, or model-selected operation.

- [x] **Step 4: Run focused regression tests**

Run: `npm test -- src/test/server/ontology/analysisPlanner.test.ts src/test/server/ontology/semanticResolver.test.ts src/test/server/ontology/queryPlanner.test.ts src/test/server/aiAnalyticsContext.test.ts`

Expected: PASS.

### Task 4: Verify and Review

**Files:**
- Create: `server/ontology/analysisPlanner.mjs`
- Create: `src/test/server/ontology/analysisPlanner.test.ts`
- Modify: `server/aiAnalyticsContext.mjs`
- Modify: `src/test/server/aiAnalyticsContext.test.ts`

- [x] **Step 1: Run static and whitespace checks**

Run: `node --check server/ontology/analysisPlanner.mjs; node --check server/aiAnalyticsContext.mjs; git diff --check -- server/ontology/analysisPlanner.mjs server/aiAnalyticsContext.mjs src/test/server/ontology/analysisPlanner.test.ts src/test/server/aiAnalyticsContext.test.ts`

Expected: exit code `0`.

- [x] **Step 2: Request a focused read-only review**

Review source-plan binding, intent mappings, row limits, blocked-plan behavior, and the absence of arbitrary execution.

### Task 5: Review-Driven Integrity Hardening

**Files:**
- Modify: `server/ontology/fingerprint.mjs`
- Modify: `server/ontology/semanticFrame.mjs`
- Modify: `server/ontology/resolver.mjs`
- Modify: `server/ontology/queryPlanner.mjs`
- Modify: `server/ontology/analysisPlanner.mjs`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Test: `src/test/server/ontology/queryPlanner.test.ts`
- Test: `src/test/server/ontology/analysisPlanner.test.ts`
- Test: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

- [x] **Step 1: Bind query plans to executable payloads**

Add `executionFingerprint` to the QueryPlan schema and include it in the deterministic `planId`; reject altered status, violations, steps, or canonical arguments before creating an analysis plan.

- [x] **Step 2: Bind similarity payloads to the effective source query**

Hash a normalized `query + clarification.text` in `SemanticFrame`; require the similarity payload, QueryPlan, and analysis planner to match that digest. The raw effective text remains transient and is not persisted in ontology or audit artifacts.

- [x] **Step 3: Restrict durable provenance to deterministic metadata**

Persist only a schema-validated compact plan in LangGraph checkpoints/events. Require `analysis-<16 hex>` and `plan-<16 hex>` identifiers, hash fingerprints, a version format, and allowlisted guardrails; omit invalid candidate plans.

- [x] **Step 4: Verify end-to-end behavior**

Run: `npm test -- src/test/server/ontology/semanticCandidate.test.ts src/test/server/ontology/semanticResolver.test.ts src/test/server/ontology/queryPlanner.test.ts src/test/server/ontology/analysisPlanner.test.ts src/test/server/aiAnalyticsContext.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts src/test/server/agentRuntime/langGraphChatHandler.test.ts src/test/server/mainAgentTools.test.ts src/test/server/mainAgentToolLoop.test.ts`

Expected: PASS.

- [x] **Step 5: Isolate observer events from persistent runtime state**

Deliver a deep copy to `onEvent` observers while retaining the internal event object for runtime state and persistence. Verify that an observer which mutates analysis-plan fields cannot alter the checkpoint or run-event audit record.

- [x] **Step 6: Canonicalize executable similarity payloads**

Use the normalized effective source query as the only similarity payload emitted by QueryPlanner. Require AnalysisPlanner to reject NFKC- or whitespace-equivalent but noncanonical payloads even when their source digest, step fingerprint, and plan ID are recomputed.

**Note:** No commit is included because the current feature branch has pre-existing uncommitted work and the user did not request integration.