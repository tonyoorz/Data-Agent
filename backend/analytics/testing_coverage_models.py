from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
from typing import Any

import sqlite3

from backend.analytics.config import (
    get_analytics_db_path,
    get_full_picture_hot_db_path,
)
from backend.analytics.db import connect
from backend.analytics.testing_coverage_reference import (
    build_feature_region_sql_expr,
    build_iso_test_week_sql_expr,
    build_tpmdashboard_project_sql_expr,
)


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

HOT_TESTING_STORE_NAME = "testing_coverage_runs"
HOT_TESTING_SNAPSHOT_STATE_TABLE = "testing_coverage_snapshot_state"
HOT_TESTING_SNAPSHOT_POINTER_TABLE = "testing_coverage_snapshot_pointer"
TEMP_TESTING_RUNS_NAME = "temp_testing_coverage_runs"


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


def _resolve_testing_db_path() -> Path:
    configured = str(os.environ.get("VIZION_ANALYTICS_DB_PATH", "")).strip()
    if configured:
        return get_analytics_db_path()
    return get_full_picture_hot_db_path()


def _connect() -> sqlite3.Connection:
    return connect(_resolve_testing_db_path())


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


def _table_columns(conn: sqlite3.Connection, table_name: str = "octane_manual_runs") -> set[str]:
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


def _is_ready_hot_testing_db(db_path: Path) -> bool:
    if not db_path.exists() or not db_path.is_file():
        return False

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        if not _table_exists(conn, HOT_TESTING_STORE_NAME):
            return False
        if not _table_exists(conn, HOT_TESTING_SNAPSHOT_STATE_TABLE):
            return False
        if not _table_exists(conn, HOT_TESTING_SNAPSHOT_POINTER_TABLE):
            return False
        pointer_row = conn.execute(
            """
            SELECT snapshot_version
            FROM testing_coverage_snapshot_pointer
            WHERE pointer_name = 'active'
            LIMIT 1
            """,
        ).fetchone()
        if pointer_row is None:
            return False
        snapshot_version = str(pointer_row[0] or "").strip()
        if not snapshot_version:
            return False
        state_row = conn.execute(
            f"""
            SELECT row_count, refresh_status
            FROM {HOT_TESTING_SNAPSHOT_STATE_TABLE}
            WHERE snapshot_version = ?
            LIMIT 1
            """,
            (snapshot_version,),
        ).fetchone()
        if state_row is None:
            return False
        row_count = int(state_row[0] or 0)
        refresh_status = str(state_row[1] or "").strip()
        return refresh_status == "ready" and row_count > 0
    except sqlite3.Error:
        return False
    finally:
        conn.close()


def _resolve_active_testing_snapshot_version(conn: sqlite3.Connection) -> str:
    if not _table_exists(conn, HOT_TESTING_STORE_NAME):
        return ""
    if not _table_exists(conn, HOT_TESTING_SNAPSHOT_STATE_TABLE):
        return ""
    if not _table_exists(conn, HOT_TESTING_SNAPSHOT_POINTER_TABLE):
        return ""

    pointer_row = conn.execute(
        f"SELECT snapshot_version FROM {HOT_TESTING_SNAPSHOT_POINTER_TABLE} WHERE pointer_name = 'active'"
    ).fetchone()
    if pointer_row is None:
        return ""
    snapshot_version = str(pointer_row[0] or "").strip()
    if not snapshot_version:
        return ""

    state_row = conn.execute(
        f"""
        SELECT row_count, refresh_status
        FROM {HOT_TESTING_SNAPSHOT_STATE_TABLE}
        WHERE snapshot_version = ?
        LIMIT 1
        """,
        (snapshot_version,),
    ).fetchone()
    if state_row is None:
        return ""
    row_count = int(state_row[0] or 0)
    refresh_status = str(state_row[1] or "").strip()
    if refresh_status != "ready" or row_count <= 0:
        return ""
    return snapshot_version


def _manual_runs_table_exists(conn: sqlite3.Connection) -> bool:
    return _table_exists(conn, "octane_manual_runs")


