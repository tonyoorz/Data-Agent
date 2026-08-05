# Data-Agent Production Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Implementation status (2026-08-05):** P0 and P1 are implemented and verified in the isolated worktree `.worktrees/feature-2026-08-04-agent-production-upgrade-p0-auth`. The changes remain uncommitted and unmerged. P2 and P3 have not started.

**Goal:** Evolve the existing governed Data-Agent into a multi-user, measurable, recoverable production service without replacing its semantic kernel or adding unconstrained SQL/code execution.

**Architecture:** Retain the current single LangGraph tool loop, compiled ontology, semantic query API, evidence contract, and file-backed audit store. First establish one authenticated, server-owned actor contract across every agent tool and backend query. Then add executable rule/recovery gates, evaluation scorecards, and an operator view. Only after those controls are proven should the system add durable jobs, human-approved actions, declarative visualization previews, or specialist subgraphs.

**Tech Stack:** Node.js ESM, Vitest, Python 3.11, FastAPI, SQLite, LangGraph, existing compiled ontology and React dashboard.

---

## Evidence-Based Baseline

The comparison diagram is directionally right, but the current branch is ahead of several cells shown there:

| Capability | Current state | Evidence | Upgrade decision |
| --- | --- | --- | --- |
| Semantic layer and schema linking | Strong | Compiled ontology, semantic candidate catalog, resolver, query plan, analysis plan, and semantic API | Extend; do not replace with a generic text-to-SQL prompt. |
| Relationship traversal | Partial | Governed relationship paths and traceability queries exist | Add execution-level lineage/provenance views after access control is unified. |
| Business rules | Partial | Rules compile and produce planner warnings | Add typed `deny`, `require`, and `derive` runtime effects. |
| Query correction | Partial | Empty-result diagnosis, value grounding, allowlisted fallback, and model transport retry exist | Build typed query recovery; do not introduce arbitrary SQL self-repair. |
| Tool orchestration | Strong for one bounded agent | LangGraph state machine, compact toolsets, tool allowlists, evidence gate | Keep one orchestrator until its policy and evaluation scorecards are stable. |
| Per-user RLS | Partial | Semantic API validates scope and redacts fields, but `/api/ai/chat` installs one configured internal actor and legacy tools do not carry actor scope | First production priority. |
| Evaluation | Partial | Routing, semantic golden, answer-citation, and runtime tests execute in Vitest | Add execution, policy, answer-quality, recovery, and trend scorecards. |
| Observability | Partial | JSONL run events, tool audits, thread checkpoints, and request metrics exist | Add structured aggregate metrics, operator query/replay view, and redaction retention policy. |
| Sandbox and async workflow | Absent for the agent | Analysis plans are declarative; tool execution is synchronous | Add only after access and evaluation gates pass. |

### Benchmark Inputs

The roadmap borrows specific production lessons rather than copying platforms wholesale. GitHub metadata was checked on 2026-08-04:

