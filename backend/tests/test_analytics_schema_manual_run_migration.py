from __future__ import annotations

import sqlite3
from pathlib import Path

from backend.analytics.schema import ensure_schema


def test_ensure_schema_adds_missing_dimension_columns_for_existing_manual_runs_table(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"

    conn = sqlite3.connect(db_path)
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
                test_week TEXT,
                pu TEXT,
                top_aida TEXT,
                feature_region TEXT,
                tester TEXT,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );
            """
        )
        conn.commit()
    finally:
        conn.close()

    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(octane_manual_runs)").fetchall()
        }
    finally:
        conn.close()

    assert {"project", "fv", "fvp", "team", "lead_model"}.issubset(columns)