def _legacy_testing_dataset_query() -> str:
    return '''
        SELECT
            TRIM(COALESCE(CAST("year" AS TEXT), '')) AS year,
            TRIM(COALESCE(CAST("test_week" AS TEXT), '')) AS test_week,
            TRIM(COALESCE(CAST("project" AS TEXT), '')) AS project,
            TRIM(COALESCE(CAST("pu" AS TEXT), '')) AS pu,
            TRIM(COALESCE(CAST("top_aida" AS TEXT), '')) AS top_aida,
            TRIM(COALESCE(CAST("feature_region" AS TEXT), '')) AS feature_region,
            TRIM(COALESCE(CAST("fvp" AS TEXT), '')) AS fvp,
            TRIM(COALESCE(CAST("fv" AS TEXT), '')) AS fv,
            TRIM(COALESCE(CAST("status" AS TEXT), '')) AS status,
            TRIM(COALESCE(CAST("test_id" AS TEXT), '')) AS test_id,
            TRIM(COALESCE(CAST("test_name" AS TEXT), '')) AS test_name,
            TRIM(COALESCE(CAST("tester" AS TEXT), '')) AS tester
        FROM octane_manual_runs
    '''


def _hot_testing_dataset_query() -> str:
    return f'''
        SELECT
            TRIM(COALESCE(CAST("year" AS TEXT), '')) AS year,
            TRIM(COALESCE(CAST("test_week" AS TEXT), '')) AS test_week,
            TRIM(COALESCE(CAST("project" AS TEXT), '')) AS project,
            TRIM(COALESCE(CAST("pu" AS TEXT), '')) AS pu,
            TRIM(COALESCE(CAST("top_aida" AS TEXT), '')) AS top_aida,
            TRIM(COALESCE(CAST("feature_region" AS TEXT), '')) AS feature_region,
            TRIM(COALESCE(CAST("fvp" AS TEXT), '')) AS fvp,
            TRIM(COALESCE(CAST("fv" AS TEXT), '')) AS fv,
            TRIM(COALESCE(CAST("status" AS TEXT), '')) AS status,
            TRIM(COALESCE(CAST("test_id" AS TEXT), '')) AS test_id,
            TRIM(COALESCE(CAST("test_name" AS TEXT), '')) AS test_name,
            TRIM(COALESCE(CAST("tester" AS TEXT), '')) AS tester
        FROM {HOT_TESTING_STORE_NAME}
    '''


def _source_feature_region_expr(
    manual_run_columns: set[str],
    defect_columns: set[str],
) -> str:
    def _optional_expr(alias: str, columns: set[str], *names: str) -> str:
        available = [f"CAST({alias}.{name} AS TEXT)" for name in names if name in columns]
        if not available:
            return "''"
        return f"COALESCE({', '.join(available)}, '')"

    market_expr = _optional_expr("d", defect_columns, "market")
    solution_cluster_expr = _optional_expr("d", defect_columns, "solution_cluster")
    feature_area_expr = _optional_expr("d", defect_columns, "top_aida", "product_areas")
    if feature_area_expr == "''" and "product_areas" in manual_run_columns:
        feature_area_expr = "COALESCE(CAST(mr.product_areas AS TEXT), '')"

    return build_feature_region_sql_expr(
        feature_area_expr,
        market_expr=market_expr,
        solution_cluster_expr=solution_cluster_expr,
    )


