# Ontology PI Coding Agent Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Vizion Lab so the PI coding agent can use the Data-Agent ontology as a governed business/engineering contract without breaking the existing testcase-context workflow.

**Architecture:** Import the Data-Agent ontology semantic kernel in layers: first the versioned ontology bundle and validators, then the Python semantic query data plane, then Node agent tool integration, and only after that the optional PI/graph runtime. The existing `/api/ontology/context` and `get_test_case_context` path remains the testcase-authoring fact tool; the new ontology layer governs analytics semantics, metric definitions, scope, evidence, and coding-agent workflows.

**Tech Stack:** Node 24.x, Vitest, AJV 2020 JSON Schema validation, FastAPI, pytest, SQLite-backed Vizion analytics read models, existing Node main agent tool loop, optional LangGraph runtime after kernel stabilization.

---

## Non-Goals For First Cut

- Do not replace `backend/analytics/ontology_context.py` or `get_test_case_context`.
- Do not import the admin UI in the first kernel migration.
- Do not make the PI/LangGraph runtime default until semantic API and main-agent tools pass focused tests.
- Do not introduce Neo4j/RDF or a separate graph database.

## File Map

**Create from Data-Agent latest branch:**
- `ontology/schema/*.json`: JSON schemas for entities, dimensions, metrics, policies, constraints, sources, relationships, vocabulary.
- `ontology/v1/*.json`: governed ontology source documents.
- `ontology/generated/ontology.compiled.json`: deterministic compiled bundle.
- `ontology/generated/fingerprint.txt`: SHA-256 fingerprint for fail-closed loading.
- `scripts/compileOntology.mjs`: compiler/check command for ontology sources.
- `server/ontology/*.mjs`: Node registry, validator, resolver, query compiler, planner, scope policy, time resolver.
- `backend/analytics/ontology.py`: Python compiled-bundle loader and fingerprint verifier.
- `backend/analytics/semantic_query.py`: Python data-plane executor for governed semantic queries.
- `backend/tests/test_ontology_contract.py`: Python ontology loader contract tests.
- `backend/tests/test_semantic_query_api.py`: Python semantic query contract tests.
- `src/test/server/ontology/*.ts`: Node ontology compiler/resolver/planner tests.

**Modify existing local files:**
- `package.json`: add ontology scripts and Node dependencies.
- `backend/analytics/api.py`: load ontology during lifespan, expose health fingerprint, add `POST /api/semantic/query`.
- `server/mainAgentTools.mjs`: add semantic tool schemas and executor for `/api/semantic/query`.
- `server/mainAgentToolLoop.mjs`: teach planning guidance to prefer governed semantic tools for analytics.
- `server/aiAnalyticsContext.mjs`: optionally add governed context in shadow mode.
- `src/test/server/mainAgentTools.test.ts`: add semantic tool execution tests.
- `src/test/server/mainAgentToolLoop.test.ts`: add planner-trigger tests.
- `backend/tests/test_analytics_ontology_context.py`: protect existing testcase-context behavior.

**Defer until second cut:**
- `server/agentRuntime/*`: PI/LangGraph runtime, step journal, tool registry, evidence/claims.
- `server/companyChat.mjs` and `server/index.mjs`: runtime switching and SSE event changes.
- `src/components/admin/*`, `src/pages/admin/*`: admin management UI.

---

## Task 1: Baseline And Branch Safety

**Files:**
- Read only: `package.json`, `backend/analytics/api.py`, `server/mainAgentTools.mjs`, `server/mainAgentToolLoop.mjs`
- No code changes.

- [x] **Step 1: Record current branch and dirty state**

Run:

```powershell
git branch --show-current; git status --short
```

Expected: current branch is visible; unrelated user changes are identified and left untouched.

- [x] **Step 2: Run current ontology/testcase baseline**

Run:

```powershell
python -m pytest backend/tests/test_analytics_ontology_context.py backend/tests/test_analytics_api_import.py backend/tests/test_traceability_analysis.py -q
```

Expected: existing testcase-context and traceability tests pass before the refactor.

- [x] **Step 3: Run current Node agent baseline**

Run:

```powershell
npm test -- src/test/server/mainAgentTools.test.ts src/test/server/mainAgentToolLoop.test.ts
```

Expected: existing main-agent tool tests pass before adding semantic tools.

---

## Task 2: Import Versioned Ontology Sources And Compiler

