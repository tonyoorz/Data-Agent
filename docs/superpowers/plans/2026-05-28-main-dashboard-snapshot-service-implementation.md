# Main Dashboard Snapshot Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Main Dashboard into snapshot-versioned summary and paged ticket APIs, add refresh-state and summary-cache foundations, and move the frontend to server-driven table loading while preserving the existing compatibility endpoint.

**Architecture:** Keep `qgatedownloader` outside Vizion Lab and treat this repository as a snapshot consumer and dashboard serving layer. Add a hot-store-backed snapshot state module, expose `/summary`, `/tickets`, and `/refresh-status` on the analytics service, and update the frontend so KPI/filter panels load from summary while `TicketDetailTable` fetches paged rows from the server.

**Tech Stack:** Python 3.11, FastAPI, SQLite, pytest, React 18, TypeScript, TanStack Query, TanStack Table, Vitest

---

## File Structure Map

- Create: `backend/analytics/dashboard_snapshot.py`
  - Owns snapshot version state, refresh metadata persistence, normalized summary cache keys, and in-process summary cache helpers.
- Modify: `backend/analytics/read_models.py`
  - Extract shared dashboard filter normalization, build summary payloads, paginate ticket rows, and attach snapshot metadata.
- Modify: `backend/analytics/api.py`
  - Add `/api/full-picture/dashboard/summary`, `/api/full-picture/dashboard/tickets`, and `/api/full-picture/dashboard/refresh-status` while keeping `/api/full-picture/dashboard` for compatibility.
- Modify: `backend/analytics_cli.py`
  - Add a unified `refresh-dashboard-snapshot` command that stages source, refreshes outcomes, prewarms summary cache, writes refresh metadata, and activates the snapshot version.
- Create: `backend/tests/test_analytics_dashboard_snapshot.py`
  - Covers snapshot metadata persistence, active version switching, and summary cache behavior.
- Modify: `backend/tests/test_analytics_full_picture_api.py`
  - Covers new summary/tickets/refresh-status endpoints and snapshot-version consistency.
- Modify: `backend/tests/test_analytics_schema.py`
  - Covers the new CLI command and refresh-state persistence.
- Modify: `src/components/dashboard/main-dashboard/mainDashboardTypes.ts`
  - Add summary payload, ticket page payload, and refresh-status frontend types.
- Modify: `src/components/dashboard/main-dashboard/mainDashboardApi.ts`
  - Split API calls into `fetchMainDashboardSummary`, `fetchMainDashboardTickets`, and `fetchMainDashboardRefreshStatus` while retaining compatibility helpers.
- Create: `src/components/dashboard/main-dashboard/useMainDashboardSummary.ts`
  - Loads and caches summary data.
- Create: `src/components/dashboard/main-dashboard/useMainDashboardTickets.ts`
  - Loads paginated ticket rows by server-side filters, search, sort, and pagination.
- Modify: `src/components/dashboard/pages/MainDashboard.tsx`
  - Use summary as the page-session version anchor and fetch ticket pages separately.
- Modify: `src/components/dashboard/main-dashboard/TicketDetailTable.tsx`
  - Convert from client-side pagination/search over all rows to a server-driven table surface.
- Create: `src/test/main-dashboard/useMainDashboardTickets.test.ts`
  - Covers the ticket query contract and version anchoring.
- Modify: `src/test/main-dashboard/MainDashboardDataLoading.test.tsx`
  - Covers summary-first page load and separate ticket-page load.
- Modify: `src/test/main-dashboard/TicketDetailTable.test.tsx`
  - Covers server-driven pagination/search/sort behavior.

### Task 1: Add snapshot state and summary cache foundations

**Files:**
- Create: `backend/analytics/dashboard_snapshot.py`
- Create: `backend/tests/test_analytics_dashboard_snapshot.py`

- [ ] **Step 1: Write the failing snapshot-state tests**

