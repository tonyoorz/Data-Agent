from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.analytics.schema import ensure_schema


DEFECT_ADDITIONAL_COLUMNS: dict[str, str] = {
    "description": "TEXT",
    "comments": "TEXT",
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
    "team": "TEXT",
    "entry_index": "INTEGER",
    "change_index": "INTEGER",
    "old_value_text": "TEXT",
    "new_value_text": "TEXT",
}

MANUAL_RUN_EXTRA_COLUMNS: dict[str, str] = {
    "creation_time": "TEXT",
    "last_modified": "TEXT",
    "started": "TEXT",
    "finished": "TEXT",
    "product_areas": "TEXT",
    "target_ecu_conf": "TEXT",
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


def _preserve_dimension(existing: sqlite3.Row | None, column_name: str, incoming: str) -> str:
    if existing is None:
        return incoming
    current = str(existing[column_name] or "").strip()
    return current if not _is_missing_dimension(current) else incoming


class OctaneSourceStore:
    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path)
        self._conn.row_factory = sqlite3.Row

    def close(self) -> None:
        self._conn.close()

    def create_tables(self) -> None:
        ensure_schema(self.db_path)
        self._ensure_columns("octane_defects", DEFECT_ADDITIONAL_COLUMNS)
        self._ensure_columns("octane_defect_history_events", HISTORY_ADDITIONAL_COLUMNS)
        self._ensure_columns("octane_manual_runs", MANUAL_RUN_EXTRA_COLUMNS)
        self._conn.commit()

    def _ensure_columns(self, table_name: str, columns: dict[str, str]) -> None:
        existing_columns = {
            str(row[1]).strip()
            for row in self._conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        }
        for column_name, column_type in columns.items():
            if column_name in existing_columns:
                continue
            self._conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")

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

        self._conn.executemany(
            """
            INSERT OR REPLACE INTO octane_defects(
                defect_id, name, project, market, pu, fv, fvp, team, lead_model,
                raw_json, fetched_at, description, comments, status_phase,
                problem_finder_team, year, assigned_ecu, top_aida, aida_english,
                aida_businesskey, solution_cluster, product_areas, software_version,
                function_responsible, ecu_to_modul
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            payload,
        )
        self._conn.commit()
        return len(payload)

    def replace_defect_history_events(self, *, defect_id: str, payload: dict[str, Any], team: str = "") -> int:
        normalized_defect_id = str(defect_id or "").strip()
        if not normalized_defect_id:
            return 0
        fetched_at = _utc_now()
        rows: list[tuple[object, ...]] = []
        for entry_index, entry in enumerate(list(payload.get("data") or [])):
            if not isinstance(entry, dict):
                continue
            change_set = list(entry.get("change_set") or [])
            if not change_set:
                rows.append(
                    (
                        normalized_defect_id,
                        str(entry.get("timestamp") or "").strip(),
                        "",
                        "",
                        "",
                        _json_text(entry),
                        fetched_at,
                        team,
                        entry_index,
                        0,
                        "",
                        "",
                    )
                )
                continue
            for change_index, change in enumerate(change_set):
                if not isinstance(change, dict):
                    continue
                rows.append(
                    (
                        normalized_defect_id,
                        str(entry.get("timestamp") or "").strip(),
                        str(change.get("field_name") or "").strip(),
                        str(change.get("old_value") or "").strip(),
                        str(change.get("value") or change.get("new_value") or "").strip(),
                        _json_text(change),
                        fetched_at,
                        team,
                        entry_index,
                        change_index,
                        str(change.get("old_value_text") or change.get("old_value") or "").strip(),
                        str(change.get("value_text") or change.get("new_value_text") or change.get("value") or "").strip(),
                    )
                )

        self._conn.execute("DELETE FROM octane_defect_history_events WHERE defect_id=?", (normalized_defect_id,))
        if rows:
            self._conn.executemany(
                """
                INSERT INTO octane_defect_history_events(
                    defect_id, event_timestamp, field_name, old_value, new_value,
                    raw_event_json, fetched_at, team, entry_index, change_index,
                    old_value_text, new_value_text
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        self._conn.commit()
        return len(rows)

    def upsert_manual_runs(self, runs: list[dict[str, Any]], *, team: str, year: int | None = None) -> int:
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
                    str(row.get("creation_time") or "").strip(),
                    str(row.get("last_modified") or "").strip(),
                    str(row.get("started") or "").strip(),
                    _coalesce(str(row.get("finished") or "").strip(), str(row.get("finished_udf") or "").strip()),
                    _joined_named_values(row.get("product_areas")),
                    _coalesce(str(row.get("target_ecu_conf") or "").strip(), str(row.get("target_ecu_conf_udf") or "").strip()),
                )
            )

        self._conn.executemany(
            """
            INSERT OR REPLACE INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week, pu,
                top_aida, feature_region, tester, project, fv, fvp, team,
                lead_model, raw_json, fetched_at, creation_time, last_modified,
                started, finished, product_areas, target_ecu_conf
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            payload,
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
                    "defect_ids": set(),
                    "feature_ids": set(),
                    "story_ids": set(),
                    "runs": [],
                },
            )
            defect_id = _nested_value(row.get("defect"), "id")
            if defect_id:
                bucket["defect_ids"].add(defect_id)
                relation_rows.append((test_id, team, scope_release, source, "defect", defect_id, defect_id, fetched_at))
            bucket["runs"].append(row)

        testcase_rows = [
            (
                test_id,
                team,
                scope_release,
                source,
                str(bucket["test_name"] or "").strip(),
                len(bucket["runs"]),
                _json_text(sorted(bucket["defect_ids"])),
                _json_text(sorted(bucket["feature_ids"])),
                _json_text(sorted(bucket["story_ids"])),
                _json_text(bucket["runs"]),
                fetched_at,
            )
            for (test_id, scope_release), bucket in grouped.items()
        ]

        if testcase_rows:
            self._conn.executemany(
                """
                INSERT OR REPLACE INTO octane_testcases(
                    test_id, scope_team, scope_release, source, test_name, run_count,
                    defect_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                testcase_rows,
            )
        if relation_rows:
            self._conn.executemany(
                """
                INSERT OR REPLACE INTO octane_testcase_relations(
                    test_id, scope_team, scope_release, source, relation_type,
                    related_id, related_name, fetched_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                relation_rows,
            )
        self._conn.commit()
        return {
            "testcase_rows": len(testcase_rows),
            "relation_rows": len(relation_rows),
        }

    def _load_existing_rows(self, table_name: str, key_name: str, values: list[str]) -> dict[str, sqlite3.Row]:
        if not values:
            return {}
        placeholders = ",".join("?" for _ in values)
        rows = self._conn.execute(
            f"SELECT * FROM {table_name} WHERE {key_name} IN ({placeholders})",
            values,
        ).fetchall()
        return {str(row[key_name]): row for row in rows}