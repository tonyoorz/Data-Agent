# Testing Quality Ontology V2 Products and Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute all eight governed Quality Intelligence products through V2 primitives, reconcile existing dashboards/reports to the same definitions, validate claims and evidence, migrate accepted V1 callers, and make V2 the default Main Agent semantic path.

**Architecture:** Treat each product as a versioned dependency recipe interpreted by a single product runner. Product steps call the controlled semantic service only; report rendering consumes validated evidence and claims. Existing page/report endpoints become adapters over the same V2 primitives and canonical snapshots. Cutover is guarded by parity, semantic golden, recovery, security, build, and full-suite qualification.

**Tech Stack:** Python 3, FastAPI, SQLite, Node.js 24.14.0 ESM, LangGraph JS, Ajv, React/TypeScript, pytest, Vitest.

---

## Entry conditions and release boundaries

- Foundation and semantic-kernel completion gates pass.
- Product recipes cannot call page endpoints, arbitrary SQL, files, URLs, or write tools.
- Every product run pins one immutable snapshot and source revision set.
- Top Issue, weekly report, coverage, and traceability remain testing-department concepts; they do not resolve to QGate by default.
- Report text is rendered only from validated claims and evidence.
- V1 accepted IDs migrate through explicit aliases; removed metrics fail with a governed replacement explanation.
- Page adapters and Agent tools use the same metric IDs and canonical read models.
- Duplicate Search internals remain unchanged.

## File responsibility map

| Path | Responsibility |
|---|---|
| `backend/analytics/semantic/products.py` | Versioned recipe interpreter and dependency execution |
| `backend/analytics/semantic/product_transforms.py` | Strict product-only selection and evidence joins |
| `backend/analytics/semantic/reporting.py` | Evidence-backed report sections and artifacts |
| `backend/analytics/semantic/claims.py` | Observed/derived claim construction and validation |
| `backend/analytics/semantic/compatibility.py` | V1 ID and request adaptation |
| `backend/analytics/api.py` | Thin product-run and compatibility routes |
| `server/ontology/productPlanner.mjs` | Agent product selection and typed invocation |
| `server/agentRuntime/evidence.mjs` | V2 evidence/claim acceptance and deterministic fallback |
| `server/agentRuntime/graph.mjs` | Product plan execution and recovery |
| `scripts/generateSemanticGolden.mjs` | V2 bilingual semantic goldens |
| `scripts/qualifyOntologyV2.mjs` | Machine-readable acceptance report and cutover gate |
| Existing dashboard/report modules | Adapters over V2 service, with no independent formulas |

### Task 1: Interpret governed analysis-product recipes

**Files:**
- Create: `backend/analytics/semantic/product_transforms.py`
- Create: `backend/analytics/semantic/products.py`
- Create: `backend/tests/test_semantic_products.py`

- [ ] **Step 1: Write RED recipe-runner tests**

For each of the eight catalog product IDs, assert:

- product and definition version are catalog-derived;
- inputs are exact-key validated;
- dependencies execute topologically;
- all primitive steps receive the same `snapshotRef`;
- transforms accept only declared input step IDs and typed outputs;
- failed or unavailable mandatory steps stop the product;
- optional partial steps produce an explicit limitation;
- output evidence IDs refer to executed steps;
- a page endpoint or undeclared tool in a recipe is rejected.

Use this result contract:

```python
{
    "schemaVersion": "2.0",
    "productRunId": "product-run-1",
    "productId": "analysis.long_runner",
    "definitionVersion": "1.0.0",
    "snapshotRef": "snapshot:1111111111111111111111111111111111111111111111111111111111111111",
    "sourceRevisionSet": {},
    "inputs": {},
    "sections": [],
    "evidence": [],
    "claims": [],
    "quality": {"completeness": "complete", "warnings": []}
}
```

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_products.py -q
```

Expected: FAIL because product execution modules are absent.

- [ ] **Step 3: Implement a bounded DAG interpreter**

Resolve the recipe only from the compiled catalog. Allow the four semantic primitives and these transforms:

```text
select_top_groups
select_growth_outliers
extract_filter_values
project_entity_keys
join_compatible_evidence
bucket_age
calculate_share
assemble_sections
```

Validate step input/output schemas, prevent cycles, enforce product step budget, and pass one trusted actor scope and snapshot through every step.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_products.py -q
git add backend/analytics/semantic/product_transforms.py backend/analytics/semantic/products.py backend/tests/test_semantic_products.py
git commit -m "feat(quality): execute governed analysis products"
```

