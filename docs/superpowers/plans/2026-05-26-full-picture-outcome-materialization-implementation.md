# Full Picture Outcome Materialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize Full Picture outcome flags into a local hot SQLite database so `/api/full-picture/dashboard` no longer scans `octane_defect_history_events` at request time.

**Architecture:** Keep `octane_defects` on the current upstream qgate source, introduce a repo-local hot SQLite database for `defect_outcomes`, refresh that table explicitly through the analytics CLI, and make `read_models.py` join defects with hot outcomes instead of loading history rows. The change stays narrow: no source-table rewrite, no DuckDB runtime dependency, and no full serving clone of the defect schema.

**Tech Stack:** Python 3.11, SQLite, FastAPI, pytest

---

## File Structure Map

- Modify: `backend/analytics/config.py`
  - Add repo-local database root and hot Full Picture database path helpers.
- Create: `backend/analytics/full_picture_outcomes.py`
  - Own hot outcome schema, source signature calculation, refresh logic, and hot outcome reads.
- Modify: `backend/analytics/read_models.py`
  - Replace request-time history scans with hot outcome reads while preserving the existing payload shape.
- Modify: `backend/analytics_cli.py`
  - Add an explicit `refresh-full-picture-outcomes` command.
- Create: `backend/tests/test_analytics_outcomes.py`
  - Cover hot schema creation, outcome derivation, signature behavior, and hot reads.
- Modify: `backend/tests/test_analytics_schema.py`
  - Cover the new hot-path config and CLI entrypoint behavior.
- Modify: `backend/tests/test_analytics_full_picture_api.py`
  - Convert the integration suite to use materialized outcomes and prove the request path no longer needs history tables.

### Task 1: Add hot database paths and outcome-store unit tests

**Files:**
- Modify: `backend/analytics/config.py`
- Create: `backend/analytics/full_picture_outcomes.py`
- Create: `backend/tests/test_analytics_outcomes.py`

- [ ] **Step 1: Write the failing tests for hot-path config and outcome-store schema**

```python
# backend/tests/test_analytics_outcomes.py
from pathlib import Path
import sqlite3

from backend.analytics.config import get_database_root, get_full_picture_hot_db_path
from backend.analytics.full_picture_outcomes import ensure_outcome_store


def test_full_picture_hot_db_path_defaults_to_repo_database_hot(monkeypatch):
    monkeypatch.delenv("VIZION_DATABASE_ROOT", raising=False)
    monkeypatch.delenv("VIZION_FULL_PICTURE_HOT_DB_PATH", raising=False)

    hot_db = get_full_picture_hot_db_path()

    assert hot_db == get_database_root() / "hot" / "vizion_serving.db"


def test_ensure_outcome_store_creates_parent_dirs_and_table(tmp_path):
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

    ensure_outcome_store(hot_db)

    conn = sqlite3.connect(hot_db)
    try:
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(defect_outcomes)").fetchall()
        }
    finally:
        conn.close()

    assert {
        "defect_id",
        "is_resolved_forward",
        "is_rejected_directly",
        "resolved_forward_at",
        "rejected_directly_at",
        "source_history_event_count",
        "source_signature",
        "derived_at",
    }.issubset(columns)
```

- [ ] **Step 2: Run the focused test file to verify it fails**

Run: `python -m pytest backend/tests/test_analytics_outcomes.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'backend.analytics.full_picture_outcomes'` and/or import failures for missing config helpers.

- [ ] **Step 3: Add database-root helpers and the hot outcome schema implementation**

```python
# backend/analytics/config.py
DEFAULT_DATABASE_ROOT = REPO_ROOT / "database"
DEFAULT_FULL_PICTURE_HOT_DB_PATH = DEFAULT_DATABASE_ROOT / "hot" / "vizion_serving.db"


def get_database_root() -> Path:
    return Path(os.environ.get("VIZION_DATABASE_ROOT", DEFAULT_DATABASE_ROOT))


def get_full_picture_hot_db_path() -> Path:
    configured = str(os.environ.get("VIZION_FULL_PICTURE_HOT_DB_PATH", "")).strip()
    if configured:
        return Path(configured)
    return get_database_root() / "hot" / "vizion_serving.db"
```

