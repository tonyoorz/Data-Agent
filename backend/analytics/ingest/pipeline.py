from __future__ import annotations

import concurrent.futures
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.analytics.ingest.source_store import OctaneSourceStore


MANUAL_RUN_OVERLAP_DAYS = 3
DEFECT_OVERLAP_DAYS = 3
ProgressCallback = Callable[[str], None]


def _elapsed_seconds(started_at: float) -> float:
    return round(time.perf_counter() - started_at, 1)


@dataclass(frozen=True)
class IngestRequest:
    source_db_path: Path
    teams: tuple[str, ...]
    years: tuple[int, ...]
    include_history: bool
    include_comments: bool
    include_testing: bool
    history_max_workers: int = 1
    team_max_workers: int = 1
    force_defect_refresh: bool = False


@dataclass(frozen=True)
class _TeamYearTarget:
    team_id: str
    team_name: str
    year: int
    modified_since: str | None


@dataclass(frozen=True)
class _TeamYearFetchResult:
    target: _TeamYearTarget
    defects: list[dict[str, Any]]
    comment_summary: dict[str, int]
    comment_state_rows: list[tuple[str, str, str]]
    history_refresh_since: dict[str, str | None]
    skipped_history_count: int
    history_payloads: dict[str, dict[str, Any]]
    manual_runs: list[dict[str, Any]]


def _select_teams(request: IngestRequest, client: Any) -> list[dict[str, str]]:
    available = client.list_teams()
    if request.teams == ("all",) or any(str(value).strip().lower() == "all" for value in request.teams):
        return available
    allowed = {str(value).strip() for value in request.teams}
    return [
        row
        for row in available
        if str(row.get("name") or "").strip() in allowed or str(row.get("id") or "").strip() in allowed
    ]


def _parse_iso_datetime(value: object) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _load_incremental_manual_run_since_by_year(
    *,
    source_db_path: Path,
    team_name: str,
    years: tuple[int, ...],
    overlap_days: int = MANUAL_RUN_OVERLAP_DAYS,
) -> dict[int, str | None]:
    watermarks: dict[int, str | None] = {int(year): None for year in years}
    if not source_db_path.exists() or not years:
        return watermarks

    placeholders_years = ", ".join("?" for _ in years)
    query = f"""
        SELECT
            CAST(year AS INTEGER) AS run_year,
            MAX(COALESCE(NULLIF(TRIM(CAST(last_modified AS TEXT)), ''), NULLIF(TRIM(CAST(fetched_at AS TEXT)), ''))) AS watermark
        FROM octane_manual_runs
        WHERE CAST(year AS INTEGER) IN ({placeholders_years})
          AND COALESCE(NULLIF(TRIM(CAST(run_team AS TEXT)), ''), NULLIF(TRIM(CAST(team AS TEXT)), '')) = ?
        GROUP BY CAST(year AS INTEGER)
    """
    conn = sqlite3.connect(str(source_db_path))
    try:
        rows = conn.execute(query, [*years, team_name]).fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        conn.close()

    for run_year, watermark in rows:
        parsed = _parse_iso_datetime(watermark)
        if parsed is None:
            continue
        watermarks[int(run_year)] = (
            parsed - timedelta(days=max(0, int(overlap_days)))
        ).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return watermarks


def _load_traceability_refresh_since_by_year(
    *,
    source_db_path: Path,
    team_name: str,
    years: tuple[int, ...],
) -> dict[int, str | None]:
    watermarks = _load_incremental_manual_run_since_by_year(
        source_db_path=source_db_path,
        team_name=team_name,
        years=years,
    )
    if not source_db_path.exists() or not years:
        return watermarks

    placeholders_years = ", ".join("?" for _ in years)
    query = f"""
        SELECT CAST(year AS INTEGER) AS run_year, COUNT(*) AS relation_count
        FROM octane_run_traceability
        WHERE CAST(year AS INTEGER) IN ({placeholders_years})
          AND TRIM(COALESCE(CAST(scope_team AS TEXT), '')) = ?
        GROUP BY CAST(year AS INTEGER)
    """
    conn = sqlite3.connect(str(source_db_path))
    try:
        rows = conn.execute(query, [*years, team_name]).fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        conn.close()

    traced_years = {int(run_year) for run_year, relation_count in rows if int(relation_count or 0) > 0}
    return {
        int(year): watermarks.get(int(year)) if int(year) in traced_years else None
        for year in years
    }


