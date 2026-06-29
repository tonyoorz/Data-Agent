from pathlib import Path
import sqlite3

import pytest

from backend.analytics.config import (
	DEFAULT_FULL_PICTURE_SOURCE_DB_PATH,
	DEFAULT_FULL_PICTURE_HOT_DB_PATH,
	get_full_picture_defect_db_candidates,
	get_full_picture_history_db_candidates,
	get_full_picture_hot_db_path,
	get_full_picture_source_db_path,
)
from backend.analytics.full_picture_outcomes import (
	ensure_outcome_store,
	load_materialized_outcomes,
	refresh_materialized_outcomes,
)


def _seed_history_events(db_path: Path, rows: list[tuple[object, ...]]) -> None:
	conn = sqlite3.connect(db_path)
	try:
		conn.executescript(
			"""
			CREATE TABLE octane_defect_history_events (
				defect_id TEXT,
				field_name TEXT,
				event_timestamp TEXT,
				entry_index INTEGER,
				change_index INTEGER,
				old_value TEXT,
				new_value TEXT,
				old_value_text TEXT,
				new_value_text TEXT
			);
			"""
		)
		conn.executemany(
			"""
			INSERT INTO octane_defect_history_events(
				defect_id, field_name, event_timestamp, entry_index, change_index,
				old_value, new_value, old_value_text, new_value_text
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			""",
			rows,
		)
		conn.commit()
	finally:
		conn.close()


def test_full_picture_hot_db_path_defaults_to_repo_database_hot(monkeypatch):
	monkeypatch.delenv("VIZION_FULL_PICTURE_HOT_DB_PATH", raising=False)

	monkeypatch.delenv("VIZION_DATABASE_ROOT", raising=False)
	assert get_full_picture_hot_db_path() == DEFAULT_FULL_PICTURE_HOT_DB_PATH

	monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", "   \t  ")
	assert get_full_picture_hot_db_path() == DEFAULT_FULL_PICTURE_HOT_DB_PATH

	monkeypatch.setenv("VIZION_DATABASE_ROOT", "   \t  ")
	monkeypatch.delenv("VIZION_FULL_PICTURE_HOT_DB_PATH", raising=False)
	assert get_full_picture_hot_db_path() == DEFAULT_FULL_PICTURE_HOT_DB_PATH

	custom_root = Path("/custom-root")
	monkeypatch.setenv("VIZION_DATABASE_ROOT", str(custom_root))
	assert get_full_picture_hot_db_path() == custom_root / "hot" / "vizion_serving.db"


def test_full_picture_source_db_path_defaults_to_repo_database_source(monkeypatch):
	monkeypatch.delenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", raising=False)

	monkeypatch.delenv("VIZION_DATABASE_ROOT", raising=False)
	assert get_full_picture_source_db_path() == DEFAULT_FULL_PICTURE_SOURCE_DB_PATH

	monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", "   \t  ")
	assert get_full_picture_source_db_path() == DEFAULT_FULL_PICTURE_SOURCE_DB_PATH

	monkeypatch.setenv("VIZION_DATABASE_ROOT", "   \t  ")
	monkeypatch.delenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", raising=False)
	assert get_full_picture_source_db_path() == DEFAULT_FULL_PICTURE_SOURCE_DB_PATH

	custom_root = Path("/custom-root")
	monkeypatch.setenv("VIZION_DATABASE_ROOT", str(custom_root))
	assert get_full_picture_source_db_path() == custom_root / "source" / "qgate_raw.db"


def test_full_picture_candidates_prefer_local_source_copy(monkeypatch, tmp_path):
	local_database_root = tmp_path / "database"
	local_source = local_database_root / "source" / "qgate_raw.db"

	monkeypatch.setenv("VIZION_DATABASE_ROOT", str(local_database_root))
	monkeypatch.delenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", raising=False)
	monkeypatch.delenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", raising=False)

	assert get_full_picture_defect_db_candidates() == (local_source,)
	assert get_full_picture_history_db_candidates() == (local_source,)


def test_full_picture_candidates_respect_explicit_overrides(monkeypatch, tmp_path):
	defect_db = tmp_path / "custom" / "defects.db"
	history_db = tmp_path / "custom" / "history.db"

	monkeypatch.setenv("VIZION_FULL_PICTURE_DEFECT_DB_PATH", str(defect_db))
	monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(history_db))

	assert get_full_picture_defect_db_candidates() == (defect_db,)
	assert get_full_picture_history_db_candidates() == (history_db,)