```python
# backend/analytics/full_picture_outcomes.py
from __future__ import annotations

from pathlib import Path
import sqlite3


OUTCOME_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS defect_outcomes (
    defect_id TEXT PRIMARY KEY,
    is_resolved_forward INTEGER NOT NULL,
    is_rejected_directly INTEGER NOT NULL,
    resolved_forward_at TEXT,
    rejected_directly_at TEXT,
    source_history_event_count INTEGER NOT NULL,
    source_signature TEXT NOT NULL,
    derived_at TEXT NOT NULL
);
"""


def ensure_outcome_store(db_path: Path | str) -> Path:
    resolved_path = Path(db_path)
    resolved_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(resolved_path)
    try:
        conn.executescript(OUTCOME_SCHEMA_SQL)
        conn.commit()
    finally:
        conn.close()
    return resolved_path
```

- [ ] **Step 4: Re-run the focused test file to verify the hot-path foundation passes**

Run: `python -m pytest backend/tests/test_analytics_outcomes.py -q`
Expected: PASS with 2 passing tests.

### Task 2: Implement outcome derivation, signature checks, and hot reads

**Files:**
- Modify: `backend/analytics/full_picture_outcomes.py`
- Create: `backend/tests/test_analytics_outcomes.py`

- [ ] **Step 1: Extend the outcome unit test file with derivation and read-path tests**

```python
# backend/tests/test_analytics_outcomes.py
from backend.analytics.full_picture_outcomes import (
    ensure_outcome_store,
    load_materialized_outcomes,
    refresh_materialized_outcomes,
)


def test_refresh_materialized_outcomes_derives_transition_flags(tmp_path):
    source_db = tmp_path / "qgate_data.db"
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

    conn = sqlite3.connect(source_db)
    try:
        conn.executescript(
            """
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
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-1", "status_phase", "2026-05-25T00:00:00Z", 1, 1, "08", "06", "08-Resolved Forward", "06-Ready for Test"),
                ("D-2", "status_phase", "2026-05-26T00:00:00Z", 1, 1, "01", "09", "01-New", "09-Rejected"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    summary = refresh_materialized_outcomes(source_db, hot_db, force=True)
    loaded = load_materialized_outcomes(hot_db, ("D-1", "D-2", "D-3"))

    assert summary["row_count"] == 2
    assert loaded["D-1"]["is_resolved_forward"] is True
    assert loaded["D-1"]["is_rejected_directly"] is False
    assert loaded["D-2"]["is_rejected_directly"] is True
    assert loaded["D-3"]["is_resolved_forward"] is False


def test_refresh_materialized_outcomes_skips_when_source_signature_matches(tmp_path):
    source_db = tmp_path / "qgate_data.db"
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

    conn = sqlite3.connect(source_db)
    try:
        conn.executescript(
            """
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
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("D-1", "status_phase", "2026-05-25T00:00:00Z", 1, 1, "08", "06", "08-Resolved Forward", "06-Ready for Test"),
        )
        conn.commit()
    finally:
        conn.close()

    first = refresh_materialized_outcomes(source_db, hot_db, force=True)
    second = refresh_materialized_outcomes(source_db, hot_db, force=False)

    assert first["skipped"] is False
    assert second["skipped"] is True
```

- [ ] **Step 2: Run the focused test file to verify the new cases fail**

Run: `python -m pytest backend/tests/test_analytics_outcomes.py -q`
Expected: FAIL with `ImportError` or `AttributeError` for missing `refresh_materialized_outcomes` and `load_materialized_outcomes`.

- [ ] **Step 3: Implement outcome derivation, signature checks, and hot reads**