def _load_incremental_defect_since_by_year(
    *,
    source_db_path: Path,
    team_name: str,
    years: tuple[int, ...],
    overlap_days: int = DEFECT_OVERLAP_DAYS,
) -> dict[int, str | None]:
    watermarks: dict[int, str | None] = {int(year): None for year in years}
    if not source_db_path.exists() or not years:
        return watermarks

    placeholders_years = ", ".join("?" for _ in years)
    query = f"""
        SELECT
            CAST(year AS INTEGER) AS defect_year,
            MAX(COALESCE(NULLIF(TRIM(CAST(last_modified AS TEXT)), ''), NULLIF(TRIM(CAST(fetched_at AS TEXT)), ''))) AS watermark
        FROM octane_defects
        WHERE CAST(year AS INTEGER) IN ({placeholders_years})
          AND COALESCE(NULLIF(TRIM(CAST(problem_finder_team AS TEXT)), ''), NULLIF(TRIM(CAST(team AS TEXT)), '')) = ?
        GROUP BY CAST(year AS INTEGER)
    """
    conn = sqlite3.connect(str(source_db_path))
    try:
        rows = conn.execute(query, [*years, team_name]).fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        conn.close()

    for defect_year, watermark in rows:
        parsed = _parse_iso_datetime(watermark)
        if parsed is None:
            continue
        watermarks[int(defect_year)] = (
            parsed - timedelta(days=max(0, int(overlap_days)))
        ).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return watermarks


def _has_cached_comments(raw_comments: str) -> bool:
    text = str(raw_comments or "").strip()
    return bool(text and text not in {"[]", "{}", "null"})


def _attach_incremental_comments(
    *,
    store: OctaneSourceStore,
    client: Any,
    defects: list[dict[str, Any]],
) -> dict[str, int]:
    defect_ids = [str(row.get("id") or "").strip() for row in defects if str(row.get("id") or "").strip()]
    snapshots = store.load_comment_snapshots(defect_ids)
    plan = _build_incremental_comment_plan(snapshots=snapshots, client=client, defects=defects)
    state_rows = list(plan["state_rows"])
    if state_rows:
        store.record_comment_refresh_state(state_rows)
    return {
        "comment_refreshed_defects": int(plan["comment_refreshed_defects"]),
        "comment_reused_defects": int(plan["comment_reused_defects"]),
    }


def _build_incremental_comment_plan(
    *,
    snapshots: dict[str, dict[str, str]],
    client: Any,
    defects: list[dict[str, Any]],
) -> dict[str, object]:
    ids_to_refresh: list[str] = []
    reused = 0

    for row in defects:
        defect_id = str(row.get("id") or "").strip()
        if not defect_id:
            continue
        incoming_last_modified = str(row.get("last_modified") or "").strip()
        snapshot = snapshots.get(defect_id)
        if (
            snapshot is not None
            and (str(snapshot.get("has_refresh_state") or "") == "1" or _has_cached_comments(snapshot.get("comments_json", "")))
            and incoming_last_modified
            and str(snapshot.get("defect_last_modified") or "").strip() == incoming_last_modified
        ):
            try:
                row["comments"] = json.loads(str(snapshot.get("comments_json") or "[]"))
            except json.JSONDecodeError:
                row["comments"] = []
            reused += 1
            continue
        ids_to_refresh.append(defect_id)

    comment_rows = client.fetch_comments_for_defects(ids_to_refresh) if ids_to_refresh else []
    comments_by_defect: dict[str, list[dict[str, object]]] = {}
    for comment in comment_rows:
        comments_by_defect.setdefault(str(comment.get("defect_id") or "").strip(), []).append(comment)

    state_rows: list[tuple[str, str, str]] = []
    for row in defects:
        defect_id = str(row.get("id") or "").strip()
        if not defect_id or defect_id not in ids_to_refresh:
            continue
        comments = comments_by_defect.get(defect_id, [])
        row["comments"] = comments
        state_rows.append((defect_id, str(row.get("last_modified") or "").strip(), json.dumps(comments, ensure_ascii=False)))

    return {
        "comment_refreshed_defects": len(ids_to_refresh),
        "comment_reused_defects": reused,
        "state_rows": state_rows,
    }


def _load_comment_snapshots(source_db_path: Path, defect_ids: list[str]) -> dict[str, dict[str, str]]:
    store = OctaneSourceStore(source_db_path)
    try:
        return store.load_comment_snapshots(defect_ids)
    finally:
        store.close()


