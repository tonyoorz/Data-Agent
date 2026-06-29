import os
from pathlib import Path
import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.analytics.api import app
from backend.analytics.dashboard_snapshot import (
    activate_snapshot_version,
    build_full_picture_snapshot_version,
    get_summary_cache,
    normalize_summary_cache_key,
    record_snapshot_refresh,
    reset_summary_cache,
)
from backend.analytics.ingest.source_store import OctaneSourceStore
from backend.analytics.full_picture_outcomes import ensure_outcome_store, refresh_materialized_outcomes
from backend.analytics import read_models
from backend.analytics.schema import ensure_schema


def _default_hot_db_path(tmp_path: Path) -> Path:
    return tmp_path / "database" / "hot" / "vizion_serving.db"


def _refresh_full_picture_hot_outcomes(source_db_path: Path, hot_db_path: Path) -> None:
    refresh_materialized_outcomes(source_db_path, hot_db_path, force=True)


def _configure_full_picture_env(
    monkeypatch,
    *,
    defect_db_path: Path | str,
    hot_db_path: Path | str,
    history_db_path: Path | str | None = None,
) -> None:
    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(defect_db_path))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db_path))
    if history_db_path is None:
        monkeypatch.delenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", raising=False)
    else:
        monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(history_db_path))


def test_full_picture_ignores_raw_only_history_db(tmp_path, monkeypatch):
    history_db_path = tmp_path / "legacy-history.db"

    conn = sqlite3.connect(history_db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defect_history_events (
                defect_id TEXT,
                event_timestamp TEXT,
                field_name TEXT,
                old_value TEXT,
                new_value TEXT,
                raw_event_json TEXT,
                fetched_at TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, event_timestamp, field_name, old_value, new_value, raw_event_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-RAW-1",
                "2026-05-25T00:00:00Z",
                "status_phase",
                "08",
                "06",
                '{"old_value_text":"08-Resolved Forward","new_value_text":"06-Ready for Test"}',
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(history_db_path))

    assert read_models._resolve_history_db_path() is None


def _seed_qgate_source_db(db_path: Path, *, defect_count: int = 1) -> None:
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
        for index in range(1, defect_count + 1):
            defect_id = f"D-{index:03d}"
            conn.execute(
                """
                INSERT INTO octane_defects(
                    defect_id, name, status_phase, problem_finder_team, year,
                    assigned_ecu, top_aida, aida_english, aida_businesskey, phase,
                    solution_cluster, lead_model, project, pu, market, last_modified, creation_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    defect_id,
                    f"Issue {index}",
                    "03-In Analysis",
                    "DTSV_China",
                    "2026",
                    "ECU-A",
                    "Speech",
                    "",
                    "",
                    "03-In Analysis",
                    "Integration",
                    "NA5",
                    "IDCEVO",
                    "PU1",
                    "CN",
                    f"2026-05-{20 + index:02d}T00:00:00Z",
                    f"2026-05-{19 + index:02d}T00:00:00Z",
                ),
            )
            conn.execute(
                """
                INSERT INTO octane_defect_history_events(
                    defect_id, field_name, event_timestamp, entry_index, change_index,
                    old_value, new_value, old_value_text, new_value_text
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    defect_id,
                    "status_phase",
                    f"2026-05-{20 + index:02d}T00:00:00Z",
                    1,
                    1,
                    "08",
                    "06",
                    "08-Resolved Forward",
                    "06-Ready for Test",
                ),
            )
        conn.commit()
    finally:
        conn.close()


def _record_active_snapshot(
    hot_db_path: Path,
    *,
    snapshot_version: str | None = None,
    source_db_path: Path | str | None = None,
) -> None:
    effective_source_db_path = Path(source_db_path or read_models.get_full_picture_source_db_path()).resolve()
    effective_snapshot_version = snapshot_version or build_full_picture_snapshot_version(effective_source_db_path)
    has_publishable_source = False
    if source_db_path is not None and effective_source_db_path.exists():
        with sqlite3.connect(effective_source_db_path) as conn:
            source_table_row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'octane_defects'"
            ).fetchone()
        has_publishable_source = source_table_row is not None
    if has_publishable_source:
        read_models.publish_dashboard_snapshot_rows(
            effective_snapshot_version,
            defect_db_path=effective_source_db_path,
            hot_db_path=hot_db_path,
        )
    reset_summary_cache()
    source_db_mtime = read_models._format_snapshot_source_mtime(effective_source_db_path) or "2026-05-28T00:00:00Z"
    record_snapshot_refresh(
        hot_db_path,
        snapshot_version=effective_snapshot_version,
        source_db_path=str(effective_source_db_path),
        source_db_mtime=source_db_mtime,
        refresh_status="ready",
        last_error=None,
    )
    activate_snapshot_version(hot_db_path, effective_snapshot_version)


def test_health_endpoint_returns_ok():
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "analytics"}


def test_health_endpoint_starts_app_lifespan():
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "analytics"}


