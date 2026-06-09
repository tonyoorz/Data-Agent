from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from pathlib import Path
import sqlite3

from backend.analytics.full_picture_outcomes import ensure_outcome_store
from backend.analytics.testing_coverage_reference import (
    build_feature_region_sql_expr,
    build_iso_test_week_sql_expr,
    build_tpmdashboard_project_sql_expr,
)


TESTING_COVERAGE_STORE_NAME = "testing_coverage_runs"
TESTING_COVERAGE_SNAPSHOT_STATE_TABLE = "testing_coverage_snapshot_state"
TESTING_COVERAGE_SNAPSHOT_POINTER_TABLE = "testing_coverage_snapshot_pointer"


TESTING_COVERAGE_SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {TESTING_COVERAGE_STORE_NAME} (
    snapshot_version TEXT NOT NULL,
    mr_id TEXT NOT NULL,
    defect_id TEXT,
    test_id TEXT,
    test_name TEXT,
    status TEXT,
    year TEXT,
    test_week TEXT,
    project TEXT,
    pu TEXT,
    top_aida TEXT,
    feature_region TEXT,
    fvp TEXT,
    fv TEXT,
    tester TEXT,
    source_signature TEXT NOT NULL,
    derived_at TEXT NOT NULL,
    PRIMARY KEY (snapshot_version, mr_id)
);

CREATE INDEX IF NOT EXISTS idx_testing_coverage_runs_snapshot
ON {TESTING_COVERAGE_STORE_NAME}(snapshot_version);

CREATE TABLE IF NOT EXISTS {TESTING_COVERAGE_SNAPSHOT_STATE_TABLE} (
    snapshot_version TEXT NOT NULL PRIMARY KEY,
    source_signature TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    refresh_status TEXT NOT NULL,
    refreshed_at TEXT NOT NULL,
    last_error TEXT
);

