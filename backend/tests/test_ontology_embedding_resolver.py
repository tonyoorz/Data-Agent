"""Tests for OntologyEmbeddingResolver — embedding-based phrase matching.

Complete rewrite: proper mock catalog with full entityId/metricId/dimensionId
resolutions, real assertion coverage, no "assert is None" cop-outs.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch
import numpy as np

from backend.analytics.ontology import OntologyCatalog
from backend.analytics.ontology_embedding_resolver import (
    OntologyEmbeddingResolver,
    EmbeddingTermMatch,
    EmbeddingIndex,
    encode_texts,
)
from backend.analytics.ontology_term_resolver import TermMatch


# ─── Shared mock catalog ───────────────────────────────────────────────────


def _make_mock_catalog() -> OntologyCatalog:
    """Build a rich mock catalog with full resolution paths.

    Every entity/metric/dimension has corresponding terms entries with
    proper resolution dicts so resolve_entity/metric/dimension actually work.
    """
    catalog = MagicMock(spec=OntologyCatalog)
    catalog.bundle = {
        "schemaVersion": "1.0",
        "ontologyVersion": "v1",
        "entities": [
            {
                "id": "quality.defect",
                "labels": {"zh-CN": "缺陷", "en-US": "Defect"},
                "descriptions": {"zh-CN": "质量缺陷记录"},
                "aliases": ["bug", "问题单", "缺陷单"],
                "governance": {"status": "approved"},
                "properties": [{"id": "defect_id"}, {"id": "name"}, {"id": "phase"}],
                "source": {"table": "octane_defects"},
            },
            {
                "id": "testing.test_run",
                "labels": {"zh-CN": "测试执行", "en-US": "Test Run"},
                "descriptions": {"zh-CN": "手动测试执行记录"},
                "aliases": ["manual run", "MR"],
                "governance": {"status": "approved"},
                "properties": [{"id": "mr_id"}, {"id": "status"}],
                "source": {"table": "octane_manual_runs"},
            },
            {
                "id": "product.ecu",
                "labels": {"zh-CN": "ECU模块", "en-US": "ECU"},
                "descriptions": {"zh-CN": "电子控制单元"},
                "aliases": ["模块", "controller"],
                "governance": {"status": "approved"},
                "properties": [],
                "source": {"table": "octane_defects"},
            },
        ],
        "metrics": [
            {
                "id": "defect.count",
                "labels": {"zh-CN": "缺陷数", "en-US": "Defect Count"},
                "description": "Distinct defect count",
                "entityId": "quality.defect",
                "unit": "count",
                "governance": {"status": "approved"},
            },
            {
                "id": "testing.pass_rate",
                "labels": {"zh-CN": "通过率", "en-US": "Pass Rate"},
                "description": "Test pass rate",
                "entityId": "testing.test_run",
                "unit": "percent",
                "governance": {"status": "approved"},
            },
        ],
        "terms": [
            # Terms with entityId resolution
            {
                "id": "entity.defect",
                "phrases": ["缺陷", "bug", "问题单", "defect"],
                "kind": "synonym",
                "resolution": {"entityId": "quality.defect"},
                "governance": {"status": "approved"},
            },
            {
                "id": "entity.test_run",
                "phrases": ["测试执行", "manual run", "MR"],
                "kind": "synonym",
                "resolution": {"entityId": "testing.test_run"},
                "governance": {"status": "approved"},
            },
            {
                "id": "entity.ecu",
                "phrases": ["ECU模块", "模块", "controller"],
                "kind": "synonym",
                "resolution": {"entityId": "product.ecu"},
                "governance": {"status": "approved"},
            },
            # Terms with metricId resolution
            {
                "id": "concept.top_issue",
                "phrases": ["Top Issue", "顶级问题"],
                "kind": "synonym",
                "resolution": {"metricId": "defect.count", "entityId": "quality.defect"},
                "governance": {"status": "approved"},
            },
            {
                "id": "concept.showstopper",
                "phrases": ["Showstopper", "阻断缺陷"],
                "kind": "synonym",
                "resolution": {"metricId": "defect.count", "entityId": "quality.defect"},
                "governance": {"status": "approved"},
            },
            {
                "id": "concept.pass_rate",
                "phrases": ["通过率", "pass rate"],
                "kind": "synonym",
                "resolution": {"metricId": "testing.pass_rate", "entityId": "testing.test_run"},
                "governance": {"status": "approved"},
            },
            # Terms with dimensionId resolution
            {
                "id": "dim.phase",
                "phrases": ["phase", "阶段"],
                "kind": "alias",
                "resolution": {"dimensionId": "quality.phase"},
                "governance": {"status": "approved"},
            },
            # Term with filterValue resolution
            {
                "id": "team.dtsv",
                "phrases": ["DTSV", "DTSV China"],
                "kind": "enum_value",
                "resolution": {"dimensionId": "org.problem_finder_team", "filterValue": "DTSV_China"},
                "governance": {"status": "approved"},
            },
            # Draft term (should be excluded from index if governance != approved)
            {
                "id": "concept.draft_term",
                "phrases": ["DraftTerm"],
                "kind": "synonym",
                "resolution": {"metricId": "defect.count"},
                "governance": {"status": "draft"},
            },
        ],
        "constraints": [],
        "actions": [],
        "relationships": [],
        "dimensions": [
            {"id": "quality.phase", "labels": {"zh-CN": "阶段"}, "entityId": "quality.defect"},
            {"id": "org.problem_finder_team", "labels": {"zh-CN": "团队"}, "entityId": "quality.defect"},
        ],
        "policies": [],
        "sources": [],
    }
    catalog.fingerprint = "test_fp_embed_001"
    return catalog


# ─── EmbeddingIndex tests ──────────────────────────────────────────────────


class TestEmbeddingIndex:
    def test_build_index_from_catalog(self):
        """Index should include phrases from terms, entity labels/aliases, metric labels."""
        catalog = _make_mock_catalog()
        resolver = OntologyEmbeddingResolver(catalog)
        idx = resolver.index

        assert len(idx.phrases) > 0
        # From terms
        assert "Top Issue" in idx.phrases
        assert "缺陷" in idx.phrases
        # From entity aliases
        assert "bug" in idx.phrases
        assert "controller" in idx.phrases
        # From metric labels
        assert "缺陷数" in idx.phrases
        assert "通过率" in idx.phrases

    def test_index_excludes_draft_terms(self):
        """Terms with governance status 'draft' should be excluded."""
        catalog = _make_mock_catalog()
        resolver = OntologyEmbeddingResolver(catalog)
        idx = resolver.index
        assert "DraftTerm" not in idx.phrases

    def test_index_resolutions_have_entity_ids(self):
        """Index entries should have proper entityId resolutions for entity terms."""
        catalog = _make_mock_catalog()
        resolver = OntologyEmbeddingResolver(catalog)
        idx = resolver.index

        # Find the "缺陷" phrase and verify it resolves to quality.defect
        for i, phrase in enumerate(idx.phrases):
            if phrase == "缺陷":
                assert idx.resolutions[i].get("entityId") == "quality.defect"
                break
        else:
            pytest.fail("'缺陷' not found in index phrases")

    def test_index_fingerprint_stable(self):
        """Same catalog → same fingerprint."""
        r1 = OntologyEmbeddingResolver(_make_mock_catalog())
        r2 = OntologyEmbeddingResolver(_make_mock_catalog())
        assert r1.index.fingerprint == r2.index.fingerprint

    def test_index_not_ready_without_embeddings(self):
        """When no embedding backend, index should have phrases but is_ready=False."""
        catalog = _make_mock_catalog()
        resolver = OntologyEmbeddingResolver(catalog)
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            idx = resolver.index
            assert len(idx.phrases) > 0
            assert idx.is_ready is False

    def test_index_ready_with_embeddings(self):
        """When embedding backend works, index should be ready."""
        catalog = _make_mock_catalog()
        resolver = OntologyEmbeddingResolver(catalog)
        phrases = resolver.index.phrases
        mock_emb = np.random.rand(len(phrases), 64).astype(np.float32)
        mock_emb = mock_emb / np.linalg.norm(mock_emb, axis=1, keepdims=True)

        # Reset index to trigger rebuild
        resolver._index = None
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=mock_emb):
            idx = resolver.index
            assert idx.is_ready is True
            assert idx.embeddings.shape == (len(phrases), 64)

    def test_index_caches_across_calls(self):
        """Index should be built once and cached."""
        catalog = _make_mock_catalog()
        resolver = OntologyEmbeddingResolver(catalog)

        with patch.object(OntologyEmbeddingResolver, "_build_index", wraps=resolver._build_index) as mock_build:
            _ = resolver.index
            _ = resolver.index
            assert mock_build.call_count == 1  # Only built once


# ─── Resolve tests ─────────────────────────────────────────────────────────


class TestEmbeddingResolverResolve:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.resolver = OntologyEmbeddingResolver(self.catalog)

    def test_resolve_empty_text(self):
        results = self.resolver.resolve("")
        assert results == []

    def test_resolve_whitespace_text(self):
        results = self.resolver.resolve("   ")
        assert results == []

    def test_resolve_no_embedding_backend(self):
        """When no embedding backend, resolve returns empty list."""
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            results = self.resolver.resolve("some query")
            assert results == []

    def test_resolve_with_mock_embeddings(self):
        """When embeddings available, resolve returns EmbeddingTermMatch objects."""
        phrases = self.resolver.index.phrases
        n = len(phrases)
        # Create embeddings where phrase 0 is identical to the query
        mock_emb = np.zeros((n, 64), dtype=np.float32)
        mock_emb[:, 0] = 1.0  # All phrases along axis 0
        mock_emb = mock_emb / np.linalg.norm(mock_emb, axis=1, keepdims=True)

        query_emb = np.array([[1.0] + [0.0] * 63], dtype=np.float32)
        query_emb = query_emb / np.linalg.norm(query_emb)

        resolver = OntologyEmbeddingResolver(self.catalog)
        call_count = [0]
        def mock_encode(texts):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_emb  # Index build
            return query_emb  # Query encoding

        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", side_effect=mock_encode):
            resolver._index = None  # Force rebuild
            results = resolver.resolve("test query")
            assert len(results) > 0
            assert all(isinstance(r, EmbeddingTermMatch) for r in results)
            assert all(r.similarity > 0 for r in results)

    def test_resolve_threshold_filtering(self):
        """Results below similarity threshold are excluded."""
        phrases = self.resolver.index.phrases
        n = len(phrases)
        # Orthogonal embeddings — query has zero similarity
        mock_emb = np.eye(n, dtype=np.float32)
        # Query is a new orthogonal direction (if n < dim)
        query_emb = np.zeros((1, n), dtype=np.float32)
        query_emb[0, 0] = 0.5
        query_emb[0, 1] = 0.5
        query_emb[0, 2] = 0.7
        query_emb = query_emb / np.linalg.norm(query_emb)

        resolver = OntologyEmbeddingResolver(self.catalog)
        call_count = [0]
        def mock_encode(texts):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_emb
            return query_emb

        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", side_effect=mock_encode):
            resolver._index = None
            results = resolver.resolve("unrelated")
            # Cosine sims will be low (~0.35-0.5), filtered by 0.75 threshold
            for r in results:
                assert r.similarity >= 0.75

    def test_resolve_top_k_limit(self):
        """resolve should respect top_k parameter."""
        phrases = self.resolver.index.phrases
        n = len(phrases)
        mock_emb = np.random.rand(n, 64).astype(np.float32)
        mock_emb = mock_emb / np.linalg.norm(mock_emb, axis=1, keepdims=True)
        query_emb = mock_emb[:1].copy()

        resolver = OntologyEmbeddingResolver(self.catalog)
        call_count = [0]
        def mock_encode(texts):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_emb
            return query_emb

        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", side_effect=mock_encode):
            resolver._index = None
            results = resolver.resolve("test", top_k=3)
            assert len(results) <= 3


# ─── Hybrid resolve tests ──────────────────────────────────────────────────


class TestEmbeddingResolverHybrid:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.resolver = OntologyEmbeddingResolver(self.catalog)

    def test_resolve_hybrid_returns_string_matches_without_embeddings(self):
        """Hybrid resolve should return string matches even without embeddings."""
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            results = self.resolver.resolve_hybrid("Top Issue", top_k=10)
            assert len(results) > 0
            # Should contain TermMatch (string-based) objects
            assert any(isinstance(r, TermMatch) for r in results)

    def test_resolve_hybrid_deduplicates(self):
        """Hybrid resolve should not return duplicate term_ids."""
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            results = self.resolver.resolve_hybrid("Top Issue 缺陷", top_k=20)
            term_ids = [r.term_id for r in results]
            assert len(term_ids) == len(set(term_ids)), "Duplicate term_ids found"

    def test_resolve_hybrid_merges_types(self):
        """Hybrid should merge string and embedding matches."""
        phrases = self.resolver.index.phrases
        n = len(phrases)
        mock_emb = np.random.rand(n, 64).astype(np.float32)
        mock_emb = mock_emb / np.linalg.norm(mock_emb, axis=1, keepdims=True)
        query_emb = mock_emb[0:1].copy()

        resolver = OntologyEmbeddingResolver(self.catalog)
        call_count = [0]
        def mock_encode(texts):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_emb
            return query_emb

        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", side_effect=mock_encode):
            resolver._index = None
            results = resolver.resolve_hybrid("缺陷 Top Issue", top_k=15)
            # Should have at least some matches
            assert len(results) > 0


# ─── Typed accessor tests ──────────────────────────────────────────────────


class TestEmbeddingResolverTypedAccess:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.resolver = OntologyEmbeddingResolver(self.catalog)

    def test_resolve_metric_finds_defect_count(self):
        """resolve_metric should find defect.count from 'Top Issue' phrase."""
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            mid = self.resolver.resolve_metric("Top Issue")
            assert mid == "defect.count"

    def test_resolve_metric_finds_pass_rate(self):
        """resolve_metric should find testing.pass_rate from '通过率' phrase."""
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            mid = self.resolver.resolve_metric("通过率")
            assert mid == "testing.pass_rate"

    def test_resolve_metric_returns_none_for_unknown(self):
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            mid = self.resolver.resolve_metric("xyzzy unknown phrase")
            assert mid is None

    def test_resolve_entity_finds_defect(self):
        """resolve_entity should find quality.defect from '缺陷' phrase."""
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            eid = self.resolver.resolve_entity("缺陷")
            assert eid == "quality.defect"

    def test_resolve_entity_finds_ecu(self):
        """resolve_entity should find product.ecu from 'ECU模块' phrase."""
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            eid = self.resolver.resolve_entity("ECU模块")
            assert eid == "product.ecu"

    def test_resolve_entity_returns_none_for_unknown(self):
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            eid = self.resolver.resolve_entity("nonexistent entity xyz")
            assert eid is None

    def test_resolve_dimension_finds_phase(self):
        """resolve_dimension should find quality.phase from '阶段' phrase."""
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            did = self.resolver.resolve_dimension("阶段")
            assert did == "quality.phase"

    def test_resolve_dimension_finds_team(self):
        """resolve_dimension should find org.problem_finder_team from 'DTSV' phrase."""
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            did = self.resolver.resolve_dimension("DTSV")
            assert did == "org.problem_finder_team"


# ─── Summary and utility tests ─────────────────────────────────────────────


class TestEmbeddingResolverSummary:
    def test_summary_without_embeddings(self):
        catalog = _make_mock_catalog()
        resolver = OntologyEmbeddingResolver(catalog)
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            s = resolver.summary()
            assert s["embedding_active"] is False
            assert s["phrases_indexed"] > 0
            assert s["embedding_dim"] == 0
            assert "fingerprint" in s
            assert "similarity_threshold" in s

    def test_summary_with_embeddings(self):
        catalog = _make_mock_catalog()
        resolver = OntologyEmbeddingResolver(catalog)
        phrases = resolver.index.phrases
        mock_emb = np.random.rand(len(phrases), 128).astype(np.float32)

        resolver._index = None
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=mock_emb):
            s = resolver.summary()
            assert s["embedding_active"] is True
            assert s["embedding_dim"] == 128
            assert s["phrases_indexed"] == len(phrases)

    def test_is_embedding_active_false_without_backend(self):
        catalog = _make_mock_catalog()
        resolver = OntologyEmbeddingResolver(catalog)
        with patch("backend.analytics.ontology_embedding_resolver.encode_texts", return_value=None):
            assert resolver.is_embedding_active is False

    def test_phrase_count_positive(self):
        catalog = _make_mock_catalog()
        resolver = OntologyEmbeddingResolver(catalog)
        assert resolver.phrase_count > 10  # We have many phrases


# ─── encode_texts tests ────────────────────────────────────────────────────


class TestEncodeTexts:
    def test_empty_input(self):
        result = encode_texts([])
        assert len(result) == 0

    def test_returns_none_when_no_backend(self):
        """When sentence-transformers not installed and no remote URL, returns None."""
        with patch(
            "backend.analytics.ontology_embedding_resolver._load_sentence_transformer",
            return_value=None,
        ):
            with patch(
                "backend.analytics.ontology_embedding_resolver._remote_embed",
                return_value=None,
            ):
                result = encode_texts(["test"])
                assert result is None

    def test_returns_array_when_local_model_works(self):
        """When local model returns vectors, encode_texts should return ndarray."""
        mock_vecs = np.random.rand(2, 64).astype(np.float32)
        mock_model = MagicMock()
        mock_model.encode.return_value = mock_vecs

        with patch(
            "backend.analytics.ontology_embedding_resolver._load_sentence_transformer",
            return_value=mock_model,
        ):
            result = encode_texts(["hello", "world"])
            assert result is not None
            assert result.shape == (2, 64)