```python
from pathlib import Path

from backend.analytics.dashboard_snapshot import (
    activate_snapshot_version,
    get_summary_cache,
    normalize_summary_cache_key,
    record_snapshot_refresh,
    read_active_snapshot_state,
)


def test_record_snapshot_refresh_and_activate_snapshot_version(tmp_path):
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

    record_snapshot_refresh(
        hot_db,
        snapshot_version="snapshot-20260528-1",
        source_db_path="C:/data/qgate_raw.db",
        source_db_mtime="2026-05-28T00:00:00Z",
        refresh_status="ready",
        last_error=None,
    )
    activate_snapshot_version(hot_db, "snapshot-20260528-1")

    state = read_active_snapshot_state(hot_db)

    assert state["active_snapshot_version"] == "snapshot-20260528-1"
    assert state["refresh_status"] == "ready"
    assert state["source_db_path"] == "C:/data/qgate_raw.db"


def test_summary_cache_normalizes_filter_order():
    cache = get_summary_cache()
    key_a = normalize_summary_cache_key(
        snapshot_version="snapshot-1",
        filters={"years": ["2026"], "projects": ["IDCEVO", "MGU"]},
    )
    key_b = normalize_summary_cache_key(
        snapshot_version="snapshot-1",
        filters={"projects": ["MGU", "IDCEVO"], "years": ["2026"]},
    )

    cache[key_a] = {"overview": {"ticket_count": 1}}

    assert key_a == key_b
    assert cache[key_b]["overview"]["ticket_count"] == 1
```

- [ ] **Step 2: Run the focused backend test file to verify it fails**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_analytics_dashboard_snapshot.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'backend.analytics.dashboard_snapshot'`

- [ ] **Step 3: Implement snapshot-state persistence and summary cache helpers**

```python
# backend/analytics/dashboard_snapshot.py
from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
import json
import sqlite3


_summary_cache: dict[str, dict[str, object]] = {}


def get_summary_cache() -> dict[str, dict[str, object]]:
    return _summary_cache


def normalize_summary_cache_key(*, snapshot_version: str, filters: Mapping[str, object]) -> str:
    normalized = {
        key: sorted(str(value).strip() for value in (values or []) if str(value).strip())
        for key, values in sorted(filters.items())
    }
    return json.dumps({"snapshot_version": snapshot_version, "filters": normalized}, sort_keys=True)


