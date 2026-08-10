"""Tests for OntologyPromptBuilder — system-prompt auto-injection from ontology."""
from __future__ import annotations

import pytest

from backend.analytics.ontology_prompt import OntologyPromptBuilder


# ─── fixtures ──────────────────────────────────────────────────────────

def _minimal_bundle() -> dict:
    return {
        "schemaVersion": "1.0",
        "ontologyVersion": "v1",
        "entities": [],
        "relationships": [],
        "dimensions": [],
        "metrics": [],
        "terms": [],
        "constraints": [],
        "actions": [],
        "policies": [],
        "businessRules": [],
        "sources": [],
    }


def _rich_bundle() -> dict:
    """Bundle with approved + draft items across every category."""
    bundle = _minimal_bundle()
    bundle["constraints"] = [
        {
            "id": "answer.claim_evidence_binding",
            "kind": "claim_evidence_binding",
            "enforcement": "claim",
            "parameters": {"coverage": 1},
            "governance": {"owner": "Agent Platform", "status": "approved"},
            "version": "1.0.0",
        },
        {
            "id": "planner.approved_metric_only",
            "kind": "approved_metric_only",
            "enforcement": "plan",
            "parameters": {"enabled": True},
            "governance": {"owner": "Metric Governance", "status": "approved"},
            "version": "1.0.0",
        },
        {
            "id": "draft.constraint",
            "kind": "draft_kind",
            "enforcement": "plan",
            "parameters": {"enabled": True},
            "governance": {"owner": "Nobody", "status": "draft"},
            "version": "1.0.0",
        },
    ]
    bundle["metrics"] = [
        {
            "id": "defect.count",
            "description": "Distinct defect primary keys in the authorized snapshot.",
            "entityId": "quality.defect",
            "unit": "count",
            "governance": {"owner": "Quality Analytics", "status": "approved"},
        },
        {
            "id": "defect.age_days",
            "description": "Elapsed calendar days under an approved clock-stop rule.",
            "entityId": "quality.defect",
            "unit": "days",
            "targetValue": 30,
            "governance": {"owner": "Quality Governance", "status": "approved"},
        },
        {
            "id": "draft.metric",
            "description": "Should not appear.",
            "entityId": "quality.defect",
            "unit": "count",
            "governance": {"owner": "Nobody", "status": "draft"},
        },
    ]
    bundle["terms"] = [
        {
            "id": "concept.aida",
            "kind": "derived_business_rule",
            "phrases": ["AIDA", "AIDA Movement"],
            "resolution": {"entityId": "quality.defect"},
            "governance": {"owner": "Requirements Analytics", "status": "approved"},
        },
        {
            "id": "concept.ddp",
            "kind": "synonym",
            "phrases": ["DDP", "Defect Detection Ratio"],
            "resolution": {"metricId": "kpi.defect_detection_ratio"},
            "governance": {"owner": "Quality Analytics", "status": "approved"},
        },
        {
            "id": "draft.term",
            "kind": "alias",
            "phrases": ["DRAFT"],
            "resolution": {"entityId": "no.such"},
            "governance": {"owner": "Nobody", "status": "draft"},
        },
    ]
    bundle["relationships"] = [
        {
            "id": "evidence.artifact.supports.defect",
            "sourceEntity": "evidence.artifact",
            "predicate": "supports",
            "targetEntity": "quality.defect",
            "governance": {"owner": "Agent Platform", "status": "approved"},
        },
        {
            "id": "draft.rel",
            "sourceEntity": "a",
            "predicate": "x",
            "targetEntity": "b",
            "governance": {"owner": "Nobody", "status": "draft"},
        },
    ]
    return bundle


@pytest.fixture()
def rich_builder() -> OntologyPromptBuilder:
    return OntologyPromptBuilder(catalog=_catalog(_rich_bundle()))


@pytest.fixture()
def empty_builder() -> OntologyPromptBuilder:
    return OntologyPromptBuilder(catalog=_catalog(_minimal_bundle()))


def _catalog(bundle: dict):
    """Build a fake OntologyCatalog without going through load_ontology."""
    from backend.analytics.ontology import OntologyCatalog, ontology_fingerprint

    return OntologyCatalog(
        version=bundle.get("ontologyVersion", "v1"),
        fingerprint=ontology_fingerprint(bundle),
        bundle=bundle,
    )


# ─── tests ─────────────────────────────────────────────────────────────


class TestBuildSystemContext:
    def test_build_system_context_returns_string(self, rich_builder):
        out = rich_builder.build_system_context()
        assert isinstance(out, str)
        assert len(out) > 0

    def test_respects_max_chars(self, rich_builder):
        out = rich_builder.build_system_context(max_chars=200)
        assert len(out) <= 200

    def test_markdown_formatting(self, rich_builder):
        out = rich_builder.build_system_context()
        # Should contain at least one ## header
        assert "## " in out

    def test_empty_ontology(self, empty_builder):
        out = empty_builder.build_system_context()
        assert isinstance(out, str)
        assert len(out) > 0  # header still present


class TestGuardrailRules:
    def test_includes_approved_constraints(self, rich_builder):
        out = rich_builder.build_system_context()
        assert "answer.claim_evidence_binding" in out
        assert "planner.approved_metric_only" in out
        assert "draft.constraint" not in out

    def test_guardrail_rules_human_readable(self, rich_builder):
        rules = rich_builder.build_guardrail_rules()
        assert len(rules) >= 2
        for rule in rules:
            # Each rule should be a non-trivial sentence
            assert isinstance(rule, str)
            assert len(rule) > 10
            # Should not be raw JSON
            assert not rule.startswith("{")


class TestMetricGlossary:
    def test_includes_metric_glossary(self, rich_builder):
        out = rich_builder.build_system_context()
        assert "defect.count" in out
        assert "Distinct defect primary keys" in out
        # Draft metric excluded
        assert "draft.metric" not in out

    def test_metric_glossary_includes_targets(self, rich_builder):
        out = rich_builder.build_system_context()
        assert "defect.age_days" in out
        assert "30" in out


class TestVocabTable:
    def test_includes_vocab_table(self, rich_builder):
        out = rich_builder.build_system_context()
        assert "AIDA" in out
        assert "→" in out  # arrow used in vocab
        # Draft term excluded
        assert "DRAFT" not in out


class TestRelationshipSummary:
    def test_relationship_summary(self, rich_builder):
        out = rich_builder.build_system_context()
        assert "evidence.artifact" in out
        assert "supports" in out
        assert "quality.defect" in out
