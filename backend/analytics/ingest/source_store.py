from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.analytics.schema import ensure_schema


SQLITE_MAX_QUERY_VARIABLES = 32000


DEFECT_ADDITIONAL_COLUMNS: dict[str, str] = {
    "description": "TEXT",
    "comments": "TEXT",
    "requirement": "TEXT",
    "requirements_json": "TEXT",
    "creation_time": "TEXT",
    "last_modified": "TEXT",
    "program": "TEXT",
    "author": "TEXT",
    "user_tags": "TEXT",
    "phase": "TEXT",
    "severity": "TEXT",
    "problem_severity": "TEXT",
    "owner": "TEXT",
    "detected_by": "TEXT",
    "detected_in_release": "TEXT",
    "vin": "TEXT",
    "ecu_no_of_changes": "TEXT",
    "parent_id": "TEXT",
    "parent_child_type": "TEXT",
    "relation_to": "TEXT",
    "test_week": "TEXT",
    "risk_score": "TEXT",
    "tqr": "TEXT",
    "blocking_reason": "TEXT",
    "error_occurrence": "TEXT",
    "solution_responsible": "TEXT",
    "reporting_class": "TEXT",
    "involved_i_step": "TEXT",
    "first_use_sop_of_function": "TEXT",
    "tolerated_count": "TEXT",
    "reprel_changes": "TEXT",
    "tproject": "TEXT",
    "function2modul": "TEXT",
    "model_series": "TEXT",
    "defect_category": "TEXT",
    "status_phase": "TEXT",
    "problem_finder_team": "TEXT",
    "year": "TEXT",
    "assigned_ecu": "TEXT",
    "top_aida": "TEXT",
    "aida_english": "TEXT",
    "aida_businesskey": "TEXT",
    "solution_cluster": "TEXT",
    "product_areas": "TEXT",
    "software_version": "TEXT",
    "function_responsible": "TEXT",
    "ecu_to_modul": "TEXT",
}

HISTORY_ADDITIONAL_COLUMNS: dict[str, str] = {
    "action": "TEXT",
    "user_name": "TEXT",
    "team": "TEXT",
    "entry_index": "INTEGER",
    "change_index": "INTEGER",
    "old_value_text": "TEXT",
    "new_value_text": "TEXT",
}

MANUAL_RUN_EXTRA_COLUMNS: dict[str, str] = {
    "name": "TEXT",
    "run_team": "TEXT",
    "program": "TEXT",
    "author": "TEXT",
    "run_by": "TEXT",
    "native_status": "TEXT",
    "is_completed": "TEXT",
    "steps_num": "TEXT",
    "version_stamp": "TEXT",
    "release": "TEXT",
    "exec_model_series": "TEXT",
    "execution_sw_version": "TEXT",
    "test_version": "TEXT",
    "domain": "TEXT",
    "test_phase": "TEXT",
    "testing_tool_type": "TEXT",
    "taxonomies": "TEXT",
    "set_field": "TEXT",
    "testplatformid": "TEXT",
    "spec": "TEXT",
    "creation_time": "TEXT",
    "last_modified": "TEXT",
    "started": "TEXT",
    "finished": "TEXT",
    "product_areas": "TEXT",
    "target_ecu_conf": "TEXT",
}

TESTCASE_ADDITIONAL_COLUMNS: dict[str, str] = {
    "test_subtype": "TEXT",
    "run_ids_json": "TEXT",
    "run_status_distribution_json": "TEXT",
    "manual_test_ids_json": "TEXT",
}

TESTCASE_RELATION_ADDITIONAL_COLUMNS: dict[str, str] = {
    "related_subtype": "TEXT",
    "related_path": "TEXT",
}

COMMENT_REFRESH_STATE_COLUMNS: dict[str, str] = {
    "defect_id": "TEXT NOT NULL PRIMARY KEY",
    "defect_last_modified": "TEXT NOT NULL",
    "comments_json": "TEXT NOT NULL",
    "refreshed_at": "TEXT NOT NULL",
}

HISTORY_REFRESH_STATE_COLUMNS: dict[str, str] = {
    "defect_id": "TEXT NOT NULL PRIMARY KEY",
    "defect_last_modified": "TEXT NOT NULL",
    "last_history_event_timestamp": "TEXT",
    "last_history_checked_at": "TEXT NOT NULL",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _is_missing_dimension(value: object) -> bool:
    text = str(value or "").strip()
    return not text or text.casefold() in {"unknown", "unclassified"}


def _json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def _nested_value(value: object, *keys: str) -> str:
    current = value
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key)
        else:
            return ""
    if isinstance(current, (dict, list)):
        return ""
    return str(current or "").strip()


