# TAP Testing Coverage Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current mock TAP coverage page with the real `Defect Explore -> Testing Coverage Analysis` core experience by migrating the filter bar and three core charts into Vizion Lab, backed by a dedicated `3003` analytics coverage-analysis API contract.

**Architecture:** Extend the local analytics database just enough to persist the testing coverage dimensions required by the TAP page, add a dedicated backend read-model/API family for grouped chart data, then rebuild the current `CoverageAnalysis.tsx` page as native React components that keep the existing Vizion Lab visual language. Keep all analytics work isolated on `3003` and leave the Main Dashboard and AI chat request paths unchanged.

**Tech Stack:** Python 3, FastAPI, SQLite, pytest, React 18, TypeScript, TanStack Query, Recharts, Vitest, Vite.

---

## Current State Snapshot

The TAP destination page already exists, but it is still mock-only:

- Existing: `src/components/dashboard/pages/CoverageAnalysis.tsx`
- Existing: `src/pages/Index.tsx`
- Existing: `backend/analytics/api.py`
- Existing: `backend/analytics/read_models.py`
- Existing: `backend/analytics/schema.py`
- Existing: `backend/analytics_cli.py`
- Existing: `backend/tests/test_analytics_schema.py`
- Existing: `backend/tests/test_analytics_testing_api.py`

The current generic testing APIs are insufficient for the TAP migration because they do not yet expose the grouped testing coverage-analysis contract used by the three reference charts.

## File Structure

### Existing files to modify

- Modify: `backend/analytics/api.py`
- Modify: `backend/analytics/schema.py`
- Modify: `backend/analytics_cli.py`
- Modify: `README.md`
- Modify: `src/components/dashboard/pages/CoverageAnalysis.tsx`

### New backend files to create

- Create: `backend/analytics/testing_coverage_models.py`
- Create: `backend/tests/test_analytics_tap_coverage_api.py`

### New frontend files to create

- Create: `src/components/dashboard/coverage-analysis/coverageAnalysisTypes.ts`
- Create: `src/components/dashboard/coverage-analysis/coverageAnalysisApi.ts`
- Create: `src/components/dashboard/coverage-analysis/useCoverageAnalysisData.ts`
- Create: `src/components/dashboard/coverage-analysis/coverageAnalysisSelection.ts`
- Create: `src/components/dashboard/coverage-analysis/CoverageAnalysisFilters.tsx`
- Create: `src/components/dashboard/coverage-analysis/CoverageAnalysisChartCard.tsx`
- Create: `src/components/dashboard/coverage-analysis/CoverageAnalysisEmptyState.tsx`
- Create: `src/test/coverage-analysis/coverageAnalysisApi.test.ts`
- Create: `src/test/coverage-analysis/coverageAnalysisSelection.test.ts`
- Create: `src/test/coverage-analysis/CoverageAnalysisPage.test.tsx`

### Existing frontend files to reuse without restructuring

- Reuse: `src/components/dashboard/main-dashboard/MultiSelectFilterField.tsx`
- Reuse: `src/test/setup.ts`
- Reuse: `vite.config.ts` because `/api/testing` already proxies to `3003`

## Task 1: Persist TAP Coverage Dimensions and Demo Seed Data

**Files:**

- Modify: `backend/analytics/schema.py`
- Modify: `backend/analytics_cli.py`
- Modify: `backend/tests/test_analytics_schema.py`
- Modify: `README.md`

- [ ] **Step 1: Write the failing schema and seed tests for TAP coverage fields**

```python
# backend/tests/test_analytics_schema.py
import sqlite3

from backend.analytics_cli import main
from backend.analytics.schema import ensure_schema


def test_ensure_schema_adds_tap_coverage_columns_to_manual_runs(tmp_path):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info('octane_manual_runs')").fetchall()
        }
    finally:
        conn.close()

    assert {
        "year",
        "test_week",
        "pu",
        "top_aida",
        "feature_region",
        "tester",
    }.issubset(columns)


def test_seed_testing_command_writes_tap_coverage_dimensions(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))

    assert main(["init-db"]) == 0
    assert main(["seed-testing"]) == 0

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT year, test_week, project, pu, top_aida, feature_region, tester, fv, fvp FROM octane_manual_runs WHERE mr_id='MR-DEMO-1'"
        ).fetchone()
    finally:
        conn.close()

    assert row == (
        2026,
        "2026-CW21",
        "IDCEVO",
        "PU1",
        "Use Speech operation [01.04.02.01.01.05]",
        "China Specific",
        "Tester-A",
        "Speech",
        "Voice Experience",
    )
```

- [ ] **Step 2: Run the schema test file to verify it fails first**

Run: `python -m pytest backend/tests/test_analytics_schema.py -q`
Expected: FAIL because `octane_manual_runs` does not yet expose the TAP coverage columns and `seed-testing` does not populate them.

- [ ] **Step 3: Extend the analytics schema and seed flow with TAP coverage dimensions**