def _ensure_snapshot_state_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS dashboard_snapshot_state (
            snapshot_version TEXT PRIMARY KEY,
            source_db_path TEXT NOT NULL,
            source_db_mtime TEXT NOT NULL,
            refresh_status TEXT NOT NULL,
            outcomes_refreshed_at TEXT,
            summary_cache_refreshed_at TEXT,
            last_success_at TEXT,
            last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS dashboard_snapshot_pointer (
            pointer_name TEXT PRIMARY KEY,
            snapshot_version TEXT NOT NULL
        );
        """
    )


def record_snapshot_refresh(
    hot_db_path: Path | str,
    *,
    snapshot_version: str,
    source_db_path: str,
    source_db_mtime: str,
    refresh_status: str,
    last_error: str | None,
) -> None:
    resolved_path = Path(hot_db_path)
    resolved_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(resolved_path)
    try:
        _ensure_snapshot_state_tables(conn)
        now_iso = datetime.now(timezone.utc).isoformat()
        conn.execute(
            """
            INSERT OR REPLACE INTO dashboard_snapshot_state(
                snapshot_version, source_db_path, source_db_mtime, refresh_status,
                outcomes_refreshed_at, summary_cache_refreshed_at, last_success_at, last_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                snapshot_version,
                source_db_path,
                source_db_mtime,
                refresh_status,
                now_iso,
                now_iso,
                now_iso if refresh_status == "ready" else None,
                last_error,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def activate_snapshot_version(hot_db_path: Path | str, snapshot_version: str) -> None:
    conn = sqlite3.connect(hot_db_path)
    try:
        _ensure_snapshot_state_tables(conn)
        conn.execute(
            "INSERT OR REPLACE INTO dashboard_snapshot_pointer(pointer_name, snapshot_version) VALUES ('active', ?)",
            (snapshot_version,),
        )
        conn.commit()
    finally:
        conn.close()


def read_active_snapshot_state(hot_db_path: Path | str) -> dict[str, object]:
    conn = sqlite3.connect(hot_db_path)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_snapshot_state_tables(conn)
        pointer = conn.execute(
            "SELECT snapshot_version FROM dashboard_snapshot_pointer WHERE pointer_name = 'active'"
        ).fetchone()
        if pointer is None:
            return {"active_snapshot_version": "", "refresh_status": "missing"}
        row = conn.execute(
            "SELECT * FROM dashboard_snapshot_state WHERE snapshot_version = ?",
            (pointer["snapshot_version"],),
        ).fetchone()
        return dict(row) | {"active_snapshot_version": row["snapshot_version"]} if row else {
            "active_snapshot_version": pointer["snapshot_version"],
            "refresh_status": "missing",
        }
    finally:
        conn.close()
```

- [ ] **Step 4: Run the focused snapshot test file to verify it passes**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_analytics_dashboard_snapshot.py -q`
Expected: PASS with `2 passed`

- [ ] **Step 5: Commit the snapshot-state foundation**

```bash
git add backend/analytics/dashboard_snapshot.py backend/tests/test_analytics_dashboard_snapshot.py
git commit -m "feat: add dashboard snapshot state foundation"
```

### Task 2: Add summary, tickets, and refresh-status backend endpoints

**Files:**
- Modify: `backend/analytics/read_models.py`
- Modify: `backend/analytics/api.py`
- Modify: `backend/tests/test_analytics_full_picture_api.py`

- [ ] **Step 1: Write the failing API tests for summary/tickets/refresh-status**

```python
def test_full_picture_summary_endpoint_returns_snapshot_version(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_full_picture_source_db(db_path)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _configure_full_picture_env(monkeypatch, defect_db_path=db_path, hot_db_path=hot_db_path)
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard/summary?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["snapshot_version"]
    assert payload["overview"]["ticket_count"] == 1
    assert "ticket_rows" not in payload


def test_full_picture_tickets_endpoint_returns_paged_rows(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_full_picture_source_db(db_path, defect_count=3)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _configure_full_picture_env(monkeypatch, defect_db_path=db_path, hot_db_path=hot_db_path)
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard/tickets?years=2026&page=1&page_size=2")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_rows"] == 3
    assert payload["page_size"] == 2
    assert len(payload["rows"]) == 2


def test_full_picture_refresh_status_endpoint_reads_active_snapshot(tmp_path, monkeypatch):
    hot_db_path = _default_hot_db_path(tmp_path)
    record_snapshot_refresh(
        hot_db_path,
        snapshot_version="snapshot-20260528-1",
        source_db_path="C:/data/qgate_raw.db",
        source_db_mtime="2026-05-28T00:00:00Z",
        refresh_status="ready",
        last_error=None,
    )
    activate_snapshot_version(hot_db_path, "snapshot-20260528-1")
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db_path))
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard/refresh-status")

    assert response.status_code == 200
    assert response.json()["active_snapshot_version"] == "snapshot-20260528-1"
```

- [ ] **Step 2: Run the focused endpoint tests to verify they fail**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_analytics_full_picture_api.py -q -k "summary_endpoint or tickets_endpoint or refresh_status_endpoint"`
Expected: FAIL with `404 Not Found` or import errors for missing helper functions.

- [ ] **Step 3: Add summary and tickets read-model helpers**

```python
# backend/analytics/read_models.py
from backend.analytics.dashboard_snapshot import read_active_snapshot_state


def _build_snapshot_version() -> str:
    state = read_active_snapshot_state(get_full_picture_hot_db_path())
    active = str(state.get("active_snapshot_version") or "").strip()
    if active:
        return active
    source_path = _resolve_defect_db_path()
    hot_path = get_full_picture_hot_db_path()
    return f"{source_path}:{hot_path}"


def build_full_picture_summary_payload(**kwargs: Any) -> dict[str, Any]:
    payload = build_full_picture_payload(**kwargs)
    return {
        "snapshot_version": _build_snapshot_version(),
        "refreshed_at": read_active_snapshot_state(get_full_picture_hot_db_path()).get("last_success_at"),
        "generated_from": payload["generated_from"],
        "refresh_metadata": read_active_snapshot_state(get_full_picture_hot_db_path()),
        "filters": payload["filters"],
        "overview": payload["overview"],
        "outcome_summary": payload["outcome_summary"],
        "team_outcome_rows": payload["team_outcome_rows"],
        "ticket_scope_count": len(payload["ticket_rows"]),
    }


def list_full_picture_ticket_rows(
    *,
    search: str = "",
    page: int = 1,
    page_size: int = 50,
    sort_by: str = "ticket_id",
    sort_order: str = "asc",
    **kwargs: Any,
) -> dict[str, Any]:
    payload = build_full_picture_payload(**kwargs)
    rows = payload["ticket_rows"]
    search_value = str(search or "").strip().lower()
    if search_value:
        rows = [
            row for row in rows
            if search_value in f"{row['ticket_id']} {row['ticket_name']}".lower()
        ]

    reverse = str(sort_order).lower() == "desc"
    rows = sorted(rows, key=lambda row: str(row.get(sort_by) or "").casefold(), reverse=reverse)

    total_rows = len(rows)
    safe_page_size = max(1, min(int(page_size), 100))
    safe_page = max(1, int(page))
    start = (safe_page - 1) * safe_page_size
    end = start + safe_page_size
    page_rows = rows[start:end]
    total_pages = max(1, (total_rows + safe_page_size - 1) // safe_page_size)

    return {
        "snapshot_version": _build_snapshot_version(),
        "refreshed_at": read_active_snapshot_state(get_full_picture_hot_db_path()).get("last_success_at"),
        "page": safe_page,
        "page_size": safe_page_size,
        "total_rows": total_rows,
        "total_pages": total_pages,
        "has_next_page": safe_page < total_pages,
        "rows": page_rows,
    }
```

- [ ] **Step 4: Wire the new FastAPI endpoints**

```python
# backend/analytics/api.py
from backend.analytics.dashboard_snapshot import read_active_snapshot_state
from backend.analytics.read_models import (
    build_full_picture_payload,
    build_full_picture_summary_payload,
    list_full_picture_ticket_rows,
)


@app.get("/api/full-picture/dashboard/summary")
def full_picture_dashboard_summary(request: Request) -> JSONResponse:
    try:
        payload = build_full_picture_summary_payload(**dict(request.query_params))
    except FullPictureDashboardDataError:
        return JSONResponse(status_code=503, content={"error": "analytics database not initialized"})
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/full-picture/dashboard/tickets")
def full_picture_dashboard_tickets(request: Request) -> JSONResponse:
    try:
        params = dict(request.query_params)
        payload = list_full_picture_ticket_rows(**params)
    except FullPictureDashboardDataError:
        return JSONResponse(status_code=503, content={"error": "analytics database not initialized"})
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/full-picture/dashboard/refresh-status")
def full_picture_dashboard_refresh_status() -> JSONResponse:
    return JSONResponse(status_code=200, content=read_active_snapshot_state(get_full_picture_hot_db_path()))
```

- [ ] **Step 5: Run the focused API tests to verify they pass**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_analytics_full_picture_api.py -q -k "summary_endpoint or tickets_endpoint or refresh_status_endpoint"`
Expected: PASS with `3 passed`

- [ ] **Step 6: Commit the new backend endpoints**

```bash
git add backend/analytics/read_models.py backend/analytics/api.py backend/tests/test_analytics_full_picture_api.py
git commit -m "feat: add paged main dashboard APIs"
```

### Task 3: Add unified snapshot refresh CLI and active-version switching

**Files:**
- Modify: `backend/analytics_cli.py`
- Modify: `backend/tests/test_analytics_schema.py`
- Modify: `backend/analytics/dashboard_snapshot.py`

- [ ] **Step 1: Write the failing CLI test for snapshot refresh orchestration**

```python
def test_refresh_dashboard_snapshot_stages_source_refreshes_outcomes_and_activates_snapshot(
    tmp_path,
    monkeypatch,
):
    upstream_db = tmp_path / "upstream_qgate.db"
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
    _seed_full_picture_source_db(upstream_db)

    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db))
    exit_code = main(["refresh-dashboard-snapshot", "--db-path", str(upstream_db)])

    assert exit_code == 0
    state = read_active_snapshot_state(hot_db)
    assert state["active_snapshot_version"]
    assert state["refresh_status"] == "ready"
```

- [ ] **Step 2: Run the focused CLI test to verify it fails**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_analytics_schema.py -q -k refresh_dashboard_snapshot`
Expected: FAIL with `Unknown command: refresh-dashboard-snapshot`

- [ ] **Step 3: Implement the unified refresh command**

```python
# backend/analytics_cli.py
from datetime import datetime, timezone

from backend.analytics.dashboard_snapshot import (
    activate_snapshot_version,
    normalize_summary_cache_key,
    record_snapshot_refresh,
    reset_summary_cache,
)
from backend.analytics.read_models import build_full_picture_summary_payload


def _refresh_dashboard_snapshot(source_db_path: Path) -> dict[str, object]:
    stage_summary = _stage_full_picture_source(source_db_path)
    outcomes_summary = refresh_materialized_outcomes(
        get_full_picture_source_db_path(),
        get_full_picture_hot_db_path(),
        force=True,
    )
    snapshot_version = outcomes_summary["source_signature"]
    summary_payload = build_full_picture_summary_payload(years="2026")
    reset_summary_cache()
    cache_key = normalize_summary_cache_key(
        snapshot_version=snapshot_version,
        filters={"years": ["2026"]},
    )
    get_summary_cache()[cache_key] = summary_payload
    source_mtime = datetime.fromtimestamp(
        get_full_picture_source_db_path().stat().st_mtime,
        tz=timezone.utc,
    ).isoformat()
    record_snapshot_refresh(
        get_full_picture_hot_db_path(),
        snapshot_version=snapshot_version,
        source_db_path=str(get_full_picture_source_db_path()),
        source_db_mtime=source_mtime,
        refresh_status="ready",
        last_error=None,
    )
    activate_snapshot_version(get_full_picture_hot_db_path(), snapshot_version)
    return {
        "stage": stage_summary,
        "outcomes": outcomes_summary,
        "snapshot_version": snapshot_version,
        "summary_cache_keys": [cache_key],
    }


if args.command == "refresh-dashboard-snapshot":
    source_db_path = (
        _require_valid_source_stage_input_path(args.db_path)
        if args.db_path
        else _require_source_stage_input_path()
    )
    summary = _refresh_dashboard_snapshot(source_db_path)
    print(json.dumps(summary, ensure_ascii=False))
    return 0
```

- [ ] **Step 4: Run the focused CLI test to verify it passes**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_analytics_schema.py -q -k refresh_dashboard_snapshot`
Expected: PASS with `1 passed`

- [ ] **Step 5: Commit the CLI orchestration slice**

```bash
git add backend/analytics_cli.py backend/tests/test_analytics_schema.py backend/analytics/dashboard_snapshot.py
git commit -m "feat: add dashboard snapshot refresh command"
```

### Task 4: Split frontend Main Dashboard data access into summary and tickets hooks

**Files:**
- Modify: `src/components/dashboard/main-dashboard/mainDashboardTypes.ts`
- Modify: `src/components/dashboard/main-dashboard/mainDashboardApi.ts`
- Create: `src/components/dashboard/main-dashboard/useMainDashboardSummary.ts`
- Create: `src/components/dashboard/main-dashboard/useMainDashboardTickets.ts`
- Create: `src/test/main-dashboard/useMainDashboardTickets.test.ts`

- [ ] **Step 1: Write the failing frontend data-hook tests**

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";

import { useMainDashboardSummary } from "@/components/dashboard/main-dashboard/useMainDashboardSummary";
import { useMainDashboardTickets } from "@/components/dashboard/main-dashboard/useMainDashboardTickets";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

describe("main dashboard data hooks", () => {
  beforeEach(() => {
    vi.mocked(useQuery).mockReset();
    vi.mocked(useQuery).mockReturnValue({} as ReturnType<typeof useQuery>);
  });

  it("loads summary data with the summary endpoint", () => {
    useMainDashboardSummary({ years: ["2026"] });

    expect(useQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["main-dashboard", "summary", { years: ["2026"] }] }),
    );
  });

  it("loads ticket pages with pagination and snapshot-version aware keys", () => {
    useMainDashboardTickets({ years: ["2026"] }, { page: 1, pageSize: 50, search: "wake", sortBy: "ticketId", sortOrder: "asc" });

    expect(useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["main-dashboard", "tickets", { years: ["2026"] }, { page: 1, pageSize: 50, search: "wake", sortBy: "ticketId", sortOrder: "asc" }],
      }),
    );
  });
});
```

- [ ] **Step 2: Run the focused hook test to verify it fails**

Run: `& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/main-dashboard/useMainDashboardTickets.test.ts`
Expected: FAIL with module import errors for missing hooks.

- [ ] **Step 3: Add summary and tickets frontend types plus API calls**

```typescript
// src/components/dashboard/main-dashboard/mainDashboardApi.ts
const MAIN_DASHBOARD_SUMMARY_API_PATH = "/api/full-picture/dashboard/summary";
const MAIN_DASHBOARD_TICKETS_API_PATH = "/api/full-picture/dashboard/tickets";
const MAIN_DASHBOARD_REFRESH_STATUS_API_PATH = "/api/full-picture/dashboard/refresh-status";