```python
# backend/analytics/full_picture_outcomes.py
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import sqlite3


def _open_sqlite_readonly(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _source_signature(source_db_path: Path) -> str:
    stat = source_db_path.stat()
    return f"{source_db_path}|{stat.st_size}|{int(stat.st_mtime)}"


def _extract_phase_code(raw_value: Any) -> str:
    text = str(raw_value or "").strip()
    if len(text) >= 2 and text[:2].isdigit():
        return text[:2]
    return ""


def refresh_materialized_outcomes(
    source_db_path: Path | str,
    hot_db_path: Path | str,
    *,
    force: bool = False,
) -> dict[str, object]:
    source_path = Path(source_db_path)
    hot_path = ensure_outcome_store(hot_db_path)
    signature = _source_signature(source_path)

    existing_signatures = set()
    conn = sqlite3.connect(hot_path)
    try:
        existing_signatures = {
            row[0]
            for row in conn.execute("SELECT DISTINCT source_signature FROM defect_outcomes").fetchall()
            if row[0]
        }
    finally:
        conn.close()

    if not force and existing_signatures == {signature}:
        return {"row_count": 0, "skipped": True, "source_signature": signature}

    with _open_sqlite_readonly(source_path) as source_conn:
        rows = source_conn.execute(
            """
            SELECT
                CAST(defect_id AS TEXT) AS defect_id,
                COALESCE(event_timestamp, '') AS event_timestamp,
                COALESCE(old_value, '') AS old_value,
                COALESCE(new_value, '') AS new_value,
                COALESCE(old_value_text, '') AS old_value_text,
                COALESCE(new_value_text, '') AS new_value_text
            FROM octane_defect_history_events
            WHERE LOWER(COALESCE(field_name, '')) LIKE '%phase%'
            ORDER BY CAST(defect_id AS TEXT), event_timestamp, entry_index, change_index
            """
        ).fetchall()

    indexed: dict[str, dict[str, object]] = {}
    for row in rows:
        defect_id = str(row["defect_id"] or "").strip()
        if not defect_id:
            continue
        state = indexed.setdefault(
            defect_id,
            {
                "is_resolved_forward": False,
                "is_rejected_directly": False,
                "resolved_forward_at": None,
                "rejected_directly_at": None,
                "source_history_event_count": 0,
            },
        )
        state["source_history_event_count"] += 1
        old_code = _extract_phase_code(row["old_value_text"]) or _extract_phase_code(row["old_value"])
        new_code = _extract_phase_code(row["new_value_text"]) or _extract_phase_code(row["new_value"])
        if old_code == "08" and new_code == "06" and not state["resolved_forward_at"]:
            state["is_resolved_forward"] = True
            state["resolved_forward_at"] = row["event_timestamp"]
        if old_code == "01" and new_code == "09" and not state["rejected_directly_at"]:
            state["is_rejected_directly"] = True
            state["rejected_directly_at"] = row["event_timestamp"]

    derived_at = datetime.now(timezone.utc).isoformat()
    payload = [
        (
            defect_id,
            1 if state["is_resolved_forward"] else 0,
            1 if state["is_rejected_directly"] else 0,
            state["resolved_forward_at"],
            state["rejected_directly_at"],
            state["source_history_event_count"],
            signature,
            derived_at,
        )
        for defect_id, state in indexed.items()
    ]

    conn = sqlite3.connect(hot_path)
    try:
        conn.execute("DELETE FROM defect_outcomes")
        conn.executemany(
            """
            INSERT INTO defect_outcomes(
                defect_id, is_resolved_forward, is_rejected_directly,
                resolved_forward_at, rejected_directly_at,
                source_history_event_count, source_signature, derived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            payload,
        )
        conn.commit()
    finally:
        conn.close()

    return {"row_count": len(payload), "skipped": False, "source_signature": signature}


def load_materialized_outcomes(
    hot_db_path: Path | str,
    defect_ids: tuple[str, ...],
) -> dict[str, dict[str, object]]:
    if not defect_ids:
        return {}

    hot_path = Path(hot_db_path)
    if not hot_path.exists():
        raise FileNotFoundError(f"Full Picture hot outcome database not found: {hot_path}")

    conn = sqlite3.connect(hot_path)
    conn.row_factory = sqlite3.Row
    try:
        placeholders = ", ".join("?" for _ in defect_ids)
        rows = conn.execute(
            f"""
            SELECT defect_id, is_resolved_forward, is_rejected_directly
            FROM defect_outcomes
            WHERE defect_id IN ({placeholders})
            """,
            list(defect_ids),
        ).fetchall()
    finally:
        conn.close()

    loaded = {
        str(row["defect_id"]): {
            "is_resolved_forward": bool(row["is_resolved_forward"]),
            "is_rejected_directly": bool(row["is_rejected_directly"]),
        }
        for row in rows
    }
    for defect_id in defect_ids:
        loaded.setdefault(
            defect_id,
            {"is_resolved_forward": False, "is_rejected_directly": False},
        )
    return loaded
```

- [ ] **Step 4: Re-run the outcome unit tests to verify derivation and read helpers pass**

Run: `python -m pytest backend/tests/test_analytics_outcomes.py -q`
Expected: PASS with 4 passing tests.

### Task 3: Add the explicit refresh command and CLI regression coverage

**Files:**
- Modify: `backend/analytics_cli.py`
- Modify: `backend/tests/test_analytics_schema.py`
- Modify: `backend/analytics/config.py`

- [ ] **Step 1: Write the failing CLI test for outcome refresh**