Expected: PASS for all eight recipe shapes.

### Task 2: Implement Top Issue, long runner, and defect hotspot

**Files:**
- Create: `backend/tests/test_semantic_defect_products.py`
- Modify: `backend/analytics/semantic/products.py`
- Modify: `backend/analytics/semantic/product_transforms.py`

- [ ] **Step 1: Write RED product fixtures**

Top Issue must apply:

```text
is_active = true
severity in SHOWSTOPPER, CRITICAL, MAJOR
order severity_rank asc, age_days desc, defect_id asc
limit policy.max_top_issue_records
```

Assert returned rule, severity set, snapshot date, record evidence, and visible user override.

Long runner must return count, average/P90 age, 30/60-day buckets, and records.

Hotspot must require an explicit group dimension, return top groups and `quality.hotspot_top5_share`, then run secondary severity/status aggregates and records for selected groups. Generic module uses the approved virtual dimension and includes `resolutionPath` plus `UNCLASSIFIED`.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_defect_products.py -q
```

Expected: FAIL until product outputs are complete.

- [ ] **Step 3: Implement the three products through primitives**

Do not add product-specific SQL or page calls. Encode defaults in catalog recipes and evaluate them through the shared runner. Product code may only validate specialized inputs and assemble typed sections from primitive results.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_defect_products.py -q
git add backend/analytics/semantic/products.py backend/analytics/semantic/product_transforms.py backend/tests/test_semantic_defect_products.py
git commit -m "feat(quality): add defect intelligence products"
```

Expected: PASS.

### Task 3: Implement phase efficiency and test coverage overview

**Files:**
- Create: `backend/tests/test_semantic_test_products.py`
- Modify: `backend/analytics/semantic/products.py`

- [ ] **Step 1: Write RED fixtures**

Phase efficiency must return transition count, average/P90 business days, usable-history coverage, transition filters, and records. Invalid or unordered history is excluded with explicit coverage impact.

Test coverage overview must return testcase/run/completed/passed/failed counts, pass/fail rates, execution coverage, unexecuted testcase count, active tester count subject to confidentiality, and breakdowns by allowed project/release/AIDA dimensions.

Zero denominator produces `unknown`, not zero.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_test_products.py -q
```

Expected: FAIL until both recipes produce every mandatory output.

- [ ] **Step 3: Complete primitive-only execution**

Use V2 metric IDs and one snapshot. Cross-source or missing-denominator metrics must return `unavailable` with reason codes; the product cannot infer coverage from relation rows alone.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_test_products.py -q
git add backend/analytics/semantic/products.py backend/tests/test_semantic_test_products.py
git commit -m "feat(quality): add phase and test coverage products"
```

Expected: PASS.

### Task 4: Implement traceability gap and controlled team/project comparison

**Files:**
- Create: `backend/tests/test_semantic_trace_comparison_products.py`
- Modify: `backend/analytics/semantic/products.py`

- [ ] **Step 1: Write RED fixtures**

Traceability gap returns requirement/testcase/run coverage rates, orphan testcase and broken-link counts, valid traversed paths, and gap records. It rejects requirement coverage when the denominator population is unavailable.

