# Testing Quality Ontology V2 Semantic Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the V1 aggregate-only semantic path with controlled V2 aggregate, trend, rank, compare, records, traversal, and lookup primitives, then make the Main Agent resolve and execute dependent analyses on one immutable snapshot.

**Architecture:** Put canonical execution in `backend/analytics/semantic`: strict request contracts select approved catalog IDs and canonical read models, a typed formula interpreter evaluates governed metrics, and separate engines handle aggregates, comparisons, records, and traversal. Keep Node as the Agent-facing resolver/planner and HTTP client; it may construct only schema-valid requests and cannot bypass Python scope, field, snapshot, or capability gates.

**Tech Stack:** Python 3 dataclasses and SQLite, FastAPI, Node.js 24.14.0 ESM, Ajv 8.20.0, Vitest, pytest.

---

## Entry conditions and invariants

- The foundation plan is complete and `ontology/generated/v2` passes `npm run ontology:v2:check`.
- V2 is loaded by explicit fingerprint and all queries pin a ready `snapshotRef`.
- No arbitrary SQL, source property, join path, URL, or file path enters a public query.
- `query_semantic_records` returns real entity records, not grouped counts.
- Compare returns current, baseline, delta, growth, and new/gone semantics per group, including groups with zero on either side.
- Generic “模块” produces candidates or the explicit `product.business_module` resolution; it never silently means ECU.
- Duplicate Search internals are untouched; only the existing adapter remains registered.

## File responsibility map

| Path | Responsibility |
|---|---|
| `backend/analytics/semantic/contracts.py` | Strict V2 query, actor scope, cursor, and response contracts |
| `backend/analytics/semantic/metric_ast.py` | Typed formula evaluation over canonical rows |
| `backend/analytics/semantic/aggregate.py` | Aggregate, trend, and rank primitives |
| `backend/analytics/semantic/compare.py` | Zero-safe aligned group comparison |
| `backend/analytics/semantic/records.py` | Allowlisted stable record pagination and drilldown |
| `backend/analytics/semantic/traverse.py` | Governed directed graph traversal |
| `backend/analytics/semantic/evidence.py` | V2 evidence envelope and data-quality distinctions |
| `backend/analytics/semantic/service.py` | Capability, scope, snapshot, and engine orchestration |
| `backend/analytics/api.py` | Thin versioned HTTP routes |
| `server/ontology/semanticFrame.mjs` | Strict V2 resolved intent and ambiguity contract |
| `server/ontology/resolver.mjs` | Bilingual concept, metric, module, coverage, and follow-up resolution |
| `server/ontology/queryCompiler.mjs` | V2 tool-request compiler |
| `server/ontology/queryPlanner.mjs` | Dependency graph and one-snapshot propagation |
| `server/ontology/resultTransforms.mjs` | Typed outputs from one step to the next |
| `server/ontology/contextPacks.mjs` | Bounded context-pack retrieval |
| `server/ontology/ontologyClient.mjs` | V2 health, lookup, query, records, and traversal HTTP client |
| `server/mainAgentTools.mjs` | Public primitive schemas and adapters |
| `server/agentRuntime/toolRegistry.mjs` | Versioned primitive registration and policy metadata |

### Task 1: Define strict V2 query and response contracts

**Files:**
- Create: `backend/analytics/semantic/contracts.py`
- Create: `backend/tests/test_semantic_v2_contracts.py`

- [ ] **Step 1: Write RED contract tests**

Create valid fixtures for four request kinds. The shared envelope is:

```python
{
    "schemaVersion": "2.0",
    "queryId": "query-1",
    "ontologyVersion": "v2",
    "schemaFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "snapshotRef": "snapshot:1111111111111111111111111111111111111111111111111111111111111111",
    "requestKind": "metrics",
    "query": {},
    "actorScope": {
        "actorId": "alice",
        "scopeHash": "scope-a",
        "workspaceIds": ["DTSV"],
        "projectIds": [],
        "releaseIds": [],
        "teamIds": ["DTSV"],
        "allowedEntityIds": ["defect.defect"],
        "allowedFieldIds": [],
        "rowPolicyIds": ["dtsv"],
        "sensitiveFieldPolicyIds": []
    }
}
```

Assert exact-key rejection, fingerprint/snapshot validation, typed filter operators, request-kind-specific fields, maximum limits, and stable response fields:

