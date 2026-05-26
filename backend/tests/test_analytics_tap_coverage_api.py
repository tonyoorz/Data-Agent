import sqlite3

from fastapi.testclient import TestClient
import pytest

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
            "tester": "Tester B",
            "count": 1,
        },
    ]


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
