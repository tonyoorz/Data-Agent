# Octane Backend Restructure Design

## Goal

Restructure the current local analytics backend that serves Vizion Lab so it can evolve from a defect-only `agate` data path into a unified Octane analytics backend.

This work must preserve the existing Main Dashboard data path while adding support for test-related data ingestion, storage, processing, and API delivery.

The first implementation phase must:

1. Restructure downloader naming and boundaries toward a unified `octane` ingestion model.
2. Extend the analytics database to include test-related entities and relationships.
3. Introduce a shared processing layer that enriches both defect and test/run data using local mapping files.

The first phase must not:

1. Change the existing Main Dashboard request contract in a breaking way.
2. Inject test KPIs into the current Main Dashboard payload.
3. Merge analytics APIs with the in-progress AI chat API.

## Confirmed Scope

### In scope for phase 1

1. Keep the current backend service on port `3003` serving analytics APIs.
2. Preserve `/api/full-picture/dashboard` as the defect-centric API used by the current Main Dashboard.
3. Add Octane test-related storage in the same analytics database.
4. Add a unified processor that can enrich defect and run data from local mapping files.
5. Add new testing-focused APIs that do not affect the Main Dashboard.
6. Support incremental migration from the current `agate` naming/data path to a unified `octane` naming/data path.

### Explicitly out of scope for phase 1

1. Changing the current Main Dashboard frontend to consume test data.
2. Expanding `/api/full-picture/dashboard` into a mixed defect-plus-test payload.
3. Merging AI chat request handling into the analytics backend.
4. Requiring an immediate full rebuild of all existing defect data before any new testing APIs can ship.

## Source Anchors

### Vizion Lab anchors

1. `src/components/dashboard/main-dashboard/mainDashboardApi.ts`
2. `src/components/dashboard/main-dashboard/mainDashboardTypes.ts`
3. `vite.config.ts`

### TPMDashboard reference anchors

1. `C:/Users/q446328/Desktop/TPMDashbaord/full_picture_api_service.py`
2. `C:/Users/q446328/Desktop/TPMDashbaord/octane_db.py`
3. `C:/Users/q446328/Desktop/TPMDashbaord/data_processor.py`
4. `C:/Users/q446328/Desktop/TPMDashbaord/download/octane_downloader.py`
5. `C:/Users/q446328/Desktop/TPMDashbaord/download/testcase_downloader.py`
6. `C:/Users/q446328/Desktop/TPMDashbaord/defect_explore.py`

## Design Decisions

1. Use one analytics backend service, not a second dedicated test backend.
2. Use one analytics database for defect, history, run, testcase, and relation data.
3. Preserve the existing defect-centric Main Dashboard API during phase 1.
4. Add testing APIs beside the existing Main Dashboard API instead of widening the current payload.
5. Isolate AI chat APIs from analytics APIs by process responsibility and request path.
6. Migrate in two phases: incremental compatibility first, full Octane naming and rebuild second.

## Architecture

The target architecture has four layers:

1. `ingest`
2. `storage`
3. `processor`
4. `api`

### Ingest layer

The current defect-only downloader path will evolve into a unified Octane ingestion path.

The new ingestion boundary should:

1. Pull defects.
2. Pull defect history events.
3. Pull manual runs and related run metadata.
4. Build testcase datasets and testcase relations from run data.
5. Write raw or semi-normalized entities into the shared analytics database.

The ingest layer should not:

1. Build dashboard payloads.
2. Read frontend concerns.
3. Perform heavy business enrichment inline when that logic belongs in the processor.

### Storage layer

The storage layer remains a single SQLite analytics database.

Phase 1 keeps current defect data usable while extending the database with Octane-oriented tables.

The minimum required logical entities are:

1. `octane_defects`
2. `octane_defect_history_events`
3. `octane_manual_runs`
4. `octane_testcases`
5. `octane_testcase_relations`

The database is treated as the shared read model source for analytics APIs. The API layer should query persisted data, not rebuild large dataframes from files on every request.

### Processor layer