```python
# backend/analytics/schema.py
from __future__ import annotations

from pathlib import Path
import sqlite3

from backend.analytics.db import connect


MANUAL_RUN_DIMENSION_COLUMNS = (
    ("year", "year INTEGER"),
    ("test_week", "test_week TEXT"),
    ("pu", "pu TEXT"),
    ("top_aida", "top_aida TEXT"),
    ("feature_region", "feature_region TEXT"),
    ("tester", "tester TEXT"),
)


def _ensure_columns(
    conn: sqlite3.Connection,
    table_name: str,
    columns: tuple[tuple[str, str], ...],
) -> None:
    existing = {
        str(row[1]).strip()
        for row in conn.execute(f"PRAGMA table_info('{table_name}')").fetchall()
    }
    for column_name, column_sql in columns:
        if column_name in existing:
            continue
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_sql}")


def ensure_schema(db_path: Path | str) -> None:
    conn = connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                project TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );
            """
        )
        _ensure_columns(conn, "octane_manual_runs", MANUAL_RUN_DIMENSION_COLUMNS)
        conn.commit()
    finally:
        conn.close()
```

```python
# backend/analytics_cli.py
from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from datetime import datetime, timezone

from backend.analytics.config import get_analytics_db_path
from backend.analytics.db import connect
from backend.analytics.processor import sync_dimension_fields
from backend.analytics.schema import ensure_schema


def _get_feature_region(top_aida: str) -> str:
    china_specific = {
        "Use Speech operation [01.04.02.01.01.05]",
    }
    return "China Specific" if top_aida in china_specific else "Global"


def seed_testing_rows() -> None:
    db_path = get_analytics_db_path()
    ensure_schema(db_path)

    fetched_at = datetime(2026, 5, 25, 0, 0, tzinfo=timezone.utc).isoformat()
    top_aida = "Use Speech operation [01.04.02.01.01.05]"
    conn = connect(db_path)
    try:
        conn.execute(
            """
            INSERT OR REPLACE INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, project,
                fv, fvp, team, lead_model, year, test_week, pu,
                top_aida, feature_region, tester, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-DEMO-1",
                "D-DEMO-1",
                "T-DEMO-1",
                "Demo wake test",
                "Passed",
                "IDCEVO",
                "Speech",
                "Voice Experience",
                "DTSV_China",
                "NA5",
                2026,
                "2026-CW21",
                "PU1",
                top_aida,
                _get_feature_region(top_aida),
                "Tester-A",
                json.dumps({"seed": True, "status": "Passed", "test_week": "2026-CW21"}),
                fetched_at,
            ),
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO octane_testcases(
                test_id, scope_team, scope_release, source, test_name,
                run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "T-DEMO-1",
                "DTSV_China",
                "ALL",
                "seed",
                "Demo wake test",
                1,
                json.dumps(["D-DEMO-1"]),
                json.dumps(["F-DEMO-1"]),
                json.dumps(["S-DEMO-1"]),
                json.dumps({"seed": True, "top_aida": top_aida}),
                fetched_at,
            ),
        )
        conn.commit()
    finally:
        conn.close()
```

```text
README.md

Initialize and seed minimum TAP coverage analysis data:

python backend/analytics_cli.py init-db
python backend/analytics_cli.py seed-testing
```

- [ ] **Step 4: Run the schema test file again**

Run: `python -m pytest backend/tests/test_analytics_schema.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/analytics/schema.py backend/analytics_cli.py backend/tests/test_analytics_schema.py README.md
git commit -m "feat: persist tap coverage dimensions in analytics seed data"
```

## Task 2: Add TAP Coverage-Analysis Backend Endpoints

**Files:**

- Create: `backend/analytics/testing_coverage_models.py`
- Create: `backend/tests/test_analytics_tap_coverage_api.py`
- Modify: `backend/analytics/api.py`

- [ ] **Step 1: Write the failing backend coverage-analysis API tests**

