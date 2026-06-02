from __future__ import annotations

import sqlite3


def backfill_qgate_history_events(db_path: str, *, vacuum: bool = False) -> dict[str, int]:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT COUNT(*) FROM octane_defect_history_events").fetchone()
        events_upserted = int(row[0] or 0) if row else 0
        if vacuum:
            conn.execute("VACUUM")
    finally:
        conn.close()

    return {
        "history_rows_seen": 0,
        "history_rows_loaded": 0,
        "history_rows_skipped": 0,
        "events_upserted": events_upserted,
    }