def _source_testing_dataset_query(conn: sqlite3.Connection) -> str:
    manual_run_columns = _table_columns(conn, "octane_manual_runs")
    defect_columns = _table_columns(conn, "octane_defects")
    testcase_columns = _table_columns(conn, "octane_testcases") if _table_exists(conn, "octane_testcases") else set()

    def _optional_expr(alias: str, columns: set[str], *names: str) -> str:
        available = [f"CAST({alias}.{name} AS TEXT)" for name in names if name in columns]
        if not available:
            return "''"
        return f"COALESCE({', '.join(available)}, '')"

    def _coalesced_expr(*expressions: str) -> str:
        available = [expression for expression in expressions if expression != "''"]
        if not available:
            return "''"
        if len(available) == 1:
            return available[0]
        return f"COALESCE({', '.join(available)}, '')"

    year_expr = _optional_expr("mr", manual_run_columns, "year")
    if year_expr != "''" and "year" in defect_columns:
        year_expr = f"COALESCE({year_expr}, CAST(d.year AS TEXT), '')"
    elif "year" in defect_columns:
        year_expr = "COALESCE(CAST(d.year AS TEXT), '')"

    test_name_expr = _optional_expr("mr", manual_run_columns, "test_name", "name")
    if test_name_expr == "''" and "test_name" in testcase_columns:
        test_name_expr = "COALESCE(CAST(tc.test_name AS TEXT), '')"
    elif "test_name" in testcase_columns:
        test_name_expr = f"COALESCE({test_name_expr}, CAST(tc.test_name AS TEXT), '')"

    top_aida_expr = _coalesced_expr(
        _optional_expr("mr", manual_run_columns, "top_aida", "product_areas"),
        _optional_expr("d", defect_columns, "top_aida", "product_areas"),
    )

    test_week_expr = build_iso_test_week_sql_expr(
        finished_expr=_optional_expr("mr", manual_run_columns, "finished", "finished_udf"),
        fallback_test_week_expr=_optional_expr("d", defect_columns, "test_week"),
    )
    project_expr = build_tpmdashboard_project_sql_expr(
        name_expr=_optional_expr("mr", manual_run_columns, "name", "test_name"),
        target_ecu_conf_expr=_optional_expr("mr", manual_run_columns, "target_ecu_conf", "target_ecu_conf_udf"),
        top_aida_expr=top_aida_expr,
        fallback_project_expr=_optional_expr("d", defect_columns, "project"),
    )

    return f'''
        SELECT
            TRIM({year_expr}) AS year,
            TRIM({test_week_expr}) AS test_week,
            TRIM({project_expr}) AS project,
            TRIM({_coalesced_expr(_optional_expr("mr", manual_run_columns, "pu"), _optional_expr("d", defect_columns, "pu"))}) AS pu,
            TRIM({top_aida_expr}) AS top_aida,
            {_source_feature_region_expr(manual_run_columns, defect_columns)} AS feature_region,
            TRIM({_coalesced_expr(_optional_expr("mr", manual_run_columns, "fvp"), _optional_expr("d", defect_columns, "fvp"))}) AS fvp,
            TRIM({_coalesced_expr(_optional_expr("mr", manual_run_columns, "fv"), _optional_expr("d", defect_columns, "fv"))}) AS fv,
            TRIM({_optional_expr("mr", manual_run_columns, "status")}) AS status,
            TRIM({_optional_expr("mr", manual_run_columns, "test_id")}) AS test_id,
            TRIM({test_name_expr}) AS test_name,
            TRIM({_optional_expr("mr", manual_run_columns, "tester", "run_by", "author", "author_name")}) AS tester
        FROM octane_manual_runs mr
        LEFT JOIN octane_defects d
            ON d.defect_id = mr.defect_id
        LEFT JOIN octane_testcases tc
            ON tc.test_id = mr.test_id
    '''


def _testing_dataset_query(conn: sqlite3.Connection) -> str | None:
    if not str(os.environ.get("VIZION_ANALYTICS_DB_PATH", "")).strip():
        return None

    if _table_exists(conn, HOT_TESTING_STORE_NAME):
        hot_columns = _table_columns(conn, HOT_TESTING_STORE_NAME)
        if set(REQUIRED_COVERAGE_FIELDS).issubset(hot_columns):
            return _hot_testing_dataset_query()

    if not _manual_runs_table_exists(conn):
        return None

    columns = _table_columns(conn)
    source_required_columns = {"mr_id", "defect_id", "test_id", "status", "year"}
    source_query_available = source_required_columns.issubset(columns) and _table_exists(conn, "octane_defects")

    if set(REQUIRED_COVERAGE_FIELDS).issubset(columns):
        if not source_query_available or _relation_has_non_blank_required_fields(
            conn,
            "octane_manual_runs",
            REQUIRED_COVERAGE_FIELDS,
        ):
            return _legacy_testing_dataset_query()

    if source_query_available:
        return _source_testing_dataset_query(conn)

    return None