The processor layer is responsible for business enrichment and normalization after ingestion.

Its responsibilities are:

1. Normalize IDs, timestamps, list fields, and relation shapes.
2. Load local mapping files once in a controlled place.
3. Compute stable business dimensions such as `project`, `market`, `PU`, `FV`, `FVP`, `team`, and `lead_model`.
4. Write enriched dimensions back into stored tables so APIs can serve stable read models efficiently.

The processor is the only layer allowed to combine raw Octane entities with local mapping files.

### API layer

The API layer remains a single analytics backend on port `3003`, but it is split by read model instead of page-specific ad hoc logic.

Phase 1 exposes separate API families:

1. Defect-centric dashboard APIs.
2. Testing summary APIs.
3. Testing drilldown APIs.
4. Correlation APIs.
5. Shared metadata APIs.

## Naming Strategy

### Phase 1 naming rule

All newly introduced modules, tables, jobs, and configuration should use `octane` naming.

Examples:

1. `octane_sync`
2. `octane_ingest`
3. `octane_processor`
4. `octane.db` or `octane_data.db`
5. `octane_*` table prefixes

Existing `agate` references may remain only as temporary compatibility surfaces during the migration.

### Phase 2 naming rule

Once the new path is stable, internal references should be fully normalized to `octane`. `agate` becomes an alias-only compatibility term and is then removed.

## Database Migration Design

### Phase 1: Incremental extension

Phase 1 extends the current analytics database without breaking the current Main Dashboard.

Steps:

1. Keep the current defect/history path readable by existing code.
2. Add test-related tables into the same analytics database.
3. Load a minimum viable set of test/run/testcase data so the new tables are not empty.
4. Run the processor so enriched dimensions exist for both defects and runs.
5. Add new APIs that read the new tables without changing the Main Dashboard contract.

The minimum viable testing dataset must be large enough to verify:

1. tables are populated;
2. relations are queryable;
3. processor backfill works;
4. testing APIs return non-empty results.

### Phase 2: Full rebuild and cutover

Phase 2 fully rebuilds a clean `octane` analytics database from the new unified ingest path.

Steps:

1. Re-run ingestion for defects, histories, runs, and testcase datasets from the unified Octane path.
2. Build a clean `octane` database without depending on legacy `agate` naming.
3. Switch the analytics backend default configuration to read the new Octane database.
4. Retire the legacy `agate` compatibility path.

## Processor and Local Mapping Design

### Processor responsibilities

The new processor boundary should be shared across defect and testing data.

Core jobs:

1. `sync_defect_dimensions`
2. `sync_run_dimensions`
3. `build_testcase_summary`
4. `build_defect_test_correlation`
5. `refresh_filter_metadata`

Phase 1 only requires the first two jobs to ship the new data foundation safely. The later jobs can follow once the data path is stable.

### Local mapping sources

Local mapping files remain supported and are treated as input dependencies to the processor, not to the API layer.

Typical mappings include:

1. `VIN -> project`
2. `VIN -> market`
3. `AIDA -> FV`
4. `FV -> FVP`
5. `assigned_ecu` or `lead_model` derived project hints

The processor must tolerate partial availability of testing data. Missing testcase relations or partially loaded runs must not block defect enrichment or defect-centric APIs.

## API Boundary Design

### Existing API to preserve

Keep:

1. `/api/full-picture/dashboard`

This endpoint remains defect-centric in phase 1 and continues to serve the current Main Dashboard without semantic expansion.

### New API families to add

Add:

1. `/api/testing/summary`
2. `/api/testing/testcases`
3. `/api/testing/runs`
4. `/api/correlation/defect-test`
5. `/api/metadata/filters`

### API responsibilities

`/api/testing/summary` returns testing domain overview metrics such as testcase counts, run counts, status distributions, and relationship coverage.

`/api/testing/testcases` returns testcase-level drilldown data backed by stored testcase summaries and relations.

`/api/testing/runs` returns run-level drilldown data backed by stored run entities.

`/api/correlation/defect-test` returns cross-domain relationships between defects and tests/runs/features/stories.

