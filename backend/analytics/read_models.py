from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
from typing import Any, Iterable
import json
import re
import sqlite3
from urllib.parse import quote

from backend.analytics.config import (
    get_analytics_db_path,
    get_full_picture_defect_db_candidates,
    get_full_picture_hot_db_path,
    get_full_picture_history_db_candidates,
    get_full_picture_source_db_path,
)
from backend.analytics.dashboard_snapshot import (
    get_summary_cache,
    normalize_summary_cache_key,
    read_active_snapshot_state,
)
from backend.analytics.db import connect
from backend.analytics.full_picture_outcomes import load_materialized_outcomes


REQUIRED_DEFECT_COLUMNS = frozenset(
    {
        "defect_id",
        "name",
        "status_phase",
        "problem_finder_team",
        "year",
        "assigned_ecu",
        "top_aida",
        "aida_english",
        "aida_businesskey",
        "phase",
        "solution_cluster",
        "lead_model",
    }
)
LOCAL_ANALYTICS_DEFECT_COLUMNS = frozenset(
    {
        "defect_id",
        "name",
        "project",
        "market",
        "pu",
        "team",
        "lead_model",
        "raw_json",
        "fetched_at",
    }
)
REQUIRED_HISTORY_EVENT_COLUMNS = frozenset(
    {
        "defect_id",
        "field_name",
        "event_timestamp",
        "entry_index",
        "change_index",
        "old_value",
        "new_value",
        "old_value_text",
        "new_value_text",
    }
)
LOCAL_ANALYTICS_HISTORY_EVENT_COLUMNS = frozenset(
    {
        "defect_id",
        "event_timestamp",
        "field_name",
        "old_value",
        "new_value",
        "fetched_at",
    }
)
DEFAULT_YEARS = ("2026",)
GROUP_ORDER = ("Q-Gate", "Integration", "CoC", "Other")
OUTCOME_SERIES = (
    ("resolved_forward", "Resolved Forward (08 -> 06)", "is_resolved_forward"),
    ("rejected_directly", "Rejected Directly (01 -> 09)", "is_rejected_directly"),
)
CHINA_SCOPE_LABEL = "China"
GLOBAL_SCOPE_LABEL = "Global"
CHINA_SOLUTION_CLUSTERS = frozenset(
    {
        "solution cluster:china product",
        "ipa cn",
        "speech cn",
        "navigation cn",
        "ent_and_con cn",
        "navigation twn",
        "etc jp",
    }
)
CHINA_DEFECT_CATEGORIES = frozenset(
    {
        "ent/connected_music_china",
        "application navigation china hk",
        "cn dkr",
        "cn backend_service",
        "cn etc",
        "cn for asia contact book",
        "cn for asiatextsupportlib",
        "cn for global festive app",
        "cn for asia speller",
        "cn for usb media service",
        "cn intelligent reminder",
        "cn ipa_visualization",
        "cn launcher",
        "cn ipa_intelligence",
        "cn llm",
        "cn media",
        "cn mls",
        "cn nav",
        "cn mpp",
        "cn social login via wechat",
        "cn store",
        "cn speech",
        "cn vod",
        "cn wechat",
        "cn_core_ui",
        "cn_experience_mode",
        "cn_huawei_hicar",
        "cn_karaoke",
        "cn_gaming",
        "cn_ui_lib",
        "cn_platform",
        "cn_subscription",
        "oap/weather/cn",
        "offboard eroute",
        "road map taiwan",
        "application navigation taiwan",
        "international keyboard",
        "apps_festivalmode",
        "cn_video_conference",
        "cn adas setting",
        "cn_demo_mode",
        "cn ad view",
        "cn video casting",
    }
)


class FullPictureDashboardDataError(ValueError):
    pass


class FullPictureDashboardRequestError(ValueError):
    pass


@dataclass(frozen=True)
class FullPictureDashboardQuery:
    years: tuple[str, ...] = DEFAULT_YEARS
    months: tuple[str, ...] = ()
    creation_time_start: str = ""
    creation_time_end: str = ""
    requirements: tuple[str, ...] = ()
    china_scopes: tuple[str, ...] = ()
    projects: tuple[str, ...] = ()
    assigned_ecus: tuple[str, ...] = ()
    problem_finder_teams: tuple[str, ...] = ()
    aidas: tuple[str, ...] = ()
    phases: tuple[str, ...] = ()
    solution_clusters: tuple[str, ...] = ()
    pus: tuple[str, ...] = ()
    markets: tuple[str, ...] = ()
    lead_models: tuple[str, ...] = ()
    groups: tuple[str, ...] = ()


def _normalize_multi_value(raw_value: Any) -> tuple[str, ...]:
    if raw_value is None:
        return ()

    if isinstance(raw_value, str):
        raw_items: Iterable[Any] = raw_value.split(",")
    else:
        raw_items = raw_value

    normalized: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        parts = item.split(",") if isinstance(item, str) else [item]
        for part in parts:
            value = str(part).strip()
            if not value or value in seen:
                continue
            seen.add(value)
            normalized.append(value)
    return tuple(normalized)


def normalize_query(**kwargs: Any) -> FullPictureDashboardQuery:
    years = _normalize_multi_value(kwargs.get("years")) or DEFAULT_YEARS
    return FullPictureDashboardQuery(
        years=years,
        months=_normalize_multi_value(kwargs.get("months")),
        creation_time_start=str(kwargs.get("creation_time_start") or "").strip(),
        creation_time_end=str(kwargs.get("creation_time_end") or "").strip(),
        requirements=_normalize_multi_value(kwargs.get("requirements")),
        china_scopes=_normalize_multi_value(kwargs.get("china_scopes")),
        projects=_normalize_multi_value(kwargs.get("projects")),
        assigned_ecus=_normalize_multi_value(kwargs.get("assigned_ecus")),
        problem_finder_teams=_normalize_multi_value(kwargs.get("problem_finder_teams")),
        aidas=_normalize_multi_value(kwargs.get("aidas")),
        phases=_normalize_multi_value(kwargs.get("phases")),
        solution_clusters=_normalize_multi_value(kwargs.get("solution_clusters")),
        pus=_normalize_multi_value(kwargs.get("pus")),
        markets=_normalize_multi_value(kwargs.get("markets")),
        lead_models=_normalize_multi_value(kwargs.get("lead_models")),
        groups=_normalize_multi_value(kwargs.get("groups")),
    )


def classify_phase_group(phase_value: Any) -> str:
    phase_code = _extract_phase_code(phase_value)
    if not phase_code:
        return "Other"
    if phase_code in {"02", "07"}:
        return "Q-Gate"
    if phase_code in {"00", "01", "06", "08", "09"}:
        return "Integration"
    if phase_code in {"03", "04", "05"}:
        return "CoC"
    return "Other"


def _extract_phase_code(raw_value: Any) -> str | None:
    text = str(raw_value or "").strip()
    if not text:
        return None

    patterns = (
        r"^(\d{2})(?=[^0-9]|$)",
        r"\bphase[_\s-]?(\d{2})\b",
        r"(\d{2})(?=-)",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return match.group(1)
    if text.isdigit() and len(text) == 2:
        return text
    return None


def _normalize_china_value(value: Any) -> str:
    return str(value or "").strip().casefold()


def _get_ticket_month_value(date_value: Any) -> str:
    text = str(date_value or "").strip()
    if not text:
        return ""

    match = re.search(r"(\d{4}-\d{2})-\d{2}", text)
    if match:
        return match.group(1)

    try:
        parsed_timestamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return parsed_timestamp.date().isoformat()[:7]


def _normalize_filter_date_value(date_value: Any) -> str:
    text = str(date_value or "").strip()
    if not text:
        return ""

    date_match = re.search(r"(\d{4}-\d{2}-\d{2})", text)
    if date_match:
        return date_match.group(1)

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return ""


def _parse_iso_date_value(date_value: Any):
    normalized_date = _normalize_filter_date_value(date_value)
    if not normalized_date:
        return None
    try:
        return datetime.fromisoformat(normalized_date).date()
    except ValueError:
        return None


def _calculate_age_days(creation_time: Any, ticket_date: Any) -> int:
    start_date = _parse_iso_date_value(creation_time)
    end_date = _parse_iso_date_value(ticket_date) or start_date
    if start_date is None or end_date is None:
        return 0
    return max((end_date - start_date).days, 0)


def _matches_creation_time_range(
    creation_time: Any,
    *,
    creation_time_start: str,
    creation_time_end: str,
) -> bool:
    normalized_creation_date = _normalize_filter_date_value(creation_time)
    if not normalized_creation_date:
        return not creation_time_start and not creation_time_end

    if creation_time_start and normalized_creation_date < creation_time_start:
        return False
    if creation_time_end and normalized_creation_date > creation_time_end:
        return False
    return True


def _get_ticket_china_scope(*, solution_cluster: Any, defect_category: Any) -> str:
    normalized_solution_cluster = _normalize_china_value(solution_cluster)
    if normalized_solution_cluster and normalized_solution_cluster in CHINA_SOLUTION_CLUSTERS:
        return CHINA_SCOPE_LABEL

    if not normalized_solution_cluster and _normalize_china_value(defect_category) in CHINA_DEFECT_CATEGORIES:
        return CHINA_SCOPE_LABEL

    return GLOBAL_SCOPE_LABEL


def _open_sqlite_readonly(db_path: Path) -> sqlite3.Connection:
    normalized_path = str(db_path.resolve()).replace("\\", "/")
    uri = f"file:{quote(normalized_path, safe='/:')}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA query_only = ON")
    except sqlite3.DatabaseError:
        pass
    return conn


def _resolve_db_path(
    candidates: tuple[Path, ...],
    table_name: str,
    *required_column_sets: Iterable[str],
    prefer_non_empty: bool = False,
) -> Path | None:
    first_match: Path | None = None

    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            with _open_sqlite_readonly(candidate) as conn:
                matches_shape = (
                    _table_has_any_required_shape(
                        conn,
                        table_name,
                        *required_column_sets,
                    )
                    if required_column_sets
                    else _table_has_required_columns(conn, table_name, ())
                )

                if not matches_shape:
                    continue

                if first_match is None:
                    first_match = candidate

                if not prefer_non_empty or _table_row_count(conn, table_name) > 0:
                    return candidate
        except sqlite3.DatabaseError:
            continue
    return first_match


