from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Any, Callable

from backend.analytics import read_models
from backend.analytics.ontology import OntologyLoadError, load_ontology


MAX_FALLBACK_LIMIT = 100
DEFAULT_FALLBACK_LIMIT = 25


@dataclass(frozen=True)
class FallbackDataset:
    id: str
    table: str
    fields: frozenset[str]
    default_count_field: str
    resolve_db_path: Callable[[], Path | None]


def _resolve_source_db_path() -> Path | None:
    path = read_models._resolve_defect_db_path()
    return path


FALLBACK_DATASETS: dict[str, FallbackDataset] = {
    "defects": FallbackDataset(
        id="defects",
        table="octane_defects",
        fields=frozenset(
            {
                "defect_id",
                "name",
                "status_phase",
                "problem_finder_team",
                "year",
                "assigned_ecu",
                "top_aida",
                "phase",
                "solution_cluster",
                "lead_model",
                "project",
                "pu",
                "market",
                "creation_time",
                "last_modified",
                "detected_by",
                "team",
            }
        ),
        default_count_field="defect_id",
        resolve_db_path=_resolve_source_db_path,
    ),
    "manual_runs": FallbackDataset(
        id="manual_runs",
        table="octane_manual_runs",
        fields=frozenset(
            {
                "mr_id",
                "defect_id",
                "test_id",
                "test_name",
                "status",
                "project",
                "team",
                "year",
                "test_week",
                "top_aida",
                "fv",
                "fvp",
                "tester",
            }
        ),
        default_count_field="mr_id",
        resolve_db_path=_resolve_source_db_path,
    ),
}


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_list(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple, set)):
        raw_items = value
    else:
        raw_items = [value]
    normalized: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        text = _normalize_text(item)
        if not text or text in seen:
            continue
        seen.add(text)
        normalized.append(text)
    return normalized


def _normalize_limit(value: Any) -> int:
    if value in {None, ""}:
        return DEFAULT_FALLBACK_LIMIT
    try:
        limit = int(str(value).strip())
    except (TypeError, ValueError) as exc:
        raise read_models.FullPictureDashboardRequestError(f"Invalid fallback limit: {value}") from exc
    if limit <= 0:
        raise read_models.FullPictureDashboardRequestError(f"Invalid fallback limit: {value}")
    return min(limit, MAX_FALLBACK_LIMIT)


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _require_dataset(dataset_id: Any) -> FallbackDataset:
    normalized = _normalize_text(dataset_id)
    dataset = FALLBACK_DATASETS.get(normalized)
    if dataset is None:
        raise read_models.FullPictureDashboardRequestError(f"Unsupported fallback dataset: {normalized or 'empty'}")
    return dataset


def _require_field(dataset: FallbackDataset, field: Any, *, purpose: str) -> str:
    normalized = _normalize_text(field)
    if normalized not in dataset.fields:
        raise read_models.FullPictureDashboardRequestError(f"Unsupported fallback {purpose}: {normalized or 'empty'}")
    return normalized


def _available_columns(conn: Any, dataset: FallbackDataset) -> set[str]:
    if not read_models._table_exists(conn, dataset.table):
        raise read_models.FullPictureDashboardDataError(f"Fallback dataset table is unavailable: {dataset.table}")
    return read_models._table_columns(conn, dataset.table)


def _require_available(field: str, available: set[str], *, purpose: str) -> str:
    if field not in available:
        raise read_models.FullPictureDashboardRequestError(f"Fallback {purpose} is not available in source data: {field}")
    return field


def _metric_alias(metric: dict[str, Any], field: str) -> str:
    alias = _normalize_text(metric.get("as"))
    if alias:
        allowed_aliases = {"count", "row_count", "defect_count", "run_count", f"{field}_count"}
        if alias not in allowed_aliases:
            raise read_models.FullPictureDashboardRequestError(f"Unsupported fallback metric alias: {alias}")
        return alias
    return f"{field}_count"


