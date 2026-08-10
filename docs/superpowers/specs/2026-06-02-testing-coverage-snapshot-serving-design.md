# Testing Coverage Snapshot Serving Design

## Goal

Move only the `测试覆盖率分析` page to a hot-snapshot serving model so that:

1. page-load reads never rebuild coverage rows from source tables;
2. refresh work runs offline through a dedicated testing materialization step;
3. concurrent readers see one stable published snapshot;
4. Full Picture defect/history serving remains unchanged in this phase.

This phase is intentionally narrow. It covers the four existing coverage-analysis APIs only and does not migrate any other testing page or any Full Picture endpoint.

## Problem Statement

Today testing coverage still behaves like a request-time derived model:

1. APIs can fall back to `database/source/qgate_raw.db` when hot coverage data is missing or stale.
2. Source-backed requests materialize temporary coverage rows inside the request path.
3. Each endpoint repeats similar grouping work, so first load is slow even for one user.
4. Multi-user reads can contend with refresh or source scans because the page is not bound to a published snapshot.

This is acceptable for debugging but not for a shared intranet dashboard, even at moderate concurrency.

## Design Decisions

1. Keep the existing source tables and ingest path unchanged.
2. Keep the existing coverage page API contract unchanged.
3. Replace coverage hot storage with versioned snapshot rows plus an active pointer.
4. Serve coverage APIs only from the active testing snapshot.
5. Return `503` when no published testing snapshot is ready instead of falling back to source reads.
6. Reuse the existing repository-local `database/source` and `database/hot` layout.
7. Reuse the existing snapshot-state pattern already present for Main Dashboard, but keep testing snapshot metadata separate from Full Picture snapshot pointers.

## Architecture

### 1. Source layer

`database/source/qgate_raw.db` remains the canonical staged source for:

1. `octane_manual_runs`
2. `octane_testcases`
3. `octane_defects`

No online request reads this layer after the migration is complete.

### 2. Testing snapshot preparation layer

An offline refresh command derives coverage rows from source and writes a new snapshot into `database/hot/vizion_serving.db`.

Responsibilities:

1. derive normalized testing coverage rows;
2. write them under a new `snapshot_version`;
3. record refresh metadata and row counts;
4. activate the snapshot only after all rows are written successfully.

### 3. Testing coverage read layer

The existing endpoints continue to exist:

1. `/api/testing/coverage-analysis/filters`
2. `/api/testing/coverage-analysis/project-status`
3. `/api/testing/coverage-analysis/aida-status`
4. `/api/testing/coverage-analysis/testcase-detail`

Their implementation changes so they:

1. resolve the active testing snapshot version;
2. query only rows for that version;
3. never derive rows from source inline;
4. fail fast with `503` when the testing snapshot is missing.

## Hot Data Model

### Coverage row store

`testing_coverage_runs` becomes a multi-snapshot table with these properties:

1. add `snapshot_version` to every row;
2. keep `mr_id` as the source identity;
3. use `(snapshot_version, mr_id)` as the logical uniqueness boundary.

### Snapshot metadata

Testing coverage gets its own snapshot metadata tables, separate from Full Picture:

1. `testing_coverage_snapshot_state`
2. `testing_coverage_snapshot_pointer`

They track:

1. `snapshot_version`
2. `source_signature`
3. `row_count`
4. `refresh_status`
5. `refreshed_at`
6. `last_error`

The active pointer stores the single published snapshot for online reads.

## Refresh Flow

The testing refresh flow becomes:

1. compute source signature from `database/source/qgate_raw.db`;
2. build a new testing snapshot version from that signature;
3. derive coverage rows from source;
4. delete any stale rows for that same snapshot version if they exist;
5. insert all derived rows with the new `snapshot_version`;
6. update `testing_coverage_snapshot_state` to `ready`;
7. move `testing_coverage_snapshot_pointer.active` to the new version;
8. optionally prune superseded old snapshots.

The active pointer does not change on failure.

## API Contract Impact

Frontend payload shapes remain unchanged.

Behavior changes:

1. the coverage page no longer reads source data directly;
2. the page will only show published hot-snapshot data;
3. operators must run the testing hot refresh to publish new data.

This is the intended tradeoff for stable reads and predictable latency.

## Concurrency Model

This phase targets shared intranet usage up to roughly 50 concurrent readers.

That target is supported by:

1. read-only APIs using short hot-table queries only;
2. SQLite `WAL` mode on the hot database;
3. atomic pointer switch after successful refresh;
4. no request-time source scans or temp-table rebuilds.

This is not a high-write architecture. It is a moderate-concurrency read service with periodic asynchronous refresh.

## Validation Goals

Success for this phase means:

1. the coverage page still renders the same API response shapes;
2. hot refresh produces a published testing snapshot;
3. coverage APIs return `503` when no testing snapshot is published;
4. coverage APIs do not need source fallback once a snapshot exists;
5. first-load latency drops because requests only hit hot grouped queries.

## Explicit Non-Goals

This phase does not:

1. migrate Full Picture endpoints;
2. migrate defect/history serving;
3. migrate other testing pages still backed by mock data;
4. add distributed infrastructure;
5. redesign the frontend API contract.