**Files:**
- Create: `ontology/schema/common.schema.json`
- Create: `ontology/schema/entities.schema.json`
- Create: `ontology/schema/dimensions.schema.json`
- Create: `ontology/schema/metrics.schema.json`
- Create: `ontology/schema/policies.schema.json`
- Create: `ontology/schema/constraints.schema.json`
- Create: `ontology/schema/relationships.schema.json`
- Create: `ontology/schema/sources.schema.json`
- Create: `ontology/schema/vocabulary.schema.json`
- Create: `ontology/v1/entities.json`
- Create: `ontology/v1/dimensions.json`
- Create: `ontology/v1/metrics.json`
- Create: `ontology/v1/policies.json`
- Create: `ontology/v1/constraints.json`
- Create: `ontology/v1/relationships.json`
- Create: `ontology/v1/sources.json`
- Create: `ontology/v1/vocab.zh-CN.json`
- Create: `ontology/generated/ontology.compiled.json`
- Create: `ontology/generated/fingerprint.txt`
- Create: `scripts/compileOntology.mjs`
- Modify: `package.json`
- Test: `src/test/server/ontology/compiler.test.ts`

- [x] **Step 1: Copy ontology source and compiler files from Data-Agent branch**

Run from repo root:

```powershell
git checkout data-agent/feature/2026-07-22-agent-ontology-admin-sync -- ontology scripts/compileOntology.mjs src/test/server/ontology/compiler.test.ts
```

Expected: ontology files and compiler test appear as added files in `git status --short`.

- [x] **Step 2: Add package scripts and dependencies**

Patch `package.json` scripts:

```json
"ontology:compile": "node scripts/compileOntology.mjs --emit-graph",
"ontology:graph": "node scripts/compileOntology.mjs --emit-graph",
"ontology:check": "node scripts/compileOntology.mjs --check",
"test:ontology": "vitest run src/test/server/ontology && python -m pytest backend/tests/test_ontology_contract.py -q"
```

Patch `package.json` dependencies:

```json
"ajv": "8.20.0",
"ajv-formats": "3.0.1"
```

Expected: no duplicate script keys; `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` succeeds.

- [x] **Step 3: Install dependencies**

Run:

```powershell
npm install
```

Expected: lockfile updates include `ajv` and `ajv-formats`.

- [x] **Step 4: Validate compiler output is current**

Run:

```powershell
npm run ontology:check
```

Expected: PASS; if stale, run `npm run ontology:compile`, inspect generated diff, then rerun `npm run ontology:check`.

---

## Task 3: Add Node Ontology Kernel

**Files:**
- Create: `server/ontology/fingerprint.mjs`
- Create: `server/ontology/validator.mjs`
- Create: `server/ontology/registry.mjs`
- Create: `server/ontology/semanticFrame.mjs`
- Create: `server/ontology/timeResolver.mjs`
- Create: `server/ontology/scopePolicy.mjs`
- Create: `server/ontology/resolver.mjs`
- Create: `server/ontology/queryCompiler.mjs`
- Create: `server/ontology/queryPlanner.mjs`
- Create: `server/ontology/semanticCandidate.mjs`
- Test: `src/test/server/ontology/registry.test.ts`
- Test: `src/test/server/ontology/semanticResolver.test.ts`
- Test: `src/test/server/ontology/queryPlanner.test.ts`
- Test: `src/test/server/ontology/timeResolver.test.ts`

- [x] **Step 1: Copy Node ontology kernel from Data-Agent branch**

Run:

```powershell
git checkout data-agent/feature/2026-07-22-agent-ontology-admin-sync -- server/ontology src/test/server/ontology
```

Expected: `server/ontology/*.mjs` exists and imports only local Node modules plus `ajv`/`ajv-formats`.

- [x] **Step 2: Run Node ontology tests**

Run:

```powershell
npm test -- src/test/server/ontology
```

Expected: PASS for compiler, registry, resolver, planner, and time resolver tests.

- [x] **Step 3: Check ontology contract behavior manually**

Run:

```powershell
node -e "import('./server/ontology/registry.mjs').then(({createOntologyRegistry})=>{const r=createOntologyRegistry(); console.log(r.version, r.fingerprint.length, r.getMetric('defect.count',{approvedOnly:true}).entityId)})"
```

Expected output contains:

```text
v1 64 quality.defect
```

---