def test_full_picture_dashboard_endpoint_exists(monkeypatch):
    monkeypatch_path = Path("C:/__missing__/octane_data.db")
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=monkeypatch_path,
        hot_db_path=Path("C:/__missing__/vizion_serving.db"),
        history_db_path=None,
    )
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard")

    assert response.status_code == 503
    assert response.json()["error"] == "analytics database not initialized"


def test_full_picture_summary_endpoint_returns_snapshot_version(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard/summary?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["snapshot_version"] == build_full_picture_snapshot_version(db_path)
    assert payload["overview"]["ticket_count"] == 1
    assert "ticket_rows" not in payload
    assert payload["filters"]["months"] == ["2026-05"]
    assert payload["filters"]["china_scopes"] == ["Global"]


def test_top_issue_analysis_endpoint_returns_filtered_rows(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path, defect_count=2)
    with sqlite3.connect(db_path) as conn:
        conn.execute("UPDATE octane_defects SET project = ? WHERE defect_id = ?", ("MGU", "D-002"))
        conn.commit()
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )
    client = TestClient(app)

    response = client.get("/api/full-picture/top-issue-analysis?years=2026&projects=IDCEVO")

    assert response.status_code == 200
    payload = response.json()
    assert payload["snapshot_version"] == build_full_picture_snapshot_version(db_path)
    assert payload["generated_from"]["projects"] == ["IDCEVO"]
    assert payload["status_distribution"] == [{"status": "03-In Analysis", "count": 1}]
    assert payload["defect_trend"] == [
        {"month": "2026-05", "new_count": 1, "closed_count": 0, "in_progress_count": 1}
    ]
    assert [row["ticket_id"] for row in payload["top_issue_rows"]] == ["D-001"]
    assert payload["top_issue_rows"][0]["age_days"] == 1


def test_full_picture_dashboard_exposes_requirement_field_and_filters(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, phase, solution_cluster, lead_model,
                project, pu, market, last_modified, creation_time,
                requirement, requirements_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "D-REQ-1",
                    "Requirement A defect",
                    "03-In Analysis",
                    "DTSV_China",
                    "2026",
                    "ECU-A",
                    "Speech",
                    "03-In Analysis",
                    "Integration",
                    "NA5",
                    "IDCEVO",
                    "PU1",
                    "CN",
                    "2026-05-25T00:00:00Z",
                    "2026-05-24T00:00:00Z",
                    "DOC_PreCon_A | DOC_PreCon_B",
                    '["DOC_PreCon_A", "DOC_PreCon_B"]',
                    '{}',
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "D-REQ-2",
                    "Requirement C defect",
                    "03-In Analysis",
                    "DTSV_China",
                    "2026",
                    "ECU-B",
                    "Speech",
                    "03-In Analysis",
                    "Integration",
                    "NA5",
                    "IDCEVO",
                    "PU1",
                    "CN",
                    "2026-05-26T00:00:00Z",
                    "2026-05-25T00:00:00Z",
                    "DOC_PreCon_C",
                    '["DOC_PreCon_C"]',
                    '{}',
                    "2026-05-26T00:00:00Z",
                ),
            ],
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "D-REQ-1",
                    "status_phase",
                    "2026-05-25T00:00:00Z",
                    1,
                    1,
                    "08",
                    "06",
                    "08-Resolved Forward",
                    "06-Ready for Test",
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "D-REQ-2",
                    "status_phase",
                    "2026-05-26T00:00:00Z",
                    1,
                    1,
                    "08",
                    "06",
                    "08-Resolved Forward",
                    "06-Ready for Test",
                    "2026-05-26T00:00:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    client = TestClient(app)

    summary_response = client.get("/api/full-picture/dashboard/summary?years=2026")
    tickets_response = client.get("/api/full-picture/dashboard/tickets?years=2026&requirements=DOC_PreCon_B")

    assert summary_response.status_code == 200
    assert tickets_response.status_code == 200

    summary_payload = summary_response.json()
    tickets_payload = tickets_response.json()

    assert summary_payload["filters"]["requirements"] == [
        "DOC_PreCon_A",
        "DOC_PreCon_B",
        "DOC_PreCon_C",
    ]
    assert tickets_payload["total_rows"] == 1
    assert tickets_payload["rows"][0]["ticket_id"] == "D-REQ-1"
    assert tickets_payload["rows"][0]["requirement"] == "DOC_PreCon_A | DOC_PreCon_B"