def _first_named_value(value: object) -> str:
    if isinstance(value, dict):
        return _nested_value(value, "full_name") or _nested_value(value, "name") or _nested_value(value, "id")
    if isinstance(value, list):
        for item in value:
            resolved = _first_named_value(item)
            if resolved:
                return resolved
        return ""
    return str(value or "").strip()


def _joined_named_values(value: object) -> str:
    if isinstance(value, list):
        parts = [_first_named_value(item) for item in value]
        return ",".join(part for part in parts if part)
    return _first_named_value(value)


def _reference_names(value: object) -> list[str]:
    if isinstance(value, dict):
        data = value.get("data")
        if isinstance(data, list):
            return _reference_names(data)
        name = _first_named_value(value)
        return [name] if name else []

    if isinstance(value, list):
        names: list[str] = []
        seen: set[str] = set()
        for item in value:
            for name in _reference_names(item):
                if not name or name in seen:
                    continue
                seen.add(name)
                names.append(name)
        return names

    name = str(value or "").strip()
    return [name] if name else []


def _release_name(row: dict[str, Any]) -> str:
    release = row.get("release")
    if isinstance(release, dict):
        return str(release.get("name") or "").strip()
    return str(release or "").strip()


def _coalesce(*values: object) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _scalar_text(value: object) -> str:
    if isinstance(value, (dict, list)):
        return ""
    return str(value or "").strip()


def _preserve_dimension(existing: sqlite3.Row | None, column_name: str, incoming: str) -> str:
    if existing is None:
        return incoming
    current = str(existing[column_name] or "").strip()
    return current if not _is_missing_dimension(current) else incoming


def _normalize_relation_subtype(value: object) -> str:
    return str(value or "").strip().lower()


def _relation_bucket_key(subtype: str) -> str | None:
    if subtype == "defect":
        return "defect_ids"
    if subtype == "feature":
        return "feature_ids"
    if subtype == "story":
        return "story_ids"
    return None