export async function fetchMainDashboardSummary(
  filters: Partial<MainDashboardFilters> = {},
): Promise<MainDashboardSummaryViewModel> {
  const response = await fetch(buildMainDashboardApiUrl(MAIN_DASHBOARD_SUMMARY_API_PATH, filters));
  if (!response.ok) throw new Error(`Full Picture summary request failed (${response.status} ${response.statusText})`);
  const payload = (await response.json()) as MainDashboardSummaryPayload;
  return adaptMainDashboardSummaryPayload(payload);
}

export async function fetchMainDashboardTickets(
  filters: Partial<MainDashboardFilters>,
  pageRequest: MainDashboardTicketsPageRequest,
): Promise<MainDashboardTicketsPage> {
  const url = new URL(buildMainDashboardApiUrl(MAIN_DASHBOARD_TICKETS_API_PATH, filters), "http://localhost");
  url.searchParams.set("page", String(pageRequest.page));
  url.searchParams.set("page_size", String(pageRequest.pageSize));
  if (pageRequest.search) url.searchParams.set("search", pageRequest.search);
  url.searchParams.set("sort_by", pageRequest.sortBy);
  url.searchParams.set("sort_order", pageRequest.sortOrder);
  const response = await fetch(`${url.pathname}${url.search}`);
  if (!response.ok) throw new Error(`Full Picture ticket request failed (${response.status} ${response.statusText})`);
  return (await response.json()) as MainDashboardTicketsPage;
}
```

```typescript
// src/components/dashboard/main-dashboard/useMainDashboardSummary.ts
import { useQuery } from "@tanstack/react-query";
import { fetchMainDashboardSummary } from "./mainDashboardApi";

