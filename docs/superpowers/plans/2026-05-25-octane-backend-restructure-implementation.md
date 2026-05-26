# Octane Backend Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebase the in-progress local `3003` analytics migration so the current defect-centric Main Dashboard keeps working, while the repository gains a stable Octane SQLite foundation, processor backfill, and additive testing APIs that do not interfere with the existing `3004` AI chat API.

**Architecture:** Keep the already-migrated Python analytics service under `backend/analytics` as the `3003` service boundary and treat it as the source of truth for analytics work in this repository. Preserve the existing Node service under `server/` on `3004` for AI chat, harden the current Full Picture compatibility layer first, then add processor and testing read models incrementally.

**Tech Stack:** Python 3, FastAPI, SQLite, pytest, Node dev launcher, Vite proxy, existing React/Vitest frontend.

---

## Current State Snapshot

The repository already contains a partially migrated analytics backend:

- Existing: `backend/analytics/api.py`
- Existing: `backend/analytics/config.py`
- Existing: `backend/analytics/db.py`
- Existing: `backend/analytics/schema.py`
- Existing: `backend/analytics/read_models.py`
- Existing: `backend/analytics_cli.py`
- Existing: `backend/tests/test_analytics_full_picture_api.py`
- Existing: `backend/tests/test_analytics_schema.py`
- Existing: `scripts/dev.mjs`
- Existing: `package.json` with `dev:analytics`

The implementation plan below starts from this reality. It does **not** repeat the already-completed service/bootstrap work.

## File Structure

### Existing files to modify

- Modify: `backend/analytics/api.py`
- Modify: `backend/analytics/config.py`
- Modify: `backend/analytics/read_models.py`
- Modify: `backend/analytics/schema.py`
- Modify: `backend/analytics_cli.py`
- Modify: `scripts/dev.mjs`
- Modify: `vite.config.ts`
- Modify: `README.md`
- Modify: `.gitignore`

### New files to create

- Create: `backend/analytics/processor.py`
- Create: `backend/tests/test_analytics_processor.py`
- Create: `backend/tests/test_analytics_testing_api.py`

### Runtime outputs

- Runtime DB: `backend/database/octane_data.db`
- Runtime analytics API entrypoint: `python -m uvicorn backend.analytics.api:app --host 127.0.0.1 --port 3003`
- Runtime AI API entrypoint: `node ./server/index.mjs` on `3004`

## Task 1: Stabilize the Current 3003 Analytics Bootstrap

**Files:**

- Modify: `backend/analytics/config.py`
- Modify: `backend/analytics_cli.py`
- Modify: `scripts/dev.mjs`
- Modify: `README.md`

- [ ] **Step 1: Extend the existing analytics tests to cover the current bootstrap contract**

```python
# backend/tests/test_analytics_schema.py
from backend.analytics.config import get_analytics_db_path
from backend.analytics_cli import main


def test_cli_uses_runtime_db_env_path(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))

    exit_code = main(["init-db"])

    assert exit_code == 0
    assert get_analytics_db_path() == db_path
    assert db_path.exists()
```

```python
# backend/tests/test_analytics_full_picture_api.py
from fastapi.testclient import TestClient

from backend.analytics.api import app


def test_health_endpoint_returns_ok():
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "analytics"}


def test_full_picture_dashboard_returns_503_when_all_db_candidates_are_missing(monkeypatch):
    missing = "C:/__missing__/octane_data.db"
    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", missing)
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", missing)

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard")

    assert response.status_code == 503
    assert response.json() == {"error": "analytics database not initialized"}
```

- [ ] **Step 2: Run tests to verify at least one fails against the current bootstrap mismatch**

Run: `python -m pytest backend/tests/test_analytics_schema.py backend/tests/test_analytics_full_picture_api.py -q`
Expected: FAIL because `backend.analytics_cli.main()` does not currently accept argv and still imports a stale `ANALYTICS_DB_PATH` symbol.

- [ ] **Step 3: Fix config and CLI wiring to match the current migrated backend shape**