def _table_has_required_columns(
    conn: sqlite3.Connection,
    table_name: str,
    required_columns: Iterable[str],
) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    if not row:
        return False

    required = {str(column).strip().lower() for column in required_columns if str(column).strip()}
    if not required:
        return True

    available = {
        str(column["name"]).strip().lower()
        for column in conn.execute(f'PRAGMA table_info("{table_name}")').fetchall()
    }
    return required.issubset(available)


def _table_has_any_required_shape(
    conn: sqlite3.Connection,
    table_name: str,
    *required_column_sets: Iterable[str],
) -> bool:
    return any(
        _table_has_required_columns(conn, table_name, required_columns)
        for required_columns in required_column_sets
    )


def _table_row_count(conn: sqlite3.Connection, table_name: str) -> int:
    row = conn.execute(f'SELECT COUNT(*) AS count FROM "{table_name}"').fetchone()
    return int(row[0] or 0) if row else 0


def _resolve_defect_db_path() -> Path | None:
    return _resolve_db_path(
        get_full_picture_defect_db_candidates(),
        "octane_defects",
        REQUIRED_DEFECT_COLUMNS,
        LOCAL_ANALYTICS_DEFECT_COLUMNS,
        prefer_non_empty=True,
    )


def _resolve_history_db_path() -> Path | None:
    return _resolve_db_path(
        get_full_picture_history_db_candidates(),
        "octane_defect_history_events",
        REQUIRED_HISTORY_EVENT_COLUMNS,
        prefer_non_empty=True,
    )


