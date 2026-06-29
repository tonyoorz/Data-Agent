from pathlib import Path

import subprocess
import sqlite3
import sys
import json

import pytest

import backend.analytics_cli as analytics_cli
from backend.analytics.config import get_analytics_db_path
from backend.analytics_cli import main
from backend.analytics.schema import ensure_schema


MANUAL_RUN_TAP_COLUMNS = {
    "year",
    "test_week",
    "pu",
    "top_aida",
    "feature_region",
    "tester",
}

DEFECT_REQUIREMENT_COLUMNS = {
    "requirement",
    "requirements_json",
}


def _seed_source_testing_coverage_tables(db_path: Path) -> None:
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
            CREATE TABLE octane_defect_history_events (
                defect_id TEXT,
                field_name TEXT,
                event_timestamp TEXT
            );
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, top_aida, test_week, project, pu, fv, fvp, team, lead_model, market, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-HOT-CLI-1",
                "Use Speech operation [01.04.02.01.01.05]",
                "2026-CW22",
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
                mr_id, defect_id, test_id, test_name, status, run_by, author, year, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-HOT-CLI-1",
                "D-HOT-CLI-1",
                "T-HOT-CLI-1",
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
                "T-HOT-CLI-1",
                "DTSV_China",
                "ALL",
                "runs",
                "Wake test",
                1,
                '["D-HOT-CLI-1"]',
                '["F-1"]',
                '["S-1"]',
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()


def test_ensure_schema_creates_required_tables(tmp_path):
    db_path = tmp_path / "octane_data.db"

    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    finally:
        conn.close()

    assert "octane_defects" in tables
    assert "octane_defect_history_events" in tables
    assert "octane_manual_runs" in tables
    assert "octane_testcases" in tables
    assert "octane_testcase_relations" in tables


def test_ensure_schema_includes_requirement_columns_on_defects(tmp_path):
    db_path = tmp_path / "octane_data.db"

    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(octane_defects)").fetchall()
        }
    finally:
        conn.close()

    assert DEFECT_REQUIREMENT_COLUMNS.issubset(columns)


def test_ensure_schema_includes_tap_manual_run_columns(tmp_path):
    db_path = tmp_path / "octane_data.db"

    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(octane_manual_runs)").fetchall()
        }
    finally:
        conn.close()

    assert MANUAL_RUN_TAP_COLUMNS.issubset(columns)


def test_ensure_schema_adds_missing_tap_columns_for_existing_manual_runs_table(tmp_path):
    db_path = tmp_path / "octane_data.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                project TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()

    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(octane_manual_runs)").fetchall()
        }
    finally:
        conn.close()

    assert MANUAL_RUN_TAP_COLUMNS.issubset(columns)


def test_cli_uses_runtime_db_env_path(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))

    exit_code = main(["init-db"])

    assert exit_code == 0
    assert get_analytics_db_path() == db_path
    assert db_path.exists()


def test_cli_sync_dimensions_command_uses_current_db(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))

    assert main(["init-db"]) == 0

    exit_code = main(["sync-dimensions"])

    assert exit_code == 0
    assert db_path.exists()


