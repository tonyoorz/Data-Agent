from pathlib import Path
import subprocess
import sqlite3
import sys

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