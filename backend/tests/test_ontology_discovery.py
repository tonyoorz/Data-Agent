"""Tests for OntologyDiscovery — discovers gaps and relationship candidates from query logs."""
from __future__ import annotations

import pytest

from backend.analytics.ontology import OntologyCatalog, ontology_fingerprint
from backend.analytics.ontology_discovery import (
    DiscoveryReport,
    OntologyDiscovery,
    RelCandidate,
    TermCandidate,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

MINIMAL_BUNDLE = {
    "schemaVersion": "1.0",
    "ontologyVersion": "v1",
    "entities": [
        {
            "id": "quality.defect",
            "aliases": ["defect", "bug"],
            "properties": [
                {"id": "defect_id", "type": "string"},
                {"id": "severity", "type": "string"},
            ],
            "source": {"table": "defects"},
        },
        {
            "id": "organization.team",
            "aliases": ["team"],
            "properties": [
                {"id": "team_id", "type": "string"},
            ],
            "source": {"table": "teams"},
        },
    ],
    "metrics": [],
    "dimensions": [],
    "terms": [
        {
            "id": "concept.blocked",
            "kind": "derived_business_rule",
            "phrases": ["blocked", "Blocked"],
            "resolution": {"entityId": "quality.defect"},
        },
    ],
    "policies": [],
    "constraints": [],
    "actions": [],
    "relationships": [
        {
            "id": "quality.defect.belongs_to.team",
            "sourceEntity": "quality.defect",
            "targetEntity": "organization.team",
            "predicate": "belongs_to",
        },
    ],
    "businessRules": [],
    "sources": [],
}


@pytest.fixture()
def catalog() -> OntologyCatalog:
    return OntologyCatalog(
        version="v1",
        fingerprint=ontology_fingerprint(MINIMAL_BUNDLE),
        bundle=MINIMAL_BUNDLE,
    )


@pytest.fixture()
def discovery(catalog: OntologyCatalog) -> OntologyDiscovery:
    return OntologyDiscovery(catalog=catalog)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_analyze_empty_logs(discovery: OntologyDiscovery) -> None:
    """Empty logs → empty report."""
    report = discovery.analyze_query_logs([])
    assert report.total_queries_analyzed == 0
    assert report.unresolved_phrases == []
    assert report.relationship_candidates == []


def test_known_terms_resolved(discovery: OntologyDiscovery) -> None:
    """Queries with known terms → not flagged."""
    logs = [
        {"query": "show blocked defects", "timestamp": "2026-01-01", "user": "u1"},
        {"query": "defect severity overview", "timestamp": "2026-01-02", "user": "u2"},
    ]
    report = discovery.analyze_query_logs(logs)
    # 'blocked', 'defect', 'severity' are all known → nothing unresolved
    phrases = {p.phrase for p in report.unresolved_phrases}
    assert "blocked" not in phrases
    assert "defect" not in phrases
    assert "severity" not in phrases


def test_unknown_terms_flagged(discovery: OntologyDiscovery) -> None:
    """'XYZ unknown phrase' → flagged as candidate."""
    logs = [
        {"query": "show meizonos data", "timestamp": "2026-01-01", "user": "u1"},
    ]
    report = discovery.analyze_query_logs(logs)
    phrases = {p.phrase for p in report.unresolved_phrases}
    assert "meizonos" in phrases


def test_frequency_grouping(discovery: OntologyDiscovery) -> None:
    """Same unknown term appears 3 times → frequency=3."""
    logs = [
        {"query": "kratos summary", "timestamp": "2026-01-01", "user": "u1"},
        {"query": "kratos details please", "timestamp": "2026-01-02", "user": "u2"},
        {"query": "kratos by team", "timestamp": "2026-01-03", "user": "u3"},
    ]
    report = discovery.analyze_query_logs(logs)
    matched = [p for p in report.unresolved_phrases if p.phrase == "kratos"]
    assert len(matched) == 1
    assert matched[0].frequency == 3
    assert len(matched[0].sample_queries) == 3


def test_suggest_new_terms(discovery: OntologyDiscovery) -> None:
    """Returns ranked list of TermCandidate."""
    logs = [
        {"query": "alpha report", "timestamp": "2026-01-01", "user": "u1"},
        {"query": "alpha and beta", "timestamp": "2026-01-02", "user": "u2"},
        {"query": "alpha again", "timestamp": "2026-01-03", "user": "u3"},
        {"query": "beta once", "timestamp": "2026-01-04", "user": "u4"},
    ]
    report = discovery.analyze_query_logs(logs)
    suggestions = discovery.suggest_new_terms(report, top_n=10)
    assert len(suggestions) >= 2
    # alpha (freq=3) should rank above beta (freq=2)
    assert suggestions[0].phrase == "alpha"
    assert suggestions[0].frequency == 3
    assert all(isinstance(s, TermCandidate) for s in suggestions)


def test_co_occurring_entities(discovery: OntologyDiscovery) -> None:
    """Two entities in same query but not connected in ontology → relationship candidate."""
    # quality.defect and organization.team ARE connected via an existing relationship,
    # so we need entities that are NOT connected. Add a query referencing 'defect' and 'team'
    # — they already have a relationship, so existing_relationship should be True.
    # We verify the mechanism: if we reference two entities, a RelCandidate is produced.
    logs = [
        {"query": "defects by team", "timestamp": "2026-01-01", "user": "u1"},
        {"query": "team defect summary", "timestamp": "2026-01-02", "user": "u2"},
    ]
    report = discovery.analyze_query_logs(logs)
    # Both entities co-occur
    rel_cands = report.relationship_candidates
    assert len(rel_cands) >= 1
    cand = rel_cands[0]
    assert {cand.entity_a, cand.entity_b} == {"quality.defect", "organization.team"}
    assert cand.co_occurrence_count == 2
    assert cand.existing_relationship is True  # they are connected in ontology

    # Now test entities that are NOT connected:
    # We use property tokens to reference entities indirectly.
    # Modify bundle to have a third entity with no relationship to others.
    bundle_with_extra = {
        **MINIMAL_BUNDLE,
        "entities": MINIMAL_BUNDLE["entities"] + [
            {
                "id": "testing.test_run",
                "aliases": ["testrun", "test_run"],
                "properties": [{"id": "run_id", "type": "string"}],
                "source": {"table": "test_runs"},
            },
        ],
    }
    catalog2 = OntologyCatalog(
        version="v1",
        fingerprint=ontology_fingerprint(bundle_with_extra),
        bundle=bundle_with_extra,
    )
    discovery2 = OntologyDiscovery(catalog=catalog2)
    logs2 = [
        {"query": "defect test_run cross reference", "timestamp": "2026-01-01", "user": "u1"},
    ]
    report2 = discovery2.analyze_query_logs(logs2)
    cross_cands = [
        r for r in report2.relationship_candidates
        if {r.entity_a, r.entity_b} == {"quality.defect", "testing.test_run"}
    ]
    assert len(cross_cands) == 1
    assert cross_cands[0].existing_relationship is False
    assert cross_cands[0].co_occurrence_count == 1
