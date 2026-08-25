from __future__ import annotations

import sqlite3
from pathlib import Path


# Standard write-side pragmas. WAL lets readers and a writer progress concurrently
# instead of serializing on the database lock; busy_timeout makes concurrent writers
# wait briefly instead of raising "database is locked"; synchronous=NORMAL is safe
# under WAL and roughly 2-3x faster than FULL. Read-only / URI connections cannot
# apply journal_mode and are left at the default.
_WRITE_PRAGMAS = (
    "PRAGMA journal_mode=WAL",
    "PRAGMA busy_timeout=5000",
    "PRAGMA synchronous=NORMAL",
)


def _apply_write_pragmas(conn: sqlite3.Connection) -> None:
    for pragma in _WRITE_PRAGMAS:
        try:
            conn.execute(pragma)
        except sqlite3.OperationalError:
            # Read-only filesystem or URI mode=ro connection: pragmas that write
            # to the db file (journal_mode) are rejected. Leave the connection
            # at default journal mode rather than failing the open.
            break


def connect(db_path: Path | str, *, readonly: bool = False) -> sqlite3.Connection:
    """Open a SQLite connection with the project's standard pragmas.

    Write-side connections (the default) get WAL + busy_timeout + synchronous=NORMAL
    so that the agent runtime's concurrent reads/writes don't serialize. Callers
    that only read should pass ``readonly=True`` (uses the ``mode=ro`` URI and
    intentionally skips the write-only pragmas).
    """
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if readonly:
        conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    else:
        conn = sqlite3.connect(str(path))
        _apply_write_pragmas(conn)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_wal_pragmas(conn: sqlite3.Connection) -> sqlite3.Connection:
    """Apply the standard WAL pragmas to an existing connection.

    For call sites that cannot route through :func:`connect` (e.g. context-manager
    ``with sqlite3.connect(...) as conn``). Read-only connections are detected and
    left unchanged. Returns the same connection for fluent use.
    """
    _apply_write_pragmas(conn)
    return conn