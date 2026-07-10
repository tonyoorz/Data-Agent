import sqlite3

from fastapi.testclient import TestClient
import pytest

from backend.analytics import config as analytics_config
from backend.analytics.api import app
from backend.analytics.schema import ensure_schema


REQUIRED_MISSING_FIELDS = [
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
]


def _seed_source_testing_tables(db_path):
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                top_aida TEXT,
                test_week TEXT,
                project TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                market TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
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
                defect_id, top_aida, test_week, project, pu, fv, fvp,
                team, lead_model, market, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-1",
                "Use Speech operation [01.04.02.01.01.05]",
                "2026-CW21",
                "IDCEVO",
                "ICV",
                "Speech",
                "Voice Experience",
                "DTSV_China",
                "NA5",
                "CN",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, run_by,
                author, year, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-1",
                "D-1",
                "T-1",
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
                test_id, scope_team, scope_release, source, test_name,
                run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
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
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _seed_hot_testing_coverage_rows(db_path):
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE testing_coverage_runs (
                snapshot_version TEXT NOT NULL,
                mr_id TEXT NOT NULL,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                year TEXT,
                test_week TEXT,
                project TEXT,
                pu TEXT,
                top_aida TEXT,
                feature_region TEXT,
                fvp TEXT,
                fv TEXT,
                tester TEXT,
                source_signature TEXT NOT NULL,
                derived_at TEXT NOT NULL,
                PRIMARY KEY (snapshot_version, mr_id)
            );
            CREATE TABLE testing_coverage_snapshot_state (
                snapshot_version TEXT NOT NULL PRIMARY KEY,
                source_signature TEXT NOT NULL,
                row_count INTEGER NOT NULL,
                refresh_status TEXT NOT NULL,
                refreshed_at TEXT NOT NULL,
                last_error TEXT
            );
            CREATE TABLE testing_coverage_snapshot_pointer (
                pointer_name TEXT NOT NULL PRIMARY KEY,
                snapshot_version TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            INSERT INTO testing_coverage_runs(
                snapshot_version,
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                project, pu, top_aida, feature_region, fvp, fv, tester,
                source_signature, derived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "testing-snapshot-hot-1",
                "MR-HOT-1",
                "D-HOT-1",
                "T-HOT-1",
                "Hot wake test",
                "Blocked",
                "2027",
                "2027-CW01",
                "HOT-PROJECT",
                "HOT-PU",
                "HOT-AIDA",
                "Global",
                "HOT-FVP",
                "HOT-FV",
                "Hot Tester",
                "sig-hot",
                "2026-05-27T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO testing_coverage_snapshot_state(
                snapshot_version, source_signature, row_count, refresh_status, refreshed_at, last_error
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "testing-snapshot-hot-1",
                "sig-hot",
                1,
                "ready",
                "2026-05-27T00:00:00Z",
                None,
            ),
        )
        conn.execute(
            """
            INSERT INTO testing_coverage_snapshot_pointer(pointer_name, snapshot_version)
            VALUES (?, ?)
            """,
            ("active", "testing-snapshot-hot-1"),
        )
        conn.commit()
    finally:
        conn.close()


