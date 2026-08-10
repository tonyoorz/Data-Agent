# TAP Testing Coverage Migration Design

## Goal

Migrate the existing `Defect Explore -> Testing Coverage Analysis` experience into Vizion Lab's `TAP` page while preserving the current Vizion Lab frontend visual language.

This migration is limited to:

1. the testing coverage filter bar;
2. the three core test-execution analysis charts;
3. the backend data contract needed to drive those charts reliably.

This migration must not depend on a working live Octane download path for the initial implementation. The first implementation phase may use already stored local analytics data or explicit local seed data.

## Confirmed Scope

### In scope

1. Replace the mock content in the current `TAP` page with a real testing coverage analysis page.
2. Preserve the current Vizion Lab page shell, card styling, spacing rhythm, typography, and chart-family direction.
3. Migrate the existing Defect Explore filter semantics for the testing coverage analysis slice.
4. Migrate the three core charts from the existing TPMDashboard testing coverage analysis.
5. Add backend analytics endpoints dedicated to the TAP testing coverage page.
6. Validate backend data completeness against the fields required by those three charts.

### Explicitly out of scope

1. Migrating the extra KPI strip from the broader TPMDashboard testing analysis.
2. Migrating the status pie, pass-rate trend, wordcloud, or export actions.
3. Rebuilding the entire TPMDashboard testing workspace inside Vizion Lab.
4. Solving current Octane downloader issues as part of this migration.
5. Changing the Main Dashboard behavior or payload.
6. Merging analytics work with the AI chat backend.

## Source Anchors

### Vizion Lab anchors

1. `src/pages/Index.tsx`
2. `src/components/dashboard/pages/CoverageAnalysis.tsx`
3. `vite.config.ts`
4. `backend/analytics/api.py`
5. `backend/analytics/read_models.py`
6. `backend/analytics/schema.py`

### TPMDashboard reference anchors

1. `C:/Users/q446328/Desktop/TPMDashbaord/test_coverage.py`
2. `C:/Users/q446328/Desktop/TPMDashbaord/test_coverage_components.py`
3. `C:/Users/q446328/Desktop/TPMDashbaord/test_coverage_callbacks.py`
4. `C:/Users/q446328/Desktop/TPMDashbaord/data_processor.py`
5. `C:/Users/q446328/Desktop/TPMDashbaord/octane_db.py`

## Existing Reference Behavior

The TPMDashboard testing coverage analysis currently centers on three charts and a shared filter model.

### Core filters in the reference flow

The existing page uses these testing-oriented filters:

1. `year`
2. `project`
3. `test_week`
4. `pu`
5. `top_aida`
6. `status`
7. `feature_region`
8. `fvp`
9. `fv`

### Core charts in the reference flow

The existing testing coverage page uses these three core views:

1. `test_week × fv × status`
2. `test_week × top_aida × status`
3. `testcase × test_week × status`

The original Dash implementation also supports click-to-filter behavior from chart interactions. That interaction pattern should be preserved where it still fits the React page model.

## Design Decisions

1. Keep the Vizion Lab `TAP` page as the destination surface instead of creating a new route.
2. Rebuild the testing coverage experience as native React components instead of embedding or translating Dash page structures directly.
3. Preserve the current Vizion Lab visual language and shell behavior.
4. Add a dedicated backend API family for TAP coverage analysis instead of forcing the frontend to reconstruct complex aggregations from the current generic `/api/testing/*` endpoints.
5. Treat backend data completeness as a first-class migration requirement, not as a later cleanup.
6. Keep the migration independent from current AI chat work and from the Main Dashboard defect-centric contract.

## User-Facing Outcome

The `测试覆盖率分析` page should become a real analysis page with live data instead of the current mock dashboard.

The page should render in this order:

1. filter bar;
2. first chart card for `test_week × fv × status`;
3. second chart card for `test_week × top_aida × status`;
4. third chart card for `testcase × test_week × status`;
5. optional explanatory empty state or data warning region when required fields are incomplete.