def test_full_picture_tickets_return_top_topic_priority_rows_ignoring_creation_time_and_team(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, phase, solution_cluster, lead_model,
                project, pu, market, last_modified, creation_time,
                requirement, requirements_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "D-TOP-DATE",
                    "Top topic outside date range",
                    "03-In Analysis",
                    "DTSV_China",
                    "2026",
                    "ECU-A",
                    "Speech",
                    "03-In Analysis",
                    "Integration",
                    "NA5",
                    "IDCEVO",
                    "PU1",
                    "CN",
                    "2026-05-25T00:00:00Z",
                    "2026-03-01T00:00:00Z",
                    "Top Topic | DOC_PreCon_A",
                    '["Top Topic", "DOC_PreCon_A"]',
                    '{}',
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "D-TOP-TEAM",
                    "Top topic outside team filter",
                    "03-In Analysis",
                    "OtherTeam",
                    "2026",
                    "ECU-A",
                    "Speech",
                    "03-In Analysis",
                    "Integration",
                    "NA5",
                    "IDCEVO",
                    "PU1",
                    "CN",
                    "2026-05-25T00:00:00Z",
                    "2026-05-22T00:00:00Z",
                    "Top Topic | DOC_PreCon_A",
                    '["Top Topic", "DOC_PreCon_A"]',
                    '{}',
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "D-TOP-GLOBAL",
                    "Top topic outside China scope filter",
                    "03-In Analysis",
                    "OtherTeam",
                    "2026",
                    "ECU-A",
                    "Speech",
                    "03-In Analysis",
                    "Integration",
                    "NA5",
                    "IDCEVO",
                    "PU1",
                    "DE",
                    "2026-05-25T00:00:00Z",
                    "2026-05-22T00:00:00Z",
                    "Top Topic | DOC_PreCon_A",
                    '["Top Topic", "DOC_PreCon_A"]',
                    '{}',
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "D-NORMAL",
                    "Normal in-scope defect",
                    "03-In Analysis",
                    "DTSV_China",
                    "2026",
                    "ECU-A",
                    "Speech",
                    "03-In Analysis",
                    "Integration",
                    "NA5",
                    "IDCEVO",
                    "PU1",
                    "CN",
                    "2026-05-25T00:00:00Z",
                    "2026-05-24T00:00:00Z",
                    "DOC_PreCon_A",
                    '["DOC_PreCon_A"]',
                    '{}',
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "D-TOP-WRONG-PROJECT",
                    "Top topic excluded by project",
                    "03-In Analysis",
                    "DTSV_China",
                    "2026",
                    "ECU-A",
                    "Speech",
                    "03-In Analysis",
                    "Integration",
                    "NA5",
                    "U12",
                    "PU1",
                    "CN",
                    "2026-05-25T00:00:00Z",
                    "2026-05-24T00:00:00Z",
                    "Top Topic | DOC_PreCon_A",
                    '["Top Topic", "DOC_PreCon_A"]',
                    '{}',
                    "2026-05-25T00:00:00Z",
                ),
            ],
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    defect_id,
                    "status_phase",
                    "2026-05-25T00:00:00Z",
                    1,
                    1,
                    "08",
                    "06",
                    "08-Resolved Forward",
                    "06-Ready for Test",
                    "2026-05-25T00:00:00Z",
                )
                for defect_id in (
                    "D-TOP-DATE",
                    "D-TOP-TEAM",
                    "D-TOP-GLOBAL",
                    "D-NORMAL",
                    "D-TOP-WRONG-PROJECT",
                )
            ],
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, snapshot_version="snapshot-top-topic", source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    tickets_payload = read_models.list_full_picture_ticket_rows(
        years=["2026"],
        projects=["IDCEVO"],
        phases=["03-In Analysis"],
        requirements=["DOC_PreCon_A"],
        china_scopes=["China"],
        problem_finder_teams=["DTSV_China"],
        creation_time_start="2026-05-20",
        creation_time_end="2026-05-31",
        page=1,
        page_size=50,
        snapshot_version="snapshot-top-topic",
    )

    assert [row["ticket_id"] for row in tickets_payload["priority_rows"]] == [
        "D-TOP-DATE",
        "D-TOP-GLOBAL",
        "D-TOP-TEAM",
    ]