```python
# backend/tests/test_analytics_schema.py
def test_cli_refresh_full_picture_outcomes_command_populates_hot_db(tmp_path, monkeypatch):
    source_db = tmp_path / "qgate_data.db"
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

    conn = sqlite3.connect(source_db)
    try:
        conn.executescript(
            """
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
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("D-CLI-1", "status_phase", "2026-05-25T00:00:00Z", 1, 1, "08", "06", "08-Resolved Forward", "06-Ready for Test"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(source_db))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db))

    exit_code = main(["refresh-full-picture-outcomes"])

    assert exit_code == 0

    conn = sqlite3.connect(hot_db)
    try:
        row = conn.execute(
            "SELECT is_resolved_forward, is_rejected_directly FROM defect_outcomes WHERE defect_id='D-CLI-1'"
        ).fetchone()
    finally:
        conn.close()

    assert row == (1, 0)
```

- [ ] **Step 2: Run the schema and CLI test file to verify the new command is missing**

Run: `python -m pytest backend/tests/test_analytics_schema.py -q`
Expected: FAIL with `Unknown command: refresh-full-picture-outcomes`.

- [ ] **Step 3: Wire the explicit refresh command into the analytics CLI**

```python
# backend/analytics_cli.py
from backend.analytics.config import (
    get_analytics_db_path,
    get_full_picture_history_db_candidates,
    get_full_picture_hot_db_path,
)
from backend.analytics.full_picture_outcomes import refresh_materialized_outcomes


def _require_history_source_path() -> Path:
    for candidate in get_full_picture_history_db_candidates():
        if Path(candidate).exists():
            return Path(candidate)
    raise SystemExit("No Full Picture history source database is available")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", default="init-db")
    parser.add_argument("--db-path")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.command == "refresh-full-picture-outcomes":
        source_db_path = Path(args.db_path) if args.db_path else _require_history_source_path()
        summary = refresh_materialized_outcomes(
            source_db_path,
            get_full_picture_hot_db_path(),
            force=args.force,
        )
        print(json.dumps(summary, ensure_ascii=False))
        return 0
```

- [ ] **Step 4: Re-run the schema and CLI tests to verify the refresh entrypoint passes**

Run: `python -m pytest backend/tests/test_analytics_schema.py -q`
Expected: PASS with the new CLI test included.

### Task 4: Cut Full Picture over to materialized outcomes and lock in regression coverage

**Files:**
- Modify: `backend/analytics/read_models.py`
- Modify: `backend/tests/test_analytics_full_picture_api.py`
- Modify: `backend/analytics/config.py`

- [ ] **Step 1: Write the failing Full Picture regression tests for the new read path**

```python
# backend/tests/test_analytics_full_picture_api.py
from backend.analytics.full_picture_outcomes import refresh_materialized_outcomes


def test_full_picture_reads_materialized_outcomes_without_history_db(tmp_path, monkeypatch):
    source_db = tmp_path / "qgate_data.db"
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

    conn = sqlite3.connect(source_db)
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
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, aida_english, aida_businesskey, phase,
                solution_cluster, lead_model, project, pu, market, last_modified, creation_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("D-HOT-1", "Hot issue", "03-In Analysis", "DTSV_China", "2026", "ECU-A", "Speech", "", "", "03-In Analysis", "Integration", "NA5", "IDCEVO", "PU1", "CN", "2026-05-25T00:00:00Z", "2026-05-24T00:00:00Z"),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("D-HOT-1", "status_phase", "2026-05-25T00:00:00Z", 1, 1, "08", "06", "08-Resolved Forward", "06-Ready for Test"),
        )
        conn.commit()
    finally:
        conn.close()

    refresh_materialized_outcomes(source_db, hot_db, force=True)
    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(source_db))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(tmp_path / "missing_history.db"))

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ticket_rows"][0]["ticket_id"] == "D-HOT-1"
    assert payload["ticket_rows"][0]["is_resolved_forward"] is True


def test_full_picture_returns_503_when_hot_outcomes_are_missing(tmp_path, monkeypatch):
    source_db = tmp_path / "qgate_data.db"

    conn = sqlite3.connect(source_db)
    try:
        conn.execute(
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
            )
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, aida_english, aida_businesskey, phase,
                solution_cluster, lead_model, project, pu, market, last_modified, creation_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("D-MISS-1", "Missing hot outcome", "03-In Analysis", "DTSV_China", "2026", "ECU-A", "Speech", "", "", "03-In Analysis", "Integration", "NA5", "IDCEVO", "PU1", "CN", "2026-05-25T00:00:00Z", "2026-05-24T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(source_db))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(tmp_path / "database" / "hot" / "vizion_serving.db"))

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 503
```

