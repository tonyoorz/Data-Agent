from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from backend.analytics.ingest.source_store import OctaneSourceStore


def _seed_traceability_db(db_path: Path) -> None:
    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                project, team, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-TRACE-1",
                "D-TRACE-1",
                "T-TRACE-1",
                "Wake trace test",
                "Failed",
                "2026",
                "2026-CW27",
                "IDCEVO",
                "DTSV_China",
                json.dumps({"seed": True}),
                "2026-06-30T08:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                project, team, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-GAP-1",
                "",
                "T-GAP-1",
                "Untraced test",
                "Planned",
                "2026",
                "2026-CW27",
                "IDCEVO",
                "DTSV_China",
                json.dumps({"seed": True}),
                "2026-06-30T08:00:00Z",
            ),
        )
        conn.executemany(
            """
            INSERT INTO octane_run_traceability(
                run_id, test_id, test_name, scope_team, scope_release, year,
                source, status, relation_type, related_id, related_name, related_subtype,
                related_path, parent_id, parent_name, parent_subtype, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-TRACE-1",
                    "T-TRACE-1",
                    "Wake trace test",
                    "DTSV_China",
                    "R-26-06",
                    "2026",
                    "manual_runs",
                    "Failed",
                    "feature",
                    "F-TRACE-1",
                    "Wake feature",
                    "feature",
                    "epic/wake-feature",
                    "E-TRACE-1",
                    "Wake epic",
                    "epic",
                    "2026-06-30T08:00:00Z",
                ),
                (
                    "MR-TRACE-1",
                    "T-TRACE-1",
                    "Wake trace test",
                    "DTSV_China",
                    "R-26-06",
                    "2026",
                    "manual_runs",
                    "Failed",
                    "story",
                    "S-TRACE-1",
                    "Wake story",
                    "story",
                    "epic/wake-feature/wake-story",
                    "F-TRACE-1",
                    "Wake feature",
                    "feature",
                    "2026-06-30T08:00:00Z",
                ),
                (
                    "MR-TRACE-1",
                    "T-TRACE-1",
                    "Wake trace test",
                    "DTSV_China",
                    "R-26-06",
                    "2026",
                    "manual_runs",
                    "Failed",
                    "defect",
                    "D-TRACE-1",
                    "Wake defect",
                    "defect",
                    "defect/wake-defect",
                    "",
                    "",
                    "",
                    "2026-06-30T08:00:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()


def test_build_traceability_analysis_payload_summarizes_relations(tmp_path: Path, monkeypatch) -> None:
    from backend.analytics.traceability_models import build_traceability_analysis_payload

    db_path = tmp_path / "qgate_raw.db"
    _seed_traceability_db(db_path)
    monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", str(db_path))

    payload = build_traceability_analysis_payload({"years": "2026"})

    assert payload["summary"] == {
        "total_runs": 2,
        "traced_runs": 1,
        "total_testcases": 2,
        "traced_testcases": 1,
        "traceability_rate": 50.0,
        "feature_count": 1,
        "story_count": 1,
        "defect_count": 1,
        "relation_rows": 3,
    }
    assert payload["relation_type_rows"] == [
        {"relation_type": "defect", "run_count": 1, "testcase_count": 1, "related_count": 1},
        {"relation_type": "feature", "run_count": 1, "testcase_count": 1, "related_count": 1},
        {"relation_type": "story", "run_count": 1, "testcase_count": 1, "related_count": 1},
    ]
    assert payload["filter_options"]["weeks"] == ["2026-CW27"]
    assert {
        "relation_type": "feature",
        "related_id": "F-TRACE-1",
        "related_name": "Wake feature",
        "parent_name": "Wake epic",
        "run_count": 1,
        "testcase_count": 1,
        "failed_runs": 1,
        "passed_runs": 0,
    } in payload["top_related_items"]
    assert payload["traceability_chain_rows"] == [
        {
            "epic_ids": "E-TRACE-1",
            "epic_names": "Wake epic",
            "feature_ids": "F-TRACE-1",
            "feature_names": "Wake feature",
            "story_ids": "S-TRACE-1",
            "story_names": "Wake story",
            "defect_ids": "D-TRACE-1",
            "defect_names": "Wake defect",
            "test_id": "T-TRACE-1",
            "test_name": "Wake trace test",
            "run_id": "MR-TRACE-1",
            "run_status": "Failed",
            "scope_team": "DTSV_China",
            "scope_release": "R-26-06",
        }
    ]
    assert payload["graph"]["layers"] == ["epic", "feature", "story", "testcase", "manual_run", "defect"]
    assert payload["graph"]["nodes"] == [
        {
            "id": "epic:E-TRACE-1",
            "type": "epic",
            "label": "Wake epic",
            "secondary_label": "E-TRACE-1",
            "status": "",
            "count": 1,
        },
        {
            "id": "feature:F-TRACE-1",
            "type": "feature",
            "label": "Wake feature",
            "secondary_label": "F-TRACE-1",
            "status": "",
            "count": 1,
        },
        {
            "id": "story:S-TRACE-1",
            "type": "story",
            "label": "Wake story",
            "secondary_label": "S-TRACE-1",
            "status": "",
            "count": 1,
        },
        {
            "id": "testcase:T-TRACE-1",
            "type": "testcase",
            "label": "Wake trace test",
            "secondary_label": "T-TRACE-1",
            "status": "",
            "count": 1,
        },
        {
            "id": "manual_run:MR-TRACE-1",
            "type": "manual_run",
            "label": "Wake trace test",
            "secondary_label": "MR-TRACE-1",
            "status": "Failed",
            "count": 1,
        },
        {
            "id": "defect:D-TRACE-1",
            "type": "defect",
            "label": "Wake defect",
            "secondary_label": "D-TRACE-1",
            "status": "",
            "count": 1,
        },
    ]
    assert payload["graph"]["edges"] == [
        {"id": "epic:E-TRACE-1->feature:F-TRACE-1", "from": "epic:E-TRACE-1", "to": "feature:F-TRACE-1", "count": 1},
        {"id": "feature:F-TRACE-1->story:S-TRACE-1", "from": "feature:F-TRACE-1", "to": "story:S-TRACE-1", "count": 1},
        {"id": "story:S-TRACE-1->testcase:T-TRACE-1", "from": "story:S-TRACE-1", "to": "testcase:T-TRACE-1", "count": 1},
        {"id": "testcase:T-TRACE-1->manual_run:MR-TRACE-1", "from": "testcase:T-TRACE-1", "to": "manual_run:MR-TRACE-1", "count": 1},
        {"id": "manual_run:MR-TRACE-1->defect:D-TRACE-1", "from": "manual_run:MR-TRACE-1", "to": "defect:D-TRACE-1", "count": 1},
    ]
    assert payload["gap_rows"] == [
        {
            "test_id": "T-GAP-1",
            "test_name": "Untraced test",
            "run_count": 1,
            "latest_status": "Planned",
            "project": "IDCEVO",
            "team": "DTSV_China",
        }
    ]

    release_payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-06"})

    assert release_payload["summary"]["total_runs"] == 1
    assert release_payload["summary"]["traced_runs"] == 1
    assert release_payload["summary"]["traceability_rate"] == 100.0
    assert release_payload["status_rows"] == [
        {"status": "Failed", "total_runs": 1, "traced_runs": 1}
    ]
    assert release_payload["gap_rows"] == []

    week_payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-06", "weeks": "2026-CW27"})

    assert week_payload["summary"]["total_runs"] == 1
    assert week_payload["summary"]["traced_runs"] == 1
    assert len(week_payload["traceability_chain_rows"]) == 1

    empty_week_payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-06", "weeks": "2026-CW28"})

    assert empty_week_payload["summary"]["total_runs"] == 0
    assert empty_week_payload["summary"]["traced_runs"] == 0
    assert empty_week_payload["traceability_chain_rows"] == []


def test_build_traceability_analysis_payload_returns_all_chain_rows(tmp_path: Path, monkeypatch) -> None:
    from backend.analytics.traceability_models import build_traceability_analysis_payload

    db_path = tmp_path / "qgate_raw.db"
    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        manual_rows = []
        traceability_rows = []
        for index in range(105):
            run_id = f"MR-BULK-{index:03d}"
            test_id = f"T-BULK-{index:03d}"
            manual_rows.append(
                (
                    run_id,
                    "",
                    test_id,
                    f"Bulk trace test {index:03d}",
                    "Passed",
                    "2026",
                    "2026-CW20",
                    "IDCEVO",
                    "DTSV_China",
                    json.dumps({"seed": True}),
                    "2026-05-20T08:00:00Z",
                )
            )
            traceability_rows.append(
                (
                    run_id,
                    test_id,
                    f"Bulk trace test {index:03d}",
                    "DTSV_China",
                    "R-26-05",
                    "2026",
                    "manual_runs",
                    "Passed",
                    "feature",
                    f"F-BULK-{index:03d}",
                    f"Bulk feature {index:03d}",
                    "feature",
                    "bulk/feature",
                    "E-BULK",
                    "Bulk epic",
                    "epic",
                    "2026-05-20T08:00:00Z",
                )
            )

        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                project, team, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            manual_rows,
        )
        conn.executemany(
            """
            INSERT INTO octane_run_traceability(
                run_id, test_id, test_name, scope_team, scope_release, year,
                source, status, relation_type, related_id, related_name, related_subtype,
                related_path, parent_id, parent_name, parent_subtype, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            traceability_rows,
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", str(db_path))

    payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-05"})

    assert payload["summary"]["traced_runs"] == 105
    assert len(payload["traceability_chain_rows"]) == 105


def test_traceability_week_filter_falls_back_to_execution_date(tmp_path: Path, monkeypatch) -> None:
    from backend.analytics.traceability_models import build_traceability_analysis_payload

    db_path = tmp_path / "qgate_raw.db"
    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                project, team, raw_json, fetched_at, release, finished
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-WEEK-1",
                "",
                "T-WEEK-1",
                "Week fallback test",
                "Passed",
                "2026",
                "",
                "IDCEVO",
                "DTSV_China",
                json.dumps({"seed": True}),
                "2026-07-08T08:00:00Z",
                "R-26-07",
                "2026-07-08T08:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_run_traceability(
                run_id, test_id, test_name, scope_team, scope_release, year,
                source, status, relation_type, related_id, related_name, related_subtype,
                related_path, parent_id, parent_name, parent_subtype, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-WEEK-1",
                "T-WEEK-1",
                "Week fallback test",
                "DTSV_China",
                "R-26-07",
                "2026",
                "manual_runs",
                "Passed",
                "story",
                "S-WEEK-1",
                "Week story",
                "story",
                "feature/week-story",
                "F-WEEK-1",
                "Week feature",
                "feature",
                "2026-07-08T08:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", str(db_path))

    payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-07"})
    week_payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-07", "weeks": "2026-CW28"})
    empty_week_payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-07", "weeks": "2026-CW27"})

    assert payload["filter_options"]["weeks"] == ["2026-CW28"]
    assert week_payload["summary"]["traced_runs"] == 1
    assert empty_week_payload["summary"]["traced_runs"] == 0


def test_traceability_week_filter_uses_planned_week_from_feature_names(tmp_path: Path, monkeypatch) -> None:
    from backend.analytics.traceability_models import build_traceability_analysis_payload

    db_path = tmp_path / "qgate_raw.db"
    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                project, team, raw_json, fetched_at, release, finished
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-PLAN-26",
                    "",
                    "T-PLAN-26",
                    "Planned week SET test",
                    "Passed",
                    "2026",
                    "",
                    "IDCEVO",
                    "DTSV_China",
                    json.dumps({"seed": True}),
                    "2026-07-08T08:00:00Z",
                    "R-26-07",
                    "2026-07-08T08:00:00Z",
                ),
                (
                    "MR-PLAN-29",
                    "",
                    "T-PLAN-29",
                    "Planned week CW test",
                    "Passed",
                    "2026",
                    "",
                    "IDCEVO",
                    "DTSV_China",
                    json.dumps({"seed": True}),
                    "2026-07-08T08:00:00Z",
                    "R-26-07",
                    "2026-07-08T08:00:00Z",
                ),
            ],
        )
        conn.executemany(
            """
            INSERT INTO octane_run_traceability(
                run_id, test_id, test_name, scope_team, scope_release, year,
                source, status, relation_type, related_id, related_name, related_subtype,
                related_path, parent_id, parent_name, parent_subtype, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-PLAN-26",
                    "T-PLAN-26",
                    "Planned week SET test",
                    "DTSV_China",
                    "R-26-07",
                    "2026",
                    "manual_runs",
                    "Passed",
                    "feature",
                    "F-PLAN-26",
                    "R-26-07_SET_26-07_IDC_BMW_M-BRANCH_IuK/DiPS",
                    "feature",
                    "feature/plan-26",
                    "E-PLAN",
                    "Plan epic",
                    "epic",
                    "2026-07-08T08:00:00Z",
                ),
                (
                    "MR-PLAN-29",
                    "T-PLAN-29",
                    "Planned week CW test",
                    "DTSV_China",
                    "R-26-07",
                    "2026",
                    "manual_runs",
                    "Passed",
                    "feature",
                    "F-PLAN-29",
                    "R-26-07_SET_26-07-PENT_CDE_China_Weekly_TW G70_CW29",
                    "feature",
                    "feature/plan-29",
                    "E-PLAN",
                    "Plan epic",
                    "epic",
                    "2026-07-08T08:00:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", str(db_path))

    payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-07"})
    set_week_payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-07", "weeks": "2026-CW26"})
    cw_week_payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-07", "weeks": "2026-CW29"})
    execution_week_payload = build_traceability_analysis_payload({"years": "2026", "releases": "R-26-07", "weeks": "2026-CW28"})

    assert payload["filter_options"]["weeks"] == ["2026-CW26", "2026-CW29"]
    assert set_week_payload["summary"]["traced_runs"] == 1
    assert cw_week_payload["summary"]["traced_runs"] == 1
    assert execution_week_payload["summary"]["traced_runs"] == 0


