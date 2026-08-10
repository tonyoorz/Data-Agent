# Ontology Candidate Schema Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the ontology catalog exposed to the semantic-candidate model while preserving the governed resolver as the final authority.

**Architecture:** `semanticCandidate.mjs` will derive a deterministic compact catalog from `registry.matchTerms(query)`, then expand only through matched metrics, their allowed dimensions, and matching ontology terms. `aiAnalyticsContext.mjs` will construct that catalog once and supply it to both the candidate JSON schema and the candidate prompt so the model cannot nominate unrelated IDs. Queries with no usable ontology term retain the current full-catalog behavior.

**Tech Stack:** Node.js ESM, AJV 2020, Vitest, existing compiled ontology registry.

---

### Task 1: Define the Compact Catalog Contract

**Files:**
- Create: `src/test/server/ontology/semanticCandidate.test.ts`
- Modify: `server/ontology/semanticCandidate.mjs`

- [x] **Step 1: Write the failing test**

```ts
it("prunes a matched metric query to its governed metric, dimensions, entities, and terms", () => {
  const catalog = createSemanticCandidateCatalog({
    registry,
    query: "最近一周 DTSV 新增缺陷按 ECU Top 5",
  });

  expect(catalog.selection).toMatchObject({ mode: "matched_terms" });
  expect(catalog.metrics.map((item) => item.id)).toEqual(["defect.created_count"]);
  expect(catalog.dimensions.map((item) => item.id)).toContain("product.ecu");
  expect(catalog.entities.map((item) => item.id)).toEqual(["quality.defect"]);
  expect(catalog.vocabulary.map((item) => item.id)).toEqual(expect.arrayContaining([
    "metric.created_defects",
    "dimension.ecu",
    "team.dtsv",
  ]));
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/test/server/ontology/semanticCandidate.test.ts`

Expected: FAIL because `createSemanticCandidateCatalog` is not exported.

- [x] **Step 3: Implement the minimal catalog selector**

```js
export function createSemanticCandidateCatalog({ registry, query } = {}) {
  const matchedTerms = registry.matchTerms(query);
  // Derive metric, dimension, entity, and vocabulary IDs only from governed matches.
  // Return the complete catalog when no usable IDs were resolved.
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/test/server/ontology/semanticCandidate.test.ts`

Expected: PASS.

### Task 2: Bind the Prompt and Candidate Schema to One Catalog

**Files:**
- Modify: `server/ontology/semanticCandidate.mjs`
- Modify: `server/aiAnalyticsContext.mjs`
- Test: `src/test/server/ontology/semanticCandidate.test.ts`

- [x] **Step 1: Add a failing schema-boundary assertion**

```ts
const schema = createSemanticCandidateSchema(registry, catalog);
expect(() => parseSemanticCandidate(JSON.stringify({
  intent: "aggregate",
  metricIds: ["testing.run_count"],
  dimensionIds: [],
  entityIds: ["testing.test_run"],
}), schema)).toThrow("SEMANTIC_CANDIDATE_INVALID");
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/test/server/ontology/semanticCandidate.test.ts`

Expected: FAIL because the existing schema admits all ontology IDs.

- [x] **Step 3: Reuse the selected catalog in production**

```js
const catalog = createSemanticCandidateCatalog({ registry, query });
const schema = createSemanticCandidateSchema(registry, catalog);
const messages = createSemanticCandidateMessages({ registry, query, priorSemanticContext, catalog });
```

- [x] **Step 4: Add and verify unmatched-query fallback**

```ts
expect(createSemanticCandidateCatalog({ registry, query: "各楼层工位利用率" }).selection.mode)
  .toBe("full_catalog");
```

Run: `npm test -- src/test/server/ontology/semanticCandidate.test.ts`

Expected: PASS.

### Task 3: Verify the Ontology Slice

**Files:**
- Modify: `server/ontology/semanticCandidate.mjs`
- Modify: `server/aiAnalyticsContext.mjs`
- Create: `src/test/server/ontology/semanticCandidate.test.ts`

- [x] **Step 1: Run focused semantic tests**

Run: `npm test -- src/test/server/ontology/semanticCandidate.test.ts src/test/server/ontology/semanticResolver.test.ts src/test/server/ontology/queryPlanner.test.ts src/test/server/aiAnalyticsContext.test.ts`

Expected: PASS with no failures.

- [x] **Step 2: Run syntax and whitespace checks**

Run: `node --check server/ontology/semanticCandidate.mjs; node --check server/aiAnalyticsContext.mjs; git diff --check -- server/ontology/semanticCandidate.mjs server/aiAnalyticsContext.mjs src/test/server/ontology/semanticCandidate.test.ts`

Expected: exit code `0`.

### Task 4: Review Follow-Up

**Files:**
- Modify: `server/ontology/semanticCandidate.mjs`
- Modify: `src/test/server/ontology/semanticCandidate.test.ts`

- [x] **Step 1: Add a failing legacy-metric regression test**

Verify that a selector registry with a metric missing `allowedDimensions` does not throw while selecting a dimension.

- [x] **Step 2: Default missing allowed dimensions to an empty list**

Use `metric.allowedDimensions || []` in both metric-inference and selected-metric expansion paths.

- [x] **Step 3: Cover inference and nonstructural-term fallback**

Verify a dimension-only ECU query infers compatible defect metrics, and a time-only query returns the full catalog with the matched term recorded.

- [x] **Step 4: Re-run focused ontology and AI-context regression tests**

Run: `npm test -- src/test/server/ontology/semanticCandidate.test.ts src/test/server/ontology/semanticResolver.test.ts src/test/server/ontology/queryPlanner.test.ts src/test/server/aiAnalyticsContext.test.ts`

Expected: PASS.

**Note:** No commit is included because the user did not request one and the current feature branch contains pre-existing uncommitted work.