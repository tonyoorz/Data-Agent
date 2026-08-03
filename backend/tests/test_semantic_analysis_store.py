from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend.analytics.config import get_semantic_analysis_db_path
from backend.analytics.semantic_analysis_store import (
    AnalysisRefExpired,
    AnalysisRefNotFound,
    AnalysisRefScopeDenied,
    SemanticAnalysisStore,
)


def _record() -> dict[str, object]:
    return {
        "actor_scope_hash": "scope-a",
        "ontology_version": "v1",
        "schema_fingerprint": "a" * 64,
        "query": {"intent": "rank", "metricIds": ["defect.count"]},
        "source_revision": {"sourceId": "analytics.full_picture_defects", "revisionId": "snap-7", "status": "pinned"},
        "evidence": {"metricValues": {"defect.count": 3}, "groupRows": [{"product.ecu": "HU", "defect.count": 3}]},
    }


def test_semantic_analysis_db_path_defaults_beside_hot_store(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("VIZION_SEMANTIC_ANALYSIS_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(tmp_path / "database"))

    assert get_semantic_analysis_db_path() == tmp_path / "database" / "hot" / "semantic_analysis.db"

    override = tmp_path / "state" / "analysis.db"
    monkeypatch.setenv("VIZION_SEMANTIC_ANALYSIS_DB_PATH", str(override))
    assert get_semantic_analysis_db_path() == override


def test_analysis_ref_round_trips_validated_continuation(tmp_path: Path) -> None:
    now = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)
    store = SemanticAnalysisStore(tmp_path / "analysis.db", now=lambda: now)

    analysis_ref = store.create(**_record(), ttl_seconds=600)
    loaded = store.load(analysis_ref, actor_scope_hash="scope-a")

    assert analysis_ref.startswith("analysis-")
    assert loaded["analysis_ref"] == analysis_ref
    assert loaded["query"] == _record()["query"]
    assert loaded["source_revision"]["revisionId"] == "snap-7"
    assert loaded["evidence"]["metricValues"] == {"defect.count": 3}
    assert loaded["created_at"] == "2026-08-03T12:00:00+00:00"
    assert loaded["expires_at"] == "2026-08-03T12:10:00+00:00"


def test_analysis_ref_is_bound_to_actor_scope(tmp_path: Path) -> None:
    store = SemanticAnalysisStore(tmp_path / "analysis.db")
    analysis_ref = store.create(**_record())

    with pytest.raises(AnalysisRefScopeDenied, match="SEMANTIC_ANALYSIS_SCOPE_DENIED"):
        store.load(analysis_ref, actor_scope_hash="scope-b")


def test_analysis_ref_expires_and_unknown_refs_fail_closed(tmp_path: Path) -> None:
    clock = [datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)]
    store = SemanticAnalysisStore(tmp_path / "analysis.db", now=lambda: clock[0])
    analysis_ref = store.create(**_record(), ttl_seconds=30)

    clock[0] += timedelta(seconds=31)
    with pytest.raises(AnalysisRefExpired, match="SEMANTIC_ANALYSIS_REF_EXPIRED"):
        store.load(analysis_ref, actor_scope_hash="scope-a")

    with pytest.raises(AnalysisRefNotFound, match="SEMANTIC_ANALYSIS_REF_NOT_FOUND"):
        store.load("analysis-missing", actor_scope_hash="scope-a")
