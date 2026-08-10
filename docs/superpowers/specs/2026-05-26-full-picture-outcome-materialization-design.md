# Full Picture Outcome Materialization Design

## Goal

Remove the Full Picture runtime dependency on scanning `octane_defect_history_events` to derive outcome flags while keeping the current defect data path stable.

This phase introduces a minimal local hot-data layer for materialized outcomes and establishes the long-term database layout for source, hot, and cold data inside Vizion Lab.

The first implementation phase must:

1. Materialize per-defect outcome flags into a local SQLite hot database.
2. Keep the existing Full Picture API contract unchanged.
3. Continue treating the current TPMDashboard `qgate_data.db` as the read-only upstream source.
4. Create a repo-local database directory layout that can later host a copied raw source database and a cold analytics archive.

The first implementation phase must not:

1. Rewrite the current defect source table structure.
2. Rebuild all analytics APIs onto a new serving schema.
3. Move test analytics onto DuckDB.
4. Mutate the shared upstream `qgate_data.db`.

## Confirmed Scope

### In scope for phase 1

1. Add a repo-local `database/` root for future analytics storage.
2. Add a local hot SQLite database dedicated to materialized outcome data.
3. Add a refresh path that derives outcome rows from `octane_defect_history_events`.
4. Update Full Picture reads to consume materialized outcomes instead of scanning the history event table on each request.
5. Preserve the current `octane_defects` source reads from the upstream qgate database.

### Explicitly out of scope for phase 1

1. Copying the full upstream qgate database into Vizion Lab by default.
2. Replacing `octane_defects` with a local slim defect table.
3. Migrating duplicate search to a new database path.
4. Refactoring test analytics into a full hot mart layer.

## Source Anchors

### Vizion Lab anchors

1. `backend/analytics/config.py`
2. `backend/analytics/read_models.py`
3. `backend/analytics/api.py`
4. `backend/tests/test_analytics_full_picture_api.py`
5. `scripts/duplicate_search_bridge.py`

### External source anchor

1. `C:/Users/q446328/Desktop/TPMDashbaord/qgate/qgate_data.db`

## Problem Statement

The current Full Picture request path loads defect rows from `octane_defects`, then loads matching history rows from `octane_defect_history_events`, then derives two booleans in Python:

1. `is_resolved_forward` from `08 -> 06`
2. `is_rejected_directly` from `01 -> 09`

That logic is correct, but it pushes a derived, stable, per-defect result into the online request path.

The performance issue is not that the defect table is too complex. The issue is that the request path repeatedly scans a large history-event dataset to compute a small outcome state.

This makes the current history table a compute layer instead of a source fact table.

## Design Decisions

1. Materialize only the outcome slice for phase 1 instead of introducing a full serving clone of the defect schema.
2. Keep `octane_defects` in the upstream qgate SQLite database as the source of truth for defect metadata during phase 1.
3. Create a repo-local hot SQLite database for derived online-read data.
4. Keep the upstream qgate SQLite database read-only from Vizion Lab.
5. Establish a repo-local directory layout now so future source-copy and cold-archive work land in stable paths.

## Database Layout

The long-term repo-local layout should be:

1. `database/source/`
2. `database/hot/`
3. `database/cold/`

Phase 1 only requires the `hot` path for runtime use, but all three directories should exist so later migration work does not reshuffle paths again.

### Target files

1. `database/source/qgate_raw.db`
2. `database/hot/vizion_serving.db`
3. `database/cold/qgate_archive.duckdb`
4. `database/cold/parquet/`

### Phase 1 usage rule

During phase 1:

1. `database/source/qgate_raw.db` is optional and may remain absent.
2. The upstream TPMDashboard qgate database remains the live source for defect and history facts.
3. `database/hot/vizion_serving.db` becomes the local storage for materialized outcomes.
4. `database/cold/` is reserved for later raw archive work and is not read by runtime APIs yet.

## Hot Outcome Table Design

The hot database introduces one new table:

1. `defect_outcomes`

Recommended columns:

1. `defect_id TEXT PRIMARY KEY`
2. `is_resolved_forward INTEGER NOT NULL`
3. `is_rejected_directly INTEGER NOT NULL`
4. `resolved_forward_at TEXT`
5. `rejected_directly_at TEXT`
6. `source_history_event_count INTEGER NOT NULL`
7. `source_signature TEXT NOT NULL`
8. `derived_at TEXT NOT NULL`

Column responsibilities:

1. `defect_id` keys the row to the upstream defect.
2. The two boolean flags support the current Full Picture contract.
3. The timestamp columns preserve the first matching event time for debugging and future analytics.
4. `source_history_event_count` gives a cheap sanity check for refresh completeness.
5. `source_signature` ties the materialized rowset to a specific upstream source snapshot.
6. `derived_at` captures when the local row was refreshed.

## Refresh Model

### Refresh boundary

Outcome derivation must happen outside the online request path.

The refresh job should:

1. Read the upstream history database once.
2. Scan only `field_name` values relevant to phase transitions.
3. Aggregate to one row per defect.
4. Replace or upsert rows in `defect_outcomes`.

### Refresh trigger

Phase 1 uses an explicit refresh command or script, not an implicit per-request rebuild.

Acceptable phase 1 trigger points:

1. manual command before starting the analytics service;
2. manual command after upstream qgate refresh;
3. optional best-effort startup refresh if the source signature changed.

The first implementation should prefer an explicit refresh command because it is easier to validate and less risky than hidden startup work.

### Source signature

The refresh process should compute a source signature from cheap upstream facts, such as:

1. source database path;
2. source database file size;
3. source database modification time;
4. optional history row count.

If the signature is unchanged, the refresh command may skip rebuilding outcomes.

## Full Picture Read Path Design

### Current request shape

The current Full Picture API should keep returning the same payload:

1. `overview`
2. `outcome_summary`
3. `team_outcome_rows`
4. `ticket_rows`
5. `generated_from`
6. `filters`

### New request flow

Phase 1 changes the internal read path only:

1. Load defect rows from the current upstream defect source.
2. Load matching outcome rows from the local hot database.
3. Default missing outcome rows to both flags `False`.
4. Build the payload exactly as the current API expects.

This removes the request-time dependency on `octane_defect_history_events` while keeping the defect source unchanged.

### Fallback behavior

If the hot outcome database or table is missing, the API should fail explicitly with a data-not-ready style error instead of silently falling back to rescanning history rows.

The goal of this phase is to remove the slow path, not to keep it hidden as a runtime fallback.

## Test Data and Future Analytics Positioning

This design does not treat Full Picture as the only future consumer.

The long-term database roles are:

1. source database for complete imported facts;
2. hot database for stable online-read models and materialized derivations;
3. cold DuckDB/Parquet storage for heavy raw payloads, wide JSON, and offline analysis.

This means phase 1 is not a vote for rebuilding every table into a serving clone. It is a minimal step that puts derived online results in the right place while preserving room for future test analytics marts.

## Why DuckDB Belongs in Cold, Not Hot

DuckDB is well suited for:

1. offline exploration;
2. wide raw payload storage;
3. Parquet-backed analysis;
4. periodic aggregation work.

DuckDB is not the right first choice for the current runtime hot path because:

1. the current backend already uses SQLite smoothly;
2. the online result we need is small and key-based;
3. introducing DuckDB into the runtime request path would add change surface without solving the online model boundary.

Phase 1 therefore keeps hot serving in SQLite and reserves DuckDB for future cold storage.

## Migration Plan

### Phase 1: Outcome materialization only

1. Create `database/hot/` and the hot SQLite file.
2. Add schema support for `defect_outcomes`.
3. Add a refresh command that derives one row per defect from upstream history events.
4. Update Full Picture to read the hot outcome table.
5. Add focused regression tests that prove payload equivalence for known history transitions.

### Phase 2: Local source copy

1. Add `database/source/qgate_raw.db` as a repo-local canonical copy.
2. Point outcome refresh jobs at the local copy instead of the sibling TPMDashboard path.
3. Keep Full Picture behavior unchanged.

### Phase 3: Cold archive split

1. Move wide raw payloads and snapshots into `database/cold/qgate_archive.duckdb` and/or Parquet.
2. Keep runtime APIs off the cold path.
3. Add analysis scripts that query the cold path directly.

## Validation Strategy

Phase 1 must prove both correctness and routing changes.

Required checks:

1. Unit test for outcome derivation from representative history transitions.
2. API regression test proving `08 -> 06` and `01 -> 09` outcomes still appear in Full Picture payloads.
3. API test proving Full Picture no longer requires `octane_defect_history_events` when `defect_outcomes` exists.
4. Data-not-ready test for a missing hot outcome table or empty hot database.

## Risks and Mitigations

### Risk: stale outcome data

If upstream qgate history changes but the hot table is not refreshed, Full Picture can serve stale flags.

Mitigation:

1. store `source_signature` and `derived_at`;
2. expose refresh status in logs or command output;
3. add an explicit refresh step to the local data workflow.

### Risk: premature serving-layer sprawl

If this phase expands into cloning every source table into hot, the change becomes larger than the performance issue requires.

Mitigation:

1. limit phase 1 to `defect_outcomes`;
2. keep `octane_defects` reads on the upstream source;
3. defer wider marts until a concrete online read path needs them.

### Risk: hidden fallback to slow path

If the API silently falls back to rescanning history rows, the architecture regresses while appearing to work.

Mitigation:

1. fail explicitly when hot outcomes are missing;
2. require a refresh workflow as part of local setup;
3. cover the absence case in tests.

## Success Criteria

This design is successful when:

1. Full Picture no longer scans `octane_defect_history_events` during normal requests.
2. Full Picture payload semantics stay unchanged for known outcome transitions.
3. Vizion Lab has a stable `database/` layout that can absorb later source and cold-data migration.
4. The change is narrowly scoped to the outcome problem instead of forcing an early full serving-schema rewrite.