```python
# backend/tests/test_analytics_tap_coverage_api.py
import sqlite3

from fastapi.testclient import TestClient

from backend.analytics.api import app
from backend.analytics.schema import ensure_schema


def seed_manual_runs(db_path):
    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, project, fv, fvp,
                team, lead_model, year, test_week, pu, top_aida, feature_region,
                tester, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-1", "D-1", "T-1", "Wake test", "Passed", "IDCEVO", "Speech", "Voice Experience",
                    "DTSV_China", "NA5", 2026, "2026-CW21", "PU1", "Use Speech operation [01.04.02.01.01.05]",
                    "China Specific", "Tester-A", '{"seed": true}', "2026-05-25T00:00:00Z"
                ),
                (
                    "MR-2", "D-1", "T-1", "Wake test", "Failed", "IDCEVO", "Speech", "Voice Experience",
                    "DTSV_China", "NA5", 2026, "2026-CW21", "PU1", "Use Speech operation [01.04.02.01.01.05]",
                    "China Specific", "Tester-A", '{"seed": true}', "2026-05-25T00:00:00Z"
                ),
                (
                    "MR-3", "D-2", "T-2", "Music test", "Passed", "IDCEVO", "Media", "Entertainment",
                    "DTSV_China", "NA5", 2026, "2026-CW22", "PU2", "Connected Music China [01.04.01.06.04]",
                    "China Specific", "Tester-B", '{"seed": true}', "2026-05-25T00:00:00Z"
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()


def test_tap_coverage_analysis_endpoints_return_grouped_rows(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)
    seed_manual_runs(db_path)
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))

    client = TestClient(app)
    filters = client.get("/api/testing/coverage-analysis/filters")
    project_status = client.get("/api/testing/coverage-analysis/project-status", params={"years": "2026"})
    aida_status = client.get("/api/testing/coverage-analysis/aida-status", params={"years": "2026"})
    testcase_detail = client.get("/api/testing/coverage-analysis/testcase-detail", params={"years": "2026"})

    assert filters.status_code == 200
    assert filters.json()["years"] == ["2026"]
    assert filters.json()["test_weeks"] == ["2026-CW21", "2026-CW22"]
    assert project_status.status_code == 200
    assert project_status.json()[0] == {
        "test_week": "2026-CW21",
        "fv": "Speech",
        "fvp": "Voice Experience",
        "status": "Failed",
        "count": 1,
    }
    assert aida_status.status_code == 200
    assert aida_status.json()[0]["top_aida"] == "Connected Music China [01.04.01.06.04]"
    assert testcase_detail.status_code == 200
    assert testcase_detail.json()[0]["test_id"] == "T-1"


def test_tap_coverage_analysis_reports_non_ready_when_dimensions_are_missing(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))

    client = TestClient(app)
    response = client.get("/api/testing/coverage-analysis/filters")

    assert response.status_code == 503
    assert response.json() == {
        "error": "testing coverage analysis data not ready",
        "missing_fields": ["year", "test_week", "project", "pu", "top_aida", "feature_region", "fvp", "fv", "status", "test_id", "test_name", "tester"],
    }
```

- [ ] **Step 2: Run the new backend API test file to verify it fails**

Run: `python -m pytest backend/tests/test_analytics_tap_coverage_api.py -q`
Expected: FAIL with `404 Not Found` because the coverage-analysis endpoints do not exist yet.

- [ ] **Step 3: Implement the coverage-analysis read model and API routes**