def test_testing_coverage_analysis_returns_503_without_published_testing_snapshot(tmp_path, monkeypatch):
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)
    _seed_source_testing_tables(source_db_path)

    monkeypatch.setattr(analytics_config, "DEFAULT_ANALYTICS_DB_PATH", tmp_path / "legacy" / "octane_data.db")
    monkeypatch.delenv("VIZION_ANALYTICS_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    client = TestClient(app)

    response = client.get("/api/testing/coverage-analysis/filters")

    assert response.status_code == 503
    assert response.json() == {
        "error": "testing coverage analysis data not ready",
        "missing_fields": REQUIRED_MISSING_FIELDS,
    }


def test_testing_coverage_analysis_prefers_hot_materialized_rows_when_available(tmp_path, monkeypatch):
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    hot_db_path = database_root / "hot" / "vizion_serving.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)
    hot_db_path.parent.mkdir(parents=True, exist_ok=True)

    _seed_source_testing_tables(source_db_path)
    _seed_hot_testing_coverage_rows(hot_db_path)

    monkeypatch.setattr(analytics_config, "DEFAULT_ANALYTICS_DB_PATH", tmp_path / "legacy" / "octane_data.db")
    monkeypatch.delenv("VIZION_ANALYTICS_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    client = TestClient(app)

    response = client.get("/api/testing/coverage-analysis/filters")

    assert response.status_code == 200
    assert response.json() == {
        "years": ["2027"],
        "projects": ["HOT-PROJECT"],
        "test_weeks": ["2027-CW01"],
        "pus": ["HOT-PU"],
        "aidas": ["HOT-AIDA"],
        "statuses": ["Blocked"],
        "feature_regions": ["Global"],
        "fvps": ["HOT-FVP"],
        "fvs": ["HOT-FV"],
    }


def test_testing_coverage_analysis_returns_503_when_hot_rows_exist_without_active_snapshot(
    tmp_path,
    monkeypatch,
):
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    hot_db_path = database_root / "hot" / "vizion_serving.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)
    hot_db_path.parent.mkdir(parents=True, exist_ok=True)

    _seed_source_testing_tables(source_db_path)

    conn = sqlite3.connect(hot_db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE testing_coverage_runs (
                snapshot_version TEXT NOT NULL,
                mr_id TEXT NOT NULL,
                source_signature TEXT NOT NULL,
                derived_at TEXT NOT NULL,
                PRIMARY KEY (snapshot_version, mr_id)
            );
            CREATE TABLE testing_coverage_snapshot_state (
                snapshot_version TEXT NOT NULL PRIMARY KEY,
                source_signature TEXT NOT NULL,
                row_count INTEGER NOT NULL,
                refresh_status TEXT NOT NULL,
                refreshed_at TEXT NOT NULL,
                last_error TEXT
            );
            """
        )
        conn.execute(
            """
            INSERT INTO testing_coverage_snapshot_state(
                snapshot_version, source_signature, row_count, refresh_status, refreshed_at, last_error
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "testing-snapshot-without-pointer",
                "sig-hot-without-pointer",
                1,
                "ready",
                "2026-05-27T00:00:00Z",
                None,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr(analytics_config, "DEFAULT_ANALYTICS_DB_PATH", tmp_path / "legacy" / "octane_data.db")
    monkeypatch.delenv("VIZION_ANALYTICS_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    client = TestClient(app)

    response = client.get("/api/testing/coverage-analysis/filters")

    assert response.status_code == 503
    assert response.json() == {
        "error": "testing coverage analysis data not ready",
        "missing_fields": REQUIRED_MISSING_FIELDS,
    }


def test_testing_coverage_analysis_uses_tpmdashboard_feature_region_mapping(
    tmp_path,
    monkeypatch,
):
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)
    _seed_source_testing_tables(source_db_path)

    conn = sqlite3.connect(source_db_path)
    try:
        conn.execute(
            "UPDATE octane_defects SET market = ? WHERE defect_id = ?",
            ("DE", "D-1"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr(analytics_config, "DEFAULT_ANALYTICS_DB_PATH", tmp_path / "legacy" / "octane_data.db")
    monkeypatch.delenv("VIZION_ANALYTICS_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    client = TestClient(app)

    response = client.get("/api/testing/coverage-analysis/filters")

    assert response.status_code == 200
    assert response.json()["feature_regions"] == ["China Specific"]


def test_testing_coverage_analysis_falls_back_from_legacy_columns_when_feature_region_values_are_blank(
    tmp_path,
    monkeypatch,
):
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                top_aida TEXT,
                test_week TEXT,
                project TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                market TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                year TEXT,
                test_week TEXT,
                pu TEXT,
                top_aida TEXT,
                feature_region TEXT,
                tester TEXT,
                project TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
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
                defect_id, top_aida, test_week, project, pu, fv, fvp,
                team, lead_model, market, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-LEGACY-BLANK-1",
                "Use Speech operation [01.04.02.01.01.05]",
                "2026-CW21",
                "IDCEVO",
                "ICV",
                "Speech",
                "Voice Experience",
                "DTSV_China",
                "NA5",
                "CN",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                pu, top_aida, feature_region, tester, project, fv, fvp,
                team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-LEGACY-BLANK-1",
                "D-LEGACY-BLANK-1",
                "T-LEGACY-BLANK-1",
                "Wake test",
                "Passed",
                "2026",
                "2026-CW21",
                "ICV",
                "Use Speech operation [01.04.02.01.01.05]",
                "",
                "Tester A",
                "IDCEVO",
                "Speech",
                "Voice Experience",
                "DTSV_China",
                "NA5",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_testcases(
                test_id, scope_team, scope_release, source, test_name,
                run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "T-LEGACY-BLANK-1",
                "DTSV_China",
                "ALL",
                "runs",
                "Wake test",
                1,
                '["D-LEGACY-BLANK-1"]',
                '[]',
                '[]',
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr(analytics_config, "DEFAULT_ANALYTICS_DB_PATH", tmp_path / "legacy" / "octane_data.db")
    monkeypatch.delenv("VIZION_ANALYTICS_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    client = TestClient(app)

    response = client.get("/api/testing/coverage-analysis/filters")

    assert response.status_code == 200
    assert response.json()["feature_regions"] == ["China Specific"]


def test_testing_coverage_analysis_prefers_tpmdashboard_finished_and_project_rules(
    tmp_path,
    monkeypatch,
):
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                top_aida TEXT,
                test_week TEXT,
                project TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                market TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                name TEXT,
                test_name TEXT,
                status TEXT,
                run_by TEXT,
                author TEXT,
                year TEXT,
                finished TEXT,
                target_ecu_conf TEXT,
                product_areas TEXT,
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
                defect_id, top_aida, test_week, project, pu, fv, fvp,
                team, lead_model, market, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-TPM-1",
                "Use Speech operation [01.04.02.01.01.05]",
                "2099-CW99",
                "LegacyProject",
                "ICV",
                "Speech",
                "Voice Experience",
                "DTSV_China",
                "NA5",
                "DE",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, name, test_name, status, run_by,
                author, year, finished, target_ecu_conf, product_areas, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-TPM-1",
                "D-TPM-1",
                "T-TPM-1",
                "BMW IDCEVO voice wake regression",
                "Wake test",
                "Passed",
                "Tester A",
                "Author A",
                "2026",
                "2026-05-27T08:15:00Z",
                "IDCEVO headunit",
                "Use Speech operation [01.04.02.01.01.05]",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_testcases(
                test_id, scope_team, scope_release, source, test_name,
                run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "T-TPM-1",
                "DTSV_China",
                "ALL",
                "runs",
                "Wake test",
                1,
                '["D-TPM-1"]',
                '["F-1"]',
                '["S-1"]',
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr(analytics_config, "DEFAULT_ANALYTICS_DB_PATH", tmp_path / "legacy" / "octane_data.db")
    monkeypatch.delenv("VIZION_ANALYTICS_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    client = TestClient(app)

    response = client.get("/api/testing/coverage-analysis/filters")

    assert response.status_code == 200
    assert response.json()["projects"] == ["IDCEVO"]
    assert response.json()["test_weeks"] == ["2026-CW22"]


def test_testing_coverage_analysis_uses_tester_column_when_run_by_and_author_are_missing(
    tmp_path,
    monkeypatch,
):
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                top_aida TEXT,
                test_week TEXT,
                project TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                market TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                tester TEXT,
                year TEXT,
                finished TEXT,
                target_ecu_conf TEXT,
                product_areas TEXT,
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
                defect_id, top_aida, test_week, project, pu, fv, fvp, market, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-TESTER-1",
                "Use Speech operation [01.04.02.01.01.05]",
                "2026-CW22",
                "LegacyProject",
                "ICV",
                "Speech",
                "Voice Experience",
                "CN",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, tester, year, finished,
                target_ecu_conf, product_areas, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-TESTER-1",
                "D-TESTER-1",
                "T-TESTER-1",
                "Wake test",
                "Passed",
                "Tester From Column",
                "2026",
                "2026-05-27T08:15:00Z",
                "IDCEVO headunit",
                "Use Speech operation [01.04.02.01.01.05]",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_testcases(
                test_id, scope_team, scope_release, source, test_name,
                run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "T-TESTER-1",
                "ALL",
                "ALL",
                "stage-testing-source",
                "Wake test",
                1,
                '["D-TESTER-1"]',
                '[]',
                '[]',
                '{}',
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr(analytics_config, "DEFAULT_ANALYTICS_DB_PATH", tmp_path / "legacy" / "octane_data.db")
    monkeypatch.delenv("VIZION_ANALYTICS_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    client = TestClient(app)

    filters_response = client.get("/api/testing/coverage-analysis/filters")
    detail_response = client.get("/api/testing/coverage-analysis/testcase-detail")

    assert filters_response.status_code == 200
    assert detail_response.status_code == 200
    assert detail_response.json() == [
        {
            "test_id": "T-TESTER-1",
            "test_name": "Wake test",
            "test_week": "2026-CW22",
            "status": "Passed",
            "top_aida": "Use Speech operation [01.04.02.01.01.05]",
            "project": "IDCEVO",
            "pu": "ICV",
            "tester": "Tester From Column",
            "count": 1,
        }
    ]


def test_testing_coverage_analysis_source_queries_prefer_manual_run_dimensions_when_defect_values_are_blank(
    tmp_path,
    monkeypatch,
):
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                top_aida TEXT,
                test_week TEXT,
                project TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                market TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                tester TEXT,
                year TEXT,
                finished TEXT,
                target_ecu_conf TEXT,
                pu TEXT,
                top_aida TEXT,
                fv TEXT,
                fvp TEXT,
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
                defect_id, top_aida, test_week, project, pu, fv, fvp, market, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-MANUAL-DIMS-1",
                "",
                "",
                "",
                "",
                "",
                "",
                "CN",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, tester, year, finished,
                target_ecu_conf, pu, top_aida, fv, fvp, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-MANUAL-DIMS-1",
                "D-MANUAL-DIMS-1",
                "T-MANUAL-DIMS-1",
                "Wake test",
                "Passed",
                "Tester From Manual Run",
                "2026",
                "2026-05-27T08:15:00Z",
                "IDCEVO headunit",
                "ICV",
                "Use Speech operation [01.04.02.01.01.05]",
                "Speech",
                "Voice Experience",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_testcases(
                test_id, scope_team, scope_release, source, test_name,
                run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "T-MANUAL-DIMS-1",
                "ALL",
                "ALL",
                "stage-testing-source",
                "Wake test",
                1,
                '["D-MANUAL-DIMS-1"]',
                '[]',
                '[]',
                '{}',
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr(analytics_config, "DEFAULT_ANALYTICS_DB_PATH", tmp_path / "legacy" / "octane_data.db")
    monkeypatch.delenv("VIZION_ANALYTICS_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    client = TestClient(app)

    filters_response = client.get("/api/testing/coverage-analysis/filters")
    project_status_response = client.get("/api/testing/coverage-analysis/project-status")
    aida_status_response = client.get("/api/testing/coverage-analysis/aida-status")
    detail_response = client.get("/api/testing/coverage-analysis/testcase-detail")

    assert filters_response.status_code == 200
    assert filters_response.json() == {
        "years": ["2026"],
        "projects": ["IDCEVO"],
        "test_weeks": ["2026-CW22"],
        "pus": ["ICV"],
        "aidas": ["Use Speech operation [01.04.02.01.01.05]"],
        "statuses": ["Passed"],
        "feature_regions": ["China Specific"],
        "fvps": ["Voice Experience"],
        "fvs": ["Speech"],
    }
    assert project_status_response.status_code == 200
    assert project_status_response.json() == [
        {
            "test_week": "2026-CW22",
            "fv": "Speech",
            "fvp": "Voice Experience",
            "status": "Passed",
            "count": 1,
        }
    ]
    assert aida_status_response.status_code == 200
    assert aida_status_response.json() == [
        {
            "test_week": "2026-CW22",
            "top_aida": "Use Speech operation [01.04.02.01.01.05]",
            "status": "Passed",
            "count": 1,
        }
    ]
    assert detail_response.status_code == 200
    assert detail_response.json() == [
        {
            "test_id": "T-MANUAL-DIMS-1",
            "test_name": "Wake test",
            "test_week": "2026-CW22",
            "status": "Passed",
            "top_aida": "Use Speech operation [01.04.02.01.01.05]",
            "project": "IDCEVO",
            "pu": "ICV",
            "tester": "Tester From Manual Run",
            "count": 1,
        }
    ]


def test_testing_coverage_analysis_endpoints_return_grouped_data(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                pu, top_aida, feature_region, tester, project, fv, fvp,
                team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-1",
                    "D-1",
                    "T-1",
                    "Wake test",
                    "Passed",
                    "2026",
                    "TW22",
                    "PU1",
                    "AIDA-1",
                    "China",
                    "Tester A",
                    "IDCEVO",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    "{}",
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "MR-2",
                    "D-2",
                    "T-1",
                    "Wake test",
                    "Failed",
                    "2026",
                    "TW22",
                    "PU1",
                    "AIDA-1",
                    "China",
                    "Tester A",
                    "IDCEVO",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    "{}",
                    "2026-05-25T00:05:00Z",
                ),
                (
                    "MR-3",
                    "D-3",
                    "T-2",
                    "Media test",
                    "Passed",
                    "2026",
                    "TW23",
                    "PU2",
                    "AIDA-2",
                    "Global",
                    "Tester B",
                    "ICAS3",
                    "Media",
                    "Entertainment",
                    "DTSV_Global",
                    "NA5",
                    "{}",
                    "2026-05-25T00:10:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    filters = client.get("/api/testing/coverage-analysis/filters")
    project_status = client.get(
        "/api/testing/coverage-analysis/project-status",
        params={"years": ["2026"], "projects": ["IDCEVO", "ICAS3"]},
    )
    aida_status = client.get(
        "/api/testing/coverage-analysis/aida-status",
        params={"years": ["2026"], "statuses": ["Passed", "Failed"]},
    )
    testcase_detail = client.get(
        "/api/testing/coverage-analysis/testcase-detail",
        params={"years": ["2026"], "test_weeks": ["TW22", "TW23"]},
    )

    assert filters.status_code == 200
    assert filters.json() == {
        "years": ["2026"],
        "projects": ["ICAS3", "IDCEVO"],
        "test_weeks": ["TW22", "TW23"],
        "pus": ["PU1", "PU2"],
        "aidas": ["AIDA-1", "AIDA-2"],
        "statuses": ["Failed", "Passed"],
        "feature_regions": ["China", "Global"],
        "fvps": ["Entertainment", "Voice"],
        "fvs": ["Media", "Speech"],
    }

    assert project_status.status_code == 200
    assert project_status.json() == [
        {
            "test_week": "TW22",
            "fv": "Speech",
            "fvp": "Voice",
            "status": "Failed",
            "count": 1,
        },
        {
            "test_week": "TW22",
            "fv": "Speech",
            "fvp": "Voice",
            "status": "Passed",
            "count": 1,
        },
        {
            "test_week": "TW23",
            "fv": "Media",
            "fvp": "Entertainment",
            "status": "Passed",
            "count": 1,
        },
    ]

    assert aida_status.status_code == 200
    assert aida_status.json() == [
        {"test_week": "TW22", "top_aida": "AIDA-1", "status": "Failed", "count": 1},
        {"test_week": "TW22", "top_aida": "AIDA-1", "status": "Passed", "count": 1},
        {"test_week": "TW23", "top_aida": "AIDA-2", "status": "Passed", "count": 1},
    ]

    assert testcase_detail.status_code == 200
    assert testcase_detail.json() == [
        {
            "test_id": "T-1",
            "test_name": "Wake test",
            "test_week": "TW22",
            "status": "Failed",
            "top_aida": "AIDA-1",
            "project": "IDCEVO",
            "pu": "PU1",
            "fvp": "Voice",
            "fv": "Speech",
            "tester": "Tester A",
            "count": 1,
        },
        {
            "test_id": "T-1",
            "test_name": "Wake test",
            "test_week": "TW22",
            "status": "Passed",
            "top_aida": "AIDA-1",
            "project": "IDCEVO",
            "pu": "PU1",
            "fvp": "Voice",
            "fv": "Speech",
            "tester": "Tester A",
            "count": 1,
        },
        {
            "test_id": "T-2",
            "test_name": "Media test",
            "test_week": "TW23",
            "status": "Passed",
            "top_aida": "AIDA-2",
            "project": "ICAS3",
            "pu": "PU2",
            "fvp": "Entertainment",
            "fv": "Media",
            "tester": "Tester B",
            "count": 1,
        },
    ]


def test_testing_coverage_filter_options_keep_available_years_when_year_is_selected(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                pu, top_aida, feature_region, tester, project, fv, fvp,
                team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-2025",
                    "D-2025",
                    "T-2025",
                    "Legacy wake test",
                    "Passed",
                    "2025",
                    "2025-CW50",
                    "PU-2025",
                    "AIDA-2025",
                    "China",
                    "Tester 2025",
                    "SP25",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    "{}",
                    "2025-12-12T00:00:00Z",
                ),
                (
                    "MR-2026",
                    "D-2026",
                    "T-2026",
                    "Current wake test",
                    "Failed",
                    "2026",
                    "2026-CW21",
                    "PU-2026",
                    "AIDA-2026",
                    "Global",
                    "Tester 2026",
                    "SP26",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    "{}",
                    "2026-05-25T00:00:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.get("/api/testing/coverage-analysis/filters", params={"years": "2026"})

    assert response.status_code == 200
    assert response.json()["years"] == ["2025", "2026"]
    assert response.json()["projects"] == ["SP26"]


def test_testing_coverage_analysis_testcase_detail_honors_limit_query_param(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                pu, top_aida, feature_region, tester, project, fv, fvp,
                team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-L1",
                    "D-L1",
                    "T-L1",
                    "Wake test 1",
                    "Passed",
                    "2026",
                    "TW22",
                    "PU1",
                    "AIDA-1",
                    "China",
                    "Tester A",
                    "IDCEVO",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    "{}",
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "MR-L2",
                    "D-L2",
                    "T-L2",
                    "Wake test 2",
                    "Failed",
                    "2026",
                    "TW22",
                    "PU1",
                    "AIDA-2",
                    "China",
                    "Tester B",
                    "IDCEVO",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    "{}",
                    "2026-05-25T00:01:00Z",
                ),
                (
                    "MR-L3",
                    "D-L3",
                    "T-L3",
                    "Wake test 3",
                    "Blocked",
                    "2026",
                    "TW23",
                    "PU1",
                    "AIDA-3",
                    "China",
                    "Tester C",
                    "IDCEVO",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    "{}",
                    "2026-05-25T00:02:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.get(
        "/api/testing/coverage-analysis/testcase-detail",
        params={"years": ["2026"], "limit": 2},
    )

    assert response.status_code == 200
    assert len(response.json()) == 2


def test_testing_coverage_analysis_grouped_endpoints_merge_normalized_bucket_values(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                pu, top_aida, feature_region, tester, project, fv, fvp,
                team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-1",
                    "D-1",
                    "T-1",
                    "Wake test",
                    "Passed",
                    "2026",
                    "TW22",
                    "PU1",
                    "AIDA-1",
                    "China",
                    "Tester A",
                    "IDCEVO",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    "{}",
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "MR-2",
                    "D-2",
                    "T-1",
                    " Wake test ",
                    " Passed ",
                    "2026",
                    "TW22",
                    "PU1",
                    " AIDA-1 ",
                    "China",
                    " Tester A ",
                    "IDCEVO",
                    " Speech ",
                    " Voice ",
                    "DTSV_China",
                    "NA5",
                    "{}",
                    "2026-05-25T00:05:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    project_status = client.get("/api/testing/coverage-analysis/project-status")
    aida_status = client.get("/api/testing/coverage-analysis/aida-status")
    testcase_detail = client.get("/api/testing/coverage-analysis/testcase-detail")

    assert project_status.status_code == 200
    assert project_status.json() == [
        {
            "test_week": "TW22",
            "fv": "Speech",
            "fvp": "Voice",
            "status": "Passed",
            "count": 2,
        }
    ]

    assert aida_status.status_code == 200
    assert aida_status.json() == [
        {"test_week": "TW22", "top_aida": "AIDA-1", "status": "Passed", "count": 2}
    ]

    assert testcase_detail.status_code == 200
    assert testcase_detail.json() == [
        {
            "test_id": "T-1",
            "test_name": "Wake test",
            "test_week": "TW22",
            "status": "Passed",
            "top_aida": "AIDA-1",
            "project": "IDCEVO",
            "pu": "PU1",
            "tester": "Tester A",
            "count": 2,
        }
    ]


def test_testing_coverage_analysis_repeated_query_params_preserve_commas_in_values(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                pu, top_aida, feature_region, tester, project, fv, fvp,
                team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-1",
                    "D-1",
                    "T-1",
                    "Wake test",
                    "Passed",
                    "2026",
                    "TW22",
                    "PU1",
                    "AIDA-1",
                    "North,America",
                    "Tester A",
                    "Audio,Platform",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    "{}",
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "MR-2",
                    "D-2",
                    "T-2",
                    "Other test",
                    "Passed",
                    "2026",
                    "TW22",
                    "PU2",
                    "AIDA-2",
                    "Global",
                    "Tester B",
                    "IDCEVO",
                    "Media",
                    "Entertainment",
                    "DTSV_Global",
                    "NA5",
                    "{}",
                    "2026-05-25T00:05:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.get(
        "/api/testing/coverage-analysis/project-status",
        params=[("projects", "Audio,Platform"), ("feature_regions", "North,America")],
    )

    assert response.status_code == 200
    assert response.json() == [
        {
            "test_week": "TW22",
            "fv": "Speech",
            "fvp": "Voice",
            "status": "Passed",
            "count": 1,
        }
    ]


@pytest.mark.parametrize(
    "path",
    [
        "/api/testing/coverage-analysis/filters",
        "/api/testing/coverage-analysis/project-status",
        "/api/testing/coverage-analysis/aida-status",
        "/api/testing/coverage-analysis/testcase-detail",
    ],
)
def test_testing_coverage_analysis_endpoints_return_503_when_data_is_missing(
    tmp_path,
    monkeypatch,
    path,
):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.get(path)

    assert response.status_code == 503
    assert response.json() == {
        "error": "testing coverage analysis data not ready",
        "missing_fields": REQUIRED_MISSING_FIELDS,
    }


def test_testing_coverage_analysis_returns_503_for_uninitialized_default_db(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "uninitialized_octane_data.db"
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.get("/api/testing/coverage-analysis/filters")

    assert response.status_code == 503
    assert response.json() == {
        "error": "testing coverage analysis data not ready",
        "missing_fields": REQUIRED_MISSING_FIELDS,
    }
