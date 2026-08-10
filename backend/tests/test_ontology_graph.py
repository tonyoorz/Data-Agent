"""Tests for OntologyGraph — in-memory knowledge graph over the compiled ontology."""
from __future__ import annotations

import pytest

from backend.analytics.ontology_graph import OntologyGraph, GraphPath


# ─── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def graph() -> OntologyGraph:
    return OntologyGraph()


# ─── node / edge counts ────────────────────────────────────────────────────────

def test_graph_node_count(graph: OntologyGraph) -> None:
    """Graph has one node per entity (28)."""
    assert graph.node_count == 28


def test_graph_edge_count(graph: OntologyGraph) -> None:
    """Graph has at least one edge per relationship (27); reversible edges double.

    All 27 relationships are reversible.  Two are self-loops
    (quality.defect→quality.defect, requirements.aida_node→requirements.aida_node)
    whose reverse collapses into the forward edge, giving 25×2 + 2 = 52.
    """
    assert graph.edge_count >= 27          # at minimum one per relationship
    assert graph.edge_count == 52          # 25 reversible pairs + 2 self-loops


# ─── neighbours ────────────────────────────────────────────────────────────────

def test_neighbors_one_hop(graph: OntologyGraph) -> None:
    """One-hop neighbours of quality.defect include testing.test_run, product.ecu, etc."""
    one_hop = graph.neighbors("quality.defect", max_hops=1)
    reachable_ids = {p.nodes[-1] for p in one_hop}
    assert "testing.test_run" in reachable_ids
    assert "product.ecu" in reachable_ids
    assert "quality.qgate" in reachable_ids
    assert "evidence.artifact" in reachable_ids   # via reverse of *supports*
    # Every path should be exactly 2 nodes (source + 1 hop)
    for p in one_hop:
        assert len(p.nodes) == 2


def test_neighbors_two_hop(graph: OntologyGraph) -> None:
    """Two-hop from quality.defect reaches testing.test_case via testing.test_run."""
    two_hop = graph.neighbors("quality.defect", max_hops=2)
    reachable_ids = {p.nodes[-1] for p in two_hop}
    # Direct (1-hop) entities
    assert "testing.test_run" in reachable_ids
    # 2-hop entities
    assert "testing.test_case" in reachable_ids       # defect → test_run → test_case
    assert "product.test_rack" in reachable_ids        # defect → test_run → test_rack
    assert "vehicle.test_vehicle" in reachable_ids     # defect → test_run → test_vehicle
    assert "requirements.feature" in reachable_ids     # defect → test_run → feature


# ─── shortest path ─────────────────────────────────────────────────────────────

def test_shortest_path(graph: OntologyGraph) -> None:
    """Shortest path from quality.defect to testing.test_case exists."""
    path = graph.shortest_path("quality.defect", "testing.test_case")
    assert path is not None
    assert path[0] == "quality.defect"
    assert path[-1] == "testing.test_case"
    # Defect → test_run → test_case  (2 hops, 3 nodes)
    assert len(path) == 3


def test_no_path(graph: OntologyGraph) -> None:
    """Disconnected entities return None.

    organisation.team is in a separate cluster (org.cluster) with no bridge
    to the quality/testing cluster.
    """
    path = graph.shortest_path("quality.defect", "organization.team")
    assert path is None


# ─── explain path ──────────────────────────────────────────────────────────────

def test_explain_path(graph: OntologyGraph) -> None:
    """explain_path returns human-readable edge descriptions."""
    text = graph.explain_path(["quality.defect", "testing.test_run"])
    assert "quality.defect" in text
    assert "testing.test_run" in text
    assert "detected_in" in text


# ─── find by predicate ─────────────────────────────────────────────────────────

def test_find_by_predicate(graph: OntologyGraph) -> None:
    """find_by_predicate returns all (source, target) pairs for a predicate."""
    pairs = graph.find_by_predicate("detected_in")
    assert isinstance(pairs, list)
    assert ("quality.defect", "testing.test_run") in pairs


# ─── entity properties ─────────────────────────────────────────────────────────

def test_get_entity_properties(graph: OntologyGraph) -> None:
    """Returns the full entity dict including the properties list."""
    props = graph.get_entity_properties("quality.defect")
    assert isinstance(props, dict)
    assert props["id"] == "quality.defect"
    assert "properties" in props
    assert isinstance(props["properties"], list)
    assert "labels" in props
    assert "governance" in props


# ─── mermaid export ────────────────────────────────────────────────────────────

def test_to_mermaid(graph: OntologyGraph) -> None:
    """Mermaid output starts with ```mermaid and contains entity names."""
    mermaid = graph.to_mermaid()
    assert mermaid.startswith("```mermaid")
    assert "quality.defect" in mermaid
    assert "testing.test_run" in mermaid
    assert mermaid.endswith("```")


# ─── subgraph ──────────────────────────────────────────────────────────────────

def test_subgraph(graph: OntologyGraph) -> None:
    """Extract subgraph around quality.defect returns dict with nodes and edges."""
    sub = graph.subgraph(["quality.defect"], radius=1)
    assert isinstance(sub, dict)
    assert "nodes" in sub
    assert "edges" in sub
    # quality.defect itself is always present
    node_ids = {n["id"] if isinstance(n, dict) else n for n in sub["nodes"]}
    assert "quality.defect" in node_ids
    # At least a few neighbours
    assert len(sub["nodes"]) > 3
    assert len(sub["edges"]) > 0