```text
schemaVersion
queryId
ontologyVersion
schemaFingerprint
snapshotRef
sourceRevisionSet
scope
data
summary
page
quality
drilldownRef
```

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_v2_contracts.py -q
```

Expected: FAIL because `contracts.py` is absent.

- [ ] **Step 3: Implement immutable typed contracts**

Use frozen dataclasses plus parsing functions that reject unknown fields. Filter operators are exactly `eq`, `neq`, `in`, `not_in`, `contains`, `gt`, `gte`, `lt`, `lte`, `is_null`, and `not_null`, constrained further by each catalog dimension. Public requests carry semantic IDs only.

Define quality values:

```text
missingness: zero | missing | unknown | unavailable | not_applicable
completeness: complete | partial | unavailable
redactionStatus: not_required | applied | denied
```

- [ ] **Step 4: Run GREEN and commit**

```bash
python3 -m pytest backend/tests/test_semantic_v2_contracts.py -q
git add backend/analytics/semantic/contracts.py backend/tests/test_semantic_v2_contracts.py
git commit -m "feat(analytics): define semantic v2 contracts"
```

Expected: PASS, then commit succeeds.

### Task 2: Interpret governed metric formulas

**Files:**
- Create: `backend/analytics/semantic/metric_ast.py`
- Create: `backend/tests/test_semantic_metric_ast.py`

- [ ] **Step 1: Write RED tests for every AST node**

Fixtures must exercise all 13 formula node types, nested `metric_ref`, null handling, distinct identity, conditional populations, percentile interpolation, calendar durations, business-hour durations, ratio zero policies, and cycles.

Representative assertions:

```python
assert evaluate_metric("testing.pass_rate", rows, context) == 75.0
assert evaluate_metric("testing.pass_rate", [], context) is None
assert evaluate_metric("defect.long_runner_count", rows, context) == 2
with pytest.raises(MetricEvaluationError, match="FORMULA_SQL_FORBIDDEN"):
    evaluate_formula({"type": "sql", "text": "select 1"}, rows, context)
```

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_metric_ast.py -q
```

Expected: FAIL because the interpreter is absent.

- [ ] **Step 3: Implement the minimal interpreter**

Evaluation accepts only a catalog-validated AST, rows from one compatible canonical model, metric context, and snapshot `asOf`. It returns a typed value plus quality inputs. It never executes strings. Cache `metric_ref` by metric ID and group key; detect cycles defensively.

- [ ] **Step 4: Verify every catalog test vector**

Add a parametrized test that loads every V2 metric decision record and evaluates every vector.

```bash
python3 -m pytest backend/tests/test_semantic_metric_ast.py -q
```

Expected: PASS for all 54 metric definitions.

- [ ] **Step 5: Commit**

```bash
git add backend/analytics/semantic/metric_ast.py backend/tests/test_semantic_metric_ast.py
git commit -m "feat(analytics): execute governed metric formulas"
```

### Task 3: Implement aggregate, trend, and rank primitives

**Files:**
- Create: `backend/analytics/semantic/aggregate.py`
- Create: `backend/tests/test_semantic_aggregate.py`

- [ ] **Step 1: Write RED tests**

Cover:

- one and multiple metric IDs;
- zero rows producing governed zero;
- enum, boolean, organization, product, requirement, and date groups;
- complete-date trend ordering;
- rank tie-breaks;
- `UNCLASSIFIED` as a real virtual-dimension value;
- unavailable dimension rejected before row scanning;
- missing and unknown values returned with explicit quality states;
- `max_groups` truncation and exact total group count;
- actor row scope applied before metric evaluation.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_aggregate.py -q
```

Expected: FAIL because `aggregate.py` is absent.

- [ ] **Step 3: Implement controlled grouping**

Resolve each dimension through its compiled binding. Apply catalog filters and actor policy before grouping. Preserve zero, missing, unknown, unavailable, and truncated as distinct states. Sort only by allowlisted dimension or metric IDs with deterministic entity-key tie-breaks.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_aggregate.py -q
git add backend/analytics/semantic/aggregate.py backend/tests/test_semantic_aggregate.py
git commit -m "feat(analytics): add semantic aggregate trend and rank"
```

Expected: PASS.

### Task 4: Implement zero-safe per-group comparison

**Files:**
- Create: `backend/analytics/semantic/compare.py`
- Create: `backend/tests/test_semantic_compare.py`

- [ ] **Step 1: Write RED comparison tests**

For each aligned group and metric require:

```python
{
    "group": {"product.business_module": "Navigation"},
    "current": 12,
    "baseline": 8,
    "delta": 4,
    "growthPct": 50.0,
    "changeKind": "increased"
}
```

