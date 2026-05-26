from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import json
import re
import sqlite3


OUTCOME_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS defect_outcomes (
	defect_id TEXT NOT NULL PRIMARY KEY,
    is_resolved_forward INTEGER NOT NULL,
    is_rejected_directly INTEGER NOT NULL,
    resolved_forward_at TEXT,
    rejected_directly_at TEXT,
    source_history_event_count INTEGER NOT NULL,
    source_signature TEXT NOT NULL,
    derived_at TEXT NOT NULL
);
"""


def ensure_outcome_store(db_path: Path | str) -> Path:
	resolved_path = Path(db_path)
	resolved_path.parent.mkdir(parents=True, exist_ok=True)
	conn = sqlite3.connect(resolved_path)
	try:
		conn.executescript(OUTCOME_SCHEMA_SQL)
		conn.commit()
	finally:
		conn.close()
	return resolved_path


def _open_read_only_connection(db_path: Path | str) -> sqlite3.Connection:
	conn = sqlite3.connect(f"{Path(db_path).resolve().as_uri()}?mode=ro", uri=True)
	conn.row_factory = sqlite3.Row
	return conn


def _compute_source_signature(db_path: Path | str) -> str:
	resolved_path = Path(db_path).resolve()
	stat_result = resolved_path.stat()
	return f"{resolved_path}|{stat_result.st_size}|{stat_result.st_mtime_ns}"


def _extract_phase_code(raw_value: object) -> str | None:
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


def _extract_preferred_phase_code(*values: object) -> str:
	for value in values:
		code = _extract_phase_code(value)
		if code:
			return code
	return ""


def _coerce_json_object(raw_value: object) -> dict[str, object]:
	if isinstance(raw_value, dict):
		return raw_value
	if not isinstance(raw_value, str) or not raw_value.strip():
		return {}
	try:
		parsed = json.loads(raw_value)
	except (TypeError, ValueError, json.JSONDecodeError):
		return {}
	return parsed if isinstance(parsed, dict) else {}


def _row_value(row: sqlite3.Row, key: str) -> object:
	return row[key] if key in row.keys() else None


def _derive_outcome_rows(source_db_path: Path | str, source_signature: str) -> list[tuple[object, ...]]:
	conn = _open_read_only_connection(source_db_path)
	try:
		rows = conn.execute(
			"""
			SELECT *
			FROM octane_defect_history_events
			WHERE lower(COALESCE(field_name, '')) LIKE '%phase%'
			ORDER BY defect_id, event_timestamp
			"""
		).fetchall()
	finally:
		conn.close()

	derived_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
	per_defect: dict[str, dict[str, object]] = {}
	for row in rows:
		defect_id = str(_row_value(row, "defect_id") or "").strip()
		if not defect_id:
			continue
		payload = _coerce_json_object(_row_value(row, "raw_event_json"))
		old_code = _extract_preferred_phase_code(
			_row_value(row, "old_value_text"),
			payload.get("old_value_text"),
			_row_value(row, "old_value"),
			payload.get("old_value"),
		)
		new_code = _extract_preferred_phase_code(
			_row_value(row, "new_value_text"),
			payload.get("new_value_text"),
			_row_value(row, "new_value"),
			payload.get("new_value"),
		)
		bucket = per_defect.setdefault(
			defect_id,
			{
				"is_resolved_forward": 0,
				"is_rejected_directly": 0,
				"resolved_forward_at": None,
				"rejected_directly_at": None,
				"source_history_event_count": 0,
			},
		)
		bucket["source_history_event_count"] = int(bucket["source_history_event_count"]) + 1
		event_timestamp = _row_value(row, "event_timestamp")
		if old_code == "08" and new_code == "06":
			bucket["is_resolved_forward"] = 1
			if bucket["resolved_forward_at"] is None:
				bucket["resolved_forward_at"] = event_timestamp
		if old_code == "01" and new_code == "09":
			bucket["is_rejected_directly"] = 1
			if bucket["rejected_directly_at"] is None:
				bucket["rejected_directly_at"] = event_timestamp

	return [
		(
			defect_id,
			int(values["is_resolved_forward"]),
			int(values["is_rejected_directly"]),
			values["resolved_forward_at"],
			values["rejected_directly_at"],
			int(values["source_history_event_count"]),
			source_signature,
			derived_at,
		)
		for defect_id, values in per_defect.items()
	]


def refresh_materialized_outcomes(
	source_db_path: Path | str,
	hot_db_path: Path | str,
	force: bool = False,
) -> dict[str, object]:
	resolved_hot_path = ensure_outcome_store(hot_db_path)
	source_signature = _compute_source_signature(source_db_path)

	hot_conn = sqlite3.connect(resolved_hot_path)
	try:
		existing_signatures = {
			row[0]
			for row in hot_conn.execute(
				"SELECT DISTINCT source_signature FROM defect_outcomes"
			).fetchall()
			if row[0]
		}
		existing_row_count_row = hot_conn.execute(
			"SELECT COUNT(*) FROM defect_outcomes"
		).fetchone()
		existing_row_count = int(existing_row_count_row[0] or 0) if existing_row_count_row else 0
		if not force and existing_signatures == {source_signature}:
			return {
				"row_count": existing_row_count,
				"skipped": True,
				"source_signature": source_signature,
			}

		derived_rows = _derive_outcome_rows(source_db_path, source_signature)
		hot_conn.execute("DELETE FROM defect_outcomes")
		hot_conn.executemany(
			"""
			INSERT INTO defect_outcomes(
				defect_id,
				is_resolved_forward,
				is_rejected_directly,
				resolved_forward_at,
				rejected_directly_at,
				source_history_event_count,
				source_signature,
				derived_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			""",
			derived_rows,
		)
		hot_conn.commit()
	finally:
		hot_conn.close()

	return {
		"row_count": len(derived_rows),
		"skipped": False,
		"source_signature": source_signature,
	}


def load_materialized_outcomes(
	hot_db_path: Path | str,
	defect_ids: tuple[str, ...] | list[str],
) -> dict[str, dict[str, object]]:
	resolved_hot_path = Path(hot_db_path)
	if not resolved_hot_path.exists():
		raise FileNotFoundError(resolved_hot_path)

	requested_ids = [str(defect_id) for defect_id in defect_ids]
	default_row = {
		"is_resolved_forward": False,
		"is_rejected_directly": False,
		"resolved_forward_at": None,
		"rejected_directly_at": None,
		"source_history_event_count": 0,
	}
	loaded = {defect_id: dict(default_row) for defect_id in requested_ids}
	if not requested_ids:
		return loaded

	conn = sqlite3.connect(resolved_hot_path)
	conn.row_factory = sqlite3.Row
	try:
		placeholders = ", ".join("?" for _ in requested_ids)
		rows = conn.execute(
			f"""
			SELECT defect_id, is_resolved_forward, is_rejected_directly,
			       resolved_forward_at, rejected_directly_at, source_history_event_count
			FROM defect_outcomes
			WHERE defect_id IN ({placeholders})
			""",
			requested_ids,
		).fetchall()
	finally:
		conn.close()

	for row in rows:
		loaded[str(row["defect_id"])] = {
			"is_resolved_forward": bool(row["is_resolved_forward"]),
			"is_rejected_directly": bool(row["is_rejected_directly"]),
			"resolved_forward_at": row["resolved_forward_at"],
			"rejected_directly_at": row["rejected_directly_at"],
			"source_history_event_count": int(row["source_history_event_count"] or 0),
		}

	return loaded