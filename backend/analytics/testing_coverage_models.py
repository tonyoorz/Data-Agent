from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import sqlite3

from backend.analytics.config import get_analytics_db_path


REQUIRED_COVERAGE_FIELDS: tuple[str, ...] = (
    "year",
    "test_week",
    "project",
    "pu",
    "top_aida",
    "feature_region",
    "fvp",
    "fv",
    "status",
    "test_id",
    "test_name",
    "tester",
)

FILTER_COLUMN_MAP: dict[str, str] = {
    "years": "year",
    "projects": "project",
    "test_weeks": "test_week",
    "pus": "pu",
    "aidas": "top_aida",
    "statuses": "status",
    "feature_regions": "feature_region",
    "fvps": "fvp",
    "fvs": "fv",
}


class TestingCoverageDataNotReadyError(ValueError):
    def __init__(self, missing_fields: list[str]):
        super().__init__("testing coverage analysis data not ready")
        self.missing_fields = missing_fields


@dataclass(frozen=True)
class TestingCoverageQuery:
    years: tuple[str, ...] = ()
    projects: tuple[str, ...] = ()
    test_weeks: tuple[str, ...] = ()
    pus: tuple[str, ...] = ()
    aidas: tuple[str, ...] = ()
    statuses: tuple[str, ...] = ()
    feature_regions: tuple[str, ...] = ()
    fvps: tuple[str, ...] = ()
    fvs: tuple[str, ...] = ()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(get_analytics_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def _normalize_multi_value(raw_values: Any, *, split_commas: bool) -> tuple[str, ...]:
    if raw_values is None:
        return ()

    if isinstance(raw_values, str):
        items = [raw_values]
    else:
        items = list(raw_values)

    normalized: list[str] = []
    seen: set[str] = set()
    for item in items:
        parts = str(item).split(",") if split_commas else [str(item)]
        for part in parts:
            value = part.strip()
            if not value or value in seen:
                continue
            seen.add(value)
            normalized.append(value)
    return tuple(normalized)


def _get_multi_values(query_params: Any, key: str) -> tuple[str, ...]:
    if hasattr(query_params, "getlist"):
        return _normalize_multi_value(query_params.getlist(key), split_commas=False)
    return _normalize_multi_value(query_params.get(key), split_commas=True)


def normalize_query(query_params: Any) -> TestingCoverageQuery:
    return TestingCoverageQuery(
        years=_get_multi_values(query_params, "years"),
        projects=_get_multi_values(query_params, "projects"),
        test_weeks=_get_multi_values(query_params, "test_weeks"),
        pus=_get_multi_values(query_params, "pus"),
        aidas=_get_multi_values(query_params, "aidas"),
        statuses=_get_multi_values(query_params, "statuses"),
        feature_regions=_get_multi_values(query_params, "feature_regions"),
        fvps=_get_multi_values(query_params, "fvps"),
        fvs=_get_multi_values(query_params, "fvs"),
    )


def _sortable_value(value: Any) -> tuple[int, Any]:
    text = str(value or "").strip()
    if text.isdigit():
        return (0, int(text))
    return (1, text.casefold())


def _table_columns(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row["name"]).strip()
        for row in conn.execute("PRAGMA table_info(octane_manual_runs)").fetchall()
    }


def _manual_runs_table_exists(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='octane_manual_runs'"
    ).fetchone()
    return row is not None


def _has_non_blank_values(conn: sqlite3.Connection, column_name: str) -> bool:
    row = conn.execute(
        f'''
        SELECT 1
        FROM octane_manual_runs
        WHERE TRIM(COALESCE(CAST("{column_name}" AS TEXT), '')) <> ''
        LIMIT 1
        '''
    ).fetchone()
    return row is not None


def _ensure_coverage_data_ready(conn: sqlite3.Connection) -> None:
    if not _manual_runs_table_exists(conn):
        raise TestingCoverageDataNotReadyError(list(REQUIRED_COVERAGE_FIELDS))

    total_rows = conn.execute("SELECT COUNT(*) FROM octane_manual_runs").fetchone()[0]
    if total_rows == 0:
        raise TestingCoverageDataNotReadyError(list(REQUIRED_COVERAGE_FIELDS))

    columns = _table_columns(conn)
    missing_fields = [
        field
        for field in REQUIRED_COVERAGE_FIELDS
        if field not in columns or not _has_non_blank_values(conn, field)
    ]
    if missing_fields:
        raise TestingCoverageDataNotReadyError(missing_fields)