```python
# backend/analytics/testing_coverage_models.py
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import sqlite3

from backend.analytics.config import get_analytics_db_path


REQUIRED_COVERAGE_COLUMNS = (
    "year",
    "test_week",
    "project",
    "pu",
    "top_aida",
    "feature_region",
    "fvp",
    "fv",
    "status",
    "test_id",
    "test_name",
    "tester",
)


class TestingCoverageDataError(ValueError):
    def __init__(self, missing_fields: list[str]):
        super().__init__("testing coverage analysis data not ready")
        self.missing_fields = missing_fields


@dataclass(frozen=True)
class CoverageAnalysisQuery:
    years: tuple[str, ...] = ()
    projects: tuple[str, ...] = ()
    test_weeks: tuple[str, ...] = ()
    pus: tuple[str, ...] = ()
    aidas: tuple[str, ...] = ()
    statuses: tuple[str, ...] = ()
    feature_regions: tuple[str, ...] = ()
    fvps: tuple[str, ...] = ()
    fvs: tuple[str, ...] = ()


def _normalize_multi_value(raw_value: Any) -> tuple[str, ...]:
    if raw_value is None:
        return ()
    if isinstance(raw_value, str):
        items = raw_value.split(",")
    else:
        items = raw_value
    values: list[str] = []
    seen: set[str] = set()
    for item in items:
        value = str(item).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        values.append(value)
    return tuple(values)


def normalize_coverage_query(**kwargs: Any) -> CoverageAnalysisQuery:
    return CoverageAnalysisQuery(
        years=_normalize_multi_value(kwargs.get("years")),
        projects=_normalize_multi_value(kwargs.get("projects")),
        test_weeks=_normalize_multi_value(kwargs.get("test_weeks")),
        pus=_normalize_multi_value(kwargs.get("pus")),
        aidas=_normalize_multi_value(kwargs.get("aidas")),
        statuses=_normalize_multi_value(kwargs.get("statuses")),
        feature_regions=_normalize_multi_value(kwargs.get("feature_regions")),
        fvps=_normalize_multi_value(kwargs.get("fvps")),
        fvs=_normalize_multi_value(kwargs.get("fvs")),
    )


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(get_analytics_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def _require_coverage_dimensions() -> None:
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM octane_manual_runs LIMIT 1").fetchone()
    finally:
        conn.close()
    if row is None:
        raise TestingCoverageDataError(list(REQUIRED_COVERAGE_COLUMNS))

    missing = [field for field in REQUIRED_COVERAGE_COLUMNS if str(row[field] or "").strip() == ""]
    if missing:
        raise TestingCoverageDataError(missing)


def _build_where(query: CoverageAnalysisQuery) -> tuple[str, list[Any]]:
    clauses = ["1=1"]
    params: list[Any] = []
    mapping = (
        ("year", query.years),
        ("project", query.projects),
        ("test_week", query.test_weeks),
        ("pu", query.pus),
        ("top_aida", query.aidas),
        ("status", query.statuses),
        ("feature_region", query.feature_regions),
        ("fvp", query.fvps),
        ("fv", query.fvs),
    )
    for column_name, values in mapping:
        if not values:
            continue
        placeholders = ", ".join("?" for _ in values)
        clauses.append(f"CAST({column_name} AS TEXT) IN ({placeholders})")
        params.extend(values)
    return " AND ".join(clauses), params


def build_coverage_analysis_filters() -> dict[str, list[str]]:
    _require_coverage_dimensions()
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT DISTINCT year, project, test_week, pu, top_aida, status, feature_region, fvp, fv FROM octane_manual_runs"
        ).fetchall()
    finally:
        conn.close()
    return {
        "years": sorted({str(row["year"]).strip() for row in rows if str(row["year"] or "").strip()}),
        "projects": sorted({row["project"] for row in rows if row["project"]}),
        "test_weeks": sorted({row["test_week"] for row in rows if row["test_week"]}),
        "pus": sorted({row["pu"] for row in rows if row["pu"]}),
        "aidas": sorted({row["top_aida"] for row in rows if row["top_aida"]}),
        "statuses": sorted({row["status"] for row in rows if row["status"]}),
        "feature_regions": sorted({row["feature_region"] for row in rows if row["feature_region"]}),
        "fvps": sorted({row["fvp"] for row in rows if row["fvp"]}),
        "fvs": sorted({row["fv"] for row in rows if row["fv"]}),
    }


def list_project_status_rows(query: CoverageAnalysisQuery) -> list[dict[str, object]]:
    _require_coverage_dimensions()
    where_sql, params = _build_where(query)
    conn = _connect()
    try:
        rows = conn.execute(
            f"""
            SELECT test_week, fv, fvp, status, COUNT(*) AS count
            FROM octane_manual_runs
            WHERE {where_sql}
            GROUP BY test_week, fv, fvp, status
            ORDER BY test_week, fv, status
            """,
            params,
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def list_aida_status_rows(query: CoverageAnalysisQuery) -> list[dict[str, object]]:
    _require_coverage_dimensions()
    where_sql, params = _build_where(query)
    conn = _connect()
    try:
        rows = conn.execute(
            f"""
            SELECT test_week, top_aida, status, COUNT(*) AS count
            FROM octane_manual_runs
            WHERE {where_sql}
            GROUP BY test_week, top_aida, status
            ORDER BY test_week, top_aida, status
            """,
            params,
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def list_testcase_detail_rows(query: CoverageAnalysisQuery) -> list[dict[str, object]]:
    _require_coverage_dimensions()
    where_sql, params = _build_where(query)
    conn = _connect()
    try:
        rows = conn.execute(
            f"""
            SELECT test_id, test_name, test_week, status, top_aida, project, pu, tester, COUNT(*) AS count
            FROM octane_manual_runs
            WHERE {where_sql}
            GROUP BY test_id, test_name, test_week, status, top_aida, project, pu, tester
            ORDER BY test_id, test_week, status
            """,
            params,
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]
```

```python
# backend/analytics/api.py
from backend.analytics.testing_coverage_models import (
    TestingCoverageDataError,
    build_coverage_analysis_filters,
    list_aida_status_rows,
    list_project_status_rows,
    list_testcase_detail_rows,
    normalize_coverage_query,
)


@app.get("/api/testing/coverage-analysis/filters")
def coverage_analysis_filters() -> dict[str, list[str]]:
    try:
        return build_coverage_analysis_filters()
    except TestingCoverageDataError as exc:
        return JSONResponse(
            status_code=503,
            content={"error": str(exc), "missing_fields": exc.missing_fields},
        )


@app.get("/api/testing/coverage-analysis/project-status")
def coverage_analysis_project_status(request: Request) -> JSONResponse:
    try:
        rows = list_project_status_rows(normalize_coverage_query(**dict(request.query_params)))
    except TestingCoverageDataError as exc:
        return JSONResponse(
            status_code=503,
            content={"error": str(exc), "missing_fields": exc.missing_fields},
        )
    return JSONResponse(status_code=200, content=rows)


@app.get("/api/testing/coverage-analysis/aida-status")
def coverage_analysis_aida_status(request: Request) -> JSONResponse:
    try:
        rows = list_aida_status_rows(normalize_coverage_query(**dict(request.query_params)))
    except TestingCoverageDataError as exc:
        return JSONResponse(
            status_code=503,
            content={"error": str(exc), "missing_fields": exc.missing_fields},
        )
    return JSONResponse(status_code=200, content=rows)


@app.get("/api/testing/coverage-analysis/testcase-detail")
def coverage_analysis_testcase_detail(request: Request) -> JSONResponse:
    try:
        rows = list_testcase_detail_rows(normalize_coverage_query(**dict(request.query_params)))
    except TestingCoverageDataError as exc:
        return JSONResponse(
            status_code=503,
            content={"error": str(exc), "missing_fields": exc.missing_fields},
        )
    return JSONResponse(status_code=200, content=rows)
```

