from __future__ import annotations

import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ANALYTICS_DB_PATH = REPO_ROOT / "backend" / "database" / "octane_data.db"
ANALYTICS_PORT = int(os.environ.get("VIZION_ANALYTICS_PORT", "3003"))


def get_analytics_db_path() -> Path:
	return Path(os.environ.get("VIZION_ANALYTICS_DB_PATH", DEFAULT_ANALYTICS_DB_PATH))


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

	return _dedupe_paths(
		[
			REPO_ROOT / "qgate" / "qgate_data.db",
			get_analytics_db_path(),
			REPO_ROOT.parent / "TPMDashbaord" / "qgate" / "qgate_data.db",
			REPO_ROOT.parent / "TPMDashboard" / "qgate" / "qgate_data.db",
		]
	)


def get_full_picture_history_db_candidates() -> tuple[Path, ...]:
	configured = str(os.environ.get("VIZION_FULL_PICTURE_HISTORY_DB_PATH", "")).strip()
	if configured:
		return (Path(configured),)

	return _dedupe_paths(
		[
			REPO_ROOT / "qgate" / "qgate_data.db",
			get_analytics_db_path(),
			REPO_ROOT.parent / "TPMDashbaord" / "qgate" / "qgate_data.db",
			REPO_ROOT.parent / "TPMDashboard" / "qgate" / "qgate_data.db",
		]
	)