```python
# backend/analytics/config.py
from __future__ import annotations

import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ANALYTICS_DB_PATH = REPO_ROOT / "backend" / "database" / "octane_data.db"
ANALYTICS_PORT = int(os.environ.get("VIZION_ANALYTICS_PORT", "3003"))


def get_analytics_db_path() -> Path:
    return Path(os.environ.get("VIZION_ANALYTICS_DB_PATH", DEFAULT_ANALYTICS_DB_PATH))
```

```python
# backend/analytics_cli.py
from __future__ import annotations

import argparse
from collections.abc import Sequence

from backend.analytics.config import get_analytics_db_path
from backend.analytics.schema import ensure_schema


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", default="init-db")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.command == "init-db":
        ensure_schema(get_analytics_db_path())
        return 0

    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
```

```js
// scripts/dev.mjs
launch(
  resolvePythonCommand(),
  [
    "-m",
    "uvicorn",
    "backend.analytics.api:app",
    "--host",
    "127.0.0.1",
    "--port",
    process.env.VIZION_ANALYTICS_PORT || "3003",
  ],
  "analytics-api",
);
launch(process.execPath, [path.join(repoRoot, "server", "index.mjs")], "local-api");
launch(process.execPath, [path.join(repoRoot, "node_modules", "vite", "bin", "vite.js")], "vite");
```

```text
<!-- README.md -->
## Local backend services

- `3003`: repository-local analytics API
- `3004`: AI chat and duplicate-search API

Initialize analytics schema:
python backend/analytics_cli.py init-db
```

- [ ] **Step 4: Run tests and syntax check to verify the bootstrap is stable**

Run: `python -m pytest backend/tests/test_analytics_schema.py backend/tests/test_analytics_full_picture_api.py -q`
Expected: PASS

Run: `node --check scripts/dev.mjs`
Expected: no output

- [ ] **Step 5: Commit**

```bash
git add backend/analytics/config.py backend/analytics_cli.py scripts/dev.mjs README.md backend/tests/test_analytics_schema.py backend/tests/test_analytics_full_picture_api.py
git commit -m "fix: stabilize migrated analytics bootstrap"
```

## Task 2: Lock Full Picture Compatibility Against the Current DB Candidate Logic

**Files:**

- Modify: `backend/analytics/read_models.py`
- Modify: `backend/analytics/config.py`
- Modify: `backend/tests/test_analytics_full_picture_api.py`

- [ ] **Step 1: Add failing regression tests for the current Full Picture compatibility path**

```python
# backend/tests/test_analytics_full_picture_api.py
import sqlite3


def test_full_picture_dashboard_reads_original_sqlite_shape(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                status_phase TEXT,
                problem_finder_team TEXT,
                year TEXT,
                assigned_ecu TEXT,
                top_aida TEXT,
                aida_english TEXT,
                aida_businesskey TEXT,
                phase TEXT,
                solution_cluster TEXT,
                lead_model TEXT,
                project TEXT,
                pu TEXT,
                market TEXT,
                last_modified TEXT,
                creation_time TEXT
            );
            CREATE TABLE octane_defect_history_events (
                defect_id TEXT,
                field_name TEXT,
                event_timestamp TEXT,
                entry_index INTEGER,
                change_index INTEGER,
                old_value TEXT,
                new_value TEXT,
                old_value_text TEXT,
                new_value_text TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO octane_defects(defect_id, name, status_phase, problem_finder_team, year, assigned_ecu, top_aida, aida_english, aida_businesskey, phase, solution_cluster, lead_model, project, pu, market, last_modified, creation_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("D-1", "Wake issue", "03-In Analysis", "DTSV_China", "2026", "ECU-A", "Speech", "", "", "03-In Analysis", "Integration", "NA5", "IDCEVO", "PU1", "CN", "2026-05-25T00:00:00Z", "2026-05-24T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO octane_defect_history_events(defect_id, field_name, event_timestamp, entry_index, change_index, old_value, new_value, old_value_text, new_value_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("D-1", "status_phase", "2026-05-25T00:00:00Z", 1, 1, "08", "06", "08-Resolved Forward", "06-Ready for Test"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(db_path))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(db_path))

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["overview"]["ticket_count"] == 1
    assert payload["ticket_rows"][0]["ticket_id"] == "D-1"
    assert payload["ticket_rows"][0]["is_resolved_forward"] is True
```