`/api/metadata/filters` returns unified filter metadata shared across defect and testing experiences.

These APIs must be additive in phase 1. They must not change the response shape of `/api/full-picture/dashboard`.

## Frontend Integration Boundary

Phase 1 does not modify the current Main Dashboard behavior.

Frontend sequence:

1. Keep the current Main Dashboard calling `/api/full-picture/dashboard`.
2. Validate that the defect-centric payload remains stable while backend storage evolves.
3. Add testing pages or testing-facing consumers later using `/api/testing/summary` and `/api/testing/testcases`.
4. Delay any Main Dashboard test KPI integration until after the new APIs and data pipeline are stable.

## AI Chat Isolation Requirements

The in-progress AI chat API must not be entangled with analytics data ingestion or processing.

### Required separation

1. Analytics APIs remain on port `3003`.
2. AI chat APIs remain on their own service boundary, currently port `3004`.
3. AI chat requests must not trigger downloader jobs, processor jobs, or mapping backfills.
4. Analytics ingestion and enrichment must run as explicit sync jobs, not inside live request paths.
5. If AI chat later reads analytics data, it must do so through explicit read-only query/context APIs rather than direct coupling to sync internals.

### Shared-state restrictions

1. Do not share mutable job state between analytics APIs and AI chat APIs.
2. Keep database configuration, caches, logging, and background job control separate by service responsibility.
3. Treat AI chat as a consumer of read-only analytics outputs, not a controller of analytics data lifecycle.

## Migration Plan

### Phase 1

1. Introduce the new `octane` naming layer for all new modules and tables.
2. Extend the existing analytics database with test-related tables.
3. Load a minimum viable testing dataset.
4. Add the shared processor for defect/run enrichment using local mappings.
5. Expose new testing and metadata APIs.
6. Verify that `/api/full-picture/dashboard` remains stable.

### Phase 2

1. Implement the unified Octane ingest path as the default source of truth.
2. Rebuild a clean Octane database.
3. Switch analytics APIs to the new Octane database by default.
4. Remove legacy `agate` compatibility names and paths.

## Validation Strategy

Validation is required at each boundary.

### Database validation

Confirm that all required tables exist and contain data:

1. defects
2. history events
3. manual runs
4. testcase summaries
5. testcase relations

### Processor validation

Confirm that enriched dimensions are written back successfully for both defect and run entities:

1. `project`
2. `market`
3. `PU`
4. `FV`
5. `FVP`
6. `team`
7. `lead_model`

### API validation

Confirm:

1. `/api/full-picture/dashboard` remains non-breaking;
2. testing APIs return non-empty data from real stored entities;
3. metadata APIs return shared filter vocabularies;
4. correlation APIs return real linked results.

### Isolation validation

Confirm:

1. analytics endpoints on `3003` remain healthy during AI chat work;
2. AI chat endpoints on `3004` remain independent of analytics sync jobs;
3. no chat request causes analytics data mutation.

## Error Handling and Operational Constraints

1. Partial testing data loads must not break defect-centric APIs.
2. Missing mapping files must degrade gracefully with warnings and partial enrichment, not total backend failure.
3. Empty new testing tables must surface as explicit non-ready diagnostics, not silent success.
4. Processor runs must be idempotent so repeated backfills are safe.
5. New APIs should fail independently; a testing API issue must not make the Main Dashboard unavailable.

## Success Criteria

Phase 1 is successful when:

1. the current Main Dashboard keeps working through `/api/full-picture/dashboard`;
2. the shared analytics database contains real test-related data;
3. local mappings enrich both defect and run entities through one processor layer;
4. testing summary and drilldown APIs can serve real data;
5. AI chat API development can continue without interfering with analytics ingestion or Main Dashboard data delivery.

## Deferred Work

The following are intentionally deferred until after phase 1 stabilizes:

1. injecting test KPIs into the Main Dashboard;
2. expanding Main Dashboard drilldowns with test overlays;
3. fully removing legacy `agate` compatibility names;
4. merging defect and testing experiences into a combined top-level page.