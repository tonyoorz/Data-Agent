from __future__ import annotations

import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATABASE_ROOT = REPO_ROOT / "database"
DEFAULT_FULL_PICTURE_SOURCE_DB_PATH = DEFAULT_DATABASE_ROOT / "source" / "qgate_raw.db"
DEFAULT_FULL_PICTURE_HOT_DB_PATH = DEFAULT_DATABASE_ROOT / "hot" / "vizion_serving.db"
DEFAULT_FULL_PICTURE_COLD_DB_PATH = DEFAULT_DATABASE_ROOT / "cold" / "qgate_archive.duckdb"
DEFAULT_FULL_PICTURE_COLD_PARQUET_DIR = DEFAULT_DATABASE_ROOT / "cold" / "parquet"
DEFAULT_ANALYTICS_DB_PATH = REPO_ROOT / "backend" / "database" / "octane_data.db"
ANALYTICS_PORT = int(os.environ.get("VIZION_ANALYTICS_PORT", "3003"))


def get_analytics_db_path() -> Path:
	return Path(os.environ.get("VIZION_ANALYTICS_DB_PATH", DEFAULT_ANALYTICS_DB_PATH))


def get_database_root() -> Path:
	configured = str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
	if configured:
		return Path(configured)
	return DEFAULT_DATABASE_ROOT


def get_full_picture_source_db_path() -> Path:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_SOURCE_DB_PATH", "")).strip()
	if configured:
		return Path(configured)
	database_root = str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
	if not database_root:
		return DEFAULT_FULL_PICTURE_SOURCE_DB_PATH
	return Path(database_root) / "source" / "qgate_raw.db"


def get_full_picture_hot_db_path() -> Path:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_HOT_DB_PATH", "")).strip()
	if configured:
		return Path(configured)
	database_root = str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
	if not database_root:
		return DEFAULT_FULL_PICTURE_HOT_DB_PATH
	return Path(database_root) / "hot" / "vizion_serving.db"


def get_full_picture_cold_db_path() -> Path:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_COLD_DB_PATH", "")).strip()
	if configured:
		return Path(configured)
	database_root = str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
	if not database_root:
		return DEFAULT_FULL_PICTURE_COLD_DB_PATH
	return Path(database_root) / "cold" / "qgate_archive.duckdb"


def get_full_picture_cold_parquet_dir() -> Path:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_COLD_PARQUET_DIR", "")).strip()
	if configured:
		return Path(configured)
	database_root = str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
	if not database_root:
		return DEFAULT_FULL_PICTURE_COLD_PARQUET_DIR
	return Path(database_root) / "cold" / "parquet"


def _dedupe_paths(paths: list[Path]) -> tuple[Path, ...]:
	unique: list[Path] = []
	seen: set[str] = set()
	for path in paths:
		key = str(path)
		if key in seen:
			continue
		seen.add(key)
		unique.append(path)
	return tuple(unique)


def get_full_picture_defect_db_candidates() -> tuple[Path, ...]:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_DEFECT_DB_PATH", "")).strip()
	if configured:
		return (Path(configured),)

	return (get_full_picture_source_db_path(),)


def get_full_picture_history_db_candidates() -> tuple[Path, ...]:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_HISTORY_DB_PATH", "")).strip()
	if configured:
		return (Path(configured),)

	return (get_full_picture_source_db_path(),)