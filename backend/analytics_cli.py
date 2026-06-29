from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.analytics.config import (
    get_analytics_db_path,
    get_octane_base_url,
    get_octane_cookie_file_path,
    get_full_picture_cold_db_path,
    get_full_picture_cold_parquet_dir,
    get_full_picture_defect_db_candidates,
    get_full_picture_history_db_candidates,
    get_full_picture_hot_db_path,
    get_full_picture_source_db_path,
)
from backend.analytics.ingest.playwright_cookie_manager import refresh_cookie_file
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
from backend.analytics.processor import backfill_defect_projects, run_processor_pipeline, sync_dimension_fields
from backend.analytics.qgate_kpi_compare_report import generate_qgate_kpi_compare_report
from backend.analytics.qgate_kpi_dashboard_report import generate_qgate_kpi_dashboard_report
from backend.analytics.qgate_kpi_report_common import build_timestamped_output_paths
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


def _validate_octane_cookie_file(cookie_file: Path) -> tuple[bool, int, str]:
    previous_cookie_file = os.environ.get("VIZION_OCTANE_COOKIE_FILE")
    os.environ["VIZION_OCTANE_COOKIE_FILE"] = str(cookie_file)
    try:
        team_count = len(ingest_client.build_default_octane_client().list_teams())
        return True, team_count, ""
    except Exception as exc:
        return False, 0, str(exc)
    finally:
        if previous_cookie_file is None:
            os.environ.pop("VIZION_OCTANE_COOKIE_FILE", None)
        else:
            os.environ["VIZION_OCTANE_COOKIE_FILE"] = previous_cookie_file