def _build_where_clause(query: TestingCoverageQuery) -> tuple[str, list[str]]:
    where_clauses = ["1=1"]
    params: list[str] = []
    for filter_name, column_name in FILTER_COLUMN_MAP.items():
        values = getattr(query, filter_name)
        if not values:
            continue
        placeholders = ", ".join("?" for _ in values)
        where_clauses.append(
            f'TRIM(COALESCE(CAST("{column_name}" AS TEXT), "")) IN ({placeholders})'
        )
        params.extend(values)
    return " AND ".join(where_clauses), params


def _list_distinct_values(
    conn: sqlite3.Connection,
    column_name: str,
    where_clause: str,
    params: list[str],
) -> list[str]:
    rows = conn.execute(
        f'''
        SELECT DISTINCT TRIM(COALESCE(CAST("{column_name}" AS TEXT), '')) AS value
        FROM octane_manual_runs
        WHERE {where_clause}
          AND TRIM(COALESCE(CAST("{column_name}" AS TEXT), '')) <> ''
        ''',
        params,
    ).fetchall()
    return sorted((str(row["value"]) for row in rows), key=_sortable_value)


def build_testing_coverage_filters(query_params: Any) -> dict[str, list[str]]:
    query = normalize_query(query_params)
    conn = _connect()
    try:
        _ensure_coverage_data_ready(conn)
        where_clause, params = _build_where_clause(query)
        return {
            filter_name: _list_distinct_values(conn, column_name, where_clause, params)
            for filter_name, column_name in FILTER_COLUMN_MAP.items()
        }
    finally:
        conn.close()


def _fetch_grouped_rows(
    query_params: Any,
    select_columns: tuple[str, ...],
    order_columns: tuple[str, ...],
) -> list[dict[str, object]]:
    query = normalize_query(query_params)
    conn = _connect()
    try:
        _ensure_coverage_data_ready(conn)
        where_clause, params = _build_where_clause(query)
        normalized_columns = tuple(
            f'TRIM(COALESCE(CAST("{column}" AS TEXT), ""))'
            for column in select_columns
        )
        select_sql = ",\n            ".join(
            f"{expression} AS {column}"
            for column, expression in zip(select_columns, normalized_columns, strict=True)
        )
        group_by_sql = ", ".join(normalized_columns)
        order_by_sql = ", ".join(f'{column} COLLATE NOCASE' for column in order_columns)
        rows = conn.execute(
            f'''
            SELECT
                {select_sql},
                COUNT(*) AS count
            FROM octane_manual_runs
            WHERE {where_clause}
            GROUP BY {group_by_sql}
            ORDER BY {order_by_sql}
            ''',
            params,
        ).fetchall()
    finally:
        conn.close()

    return [dict(row) for row in rows]


def build_project_status_rows(query_params: Any) -> list[dict[str, object]]:
    return _fetch_grouped_rows(
        query_params,
        select_columns=("test_week", "fv", "fvp", "status"),
        order_columns=("test_week", "fv", "fvp", "status"),
    )


def build_aida_status_rows(query_params: Any) -> list[dict[str, object]]:
    return _fetch_grouped_rows(
        query_params,
        select_columns=("test_week", "top_aida", "status"),
        order_columns=("test_week", "top_aida", "status"),
    )


def build_testcase_detail_rows(query_params: Any) -> list[dict[str, object]]:
    return _fetch_grouped_rows(
        query_params,
        select_columns=(
            "test_id",
            "test_name",
            "test_week",
            "status",
            "top_aida",
            "project",
            "pu",
            "tester",
        ),
        order_columns=(
            "test_id",
            "test_name",
            "test_week",
            "status",
            "top_aida",
            "project",
            "pu",
            "tester",
        ),
    )