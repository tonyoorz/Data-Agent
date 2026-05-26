from __future__ import annotations

from pathlib import Path
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