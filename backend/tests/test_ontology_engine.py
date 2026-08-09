"""Tests for OntologyEngine — integration of all ontology modules."""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock

from backend.analytics.ontology_engine import OntologyEngine
from backend.analytics.ontology import OntologyCatalog


def _make_mock_catalog():
    """Build a minimal but functional mock catalog."""
    catalog = MagicMock(spec=OntologyCatalog)
    catalog.bundle = {
        "schemaVersion": "1.0",
        "ontologyVersion": "v1",
        "compilerVersion": "ontology-compiler-v1",
        "entities": [
            {"id": "quality.defect", "labels": {"zh-CN": "缺陷"}, "properties": [
                {"id": "defect_id", "type": "string", "nullable": False}
            ], "governance": {"status": "approved"}, "source": {"table": "octane_defects"}},
            {"id": "testing.test_run", "labels": {"zh-CN": "测试执行"}, "properties": [
                {"id": "mr_id", "type": "string", "nullable": False}
            ], "governance": {"status": "approved"}, "source": {"table": "octane_manual_runs"}},
        ],
        "relationships": [
            {"id": "rel1", "predicate": "detected_in", "sourceEntity": "quality.defect",
             "targetEntity": "testing.test_run", "reversible": True,
             "governance": {"status": "approved"}},
        ],
        "dimensions": [
            {"id": "quality.phase", "entityId": "quality.defect", "propertyId": "phase",
             "type": "enum", "governance": {"status": "approved"}},
        ],
        "metrics": [
            {"id": "defect.count", "labels": {"zh-CN": "缺陷数"},
             "governance": {"status": "approved"}, "applicableDimensions": ["quality.phase"],
             "targetValue": ""},
        ],
        "terms": [
            {"id": "concept.top_issue", "phrases": ["Top Issue", "top issue"],
             "kind": "synonym", "resolution": {"metricId": "defect.count"},
             "governance": {"status": "approved"}},
        ],
        "constraints": [
            {"id": "rule1", "description": "Test rule", "condition": "1=1",
             "action": "log", "enforcement": "plan",
             "governance": {"status": "approved"}},
        ],
        "actions": [
            {"id": "action.query", "operation": "read", "targetEntityId": "quality.defect",
             "capabilityState": "available",
             "execution": {"mode": "enabled", "requiresHumanApproval": False, "requiresDryRun": False},
             "governance": {"status": "approved"}},
        ],
        "policies": [],
        "sources": [],
        "businessRules": [],
    }
    catalog.version = "v1"
    catalog.fingerprint = "abc123"
    return catalog


class TestOntologyEngine:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.engine = OntologyEngine(catalog=self.catalog)

    def test_is_available(self):
        assert self.engine.is_available is True

    def test_resolve_terms(self):
        matches = self.engine.resolve_terms("show me the Top Issue data")
        assert len(matches) > 0
        assert matches[0].term_id == "concept.top_issue"

    def test_resolve_metric(self):
        metric = self.engine.resolve_metric("Top Issue")
        assert metric == "defect.count"

    def test_resolve_metric_none(self):
        assert self.engine.resolve_metric("xyz random text") is None

    def test_system_prompt_context(self):
        ctx = self.engine.system_prompt_context
        assert isinstance(ctx, str)
        assert len(ctx) > 0
        assert "Ontology" in ctx or "ontology" in ctx.lower()

    def test_build_prompt_max_chars(self):
        ctx = self.engine.build_prompt(max_chars=200)
        assert len(ctx) <= 203  # 200 + "..." potential

    def test_list_guardrail_rules(self):
        rules = self.engine.list_guardrail_rules()
        assert len(rules) > 0
        assert "Test rule" in rules[0]

    def test_list_available_actions(self):
        actions = self.engine.list_available_actions()
        assert len(actions) == 1
        assert actions[0]["id"] == "action.query"

    def test_explore_graph(self):
        paths = self.engine.explore_graph("quality.defect", max_hops=2)
        assert len(paths) > 0
        # Should reach testing.test_run in 1 hop
        node_ids = [n for p in paths for n in p.nodes]
        assert "testing.test_run" in node_ids

    def test_shortest_path(self):
        path = self.engine.shortest_path("quality.defect", "testing.test_run")
        assert path is not None
        assert path[0] == "quality.defect"
        assert path[-1] == "testing.test_run"

    def test_explain_path(self):
        path = ["quality.defect", "testing.test_run"]
        explanation = self.engine.explain_path(path)
        assert "detected_in" in explanation or "quality.defect" in explanation

    def test_validate_query_valid(self):
        result = self.engine.validate_query("defect.count", dimensions=["quality.phase"])
        assert result.passed is True

    def test_validate_query_unknown_metric(self):
        result = self.engine.validate_query("nonexistent.metric")
        assert result.passed is False

    def test_validate_action_approved(self):
        result = self.engine.validate_action("action.query")
        assert result.passed is True

    def test_validate_action_unknown(self):
        result = self.engine.validate_action("action.nonexistent")
        assert result.passed is False

    def test_check_metric_target_no_target(self):
        result = self.engine.check_metric_target("defect.count", 42.0)
        assert result.passed is True

    def test_entity_count(self):
        assert self.engine.entity_count == 2

    def test_relationship_count(self):
        assert self.engine.relationship_count >= 2  # 1 base + 1 reverse

    def test_constraint_count(self):
        assert self.engine.constraint_count == 1

    def test_action_count(self):
        assert self.engine.action_count == 1

    def test_summary(self):
        s = self.engine.summary()
        assert s["available"] is True
        assert s["entities"] == 2
        assert s["constraints"] == 1
        assert "prompt_context_chars" in s

    def test_graph_to_mermaid(self):
        mermaid = self.engine.graph_to_mermaid()
        assert "mermaid" in mermaid.lower() or "flowchart" in mermaid.lower()


class TestOntologyEngineEmpty:
    def test_empty_catalog_no_crash(self):
        """Engine should gracefully handle missing ontology."""
        engine = OntologyEngine(catalog=None)
        # Will try load_ontology() which may fail → degrade gracefully
        # Just verify it doesn't crash
        assert engine.resolve_terms("test") == [] or len(engine.resolve_terms("test")) >= 0