def _plan_history_refreshes(source_db_path: Path, defects: list[dict[str, Any]]) -> tuple[dict[str, str | None], int]:
    store = OctaneSourceStore(source_db_path)
    try:
        return store.plan_history_refreshes(defects)
    finally:
        store.close()


def _fetch_team_year_source(
    *,
    request: IngestRequest,
    client: Any,
    target: _TeamYearTarget,
) -> _TeamYearFetchResult:
    team_year_started_at = time.perf_counter()
    if target.modified_since:
        print(f"Source refresh {target.team_name} {target.year}: fetching defects since {target.modified_since}", flush=True)
    else:
        print(f"Source refresh {target.team_name} {target.year}: fetching defects with full year scope", flush=True)
    defect_fetch_started_at = time.perf_counter()
    defects = list(client.fetch_defects(team_id=target.team_id, year=target.year, modified_since=target.modified_since))
    print(
        f"Source refresh {target.team_name} {target.year}: fetched {len(defects)} defects duration_seconds={_elapsed_seconds(defect_fetch_started_at)}",
        flush=True,
    )

    comment_summary = {"comment_refreshed_defects": 0, "comment_reused_defects": 0}
    comment_state_rows: list[tuple[str, str, str]] = []
    if request.include_comments and defects:
        comments_started_at = time.perf_counter()
        defect_ids = [str(row.get("id") or "").strip() for row in defects if str(row.get("id") or "").strip()]
        snapshots = _load_comment_snapshots(request.source_db_path, defect_ids)
        comment_plan = _build_incremental_comment_plan(snapshots=snapshots, client=client, defects=defects)
        comment_state_rows = list(comment_plan["state_rows"])
        comment_summary = {
            "comment_refreshed_defects": int(comment_plan["comment_refreshed_defects"]),
            "comment_reused_defects": int(comment_plan["comment_reused_defects"]),
        }
        print(
            f"Source refresh {target.team_name} {target.year}: comments refreshed={comment_summary['comment_refreshed_defects']} reused={comment_summary['comment_reused_defects']} duration_seconds={_elapsed_seconds(comments_started_at)}",
            flush=True,
        )

    history_refresh_since: dict[str, str | None] = {}
    skipped_history_count = 0
    history_payloads: dict[str, dict[str, Any]] = {}
    if request.include_history:
        history_refresh_since, skipped_history_count = _plan_history_refreshes(request.source_db_path, defects)
        stale_history_ids = sorted(history_refresh_since)
        incremental_history_count = sum(1 for value in history_refresh_since.values() if value)
        print(
            f"Source refresh {target.team_name} {target.year}: history queued={len(stale_history_ids)} skipped={skipped_history_count} incremental={incremental_history_count} full={len(stale_history_ids) - incremental_history_count}",
            flush=True,
        )
        history_fetch_started_at = time.perf_counter()
        history_payloads = client.fetch_histories_for_defects(
            stale_history_ids,
            max_workers=max(1, int(request.history_max_workers or 1)),
            modified_since_by_defect=history_refresh_since,
        )
        fetched_history_rows = sum(len(list(payload.get("data") or [])) for payload in history_payloads.values())
        print(
            f"Source refresh {target.team_name} {target.year}: history fetched payloads={len(history_payloads)} entries={fetched_history_rows} duration_seconds={_elapsed_seconds(history_fetch_started_at)}",
            flush=True,
        )

    manual_runs: list[dict[str, Any]] = []
    if request.include_testing:
        manual_runs = list(client.fetch_manual_runs(team_id=target.team_id, year=target.year))

    print(
        f"Source refresh {target.team_name} {target.year}: fetch duration_seconds={_elapsed_seconds(team_year_started_at)}",
        flush=True,
    )
    return _TeamYearFetchResult(
        target=target,
        defects=defects,
        comment_summary=comment_summary,
        comment_state_rows=comment_state_rows,
        history_refresh_since=history_refresh_since,
        skipped_history_count=skipped_history_count,
        history_payloads=history_payloads,
        manual_runs=manual_runs,
    )


