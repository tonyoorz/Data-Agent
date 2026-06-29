from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from backend.analytics.schema import ensure_schema
from backend.analytics.legacy_octane_db import OctaneSQLiteStore
from backend.analytics.ingest.source_store import OctaneSourceStore


def test_legacy_octane_store_writes_into_current_source_schema(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    ensure_schema(db_path)

    store = OctaneSQLiteStore(str(db_path))
    try:
        store.create_tables()
        store.create_optimized_tables()

        defect_count = store.upsert_defects_batch(
            [
                {
                    "id": "D-1",
                    "name": "Wake defect",
                    "description": "Wake defect description",
                    "team": {"name": "DTSV_China"},
                    "problem_finder_team_udf": {"name": "DTSV_China"},
                    "phase": {"name": "06"},
                    "severity": {"name": "High"},
                    "product_areas": {"data": [{"name": "Speech AIDA"}]},
                    "comments": [{"id": "C-1", "text": "hello"}],
                    "creation_time": "2026-01-02T00:00:00Z",
                }
            ],
            year=2026,
        )
        history_count = store.upsert_defect_history(
            defect_id="D-1",
            team="DTSV_China",
            payload={
                "data": [
                    {
                        "timestamp": "2026-01-03T00:00:00Z",
                        "action": "updated",
                        "user": {"name": "Tester One"},
                        "change_set": [
                            {
                                "field_name": "phase",
                                "old_value": "08",
                                "value": "06",
                                "old_value_text": "In Review",
                                "value_text": "Open",
                            }
                        ],
                    }
                ]
            },
        )
        manual_count = store.upsert_manual_runs_batch(
            [
                {
                    "id": "MR-1",
                    "defect": {"id": "D-1"},
                    "test": {"id": "T-1", "name": "Wake test", "subtype": "test_manual"},
                    "test_name": "Wake test",
                    "status": {"name": "Passed"},
                    "run_team_000_udf": {"name": "DTSV_China"},
                    "exec_model_series_udf": {"name": "NA5"},
                    "product_areas": {"data": [{"name": "Speech AIDA"}]},
                    "set_udf": {"name": "25-07"},
                    "run_by": {"full_name": "Tester One"},
                    "release": {"name": "R-26-01"},
                    "finished_udf": "2026-01-04T00:00:00Z",
                }
            ],
            year=2026,
            spec="R-26-01",
        )
        testcase_result = store.upsert_testcase_dataset(
            {
                "generated_at": "2026-01-05T00:00:00Z",
                "scope": {
                    "team": "DTSV_China",
                    "release": "R-26-01",
                    "source": "runs",
                },
                "testcases": [
                    {
                        "test_id": "T-1",
                        "test_name": "Wake test",
                        "test_subtype": "test_manual",
                        "run_count": 1,
                        "run_ids": ["MR-1"],
                        "run_status_distribution": {"Passed": 1},
                        "defect_ids": ["D-1"],
                        "manual_test_ids": ["MT-1"],
                        "feature_ids": ["F-1"],
                        "story_ids": ["S-1"],
                        "defect_links": [{"id": "D-1", "name": "Wake defect", "subtype": "defect"}],
                        "manual_test_links": [{"id": "MT-1", "name": "Manual wake", "subtype": "test_manual"}],
                        "feature_links": [{"id": "F-1", "name": "Wake feature", "subtype": "feature", "path": "epic/feature"}],
                        "story_links": [{"id": "S-1", "name": "Wake story", "subtype": "story", "path": "epic/feature/story"}],
                    }
                ],
            }
        )
    finally:
        store.close()

    assert defect_count == 1
    assert history_count == 1
    assert manual_count == 1
    assert testcase_result == {"testcases": 1, "relations": 4}

    conn = sqlite3.connect(db_path)
    try:
        defect_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(octane_defects)").fetchall()
        }
        history_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(octane_defect_history_events)").fetchall()
        }
        manual_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(octane_manual_runs)").fetchall()
        }
        testcase_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(octane_testcases)").fetchall()
        }

        defect_row = conn.execute(
            "SELECT defect_id, name, comments, raw_json FROM octane_defects WHERE defect_id='D-1'"
        ).fetchone()
        history_row = conn.execute(
            "SELECT action, user_name, old_value_text, new_value_text FROM octane_defect_history_events WHERE defect_id='D-1'"
        ).fetchone()
        manual_row = conn.execute(
            "SELECT mr_id, test_id, team, lead_model, tester, top_aida FROM octane_manual_runs WHERE mr_id='MR-1'"
        ).fetchone()
        testcase_row = conn.execute(
            "SELECT test_id, scope_team, scope_release, defect_ids_json, feature_ids_json, story_ids_json, manual_test_ids_json FROM octane_testcases WHERE test_id='T-1'"
        ).fetchone()
        relation_rows = conn.execute(
            "SELECT relation_type, related_id FROM octane_testcase_relations WHERE test_id='T-1' ORDER BY relation_type, related_id"
        ).fetchall()
    finally:
        conn.close()

    assert {
        "project",
        "market",
        "pu",
        "fv",
        "fvp",
        "team",
        "comments",
        "creation_time",
        "last_modified",
        "phase",
        "severity",
        "owner",
        "program",
    }.issubset(defect_columns)
    assert {"action", "user_name", "old_value_text", "new_value_text"}.issubset(history_columns)
    assert "raw_event_json" not in history_columns
    assert "raw_change_json" not in history_columns
    assert {
        "project",
        "fv",
        "fvp",
        "team",
        "lead_model",
        "tester",
        "top_aida",
        "run_team",
        "release",
        "exec_model_series",
        "spec",
    }.issubset(manual_columns)
    assert {"test_subtype", "run_ids_json", "manual_test_ids_json"}.issubset(testcase_columns)

    assert defect_row[0] == "D-1"
    assert defect_row[1] == "Wake defect"
    assert json.loads(defect_row[2])[0]["id"] == "C-1"
    assert json.loads(defect_row[3])["id"] == "D-1"
    assert history_row[0] == "updated"
    assert history_row[1] == "Tester One"
    assert history_row[2] == "In Review"
    assert history_row[3] == "Open"

    assert manual_row == ("MR-1", "T-1", "DTSV_China", "NA5", "Tester One", "Speech AIDA")
    assert testcase_row[0] == "T-1"
    assert testcase_row[1] == "DTSV_China"
    assert testcase_row[2] == "R-26-01"
    assert json.loads(testcase_row[3]) == ["D-1"]
    assert json.loads(testcase_row[4]) == ["F-1"]
    assert json.loads(testcase_row[5]) == ["S-1"]
    assert json.loads(testcase_row[6]) == ["MT-1"]
    assert relation_rows == [
        ("defect", "D-1"),
        ("feature", "F-1"),
        ("manual_test", "MT-1"),
        ("story", "S-1"),
    ]