- [ ] **Step 4: Run the backend TAP coverage API suite**

Run: `python -m pytest backend/tests/test_analytics_tap_coverage_api.py backend/tests/test_analytics_schema.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/analytics/api.py backend/analytics/testing_coverage_models.py backend/tests/test_analytics_tap_coverage_api.py
git commit -m "feat: add tap coverage analysis analytics endpoints"
```

## Task 3: Add Frontend Coverage-Analysis Types, API Client, and Selection Logic

**Files:**

- Create: `src/components/dashboard/coverage-analysis/coverageAnalysisTypes.ts`
- Create: `src/components/dashboard/coverage-analysis/coverageAnalysisApi.ts`
- Create: `src/components/dashboard/coverage-analysis/useCoverageAnalysisData.ts`
- Create: `src/components/dashboard/coverage-analysis/coverageAnalysisSelection.ts`
- Create: `src/test/coverage-analysis/coverageAnalysisApi.test.ts`
- Create: `src/test/coverage-analysis/coverageAnalysisSelection.test.ts`

- [ ] **Step 1: Write the failing frontend API and selection tests**

```ts
// src/test/coverage-analysis/coverageAnalysisApi.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { fetchCoverageAnalysisPageData } from "@/components/dashboard/coverage-analysis/coverageAnalysisApi";

describe("fetchCoverageAnalysisPageData", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the four TAP coverage-analysis endpoints with shared query params", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ years: ["2026"], projects: ["IDCEVO"], test_weeks: ["2026-CW21"], pus: ["PU1"], aidas: ["AIDA-1"], statuses: ["Passed"], feature_regions: ["China Specific"], fvps: ["Voice Experience"], fvs: ["Speech"] })))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ test_week: "2026-CW21", fv: "Speech", fvp: "Voice Experience", status: "Passed", count: 1 }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ test_week: "2026-CW21", top_aida: "AIDA-1", status: "Passed", count: 1 }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ test_id: "T-1", test_name: "Wake test", test_week: "2026-CW21", status: "Passed", top_aida: "AIDA-1", project: "IDCEVO", pu: "PU1", tester: "Tester-A", count: 1 }])));

    const data = await fetchCoverageAnalysisPageData({ years: ["2026"], projects: ["IDCEVO"] });

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/testing/coverage-analysis/filters?years=2026&projects=IDCEVO");
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/testing/coverage-analysis/project-status?years=2026&projects=IDCEVO");
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/testing/coverage-analysis/aida-status?years=2026&projects=IDCEVO");
    expect(fetch).toHaveBeenNthCalledWith(4, "/api/testing/coverage-analysis/testcase-detail?years=2026&projects=IDCEVO");
    expect(data.projectStatusRows[0].fv).toBe("Speech");
  });
});
```

```ts
// src/test/coverage-analysis/coverageAnalysisSelection.test.ts
import { describe, expect, it } from "vitest";

import {
  applyAidaPointSelection,
  applyFvPointSelection,
} from "@/components/dashboard/coverage-analysis/coverageAnalysisSelection";

describe("coverageAnalysisSelection", () => {
  it("replaces the fv selection from chart 1 clicks", () => {
    expect(applyFvPointSelection(["Media"], "Speech")).toEqual(["Speech"]);
  });

  it("replaces the aida selection from chart 2 clicks", () => {
    expect(applyAidaPointSelection(["AIDA-OLD"], "AIDA-NEW")).toEqual(["AIDA-NEW"]);
  });
});
```

- [ ] **Step 2: Run the new frontend unit tests to verify they fail**

Run: `npm test -- src/test/coverage-analysis/coverageAnalysisApi.test.ts src/test/coverage-analysis/coverageAnalysisSelection.test.ts`
Expected: FAIL because the coverage-analysis frontend modules do not exist yet.

- [ ] **Step 3: Implement the frontend types, client, hook, and selection helpers**

```ts
// src/components/dashboard/coverage-analysis/coverageAnalysisTypes.ts
export type CoverageAnalysisFilters = {
  years: string[];
  projects: string[];
  testWeeks: string[];
  pus: string[];
  aidas: string[];
  statuses: string[];
  featureRegions: string[];
  fvps: string[];
  fvs: string[];
};

export type CoverageAnalysisFilterOptions = CoverageAnalysisFilters;

export type ProjectStatusRow = {
  test_week: string;
  fv: string;
  fvp: string;
  status: string;
  count: number;
};

export type AidaStatusRow = {
  test_week: string;
  top_aida: string;
  status: string;
  count: number;
};

export type TestcaseDetailRow = {
  test_id: string;
  test_name: string;
  test_week: string;
  status: string;
  top_aida: string;
  project: string;
  pu: string;
  tester: string;
  count: number;
};

export type CoverageAnalysisPageData = {
  filterOptions: CoverageAnalysisFilterOptions;
  projectStatusRows: ProjectStatusRow[];
  aidaStatusRows: AidaStatusRow[];
  testcaseDetailRows: TestcaseDetailRow[];
};
```