def _refresh_cookie_with_external_sso(candidate_cookie_file: Path) -> dict[str, object]:
    repo_root = Path(__file__).resolve().parents[1]
    external_root = repo_root.parent / "TPMDashbaord"
    cookie_manager_path = external_root / "scripts" / "utilities" / "simple_cookie_updater.py"
    if not cookie_manager_path.exists():
        return {"attempted": False, "error": f"External cookie manager not found: {cookie_manager_path}"}
    login_file = repo_root / "login_info.txt"
    code = "\n".join(
        [
            "import pathlib, sys",
            "sys.path.insert(0, str(pathlib.Path.cwd()))",
            "import scripts.utilities.simple_cookie_updater as cm",
            f"cm.COOKIE_FILE = {str(candidate_cookie_file)!r}",
            f"cm.LOGIN_FILE = {str(login_file)!r}",
            "ok = cm.SimpleCookieUpdater().update_cookie_if_needed()",
            "raise SystemExit(0 if ok else 1)",
        ]
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=external_root,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    return {
        "attempted": True,
        "exit_code": result.returncode,
        "stdout_tail": "\n".join((result.stdout or "").splitlines()[-5:]),
        "stderr_tail": "\n".join((result.stderr or "").splitlines()[-5:]),
    }


def refresh_octane_cookie(*, prefer_legacy: bool = False, sync_login: bool = False, headless: bool = False) -> dict[str, object]:
    cookie_file = get_octane_cookie_file_path()
    candidate_cookie_file = cookie_file.with_name(cookie_file.name + ".candidate")
    local_error = ""
    try:
        refresh_cookie_file(
            base_url=get_octane_base_url(),
            cookie_file=candidate_cookie_file,
            headless=headless,
        )
    except Exception as exc:
        local_error = str(exc)

    cookie_validated, team_count, validation_error = _validate_octane_cookie_file(candidate_cookie_file)
    mode = "local-playwright"
    external_result: dict[str, object] | None = None
    if not cookie_validated:
        external_result = _refresh_cookie_with_external_sso(candidate_cookie_file)
        if external_result.get("attempted") and int(external_result.get("exit_code") or 1) == 0:
            cookie_validated, team_count, validation_error = _validate_octane_cookie_file(candidate_cookie_file)
            mode = "external-sso"

    if not cookie_validated:
        return {
            "cookie_refreshed": bool(candidate_cookie_file.exists()),
            "cookie_validated": False,
            "mode": mode,
            "cookie_file": str(cookie_file),
            "candidate_cookie_file": str(candidate_cookie_file),
            "local_error": local_error,
            "validation_error": validation_error,
            "external_result": external_result,
        }
    cookie_file.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(candidate_cookie_file, cookie_file)
    return {
        "cookie_refreshed": True,
        "cookie_validated": True,
        "mode": mode,
        "cookie_file": str(cookie_file),
        "team_count": team_count,
    }


def _refresh_full_picture_outcomes_with_progress(
    *,
    source_db_path: Path | str,
    hot_db_path: Path | str,
    force: bool,
    defect_ids: tuple[str, ...] | None = None,
) -> dict[str, object]:
    _emit_progress(f"Starting full-picture outcomes refresh force={bool(force)}")
    _emit_progress(f"Deriving hot outcomes from {Path(source_db_path).resolve()}")
    summary = refresh_materialized_outcomes(
        source_db_path,
        hot_db_path,
        force=force,
        defect_ids=defect_ids,
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
    manual_run_ids = tuple(str(run_id).strip() for run_id in summary.get("manual_run_ids", []) if str(run_id).strip())
    processor_summary = run_processor_pipeline(
        source_db_path,
        manual_run_ids=manual_run_ids if "manual_run_ids" in summary else None,
    )
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

def _prepare_duplicate_search_index() -> dict[str, object]:
    from scripts.duplicate_search_bridge import warmup_duplicate_search

    return warmup_duplicate_search()

def _run_duplicate_search_eval(eval_cases_path: Path, top_k: int) -> dict[str, object]:
    from backend.duplicate_search_eval import run_duplicate_search_eval

    return run_duplicate_search_eval(eval_cases_path, top_k=top_k)

def _export_duplicate_search_eval_cases(feedback_db_path: Path, output_path: Path) -> dict[str, object]:
    from backend.duplicate_search_eval import export_duplicate_search_eval_cases

    return export_duplicate_search_eval_cases(feedback_db_path, output_path)

def sync_octane_auth_from_legacy(*, sync_login: bool = False) -> dict[str, object]:
    return refresh_octane_cookie(sync_login=sync_login)


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
    _emit_progress("Step 1/3: refreshing Octane defects and history source...")
    source_summary = ingest_pipeline.refresh_octane_source(
        request=ingest_pipeline.IngestRequest(
            source_db_path=source_db_path,
            teams=teams,
            years=years,
            include_history=not args.skip_history,
            include_comments=not args.skip_comments,
            include_testing=False,
            history_max_workers=int(args.history_max_workers or 1),
            team_max_workers=int(getattr(args, "team_max_workers", 1) or 1),
            force_defect_refresh=bool(getattr(args, "force_defect_refresh", False)),
        ),
        client=ingest_client.build_default_octane_client(),
    )
    _emit_progress(
        "Step 1/3 summary: "
        f"defect_rows={source_summary.get('defect_rows', 0)} "
        f"history_event_rows={source_summary.get('history_event_rows', 0)}"
    )

    _emit_progress("Step 2/3: refreshing manual runs source...")
    manual_summary = _refresh_manual_runs_source_with_progress(team_name=manual_team_name, years=manual_years)

    _emit_progress("Step 3/3: refreshing full-picture outcomes...")
    source_defect_ids = tuple(str(defect_id).strip() for defect_id in source_summary.get("defect_ids", []) if str(defect_id).strip())
    outcomes_summary = _refresh_full_picture_outcomes_with_progress(
        source_db_path=source_db_path,
        hot_db_path=hot_db_path,
        force=args.force,
        defect_ids=source_defect_ids if "defect_ids" in source_summary else None,
    )
    duplicate_index_summary: dict[str, object] | None = None
    if getattr(args, "prepare_duplicate_index", False):
        _emit_progress("Step 4/4: preparing duplicate-search index...")
        duplicate_index_summary = _prepare_duplicate_search_index()
    _emit_progress("Combined source refresh finished")
    summary = {
        "source_refresh": source_summary,
        "manual_runs_refresh": manual_summary,
        "outcomes_refresh": outcomes_summary,
    }
    if duplicate_index_summary is not None:
        summary["duplicate_search_index"] = duplicate_index_summary
    return summary


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
    parser.add_argument("--eval-cases")
    parser.add_argument("--feedback-db-path")
    parser.add_argument("--output-path")
    parser.add_argument("--output-root")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--skip-history", action="store_true")
    parser.add_argument("--skip-comments", action="store_true")
    parser.add_argument("--prepare-duplicate-index", action="store_true")
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
    parser.add_argument("--team-max-workers", type=int, default=1)
    parser.add_argument("--force-defect-refresh", action="store_true")
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
    if args.command == "generate-qgate-kpi-reports":
        report_db_path = Path(args.db_path) if args.db_path else get_full_picture_source_db_path()
        years = tuple(str(year).strip() for year in str(args.years or "2025,2026").split(",") if str(year).strip())
        if len(years) != 2:
            raise SystemExit("--years must contain exactly two comma-separated years")
        output_root = args.output_root or str(Path("docs") / "qgate-reports" / "generated_runs")
        dashboard_path, compare_path = build_timestamped_output_paths(
            output_root,
            (
                "qgate_kpi_dashboard_{stamp}.html",
                f"qgate_kpi_compare_{years[0]}_{years[1]}_{{stamp}}.html",
            ),
        )
        generated_dashboard = generate_qgate_kpi_dashboard_report(
            db_path=report_db_path,
            output_path=dashboard_path,
        )
        generated_compare = generate_qgate_kpi_compare_report(
            db_path=report_db_path,
            output_path=compare_path,
            years=years,
        )
        print(json.dumps({"dashboard": str(generated_dashboard), "compare": str(generated_compare)}, ensure_ascii=False))
        return 0
    if args.command == "prepare-duplicate-search-index":
        summary = _prepare_duplicate_search_index()
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "evaluate-duplicate-search":
        if not args.eval_cases:
            raise SystemExit("--eval-cases is required")
        summary = _run_duplicate_search_eval(Path(args.eval_cases), top_k=int(args.top_k or 10))
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if args.command == "export-duplicate-search-eval-cases":
        if not args.feedback_db_path or not args.output_path:
            raise SystemExit("--feedback-db-path and --output-path are required")
        summary = _export_duplicate_search_eval_cases(Path(args.feedback_db_path), Path(args.output_path))
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
            force_defect_refresh=bool(getattr(args, "force_defect_refresh", False)),
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
        raise SystemExit("refresh-legacy-qgate-source was removed. Use refresh-octane-source or refresh-all-sources.")
    if args.command == "resume-legacy-qgate-history-source":
        raise SystemExit("resume-legacy-qgate-history-source was removed. Use refresh-octane-source or refresh-all-sources.")
    if args.command == "refresh-legacy-testcase-source":
        raise SystemExit("refresh-legacy-testcase-source was removed. Use refresh-manual-runs-source.")
    if args.command == "refresh-octane-cookie":
        summary = refresh_octane_cookie(
            prefer_legacy=not args.prefer_local,
            sync_login=args.sync_login,
            headless=args.headless,
        )
        print(json.dumps(summary, ensure_ascii=False))
        return 0 if bool(summary.get("cookie_validated")) else 1
    if args.command == "sync-octane-cookie":
        summary = sync_octane_auth_from_legacy(sync_login=args.sync_login)
        print(json.dumps(summary, ensure_ascii=False))
        return 0

    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())