The page should continue to feel like part of the current Vizion Lab dashboard family, not like a transplanted Bootstrap or Dash page.

## Frontend Design

### Destination page

The destination page remains:

1. `src/components/dashboard/pages/CoverageAnalysis.tsx`

That file is currently a mock coverage page and should be repurposed into the real TAP testing coverage analysis page.

### Visual direction

The migrated page should keep:

1. current `dashboard-card` usage;
2. current background and border tokens;
3. current chart embedding style used elsewhere in the React dashboard;
4. current typography and shell header treatment;
5. current sidebar and content spacing.

The migrated page should not copy:

1. Dash layout wrappers;
2. Bootstrap panel styling from TPMDashboard;
3. server-side callback architecture;
4. TPMDashboard-specific dark/light switching behavior.

### Recommended component split

Recommended React modules:

1. `CoverageAnalysis.tsx`
2. `coverage-analysis/useCoverageAnalysisData.ts`
3. `coverage-analysis/coverageAnalysisApi.ts`
4. `coverage-analysis/coverageAnalysisTypes.ts`
5. `coverage-analysis/CoverageAnalysisFilters.tsx`
6. `coverage-analysis/CoverageAnalysisChartCard.tsx`
7. `coverage-analysis/CoverageAnalysisEmptyState.tsx`

### Filter behavior

All filters should be multi-select unless the UI later proves that a single-select control is materially better.

Empty selection semantics:

1. empty means `All`;
2. default year scope may be preselected when data includes a clear current-year slice;
3. reset clears all explicit selections and restores the default year behavior.

### Interaction behavior

Preserve the reference interaction model in a React-native way:

1. filter changes refresh all three charts;
2. clicking chart 1 narrows the `fv` selection;
3. clicking chart 2 narrows the `top_aida` selection;
4. chart 3 acts as the drilldown-heavy view and should reflect the current filter scope plus any chart-driven narrowing;
5. no interaction on this page may mutate backend data.

## Backend Design

### Why the current generic testing APIs are not enough

The current Vizion Lab testing endpoints are intentionally lightweight:

1. `/api/testing/summary`
2. `/api/testing/testcases`
3. `/api/testing/runs`
4. `/api/metadata/filters`
5. `/api/correlation/defect-test`

These endpoints are useful for foundational testing data access, but they do not yet expose the complete testing coverage analysis contract required by the three reference charts.

The TAP page should not force the frontend to reconstruct the full analysis model from partial raw endpoints.

### Recommended API family

Add a dedicated TAP-focused testing coverage API family on the existing analytics backend:

1. `/api/testing/coverage-analysis/filters`
2. `/api/testing/coverage-analysis/project-status`
3. `/api/testing/coverage-analysis/aida-status`
4. `/api/testing/coverage-analysis/testcase-detail`

These endpoints remain on port `3003` beside the existing analytics APIs.

### Request vocabulary

The new endpoints should share one common filter vocabulary:

1. `years`
2. `projects`
3. `test_weeks`
4. `pus`
5. `aidas`
6. `statuses`
7. `feature_regions`
8. `fvps`
9. `fvs`

This vocabulary should be stable across all four endpoints so the frontend can keep one page-level filter state.

### Response responsibilities

`/api/testing/coverage-analysis/filters` should return the distinct values required to render the filter bar.

`/api/testing/coverage-analysis/project-status` should return the aggregated rows needed for chart 1, centered on:

1. `test_week`
2. `fv`
3. `fvp`
4. `status`
5. `count`

`/api/testing/coverage-analysis/aida-status` should return the aggregated rows needed for chart 2, centered on:

1. `test_week`
2. `top_aida`
3. `status`
4. `count`

`/api/testing/coverage-analysis/testcase-detail` should return the detailed rows needed for chart 3, centered on:

1. `test_id`
2. `test_name`
3. `test_week`
4. `status`
5. `top_aida`
6. `project`
7. `pu`
8. `tester`
9. `count`

If the frontend later needs client-side drill cards or tooltips, optional fields may also include:

