from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

from backend.analytics.config import get_full_picture_hot_db_path


CACHE_DB_SQL = """
CREATE TABLE IF NOT EXISTS query_cache (
    cache_key TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    created_at REAL NOT NULL,
    ttl_seconds INTEGER NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_query_cache_expiry ON query_cache(created_at, ttl_seconds);
"""


class QueryCache:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.executescript(CACHE_DB_SQL)

    def _cache_key(self, endpoint: str, params: dict[str, Any]) -> str:
        normalized = json.dumps({"endpoint": endpoint, "params": params}, sort_keys=True, default=str)
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def get(self, endpoint: str, params: dict[str, Any]) -> dict[str, Any] | None:
        key = self._cache_key(endpoint, params)
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT response_json FROM query_cache WHERE cache_key=? AND created_at + ttl_seconds > ?",
                (key, time.time()),
            ).fetchone()
            if row is None:
                return None
            conn.execute("UPDATE query_cache SET hit_count = hit_count + 1 WHERE cache_key=?", (key,))
            return json.loads(row["response_json"])

    def set(self, endpoint: str, params: dict[str, Any], response: dict[str, Any], ttl_seconds: int = 300) -> None:
        key = self._cache_key(endpoint, params)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO query_cache(cache_key, response_json, created_at, ttl_seconds, hit_count)
                VALUES(?, ?, ?, ?, 0)
                """,
                (key, json.dumps(response, ensure_ascii=False, sort_keys=True, default=str), time.time(), ttl_seconds),
            )

    def clear_expired(self) -> int:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("DELETE FROM query_cache WHERE created_at + ttl_seconds < ?", (time.time(),))
            return int(cursor.rowcount)


_default_cache: QueryCache | None = None
_default_cache_path: Path | None = None


def get_default_query_cache() -> QueryCache:
    global _default_cache, _default_cache_path
    configured = os.environ.get("VIZION_ANALYTICS_QUERY_CACHE_DB_PATH", "").strip()
    db_path = Path(configured) if configured else get_full_picture_hot_db_path().parent / "query_cache.db"
    if _default_cache is None or _default_cache_path != db_path:
        _default_cache = QueryCache(db_path)
        _default_cache_path = db_path
    return _default_cache