def _materialize_testing_runs(conn: sqlite3.Connection) -> str | None:
    if not str(os.environ.get("VIZION_ANALYTICS_DB_PATH", "")).strip():
        snapshot_version = _resolve_active_testing_snapshot_version(conn)
        if not snapshot_version:
            return None
        conn.execute(f"DROP TABLE IF EXISTS {TEMP_TESTING_RUNS_NAME}")
        conn.execute(
            f"""
            CREATE TEMP TABLE {TEMP_TESTING_RUNS_NAME} AS
            {_hot_testing_dataset_query()}
            WHERE snapshot_version = ?
            """,
            (snapshot_version,),
        )
        return TEMP_TESTING_RUNS_NAME

    dataset_query = _testing_dataset_query(conn)
    if not dataset_query:
        return None
    conn.execute(f"DROP TABLE IF EXISTS {TEMP_TESTING_RUNS_NAME}")
    conn.execute(f"CREATE TEMP TABLE {TEMP_TESTING_RUNS_NAME} AS {dataset_query}")
    return TEMP_TESTING_RUNS_NAME


def _has_non_blank_values(conn: sqlite3.Connection, relation_name: str, column_name: str) -> bool:
    if not relation_name:
        return False
    row = conn.execute(
        f'''
        SELECT 1
        FROM {relation_name}
        WHERE TRIM(COALESCE(CAST("{column_name}" AS TEXT), '')) <> ''
        LIMIT 1
        '''
    ).fetchone()
    return row is not None


def _relation_has_non_blank_required_fields(
    conn: sqlite3.Connection,
    relation_name: str,
    required_fields: tuple[str, ...],
) -> bool:
    return all(
        _has_non_blank_values(conn, relation_name, field)
        for field in required_fields
    )


def _ensure_coverage_data_ready(conn: sqlite3.Connection, relation_name: str | None) -> None:
    if not relation_name:
        raise TestingCoverageDataNotReadyError(list(REQUIRED_COVERAGE_FIELDS))

    total_rows = conn.execute(
        f"SELECT COUNT(*) FROM {relation_name}"
    ).fetchone()[0]
    if total_rows == 0:
        raise TestingCoverageDataNotReadyError(list(REQUIRED_COVERAGE_FIELDS))

    missing_fields = [
        field
        for field in REQUIRED_COVERAGE_FIELDS
        if not _has_non_blank_values(conn, relation_name, field)
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


def _get_positive_int_query_param(query_params: Any, key: str) -> int | None:
    if hasattr(query_params, "get"):
        raw_value = query_params.get(key)
    elif isinstance(query_params, dict):
        raw_value = query_params.get(key)
    else:
        raw_value = None

    if raw_value in (None, ""):
        return None

    try:
        value = int(str(raw_value).strip())
    except (TypeError, ValueError):
        return None

    return value if value > 0 else None


def _list_distinct_values(
    conn: sqlite3.Connection,
    relation_name: str,
    column_name: str,
    where_clause: str,
    params: list[str],
) -> list[str]:
    rows = conn.execute(
        f'''
        SELECT DISTINCT TRIM(COALESCE(CAST("{column_name}" AS TEXT), '')) AS value
        FROM {relation_name}
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
        relation_name = _materialize_testing_runs(conn)
        _ensure_coverage_data_ready(conn, relation_name)
        where_clause, params = _build_where_clause(query)
        return {
            filter_name: _list_distinct_values(conn, relation_name, column_name, where_clause, params)
            for filter_name, column_name in FILTER_COLUMN_MAP.items()
        }
    finally:
        conn.close()


def _fetch_grouped_rows(
    query_params: Any,
    select_columns: tuple[str, ...],
    order_columns: tuple[str, ...],
    limit: int | None = None,
) -> list[dict[str, object]]:
    query = normalize_query(query_params)
    conn = _connect()
    try:
        relation_name = _materialize_testing_runs(conn)
        _ensure_coverage_data_ready(conn, relation_name)
        if not relation_name:
            return []
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
        limit_sql = f"\n            LIMIT {limit}" if limit is not None else ""
        rows = conn.execute(
            f'''
            SELECT
                {select_sql},
                COUNT(*) AS count
            FROM {relation_name}
            WHERE {where_clause}
            GROUP BY {group_by_sql}
            ORDER BY {order_by_sql}
            {limit_sql}
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
        limit=_get_positive_int_query_param(query_params, "limit"),
    )