```python
def test_full_picture_prefers_local_octane_db_when_explicitly_configured(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO octane_defects(defect_id, name, project, market, pu, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("D-2", "Local issue", "IDCEVO", "CN", "PU1", "Speech", "Tony", "DTSV_China", "NA5", '{"status_phase":"03-In Analysis","year":"2026","problem_finder_team":"DTSV_China","assigned_ecu":"ECU-A","top_aida":"Speech","phase":"03-In Analysis","solution_cluster":"Integration"}', "2026-05-25T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, raw_event_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("D-2", "2026-05-25T00:00:00Z", "status_phase", "08", "06", "{}", "2026-05-25T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(db_path))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(db_path))

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    assert response.json()["ticket_rows"][0]["ticket_id"] == "D-2"
```

- [ ] **Step 2: Run tests to verify the current compatibility contract before changing behavior**

Run: `python -m pytest backend/tests/test_analytics_full_picture_api.py -q`
Expected: PASS or one localized FAIL that exposes a real compatibility mismatch in the current migrated read model.

- [ ] **Step 3: Tighten config/read-model behavior only if the regression test exposes a mismatch**

```python
# backend/analytics/config.py
def get_full_picture_defect_db_candidates() -> tuple[Path, ...]:
    configured = str(os.environ.get("VIZION_FULL_PICTURE_DEFECT_DB_PATH", "")).strip()
    if configured:
        return (Path(configured),)

    return _dedupe_paths(
        [
            get_analytics_db_path(),
            REPO_ROOT / "qgate" / "qgate_data.db",
            REPO_ROOT.parent / "TPMDashbaord" / "qgate" / "qgate_data.db",
            REPO_ROOT.parent / "TPMDashboard" / "qgate" / "qgate_data.db",
        ]
    )
```

```python
# backend/analytics/read_models.py
class FullPictureDashboardDataError(ValueError):
    pass


def _require_database_path(db_path: Path | None, database_kind: str) -> Path:
    if db_path is None:
        raise FullPictureDashboardDataError(f"Full Picture {database_kind} database is not available")
    return db_path
```

- [ ] **Step 4: Run the focused regression suite again**

Run: `python -m pytest backend/tests/test_analytics_full_picture_api.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/analytics/config.py backend/analytics/read_models.py backend/tests/test_analytics_full_picture_api.py
git commit -m "test: lock full picture compatibility during migration"
```

## Task 3: Add Shared Processor Backfill for Defects and Runs

**Files:**

- Create: `backend/analytics/processor.py`
- Create: `backend/tests/test_analytics_processor.py`
- Modify: `backend/analytics/schema.py`
- Modify: `backend/analytics_cli.py`

- [ ] **Step 1: Write the failing processor tests**

```python
# backend/tests/test_analytics_processor.py
import sqlite3

from backend.analytics.processor import sync_dimension_fields
from backend.analytics.schema import ensure_schema


def test_sync_dimension_fields_backfills_defects_and_runs(tmp_path):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO octane_defects(defect_id, name, project, market, pu, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("D-1", "Wake issue", "", "", "", "", "", "", "", "{}", "2026-05-25T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, project, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("MR-1", "D-1", "T-1", "Wake test", "Passed", "", "", "", "", "", "{}", "2026-05-25T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    sync_dimension_fields(
        db_path,
        defect_dimension_rows=[{"id": "D-1", "project": "IDCEVO", "market": "CN", "pu": "PU1", "fv": "Speech", "fvp": "Tony", "team": "DTSV_China", "lead_model": "NA5"}],
        run_dimension_rows=[{"id": "MR-1", "project": "IDCEVO", "fv": "Speech", "fvp": "Tony", "team": "DTSV_China", "lead_model": "NA5"}],
    )

    conn = sqlite3.connect(db_path)
    try:
        defect = conn.execute("SELECT project, market, pu, fv, fvp, team, lead_model FROM octane_defects WHERE defect_id='D-1'").fetchone()
        run = conn.execute("SELECT project, fv, fvp, team, lead_model FROM octane_manual_runs WHERE mr_id='MR-1'").fetchone()
    finally:
        conn.close()

    assert defect == ("IDCEVO", "CN", "PU1", "Speech", "Tony", "DTSV_China", "NA5")
    assert run == ("IDCEVO", "Speech", "Tony", "DTSV_China", "NA5")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_analytics_processor.py -q`