Cover unchanged, decreased, `new` (baseline zero/current positive), `gone` (baseline positive/current zero), both zero, null/unavailable, multiple grouping dimensions, current-only groups, baseline-only groups, and fixed snapshot use.

Assert `growthPct is None` when baseline is zero and never emit infinity.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_compare.py -q
```

Expected: FAIL because `compare.py` is absent.

- [ ] **Step 3: Implement alignment and derivation**

Run both periods/cohorts through the same aggregate definition and scope. Union keys, fill evaluated empty populations with zero, preserve unavailable/null separately, then calculate delta and change kind. Return exact current and baseline scopes and one `snapshotRef`.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_compare.py -q
git add backend/analytics/semantic/compare.py backend/tests/test_semantic_compare.py
git commit -m "feat(analytics): add zero-safe semantic compare"
```

Expected: PASS.

### Task 5: Implement real record retrieval and stable drilldown

**Files:**
- Create: `backend/analytics/semantic/records.py`
- Create: `backend/tests/test_semantic_records.py`

- [ ] **Step 1: Write RED record tests**

Tests must prove:

- returned rows contain entity records, not grouped counts;
- `selectFields` is checked against the entity-specific field policy;
- sensitive tester/owner identities are redacted or denied;
- stable ordering appends `entityKey`;
- cursor is opaque, signed, actor-scope-bound, query-bound, and snapshot-bound;
- next page has no duplicate or skipped rows;
- stale/tampered cursor returns 409;
- `totalCount`, `returnedCount`, `truncated`, `nextCursor`, and `drilldownRef` are exact;
- a drilldown created by aggregate/compare reproduces its filters and snapshot;
- comment/attachment text remains tagged as untrusted content.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_records.py -q
```

Expected: FAIL because the record engine is absent.

- [ ] **Step 3: Implement cursor and field policy**

Encode cursor payload:

```python
{
    "version": 1,
    "snapshotRef": "snapshot:1111111111111111111111111111111111111111111111111111111111111111",
    "scopeHash": "scope-a",
    "queryHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sortValues": ["CRITICAL", 47, "defect:source.octane:DTSV:D-17"],
    "expiresAt": "2026-07-20T01:00:00Z"
}
```

Sign with an application secret using HMAC-SHA256. Read only catalog-bound canonical fields. A `drilldownRef` is a signed immutable reference to normalized filters, time scopes, source aggregate step, and snapshot.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_records.py -q
git add backend/analytics/semantic/records.py backend/tests/test_semantic_records.py
git commit -m "feat(analytics): return governed semantic records"
```

Expected: PASS.

### Task 6: Implement governed traversal

**Files:**
- Create: `backend/analytics/semantic/traverse.py`
- Create: `backend/tests/test_semantic_traverse.py`

- [ ] **Step 1: Write RED traversal tests**

Cover every relationship family in Sections 5.1–5.5, forward/reverse permission, allowed path sequences, depth and edge limits, cycle handling, broken links, scope propagation, redaction, source lineage, and deterministic breadth-first ordering.

Reject polymorphic ad hoc endpoints and many-to-many expansion without the declared explosion policy.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_traverse.py -q
```

Expected: FAIL because the traversal engine is absent.

- [ ] **Step 3: Implement bounded traversal**

Start keys must be authorized entity keys. Resolve each requested relationship ID through the catalog and query only `semantic_trace_edges` or explicitly materialized relationship bindings. Return nodes, edges, paths, broken-edge diagnostics, `totalEdges`, `returnedEdges`, and truncation.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_traverse.py -q
git add backend/analytics/semantic/traverse.py backend/tests/test_semantic_traverse.py
git commit -m "feat(analytics): add governed semantic traversal"
```

Expected: PASS.

### Task 7: Orchestrate scope, capability, snapshot, and evidence

**Files:**
- Create: `backend/analytics/semantic/evidence.py`
- Create: `backend/analytics/semantic/service.py`
- Create: `backend/tests/test_semantic_service.py`
- Create: `backend/tests/test_semantic_security.py`

- [ ] **Step 1: Write RED orchestration tests**

Assert this order:

```text
parse contract
verify catalog fingerprint
load ready snapshot
recompute actor scope
resolve migration aliases
verify capabilities
authorize entity/fields/relationships
execute primitive
validate response/evidence
```

