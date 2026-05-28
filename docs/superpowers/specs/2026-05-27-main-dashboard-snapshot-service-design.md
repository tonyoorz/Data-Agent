# Main Dashboard Snapshot Service Design

## Goal

Define Vizion Lab as a snapshot consumer and dashboard serving layer for Main Dashboard, instead of an Octane downloader runtime.

This phase must improve Main Dashboard first-load behavior and make the service suitable for shared intranet usage without depending on live Octane sessions, cookie lifetime, or request-time full dataset hydration.

The design assumes:

1. Upstream qgate data is refreshed out-of-band, not by end-user page requests.
2. Main Dashboard data freshness is daily or manual, not hourly or near-real-time.
3. The current repository should consume prepared snapshots and serve stable read APIs.

## Problem Statement

Today Main Dashboard behaves like a single large read model:

1. `/api/full-picture/dashboard` returns filters, KPI summaries, team summaries, and full `ticket_rows` in one response.
2. The payload is large enough to slow first paint and degrade shared intranet access.
3. The current repository already has local source and hot-store concepts, but its runtime contract still assumes full dashboard hydration on initial load.
4. The repository does not yet own the full Octane download and persistence boundary.

This creates the wrong coupling:

1. first-load performance depends on full detail hydration;
2. multi-user access repeats expensive work;
3. refresh flow is not yet expressed as a single snapshot lifecycle;
4. downloader migration pressure is mixed into dashboard-serving concerns.

## Design Decisions

1. Treat the current repository as a snapshot consumer and dashboard serving layer.
2. Keep Octane download and cookie/session management out of the online request path.
3. Preserve the current repository-local source and hot-store model.
4. Split Main Dashboard reads into separate summary and detail APIs.
5. Cache summary responses by snapshot version and normalized filters.
6. Move table pagination, sorting, and search to the server.
7. Make refresh an offline, versioned, atomic snapshot preparation flow.
8. Preserve a clean future migration path where downloader logic may move into this repository later, but still as an offline ingest subsystem.

## Repository Role

### Current repository responsibilities

Vizion Lab is responsible for:

1. accepting an already-downloaded qgate SQLite snapshot;
2. staging that snapshot into `database/source/qgate_raw.db`;
3. materializing local hot dashboard read data;
4. preparing and serving dashboard read models;
5. exposing refresh metadata and snapshot identity to the frontend;
6. serving Main Dashboard and other analytics APIs from local prepared data.

### Explicit non-responsibilities

Vizion Lab is not responsible in this phase for:

1. Octane login;
2. cookie lifecycle management;
3. raw defect/history/test download scheduling;
4. page-request-triggered ingestion;
5. request-time source rebuilds from Octane.

### Upstream data producer boundary

The upstream producer remains the existing qgate downloader workflow.

In practice this means:

1. `qgatedownloader` or equivalent upstream tooling refreshes qgate SQLite;
2. Vizion Lab consumes the resulting SQLite snapshot;
3. the integration boundary is file-based snapshot handoff, not API-level live sync.

## Architecture

The architecture for this phase has three layers.

### 1. Upstream ingest layer

This layer remains outside Vizion Lab for now.

Responsibilities:

1. authenticate to Octane;
2. download defects, history, and other upstream entities as needed;
3. build or refresh qgate SQLite.

Output:

1. a valid qgate SQLite snapshot.

### 2. Snapshot preparation layer

This layer runs inside Vizion Lab as offline commands.

Responsibilities:

1. validate and stage the snapshot into `database/source/qgate_raw.db`;
2. refresh hot outcomes and related prepared read data;
3. precompute and cache dashboard summary data for hot query shapes;
4. write refresh metadata;
5. switch the active snapshot version only after preparation completes successfully.

### 3. Dashboard service layer

This layer is the online analytics API on port `3003`.

Responsibilities:

1. serve Main Dashboard summary data;
2. serve paged ticket detail data;
3. serve refresh metadata;
4. read only prepared local snapshot and hot data;
5. never trigger downloader logic or long-running materialization inline.

## Data Layout

The repository-local data model remains rooted in three areas:

1. `database/source/`
2. `database/hot/`
3. `database/cold/`

### Source data

`database/source/qgate_raw.db` remains the canonical staged source snapshot used by Vizion Lab.

### Hot data

`database/hot/` remains the place for prepared read-side data such as:

1. materialized outcome flags;
2. future summary read models;
3. refresh-state metadata if kept in SQLite.

### Cold data

`database/cold/` stays explicitly out of the online runtime read path in this phase.

## Main Dashboard API Evolution

### Current state

The current endpoint is:

1. `/api/full-picture/dashboard`

