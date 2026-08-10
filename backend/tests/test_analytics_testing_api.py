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


def test_testing_team_analysis_returns_dtsv_china_tester_rows(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, tester,
                project, fv, fvp, team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("MR-1", "D-1", "T-1", "Wake test", "Passed", "Tester A", "IDCEVO", "Speech", "Voice", "DTSV_China", "NA5", "{}", "2026-05-25T00:00:00Z"),
                ("MR-2", "D-2", "T-2", "Media test", "Failed", "Tester A", "IDCEVO", "Media", "Entertainment", "DTSV_China", "NA5", "{}", "2026-05-26T00:00:00Z"),
                ("MR-3", "", "T-3", "Navi test", "Passed", "Tester B", "IDC", "Navigation", "Navigation", "DTSV_China", "NA5", "{}", "2026-05-27T00:00:00Z"),
                ("MR-4", "D-4", "T-4", "Other team test", "Passed", "Tester C", "IDC", "Speech", "Voice", "Other_Team", "NA5", "{}", "2026-05-28T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.get("/api/testing/team-analysis")

    assert response.status_code == 200
    assert response.json() == {
        "team": "DTSV_China",
        "years": [],
        "rows": [
            {
                "tester": "Tester A",
                "total_runs": 2,
                "passed_runs": 1,
                "linked_defects": 2,
                "pass_rate": 50.0,
            },
            {
                "tester": "Tester B",
                "total_runs": 1,
                "passed_runs": 1,
                "linked_defects": 0,
                "pass_rate": 100.0,
            },
        ],
    }


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