def test_ensure_outcome_store_creates_parent_dirs_and_table(tmp_path):
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

	ensure_outcome_store(hot_db)

	conn = sqlite3.connect(hot_db)
	try:
		tables = {
			row[0]
			for row in conn.execute(
				"SELECT name FROM sqlite_master WHERE type='table'"
			).fetchall()
		}
		columns = {
			row[1]: {"notnull": bool(row[3]), "pk": row[5]}
			for row in conn.execute("PRAGMA table_info(defect_outcomes)").fetchall()
		}
		refresh_state_columns = {
			row[1]: {"notnull": bool(row[3]), "pk": row[5]}
			for row in conn.execute("PRAGMA table_info(outcome_refresh_state)").fetchall()
		}
	finally:
		conn.close()

	assert {"defect_outcomes", "outcome_refresh_state"}.issubset(tables)
	assert {
		"defect_id",
		"is_resolved_forward",
		"is_rejected_directly",
		"resolved_forward_at",
		"rejected_directly_at",
		"source_history_event_count",
		"source_signature",
		"derived_at",
	}.issubset(columns)
	assert columns["defect_id"]["pk"] == 1
	assert columns["is_resolved_forward"]["notnull"] is True
	assert columns["is_rejected_directly"]["notnull"] is True
	assert columns["source_history_event_count"]["notnull"] is True
	assert columns["source_signature"]["notnull"] is True
	assert columns["derived_at"]["notnull"] is True
	assert {
		"store_name",
		"source_signature",
		"outcome_row_count",
		"refreshed_at",
	}.issubset(refresh_state_columns)
	assert refresh_state_columns["store_name"]["pk"] == 1
	assert refresh_state_columns["source_signature"]["notnull"] is True
	assert refresh_state_columns["outcome_row_count"]["notnull"] is True
	assert refresh_state_columns["refreshed_at"]["notnull"] is True