Expected: FAIL with `ModuleNotFoundError` because `backend.analytics.processor` does not exist yet.

- [ ] **Step 3: Implement the minimal shared processor and wire a CLI command for explicit backfill**

```python
# backend/analytics/processor.py
from __future__ import annotations

import sqlite3
from pathlib import Path


def sync_dimension_fields(db_path: Path | str, defect_dimension_rows: list[dict], run_dimension_rows: list[dict]) -> dict[str, int]:
    conn = sqlite3.connect(db_path)
    try:
        defect_payload = [
            (
                row.get("project", ""),
                row.get("market", ""),
                row.get("pu", ""),
                row.get("fv", ""),
                row.get("fvp", ""),
                row.get("team", ""),
                row.get("lead_model", ""),
                row["id"],
            )
            for row in defect_dimension_rows
        ]
        run_payload = [
            (
                row.get("project", ""),
                row.get("fv", ""),
                row.get("fvp", ""),
                row.get("team", ""),
                row.get("lead_model", ""),
                row["id"],
            )
            for row in run_dimension_rows
        ]

        conn.executemany(
            "UPDATE octane_defects SET project=?, market=?, pu=?, fv=?, fvp=?, team=?, lead_model=? WHERE defect_id=?",
            defect_payload,
        )
        defect_updates = conn.total_changes
        conn.executemany(
            "UPDATE octane_manual_runs SET project=?, fv=?, fvp=?, team=?, lead_model=? WHERE mr_id=?",
            run_payload,
        )
        run_updates = conn.total_changes - defect_updates
        conn.commit()
        return {"defect_updates": defect_updates, "run_updates": run_updates}
    finally:
        conn.close()
```

```python
# backend/analytics_cli.py
from backend.analytics.processor import sync_dimension_fields


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", default="init-db")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.command == "init-db":
        ensure_schema(get_analytics_db_path())
        return 0
    if args.command == "sync-dimensions":
        sync_dimension_fields(get_analytics_db_path(), [], [])
        return 0

    raise SystemExit(f"Unknown command: {args.command}")
```

- [ ] **Step 4: Run the processor test and the existing schema tests**

Run: `python -m pytest backend/tests/test_analytics_processor.py backend/tests/test_analytics_schema.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/analytics/processor.py backend/analytics_cli.py backend/tests/test_analytics_processor.py backend/tests/test_analytics_schema.py
git commit -m "feat: add analytics dimension backfill processor"
```

## Task 4: Add Testing Summary and Drilldown APIs

**Files:**

- Create: `backend/tests/test_analytics_testing_api.py`
- Modify: `backend/analytics/api.py`
- Modify: `backend/analytics/read_models.py`
- Modify: `vite.config.ts`

- [ ] **Step 1: Write the failing testing API tests**

```python
# backend/tests/test_analytics_testing_api.py
import sqlite3

from fastapi.testclient import TestClient

from backend.analytics.api import app
from backend.analytics.schema import ensure_schema


def test_testing_summary_and_testcase_endpoints_return_real_data(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, project, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("MR-1", "D-1", "T-1", "Wake test", "Passed", "IDCEVO", "Speech", "Tony", "DTSV_China", "NA5", "{}", "2026-05-25T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO octane_testcases(test_id, scope_team, scope_release, source, test_name, run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("T-1", "DTSV_China", "ALL", "runs", "Wake test", 1, '[\"D-1\"]', '[\"F-1\"]', '[\"S-1\"]', '{\"test_id\":\"T-1\"}', "2026-05-25T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(db_path))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(db_path))

    client = TestClient(app)
    summary = client.get("/api/testing/summary")
    testcases = client.get("/api/testing/testcases")
    runs = client.get("/api/testing/runs")

    assert summary.status_code == 200
    assert summary.json()["total_runs"] == 1
    assert summary.json()["total_testcases"] == 1
    assert testcases.status_code == 200
    assert testcases.json()[0]["test_id"] == "T-1"
    assert runs.status_code == 200
    assert runs.json()[0]["mr_id"] == "MR-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_analytics_testing_api.py -q`