- [ ] **Step 2: Run the focused Full Picture API suite to verify the request path still depends on history**

Run: `python -m pytest backend/tests/test_analytics_full_picture_api.py -q`
Expected: FAIL because `build_full_picture_payload()` still loads history rows and does not know about the hot outcome database.

- [ ] **Step 3: Replace request-time history scans with hot outcome reads in `read_models.py`**

```python
# backend/analytics/read_models.py
from backend.analytics.config import (
    get_analytics_db_path,
    get_full_picture_defect_db_candidates,
    get_full_picture_history_db_candidates,
    get_full_picture_hot_db_path,
)
from backend.analytics.full_picture_outcomes import load_materialized_outcomes


def _load_outcome_index(defect_ids: tuple[str, ...]) -> dict[str, dict[str, Any]]:
    try:
        loaded = load_materialized_outcomes(get_full_picture_hot_db_path(), defect_ids)
    except (FileNotFoundError, sqlite3.DatabaseError) as exc:
        raise FullPictureDashboardDataError(
            f"Full Picture hot outcome database is not available: {exc}"
        ) from exc
    return loaded


def build_full_picture_payload(**kwargs: Any) -> dict[str, Any]:
    query = normalize_query(**kwargs)
    defect_rows = _load_defect_rows(query)
    defect_ids = tuple(
        str(row.get("ticket_id") or "").strip()
        for row in defect_rows
        if str(row.get("ticket_id") or "").strip()
    )
    outcome_index = _load_outcome_index(defect_ids)
    ticket_rows = _build_ticket_rows(defect_rows, outcome_index)
    ticket_rows = _apply_group_filter(ticket_rows, query.groups)

    return {
        "generated_from": {
            "defect_db_path": str(_resolve_defect_db_path() or ""),
            "history_db_path": str(_resolve_history_db_path() or ""),
            "outcome_db_path": str(get_full_picture_hot_db_path()),
            "years": list(query.years),
            "projects": list(query.projects),
            "assigned_ecus": list(query.assigned_ecus),
            "problem_finder_teams": list(query.problem_finder_teams),
            "aidas": list(query.aidas),
            "phases": list(query.phases),
            "solution_clusters": list(query.solution_clusters),
            "pus": list(query.pus),
            "markets": list(query.markets),
            "lead_models": list(query.lead_models),
            "groups": list(query.groups),
        },
        "filters": _build_filters(ticket_rows),
        "overview": _build_overview(ticket_rows),
        "outcome_summary": _build_outcome_summary(ticket_rows),
        "team_outcome_rows": _build_team_outcome_rows(ticket_rows),
        "ticket_rows": ticket_rows,
    }
```

- [ ] **Step 4: Update existing Full Picture integration tests to refresh outcomes before requests**

```python
# backend/tests/test_analytics_full_picture_api.py
def _refresh_hot_outcomes(source_db: Path, hot_db: Path) -> None:
    refresh_materialized_outcomes(source_db, hot_db, force=True)


def test_full_picture_dashboard_reads_original_sqlite_shape(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
    # existing defect/history setup stays the same
    _refresh_hot_outcomes(db_path, hot_db)

    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(db_path))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(db_path))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db))

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ticket_rows"][0]["is_resolved_forward"] is True
    assert payload["generated_from"]["outcome_db_path"] == str(hot_db)
```

- [ ] **Step 5: Run the focused Full Picture API suite to verify the cutover passes**

Run: `python -m pytest backend/tests/test_analytics_full_picture_api.py -q`
Expected: PASS with the existing Full Picture contract preserved and the new hot-outcome routing covered.

- [ ] **Step 6: Run the post-cutover regression commands for the touched backend slice**

Run: `python -m pytest backend/tests/test_analytics_outcomes.py backend/tests/test_analytics_schema.py backend/tests/test_analytics_full_picture_api.py -q`
Expected: PASS with all outcome-materialization and Full Picture backend tests green.

## Self-Review Checklist

- Spec coverage: the plan covers repo-local database layout, `defect_outcomes`, explicit refresh, request-path cutover, and regression validation.
- Placeholder scan: every task includes concrete file paths, concrete code, and runnable commands.
- Type consistency: the plan uses one hot-path vocabulary throughout: `get_full_picture_hot_db_path`, `ensure_outcome_store`, `refresh_materialized_outcomes`, and `load_materialized_outcomes`.