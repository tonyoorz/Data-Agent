from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.analytics.ingest.source_store import OctaneSourceStore


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