def test_full_picture_tickets_hide_top_topic_priority_rows_after_first_page(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, phase, solution_cluster, lead_model,
                project, pu, market, last_modified, creation_time,
                requirement, requirements_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-TOP-PAGED",
                "Top topic second page hidden",
                "03-In Analysis",
                "OtherTeam",
                "2026",
                "ECU-A",
                "Speech",
                "03-In Analysis",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-03-01T00:00:00Z",
                "Top Topic | DOC_PreCon_A",
                '["Top Topic", "DOC_PreCon_A"]',
                '{}',
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-TOP-PAGED",
                "status_phase",
                "2026-05-25T00:00:00Z",
                1,
                1,
                "08",
                "06",
                "08-Resolved Forward",
                "06-Ready for Test",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, snapshot_version="snapshot-top-topic-page-2", source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    tickets_payload = read_models.list_full_picture_ticket_rows(
        years=["2026"],
        projects=["IDCEVO"],
        requirements=["DOC_PreCon_A"],
        problem_finder_teams=["DTSV_China"],
        creation_time_start="2026-05-20",
        creation_time_end="2026-05-31",
        page=2,
        page_size=1,
        snapshot_version="snapshot-top-topic-page-2",
    )

    assert tickets_payload["priority_rows"] == []


def test_full_picture_creation_time_month_filter_uses_creation_time_not_last_modified(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            UPDATE octane_defects
            SET creation_time = ?, last_modified = ?
            WHERE defect_id = ?
            """,
            ("2026-02-20T00:00:00Z", "2026-05-21T00:00:00Z", "D-001"),
        )
        conn.commit()
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    summary_payload = read_models.build_full_picture_summary_payload(years=["2026"])
    tickets_payload = read_models.list_full_picture_ticket_rows(
        years=["2026"],
        months=["2026-02"],
        page=1,
        page_size=50,
        snapshot_version=summary_payload["snapshot_version"],
    )

    assert summary_payload["filters"]["months"] == ["2026-02"]
    assert [row["ticket_id"] for row in tickets_payload["rows"]] == ["D-001"]


def test_full_picture_creation_time_date_range_filters_summary_and_tickets(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path, defect_count=2)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            UPDATE octane_defects
            SET creation_time = ?, last_modified = ?
            WHERE defect_id = ?
            """,
            ("2026-03-15T00:00:00Z", "2026-05-21T00:00:00Z", "D-001"),
        )
        conn.execute(
            """
            UPDATE octane_defects
            SET creation_time = ?, last_modified = ?
            WHERE defect_id = ?
            """,
            ("2026-05-22T00:00:00Z", "2026-05-22T00:00:00Z", "D-002"),
        )
        conn.commit()
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    summary_payload = read_models.build_full_picture_summary_payload(
        years=["2026"],
        creation_time_start="2026-03-01",
        creation_time_end="2026-04-30",
    )
    tickets_payload = read_models.list_full_picture_ticket_rows(
        years=["2026"],
        creation_time_start="2026-03-01",
        creation_time_end="2026-04-30",
        page=1,
        page_size=50,
        snapshot_version=summary_payload["snapshot_version"],
    )

    assert summary_payload["overview"]["ticket_count"] == 1
    assert [row["ticket_id"] for row in tickets_payload["rows"]] == ["D-001"]


def test_full_picture_tickets_endpoint_returns_paged_rows(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path, defect_count=3)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard/tickets?years=2026&page=2&page_size=1")

    assert response.status_code == 200
    payload = response.json()
    assert payload["snapshot_version"] == build_full_picture_snapshot_version(db_path)
    assert payload["page"] == 2
    assert payload["page_size"] == 1
    assert payload["total_rows"] == 3
    assert payload["total_pages"] == 3
    assert len(payload["rows"]) == 1
    assert payload["rows"][0]["ticket_id"] == "D-002"


def test_full_picture_refresh_status_endpoint_reads_active_snapshot(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    db_path.touch()
    hot_db_path = _default_hot_db_path(tmp_path)
    _record_active_snapshot(hot_db_path, snapshot_version="snapshot-20260528-2", source_db_path=db_path)
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db_path))
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard/refresh-status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["active_snapshot_version"] == "snapshot-20260528-2"
    assert payload["refresh_status"] == "ready"


def test_full_picture_dashboard_split_endpoints_share_active_snapshot_version(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path, defect_count=2)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, snapshot_version="snapshot-20260528-shared", source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )
    client = TestClient(app)

    summary_response = client.get("/api/full-picture/dashboard/summary?years=2026")
    tickets_response = client.get("/api/full-picture/dashboard/tickets?years=2026&page=1&page_size=1")
    refresh_status_response = client.get("/api/full-picture/dashboard/refresh-status")

    assert summary_response.status_code == 200
    assert tickets_response.status_code == 200
    assert refresh_status_response.status_code == 200
    assert summary_response.json()["snapshot_version"] == "snapshot-20260528-shared"
    assert tickets_response.json()["snapshot_version"] == "snapshot-20260528-shared"
    assert refresh_status_response.json()["active_snapshot_version"] == "snapshot-20260528-shared"


def test_full_picture_summary_reads_published_snapshot_without_request_time_materialization(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path, defect_count=2)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, snapshot_version="snapshot-published", source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    def fail_if_materialized_on_read(*_args, **_kwargs):
        pytest.fail("summary request unexpectedly materialized snapshot rows on the read path")

    monkeypatch.setattr(read_models, "_materialize_snapshot_ticket_rows", fail_if_materialized_on_read)

    payload = read_models.build_full_picture_summary_payload(years=["2026"])

    assert payload["snapshot_version"] == "snapshot-published"
    assert payload["overview"]["ticket_count"] == 2


