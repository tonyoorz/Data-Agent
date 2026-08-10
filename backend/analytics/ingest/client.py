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
    "requirements{name}",
    "assigned_ecu_udf{name}",
    "software_version_udf",
    "solution_cluster_udf{name}",
    "problem_category_udf{name}",
    "reporting_class_udf{name}",
    "problem_severity_udf{name}",
    "vin_udf",
    "first_use_sop_of_function_udf",
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
    "covered_content{id,name,subtype,parent{id,name,subtype},path}",
    "linked_defects",
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
    "release{name}",
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


def _reference_name(value: object) -> str:
    if isinstance(value, dict):
        return str(value.get("name") or value.get("id") or "").strip()
    return str(value or "").strip()


def _cookie_value_from_header(cookie_header: str, name: str) -> str:
    for part in str(cookie_header or "").split(";"):
        cookie_part = part.strip()
        if not cookie_part or "=" not in cookie_part:
            continue
        cookie_name, cookie_value = cookie_part.split("=", 1)
        if cookie_name.strip() == name:
            return cookie_value.strip()
    return ""


def _session_cookie_value(session: requests.Session, name: str) -> str:
    cookies = getattr(session, "cookies", None)
    cookie_value = str(cookies.get(name) if cookies is not None else "").strip()
    if cookie_value:
        return cookie_value
    return _cookie_value_from_header(str(session.headers.get("Cookie") or ""), name)


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

    def fetch_work_item(self, work_item_id: str) -> dict[str, Any]:
        normalized_id = str(work_item_id or "").strip()
        if not normalized_id:
            raise ValueError("work_item_id is required")
        response = self._session.get(
            f"{self._api_base}/work_items/{normalized_id}",
            params={"fields": "id,name,subtype,description,phase{name,id},last_modified"},
            timeout=60,
            verify=False,
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

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

    def create_comment_for_work_item(self, *, work_item_id: str, html_text: str) -> dict[str, Any]:
        normalized_id = str(work_item_id or "").strip()
        if not normalized_id:
            raise ValueError("work_item_id is required")
        text = str(html_text or "").strip()
        if not text:
            raise ValueError("html_text is required")
        xsrf_cookie = _session_cookie_value(self._session, "XSRF_COOKIE")
        if not xsrf_cookie:
            raise ValueError("XSRF_COOKIE is required to write Octane comments")

        response = self._session.post(
            f"{self._api_base}/comments",
            json={
                "data": [
                    {
                        "type": "comment",
                        "text": text,
                        "owner_work_item": {"type": "work_item", "id": normalized_id},
                    }
                ]
            },
            headers={"XSRF-HEADER": xsrf_cookie},
            timeout=60,
            verify=False,
        )
        response.raise_for_status()
        payload = response.json()
        rows = [row for row in list(payload.get("data") or []) if isinstance(row, dict)]
        return rows[0] if rows else payload

    def _xsrf_header(self) -> dict[str, str]:
        xsrf_cookie = _session_cookie_value(self._session, "XSRF_COOKIE")
        if not xsrf_cookie:
            raise ValueError("XSRF_COOKIE is required to write to Octane")
        return {"XSRF-HEADER": xsrf_cookie}

    def create_entity(
        self,
        *,
        collection: str,
        entity_type: str,
        fields: dict[str, Any],
    ) -> dict[str, Any]:
        """POST a single entity to any Octane collection (defects, tests, work_items, ...).

        Generalizes the proven write pattern in ``create_comment_for_work_item``: the body is
        ``{"data": [{"type": <entity_type>, **fields}]}`` and the request carries the
        ``XSRF-HEADER`` from the session cookie. The same session is shared with reads, so the
        existing 401 cookie self-healing chain transfers to writes.
        """
        response = self._session.post(
            f"{self._api_base}/{collection}",
            json={"data": [{"type": entity_type, **fields}]},
            headers=self._xsrf_header(),
            timeout=60,
            verify=False,
        )
        response.raise_for_status()
        payload = response.json()
        rows = [row for row in list(payload.get("data") or []) if isinstance(row, dict)]
        return rows[0] if rows else payload

    def update_entity(
        self,
        *,
        collection: str,
        entity_id: str,
        entity_type: str,
        fields: dict[str, Any],
    ) -> dict[str, Any]:
        """PUT a single-entity update. The body is the entity object directly (NOT wrapped in
        ``{"data": [...]}``), and multi-value reference fields use ``{"data": [...]}``.
        """
        response = self._session.put(
            f"{self._api_base}/{collection}/{entity_id}",
            json={"type": entity_type, "id": entity_id, **fields},
            headers=self._xsrf_header(),
            timeout=60,
            verify=False,
        )
        response.raise_for_status()
        return response.json()

    def create_test_case(
        self,
        *,
        name: str,
        description_html: str,
        owner_workspace_user_id: str,
        servicepack_node_id: str,
        covered_work_item_ids: Sequence[str] = (),
    ) -> dict[str, Any]:
        """Create a ``test_manual`` work item in the ``/tests`` collection.

        ``covered_content`` links the test to one or more backlog work items (feature/story),
        so the test appears under them in the Octane UI. Phase defaults to ``phase.test_manual.new``
        ("New / In Design"). ``owner`` and ``servicepack_udf`` are required fields in workspace
        2001 and must be supplied as ids.
        """
        fields: dict[str, Any] = {
            "subtype": "test_manual",
            "name": name,
            "description": description_html,
            "phase": {"type": "phase", "id": "phase.test_manual.new"},
            "owner": {"type": "workspace_user", "id": owner_workspace_user_id},
            "servicepack_udf": {"data": [{"type": "list_node", "id": servicepack_node_id}]},
        }
        if covered_work_item_ids:
            fields["covered_content"] = {
                "data": [{"type": "work_item", "id": str(wid)} for wid in covered_work_item_ids]
            }
        return self.create_entity(collection="tests", entity_type="test", fields=fields)

    def fetch_test_steps(self, *, test_id: str) -> dict[str, Any]:
        """Read a test_manual's steps from the ``/tests/{id}/script`` sub-resource.

        Manual test steps in workspace 2001 are stored as plain text in the test's ``script``
        field, accessed via the ``/tests/{id}/script`` sub-resource (NOT a field on the test
        entity, and NOT a ``test_steps`` collection — that returns 404). Returns a dict with
        ``script`` (the steps text), ``test_version``, and ``version_stamp``.
        """
        normalized_id = str(test_id or "").strip()
        if not normalized_id:
            raise ValueError("test_id is required")
        response = self._session.get(
            f"{self._api_base}/tests/{normalized_id}/script",
            timeout=60,
            verify=False,
        )
        response.raise_for_status()
        return response.json()

    def write_test_steps(self, *, test_id: str, steps_text: str) -> dict[str, Any]:
        """Write a test_manual's steps to the ``/tests/{id}/script`` sub-resource.

        ``steps_text`` is plain text following the workspace convention (verified against
        hand-written test 1414874):

        - ``- [PreCon] <text>`` — precondition line
        - ``- <text>``          — action step
        - ``- ? <text>``        — checkpoint / expected result

        Each line is one step. The PUT body is ``{"script": <text>}`` (a bare object, not wrapped
        in ``{"data": [...]}``).
        """
        normalized_id = str(test_id or "").strip()
        if not normalized_id:
            raise ValueError("test_id is required")
        text = str(steps_text or "")
        response = self._session.put(
            f"{self._api_base}/tests/{normalized_id}/script",
            json={"script": text},
            headers=self._xsrf_header(),
            timeout=60,
            verify=False,
        )
        response.raise_for_status()
        return response.json()

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
        releases: Sequence[str] = (),
        related_work_item_workers: int = 24,
        progress: ProgressCallback | None = None,
    ) -> list[dict[str, Any]]:
        team_name = self._team_name_cache.get(str(team_id).strip(), str(team_id).strip())
        safe_team = _escape_octane_text(team_name)
        release_names = tuple(str(release).strip() for release in releases if str(release).strip()) or _release_names_for_year(year)
        rel_expr = "||".join(f"(release={{name='{_escape_octane_text(release_name)}'}})" for release_name in release_names)
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
            run_ids_by_release: dict[str, list[str]] = {}
            for row in runs:
                run_id = str(row.get("id") or "").strip()
                if not run_id:
                    continue
                run_release = _reference_name(row.get("release"))
                run_ids_by_release.setdefault(run_release, []).append(run_id)
            related_by_run: dict[str, list[dict[str, Any]]] = {
                run_id: []
                for grouped_run_ids in run_ids_by_release.values()
                for run_id in grouped_run_ids
            }
            for run_release, grouped_run_ids in run_ids_by_release.items():
                related_by_run.update(
                    self.fetch_related_work_items_for_runs(
                        grouped_run_ids,
                        releases=(run_release,) if run_release else (),
                        max_workers=related_work_item_workers,
                        progress=progress,
                    )
                )
            for row in runs:
                run_id = str(row.get("id") or "").strip()
                row["related_work_items"] = related_by_run.get(run_id, [])
        return runs

    def fetch_related_work_items_for_runs(
        self,
        run_ids: Sequence[str],
        *,
        releases: Sequence[str] = (),
        batch_size: int = 1,
        max_workers: int = 8,
        progress: ProgressCallback | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        normalized_ids = [str(run_id).strip() for run_id in run_ids if str(run_id).strip()]
        if not normalized_ids:
            return {}
        release_names = tuple(str(release).strip() for release in releases if str(release).strip())
        release_clause = ""
        if release_names:
            rel_expr = "||".join(f"(release={{name='{_escape_octane_text(release_name)}'}})" for release_name in release_names)
            release_clause = f";({rel_expr})"

        related_by_run: dict[str, list[dict[str, Any]]] = {run_id: [] for run_id in normalized_ids}
        completed_batches = 0

        def fetch_batch(batch: Sequence[str]) -> dict[str, list[dict[str, Any]]]:
            nonlocal completed_batches
            batch_related: dict[str, list[dict[str, Any]]] = {run_id: [] for run_id in batch}
            id_expr = ",".join(f"'{_escape_octane_text(run_id)}'" for run_id in batch)
            query = f'"(subtype IN \'defect\',\'feature\',\'story\'{release_clause};run_covered_content_relation={{id IN {id_expr}}})"'
            try:
                rows = self.fetch_rows(
                    endpoint="work_items",
                    fields=WORK_ITEM_RELATION_FIELDS,
                    query=query,
                    limit=1000,
                )
            except requests.exceptions.Timeout:
                if len(batch) <= 1:
                    raise
                if progress is not None:
                    progress(f"related work-items batch timed out for {len(batch)} runs; splitting")
                midpoint = max(1, len(batch) // 2)
                left = fetch_batch(batch[:midpoint])
                right = fetch_batch(batch[midpoint:])
                for result in (left, right):
                    for run_id, items in result.items():
                        batch_related.setdefault(run_id, []).extend(items)
                return batch_related
            for row in rows:
                relation_run_ids = _normalize_relation_run_ids(row.get("run_covered_content_relation"))
                relation_payload = {
                    "id": str(row.get("id") or "").strip(),
                    "name": str(row.get("name") or "").strip(),
                    "subtype": str(row.get("subtype") or "").strip(),
                    "path": str(row.get("path") or "").strip(),
                    "parent": row.get("parent"),
                }
                if len(batch) == 1:
                    batch_related[batch[0]].append(relation_payload)
                    continue
                for run_id in relation_run_ids:
                    if run_id in batch_related:
                        batch_related[run_id].append(relation_payload)
            completed_batches += 1
            if progress is not None and completed_batches % 20 == 0:
                progress(f"related work-items batches fetched: {completed_batches}")
            return batch_related

        batches = _chunked(normalized_ids, batch_size)
        effective_workers = max(1, min(int(max_workers or 1), len(batches)))
        if effective_workers == 1:
            for batch in batches:
                result = fetch_batch(batch)
                for run_id, items in result.items():
                    related_by_run.setdefault(run_id, []).extend(items)
            return related_by_run

        with concurrent.futures.ThreadPoolExecutor(max_workers=effective_workers) as executor:
            futures = [executor.submit(fetch_batch, batch) for batch in batches]
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                for run_id, items in result.items():
                    related_by_run.setdefault(run_id, []).extend(items)
        return related_by_run


def build_default_octane_client() -> OctaneApiClient:
    return OctaneApiClient(
        base_url=get_octane_base_url(),
        shared_space_id=get_octane_shared_space_id(),
        workspace_id=get_octane_workspace_id(),
        session=build_cookie_session(resolve_octane_cookie_file_path()),
    )