## Task 4: Add Python Ontology Loader And Semantic Query API

**Files:**
- Create: `backend/analytics/ontology.py`
- Create: `backend/analytics/semantic_query.py`
- Modify: `backend/analytics/api.py`
- Test: `backend/tests/test_ontology_contract.py`
- Test: `backend/tests/test_semantic_query_api.py`

- [x] **Step 1: Copy Python ontology modules and tests from Data-Agent branch**

Run:

```powershell
git checkout data-agent/feature/2026-07-22-agent-ontology-admin-sync -- backend/analytics/ontology.py backend/analytics/semantic_query.py backend/tests/test_ontology_contract.py backend/tests/test_semantic_query_api.py
```

Expected: new Python modules import existing local `read_models` and `traceability_models`.

- [x] **Step 2: Patch FastAPI imports**

Add to `backend/analytics/api.py` imports:

```python
from backend.analytics.ontology import load_ontology
from backend.analytics.semantic_query import SemanticQueryError, execute_semantic_query
```

Expected: existing imports remain intact, including `build_ontology_catalog_payload` and `build_test_case_context_payload`.

- [x] **Step 3: Patch FastAPI lifespan and health**

In `analytics_lifespan`, add:

```python
_app.state.ontology = load_ontology()
```

In `health`, include:

```python
ontology = getattr(request.app.state, "ontology", None) or load_ontology()
"ontologyVersion": ontology.version,
"ontologyFingerprint": ontology.fingerprint,
```

Expected: analytics service fails closed if the compiled ontology is missing or fingerprint-mismatched.

- [x] **Step 4: Add semantic endpoint without removing existing ontology endpoints**

Add below `health` or near existing analytics endpoints:

```python
@app.post("/api/semantic/query")
def semantic_query(request: Request, payload: dict[str, object]) -> JSONResponse:
    try:
        catalog = getattr(request.app.state, "ontology", None) or load_ontology()
        result = execute_semantic_query(payload, catalog=catalog)
    except SemanticQueryError as exc:
        return JSONResponse(status_code=exc.status_code, content={"code": exc.code, "safeMessage": exc.code, "retryable": False})
    return JSONResponse(status_code=200, content=result)
```

Expected: `/api/ontology/context` and `/api/ontology/catalog` remain available.

- [x] **Step 5: Run Python semantic tests**

Run:

```powershell
python -m pytest backend/tests/test_ontology_contract.py backend/tests/test_semantic_query_api.py -q
```

Expected: PASS; failures are contract mismatches and must be fixed before Node agent integration.

---

## Task 5: Preserve Existing Testcase Context Behavior

**Files:**
- Modify only if needed: `backend/analytics/ontology_context.py`
- Modify only if needed: `backend/tests/test_analytics_ontology_context.py`

- [x] **Step 1: Run existing testcase-context tests after semantic API is added**

Run:

```powershell
python -m pytest backend/tests/test_analytics_ontology_context.py backend/tests/test_analytics_api_import.py backend/tests/test_traceability_analysis.py -q
```

Expected: PASS. If this fails, restore the existing `/api/ontology/context` behavior before continuing.

- [x] **Step 2: Smoke test defect 2774806 context**

Run while analytics API is running:

```powershell
$body = @{ anchor = @{ type = 'defect_id'; value = '2774806' }; purpose = 'create_test_case' } | ConvertTo-Json -Depth 5
$payload = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3003/api/ontology/context' -ContentType 'application/json' -Body $body
$payload | Select-Object anchor,business_scope,defect_context,gaps | ConvertTo-Json -Depth 8
```

Expected: response still includes `defect_context` fallback for defects without manual runs.

---

## Task 6: Add Governed Semantic Tools To Current Main Agent

**Files:**
- Modify: `server/mainAgentTools.mjs`
- Modify: `src/test/server/mainAgentTools.test.ts`

- [x] **Step 1: Write failing tests for semantic tool registration and execution**

Add to `src/test/server/mainAgentTools.test.ts`:

```ts
it("registers governed semantic analytics tools", () => {
  const names = MAIN_AGENT_TOOLS.map((tool) => tool.function.name);
  expect(names).toContain("query_semantic_metrics");
  expect(names).toContain("query_semantic_records");
  expect(names).toContain("query_traceability");
});
```

Add an execution test that stubs analytics fetch:

```ts
it("executes query_semantic_metrics through the semantic API", async () => {
  const analyticsFetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      ontologyVersion: "v1",
      schemaFingerprint: "a".repeat(64),
      sourceRevision: { revisionId: "snap-1" },
      data: [],
      summary: { metrics: { "defect.count": 2 }, rowCount: 2 },
      quality: { completeness: "complete" },
    }),
  }));
  const toolCall = {
    id: "semantic-1",
    function: {
      name: "query_semantic_metrics",
      arguments: JSON.stringify({
        query: {
          schemaVersion: "1.0",
          ontologyVersion: "v1",
          schemaFingerprint: "a".repeat(64),
          intent: "aggregate",
          entityIds: ["quality.defect"],
          metricIds: ["defect.count"],
          dimensionIds: [],
          filters: [{ dimensionId: "org.problem_finder_team", operator: "in", values: ["DTSV_China"], source: "policy" }],
          timeScopes: [],
          comparison: null,
          sort: [],
          limit: 20,
        },
      }),
    },
  };
  const result = await executeMainAgentToolCall(toolCall, { analyticsFetch, analyticsApiBase: "http://127.0.0.1:3003", actor: { scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } } });
  expect(analyticsFetch).toHaveBeenCalledWith("http://127.0.0.1:3003/api/semantic/query", expect.objectContaining({ method: "POST" }));
  expect(result.contextText).toContain("Tool: query_semantic_metrics");
  expect(result.contextText).toContain("defect.count: 2");
});
```

Run:

```powershell
npm test -- src/test/server/mainAgentTools.test.ts
```

Expected: FAIL because tools are not registered yet.

- [x] **Step 2: Add semantic tool schemas and executor**

In `server/mainAgentTools.mjs`, import:

```js
import { semanticQuerySchema } from "./ontology/queryCompiler.mjs";
```

Add tool names:

```js
const SEMANTIC_TOOL_NAMES = new Set(["query_semantic_metrics", "query_semantic_records", "query_traceability"]);
```

Add three `MAIN_AGENT_TOOLS` entries using `semanticQuerySchema` for the `query` property.

Add executor shape:

```js
async function executeSemanticQuery(toolCall, { analyticsFetch, analyticsApiBase, actor }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const query = args.query;
  const url = new URL("/api/semantic/query", analyticsApiBase).toString();
  const body = {
    schemaVersion: "1.0",
    queryId: String(toolCall?.id || `semantic-${Date.now()}`),
    ontologyVersion: query?.ontologyVersion,
    schemaFingerprint: query?.schemaFingerprint,
    query,
    actorScope: buildActorScope(actor),
  };
  const response = await analyticsFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response?.ok) {
    let failure = {};
    try { failure = await response.json(); } catch {}
    const code = String(failure?.code || `SEMANTIC_API_HTTP_${response?.status || "UNKNOWN"}`);
    throw Object.assign(new Error(code), { code, status: response?.status === 403 ? "denied" : "failed", retryable: response?.status === 429 || Number(response?.status || 0) >= 500 });
  }
  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: toolCall.function.name, result: payload })),
    contextText: formatSemanticContext(toolCall.function.name, payload),
  };
}
```

Expected: semantic tools call only `/api/semantic/query`; they do not construct SQL.

- [x] **Step 3: Run focused Node tool tests**

Run:

```powershell
npm test -- src/test/server/mainAgentTools.test.ts
```

Expected: PASS.

---

## Task 7: Teach The Current Tool Loop To Prefer Governed Semantics

**Files:**
- Modify: `server/mainAgentToolLoop.mjs`
- Modify: `src/test/server/mainAgentToolLoop.test.ts`

- [x] **Step 1: Add failing planner guidance tests**

Add tests asserting analytics questions trigger semantic tools:

```ts
it("tells the planner to use governed semantic tools for analytics metrics", async () => {
  const prompt = buildMainAgentToolPlanningPrompt([{ role: "user", content: "最近一周 DTSV 新增缺陷按 ECU Top 5" }]);
  expect(prompt).toContain("query_semantic_metrics");
  expect(prompt).toContain("governed Ontology");
});

it("keeps testcase drafting on get_test_case_context", async () => {
  const prompt = buildMainAgentToolPlanningPrompt([{ role: "user", content: "根据 defect 2774806 帮我写测试用例" }]);
  expect(prompt).toContain("get_test_case_context");
});
```

Run:

```powershell
npm test -- src/test/server/mainAgentToolLoop.test.ts
```

Expected: FAIL until planner instructions are updated.

- [x] **Step 2: Update planner text**

Add rules to `server/mainAgentToolLoop.mjs`:

```text
Use query_semantic_metrics for governed aggregate, trend, compare, rank, and count questions when the query can be represented by ontology metrics and dimensions.
Use query_semantic_records for governed list or drilldown requests.
Use query_traceability for requirement, testcase, testrun, and defect lineage questions.
Use get_test_case_context before drafting or extending test cases from a defect_id or test_id anchor.
Never redefine metrics after a semantic tool result; use the returned ontologyVersion, schemaFingerprint, sourceRevision, quality, and metrics as factual evidence.
```

Expected: analytics goes semantic; testcase authoring remains on current context tool.

- [x] **Step 3: Run tool-loop tests**

Run:

```powershell
npm test -- src/test/server/mainAgentToolLoop.test.ts
```

Expected: PASS.

---

## Task 8: Add PI Coding-Agent Ontology Playbook

**Files:**
- Create: `docs/ontology/pi-coding-agent-playbook.md`
- Modify only if the repository already uses it: `.github/copilot-instructions.md`

- [x] **Step 1: Create the playbook**

Create `docs/ontology/pi-coding-agent-playbook.md` with:

```markdown
# PI Coding Agent Ontology Playbook

## Rule

For Vizion Lab analytics, defect, testing, traceability, and testcase-context code changes, the PI coding agent must treat the ontology bundle and semantic query contracts as the source of truth for business concepts.

## Required Checks Before Editing

1. If changing a metric, dimension, entity, policy, source binding, vocabulary, or semantic tool contract, inspect `ontology/v1/*` first.
2. If adding or renaming a business concept, update ontology source JSON before changing resolver or executor code.
3. If changing semantic query behavior, update both Node tests under `src/test/server/ontology` and Python tests under `backend/tests/test_semantic_query_api.py`.
4. If changing testcase drafting behavior, keep `/api/ontology/context` and `get_test_case_context` tests passing.

## Validation Commands

```powershell
npm run ontology:check
npm test -- src/test/server/ontology src/test/server/mainAgentTools.test.ts src/test/server/mainAgentToolLoop.test.ts
python -m pytest backend/tests/test_ontology_contract.py backend/tests/test_semantic_query_api.py backend/tests/test_analytics_ontology_context.py -q
```
```

Expected: playbook clearly separates analytics semantics from testcase-context authoring.

- [x] **Step 2: Wire playbook into coding-agent instructions if present**

If `.github/copilot-instructions.md` exists, add:

```markdown
## Ontology-Grounded Coding

When editing analytics, defect, testing, traceability, or testcase-context code, follow `docs/ontology/pi-coding-agent-playbook.md`. Do not invent metrics, dimensions, filters, source fields, or SQL outside the ontology and semantic query contracts.
```

Expected: coding agents have a stable instruction entrypoint without embedding the whole ontology in prompt text.

---

## Task 9: Optional Shadow Context In AI Analytics Context

**Files:**
- Modify: `server/aiAnalyticsContext.mjs`
- Test: `src/test/server/aiAnalyticsContext.test.ts`

- [x] **Step 1: Add shadow-only ontology interpretation**

Add optional parameters to `resolveAiAnalyticsContext`:

```js
export async function resolveAiAnalyticsContext({ messages, analyticsFetch = globalThis.fetch, now = new Date(), actor, ontologyRegistry }) {
```

When both `actor` and `ontologyRegistry` exist, resolve a semantic frame and plan, then append a governed interpretation block. If resolving fails, append a fail-closed message and do not answer analytics questions without evidence.

Expected: old callers still work because `actor` and `ontologyRegistry` are optional.

- [x] **Step 2: Test backward compatibility and shadow behavior**

Run:

```powershell
npm test -- src/test/server/aiAnalyticsContext.test.ts
```

Expected: existing context behavior passes; new test confirms governed interpretation appears only when registry and actor are provided.

---

## Task 10: Full Focused Validation Gate

**Files:**
- All touched files.

- [x] **Step 1: Run ontology checks**

Run:

```powershell
npm run ontology:check
npm test -- src/test/server/ontology
```

Expected: PASS. Verified 2026-07-23: `npm run ontology:check` reported ontology `v1` fingerprint `777e3a8e9c87045b460d1d052e277b9b97c4eb7057f450aac1aad6b06f6f8fb9`; `npm test -- src/test/server/ontology` passed 6 files / 53 tests.

- [x] **Step 2: Run Python semantic and context checks**

Run:

```powershell
python -m pytest backend/tests/test_ontology_contract.py backend/tests/test_semantic_query_api.py backend/tests/test_analytics_ontology_context.py backend/tests/test_analytics_api_import.py backend/tests/test_traceability_analysis.py -q
```

Expected: PASS. Verified 2026-07-23: 38 passed.

- [x] **Step 3: Run Node main-agent checks**

Run:

```powershell
npm test -- src/test/server/mainAgentTools.test.ts src/test/server/mainAgentToolLoop.test.ts src/test/server/aiAnalyticsContext.test.ts
```

Expected: PASS. Verified 2026-07-23: 3 files / 37 tests passed.

- [x] **Step 4: Smoke test live APIs**

Run dev stack, then:

```powershell
Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3003/health' | ConvertTo-Json -Depth 5
```

Expected: health includes `ontologyVersion: v1` and a 64-character `ontologyFingerprint`.

Run existing context smoke:

```powershell
$body = @{ anchor = @{ type = 'defect_id'; value = '2774806' }; purpose = 'create_test_case' } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3003/api/ontology/context' -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 8
```

Expected: existing testcase context still works. Verified 2026-07-23 against current-code server on port 3013 because port 3003 was occupied by an older analytics process; `/health` returned ontology `v1` and the expected fingerprint, and `/api/ontology/context` still returned defect `2774806` context.

---

## Task 11: Optional LangGraph AI Chat Runtime After Kernel Is Stable

**Files:**
- Create/modify after Tasks 1-10 pass: `server/agentRuntime/*`
- Modify: `server/index.mjs`
- Modify: `package.json`
- Test: `src/test/server/agentRuntime/*`
- Test: `src/test/ai-chat/*`

- [x] **Step 1: Add runtime dependency for opt-in graph shell**

Patch `package.json` dependencies:

```json
"@langchain/langgraph": "^1.4.8"
```

Expected: Node 24.x is used; legacy runtime remains default. Durable checkpoint dependencies are deferred until the production persistence slice.

- [x] **Step 2: Import runtime in disabled mode**

Add feature flag:

```text
VIZION_AGENT_RUNTIME=legacy|langgraph
```

Default remains:

```text
legacy
```

Expected: existing chat behavior is unchanged unless `VIZION_AGENT_RUNTIME=langgraph` is explicitly set.

- [x] **Step 3: Run runtime tests**

Run:

```powershell
npm test -- src/test/server/agentRuntime/langGraphChatRuntime.test.ts src/test/server/agentRuntime/langGraphChatHandler.test.ts src/test/server/companyChat.test.ts src/test/server/mainAgentToolLoop.test.ts
```

Expected: PASS before any default runtime switch. Verified first-cut graph shell: 4 files / 23 tests passed.

- [x] **Step 4: Add durable runtime checkpoint and audit store**

Add file-backed durable runtime store:

```text
server/agentRuntime/runtimeAuditStore.mjs
```

Expected: LangGraph runtime writes thread checkpoints, run events, tool-call audit records, and actor scope under `logs/agent-runtime` by default. Verified with `npm test -- src/test/server/agentRuntime`.

---

## Rollout Decision

After Tasks 1-10 pass, the repository has ontology-grounded coding and analytics semantics. Task 11 adds an opt-in LangGraph AI Chat runtime shell while keeping legacy as the default runtime.

Recommended first production posture:

```text
semantic kernel: enabled
semantic tools: enabled for analytics questions
testcase context: existing path preserved
LangGraph runtime: explicit opt-in only with `VIZION_AGENT_RUNTIME=langgraph`
admin UI: deferred
```

## Self-Review

- Spec coverage: covers ontology import, semantic query data plane, current main-agent tool integration, coding-agent playbook, existing testcase context preservation, optional LangGraph runtime shell.
- Placeholder scan: no task uses TBD/TODO/implement later; deferred areas are explicitly scoped as second-cut work.
- Type consistency: `semanticFrame`, `semanticQuerySchema`, `query_semantic_metrics`, `query_semantic_records`, `query_traceability`, `/api/semantic/query`, and `/api/ontology/context` are used consistently.