def test_full_picture_summary_endpoint_preserves_repeated_query_values(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard/summary?projects=IDCEVO&projects=MGU")

    assert response.status_code == 200
    assert response.json()["generated_from"]["projects"] == ["IDCEVO", "MGU"]


def test_full_picture_tickets_endpoint_rejects_invalid_page_value(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard/tickets?page=abc")

    assert response.status_code == 400
    assert "Invalid page" in response.json()["error"]


def test_full_picture_tickets_endpoint_rejects_stale_snapshot_version(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, snapshot_version="snapshot-live", source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )
    client = TestClient(app)

    response = client.get(
        "/api/full-picture/dashboard/tickets?snapshot_version=snapshot-stale&page=1&page_size=1"
    )

    assert response.status_code == 409
    assert "stale" in response.json()["error"]


def test_full_picture_summary_payload_uses_warmed_cache_before_rebuilding(tmp_path, monkeypatch):
    hot_db_path = _default_hot_db_path(tmp_path)
    _record_active_snapshot(hot_db_path, snapshot_version="snapshot-cache")
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db_path))

    reset_summary_cache()
    cache_key = normalize_summary_cache_key(
        snapshot_version="snapshot-cache",
        filters=read_models._serialize_query_filters(read_models.normalize_query()),
    )
    cached_payload = {
        "snapshot_version": "snapshot-cache",
        "generated_from": {"years": ["2026"]},
        "refresh_metadata": {"active_snapshot_version": "snapshot-cache", "refresh_status": "ready"},
        "filters": {"years": ["2026"]},
        "overview": {"ticket_count": 1},
        "outcome_summary": [],
        "team_outcome_rows": [],
    }
    get_summary_cache()[cache_key] = cached_payload

    def fail_if_rebuilt(*_args, **_kwargs):
        pytest.fail("summary cache miss triggered unnecessary rebuild")

    monkeypatch.setattr(read_models, "_build_snapshot_bound_dataset", fail_if_rebuilt)

    assert read_models.build_full_picture_summary_payload() == cached_payload


def test_full_picture_tickets_reuse_materialized_rows_after_summary_build(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path, defect_count=3)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, snapshot_version="snapshot-materialized", source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    summary_payload = read_models.build_full_picture_summary_payload(years=["2026"])

    assert summary_payload["filters"]["months"] == ["2026-05"]
    assert summary_payload["filters"]["china_scopes"] == ["Global"]

    def fail_if_source_rebuilt(*_args, **_kwargs):
        pytest.fail("tickets endpoint rebuilt source rows instead of reading materialized ticket rows")

    monkeypatch.setattr(read_models, "_load_defect_rows", fail_if_source_rebuilt)

    tickets_payload = read_models.list_full_picture_ticket_rows(
        years=["2026"],
        page=2,
        page_size=1,
        snapshot_version="snapshot-materialized",
    )

    assert tickets_payload["total_rows"] == 3
    assert tickets_payload["rows"][0]["ticket_id"] == "D-002"


def test_full_picture_tickets_use_materialized_rows_without_active_snapshot(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path, defect_count=3)
    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    summary_payload = read_models.build_full_picture_summary_payload(years=["2026"])

    assert summary_payload["snapshot_version"].startswith("live-")

    def fail_if_source_rebuilt(*_args, **_kwargs):
        pytest.fail("fallback snapshot should reuse materialized ticket rows")

    monkeypatch.setattr(read_models, "_load_defect_rows", fail_if_source_rebuilt)

    tickets_payload = read_models.list_full_picture_ticket_rows(
        years=["2026"],
        page=2,
        page_size=1,
        snapshot_version=summary_payload["snapshot_version"],
    )

    assert tickets_payload["snapshot_version"] == summary_payload["snapshot_version"]
    assert tickets_payload["total_rows"] == 3
    assert tickets_payload["rows"][0]["ticket_id"] == "D-002"


