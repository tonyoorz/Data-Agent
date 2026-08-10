# Testing Quality Ontology V2 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile the approved five-context Ontology V2, bind it honestly to profiled source capabilities, and materialize immutable canonical defect, test, traceability, and organization/product snapshots.

**Architecture:** Keep governed business definitions in versioned JSON sources, compile them deterministically into a zero-draft V2 bundle, and load that bundle from both Node and Python. Keep physical source knowledge separate from business meaning: source profiling produces capability states, then atomic materializers create canonical SQLite read models and a snapshot manifest without mutating source databases.

**Tech Stack:** Node.js 24.14.0 ESM, Ajv 8.20.0, JSON Schema 2020-12, Python 3, SQLite, pytest, Vitest.

---

## Approved source and release boundaries

Implement against `docs/superpowers/specs/2026-07-20-testing-quality-ontology-v2-design.md`.

- `QGate` is an alias for the Defect Management bounded context only.
- `Octane` is a physical source, never a business entity or bounded context.
- The deployable bundle contains all five contexts and no draft business definitions.
- A dimension is executable only when its binding is materialized and profiled; otherwise capability compilation marks it `unavailable`.
- Source databases, including `backend/database/ticket_embeddings.db`, are read-only inputs and are never staged by this work.
- Full-value lifecycle normalization distinguishes values such as `09-In Progress`, `09-Rejected`, and `09-Concluded without action`.
- Resolved-forward (`08 -> 06`) and direct-rejection (`01 -> 09`) are event rules, not current-phase guesses.
- Duplicate Search storage, ranking, bridge, indexes, and UI remain unchanged.

## Program coverage map

| Specification work package | Implemented by |
|---|---|
| Package A: V2 schema, compiler, and release invariants | Foundation Tasks 1–6 and 10 |
| Package B: Canonical snapshots and physical profiles | Foundation Tasks 6–10 |
| Package C: Complete business catalog | Foundation Tasks 2–5 |
| Package D: Controlled query kernel | `2026-07-20-testing-quality-ontology-v2-semantic-kernel.md` Tasks 1–8 and 12 |
| Package E: Agent resolver and dependent planning | Semantic-kernel Tasks 9–12 |
| Package F: Quality Intelligence products | `2026-07-20-testing-quality-ontology-v2-products-cutover.md` Tasks 1–5 and 7 |
| Package G: Evidence, claims, compatibility, and cutover | Products/cutover Tasks 6 and 8–13 |

The three plans are executed in table order. Each plan has its own passing completion gate; the final gate additionally maps observed evidence to all 20 acceptance criteria.

## Execution preflight

- [ ] Run `git status --short` in the implementation worktree and verify it is clean.
- [ ] Run:

```bash
/Users/tonyorz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --version
```

Expected: `v24.14.0`.

- [ ] Export the bundled Node directory for every Node command in this plan:

```bash
export PATH="/Users/tonyorz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
```

- [ ] Run the focused baseline:

```bash
python3 -m pytest backend/tests/test_ontology_contract.py backend/tests/test_semantic_query_api.py -q
npm run test:ontology
```

Expected before V2 changes: Python reports `27 passed`; the current V1 Node/Python ontology contract passes.

## File responsibility map

| Path | Responsibility |
|---|---|
| `ontology/schema/v2/*.schema.json` | Strict V2 source contracts, formula AST, bindings, recipes, policies, and profiles |
| `ontology/v2/manifest.json` | Release identity, five bounded contexts, ownership, source document list |
| `ontology/v2/{sources,entities,relationships,dimensions,metrics}.json` | Complete approved business catalog |
| `ontology/v2/vocab.{zh-CN,en-US}.json` | Governed bilingual resolution terms |
| `ontology/v2/analysis-products.json` | Eight primitive-only analysis recipes |
| `ontology/v2/{policies,constraints}.json` | Scope, fields, traversal, limits, and release invariants |
| `ontology/v2/metric-decisions/*.json` | One checked-in owner decision and test-vector set per metric |
| `ontology/v2/context-packs/*.json` | Bounded resolver context selected by intent/domain |
| `scripts/compileOntologyV2.mjs` | Deterministic compile, cross-reference checks, capability report, migration map |
| `scripts/profileOntologySources.mjs` | Read-only source schema and field capability inspection |
| `ontology/generated/v2/*` | Generated compiled bundle, fingerprint, profile, report, and V1 migration |
| `backend/analytics/semantic/catalog.py` | Trusted Python V2 loader and catalog lookups |
| `backend/analytics/semantic/snapshot_manifest.py` | Immutable snapshot and source-revision-set contract |
| `backend/analytics/semantic/materialize_*.py` | Atomic canonical fact, event, edge, and context materialization |
| `backend/analytics/schema.py` | Canonical semantic SQLite tables and indexes |

