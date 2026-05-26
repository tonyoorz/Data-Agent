from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.analytics.config import get_analytics_db_path
from backend.analytics.db import connect
from backend.analytics.processor import backfill_defect_projects, sync_dimension_fields
from backend.analytics.schema import ensure_schema


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


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", default="init-db")
    parser.add_argument("--db-path")
    parser.add_argument("--apply", action="store_true")
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

    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())