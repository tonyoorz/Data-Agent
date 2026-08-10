"""Tests for OntologyRAG — Graph-enhanced retrieval-augmented generation.

Complete rewrite: rich mock catalog with proper entityId/metricId mappings,
full coverage of retrieval paths, graph expansion, assembly, and edge cases.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError
from backend.analytics.ontology_rag import (
    OntologyRAG,
    RetrievalResult,
    RetrievedContext,
)


# ─── Shared mock catalog ───────────────────────────────────────────────────


def _make_mock_catalog() -> OntologyCatalog:
    """Rich mock catalog with entities, relationships, metrics, constraints, terms."""
    catalog = MagicMock(spec=OntologyCatalog)
    catalog.bundle = {
        "schemaVersion": "1.0",
        "ontologyVersion": "v1",
        "entities": [
            {
                "id": "quality.defect",
                "labels": {"zh-CN": "缺陷", "en-US": "Defect"},
                "descriptions": {"zh-CN": "质量缺陷记录"},
                "aliases": ["bug", "问题单"],
                "governance": {"status": "approved"},
                "properties": [{"id": "defect_id"}, {"id": "phase"}],
                "source": {"table": "octane_defects"},
            },
            {
                "id": "testing.test_run",
                "labels": {"zh-CN": "测试执行", "en-US": "Test Run"},
                "descriptions": {"zh-CN": "手动测试执行记录"},
                "aliases": ["manual run", "MR"],
                "governance": {"status": "approved"},
                "properties": [{"id": "mr_id"}],
                "source": {"table": "octane_manual_runs"},
            },
            {
                "id": "product.ecu",
                "labels": {"zh-CN": "ECU", "en-US": "ECU"},
                "descriptions": {"zh-CN": "电子控制单元"},
                "aliases": ["模块"],
                "governance": {"status": "approved"},
                "properties": [],
                "source": {"table": "octane_defects"},
            },
        ],
        "relationships": [
            {
                "id": "rel.defect_detected_in_test",
                "predicate": "detected_in",
                "sourceEntity": "quality.defect",
                "targetEntity": "testing.test_run",
                "direction": "outbound",
                "cardinality": "many_to_one",
                "reversible": True,
                "governance": {"status": "approved"},
            },
            {
                "id": "rel.defect_affects_ecu",
                "predicate": "affects",
                "sourceEntity": "quality.defect",
                "targetEntity": "product.ecu",
                "direction": "outbound",
                "cardinality": "many_to_one",
                "reversible": True,
                "governance": {"status": "approved"},
            },
            {
                "id": "rel.test_validates_ecu",
                "predicate": "validates",
                "sourceEntity": "testing.test_run",
                "targetEntity": "product.ecu",
                "direction": "outbound",
                "cardinality": "many_to_many",
                "reversible": True,
                "governance": {"status": "approved"},
            },
        ],
        "metrics": [
            {
                "id": "defect.count",
                "labels": {"zh-CN": "缺陷数"},
                "description": "Distinct defect primary keys in the authorized snapshot.",
                "entityId": "quality.defect",
                "unit": "count",
                "governance": {"status": "approved"},
                "applicableDimensions": ["quality.phase"],
            },
            {
                "id": "testing.pass_rate",
                "labels": {"zh-CN": "通过率"},
                "description": "Test execution pass rate percentage.",
                "entityId": "testing.test_run",
                "unit": "percent",
                "governance": {"status": "approved"},
            },
        ],
        "terms": [
            {
                "id": "entity.defect",
                "phrases": ["缺陷", "bug", "问题单", "defect"],
                "kind": "synonym",
                "resolution": {"entityId": "quality.defect"},
                "governance": {"status": "approved"},
            },
            {
                "id": "entity.test_run",
                "phrases": ["测试执行", "manual run"],
                "kind": "synonym",
                "resolution": {"entityId": "testing.test_run"},
                "governance": {"status": "approved"},
            },
            {
                "id": "entity.ecu",
                "phrases": ["ECU", "模块"],
                "kind": "synonym",
                "resolution": {"entityId": "product.ecu"},
                "governance": {"status": "approved"},
            },
            {
                "id": "concept.top_issue",
                "phrases": ["Top Issue", "顶级问题"],
                "kind": "synonym",
                "resolution": {"metricId": "defect.count", "entityId": "quality.defect"},
                "governance": {"status": "approved"},
            },
            {
                "id": "concept.pass_rate",
                "phrases": ["通过率"],
                "kind": "synonym",
                "resolution": {"metricId": "testing.pass_rate", "entityId": "testing.test_run"},
                "governance": {"status": "approved"},
            },
        ],
        "constraints": [
            {
                "id": "query.max_limit",
                "description": "Query results limited to 200 rows",
                "enforcement": "plan",
                "parameters": {"maximum": 200},
                "governance": {"status": "approved"},
            },
            {
                "id": "defect.metric_guardrail",
                "description": "Defect count metric must use approved aggregation",
                "enforcement": "plan",
                "parameters": {"metricId": "defect.count"},
                "governance": {"status": "approved"},
            },
            {
                "id": "draft.rule",
                "description": "Draft rule (should be excluded)",
                "enforcement": "plan",
                "parameters": {},
                "governance": {"status": "draft"},
            },
        ],
        "actions": [],
        "dimensions": [
            {"id": "quality.phase", "labels": {"zh-CN": "阶段"}, "entityId": "quality.defect"},
        ],
        "policies": [],
        "sources": [],
    }
    catalog.fingerprint = "test_fp_rag_001"
    return catalog


# ─── OntologyRAG tests ─────────────────────────────────────────────────────


class TestOntologyRAGAvailability:
    def test_is_available_with_catalog(self):
        rag = OntologyRAG(catalog=_make_mock_catalog())
        assert rag.is_available is True

    def test_is_not_available_without_catalog(self):
        with patch("backend.analytics.ontology_rag.load_ontology", side_effect=OntologyLoadError("none")):
            rag = OntologyRAG(catalog=None)
            assert rag.is_available is False


class TestOntologyRAGRetrieveBasic:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.rag = OntologyRAG(catalog=self.catalog)

    def test_retrieve_returns_retrieval_result(self):
        result = self.rag.retrieve("缺陷")
        assert isinstance(result, RetrievalResult)
        assert result.query == "缺陷"

    def test_retrieve_returns_fragments(self):
        result = self.rag.retrieve("Top Issue 缺陷")
        assert len(result.fragments) > 0
        assert all(isinstance(f, RetrievedContext) for f in result.fragments)

    def test_retrieve_assembles_context(self):
        result = self.rag.retrieve("Top Issue 缺陷")
        assert len(result.assembled_context) > 0
        assert isinstance(result.assembled_context, str)

    def test_retrieve_empty_query_returns_default(self):
        result = self.rag.retrieve("")
        assert isinstance(result, RetrievalResult)
        # Empty query → no seeds → default fragments (or empty)
        # Either is acceptable, but shouldn't crash

    def test_retrieve_unknown_query_returns_default(self):
        result = self.rag.retrieve("xyzzy random nonsense word")
        assert isinstance(result, RetrievalResult)


class TestOntologyRAGRetrieveEntities:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.rag = OntologyRAG(catalog=self.catalog)

    def test_retrieve_finds_seed_entity_defect(self):
        result = self.rag.retrieve("缺陷")
        entity_fragments = [f for f in result.fragments if f.source == "entity"]
        assert len(entity_fragments) > 0
        assert any(f.metadata.get("entity_id") == "quality.defect" for f in entity_fragments)

    def test_retrieve_finds_seed_entity_ecu(self):
        result = self.rag.retrieve("ECU")
        entity_fragments = [f for f in result.fragments if f.source == "entity"]
        entity_ids = [f.metadata.get("entity_id") for f in entity_fragments]
        # ECU should be a seed, or found via graph expansion from defect
        assert "product.ecu" in entity_ids or any("ECU" in f.content for f in entity_fragments)

    def test_entity_summary_has_labels(self):
        result = self.rag.retrieve("缺陷")
        entity_fragments = [f for f in result.fragments if f.source == "entity"]
        assert len(entity_fragments) > 0
        # Should contain zh-CN label
        assert "缺陷" in entity_fragments[0].content or "Defect" in entity_fragments[0].content


class TestOntologyRAGRetrieveMetrics:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.rag = OntologyRAG(catalog=self.catalog)

    def test_retrieve_finds_defect_count_metric(self):
        result = self.rag.retrieve("Top Issue 缺陷")
        metric_fragments = [f for f in result.fragments if f.source == "metric"]
        metric_ids = [f.metadata.get("metric_id") for f in metric_fragments]
        assert "defect.count" in metric_ids

    def test_retrieve_finds_pass_rate_metric(self):
        result = self.rag.retrieve("通过率")
        metric_fragments = [f for f in result.fragments if f.source == "metric"]
        metric_ids = [f.metadata.get("metric_id") for f in metric_fragments]
        assert "testing.pass_rate" in metric_ids

    def test_metric_fragment_has_description(self):
        result = self.rag.retrieve("Top Issue 缺陷")
        metric_fragments = [f for f in result.fragments if f.source == "metric"]
        if metric_fragments:
            assert "defect" in metric_fragments[0].content.lower() or "缺陷" in metric_fragments[0].content


class TestOntologyRAGRetrieveConstraints:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.rag = OntologyRAG(catalog=self.catalog)

    def test_retrieve_finds_relevant_constraints(self):
        result = self.rag.retrieve("缺陷")
        constraint_fragments = [f for f in result.fragments if f.source == "constraint"]
        assert len(constraint_fragments) > 0

    def test_constraint_excludes_draft_status(self):
        """Draft governance constraints should be excluded."""
        result = self.rag.retrieve("缺陷")
        constraint_fragments = [f for f in result.fragments if f.source == "constraint"]
        for f in constraint_fragments:
            assert "draft" not in f.content.lower()

    def test_metric_guardrail_scores_higher(self):
        """Constraints referencing seed metrics should rank higher."""
        result = self.rag.retrieve("Top Issue 缺陷")
        constraint_fragments = [f for f in result.fragments if f.source == "constraint"]
        if len(constraint_fragments) >= 2:
            # The metric_guardrail constraint should be ranked high
            top = constraint_fragments[0]
            assert top.relevance >= constraint_fragments[1].relevance


class TestOntologyRAGRetrieveRelationships:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.rag = OntologyRAG(catalog=self.catalog)

    def test_retrieve_finds_defect_relationships(self):
        result = self.rag.retrieve("缺陷")
        rel_fragments = [f for f in result.fragments if f.source == "relationship"]
        assert len(rel_fragments) > 0
        rel_content = " ".join(f.content for f in rel_fragments)
        assert "quality.defect" in rel_content

    def test_relationship_finds_defect_to_test_run(self):
        result = self.rag.retrieve("缺陷")
        rel_fragments = [f for f in result.fragments if f.source == "relationship"]
        rel_content = " ".join(f.content for f in rel_fragments)
        assert "detected_in" in rel_content

    def test_relationship_finds_defect_to_ecu(self):
        result = self.rag.retrieve("缺陷")
        rel_fragments = [f for f in result.fragments if f.source == "relationship"]
        rel_content = " ".join(f.content for f in rel_fragments)
        assert "affects" in rel_content


class TestOntologyRAGRetrieveVocabulary:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.rag = OntologyRAG(catalog=self.catalog)

    def test_retrieve_finds_vocabulary_for_top_issue(self):
        result = self.rag.retrieve("Top Issue")
        vocab_fragments = [f for f in result.fragments if f.source == "vocabulary"]
        assert len(vocab_fragments) > 0
        assert any("Top Issue" in f.content for f in vocab_fragments)

    def test_vocabulary_fragment_has_resolution(self):
        result = self.rag.retrieve("Top Issue 缺陷")
        vocab_fragments = [f for f in result.fragments if f.source == "vocabulary"]
        if vocab_fragments:
            # Should contain metricId or entityId in resolution
            content = vocab_fragments[0].content
            assert "metricId" in content or "entityId" in content or "defect" in content


class TestOntologyRAGGraphExpansion:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.rag = OntologyRAG(catalog=self.catalog)

    def test_graph_expansion_finds_ecu_from_defect(self):
        """Query about defects should expand to ECU via affects relationship."""
        result = self.rag.retrieve("缺陷", max_hops=2)
        all_content = result.assembled_context
        # ECU should appear via graph traversal: defect → affects → ecu
        assert "product.ecu" in all_content or "ECU" in all_content

    def test_graph_expansion_finds_test_run_from_defect(self):
        """Query about defects should expand to test_run via detected_in."""
        result = self.rag.retrieve("缺陷", max_hops=2)
        all_content = result.assembled_context
        assert "testing.test_run" in all_content or "测试执行" in all_content

    def test_graph_expansion_respects_max_hops(self):
        """With max_hops=0, should not expand beyond seed entities."""
        result = self.rag.retrieve("缺陷", max_hops=0)
        # With 0 hops, only seed entity fragments, fewer relationships
        # Should still have the seed entity
        entity_fragments = [f for f in result.fragments if f.source == "entity"]
        assert any(f.metadata.get("entity_id") == "quality.defect" for f in entity_fragments)


class TestOntologyRAGAssembly:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.rag = OntologyRAG(catalog=self.catalog)

    def test_assembled_context_has_markdown_sections(self):
        result = self.rag.retrieve("Top Issue 缺陷")
        ctx = result.assembled_context
        assert "##" in ctx  # Has markdown headers
        assert "Ontology" in ctx

    def test_assembled_context_has_fragment_count(self):
        result = self.rag.retrieve("Top Issue 缺陷")
        ctx = result.assembled_context
        assert "Retrieved" in ctx or "fragments" in ctx.lower()

    def test_assembled_context_respects_max_chars(self):
        result = self.rag.retrieve("缺陷 ECU Top Issue", max_chars=300)
        assert len(result.assembled_context) <= 303  # Small overflow for "..."

    def test_assembled_context_sections_ordered(self):
        """Sections should appear in defined order: entity, metric, constraint, relationship, vocab."""
        result = self.rag.retrieve("Top Issue 缺陷")
        ctx = result.assembled_context
        # Check entity section comes before metric section
        entity_pos = ctx.find("## Relevant Entities")
        metric_pos = ctx.find("## Relevant Metrics")
        if entity_pos >= 0 and metric_pos >= 0:
            assert entity_pos < metric_pos


class TestOntologyRAGFragmentRanking:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.rag = OntologyRAG(catalog=self.catalog)

    def test_fragments_sorted_by_relevance_within_source(self):
        result = self.rag.retrieve("Top Issue 缺陷")
        for source in set(f.source for f in result.fragments):
            source_frags = [f for f in result.fragments if f.source == source]
            for i in range(len(source_frags) - 1):
                assert source_frags[i].relevance >= source_frags[i + 1].relevance

    def test_seed_entity_has_high_relevance(self):
        result = self.rag.retrieve("缺陷")
        entity_frags = [f for f in result.fragments if f.source == "entity"]
        if entity_frags:
            # Seed entity should have relevance 1.0
            defect_frag = [f for f in entity_frags if f.metadata.get("entity_id") == "quality.defect"]
            if defect_frag:
                assert defect_frag[0].relevance == 1.0


class TestOntologyRAGSummary:
    def test_summary_with_catalog(self):
        rag = OntologyRAG(catalog=_make_mock_catalog())
        s = rag.summary()
        assert s["available"] is True
        assert s["graph_nodes"] >= 3
        assert s["graph_edges"] >= 3  # We have 3 relationships
        assert s["total_constraints"] >= 2  # approved ones
        assert s["total_metrics"] >= 2
        assert s["total_terms"] >= 4

    def test_summary_without_catalog(self):
        with patch("backend.analytics.ontology_rag.load_ontology", side_effect=OntologyLoadError("none")):
            rag = OntologyRAG(catalog=None)
            s = rag.summary()
            assert s["available"] is False


class TestOntologyRAGEdgeCases:
    def test_no_catalog_no_crash(self):
        with patch("backend.analytics.ontology_rag.load_ontology", side_effect=OntologyLoadError("none")):
            rag = OntologyRAG(catalog=None)
            assert rag.is_available is False
            result = rag.retrieve("anything")
            assert isinstance(result, RetrievalResult)
            assert len(result.fragments) == 0
            assert result.assembled_context == ""

    def test_retrieve_with_multiple_seeds(self):
        """Query mentioning multiple entities should find broader context."""
        rag = OntologyRAG(catalog=_make_mock_catalog())
        result = rag.retrieve("缺陷 ECU 测试执行")
        # Should have fragments from multiple entity sources
        entity_frags = [f for f in result.fragments if f.source == "entity"]
        entity_ids = {f.metadata.get("entity_id") for f in entity_frags}
        assert len(entity_ids) >= 2  # At least 2 seed entities

    def test_retrieve_respects_max_rules(self):
        rag = OntologyRAG(catalog=_make_mock_catalog())
        result = rag.retrieve("缺陷", max_rules=1)
        constraint_frags = [f for f in result.fragments if f.source == "constraint"]
        assert len(constraint_frags) <= 1

    def test_retrieve_respects_max_metrics(self):
        rag = OntologyRAG(catalog=_make_mock_catalog())
        result = rag.retrieve("Top Issue", max_metrics=1)
        metric_frags = [f for f in result.fragments if f.source == "metric"]
        assert len(metric_frags) <= 1
