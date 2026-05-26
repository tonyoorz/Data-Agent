from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.analytics.config import (
    get_analytics_db_path,
    get_full_picture_defect_db_candidates,
    get_full_picture_history_db_candidates,
    get_full_picture_hot_db_path,
    get_full_picture_source_db_path,
)
from backend.analytics.db import connect
from backend.analytics.full_picture_outcomes import refresh_materialized_outcomes
from backend.analytics.processor import backfill_defect_projects, sync_dimension_fields
from backend.analytics.schema import ensure_schema


HISTORY_SOURCE_REQUIRED_COLUMNS = frozenset({"defect_id", "field_name", "event_timestamp"})
SOURCE_STAGE_REQUIRED_TABLES = frozenset({"octane_defects", "octane_defect_history_events"})


def seed_testing_rows() -> None:
    db_path = get_analytics_db_path()
    ensure_schema(db_path)

    conn = connect(db_path)
    try:
        fetched_at = datetime.now(timezone.utc).isoformat()
        conn.execute(
            """
            INSERT OR REPLACE INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status,
                year, test_week, pu, top_aida, feature_region, tester,
                project, fv, fvp, team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-DEMO-1",
                "D-DEMO-1",
                "T-DEMO-1",
                "Demo wake test",
                "Passed",
                "2026",
                "TW22",
                "ICV",
                "AIDA-CN",
                "China",
                "Tony Xie",
                "IDCEVO",
                "Speech",
                "Tony",
                "DTSV_China",
                "NA5",
                json.dumps({"seed": True}),
                fetched_at,
            ),
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO octane_testcases(
                test_id, scope_team, scope_release, source, test_name,
                run_count, defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "T-DEMO-1",
                "DTSV_China",
                "ALL",
                "seed",
                "Demo wake test",
                1,
                json.dumps(["D-DEMO-1"]),
                json.dumps(["F-DEMO-1"]),
                json.dumps(["S-DEMO-1"]),
                json.dumps({"seed": True}),
                fetched_at,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _require_history_source_path() -> Path:
    first_valid: Path | None = None
    for candidate in get_full_picture_history_db_candidates():
        resolved = Path(candidate)
        row_count = _get_history_source_row_count(resolved)
        if row_count is None:
            continue
        if first_valid is None:
            first_valid = resolved
        if row_count > 0:
            return resolved
    if first_valid is not None:
        return first_valid
    raise SystemExit("No Full Picture history source database is available")


def _require_valid_history_source_path(candidate: str | Path) -> Path:
    resolved = Path(candidate)
    if _is_valid_history_source_path(resolved):
        return resolved
    raise SystemExit(f"Provided Full Picture history source database is invalid: {resolved}")


def _require_source_stage_input_path() -> Path:
    target_path = get_full_picture_source_db_path().resolve()
    first_valid: Path | None = None
    for candidate in get_full_picture_defect_db_candidates():
        resolved = Path(candidate)
        if resolved.resolve() == target_path:
            continue
        if not _is_valid_source_stage_path(resolved):
            continue
        if first_valid is None:
            first_valid = resolved
        if _get_defect_source_row_count(resolved) > 0:
            return resolved
    if first_valid is not None:
        return first_valid
    raise SystemExit("No Full Picture source database is available for local staging")


def _require_valid_source_stage_input_path(candidate: str | Path) -> Path:
    resolved = Path(candidate)
    if _is_valid_source_stage_path(resolved):
        return resolved
    raise SystemExit(f"Provided Full Picture source database is invalid: {resolved}")


def _is_valid_source_stage_path(candidate: Path) -> bool:
    if not candidate.exists() or not candidate.is_file():
        return False

    try:
        conn = sqlite3.connect(str(candidate))
    except sqlite3.Error:
        return False

    try:
        tables = {
            str(row[0]).strip().lower()
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
    except sqlite3.Error:
        return False
    finally:
        conn.close()

    return SOURCE_STAGE_REQUIRED_TABLES.issubset(tables)


def _get_defect_source_row_count(candidate: Path) -> int:
    conn = sqlite3.connect(str(candidate))
    try:
        row = conn.execute("SELECT COUNT(*) FROM octane_defects").fetchone()
    finally:
        conn.close()
    return int(row[0] or 0) if row else 0


def _stage_full_picture_source(source_db_path: Path | str) -> dict[str, object]:
    resolved_source_path = Path(source_db_path).resolve()
    target_path = get_full_picture_source_db_path().resolve()
    target_path.parent.mkdir(parents=True, exist_ok=True)

    if resolved_source_path != target_path:
        shutil.copy2(resolved_source_path, target_path)

    return {
        "source_db_path": str(resolved_source_path),
        "staged_db_path": str(target_path),
        "copied": resolved_source_path != target_path,
    }


def _is_valid_history_source_path(candidate: Path) -> bool:
    return _get_history_source_row_count(candidate) is not None


def _get_history_source_row_count(candidate: Path) -> int | None:
    if not candidate.exists() or not candidate.is_file():
        return None

    try:
        conn = sqlite3.connect(str(candidate))
    except sqlite3.Error:
        return None

    try:
        row = conn.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table' AND name = ?
            LIMIT 1
            """,
            ("octane_defect_history_events",),
        ).fetchone()
        if row is None:
            return None

        columns = {
            str(column_name).lower()
            for (_, column_name, *_) in conn.execute(
                "PRAGMA table_info(octane_defect_history_events)"
            ).fetchall()
        }
        if not HISTORY_SOURCE_REQUIRED_COLUMNS.issubset(columns):
            return None

        count_row = conn.execute(
            "SELECT COUNT(*) FROM octane_defect_history_events"
        ).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()

    return int(count_row[0] or 0) if count_row else 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", default="init-db")
    parser.add_argument("--db-path")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(list(argv) if argv is not None else None)

    db_path = args.db_path or str(get_analytics_db_path())

    if args.command == "init-db":
        ensure_schema(db_path)
        return 0
    if args.command == "sync-dimensions":
        sync_dimension_fields(db_path, [], [])
        return 0
    if args.command == "seed-testing":
        seed_testing_rows()
        return 0
    if args.command == "backfill-projects":
        summary = backfill_defect_projects(db_path, apply=args.apply)
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "stage-full-picture-source":
        source_db_path = (
            _require_valid_source_stage_input_path(args.db_path)
            if args.db_path
            else _require_source_stage_input_path()
        )
        summary = _stage_full_picture_source(source_db_path)
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "refresh-full-picture-outcomes":
        source_db_path = (
            _require_valid_history_source_path(args.db_path)
            if args.db_path
            else _require_history_source_path()
        )
        summary = refresh_materialized_outcomes(
            source_db_path,
            get_full_picture_hot_db_path(),
            force=args.force,
        )
        print(json.dumps(summary, ensure_ascii=False))
        return 0

    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())