def test_full_picture_summary_uses_live_snapshot_when_active_snapshot_source_is_stale(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, phase, solution_cluster, lead_model,
                project, pu, market, last_modified, creation_time,
                requirement, requirements_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-REQ-STALE",
                "Requirement updated after snapshot",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "03-In Analysis",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
                "DOC_PreCon_A",
                '["DOC_PreCon_A"]',
                '{}',
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-REQ-STALE",
                "status_phase",
                "2026-05-25T00:00:00Z",
                1,
                1,
                "08",
                "06",
                "08-Resolved Forward",
                "06-Ready for Test",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    read_models.publish_dashboard_snapshot_rows(
        "snapshot-stale",
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )
    record_snapshot_refresh(
        hot_db_path,
        snapshot_version="snapshot-stale",
        source_db_path=str(db_path.resolve()),
        source_db_mtime=read_models._format_snapshot_source_mtime(db_path),
        refresh_status="ready",
        last_error=None,
    )
    activate_snapshot_version(hot_db_path, "snapshot-stale")
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    initial_summary_payload = read_models.build_full_picture_summary_payload(years=["2026"])
    initial_tickets_payload = read_models.list_full_picture_ticket_rows(
        years=["2026"],
        snapshot_version="snapshot-stale",
    )

    assert initial_summary_payload["snapshot_version"] == "snapshot-stale"
    assert initial_tickets_payload["rows"][0]["requirement"] == "DOC_PreCon_A"

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            UPDATE octane_defects
            SET requirement = ?, requirements_json = ?, last_modified = ?
            WHERE defect_id = ?
            """,
            (
                "Top Topic | DOC_PreCon_A",
                '["Top Topic", "DOC_PreCon_A"]',
                "2026-05-26T00:00:00Z",
                "D-REQ-STALE",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    newer_mtime_ns = db_path.stat().st_mtime_ns + 5_000_000_000
    os.utime(db_path, ns=(newer_mtime_ns, newer_mtime_ns))
    reset_summary_cache()

    refreshed_summary_payload = read_models.build_full_picture_summary_payload(years=["2026"])
    refreshed_tickets_payload = read_models.list_full_picture_ticket_rows(
        years=["2026"],
        snapshot_version=refreshed_summary_payload["snapshot_version"],
    )

    assert refreshed_summary_payload["snapshot_version"].startswith("live-")
    assert refreshed_summary_payload["snapshot_version"] != "snapshot-stale"
    assert "Top Topic" in refreshed_summary_payload["filters"]["requirements"]
    assert refreshed_tickets_payload["rows"][0]["requirement"] == "Top Topic | DOC_PreCon_A"


def test_full_picture_summary_filters_keep_current_field_expandable(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    _seed_qgate_source_db(db_path, defect_count=1)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, aida_english, aida_businesskey, phase,
                solution_cluster, lead_model, project, pu, market, last_modified, creation_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-900",
                "Issue 900",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "Integration",
                "NA5",
                "U12",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, aida_english, aida_businesskey, phase,
                solution_cluster, lead_model, project, pu, market, last_modified, creation_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-901",
                "Issue 901",
                "03-In Analysis",
                "OtherTeam",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "Integration",
                "NA5",
                "APP",
                "PU1",
                "CN",
                "2026-05-26T00:00:00Z",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _record_active_snapshot(hot_db_path, snapshot_version="snapshot-self-filter", source_db_path=db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    payload = read_models.build_full_picture_summary_payload(
        years=["2026"],
        projects=["U12"],
        problem_finder_teams=["DTSV_China"],
        phases=["03-In Analysis"],
    )

    assert payload["overview"]["ticket_count"] == 1
    assert payload["filters"]["projects"] == ["IDCEVO", "U12"]
    assert payload["filters"]["problem_finder_teams"] == ["DTSV_China"]


def test_full_picture_dashboard_reads_original_sqlite_shape(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
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
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, aida_english, aida_businesskey, phase,
                solution_cluster, lead_model, project, pu, market, last_modified, creation_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-1",
                "Wake issue",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-1",
                "status_phase",
                "2026-05-25T00:00:00Z",
                1,
                1,
                "08",
                "06",
                "08-Resolved Forward",
                "06-Ready for Test",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["overview"]["ticket_count"] == 1
    assert payload["ticket_rows"][0]["ticket_id"] == "D-1"
    assert payload["ticket_rows"][0]["is_resolved_forward"] is True
    assert payload["generated_from"]["defect_db_path"] == str(db_path)
    assert payload["generated_from"]["outcome_db_path"] == str(hot_db_path)


def test_full_picture_prefers_local_source_copy_when_present(tmp_path, monkeypatch):
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    hot_db_path = database_root / "hot" / "vizion_serving.db"
    analytics_db_path = tmp_path / "backend" / "database" / "octane_data.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_db_path)
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
            (
                "D-LOCAL-1",
                "Local source issue",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-LOCAL-1",
                "status_phase",
                "2026-05-25T00:00:00Z",
                1,
                1,
                "08",
                "06",
                "08-Resolved Forward",
                "06-Ready for Test",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(source_db_path, hot_db_path)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(analytics_db_path))
    monkeypatch.delenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", raising=False)
    monkeypatch.delenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", raising=False)
    monkeypatch.delenv("VIZION_FULL_PICTURE_HOT_DB_PATH", raising=False)

    payload = read_models.build_full_picture_payload(years="2026")

    assert payload["overview"]["ticket_count"] == 1
    assert payload["ticket_rows"][0]["ticket_id"] == "D-LOCAL-1"
    assert payload["ticket_rows"][0]["is_resolved_forward"] is True
    assert payload["generated_from"]["defect_db_path"] == str(source_db_path)
    assert payload["generated_from"]["outcome_db_path"] == str(hot_db_path)


def test_full_picture_reads_materialized_outcomes_without_history_db(tmp_path, monkeypatch):
    defect_db_path = tmp_path / "qgate_data.db"
    history_source_db_path = tmp_path / "history_source.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    missing_history_db_path = tmp_path / "missing_history.db"

    defect_conn = sqlite3.connect(defect_db_path)
    try:
        defect_conn.executescript(
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
            """
        )
        defect_conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, aida_english, aida_businesskey, phase,
                solution_cluster, lead_model, project, pu, market, last_modified, creation_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-HOT-1",
                "Hot outcome issue",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
            ),
        )
        defect_conn.commit()
    finally:
        defect_conn.close()

    history_conn = sqlite3.connect(history_source_db_path)
    try:
        history_conn.executescript(
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
        history_conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-HOT-1",
                "status_phase",
                "2026-05-25T00:00:00Z",
                1,
                1,
                "08",
                "06",
                "08-Resolved Forward",
                "06-Ready for Test",
            ),
        )
        history_conn.commit()
    finally:
        history_conn.close()

    _refresh_full_picture_hot_outcomes(history_source_db_path, hot_db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=defect_db_path,
        hot_db_path=hot_db_path,
        history_db_path=missing_history_db_path,
    )

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["overview"]["ticket_count"] == 1
    assert payload["ticket_rows"][0]["ticket_id"] == "D-HOT-1"
    assert payload["ticket_rows"][0]["is_resolved_forward"] is True
    assert payload["generated_from"]["defect_db_path"] == str(defect_db_path)
    assert payload["generated_from"]["outcome_db_path"] == str(hot_db_path)