export function useMainDashboardSummary(filters: Partial<MainDashboardFilters>) {
  return useQuery({
    queryKey: ["main-dashboard", "summary", filters],
    queryFn: () => fetchMainDashboardSummary(filters),
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 0,
  });
}
```

```typescript
// src/components/dashboard/main-dashboard/useMainDashboardTickets.ts
import { useQuery } from "@tanstack/react-query";
import { fetchMainDashboardTickets } from "./mainDashboardApi";

export function useMainDashboardTickets(
  filters: Partial<MainDashboardFilters>,
  pageRequest: MainDashboardTicketsPageRequest,
) {
  return useQuery({
    queryKey: ["main-dashboard", "tickets", filters, pageRequest],
    queryFn: () => fetchMainDashboardTickets(filters, pageRequest),
    keepPreviousData: true,
    staleTime: 30_000,
    retry: 0,
  });
}
```

- [ ] **Step 4: Run the focused hook test to verify it passes**

Run: `& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/main-dashboard/useMainDashboardTickets.test.ts`
Expected: PASS with `2 passed`

- [ ] **Step 5: Commit the frontend data-layer split**

```bash
git add src/components/dashboard/main-dashboard/mainDashboardTypes.ts src/components/dashboard/main-dashboard/mainDashboardApi.ts src/components/dashboard/main-dashboard/useMainDashboardSummary.ts src/components/dashboard/main-dashboard/useMainDashboardTickets.ts src/test/main-dashboard/useMainDashboardTickets.test.ts
git commit -m "feat: split main dashboard summary and ticket queries"
```

### Task 5: Move Main Dashboard and TicketDetailTable to server-driven ticket loading

**Files:**
- Modify: `src/components/dashboard/pages/MainDashboard.tsx`
- Modify: `src/components/dashboard/main-dashboard/TicketDetailTable.tsx`
- Modify: `src/test/main-dashboard/MainDashboardDataLoading.test.tsx`
- Modify: `src/test/main-dashboard/TicketDetailTable.test.tsx`

- [ ] **Step 1: Write the failing UI tests for summary-first load and server-driven table paging**

```typescript
it("loads summary first and then requests the first ticket page", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(createSummaryResponse())
    .mockResolvedValueOnce(createTicketsPageResponse());

  renderMainDashboard(createQueryClient());

  expect(await screen.findByText("Solution Outcome")).toBeInTheDocument();
  expect(fetch).toHaveBeenNthCalledWith(1, "/api/full-picture/dashboard/summary");
  expect(fetch).toHaveBeenNthCalledWith(2, "/api/full-picture/dashboard/tickets?page=1&page_size=50&sort_by=ticketId&sort_order=asc");
});