Team/project comparison uses the same metrics, filters, time scopes, and snapshot for every group. Each row includes current, baseline, delta, growth, and new/gone state. Actor scope must remove unauthorized groups before comparison.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_trace_comparison_products.py -q
```

Expected: FAIL until both products are complete.

- [ ] **Step 3: Implement through traversal and compare**

Use `query_semantic_traverse` for paths and `compare.py` for group alignment. Product assembly must not recalculate metrics independently.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_trace_comparison_products.py -q
git add backend/analytics/semantic/products.py backend/tests/test_semantic_trace_comparison_products.py
git commit -m "feat(quality): add traceability and comparison products"
```

Expected: PASS.

### Task 5: Implement the weekly quality report and report artifacts

**Files:**
- Create: `backend/analytics/semantic/reporting.py`
- Create: `backend/tests/test_semantic_weekly_report_product.py`
- Modify: `backend/analytics/semantic/products.py`

- [ ] **Step 1: Write RED weekly-report tests**

Require exactly these ordered sections:

```text
scope_source_health
defect_flow_inventory
critical_long_runner
test_execution_coverage
traceability
top_issue_records
largest_changes
evidence_completeness
```

Assert inflow, terminal-outcome components, outflow, net change, active inventory, critical and long-runner counts, run/pass/fail and coverage, trace gaps, Top Issue records, one explicit comparison dimension, and citations to evidence. All sections share one ISO week and one source revision set.

Simulate one stale/partial source and verify the report marks the affected section partial without converting unavailable values to zero.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_weekly_report_product.py -q
```

Expected: FAIL because report assembly is absent.

- [ ] **Step 3: Implement evidence-backed report assembly**

Render structured JSON first; Markdown is a pure view over validated claims. Store artifacts through the existing Runtime artifact boundary with product ID, inputs, fingerprint, snapshot, revision set, evidence IDs, and content hash. Never embed raw confidential fields or untrusted comment text as instructions.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_weekly_report_product.py -q
git add backend/analytics/semantic/reporting.py backend/analytics/semantic/products.py backend/tests/test_semantic_weekly_report_product.py
git commit -m "feat(quality): generate governed weekly report"
```

Expected: PASS.

### Task 6: Validate observed and derived claims before rendering

**Files:**
- Create: `backend/analytics/semantic/claims.py`
- Create: `backend/tests/test_semantic_claims.py`
- Modify: `server/agentRuntime/evidence.mjs`
- Modify: `src/test/server/agentRuntime/evidence.test.ts`

- [ ] **Step 1: Write RED claim tests**

Cover:

- observed metric claim exactly matching evidence;
- grouped current/baseline values;
- derived delta and growth with input claim IDs;
- ratio zero-denominator limitation;
- record claim linked to record evidence;
- traversal claim linked to edge/path evidence;
- rejected mismatched value, group, snapshot, scope, metric version, redacted field, or source revision;
- no claim from similarity candidates as a population fact;
- deterministic insufficient-evidence answer when validation rejects all claims.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_claims.py -q
npm test -- src/test/server/agentRuntime/evidence.test.ts
```

Expected: FAIL until V2 claim validation is complete in both layers.

- [ ] **Step 3: Implement one claim contract**

Claim fields:

```text
claimId
claimType
metricId or predicateId
definitionVersion
value
unit
dimensions
timeScopes
derivation
inputClaimIds
evidenceIds
snapshotRef
sourceRevisionSetHash
text
```

Python validates product claims at creation; Node revalidates accepted claims before rendering/persistence. Derived claims allow only catalog-approved operations and referenced input claims.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_claims.py -q
npm test -- src/test/server/agentRuntime/evidence.test.ts
git add backend/analytics/semantic/claims.py backend/tests/test_semantic_claims.py server/agentRuntime/evidence.mjs src/test/server/agentRuntime/evidence.test.ts
git commit -m "feat(runtime): validate v2 evidence claims"
```

Expected: PASS.

### Task 7: Expose product runs to the Agent

**Files:**
- Create: `server/ontology/productPlanner.mjs`
- Create: `src/test/server/ontology/productPlanner.test.ts`
- Create: `backend/tests/test_semantic_product_api.py`
- Modify: `backend/analytics/api.py`
- Modify: `server/mainAgentTools.mjs`
- Modify: `server/agentRuntime/toolRegistry.mjs`
- Modify: `server/agentRuntime/graph.mjs`

