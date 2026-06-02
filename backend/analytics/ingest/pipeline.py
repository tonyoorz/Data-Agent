from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.analytics.ingest.source_store import OctaneSourceStore


MANUAL_RUN_OVERLAP_DAYS = 3
ProgressCallback = Callable[[str], None]


@dataclass(frozen=True)
class IngestRequest:
    source_db_path: Path
    teams: tuple[str, ...]
    years: tuple[int, ...]
    include_history: bool
    include_comments: bool
    include_testing: bool


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


def refresh_octane_source(*, request: IngestRequest, client: Any) -> dict[str, int]:
    store = OctaneSourceStore(request.source_db_path)
    store.create_tables()

    defect_rows = 0
    history_rows = 0
    manual_run_rows = 0
    testcase_rows = 0
    testcase_relation_rows = 0

    try:
        for team in _select_teams(request, client):
            team_id = str(team.get("id") or "").strip()
            team_name = str(team.get("name") or "").strip()
            for year in request.years:
                defects = list(client.fetch_defects(team_id=team_id, year=year))
                if request.include_comments and defects:
                    comment_rows = client.fetch_comments_for_defects([str(row.get("id") or "").strip() for row in defects])
                    comments_by_defect: dict[str, list[dict[str, object]]] = {}
                    for comment in comment_rows:
                        comments_by_defect.setdefault(str(comment.get("defect_id") or "").strip(), []).append(comment)
                    for row in defects:
                        row["comments"] = comments_by_defect.get(str(row.get("id") or "").strip(), [])
                defect_rows += store.upsert_defects(defects, team=team_name, year=year)

                if request.include_history:
                    for defect in defects:
                        defect_id = str(defect.get("id") or "").strip()
                        if not defect_id:
                            continue
                        history_payload = client.fetch_history(defect_id=defect_id)
                        history_rows += store.replace_defect_history_events(
                            defect_id=defect_id,
                            payload=history_payload,
                            team=team_name,
                        )

                if request.include_testing:
                    runs = list(client.fetch_manual_runs(team_id=team_id, year=year))
                    manual_run_rows += store.upsert_manual_runs(runs, team=team_name, year=year)
                    testcase_summary = store.rebuild_testcases_from_runs(runs, team=team_name)
                    testcase_rows += testcase_summary["testcase_rows"]
                    testcase_relation_rows += testcase_summary["relation_rows"]
    finally:
        store.close()

    return {
        "defect_rows": defect_rows,
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
            if progress is not None:
                progress(f"Stored {written_rows} manual runs for {effective_team_name} {year}")
    finally:
        store.close()

    return {"manual_run_rows": manual_run_rows}