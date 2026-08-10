from __future__ import annotations

from datetime import datetime
from html import escape
from pathlib import Path
import sqlite3

from backend.analytics.config import get_full_picture_source_db_path


def resolve_report_db_path(db_path: str | Path | None) -> Path:
    if db_path is None:
        return get_full_picture_source_db_path()
    return Path(db_path)


def require_tables(db_path: Path, table_names: tuple[str, ...]) -> None:
    if not db_path.exists():
        raise FileNotFoundError(f"SQLite database not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    try:
        existing = {
            str(row[0])
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    finally:
        conn.close()

    missing = [name for name in table_names if name not in existing]
    if missing:
        raise ValueError(f"Missing required tables: {', '.join(missing)}")


def build_timestamped_output_paths(
    output_root: str | Path | None,
    file_names: tuple[str, ...],
) -> tuple[Path, ...]:
    root = (
        Path(output_root)
        if output_root is not None
        else Path("docs") / "qgate-reports" / "generated_runs"
    )
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = root / stamp
    run_dir.mkdir(parents=True, exist_ok=True)
    return tuple(run_dir / file_name.format(stamp=stamp) for file_name in file_names)


def escape_html(value: object) -> str:
    if value is None:
        return ""
    return escape(str(value), quote=True)