It returns:

1. `generated_from`
2. `filters`
3. `overview`
4. `outcome_summary`
5. `team_outcome_rows`
6. `ticket_rows`

This should remain temporarily for compatibility, but it is no longer the target serving model.

### Target endpoints

The Main Dashboard read contract should evolve to three read models.

#### 1. Summary endpoint

Recommended path:

1. `/api/full-picture/dashboard/summary`

Responsibilities:

1. return first-screen dashboard state;
2. exclude full detail rows;
3. be cacheable and prewarmable.

Recommended response shape:

1. `snapshot_version`
2. `refreshed_at`
3. `generated_from`
4. `refresh_metadata`
5. `filters`
6. `overview`
7. `outcome_summary`
8. `team_outcome_rows`
9. `ticket_scope_count`

This endpoint is the default page-load entrypoint.

#### 2. Tickets endpoint

Recommended path:

1. `/api/full-picture/dashboard/tickets`

Responsibilities:

1. return paged table data only;
2. support server-side pagination;
3. support search and sorting;
4. use the same normalized filter vocabulary as summary.

Recommended request parameters:

1. existing dashboard filters:
   - `years`
   - `projects`
   - `assigned_ecus`
   - `problem_finder_teams`
   - `aidas`
   - `phases`
   - `solution_clusters`
   - `pus`
   - `markets`
   - `lead_models`
   - `groups`
2. `search`
3. `page`
4. `page_size`
5. `sort_by`
6. `sort_order`

Recommended response shape:

1. `snapshot_version`
2. `refreshed_at`
3. `page`
4. `page_size`
5. `total_rows`
6. `total_pages`
7. `has_next_page`
8. `rows`

#### 3. Refresh status endpoint

Recommended path:

1. `/api/full-picture/dashboard/refresh-status`

Responsibilities:

1. expose the active snapshot identity;
2. expose refresh success/failure state;
3. support UI status messaging and diagnostics.

Recommended response shape:

1. `active_snapshot_version`
2. `source_db_path`
3. `source_db_mtime`
4. `outcomes_refreshed_at`
5. `summary_cache_refreshed_at`
6. `refresh_status`
7. `last_success_at`
8. `last_error`

## Frontend Integration Design

### Page-load sequence

Main Dashboard should load in this order:

1. request `summary`;
2. render filters, KPI cards, outcome panel, team panel, and refresh status;
3. request `tickets` for the initial table page;
4. render the first table page once available.

### Why this improves user experience

This design removes the current assumption that first paint requires full `ticket_rows` hydration.

The user sees:

1. dashboard shell quickly;
2. KPI and summary state first;
3. table detail next.

### Filtering behavior

Summary and tickets must share the same normalized filter behavior.

This means:

1. identical filter vocabulary;
2. identical default filter semantics;
3. identical multi-select handling;
4. identical query normalization;
5. identical scope interpretation.

### Table behavior

`TicketDetailTable` should stop owning a full in-memory dataset.

Instead it should become a server-driven table surface that:

1. renders the current page rows;
2. emits pagination changes;
3. emits sort changes;
4. emits search text;
5. relies on server responses for total count and next page state.

## Caching Strategy

### What to cache

Only `summary` should be a first-class cache target in phase 2.

Reason:

1. it is shared across many viewers;
2. it is the critical first-screen payload;
3. it has a smaller shape than full ticket detail;
4. it is naturally tied to snapshot versions.

### Cache implementation now

The first implementation should use in-process memory cache.

### Cache implementation later

The cache contract must be designed so the backend can later swap to Redis or another shared cache without changing API semantics.

### Cache key design

The cache key must include:

1. `snapshot_version`
2. normalized filter params

The key should not depend on raw query-string ordering.

### Default prewarm

The refresh flow should prewarm the most important summary query shapes:

1. default landing query;
2. optional small set of high-traffic preset scopes if later needed.

### What not to cache aggressively yet

The `tickets` endpoint should not be the initial caching focus.

Reason:

1. page/search/sort combinations create a high cardinality surface;
2. correct server-side pagination already removes the main first-load bottleneck;
3. ticket caching can be revisited later if real usage proves it necessary.

## Version Consistency Rules

### Single version contract

All Main Dashboard read APIs must surface a version identifier.

At minimum:

1. `summary.snapshot_version`
2. `tickets.snapshot_version`
3. `refresh-status.active_snapshot_version`

### Frontend version anchor

The frontend should treat the `summary` response as the page-session version anchor.

If a later `tickets` response returns a mismatched version, the frontend should discard mixed-state rendering and resync.

### Snapshot version source

The snapshot version should be derived from prepared data state, for example:

