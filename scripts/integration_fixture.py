"""Build a temporary full-picture source + hot DB pair for live integration
verification.

Creates <tmp>/source.db with three DTSV_China / IDCEVO defects, materializes
<tmp>/hot.db via the production refresh_materialized_outcomes pipeline, and
activates the dashboard snapshot. Prints a JSON object with both paths. The
verify script points VIZION_FULL_PICTURE_DEFECT_DB_PATH / _HOT_DB_PATH at
these files so the live end-to-end check runs against the real read-model
pipeline without touching repository databases.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.analytics.dashboard_snapshot import (
    activate_snapshot_version,
    build_full_picture_snapshot_version,
    format_snapshot_source_mtime,
    record_snapshot_refresh,
)
from backend.analytics.full_picture_outcomes import refresh_materialized_outcomes


def _seed_source_db(db_path: Path, *, defect_count: int = 3) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                status_phase TEXT,
                problem_finder_team TEXT,
                year TEXT,
                assigned_ecu TEXT,
                top_aida TEXT,
                aida_english TEXT,
                aida_businesskey TEXT,
                phase TEXT,
                solution_cluster TEXT,
                lead_model TEXT,
                project TEXT,
                pu TEXT,
                market TEXT,
                last_modified TEXT,
                creation_time TEXT
            );
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
        for index in range(1, defect_count + 1):
            defect_id = f"D-INT{index:03d}"
            conn.execute(
                """
                INSERT INTO octane_defects(
                    defect_id, name, status_phase, problem_finder_team, year,
                    assigned_ecu, top_aida, aida_english, aida_businesskey, phase,
                    solution_cluster, lead_model, project, pu, market, last_modified, creation_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    defect_id,
                    f"Integration verify defect {index}",
                    "03-In Analysis",
                    "DTSV_China",
                    "2026",
                    "ECU-A",
                    "Speech",
                    "",
                    "",
                    "03-In Analysis",
                    "Integration",
                    "NA5",
                    "IDCEVO",
                    "PU1",
                    "CN",
                    f"2026-08-{10 + index:02d}T00:00:00Z",
                    f"2026-08-{9 + index:02d}T00:00:00Z",
                ),
            )
        conn.commit()
    finally:
        conn.close()


def main() -> int:
    tmp_dir = Path(tempfile.mkdtemp(prefix="data-agent-integration-"))
    source_db = tmp_dir / "source.db"
    hot_db = tmp_dir / "hot.db"
    _seed_source_db(source_db, defect_count=3)
    refresh_materialized_outcomes(source_db, hot_db, force=True)
    snapshot_version = build_full_picture_snapshot_version(source_db)
    record_snapshot_refresh(
        hot_db,
        snapshot_version=snapshot_version,
        source_db_path=str(source_db.resolve()),
        source_db_mtime=format_snapshot_source_mtime(source_db),
        refresh_status="ready",
        last_error=None,
    )
    activate_snapshot_version(hot_db, snapshot_version)
    print(json.dumps({
        "sourceDbPath": str(source_db),
        "hotDbPath": str(hot_db),
        "snapshotVersion": snapshot_version,
        "defectCount": 3,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