def test_full_picture_returns_503_when_hot_outcomes_are_missing(tmp_path, monkeypatch):
    defect_db_path = tmp_path / "qgate_data.db"
    missing_hot_db_path = tmp_path / "database" / "hot" / "missing_vizion_serving.db"
    missing_history_db_path = tmp_path / "missing_history.db"

    conn = sqlite3.connect(defect_db_path)
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
            (
                "D-MISSING-HOT",
                "Missing hot outcome issue",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=defect_db_path,
        hot_db_path=missing_hot_db_path,
        history_db_path=missing_history_db_path,
    )

    with pytest.raises(read_models.FullPictureDashboardDataError, match="hot.+outcome.+not available"):
        read_models.build_full_picture_payload(years="2026")

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 503
    assert response.json()["error"] == "analytics database not initialized"


def test_full_picture_returns_503_when_hot_outcomes_were_never_refreshed(tmp_path, monkeypatch):
    defect_db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    missing_history_db_path = tmp_path / "missing_history.db"

    conn = sqlite3.connect(defect_db_path)
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
            (
                "D-NOT-READY",
                "Never refreshed outcome issue",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    ensure_outcome_store(hot_db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=defect_db_path,
        hot_db_path=hot_db_path,
        history_db_path=missing_history_db_path,
    )

    with pytest.raises(read_models.FullPictureDashboardDataError, match="hot.+outcome.+not available"):
        read_models.build_full_picture_payload(years="2026")

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 503
    assert response.json()["error"] == "analytics database not initialized"


def test_full_picture_allows_refreshed_empty_hot_outcomes(tmp_path, monkeypatch):
    defect_db_path = tmp_path / "qgate_data.db"
    history_source_db_path = tmp_path / "history_source.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    missing_history_db_path = tmp_path / "missing_history.db"

    defect_conn = sqlite3.connect(defect_db_path)
    try:
        defect_conn.executescript(
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
            """
        )
        defect_conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, problem_finder_team, year,
                assigned_ecu, top_aida, aida_english, aida_businesskey, phase,
                solution_cluster, lead_model, project, pu, market, last_modified, creation_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-EMPTY-HOT",
                "Refreshed empty outcome issue",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
            ),
        )
        defect_conn.commit()
    finally:
        defect_conn.close()

    history_conn = sqlite3.connect(history_source_db_path)
    try:
        history_conn.execute(
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
            )
            """
        )
        history_conn.commit()
    finally:
        history_conn.close()

    _refresh_full_picture_hot_outcomes(history_source_db_path, hot_db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=defect_db_path,
        hot_db_path=hot_db_path,
        history_db_path=missing_history_db_path,
    )

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["overview"]["ticket_count"] == 1
    assert payload["ticket_rows"][0]["ticket_id"] == "D-EMPTY-HOT"
    assert payload["ticket_rows"][0]["is_resolved_forward"] is False
    assert payload["ticket_rows"][0]["is_rejected_directly"] is False
    assert payload["generated_from"]["outcome_db_path"] == str(hot_db_path)


def test_full_picture_prefers_local_octane_db_when_explicitly_configured(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, project, market, pu, fv, fvp, team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-2",
                "Local issue",
                "IDCEVO",
                "CN",
                "PU1",
                "Speech",
                "Tony",
                "DTSV_China",
                "NA5",
                '{"status_phase":"03-In Analysis","year":"2026","problem_finder_team":"DTSV_China","assigned_ecu":"ECU-A","top_aida":"Speech","phase":"03-In Analysis","solution_cluster":"Integration","defect_category":"CN Speech"}',
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, event_timestamp, field_name, old_value, new_value, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "D-2",
                "2026-05-25T00:00:00Z",
                "status_phase",
                "08",
                "06",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ticket_rows"][0]["ticket_id"] == "D-2"
    assert payload["ticket_rows"][0]["defect_category"] == "CN Speech"
    assert payload["generated_from"]["defect_db_path"] == str(db_path)
    assert payload["generated_from"]["outcome_db_path"] == str(hot_db_path)


def test_full_picture_qgate_shape_falls_back_to_problem_category_from_raw_json(tmp_path, monkeypatch):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
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
                creation_time TEXT,
                raw_json TEXT
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
                solution_cluster, lead_model, project, pu, market,
                last_modified, creation_time, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-RAW-1",
                "Issue with CN category only in raw",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
                '{"problem_category_udf":{"name":"CN IPA_Intelligence"}}',
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-RAW-1",
                "status_phase",
                "2026-05-25T00:00:00Z",
                1,
                1,
                "08",
                "06",
                "08-Resolved Forward",
                "06-Ready for Test",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ticket_rows"][0]["defect_id" if False else "ticket_id"] == "D-RAW-1"
    assert payload["ticket_rows"][0]["defect_category"] == "CN IPA_Intelligence"


def test_full_picture_qgate_shape_keeps_direct_defect_category_while_parsing_raw_json_metadata(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
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
                defect_category TEXT,
                solution_cluster TEXT,
                lead_model TEXT,
                project TEXT,
                pu TEXT,
                market TEXT,
                last_modified TEXT,
                creation_time TEXT,
                raw_json TEXT
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
                defect_category, solution_cluster, lead_model, project, pu, market,
                last_modified, creation_time, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-CAT-1",
                "Issue with direct category",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "CN Speech",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
                '{"problem_category_udf":{"name":"Should not be parsed"},"reporting_class_udf":{"data":[{"name":"Showstopper_Candidate"}]},"problem_severity_udf":{"name":"05-unsatisfactory"}}',
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-CAT-1",
                "status_phase",
                "2026-05-25T00:00:00Z",
                1,
                1,
                "08",
                "06",
                "08-Resolved Forward",
                "06-Ready for Test",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    parse_calls = 0
    original_safe_json_object = read_models._safe_json_object

    def counting_safe_json_object(raw_value):
        nonlocal parse_calls
        parse_calls += 1
        return original_safe_json_object(raw_value)

    monkeypatch.setattr(read_models, "_safe_json_object", counting_safe_json_object)

    payload = read_models.build_full_picture_payload(years="2026")

    assert payload["ticket_rows"][0]["ticket_id"] == "D-CAT-1"
    assert payload["ticket_rows"][0]["defect_category"] == "CN Speech"
    assert payload["ticket_rows"][0]["classification"] == "Showstopper_Candidate"
    assert payload["ticket_rows"][0]["problem_severity"] == "05-unsatisfactory"
    assert parse_calls == 1


def test_full_picture_qgate_shape_falls_back_to_raw_json_when_defect_category_blank(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "qgate_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
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
                defect_category TEXT,
                solution_cluster TEXT,
                lead_model TEXT,
                project TEXT,
                pu TEXT,
                market TEXT,
                last_modified TEXT,
                creation_time TEXT,
                raw_json TEXT
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
                defect_category, solution_cluster, lead_model, project, pu, market,
                last_modified, creation_time, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-CAT-BLANK-1",
                "Issue with blank category column",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
                '{"problem_category_udf":{"name":"CN Blank Fallback"}}',
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-CAT-BLANK-1",
                "status_phase",
                "2026-05-25T00:00:00Z",
                1,
                1,
                "08",
                "06",
                "08-Resolved Forward",
                "06-Ready for Test",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(db_path, hot_db_path)
    _configure_full_picture_env(
        monkeypatch,
        defect_db_path=db_path,
        hot_db_path=hot_db_path,
    )

    payload = read_models.build_full_picture_payload(years="2026")

    assert payload["ticket_rows"][0]["ticket_id"] == "D-CAT-BLANK-1"
    assert payload["ticket_rows"][0]["defect_category"] == "CN Blank Fallback"


def test_full_picture_skips_empty_local_candidate_when_non_empty_qgate_db_exists(
    tmp_path,
    monkeypatch,
):
    empty_db = tmp_path / "octane_data.db"
    hot_db_path = _default_hot_db_path(tmp_path)
    ensure_schema(empty_db)

    populated_db = tmp_path / "qgate_data.db"
    conn = sqlite3.connect(populated_db)
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
            (
                "D-3",
                "Sibling qgate issue",
                "03-In Analysis",
                "DTSV_China",
                "2026",
                "ECU-A",
                "Speech",
                "",
                "",
                "03-In Analysis",
                "Integration",
                "NA5",
                "IDCEVO",
                "PU1",
                "CN",
                "2026-05-25T00:00:00Z",
                "2026-05-24T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, entry_index, change_index,
                old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-3",
                "status_phase",
                "2026-05-25T00:00:00Z",
                1,
                1,
                "08",
                "06",
                "08-Resolved Forward",
                "06-Ready for Test",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    _refresh_full_picture_hot_outcomes(populated_db, hot_db_path)
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db_path))

    monkeypatch.setattr(
        read_models,
        "get_full_picture_defect_db_candidates",
        lambda: (empty_db, populated_db),
    )
    monkeypatch.setattr(
        read_models,
        "get_full_picture_history_db_candidates",
        lambda: (empty_db, populated_db),
    )

    payload = read_models.build_full_picture_payload(years="2026")

    assert payload["overview"]["ticket_count"] == 1
    assert payload["ticket_rows"][0]["ticket_id"] == "D-3"
    assert payload["generated_from"]["defect_db_path"] == str(populated_db)
    assert payload["generated_from"]["outcome_db_path"] == str(hot_db_path)