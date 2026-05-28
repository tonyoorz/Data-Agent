from pathlib import Path
import sqlite3

from backend.analytics.config import (
	DEFAULT_FULL_PICTURE_COLD_DB_PATH,
	DEFAULT_FULL_PICTURE_COLD_PARQUET_DIR,
	get_full_picture_cold_db_path,
	get_full_picture_cold_parquet_dir,
)
from backend.analytics.cold_archive import archive_source_to_cold_storage


def test_full_picture_cold_paths_default_to_repo_database_cold(monkeypatch):
	monkeypatch.delenv("VIZION_FULL_PICTURE_COLD_DB_PATH", raising=False)
	monkeypatch.delenv("VIZION_FULL_PICTURE_COLD_PARQUET_DIR", raising=False)

	monkeypatch.delenv("VIZION_DATABASE_ROOT", raising=False)
	assert get_full_picture_cold_db_path() == DEFAULT_FULL_PICTURE_COLD_DB_PATH
	assert get_full_picture_cold_parquet_dir() == DEFAULT_FULL_PICTURE_COLD_PARQUET_DIR

	monkeypatch.setenv("VIZION_FULL_PICTURE_COLD_DB_PATH", "   \t  ")
	monkeypatch.setenv("VIZION_FULL_PICTURE_COLD_PARQUET_DIR", "   \t  ")
	assert get_full_picture_cold_db_path() == DEFAULT_FULL_PICTURE_COLD_DB_PATH
	assert get_full_picture_cold_parquet_dir() == DEFAULT_FULL_PICTURE_COLD_PARQUET_DIR

	custom_root = Path("/custom-root")
	monkeypatch.setenv("VIZION_DATABASE_ROOT", str(custom_root))
	monkeypatch.delenv("VIZION_FULL_PICTURE_COLD_DB_PATH", raising=False)
	monkeypatch.delenv("VIZION_FULL_PICTURE_COLD_PARQUET_DIR", raising=False)
	assert get_full_picture_cold_db_path() == custom_root / "cold" / "qgate_archive.duckdb"
	assert get_full_picture_cold_parquet_dir() == custom_root / "cold" / "parquet"


def test_archive_source_to_cold_storage_exports_sqlite_tables_to_duckdb_and_parquet(tmp_path, monkeypatch):
	source_db = tmp_path / "database" / "source" / "qgate_raw.db"
	cold_db = tmp_path / "database" / "cold" / "qgate_archive.duckdb"
	parquet_dir = tmp_path / "database" / "cold" / "parquet"
	source_db.parent.mkdir(parents=True, exist_ok=True)

	conn = sqlite3.connect(source_db)
	try:
		conn.execute("CREATE TABLE octane_defects (defect_id TEXT PRIMARY KEY, name TEXT)")
		conn.execute("CREATE TABLE octane_payloads (id TEXT PRIMARY KEY, payload_json TEXT)")
		conn.execute(
			"INSERT INTO octane_defects(defect_id, name) VALUES (?, ?)",
			("D-COLD-1", "Cold export defect"),
		)
		conn.execute(
			"INSERT INTO octane_payloads(id, payload_json) VALUES (?, ?)",
			("P-1", '{"ticket": "D-COLD-1"}'),
		)
		conn.commit()
	finally:
		conn.close()

	records: dict[str, object] = {}

	class FakeDuckConnection:
		def register(self, name, frame):
			records.setdefault("frames", []).append((name, tuple(frame.columns), len(frame)))

		def unregister(self, name):
			records.setdefault("unregistered", []).append(name)

		def execute(self, sql):
			records.setdefault("sql", []).append(sql)
			if " TO '" in sql:
				parquet_path = sql.split(" TO '", 1)[1].split("'", 1)[0]
				Path(parquet_path).parent.mkdir(parents=True, exist_ok=True)
				Path(parquet_path).touch()
			return self

		def close(self):
			records["closed"] = True

	class FakeDuckModule:
		def connect(self, path):
			records["cold_db_path"] = path
			Path(path).parent.mkdir(parents=True, exist_ok=True)
			Path(path).touch()
			return FakeDuckConnection()

	from backend.analytics import cold_archive

	monkeypatch.setattr(cold_archive, "_import_duckdb", lambda: FakeDuckModule())

	summary = archive_source_to_cold_storage(source_db, cold_db, parquet_dir)

	assert cold_db.exists()
	assert (parquet_dir / "octane_defects.parquet").exists()
	assert (parquet_dir / "octane_payloads.parquet").exists()
	assert summary["source_db_path"] == str(source_db.resolve())
	assert summary["cold_db_path"] == str(cold_db.resolve())
	assert summary["parquet_dir"] == str(parquet_dir.resolve())
	assert summary["table_count"] == 2
	assert summary["tables"] == [
		{"table_name": "octane_defects", "row_count": 1, "parquet_path": str((parquet_dir / "octane_defects.parquet").resolve())},
		{"table_name": "octane_payloads", "row_count": 1, "parquet_path": str((parquet_dir / "octane_payloads.parquet").resolve())},
	]


def test_archive_source_to_cold_storage_removes_zero_byte_duckdb_target(tmp_path, monkeypatch):
	source_db = tmp_path / "database" / "source" / "qgate_raw.db"
	cold_db = tmp_path / "database" / "cold" / "qgate_archive.duckdb"
	parquet_dir = tmp_path / "database" / "cold" / "parquet"
	source_db.parent.mkdir(parents=True, exist_ok=True)
	cold_db.parent.mkdir(parents=True, exist_ok=True)

	conn = sqlite3.connect(source_db)
	try:
		conn.execute("CREATE TABLE octane_defects (defect_id TEXT PRIMARY KEY, name TEXT)")
		conn.execute(
			"INSERT INTO octane_defects(defect_id, name) VALUES (?, ?)",
			("D-COLD-1", "Cold export defect"),
		)
		conn.commit()
	finally:
		conn.close()

	cold_db.touch()
	assert cold_db.stat().st_size == 0

	class FakeDuckConnection:
		def register(self, name, frame):
			return None

		def unregister(self, name):
			return None

		def execute(self, sql):
			if " TO '" in sql:
				parquet_path = sql.split(" TO '", 1)[1].split("'", 1)[0]
				Path(parquet_path).parent.mkdir(parents=True, exist_ok=True)
				Path(parquet_path).touch()
			return self

		def close(self):
			return None

	class FakeDuckModule:
		def connect(self, path):
			assert not Path(path).exists()
			Path(path).touch()
			return FakeDuckConnection()

	from backend.analytics import cold_archive

	monkeypatch.setattr(cold_archive, "_import_duckdb", lambda: FakeDuckModule())

	summary = archive_source_to_cold_storage(source_db, cold_db, parquet_dir)

	assert cold_db.exists()
	assert summary["table_count"] == 1