```ts
// src/components/dashboard/coverage-analysis/coverageAnalysisApi.ts
import type {
  CoverageAnalysisFilters,
  CoverageAnalysisPageData,
  CoverageAnalysisFilterOptions,
  ProjectStatusRow,
  AidaStatusRow,
  TestcaseDetailRow,
} from "./coverageAnalysisTypes";

const filterKeyMap = {
  years: "years",
  projects: "projects",
  testWeeks: "test_weeks",
  pus: "pus",
  aidas: "aidas",
  statuses: "statuses",
  featureRegions: "feature_regions",
  fvps: "fvps",
  fvs: "fvs",
} as const;

function buildCoverageAnalysisUrl(basePath: string, filters: Partial<CoverageAnalysisFilters>) {
  const params = new URLSearchParams();
  for (const [viewKey, payloadKey] of Object.entries(filterKeyMap)) {
    const values = filters[viewKey as keyof CoverageAnalysisFilters];
    if (values?.length) {
      params.set(payloadKey, values.join(","));
    }
  }
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchCoverageAnalysisPageData(
  filters: Partial<CoverageAnalysisFilters> = {},
): Promise<CoverageAnalysisPageData> {
  const [filterOptions, projectStatusRows, aidaStatusRows, testcaseDetailRows] = await Promise.all([
    fetchJson<CoverageAnalysisFilterOptions>(buildCoverageAnalysisUrl("/api/testing/coverage-analysis/filters", filters)),
    fetchJson<ProjectStatusRow[]>(buildCoverageAnalysisUrl("/api/testing/coverage-analysis/project-status", filters)),
    fetchJson<AidaStatusRow[]>(buildCoverageAnalysisUrl("/api/testing/coverage-analysis/aida-status", filters)),
    fetchJson<TestcaseDetailRow[]>(buildCoverageAnalysisUrl("/api/testing/coverage-analysis/testcase-detail", filters)),
  ]);

  return { filterOptions, projectStatusRows, aidaStatusRows, testcaseDetailRows };
}

export { buildCoverageAnalysisUrl };
```

```ts
// src/components/dashboard/coverage-analysis/useCoverageAnalysisData.ts
import { useQuery } from "@tanstack/react-query";

import { fetchCoverageAnalysisPageData } from "./coverageAnalysisApi";
import type { CoverageAnalysisFilters } from "./coverageAnalysisTypes";

export function useCoverageAnalysisData(filters: Partial<CoverageAnalysisFilters>) {
  return useQuery({
    queryKey: ["coverage-analysis", filters],
    queryFn: () => fetchCoverageAnalysisPageData(filters),
    staleTime: 60_000,
    retry: 0,
  });
}
```

```ts
// src/components/dashboard/coverage-analysis/coverageAnalysisSelection.ts
export function applyFvPointSelection(_currentValues: string[], nextValue: string) {
  return nextValue ? [nextValue] : [];
}

export function applyAidaPointSelection(_currentValues: string[], nextValue: string) {
  return nextValue ? [nextValue] : [];
}
```

- [ ] **Step 4: Run the frontend unit tests again**

Run: `npm test -- src/test/coverage-analysis/coverageAnalysisApi.test.ts src/test/coverage-analysis/coverageAnalysisSelection.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/coverage-analysis src/test/coverage-analysis/coverageAnalysisApi.test.ts src/test/coverage-analysis/coverageAnalysisSelection.test.ts
git commit -m "feat: add tap coverage analysis data client and selection helpers"
```

## Task 4: Replace the Mock TAP Page with Live Filters and Three Charts

**Files:**

- Create: `src/components/dashboard/coverage-analysis/CoverageAnalysisFilters.tsx`
- Create: `src/components/dashboard/coverage-analysis/CoverageAnalysisChartCard.tsx`
- Create: `src/components/dashboard/coverage-analysis/CoverageAnalysisEmptyState.tsx`
- Create: `src/test/coverage-analysis/CoverageAnalysisPage.test.tsx`
- Modify: `src/components/dashboard/pages/CoverageAnalysis.tsx`

- [ ] **Step 1: Write the failing page test for the live TAP experience**

