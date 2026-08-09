"""OntologyGraph — in-memory knowledge graph over the compiled ontology bundle.

Built on networkx, provides multi-hop traversal, shortest-path lookup,
predicate search, Mermaid export and sub-graph extraction.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any

try:
    import networkx as nx
except ImportError:  # pragma: no cover
    raise ImportError("networkx is required: pip install networkx")

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology


# ─── data structures ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class GraphPath:
    """A path through the ontology graph."""

    nodes: list[str]
    edges: list[str]  # predicates along the path
    entities: list[dict] = field(default_factory=list)  # entity metadata at each node


# ─── OntologyGraph ─────────────────────────────────────────────────────────────


class OntologyGraph:
    """In-memory directed graph built from the compiled ontology bundle."""

    def __init__(self, catalog: OntologyCatalog | None = None):
        try:
            self._catalog = catalog or load_ontology()
        except OntologyLoadError:
            self._catalog = None
            self._graph: nx.DiGraph = nx.DiGraph()
            return
        self._graph = self._build_graph(self._catalog.bundle)

    # ── construction ───────────────────────────────────────────────────────────

    def _build_graph(self, bundle: dict) -> nx.DiGraph:
        G = nx.DiGraph()

        # Add entity nodes
        for entity in bundle.get("entities", []):
            G.add_node(entity["id"], **entity)

        # Add relationship edges
        for rel in bundle.get("relationships", []):
            source = rel.get("sourceEntity", "")
            target = rel.get("targetEntity", "")
            if not source or not target:
                continue

            edge_attrs = {
                k: v
                for k, v in rel.items()
                if k not in ("sourceEntity", "targetEntity")
            }
            G.add_edge(source, target, **edge_attrs)

            # Reverse edge — skip self-loops (would just overwrite)
            if rel.get("reversible", False) and source != target:
                rev_attrs = dict(edge_attrs)
                rev_attrs["predicate"] = f"~{rev_attrs.get('predicate', '')}"
                rev_attrs["id"] = f"~{rev_attrs.get('id', '')}"
                G.add_edge(target, source, **rev_attrs)

        return G

    # ── properties ─────────────────────────────────────────────────────────────

    @property
    def node_count(self) -> int:
        return self._graph.number_of_nodes()

    @property
    def edge_count(self) -> int:
        return self._graph.number_of_edges()

    # ── traversal ──────────────────────────────────────────────────────────────

    def neighbors(self, entity_id: str, max_hops: int = 2) -> list[GraphPath]:
        """BFS from *entity_id* up to *max_hops*, returning GraphPaths to all reachable entities."""
        if entity_id not in self._graph:
            return []

        results: list[GraphPath] = []
        visited: set[str] = {entity_id}
        # queue items: (current_node, path_nodes, path_edges)
        queue: deque[tuple[str, list[str], list[str]]] = deque(
            [(entity_id, [entity_id], [])]
        )

        while queue:
            node, path_nodes, path_edges = queue.popleft()
            if len(path_nodes) - 1 >= max_hops:
                continue
            for neighbor in self._graph.successors(node):
                if neighbor in visited and neighbor != entity_id:
                    continue
                edge_data = self._graph.get_edge_data(node, neighbor) or {}
                predicate = edge_data.get("predicate", "?")
                new_nodes = path_nodes + [neighbor]
                new_edges = path_edges + [predicate]
                # Record this path
                entities = [
                    dict(self._graph.nodes[n]) for n in new_nodes if n in self._graph.nodes
                ]
                results.append(
                    GraphPath(nodes=new_nodes, edges=new_edges, entities=entities)
                )
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append((neighbor, new_nodes, new_edges))

        return results

    def shortest_path(self, source: str, target: str) -> list[str] | None:
        """Return shortest node-id path or None if unreachable."""
        try:
            return nx.shortest_path(self._graph, source=source, target=target)
        except (nx.NodeNotFound, nx.NetworkXNoPath):
            return None

    def subgraph(self, entity_ids: list[str], radius: int = 1) -> dict:
        """Extract subgraph around *entity_ids* within *radius* hops.

        Returns ``{"nodes": [...], "edges": [...]}``.
        """
        # Collect nodes within radius via BFS
        keep: set[str] = set()
        for seed in entity_ids:
            if seed not in self._graph:
                continue
            keep.add(seed)
            frontier = {seed}
            for _ in range(radius):
                next_frontier: set[str] = set()
                for node in frontier:
                    next_frontier.update(self._graph.successors(node))
                    next_frontier.update(self._graph.predecessors(node))
                keep.update(next_frontier)
                frontier = next_frontier - keep

        sub = self._graph.subgraph(keep)
        return {
            "nodes": [
                dict(data) if data else {"id": node}
                for node, data in sub.nodes(data=True)
            ],
            "edges": [
                {
                    "source": u,
                    "target": v,
                    **(data or {}),
                }
                for u, v, data in sub.edges(data=True)
            ],
        }

    # ── helpers ───────────────────────────────────────────────────────────────

    def explain_path(self, path: list[str]) -> str:
        """Human-readable rendering of a node-id sequence.

        Example: ``["quality.defect", "testing.test_run"]`` →
        ``"quality.defect --detected_in--> testing.test_run"``
        """
        if len(path) < 2:
            return path[0] if path else ""
        parts: list[str] = []
        for i in range(len(path) - 1):
            src, tgt = path[i], path[i + 1]
            edge_data = self._graph.get_edge_data(src, tgt) or {}
            predicate = edge_data.get("predicate", "?")
            parts.append(f"{src} --{predicate}--> {tgt}")
        return "  ".join(parts)

    def find_by_predicate(self, predicate: str) -> list[tuple[str, str]]:
        """All (source, target) pairs whose edge predicate matches."""
        results: list[tuple[str, str]] = []
        for u, v, data in self._graph.edges(data=True):
            if data.get("predicate") == predicate:
                results.append((u, v))
        return results

    def get_entity_properties(self, entity_id: str) -> dict:
        """Return the full entity dict stored on the node, or empty dict."""
        if entity_id not in self._graph:
            return {}
        return dict(self._graph.nodes[entity_id])

    # ── export ────────────────────────────────────────────────────────────────

    def to_mermaid(self, max_nodes: int = 30) -> str:
        """Generate a Mermaid flowchart of the graph (up to *max_nodes*)."""
        lines: list[str] = ["```mermaid", "graph LR"]

        # Sanitize node ids for mermaid (replace dots with underscores)
        def safe(node_id: str) -> str:
            return node_id.replace(".", "_")

        nodes_written = 0
        for node in list(self._graph.nodes)[:max_nodes]:
            nid = safe(node)
            label = node  # full entity id for readability
            lines.append(f'    {nid}["{label}"]')
            nodes_written += 1

        edge_count = 0
        for u, v, data in self._graph.edges(data=True):
            if safe(u) not in {safe(n) for n in list(self._graph.nodes)[:max_nodes]}:
                continue
            if safe(v) not in {safe(n) for n in list(self._graph.nodes)[:max_nodes]}:
                continue
            predicate = data.get("predicate", "")
            # Skip reverse edges (those starting with ~) to keep diagram clean
            if predicate.startswith("~"):
                continue
            lines.append(f"    {safe(u)} -->|{predicate}| {safe(v)}")
            edge_count += 1

        lines.append("```")
        return "\n".join(lines)
