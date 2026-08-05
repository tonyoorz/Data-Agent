from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import date
from typing import Any, Iterable

from backend.analytics import read_models


SCHEMA_VERSION = "1.0"
DEFAULT_TIMEZONE = "Asia/Shanghai"
MAX_AGGREGATE_LIMIT = 100
MAX_RECORD_LIMIT = 100
AGENT_DRILLDOWN_REF_VERSION = "agent-v1"

SUPPORTED_METRICS = frozenset(
    {
        "defect_count",
        "resolved_forward_count",
        "rejected_directly_count",
        "resolved_forward_rate",
        "rejected_directly_rate",
    }
)
SUPPORTED_DIMENSIONS = frozenset(
    {
        "business_module",
        "assigned_ecu",
        "solution_cluster",
        "defect_category",
        "phase",
        "aida",
        "project",
        "problem_finder_team",
        "detected_by",
        "outcome_flag",
    }
)
SUPPORTED_DERIVED_METRICS = frozenset({"delta", "growth_pct"})
SUPPORTED_FILTERS = frozenset(
    {
        "years",
        "months",
        "requirements",
        "china_scopes",
        "projects",
        "assigned_ecus",
        "problem_finder_teams",
        "aidas",
        "phases",
        "solution_clusters",
        "pus",
        "markets",
        "lead_models",
        "groups",
        "detected_by",
        "business_module",
        "business_modules",
    }
)


def _normalize_string(value: Any) -> str:
    return str(value or "").strip()


