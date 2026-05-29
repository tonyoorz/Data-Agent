from __future__ import annotations

import os
from pathlib import Path


ANALYTICS_PORT = int(os.environ.get("VIZION_ANALYTICS_PORT", "3003"))


def _repo_root() -> Path:
	configured = str(os.environ.get("VIZION_REPO_ROOT_OVERRIDE", "")).strip()
	if configured:
		return Path(configured)
	return Path(__file__).resolve().parents[2]


def _default_database_root() -> Path:
	return _repo_root() / "database"


def _default_analytics_db_path() -> Path:
	return _repo_root() / "backend" / "database" / "octane_data.db"


def get_analytics_db_path() -> Path:
	configured = str(os.environ.get("VIZION_ANALYTICS_DB_PATH", "")).strip()
	return Path(configured) if configured else _default_analytics_db_path()


def get_database_root() -> Path:
	configured = str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
	if configured:
		return Path(configured)
	return _default_database_root()


def get_full_picture_source_db_path() -> Path:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_SOURCE_DB_PATH", "")).strip()
	if configured:
		return Path(configured)
	database_root = str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
	if not database_root:
		return _default_database_root() / "source" / "qgate_raw.db"
	return Path(database_root) / "source" / "qgate_raw.db"


def get_full_picture_hot_db_path() -> Path:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_HOT_DB_PATH", "")).strip()
	if configured:
		return Path(configured)
	database_root = str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
	if not database_root:
		return _default_database_root() / "hot" / "vizion_serving.db"
	return Path(database_root) / "hot" / "vizion_serving.db"


def get_full_picture_cold_db_path() -> Path:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_COLD_DB_PATH", "")).strip()
	if configured:
		return Path(configured)
	database_root = str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
	if not database_root:
		return _default_database_root() / "cold" / "qgate_archive.duckdb"
	return Path(database_root) / "cold" / "qgate_archive.duckdb"


def get_full_picture_cold_parquet_dir() -> Path:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_COLD_PARQUET_DIR", "")).strip()
	if configured:
		return Path(configured)
	database_root = str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
	if not database_root:
		return _default_database_root() / "cold" / "parquet"
	return Path(database_root) / "cold" / "parquet"


def get_octane_cookie_file_path() -> Path:
	configured = str(os.environ.get("VIZION_OCTANE_COOKIE_FILE", "")).strip()
	return Path(configured) if configured else _repo_root() / "cookie.txt"


def get_octane_login_file_path() -> Path:
	configured = str(os.environ.get("VIZION_OCTANE_LOGIN_FILE", "")).strip()
	return Path(configured) if configured else _repo_root() / "login_info.txt"


def get_octane_base_url() -> str:
	return str(os.environ.get("VIZION_OCTANE_BASE_URL", "https://octane-prod.bmwgroup.net")).rstrip("/")


def get_octane_shared_space_id() -> str:
	return str(os.environ.get("VIZION_OCTANE_SHARED_SPACE_ID", "1002")).strip()


def get_octane_workspace_id() -> str:
	return str(os.environ.get("VIZION_OCTANE_WORKSPACE_ID", "2001")).strip()


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