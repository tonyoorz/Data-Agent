from __future__ import annotations

import numpy as np
import pytest

import backend.duplicate_issue_finder as dif
from backend.duplicate_issue_finder import (
    DuplicateCandidate,
    DuplicateIssueIndex,
    calibrate_duplicate_confidence,
)


def _candidate(ticket_id: str, similarity: float, source_index: int) -> DuplicateCandidate:
    return DuplicateCandidate(
        score_1_10=max(1, min(10, int(round(similarity * 9 + 1)))),
        similarity=similarity,
        ticket_id=ticket_id,
        name=f"defect {ticket_id}",
        project=None,
        pu=None,
        status_phase=None,
        snippet="",
        evidence_snippets=[],
        ranking_signals={},
        source_index=source_index,
    )


def _bare_index(meta=None) -> DuplicateIssueIndex:
    index = DuplicateIssueIndex.__new__(DuplicateIssueIndex)
    index.text_fields = ("name", "description")
    index._meta = meta if meta is not None else []
    return index


@pytest.fixture(autouse=True)
def _reset_cross_encoder_state(monkeypatch, tmp_path):
    monkeypatch.setattr(dif, "_cross_encoder_instance", None)
    monkeypatch.setattr(dif, "_cross_encoder_attempted", False)
    monkeypatch.setattr(dif, "_RERANKER_CACHE_DIR", str(tmp_path / "reranker_models"))
    monkeypatch.delenv("DUPLICATE_RERANKER_MODEL", raising=False)
    monkeypatch.delenv("DUPLICATE_ALLOW_REMOTE_RERANKER_DOWNLOAD", raising=False)
    yield


class _FakeCrossEncoder:
    def __init__(self, scores):
        self._scores = np.asarray(scores, dtype=np.float32)
        self.calls = []

    def predict(self, pairs):
        self.calls.append(pairs)
        assert len(pairs) == len(self._scores)
        return self._scores


def test_reranker_disabled_without_local_model_or_download_flag():
    assert dif._resolve_reranker_model_name() is None
    assert dif._get_cross_encoder() is None


def test_reranker_resolves_local_model_directory(tmp_path, monkeypatch):
    cache_root = tmp_path / "reranker_models" / "modelscope" / "BAAI"
    model_dir = cache_root / "bge-reranker-v2-m3"
    model_dir.mkdir(parents=True)
    (model_dir / "config.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(dif, "_RERANKER_CACHE_DIR", str(tmp_path / "reranker_models"))

    assert dif._resolve_reranker_model_name() == str(model_dir)


def test_cross_encoder_rerank_reorders_pool_and_records_signal(monkeypatch):
    index = _bare_index(
        meta=[
            {"name": "defect A", "description": "cold start black screen"},
            {"name": "defect B", "description": "white screen"},
            {"name": "defect C", "description": "speech failure"},
        ]
    )
    candidates = [
        _candidate("A", 0.90, 0),
        _candidate("B", 0.50, 1),
        _candidate("C", 0.30, 2),
    ]
    # Raw logits: the retrieval leader scores low, candidate B scores high.
    fake = _FakeCrossEncoder([0.1, 5.0, 2.0])
    monkeypatch.setattr(dif, "_get_cross_encoder", lambda: fake)

    reranked, applied = index._cross_encoder_rerank("cold start black screen", candidates)

    assert applied is True
    assert [c.ticket_id for c in reranked] == ["B", "C", "A"]
    signals = reranked[0].ranking_signals
    assert 0.85 < signals["cross_encoder_score"] < 1.0
    assert len(fake.calls[0]) == 3
    assert fake.calls[0][0][1].startswith("defect A")


def test_cross_encoder_rerank_is_noop_without_model(monkeypatch):
    index = _bare_index()
    candidates = [_candidate("A", 0.9, 0), _candidate("B", 0.5, 1)]
    monkeypatch.setattr(dif, "_get_cross_encoder", lambda: None)

    reranked, applied = index._cross_encoder_rerank("any query", candidates)

    assert applied is False
    assert reranked == candidates


def test_cross_encoder_failure_keeps_retrieval_order(monkeypatch):
    index = _bare_index()
    candidates = [_candidate("A", 0.9, 0)]

    class _Broken:
        def predict(self, pairs):
            raise RuntimeError("boom")

    monkeypatch.setattr(dif, "_get_cross_encoder", lambda: _Broken())
    reranked, applied = index._cross_encoder_rerank("any query", candidates)
    assert applied is False
    assert reranked == candidates


def test_search_with_metadata_flags_cross_encoder_stage(monkeypatch):
    index = _bare_index()
    candidates = [_candidate("A", 0.9, 0), _candidate("B", 0.5, 1)]
    monkeypatch.setattr(index, "_coarse_search", lambda query, hints=None, top_k=10: candidates)
    monkeypatch.setattr(dif, "_get_cross_encoder", lambda: None)

    result, metadata = index.search_with_metadata("any query", top_k=5)

    assert [c.ticket_id for c in result] == ["A", "B"]
    assert "cross_encoder_rerank" not in metadata

    fake = _FakeCrossEncoder([0.1, 5.0])
    monkeypatch.setattr(dif, "_get_cross_encoder", lambda: fake)
    result, metadata = index.search_with_metadata("any query", top_k=5)
    assert metadata.get("cross_encoder_rerank") is True
    assert [c.ticket_id for c in result] == ["B", "A"]


def test_calibrate_confidence_shifts_with_cross_encoder_score():
    base = calibrate_duplicate_confidence(
        similarity=0.6,
        ranking_signals={"dense_rank": 3, "sparse_rank": 4},
        evidence_snippets=["some evidence"],
    )
    up = calibrate_duplicate_confidence(
        similarity=0.6,
        ranking_signals={
            "dense_rank": 3,
            "sparse_rank": 4,
            "cross_encoder_score": 0.95,
        },
        evidence_snippets=["some evidence"],
    )
    down = calibrate_duplicate_confidence(
        similarity=0.6,
        ranking_signals={
            "dense_rank": 3,
            "sparse_rank": 4,
            "cross_encoder_score": 0.05,
        },
        evidence_snippets=["some evidence"],
    )
    assert up["score"] > base["score"]
    assert down["score"] < base["score"]
    assert up["score"] - down["score"] <= 2
