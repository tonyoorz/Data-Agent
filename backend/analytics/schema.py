from __future__ import annotations

from pathlib import Path

from backend.analytics.db import connect


MANUAL_RUN_ADDITIONAL_COLUMNS: tuple[str, ...] = (
    "year",
    "test_week",
    "pu",
    "top_aida",
    "feature_region",
    "tester",
    "project",
    "fv",
    "fvp",
    "team",
    "lead_model",
)

DEFECT_ADDITIONAL_COLUMNS: tuple[str, ...] = (
    "requirement",
    "requirements_json",
)


def _ensure_defect_additional_columns(conn) -> None:
    existing_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(octane_defects)").fetchall()
    }
    for column_name in DEFECT_ADDITIONAL_COLUMNS:
        if column_name in existing_columns:
            continue
        conn.execute(f"ALTER TABLE octane_defects ADD COLUMN {column_name} TEXT")


def _ensure_manual_run_additional_columns(conn) -> None:
    existing_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(octane_manual_runs)").fetchall()
    }
    for column_name in MANUAL_RUN_ADDITIONAL_COLUMNS:
        if column_name in existing_columns:
            continue
        conn.execute(f"ALTER TABLE octane_manual_runs ADD COLUMN {column_name} TEXT")


def ensure_schema(db_path: Path | str) -> None:
    conn = connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                project TEXT,
                market TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS octane_defect_history_events (
                defect_id TEXT NOT NULL,
                event_timestamp TEXT,
                field_name TEXT,
                old_value TEXT,
                new_value TEXT,
                fetched_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS octane_manual_runs (
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
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS octane_testcases (
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
            CREATE TABLE IF NOT EXISTS octane_testcase_relations (
                test_id TEXT NOT NULL,
                scope_team TEXT NOT NULL,
                scope_release TEXT NOT NULL,
                source TEXT NOT NULL,
                relation_type TEXT NOT NULL,
                related_id TEXT NOT NULL,
                related_name TEXT,
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (test_id, scope_team, scope_release, source, relation_type, related_id)
            );
            """
        )
        _ensure_defect_additional_columns(conn)
        _ensure_manual_run_additional_columns(conn)
        conn.commit()
    finally:
        conn.close()