Expected: FAIL with `404 Not Found` because `/api/testing/*` routes do not exist yet.

- [ ] **Step 3: Implement additive testing read models and API routes**

```python
# backend/analytics/read_models.py
def _open_local_analytics_db() -> sqlite3.Connection:
    db_path = get_analytics_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def build_testing_summary() -> dict[str, int]:
    conn = _open_local_analytics_db()
    try:
        total_runs = conn.execute("SELECT COUNT(*) FROM octane_manual_runs").fetchone()[0]
        total_testcases = conn.execute("SELECT COUNT(*) FROM octane_testcases").fetchone()[0]
    finally:
        conn.close()
    return {"total_runs": total_runs, "total_testcases": total_testcases}


def list_testing_testcases() -> list[dict[str, Any]]:
    conn = _open_local_analytics_db()
    try:
        rows = conn.execute(
            "SELECT test_id, test_name, run_count, defect_ids_json, feature_ids_json, story_ids_json FROM octane_testcases ORDER BY test_id"
        ).fetchall()
    finally:
        conn.close()

    return [
        {
            "test_id": row["test_id"],
            "test_name": row["test_name"],
            "run_count": row["run_count"],
            "defect_ids": json.loads(row["defect_ids_json"]),
            "feature_ids": json.loads(row["feature_ids_json"]),
            "story_ids": json.loads(row["story_ids_json"]),
        }
        for row in rows
    ]


def list_testing_runs() -> list[dict[str, Any]]:
    conn = _open_local_analytics_db()
    try:
        rows = conn.execute(
            "SELECT mr_id, defect_id, test_id, test_name, status, project, fv, fvp, team, lead_model FROM octane_manual_runs ORDER BY mr_id"
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]
```

```python
# backend/analytics/api.py
from backend.analytics.read_models import (
    FullPictureDashboardDataError,
    build_full_picture_payload,
    build_testing_summary,
    list_testing_runs,
    list_testing_testcases,
)


@app.get("/api/testing/summary")
def testing_summary() -> dict[str, int]:
    return build_testing_summary()


@app.get("/api/testing/testcases")
def testing_testcases() -> list[dict[str, object]]:
    return list_testing_testcases()


@app.get("/api/testing/runs")
def testing_runs() -> list[dict[str, object]]:
    return list_testing_runs()
```

```ts
// vite.config.ts
proxy: {
  "/api/full-picture": {
    target: "http://127.0.0.1:3003",
    changeOrigin: true,
  },
  "/api/testing": {
    target: "http://127.0.0.1:3003",
    changeOrigin: true,
  },
}
```

- [ ] **Step 4: Run the testing API suite**

Run: `python -m pytest backend/tests/test_analytics_testing_api.py backend/tests/test_analytics_full_picture_api.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/analytics/api.py backend/analytics/read_models.py backend/tests/test_analytics_testing_api.py vite.config.ts
git commit -m "feat: add testing analytics endpoints"
```

## Task 5: Add Metadata and Correlation APIs Without Touching the 3004 AI Service

**Files:**

- Modify: `backend/analytics/api.py`
- Modify: `backend/analytics/read_models.py`
- Modify: `vite.config.ts`
- Modify: `README.md`
- Modify: `backend/tests/test_analytics_testing_api.py`

- [ ] **Step 1: Extend the testing API test file with failing metadata/correlation tests**

```python
def test_metadata_and_correlation_endpoints_are_available(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO octane_defects(defect_id, name, project, market, pu, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("D-1", "Wake issue", "IDCEVO", "CN", "PU1", "Speech", "Tony", "DTSV_China", "NA5", '{"status_phase":"03-In Analysis","year":"2026","problem_finder_team":"DTSV_China","assigned_ecu":"ECU-A","top_aida":"Speech","phase":"03-In Analysis","solution_cluster":"Integration"}', "2026-05-25T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO octane_testcases(test_id, scope_team, scope_release, source, test_name, run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("T-1", "DTSV_China", "ALL", "runs", "Wake test", 1, '[\"D-1\"]', '[\"F-1\"]', '[\"S-1\"]', '{\"test_id\":\"T-1\"}', "2026-05-25T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(db_path))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(db_path))

    client = TestClient(app)
    metadata = client.get("/api/metadata/filters")
    correlation = client.get("/api/correlation/defect-test", params={"defect_id": "D-1"})

    assert metadata.status_code == 200
    assert metadata.json()["projects"] == ["IDCEVO"]
    assert correlation.status_code == 200
    assert correlation.json() == {"defect_id": "D-1", "test_ids": ["T-1"]}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_analytics_testing_api.py -q`