def test_cli_script_entrypoint_works_from_repo_root(tmp_path):
    repo_root = Path(__file__).resolve().parents[2]
    db_path = tmp_path / "octane_data.db"

    result = subprocess.run(
        [sys.executable, "backend/analytics_cli.py", "init-db"],
        cwd=repo_root,
        env={**dict(__import__("os").environ), "VIZION_ANALYTICS_DB_PATH": str(db_path)},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert db_path.exists()


def test_seed_testing_command_writes_minimum_rows(tmp_path, monkeypatch):
    db_path = tmp_path / "octane_data.db"
    monkeypatch.setenv("VIZION_ANALYTICS_DB_PATH", str(db_path))

    assert main(["init-db"]) == 0
    assert main(["seed-testing"]) == 0

    conn = sqlite3.connect(db_path)
    try:
        run_count = conn.execute("SELECT COUNT(*) FROM octane_manual_runs").fetchone()[0]
        testcase_count = conn.execute("SELECT COUNT(*) FROM octane_testcases").fetchone()[0]
        manual_run = conn.execute(
            """
            SELECT year, test_week, pu, top_aida, feature_region, tester
            FROM octane_manual_runs
            WHERE mr_id = ?
            """,
            ("MR-DEMO-1",),
        ).fetchone()
    finally:
        conn.close()

    assert run_count >= 1
    assert testcase_count >= 1
    assert manual_run == ("2026", "TW22", "ICV", "AIDA-CN", "China", "Tony Xie")


def test_cli_backfill_projects_command_updates_unknown_defect_projects(tmp_path):
    db_path = tmp_path / "qgate_data.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                project TEXT,
                tproject TEXT,
                top_aida TEXT,
                assigned_ecu TEXT,
                software_version TEXT,
                lead_model TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, project, tproject, top_aida, assigned_ecu, software_version, lead_model
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("D-1", "Unknown", "Unknown", "", "HU-MGU_02_A", "", ""),
        )
        conn.commit()
    finally:
        conn.close()

    exit_code = main(["backfill-projects", "--db-path", str(db_path), "--apply"])

    assert exit_code == 0

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT project, tproject FROM octane_defects WHERE defect_id='D-1'"
        ).fetchone()
    finally:
        conn.close()

    assert row == ("IDC", "IDC")


def test_cli_refresh_full_picture_outcomes_command_populates_hot_db(tmp_path, monkeypatch, capsys):
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
            (
                "D-CLI-1",
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

    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(source_db))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db))

    exit_code = main(["refresh-full-picture-outcomes"])

    assert exit_code == 0

    stdout_lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    printed = json.loads(stdout_lines[-1])
    assert printed["row_count"] == 1
    assert printed["skipped"] is False

    conn = sqlite3.connect(hot_db)
    try:
        row = conn.execute(
            "SELECT is_resolved_forward, is_rejected_directly FROM defect_outcomes WHERE defect_id='D-CLI-1'"
        ).fetchone()
    finally:
        conn.close()

    assert row == (1, 0)


def test_cli_refresh_testing_coverage_hot_populates_hot_db(tmp_path, monkeypatch, capsys):
    database_root = tmp_path / "database"
    source_db = database_root / "source" / "qgate_raw.db"
    hot_db = database_root / "hot" / "vizion_serving.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)

    _seed_source_testing_coverage_tables(source_db)

    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    exit_code = main(["refresh-testing-coverage-hot"])

    assert exit_code == 0

    printed = json.loads(capsys.readouterr().out)
    assert printed["row_count"] == 1
    assert printed["skipped"] is False
    assert printed["snapshot_version"].startswith("testing-coverage-")

    conn = sqlite3.connect(hot_db)
    try:
        row = conn.execute(
            """
            SELECT snapshot_version, project, test_week, top_aida, feature_region
            FROM testing_coverage_runs
            WHERE mr_id = 'MR-HOT-CLI-1'
            """
        ).fetchone()
        snapshot_state = conn.execute(
            "SELECT row_count, refresh_status FROM testing_coverage_snapshot_state WHERE snapshot_version = ?",
            (printed["snapshot_version"],),
        ).fetchone()
        active_pointer = conn.execute(
            "SELECT snapshot_version FROM testing_coverage_snapshot_pointer WHERE pointer_name = 'active'"
        ).fetchone()
    finally:
        conn.close()

    assert row == (
        printed["snapshot_version"],
        "IDCEVO",
        "2026-CW22",
        "Use Speech operation [01.04.02.01.01.05]",
        "China Specific",
    )
    assert snapshot_state == (1, "ready")
    assert active_pointer == (printed["snapshot_version"],)