Test denied entities, properties, teams/projects/releases, stale snapshot, partial source, unsynchronized ratio, source field unavailable, maximum limits, prompt-injection strings in records, and read-only database enforcement.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_service.py backend/tests/test_semantic_security.py -q
```

Expected: FAIL because service/evidence modules are absent.

- [ ] **Step 3: Implement the service**

Expose:

```python
SemanticService.query_metrics(request)
SemanticService.query_records(request)
SemanticService.query_traverse(request)
SemanticService.lookup_concepts(request)
```

All responses include one source revision set, exact scope, quality state, warnings, and an evidence checksum. Content fields are data, never executable instructions.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_service.py backend/tests/test_semantic_security.py -q
git add backend/analytics/semantic/evidence.py backend/analytics/semantic/service.py backend/tests/test_semantic_service.py backend/tests/test_semantic_security.py
git commit -m "feat(analytics): orchestrate semantic v2 execution"
```

Expected: PASS.

### Task 8: Expose four thin V2 HTTP routes

**Files:**
- Create: `backend/tests/test_semantic_v2_api.py`
- Modify: `backend/analytics/api.py`
- Modify: `backend/analytics/semantic_query.py`

- [ ] **Step 1: Write RED API tests**

Add:

```text
POST /api/semantic/v2/metrics
POST /api/semantic/v2/records
POST /api/semantic/v2/traverse
POST /api/semantic/v2/lookup
GET  /api/semantic/v2/health
```

Assert error mapping: 400 contract, 403 policy, 409 fingerprint/snapshot/cursor, 422 capability, 503 unavailable source. The health route returns V2 version, fingerprint, active snapshot, and capability summary without sensitive paths.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_v2_api.py -q
```

Expected: FAIL because routes are absent.

- [ ] **Step 3: Implement thin routes**

Routes parse JSON, obtain trusted actor context from the request integration, call one `SemanticService` method, and serialize its validated result. Keep `/api/semantic/query` as a V1 compatibility adapter until the cutover plan.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_v2_api.py backend/tests/test_semantic_query_api.py -q
git add backend/analytics/api.py backend/analytics/semantic_query.py backend/tests/test_semantic_v2_api.py
git commit -m "feat(api): expose semantic v2 primitives"
```

Expected: both V2 and V1 compatibility tests pass.

### Task 9: Upgrade the Node registry, context packs, and SemanticFrame

**Files:**
- Create: `server/ontology/contextPacks.mjs`
- Create: `src/test/server/ontology/contextPacks.test.ts`
- Modify: `server/ontology/registry.mjs`
- Modify: `server/ontology/semanticFrame.mjs`
- Modify: `server/ontology/validator.mjs`
- Modify: `src/test/server/ontology/registry.test.ts`
- Modify: `src/test/server/ontology/semanticResolver.test.ts`

- [ ] **Step 1: Write RED Node tests**

Assert V2 default paths, five contexts, analysis product/context-pack lookup, migration aliases, capability lookup, zero drafts, strict schema `2.0`, `snapshotRef`, `sourceRevisionSet`, and these ambiguity outcomes:

```ts
expect(resolve("QGate 本周缺陷")).toMatchObject({ contextIds: ["defect_management"] });
expect(resolve("测试覆盖率")).toMatchObject({ status: "needs_clarification" });
expect(resolve("按模块看缺陷")).toMatchObject({
  ambiguities: [expect.objectContaining({ code: "BUSINESS_MODULE_AMBIGUOUS" })],
});
expect(resolve("按 ECU 模块看缺陷")).toMatchObject({ dimensionIds: ["product.ecu"] });
```

- [ ] **Step 2: Run RED**

```bash
npm test -- \
  src/test/server/ontology/registry.test.ts \
  src/test/server/ontology/contextPacks.test.ts \
  src/test/server/ontology/semanticResolver.test.ts
```

Expected: FAIL against V1 contracts.

- [ ] **Step 3: Implement V2 registry and bounded packs**

Default to `ontology/generated/v2`. Provide indexed getters for contexts, sources, entities, relationships, dimensions, metrics, products, policies, constraints, capabilities, migration aliases, and terms. Context-pack retrieval accepts validated intent/context IDs and returns only referenced fragments within the configured token cap.

- [ ] **Step 4: Upgrade SemanticFrame**

Require `schemaVersion: "2.0"`, catalog fingerprint, request anchor, context/product IDs, resolved IDs, ambiguity objects, assumptions, capability requirements, plan hints, and confidence. Snapshot is assigned by the planner, never guessed by the model.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- \
  src/test/server/ontology/registry.test.ts \
  src/test/server/ontology/contextPacks.test.ts \
  src/test/server/ontology/semanticResolver.test.ts
