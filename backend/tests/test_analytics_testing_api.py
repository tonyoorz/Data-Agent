import sqlite3

from fastapi.testclient import TestClient

from backend.analytics import config as analytics_config
from backend.analytics.api import app
from backend.analytics.schema import ensure_schema


def _seed_source_testing_api_tables(db_path):
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                project TEXT,
                market TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                name TEXT,
                status TEXT,
                run_by TEXT,
                author TEXT,
                year TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            CREATE TABLE octane_testcases (
                test_id TEXT NOT NULL,
                scope_team TEXT NOT NULL,
                scope_release TEXT NOT NULL,
                source TEXT NOT NULL,
                test_name TEXT,
                run_count INTEGER NOT NULL,
                defect_ids_json TEXT NOT NULL,
                feature_ids_json TEXT NOT NULL,
                story_ids_json TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (test_id, scope_team, scope_release, source)
            );
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, project, market, pu, fv, fvp, team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-1",
                "Wake issue",
                "IDCEVO",
                "CN",
                "PU1",
                "Speech",
                "Voice",
                "DTSV_China",
                "NA5",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, name, status, run_by, author, year, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-1",
                "D-1",
                "T-1",
                "Wake test",
                "Wake test",
                "Passed",
                "Tester A",
                "Author A",
                "2026",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_testcases(
                test_id, scope_team, scope_release, source, test_name, run_count,
                defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "T-1",
                "DTSV_China",
                "ALL",
                "runs",
                "Wake test",
                1,
                '["D-1"]',
                '["F-1"]',
                '["S-1"]',
                '{"test_id":"T-1"}',
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()


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
            ("T-1", "DTSV_China", "ALL", "runs", "Wake test", 1, '["D-1"]', '["F-1"]', '["S-1"]', '{"test_id":"T-1"}', "2026-05-25T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    summary = client.get("/api/testing/summary")
    testcases = client.get("/api/testing/testcases")

    assert summary.status_code == 200
    assert summary.json()["total_runs"] == 1
    assert summary.json()["total_testcases"] == 1
    assert testcases.status_code == 200
    assert testcases.json()[0]["test_id"] == "T-1"


def test_metadata_and_correlation_endpoints_are_available(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO octane_defects(defect_id, name, project, market, pu, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("D-1", "Wake issue", "IDCEVO", "CN", "PU1", "Speech", "Tony", "DTSV_China", "NA5", "{}", "2026-05-25T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO octane_testcases(test_id, scope_team, scope_release, source, test_name, run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("T-1", "DTSV_China", "ALL", "runs", "Wake test", 1, '["D-1"]', '["F-1"]', '["S-1"]', '{"test_id":"T-1"}', "2026-05-25T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    metadata = client.get("/api/metadata/filters")
    correlation = client.get("/api/correlation/defect-test", params={"defect_id": "D-1"})

    assert metadata.status_code == 200
    assert "projects" in metadata.json()
    assert correlation.status_code == 200
    assert correlation.json()["defect_id"] == "D-1"
    assert correlation.json()["test_ids"] == ["T-1"]


def test_testing_endpoints_default_to_local_source_copy(tmp_path, monkeypatch):
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)
    _seed_source_testing_api_tables(source_db_path)

    monkeypatch.setattr(analytics_config, "DEFAULT_ANALYTICS_DB_PATH", tmp_path / "legacy" / "octane_data.db")
    monkeypatch.delenv("VIZION_ANALYTICS_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    client = TestClient(app)

    summary = client.get("/api/testing/summary")
    testcases = client.get("/api/testing/testcases")
    runs = client.get("/api/testing/runs")
    metadata = client.get("/api/metadata/filters")
    correlation = client.get("/api/correlation/defect-test", params={"defect_id": "D-1"})

    assert summary.status_code == 200
    assert summary.json() == {"total_runs": 1, "total_testcases": 1}
    assert testcases.status_code == 200
    assert testcases.json()[0]["test_id"] == "T-1"
    assert runs.status_code == 200
    assert runs.json()[0]["project"] == "IDCEVO"
    assert runs.json()[0]["team"] == "DTSV_China"
    assert metadata.status_code == 200
    assert metadata.json()["projects"] == ["IDCEVO"]
    assert correlation.status_code == 200
    assert correlation.json() == {"defect_id": "D-1", "test_ids": ["T-1"]}