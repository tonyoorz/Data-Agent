from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Any

import requests

from backend.analytics.config import (
    get_octane_base_url,
    get_octane_cookie_file_path,
    get_octane_shared_space_id,
    get_octane_workspace_id,
)
from backend.analytics.ingest.auth import build_cookie_session


DEFECT_FIELDS: tuple[str, ...] = (
    "id",
    "name",
    "description",
    "creation_time",
    "last_modified",
    "team{name}",
    "problem_finder_team_udf{name}",
    "product_areas{name}",
    "assigned_ecu_udf{name}",
    "software_version_udf",
    "solution_cluster_udf{name}",
    "function_responsible1_udf{full_name,name}",
    "ecu_to_modul_udf{name}",
    "lead_model_udf{name}",
    "phase{name,id}",
    "severity{name,id}",
    "owner{full_name,name}",
    "author{full_name,name}",
)

MANUAL_RUN_FIELDS: tuple[str, ...] = (
    "id",
    "defect{id,name}",
    "test{id,name}",
    "test_name",
    "status{name,id}",
    "creation_time",
    "last_modified",
    "started",
    "finished_udf",
    "release{name}",
    "run_team_000_udf{name}",
    "run_by{full_name,name}",
    "author{full_name,name}",
    "product_areas{name}",
    "set_udf{name}",
    "target_ecu_conf_udf",
    "exec_model_series_udf{name}",
)


def _escape_octane_text(value: str) -> str:
    return value.replace("'", "\\'")


def _release_names_for_year(year: int) -> tuple[str, ...]:
    suffix = str(year)[-2:]
    return tuple(f"R-{suffix}-{month:02d}" for month in range(1, 14))


class OctaneApiClient:
    def __init__(self, *, base_url: str, shared_space_id: str, workspace_id: str, session: requests.Session):
        self._base_url = base_url.rstrip("/")
        self._api_base = f"{self._base_url}/api/shared_spaces/{shared_space_id}/workspaces/{workspace_id}"
        self._session = session
        self._team_name_cache: dict[str, str] = {}

    def fetch_rows(self, endpoint: str, *, fields: str | Sequence[str], query: str, limit: int = 1000) -> list[dict[str, Any]]:
        offset = 0
        rows: list[dict[str, Any]] = []
        field_expr = ",".join(fields) if not isinstance(fields, str) else fields
        while True:
            response = self._session.get(
                f"{self._api_base}/{endpoint}",
                params={"fields": field_expr, "query": query, "limit": limit, "offset": offset},
                timeout=60,
                verify=False,
            )
            response.raise_for_status()
            payload = response.json()
            batch = [row for row in list(payload.get("data") or []) if isinstance(row, dict)]
            rows.extend(batch)
            if len(batch) < limit:
                return rows
            offset += limit

    def list_teams(self) -> list[dict[str, str]]:
        rows = [
            {"id": str(row.get("id") or "").strip(), "name": str(row.get("name") or "").strip()}
            for row in self.fetch_rows(endpoint="teams", fields=("id", "name"), query='"true"')
            if str(row.get("id") or "").strip() and str(row.get("name") or "").strip()
        ]
        self._team_name_cache = {row["id"]: row["name"] for row in rows}
        return rows

    def fetch_defects(self, *, team_id: str, year: int) -> list[dict[str, Any]]:
        team_name = self._team_name_cache.get(str(team_id).strip(), str(team_id).strip())
        safe_team = _escape_octane_text(team_name)
        query = (
            f'"(creation_time>=\'{year}-01-01\';creation_time<=\'{year}-12-31\';'
            f'((problem_finder_team_udf={{name=\'{safe_team}\'}})||(author={{name=\'{safe_team}\'}})||(team={{name=\'{safe_team}\'}})))"'
        )
        return self.fetch_rows(endpoint="defects", fields=DEFECT_FIELDS, query=query)

    def fetch_comments_for_defects(self, defect_ids: Sequence[str]) -> list[dict[str, Any]]:
        normalized_ids = [str(defect_id).strip() for defect_id in defect_ids if str(defect_id).strip()]
        if not normalized_ids:
            return []
        id_expr = ",".join(f"'{_escape_octane_text(defect_id)}'" for defect_id in normalized_ids)
        query = f'"(owner_work_item={{id IN {id_expr}}})"'
        rows = self.fetch_rows(
            endpoint="comments",
            fields="id,author{full_name,name},text,creation_time,last_modified,owner_work_item{id,subtype}",
            query=query,
        )
        for row in rows:
            owner = row.get("owner_work_item") or {}
            if isinstance(owner, dict):
                row["defect_id"] = str(owner.get("id") or "").strip()
        return rows

    def fetch_history(self, *, defect_id: str) -> dict[str, Any]:
        query = f'"(entity_id=\'{_escape_octane_text(str(defect_id).strip())}\';entity_type=\'defect\')"'
        rows = self.fetch_rows(endpoint="history_logs", fields="*", query=query, limit=10000)
        return {"data": rows, "total_count": len(rows)}

    def fetch_manual_runs(self, *, team_id: str, year: int) -> list[dict[str, Any]]:
        team_name = self._team_name_cache.get(str(team_id).strip(), str(team_id).strip())
        safe_team = _escape_octane_text(team_name)
        rel_expr = "||".join(f"(release={{name='{release_name}'}})" for release_name in _release_names_for_year(year))
        query = f'"(run_team_000_udf={{name=\'{safe_team}\'}});({rel_expr})"'
        return self.fetch_rows(endpoint="manual_runs", fields=MANUAL_RUN_FIELDS, query=query)


def build_default_octane_client() -> OctaneApiClient:
    return OctaneApiClient(
        base_url=get_octane_base_url(),
        shared_space_id=get_octane_shared_space_id(),
        workspace_id=get_octane_workspace_id(),
        session=build_cookie_session(get_octane_cookie_file_path()),
    )