def _normalize_metrics(raw_metrics: Any, dataset: FallbackDataset, available: set[str]) -> list[dict[str, str]]:
    metrics = raw_metrics if isinstance(raw_metrics, list) and raw_metrics else [
        {"op": "count", "field": dataset.default_count_field, "as": "row_count"}
    ]
    normalized: list[dict[str, str]] = []
    for raw_metric in metrics:
        metric = raw_metric if isinstance(raw_metric, dict) else {}
        op = _normalize_text(metric.get("op") or "count").lower()
        if op != "count":
            raise read_models.FullPictureDashboardRequestError(f"Unsupported fallback metric op: {op or 'empty'}")
        field = _require_field(dataset, metric.get("field") or dataset.default_count_field, purpose="metric field")
        _require_available(field, available, purpose="metric field")
        normalized.append({"op": op, "field": field, "as": _metric_alias(metric, field)})
    return normalized[:3]


def _normalize_group_by(raw_group_by: Any, dataset: FallbackDataset, available: set[str]) -> list[str]:
    group_by = []
    for field in _normalize_list(raw_group_by):
        normalized = _require_field(dataset, field, purpose="group_by field")
        group_by.append(_require_available(normalized, available, purpose="group_by field"))
    if len(group_by) > 2:
        raise read_models.FullPictureDashboardRequestError("Fallback query supports at most two group_by fields")
    return group_by


def _append_filter_clauses(raw_filters: Any, dataset: FallbackDataset, available: set[str], clauses: list[str], params: list[Any]) -> dict[str, list[str]]:
    filters = raw_filters if isinstance(raw_filters, dict) else {}
    normalized_filters: dict[str, list[str]] = {}
    for raw_field, raw_values in filters.items():
        field = _require_field(dataset, raw_field, purpose="filter field")
        _require_available(field, available, purpose="filter field")
        values = _normalize_list(raw_values)
        if not values:
            continue
        placeholders = ", ".join("?" for _ in values)
        clauses.append(f"{_quote_identifier(field)} IN ({placeholders})")
        params.extend(values)
        normalized_filters[field] = values
    return normalized_filters


def _append_time_clause(raw_time: Any, dataset: FallbackDataset, available: set[str], clauses: list[str], params: list[Any]) -> dict[str, Any]:
    time_scope = raw_time if isinstance(raw_time, dict) else {}
    field = _normalize_text(time_scope.get("field"))
    current = _normalize_list(time_scope.get("current"))
    if not field and not current:
        return {}
    field = _require_field(dataset, field or "creation_time", purpose="time field")
    _require_available(field, available, purpose="time field")
    if len(current) != 2:
        raise read_models.FullPictureDashboardRequestError("Fallback time.current must contain [start, end]")
    clauses.append(f"substr(CAST({_quote_identifier(field)} AS TEXT), 1, 10) BETWEEN ? AND ?")
    params.extend([current[0], current[1]])
    return {"field": field, "current": current, "timezone": _normalize_text(time_scope.get("timezone") or "Asia/Shanghai")}


def _normalize_order_by(raw_order_by: Any, output_columns: set[str]) -> list[dict[str, str]]:
    order_by = raw_order_by if isinstance(raw_order_by, list) else []
    normalized: list[dict[str, str]] = []
    for raw_item in order_by[:3]:
        item = raw_item if isinstance(raw_item, dict) else {}
        field = _normalize_text(item.get("field"))
        if field not in output_columns:
            raise read_models.FullPictureDashboardRequestError(f"Unsupported fallback order_by field: {field or 'empty'}")
        direction = _normalize_text(item.get("direction") or "asc").lower()
        if direction not in {"asc", "desc"}:
            raise read_models.FullPictureDashboardRequestError(f"Unsupported fallback order direction: {direction}")
        normalized.append({"field": field, "direction": direction})
    return normalized