def _safe_json_object(raw_value: Any) -> dict[str, Any]:
    if isinstance(raw_value, dict):
        return raw_value
    if not isinstance(raw_value, str) or not raw_value.strip():
        return {}
    try:
        parsed = json.loads(raw_value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _first_non_empty(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _extract_reference_name(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        data = value.get("data")
        if isinstance(data, list) and data:
            first_item = data[0]
            if isinstance(first_item, dict):
                return _first_non_empty(
                    first_item.get("name"),
                    first_item.get("full_name"),
                    first_item.get("id"),
                )
        return _first_non_empty(value.get("name"), value.get("full_name"), value.get("id"))
    if isinstance(value, list) and value:
        first_item = value[0]
        if isinstance(first_item, dict):
            return _first_non_empty(
                first_item.get("name"),
                first_item.get("full_name"),
                first_item.get("id"),
            )
    return _first_non_empty(value)


def _extract_reference_names(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, dict):
        data = value.get("data")
        if isinstance(data, list):
            return _extract_reference_names(data)
        name = _extract_reference_name(value)
        return [name] if name else []
    if isinstance(value, list):
        names: list[str] = []
        seen: set[str] = set()
        for item in value:
            for name in _extract_reference_names(item):
                if not name or name in seen:
                    continue
                seen.add(name)
                names.append(name)
        return names
    name = _first_non_empty(value)
    return [name] if name else []


def _parse_string_list(raw_value: Any) -> list[str]:
    if isinstance(raw_value, list):
        return [str(item).strip() for item in raw_value if str(item or "").strip()]
    if not isinstance(raw_value, str) or not raw_value.strip():
        return []
    try:
        parsed = json.loads(raw_value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item or "").strip()]


def _matches_requirement_filter(requirement_names: Iterable[Any], allowed_values: tuple[str, ...]) -> bool:
    if not allowed_values:
        return True
    normalized_names = {str(name or "").strip() for name in requirement_names if str(name or "").strip()}
    return any(value in normalized_names for value in allowed_values)


def _build_requirement_search_params(values: tuple[str, ...]) -> list[str]:
    return [f"%{json.dumps(str(value).strip(), ensure_ascii=False).casefold()}%" for value in values if str(value).strip()]


def _extract_problem_classification(raw_payload: dict[str, Any]) -> str:
    return _first_non_empty(
        _extract_reference_name(raw_payload.get("reporting_class_udf")),
        _extract_reference_name(raw_payload.get("classification")),
    )


def _extract_problem_severity(raw_payload: dict[str, Any]) -> str:
    return _first_non_empty(
        _extract_reference_name(raw_payload.get("problem_severity_udf")),
        _extract_reference_name(raw_payload.get("severity")),
    )


def _matches_query_filters(row: dict[str, Any], query: FullPictureDashboardQuery) -> bool:
    comparisons = (
        (query.years, row.get("year")),
        (query.projects, row.get("project")),
        (query.assigned_ecus, row.get("assigned_ecu")),
        (query.problem_finder_teams, row.get("problem_finder_team")),
        (query.aidas, row.get("aida")),
        (query.phases, row.get("phase")),
        (query.solution_clusters, row.get("solution_cluster")),
        (query.pus, row.get("pu")),
        (query.markets, row.get("market")),
        (query.lead_models, row.get("lead_model")),
    )
    for allowed_values, current_value in comparisons:
        if allowed_values and str(current_value or "").strip() not in allowed_values:
            return False
    if not _matches_requirement_filter(row.get("requirement_names") or [], query.requirements):
        return False
    return True


def _load_local_analytics_defect_rows(
    db_path: Path,
    query: FullPictureDashboardQuery,
) -> list[dict[str, Any]]:
    try:
        with _open_sqlite_readonly(db_path) as conn:
            rows = conn.execute(
                "SELECT defect_id, name, project, market, pu, fv, team, lead_model, raw_json, fetched_at FROM octane_defects ORDER BY CAST(defect_id AS TEXT)"
            ).fetchall()
    except sqlite3.DatabaseError as exc:
        _raise_database_error("loading defect rows", db_path, exc)

    normalized_rows: list[dict[str, Any]] = []
    for row in rows:
        raw_payload = _safe_json_object(row["raw_json"])
        normalized = {
            "ticket_id": _first_non_empty(row["defect_id"]),
            "ticket_name": _first_non_empty(row["name"], raw_payload.get("name")),
            "status": _first_non_empty(raw_payload.get("status_phase"), raw_payload.get("phase")),
            "creation_time": _first_non_empty(raw_payload.get("creation_time")),
            "problem_finder_team": _first_non_empty(raw_payload.get("problem_finder_team"), row["team"]),
            "ticket_date": _first_non_empty(
                raw_payload.get("last_modified"),
                raw_payload.get("creation_time"),
                row["fetched_at"],
            ),
            "year": _first_non_empty(raw_payload.get("year")),
            "project": _first_non_empty(row["project"]),
            "assigned_ecu": _first_non_empty(raw_payload.get("assigned_ecu")),
            "aida": _first_non_empty(
                raw_payload.get("top_aida"),
                raw_payload.get("aida_english"),
                raw_payload.get("aida_businesskey"),
                row["fv"],
            ),
            "phase": _first_non_empty(raw_payload.get("phase"), raw_payload.get("status_phase")),
            "classification": _extract_problem_classification(raw_payload),
            "problem_severity": _extract_problem_severity(raw_payload),
            "requirement_names": _extract_reference_names(raw_payload.get("requirements")),
            "requirement": " | ".join(_extract_reference_names(raw_payload.get("requirements"))),
            "defect_category": _first_non_empty(
                raw_payload.get("defect_category"),
                raw_payload.get("defectCategory"),
                raw_payload.get("Defect category"),
            ),
            "solution_cluster": _first_non_empty(raw_payload.get("solution_cluster")),
            "pu": _first_non_empty(row["pu"]),
            "market": _first_non_empty(row["market"]),
            "lead_model": _first_non_empty(row["lead_model"]),
        }
        if _matches_query_filters(normalized, query):
            normalized_rows.append(normalized)
    return normalized_rows


def _get_table_columns(db_path: Path, table_name: str) -> tuple[str, ...]:
    try:
        with _open_sqlite_readonly(db_path) as conn:
            return tuple(
                str(column["name"]).strip()
                for column in conn.execute(f'PRAGMA table_info("{table_name}")').fetchall()
            )
    except sqlite3.DatabaseError as exc:
        _raise_database_error(f"inspecting {table_name} columns", db_path, exc)


def _raise_database_error(operation: str, db_path: Path, exc: sqlite3.DatabaseError) -> None:
    raise FullPictureDashboardDataError(
        f"Full Picture database error while {operation} from {db_path}: {exc}"
    ) from exc


def _require_database_path(db_path: Path | None, database_kind: str) -> Path:
    if db_path is None:
        raise FullPictureDashboardDataError(f"Full Picture {database_kind} database is not available")
    return db_path


def _load_defect_rows(
    query: FullPictureDashboardQuery,
    *,
    defect_db_path: Path | str | None = None,
) -> list[dict[str, Any]]:
    resolved_defect_db_path = Path(defect_db_path).resolve() if defect_db_path is not None else _resolve_defect_db_path()
    db_path = _require_database_path(resolved_defect_db_path, "defect")
    available_columns = set(_get_table_columns(db_path, "octane_defects"))
    available_columns_lower = {column.lower() for column in available_columns}

    if LOCAL_ANALYTICS_DEFECT_COLUMNS.issubset(available_columns_lower) and not REQUIRED_DEFECT_COLUMNS.issubset(available_columns_lower):
        return _load_local_analytics_defect_rows(db_path, query)

    def optional_text_expr(column_name: str, *, cast_text: bool = False) -> str:
        if column_name not in available_columns:
            return "''"
        if cast_text:
            return f"COALESCE(CAST({column_name} AS TEXT), '')"
        return f"COALESCE({column_name}, '')"

    aida_sources = [
        f"NULLIF({column_name}, '')"
        for column_name in ("top_aida", "aida_english", "aida_businesskey")
        if column_name in available_columns
    ]
    aida_expr = f"COALESCE({', '.join(aida_sources)}, '')" if aida_sources else "''"
    ticket_date_sources = [
        f"NULLIF({column_name}, '')"
        for column_name in ("last_modified", "creation_time")
        if column_name in available_columns
    ]
    ticket_date_expr = (
        f"COALESCE({', '.join(ticket_date_sources)}, '')" if ticket_date_sources else "''"
    )

    where_clauses = ["1=1"]
    params: list[Any] = []
    for expression, values in (
        (optional_text_expr("year", cast_text=True), query.years),
        (optional_text_expr("project"), query.projects),
        (optional_text_expr("assigned_ecu"), query.assigned_ecus),
        (optional_text_expr("problem_finder_team"), query.problem_finder_teams),
        (aida_expr, query.aidas),
        (optional_text_expr("phase"), query.phases),
        (optional_text_expr("solution_cluster"), query.solution_clusters),
        (optional_text_expr("pu"), query.pus),
        (optional_text_expr("market"), query.markets),
        (optional_text_expr("lead_model"), query.lead_models),
    ):
        if not values:
            continue
        placeholders = ", ".join("?" for _ in values)
        where_clauses.append(f"{expression} IN ({placeholders})")
        params.extend(values)

    if query.requirements and "requirements_json" in available_columns:
        like_clauses = ["LOWER(COALESCE(requirements_json, '')) LIKE ?" for _ in query.requirements]
        where_clauses.append("(" + " OR ".join(like_clauses) + ")")
        params.extend(_build_requirement_search_params(query.requirements))

    has_defect_category_column = "defect_category" in available_columns
    has_raw_json_column = "raw_json" in available_columns
    include_raw_json_in_primary_query = has_raw_json_column
    raw_json_expr = optional_text_expr("raw_json") if include_raw_json_in_primary_query else "''"

    sql = f"""
        SELECT
            CAST(defect_id AS TEXT) AS ticket_id,
            {optional_text_expr('name')} AS ticket_name,
            {optional_text_expr('status_phase')} AS status,
            {optional_text_expr('creation_time')} AS creation_time,
            {optional_text_expr('problem_finder_team')} AS problem_finder_team,
            {ticket_date_expr} AS ticket_date,
            {optional_text_expr('year', cast_text=True)} AS year,
            {optional_text_expr('project')} AS project,
            {optional_text_expr('assigned_ecu')} AS assigned_ecu,
            {aida_expr} AS aida,
            {optional_text_expr('phase')} AS phase,
            {optional_text_expr('requirement')} AS requirement,
            {optional_text_expr('requirements_json')} AS requirements_json,
            {optional_text_expr('defect_category')} AS defect_category,
            {optional_text_expr('solution_cluster')} AS solution_cluster,
            {optional_text_expr('pu')} AS pu,
            {optional_text_expr('market')} AS market,
            {optional_text_expr('lead_model')} AS lead_model,
            {raw_json_expr} AS raw_json
        FROM octane_defects
        WHERE {' AND '.join(where_clauses)}
        ORDER BY CAST(year AS TEXT), CAST(defect_id AS TEXT)
    """

    try:
        with _open_sqlite_readonly(db_path) as conn:
            rows = conn.execute(sql, params).fetchall()
    except sqlite3.DatabaseError as exc:
        _raise_database_error("loading defect rows", db_path, exc)

    normalized_rows: list[dict[str, Any]] = []
    missing_defect_category_ids: list[str] = []
    for row in rows:
        normalized = dict(row)
        ticket_id = str(normalized.get("ticket_id") or "").strip()
        if include_raw_json_in_primary_query:
            raw_payload = _safe_json_object(normalized.get("raw_json"))
            requirement_names = _parse_string_list(normalized.get("requirements_json"))
            if not requirement_names:
                requirement_names = _extract_reference_names(raw_payload.get("requirements"))
            normalized["requirement_names"] = requirement_names
            normalized["requirement"] = _first_non_empty(
                normalized.get("requirement"),
                " | ".join(requirement_names),
            )
            normalized["defect_category"] = _first_non_empty(
                normalized.get("defect_category"),
                raw_payload.get("defect_category"),
                raw_payload.get("defectCategory"),
                _extract_reference_name(raw_payload.get("problem_category_udf")),
            )
            normalized["creation_time"] = _first_non_empty(
                normalized.get("creation_time"),
                raw_payload.get("creation_time"),
            )
            normalized["classification"] = _first_non_empty(
                normalized.get("classification"),
                _extract_problem_classification(raw_payload),
            )
            normalized["problem_severity"] = _first_non_empty(
                normalized.get("problem_severity"),
                _extract_problem_severity(raw_payload),
            )
        else:
            normalized["requirement_names"] = _parse_string_list(normalized.get("requirements_json"))
            normalized["requirement"] = _first_non_empty(
                normalized.get("requirement"),
                " | ".join(normalized["requirement_names"]),
            )
            normalized["defect_category"] = _first_non_empty(normalized.get("defect_category"))
            if has_raw_json_column and ticket_id and not normalized["defect_category"]:
                missing_defect_category_ids.append(ticket_id)
        if query.requirements and not _matches_requirement_filter(normalized.get("requirement_names") or [], query.requirements):
            normalized.pop("raw_json", None)
            continue
        normalized.pop("raw_json", None)
        normalized_rows.append(normalized)

    if has_raw_json_column and missing_defect_category_ids:
        fallback_defect_categories = _load_problem_categories_from_raw_json(
            db_path,
            tuple(missing_defect_category_ids),
        )
        for normalized in normalized_rows:
            ticket_id = str(normalized.get("ticket_id") or "").strip()
            if ticket_id and not normalized.get("defect_category"):
                normalized["defect_category"] = fallback_defect_categories.get(ticket_id, "")

    return normalized_rows


def _load_problem_categories_from_raw_json(
    db_path: Path,
    defect_ids: tuple[str, ...],
) -> dict[str, str]:
    if not defect_ids:
        return {}

    categories: dict[str, str] = {}
    try:
        with _open_sqlite_readonly(db_path) as conn:
            for start in range(0, len(defect_ids), 500):
                chunk = defect_ids[start : start + 500]
                placeholders = ", ".join("?" for _ in chunk)
                sql = f"""
                    SELECT
                        CAST(defect_id AS TEXT) AS ticket_id,
                        COALESCE(raw_json, '') AS raw_json
                    FROM octane_defects
                    WHERE CAST(defect_id AS TEXT) IN ({placeholders})
                """
                for row in conn.execute(sql, list(chunk)).fetchall():
                    raw_payload = _safe_json_object(row["raw_json"])
                    category = _first_non_empty(
                        raw_payload.get("defect_category"),
                        raw_payload.get("defectCategory"),
                        _extract_reference_name(raw_payload.get("problem_category_udf")),
                    )
                    ticket_id = str(row["ticket_id"] or "").strip()
                    if ticket_id and category:
                        categories[ticket_id] = category
    except sqlite3.DatabaseError as exc:
        _raise_database_error("loading defect-category raw_json fallbacks", db_path, exc)

    return categories


def _load_history_events(defect_ids: tuple[str, ...]) -> list[dict[str, Any]]:
    if not defect_ids:
        return []

    db_path = _require_database_path(_resolve_history_db_path(), "history")
    rows: list[dict[str, Any]] = []
    try:
        with _open_sqlite_readonly(db_path) as conn:
            for start in range(0, len(defect_ids), 500):
                chunk = defect_ids[start : start + 500]
                placeholders = ", ".join("?" for _ in chunk)
                sql = f"""
                    SELECT
                        CAST(defect_id AS TEXT) AS ticket_id,
                        COALESCE(event_timestamp, '') AS event_timestamp,
                        COALESCE(entry_index, 0) AS entry_index,
                        COALESCE(change_index, 0) AS change_index,
                        COALESCE(old_value, '') AS old_value,
                        COALESCE(new_value, '') AS new_value,
                        COALESCE(old_value_text, '') AS old_value_text,
                        COALESCE(new_value_text, '') AS new_value_text
                    FROM octane_defect_history_events
                    WHERE CAST(defect_id AS TEXT) IN ({placeholders})
                      AND LOWER(COALESCE(field_name, '')) LIKE '%phase%'
                """
                rows.extend(dict(row) for row in conn.execute(sql, list(chunk)).fetchall())
    except sqlite3.DatabaseError as exc:
        _raise_database_error("loading defect history", db_path, exc)

    rows.sort(
        key=lambda row: (
            str(row.get("event_timestamp") or ""),
            int(row.get("entry_index") or 0),
            int(row.get("change_index") or 0),
        )
    )
    return rows


def _build_outcome_index(history_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for row in history_rows:
        ticket_id = str(row.get("ticket_id") or "").strip()
        if not ticket_id:
            continue
        state = indexed.setdefault(ticket_id, _empty_outcome_state())
        old_code = _extract_phase_code(row.get("old_value_text")) or _extract_phase_code(row.get("old_value"))
        new_code = _extract_phase_code(row.get("new_value_text")) or _extract_phase_code(row.get("new_value"))

        if old_code == "08" and new_code == "06":
            state["is_resolved_forward"] = True
        elif old_code == "01" and new_code == "09":
            state["is_rejected_directly"] = True
    return indexed


def _empty_outcome_state() -> dict[str, bool]:
    return {
        "is_resolved_forward": False,
        "is_rejected_directly": False,
    }


def _load_hot_outcomes(
    defect_ids: tuple[str, ...],
    *,
    hot_db_path: Path | str | None = None,
) -> dict[str, dict[str, Any]]:
    resolved_hot_db_path = Path(hot_db_path).resolve() if hot_db_path is not None else get_full_picture_hot_db_path()
    try:
        return load_materialized_outcomes(resolved_hot_db_path, defect_ids)
    except FileNotFoundError as exc:
        raise FullPictureDashboardDataError(
            f"Full Picture hot outcomes are not available from {resolved_hot_db_path}"
        ) from exc
    except sqlite3.DatabaseError as exc:
        raise FullPictureDashboardDataError(
            f"Full Picture hot outcomes are not available from {resolved_hot_db_path}: {exc}"
        ) from exc


def _build_ticket_rows(
    defect_rows: list[dict[str, Any]],
    outcome_index: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    ticket_rows: list[dict[str, Any]] = []
    for row in defect_rows:
        ticket_id = str(row.get("ticket_id") or "").strip()
        if not ticket_id:
            continue
        phase = str(row.get("phase") or "").strip()
        group = classify_phase_group(phase)
        outcome_state = outcome_index.get(ticket_id, _empty_outcome_state())
        creation_time = str(row.get("creation_time") or "").strip()
        ticket_date = str(row.get("ticket_date") or "").strip()
        defect_category = str(row.get("defect_category") or "").strip()
        solution_cluster = str(row.get("solution_cluster") or "").strip()
        ticket_row = {
            "ticket_id": ticket_id,
            "ticket_name": str(row.get("ticket_name") or "").strip(),
            "status": str(row.get("status") or row.get("phase") or "").strip(),
            "creation_time": creation_time,
            "ticket_date": ticket_date,
            "month": _get_ticket_month_value(creation_time),
            "problem_finder_team": str(row.get("problem_finder_team") or "").strip(),
            "classification": str(row.get("classification") or "").strip(),
            "problem_severity": str(row.get("problem_severity") or "").strip(),
            "group": group,
            "phase": phase,
            "requirement": str(row.get("requirement") or "").strip(),
            "requirement_names": list(row.get("requirement_names") or []),
            "is_resolved_forward": bool(outcome_state["is_resolved_forward"]),
            "is_rejected_directly": bool(outcome_state["is_rejected_directly"]),
            "year": str(row.get("year") or "").strip(),
            "project": str(row.get("project") or "").strip(),
            "assigned_ecu": str(row.get("assigned_ecu") or "").strip(),
            "aida": str(row.get("aida") or "").strip(),
            "defect_category": defect_category,
            "china_scope": _get_ticket_china_scope(
                solution_cluster=solution_cluster,
                defect_category=defect_category,
            ),
            "solution_cluster": solution_cluster,
            "pu": str(row.get("pu") or "").strip(),
            "market": str(row.get("market") or "").strip(),
            "lead_model": str(row.get("lead_model") or "").strip(),
        }
        if ticket_date:
            ticket_row["ticket_date"] = ticket_date
        ticket_rows.append(ticket_row)
    ticket_rows.sort(key=lambda row: (_sortable_value(row.get("problem_finder_team")), _sortable_value(row.get("ticket_id"))))
    return ticket_rows


def _apply_group_filter(ticket_rows: list[dict[str, Any]], groups: tuple[str, ...]) -> list[dict[str, Any]]:
    if not groups:
        return ticket_rows
    allowed = set(groups)
    return [row for row in ticket_rows if row.get("group") in allowed]


def _collect_unique_requirement_names(ticket_rows: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for row in ticket_rows:
        for name in row.get("requirement_names") or []:
            normalized = str(name or "").strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            names.append(normalized)
    return _unique_sorted(names)


def _build_filters(ticket_rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    return {
        "years": _unique_sorted(row.get("year") for row in ticket_rows),
        "months": _unique_sorted(row.get("month") for row in ticket_rows),
        "requirements": _collect_unique_requirement_names(ticket_rows),
        "china_scopes": _unique_sorted(row.get("china_scope") for row in ticket_rows),
        "projects": _unique_sorted(row.get("project") for row in ticket_rows),
        "assigned_ecus": _unique_sorted(row.get("assigned_ecu") for row in ticket_rows),
        "problem_finder_teams": _unique_sorted(row.get("problem_finder_team") for row in ticket_rows),
        "aidas": _unique_sorted(row.get("aida") for row in ticket_rows),
        "phases": _unique_sorted(row.get("phase") for row in ticket_rows),
        "solution_clusters": _unique_sorted(row.get("solution_cluster") for row in ticket_rows),
        "pus": _unique_sorted(row.get("pu") for row in ticket_rows),
        "markets": _unique_sorted(row.get("market") for row in ticket_rows),
        "lead_models": _unique_sorted(row.get("lead_model") for row in ticket_rows),
        "groups": _unique_sorted((row.get("group") for row in ticket_rows), group_values=True),
    }


FILTER_QUERY_FIELD_NAMES = (
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
)

MATERIALIZED_FILTER_COLUMNS = {
    "years": "year",
    "months": "ticket_month",
    "requirements": "requirements_json",
    "china_scopes": "china_scope",
    "projects": "project",
    "assigned_ecus": "assigned_ecu",
    "problem_finder_teams": "problem_finder_team",
    "aidas": "aida",
    "phases": "phase",
    "solution_clusters": "solution_cluster",
    "pus": "pu",
    "markets": "market",
    "lead_models": "lead_model",
    "groups": "group_name",
}


def _query_without_filter(
    query: FullPictureDashboardQuery,
    field_name: str,
) -> FullPictureDashboardQuery:
    return replace(query, **{field_name: ()})


def _sort_filter_values(field_name: str, values: Iterable[Any]) -> list[str]:
    return _unique_sorted(values, group_values=field_name == "groups")


def _build_overview(ticket_rows: list[dict[str, Any]]) -> dict[str, Any]:
    total_tickets = len(ticket_rows)
    resolved_forward_count = _count_ticket_rows(ticket_rows, "is_resolved_forward")
    rejected_directly_count = _count_ticket_rows(ticket_rows, "is_rejected_directly")
    return {
        "ticket_count": total_tickets,
        "resolved_forward_count": resolved_forward_count,
        "rejected_directly_count": rejected_directly_count,
        "resolved_forward_percent": _to_percent(resolved_forward_count, total_tickets),
        "rejected_directly_percent": _to_percent(rejected_directly_count, total_tickets),
    }


def _build_outcome_summary(ticket_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    total_tickets = len(ticket_rows)
    return [
        {
            "key": key,
            "label": label,
            "count": _count_ticket_rows(ticket_rows, flag_name),
            "percent": _to_percent(_count_ticket_rows(ticket_rows, flag_name), total_tickets),
            "denominator": total_tickets,
        }
        for key, label, flag_name in OUTCOME_SERIES
    ]


def _build_team_outcome_rows(ticket_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, int]] = {}
    for row in ticket_rows:
        team_name = str(row.get("problem_finder_team") or "").strip()
        state = grouped.setdefault(
            team_name,
            {"total": 0, "resolved_forward": 0, "rejected_directly": 0},
        )
        state["total"] += 1
        if row.get("is_resolved_forward"):
            state["resolved_forward"] += 1
        if row.get("is_rejected_directly"):
            state["rejected_directly"] += 1

    team_rows = []
    for team_name, state in grouped.items():
        team_total = state["total"]
        team_rows.append(
            {
                "problem_finder_team": team_name,
                "total_tickets": state["total"],
                "resolved_forward_count": state["resolved_forward"],
                "rejected_directly_count": state["rejected_directly"],
                "resolved_forward_team_percent": _to_percent(state["resolved_forward"], team_total),
                "rejected_directly_team_percent": _to_percent(state["rejected_directly"], team_total),
                "team_denominator": team_total,
            }
        )
    team_rows.sort(key=lambda row: (-int(row["total_tickets"]), _sortable_value(row["problem_finder_team"])))
    return team_rows


def _count_ticket_rows(ticket_rows: list[dict[str, Any]], flag_name: str) -> int:
    return sum(1 for row in ticket_rows if row.get(flag_name))


def _unique_sorted(values: Iterable[Any], *, group_values: bool = False) -> list[str]:
    unique_values = {str(value).strip() for value in values if str(value or "").strip()}
    if group_values:
        order = {group: index for index, group in enumerate(GROUP_ORDER)}
        return sorted(unique_values, key=lambda value: (order.get(value, len(GROUP_ORDER)), _sortable_value(value)))
    return sorted(unique_values, key=_sortable_value)


def _sortable_value(value: Any) -> tuple[int, Any]:
    text = str(value or "").strip()
    if text.isdigit():
        return (0, int(text))
    return (1, text.casefold())


def _to_percent(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round((numerator / denominator) * 100.0, 2)


def _serialize_query_filters(query: FullPictureDashboardQuery) -> dict[str, list[str]]:
    return {
        "years": list(query.years),
        "months": list(query.months),
        "creation_time_start": [query.creation_time_start] if query.creation_time_start else [],
        "creation_time_end": [query.creation_time_end] if query.creation_time_end else [],
        "requirements": list(query.requirements),
        "china_scopes": list(query.china_scopes),
        "projects": list(query.projects),
        "assigned_ecus": list(query.assigned_ecus),
        "problem_finder_teams": list(query.problem_finder_teams),
        "aidas": list(query.aidas),
        "phases": list(query.phases),
        "solution_clusters": list(query.solution_clusters),
        "pus": list(query.pus),
        "markets": list(query.markets),
        "lead_models": list(query.lead_models),
        "groups": list(query.groups),
    }


def _read_snapshot_metadata() -> dict[str, object]:
    return read_active_snapshot_state(get_full_picture_hot_db_path())


def _normalize_snapshot_source_path(db_path: Path | str | None) -> str:
    raw_path = str(db_path or "").strip()
    if not raw_path:
        return ""
    try:
        return str(Path(raw_path).resolve())
    except OSError:
        return raw_path


def _format_snapshot_source_mtime(db_path: Path | str | None) -> str:
    raw_path = str(db_path or "").strip()
    if not raw_path:
        return ""
    try:
        stat_result = Path(raw_path).resolve().stat()
    except OSError:
        return ""
    return datetime.fromtimestamp(stat_result.st_mtime, timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00",
        "Z",
    )


def _build_db_source_signature(db_path: Path | str | None) -> str:
    resolved_path = Path(db_path or "")
    if not str(resolved_path).strip() or not resolved_path.exists():
        return ""
    stat_result = resolved_path.stat()
    return f"{resolved_path.resolve()}|{stat_result.st_size}|{stat_result.st_mtime_ns}"


def _read_outcome_refresh_signature(hot_db_path: Path | str) -> str:
    try:
        with connect(hot_db_path) as conn:
            row = conn.execute(
                """
                SELECT source_signature, refreshed_at
                FROM outcome_refresh_state
                WHERE store_name = ?
                LIMIT 1
                """,
                ("defect_outcomes",),
            ).fetchone()
    except sqlite3.DatabaseError:
        return ""

    if row is None:
        return ""

    source_signature = str(row["source_signature"] or "").strip()
    refreshed_at = str(row["refreshed_at"] or "").strip()
    return "|".join(part for part in (source_signature, refreshed_at) if part)


def _build_fallback_snapshot_version() -> str:
    source_signature = _build_db_source_signature(_resolve_defect_db_path() or get_full_picture_source_db_path())
    outcome_signature = _read_outcome_refresh_signature(get_full_picture_hot_db_path())
    combined_signature = "||".join(part for part in (source_signature, outcome_signature) if part)
    if not combined_signature:
        return ""
    digest = hashlib.sha1(combined_signature.encode("utf-8")).hexdigest()[:16]
    return f"live-{digest}"


def _active_snapshot_matches_current_source(snapshot_metadata: dict[str, object]) -> bool:
    active_snapshot_version = _resolve_snapshot_version(snapshot_metadata)
    if not active_snapshot_version:
        return False

    current_source_path = _resolve_defect_db_path() or get_full_picture_source_db_path()
    normalized_current_source_path = _normalize_snapshot_source_path(current_source_path)
    normalized_snapshot_source_path = _normalize_snapshot_source_path(snapshot_metadata.get("source_db_path"))
    if normalized_current_source_path and normalized_snapshot_source_path:
        if normalized_current_source_path != normalized_snapshot_source_path:
            return False
    elif normalized_current_source_path != normalized_snapshot_source_path:
        return False

    recorded_source_mtime = str(snapshot_metadata.get("source_db_mtime") or "").strip()
    current_source_mtime = _format_snapshot_source_mtime(current_source_path)
    if recorded_source_mtime and current_source_mtime:
        return recorded_source_mtime == current_source_mtime
    return False


def _resolve_effective_snapshot_version(snapshot_metadata: dict[str, object]) -> str:
    active_snapshot_version = _resolve_snapshot_version(snapshot_metadata)
    if active_snapshot_version and _active_snapshot_matches_current_source(snapshot_metadata):
        return active_snapshot_version
    fallback_snapshot_version = _build_fallback_snapshot_version()
    if fallback_snapshot_version:
        return fallback_snapshot_version
    return active_snapshot_version


DASHBOARD_TICKET_STORE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS dashboard_ticket_snapshot_rows (
    snapshot_version TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    ticket_name TEXT NOT NULL,
    status TEXT NOT NULL,
    creation_time TEXT NOT NULL,
    ticket_date TEXT NOT NULL,
    ticket_month TEXT NOT NULL,
    china_scope TEXT NOT NULL,
    problem_finder_team TEXT NOT NULL,
    classification TEXT NOT NULL,
    problem_severity TEXT NOT NULL,
    group_name TEXT NOT NULL,
    phase TEXT NOT NULL,
    requirement TEXT NOT NULL,
    requirements_json TEXT NOT NULL,
    is_resolved_forward INTEGER NOT NULL,
    is_rejected_directly INTEGER NOT NULL,
    year TEXT NOT NULL,
    project TEXT NOT NULL,
    assigned_ecu TEXT NOT NULL,
    aida TEXT NOT NULL,
    defect_category TEXT NOT NULL,
    solution_cluster TEXT NOT NULL,
    pu TEXT NOT NULL,
    market TEXT NOT NULL,
    lead_model TEXT NOT NULL,
    PRIMARY KEY (snapshot_version, ticket_id)
);
CREATE TABLE IF NOT EXISTS dashboard_ticket_snapshot_state (
    snapshot_version TEXT NOT NULL PRIMARY KEY,
    row_count INTEGER NOT NULL,
    refreshed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dashboard_ticket_snapshot_filters
    ON dashboard_ticket_snapshot_rows(snapshot_version, year, ticket_month, china_scope, phase, problem_finder_team, group_name);
CREATE INDEX IF NOT EXISTS idx_dashboard_ticket_snapshot_project
    ON dashboard_ticket_snapshot_rows(snapshot_version, project, assigned_ecu, aida, solution_cluster, pu, market, lead_model);
"""

MATERIALIZED_TICKET_SORT_COLUMNS = {
    "ticket_id": "ticket_id",
    "ticket_name": "ticket_name",
    "status": "status",
    "creation_time": "creation_time",
    "ticket_date": "ticket_date",
    "problem_finder_team": "problem_finder_team",
    "classification": "classification",
    "problem_severity": "problem_severity",
    "group": "group_name",
    "phase": "phase",
    "requirement": "requirement",
    "year": "year",
    "project": "project",
    "assigned_ecu": "assigned_ecu",
    "aida": "aida",
    "defect_category": "defect_category",
    "solution_cluster": "solution_cluster",
    "pu": "pu",
    "market": "market",
    "lead_model": "lead_model",
}


def _ensure_dashboard_ticket_store(conn: sqlite3.Connection) -> bool:
    conn.executescript(DASHBOARD_TICKET_STORE_SCHEMA_SQL)
    schema_updated = False
    existing_columns = {
        str(row["name"]).strip()
        for row in conn.execute("PRAGMA table_info('dashboard_ticket_snapshot_rows')").fetchall()
    }
    for column_name, definition in (
        ("creation_time", "TEXT NOT NULL DEFAULT ''"),
        ("classification", "TEXT NOT NULL DEFAULT ''"),
        ("problem_severity", "TEXT NOT NULL DEFAULT ''"),
        ("requirement", "TEXT NOT NULL DEFAULT ''"),
        ("requirements_json", "TEXT NOT NULL DEFAULT '[]'"),
    ):
        if column_name not in existing_columns:
            conn.execute(
                f"ALTER TABLE dashboard_ticket_snapshot_rows ADD COLUMN {column_name} {definition}"
            )
            schema_updated = True
    return schema_updated


def _build_generated_from_payload(query: FullPictureDashboardQuery) -> dict[str, Any]:
    return {
        "defect_db_path": str(_resolve_defect_db_path() or ""),
        "outcome_db_path": str(get_full_picture_hot_db_path()),
        "history_db_path": str(_resolve_history_db_path() or ""),
        **_serialize_query_filters(query),
    }


def _materialize_snapshot_ticket_rows(
    snapshot_version: str,
    *,
    defect_db_path: Path | str | None = None,
    hot_db_path: Path | str | None = None,
    defect_ids: Iterable[Any] | None = None,
) -> None:
    normalized_snapshot_version = str(snapshot_version or "").strip()
    if not normalized_snapshot_version:
        return
    has_incremental_defect_ids = defect_ids is not None

    resolved_hot_db_path = Path(hot_db_path).resolve() if hot_db_path is not None else get_full_picture_hot_db_path()
    resolved_hot_db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(resolved_hot_db_path)
    conn.row_factory = sqlite3.Row
    try:
        schema_updated = _ensure_dashboard_ticket_store(conn)
        state_row = conn.execute(
            "SELECT row_count FROM dashboard_ticket_snapshot_state WHERE snapshot_version = ?",
            (normalized_snapshot_version,),
        ).fetchone()
        if state_row is not None and not schema_updated:
            if not has_incremental_defect_ids:
                return

        if schema_updated:
            conn.execute(
                "DELETE FROM dashboard_ticket_snapshot_state WHERE snapshot_version = ?",
                (normalized_snapshot_version,),
            )

        all_snapshot_query = FullPictureDashboardQuery(years=())
        _generated_from, ticket_rows = _build_full_picture_dataset(
            all_snapshot_query,
            defect_db_path=defect_db_path,
            hot_db_path=resolved_hot_db_path,
        )
        refreshed_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

        conn.execute(
            "DELETE FROM dashboard_ticket_snapshot_rows WHERE snapshot_version = ?",
            (normalized_snapshot_version,),
        )
        conn.executemany(
            """
            INSERT INTO dashboard_ticket_snapshot_rows(
                snapshot_version,
                ticket_id,
                ticket_name,
                status,
                creation_time,
                ticket_date,
                ticket_month,
                china_scope,
                problem_finder_team,
                classification,
                problem_severity,
                group_name,
                phase,
                requirement,
                requirements_json,
                is_resolved_forward,
                is_rejected_directly,
                year,
                project,
                assigned_ecu,
                aida,
                defect_category,
                solution_cluster,
                pu,
                market,
                lead_model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    normalized_snapshot_version,
                    str(row.get("ticket_id") or ""),
                    str(row.get("ticket_name") or ""),
                    str(row.get("status") or ""),
                    str(row.get("creation_time") or ""),
                    str(row.get("ticket_date") or ""),
                    str(row.get("month") or ""),
                    str(row.get("china_scope") or ""),
                    str(row.get("problem_finder_team") or ""),
                    str(row.get("classification") or ""),
                    str(row.get("problem_severity") or ""),
                    str(row.get("group") or ""),
                    str(row.get("phase") or ""),
                    str(row.get("requirement") or ""),
                    json.dumps(list(row.get("requirement_names") or []), ensure_ascii=False),
                    1 if row.get("is_resolved_forward") else 0,
                    1 if row.get("is_rejected_directly") else 0,
                    str(row.get("year") or ""),
                    str(row.get("project") or ""),
                    str(row.get("assigned_ecu") or ""),
                    str(row.get("aida") or ""),
                    str(row.get("defect_category") or ""),
                    str(row.get("solution_cluster") or ""),
                    str(row.get("pu") or ""),
                    str(row.get("market") or ""),
                    str(row.get("lead_model") or ""),
                )
                for row in ticket_rows
            ],
        )
        conn.execute(
            """
            INSERT INTO dashboard_ticket_snapshot_state(snapshot_version, row_count, refreshed_at)
            VALUES (?, ?, ?)
            ON CONFLICT(snapshot_version) DO UPDATE SET
                row_count = excluded.row_count,
                refreshed_at = excluded.refreshed_at
            """,
            (normalized_snapshot_version, len(ticket_rows), refreshed_at),
        )
        conn.commit()
    finally:
        conn.close()


def has_materialized_dashboard_snapshot_rows(
    snapshot_version: str,
    *,
    hot_db_path: Path | str | None = None,
) -> bool:
    normalized_snapshot_version = str(snapshot_version or "").strip()
    if not normalized_snapshot_version:
        return False

    resolved_hot_db_path = Path(hot_db_path).resolve() if hot_db_path is not None else get_full_picture_hot_db_path()
    if not resolved_hot_db_path.exists():
        return False

    conn = sqlite3.connect(resolved_hot_db_path)
    conn.row_factory = sqlite3.Row
    try:
        schema_updated = _ensure_dashboard_ticket_store(conn)
        if schema_updated:
            return False
        state_row = conn.execute(
            "SELECT row_count FROM dashboard_ticket_snapshot_state WHERE snapshot_version = ?",
            (normalized_snapshot_version,),
        ).fetchone()
        return state_row is not None
    finally:
        conn.close()


def publish_dashboard_snapshot_rows(
    snapshot_version: str,
    *,
    defect_db_path: Path | str | None = None,
    hot_db_path: Path | str | None = None,
    defect_ids: Iterable[Any] | None = None,
) -> None:
    _materialize_snapshot_ticket_rows(
        snapshot_version,
        defect_db_path=defect_db_path,
        hot_db_path=hot_db_path,
        defect_ids=defect_ids,
    )


def _build_materialized_ticket_where_clause(
    query: FullPictureDashboardQuery,
    *,
    snapshot_version: str,
    search: str = "",
) -> tuple[str, list[Any]]:
    where_clauses = ["snapshot_version = ?"]
    params: list[Any] = [snapshot_version]

    for column_name, values in (
        ("year", query.years),
        ("ticket_month", query.months),
        ("china_scope", query.china_scopes),
        ("project", query.projects),
        ("assigned_ecu", query.assigned_ecus),
        ("problem_finder_team", query.problem_finder_teams),
        ("aida", query.aidas),
        ("phase", query.phases),
        ("solution_cluster", query.solution_clusters),
        ("pu", query.pus),
        ("market", query.markets),
        ("lead_model", query.lead_models),
        ("group_name", query.groups),
    ):
        if not values:
            continue
        placeholders = ", ".join("?" for _ in values)
        where_clauses.append(f"{column_name} IN ({placeholders})")
        params.extend(values)

    if query.requirements:
        like_clauses = ["LOWER(COALESCE(requirements_json, '')) LIKE ?" for _ in query.requirements]
        where_clauses.append("(" + " OR ".join(like_clauses) + ")")
        params.extend(_build_requirement_search_params(query.requirements))

    if query.creation_time_start:
        where_clauses.append("substr(COALESCE(creation_time, ''), 1, 10) >= ?")
        params.append(query.creation_time_start)
    if query.creation_time_end:
        where_clauses.append("substr(COALESCE(creation_time, ''), 1, 10) <= ?")
        params.append(query.creation_time_end)

    normalized_search = str(search or "").strip().casefold()
    if normalized_search:
        search_columns = (
            "ticket_id",
            "ticket_name",
            "creation_time",
            "problem_finder_team",
            "classification",
            "problem_severity",
            "status",
            "phase",
            "requirement",
            "group_name",
            "project",
        )
        where_clauses.append(
            "(" + " OR ".join(f"LOWER(COALESCE({column}, '')) LIKE ?" for column in search_columns) + ")"
        )
        params.extend([f"%{normalized_search}%"] * len(search_columns))

    return " AND ".join(where_clauses), params


def _load_materialized_ticket_rows(
    *,
    snapshot_version: str,
    query: FullPictureDashboardQuery,
) -> list[dict[str, Any]]:
    hot_db_path = get_full_picture_hot_db_path()
    with connect(hot_db_path) as conn:
        _ensure_dashboard_ticket_store(conn)
        where_sql, params = _build_materialized_ticket_where_clause(
            query,
            snapshot_version=snapshot_version,
        )
        rows = conn.execute(
            f"""
            SELECT
                ticket_id,
                ticket_name,
                status,
                creation_time,
                ticket_date,
                ticket_month AS month,
                china_scope,
                problem_finder_team,
                classification,
                problem_severity,
                group_name AS "group",
                phase,
                requirement,
                requirements_json,
                is_resolved_forward,
                is_rejected_directly,
                year,
                project,
                assigned_ecu,
                aida,
                defect_category,
                solution_cluster,
                pu,
                market,
                lead_model
            FROM dashboard_ticket_snapshot_rows
            WHERE {where_sql}
            ORDER BY ticket_id
            """,
            params,
        ).fetchall()
    ticket_rows = [dict(row) for row in rows]
    for row in ticket_rows:
        row["requirement_names"] = _parse_string_list(row.get("requirements_json"))
    return ticket_rows


def _load_materialized_filter_values(
    *,
    snapshot_version: str,
    query: FullPictureDashboardQuery,
    field_name: str,
) -> list[str]:
    hot_db_path = get_full_picture_hot_db_path()
    column_name = MATERIALIZED_FILTER_COLUMNS[field_name]
    with connect(hot_db_path) as conn:
        _ensure_dashboard_ticket_store(conn)
        where_sql, params = _build_materialized_ticket_where_clause(
            query,
            snapshot_version=snapshot_version,
        )
        rows = conn.execute(
            f"""
            SELECT DISTINCT {column_name} AS value
            FROM dashboard_ticket_snapshot_rows
            WHERE {where_sql}
            """,
            params,
        ).fetchall()
    if field_name == "requirements":
        values: list[str] = []
        for row in rows:
            values.extend(_parse_string_list(row["value"]))
        return _sort_filter_values(field_name, values)
    return _sort_filter_values(field_name, (row["value"] for row in rows))


def _build_summary_filters(
    query: FullPictureDashboardQuery,
    *,
    snapshot_version: str,
    filtered_ticket_rows: list[dict[str, Any]],
) -> dict[str, list[str]]:
    if snapshot_version:
        return {
            field_name: _load_materialized_filter_values(
                snapshot_version=snapshot_version,
                query=_query_without_filter(query, field_name),
                field_name=field_name,
            )
            for field_name in FILTER_QUERY_FIELD_NAMES
        }

    summary_filters: dict[str, list[str]] = {}
    for field_name in FILTER_QUERY_FIELD_NAMES:
        relaxed_query = _query_without_filter(query, field_name)
        if relaxed_query == query:
            relaxed_rows = filtered_ticket_rows
        else:
            _generated_from, relaxed_rows = _build_full_picture_dataset(relaxed_query)
        summary_filters[field_name] = _build_filters(relaxed_rows)[field_name]
    return summary_filters


def _list_materialized_ticket_rows(
    *,
    snapshot_version: str,
    query: FullPictureDashboardQuery,
    search: str,
    sort_by: str,
    sort_order: str,
    page: int,
    page_size: int,
) -> tuple[int, int, list[dict[str, Any]]]:
    normalized_sort_by = MATERIALIZED_TICKET_SORT_COLUMNS.get(str(sort_by or "ticket_id").strip(), "ticket_id")
    normalized_sort_order = "DESC" if str(sort_order or "asc").strip().lower() == "desc" else "ASC"
    offset = (page - 1) * page_size

    hot_db_path = get_full_picture_hot_db_path()
    with connect(hot_db_path) as conn:
        _ensure_dashboard_ticket_store(conn)
        where_sql, params = _build_materialized_ticket_where_clause(
            query,
            snapshot_version=snapshot_version,
            search=search,
        )
        total_rows_row = conn.execute(
            f"SELECT COUNT(*) AS total_rows FROM dashboard_ticket_snapshot_rows WHERE {where_sql}",
            params,
        ).fetchone()
        total_rows = int(total_rows_row["total_rows"] or 0) if total_rows_row else 0
        total_pages = max((total_rows + page_size - 1) // page_size, 1)
        rows = conn.execute(
            f"""
            SELECT
                ticket_id,
                ticket_name,
                status,
                creation_time,
                ticket_date,
                ticket_month AS month,
                china_scope,
                problem_finder_team,
                classification,
                problem_severity,
                group_name AS "group",
                phase,
                requirement,
                requirements_json,
                is_resolved_forward,
                is_rejected_directly,
                year,
                project,
                assigned_ecu,
                aida,
                defect_category,
                solution_cluster,
                pu,
                market,
                lead_model
            FROM dashboard_ticket_snapshot_rows
            WHERE {where_sql}
            ORDER BY {normalized_sort_by} {normalized_sort_order}, ticket_id {normalized_sort_order}
            LIMIT ? OFFSET ?
            """,
            [*params, page_size, offset],
        ).fetchall()

    ticket_rows = [dict(row) for row in rows]
    for row in ticket_rows:
        row["requirement_names"] = _parse_string_list(row.get("requirements_json"))
    return total_rows, total_pages, ticket_rows


def _resolve_snapshot_version(snapshot_metadata: dict[str, object]) -> str:
    return str(snapshot_metadata.get("active_snapshot_version") or "").strip()


def _build_snapshot_bound_dataset(
    query: FullPictureDashboardQuery,
    *,
    requested_snapshot_version: str = "",
) -> tuple[dict[str, object], dict[str, Any], list[dict[str, Any]]]:
    snapshot_metadata_before = _read_snapshot_metadata()
    snapshot_version_before = _resolve_snapshot_version(snapshot_metadata_before)
    normalized_requested_version = str(requested_snapshot_version or "").strip()
    if (
        normalized_requested_version
        and snapshot_version_before
        and normalized_requested_version != snapshot_version_before
    ):
        raise FullPictureDashboardRequestError(
            f"Requested snapshot version is stale: {normalized_requested_version}"
        )

    generated_from, ticket_rows = _build_full_picture_dataset(query)

    snapshot_metadata_after = _read_snapshot_metadata()
    snapshot_version_after = _resolve_snapshot_version(snapshot_metadata_after)
    if snapshot_version_before != snapshot_version_after:
        raise FullPictureDashboardRequestError("Dashboard snapshot changed during request")
    if (
        normalized_requested_version
        and snapshot_version_after
        and normalized_requested_version != snapshot_version_after
    ):
        raise FullPictureDashboardRequestError(
            f"Requested snapshot version is stale: {normalized_requested_version}"
        )

    return snapshot_metadata_after, generated_from, ticket_rows


def _parse_positive_int(raw_value: Any, *, field_name: str, default: int) -> int:
    if raw_value in {None, ""}:
        return default
    try:
        parsed_value = int(str(raw_value).strip())
    except (TypeError, ValueError) as exc:
        raise FullPictureDashboardRequestError(
            f"Invalid {field_name}: {raw_value}"
        ) from exc
    if parsed_value <= 0:
        raise FullPictureDashboardRequestError(f"Invalid {field_name}: {raw_value}")
    return parsed_value


def _build_full_picture_dataset(
    query: FullPictureDashboardQuery,
    *,
    defect_db_path: Path | str | None = None,
    hot_db_path: Path | str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    defect_rows = _load_defect_rows(query, defect_db_path=defect_db_path)
    defect_ids = tuple(
        str(row.get("ticket_id") or "").strip()
        for row in defect_rows
        if str(row.get("ticket_id") or "").strip()
    )
    resolved_hot_db_path = Path(hot_db_path).resolve() if hot_db_path is not None else get_full_picture_hot_db_path()
    outcome_index = _load_hot_outcomes(defect_ids, hot_db_path=resolved_hot_db_path)
    ticket_rows = _build_ticket_rows(defect_rows, outcome_index)
    if query.months:
        allowed_months = set(query.months)
        ticket_rows = [row for row in ticket_rows if str(row.get("month") or "") in allowed_months]
    if query.creation_time_start or query.creation_time_end:
        ticket_rows = [
            row
            for row in ticket_rows
            if _matches_creation_time_range(
                row.get("creation_time"),
                creation_time_start=query.creation_time_start,
                creation_time_end=query.creation_time_end,
            )
        ]
    if query.china_scopes:
        allowed_scopes = set(query.china_scopes)
        ticket_rows = [row for row in ticket_rows if str(row.get("china_scope") or "") in allowed_scopes]
    ticket_rows = _apply_group_filter(ticket_rows, query.groups)
    generated_from = {
        "defect_db_path": str(Path(defect_db_path).resolve() if defect_db_path is not None else (_resolve_defect_db_path() or "")),
        "outcome_db_path": str(resolved_hot_db_path),
        "history_db_path": str(_resolve_history_db_path() or ""),
        **_serialize_query_filters(query),
    }
    return generated_from, ticket_rows


def build_full_picture_summary_payload(**kwargs: Any) -> dict[str, Any]:
    query = normalize_query(**kwargs)
    snapshot_metadata = _read_snapshot_metadata()
    snapshot_version = _resolve_effective_snapshot_version(snapshot_metadata)
    cache_key = normalize_summary_cache_key(
        snapshot_version=snapshot_version,
        filters=_serialize_query_filters(query),
    )
    cached_payload = get_summary_cache().get(cache_key)
    if cached_payload is not None:
        return cached_payload

    if snapshot_version:
        if snapshot_version.startswith("live-"):
            _materialize_snapshot_ticket_rows(snapshot_version)
        snapshot_metadata = _read_snapshot_metadata()
        if _resolve_effective_snapshot_version(snapshot_metadata) != snapshot_version:
            raise FullPictureDashboardRequestError("Dashboard snapshot changed during request")
        generated_from = _build_generated_from_payload(query)
        ticket_rows = _load_materialized_ticket_rows(
            snapshot_version=snapshot_version,
            query=query,
        )
    else:
        snapshot_metadata, generated_from, ticket_rows = _build_snapshot_bound_dataset(
            query,
            requested_snapshot_version=snapshot_version,
        )

    payload = {
        "snapshot_version": snapshot_version,
        "generated_from": generated_from,
        "refresh_metadata": snapshot_metadata,
        "filters": _build_summary_filters(
            query,
            snapshot_version=snapshot_version,
            filtered_ticket_rows=ticket_rows,
        ),
        "overview": _build_overview(ticket_rows),
        "outcome_summary": _build_outcome_summary(ticket_rows),
        "team_outcome_rows": _build_team_outcome_rows(ticket_rows),
    }
    get_summary_cache()[cache_key] = payload
    return payload


def _search_ticket_rows(ticket_rows: list[dict[str, Any]], search: str) -> list[dict[str, Any]]:
    search_value = str(search or "").strip().casefold()
    if not search_value:
        return ticket_rows
    return [
        row
        for row in ticket_rows
        if search_value in " ".join(
            [
                str(row.get("ticket_id") or ""),
                str(row.get("ticket_name") or ""),
                str(row.get("creation_time") or ""),
                str(row.get("problem_finder_team") or ""),
                str(row.get("classification") or ""),
                str(row.get("problem_severity") or ""),
                str(row.get("status") or ""),
                str(row.get("phase") or ""),
                str(row.get("requirement") or ""),
                str(row.get("group") or ""),
                str(row.get("project") or ""),
            ]
        ).casefold()
    ]


def _is_top_topic_ticket_row(row: dict[str, Any]) -> bool:
    requirement_names = [str(name or "").strip().casefold() for name in row.get("requirement_names") or []]
    if "top topic" in requirement_names:
        return True
    return "top topic" in str(row.get("requirement") or "").casefold()


def _build_top_topic_priority_query(query: FullPictureDashboardQuery) -> FullPictureDashboardQuery:
    return replace(
        query,
        creation_time_start="",
        creation_time_end="",
        china_scopes=(),
        problem_finder_teams=(),
    )


def _filter_priority_rows(
    candidate_rows: list[dict[str, Any]],
    *,
    search: str,
    sort_by: str,
    sort_order: str,
    excluded_ticket_ids: set[str],
) -> list[dict[str, Any]]:
    priority_rows = [row for row in candidate_rows if _is_top_topic_ticket_row(row)]
    priority_rows = _search_ticket_rows(priority_rows, search)
    priority_rows = _sort_ticket_rows(
        priority_rows,
        sort_by=sort_by,
        sort_order=sort_order,
    )
    return [
        row
        for row in priority_rows
        if str(row.get("ticket_id") or "").strip() not in excluded_ticket_ids
    ]


def _sort_ticket_rows(
    ticket_rows: list[dict[str, Any]],
    *,
    sort_by: str,
    sort_order: str,
) -> list[dict[str, Any]]:
    normalized_sort_by = str(sort_by or "ticket_id").strip() or "ticket_id"
    reverse = str(sort_order or "asc").strip().lower() == "desc"
    return sorted(
        ticket_rows,
        key=lambda row: (_sortable_value(row.get(normalized_sort_by)), _sortable_value(row.get("ticket_id"))),
        reverse=reverse,
    )


def list_full_picture_ticket_rows(**kwargs: Any) -> dict[str, Any]:
    query = normalize_query(**kwargs)
    requested_snapshot_version = str(kwargs.get("snapshot_version") or "").strip()
    search = str(kwargs.get("search") or "")
    sort_by = str(kwargs.get("sort_by") or "ticket_id")
    sort_order = str(kwargs.get("sort_order") or "asc")
    snapshot_metadata = _read_snapshot_metadata()
    snapshot_version = _resolve_effective_snapshot_version(snapshot_metadata)
    if requested_snapshot_version and snapshot_version and requested_snapshot_version != snapshot_version:
        raise FullPictureDashboardRequestError(
            f"Requested snapshot version is stale: {requested_snapshot_version}"
        )

    page = _parse_positive_int(kwargs.get("page"), field_name="page", default=1)
    page_size = min(
        _parse_positive_int(kwargs.get("page_size"), field_name="page_size", default=50),
        200,
    )
    priority_rows: list[dict[str, Any]] = []

    if snapshot_version:
        if snapshot_version.startswith("live-"):
            _materialize_snapshot_ticket_rows(snapshot_version)
        snapshot_metadata = _read_snapshot_metadata()
        snapshot_version_after = _resolve_effective_snapshot_version(snapshot_metadata)
        if snapshot_version_after != snapshot_version:
            raise FullPictureDashboardRequestError("Dashboard snapshot changed during request")
        if requested_snapshot_version and snapshot_version_after and requested_snapshot_version != snapshot_version_after:
            raise FullPictureDashboardRequestError(
                f"Requested snapshot version is stale: {requested_snapshot_version}"
            )

        total_rows, total_pages, rows = _list_materialized_ticket_rows(
            snapshot_version=snapshot_version_after,
            query=query,
            search=search,
            sort_by=sort_by,
            sort_order=sort_order,
            page=page,
            page_size=page_size,
        )
        generated_from = _build_generated_from_payload(query)
        if page == 1:
            relaxed_query = _build_top_topic_priority_query(query)
            candidate_priority_rows = _load_materialized_ticket_rows(
                snapshot_version=snapshot_version_after,
                query=relaxed_query,
            )
            priority_rows = _filter_priority_rows(
                candidate_priority_rows,
                search=search,
                sort_by=sort_by,
                sort_order=sort_order,
                excluded_ticket_ids={str(row.get("ticket_id") or "").strip() for row in rows},
            )
    else:
        snapshot_metadata, generated_from, ticket_rows = _build_snapshot_bound_dataset(
            query,
            requested_snapshot_version=requested_snapshot_version,
        )
        searched_rows = _search_ticket_rows(ticket_rows, search)
        sorted_rows = _sort_ticket_rows(
            searched_rows,
            sort_by=sort_by,
            sort_order=sort_order,
        )
        total_rows = len(sorted_rows)
        total_pages = max((total_rows + page_size - 1) // page_size, 1)
        start_index = (page - 1) * page_size
        end_index = start_index + page_size
        rows = sorted_rows[start_index:end_index]
        if page == 1:
            relaxed_query = _build_top_topic_priority_query(query)
            _priority_snapshot_metadata, _priority_generated_from, priority_ticket_rows = _build_snapshot_bound_dataset(
                relaxed_query,
                requested_snapshot_version=requested_snapshot_version,
            )
            priority_rows = _filter_priority_rows(
                priority_ticket_rows,
                search=search,
                sort_by=sort_by,
                sort_order=sort_order,
                excluded_ticket_ids={str(row.get("ticket_id") or "").strip() for row in rows},
            )

    return {
        "snapshot_version": snapshot_version if snapshot_version else _resolve_snapshot_version(snapshot_metadata),
        "generated_from": generated_from,
        "refresh_metadata": snapshot_metadata,
        "page": page,
        "page_size": page_size,
        "total_rows": total_rows,
        "total_pages": total_pages,
        "rows": rows,
        "priority_rows": priority_rows,
    }


def _is_closed_top_issue_row(row: dict[str, Any]) -> bool:
    phase_code = _extract_phase_code(row.get("phase") or row.get("status"))
    return phase_code in {"06", "08", "09"}


def _build_top_issue_status_distribution(ticket_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for row in ticket_rows:
        status = str(row.get("status") or "Unknown").strip() or "Unknown"
        counts[status] = counts.get(status, 0) + 1
    return [
        {"status": status, "count": count}
        for status, count in sorted(counts.items(), key=lambda item: (-item[1], _sortable_value(item[0])))
    ]


def _build_top_issue_defect_trend(ticket_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, int]] = {}
    for row in ticket_rows:
        month = str(row.get("month") or _get_ticket_month_value(row.get("creation_time")) or "").strip()
        if not month:
            continue
        state = grouped.setdefault(month, {"new_count": 0, "closed_count": 0, "in_progress_count": 0})
        state["new_count"] += 1
        if _is_closed_top_issue_row(row):
            state["closed_count"] += 1
        else:
            state["in_progress_count"] += 1
    return [
        {"month": month, **state}
        for month, state in sorted(grouped.items(), key=lambda item: item[0])
    ]


def _build_top_issue_rows(ticket_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    severity_order = {"showstopper": 0, "critical": 1, "major": 2}

    rows = [
        {
            "ticket_id": str(row.get("ticket_id") or ""),
            "ticket_name": str(row.get("ticket_name") or ""),
            "severity": str(row.get("problem_severity") or ""),
            "project": str(row.get("project") or ""),
            "status": str(row.get("status") or ""),
            "age_days": _calculate_age_days(row.get("creation_time"), row.get("ticket_date")),
            "creation_time": str(row.get("creation_time") or ""),
            "ticket_date": str(row.get("ticket_date") or ""),
            "classification": str(row.get("classification") or ""),
        }
        for row in ticket_rows
    ]
    rows.sort(
        key=lambda row: (
            severity_order.get(str(row.get("severity") or "").strip().casefold(), len(severity_order)),
            -int(row.get("age_days") or 0),
            _sortable_value(row.get("ticket_id")),
        )
    )
    return rows[:100]


def build_top_issue_analysis_payload(**kwargs: Any) -> dict[str, Any]:
    query = normalize_query(**kwargs)
    requested_snapshot_version = str(kwargs.get("snapshot_version") or "").strip()
    snapshot_metadata = _read_snapshot_metadata()
    snapshot_version = _resolve_effective_snapshot_version(snapshot_metadata)
    if requested_snapshot_version and snapshot_version and requested_snapshot_version != snapshot_version:
        raise FullPictureDashboardRequestError(
            f"Requested snapshot version is stale: {requested_snapshot_version}"
        )

    if snapshot_version:
        if snapshot_version.startswith("live-"):
            _materialize_snapshot_ticket_rows(snapshot_version)
        snapshot_metadata = _read_snapshot_metadata()
        snapshot_version_after = _resolve_effective_snapshot_version(snapshot_metadata)
        if snapshot_version_after != snapshot_version:
            raise FullPictureDashboardRequestError("Dashboard snapshot changed during request")
        if requested_snapshot_version and snapshot_version_after and requested_snapshot_version != snapshot_version_after:
            raise FullPictureDashboardRequestError(
                f"Requested snapshot version is stale: {requested_snapshot_version}"
            )
        generated_from = _build_generated_from_payload(query)
        ticket_rows = _load_materialized_ticket_rows(
            snapshot_version=snapshot_version_after,
            query=query,
        )
        response_snapshot_version = snapshot_version_after
    else:
        snapshot_metadata, generated_from, ticket_rows = _build_snapshot_bound_dataset(
            query,
            requested_snapshot_version=requested_snapshot_version,
        )
        response_snapshot_version = _resolve_snapshot_version(snapshot_metadata)

    return {
        "snapshot_version": response_snapshot_version,
        "generated_from": generated_from,
        "refresh_metadata": snapshot_metadata,
        "top_issue_rows": _build_top_issue_rows(ticket_rows),
        "status_distribution": _build_top_issue_status_distribution(ticket_rows),
        "defect_trend": _build_top_issue_defect_trend(ticket_rows),
    }


def build_full_picture_payload(**kwargs: Any) -> dict[str, Any]:
    query = normalize_query(**kwargs)
    generated_from, ticket_rows = _build_full_picture_dataset(query)

    return {
        "generated_from": generated_from,
        "filters": _build_filters(ticket_rows),
        "overview": _build_overview(ticket_rows),
        "outcome_summary": _build_outcome_summary(ticket_rows),
        "team_outcome_rows": _build_team_outcome_rows(ticket_rows),
        "ticket_rows": ticket_rows,
    }


def _connect() -> sqlite3.Connection:
    configured = str(os.environ.get("VIZION_ANALYTICS_DB_PATH", "")).strip()
    if configured:
        return connect(get_analytics_db_path())
    return connect(get_full_picture_source_db_path())


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        str(row["name"]).strip()
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def build_testing_summary() -> dict[str, int]:
    conn = _connect()
    try:
        total_runs = conn.execute("SELECT COUNT(*) FROM octane_manual_runs").fetchone()[0]
        total_testcases = conn.execute("SELECT COUNT(*) FROM octane_testcases").fetchone()[0]
    finally:
        conn.close()
    return {"total_runs": total_runs, "total_testcases": total_testcases}


def list_testcases() -> list[dict[str, object]]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT test_id, test_name, run_count, defect_ids_json, feature_ids_json, story_ids_json FROM octane_testcases ORDER BY test_id"
        ).fetchall()
    finally:
        conn.close()

    return [
        {
            "test_id": row["test_id"],
            "test_name": row["test_name"],
            "run_count": row["run_count"],
            "defect_ids": json.loads(row["defect_ids_json"]),
            "feature_ids": json.loads(row["feature_ids_json"]),
            "story_ids": json.loads(row["story_ids_json"]),
        }
        for row in rows
    ]


def list_runs() -> list[dict[str, object]]:
    conn = _connect()
    try:
        manual_run_columns = _table_columns(conn, "octane_manual_runs")
        if {"project", "team"}.issubset(manual_run_columns):
            rows = conn.execute(
                "SELECT mr_id, defect_id, test_id, test_name, status, project, team FROM octane_manual_runs ORDER BY mr_id"
            ).fetchall()
        elif _table_exists(conn, "octane_defects"):
            rows = conn.execute(
                '''
                SELECT
                    mr.mr_id,
                    mr.defect_id,
                    mr.test_id,
                    TRIM(COALESCE(CAST(mr.test_name AS TEXT), CAST(mr.name AS TEXT), '')) AS test_name,
                    TRIM(COALESCE(CAST(mr.status AS TEXT), '')) AS status,
                    TRIM(COALESCE(CAST(d.project AS TEXT), '')) AS project,
                    TRIM(COALESCE(CAST(d.team AS TEXT), '')) AS team
                FROM octane_manual_runs mr
                LEFT JOIN octane_defects d
                    ON CAST(d.defect_id AS TEXT) = CAST(mr.defect_id AS TEXT)
                ORDER BY mr.mr_id
                '''
            ).fetchall()
        else:
            rows = conn.execute(
                '''
                SELECT
                    mr_id,
                    defect_id,
                    test_id,
                    TRIM(COALESCE(CAST(test_name AS TEXT), CAST(name AS TEXT), '')) AS test_name,
                    TRIM(COALESCE(CAST(status AS TEXT), '')) AS status,
                    '' AS project,
                    '' AS team
                FROM octane_manual_runs
                ORDER BY mr_id
                '''
            ).fetchall()
    finally:
        conn.close()

    return [dict(row) for row in rows]


def build_filter_metadata() -> dict[str, list[str]]:
    conn = _connect()
    try:
        defects = conn.execute(
            "SELECT DISTINCT project, market, pu, fv, fvp, team, lead_model FROM octane_defects"
        ).fetchall()
    finally:
        conn.close()

    return {
        "projects": sorted({row["project"] for row in defects if row["project"]}),
        "markets": sorted({row["market"] for row in defects if row["market"]}),
        "pus": sorted({row["pu"] for row in defects if row["pu"]}),
        "fvs": sorted({row["fv"] for row in defects if row["fv"]}),
        "fvps": sorted({row["fvp"] for row in defects if row["fvp"]}),
        "teams": sorted({row["team"] for row in defects if row["team"]}),
        "lead_models": sorted({row["lead_model"] for row in defects if row["lead_model"]}),
    }


def build_defect_test_correlation(defect_id: str) -> dict[str, object]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT test_id, defect_ids_json FROM octane_testcases ORDER BY test_id"
        ).fetchall()
    finally:
        conn.close()

    test_ids = []
    for row in rows:
        defect_ids = json.loads(row["defect_ids_json"])
        if defect_id in defect_ids:
            test_ids.append(row["test_id"])

    return {"defect_id": defect_id, "test_ids": test_ids}