def test_cli_refresh_testing_coverage_hot_uses_tpmdashboard_feature_region_mapping(
    tmp_path,
    monkeypatch,
    capsys,
):
    database_root = tmp_path / "database"
    source_db = database_root / "source" / "qgate_raw.db"
    hot_db = database_root / "hot" / "vizion_serving.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)

    _seed_source_testing_coverage_tables(source_db)

    conn = sqlite3.connect(source_db)
    try:
        conn.execute(
            "UPDATE octane_defects SET market = ? WHERE defect_id = ?",
            ("DE", "D-HOT-CLI-1"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    exit_code = main(["refresh-testing-coverage-hot"])

    assert exit_code == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["row_count"] == 1

    conn = sqlite3.connect(hot_db)
    try:
        row = conn.execute(
            "SELECT feature_region FROM testing_coverage_runs WHERE mr_id = 'MR-HOT-CLI-1'"
        ).fetchone()
    finally:
        conn.close()

    assert row == ("China Specific",)


def test_cli_refresh_testing_coverage_hot_uses_tpmdashboard_project_and_finished_rules(
    tmp_path,
    monkeypatch,
    capsys,
):
    database_root = tmp_path / "database"
    source_db = database_root / "source" / "qgate_raw.db"
    hot_db = database_root / "hot" / "vizion_serving.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_db)
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
            CREATE TABLE octane_defect_history_events (
                defect_id TEXT,
                field_name TEXT,
                event_timestamp TEXT
            );
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, top_aida, test_week, project, pu, fv, fvp, team, lead_model, market, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-HOT-TPM-1",
                "Use Speech operation [01.04.02.01.01.05]",
                "2099-CW99",
                "LegacyProject",
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
                mr_id, defect_id, test_id, name, test_name, status, run_by, author,
                year, finished, target_ecu_conf, product_areas, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-HOT-TPM-1",
                "D-HOT-TPM-1",
                "T-HOT-TPM-1",
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
                test_id, scope_team, scope_release, source, test_name, run_count,
                defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "T-HOT-TPM-1",
                "DTSV_China",
                "ALL",
                "runs",
                "Wake test",
                1,
                '["D-HOT-TPM-1"]',
                '["F-1"]',
                '["S-1"]',
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    exit_code = main(["refresh-testing-coverage-hot"])

    assert exit_code == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["row_count"] == 1

    conn = sqlite3.connect(hot_db)
    try:
        row = conn.execute(
            "SELECT project, test_week FROM testing_coverage_runs WHERE mr_id = 'MR-HOT-TPM-1'"
        ).fetchone()
    finally:
        conn.close()

    assert row == ("IDCEVO", "2026-CW22")


def test_cli_stage_testing_source_imports_manual_runs_and_synthesizes_testcases(
    tmp_path,
    monkeypatch,
    capsys,
):
    source_testing_db = tmp_path / "tpmdashboard" / "database" / "local_data_rebuilt.db"
    source_testing_db.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_testing_db)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                year TEXT,
                finished TEXT,
                target_ecu_conf TEXT,
                product_areas TEXT,
                run_by TEXT,
                author TEXT,
                project TEXT,
                top_aida TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                test_week TEXT,
                pu TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            """
        )
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, finished,
                target_ecu_conf, product_areas, run_by, author, project, top_aida,
                fv, fvp, team, lead_model, test_week, pu, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-IMPORT-1",
                    "D-IMPORT-1",
                    "T-IMPORT-1",
                    "Wake test",
                    "Passed",
                    "2026",
                    "2026-05-27T08:15:00Z",
                    "IDCEVO headunit",
                    "Use Speech operation [01.04.02.01.01.05]",
                    "Tester A",
                    "Author A",
                    "IDCEVO",
                    "Use Speech operation [01.04.02.01.01.05]",
                    "Speech",
                    "Voice Experience",
                    "DTSV_China",
                    "NA5",
                    "2026-CW22",
                    "ICV",
                    "{}",
                    "2026-05-25T00:00:00Z",
                ),
                (
                    "MR-IMPORT-2",
                    "D-IMPORT-2",
                    "T-IMPORT-1",
                    "Wake test",
                    "Failed",
                    "2026",
                    "2026-05-28T08:15:00Z",
                    "IDCEVO headunit",
                    "Use Speech operation [01.04.02.01.01.05]",
                    "Tester B",
                    "Author B",
                    "IDCEVO",
                    "Use Speech operation [01.04.02.01.01.05]",
                    "Speech",
                    "Voice Experience",
                    "DTSV_China",
                    "NA5",
                    "2026-CW22",
                    "ICV",
                    "{}",
                    "2026-05-25T00:00:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(tmp_path / "database"))

    exit_code = main(["stage-testing-source", "--db-path", str(source_testing_db)])

    assert exit_code == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["manual_run_row_count"] == 2
    assert printed["testcase_row_count"] == 1

    staged_db = tmp_path / "database" / "source" / "qgate_raw.db"
    conn = sqlite3.connect(staged_db)
    try:
        manual_run_count = conn.execute("SELECT COUNT(*) FROM octane_manual_runs").fetchone()[0]
        testcase_row = conn.execute(
            "SELECT test_id, test_name, run_count, defect_ids_json FROM octane_testcases"
        ).fetchone()
    finally:
        conn.close()

    assert manual_run_count == 2
    assert testcase_row == (
        "T-IMPORT-1",
        "Wake test",
        2,
        '["D-IMPORT-1", "D-IMPORT-2"]',
    )


def test_cli_stage_testing_source_supports_richer_existing_source_testcase_schema(
    tmp_path,
    monkeypatch,
    capsys,
):
    source_testing_db = tmp_path / "tpmdashboard" / "database" / "local_data_rebuilt.db"
    source_testing_db.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_testing_db)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                year TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            """
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-IMPORT-RICH-1",
                "D-IMPORT-RICH-1",
                "T-IMPORT-RICH-1",
                "Wake test",
                "Passed",
                "2026",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    database_root = tmp_path / "database"
    staged_db = database_root / "source" / "qgate_raw.db"
    staged_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(staged_db)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );
            CREATE TABLE octane_testcases (
                test_id TEXT NOT NULL,
                scope_team TEXT NOT NULL,
                scope_release TEXT NOT NULL,
                source TEXT NOT NULL,
                test_name TEXT,
                test_subtype TEXT,
                run_count INTEGER NOT NULL,
                run_ids_json TEXT NOT NULL,
                run_status_distribution_json TEXT NOT NULL,
                defect_ids_json TEXT NOT NULL,
                manual_test_ids_json TEXT NOT NULL,
                feature_ids_json TEXT NOT NULL,
                story_ids_json TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (test_id, scope_team, scope_release, source)
            );
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                raw_json TEXT,
                fetched_at TEXT
            );
            CREATE TABLE octane_defect_history_events (
                defect_id TEXT,
                field_name TEXT,
                event_timestamp TEXT
            );
            """
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    exit_code = main(["stage-testing-source", "--db-path", str(source_testing_db)])

    assert exit_code == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["manual_run_row_count"] == 1
    assert printed["testcase_row_count"] == 1

    conn = sqlite3.connect(staged_db)
    try:
        testcase_row = conn.execute(
            "SELECT run_ids_json, run_status_distribution_json, manual_test_ids_json FROM octane_testcases"
        ).fetchone()
    finally:
        conn.close()

    assert testcase_row == ('[]', '{}', '[]')


def test_cli_stage_testing_source_maps_author_name_into_tester(
    tmp_path,
    monkeypatch,
    capsys,
):
    source_testing_db = tmp_path / "tpmdashboard" / "database" / "local_data_rebuilt.db"
    source_testing_db.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_testing_db)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                year TEXT,
                author_name TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            """
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, author_name, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-IMPORT-TESTER-1",
                "D-IMPORT-TESTER-1",
                "T-IMPORT-TESTER-1",
                "Wake test",
                "Passed",
                "2026",
                "Tester From Author Name",
                "{}",
                "2026-05-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(tmp_path / "database"))

    exit_code = main(["stage-testing-source", "--db-path", str(source_testing_db)])

    assert exit_code == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["manual_run_row_count"] == 1

    staged_db = tmp_path / "database" / "source" / "qgate_raw.db"
    conn = sqlite3.connect(staged_db)
    try:
        tester = conn.execute(
            "SELECT tester FROM octane_manual_runs WHERE mr_id = ?",
            ("MR-IMPORT-TESTER-1",),
        ).fetchone()[0]
    finally:
        conn.close()

    assert tester == "Tester From Author Name"