def refresh_octane_source(*, request: IngestRequest, client: Any) -> dict[str, int]:
    store = OctaneSourceStore(request.source_db_path)
    store.create_tables()

    defect_rows = 0
    history_rows = 0
    manual_run_rows = 0
    testcase_rows = 0
    testcase_relation_rows = 0
    defect_ids: list[str] = []
    comment_refreshed_defects = 0
    comment_reused_defects = 0
    history_queued_defects = 0
    history_skipped_defects = 0

    try:
        targets: list[_TeamYearTarget] = []
        for team in _select_teams(request, client):
            team_id = str(team.get("id") or "").strip()
            team_name = str(team.get("name") or "").strip()
            incremental_defect_since = (
                {int(year): None for year in request.years}
                if request.force_defect_refresh
                else _load_incremental_defect_since_by_year(
                    source_db_path=request.source_db_path,
                    team_name=team_name,
                    years=request.years,
                )
            )
            for year in request.years:
                targets.append(
                    _TeamYearTarget(
                        team_id=team_id,
                        team_name=team_name,
                        year=int(year),
                        modified_since=incremental_defect_since.get(int(year)),
                    )
                )

        effective_team_workers = max(1, min(int(request.team_max_workers or 1), 3, len(targets) or 1))
        print(f"Source refresh team workers={effective_team_workers}", flush=True)
        if effective_team_workers == 1:
            fetch_results = [
                _fetch_team_year_source(request=request, client=client, target=target)
                for target in targets
            ]
        else:
            fetch_results_by_target: dict[_TeamYearTarget, _TeamYearFetchResult] = {}
            with concurrent.futures.ThreadPoolExecutor(max_workers=effective_team_workers) as executor:
                future_to_target = {
                    executor.submit(_fetch_team_year_source, request=request, client=client, target=target): target
                    for target in targets
                }
                for future in concurrent.futures.as_completed(future_to_target):
                    target = future_to_target[future]
                    fetch_results_by_target[target] = future.result()
            fetch_results = [fetch_results_by_target[target] for target in targets]

        for result in fetch_results:
            target = result.target
            team_year_store_started_at = time.perf_counter()
            if result.comment_state_rows:
                store.record_comment_refresh_state(result.comment_state_rows)
            comment_refreshed_defects += int(result.comment_summary["comment_refreshed_defects"])
            comment_reused_defects += int(result.comment_summary["comment_reused_defects"])

            defect_rows += store.upsert_defects(result.defects, team=target.team_name, year=target.year)
            defect_ids.extend(
                str(row.get("id") or "").strip()
                for row in result.defects
                if str(row.get("id") or "").strip()
            )

            stale_history_ids = sorted(result.history_refresh_since)
            history_queued_defects += len(stale_history_ids)
            history_skipped_defects += result.skipped_history_count
            history_store_started_at = time.perf_counter()
            defect_last_modified = {
                str(row.get("id") or "").strip(): str(row.get("last_modified") or "").strip()
                for row in result.defects
                if str(row.get("id") or "").strip()
            }
            for defect_id in stale_history_ids:
                history_payload = result.history_payloads.get(defect_id, {"data": []})
                history_rows += store.upsert_defect_history_events(
                    defect_id=defect_id,
                    payload=history_payload,
                    team=target.team_name,
                    modified_since=result.history_refresh_since.get(defect_id),
                    defect_last_modified=defect_last_modified.get(defect_id, ""),
                )
            if request.include_history:
                print(
                    f"Source refresh {target.team_name} {target.year}: stored {history_rows} history event rows total duration_seconds={_elapsed_seconds(history_store_started_at)}",
                    flush=True,
                )

            if request.include_testing:
                manual_run_rows += store.upsert_manual_runs(result.manual_runs, team=target.team_name, year=target.year)
                testcase_summary = store.rebuild_testcases_from_runs(result.manual_runs, team=target.team_name)
                testcase_rows += testcase_summary["testcase_rows"]
                testcase_relation_rows += testcase_summary["relation_rows"]
            print(
                f"Source refresh {target.team_name} {target.year}: store duration_seconds={_elapsed_seconds(team_year_store_started_at)}",
                flush=True,
            )
    finally:
        store.close()

    return {
        "defect_rows": defect_rows,
        "defect_ids": sorted(set(defect_ids)),
        "comment_refreshed_defects": comment_refreshed_defects,
        "comment_reused_defects": comment_reused_defects,
        "history_queued_defects": history_queued_defects,
        "history_skipped_defects": history_skipped_defects,
        "history_event_rows": history_rows,
        "manual_run_rows": manual_run_rows,
        "testcase_rows": testcase_rows,
        "testcase_relation_rows": testcase_relation_rows,
    }