def _normalize_list(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    raw_items: Iterable[Any]
    if isinstance(value, str):
        raw_items = value.split(",")
    elif isinstance(value, Iterable):
        raw_items = value
    else:
        raw_items = [value]
    normalized: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        parts = item.split(",") if isinstance(item, str) else [item]
        for part in parts:
            text = _normalize_string(part)
            if not text or text in seen:
                continue
            seen.add(text)
            normalized.append(text)
    return normalized


def _normalize_metrics(metrics: Any) -> list[str]:
    normalized = _normalize_list(metrics) or ["defect_count"]
    unsupported = [metric for metric in normalized if metric not in SUPPORTED_METRICS]
    if unsupported:
        raise read_models.FullPictureDashboardRequestError(f"Unsupported defect metrics: {', '.join(unsupported)}")
    return normalized


def _normalize_dimensions(dimensions: Any) -> list[str]:
    normalized = _normalize_list(dimensions)
    if len(normalized) > 1:
        raise read_models.FullPictureDashboardRequestError("Defect aggregate supports at most one dimension in v1")
    unsupported = [dimension for dimension in normalized if dimension not in SUPPORTED_DIMENSIONS]
    if unsupported:
        raise read_models.FullPictureDashboardRequestError(f"Unsupported defect dimensions: {', '.join(unsupported)}")
    return normalized


def _normalize_derived_metrics(derived_metrics: Any) -> list[str]:
    normalized = _normalize_list(derived_metrics)
    unsupported = [metric for metric in normalized if metric not in SUPPORTED_DERIVED_METRICS]
    if unsupported:
        raise read_models.FullPictureDashboardRequestError(f"Unsupported derived metrics: {', '.join(unsupported)}")
    return normalized


def _normalize_limit(raw_limit: Any, *, default: int, maximum: int) -> int:
    if raw_limit in {None, ""}:
        return default
    try:
        value = int(str(raw_limit).strip())
    except (TypeError, ValueError) as exc:
        raise read_models.FullPictureDashboardRequestError(f"Invalid limit: {raw_limit}") from exc
    if value <= 0:
        raise read_models.FullPictureDashboardRequestError(f"Invalid limit: {raw_limit}")
    return min(value, maximum)


def _date_years(start: str, end: str) -> list[str]:
    try:
        start_year = date.fromisoformat(start).year
        end_year = date.fromisoformat(end).year
    except ValueError as exc:
        raise read_models.FullPictureDashboardRequestError("Defect query time.current must use YYYY-MM-DD dates") from exc
    if end < start:
        raise read_models.FullPictureDashboardRequestError("Defect query time.current end must be on or after start")
    return [str(year) for year in range(start_year, end_year + 1)]


def _normalize_time(time_scope: Any) -> dict[str, Any]:
    raw_time = time_scope if isinstance(time_scope, dict) else {}
    field = _normalize_string(raw_time.get("field") or "creation_time")
    if field != "creation_time":
        raise read_models.FullPictureDashboardRequestError("Defect query v1 only supports time.field=creation_time")
    timezone = _normalize_string(raw_time.get("timezone") or DEFAULT_TIMEZONE)
    if timezone != DEFAULT_TIMEZONE:
        raise read_models.FullPictureDashboardRequestError(f"Defect query v1 only supports timezone={DEFAULT_TIMEZONE}")
    current = raw_time.get("current") or []
    current_values = _normalize_list(current)
    if len(current_values) not in {0, 2}:
        raise read_models.FullPictureDashboardRequestError("Defect query time.current must contain [start, end]")
    normalized: dict[str, Any] = {"field": field, "timezone": timezone}
    if current_values:
        _date_years(current_values[0], current_values[1])
        normalized["current"] = current_values
    comparison_values = _normalize_list(raw_time.get("comparison"))
    if comparison_values:
        if len(comparison_values) != 2:
            raise read_models.FullPictureDashboardRequestError("Defect query time.comparison must contain [start, end]")
        _date_years(comparison_values[0], comparison_values[1])
        normalized["comparison"] = comparison_values
    return normalized


def _normalize_filters(filters: Any) -> dict[str, list[str]]:
    raw_filters = filters if isinstance(filters, dict) else {}
    normalized: dict[str, list[str]] = {}
    unsupported = sorted(str(key) for key in raw_filters if key not in SUPPORTED_FILTERS)
    if unsupported:
        raise read_models.FullPictureDashboardRequestError(f"Unsupported defect filters: {', '.join(unsupported)}")
    for key, value in raw_filters.items():
        values = _normalize_list(value)
        if values:
            normalized_key = "business_module" if key == "business_modules" else key
            normalized[normalized_key] = values
    return normalized


def _query_kwargs(filters: dict[str, list[str]], time_scope: dict[str, Any]) -> dict[str, Any]:
    kwargs: dict[str, Any] = {key: list(value) for key, value in filters.items() if key != "business_module"}
    current = time_scope.get("current") or []
    if current:
        kwargs["creation_time_start"] = current[0]
        kwargs["creation_time_end"] = current[1]
        if "years" not in kwargs:
            kwargs["years"] = _date_years(current[0], current[1])
    return kwargs


def _current_snapshot_version() -> str:
    snapshot_metadata = read_models._read_snapshot_metadata()
    snapshot_version = read_models._resolve_effective_snapshot_version(snapshot_metadata)
    if snapshot_version and snapshot_version.startswith("live-"):
        read_models._materialize_snapshot_ticket_rows(snapshot_version)
    return snapshot_version


def _load_rows(snapshot_version: str, filters: dict[str, list[str]], time_scope: dict[str, Any]) -> list[dict[str, Any]]:
    query = read_models.normalize_query(**_query_kwargs(filters, time_scope))
    rows = read_models._load_materialized_ticket_rows(snapshot_version=snapshot_version, query=query)
    business_modules = filters.get("business_module") or []
    if business_modules:
        allowed = set(business_modules)
        rows = [row for row in rows if _business_module(row) in allowed]
    return rows


def _business_module(row: dict[str, Any]) -> str:
    return _normalize_string(row.get("solution_cluster")) or _normalize_string(row.get("defect_category")) or "UNCLASSIFIED"


def _dimension_value(row: dict[str, Any], dimension: str) -> str:
    if dimension == "business_module":
        return _business_module(row)
    if dimension == "outcome_flag":
        if row.get("is_resolved_forward"):
            return "resolved_forward"
        if row.get("is_rejected_directly"):
            return "rejected_directly"
        return "other"
    return _normalize_string(row.get(dimension)) or "UNCLASSIFIED"


def _metric_values(rows: list[dict[str, Any]], metrics: list[str]) -> dict[str, Any]:
    defect_count = len(rows)
    resolved_forward_count = sum(1 for row in rows if row.get("is_resolved_forward"))
    rejected_directly_count = sum(1 for row in rows if row.get("is_rejected_directly"))
    values: dict[str, Any] = {}
    for metric in metrics:
        if metric == "defect_count":
            values[metric] = defect_count
        elif metric == "resolved_forward_count":
            values[metric] = resolved_forward_count
        elif metric == "rejected_directly_count":
            values[metric] = rejected_directly_count
        elif metric == "resolved_forward_rate":
            values[metric] = read_models._to_percent(resolved_forward_count, defect_count)
            values[f"{metric}_numerator"] = resolved_forward_count
            values[f"{metric}_denominator"] = defect_count
        elif metric == "rejected_directly_rate":
            values[metric] = read_models._to_percent(rejected_directly_count, defect_count)
            values[f"{metric}_numerator"] = rejected_directly_count
            values[f"{metric}_denominator"] = defect_count
    return values


def _fingerprint(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _encode_ref(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_ref(drilldown_ref: str) -> dict[str, Any]:
    padded = drilldown_ref + "=" * (-len(drilldown_ref) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        payload = json.loads(decoded)
    except (ValueError, json.JSONDecodeError) as exc:
        raise read_models.FullPictureDashboardRequestError("Invalid drilldown_ref") from exc
    if not isinstance(payload, dict):
        raise read_models.FullPictureDashboardRequestError("Invalid drilldown_ref")
    return payload


class AgentDrilldownScopeError(read_models.FullPictureDashboardRequestError):
    pass


def _agent_drilldown_context(kwargs: dict[str, Any]) -> tuple[str, str] | None:
    actor_scope_hash = kwargs.get("agent_actor_scope_hash")
    drilldown_secret = kwargs.get("agent_drilldown_secret")
    if actor_scope_hash is None and drilldown_secret is None:
        return None
    if not isinstance(actor_scope_hash, str) or not actor_scope_hash:
        raise read_models.FullPictureDashboardRequestError("Invalid agent drilldown context")
    if not isinstance(drilldown_secret, str) or not drilldown_secret:
        raise read_models.FullPictureDashboardRequestError("Invalid agent drilldown context")
    return actor_scope_hash, drilldown_secret


def _encode_agent_drilldown_ref(payload: dict[str, Any], *, actor_scope_hash: str, secret: str) -> str:
    payload_part = _encode_ref({**payload, "actor_scope_hash": actor_scope_hash})
    signing_input = f"{AGENT_DRILLDOWN_REF_VERSION}.{payload_part}"
    signature = hmac.new(secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    signature_part = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
    return f"{signing_input}.{signature_part}"


def _decode_agent_drilldown_ref(drilldown_ref: str, *, actor_scope_hash: str, secret: str) -> dict[str, Any]:
    parts = drilldown_ref.split(".")
    if len(parts) != 3 or parts[0] != AGENT_DRILLDOWN_REF_VERSION:
        raise read_models.FullPictureDashboardRequestError("Invalid agent drilldown_ref")
    _, payload_part, signature_part = parts
    if not signature_part or any(character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for character in signature_part):
        raise read_models.FullPictureDashboardRequestError("Invalid agent drilldown_ref")
    try:
        padded_signature = signature_part + "=" * (-len(signature_part) % 4)
        received_signature = base64.urlsafe_b64decode(padded_signature.encode("ascii"))
    except (ValueError, UnicodeEncodeError):
        raise read_models.FullPictureDashboardRequestError("Invalid agent drilldown_ref") from None
    expected_signature = hmac.new(
        secret.encode("utf-8"),
        f"{AGENT_DRILLDOWN_REF_VERSION}.{payload_part}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    if len(received_signature) != len(expected_signature) or not hmac.compare_digest(received_signature, expected_signature):
        raise read_models.FullPictureDashboardRequestError("Invalid agent drilldown_ref")
    payload = _decode_ref(payload_part)
    if payload.get("actor_scope_hash") != actor_scope_hash:
        raise AgentDrilldownScopeError("Agent drilldown scope denied")
    return payload


def _applied_query(
    *,
    metrics: list[str],
    dimensions: list[str],
    derived_metrics: list[str],
    filters: dict[str, list[str]],
    time_scope: dict[str, Any],
    order_by: list[dict[str, str]],
    limit: int,
    min_baseline_count: int,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "metrics": metrics,
        "dimensions": dimensions,
        "derived_metrics": derived_metrics,
        "filters": filters,
        "time": time_scope,
        "order_by": order_by,
        "limit": limit,
    }
    if min_baseline_count:
        payload["min_baseline_count"] = min_baseline_count
    return payload


def _normalize_order_by(order_by: Any) -> list[dict[str, str]]:
    if not isinstance(order_by, list):
        return [{"field": "defect_count", "direction": "desc"}]
    normalized: list[dict[str, str]] = []
    for item in order_by:
        if not isinstance(item, dict):
            continue
        field = _normalize_string(item.get("field"))
        direction = _normalize_string(item.get("direction") or "asc").lower()
        if not field:
            continue
        if direction not in {"asc", "desc"}:
            raise read_models.FullPictureDashboardRequestError(f"Unsupported order direction: {direction}")
        normalized.append({"field": field, "direction": direction})
    return normalized or [{"field": "defect_count", "direction": "desc"}]


def _sort_rows(rows: list[dict[str, Any]], order_by: list[dict[str, str]], dimensions: list[str]) -> list[dict[str, Any]]:
    ordered = list(rows)
    tie_field = dimensions[0] if dimensions else "scope"
    for order in reversed(order_by):
        field = order["field"]
        reverse = order["direction"] == "desc"
        ordered.sort(key=lambda row: row.get(field) if isinstance(row.get(field), (int, float)) else read_models._sortable_value(row.get(field)), reverse=reverse)
    ordered.sort(key=lambda row: read_models._sortable_value(row.get(tie_field)))
    for order in reversed(order_by):
        field = order["field"]
        reverse = order["direction"] == "desc"
        ordered.sort(key=lambda row: row.get(field) if isinstance(row.get(field), (int, float)) else read_models._sortable_value(row.get(field)), reverse=reverse)
    return ordered


def _group_rows(rows: list[dict[str, Any]], dimensions: list[str]) -> dict[str, list[dict[str, Any]]]:
    if not dimensions:
        return {"all_defects": rows}
    dimension = dimensions[0]
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        value = _dimension_value(row, dimension)
        grouped.setdefault(value, []).append(row)
    return grouped


def _comparison_time_scope(time_scope: dict[str, Any]) -> dict[str, Any] | None:
    comparison = time_scope.get("comparison")
    if not comparison:
        return None
    return {
        "field": time_scope.get("field") or "creation_time",
        "timezone": time_scope.get("timezone") or DEFAULT_TIMEZONE,
        "current": list(comparison),
    }


def _add_comparison_fields(
    row: dict[str, Any],
    *,
    current_count: int,
    previous_count: int,
    derived_metrics: list[str],
) -> None:
    if not derived_metrics:
        return
    row["current_count"] = current_count
    row["previous_count"] = previous_count
    if "delta" in derived_metrics:
        row["delta"] = current_count - previous_count
    if "growth_pct" in derived_metrics:
        row["growth_pct"] = None if previous_count == 0 else round(((current_count - previous_count) / previous_count) * 100.0, 2)
        row["is_new"] = previous_count == 0 and current_count > 0


def _row_preview(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "ticket_id": row.get("ticket_id"),
        "ticket_name": row.get("ticket_name"),
        "status": row.get("status"),
        "creation_time": row.get("creation_time"),
        "problem_finder_team": row.get("problem_finder_team"),
        "detected_by": row.get("detected_by"),
        "project": row.get("project"),
        "assigned_ecu": row.get("assigned_ecu"),
        "aida": row.get("aida"),
        "phase": row.get("phase"),
        "solution_cluster": row.get("solution_cluster"),
        "defect_category": row.get("defect_category"),
        "is_resolved_forward": bool(row.get("is_resolved_forward")),
        "is_rejected_directly": bool(row.get("is_rejected_directly")),
    }


def build_defect_aggregate_payload(**kwargs: Any) -> dict[str, Any]:
    metrics = _normalize_metrics(kwargs.get("metrics"))
    dimensions = _normalize_dimensions(kwargs.get("dimensions"))
    derived_metrics = _normalize_derived_metrics(kwargs.get("derived_metrics"))
    filters = _normalize_filters(kwargs.get("filters"))
    time_scope = _normalize_time(kwargs.get("time"))
    order_by = _normalize_order_by(kwargs.get("order_by"))
    limit = _normalize_limit(kwargs.get("limit"), default=12, maximum=MAX_AGGREGATE_LIMIT)
    min_baseline_count = _normalize_limit(kwargs.get("min_baseline_count"), default=0, maximum=100000) if kwargs.get("min_baseline_count") not in {None, ""} else 0
    agent_drilldown_context = _agent_drilldown_context(kwargs)
    snapshot_version = _current_snapshot_version()
    if not snapshot_version:
        raise read_models.FullPictureDashboardDataError("analytics dashboard snapshot is not initialized")
    current_rows = _load_rows(snapshot_version, filters, time_scope)
    applied_query = _applied_query(
        metrics=metrics,
        dimensions=dimensions,
        derived_metrics=derived_metrics,
        filters=filters,
        time_scope=time_scope,
        order_by=order_by,
        limit=limit,
        min_baseline_count=min_baseline_count,
    )
    query_fingerprint = _fingerprint({"snapshot_version": snapshot_version, "query": applied_query})
    grouped = _group_rows(current_rows, dimensions)
    comparison_scope = _comparison_time_scope(time_scope)
    comparison_grouped: dict[str, list[dict[str, Any]]] = {}
    if comparison_scope is not None:
        comparison_grouped = _group_rows(_load_rows(snapshot_version, filters, comparison_scope), dimensions)
    result_rows: list[dict[str, Any]] = []
    dimension = dimensions[0] if dimensions else "scope"
    group_values = sorted(set(grouped) | set(comparison_grouped), key=read_models._sortable_value)
    for value in group_values:
        grouped_rows = grouped.get(value, [])
        previous_rows = comparison_grouped.get(value, [])
        row = {dimension: value, **_metric_values(grouped_rows, metrics)}
        _add_comparison_fields(
            row,
            current_count=len(grouped_rows),
            previous_count=len(previous_rows),
            derived_metrics=derived_metrics,
        )
        drilldown_payload = {
            "schema_version": SCHEMA_VERSION,
            "snapshot_version": snapshot_version,
            "query_fingerprint": query_fingerprint,
            "applied_query": applied_query,
            "dimension": dimension,
            "dimension_value": value,
        }
        row["drilldown_ref"] = (
            _encode_agent_drilldown_ref(
                drilldown_payload,
                actor_scope_hash=agent_drilldown_context[0],
                secret=agent_drilldown_context[1],
            )
            if agent_drilldown_context
            else _encode_ref(drilldown_payload)
        )
        result_rows.append(row)
    result_rows = _sort_rows(result_rows, order_by, dimensions)
    total_groups = len(result_rows)
    returned_rows = result_rows[:limit]
    return {
        "schema_version": SCHEMA_VERSION,
        "snapshot_version": snapshot_version,
        "query_fingerprint": query_fingerprint,
        "applied_query": applied_query,
        "rows": returned_rows,
        "total_groups": total_groups,
        "returned_groups": len(returned_rows),
        "truncated": total_groups > len(returned_rows),
        "warnings": [],
    }


def build_defect_records_payload(**kwargs: Any) -> dict[str, Any]:
    agent_drilldown_context = _agent_drilldown_context(kwargs)
    drilldown_ref = _normalize_string(kwargs.get("drilldown_ref"))
    drilldown = (
        _decode_agent_drilldown_ref(
            drilldown_ref,
            actor_scope_hash=agent_drilldown_context[0],
            secret=agent_drilldown_context[1],
        )
        if agent_drilldown_context
        else _decode_ref(drilldown_ref)
    )
    applied_query = drilldown.get("applied_query") if isinstance(drilldown.get("applied_query"), dict) else {}
    snapshot_version = _normalize_string(drilldown.get("snapshot_version"))
    if not snapshot_version:
        raise read_models.FullPictureDashboardRequestError("Invalid drilldown_ref")
    filters = _normalize_filters(applied_query.get("filters"))
    time_scope = _normalize_time(applied_query.get("time"))
    rows = _load_rows(snapshot_version, filters, time_scope)
    dimension = _normalize_string(drilldown.get("dimension"))
    dimension_value = _normalize_string(drilldown.get("dimension_value"))
    if dimension and dimension != "scope":
        rows = [row for row in rows if _dimension_value(row, dimension) == dimension_value]
    rows.sort(key=lambda row: read_models._sortable_value(row.get("ticket_id")))
    limit = _normalize_limit(kwargs.get("limit"), default=20, maximum=MAX_RECORD_LIMIT)
    returned_rows = rows[:limit]
    return {
        "schema_version": SCHEMA_VERSION,
        "snapshot_version": snapshot_version,
        "query_fingerprint": _normalize_string(drilldown.get("query_fingerprint")),
        "applied_query": applied_query,
        "rows": [_row_preview(row) for row in returned_rows],
        "total_rows": len(rows),
        "returned_rows": len(returned_rows),
        "truncated": len(rows) > len(returned_rows),
        "warnings": ["records are examples for the selected aggregate scope; they do not prove causality"],
    }