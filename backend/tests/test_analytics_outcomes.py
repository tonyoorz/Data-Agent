from pathlib import Path
import sqlite3

import pytest

from backend.analytics.config import (
	DEFAULT_FULL_PICTURE_HOT_DB_PATH,
	get_full_picture_hot_db_path,
)
from backend.analytics.full_picture_outcomes import ensure_outcome_store


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


def test_ensure_outcome_store_creates_parent_dirs_and_table(tmp_path):
	hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

	ensure_outcome_store(hot_db)

	conn = sqlite3.connect(hot_db)
	try:
		columns = {
			row[1]: {"notnull": bool(row[3]), "pk": row[5]}
			for row in conn.execute("PRAGMA table_info(defect_outcomes)").fetchall()
		}
	finally:
		conn.close()

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