def refresh_octane_manual_runs_only(
    *,
    source_db_path: Path,
    team_name: str,
    years: tuple[int, ...],
    client: Any,
    progress: ProgressCallback | None = None,
) -> dict[str, int]:
    if progress is not None:
        progress(f"Resolving Octane team: {team_name}")
    available_teams = client.list_teams()
    selected_team = next(
        (
            row
            for row in available_teams
            if str(row.get("name") or "").strip() == str(team_name).strip()
            or str(row.get("id") or "").strip() == str(team_name).strip()
        ),
        None,
    )
    if selected_team is None:
        raise ValueError(f"Octane team not found: {team_name}")

    effective_team_name = str(selected_team.get("name") or team_name).strip()
    team_id = str(selected_team.get("id") or "").strip()
    if progress is not None:
        progress(f"Resolved Octane team: {effective_team_name} ({team_id})")
    incremental_since = _load_incremental_manual_run_since_by_year(
        source_db_path=source_db_path,
        team_name=effective_team_name,
        years=years,
    )

    store = OctaneSourceStore(source_db_path)
    store.create_tables()
    manual_run_rows = 0
    manual_run_ids: list[str] = []
    try:
        for year in years:
            modified_since = incremental_since.get(int(year))
            if progress is not None:
                if modified_since:
                    progress(f"Refreshing manual runs for {effective_team_name} {year} since {modified_since}")
                else:
                    progress(f"Refreshing manual runs for {effective_team_name} {year} with full fetch")
            runs = list(
                client.fetch_manual_runs(
                    team_id=team_id,
                    year=year,
                    modified_since=modified_since,
                    include_related_work_items=False,
                    progress=progress,
                )
            )
            written_rows = store.upsert_manual_runs(runs, team=effective_team_name, year=year)
            manual_run_rows += written_rows
            manual_run_ids.extend(
                str(row.get("id") or "").strip()
                for row in runs
                if str(row.get("id") or "").strip()
            )
            if progress is not None:
                progress(f"Stored {written_rows} manual runs for {effective_team_name} {year}")
    finally:
        store.close()

    return {"manual_run_rows": manual_run_rows, "manual_run_ids": sorted(set(manual_run_ids))}


def refresh_octane_traceability_source(
    *,
    source_db_path: Path,
    team_name: str,
    years: tuple[int, ...],
    releases: tuple[str, ...] = (),
    force: bool = False,
    workers: int = 24,
    client: Any,
    progress: ProgressCallback | None = None,
) -> dict[str, object]:
    if progress is not None:
        progress(f"Resolving Octane team: {team_name}")
    available_teams = client.list_teams()
    selected_team = next(
        (
            row
            for row in available_teams
            if str(row.get("name") or "").strip() == str(team_name).strip()
            or str(row.get("id") or "").strip() == str(team_name).strip()
        ),
        None,
    )
    if selected_team is None:
        raise ValueError(f"Octane team not found: {team_name}")

    effective_team_name = str(selected_team.get("name") or team_name).strip()
    team_id = str(selected_team.get("id") or "").strip()
    if progress is not None:
        progress(f"Resolved Octane team: {effective_team_name} ({team_id})")
    if force:
        store = OctaneSourceStore(source_db_path)
        try:
            store.create_tables()
            store.delete_run_traceability_scope(team=effective_team_name, years=years, releases=releases)
        finally:
            store.close()
    incremental_since = _load_traceability_refresh_since_by_year(
        source_db_path=source_db_path,
        team_name=effective_team_name,
        years=years,
    )

    store = OctaneSourceStore(source_db_path)
    store.create_tables()
    manual_run_rows = 0
    traceability_rows = 0
    manual_run_ids: list[str] = []
    try:
        for year in years:
            modified_since = incremental_since.get(int(year))
            if progress is not None:
                if modified_since:
                    progress(f"Refreshing traceability runs for {effective_team_name} {year} since {modified_since}")
                else:
                    progress(f"Refreshing traceability runs for {effective_team_name} {year} with full fetch")
            runs = list(
                client.fetch_manual_runs(
                    team_id=team_id,
                    year=year,
                    modified_since=modified_since,
                    include_related_work_items=True,
                    releases=releases,
                    related_work_item_workers=workers,
                    progress=progress,
                )
            )
            manual_run_rows += store.upsert_manual_runs(runs, team=effective_team_name, year=year)
            traceability_rows += store.replace_run_traceability_from_runs(runs, team=effective_team_name)
            manual_run_ids.extend(
                str(row.get("id") or "").strip()
                for row in runs
                if str(row.get("id") or "").strip()
            )
            if progress is not None:
                progress(f"Stored traceability for {len(runs)} manual runs in {effective_team_name} {year}")
    finally:
        store.close()

    return {
        "manual_run_rows": manual_run_rows,
        "traceability_rows": traceability_rows,
        "manual_run_ids": sorted(set(manual_run_ids)),
    }