it("requests a new server page instead of paginating a client-side full dataset", async () => {
  const onPageChange = vi.fn();
  render(
    <TicketDetailTable
      rows={createTicketRowsPageOne()}
      totalRows={120}
      page={1}
      pageSize={50}
      onPageChange={onPageChange}
      onSearchChange={vi.fn()}
      onSortChange={vi.fn()}
      selection={{}}
      onClearSelection={() => {}}
    />,
  );

  await user.click(screen.getByRole("button", { name: /next page/i }));

  expect(onPageChange).toHaveBeenCalledWith(2);
});
```

- [ ] **Step 2: Run the focused UI tests to verify they fail**

Run: `& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/main-dashboard/MainDashboardDataLoading.test.tsx src/test/main-dashboard/TicketDetailTable.test.tsx`
Expected: FAIL because `MainDashboard` still fetches `/api/full-picture/dashboard` and `TicketDetailTable` still paginates an in-memory row set.

- [ ] **Step 3: Update MainDashboard and TicketDetailTable to server-driven detail loading**

```tsx
// src/components/dashboard/pages/MainDashboard.tsx
const summaryQuery = useMainDashboardSummary({});
const [ticketPageRequest, setTicketPageRequest] = useState({
  page: 1,
  pageSize: 50,
  search: "",
  sortBy: "ticketId",
  sortOrder: "asc" as const,
});

