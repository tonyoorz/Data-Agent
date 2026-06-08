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
    get_full_picture_cold_db_path,
    get_full_picture_cold_parquet_dir,
    get_full_picture_defect_db_candidates,
    get_full_picture_history_db_candidates,
    get_full_picture_hot_db_path,
    get_full_picture_source_db_path,
)
from backend.analytics.cold_archive import archive_source_to_cold_storage
from backend.analytics.dashboard_snapshot import (
    activate_snapshot_version,
    build_full_picture_snapshot_version,
    format_snapshot_source_mtime,
    record_snapshot_refresh,
)
from backend.analytics.db import connect
from backend.analytics.full_picture_outcomes import refresh_materialized_outcomes
from backend.analytics.ingest import client as ingest_client
from backend.analytics.ingest import pipeline as ingest_pipeline
from backend.analytics.legacy_bridge import (
    refresh_legacy_qgate_source_incremental,
    refresh_octane_cookie,
    resume_legacy_qgate_history_source,
    run_legacy_qgate_source,
    run_legacy_testcase_source,
    sync_octane_auth_from_legacy,
)
from backend.analytics.processor import backfill_defect_projects, run_processor_pipeline, sync_dimension_fields
from backend.analytics.schema import ensure_schema
from backend.analytics.testing_coverage_hot import refresh_materialized_testing_coverage


HISTORY_SOURCE_REQUIRED_COLUMNS = frozenset({"defect_id", "field_name", "event_timestamp"})
SOURCE_STAGE_REQUIRED_TABLES = frozenset({"octane_defects", "octane_defect_history_events"})
def _parse_csv_values(raw_value: str | None) -> tuple[str, ...]:
    if raw_value is None:
        return ()
    return tuple(part.strip() for part in str(raw_value).split(",") if part.strip())


def _parse_year_values(raw_value: str | None) -> tuple[int, ...]:
    values = _parse_csv_values(raw_value)
    return tuple(int(value) for value in values if value.isdigit())


def _emit_progress(message: str) -> None:
    print(message, flush=True)


def _refresh_full_picture_outcomes_with_progress(
    *,
    source_db_path: Path | str,
    hot_db_path: Path | str,
    force: bool,
) -> dict[str, object]:
    _emit_progress(f"Starting full-picture outcomes refresh force={bool(force)}")
    _emit_progress(f"Deriving hot outcomes from {Path(source_db_path).resolve()}")
    summary = refresh_materialized_outcomes(
        source_db_path,
        hot_db_path,
        force=force,
    )
    _emit_progress("Recording dashboard snapshot metadata...")
    snapshot_version = build_full_picture_snapshot_version(source_db_path)
    record_snapshot_refresh(
        hot_db_path,
        snapshot_version=snapshot_version,
        source_db_path=str(Path(source_db_path).resolve()),
        source_db_mtime=format_snapshot_source_mtime(source_db_path),
        refresh_status="ready",
        last_error=None,
    )
    activate_snapshot_version(hot_db_path, snapshot_version)
    _emit_progress("Full-picture outcomes refresh finished")
    return summary


def _refresh_manual_runs_source_with_progress(*, team_name: str, years: tuple[int, ...]) -> dict[str, object]:
    source_db_path = get_full_picture_source_db_path()
    _emit_progress(
        f"Starting manual-runs refresh for {team_name} years={','.join(str(year) for year in years)}"
    )
    summary = ingest_pipeline.refresh_octane_manual_runs_only(
        source_db_path=source_db_path,
        team_name=team_name,
        years=years,
        client=ingest_client.build_default_octane_client(),
        progress=_emit_progress,
    )
    _emit_progress("Running processor pipeline...")
    processor_summary = run_processor_pipeline(source_db_path)
    _emit_progress("Processor pipeline finished")
    return {**summary, **processor_summary}


def _refresh_testing_coverage_hot_with_progress(*, force: bool) -> dict[str, object]:
    source_db_path = get_full_picture_source_db_path()
    hot_db_path = get_full_picture_hot_db_path()
    summary = refresh_materialized_testing_coverage(
        source_db_path=source_db_path,
        hot_db_path=hot_db_path,
        force=force,
    )
    return summary