class OctaneSourceStore:
    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path)
        self._conn.row_factory = sqlite3.Row

    def close(self) -> None:
        self._conn.close()

    def commit(self) -> None:
        self._conn.commit()

    def create_tables(self) -> None:
        ensure_schema(self.db_path)
        self._ensure_columns("octane_defects", DEFECT_ADDITIONAL_COLUMNS)
        self._ensure_columns("octane_defect_history_events", HISTORY_ADDITIONAL_COLUMNS)
        self._ensure_columns("octane_manual_runs", MANUAL_RUN_EXTRA_COLUMNS)
        self._ensure_columns("octane_testcases", TESTCASE_ADDITIONAL_COLUMNS)
        self._ensure_columns("octane_testcase_relations", TESTCASE_RELATION_ADDITIONAL_COLUMNS)
        self._ensure_comment_refresh_state_table()
        self._ensure_history_refresh_state_table()
        self._conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_octane_defect_history_events_defect_timestamp
            ON octane_defect_history_events(defect_id, event_timestamp)
            """
        )
        self._conn.commit()

    def _ensure_comment_refresh_state_table(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS octane_defect_comment_refresh_state (
                defect_id TEXT NOT NULL PRIMARY KEY,
                defect_last_modified TEXT NOT NULL,
                comments_json TEXT NOT NULL,
                refreshed_at TEXT NOT NULL
            )
            """
        )
        self._ensure_columns(
            "octane_defect_comment_refresh_state",
            {
                "defect_last_modified": "TEXT NOT NULL DEFAULT ''",
                "last_defect_modified": "TEXT NOT NULL DEFAULT ''",
                "comments_json": "TEXT NOT NULL DEFAULT '[]'",
                "refreshed_at": "TEXT NOT NULL DEFAULT ''",
            },
        )

    def _ensure_history_refresh_state_table(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS octane_defect_history_refresh_state (
                defect_id TEXT NOT NULL PRIMARY KEY,
                defect_last_modified TEXT NOT NULL,
                last_history_event_timestamp TEXT,
                last_history_checked_at TEXT NOT NULL
            )
            """
        )
        self._ensure_columns(
            "octane_defect_history_refresh_state",
            {
                "defect_last_modified": "TEXT NOT NULL DEFAULT ''",
                "last_history_event_timestamp": "TEXT",
                "last_history_checked_at": "TEXT NOT NULL DEFAULT ''",
            },
        )

    def _ensure_columns(self, table_name: str, columns: dict[str, str]) -> None:
        existing_columns = {
            str(row[1]).strip()
            for row in self._conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        }
        for column_name, column_type in columns.items():
            if column_name in existing_columns:
                continue
            self._conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")

    def _upsert_rows(
        self,
        table_name: str,
        columns: tuple[str, ...],
        rows: list[tuple[object, ...]],
        *,
        conflict_columns: tuple[str, ...],
    ) -> None:
        if not rows:
            return
        update_columns = [column for column in columns if column not in conflict_columns]
        assignments = ", ".join(f"{column}=excluded.{column}" for column in update_columns)
        placeholders = ", ".join("?" for _ in columns)
        insert_columns = ", ".join(columns)
        conflict_target = ", ".join(conflict_columns)
        sql = (
            f"INSERT INTO {table_name}({insert_columns}) VALUES ({placeholders}) "
            f"ON CONFLICT({conflict_target}) DO UPDATE SET {assignments}"
        )
        self._conn.executemany(sql, rows)

    def load_comment_snapshots(self, defect_ids: list[str]) -> dict[str, dict[str, str]]:
        normalized_ids = [str(defect_id).strip() for defect_id in defect_ids if str(defect_id).strip()]
        if not normalized_ids:
            return {}

        snapshots: dict[str, dict[str, str]] = {}
        for start_index in range(0, len(normalized_ids), SQLITE_MAX_QUERY_VARIABLES):
            batch_ids = normalized_ids[start_index : start_index + SQLITE_MAX_QUERY_VARIABLES]
            placeholders = ", ".join("?" for _ in batch_ids)
            rows = self._conn.execute(
                f"""
                SELECT
                    d.defect_id,
                    CASE WHEN s.defect_id IS NULL THEN 0 ELSE 1 END AS has_refresh_state,
                    COALESCE(NULLIF(TRIM(CAST(s.defect_last_modified AS TEXT)), ''), NULLIF(TRIM(CAST(s.last_defect_modified AS TEXT)), ''), NULLIF(TRIM(CAST(d.last_modified AS TEXT)), '')) AS defect_last_modified,
                    COALESCE(NULLIF(TRIM(CAST(s.comments_json AS TEXT)), ''), NULLIF(TRIM(CAST(d.comments AS TEXT)), '')) AS comments_json
                FROM octane_defects d
                LEFT JOIN octane_defect_comment_refresh_state s ON s.defect_id = d.defect_id
                WHERE d.defect_id IN ({placeholders})
                """,
                batch_ids,
            ).fetchall()
            for row in rows:
                snapshots[str(row["defect_id"])] = {
                    "has_refresh_state": "1" if int(row["has_refresh_state"] or 0) else "0",
                    "defect_last_modified": str(row["defect_last_modified"] or "").strip(),
                    "comments_json": str(row["comments_json"] or "").strip(),
                }
        return snapshots

    def record_comment_refresh_state(self, rows: list[tuple[str, str, str]]) -> None:
        if not rows:
            return
        refreshed_at = _utc_now()
        existing_columns = {
            str(row[1]).strip()
            for row in self._conn.execute("PRAGMA table_info(octane_defect_comment_refresh_state)").fetchall()
        }
        columns = ["defect_id", "defect_last_modified", "comments_json", "refreshed_at"]
        if "last_defect_modified" in existing_columns:
            columns.insert(2, "last_defect_modified")
        if "last_synced_at" in existing_columns:
            columns.append("last_synced_at")
        placeholders = ", ".join("?" for _ in columns)
        assignments = ", ".join(
            f"{column}=excluded.{column}"
            for column in columns
            if column != "defect_id"
        )
        values: list[tuple[object, ...]] = []
        for defect_id, last_modified, comments_json in rows:
            row_values: list[object] = [defect_id, last_modified, comments_json, refreshed_at]
            if "last_defect_modified" in existing_columns:
                row_values.insert(2, last_modified)
            if "last_synced_at" in existing_columns:
                row_values.append(refreshed_at)
            values.append(tuple(row_values))
        self._conn.executemany(
            f"""
            INSERT INTO octane_defect_comment_refresh_state({', '.join(columns)})
            VALUES ({placeholders})
            ON CONFLICT(defect_id) DO UPDATE SET {assignments}
            """,
            values,
        )

    def plan_history_refreshes(self, defects: list[dict[str, Any]]) -> tuple[dict[str, str | None], int]:
        defect_last_modified = {
            str(row.get("id") or "").strip(): str(row.get("last_modified") or "").strip()
            for row in defects
            if str(row.get("id") or "").strip()
        }
        defect_ids = sorted(defect_last_modified)
        if not defect_ids:
            return {}, 0

        latest_history: dict[str, dict[str, str]] = {}
        history_state: dict[str, dict[str, str]] = {}
        for start_index in range(0, len(defect_ids), SQLITE_MAX_QUERY_VARIABLES):
            batch_ids = defect_ids[start_index : start_index + SQLITE_MAX_QUERY_VARIABLES]
            placeholders = ", ".join("?" for _ in batch_ids)
            rows = self._conn.execute(
                f"""
                SELECT
                    defect_id,
                    MAX(event_timestamp) AS last_history_event_timestamp,
                    MAX(fetched_at) AS latest_fetched_at
                FROM octane_defect_history_events
                WHERE defect_id IN ({placeholders})
                GROUP BY defect_id
                """,
                batch_ids,
            ).fetchall()
            for row in rows:
                latest_history[str(row["defect_id"])] = {
                    "last_history_event_timestamp": str(row["last_history_event_timestamp"] or "").strip(),
                    "latest_fetched_at": str(row["latest_fetched_at"] or "").strip(),
                }

            state_rows = self._conn.execute(
                f"""
                SELECT defect_id, last_history_event_timestamp, last_history_checked_at
                FROM octane_defect_history_refresh_state
                WHERE defect_id IN ({placeholders})
                """,
                batch_ids,
            ).fetchall()
            for row in state_rows:
                history_state[str(row["defect_id"])] = {
                    "last_history_event_timestamp": str(row["last_history_event_timestamp"] or "").strip(),
                    "last_history_checked_at": str(row["last_history_checked_at"] or "").strip(),
                }

        refresh_since: dict[str, str | None] = {}
        for defect_id in defect_ids:
            state = history_state.get(defect_id, {})
            latest = latest_history.get(defect_id, {})
            last_checked_at = state.get("last_history_checked_at") or latest.get("latest_fetched_at") or ""
            last_event_timestamp = state.get("last_history_event_timestamp") or latest.get("last_history_event_timestamp") or ""
            modified_at = defect_last_modified.get(defect_id, "")
            if not last_checked_at or (modified_at and modified_at > last_checked_at):
                refresh_since[defect_id] = last_event_timestamp or None
        return refresh_since, len(defect_ids) - len(refresh_since)

    def filter_stale_history_defect_ids(self, defects: list[dict[str, Any]]) -> tuple[list[str], int]:
        refresh_since, skipped_count = self.plan_history_refreshes(defects)
        return sorted(refresh_since), skipped_count

    def upsert_defects(self, defects: list[dict[str, Any]], *, team: str, year: int | None = None) -> int:
        defect_ids = [str(row.get("id") or "").strip() for row in defects if str(row.get("id") or "").strip()]
        existing_rows = self._load_existing_rows("octane_defects", "defect_id", defect_ids)
        payload: list[tuple[object, ...]] = []
        fetched_at = _utc_now()
        for row in defects:
            defect_id = str(row.get("id") or "").strip()
            if not defect_id:
                continue
            existing = existing_rows.get(defect_id)
            status_phase = _first_named_value(row.get("phase"))
            incoming_team = _coalesce(_first_named_value(row.get("team")), team)
            lead_model = _first_named_value(row.get("lead_model_udf"))
            requirement_names = _reference_names(row.get("requirements"))
            payload.append(
                (
                    defect_id,
                    str(row.get("name") or "").strip(),
                    _preserve_dimension(existing, "project", ""),
                    _preserve_dimension(existing, "market", ""),
                    _preserve_dimension(existing, "pu", ""),
                    _preserve_dimension(existing, "fv", ""),
                    _preserve_dimension(existing, "fvp", ""),
                    _preserve_dimension(existing, "team", incoming_team),
                    _preserve_dimension(existing, "lead_model", lead_model),
                    _json_text(row),
                    fetched_at,
                    str(row.get("description") or "").strip(),
                    _json_text(row.get("comments") or []),
                    " | ".join(requirement_names),
                    _json_text(requirement_names),
                    _scalar_text(row.get("creation_time")),
                    _scalar_text(row.get("last_modified")),
                    _first_named_value(row.get("program")),
                    _coalesce(_nested_value(row.get("author"), "full_name"), _nested_value(row.get("author"), "name"), _scalar_text(row.get("author"))),
                    _joined_named_values(row.get("user_tags")),
                    _first_named_value(row.get("phase")),
                    _first_named_value(row.get("severity")),
                    _first_named_value(row.get("problem_severity")),
                    _first_named_value(row.get("owner")),
                    _first_named_value(row.get("detected_by")),
                    _first_named_value(row.get("detected_in_release")),
                    _scalar_text(row.get("vin")),
                    _scalar_text(row.get("ecu_no_of_changes")),
                    _coalesce(_nested_value(row.get("parent"), "id"), _scalar_text(row.get("parent_id"))),
                    _scalar_text(row.get("parent_child_type")),
                    _scalar_text(row.get("relation_to")),
                    _scalar_text(row.get("test_week")),
                    _scalar_text(row.get("risk_score")),
                    _scalar_text(row.get("tqr")),
                    _scalar_text(row.get("blocking_reason")),
                    _scalar_text(row.get("error_occurrence")),
                    _first_named_value(row.get("solution_responsible")),
                    _scalar_text(row.get("reporting_class")),
                    _scalar_text(row.get("involved_i_step")),
                    _scalar_text(row.get("first_use_sop_of_function")),
                    _scalar_text(row.get("tolerated_count")),
                    _scalar_text(row.get("reprel_changes")),
                    _scalar_text(row.get("tproject")),
                    _scalar_text(row.get("function2modul")),
                    _first_named_value(row.get("model_series")),
                    _first_named_value(row.get("defect_category")),
                    status_phase,
                    _coalesce(_first_named_value(row.get("problem_finder_team_udf")), incoming_team),
                    _coalesce(str(row.get("year") or "").strip(), str(year or ""), str(row.get("creation_time") or "")[:4]),
                    _coalesce(_first_named_value(row.get("assigned_ecu_udf")), str(row.get("assigned_ecu") or "").strip()),
                    _coalesce(_first_named_value(row.get("product_areas")), str(row.get("top_aida") or "").strip()),
                    str(row.get("aida_english") or "").strip(),
                    _coalesce(str(row.get("aida_businesskey") or "").strip(), str(row.get("aida_businesskey_udf") or "").strip()),
                    _coalesce(_first_named_value(row.get("solution_cluster_udf")), str(row.get("solution_cluster") or "").strip()),
                    _joined_named_values(row.get("product_areas")),
                    _coalesce(str(row.get("software_version") or "").strip(), str(row.get("software_version_udf") or "").strip()),
                    _coalesce(_joined_named_values(row.get("function_responsible1_udf")), str(row.get("function_responsible") or "").strip()),
                    _coalesce(_first_named_value(row.get("ecu_to_modul_udf")), str(row.get("ecu_to_modul") or "").strip()),
                )
            )

        self._upsert_rows(
            "octane_defects",
            (
                "defect_id", "name", "project", "market", "pu", "fv", "fvp", "team", "lead_model",
                "raw_json", "fetched_at", "description", "comments", "requirement", "requirements_json", "creation_time", "last_modified",
                "program", "author", "user_tags", "phase", "severity", "problem_severity", "owner",
                "detected_by", "detected_in_release", "vin", "ecu_no_of_changes", "parent_id",
                "parent_child_type", "relation_to", "test_week", "risk_score", "tqr", "blocking_reason",
                "error_occurrence", "solution_responsible", "reporting_class", "involved_i_step",
                "first_use_sop_of_function", "tolerated_count", "reprel_changes", "tproject",
                "function2modul", "model_series", "defect_category", "status_phase", "problem_finder_team",
                "year", "assigned_ecu", "top_aida", "aida_english", "aida_businesskey", "solution_cluster",
                "product_areas", "software_version", "function_responsible", "ecu_to_modul"
            ),
            payload,
            conflict_columns=("defect_id",),
        )
        self._conn.commit()
        return len(payload)

    def _history_event_rows_from_payload(
        self,
        *,
        defect_id: str,
        payload: dict[str, Any],
        team: str = "",
        min_event_timestamp: str | None = None,
        fetched_at: str | None = None,
        start_entry_index: int = 0,
    ) -> list[tuple[object, ...]]:
        normalized_defect_id = str(defect_id or "").strip()
        if not normalized_defect_id:
            return []
        resolved_fetched_at = fetched_at or _utc_now()
        min_timestamp = str(min_event_timestamp or "").strip()
        rows: list[tuple[object, ...]] = []
        for entry_index, entry in enumerate(list(payload.get("data") or [])):
            if not isinstance(entry, dict):
                continue
            event_timestamp = str(entry.get("timestamp") or "").strip()
            if min_timestamp and event_timestamp and event_timestamp < min_timestamp:
                continue
            stored_entry_index = int(start_entry_index) + len({row[9] for row in rows})
            change_set = list(entry.get("change_set") or [])
            if not change_set:
                row = (
                    normalized_defect_id,
                    event_timestamp,
                    "",
                    "",
                    "",
                    resolved_fetched_at,
                    str(entry.get("action") or "").strip(),
                    _coalesce(_nested_value(entry.get("user"), "full_name"), _nested_value(entry.get("user"), "name"), _scalar_text(entry.get("user"))),
                    team,
                    stored_entry_index,
                    0,
                    "",
                    "",
                )
                rows.append(row)
                continue
            for change_index, change in enumerate(change_set):
                if not isinstance(change, dict):
                    continue
                row = (
                    normalized_defect_id,
                    event_timestamp,
                    str(change.get("field_name") or "").strip(),
                    str(change.get("old_value") or "").strip(),
                    str(change.get("value") or change.get("new_value") or "").strip(),
                    resolved_fetched_at,
                    str(entry.get("action") or "").strip(),
                    _coalesce(_nested_value(entry.get("user"), "full_name"), _nested_value(entry.get("user"), "name"), _scalar_text(entry.get("user"))),
                    team,
                    stored_entry_index,
                    change_index,
                    str(change.get("old_value_text") or change.get("old_value") or "").strip(),
                    str(change.get("value_text") or change.get("new_value_text") or change.get("value") or "").strip(),
                )
                rows.append(row)

        return rows

    def _min_history_payload_timestamp(self, payload: dict[str, Any], *, min_event_timestamp: str | None = None) -> str:
        min_timestamp = str(min_event_timestamp or "").strip()
        timestamps = []
        for entry in list(payload.get("data") or []):
            if not isinstance(entry, dict):
                continue
            event_timestamp = str(entry.get("timestamp") or "").strip()
            if not event_timestamp:
                continue
            if min_timestamp and event_timestamp < min_timestamp:
                continue
            timestamps.append(event_timestamp)
        return min(timestamps) if timestamps else ""

    def _next_history_entry_index(self, defect_id: str) -> int:
        row = self._conn.execute(
            """
            SELECT MAX(COALESCE(entry_index, 0)) AS max_entry_index
            FROM octane_defect_history_events
            WHERE defect_id = ?
            """,
            (defect_id,),
        ).fetchone()
        if row is None or row["max_entry_index"] is None:
            return 0
        return int(row["max_entry_index"] or 0) + 1

    def _insert_history_event_rows(self, rows: list[tuple[object, ...]]) -> None:
        if not rows:
            return
        insert_columns = [
            "defect_id",
            "event_timestamp",
            "field_name",
            "old_value",
            "new_value",
            "fetched_at",
            "action",
            "user_name",
            "team",
            "entry_index",
            "change_index",
            "old_value_text",
            "new_value_text",
        ]
        placeholders = ", ".join("?" for _ in insert_columns)
        self._conn.executemany(
            f"INSERT INTO octane_defect_history_events({', '.join(insert_columns)}) VALUES ({placeholders})",
            rows,
        )

    def _record_history_refresh_state(self, *, defect_id: str, defect_last_modified: str = "") -> None:
        normalized_defect_id = str(defect_id or "").strip()
        if not normalized_defect_id:
            return
        row = self._conn.execute(
            """
            SELECT MAX(event_timestamp) AS last_history_event_timestamp
            FROM octane_defect_history_events
            WHERE defect_id = ?
            """,
            (normalized_defect_id,),
        ).fetchone()
        last_history_event_timestamp = str(row["last_history_event_timestamp"] or "").strip() if row else ""
        self._conn.execute(
            """
            INSERT INTO octane_defect_history_refresh_state(
                defect_id, defect_last_modified, last_history_event_timestamp, last_history_checked_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(defect_id) DO UPDATE SET
                defect_last_modified=excluded.defect_last_modified,
                last_history_event_timestamp=excluded.last_history_event_timestamp,
                last_history_checked_at=excluded.last_history_checked_at
            """,
            (normalized_defect_id, str(defect_last_modified or "").strip(), last_history_event_timestamp, _utc_now()),
        )

    def replace_defect_history_events(
        self,
        *,
        defect_id: str,
        payload: dict[str, Any],
        team: str = "",
        commit: bool = True,
    ) -> int:
        normalized_defect_id = str(defect_id or "").strip()
        if not normalized_defect_id:
            return 0
        rows = self._history_event_rows_from_payload(defect_id=normalized_defect_id, payload=payload, team=team)

        self._conn.execute("DELETE FROM octane_defect_history_events WHERE defect_id=?", (normalized_defect_id,))
        self._insert_history_event_rows(rows)
        self._record_history_refresh_state(defect_id=normalized_defect_id)
        if commit:
            self._conn.commit()
        return len(rows)

    def upsert_defect_history_events(
        self,
        *,
        defect_id: str,
        payload: dict[str, Any],
        team: str = "",
        modified_since: str | None = None,
        defect_last_modified: str = "",
        commit: bool = True,
    ) -> int:
        normalized_defect_id = str(defect_id or "").strip()
        if not normalized_defect_id:
            return 0
        normalized_since = str(modified_since or "").strip()
        delete_from_timestamp = self._min_history_payload_timestamp(
            payload,
            min_event_timestamp=normalized_since or None,
        )
        if normalized_since and delete_from_timestamp:
            self._conn.execute(
                """
                DELETE FROM octane_defect_history_events
                WHERE defect_id = ? AND COALESCE(event_timestamp, '') >= ?
                """,
                (normalized_defect_id, delete_from_timestamp),
            )
        elif not normalized_since:
            self._conn.execute("DELETE FROM octane_defect_history_events WHERE defect_id=?", (normalized_defect_id,))
        rows = self._history_event_rows_from_payload(
            defect_id=normalized_defect_id,
            payload=payload,
            team=team,
            min_event_timestamp=normalized_since or None,
            start_entry_index=self._next_history_entry_index(normalized_defect_id) if normalized_since else 0,
        )
        self._insert_history_event_rows(rows)
        self._record_history_refresh_state(defect_id=normalized_defect_id, defect_last_modified=defect_last_modified)
        if commit:
            self._conn.commit()
        return len(rows)

    def upsert_manual_runs(self, runs: list[dict[str, Any]], *, team: str, year: int | None = None, spec: str | None = None) -> int:
        run_ids = [str(row.get("id") or "").strip() for row in runs if str(row.get("id") or "").strip()]
        existing_rows = self._load_existing_rows("octane_manual_runs", "mr_id", run_ids)
        payload: list[tuple[object, ...]] = []
        fetched_at = _utc_now()
        for row in runs:
            mr_id = str(row.get("id") or "").strip()
            if not mr_id:
                continue
            existing = existing_rows.get(mr_id)
            incoming_team = _coalesce(_first_named_value(row.get("run_team_000_udf")), team)
            incoming_lead_model = _first_named_value(row.get("exec_model_series_udf"))
            payload.append(
                (
                    mr_id,
                    _nested_value(row.get("defect"), "id"),
                    _nested_value(row.get("test"), "id"),
                    _coalesce(str(row.get("test_name") or "").strip(), _nested_value(row.get("test"), "name"), str(row.get("name") or "").strip()),
                    _first_named_value(row.get("status")),
                    _coalesce(str(row.get("year") or "").strip(), str(year or ""), _release_name(row)[2:4] if _release_name(row).startswith("R-") else ""),
                    _preserve_dimension(existing, "test_week", ""),
                    _preserve_dimension(existing, "pu", _first_named_value(row.get("set_udf"))),
                    _preserve_dimension(existing, "top_aida", _first_named_value(row.get("product_areas"))),
                    _preserve_dimension(existing, "feature_region", ""),
                    _preserve_dimension(existing, "tester", _coalesce(_nested_value(row.get("run_by"), "full_name"), _nested_value(row.get("run_by"), "name"), _nested_value(row.get("author"), "full_name"), _nested_value(row.get("author"), "name"))),
                    _preserve_dimension(existing, "project", ""),
                    _preserve_dimension(existing, "fv", ""),
                    _preserve_dimension(existing, "fvp", ""),
                    _preserve_dimension(existing, "team", incoming_team),
                    _preserve_dimension(existing, "lead_model", incoming_lead_model),
                    _json_text(row),
                    fetched_at,
                    _coalesce(str(row.get("name") or "").strip(), str(row.get("test_name") or "").strip(), _nested_value(row.get("test"), "name")),
                    incoming_team,
                    _first_named_value(row.get("program")),
                    _coalesce(_nested_value(row.get("author"), "full_name"), _nested_value(row.get("author"), "name"), _scalar_text(row.get("author"))),
                    _coalesce(_nested_value(row.get("run_by"), "full_name"), _nested_value(row.get("run_by"), "name")),
                    _scalar_text(row.get("native_status")),
                    _scalar_text(row.get("is_completed")),
                    _scalar_text(row.get("steps_num")),
                    _scalar_text(row.get("version_stamp")),
                    _release_name(row),
                    incoming_lead_model,
                    _scalar_text(row.get("execution_sw_version")),
                    _first_named_value(row.get("test_version")),
                    _first_named_value(row.get("domain")),
                    _first_named_value(row.get("test_phase")),
                    _first_named_value(row.get("testing_tool_type")),
                    _joined_named_values(row.get("taxonomies")),
                    _coalesce(_first_named_value(row.get("set_udf")), _scalar_text(row.get("set_field"))),
                    _scalar_text(row.get("testplatformid")),
                    str(spec or "").strip(),
                    str(row.get("creation_time") or "").strip(),
                    str(row.get("last_modified") or "").strip(),
                    str(row.get("started") or "").strip(),
                    _coalesce(str(row.get("finished") or "").strip(), str(row.get("finished_udf") or "").strip()),
                    _joined_named_values(row.get("product_areas")),
                    _coalesce(str(row.get("target_ecu_conf") or "").strip(), str(row.get("target_ecu_conf_udf") or "").strip()),
                )
            )

        self._upsert_rows(
            "octane_manual_runs",
            (
                "mr_id", "defect_id", "test_id", "test_name", "status", "year", "test_week", "pu",
                "top_aida", "feature_region", "tester", "project", "fv", "fvp", "team", "lead_model",
                "raw_json", "fetched_at", "name", "run_team", "program", "author", "run_by",
                "native_status", "is_completed", "steps_num", "version_stamp", "release",
                "exec_model_series", "execution_sw_version", "test_version", "domain", "test_phase",
                "testing_tool_type", "taxonomies", "set_field", "testplatformid", "spec",
                "creation_time", "last_modified", "started", "finished", "product_areas", "target_ecu_conf"
            ),
            payload,
            conflict_columns=("mr_id",),
        )
        self._conn.commit()
        return len(payload)

    def rebuild_testcases_from_runs(self, runs: list[dict[str, Any]], *, team: str, source: str = "manual_runs") -> dict[str, int]:
        grouped: dict[tuple[str, str], dict[str, Any]] = {}
        relation_rows: list[tuple[object, ...]] = []
        fetched_at = _utc_now()

        for row in runs:
            test_id = _nested_value(row.get("test"), "id")
            if not test_id:
                continue
            scope_release = _release_name(row)
            group_key = (test_id, scope_release)
            bucket = grouped.setdefault(
                group_key,
                {
                    "test_name": _coalesce(str(row.get("test_name") or "").strip(), _nested_value(row.get("test"), "name")),
                    "test_subtype": _nested_value(row.get("test"), "subtype"),
                    "defect_ids": set(),
                    "feature_ids": set(),
                    "story_ids": set(),
                    "manual_test_ids": set(),
                    "run_ids": [],
                    "run_status_distribution": {},
                    "runs": [],
                },
            )
            bucket["run_ids"].append(str(row.get("id") or "").strip())
            status_name = _first_named_value(row.get("status"))
            if status_name:
                bucket["run_status_distribution"][status_name] = int(bucket["run_status_distribution"].get(status_name, 0)) + 1
            defect_id = _nested_value(row.get("defect"), "id")
            if defect_id:
                bucket["defect_ids"].add(defect_id)
                relation_rows.append((test_id, team, scope_release, source, "defect", defect_id, defect_id, "defect", "", fetched_at))

            manual_test_id = _nested_value(row.get("covered_manual_test"), "id")
            if manual_test_id:
                bucket["manual_test_ids"].add(manual_test_id)

            for item in list(row.get("related_work_items") or []):
                if not isinstance(item, dict):
                    continue
                related_id = str(item.get("id") or "").strip()
                related_subtype = _normalize_relation_subtype(item.get("subtype"))
                bucket_key = _relation_bucket_key(related_subtype)
                if not related_id or bucket_key is None:
                    continue
                bucket[bucket_key].add(related_id)
                relation_rows.append(
                    (
                        test_id,
                        team,
                        scope_release,
                        source,
                        related_subtype,
                        related_id,
                        str(item.get("name") or "").strip(),
                        related_subtype,
                        str(item.get("path") or "").strip(),
                        fetched_at,
                    )
                )
            bucket["runs"].append(row)

        testcase_rows = [
            (
                test_id,
                team,
                scope_release,
                source,
                str(bucket["test_name"] or "").strip(),
                str(bucket["test_subtype"] or "").strip(),
                len(bucket["runs"]),
                _json_text(bucket["run_ids"]),
                _json_text(bucket["run_status_distribution"]),
                _json_text(sorted(bucket["defect_ids"])),
                _json_text(sorted(bucket["manual_test_ids"])),
                _json_text(sorted(bucket["feature_ids"])),
                _json_text(sorted(bucket["story_ids"])),
                _json_text(bucket["runs"]),
                fetched_at,
            )
            for (test_id, scope_release), bucket in grouped.items()
        ]

        if testcase_rows:
            self._upsert_rows(
                "octane_testcases",
                (
                    "test_id", "scope_team", "scope_release", "source", "test_name", "test_subtype",
                    "run_count", "run_ids_json", "run_status_distribution_json", "defect_ids_json",
                    "manual_test_ids_json", "feature_ids_json", "story_ids_json", "raw_json", "fetched_at"
                ),
                testcase_rows,
                conflict_columns=("test_id", "scope_team", "scope_release", "source"),
            )
        if relation_rows:
            self._upsert_rows(
                "octane_testcase_relations",
                (
                    "test_id", "scope_team", "scope_release", "source", "relation_type",
                    "related_id", "related_name", "related_subtype", "related_path", "fetched_at"
                ),
                relation_rows,
                conflict_columns=("test_id", "scope_team", "scope_release", "source", "relation_type", "related_id"),
            )
        self._conn.commit()
        return {
            "testcase_rows": len(testcase_rows),
            "relation_rows": len(relation_rows),
        }

    def _load_existing_rows(self, table_name: str, key_name: str, values: list[str]) -> dict[str, sqlite3.Row]:
        if not values:
            return {}
        loaded_rows: dict[str, sqlite3.Row] = {}
        for start in range(0, len(values), SQLITE_MAX_QUERY_VARIABLES):
            batch = values[start:start + SQLITE_MAX_QUERY_VARIABLES]
            placeholders = ",".join("?" for _ in batch)
            rows = self._conn.execute(
                f"SELECT * FROM {table_name} WHERE {key_name} IN ({placeholders})",
                batch,
            ).fetchall()
            loaded_rows.update({str(row[key_name]): row for row in rows})
        return loaded_rows