Expected: FAIL with `404 Not Found` for `/api/metadata/filters` and `/api/correlation/defect-test`.

- [ ] **Step 3: Implement metadata/correlation routes and keep AI chat fully untouched**

```python
# backend/analytics/read_models.py
def build_filter_metadata() -> dict[str, list[str]]:
    conn = _open_local_analytics_db()
    try:
        rows = conn.execute(
            "SELECT DISTINCT project, market, pu, fv, fvp, team, lead_model FROM octane_defects ORDER BY project"
        ).fetchall()
    finally:
        conn.close()

    return {
        "projects": sorted({row["project"] for row in rows if row["project"]}),
        "markets": sorted({row["market"] for row in rows if row["market"]}),
        "pus": sorted({row["pu"] for row in rows if row["pu"]}),
        "fvs": sorted({row["fv"] for row in rows if row["fv"]}),
        "fvps": sorted({row["fvp"] for row in rows if row["fvp"]}),
        "teams": sorted({row["team"] for row in rows if row["team"]}),
        "lead_models": sorted({row["lead_model"] for row in rows if row["lead_model"]}),
    }


def build_defect_test_correlation(defect_id: str) -> dict[str, Any]:
    conn = _open_local_analytics_db()
    try:
        rows = conn.execute(
            "SELECT test_id, defect_ids_json FROM octane_testcases ORDER BY test_id"
        ).fetchall()
    finally:
        conn.close()

    test_ids = [
        row["test_id"]
        for row in rows
        if defect_id in json.loads(row["defect_ids_json"])
    ]
    return {"defect_id": defect_id, "test_ids": test_ids}
```

```python
# backend/analytics/api.py
from fastapi import FastAPI, Query, Request

from backend.analytics.read_models import (
    FullPictureDashboardDataError,
    build_defect_test_correlation,
    build_filter_metadata,
    build_full_picture_payload,
    build_testing_summary,
    list_testing_runs,
    list_testing_testcases,
)


@app.get("/api/metadata/filters")
def metadata_filters() -> dict[str, list[str]]:
    return build_filter_metadata()


@app.get("/api/correlation/defect-test")
def defect_test_correlation(defect_id: str = Query(...)) -> dict[str, object]:
    return build_defect_test_correlation(defect_id)
```

```ts
// vite.config.ts
proxy: {
  "/api/full-picture": { target: "http://127.0.0.1:3003", changeOrigin: true },
  "/api/testing": { target: "http://127.0.0.1:3003", changeOrigin: true },
  "/api/metadata": { target: "http://127.0.0.1:3003", changeOrigin: true },
  "/api/correlation": { target: "http://127.0.0.1:3003", changeOrigin: true },
}
```