1. source snapshot signature;
2. hot outcome refresh signature;
3. explicit refresh version metadata.

The exact representation is flexible, but it must be deterministic and stable.

## Refresh Flow

### Refresh trigger model

Refresh is offline and explicit.

Supported trigger styles:

1. manual run;
2. scheduled daily refresh.

Refresh is not part of any end-user HTTP request path.

### Refresh sequence

The target logical flow is:

1. verify upstream qgate SQLite snapshot exists and is valid;
2. stage snapshot into `database/source/qgate_raw.db`;
3. refresh hot outcomes;
4. refresh summary cache for hot query shapes;
5. write refresh metadata;
6. switch active snapshot version.

### Why this must be one pipeline

Users should not have to remember multiple independent commands for normal dashboard data preparation.

The repository should expose one logical refresh action even if it internally calls multiple lower-level steps.

## Atomic Switch Design

### Core rule

The service must never expose half-prepared state as the active snapshot.

### Two-phase approach

#### Preparation phase

Prepare the next snapshot version completely:

1. staged source ready;
2. hot outcomes ready;
3. summary cache ready;
4. metadata ready.

#### Activation phase

Switch one active pointer/version marker so all read APIs resolve to the same new version.

### Failure behavior

If preparation fails:

1. keep serving the old active snapshot;
2. record failure in refresh metadata;
3. avoid mixed old/new reads.

This keeps the dashboard available even when the latest refresh attempt fails.

## Refresh Metadata Design

The refresh state should expose enough information for both diagnostics and UI display.

Recommended fields:

1. `active_snapshot_version`
2. `source_db_path`
3. `source_db_mtime`
4. `source_snapshot_signature`
5. `outcomes_refreshed_at`
6. `summary_cache_refreshed_at`
7. `refresh_status`
8. `last_success_at`
9. `last_error`

The page-level “data synced at” indicator should read from this metadata rather than recomputing ad hoc display dates.

## Future Downloader Migration Boundary

If downloader logic moves into Vizion Lab later, it must still remain outside the online request path.

### Target future boundaries

#### 1. Ingestion subsystem

Responsibilities:

1. Octane authentication;
2. cookie/session handling;
3. upstream data download;
4. raw SQLite build/update.

Runtime style:

1. offline job, scheduled task, or manual command.

#### 2. Snapshot preparation subsystem

Responsibilities:

1. stage source snapshot;
2. refresh hot outcomes;
3. refresh summary cache;
4. write refresh metadata;
5. switch active snapshot version.

#### 3. Dashboard service subsystem

Responsibilities:

1. serve summary;
2. serve tickets;
3. serve refresh status;
4. serve only prepared local data.

### Migration rule

Future downloader migration means moving the ingest subsystem into this repository, not merging it into the dashboard API process.

## Backward Compatibility

During migration, keep `/api/full-picture/dashboard` as a compatibility endpoint until:

1. the frontend fully adopts `summary` and `tickets`;
2. the new pagination and versioning behavior is stable;
3. refresh metadata is visible and trusted.

The old endpoint may later be reduced to:

1. a compatibility shim;
2. an internal debug surface; or
3. a deprecated endpoint scheduled for removal.

## Acceptance Criteria

1. The repository is clearly documented as a snapshot consumer and dashboard serving layer.
2. Main Dashboard first load no longer depends on full `ticket_rows` hydration.
3. A summary endpoint exists and is cacheable by snapshot version.
4. A tickets endpoint exists and supports server-side pagination, sorting, and search.
5. A refresh-status endpoint exists and exposes active snapshot metadata.
6. Summary and tickets are guaranteed to represent the same snapshot version.
7. Refresh failures do not break the currently active dashboard snapshot.
8. Future downloader migration preserves offline ingest boundaries.

## Out Of Scope For This Phase

1. Migrating the full Octane downloader into Vizion Lab.
2. Adding near-real-time or hourly refresh.
3. Making page requests trigger upstream ingestion.
4. Introducing Redis in the first implementation slice.
5. Optimizing every downstream analytics API with the same cache strategy before Main Dashboard stabilization.

## Recommended Implementation Order

1. Add refresh metadata model and active snapshot version contract.
2. Add `summary` endpoint using the current dashboard semantics minus full ticket rows.
3. Add `tickets` endpoint with server-side pagination and shared filter normalization.
4. Update the Main Dashboard frontend to load summary first and tickets separately.
5. Add in-process summary cache keyed by snapshot version and normalized filters.
6. Add a unified refresh command that stages source, refreshes outcomes, prewarms summary, writes metadata, and activates the snapshot.
7. Keep the existing `/api/full-picture/dashboard` endpoint during frontend cutover.