```tsx
// src/test/coverage-analysis/CoverageAnalysisPage.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import CoverageAnalysis from "@/components/dashboard/pages/CoverageAnalysis";

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CoverageAnalysis />
    </QueryClientProvider>,
  );
}

describe("CoverageAnalysis", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the filter bar and the three live chart cards", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ years: ["2026"], projects: ["IDCEVO"], testWeeks: [], pus: [], aidas: [], statuses: [], featureRegions: [], fvps: [], fvs: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ test_week: "2026-CW21", fv: "Speech", fvp: "Voice Experience", status: "Passed", count: 1 }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ test_week: "2026-CW21", top_aida: "AIDA-1", status: "Passed", count: 1 }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ test_id: "T-1", test_name: "Wake test", test_week: "2026-CW21", status: "Passed", top_aida: "AIDA-1", project: "IDCEVO", pu: "PU1", tester: "Tester-A", count: 1 }])));

    renderPage();

    expect(await screen.findByText("按周和功能分类的测试状态")).toBeInTheDocument();
    expect(screen.getByText("按 Top AIDA 和测试周分类的状态")).toBeInTheDocument();
    expect(screen.getByText("按测试用例和测试周分类的状态")).toBeInTheDocument();
    expect(screen.getByLabelText("年份 filter")).toBeInTheDocument();
  });

  it("shows the backend non-ready message when coverage data is incomplete", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "testing coverage analysis data not ready", missing_fields: ["test_week"] }), { status: 503 }),
    );

    renderPage();

    expect(await screen.findByText("Testing coverage analysis is not ready yet.")).toBeInTheDocument();
    expect(screen.getByText(/test_week/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the page test to verify it fails**

Run: `npm test -- src/test/coverage-analysis/CoverageAnalysisPage.test.tsx`
Expected: FAIL because the current TAP page still renders mock KPI cards and unrelated charts.

- [ ] **Step 3: Replace the mock TAP page with the live filter-plus-three-chart page**

```tsx
// src/components/dashboard/coverage-analysis/CoverageAnalysisFilters.tsx
import type { CoverageAnalysisFilterOptions, CoverageAnalysisFilters } from "./coverageAnalysisTypes";
import MultiSelectFilterField from "@/components/dashboard/main-dashboard/MultiSelectFilterField";

const filterFields: Array<{ key: keyof CoverageAnalysisFilters; label: string }> = [
  { key: "years", label: "年份" },
  { key: "projects", label: "项目" },
  { key: "testWeeks", label: "测试周" },
  { key: "pus", label: "PU" },
  { key: "aidas", label: "Top AIDA" },
  { key: "statuses", label: "状态" },
  { key: "featureRegions", label: "Feature Region" },
  { key: "fvps", label: "FVP" },
  { key: "fvs", label: "FV" },
];

export default function CoverageAnalysisFilters({
  availableFilters,
  selectedFilters,
  onToggleValue,
}: {
  availableFilters: CoverageAnalysisFilterOptions;
  selectedFilters: CoverageAnalysisFilters;
  onToggleValue: <K extends keyof CoverageAnalysisFilters>(field: K, value: string) => void;
}) {
  return (
    <div className="dashboard-card p-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filterFields.map(({ key, label }) => (
          <MultiSelectFilterField
            key={key}
            label={label}
            options={availableFilters[key]}
            selectedValues={selectedFilters[key]}
            onToggleValue={(value) => onToggleValue(key, value)}
          />
        ))}
      </div>
    </div>
  );
}
```

```tsx
// src/components/dashboard/coverage-analysis/CoverageAnalysisChartCard.tsx
import type { ReactNode } from "react";

export default function CoverageAnalysisChartCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="dashboard-card p-5">
      <h3 className="mb-4 text-sm font-semibold text-foreground">{title}</h3>
      <div className="h-[360px]">{children}</div>
    </div>
  );
}
```

```tsx
// src/components/dashboard/coverage-analysis/CoverageAnalysisEmptyState.tsx
export default function CoverageAnalysisEmptyState({ message }: { message: string }) {
  return (
    <div className="dashboard-card p-8 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">Testing coverage analysis is not ready yet.</p>
      <p className="mt-2">{message}</p>
    </div>
  );
}
```

```tsx
// src/components/dashboard/pages/CoverageAnalysis.tsx
import { useMemo, useState } from "react";
import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip } from "recharts";

import CoverageAnalysisChartCard from "@/components/dashboard/coverage-analysis/CoverageAnalysisChartCard";
import CoverageAnalysisEmptyState from "@/components/dashboard/coverage-analysis/CoverageAnalysisEmptyState";
import CoverageAnalysisFilters from "@/components/dashboard/coverage-analysis/CoverageAnalysisFilters";
import { applyAidaPointSelection, applyFvPointSelection } from "@/components/dashboard/coverage-analysis/coverageAnalysisSelection";
import { useCoverageAnalysisData } from "@/components/dashboard/coverage-analysis/useCoverageAnalysisData";
import type { CoverageAnalysisFilters as CoverageAnalysisFiltersType } from "@/components/dashboard/coverage-analysis/coverageAnalysisTypes";

const emptyFilters: CoverageAnalysisFiltersType = {
  years: [],
  projects: [],
  testWeeks: [],
  pus: [],
  aidas: [],
  statuses: [],
  featureRegions: [],
  fvps: [],
  fvs: [],
};