def test_cli_stage_full_picture_source_copies_upstream_db_to_local_source(tmp_path, monkeypatch):
    upstream_db = tmp_path / "upstream" / "qgate_data.db"
    upstream_db.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(upstream_db)
    try:
        conn.execute("CREATE TABLE octane_defects (defect_id TEXT PRIMARY KEY, name TEXT)")
        conn.execute(
            "CREATE TABLE octane_defect_history_events (defect_id TEXT, field_name TEXT, event_timestamp TEXT)"
        )
        conn.execute(
            "INSERT INTO octane_defects(defect_id, name) VALUES (?, ?)",
            ("D-STAGE-1", "Staged source defect"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(tmp_path / "database"))

    exit_code = main(["stage-full-picture-source", "--db-path", str(upstream_db)])

    assert exit_code == 0

    staged_db = tmp_path / "database" / "source" / "qgate_raw.db"
    assert staged_db.exists()

    conn = sqlite3.connect(staged_db)
    try:
        row = conn.execute(
            "SELECT defect_id, name FROM octane_defects WHERE defect_id = ?",
            ("D-STAGE-1",),
        ).fetchone()
    finally:
        conn.close()

    assert row == ("D-STAGE-1", "Staged source defect")


def test_cli_archive_full_picture_cold_exports_local_source_to_cold_storage(tmp_path, monkeypatch, capsys):
    source_db = tmp_path / "source" / "qgate_raw.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_db)
    try:
        conn.execute("CREATE TABLE octane_defects (defect_id TEXT PRIMARY KEY, name TEXT)")
        conn.execute(
            "CREATE TABLE octane_defect_history_events (defect_id TEXT, field_name TEXT, event_timestamp TEXT)"
        )
        conn.commit()
    finally:
        conn.close()

    calls = {}

    def fake_archive(source_db_path, cold_db_path, parquet_dir):
        calls["source_db_path"] = source_db_path
        calls["cold_db_path"] = cold_db_path
        calls["parquet_dir"] = parquet_dir
        return {
            "table_count": 2,
            "cold_db_path": str(cold_db_path),
            "parquet_dir": str(parquet_dir),
        }

    monkeypatch.setattr(analytics_cli, "archive_source_to_cold_storage", fake_archive)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(tmp_path / "database"))

    exit_code = main(["archive-full-picture-cold", "--db-path", str(source_db)])

    assert exit_code == 0
    assert calls == {
        "source_db_path": source_db,
        "cold_db_path": tmp_path / "database" / "cold" / "qgate_archive.duckdb",
        "parquet_dir": tmp_path / "database" / "cold" / "parquet",
    }
    assert json.loads(capsys.readouterr().out) == {
        "table_count": 2,
        "cold_db_path": str(tmp_path / "database" / "cold" / "qgate_archive.duckdb"),
        "parquet_dir": str(tmp_path / "database" / "cold" / "parquet"),
    }


