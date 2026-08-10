import sqlite3
import time

from fastapi.testclient import TestClient

from backend.analytics.agent_actor_capability import (
    ACTOR_CAPABILITY_HEADER,
    create_actor_capability,
)
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


def test_testing_team_analysis_groups_dtsv_runs_by_fv_and_normalizes_week_input(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, tester, year,
                test_week, project, fv, fvp, team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("MR-1", "D-1", "T-1", "Speech wake", "Passed", "Tester A", "2026", "26-CW19", "IDCEVO", "Speech", "Voice", "DTSV_China", "NA5", "{}", "2026-05-25T00:00:00Z"),
                ("MR-2", "D-1", "T-2", "Speech media", "Failed", "Tester B", "2026", "26-CW19", "IDCEVO", "Speech", "Voice", "DTSV_China", "NA5", "{}", "2026-05-25T00:00:00Z"),
                ("MR-3", "D-2", "T-3", "Navi route", "Passed", "Tester C", "2026", "26-CW19", "IDC", "Navigation", "Navigation", "DTSV_China", "NA5", "{}", "2026-05-25T00:00:00Z"),
                ("MR-4", "D-3", "T-4", "Prior week", "Passed", "Tester D", "2026", "26-CW18", "IDC", "Navigation", "Navigation", "DTSV_China", "NA5", "{}", "2026-05-18T00:00:00Z"),
                ("MR-5", "D-4", "T-5", "Other team", "Passed", "Tester E", "2026", "26-CW19", "IDC", "Speech", "Voice", "Other_Team", "NA5", "{}", "2026-05-25T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.get(
        "/api/testing/team-analysis",
        params={"group_by": "fv", "test_weeks": "2026-W19"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "team": "DTSV_China",
        "years": [],
        "test_weeks": ["2026-CW19"],
        "group_by": "fv",
        "rows": [
            {
                "fv": "Speech",
                "total_runs": 2,
                "passed_runs": 1,
                "linked_defects": 1,
                "pass_rate": 50.0,
                "defect_discovery_rate": 50.0,
            },
            {
                "fv": "Navigation",
                "total_runs": 1,
                "passed_runs": 1,
                "linked_defects": 1,
                "pass_rate": 100.0,
                "defect_discovery_rate": 100.0,
            },
        ],
    }


def test_agent_testing_team_fv_analysis_enforces_actor_team_scope(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                project, fv, fvp, team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("MR-1", "D-1", "T-1", "DTSV speech", "Passed", "2026", "26-CW19", "IDCEVO", "Speech", "Voice", "DTSV_China", "NA5", "{}", "2026-05-25T00:00:00Z"),
                ("MR-2", "D-2", "T-2", "Other speech", "Passed", "2026", "26-CW19", "IDCEVO", "Speech", "Voice", "Other_Team", "NA5", "{}", "2026-05-25T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    secret = "agent-testing-fv-analysis-secret"
    now = int(time.time())
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    monkeypatch.setenv("VIZION_AGENT_ACTOR_CAPABILITY_SECRET", secret)
    token = create_actor_capability(
        {
            "actorId": "alice",
            "scopeHash": "oidc-alice-dtsv",
            "scopes": {
                "allowedObjectTypes": ["quality.defect"],
                "teamIds": ["DTSV_China"],
            },
        },
        secret=secret,
        now=now,
        nonce="agent-testing-fv-analysis",
    )
    client = TestClient(app)
    request_payload = {"team": "DTSV_China", "test_weeks": ["2026-W19"]}

    assert client.post("/api/agent/analytics/testing/team-fv-analysis", json=request_payload).status_code == 401

    allowed_response = client.post(
        "/api/agent/analytics/testing/team-fv-analysis",
        json=request_payload,
        headers={ACTOR_CAPABILITY_HEADER: token},
    )

    assert allowed_response.status_code == 200
    assert allowed_response.json() == {
        "team": "DTSV_China",
        "years": [],
        "test_weeks": ["2026-CW19"],
        "group_by": "fv",
        "rows": [
            {
                "fv": "Speech",
                "total_runs": 1,
                "passed_runs": 1,
                "linked_defects": 1,
                "pass_rate": 100.0,
                "defect_discovery_rate": 100.0,
            },
        ],
    }

    denied_response = client.post(
        "/api/agent/analytics/testing/team-fv-analysis",
        json={"team": "Other_Team"},
        headers={ACTOR_CAPABILITY_HEADER: token},
    )

    assert denied_response.status_code == 403
    assert denied_response.json()["code"] == "ACTOR_CAPABILITY_SCOPE_DENIED"


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