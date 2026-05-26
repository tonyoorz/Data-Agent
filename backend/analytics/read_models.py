from __future__ import annotations

from dataclasses import dataclass
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
)
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
        "raw_event_json",
        "fetched_at",
    }
)
DEFAULT_YEARS = ("2026",)
GROUP_ORDER = ("Q-Gate", "Integration", "CoC", "Other")
OUTCOME_SERIES = (
    ("resolved_forward", "Resolved Forward (08 -> 06)", "is_resolved_forward"),
    ("rejected_directly", "Rejected Directly (01 -> 09)", "is_rejected_directly"),
)


class FullPictureDashboardDataError(ValueError):
    pass


@dataclass(frozen=True)
class FullPictureDashboardQuery:
    years: tuple[str, ...] = DEFAULT_YEARS
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
        LOCAL_ANALYTICS_HISTORY_EVENT_COLUMNS,
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


def _load_defect_rows(query: FullPictureDashboardQuery) -> list[dict[str, Any]]:
    db_path = _require_database_path(_resolve_defect_db_path(), "defect")
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

    raw_json_expr = optional_text_expr("raw_json") if "raw_json" in available_columns else "''"

    sql = f"""
        SELECT
            CAST(defect_id AS TEXT) AS ticket_id,
            {optional_text_expr('name')} AS ticket_name,
            {optional_text_expr('status_phase')} AS status,
            {optional_text_expr('problem_finder_team')} AS problem_finder_team,
            {ticket_date_expr} AS ticket_date,
            {optional_text_expr('year', cast_text=True)} AS year,
            {optional_text_expr('project')} AS project,
            {optional_text_expr('assigned_ecu')} AS assigned_ecu,
            {aida_expr} AS aida,
            {optional_text_expr('phase')} AS phase,
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
    for row in rows:
        normalized = dict(row)
        raw_payload = _safe_json_object(normalized.get("raw_json"))
        normalized["defect_category"] = _first_non_empty(
            normalized.get("defect_category"),
            raw_payload.get("defect_category"),
            raw_payload.get("defectCategory"),
            _extract_reference_name(raw_payload.get("problem_category_udf")),
        )
        normalized_rows.append(normalized)
    return normalized_rows


def _load_history_events(defect_ids: tuple[str, ...]) -> list[dict[str, Any]]:
    if not defect_ids:
        return []

    db_path = _require_database_path(_resolve_history_db_path(), "history")
    available_columns_lower = {column.lower() for column in _get_table_columns(db_path, "octane_defect_history_events")}

    if LOCAL_ANALYTICS_HISTORY_EVENT_COLUMNS.issubset(available_columns_lower) and not REQUIRED_HISTORY_EVENT_COLUMNS.issubset(available_columns_lower):
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
                            COALESCE(old_value, '') AS old_value,
                            COALESCE(new_value, '') AS new_value,
                            COALESCE(raw_event_json, '') AS raw_event_json
                        FROM octane_defect_history_events
                        WHERE CAST(defect_id AS TEXT) IN ({placeholders})
                          AND LOWER(COALESCE(field_name, '')) LIKE '%phase%'
                    """
                    for row in conn.execute(sql, list(chunk)).fetchall():
                        raw_event = _safe_json_object(row["raw_event_json"])
                        rows.append(
                            {
                                "ticket_id": row["ticket_id"],
                                "event_timestamp": row["event_timestamp"],
                                "entry_index": 0,
                                "change_index": 0,
                                "old_value": row["old_value"],
                                "new_value": row["new_value"],
                                "old_value_text": _first_non_empty(raw_event.get("old_value_text"), row["old_value"]),
                                "new_value_text": _first_non_empty(raw_event.get("new_value_text"), row["new_value"]),
                            }
                        )
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


def _load_hot_outcomes(defect_ids: tuple[str, ...]) -> dict[str, dict[str, Any]]:
    hot_db_path = get_full_picture_hot_db_path()
    try:
        return load_materialized_outcomes(hot_db_path, defect_ids)
    except FileNotFoundError as exc:
        raise FullPictureDashboardDataError(
            f"Full Picture hot outcomes are not available from {hot_db_path}"
        ) from exc
    except sqlite3.DatabaseError as exc:
        raise FullPictureDashboardDataError(
            f"Full Picture hot outcomes are not available from {hot_db_path}: {exc}"
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
        ticket_row = {
            "ticket_id": ticket_id,
            "ticket_name": str(row.get("ticket_name") or "").strip(),
            "status": str(row.get("status") or row.get("phase") or "").strip(),
            "problem_finder_team": str(row.get("problem_finder_team") or "").strip(),
            "group": group,
            "phase": phase,
            "is_resolved_forward": bool(outcome_state["is_resolved_forward"]),
            "is_rejected_directly": bool(outcome_state["is_rejected_directly"]),
            "year": str(row.get("year") or "").strip(),
            "project": str(row.get("project") or "").strip(),
            "assigned_ecu": str(row.get("assigned_ecu") or "").strip(),
            "aida": str(row.get("aida") or "").strip(),
            "defect_category": str(row.get("defect_category") or "").strip(),
            "solution_cluster": str(row.get("solution_cluster") or "").strip(),
            "pu": str(row.get("pu") or "").strip(),
            "market": str(row.get("market") or "").strip(),
            "lead_model": str(row.get("lead_model") or "").strip(),
        }
        ticket_date = str(row.get("ticket_date") or "").strip()
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


def _build_filters(ticket_rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    return {
        "years": _unique_sorted(row.get("year") for row in ticket_rows),
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


def build_full_picture_payload(**kwargs: Any) -> dict[str, Any]:
    query = normalize_query(**kwargs)
    defect_rows = _load_defect_rows(query)
    defect_ids = tuple(
        str(row.get("ticket_id") or "").strip()
        for row in defect_rows
        if str(row.get("ticket_id") or "").strip()
    )
    outcome_index = _load_hot_outcomes(defect_ids)
    ticket_rows = _build_ticket_rows(defect_rows, outcome_index)
    ticket_rows = _apply_group_filter(ticket_rows, query.groups)

    return {
        "generated_from": {
            "defect_db_path": str(_resolve_defect_db_path() or ""),
            "outcome_db_path": str(get_full_picture_hot_db_path()),
            "history_db_path": str(_resolve_history_db_path() or ""),
            "years": list(query.years),
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
        },
        "filters": _build_filters(ticket_rows),
        "overview": _build_overview(ticket_rows),
        "outcome_summary": _build_outcome_summary(ticket_rows),
        "team_outcome_rows": _build_team_outcome_rows(ticket_rows),
        "ticket_rows": ticket_rows,
    }


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(get_analytics_db_path())
    conn.row_factory = sqlite3.Row
    return conn


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
        rows = conn.execute(
            "SELECT mr_id, defect_id, test_id, test_name, status, project, team FROM octane_manual_runs ORDER BY mr_id"
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