def test_cli_archive_full_picture_cold_defaults_to_staged_local_source(tmp_path, monkeypatch, capsys):
    database_root = tmp_path / "database"
    source_db = database_root / "source" / "qgate_raw.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_db)
    try:
        conn.execute("CREATE TABLE octane_defects (defect_id TEXT PRIMARY KEY, name TEXT)")
        conn.execute(
            "CREATE TABLE octane_defect_history_events (defect_id TEXT, field_name TEXT, event_timestamp TEXT)"
        )
        conn.commit()
    finally:
        conn.close()

    calls = {}

    def fake_archive(source_db_path, cold_db_path, parquet_dir):
        calls["source_db_path"] = source_db_path
        calls["cold_db_path"] = cold_db_path
        calls["parquet_dir"] = parquet_dir
        return {
            "table_count": 2,
            "cold_db_path": str(cold_db_path),
            "parquet_dir": str(parquet_dir),
        }

    monkeypatch.setattr(analytics_cli, "archive_source_to_cold_storage", fake_archive)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    exit_code = main(["archive-full-picture-cold"])

    assert exit_code == 0
    assert calls == {
        "source_db_path": source_db,
        "cold_db_path": database_root / "cold" / "qgate_archive.duckdb",
        "parquet_dir": database_root / "cold" / "parquet",
    }
    assert json.loads(capsys.readouterr().out) == {
        "table_count": 2,
        "cold_db_path": str(database_root / "cold" / "qgate_archive.duckdb"),
        "parquet_dir": str(database_root / "cold" / "parquet"),
    }