export default function CoverageAnalysis() {
  const [selectedFilters, setSelectedFilters] = useState<CoverageAnalysisFiltersType>(emptyFilters);
  const { data, error, isLoading } = useCoverageAnalysisData(selectedFilters);

  const toggleFilterValue = <K extends keyof CoverageAnalysisFiltersType>(field: K, value: string) => {
    setSelectedFilters((current) => {
      const nextValues = current[field].includes(value)
        ? current[field].filter((item) => item !== value)
        : [...current[field], value];
      return { ...current, [field]: nextValues };
    });
  };

  const projectStatusRows = data?.projectStatusRows ?? [];
  const aidaStatusRows = data?.aidaStatusRows ?? [];
  const testcaseDetailRows = data?.testcaseDetailRows ?? [];

  const readinessMessage = error instanceof Error ? error.message : null;

  if (isLoading) {
    return <div className="dashboard-card p-6 text-sm text-muted-foreground">Loading testing coverage analysis...</div>;
  }

  if (readinessMessage) {
    return <CoverageAnalysisEmptyState message={readinessMessage} />;
  }

  const filterOptions = data?.filterOptions ?? emptyFilters;

  return (
    <div className="space-y-5">
      <CoverageAnalysisFilters
        availableFilters={filterOptions}
        selectedFilters={selectedFilters}
        onToggleValue={toggleFilterValue}
      />

      <CoverageAnalysisChartCard title="按周和功能分类的测试状态">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
            <XAxis dataKey="test_week" name="测试周" />
            <YAxis dataKey="fv" name="FV" />
            <ZAxis dataKey="count" range={[80, 400]} />
            <Tooltip />
            <Scatter
              data={projectStatusRows}
              fill="hsl(215, 70%, 48%)"
              onClick={(row) => setSelectedFilters((current) => ({
                ...current,
                fvs: applyFvPointSelection(current.fvs, String(row.fv || "")),
              }))}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </CoverageAnalysisChartCard>

      <CoverageAnalysisChartCard title="按 Top AIDA 和测试周分类的状态">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
            <XAxis dataKey="test_week" name="测试周" />
            <YAxis dataKey="top_aida" name="Top AIDA" />
            <ZAxis dataKey="count" range={[80, 400]} />
            <Tooltip />
            <Scatter
              data={aidaStatusRows}
              fill="hsl(152, 60%, 40%)"
              onClick={(row) => setSelectedFilters((current) => ({
                ...current,
                aidas: applyAidaPointSelection(current.aidas, String(row.top_aida || "")),
              }))}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </CoverageAnalysisChartCard>

      <CoverageAnalysisChartCard title="按测试用例和测试周分类的状态">
        <div className="h-full overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-2">Testcase</th>
                <th className="px-4 py-2">Week</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Top AIDA</th>
                <th className="px-4 py-2">Project</th>
                <th className="px-4 py-2">PU</th>
                <th className="px-4 py-2">Tester</th>
                <th className="px-4 py-2">Count</th>
              </tr>
            </thead>
            <tbody>
              {testcaseDetailRows.map((row) => (
                <tr key={`${row.test_id}-${row.test_week}-${row.status}`} className="border-b border-border/50">
                  <td className="px-4 py-2">{row.test_name}</td>
                  <td className="px-4 py-2">{row.test_week}</td>
                  <td className="px-4 py-2">{row.status}</td>
                  <td className="px-4 py-2">{row.top_aida}</td>
                  <td className="px-4 py-2">{row.project}</td>
                  <td className="px-4 py-2">{row.pu}</td>
                  <td className="px-4 py-2">{row.tester}</td>
                  <td className="px-4 py-2">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CoverageAnalysisChartCard>
    </div>
  );
}
```

- [ ] **Step 4: Run the TAP page tests, then the focused analytics and frontend checks**

Run: `npm test -- src/test/coverage-analysis/CoverageAnalysisPage.test.tsx src/test/coverage-analysis/coverageAnalysisApi.test.ts src/test/coverage-analysis/coverageAnalysisSelection.test.ts`
Expected: PASS

Run: `python -m pytest backend/tests/test_analytics_schema.py backend/tests/test_analytics_tap_coverage_api.py -q`
Expected: PASS

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/coverage-analysis src/components/dashboard/pages/CoverageAnalysis.tsx src/test/coverage-analysis/CoverageAnalysisPage.test.tsx
git commit -m "feat: migrate tap testing coverage analysis core charts"
```

## Spec Coverage Check

1. Replace the mock TAP page with a real testing coverage analysis page: covered by Task 4.
2. Preserve the current Vizion Lab frontend visual language: covered by Task 4 through reuse of the existing page shell, `dashboard-card`, and `MultiSelectFilterField` patterns.
3. Migrate the testing coverage filter bar and three core charts: covered by Tasks 3 and 4.
4. Add dedicated backend analytics endpoints for TAP: covered by Task 2.
5. Validate backend data completeness against the required dimensions: covered by Tasks 1 and 2.
6. Keep AI chat and Main Dashboard unaffected: covered by Task 2 validation boundaries and by not touching the `3004` server files or the Main Dashboard data contract.

## Plan Self-Review

1. The plan is limited to the user-approved TAP scope and does not pull in the extra KPI strip, pie chart, wordcloud, or export features.
2. The plan adds a TAP-specific backend contract instead of overloading the current generic testing endpoints.
3. The plan includes explicit backend and frontend validation for non-ready states, grouped chart rows, and interaction narrowing.

Plan complete and saved to `docs/superpowers/plans/2026-05-25-tap-testing-coverage-migration-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