def _fingerprint(query_ast: dict[str, Any]) -> str:
    canonical = json.dumps(query_ast, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def _enabled_constraint_ids(*constraint_ids: str) -> list[str]:
    try:
        catalog = load_ontology()
    except OntologyLoadError:
        return []
    enabled: list[str] = []
    for constraint_id in constraint_ids:
        try:
            constraint = catalog.get_constraint(constraint_id)
        except OntologyLoadError:
            continue
        if constraint.get("parameters", {}).get("enabled") is False:
            continue
        enabled.append(constraint_id)
    return enabled


def build_analytics_fallback_query_payload(**kwargs: Any) -> dict[str, Any]:
    if _normalize_text(kwargs.get("sql")):
        raise read_models.FullPictureDashboardRequestError("Fallback query does not accept raw SQL")
    dataset = _require_dataset(kwargs.get("dataset"))
    db_path = dataset.resolve_db_path()
    if db_path is None:
        raise read_models.FullPictureDashboardDataError(f"Fallback dataset is unavailable: {dataset.id}")

    limit = _normalize_limit(kwargs.get("limit"))
    with read_models._open_sqlite_readonly(db_path) as conn:
        available = _available_columns(conn, dataset)
        group_by = _normalize_group_by(kwargs.get("group_by"), dataset, available)
        metrics = _normalize_metrics(kwargs.get("metrics"), dataset, available)
        clauses: list[str] = []
        params: list[Any] = []
        filters = _append_filter_clauses(kwargs.get("filters"), dataset, available, clauses, params)
        time_scope = _append_time_clause(kwargs.get("time"), dataset, available, clauses, params)
        output_columns = set(group_by) | {metric["as"] for metric in metrics}
        order_by = _normalize_order_by(kwargs.get("order_by"), output_columns)

        select_parts = [f"TRIM(COALESCE(CAST({_quote_identifier(field)} AS TEXT), '')) AS {_quote_identifier(field)}" for field in group_by]
        select_parts.extend(f"COUNT({_quote_identifier(metric['field'])}) AS {_quote_identifier(metric['as'])}" for metric in metrics)
        sql_parts = [f"SELECT {', '.join(select_parts)} FROM {_quote_identifier(dataset.table)}"]
        if clauses:
            sql_parts.append("WHERE " + " AND ".join(clauses))
        if group_by:
            sql_parts.append("GROUP BY " + ", ".join(_quote_identifier(field) for field in group_by))
        if order_by:
            sql_parts.append("ORDER BY " + ", ".join(f"{_quote_identifier(item['field'])} {item['direction'].upper()}" for item in order_by))
        sql_parts.append("LIMIT ?")
        query_params = [*params, limit + 1]
        rows = [dict(row) for row in conn.execute(" ".join(sql_parts), query_params).fetchall()]

    returned_rows = rows[:limit]
    query_ast = {
        "dataset": dataset.id,
        "metrics": metrics,
        "group_by": group_by,
        "filters": filters,
        "time": time_scope,
        "order_by": order_by,
        "limit": limit,
    }
    return {
        "schema_version": "1.0",
        "dataset": dataset.id,
        "source_table": dataset.table,
        "columns": [*group_by, *[metric["as"] for metric in metrics]],
        "rows": returned_rows,
        "returned_rows": len(returned_rows),
        "truncated": len(rows) > limit,
        "query_fingerprint": _fingerprint(query_ast),
        "applied_query": query_ast,
        "field_catalog": {"allowed_fields": sorted(dataset.fields), "available_fields": sorted(set(dataset.fields) & available)},
        "audit": {
            "readonly": True,
            "allowlisted": True,
            "constraints": _enabled_constraint_ids("planner.forbid_arbitrary_sql"),
            "dataset": dataset.id,
            "source_table": dataset.table,
            "reason": _normalize_text(kwargs.get("reason")),
        },
    }