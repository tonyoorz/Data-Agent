# Trusted Closure P0.1 Deterministic QueryPlan Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a valid, scope-bound ontology `QueryPlan` directly through its canonical tool arguments and stop the tool loop, rather than asking the model to re-plan the same semantic request.

**Architecture:** `resolveAiAnalyticsContext()` returns its validated `semanticPlan` alongside the existing analysis-plan audit record. The LangGraph runtime validates plan schema, execution fingerprint, actor scope hash, nonempty R0 steps, and selected toolset membership. If all checks pass, it converts each step to a standard tool call and executes the existing tool executor in dependency order. Invalid, unavailable, or legacy plans retain the current model-planning fallback; this slice intentionally does not remove tools or deprecate intents.

**Tech Stack:** Node.js ESM, LangGraph, Ajv-validated QueryPlan, Vitest.

---

## Task 1: Define Direct-Execution Contracts

**Files:**

- Modify: `src/test/server/aiAnalyticsContext.test.ts`
- Modify: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

- [x] **Step 1: Require `semanticPlan` in governed analytics context**

```ts
expect(resolved.semanticPlan).toMatchObject({
  status: "valid",
  actorScopeHash: "scope-a",
  steps: [expect.objectContaining({ toolName: "query_semantic_metrics", canonicalArgs: expect.any(Object) })],
});
```

- [x] **Step 2: Add a failing runtime direct-execution test**

```ts
const result = await runtime.invoke({ body: { useAnalyticsContext: true, actor, messages } });

expect(requestToolCompletion).not.toHaveBeenCalled();
expect(executeToolCall).toHaveBeenCalledWith(expect.objectContaining({
  function: { name: "query_semantic_metrics", arguments: JSON.stringify(semanticPlan.steps[0].canonicalArgs) },
}), expect.objectContaining({ actor }));
expect(result.mainAgentToolContext?.stoppedReason).toBe("deterministic_plan_complete");
```

The fixture must include a schema-valid plan with a matching `executionFingerprint`, matching actor `scopeHash`, and a tool permitted by the routed intent.

- [x] **Step 3: Add an invalid-plan fallback assertion**

```ts
expect(requestToolCompletion).toHaveBeenCalledTimes(1);
```

Use an invalid fingerprint or mismatched scope plan, and verify the legacy bounded model planning path remains available rather than executing unvalidated canonical arguments.

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
npm test -- --run src/test/server/aiAnalyticsContext.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts
```

Expected: analytics context lacks `semanticPlan`; runtime calls `requestToolCompletion` even for valid canonical steps.

## Task 2: Return and Validate the Canonical Plan

**Files:**

- Modify: `server/aiAnalyticsContext.mjs`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Test: `src/test/server/aiAnalyticsContext.test.ts`
- Test: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

- [x] **Step 1: Return `semanticPlan` from governed context resolution**

```js
return {
  queryText,
  contextText,
  skipDefectContext: Boolean(detectedMetric),
  shadowObservation,
  analysisPlan,
  semanticPlan,
};
```

The existing `analysisPlan` audit projection remains unchanged.

- [x] **Step 2: Add a strict executable-plan resolver in the runtime**

```js
const plan = validatePlan(candidate);
if (plan.status !== "valid" || plan.actorScopeHash !== actorScope.scopeHash) return null;
if (plan.executionFingerprint !== fingerprintQueryPlanSteps(plan.steps)) return null;
if (!plan.steps.length || !plan.steps.every((step) => selectedToolset.toolNames.includes(step.toolName))) return null;
return plan;
```

Do not accept a malformed plan, scope mismatch, altered canonical step, or tool outside the selected intent.

- [x] **Step 3: Convert validated steps into standard tool calls**

```js
const toolCalls = plan.steps.map((step) => ({
  id: `${plan.planId}:${step.stepId}`,
  type: "function",
  function: { name: step.toolName, arguments: JSON.stringify(step.canonicalArgs) },
}));
```

Preserve existing tool policy, event, evidence, and executor logic by passing these calls through `executeMainAgentPlannedToolCall()`.

- [x] **Step 4: Stop after a deterministic plan completes**

```js
if (!stoppedReason && state.toolExecutionMode === "deterministic") {
  stoppedReason = "deterministic_plan_complete";
}
```

This prevents graph routing from returning to `plan_tool_calls` and issuing a second model completion.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run:

```powershell
npm test -- --run src/test/server/aiAnalyticsContext.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts
```

Expected: valid plans bypass model tool planning; invalid plans retain fallback model planning; existing runtime audit tests remain green.

## Task 3: Verify the Direct Execution Slice

**Files:**

- Test: `src/test/server/aiAnalyticsContext.test.ts`
- Test: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`
- Test: `src/test/server/ontology/queryPlanner.test.ts`
- Test: `src/test/server/semanticAnalysisClosure.e2e.test.ts`

- [x] **Step 1: Run deterministic planning and semantic closure regressions**

Run:

```powershell
npm test -- --run src/test/server/aiAnalyticsContext.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts src/test/server/ontology/queryPlanner.test.ts src/test/server/semanticAnalysisClosure.e2e.test.ts
```

Expected: deterministic plans execute only through canonical steps, fallback remains bounded, and aggregate-to-records closure stays green.

- [x] **Step 2: Run lint, syntax, and diff checks**

Run:

```powershell
npm run lint -- --quiet
node --check server/aiAnalyticsContext.mjs
node --check server/agentRuntime/langGraphChatRuntime.mjs
git diff --check
```

Expected: no lint or syntax errors and no unplanned files.

### Scope Boundaries

- Do not remove legacy tools or change intent profiles in this slice.
- Do not let a model override, append, or rewrite canonical step arguments once a valid plan is selected.
- Do not execute plans with unresolved ambiguities, scope mismatch, invalid fingerprints, or unsupported selected tools.
- Do not add a second planner, supervisor, or online multi-agent layer.