def test_legacy_octane_store_preserves_unmanaged_columns_on_existing_rows(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("ALTER TABLE octane_defects ADD COLUMN preserve_me TEXT")
        conn.execute("ALTER TABLE octane_manual_runs ADD COLUMN preserve_me TEXT")
        conn.execute("ALTER TABLE octane_testcases ADD COLUMN preserve_me TEXT")
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, project, market, pu, fv, fvp, team, lead_model, raw_json, fetched_at, preserve_me
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("D-1", "Before", "P", "M", "PU", "FV", "FVP", "Team", "LM", "{}", "2026-01-01T00:00:00Z", "keep-defect"),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week, pu, top_aida, feature_region,
                tester, project, fv, fvp, team, lead_model, raw_json, fetched_at, preserve_me
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("MR-1", "D-1", "T-1", "Before", "Passed", "2026", "TW01", "PU", "AIDA", "CN", "Tester", "P", "FV", "FVP", "Team", "LM", "{}", "2026-01-01T00:00:00Z", "keep-run"),
        )
        conn.execute(
            """
            INSERT INTO octane_testcases(
                test_id, scope_team, scope_release, source, test_name, run_count, defect_ids_json,
                feature_ids_json, story_ids_json, raw_json, fetched_at, preserve_me
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("T-1", "DTSV_China", "R-26-01", "runs", "Before", 1, "[]", "[]", "[]", "{}", "2026-01-01T00:00:00Z", "keep-test"),
        )
        conn.commit()
    finally:
        conn.close()

    store = OctaneSQLiteStore(str(db_path))
    try:
        store.upsert_defects_batch(
            [
                {
                    "id": "D-1",
                    "name": "After",
                    "team": {"name": "DTSV_China"},
                    "problem_finder_team_udf": {"name": "DTSV_China"},
                }
            ],
            year=2026,
        )
        store.upsert_manual_runs_batch(
            [
                {
                    "id": "MR-1",
                    "defect": {"id": "D-1"},
                    "test": {"id": "T-1", "name": "Wake test", "subtype": "test_manual"},
                    "status": {"name": "Passed"},
                    "run_team_000_udf": {"name": "DTSV_China"},
                }
            ],
            year=2026,
            spec="R-26-01",
        )
        store.upsert_testcase_dataset(
            {
                "generated_at": "2026-01-05T00:00:00Z",
                "scope": {"team": "DTSV_China", "release": "R-26-01", "source": "runs"},
                "testcases": [
                    {
                        "test_id": "T-1",
                        "test_name": "Wake test",
                        "test_subtype": "test_manual",
                        "run_count": 1,
                        "run_ids": ["MR-1"],
                        "run_status_distribution": {"Passed": 1},
                        "defect_ids": ["D-1"],
                        "manual_test_ids": [],
                        "feature_ids": [],
                        "story_ids": [],
                    }
                ],
            }
        )
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        preserved = conn.execute(
            """
            SELECT
                (SELECT preserve_me FROM octane_defects WHERE defect_id='D-1'),
                (SELECT preserve_me FROM octane_manual_runs WHERE mr_id='MR-1'),
                (SELECT preserve_me FROM octane_testcases WHERE test_id='T-1' AND scope_team='DTSV_China' AND scope_release='R-26-01' AND source='runs')
            """
        ).fetchone()
    finally:
        conn.close()

    assert preserved == ("keep-defect", "keep-run", "keep-test")


def test_source_store_history_writer_leaves_legacy_raw_columns_empty_when_present(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defect_history_events (
                defect_id TEXT NOT NULL,
                team TEXT NOT NULL,
                event_timestamp TEXT,
                entry_index INTEGER NOT NULL,
                change_index INTEGER NOT NULL,
                action TEXT,
                user_name TEXT,
                field_name TEXT,
                old_value TEXT,
                new_value TEXT,
                old_value_text TEXT,
                new_value_text TEXT,
                raw_event_json TEXT,
                raw_change_json TEXT,
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (defect_id, team, entry_index, change_index)
            );
            """
        )
        conn.commit()
    finally:
        conn.close()

    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
        count = store.replace_defect_history_events(
            defect_id="D-1",
            team="DTSV_China",
            payload={
                "data": [
                    {
                        "timestamp": "2026-01-03T00:00:00Z",
                        "action": "updated",
                        "user": {"name": "Tester One"},
                        "change_set": [
                            {
                                "field_name": "phase",
                                "old_value": "08",
                                "value": "06",
                                "old_value_text": "In Review",
                                "value_text": "Open",
                            }
                        ],
                    }
                ]
            },
        )
    finally:
        store.close()

    assert count == 1

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT raw_event_json, raw_change_json FROM octane_defect_history_events WHERE defect_id = ?",
            ("D-1",),
        ).fetchone()
    finally:
        conn.close()

    assert row == (None, None)


