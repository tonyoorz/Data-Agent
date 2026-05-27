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

    printed = json.loads(capsys.readouterr().out)
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
    printed = json.loads(capsys.readouterr().out)
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
    assert json.loads(capsys.readouterr().out) == {"row_count": 0, "skipped": False}