const summary = summaryQuery.data ?? emptySummaryViewModel;
const selectedFilters = createDefaultFilters(summary);
const ticketQuery = useMainDashboardTickets(selectedFilters, ticketPageRequest);

<TicketDetailTable
  rows={ticketQuery.data?.rows ?? []}
  totalRows={ticketQuery.data?.total_rows ?? 0}
  page={ticketQuery.data?.page ?? 1}
  pageSize={ticketQuery.data?.page_size ?? 50}
  onPageChange={(page) => setTicketPageRequest((current) => ({ ...current, page }))}
  onSearchChange={(search) => setTicketPageRequest((current) => ({ ...current, page: 1, search }))}
  onSortChange={(sortBy, sortOrder) => setTicketPageRequest((current) => ({ ...current, page: 1, sortBy, sortOrder }))}
  selection={selection}
  selectedOutcomeLabel={selectedOutcomeLabel}
  onClearSelection={() => setSelection({})}
/>
```

```tsx
// src/components/dashboard/main-dashboard/TicketDetailTable.tsx
type TicketDetailTableProps = {
  rows: MainDashboardTicketRow[];
  totalRows: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onSearchChange: (search: string) => void;
  onSortChange: (sortBy: string, sortOrder: "asc" | "desc") => void;
  selection: MainDashboardDrilldownSelection;
  selectedOutcomeLabel?: string | null;
  onClearSelection: () => void;
};