def test_legacy_octane_store_flushes_batched_history_writes_on_close(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    ensure_schema(db_path)

    store = OctaneSQLiteStore(str(db_path))
    try:
        store.create_tables()
        first_count = store.upsert_defect_history(
            defect_id="D-1",
            team="DTSV_China",
            payload={
                "data": [
                    {
                        "timestamp": "2026-01-03T00:00:00Z",
                        "action": "updated",
                        "user": {"name": "Tester One"},
                        "change_set": [{"field_name": "phase", "old_value": "01", "value": "02"}],
                    }
                ]
            },
        )
        second_count = store.upsert_defect_history(
            defect_id="D-2",
            team="DTSV_China",
            payload={
                "data": [
                    {
                        "timestamp": "2026-01-04T00:00:00Z",
                        "action": "updated",
                        "user": {"name": "Tester Two"},
                        "change_set": [{"field_name": "phase", "old_value": "02", "value": "03"}],
                    }
                ]
            },
        )
    finally:
        store.close()

    assert first_count == 1
    assert second_count == 1

    conn = sqlite3.connect(db_path)
    try:
        stored = conn.execute(
            "SELECT defect_id, field_name FROM octane_defect_history_events ORDER BY defect_id"
        ).fetchall()
    finally:
        conn.close()

    assert stored == [("D-1", "phase"), ("D-2", "phase")]


def test_legacy_octane_store_handles_large_defect_batches_without_sqlite_variable_overflow(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    ensure_schema(db_path)

    store = OctaneSQLiteStore(str(db_path))
    try:
        defects = [
            {
                "id": f"D-{index}",
                "name": f"Defect {index}",
                "team": {"name": "DTSV_China"},
                "problem_finder_team_udf": {"name": "DTSV_China"},
            }
            for index in range(1100)
        ]

        count = store.upsert_defects_batch(defects, year=2026)
    finally:
        store.close()

    assert count == 1100

    conn = sqlite3.connect(db_path)
    try:
        stored_count = conn.execute("SELECT COUNT(*) FROM octane_defects").fetchone()[0]
    finally:
        conn.close()

    assert stored_count == 1100


def test_octane_source_store_load_existing_rows_chunks_large_parameter_lists(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    ensure_schema(db_path)

    store = OctaneSourceStore(db_path)
    try:
        values = [f"D-{index}" for index in range(33000)]
        rows = store._load_existing_rows("octane_defects", "defect_id", values)
    finally:
        store.close()

    assert rows == {}


def test_octane_source_store_flattens_requirement_names_from_defect_payload(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    ensure_schema(db_path)

    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
        count = store.upsert_defects(
            [
                {
                    "id": "D-REQ-1",
                    "name": "Requirement-backed defect",
                    "team": {"name": "DTSV_China"},
                    "problem_finder_team_udf": {"name": "DTSV_China"},
                    "requirements": {
                        "total_count": 2,
                        "data": [
                            {
                                "id": "R-1",
                                "name": "DOC_PreCon_A",
                                "type": "requirement",
                            },
                            {
                                "id": "R-2",
                                "name": "DOC_PreCon_B",
                                "type": "requirement_document",
                            },
                        ],
                    },
                }
            ],
            team="DTSV_China",
            year=2026,
        )
    finally:
        store.close()

    assert count == 1

    conn = sqlite3.connect(db_path)
    try:
        stored = conn.execute(
            "SELECT requirement, requirements_json FROM octane_defects WHERE defect_id='D-REQ-1'"
        ).fetchone()
    finally:
        conn.close()

    assert stored == (
        "DOC_PreCon_A | DOC_PreCon_B",
        '["DOC_PreCon_A", "DOC_PreCon_B"]',
    )