1. `mr_id`
2. `team`
3. `lead_model`

## Data Completeness Contract

### Required logical fields

For this migration to be considered backend-complete, the analytics read model must be able to provide these testing coverage dimensions:

1. `year`
2. `test_week`
3. `project`
4. `pu`
5. `top_aida`
6. `feature_region`
7. `fvp`
8. `fv`
9. `status`
10. `test_id`
11. `test_name`
12. `tester`

### Derived fields allowed in phase 1

Not all of these fields need to be stored as original raw fields if they can be derived safely and deterministically.

Allowed derived fields in phase 1:

1. `test_week` derived from a run timestamp or creation timestamp;
2. `year` derived from timestamp or persisted year field;
3. `feature_region` derived from `top_aida` using the same mapping rule used by TPMDashboard;
4. `status` normalized from `native_status`, `status`, or equivalent run status field;
5. `fvp` derived from `fv` through the existing mapping rules.

### Data gap findings in the current Vizion Lab analytics model

The current Vizion Lab analytics foundation does not yet guarantee a stable TAP coverage contract for these dimensions:

1. `test_week`
2. `top_aida`
3. `feature_region`
4. `pu`
5. `tester`
6. testing-oriented filter vocabularies
7. chart-ready grouped rows for the three coverage views

This means the migration requires backend read-model work, not just frontend rewiring.

## Error Handling

### Missing or incomplete testing data

If testing coverage fields are incomplete, the new API family should fail explicitly and locally.

Required behavior:

1. the TAP coverage endpoints should return a clear non-ready response when critical dimensions are missing;
2. failure in TAP testing endpoints must not break `/api/full-picture/dashboard`;
3. failure in TAP testing endpoints must not affect AI chat APIs on `3004`;
4. empty testing data should render a clear empty state in the page instead of misleading zero-value charts.

### Partial readiness

If some dimensions exist but others do not, the backend may return partial readiness metadata, but only if the frontend can present it honestly.

The page should not silently render charts that imply full coverage when the underlying dimensional completeness is incomplete.

## Validation Strategy

### Backend validation

Validate the new TAP coverage contract at three levels:

1. schema-level field availability;
2. read-model grouping correctness;
3. endpoint response completeness for the three chart contracts.

### Frontend validation

Validate:

1. the filter bar renders from live backend filter options;
2. all three charts update when filters change;
3. chart 1 click narrows `fv` state correctly;
4. chart 2 click narrows `top_aida` state correctly;
5. chart 3 reflects the active scope without layout breakage;
6. empty-state and non-ready-state messaging are visible and accurate.

### Isolation validation

Confirm:

1. Main Dashboard remains defect-centric and unchanged;
2. AI chat routes on `3004` remain unaffected;
3. TAP testing analysis remains read-only;
4. coverage-analysis API failures do not degrade unrelated dashboard pages.

## Delivery Sequence

### Phase 1

1. define the TAP coverage-analysis backend contract;
2. add backend data-completeness checks and grouped read models;
3. expose the new coverage-analysis endpoints on `3003`;
4. replace the mock `CoverageAnalysis.tsx` page with live filters and three real charts;
5. validate empty-state, partial-readiness, and interaction behavior.

### Phase 2

1. consider migrating extra testing coverage widgets only after the core three-chart flow is stable;
2. consider consolidating testing metadata APIs if multiple testing pages begin to reuse the same filter vocabulary;
3. consider richer drilldown tables or export features after the core page is proven stable.

## Design Summary

The TAP migration should preserve the current Vizion Lab look and feel while reusing the business intent of the TPMDashboard testing coverage analysis.

The page migration itself is straightforward because Vizion Lab already has a destination page.

The real implementation challenge is backend completeness. The current generic testing APIs are a good foundation, but they are not yet equivalent to the testing coverage analysis contract used by Defect Explore.

For that reason, the correct migration path is:

1. add a TAP-specific coverage-analysis backend contract;
2. validate data completeness for the required testing dimensions;
3. then migrate the filter bar and three core charts into the current TAP page.