def test_cli_refresh_full_picture_outcomes_autodiscovery_prefers_non_empty_valid_history_source(
    tmp_path, monkeypatch, capsys
):
    empty_source_db = tmp_path / "empty-history.db"
    populated_source_db = tmp_path / "populated-history.db"
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

    for db_path, rows in (
        (empty_source_db, []),
        (
            populated_source_db,
            [
                (
                    "D-CLI-2",
                    "status_phase",
                    "2026-05-25T00:00:00Z",
                    1,
                    1,
                    "08",
                    "06",
                    "08-Resolved Forward",
                    "06-Ready for Test",
                )
            ],
        ),
    ):
        conn = sqlite3.connect(db_path)
        try:
            conn.execute(
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
            if rows:
                conn.executemany(
                    """
                    INSERT INTO octane_defect_history_events(
                        defect_id, field_name, event_timestamp, entry_index, change_index,
                        old_value, new_value, old_value_text, new_value_text
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    rows,
                )
            conn.commit()
        finally:
            conn.close()

    monkeypatch.setattr(
        analytics_cli,
        "get_full_picture_history_db_candidates",
        lambda: [empty_source_db, populated_source_db],
    )
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db))

    exit_code = main(["refresh-full-picture-outcomes"])

    assert exit_code == 0
    stdout_lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    printed = json.loads(stdout_lines[-1])
    assert printed["row_count"] == 1
    assert str(populated_source_db.resolve()) in printed["source_signature"]


@pytest.mark.parametrize("create_candidate", [False, True])
def test_cli_refresh_full_picture_outcomes_requires_valid_history_source(
    tmp_path, monkeypatch, create_candidate
):
    candidate = tmp_path / "candidate.db"
    if create_candidate:
        sqlite3.connect(candidate).close()

    monkeypatch.setattr(
        analytics_cli,
        "get_full_picture_history_db_candidates",
        lambda: [candidate],
    )

    with pytest.raises(SystemExit, match="No Full Picture history source database is available"):
        main(["refresh-full-picture-outcomes"])


def test_cli_refresh_full_picture_outcomes_rejects_invalid_explicit_db_path(tmp_path):
    invalid_db_path = tmp_path / "missing-history.db"

    with pytest.raises(SystemExit) as exc_info:
        main(["refresh-full-picture-outcomes", "--db-path", str(invalid_db_path)])

    assert str(exc_info.value) == (
        f"Provided Full Picture history source database is invalid: {invalid_db_path}"
    )


def test_cli_refresh_full_picture_outcomes_rejects_malformed_history_schema(tmp_path):
    invalid_db_path = tmp_path / "malformed-history.db"

    conn = sqlite3.connect(invalid_db_path)
    try:
        conn.execute("CREATE TABLE octane_defect_history_events (defect_id TEXT)")
        conn.commit()
    finally:
        conn.close()

    with pytest.raises(SystemExit) as exc_info:
        main(["refresh-full-picture-outcomes", "--db-path", str(invalid_db_path)])

    assert str(exc_info.value) == (
        f"Provided Full Picture history source database is invalid: {invalid_db_path}"
    )


def test_cli_compact_source_history_storage_drops_legacy_raw_history_payloads(tmp_path, capsys):
    source_db = tmp_path / "qgate_raw.db"

    conn = sqlite3.connect(source_db)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defect_history_events (
                defect_id TEXT,
                team TEXT,
                event_timestamp TEXT,
                entry_index INTEGER,
                change_index INTEGER,
                action TEXT,
                user_name TEXT,
                field_name TEXT,
                old_value TEXT,
                new_value TEXT,
                old_value_text TEXT,
                new_value_text TEXT,
                raw_event_json TEXT,
                raw_change_json TEXT,
                fetched_at TEXT
            );
            CREATE TABLE octane_defect_histories (
                defect_id TEXT PRIMARY KEY,
                team TEXT,
                total_count INTEGER,
                payload_json TEXT,
                fetched_at TEXT
            );
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, old_value, new_value,
                old_value_text, new_value_text, raw_event_json, raw_change_json, fetched_at
            ) VALUES ('D-1', 'phase', '2026-01-01T00:00:00Z', '08', '06', 'Review', 'Open', '{""raw"": true}', '{""field_name"": ""phase""}', '2026-01-02T00:00:00Z');
            INSERT INTO octane_defect_histories(defect_id, team, total_count, payload_json, fetched_at)
            VALUES ('D-1', 'DTSV_China', 1, '{""data"": []}', '2026-01-02T00:00:00Z');
            """
        )
        conn.commit()
    finally:
        conn.close()

    exit_code = main(["compact-source-history-storage", "--db-path", str(source_db)])

    assert exit_code == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["dropped_raw_columns"] == ["raw_event_json", "raw_change_json"]
    assert summary["dropped_tables"] == ["octane_defect_histories"]
    conn = sqlite3.connect(source_db)
    try:
        history_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(octane_defect_history_events)").fetchall()
        }
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        }
        row_count = conn.execute("SELECT COUNT(*) FROM octane_defect_history_events").fetchone()[0]
    finally:
        conn.close()

    assert "raw_event_json" not in history_columns
    assert "raw_change_json" not in history_columns
    assert "octane_defect_histories" not in tables
    assert row_count == 1


def test_cli_refresh_full_picture_outcomes_passes_force_flag(tmp_path, monkeypatch, capsys):
    source_db = tmp_path / "history.db"
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
    calls = {}

    conn = sqlite3.connect(source_db)
    try:
        conn.execute(
            "CREATE TABLE octane_defect_history_events (defect_id TEXT, field_name TEXT, event_timestamp TEXT)"
        )
        conn.commit()
    finally:
        conn.close()

    def fake_refresh(source_db_path, hot_db_path, force):
        calls["source_db_path"] = source_db_path
        calls["hot_db_path"] = hot_db_path
        calls["force"] = force
        return {"row_count": 0, "skipped": False}

    monkeypatch.setattr(analytics_cli, "refresh_materialized_outcomes", fake_refresh)
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(source_db))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db))

    exit_code = main(["refresh-full-picture-outcomes", "--force"])

    assert exit_code == 0
    assert calls == {
        "source_db_path": source_db,
        "hot_db_path": hot_db,
        "force": True,
    }
    stdout_lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert json.loads(stdout_lines[-1]) == {"row_count": 0, "skipped": False}