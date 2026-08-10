from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
from typing import Any
from uuid import uuid4

from backend.analytics.config import get_semantic_analysis_db_path


DEFAULT_ANALYSIS_TTL_SECONDS = 60 * 60


class AnalysisRefError(ValueError):
    code = "SEMANTIC_ANALYSIS_REF_ERROR"

    def __init__(self) -> None:
        super().__init__(self.code)


class AnalysisRefNotFound(AnalysisRefError):
    code = "SEMANTIC_ANALYSIS_REF_NOT_FOUND"


class AnalysisRefExpired(AnalysisRefError):
    code = "SEMANTIC_ANALYSIS_REF_EXPIRED"


class AnalysisRefScopeDenied(AnalysisRefError):
    code = "SEMANTIC_ANALYSIS_SCOPE_DENIED"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class SemanticAnalysisStore:
    def __init__(
        self,
        db_path: Path | str | None = None,
        *,
        now: Callable[[], datetime] = _utc_now,
    ) -> None:
        self.db_path = Path(db_path) if db_path is not None else get_semantic_analysis_db_path()
        self.now = now

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS semantic_analysis_refs (
                analysis_ref TEXT PRIMARY KEY,
                actor_scope_hash TEXT NOT NULL,
                ontology_version TEXT NOT NULL,
                schema_fingerprint TEXT NOT NULL,
                query_json TEXT NOT NULL,
                source_revision_json TEXT NOT NULL,
                evidence_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS semantic_analysis_refs_expiry_idx ON semantic_analysis_refs(expires_at)"
        )
        return conn

    def create(
        self,
        *,
        actor_scope_hash: str,
        ontology_version: str,
        schema_fingerprint: str,
        query: dict[str, Any],
        source_revision: dict[str, Any],
        evidence: dict[str, Any],
        ttl_seconds: int = DEFAULT_ANALYSIS_TTL_SECONDS,
    ) -> str:
        if not actor_scope_hash or not ontology_version or not schema_fingerprint:
            raise ValueError("SEMANTIC_ANALYSIS_METADATA_REQUIRED")
        if not isinstance(ttl_seconds, int) or ttl_seconds < 1:
            raise ValueError("SEMANTIC_ANALYSIS_TTL_INVALID")
        created_at = _as_utc(self.now())
        expires_at = created_at + timedelta(seconds=ttl_seconds)
        analysis_ref = f"analysis-{uuid4()}"
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM semantic_analysis_refs WHERE expires_at <= ?", (created_at.isoformat(),))
            conn.execute(
                """
                INSERT INTO semantic_analysis_refs(
                    analysis_ref, actor_scope_hash, ontology_version, schema_fingerprint,
                    query_json, source_revision_json, evidence_json, created_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    analysis_ref,
                    actor_scope_hash,
                    ontology_version,
                    schema_fingerprint,
                    _json(query),
                    _json(source_revision),
                    _json(evidence),
                    created_at.isoformat(),
                    expires_at.isoformat(),
                ),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        return analysis_ref

    def load(self, analysis_ref: str, *, actor_scope_hash: str) -> dict[str, Any]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM semantic_analysis_refs WHERE analysis_ref = ?",
                (str(analysis_ref or "").strip(),),
            ).fetchone()
            if row is None:
                raise AnalysisRefNotFound()
            if str(row["actor_scope_hash"]) != str(actor_scope_hash or ""):
                raise AnalysisRefScopeDenied()
            now = _as_utc(self.now())
            expires_at = datetime.fromisoformat(str(row["expires_at"]))
            if expires_at <= now:
                conn.execute("DELETE FROM semantic_analysis_refs WHERE analysis_ref = ?", (analysis_ref,))
                conn.commit()
                raise AnalysisRefExpired()
            return {
                "analysis_ref": str(row["analysis_ref"]),
                "actor_scope_hash": str(row["actor_scope_hash"]),
                "ontology_version": str(row["ontology_version"]),
                "schema_fingerprint": str(row["schema_fingerprint"]),
                "query": json.loads(str(row["query_json"])),
                "source_revision": json.loads(str(row["source_revision_json"])),
                "evidence": json.loads(str(row["evidence_json"])),
                "created_at": str(row["created_at"]),
                "expires_at": str(row["expires_at"]),
            }
        finally:
            conn.close()