### Task 1: Establish the V2 manifest and strict compiler shell

**Files:**
- Create: `ontology/schema/v2/common.schema.json`
- Create: `ontology/schema/v2/manifest.schema.json`
- Create: `ontology/v2/manifest.json`
- Create: `scripts/compileOntologyV2.mjs`
- Create: `src/test/server/ontology/v2Compiler.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing compiler contract**

Create `src/test/server/ontology/v2Compiler.test.ts` with this release-level test:

```ts
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { compileOntologyV2 } from "../../../../scripts/compileOntologyV2.mjs";

const expectedContexts = [
  "defect_management",
  "test_management",
  "traceability",
  "quality_intelligence",
  "organization_product_context",
];

describe("Ontology V2 compiler", () => {
  it("loads one complete five-context release and fingerprints it deterministically", () => {
    const first = compileOntologyV2({ check: false });
    const second = compileOntologyV2({ check: true });
    expect(first.bundle.schemaVersion).toBe("2.0");
    expect(first.bundle.ontologyVersion).toBe("v2");
    expect(first.bundle.manifest.boundedContexts.map((item: { id: string }) => item.id)).toEqual(expectedContexts);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(fs.readFileSync("ontology/generated/v2/fingerprint.txt", "utf8").trim()).toBe(first.fingerprint);
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npm test -- src/test/server/ontology/v2Compiler.test.ts
```

Expected: FAIL because `scripts/compileOntologyV2.mjs` does not exist.

- [ ] **Step 3: Create the manifest contract**

`common.schema.json` must define reusable `$defs` for `id`, bilingual `labels`, `governance`, `binding`, `typedReference`, and `formulaNode`. Every object schema uses `additionalProperties: false`.

`manifest.schema.json` must require:

```json
{
  "schemaVersion": "2.0",
  "ontologyVersion": "v2",
  "releaseStatus": "approved",
  "boundedContexts": [],
  "documents": [],
  "owners": [],
  "compatibility": {"previousVersion": "v1", "migrationFile": "id-migration-v1.json"}
}
```

`ontology/v2/manifest.json` must list the five context IDs in the test order and assign an owner to each. Its document list initially contains only `manifest.json`; each subsequent catalog task adds its newly created documents, and Task 5 asserts the final required document set.

- [ ] **Step 4: Implement deterministic compilation**

Export `compileOntologyV2({ root, sourceDir, schemaDir, outputDir, check, physicalProfilePath })`. It must:

1. validate every document against its declared schema;
2. canonicalize object keys and sort every catalog collection by stable `id`;
3. run cross-reference and release-invariant validation;
4. include SHA-256 source-file hashes and compiler version `ontology-compiler-v2`;
5. write atomically to `ontology/generated/v2`;
6. recompute the fingerprint from the entire compiled JSON;
7. reject stale or missing generated output under `--check`;
8. expose a CLI with the same override flags as `compileOntology.mjs`.

Add scripts:

```json
{
  "ontology:v2:compile": "node scripts/compileOntologyV2.mjs",
  "ontology:v2:check": "node scripts/compileOntologyV2.mjs --check",
  "ontology:v2:profile": "node scripts/profileOntologySources.mjs"
}
```

- [ ] **Step 5: Run GREEN**

```bash
npm test -- src/test/server/ontology/v2Compiler.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json ontology/schema/v2/common.schema.json ontology/schema/v2/manifest.schema.json ontology/v2/manifest.json scripts/compileOntologyV2.mjs src/test/server/ontology/v2Compiler.test.ts
git commit -m "feat(ontology): establish v2 compiler manifest"
```

### Task 2: Compile the complete entity and relationship graph

**Files:**
- Create: `ontology/schema/v2/entities.schema.json`
- Create: `ontology/schema/v2/relationships.schema.json`
- Create: `ontology/v2/entities.json`
- Create: `ontology/v2/relationships.json`
- Create: `src/test/server/ontology/v2GraphContract.test.ts`
- Modify: `scripts/compileOntologyV2.mjs`
- Modify: `ontology/v2/manifest.json`

- [ ] **Step 1: Write the graph inventory test**

The test must assert exact identity sets. Define these arrays in the test:

```ts
const entities = [
  "defect.defect", "defect.lifecycle_event", "defect.comment",
  "testing.test_case", "testing.test_run",
  "requirements.aida_node", "requirements.epic", "requirements.feature", "requirements.story", "traceability.link",
  "quality_intelligence.analysis_product", "quality_intelligence.report_run", "quality_intelligence.insight",
  "quality_intelligence.risk_signal", "evidence.artifact",
  "organization.team", "organization.person", "product.project", "product.release", "product.service_pack",
  "product.pu", "product.i_step", "product.os", "product.platform", "product.ecu",
  "product.solution_cluster", "product.defect_category", "product.feature_region", "product.fv", "product.fvp",
  "vehicle.model_series", "market.market",
];
```

Define the 41 relationship IDs exactly as listed in specification Sections 5.1–5.5. Assert:

```ts
expect(bundle.entities.map(({ id }) => id)).toEqual([...entities].sort());
expect(bundle.relationships.map(({ id }) => id)).toEqual([...relationships].sort());
expect(bundle.entities.every((item) => item.governance.status === "approved")).toBe(true);
expect(bundle.relationships.every((item) => item.governance.status === "approved")).toBe(true);
expect(bundle.entities.some((item) => item.id === "quality.qgate")).toBe(false);
```

- [ ] **Step 2: Run RED**

```bash
npm test -- src/test/server/ontology/v2GraphContract.test.ts
```

Expected: FAIL because the documents and schemas are absent.

- [ ] **Step 3: Implement the graph sources**

Every entity must declare its bounded context, canonical identity fields, source binding, owner, sensitivity, definition version, and approved governance. Every relationship must declare source/target IDs, direction, reversibility, cardinality, typed join keys, allowed join paths, explosion policy, validity fields, source revision field, scope propagation, and grain protection.

The compiler must reject:

- duplicate IDs;
- unknown context, source, entity, or relationship references;
- many-to-many traversal without an explicit explosion policy;
- a relationship whose join fields do not exist in both endpoint bindings;
- `quality.qgate`;
- any governance status other than `approved`.

- [ ] **Step 4: Verify graph compilation**

```bash
npm run ontology:v2:compile
npm test -- src/test/server/ontology/v2GraphContract.test.ts
```

Expected: both commands pass and the compiled bundle contains exactly 32 entities and 41 relationships.

- [ ] **Step 5: Commit**

```bash
git add ontology/schema/v2/entities.schema.json ontology/schema/v2/relationships.schema.json ontology/v2/entities.json ontology/v2/relationships.json ontology/v2/manifest.json scripts/compileOntologyV2.mjs src/test/server/ontology/v2GraphContract.test.ts ontology/generated/v2
git commit -m "feat(ontology): compile complete testing domain graph"
```

### Task 3: Add executable dimensions and bilingual vocabulary

**Files:**
- Create: `ontology/schema/v2/dimensions.schema.json`
- Create: `ontology/schema/v2/vocab.schema.json`
- Create: `ontology/v2/dimensions.json`
- Create: `ontology/v2/vocab.zh-CN.json`
- Create: `ontology/v2/vocab.en-US.json`
- Create: `src/test/server/ontology/v2Dimensions.test.ts`
- Modify: `scripts/compileOntologyV2.mjs`
- Modify: `ontology/v2/manifest.json`

- [ ] **Step 1: Write failing dimension and terminology tests**

Assert all IDs from specification Sections 6.2–6.4 plus the virtual `product.business_module`. Also assert:

```ts
expect(registry.resolveTerm("QGate")).toMatchObject({
  kind: "bounded_context",
  targetId: "defect_management",
});
expect(registry.resolveTerm("Octane")).toMatchObject({
  kind: "source",
  targetId: "source.octane",
});
expect(registry.resolveTerm("模块").candidateIds).toEqual([
  "product.solution_cluster",
  "product.defect_category",
  "product.feature_region",
  "requirements.aida",
  "product.ecu",
]);
expect(registry.resolveTerm("ECU 模块").targetId).toBe("product.ecu");
```

The catalog test must verify no dimension uses `missingValuePolicy: "coerce_to_label"` and that every dimension has an `availabilityRule`.

- [ ] **Step 2: Run RED**

```bash
npm test -- src/test/server/ontology/v2Dimensions.test.ts
```

Expected: FAIL because V2 dimensions and vocabulary are absent.

- [ ] **Step 3: Implement strict dimension bindings**

Each dimension declares `entityId`, `propertyId`, `valueType`, optional closed enum, canonical read model, source field, availability rule, operators, missing-value policy, sensitivity, owner, definition version, and approved governance.

Implement full-value mappings for `defect.phase`, the six result buckets for `testing.result_bucket`, and the five link states for `traceability.link_status`. Define:

```json
{
  "id": "product.business_module",
  "kind": "virtual",
  "expression": {
    "type": "first_non_blank",
    "dimensionIds": ["product.solution_cluster", "product.defect_category"],
    "fallback": "UNCLASSIFIED"
  },
  "displayLabel": "Business Module",
  "forbiddenDisplayLabels": ["ECU", "ECU Module"]
}
```

- [ ] **Step 4: Implement deterministic term resolution**

Vocabulary entries must be locale-specific and resolve only to catalog IDs. Include every core term in Section 6.7. Ambiguous terms carry ordered `candidateIds`; explicit ECU phrases resolve directly.

- [ ] **Step 5: Verify**

```bash
npm run ontology:v2:compile
npm test -- src/test/server/ontology/v2Dimensions.test.ts
```

Expected: PASS with all required dimensions approved; unresolved physical bindings remain a capability state, not a fake `(missing)` group.

- [ ] **Step 6: Commit**

```bash
git add ontology/schema/v2/dimensions.schema.json ontology/schema/v2/vocab.schema.json ontology/v2/dimensions.json ontology/v2/vocab.zh-CN.json ontology/v2/vocab.en-US.json ontology/v2/manifest.json scripts/compileOntologyV2.mjs src/test/server/ontology/v2Dimensions.test.ts ontology/generated/v2
git commit -m "feat(ontology): govern dimensions and bilingual terms"
```

### Task 4: Compile every governed metric and decision record

**Files:**
- Create: `ontology/schema/v2/metrics.schema.json`
- Create: `ontology/v2/metrics.json`
- Create: `ontology/v2/metric-decisions/*.json`
- Create: `src/test/server/ontology/v2Metrics.test.ts`
- Modify: `scripts/compileOntologyV2.mjs`
- Modify: `ontology/v2/manifest.json`

- [ ] **Step 1: Write the failing metric inventory test**

Define the exact 54 metric IDs from specification Sections 7.2–7.5 and assert:

```ts
expect(bundle.metrics.map(({ id }) => id)).toEqual([...expectedMetricIds].sort());
for (const metric of bundle.metrics) {
  expect(metric.governance.status).toBe("approved");
  expect(metric.definitionVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(metric.formula).toBeTypeOf("object");
  expect(metric.owner).toBeTruthy();
  expect(metric.testVectors.length).toBeGreaterThan(0);
  expect(metric.sourceReadModels.length).toBeGreaterThan(0);
}
expect(bundle.metrics.some(({ id }) => [
  "defect.repeat_rate", "team.discovery_efficiency", "quality.defect_density",
].includes(id))).toBe(false);
```

Add negative fixtures for SQL text, unknown `metric_ref`, invalid ratio zero policy, missing owner, and absent test vectors.

- [ ] **Step 2: Run RED**

```bash
npm test -- src/test/server/ontology/v2Metrics.test.ts
```

Expected: FAIL because the V2 metric catalog is absent.

- [ ] **Step 3: Implement the formula AST schema and validator**

Allow only:

```text
count_distinct
conditional_count_distinct
sum
min
max
average
percentile
ratio
difference
duration_calendar_days
duration_business_hours
predicate
metric_ref
```

The compiler must type-check formula inputs, resolve metric and dimension references, reject cycles, require synchronized revisions for cross-source ratios, validate denominator zero policies, and reject any property named `sql`, `query`, or `expressionText`.

- [ ] **Step 4: Populate the complete approved catalog**

Encode every definition from Sections 7.2–7.5, including:

- event-based defect terminal and rejection metrics;
- active age at `snapshotAsOf`;
- 30-day and 60-day long-runner thresholds;
- pass/fail denominators limited to passed plus failed;
- testcase execution coverage with matching project/release scope;
- requirement coverage only with a materialized requirement population;
- cross-source synchronization for `quality.defects_per_100_completed_runs`;
- exact aliases from Section 7.6 in the migration document, not duplicate formulas.

Create one decision record per metric. Each record contains metric ID, owner, decision date, population, denominator, zero policy, effective date, source bindings, test vectors, and approval.

- [ ] **Step 5: Verify**

```bash
npm run ontology:v2:compile
npm test -- src/test/server/ontology/v2Metrics.test.ts
```

Expected: PASS; the compiler reports 54 approved metrics and zero draft definitions.

- [ ] **Step 6: Commit**

```bash
git add ontology/schema/v2/metrics.schema.json ontology/v2/metrics.json ontology/v2/metric-decisions ontology/v2/manifest.json scripts/compileOntologyV2.mjs src/test/server/ontology/v2Metrics.test.ts ontology/generated/v2
git commit -m "feat(ontology): compile governed metric catalog"
```

### Task 5: Compile policies, constraints, context packs, and analysis products

**Files:**
- Create: `ontology/schema/v2/policies.schema.json`
- Create: `ontology/schema/v2/constraints.schema.json`
- Create: `ontology/schema/v2/context-pack.schema.json`
- Create: `ontology/schema/v2/analysis-products.schema.json`
- Create: `ontology/v2/policies.json`
- Create: `ontology/v2/constraints.json`
- Create: `ontology/v2/context-packs/*.json`
- Create: `ontology/v2/analysis-products.json`
- Create: `src/test/server/ontology/v2ReleaseInvariant.test.ts`
- Modify: `scripts/compileOntologyV2.mjs`
- Modify: `ontology/v2/manifest.json`

- [ ] **Step 1: Write release-invariant tests**

Assert the eight product IDs from Section 8.1 and context packs for defect management, test management, traceability, quality intelligence, organization/product context, coverage ambiguity, module ambiguity, and source-health interpretation.

For every product assert that each step uses only:

```ts
[
  "query_semantic_metrics",
  "query_semantic_records",
  "query_semantic_traverse",
  "lookup_ontology_concepts",
]
```

Reject page endpoint names, arbitrary URLs, SQL, writes, undefined metric/dimension/product references, excessive traversal limits, and any definition whose status is not `approved`.

- [ ] **Step 2: Run RED**

```bash
npm test -- src/test/server/ontology/v2ReleaseInvariant.test.ts
```

Expected: FAIL because release-governance documents are absent.

- [ ] **Step 3: Implement governance sources**

Policies must cover workspace/project/release/team row scope, object and field access, confidential identities, comment/attachment content, result limits, traversal limits, artifact retention, and read-only enforcement.

Constraints must include:

```text
query.max_groups
query.max_records
query.max_page_size
query.max_traversal_depth
query.max_edges
query.cursor_ttl_seconds
analysis.max_steps
analysis.max_top_issue_records
release.zero_draft
release.require_physical_capability
```

Context packs contain only referenced catalog fragments, owner, intent/domain selectors, max tokens, and version. Analysis products encode the exact dependencies and outputs in Section 8; the weekly report uses one shared snapshot and eight required sections.

- [ ] **Step 4: Verify**

```bash
npm run ontology:v2:compile
npm test -- src/test/server/ontology/v2ReleaseInvariant.test.ts
```

Expected: PASS and zero release-invariant violations.

- [ ] **Step 5: Commit**

```bash
git add ontology/schema/v2/policies.schema.json ontology/schema/v2/constraints.schema.json ontology/schema/v2/context-pack.schema.json ontology/schema/v2/analysis-products.schema.json ontology/v2/policies.json ontology/v2/constraints.json ontology/v2/context-packs ontology/v2/analysis-products.json ontology/v2/manifest.json scripts/compileOntologyV2.mjs src/test/server/ontology/v2ReleaseInvariant.test.ts ontology/generated/v2
git commit -m "feat(ontology): govern v2 analysis products and policies"
```

### Task 6: Profile sources and compile honest capability states

**Files:**
- Create: `ontology/schema/v2/sources.schema.json`
- Create: `ontology/schema/v2/physical-profile.schema.json`
- Create: `ontology/v2/sources.json`
- Create: `scripts/profileOntologySources.mjs`
- Create: `src/test/server/ontology/v2PhysicalProfile.test.ts`
- Create: `backend/tests/test_semantic_physical_profile.py`
- Modify: `scripts/compileOntologyV2.mjs`

- [ ] **Step 1: Write failing profile tests**

Use temporary SQLite fixtures. Assert:

```ts
expect(profile.bindings["product.solution_cluster"].state).toBe("available");
expect(profile.bindings["product.service_pack"].state).toBe("unavailable");
expect(profile.bindings["product.service_pack"].reasonCode).toBe("SOURCE_FIELD_ABSENT");
expect(profile.bindings["product.service_pack"].nonBlankCoverage).toBeNull();
```

Also assert that profiling opens each database read-only, records schema hash, row count, distinct count, null/blank counts, observed type, sample-safe enum values, and watermark without changing the file hash.

- [ ] **Step 2: Run RED**

```bash
npm test -- src/test/server/ontology/v2PhysicalProfile.test.ts
python3 -m pytest backend/tests/test_semantic_physical_profile.py -q
```

Expected: FAIL because the profiler and profile reader do not exist.

- [ ] **Step 3: Implement read-only profiling**

`profileOntologySources.mjs` accepts explicit source paths and an output path. It must use SQLite URI read-only mode, reject paths outside configured source roots, never attach writable databases, calculate a pre/post SHA-256, and fail if any input changes.

Capability states are exactly:

```text
available
partial
unavailable
incompatible
stale
```

The compiler joins declared dimension/metric bindings to the profile and emits `capability-report.json`. It must reject an approved metric with no executable provider, while allowing a dimension to remain cataloged with `unavailable` and an explicit reason.

- [ ] **Step 4: Generate the checked-in development profile**

```bash
npm run ontology:v2:profile
npm run ontology:v2:compile
```

Expected: `ontology/generated/v2/physical-profile.json` and `capability-report.json` are schema-valid; unavailable fields are listed explicitly and never represented as valid `(missing)` dimensions.

- [ ] **Step 5: Commit**

```bash
git add ontology/schema/v2/sources.schema.json ontology/schema/v2/physical-profile.schema.json ontology/v2/sources.json scripts/profileOntologySources.mjs scripts/compileOntologyV2.mjs src/test/server/ontology/v2PhysicalProfile.test.ts backend/tests/test_semantic_physical_profile.py ontology/generated/v2
git commit -m "feat(ontology): compile physical source capabilities"
```

### Task 7: Load V2 and create immutable snapshot manifests

**Files:**
- Create: `backend/analytics/semantic/__init__.py`
- Create: `backend/analytics/semantic/catalog.py`
- Create: `backend/analytics/semantic/snapshot_manifest.py`
- Create: `backend/tests/test_semantic_catalog_v2.py`
- Create: `backend/tests/test_semantic_snapshot_manifest.py`
- Modify: `backend/analytics/ontology.py`

- [ ] **Step 1: Write failing loader and snapshot tests**

Tests must prove:

- V2 is loadable with a matching declared fingerprint;
- tampering fails closed;
- V1 accepted IDs resolve through `id-migration-v1.json`;
- `quality.qgate` is rejected;
- a manifest ID is deterministic from sorted source revisions;
- source revisions are immutable;
- a partial refresh cannot replace the active manifest;
- every analysis step using a supplied `snapshotRef` sees the same `sourceRevisionSet`.

Use this canonical manifest shape:

```python
{
    "schemaVersion": "2.0",
    "snapshotRef": "snapshot:1111111111111111111111111111111111111111111111111111111111111111",
    "createdAt": "2026-07-20T00:00:00Z",
    "asOf": "2026-07-20T00:00:00Z",
    "status": "ready",
    "ontologyVersion": "v2",
    "schemaFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sourceRevisionSet": {
        "source.octane.defects": {
            "revisionId": "defects-1",
            "schemaHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "watermark": "2026-07-20T00:00:00Z",
            "completeness": "complete"
        }
    }
}
```

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_catalog_v2.py backend/tests/test_semantic_snapshot_manifest.py -q
```

Expected: FAIL because the semantic package is absent.

- [ ] **Step 3: Implement the trusted loader and manifest store**

`catalog.py` verifies version `v2`, fingerprint, source hashes, release status, zero-draft invariant, capability report fingerprint, and migration aliases. `snapshot_manifest.py` writes a new manifest and all canonical tables in one transaction, then atomically advances a single active pointer. Existing ready manifests are never mutated.

- [ ] **Step 4: Verify**

```bash
python3 -m pytest backend/tests/test_semantic_catalog_v2.py backend/tests/test_semantic_snapshot_manifest.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/analytics/semantic backend/analytics/ontology.py backend/tests/test_semantic_catalog_v2.py backend/tests/test_semantic_snapshot_manifest.py
git commit -m "feat(analytics): load v2 catalog and pin snapshots"
```

### Task 8: Materialize canonical defect facts and lifecycle events

**Files:**
- Create: `backend/analytics/semantic/materialize_defects.py`
- Create: `backend/tests/test_semantic_materialize_defects.py`
- Modify: `backend/analytics/schema.py`

- [ ] **Step 1: Write fixture-driven RED tests**

Cover:

- source identity deduplication;
- complete raw/canonical phase values;
- `09-In Progress`, `09-Rejected`, and `09-Concluded without action`;
- ordered lifecycle events;
- exact `08 -> 06` resolved-forward flag;
- exact `01 -> 09` direct-rejection flag;
- terminal-to-nonterminal reopen;
- current active status;
- age at snapshot, not wall-clock now;
- solution cluster, defect category, ECU, AIDA, project, release, team, owner;
- null, unknown, unavailable, and raw-value preservation;
- source DB SHA-256 unchanged after materialization.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest backend/tests/test_semantic_materialize_defects.py -q
```

Expected: FAIL because canonical tables and materializer are absent.

- [ ] **Step 3: Add canonical tables**

Create versioned tables `semantic_snapshot_manifest`, `semantic_source_revisions`, `semantic_defect_facts`, and `semantic_defect_events`. Every fact/event key includes `snapshot_ref`; indexes cover entity key, external ID, event time, project/release, team, phase, severity, business-module source fields, and snapshot.

- [ ] **Step 4: Implement normalization and atomic writes**

Use pure functions for full-value phase normalization and transition derivation. Store rule version with every derived flag. Read source SQLite connections in query-only/read-only mode; write only to the configured semantic database transaction.

- [ ] **Step 5: Verify**

```bash
python3 -m pytest backend/tests/test_semantic_materialize_defects.py backend/tests/test_analytics_outcomes.py -q
```

Expected: PASS and existing outcome behavior remains reconciled.

- [ ] **Step 6: Commit**

```bash
git add backend/analytics/schema.py backend/analytics/semantic/materialize_defects.py backend/tests/test_semantic_materialize_defects.py
git commit -m "feat(analytics): materialize canonical defect snapshots"
```

### Task 9: Materialize tests, traceability edges, and context nodes

**Files:**
- Create: `backend/analytics/semantic/materialize_tests.py`
- Create: `backend/analytics/semantic/materialize_traceability.py`
- Create: `backend/analytics/semantic/materialize_context.py`
- Create: `backend/tests/test_semantic_materialize_tests.py`
- Create: `backend/tests/test_semantic_materialize_traceability.py`
- Create: `backend/tests/test_semantic_materialize_context.py`
- Modify: `backend/analytics/schema.py`

- [ ] **Step 1: Write fixture-driven RED tests**

Tests must cover:

- testcase and manual-run identity;
- full-value run result normalization;
- valid and invalid duration;
- tester confidentiality markers;
- project/release/AIDA/FV/FVP bindings;
- valid, broken-source, broken-target, duplicate, and unknown trace links;
- explicit relationship ID and direction;
- requirement hierarchy nodes;
- organization/product node deduplication;
- relation-only sources marked unable to provide a requirement denominator;
- source file hashes unchanged.

- [ ] **Step 2: Run RED**

```bash
python3 -m pytest \
  backend/tests/test_semantic_materialize_tests.py \
  backend/tests/test_semantic_materialize_traceability.py \
  backend/tests/test_semantic_materialize_context.py -q
```

Expected: FAIL because the tables and materializers are absent.

- [ ] **Step 3: Add canonical tables and indexes**

Add `semantic_testcase_facts`, `semantic_testrun_facts`, `semantic_trace_edges`, and `semantic_context_nodes`. Use composite primary keys with `snapshot_ref`; preserve raw values and data-quality state; index endpoint keys and allowed traversal paths.

- [ ] **Step 4: Implement all three materializers**

Each materializer accepts a trusted catalog, explicit source adapters, a pending manifest, and one destination connection. It returns counts and quality diagnostics. The orchestrator promotes the snapshot only after every required materializer succeeds.

- [ ] **Step 5: Verify**

```bash
python3 -m pytest \
  backend/tests/test_semantic_materialize_tests.py \
  backend/tests/test_semantic_materialize_traceability.py \
  backend/tests/test_semantic_materialize_context.py \
  backend/tests/test_analytics_testing_api.py \
  backend/tests/test_traceability_analysis.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/analytics/schema.py backend/analytics/semantic/materialize_tests.py backend/analytics/semantic/materialize_traceability.py backend/analytics/semantic/materialize_context.py backend/tests/test_semantic_materialize_tests.py backend/tests/test_semantic_materialize_traceability.py backend/tests/test_semantic_materialize_context.py
git commit -m "feat(analytics): materialize test trace and context snapshots"
```

### Task 10: Add foundation qualification and deterministic generation checks

**Files:**
- Create: `backend/tests/test_semantic_foundation_acceptance.py`
- Modify: `src/test/server/ontology/v2Compiler.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add acceptance assertions**

The tests must reconcile all catalog counts, every source hash, every generated file, all five contexts, every canonical table, snapshot immutability, zero drafts, no `quality.qgate`, explicit unavailable bindings, and no source-file mutation.

- [ ] **Step 2: Run focused qualification**

```bash
npm run ontology:v2:compile
npm run ontology:v2:check
npm test -- \
  src/test/server/ontology/v2Compiler.test.ts \
  src/test/server/ontology/v2GraphContract.test.ts \
  src/test/server/ontology/v2Dimensions.test.ts \
  src/test/server/ontology/v2Metrics.test.ts \
  src/test/server/ontology/v2ReleaseInvariant.test.ts \
  src/test/server/ontology/v2PhysicalProfile.test.ts
python3 -m pytest \
  backend/tests/test_semantic_catalog_v2.py \
  backend/tests/test_semantic_snapshot_manifest.py \
  backend/tests/test_semantic_materialize_defects.py \
  backend/tests/test_semantic_materialize_tests.py \
  backend/tests/test_semantic_materialize_traceability.py \
  backend/tests/test_semantic_materialize_context.py \
  backend/tests/test_semantic_foundation_acceptance.py -q
```

Expected: all commands exit 0.

- [ ] **Step 3: Prove deterministic output**

```bash
before="$(shasum -a 256 ontology/generated/v2/ontology.compiled.json ontology/generated/v2/fingerprint.txt ontology/generated/v2/capability-report.json)"
npm run ontology:v2:compile
after="$(shasum -a 256 ontology/generated/v2/ontology.compiled.json ontology/generated/v2/fingerprint.txt ontology/generated/v2/capability-report.json)"
test "$before" = "$after"
git status --short
```

Expected: hash comparison exits 0; `git status` contains only the intended foundation files and never `backend/database/ticket_embeddings.db`.

- [ ] **Step 4: Scan for incomplete release markers**

```bash
rg -n -i 'TODO|TBD|placeholder|not implemented|draft' \
  ontology/schema/v2 ontology/v2 scripts/compileOntologyV2.mjs scripts/profileOntologySources.mjs \
  backend/analytics/semantic backend/tests/test_semantic_ src/test/server/ontology
```

Expected: no incomplete implementation marker; legitimate test assertions about rejecting `draft` may remain.

- [ ] **Step 5: Commit**

```bash
git add package.json backend/tests/test_semantic_foundation_acceptance.py src/test/server/ontology/v2Compiler.test.ts ontology/generated/v2
git commit -m "test(ontology): qualify v2 semantic foundation"
```

## Foundation completion gate

Do not begin the semantic-kernel plan until:

- every required business definition compiles as approved;
- the physical profile distinguishes available, partial, unavailable, incompatible, and stale;
- every approved metric has an executable provider;
- all canonical tables are populated under one immutable snapshot manifest;
- no source database hash changes;
- V2 generation is deterministic under Node 24.14.0.