- [ ] **Step 1: Write RED API and planner tests**

Add `POST /api/semantic/v2/products/{productId}/runs`.

Agent resolution must map:

```text
周报 -> analysis.weekly_quality_report
Top Issue/重点问题 -> analysis.top_issue
Long Runner/老缺陷 -> analysis.long_runner
热点/高频模块 -> analysis.defect_hotspot
阶段效率 -> analysis.phase_efficiency
测试覆盖概览 -> analysis.test_coverage_overview
追溯缺口 -> analysis.traceability_gap
团队/项目对比 -> analysis.team_project_comparison
```

Assert QGate alone does not select non-defect products and Octane only adds source context.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_product_api.py -q
npm test -- src/test/server/ontology/productPlanner.test.ts
```

Expected: FAIL because product API/planner is absent.

- [ ] **Step 3: Implement product invocation**

The planner validates required inputs and either emits a focused clarification or a product-run request. Runtime executes product runs as recoverable external steps, journals the snapshot and input hash, validates the returned evidence/claims, and then renders.

Do not add eight page-shaped model tools. Expose one governed `run_analysis_product` tool whose `productId` enum comes from the registry, alongside the four semantic primitives.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_product_api.py -q
npm test -- src/test/server/ontology/productPlanner.test.ts src/test/server/agentRuntime/graph.test.ts src/test/server/agentRuntime/toolRegistry.test.ts
git add backend/analytics/api.py backend/tests/test_semantic_product_api.py server/ontology/productPlanner.mjs server/mainAgentTools.mjs server/agentRuntime/toolRegistry.mjs server/agentRuntime/graph.mjs src/test/server/ontology/productPlanner.test.ts
git commit -m "feat(agent): run governed quality products"
```

Expected: PASS.

### Task 8: Adapt existing pages and reports to shared V2 definitions

**Files:**
- Create: `backend/analytics/semantic/page_adapters.py`
- Create: `backend/tests/test_semantic_page_parity.py`
- Modify: `backend/analytics/read_models.py`
- Modify: `backend/analytics/qgate_weekly_report.py`
- Modify: `backend/analytics/qgate_kpi_report_common.py`
- Modify: `backend/analytics/qgate_kpi_dashboard_report.py`
- Modify: `backend/analytics/qgate_kpi_compare_report.py`
- Modify: `backend/analytics/testing_coverage_hot.py`
- Modify: `backend/analytics/testing_coverage_models.py`
- Modify: `backend/analytics/traceability_models.py`
- Modify: `backend/analytics/api.py`

- [ ] **Step 1: Write RED parity tests**

On the same fixture, filters, and snapshot assert:

- Full Picture defect totals equal `defect.count`;
- outcome flags equal resolved-forward/direct-rejection materialization;
- testing page totals equal V2 testcase/run metrics;
- traceability page counts equal V2 edge populations;
- weekly report sections equal the weekly product;
- Top Issue page records equal the governed Top Issue rule;
- compare report values equal V2 compare rows.

Monkeypatch product/page adapters to fail if legacy modules independently calculate a governed formula.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_page_parity.py -q
```

Expected: FAIL because existing endpoints own separate formulas.

- [ ] **Step 3: Implement adapters**

`page_adapters.py` translates page request fields to semantic filters, calls `SemanticService` or product runner, and maps validated results to existing response DTOs. Preserve page compatibility fields, but include V2 fingerprint, snapshot, revision set, and quality metadata.

Remove duplicate formula implementations only after each parity assertion passes. Preserve ingestion, source adapters, and Duplicate Search code.

- [ ] **Step 4: Run page/report regression**

```bash
python3 -m pytest \
  backend/tests/test_semantic_page_parity.py \
  backend/tests/test_analytics_full_picture_api.py \
  backend/tests/test_analytics_testing_api.py \
  backend/tests/test_traceability_analysis.py \
  backend/tests/test_qgate_weekly_report.py \
  backend/tests/test_qgate_kpi_dashboard_report.py \
  backend/tests/test_qgate_kpi_compare_report.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/analytics/semantic/page_adapters.py backend/analytics/read_models.py backend/analytics/qgate_weekly_report.py backend/analytics/qgate_kpi_report_common.py backend/analytics/qgate_kpi_dashboard_report.py backend/analytics/qgate_kpi_compare_report.py backend/analytics/testing_coverage_hot.py backend/analytics/testing_coverage_models.py backend/analytics/traceability_models.py backend/analytics/api.py backend/tests/test_semantic_page_parity.py
