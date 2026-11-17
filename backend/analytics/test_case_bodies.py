"""Lazy full-body cache for Octane test cases (name + description + steps script).

The embedding index (``test_case_index``) retrieves candidates by test *name* only.
For few-shot prompting, however, the LLM needs the full body of a reference test —
its step script and description — to imitate real structure, granularity and
checkpoint style rather than guessing from the title.

This module fetches bodies on demand (only for the top-k retrieved candidates,
so at most a handful per generation request) and caches them in a dedicated
SQLite file so each test is fetched from Octane at most once. Mirrors the
embedding-cache pattern: separate DB file under ``database/`` to avoid touching
the source store.
"""
from __future__ import annotations

import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

_REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BODY_CACHE_PATH = _REPO_ROOT / "database" / "test_case_bodies.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS test_case_bodies (
    test_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    description_text TEXT NOT NULL DEFAULT '',
    steps_text TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL
)
"""


@dataclass(frozen=True)
class TestCaseBody:
    test_id: str
    name: str
    description_text: str
    steps_text: str


# Class name starts with "Test" — tell pytest this is a data holder, not a test class.
TestCaseBody.__test__ = False


def full_bodies_enabled(env: dict[str, str] | None = None) -> bool:
    raw = str((env or os.environ).get("TESTCASE_FEW_SHOT_FULL_BODIES", "1")).strip().lower()
    return raw not in {"0", "false", "no", "off"}


def resolve_body_cache_path() -> str:
    configured = str(os.environ.get("TESTCASE_BODY_CACHE_PATH") or "").strip()
    if configured:
        return configured
    return str(DEFAULT_BODY_CACHE_PATH)


def _html_to_text(html: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", str(html or ""), flags=re.IGNORECASE)
    text = re.sub(r"</(p|div|li|tr|h[1-6])>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    lines = [line.strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def _connect(cache_path: str) -> sqlite3.Connection:
    path = Path(cache_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute(_SCHEMA)
    return conn


def _read_cached(conn: sqlite3.Connection, test_ids: Sequence[str]) -> dict[str, TestCaseBody]:
    if not test_ids:
        return {}
    placeholders = ",".join("?" for _ in test_ids)
    rows = conn.execute(
        f"SELECT test_id, name, description_text, steps_text FROM test_case_bodies WHERE test_id IN ({placeholders})",
        tuple(test_ids),
    ).fetchall()
    return {
        str(row[0]): TestCaseBody(
            test_id=str(row[0]),
            name=str(row[1] or ""),
            description_text=str(row[2] or ""),
            steps_text=str(row[3] or ""),
        )
        for row in rows
    }


def _write_cached(conn: sqlite3.Connection, bodies: Sequence[TestCaseBody]) -> None:
    if not bodies:
        return
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn.executemany(
        "INSERT OR REPLACE INTO test_case_bodies(test_id, name, description_text, steps_text, fetched_at) VALUES (?,?,?,?,?)",
        [(b.test_id, b.name, b.description_text, b.steps_text, now) for b in bodies],
    )
    conn.commit()


def _fetch_body_from_octane(client: Any, test_id: str) -> TestCaseBody | None:
    entity = client.fetch_test_entity(test_id)
    try:
        script_payload = client.fetch_test_steps(test_id=test_id)
    except Exception:
        script_payload = {}
    steps_text = str(script_payload.get("script") or "") if isinstance(script_payload, dict) else ""
    description_text = _html_to_text(str(entity.get("description") or ""))
    if not steps_text and not description_text:
        return None
    return TestCaseBody(
        test_id=test_id,
        name=str(entity.get("name") or ""),
        description_text=description_text,
        steps_text=steps_text,
    )


def get_test_bodies(
    test_ids: Sequence[str],
    *,
    cache_path: str | None = None,
    client: Any | None = None,
) -> dict[str, TestCaseBody]:
    """Return full bodies for the given test ids, fetching missing ones from Octane.

    Best-effort: per-id fetch failures are swallowed (that test simply stays
    name-only in the few-shot prompt), and a total Octane/client failure still
    returns whatever the cache already holds.
    """
    normalized = []
    seen = set()
    for raw in test_ids:
        test_id = str(raw or "").strip()
        if test_id and test_id not in seen:
            seen.add(test_id)
            normalized.append(test_id)
    if not normalized:
        return {}

    conn = _connect(cache_path or resolve_body_cache_path())
    try:
        bodies = _read_cached(conn, normalized)
        missing = [test_id for test_id in normalized if test_id not in bodies]
        if not missing:
            return bodies

        octane_client = client
        if octane_client is None:
            from backend.analytics.ingest.client import build_default_octane_client

            try:
                octane_client = build_default_octane_client()
            except Exception:
                return bodies

        fetched: list[TestCaseBody] = []
        for test_id in missing:
            try:
                body = _fetch_body_from_octane(octane_client, test_id)
            except Exception:
                body = None
            if body is not None:
                fetched.append(body)
        _write_cached(conn, fetched)
        for body in fetched:
            bodies[body.test_id] = body
        return bodies
    finally:
        conn.close()