git add server/ontology/registry.mjs server/ontology/contextPacks.mjs server/ontology/semanticFrame.mjs server/ontology/validator.mjs src/test/server/ontology/registry.test.ts src/test/server/ontology/contextPacks.test.ts src/test/server/ontology/semanticResolver.test.ts
git commit -m "feat(agent): resolve ontology v2 concepts"
```

Expected: PASS.

### Task 10: Compile V2 requests and dependent plans

**Files:**
- Create: `server/ontology/resultTransforms.mjs`
- Create: `server/ontology/ontologyClient.mjs`
- Create: `src/test/server/ontology/resultTransforms.test.ts`
- Create: `src/test/server/ontology/ontologyClient.test.ts`
- Modify: `server/ontology/queryCompiler.mjs`
- Modify: `server/ontology/queryPlanner.mjs`
- Modify: `src/test/server/ontology/queryPlanner.test.ts`

- [ ] **Step 1: Write RED planner tests**

Require:

- one snapshot health step before the first data query;
- all subsequent steps carry the same snapshot;
- aggregate, trend, rank, compare, records, traverse, and lookup compile to separate request shapes;
- unavailable fields fail before execution;
- “先找增长最快的模块，再看严重度和样本” produces:

```text
1 query_semantic_metrics(compare by product.business_module)
2 select_growth_outliers(step 1)
3 query_semantic_metrics(severity/status filtered by step 2)
4 query_semantic_records(filtered by step 2, drilldownRef from step 1)
```

- only these transforms are allowed:

```text
select_top_groups
select_growth_outliers
extract_filter_values
project_entity_keys
join_compatible_evidence
```

- [ ] **Step 2: Run RED**

```bash
npm test -- \
  src/test/server/ontology/queryPlanner.test.ts \
  src/test/server/ontology/resultTransforms.test.ts \
  src/test/server/ontology/ontologyClient.test.ts
```

Expected: FAIL because V2 planning modules are absent or still V1-shaped.

- [ ] **Step 3: Implement strict compilation and transforms**

`queryCompiler.mjs` accepts only a validated SemanticFrame and registry objects. `queryPlanner.mjs` emits a DAG with explicit `dependsOn`, typed `inputBindings`, one `snapshotRef`, budgets, and a final evidence-join step. Transforms validate their input/output schemas and cannot invent catalog IDs.

`ontologyClient.mjs` calls only configured local analytics routes, applies timeout/cancellation, validates V2 responses, and rejects fingerprint/query/snapshot mismatches.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- \
  src/test/server/ontology/queryPlanner.test.ts \
  src/test/server/ontology/resultTransforms.test.ts \
  src/test/server/ontology/ontologyClient.test.ts
git add server/ontology/queryCompiler.mjs server/ontology/queryPlanner.mjs server/ontology/resultTransforms.mjs server/ontology/ontologyClient.mjs src/test/server/ontology/queryPlanner.test.ts src/test/server/ontology/resultTransforms.test.ts src/test/server/ontology/ontologyClient.test.ts
git commit -m "feat(agent): plan dependent semantic v2 queries"
```

Expected: PASS.

### Task 11: Register the four primitives in the Main Agent Runtime

**Files:**
- Modify: `server/mainAgentTools.mjs`
- Modify: `server/agentRuntime/toolRegistry.mjs`
- Modify: `server/agentRuntime/graph.mjs`
- Modify: `server/agentRuntime/evidence.mjs`
- Modify: `src/test/server/mainAgentTools.test.ts`
- Modify: `src/test/server/agentRuntime/toolRegistry.test.ts`
- Modify: `src/test/server/agentRuntime/graph.test.ts`
- Modify: `src/test/server/agentRuntime/evidence.test.ts`

- [ ] **Step 1: Write RED integration tests**

Expected public tools:

```ts
[
  "query_semantic_metrics",
  "query_semantic_records",
  "query_semantic_traverse",
  "lookup_ontology_concepts",
  "search_duplicates",
]
```

Verify each semantic tool is version `ontology-semantic-v2`, uses its own request schema/endpoint, preserves one snapshot across dependent tool calls and recovery, and produces validated V2 evidence before claims.

Assert `search_duplicates` still invokes the existing adapter and that no Duplicate Search internal file changes.

- [ ] **Step 2: Run RED**