git commit -m "refactor(analytics): share v2 definitions with page adapters"
```

### Task 9: Add explicit V1 compatibility and make V2 default

**Files:**
- Create: `backend/analytics/semantic/compatibility.py`
- Create: `backend/tests/test_semantic_v1_compatibility.py`
- Modify: `backend/analytics/ontology.py`
- Modify: `backend/analytics/semantic_query.py`
- Modify: `server/ontology/registry.mjs`
- Modify: `server/ontology/resolver.mjs`
- Modify: `server/index.mjs`
- Modify: `server/app.mjs`

- [ ] **Step 1: Write RED compatibility/cutover tests**

Assert:

```text
team.execution_count -> testing.run_count grouped by org.test_team
team.defect_discovery_count -> defect.created_count grouped by org.problem_finder_team
defect.direct_rejection_count -> defect.rejected_count
testing.requirement_coverage_rate -> traceability.requirement_coverage_rate
testing.traceability_rate -> resolver selects subject-specific traceability metric
```

Removed IDs return `SEMANTIC_METRIC_REMOVED` and recommend `quality.defects_per_100_completed_runs` where applicable. `quality.qgate` always fails. New Node/Python loads default to V2; V1 requires an explicit compatibility flag.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_v1_compatibility.py -q
npm test -- src/test/server/ontology/registry.test.ts src/test/server/ontology/semanticResolver.test.ts
```

Expected: FAIL while V1 remains default.

- [ ] **Step 3: Implement the migration boundary**