```text
<!-- README.md -->
Do not route AI chat through the analytics service.

- `3003` serves `/api/full-picture`, `/api/testing`, `/api/metadata`, `/api/correlation`
- `3004` serves `/api/ai/*`, `/api/chat`, `/api/duplicate-*`
```

- [ ] **Step 4: Run the focused analytics test suite and keep AI chat checks separate**

Run: `python -m pytest backend/tests/test_analytics_full_picture_api.py backend/tests/test_analytics_testing_api.py backend/tests/test_analytics_processor.py backend/tests/test_analytics_schema.py -q`
Expected: PASS

Run: `& 'C:\nvm4w\nodejs\node.exe' '.\node_modules\vitest\vitest.mjs' run src/test/ai-chat/AIChat.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/analytics/api.py backend/analytics/read_models.py backend/tests/test_analytics_testing_api.py vite.config.ts README.md
git commit -m "feat: add metadata and correlation analytics apis"
```

## Task 6: Add Explicit Local Data Seeding Until Real Octane Sync Lands

**Files:**

- Modify: `backend/analytics_cli.py`
- Modify: `README.md`
- Modify: `backend/tests/test_analytics_schema.py`

- [ ] **Step 1: Add a failing CLI test for minimum viable local test data seeding**

```python
# backend/tests/test_analytics_schema.py
import sqlite3


def test_seed_testing_command_writes_minimum_rows(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))

    from backend.analytics_cli import main

    assert main(["init-db"]) == 0
    assert main(["seed-testing"]) == 0

    conn = sqlite3.connect(db_path)
    try:
        run_count = conn.execute("SELECT COUNT(*) FROM octane_manual_runs").fetchone()[0]
        testcase_count = conn.execute("SELECT COUNT(*) FROM octane_testcases").fetchone()[0]
    finally:
        conn.close()

    assert run_count >= 1
    assert testcase_count >= 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_analytics_schema.py -q`
Expected: FAIL with `Unknown command: seed-testing`.

- [ ] **Step 3: Implement an explicit seed command for migration-phase verification**

```python
# backend/analytics_cli.py
from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from datetime import datetime, timezone

from backend.analytics.config import get_analytics_db_path
from backend.analytics.db import connect
from backend.analytics.schema import ensure_schema


def seed_testing_rows() -> None:
    db_path = get_analytics_db_path()
    ensure_schema(db_path)
    conn = connect(db_path)
    try:
        now_text = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT OR REPLACE INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, project, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("MR-DEMO-1", "D-DEMO-1", "T-DEMO-1", "Demo wake test", "Passed", "IDCEVO", "Speech", "Tony", "DTSV_China", "NA5", json.dumps({"seed": True}), now_text),
        )
        conn.execute(
            "INSERT OR REPLACE INTO octane_testcases(test_id, scope_team, scope_release, source, test_name, run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("T-DEMO-1", "DTSV_China", "ALL", "seed", "Demo wake test", 1, json.dumps(["D-DEMO-1"]), json.dumps(["F-DEMO-1"]), json.dumps(["S-DEMO-1"]), json.dumps({"seed": True}), now_text),
        )
        conn.commit()
    finally:
        conn.close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", default="init-db")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.command == "init-db":
        ensure_schema(get_analytics_db_path())
        return 0
    if args.command == "sync-dimensions":
        sync_dimension_fields(get_analytics_db_path(), [], [])
        return 0
    if args.command == "seed-testing":
        seed_testing_rows()
        return 0

    raise SystemExit(f"Unknown command: {args.command}")
```

```text
<!-- README.md -->
Seed minimum testing data for local API verification:
python backend/analytics_cli.py init-db
python backend/analytics_cli.py seed-testing
```

- [ ] **Step 4: Run the schema and testing API checks again**

Run: `python -m pytest backend/tests/test_analytics_schema.py backend/tests/test_analytics_testing_api.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/analytics_cli.py README.md backend/tests/test_analytics_schema.py
git commit -m "feat: add minimum local analytics seed flow"
```

## Spec Coverage Check

1. Keep `3003` as repository-local analytics service: covered by Tasks 1 and 2.
2. Preserve `/api/full-picture/dashboard` as the defect-centric Main Dashboard contract: covered by Task 2.
3. Add Octane test-related storage in the same analytics database: schema already present and exercised through Tasks 4 and 6.
4. Add a shared processor for defect and run enrichment: covered by Task 3.
5. Add testing-focused APIs without affecting Main Dashboard: covered by Tasks 4 and 5.
6. Keep AI chat isolated on `3004`: covered by Task 5 and by deliberate non-modification of `server/index.mjs` routes.

## Plan Self-Review

1. The plan now starts from the current migrated state instead of repeating already-completed scaffolding.
2. The first tasks focus on stabilizing real repository code that already exists.
3. The plan still avoids test KPI integration into Main Dashboard and avoids merging analytics and AI chat request paths.

Plan complete and saved to `docs/superpowers/plans/2026-05-25-octane-backend-restructure-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
