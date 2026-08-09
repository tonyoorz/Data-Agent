"""
OntologyRAG — Graph-enhanced Retrieval-Augmented Generation for ontology context.

Instead of injecting the entire ontology into the LLM system prompt,
OntologyRAG retrieves only the most relevant ontology subsets based on
the user's query, producing tighter, more accurate context windows.

Architecture:
    1. Extract entities/metrics/dimensions from user query (via EmbeddingResolver)
    2. Expand: traverse the ontology graph from those nodes (BFS, k hops)
    3. Retrieve: collect relevant constraints, metrics, vocabulary, relationships
    4. Rank: prioritize by relevance score (similarity × graph distance)
    5. Assemble: build a focused system-prompt fragment

This implements the GraphRAG pattern (Microsoft Research, 2024) adapted
for ontology-driven NL2SQL agents.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology
from backend.analytics.ontology_graph import OntologyGraph
from backend.analytics.ontology_term_resolver import OntologyTermResolver

logger = logging.getLogger(__name__)

# Default retrieval parameters
_DEFAULT_MAX_HOPS = 2
_DEFAULT_MAX_RULES = 8
_DEFAULT_MAX_METRICS = 6
_DEFAULT_MAX_RELATIONSHIPS = 10
_DEFAULT_MAX_VOCAB = 12
_DEFAULT_MAX_CHARS = 3000
_DEFAULT_TOP_K_ENTITIES = 5


# ─── Data structures ───────────────────────────────────────────────────────


@dataclass
class RetrievedContext:
    """A single retrieved context fragment."""

    source: str  # "constraint", "metric", "vocabulary", "relationship", "entity"
    content: str  # formatted text fragment
    relevance: float  # 0-1
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RetrievalResult:
    """Aggregated retrieval result from OntologyRAG."""

    query: str
    fragments: list[RetrievedContext] = field(default_factory=list)
    assembled_context: str = ""

    @property
    def total_chars(self) -> int:
        return len(self.assembled_context)

    @property
    def fragment_count(self) -> int:
        return len(self.fragments)


# ─── OntologyRAG ───────────────────────────────────────────────────────────


class OntologyRAG:
    """Graph-enhanced retrieval of ontology context for LLM prompts.

    Usage::

        rag = OntologyRAG(catalog)
        result = rag.retrieve("中国相关的Top Issue缺陷有多少")
        system_prompt_fragment = result.assembled_context
    """

    def __init__(
        self,
        catalog: OntologyCatalog | None = None,
        graph: OntologyGraph | None = None,
        term_resolver: OntologyTermResolver | None = None,
    ):
        try:
            self._catalog = catalog or load_ontology()
        except OntologyLoadError:
            self._catalog = None

        self._graph = graph or OntologyGraph(self._catalog)
        self._resolver = term_resolver or OntologyTermResolver(self._catalog)

        # Try to use embedding resolver if available
        self._embedding_resolver = None
        try:
            from backend.analytics.ontology_embedding_resolver import OntologyEmbeddingResolver
            self._embedding_resolver = OntologyEmbeddingResolver(self._catalog)
        except Exception:
            pass

        self._bundle = self._catalog.bundle if self._catalog else {}

    # ── Core retrieval ─────────────────────────────────────────────────

    def retrieve(
        self,
        query: str,
        *,
        max_hops: int = _DEFAULT_MAX_HOPS,
        max_rules: int = _DEFAULT_MAX_RULES,
        max_metrics: int = _DEFAULT_MAX_METRICS,
        max_relationships: int = _DEFAULT_MAX_RELATIONSHIPS,
        max_vocab: int = _DEFAULT_MAX_VOCAB,
        max_chars: int = _DEFAULT_MAX_CHARS,
    ) -> RetrievalResult:
        """Retrieve relevant ontology context for a user query.

        Args:
            query: User's natural language question
            max_hops: Graph traversal depth for entity expansion
            max_rules: Max constraints/rules to include
            max_metrics: Max metric definitions to include
            max_relationships: Max relationship descriptions
            max_vocab: Max vocabulary terms to include
            max_chars: Total character budget for assembled context

        Returns:
            RetrievalResult with ranked fragments and assembled context
        """
        result = RetrievalResult(query=query)

        if not self._catalog:
            return result

        # Step 1: Identify seed entities/metrics/dimensions from query
        seed_entities, seed_metrics, seed_dims, seed_terms = self._extract_seeds(query)

        if not seed_entities and not seed_metrics and not seed_dims:
            # No seeds found — return a minimal default context
            result.fragments = self._default_fragments()
            result.assembled_context = self._assemble(result.fragments, max_chars)
            return result

        # Step 2: Expand via graph traversal
        expanded_entities = self._expand_entities(seed_entities, max_hops)

        # Step 3: Retrieve and rank fragments
        result.fragments = self._retrieve_fragments(
            query=query,
            seed_entities=seed_entities,
            expanded_entities=expanded_entities,
            seed_metrics=seed_metrics,
            seed_dims=seed_dims,
            seed_terms=seed_terms,
            max_rules=max_rules,
            max_metrics=max_metrics,
            max_relationships=max_relationships,
            max_vocab=max_vocab,
        )

        # Step 4: Assemble into a single context string
        result.assembled_context = self._assemble(result.fragments, max_chars)

        return result

    # ── Seed extraction ────────────────────────────────────────────────

    def _extract_seeds(
        self, query: str
    ) -> tuple[set[str], set[str], set[str], list[dict]]:
        """Extract seed entity/metric/dimension IDs from user query.

        Uses both string matching and embedding matching (if available).
        """
        entities: set[str] = set()
        metrics: set[str] = set()
        dims: set[str] = set()
        matched_terms: list[dict] = []

        # Try embedding resolver first (semantic matching)
        if self._embedding_resolver and self._embedding_resolver.is_embedding_active:
            from backend.analytics.ontology_embedding_resolver import EmbeddingTermMatch
            matches = self._embedding_resolver.resolve_hybrid(query, top_k=15)
            for m in matches:
                res = m.resolution if hasattr(m, "resolution") else {}
                eid = res.get("entityId")
                mid = res.get("metricId")
                did = res.get("dimensionId")
                if eid:
                    entities.add(eid)
                if mid:
                    metrics.add(mid)
                if did:
                    dims.add(did)
                matched_terms.append({
                    "term_id": m.term_id,
                    "phrase": m.phrase,
                    "kind": m.kind,
                    "resolution": res,
                    "similarity": getattr(m, "similarity", getattr(m, "score", 0.0)),
                })
        else:
            # Fall back to string resolver
            for m in self._resolver.resolve(query):
                res = m.resolution
                eid = res.get("entityId")
                mid = res.get("metricId")
                did = res.get("dimensionId")
                if eid:
                    entities.add(eid)
                if mid:
                    metrics.add(mid)
                if did:
                    dims.add(did)
                matched_terms.append({
                    "term_id": m.term_id,
                    "phrase": m.phrase,
                    "kind": m.kind,
                    "resolution": res,
                    "similarity": m.score,
                })

        return entities, metrics, dims, matched_terms

    # ── Graph expansion ────────────────────────────────────────────────

    def _expand_entities(self, seed_entities: set[str], max_hops: int) -> set[str]:
        """BFS expand from seed entities through the ontology graph."""
        expanded = set(seed_entities)
        for entity_id in seed_entities:
            try:
                paths = self._graph.neighbors(entity_id, max_hops=max_hops)
                for path in paths:
                    for node in path.nodes:
                        expanded.add(node)
            except Exception:
                continue
        return expanded

    # ── Fragment retrieval ─────────────────────────────────────────────

    def _retrieve_fragments(
        self,
        *,
        query: str,
        seed_entities: set[str],
        expanded_entities: set[str],
        seed_metrics: set[str],
        seed_dims: set[str],
        seed_terms: list[dict],
        max_rules: int,
        max_metrics: int,
        max_relationships: int,
        max_vocab: int,
    ) -> list[RetrievedContext]:
        """Retrieve and rank ontology fragments by relevance."""
        fragments: list[RetrievedContext] = []

        # --- Constraints ---
        for constraint in self._ranked_constraints(
            seed_entities, seed_metrics, expanded_entities, max_rules
        ):
            fragments.append(constraint)

        # --- Metrics ---
        for metric in self._ranked_metrics(
            seed_metrics, seed_entities, expanded_entities, max_metrics
        ):
            fragments.append(metric)

        # --- Relationships ---
        for rel in self._ranked_relationships(
            seed_entities, expanded_entities, max_relationships
        ):
            fragments.append(rel)

        # --- Vocabulary ---
        for vocab in self._ranked_vocab(seed_terms, max_vocab):
            fragments.append(vocab)

        # --- Entity summary ---
        for ent in self._entity_summaries(seed_entities, _DEFAULT_TOP_K_ENTITIES):
            fragments.append(ent)

        return fragments

    def _ranked_constraints(
        self,
        seeds: set[str],
        seed_metrics: set[str],
        expanded: set[str],
        max_rules: int,
    ) -> list[RetrievedContext]:
        """Rank constraints by relevance to the query entities/metrics."""
        constraints = self._bundle.get("constraints", [])
        scored: list[tuple[float, dict]] = []

        for c in constraints:
            gov = c.get("governance", {})
            if gov.get("status") not in (None, "approved"):
                continue

            score = 0.0
            c_str = str(c)
            c_params = str(c.get("parameters", ""))

            # Score by entity mention
            for eid in seeds:
                if eid in c_str or eid.split(".")[-1] in c_str.lower():
                    score += 0.5
            for eid in expanded:
                if eid in c_str:
                    score += 0.2

            # Score by metric mention
            for mid in seed_metrics:
                if mid in c_str or mid in c_params:
                    score += 0.6

            # Metric guardrail bonus
            if c.get("parameters", {}).get("metricId") in seed_metrics:
                score += 1.0

            if score > 0:
                scored.append((min(score, 2.0), c))

        scored.sort(key=lambda x: -x[0])

        results: list[RetrievedContext] = []
        for score, c in scored[:max_rules]:
            desc = c.get("description", c.get("id", "unknown rule"))
            enforcement = c.get("enforcement", "plan")
            content = f"- **{c.get('id', '')}**: {desc} (enforcement: {enforcement})"
            results.append(RetrievedContext(
                source="constraint",
                content=content,
                relevance=round(score / 2.0, 3),
                metadata={"constraint_id": c.get("id")},
            ))

        return results

    def _ranked_metrics(
        self,
        seed_metrics: set[str],
        seeds: set[str],
        expanded: set[str],
        max_metrics: int,
    ) -> list[RetrievedContext]:
        """Rank metrics by relevance."""
        metrics = self._bundle.get("metrics", [])
        scored: list[tuple[float, dict]] = []

        for m in metrics:
            score = 0.0
            mid = m.get("id", "")

            if mid in seed_metrics:
                score += 1.5

            entity_id = m.get("entityId", "")
            if entity_id in seeds:
                score += 0.6
            elif entity_id in expanded:
                score += 0.3

            if score > 0:
                scored.append((score, m))

        scored.sort(key=lambda x: -x[0])

        results: list[RetrievedContext] = []
        for score, m in scored[:max_metrics]:
            mid = m.get("id", "?")
            desc = (m.get("description") or "")[:120]
            unit = m.get("unit", "")
            target = m.get("targetValue") or m.get("governance", {}).get("targetValue", "")
            line = f"- **{mid}**: {desc}"
            if target:
                line += f" (target: {target})"
            if unit:
                line += f" [{unit}]"
            results.append(RetrievedContext(
                source="metric",
                content=line,
                relevance=round(score / 1.5, 3),
                metadata={"metric_id": mid},
            ))

        return results

    def _ranked_relationships(
        self,
        seeds: set[str],
        expanded: set[str],
        max_rels: int,
    ) -> list[RetrievedContext]:
        """Rank relationships by proximity to seed entities."""
        relationships = self._bundle.get("relationships", [])
        scored: list[tuple[float, dict]] = []

        for r in relationships:
            gov = r.get("governance", {})
            if gov.get("status") not in (None, "approved"):
                continue

            score = 0.0
            src = r.get("sourceEntity", "")
            tgt = r.get("targetEntity", "")

            if src in seeds and tgt in seeds:
                score += 2.0  # Direct connection between seeds
            elif src in seeds or tgt in seeds:
                score += 1.0  # One end is a seed
            elif src in expanded and tgt in expanded:
                score += 0.4  # Both in expanded
            elif src in expanded or tgt in expanded:
                score += 0.2  # One end in expanded

            if score > 0:
                scored.append((score, r))

        scored.sort(key=lambda x: -x[0])

        results: list[RetrievedContext] = []
        for score, r in scored[:max_rels]:
            src = r.get("sourceEntity", "?")
            tgt = r.get("targetEntity", "?")
            pred = r.get("predicate", "?")
            content = f"- {src} --{pred}--> {tgt}"
            results.append(RetrievedContext(
                source="relationship",
                content=content,
                relevance=round(score / 2.0, 3),
                metadata={"relationship_id": r.get("id")},
            ))

        return results

    def _ranked_vocab(
        self, seed_terms: list[dict], max_vocab: int
    ) -> list[RetrievedContext]:
        """Rank vocabulary terms by match similarity."""
        seen: set[str] = set()
        sorted_terms = sorted(seed_terms, key=lambda t: -t.get("similarity", 0))

        results: list[RetrievedContext] = []
        for t in sorted_terms:
            tid = t.get("term_id", "")
            if tid in seen:
                continue
            seen.add(tid)

            res = t.get("resolution", {})
            res_parts = []
            for rk in ("metricId", "dimensionId", "entityId", "filterValue"):
                if rk in res:
                    res_parts.append(f"{rk}={res[rk]}")
            res_str = ", ".join(res_parts) if res_parts else str(res)

            phrase = t.get("phrase", "")
            content = f"- '{phrase}' → {res_str}"
            results.append(RetrievedContext(
                source="vocabulary",
                content=content,
                relevance=round(t.get("similarity", 0.5), 3),
                metadata={"term_id": tid},
            ))

            if len(results) >= max_vocab:
                break

        return results

    def _entity_summaries(
        self, seed_entities: set[str], max_entities: int
    ) -> list[RetrievedContext]:
        """Brief summaries of seed entities."""
        entities = self._bundle.get("entities", [])
        ent_map = {e["id"]: e for e in entities if "id" in e}

        results: list[RetrievedContext] = []
        for eid in sorted(seed_entities)[:max_entities]:
            ent = ent_map.get(eid)
            if not ent:
                continue
            labels = ent.get("labels", {})
            zh = labels.get("zh-CN", "")
            en = labels.get("en-US", "")
            desc = ent.get("descriptions", {}).get("zh-CN", "")
            content = f"- **{eid}** ({zh}/{en})"
            if desc:
                content += f": {desc[:80]}"
            results.append(RetrievedContext(
                source="entity",
                content=content,
                relevance=1.0,
                metadata={"entity_id": eid},
            ))

        return results

    # ── Assembly ───────────────────────────────────────────────────────

    def _assemble(
        self, fragments: list[RetrievedContext], max_chars: int
    ) -> str:
        """Assemble fragments into a single system-prompt string.

        Fragments are sorted by relevance (desc) and grouped by source.
        Truncated at max_chars on a line boundary.
        """
        if not fragments:
            return ""

        # Group by source
        groups: dict[str, list[RetrievedContext]] = defaultdict(list)
        for f in fragments:
            groups[f.source].append(f)

        # Sort within each group by relevance
        for source, items in groups.items():
            items.sort(key=lambda f: -f.relevance)

        # Define section order and titles
        section_order = [
            ("entity", "## Relevant Entities"),
            ("metric", "## Relevant Metrics"),
            ("constraint", "## Business Rules (Ontology)"),
            ("relationship", "## Entity Relationships"),
            ("vocabulary", "## Vocabulary Mapping"),
        ]

        sections: list[str] = []
        header = (
            "## Ontology Context (GraphRAG)\n\n"
            f"Retrieved {len(fragments)} fragments for this query."
        )
        sections.append(header)

        for source, title in section_order:
            items = groups.get(source, [])
            if not items:
                continue
            lines = [title, ""]
            for item in items:
                lines.append(item.content)
            sections.append("\n".join(lines))

        result = "\n\n".join(sections)

        if len(result) > max_chars:
            cut = result[: max_chars - 3]
            last_nl = cut.rfind("\n")
            if last_nl > max_chars // 2:
                cut = cut[:last_nl]
            result = cut.rstrip() + "..."

        return result

    def _default_fragments(self) -> list[RetrievedContext]:
        """Minimal fallback when no seeds are found."""
        # Include just the top-level guardrails
        constraints = self._bundle.get("constraints", [])
        approved = [
            c for c in constraints
            if c.get("governance", {}).get("status") in (None, "approved")
        ][:3]

        results: list[RetrievedContext] = []
        for c in approved:
            desc = c.get("description", c.get("id", ""))
            results.append(RetrievedContext(
                source="constraint",
                content=f"- {desc}",
                relevance=0.3,
                metadata={"constraint_id": c.get("id")},
            ))
        return results

    # ── Utility ────────────────────────────────────────────────────────

    @property
    def is_available(self) -> bool:
        return self._catalog is not None

    def summary(self) -> dict[str, Any]:
        return {
            "available": self.is_available,
            "embedding_resolver": self._embedding_resolver is not None
            and self._embedding_resolver.is_embedding_active,
            "graph_nodes": self._graph.node_count,
            "graph_edges": self._graph.edge_count,
            "total_constraints": len(self._bundle.get("constraints", [])),
            "total_metrics": len(self._bundle.get("metrics", [])),
            "total_terms": len(self._bundle.get("terms", [])),
        }
