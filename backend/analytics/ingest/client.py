from __future__ import annotations

from collections.abc import Callable, Sequence
import concurrent.futures
from typing import Any

import requests
import urllib3

from backend.analytics.config import (
    get_octane_base_url,
    get_octane_shared_space_id,
    get_octane_workspace_id,
    resolve_octane_cookie_file_path,
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

HISTORY_FIELDS: tuple[str, ...] = (
    "timestamp",
    "action",
    "user{full_name,name}",
    "change_set{field_name,old_value,new_value,value,old_value_text,new_value_text,value_text}",
)

WORK_ITEM_RELATION_FIELDS: tuple[str, ...] = (
    "id",
    "name",
    "subtype",
    "parent{id,name,subtype}",
    "run_covered_content_relation{id}",
    "path",
)

ProgressCallback = Callable[[str], None]
COMMENT_DEFECT_ID_BATCH_SIZE = 100
HISTORY_DEFECT_ID_BATCH_SIZE = 50


urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


def _escape_octane_text(value: str) -> str:
    return value.replace("'", "\\'")


def _release_names_for_year(year: int) -> tuple[str, ...]:
    suffix = str(year)[-2:]
    return tuple(f"R-{suffix}-{month:02d}" for month in range(1, 14))


def _chunked(values: Sequence[str], chunk_size: int) -> list[list[str]]:
    return [list(values[index:index + chunk_size]) for index in range(0, len(values), chunk_size)]


def _normalize_relation_run_ids(value: object) -> list[str]:
    if isinstance(value, dict):
        relation_id = str(value.get("id") or "").strip()
        return [relation_id] if relation_id else []
    if isinstance(value, list):
        normalized: list[str] = []
        for item in value:
            normalized.extend(_normalize_relation_run_ids(item))
        return normalized
    relation_id = str(value or "").strip()
    return [relation_id] if relation_id else []


class OctaneApiClient:
    def __init__(self, *, base_url: str, shared_space_id: str, workspace_id: str, session: requests.Session):
        self._base_url = base_url.rstrip("/")
        self._api_base = f"{self._base_url}/api/shared_spaces/{shared_space_id}/workspaces/{workspace_id}"
        self._session = session
        self._team_name_cache: dict[str, str] = {}

    def fetch_rows(
        self,
        endpoint: str,
        *,
        fields: str | Sequence[str],
        query: str | None = None,
        limit: int = 1000,
        progress: ProgressCallback | None = None,
        progress_label: str | None = None,
    ) -> list[dict[str, Any]]:
        offset = 0
        rows: list[dict[str, Any]] = []
        field_expr = ",".join(fields) if not isinstance(fields, str) else fields
        while True:
            params = {"fields": field_expr, "limit": limit, "offset": offset}
            if query is not None:
                params["query"] = query
            response = self._session.get(
                f"{self._api_base}/{endpoint}",
                params=params,
                timeout=60,
                verify=False,
            )
            response.raise_for_status()
            payload = response.json()
            batch = [row for row in list(payload.get("data") or []) if isinstance(row, dict)]
            rows.extend(batch)
            if progress is not None and progress_label:
                progress(f"{progress_label}: fetched {len(rows)} rows")
            if len(batch) < limit:
                return rows
            offset += limit

    def list_teams(self) -> list[dict[str, str]]:
        rows = [
            {"id": str(row.get("id") or "").strip(), "name": str(row.get("name") or "").strip()}
            for row in self.fetch_rows(endpoint="teams", fields=("id", "name"))
            if str(row.get("id") or "").strip() and str(row.get("name") or "").strip()
        ]
        self._team_name_cache = {row["id"]: row["name"] for row in rows}
        return rows

    def fetch_defects(self, *, team_id: str, year: int, modified_since: str | None = None) -> list[dict[str, Any]]:
        safe_team_id = _escape_octane_text(str(team_id).strip())
        modified_since_clause = ""
        if modified_since:
            modified_since_clause = f"last_modified>='{_escape_octane_text(str(modified_since).strip())}';"
        query = (
            f'"(problem_finder_team_udf={{id=\'{safe_team_id}\'}};'
            f"creation_time>='{year}-01-01T00:00:00Z';"
            f"{modified_since_clause}"
            f"creation_time<='{year}-12-31T23:59:59Z')\""
        )
        return self.fetch_rows(endpoint="defects", fields=DEFECT_FIELDS, query=query)

    def fetch_comments_for_defects(self, defect_ids: Sequence[str]) -> list[dict[str, Any]]:
        normalized_ids = sorted({str(defect_id).strip() for defect_id in defect_ids if str(defect_id).strip()})
        if not normalized_ids:
            return []
        rows: list[dict[str, Any]] = []
        for batch_ids in _chunked(normalized_ids, COMMENT_DEFECT_ID_BATCH_SIZE):
            id_expr = ",".join(f"'{_escape_octane_text(defect_id)}'" for defect_id in batch_ids)
            query = f'"(owner_work_item={{id IN {id_expr}}})"'
            rows.extend(
                self.fetch_rows(
                    endpoint="comments",
                    fields="id,author{full_name,name},text,creation_time,last_modified,owner_work_item{id,subtype}",
                    query=query,
                )
            )
        for row in rows:
            owner = row.get("owner_work_item") or {}
            if isinstance(owner, dict):
                row["defect_id"] = str(owner.get("id") or "").strip()
        return rows

    def fetch_history(self, *, defect_id: str) -> dict[str, Any]:
        query = f'"(entity_id=\'{_escape_octane_text(str(defect_id).strip())}\';entity_type=\'defect\')"'
        return self._fetch_history_payload(query=query)

    def _history_query(self, *, defect_ids: Sequence[str], modified_since: str | None = None) -> str:
        if len(defect_ids) == 1:
            entity_clause = f"entity_id='{_escape_octane_text(str(defect_ids[0]).strip())}'"
        else:
            id_expr = ",".join(f"'{_escape_octane_text(defect_id)}'" for defect_id in defect_ids)
            entity_clause = f"entity_id IN {id_expr}"
        since_clause = ""
        if modified_since:
            since_clause = f";timestamp>='{_escape_octane_text(str(modified_since).strip())}'"
        return f'"({entity_clause};entity_type=\'defect\'{since_clause})"'

    def _fetch_history_payload(self, *, query: str) -> dict[str, Any]:
        offset = 0
        limit = 10000
        rows: list[dict[str, Any]] = []
        total_count: int | None = None
        while True:
            response = self._session.get(
                f"{self._api_base}/history_logs",
                params={
                    "query": query,
                    "limit": limit,
                    "offset": offset,
                    "order_by": "-timestamp",
                },
                timeout=90,
                verify=False,
            )
            response.raise_for_status()
            payload = response.json()
            batch = [row for row in list(payload.get("data") or []) if isinstance(row, dict)]
            rows.extend(batch)
            if total_count is None:
                try:
                    total_count = int(payload.get("total_count")) if payload.get("total_count") is not None else None
                except (TypeError, ValueError):
                    total_count = None
            if len(batch) < limit:
                break
            if total_count is not None and len(rows) >= total_count:
                break
            offset += limit
        return {"data": rows, "total_count": len(rows)}

    def _fetch_history_batch(self, batch_ids: Sequence[str], *, modified_since: str | None = None) -> dict[str, dict[str, Any]]:
        if not batch_ids:
            return {}
        if len(batch_ids) == 1:
            defect_id = str(batch_ids[0]).strip()
            query = self._history_query(defect_ids=(defect_id,), modified_since=modified_since)
            return {defect_id: self._fetch_history_payload(query=query)}

        query = self._history_query(defect_ids=batch_ids, modified_since=modified_since)
        payload = self._fetch_history_payload(query=query)
        grouped_rows = {defect_id: [] for defect_id in batch_ids}
        for row in list(payload.get("data") or []):
            if not isinstance(row, dict):
                continue
            entity_id = str(row.get("entity_id") or "").strip()
            if entity_id in grouped_rows:
                grouped_rows[entity_id].append(row)
        return {
            defect_id: {"data": grouped_rows[defect_id], "total_count": len(grouped_rows[defect_id])}
            for defect_id in batch_ids
        }

    def fetch_histories_for_defects(
        self,
        defect_ids: Sequence[str],
        *,
        max_workers: int = 1,
        modified_since_by_defect: dict[str, str | None] | None = None,
    ) -> dict[str, dict[str, Any]]:
        normalized_ids = sorted({str(defect_id).strip() for defect_id in defect_ids if str(defect_id).strip()})
        if not normalized_ids:
            return {}
        results: dict[str, dict[str, Any]] = {}
        since_by_defect = modified_since_by_defect or {}
        if modified_since_by_defect:
            full_refresh_ids = [defect_id for defect_id in normalized_ids if since_by_defect.get(defect_id) is None]
            incremental_refresh_ids = [defect_id for defect_id in normalized_ids if since_by_defect.get(defect_id) is not None]
            batches = _chunked(full_refresh_ids, HISTORY_DEFECT_ID_BATCH_SIZE) + _chunked(
                incremental_refresh_ids,
                HISTORY_DEFECT_ID_BATCH_SIZE,
            )
        else:
            batches = _chunked(normalized_ids, HISTORY_DEFECT_ID_BATCH_SIZE)
        effective_workers = max(1, min(int(max_workers or 1), 8, len(batches)))

        def batch_since(batch_ids: Sequence[str]) -> str | None:
            since_values = [since_by_defect.get(defect_id) for defect_id in batch_ids]
            if any(value is None for value in since_values):
                return None
            normalized_since = [str(value).strip() for value in since_values if str(value or "").strip()]
            return min(normalized_since) if normalized_since else None

        if effective_workers == 1:
            for batch_ids in batches:
                results.update(self._fetch_history_batch(batch_ids, modified_since=batch_since(batch_ids)))
            return results

        with concurrent.futures.ThreadPoolExecutor(max_workers=effective_workers) as executor:
            future_to_batch = {
                executor.submit(self._fetch_history_batch, batch_ids, modified_since=batch_since(batch_ids)): batch_ids
                for batch_ids in batches
            }
            for future in concurrent.futures.as_completed(future_to_batch):
                results.update(future.result())
        return results

    def fetch_manual_runs(
        self,
        *,
        team_id: str,
        year: int,
        modified_since: str | None = None,
        include_related_work_items: bool = True,
        progress: ProgressCallback | None = None,
    ) -> list[dict[str, Any]]:
        team_name = self._team_name_cache.get(str(team_id).strip(), str(team_id).strip())
        safe_team = _escape_octane_text(team_name)
        rel_expr = "||".join(f"(release={{name='{release_name}'}})" for release_name in _release_names_for_year(year))
        query_parts = [
            f"run_team_000_udf={{name='{safe_team}'}}",
            f"({rel_expr})",
        ]
        if modified_since:
            query_parts.append(f"last_modified>='{_escape_octane_text(str(modified_since).strip())}'")
        query = f'"({";".join(query_parts)})"'
        runs = self.fetch_rows(
            endpoint="manual_runs",
            fields=MANUAL_RUN_FIELDS,
            query=query,
            progress=progress,
            progress_label=f"manual-runs {team_name} {year}",
        )
        if include_related_work_items:
            run_ids = [str(row.get("id") or "").strip() for row in runs if str(row.get("id") or "").strip()]
            related_by_run = self.fetch_related_work_items_for_runs(run_ids)
            for row in runs:
                run_id = str(row.get("id") or "").strip()
                row["related_work_items"] = related_by_run.get(run_id, [])
        return runs

    def fetch_related_work_items_for_runs(self, run_ids: Sequence[str], *, batch_size: int = 100) -> dict[str, list[dict[str, Any]]]:
        normalized_ids = [str(run_id).strip() for run_id in run_ids if str(run_id).strip()]
        if not normalized_ids:
            return {}

        related_by_run: dict[str, list[dict[str, Any]]] = {run_id: [] for run_id in normalized_ids}
        for batch in _chunked(normalized_ids, batch_size):
            id_expr = ",".join(f"'{_escape_octane_text(run_id)}'" for run_id in batch)
            query = f'"(subtype IN \'defect\',\'feature\',\'story\';run_covered_content_relation={{id IN {id_expr}}})"'
            rows = self.fetch_rows(
                endpoint="work_items",
                fields=WORK_ITEM_RELATION_FIELDS,
                query=query,
                limit=1000,
            )
            for row in rows:
                relation_run_ids = _normalize_relation_run_ids(row.get("run_covered_content_relation"))
                relation_payload = {
                    "id": str(row.get("id") or "").strip(),
                    "name": str(row.get("name") or "").strip(),
                    "subtype": str(row.get("subtype") or "").strip(),
                    "path": str(row.get("path") or "").strip(),
                    "parent": row.get("parent"),
                }
                for run_id in relation_run_ids:
                    if run_id in related_by_run:
                        related_by_run[run_id].append(relation_payload)
        return related_by_run


def build_default_octane_client() -> OctaneApiClient:
    return OctaneApiClient(
        base_url=get_octane_base_url(),
        shared_space_id=get_octane_shared_space_id(),
        workspace_id=get_octane_workspace_id(),
        session=build_cookie_session(resolve_octane_cookie_file_path()),
    )