CREATE TABLE IF NOT EXISTS {TESTING_COVERAGE_SNAPSHOT_POINTER_TABLE} (
    pointer_name TEXT NOT NULL PRIMARY KEY,
    snapshot_version TEXT NOT NULL
);
"""


def ensure_testing_coverage_store(db_path: Path | str) -> Path:
    resolved_path = ensure_outcome_store(db_path)
    conn = sqlite3.connect(resolved_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        existing_tables = {
            str(row[0]).strip()
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if TESTING_COVERAGE_STORE_NAME in existing_tables:
            columns = {
                str(row["name"]).strip()
                for row in conn.execute(f"PRAGMA table_info({TESTING_COVERAGE_STORE_NAME})").fetchall()
            }
            if "snapshot_version" not in columns:
                conn.execute(f"DROP TABLE IF EXISTS {TESTING_COVERAGE_STORE_NAME}")
                conn.execute(f"DROP TABLE IF EXISTS {TESTING_COVERAGE_SNAPSHOT_STATE_TABLE}")
                conn.execute(f"DROP TABLE IF EXISTS {TESTING_COVERAGE_SNAPSHOT_POINTER_TABLE}")
        conn.executescript(TESTING_COVERAGE_SCHEMA_SQL)
        conn.commit()
    finally:
        conn.close()
    return resolved_path


def _build_testing_coverage_snapshot_version(source_signature: str) -> str:
    digest = hashlib.sha1(source_signature.encode("utf-8")).hexdigest()[:16]
    return f"testing-coverage-{digest}"


def _open_read_only_connection(db_path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"{Path(db_path).resolve().as_uri()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _compute_source_signature(db_path: Path | str) -> str:
    resolved_path = Path(db_path).resolve()
    stat_result = resolved_path.stat()
    return f"{resolved_path}|{stat_result.st_size}|{stat_result.st_mtime_ns}"


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        str(row["name"]).strip()
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }


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


def _feature_region_expr(manual_run_columns: set[str], defect_columns: set[str]) -> str:
    market_expr = _optional_expr("d", defect_columns, "market")
    solution_cluster_expr = _optional_expr("d", defect_columns, "solution_cluster")
    feature_area_expr = _coalesced_expr(
        _optional_expr("mr", manual_run_columns, "top_aida", "product_areas"),
        _optional_expr("d", defect_columns, "top_aida", "product_areas"),
    )

    return build_feature_region_sql_expr(
        feature_area_expr,
        market_expr=market_expr,
        solution_cluster_expr=solution_cluster_expr,
    )


def _derive_testing_coverage_rows(
    source_db_path: Path | str,
    source_signature: str,
) -> list[tuple[object, ...]]:
    conn = _open_read_only_connection(source_db_path)
    try:
        manual_run_columns = _table_columns(conn, "octane_manual_runs")
        defect_columns = _table_columns(conn, "octane_defects") if _table_exists(conn, "octane_defects") else set()
        testcase_columns = _table_columns(conn, "octane_testcases") if _table_exists(conn, "octane_testcases") else set()

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

        rows = conn.execute(
            f'''
            SELECT
                TRIM(COALESCE(CAST(mr.mr_id AS TEXT), '')) AS mr_id,
                TRIM(COALESCE(CAST(mr.defect_id AS TEXT), '')) AS defect_id,
                TRIM(COALESCE(CAST(mr.test_id AS TEXT), '')) AS test_id,
                TRIM({test_name_expr}) AS test_name,
                TRIM({_optional_expr("mr", manual_run_columns, "status")}) AS status,
                TRIM({year_expr}) AS year,
                TRIM({test_week_expr}) AS test_week,
                TRIM({project_expr}) AS project,
                TRIM({_coalesced_expr(_optional_expr("mr", manual_run_columns, "pu"), _optional_expr("d", defect_columns, "pu"))}) AS pu,
                TRIM({top_aida_expr}) AS top_aida,
                {_feature_region_expr(manual_run_columns, defect_columns)} AS feature_region,
                TRIM({_coalesced_expr(_optional_expr("mr", manual_run_columns, "fvp"), _optional_expr("d", defect_columns, "fvp"))}) AS fvp,
                TRIM({_coalesced_expr(_optional_expr("mr", manual_run_columns, "fv"), _optional_expr("d", defect_columns, "fv"))}) AS fv,
                TRIM({_optional_expr("mr", manual_run_columns, "tester", "run_by", "author", "author_name")}) AS tester
            FROM octane_manual_runs mr
            LEFT JOIN octane_defects d
                ON d.defect_id = mr.defect_id
            LEFT JOIN octane_testcases tc
                ON tc.test_id = mr.test_id
            ORDER BY mr.mr_id
            '''
        ).fetchall()
    finally:
        conn.close()

    derived_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    derived_rows: list[tuple[object, ...]] = []
    for row in rows:
        mr_id = str(row["mr_id"] or "").strip()
        if not mr_id:
            continue
        derived_rows.append(
            (
                mr_id,
                row["defect_id"],
                row["test_id"],
                row["test_name"],
                row["status"],
                row["year"],
                row["test_week"],
                row["project"],
                row["pu"],
                row["top_aida"],
                row["feature_region"],
                row["fvp"],
                row["fv"],
                row["tester"],
                source_signature,
                derived_at,
            )
        )
    return derived_rows


def refresh_materialized_testing_coverage(
    source_db_path: Path | str,
    hot_db_path: Path | str,
    force: bool = False,
) -> dict[str, object]:
    resolved_hot_path = ensure_testing_coverage_store(hot_db_path)
    source_signature = _compute_source_signature(source_db_path)
    snapshot_version = _build_testing_coverage_snapshot_version(source_signature)

    hot_conn = sqlite3.connect(resolved_hot_path)
    try:
        refresh_state_row = hot_conn.execute(
            f"""
            SELECT source_signature, row_count, refresh_status
            FROM {TESTING_COVERAGE_SNAPSHOT_STATE_TABLE}
            WHERE snapshot_version = ?
            LIMIT 1
            """,
            (snapshot_version,),
        ).fetchone()
        active_pointer_row = hot_conn.execute(
            """
            SELECT snapshot_version
            FROM testing_coverage_snapshot_pointer
            WHERE pointer_name = 'active'
            LIMIT 1
            """,
        ).fetchone()
        existing_row_count_row = hot_conn.execute(
            f"SELECT COUNT(*) FROM {TESTING_COVERAGE_STORE_NAME} WHERE snapshot_version = ?",
            (snapshot_version,),
        ).fetchone()
        existing_row_count = int(existing_row_count_row[0] or 0) if existing_row_count_row else 0
        refresh_state_signature = str(refresh_state_row[0]).strip() if refresh_state_row else ""
        refresh_state_row_count = int(refresh_state_row[1] or 0) if refresh_state_row else -1
        refresh_state_status = str(refresh_state_row[2] or "").strip() if refresh_state_row else ""
        active_snapshot_version = str(active_pointer_row[0] or "").strip() if active_pointer_row else ""
        if (
            not force
            and refresh_state_signature == source_signature
            and refresh_state_row_count == existing_row_count
            and refresh_state_status == "ready"
            and active_snapshot_version == snapshot_version
        ):
            return {
                "row_count": existing_row_count,
                "skipped": True,
                "source_signature": source_signature,
                "snapshot_version": snapshot_version,
            }

        derived_rows = _derive_testing_coverage_rows(source_db_path, source_signature)
        refreshed_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        hot_conn.execute(
            f"DELETE FROM {TESTING_COVERAGE_STORE_NAME} WHERE snapshot_version = ?",
            (snapshot_version,),
        )
        hot_conn.executemany(
            f'''
            INSERT INTO {TESTING_COVERAGE_STORE_NAME}(
                snapshot_version,
                mr_id,
                defect_id,
                test_id,
                test_name,
                status,
                year,
                test_week,
                project,
                pu,
                top_aida,
                feature_region,
                fvp,
                fv,
                tester,
                source_signature,
                derived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            [
                (
                    snapshot_version,
                    *row,
                )
                for row in derived_rows
            ],
        )
        hot_conn.execute(
            f"""
            INSERT INTO {TESTING_COVERAGE_SNAPSHOT_STATE_TABLE}(
                snapshot_version,
                source_signature,
                row_count,
                refresh_status,
                refreshed_at,
                last_error
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(snapshot_version) DO UPDATE SET
                source_signature = excluded.source_signature,
                row_count = excluded.row_count,
                refresh_status = excluded.refresh_status,
                refreshed_at = excluded.refreshed_at,
                last_error = excluded.last_error
            """,
            (
                snapshot_version,
                source_signature,
                len(derived_rows),
                "ready",
                refreshed_at,
                None,
            ),
        )
        hot_conn.execute(
            f"""
            INSERT INTO {TESTING_COVERAGE_SNAPSHOT_POINTER_TABLE}(pointer_name, snapshot_version)
            VALUES ('active', ?)
            ON CONFLICT(pointer_name) DO UPDATE SET
                snapshot_version = excluded.snapshot_version
            """,
            (snapshot_version,),
        )
        hot_conn.execute(
            """
            INSERT INTO outcome_refresh_state(
                store_name,
                source_signature,
                outcome_row_count,
                refreshed_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(store_name) DO UPDATE SET
                source_signature = excluded.source_signature,
                outcome_row_count = excluded.outcome_row_count,
                refreshed_at = excluded.refreshed_at
            """,
            (
                TESTING_COVERAGE_STORE_NAME,
                source_signature,
                len(derived_rows),
                refreshed_at,
            ),
        )
        hot_conn.commit()
    finally:
        hot_conn.close()

    return {
        "row_count": len(derived_rows),
        "skipped": False,
        "source_signature": source_signature,
            "snapshot_version": snapshot_version,
    }