```bash
npm test -- \
  src/test/server/mainAgentTools.test.ts \
  src/test/server/agentRuntime/toolRegistry.test.ts \
  src/test/server/agentRuntime/graph.test.ts \
  src/test/server/agentRuntime/evidence.test.ts
```

Expected: FAIL because Runtime still exposes V1 `query_traceability` and generic semantic payloads.

- [ ] **Step 3: Implement adapters and evidence validation**

Replace `query_traceability` with `query_semantic_traverse`. Route the four V2 tools through `ontologyClient.mjs`. Store `snapshotRef` and full `sourceRevisionSet` in graph state and step journal. Evidence validation must check scope, fingerprint, snapshot, metric/dimension/field IDs, compare shape, record page metadata, traversal lineage, redaction, and quality state before claim creation.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- \
  src/test/server/mainAgentTools.test.ts \
  src/test/server/agentRuntime/toolRegistry.test.ts \
  src/test/server/agentRuntime/graph.test.ts \
  src/test/server/agentRuntime/evidence.test.ts
git add server/mainAgentTools.mjs server/agentRuntime/toolRegistry.mjs server/agentRuntime/graph.mjs server/agentRuntime/evidence.mjs src/test/server/mainAgentTools.test.ts src/test/server/agentRuntime/toolRegistry.test.ts src/test/server/agentRuntime/graph.test.ts src/test/server/agentRuntime/evidence.test.ts
git commit -m "feat(runtime): execute ontology v2 primitives"
```

Expected: PASS.

### Task 12: Qualify the controlled semantic kernel

**Files:**
- Create: `backend/tests/test_semantic_kernel_acceptance.py`
- Create: `src/test/server/ontology/v2KernelAcceptance.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add one end-to-end fixed-snapshot fixture**

The fixture must include:

- two business modules present in both periods;
- one new and one gone module;
- severity/status drilldown records;
- unavailable `product.service_pack`;
- a valid and a broken trace edge;
- sensitive tester data;
- one prompt-injection string in a defect comment.

Assert aggregate → growth selection → secondary aggregate → records uses one snapshot and returns evidence-linked records.

- [ ] **Step 2: Run focused qualification**

```bash
python3 -m pytest \
  backend/tests/test_semantic_v2_contracts.py \
  backend/tests/test_semantic_metric_ast.py \
  backend/tests/test_semantic_aggregate.py \
  backend/tests/test_semantic_compare.py \
  backend/tests/test_semantic_records.py \
  backend/tests/test_semantic_traverse.py \
  backend/tests/test_semantic_service.py \
  backend/tests/test_semantic_security.py \
  backend/tests/test_semantic_v2_api.py \
  backend/tests/test_semantic_kernel_acceptance.py -q
npm test -- \
  src/test/server/ontology \
  src/test/server/agentRuntime/toolRegistry.test.ts \
  src/test/server/agentRuntime/graph.test.ts \
  src/test/server/agentRuntime/evidence.test.ts \
  src/test/server/mainAgentTools.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 3: Run compatibility and mutation guards**

```bash
python3 -m pytest backend/tests/test_semantic_query_api.py -q
git diff --exit-code -- server/duplicateBridgeRuntime.cjs scripts/duplicate_search_bridge.py
git status --short
```

Expected: V1 compatibility tests pass; Duplicate Search diff is empty; the embeddings database is absent from this worktree.

- [ ] **Step 4: Scan for bypasses and incomplete paths**

```bash
rg -n -i 'TODO|TBD|placeholder|not implemented|select\\s+.+from|query_traceability' \
  backend/analytics/semantic server/ontology server/mainAgentTools.mjs server/agentRuntime \
  backend/tests/test_semantic_ src/test/server/ontology
```

Expected: no incomplete marker, arbitrary SQL path, or old public trace tool. Literal SQL inside the private canonical storage layer must use fixed table/column names and never interpolate request values.

- [ ] **Step 5: Commit**

```bash
git add package.json backend/tests/test_semantic_kernel_acceptance.py src/test/server/ontology/v2KernelAcceptance.test.ts
git commit -m "test(semantic): qualify controlled v2 kernel"
```

## Semantic-kernel completion gate

Do not start product cutover until:

- every primitive passes fixed-snapshot tests;
- records, compare, and traversal meet their exact contracts;
- actor scope and fields fail closed in Python and Node;
- the dependent planner proves aggregate-to-drilldown execution;
- evidence validation rejects mismatched scope, fingerprint, snapshot, or shape;
- Duplicate Search internals have a zero diff.
