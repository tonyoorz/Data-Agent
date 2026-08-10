# Governed Agent Execution Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a validated semantic metric plan deterministically and recover a final answer that omits an otherwise required evidence citation.

**Architecture:** The LangGraph runtime will turn one validated, scope-bound semantic metric plan step into the existing typed `query_semantic_metrics` tool call before asking the model to plan tools. The streaming response layer will append one deterministic citation footer only when validation fails solely because a tool-backed answer omitted every citation.

**Tech Stack:** Node.js, LangGraph, Vitest, server-sent events.

---

## Task 1: Execute A Ready Semantic Metric Plan

**Files:**

- Modify: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`

- [x] **Step 1: Write the failing test**

Add a runtime test with a `ready` analysis plan and one `valid` scope-bound query-plan step. Assert that the runtime invokes `query_semantic_metrics` using the step's exact `canonicalArgs`, does not call the model tool planner, and finalizes after that tool result.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

Expected: the new test fails because the current runtime calls `requestToolCompletion` instead of executing the validated plan step.

- [x] **Step 3: Write the minimal implementation**

Add a small runtime helper that accepts only one valid, actor-scope-bound `semantic_metric_query` step whose tool is allowed by the selected toolset. Use the step's unmodified `canonicalArgs` to construct `query_semantic_metrics`, execute it through the existing policy gate, and finalize rather than returning to free-form tool planning.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

Expected: all runtime tests pass.

## Task 2: Recover Missing Citation Footers

**Files:**

- Modify: `src/test/server/companyChat.test.ts`
- Modify: `server/companyChat.mjs`

- [x] **Step 1: Write the failing test**

Add a streamed-answer test where a factual tool-backed answer has no `<cite>` markup. Assert that the response appends a citation footer using the real tool-call ID, emits a valid `answer-validation` event, and sends it before `[DONE]`.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- src/test/server/companyChat.test.ts`

Expected: the new test fails because the current stream emits `ANSWER_CITATION_REQUIRED` without recovery.

- [x] **Step 3: Write the minimal implementation**

When validation fails only with `ANSWER_CITATION_REQUIRED`, append a static citation footer for the first valid evidence item, revalidate the accumulated visible content, and then emit the result. Do not recover unknown citations or causal-claim violations.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- src/test/server/companyChat.test.ts`

Expected: all company-chat tests pass.

## Task 3: Verify The Closed Loop

**Files:**

- Verify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Verify: `server/companyChat.mjs`

- [x] **Step 1: Run the focused regression suite**

Run: `npm test -- src/test/server/agentRuntime/langGraphChatRuntime.test.ts src/test/server/companyChat.test.ts src/test/server/answerValidator.test.ts`

Expected: all selected tests pass.

- [x] **Step 2: Run static and diff checks**

Run: `node --check server/agentRuntime/langGraphChatRuntime.mjs; node --check server/companyChat.mjs; npm run ontology:check; git diff --check`

Expected: each command exits with code `0`.

- [x] **Step 3: Run a local AI Chat metric request**

Send a read-only metric query to `/api/ai/chat` and verify an HTTP `200`, a `query_semantic_metrics` tool event, a valid `answer-validation` SSE event, and `[DONE]`.

## Task 4: Resolve Explicit Project And Status Semantics

**Files:**

- Modify: `ontology/v1/vocab.zh-CN.json`
- Modify: `server/ontology/resolver.mjs`
- Modify: `src/test/server/ontology/semanticResolver.test.ts`

- [x] **Step 1: Write the failing semantic-frame test**

Add a query for `IDCEVO` defect count grouped by status. Require `product.project = IDCEVO` as a user filter and `quality.status` as the only grouping dimension.

- [x] **Step 2: Verify the expected failure**

Run: `npm test -- src/test/server/ontology/semanticResolver.test.ts`

Expected: the pre-change resolver groups by project and omits the IDCEVO filter and defect-status dimension.

- [x] **Step 3: Add governed vocabulary and grouping precedence**

Add approved `IDCEVO` project and defect-status terms. When an analytics question names an explicit grouping, prefer that matched dimension over incidental dimension mentions in the same query.

- [x] **Step 4: Compile and verify the end-to-end result**

Run: `npm run ontology:compile`, the focused ontology tests, and a local `/api/ai/chat` query. Verify the tool audit includes `product.project = IDCEVO`, `quality.status`, a semantic metric result, and passing citation validation.