def test_ensure_outcome_store_rejects_null_defect_id(tmp_path):
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

	ensure_outcome_store(hot_db)

	conn = sqlite3.connect(hot_db)
	try:
		with pytest.raises(sqlite3.IntegrityError):
			conn.execute(
				"""
				INSERT INTO defect_outcomes (
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
				(None, 0, 0, None, None, 0, "sig", "2026-05-26T00:00:00Z"),
			)
	finally:
		conn.close()


def test_refresh_materialized_outcomes_derives_transition_flags(tmp_path):
	source_db = tmp_path / "qgate_data.db"
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
	_seed_history_events(
		source_db,
		[
			(
				"D-1",
				"status_phase",
				"2026-05-25T00:00:00Z",
				1,
				1,
				"08",
				"06",
				"08-Resolved Forward",
				"06-Ready for Test",
			),
			(
				"D-1",
				"phase",
				"2026-05-26T00:00:00Z",
				2,
				1,
				"01",
				"03",
				"01-New",
				"03-In Analysis",
			),
			(
				"D-2",
				"workflow_phase",
				"2026-05-27T00:00:00Z",
				1,
				1,
				"01",
				"09",
				"01-New",
				"09-Rejected",
			),
			(
				"D-3",
				"owner",
				"2026-05-28T00:00:00Z",
				1,
				1,
				"alice",
				"bob",
				"alice",
				"bob",
			),
		],
	)

	summary = refresh_materialized_outcomes(source_db, hot_db, force=True)
	loaded = load_materialized_outcomes(hot_db, ("D-1", "D-2", "D-3", "D-404"))

	assert summary["row_count"] == 2
	assert summary["skipped"] is False
	assert isinstance(summary["source_signature"], str)

	assert loaded["D-1"] == {
		"is_resolved_forward": True,
		"is_rejected_directly": False,
		"resolved_forward_at": "2026-05-25T00:00:00Z",
		"rejected_directly_at": None,
		"source_history_event_count": 2,
	}
	assert loaded["D-2"] == {
		"is_resolved_forward": False,
		"is_rejected_directly": True,
		"resolved_forward_at": None,
		"rejected_directly_at": "2026-05-27T00:00:00Z",
		"source_history_event_count": 1,
	}
	assert loaded["D-3"] == {
		"is_resolved_forward": False,
		"is_rejected_directly": False,
		"resolved_forward_at": None,
		"rejected_directly_at": None,
		"source_history_event_count": 0,
	}
	assert loaded["D-404"] == {
		"is_resolved_forward": False,
		"is_rejected_directly": False,
		"resolved_forward_at": None,
		"rejected_directly_at": None,
		"source_history_event_count": 0,
	}


def test_refresh_materialized_outcomes_prefers_text_fields_over_raw_values(tmp_path):
	source_db = tmp_path / "qgate_data.db"
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
	_seed_history_events(
		source_db,
		[
			(
				"D-TEXT",
				"status_phase",
				"2026-05-25T00:00:00Z",
				1,
				1,
				"ticket 99 moved from queue 12",
				"owner 34 requested build 56",
				"08-Resolved Forward",
				"06-Ready for Test",
			),
		],
	)

	refresh_materialized_outcomes(source_db, hot_db, force=True)
	loaded = load_materialized_outcomes(hot_db, ("D-TEXT",))

	assert loaded["D-TEXT"] == {
		"is_resolved_forward": True,
		"is_rejected_directly": False,
		"resolved_forward_at": "2026-05-25T00:00:00Z",
		"rejected_directly_at": None,
		"source_history_event_count": 1,
	}


def test_refresh_materialized_outcomes_ignores_non_phase_numeric_noise(tmp_path):
	source_db = tmp_path / "qgate_data.db"
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
	_seed_history_events(
		source_db,
		[
			(
				"D-NOISE",
				"status_phase",
				"2026-05-25T00:00:00Z",
				1,
				1,
				"owner 08 assigned to team 21",
				"priority 06 set for release 33",
				"",
				"",
			),
		],
	)

	summary = refresh_materialized_outcomes(source_db, hot_db, force=True)
	loaded = load_materialized_outcomes(hot_db, ("D-NOISE",))

	assert summary["row_count"] == 1
	assert loaded["D-NOISE"] == {
		"is_resolved_forward": False,
		"is_rejected_directly": False,
		"resolved_forward_at": None,
		"rejected_directly_at": None,
		"source_history_event_count": 1,
	}


def test_refresh_materialized_outcomes_skips_when_source_signature_matches(tmp_path):
	source_db = tmp_path / "qgate_data.db"
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
	_seed_history_events(
		source_db,
		[
			(
				"D-1",
				"status_phase",
				"2026-05-25T00:00:00Z",
				1,
				1,
				"08",
				"06",
				"08-Resolved Forward",
				"06-Ready for Test",
			),
		],
	)

	first = refresh_materialized_outcomes(source_db, hot_db, force=True)
	second = refresh_materialized_outcomes(source_db, hot_db, force=False)

	assert first["row_count"] == 1
	assert first["skipped"] is False
	assert second == {
		"row_count": 1,
		"skipped": True,
		"source_signature": first["source_signature"],
	}


def test_refresh_materialized_outcomes_rebuilds_when_source_signature_changes(tmp_path):
	source_db = tmp_path / "qgate_data.db"
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
	_seed_history_events(
		source_db,
		[
			(
				"D-1",
				"status_phase",
				"2026-05-25T00:00:00Z",
				1,
				1,
				"08",
				"06",
				"08-Resolved Forward",
				"06-Ready for Test",
			),
		],
	)

	first = refresh_materialized_outcomes(source_db, hot_db, force=True)

	conn = sqlite3.connect(source_db)
	try:
		conn.execute(
			"""
			INSERT INTO octane_defect_history_events(
				defect_id, field_name, event_timestamp, entry_index, change_index,
				old_value, new_value, old_value_text, new_value_text
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			""",
			(
				"D-2",
				"status_phase",
				"2026-05-26T00:00:00Z",
				1,
				1,
				"01",
				"09",
				"01-New",
				"09-Rejected",
			),
		)
		conn.commit()
	finally:
		conn.close()

	second = refresh_materialized_outcomes(source_db, hot_db, force=False)
	loaded = load_materialized_outcomes(hot_db, ("D-1", "D-2"))

	assert second["skipped"] is False
	assert second["row_count"] == 2
	assert second["source_signature"] != first["source_signature"]
	assert loaded["D-1"]["is_resolved_forward"] is True
	assert loaded["D-2"]["is_rejected_directly"] is True


def test_refresh_materialized_outcomes_can_update_selected_defects(tmp_path):
	source_db = tmp_path / "qgate_data.db"
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
	_seed_history_events(
		source_db,
		[
			(
				"D-1",
				"status_phase",
				"2026-05-25T00:00:00Z",
				1,
				1,
				"08",
				"06",
				"08-Resolved Forward",
				"06-Ready for Test",
			),
			(
				"D-2",
				"status_phase",
				"2026-05-26T00:00:00Z",
				1,
				1,
				"01",
				"03",
				"01-New",
				"03-In Analysis",
			),
		],
	)

	first = refresh_materialized_outcomes(source_db, hot_db, force=True)

	conn = sqlite3.connect(source_db)
	try:
		conn.execute("DELETE FROM octane_defect_history_events WHERE defect_id = 'D-2'")
		conn.execute(
			"""
			INSERT INTO octane_defect_history_events(
				defect_id, field_name, event_timestamp, entry_index, change_index,
				old_value, new_value, old_value_text, new_value_text
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			""",
			(
				"D-2",
				"status_phase",
				"2026-05-27T00:00:00Z",
				1,
				1,
				"01",
				"09",
				"01-New",
				"09-Rejected",
			),
		)
		conn.commit()
	finally:
		conn.close()

	second = refresh_materialized_outcomes(source_db, hot_db, force=False, defect_ids=("D-2",))
	loaded = load_materialized_outcomes(hot_db, ("D-1", "D-2"))

	assert first["row_count"] == 2
	assert second["skipped"] is False
	assert second["incremental"] is True
	assert second["updated_row_count"] == 1
	assert second["row_count"] == 2
	assert loaded["D-1"]["is_resolved_forward"] is True
	assert loaded["D-2"]["is_rejected_directly"] is True


def test_refresh_materialized_outcomes_can_update_selected_snapshot_rows(tmp_path):
	source_db = tmp_path / "qgate_data.db"
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
	_seed_history_events(
		source_db,
		[
			("D-1", "status_phase", "2026-05-25T00:00:00Z", 1, 1, "08", "06", "08-Resolved Forward", "06-Ready for Test"),
			("D-2", "status_phase", "2026-05-26T00:00:00Z", 1, 1, "01", "03", "01-New", "03-In Analysis"),
		],
	)
	conn = sqlite3.connect(source_db)
	try:
		conn.executescript(
			"""
			CREATE TABLE octane_defects (
				defect_id TEXT PRIMARY KEY,
				name TEXT,
				status_phase TEXT,
				creation_time TEXT,
				problem_finder_team TEXT,
				year TEXT,
				project TEXT
			);
			"""
		)
		conn.executemany(
			"INSERT INTO octane_defects(defect_id, name, status_phase, creation_time, problem_finder_team, year, project) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				("D-1", "Original D1", "06-Ready for Test", "2026-05-25T00:00:00Z", "DTSV_China", "2026", "IDCEVO"),
				("D-2", "Original D2", "03-In Analysis", "2026-05-26T00:00:00Z", "DTSV_China", "2026", "IDCEVO"),
			],
		)
		conn.commit()
	finally:
		conn.close()

	refresh_materialized_outcomes(source_db, hot_db, force=True)
	conn = sqlite3.connect(source_db)
	try:
		conn.execute("UPDATE octane_defects SET name='Updated D2' WHERE defect_id='D-2'")
		conn.commit()
	finally:
		conn.close()

	second = refresh_materialized_outcomes(source_db, hot_db, force=False, defect_ids=("D-2",))

	assert second["incremental"] is True

	conn = sqlite3.connect(hot_db)
	try:
		latest_snapshot_version = conn.execute(
			"""
			SELECT snapshot_version
			FROM dashboard_ticket_snapshot_state
			ORDER BY rowid DESC
			LIMIT 1
			"""
		).fetchone()[0]
		rows = conn.execute(
			"""
			SELECT ticket_id, ticket_name
			FROM dashboard_ticket_snapshot_rows
			WHERE snapshot_version = ?
			ORDER BY ticket_id
			""",
			(latest_snapshot_version,),
		).fetchall()
	finally:
		conn.close()

	assert rows == [("D-1", "Original D1"), ("D-2", "Updated D2")]


def test_load_materialized_outcomes_batches_large_defect_id_lists(tmp_path):
	source_db = tmp_path / "qgate_data.db"
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"
	_seed_history_events(
		source_db,
		[
			(
				"D-1",
				"status_phase",
				"2026-05-25T00:00:00Z",
				1,
				1,
				"08",
				"06",
				"08-Resolved Forward",
				"06-Ready for Test",
			),
		],
	)

	refresh_materialized_outcomes(source_db, hot_db, force=True)
	requested_ids = tuple(["D-1", *[f"D-MISS-{index}" for index in range(1100)]])
	loaded = load_materialized_outcomes(hot_db, requested_ids)

	assert loaded["D-1"]["is_resolved_forward"] is True
	assert loaded["D-MISS-1099"] == {
		"is_resolved_forward": False,
		"is_rejected_directly": False,
		"resolved_forward_at": None,
		"rejected_directly_at": None,
		"source_history_event_count": 0,
	}