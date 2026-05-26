import sqlite3

from fastapi.testclient import TestClient

from backend.analytics.api import app
from backend.analytics import read_models
from backend.analytics.schema import ensure_schema


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


def test_full_picture_dashboard_endpoint_exists():
    monkeypatch_path = "C:/__missing__/octane_data.db"
    import os

    os.environ["VIZION_FULL_PICTURE_DEFECT_DB_PATH"] = monkeypatch_path
    os.environ["VIZION_FULL_PICTURE_HISTORY_DB_PATH"] = monkeypatch_path
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard")

    assert response.status_code == 503
    assert response.json()["error"] == "analytics database not initialized"
    os.environ.pop("VIZION_FULL_PICTURE_DEFECT_DB_PATH", None)
    os.environ.pop("VIZION_FULL_PICTURE_HISTORY_DB_PATH", None)


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

    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(db_path))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["overview"]["ticket_count"] == 1
    assert payload["ticket_rows"][0]["ticket_id"] == "D-1"
    assert payload["ticket_rows"][0]["is_resolved_forward"] is True
    assert payload["generated_from"]["defect_db_path"] == str(db_path)


def test_full_picture_prefers_local_octane_db_when_explicitly_configured(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
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
                defect_id, event_timestamp, field_name, old_value, new_value, raw_event_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-2",
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

    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(db_path))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(db_path))

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ticket_rows"][0]["ticket_id"] == "D-2"
    assert payload["ticket_rows"][0]["defect_category"] == "CN Speech"
    assert payload["generated_from"]["defect_db_path"] == str(db_path)


def test_full_picture_qgate_shape_falls_back_to_problem_category_from_raw_json(tmp_path, monkeypatch):
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

    monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(db_path))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(db_path))

    client = TestClient(app)
    response = client.get("/api/full-picture/dashboard?years=2026")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ticket_rows"][0]["defect_id" if False else "ticket_id"] == "D-RAW-1"
    assert payload["ticket_rows"][0]["defect_category"] == "CN IPA_Intelligence"


def test_full_picture_skips_empty_local_candidate_when_non_empty_qgate_db_exists(
    tmp_path,
    monkeypatch,
):
    empty_db = tmp_path / "octane_data.db"
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