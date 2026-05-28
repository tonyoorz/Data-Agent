from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path

from backend.analytics.db import connect


_summary_cache: dict[str, dict[str, object]] = {}


def get_summary_cache() -> dict[str, dict[str, object]]:
    return _summary_cache


def reset_summary_cache() -> None:
    _summary_cache.clear()


def _normalize_filter_values(values: object) -> list[str]:
    if values is None:
        return []
    if isinstance(values, str):
        candidates = [values]
    elif isinstance(values, Sequence):
        candidates = list(values)
    else:
        candidates = [values]

    normalized_values: set[str] = set()
    for value in candidates:
        if value is None:
            continue
        if isinstance(value, str):
            normalized_value = value.strip()
        else:
            normalized_value = str(value).strip()
        if not normalized_value:
            continue
        normalized_values.add(normalized_value)

    return sorted(normalized_values)


def normalize_summary_cache_key(*, snapshot_version: str, filters: Mapping[str, object]) -> str:
    normalized_filters = {
        key: _normalize_filter_values(values)
        for key, values in sorted(filters.items())
    }
    return json.dumps(
        {
            "snapshot_version": str(snapshot_version).strip(),
            "filters": normalized_filters,
        },
        sort_keys=True,
    )


def _ensure_snapshot_tables(db_path: Path | str) -> None:
    conn = connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS dashboard_snapshot_state (
                snapshot_version TEXT PRIMARY KEY,
                source_db_path TEXT NOT NULL,
                source_db_mtime TEXT NOT NULL,
                refresh_status TEXT NOT NULL,
                outcomes_refreshed_at TEXT,
                summary_cache_refreshed_at TEXT,
                last_success_at TEXT,
                last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS dashboard_snapshot_pointer (
                pointer_name TEXT PRIMARY KEY,
                snapshot_version TEXT NOT NULL
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


def record_snapshot_refresh(
    hot_db_path: Path | str,
    *,
    snapshot_version: str,
    source_db_path: str,
    source_db_mtime: str,
    refresh_status: str,
    last_error: str | None,
) -> None:
    _ensure_snapshot_tables(hot_db_path)
    now_iso = datetime.now(timezone.utc).isoformat()
    conn = connect(hot_db_path)
    try:
        existing_row = conn.execute(
            "SELECT last_success_at FROM dashboard_snapshot_state WHERE snapshot_version = ?",
            (snapshot_version,),
        ).fetchone()
        last_success_at = now_iso if refresh_status == "ready" else (
            existing_row["last_success_at"] if existing_row is not None else None
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO dashboard_snapshot_state(
                snapshot_version,
                source_db_path,
                source_db_mtime,
                refresh_status,
                outcomes_refreshed_at,
                summary_cache_refreshed_at,
                last_success_at,
                last_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                snapshot_version,
                source_db_path,
                source_db_mtime,
                refresh_status,
                now_iso,
                now_iso,
                last_success_at,
                last_error,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def activate_snapshot_version(hot_db_path: Path | str, snapshot_version: str) -> None:
    _ensure_snapshot_tables(hot_db_path)
    conn = connect(hot_db_path)
    try:
        state_row = conn.execute(
            "SELECT snapshot_version FROM dashboard_snapshot_state WHERE snapshot_version = ?",
            (snapshot_version,),
        ).fetchone()
        if state_row is None:
            raise ValueError(f"Unknown snapshot version: {snapshot_version}")
        conn.execute(
            """
            INSERT OR REPLACE INTO dashboard_snapshot_pointer(pointer_name, snapshot_version)
            VALUES ('active', ?)
            """,
            (snapshot_version,),
        )
        conn.commit()
    finally:
        conn.close()


def read_active_snapshot_state(hot_db_path: Path | str) -> dict[str, object]:
    _ensure_snapshot_tables(hot_db_path)
    conn = connect(hot_db_path)
    try:
        pointer_row = conn.execute(
            "SELECT snapshot_version FROM dashboard_snapshot_pointer WHERE pointer_name = 'active'"
        ).fetchone()
        if pointer_row is None:
            return {
                "active_snapshot_version": "",
                "refresh_status": "missing",
            }

        snapshot_version = str(pointer_row["snapshot_version"] or "").strip()
        state_row = conn.execute(
            "SELECT * FROM dashboard_snapshot_state WHERE snapshot_version = ?",
            (snapshot_version,),
        ).fetchone()
        if state_row is None:
            return {
                "active_snapshot_version": snapshot_version,
                "refresh_status": "missing",
            }

        state = dict(state_row)
        state["active_snapshot_version"] = snapshot_version
        return state
    finally:
        conn.close()