Adapt accepted V1 IDs before validation and record `requestedId`, `resolvedId`, and migration rule in scope metadata. Do not copy formulas. Composition roots load V2 default fingerprint and refuse startup if the compiled bundle/capability report is stale.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m pytest backend/tests/test_semantic_v1_compatibility.py backend/tests/test_semantic_query_api.py -q
npm test -- src/test/server/ontology
git add backend/analytics/semantic/compatibility.py backend/analytics/ontology.py backend/analytics/semantic_query.py backend/tests/test_semantic_v1_compatibility.py server/ontology/registry.mjs server/ontology/resolver.mjs server/index.mjs server/app.mjs
git commit -m "feat(ontology): cut default semantic path to v2"
```

Expected: PASS with V2 default.

### Task 10: Replace semantic goldens with complete V2 behavior

**Files:**
- Modify: `evals/main-agent/semantic/golden.jsonl`
- Modify: `scripts/generateSemanticGolden.mjs`
- Modify: `src/test/server/ontology/semanticGolden.test.ts`

- [ ] **Step 1: Add RED golden cases**

Include mixed Chinese/English cases for every rule in specification Section 18.4 and each analysis product. Mandatory cases:

```text
QGate defect questions -> defect_management only
测试覆盖率 -> clarification
周报 -> weekly product, not QGate
Top Issue -> top_issue product, not QGate
Octane -> source context
按模块 -> candidates or business_module with visible assumption
按 ECU 模块 -> product.ecu
aggregate -> high-growth groups -> severity -> records dependent plan
elliptical follow-up -> validated frame reuse with a newly pinned run snapshot
unavailable field -> capability explanation, never (missing)
```

- [ ] **Step 2: Run RED**

```bash
npm run semantic-golden:generate
npm run semantic-golden:check
```

Expected: initial check fails until generator and resolver emit V2 expectations.

- [ ] **Step 3: Upgrade deterministic generation**

Generate expected frames/plans from the V2 registry and fixed request anchors. Include catalog fingerprint and source hashes so stale goldens fail.

- [ ] **Step 4: Verify and commit**

```bash
npm run semantic-golden:generate
npm run semantic-golden:check
npm test -- src/test/server/ontology/semanticGolden.test.ts
git add evals/main-agent/semantic/golden.jsonl scripts/generateSemanticGolden.mjs src/test/server/ontology/semanticGolden.test.ts
git commit -m "test(ontology): cover v2 semantic goldens"
```

Expected: PASS.

### Task 11: Prove Runtime recovery and safety under V2

**Files:**
- Create: `src/test/server/agentRuntime/ontologyV2Recovery.test.ts`
- Create: `src/test/server/agentRuntime/ontologyV2Safety.test.ts`
- Modify: `server/agentRuntime/graph.mjs`
- Modify: `server/agentRuntime/stepJournal.mjs`
- Modify: `server/agentRuntime/untrustedContent.mjs`
- Modify: `server/agentRuntime/evidence.mjs`

- [ ] **Step 1: Write RED failure-path tests**

Deterministically inject:

- process recovery after aggregate but before records;
- changed active snapshot during a run;
- fingerprint mismatch;
- stale/partial source;
- policy-denied property;
- comment/attachment prompt injection;
- evidence scope/snapshot mismatch;
- invalid derived claim;
- similarity result presented as a rate;
- unsynchronized cross-source ratio.

Recovery must reuse completed evidence, pinned snapshot, and idempotency keys; it must never switch to the new active snapshot.

- [ ] **Step 2: Run RED**

```bash
npm test -- \
  src/test/server/agentRuntime/ontologyV2Recovery.test.ts \
  src/test/server/agentRuntime/ontologyV2Safety.test.ts
```

Expected: FAIL until V2 state and validation are fully journaled.

- [ ] **Step 3: Complete recovery and safety gates**

Persist V2 fingerprint, snapshot, source revision set, product/plan version, normalized step input hash, evidence IDs, and claim IDs. Treat all source text as untrusted data and validate rendered output before persistence/streaming.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- \
  src/test/server/agentRuntime/ontologyV2Recovery.test.ts \
  src/test/server/agentRuntime/ontologyV2Safety.test.ts \
  src/test/server/agentRuntime/recovery.test.ts \
  src/test/server/agentRuntime/graphResume.test.ts
git add server/agentRuntime/graph.mjs server/agentRuntime/stepJournal.mjs server/agentRuntime/untrustedContent.mjs server/agentRuntime/evidence.mjs src/test/server/agentRuntime/ontologyV2Recovery.test.ts src/test/server/agentRuntime/ontologyV2Safety.test.ts
git commit -m "test(runtime): prove ontology v2 recovery safety"
```

Expected: PASS.

### Task 12: Build an auditable V2 qualification command

**Files:**
- Create: `scripts/qualifyOntologyV2.mjs`
- Create: `src/test/server/ontology/v2Qualification.test.ts`
- Create: `docs/ontology-v2-operations.md`
- Modify: `package.json`

- [ ] **Step 1: Write RED qualification tests**

The script must produce JSON containing all 20 acceptance criteria, command results, durations, catalog counts, fingerprint, snapshot/capability status, parity results, Duplicate Search diff guard, source DB pre/post hashes, and final decision.

Add:

```json
{
  "ontology:v2:qualify": "node scripts/qualifyOntologyV2.mjs --strict"
}
```

- [ ] **Step 2: Run RED**

```bash
npm test -- src/test/server/ontology/v2Qualification.test.ts
```

Expected: FAIL because the qualification script is absent.

- [ ] **Step 3: Implement the strict orchestrator**

Use `spawnSync` with fixed executable/argument arrays, bounded output, explicit Node/Python versions, and no shell interpolation. A missing, skipped, partial, or nonzero check makes strict qualification fail. Write reports to ignored Runtime artifacts, not generated ontology sources.