def _refresh_all_sources_with_progress(args: argparse.Namespace) -> dict[str, object]:
    teams = tuple(part.strip() for part in str(args.teams or "").split(",") if part.strip()) or ("DTSV_China",)
    years = tuple(int(part.strip()) for part in str(args.years or datetime.now().year).split(",") if part.strip())
    manual_years = _parse_year_values(getattr(args, "manual_years", None)) or (datetime.now().year,)
    manual_team_name = str(args.team_name or "DTSV_China")
    source_db_path = get_full_picture_source_db_path()
    hot_db_path = get_full_picture_hot_db_path()

    _emit_progress(
        f"Starting combined source refresh teams={','.join(teams)} years={','.join(str(year) for year in years)} manual_team={manual_team_name} manual_years={','.join(str(year) for year in manual_years)}"
    )
    _emit_progress("Step 1/3: refreshing incremental defect/history source...")
    legacy_summary = refresh_legacy_qgate_source_incremental(
        teams=teams,
        years=years,
        include_comments=not args.skip_comments,
        history_max_workers=int(args.history_max_workers or 50),
        save_files=args.save_files,
        cookie_file=args.cookie_file,
    )
    defect_team_summaries = list((legacy_summary.get("defect_refresh") or {}).get("team_summaries") or [])
    history_team_summaries = list((legacy_summary.get("history_resume") or {}).get("team_summaries") or [])
    refreshed_defects = sum(int(team.get("refreshed_defects") or 0) for team in defect_team_summaries if isinstance(team, dict))
    comments_refreshed = sum(
        int(year.get("comments_refreshed") or 0)
        for team in defect_team_summaries
        if isinstance(team, dict)
        for year in list(team.get("year_summaries") or [])
        if isinstance(year, dict)
    )
    comments_reused = sum(
        int(year.get("comments_reused") or 0)
        for team in defect_team_summaries
        if isinstance(team, dict)
        for year in list(team.get("year_summaries") or [])
        if isinstance(year, dict)
    )
    history_queued = sum(int(team.get("queued_defects") or 0) for team in history_team_summaries if isinstance(team, dict))
    history_processed = sum(int(team.get("processed_defects") or 0) for team in history_team_summaries if isinstance(team, dict))
    history_failed = sum(int(team.get("failed_defects") or 0) for team in history_team_summaries if isinstance(team, dict))
    _emit_progress(
        "Step 1/3 summary: "
        f"defects={refreshed_defects} "
        f"comments_refreshed={comments_refreshed} "
        f"comments_reused={comments_reused} "
        f"history_queued={history_queued} "
        f"history_processed={history_processed} "
        f"history_failed={history_failed}"
    )

    _emit_progress("Step 2/3: refreshing manual runs source...")
    manual_summary = _refresh_manual_runs_source_with_progress(team_name=manual_team_name, years=manual_years)

    _emit_progress("Step 3/3: refreshing full-picture outcomes...")
    outcomes_summary = _refresh_full_picture_outcomes_with_progress(
        source_db_path=source_db_path,
        hot_db_path=hot_db_path,
        force=args.force,
    )
    _emit_progress("Combined source refresh finished")
    return {
        "legacy_refresh": legacy_summary,
        "manual_runs_refresh": manual_summary,
        "outcomes_refresh": outcomes_summary,
    }


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
    parser.add_argument("--teams")
    parser.add_argument("--years")
    parser.add_argument("--manual-years")
    parser.add_argument("--skip-history", action="store_true")
    parser.add_argument("--skip-comments", action="store_true")
    parser.add_argument("--full-history", action="store_true")
    parser.add_argument("--save-files", action="store_true")
    parser.add_argument("--cookie-file")
    parser.add_argument("--team-name")
    parser.add_argument("--release-name")
    parser.add_argument("--page-limit", type=int)
    parser.add_argument("--workers", type=int)
    parser.add_argument("--workitems-fallback-max", type=int)
    parser.add_argument("--workitems-fallback-workers", type=int)
    parser.add_argument("--history-max-workers", type=int, default=50)
    parser.add_argument("--refreshed-after")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--sync-login", action="store_true")
    parser.add_argument("--prefer-local", action="store_true")
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
    if args.command == "archive-full-picture-cold":
        source_db_path = (
            _require_valid_source_stage_input_path(args.db_path)
            if args.db_path
            else _require_source_stage_input_path()
        )
        summary = archive_source_to_cold_storage(
            source_db_path,
            get_full_picture_cold_db_path(),
            get_full_picture_cold_parquet_dir(),
        )
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "refresh-full-picture-outcomes":
        source_db_path = (
            _require_valid_history_source_path(args.db_path)
            if args.db_path
            else _require_history_source_path()
        )
        hot_db_path = get_full_picture_hot_db_path()
        summary = _refresh_full_picture_outcomes_with_progress(
            source_db_path=source_db_path,
            hot_db_path=hot_db_path,
            force=args.force,
        )
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "refresh-octane-source":
        source_db_path = get_full_picture_source_db_path()
        request = ingest_pipeline.IngestRequest(
            source_db_path=source_db_path,
            teams=_parse_csv_values(args.teams) or ("all",),
            years=_parse_year_values(args.years) or (datetime.now().year,),
            include_history=not args.skip_history,
            include_comments=not args.skip_comments,
            include_testing=True,
        )
        summary = ingest_pipeline.refresh_octane_source(
            request=request,
            client=ingest_client.build_default_octane_client(),
        )
        processor_summary = run_processor_pipeline(source_db_path)
        print(json.dumps({**summary, **processor_summary}, ensure_ascii=False))
        return 0
    if args.command == "refresh-manual-runs-source":
        summary = _refresh_manual_runs_source_with_progress(
            team_name=str(args.team_name or "DTSV_China"),
            years=_parse_year_values(args.years) or (datetime.now().year,),
        )
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "refresh-testing-coverage-hot":
        summary = _refresh_testing_coverage_hot_with_progress(force=args.force)
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "refresh-all-sources":
        summary = _refresh_all_sources_with_progress(args)
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "audit-octane-dimensions":
        source_db_path = get_full_picture_source_db_path()
        report_path = get_full_picture_hot_db_path().parent / "processor_dimension_diff.json"
        summary = run_processor_pipeline(
            source_db_path,
            dry_run=True,
            report_path=report_path,
        )
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "refresh-legacy-qgate-source":
        teams = tuple(part.strip() for part in str(args.teams or "").split(",") if part.strip()) or ("DTSV_China",)
        years = tuple(int(part.strip()) for part in str(args.years or datetime.now().year).split(",") if part.strip())
        if args.skip_history:
            summary = run_legacy_qgate_source(
                teams=teams,
                years=years,
                include_history=False,
                include_comments=not args.skip_comments,
                save_files=args.save_files,
                cookie_file=args.cookie_file,
            )
        elif args.full_history:
            summary = run_legacy_qgate_source(
                teams=teams,
                years=years,
                include_history=True,
                include_comments=not args.skip_comments,
                save_files=args.save_files,
                cookie_file=args.cookie_file,
            )
        else:
            summary = refresh_legacy_qgate_source_incremental(
                teams=teams,
                years=years,
                include_comments=not args.skip_comments,
                history_max_workers=int(args.history_max_workers or 50),
                save_files=args.save_files,
                cookie_file=args.cookie_file,
            )
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "resume-legacy-qgate-history-source":
        teams = tuple(part.strip() for part in str(args.teams or "").split(",") if part.strip()) or ("DTSV_China",)
        years = tuple(int(part.strip()) for part in str(args.years or datetime.now().year).split(",") if part.strip())
        refreshed_after = str(args.refreshed_after or "").strip()
        if not refreshed_after:
            raise SystemExit("--refreshed-after is required for resume-legacy-qgate-history-source")
        summary = resume_legacy_qgate_history_source(
            teams=teams,
            years=years,
            history_max_workers=int(args.history_max_workers or 50),
            refreshed_after=refreshed_after,
            save_files=args.save_files,
            cookie_file=args.cookie_file,
        )
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "refresh-legacy-testcase-source":
        summary = run_legacy_testcase_source(
            team_name=str(args.team_name or "DTSV_China"),
            release_name=str(args.release_name or "").strip() or None,
            page_limit=args.page_limit,
            workers=args.workers,
            workitems_fallback_max=args.workitems_fallback_max,
            workitems_fallback_workers=args.workitems_fallback_workers,
            save_files=args.save_files,
            cookie_file=args.cookie_file,
        )
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "refresh-octane-cookie":
        summary = refresh_octane_cookie(
            prefer_legacy=not args.prefer_local,
            sync_login=args.sync_login,
            headless=args.headless,
        )
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "sync-octane-cookie":
        summary = sync_octane_auth_from_legacy(sync_login=args.sync_login)
        print(json.dumps(summary, ensure_ascii=False))
        return 0

    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())