- [Dify](https://github.com/langgenius/dify) (~151k stars): visual workflows, RAG, model management, logs, and annotations.
- [n8n](https://github.com/n8n-io/n8n) (~199k stars): reliable visual workflow execution and broad integrations.
- [LangGraph](https://github.com/langchain-ai/langgraph) (~38.8k stars): stateful, resilient agent orchestration.
- [OpenHands](https://github.com/OpenHands/OpenHands) (~83k stars): controlled agent execution as a separate concern.
- [DB-GPT](https://github.com/eosphoros-ai/DB-GPT) (~19.6k stars): data-agent product surface.
- [OpenMetadata](https://github.com/open-metadata/OpenMetadata) (~14.6k stars): metadata, business semantics, lineage, and governance.

## Sequencing Decisions

1. Do not add a free-form multi-agent system before a single agent has measurable correctness, authorization, recovery, and traceability.
2. Do not add arbitrary SQL or Python execution to imitate academic SQL agents. The existing semantic frame and allowlisted fallback are safer foundations for query recovery.
3. Do not expose GraphQL only for feature parity. The existing REST semantic API is sufficient until a real external consumer requires a graph contract.
4. Do not enable write actions until each action has an approval record, an idempotency key, an immutable audit event, and a compensating/manual recovery path.
5. Treat the current internal actor as a deployment bootstrap mode, not as per-user authorization.

## Phase P0: Trust, Scope, and Measurement

**Target:** 2-3 sprints. This phase is the prerequisite for any new action, agent role, or sandbox capability.

### Task 1: Replace the fixed internal principal with an authenticated actor resolver

**Files:**

- Create: `server/agentAuth.mjs`
- Modify: `server/index.mjs`
- Modify: `server/internalActorScope.mjs`
- Modify: `package.json`
- Create: `src/test/server/agentAuth.test.ts`
- Modify: `src/test/server/internalActorScope.test.ts`

- [ ] **Step 1: Write failing actor-resolution tests**

```ts
it("rejects a browser request without a verified identity outside internal mode", async () => {
  await expect(resolveRequestActor({ headers: {} }, { authMode: "oidc" }))
    .rejects.toThrow("AUTHENTICATED_ACTOR_REQUIRED");
});

it("maps verified claims to a server-owned scope instead of accepting browser scope fields", async () => {
  const actor = await resolveRequestActor(
    { headers: { authorization: "Bearer signed-token" } },
    { authMode: "oidc", verifyToken: async () => ({ sub: "alice", groups: ["DTSV"] }) },
  );
  expect(actor).toMatchObject({ actorId: "alice", scopes: { teamIds: ["DTSV"] } });
});
```

- [ ] **Step 2: Run the new tests to prove the missing boundary**

Run:

```powershell
& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/agentAuth.test.ts src/test/server/internalActorScope.test.ts
```

Expected: FAIL because `resolveRequestActor` does not exist and the chat handler always chooses the internal actor.

- [ ] **Step 3: Implement two explicit authentication modes**

Add `resolveRequestActor(request, options)` with these fixed modes:

```js
if (options.authMode === "internal") return resolveInternalActorScope(options.env);
if (options.authMode !== "oidc") throw new Error("AGENT_AUTH_MODE_INVALID");
const claims = await options.verifyToken(extractBearerToken(request.headers));
return scopePolicy.actorFromClaims(claims);
```

Use `jose` for JWKS-backed OIDC verification. Map user/group claims to object, row, and sensitive-field permissions only through a server-side policy map. Keep `VIZION_AGENT_AUTH_MODE=internal` as an explicit local-development mode; production must use `oidc` and fail closed when identity cannot be verified.

- [ ] **Step 4: Route the resolved actor through the LangGraph request**

Replace `withInternalActorScope(rawBody, process.env)` in `handleAiChatRequest` with a resolved, server-owned actor. Preserve `withInternalActorScope` only for trusted CLI jobs and tests.

- [ ] **Step 5: Verify focused behavior**

Run:

```powershell
& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/agentAuth.test.ts src/test/server/internalActorScope.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts
```

Expected: PASS; caller-supplied scope cannot widen authority, and an authenticated user reaches the runtime with a server-derived actor.

### Task 2: Carry one signed actor capability through every agent data path

**Files:**

- Create: `server/agentActorCapability.mjs`
- Create: `backend/analytics/agent_actor_capability.py`
- Modify: `server/mainAgentTools.mjs`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Modify: `backend/analytics/api.py`
- Create: `src/test/server/agentActorCapability.test.ts`
- Create: `backend/tests/test_agent_actor_capability.py`

- [ ] **Step 1: Write failing cross-service capability tests**

```ts
const capability = createActorCapability({ actor, secret: "test-secret", now: fixedNow });
expect(verifyActorCapability(capability, { secret: "test-secret", now: fixedNow })).toMatchObject({
  actorId: "alice",
  scopeHash: "scope-a",
});
expect(() => verifyActorCapability(`${capability}x`, { secret: "test-secret", now: fixedNow }))
  .toThrow("ACTOR_CAPABILITY_SIGNATURE_INVALID");
```

```python
def test_agent_route_rejects_missing_or_expired_actor_capability(client):
    assert client.post("/api/agent/analytics/defects/aggregate", json={}).status_code == 401
```

- [ ] **Step 2: Add an HMAC-SHA256 capability with short expiry**

The Node service signs only `actorId`, normalized scopes, `scopeHash`, `issuedAt`, `expiresAt`, and a nonce using `VIZION_AGENT_ACTOR_CAPABILITY_SECRET`. The FastAPI verifier accepts only this server-to-server header and rejects missing, altered, or expired capabilities. Do not send the signing secret or raw scope policy to the browser.

- [ ] **Step 3: Add agent-only scope-aware endpoints**

Introduce `/api/agent/analytics/...` counterparts for every data-returning tool used by `executeMainAgentToolCall`: aggregate, records, fallback, filter-value search, coverage, Full Picture, traceability, and semantic endpoints. Each endpoint derives mandatory filters and sensitive-field policy from the verified actor capability before executing the existing model function.

- [ ] **Step 4: Update every tool adapter to use the agent-only endpoint**

Add one helper in `server/mainAgentTools.mjs` that attaches the capability to every fetch. A tool must not choose its endpoint or bypass the helper based on model-generated arguments.

- [ ] **Step 5: Verify all agent query families use the same scope**

Run:

```powershell
& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/mainAgentTools.test.ts src/test/server/agentActorCapability.test.ts
& 'C:\Users\q446328\Desktop\vizion-lab\.venv\Scripts\python.exe' -m pytest backend/tests/test_agent_actor_capability.py backend/tests/test_semantic_query_api.py -q
```

Expected: PASS; an aggregate, fallback, record drilldown, and semantic query all reject an invalid capability and apply the same authorized scope.

### Task 3: Define typed query recovery rather than SQL self-repair

**Files:**

- Create: `server/mainAgentToolRecovery.mjs`
- Modify: `server/mainAgentToolPlanning.mjs`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Modify: `server/mainAgentTools.mjs`
- Create: `src/test/server/mainAgentToolRecovery.test.ts`
- Modify: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

- [ ] **Step 1: Write recovery classification tests**

```ts
expect(classifyToolFailure({ statusCode: 429, toolName: "query_semantic_metrics" })).toEqual({
  action: "retry",
  maxAttempts: 2,
  retryable: true,
});
expect(classifyToolFailure({ code: "SEMANTIC_SCOPE_FILTER_DENIED", toolName: "query_semantic_metrics" }))
  .toEqual({ action: "deny", retryable: false });
expect(classifyToolFailure({ code: "EMPTY_RESULT", toolName: "query_analytics" }))
  .toEqual({ action: "diagnose", retryable: false });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/mainAgentToolRecovery.test.ts
```

Expected: FAIL because error handling is currently dispersed across tool adapters and the model transport client.

- [ ] **Step 3: Implement a bounded recovery matrix**

Use a single immutable policy:

| Failure class | Agent behavior |
| --- | --- |
| `429`, `408`, transient network, `5xx` read failure | Retry once with jitter while remaining inside the tool and turn budget. |
| Empty result | Run the existing structured diagnosis once, then retry only with a deterministic corrected query or ask a clarification. |
| Schema/value mismatch | Search governed field/value catalogs, then issue one revised structured request. |
| Policy, scope, sensitivity, or action denial | Never retry or fall back; surface a safe denial. |
| Any future write action | Never automatically retry without an idempotency key and approval state. |

No branch may generate or execute raw SQL. Persist the original query fingerprint, recovery decision, and retry outcome in the tool audit.

- [ ] **Step 4: Verify recovery and non-escalation**

Run:

```powershell
& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/mainAgentToolRecovery.test.ts src/test/server/mainAgentToolLoop.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts
```

Expected: PASS; retryable reads recover within budget, and denied operations never gain a fallback path.

### Task 4: Turn current goldens into an execution and policy scorecard

**Files:**

- Create: `evals/main-agent/target/execution-golden.jsonl`
- Create: `evals/main-agent/target/policy-golden.jsonl`
- Create: `src/test/server/mainAgentExecutionGolden.test.ts`
- Create: `src/test/server/mainAgentPolicyGolden.test.ts`
- Modify: `src/test/server/mainAgentGolden.test.ts`
- Modify: `src/test/server/ontology/semanticGolden.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add failing execution golden cases**

Each execution case must define a stable fake response and expected observable behavior:

```json
{"caseId":"empty-result-alias-recovery","query":"Size Li 2026 提了多少 ticket","actor":"dtsv-reader","fakeResponses":[{"tool":"query_analytics","rows":[]},{"tool":"diagnose_analytics_empty","causeCode":"FILTER_VALUE_ALIAS","retryQuery":{"filters":{"detected_by":["Li Size"]}}},{"tool":"query_analytics","count":12}],"expected":{"toolSequence":["query_analytics","diagnose_analytics_empty","query_analytics"],"evidenceStatus":"pass"}}
```

- [ ] **Step 2: Add policy golden cases**

Cover at least these non-negotiable denials: altered capability, cross-team filter widening, restricted field without policy, stale `analysisRef`, model-requested tool outside the selected toolset, and action without approval.

- [ ] **Step 3: Implement the deterministic runners**

The runners must use injected fake `analyticsFetch`, `requestToolCompletion`, and clock values. They must assert tool sequence, endpoint, actor scope hash, policy decision, evidence status, final citation validation, and no raw SQL/code field in any request.

- [ ] **Step 4: Add a focused CI command**

Add `npm run test:agent-evals` that runs routing, semantic, execution, policy, answer-citation, and recovery suites without requiring live services.

- [ ] **Step 5: Verify scorecard execution**

Run:

```powershell
& 'C:\nvm4w\nodejs\npm.cmd' run test:agent-evals
```

Expected: PASS with case counts and failures named by `caseId`.

### Task 5: Make audit data operable and privacy-safe

**Files:**

- Create: `server/agentRuntime/runSummary.mjs`
- Modify: `server/agentRuntime/runtimeAuditStore.mjs`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Modify: `server/index.mjs`
- Create: `src/components/dashboard/pages/AgentOperations.tsx`
- Modify: `src/pages/Index.tsx`
- Create: `src/test/server/agentRuntime/runSummary.test.ts`
- Create: `src/test/agent-operations/AgentOperations.test.tsx`

- [ ] **Step 1: Write failing aggregation and redaction tests**

```ts
expect(summarizeRuns(events)).toMatchObject({
  totalRuns: 3,
  byOutcome: { completed: 2, denied: 1 },
  byEvidenceStatus: { pass: 2, blocked: 1 },
});
expect(redactAuditPayload({ detected_by: "Alice", ticket_title: "Sensitive" })).not.toContain("Alice");
```

- [ ] **Step 2: Record one normalized run summary**

Store only `runId`, `threadId`, actor scope hash, selected intent, tool names/outcomes, latency, retry/recovery decision, source revision, evidence state, citation validation, and sanitized error code. Never store raw model prompts, access tokens, or sensitive row values in the operational index.

- [ ] **Step 3: Expose a restricted operations endpoint and page**

Add `/api/agent-operations/summary` and `/api/agent-operations/runs/:runId` behind an operator permission. The page shows success/error/denial rates, P50/P95 latency, top failure codes, recovery outcomes, and a sanitized per-run timeline linked by `runId`.

- [ ] **Step 4: Verify the operator slice**

Run:

```powershell
& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/agentRuntime/runSummary.test.ts src/test/agent-operations/AgentOperations.test.tsx
& 'C:\nvm4w\nodejs\npm.cmd' run build
```

Expected: PASS; unauthorized callers cannot read run detail and raw sensitive values never appear in aggregate or timeline output.

### Task 6: P0 release gate

**Files:**

- Modify: `README.md`
- Modify: `docs/ONBOARDING.md`
- Modify: `docs/duplicate-search-feedback-collection-design.md`

- [ ] **Step 1: Document deployment modes and key rotation**

Document `internal` versus `oidc` mode, JWKS configuration, actor-capability secret rotation, backend network binding, retention, and the emergency rollback that disables agent endpoints while preserving dashboard read-only access.

- [ ] **Step 2: Capture the scorecard baseline**

Run `npm run test:agent-evals`, the focused Python scope suite, and the operations summary against a non-production snapshot. Record case count, pass rate, p50/p95 latency, tool failure rate, denial rate, and citation-validity rate.

- [ ] **Step 3: Require two consecutive clean qualification runs**

Proceed to P1 only when both qualification runs satisfy all of the following:

| Gate | Threshold |
| --- | --- |
| Routing, semantic, execution, and policy golden cases | 100% pass |
| Scope widening, invalid capability, and restricted-field cases | 100% denied |
| Valid evidence-backed answers | 100% citation-valid |
| Automatic recovery behavior | 100% stays within retry/tool budget |
| Operator audit record | Present for 100% of agent runs |

## Phase P1: Make Ontology Governance Execute at Runtime

**Target:** 2 sprints after P0 gates pass.

### P1 Deliverables

1. Extend the compiled business-rule contract with three typed effects: `deny`, `require`, and `derive`. Execute the rule evaluator before a semantic plan is sent to any backend endpoint; retain `plan_warning` only for informational rules.
2. Turn the existing relationship path registry into a read-only lineage response that emits the approved path, join/cardinality policy, source revision, and row-level evidence. Render it as a traceability view rather than an opaque model paragraph.
3. Expand the semantic query compiler's structured recovery only for catalog-backed field/value substitutions and approved metric alternatives. Persist the failed plan, revised plan, reason, and outcome as linked audit events.
4. Add semantic quality checks for ambiguous terms, unsupported joins, unbounded cardinality, stale snapshot, and false causal claims. Each check must have a deterministic golden case.
5. Keep REST as the semantic contract. Add GraphQL only after an external consumer has a written query pattern that REST cannot express.

### P1 Exit Criteria

- Every enforced business rule appears in the plan, backend response, final answer context, and audit run.
- Every lineage answer carries an approved relationship path and source revision.
- The recovery scorecard reports no raw SQL/code generation and no policy-bypass fallback.
- P0 tests remain green with no reduced authorization coverage.

## Phase P2: Durable Workflows, Human Approval, and Safe Visualization

**Target:** 2-3 sprints after P1 gates pass.

### P2 Deliverables

1. Replace in-memory-only long-running work with a durable `agent_jobs` store and worker lease protocol. A job records actor scope hash, request fingerprint, state, retry budget, idempotency key, source revision, and terminal result reference. Users can poll, cancel, and resume only jobs in their own scope.
2. Implement action ontology execution as a state machine: `draft -> requested -> approved -> executing -> succeeded|failed|expired`. Approval must bind the actor, exact action payload hash, expiry, and idempotency key. Initial actions remain dry-run until operators approve a concrete action family.
3. Render the existing declarative analysis plan as a React preview using only `kpi`, `line`, `bar`, `grouped_bar`, and `table` profiles. The preview receives validated data and a row budget; it does not run browser Python, generated JavaScript, or model-supplied SQL.
4. Add an operator-owned feedback loop that associates a run with `correct`, `incorrect`, `insufficient-data`, or `access-denied` and feeds sampled failures into new golden cases.

### P2 Exit Criteria

- A long job survives a Node process restart and preserves scope, cancellation, and audit history.
- Every approved write has one immutable approval record and exactly one idempotent terminal execution record.
- Preview output cannot exceed the governed row budget or execute arbitrary code.
- Feedback samples can be traced to a sanitized run ID and an evaluation case.

## Phase P3: Specialist Subgraphs and Federated Context

**Target:** Only after P2 has operating data that identifies a repeatable bottleneck.

1. Add typed specialist nodes inside the existing LangGraph graph, not a free-form agent swarm: `semantic_resolver`, `query_recovery`, `evidence_verifier`, and optional `action_reviewer`. Every handoff uses a JSON schema, actor scope hash, plan fingerprint, and bounded retry budget.
2. Introduce federated source adapters behind the same capability and evidence contracts. A source must declare schema, lineage, availability, row policy mapping, and freshness before it becomes tool-visible.
3. Add data-quality and lineage checks inspired by metadata platforms only for sources that the Data-Agent can query. Do not deploy a separate catalog platform unless organizational ownership and synchronization needs justify it.

## Explicitly Deferred Work

- General Python notebook execution, shell execution, and arbitrary SQL execution.
- Autonomous write/update/delete actions.
- A second agent framework or supervisor layer.
- GraphQL for its own sake.
- A full replacement of the current ontology, semantic API, or LangGraph runtime.

## Success Definition

The upgraded Data-Agent is successful when a user can ask a governed business question and the system can prove: who was authorized, which semantic interpretation and source revision were used, what query/recovery steps occurred, which evidence supports the answer, whether the answer passed citation validation, and how an operator can replay the sanitized run. New autonomy is added only after those facts remain true under error, denial, and restart scenarios.