Document compile/profile/materialize/query/product/cutover/recovery operations, source read-only guarantees, fingerprint mismatch response, rollback through explicit V1 compatibility mode, and evidence needed for incident review.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- src/test/server/ontology/v2Qualification.test.ts
git add package.json scripts/qualifyOntologyV2.mjs src/test/server/ontology/v2Qualification.test.ts docs/ontology-v2-operations.md
git commit -m "build(ontology): add strict v2 qualification"
```

Expected: PASS.

### Task 13: Run focused, full, build, and mutation qualification

**Files:**
- Verify only; if a command exposes a defect, stop this task, add the smallest failing regression test in the owning task's test file, implement the fix there, rerun that owning task, and restart Task 13 from Step 1.

- [ ] **Step 1: Capture protected hashes and status**

```bash
git status --short
shasum -a 256 \
  server/duplicateBridgeRuntime.cjs \
  scripts/duplicate_search_bridge.py \
  backend/database/ticket_embeddings.db
```

Expected: implementation worktree is clean before qualification.

- [ ] **Step 2: Run exact release commands under Node 24.14.0**

```bash
export PATH="/Users/tonyorz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node --version
npm run ontology:v2:compile
npm run ontology:v2:check
npm run semantic-golden:check
npm run runtime-target:check
npm run test:ontology
python3 -m pytest backend/tests -q
npm test -- --run
npm run build
npm run ontology:v2:qualify
```

Expected: Node prints `v24.14.0`; every command exits 0. Record observed test counts and durations from command output.

- [ ] **Step 3: Recheck protected hashes and source mutation**

```bash
git diff --exit-code -- server/duplicateBridgeRuntime.cjs scripts/duplicate_search_bridge.py
git status --short
shasum -a 256 \
  server/duplicateBridgeRuntime.cjs \
  scripts/duplicate_search_bridge.py \
  backend/database/ticket_embeddings.db
```

Expected: protected hashes match Step 1; no generated Runtime state or database is staged.

- [ ] **Step 4: Scan for release blockers**

```bash
rg -n -i 'TODO|TBD|placeholder|not implemented|governance"\\s*:\\s*\\{[^}]*"status"\\s*:\\s*"draft"' \
  ontology/v2 ontology/generated/v2 backend/analytics/semantic server/ontology scripts/qualifyOntologyV2.mjs
rg -n 'quality\\.qgate|query_traceability|ontology-semantic-v1' \
  ontology/v2 ontology/generated/v2 backend/analytics server/ontology server/agentRuntime server/mainAgentTools.mjs
```

Expected: no deployable draft, placeholder, `quality.qgate`, old public trace tool, or V1 default registration. Tests that assert rejection may contain those strings.

- [ ] **Step 5: Review all acceptance evidence**

Open the strict qualification JSON and manually map each result to specification acceptance criteria 1–20. Confirm:

- all five contexts and 54 governed metrics;
- eight products callable;
- one-snapshot dependent analysis;
- true records/cursor/drilldown;
- per-group compare semantics;
- governed traversal;
- module ambiguity;
- Python and Node scope/field enforcement;
- claim-before-render;
- explicit V1 aliases;
- shared page formulas;
- Duplicate Search zero diff;
- full test/build pass;
- protected database unchanged.

- [ ] **Step 6: Verify the qualification run left no uncommitted output**

```bash
git status --short
git diff --check
```

Expected: the worktree is clean; no database or local qualification artifact is staged.

## Final completion gate

The implementation is complete only when:

- `npm run ontology:v2:qualify` reports all 20 criteria passed;
- exact observed full Python, Node, and build commands pass under Node 24.14.0;
- page/report parity is proven against one snapshot;
- Agent product and dependent-query recovery is proven;
- V2 is default in Node and Python;
- no deployable definition is draft or physically faked;
- `backend/database/ticket_embeddings.db` and Duplicate Search internals retain their protected hashes.