const totalPages = Math.max(Math.ceil(totalRows / pageSize), 1);

<Button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
  Next page
</Button>
```

- [ ] **Step 4: Run the focused UI tests to verify they pass**

Run: `& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/main-dashboard/MainDashboardDataLoading.test.tsx src/test/main-dashboard/TicketDetailTable.test.tsx`
Expected: PASS with the updated page-load and table interaction assertions.

- [ ] **Step 5: Run the broader Main Dashboard regression suite**

Run: `& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/main-dashboard/mainDashboardFiltering.test.ts src/test/main-dashboard/mainDashboardAdapter.test.ts src/test/main-dashboard/MainDashboardDataLoading.test.tsx src/test/main-dashboard/TicketDetailTable.test.tsx src/test/main-dashboard/useMainDashboardTickets.test.ts`
Expected: PASS with all touched Main Dashboard tests green.

- [ ] **Step 6: Commit the server-driven Main Dashboard UI slice**

```bash
git add src/components/dashboard/pages/MainDashboard.tsx src/components/dashboard/main-dashboard/TicketDetailTable.tsx src/test/main-dashboard/MainDashboardDataLoading.test.tsx src/test/main-dashboard/TicketDetailTable.test.tsx
git commit -m "feat: move main dashboard table to server pagination"
```

### Task 6: Final integration validation and compatibility check

**Files:**
- Modify: `backend/tests/test_analytics_full_picture_api.py`
- Modify: `src/test/main-dashboard/MainDashboardDataLoading.test.tsx`

- [ ] **Step 1: Add compatibility assertions for the legacy endpoint remaining intact**

```python
def test_full_picture_legacy_dashboard_endpoint_remains_available(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_full_picture_source_db(db_path)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _configure_full_picture_env(monkeypatch, defect_db_path=db_path, hot_db_path=hot_db_path)
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    assert "ticket_rows" in response.json()
```

- [ ] **Step 2: Run the full backend and frontend validation set**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_analytics_dashboard_snapshot.py backend/tests/test_analytics_full_picture_api.py backend/tests/test_analytics_schema.py -q`
Expected: PASS with all new snapshot-service backend tests green.

Run: `& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/main-dashboard/mainDashboardFiltering.test.ts src/test/main-dashboard/mainDashboardAdapter.test.ts src/test/main-dashboard/MainDashboardDataLoading.test.tsx src/test/main-dashboard/TicketDetailTable.test.tsx src/test/main-dashboard/useMainDashboardTickets.test.ts`
Expected: PASS with all Main Dashboard tests green.

Run: `& 'C:\nvm4w\nodejs\npm.cmd' run build`
Expected: PASS with Vite build success.

- [ ] **Step 3: Commit the final integrated slice**

```bash
git add backend/tests/test_analytics_full_picture_api.py src/test/main-dashboard/MainDashboardDataLoading.test.tsx docs/superpowers/plans/2026-05-28-main-dashboard-snapshot-service-implementation.md
git commit -m "feat: complete main dashboard snapshot service split"
```

## Plan Self-Review

### Spec coverage

The plan covers:

1. snapshot consumer and dashboard service repository role via Tasks 1 and 3;
2. `summary`, `tickets`, and `refresh-status` endpoint split via Task 2;
3. server-side pagination and frontend split loading via Tasks 4 and 5;
4. summary caching by snapshot version via Tasks 1 and 3;
5. refresh metadata and active version consistency via Tasks 1, 2, and 3;
6. backward-compatible preservation of `/api/full-picture/dashboard` via Task 6.

### Completeness scan

The task list contains no deferred follow-up markers. Every code step includes concrete code blocks, commands, and expected outcomes.

### Type consistency

The plan uses these stable names consistently across tasks:

1. `snapshot_version`
2. `build_full_picture_summary_payload`
3. `list_full_picture_ticket_rows`
4. `useMainDashboardSummary`
5. `useMainDashboardTickets`
6. `refresh-dashboard-snapshot`
