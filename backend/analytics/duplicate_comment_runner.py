from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
import sqlite3
from backend.analytics.db import ensure_wal_pragmas
from typing import Any


@dataclass(frozen=True)
class Phase00TicketCandidate:
    ticket_id: str
    name: str
    phase: str
    team: str


class DuplicateCommentRunStore:
    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        return ensure_wal_pragmas(sqlite3.connect(self.db_path))

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS duplicate_agent_comment_runs (
                    ticket_id TEXT PRIMARY KEY,
                    ticket_name TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    search_id TEXT,
                    comment_id TEXT,
                    status TEXT NOT NULL,
                    error TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_duplicate_agent_comment_runs_status
                ON duplicate_agent_comment_runs(status)
                """
            )

    def already_succeeded(self, ticket_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT 1 FROM duplicate_agent_comment_runs
                WHERE ticket_id = ? AND status = 'success'
                """,
                (str(ticket_id),),
            ).fetchone()
        return row is not None

    def record_success(
        self,
        *,
        ticket_id: str,
        ticket_name: str,
        phase: str,
        search_id: str = "",
        comment_id: str = "",
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO duplicate_agent_comment_runs(
                    ticket_id, ticket_name, phase, search_id, comment_id, status, error, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'success', NULL, CURRENT_TIMESTAMP)
                ON CONFLICT(ticket_id) DO UPDATE SET
                    ticket_name = excluded.ticket_name,
                    phase = excluded.phase,
                    search_id = excluded.search_id,
                    comment_id = excluded.comment_id,
                    status = 'success',
                    error = NULL,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(ticket_id), str(ticket_name), str(phase), str(search_id), str(comment_id)),
            )

    def record_failure(self, *, ticket_id: str, ticket_name: str, phase: str, error: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO duplicate_agent_comment_runs(
                    ticket_id, ticket_name, phase, search_id, comment_id, status, error, updated_at
                ) VALUES (?, ?, ?, '', '', 'failed', ?, CURRENT_TIMESTAMP)
                ON CONFLICT(ticket_id) DO UPDATE SET
                    ticket_name = excluded.ticket_name,
                    phase = excluded.phase,
                    status = 'failed',
                    error = excluded.error,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(ticket_id), str(ticket_name), str(phase), str(error)),
            )


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}


def _coalesce_column(columns: set[str], names: Sequence[str], fallback: str = "''") -> str:
    present = [name for name in names if name in columns]
    if not present:
        return fallback
    if len(present) == 1:
        return present[0]
    return "COALESCE(" + ", ".join(present) + ")"


def load_phase00_ticket_candidates(
    source_db_path: Path | str,
    *,
    team_name: str = "DTSV_China",
    ticket_ids: Sequence[str] | None = None,
    limit: int | None = None,
) -> list[Phase00TicketCandidate]:
    normalized_ids = tuple(str(ticket_id).strip() for ticket_id in (ticket_ids or ()) if str(ticket_id).strip())
    with ensure_wal_pragmas(sqlite3.connect(source_db_path)) as conn:
        columns = _table_columns(conn, "octane_defects")
        phase_expr = _coalesce_column(columns, ("status_phase", "phase"))
        team_expr = _coalesce_column(columns, ("problem_finder_team", "team"))
        order_expr = "creation_time" if "creation_time" in columns else "defect_id"
        params: list[object] = [team_name]
        clauses = [f"({team_expr} = ?)", f"({phase_expr} LIKE '00%')"]
        if normalized_ids:
            placeholders = ",".join("?" for _ in normalized_ids)
            clauses.append(f"defect_id IN ({placeholders})")
            params.extend(normalized_ids)
        limit_clause = ""
        if limit is not None and int(limit) > 0:
            limit_clause = " LIMIT ?"
            params.append(int(limit))
        rows = conn.execute(
            f"""
            SELECT defect_id, name, {phase_expr} AS phase_value, {team_expr} AS team_value
            FROM octane_defects
            WHERE {' AND '.join(clauses)}
            ORDER BY {order_expr} DESC, defect_id
            {limit_clause}
            """,
            params,
        ).fetchall()
    return [
        Phase00TicketCandidate(
            ticket_id=str(row[0] or "").strip(),
            name=str(row[1] or "").strip(),
            phase=str(row[2] or "").strip(),
            team=str(row[3] or "").strip(),
        )
        for row in rows
        if str(row[0] or "").strip()
    ]


def run_duplicate_comment_agent(
    *,
    source_db_path: Path | str,
    state_db_path: Path | str,
    team_name: str = "DTSV_China",
    ticket_ids: Sequence[str] | None = None,
    limit: int | None = None,
    apply: bool = False,
    force: bool = False,
    post_comment: Callable[..., dict[str, object]],
) -> dict[str, object]:
    store = DuplicateCommentRunStore(state_db_path)
    candidates = load_phase00_ticket_candidates(
        source_db_path,
        team_name=team_name,
        ticket_ids=ticket_ids,
        limit=limit,
    )
    results: list[dict[str, object]] = []
    skipped_existing = 0
    failed = 0
    processed = 0
    for candidate in candidates:
        if not force and store.already_succeeded(candidate.ticket_id):
            skipped_existing += 1
            results.append({"ticket_id": candidate.ticket_id, "status": "skipped_existing"})
            continue
        try:
            result = post_comment(ticket_id=candidate.ticket_id, ticket_name=candidate.name, apply=apply)
            processed += 1
            if apply:
                store.record_success(
                    ticket_id=candidate.ticket_id,
                    ticket_name=candidate.name,
                    phase=candidate.phase,
                    search_id=str(result.get("search_id") or ""),
                    comment_id=str(result.get("created_comment_id") or ""),
                )
            results.append({"ticket_id": candidate.ticket_id, "status": "posted" if apply else "planned", "result": result})
        except Exception as exc:
            failed += 1
            store.record_failure(
                ticket_id=candidate.ticket_id,
                ticket_name=candidate.name,
                phase=candidate.phase,
                error=str(exc),
            )
            results.append({"ticket_id": candidate.ticket_id, "status": "failed", "error": str(exc)})
    return {
        "team_name": team_name,
        "candidate_count": len(candidates),
        "processed": processed,
        "skipped_existing": skipped_existing,
        "failed": failed,
        "applied": bool(apply),
        "results": results,
    }
