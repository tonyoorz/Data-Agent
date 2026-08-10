"""
OntologyEngine — one-stop ontology reasoning engine.

Wires all ontology modules together into a single entry point:
- TermResolver: natural language → ontology concepts (string matching)
- EmbeddingResolver: semantic phrase matching (BGE embeddings)
- PromptBuilder: ontology → system prompt context
- GraphRAG: query-specific ontology context retrieval
- Graph: entity relationship traversal
- Guardrail: pre-execution validation
- DriftDetector: schema integrity monitoring
- Discovery: automated gap detection
- AutoUpdate: closed-loop discovery → proposal → review pipeline
"""
from __future__ import annotations

from functools import cached_property
from pathlib import Path
from typing import Any

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology
from backend.analytics.ontology_term_resolver import OntologyTermResolver, TermMatch
from backend.analytics.ontology_prompt import OntologyPromptBuilder
from backend.analytics.ontology_graph import OntologyGraph, GraphPath
from backend.analytics.ontology_guardrail import (
    ConstraintGuardrail,
    GuardrailResult,
    GuardrailViolation,
)


class OntologyEngine:
    """Unified ontology reasoning engine.

    Single entry point that provides:
    - Term resolution (NL → metric/dimension/entity)
    - System prompt context generation
    - Graph traversal (multi-hop entity relationships)
    - Pre-execution guardrail validation
    - Schema drift detection (optional, requires DB path)
    - Query log gap discovery (optional, requires logs)
    """

    def __init__(
        self,
        catalog: OntologyCatalog | None = None,
        db_path: Path | None = None,
    ):
        try:
            self._catalog = catalog or load_ontology()
        except OntologyLoadError:
            self._catalog = None

        self._db_path = db_path
        self._resolver = OntologyTermResolver(self._catalog)
        self._prompt = OntologyPromptBuilder(self._catalog)
        self._graph = OntologyGraph(self._catalog)
        self._guardrail = ConstraintGuardrail(self._catalog)

        # Lazy-loaded modules (only when needed)
        self._drift = None
        self._discovery = None
        self._embedding_resolver = None
        self._rag = None
        self._auto_update = None

    @property
    def catalog(self) -> OntologyCatalog | None:
        return self._catalog

    @property
    def is_available(self) -> bool:
        """True if ontology compiled bundle is loaded."""
        return self._catalog is not None

    # === Term Resolution ===

    def resolve_terms(self, text: str) -> list[TermMatch]:
        """Resolve natural language text to ontology terms.

        Args:
            text: User's natural language query

        Returns:
            List of TermMatch objects, sorted by position then score
        """
        return self._resolver.resolve(text)

    def resolve_metric(self, text: str) -> str | None:
        """Convenience: extract best metric_id from text."""
        # Try embedding resolver first if available
        if self.embedding_resolver.is_embedding_active:
            mid = self.embedding_resolver.resolve_metric(text)
            if mid:
                return mid
        return self._resolver.resolve_metric(text)

    def resolve_dimension(self, text: str) -> str | None:
        """Convenience: extract best dimension_id from text."""
        if self.embedding_resolver.is_embedding_active:
            dim = self.embedding_resolver.resolve_dimension(text)
            if dim:
                return dim
        return self._resolver.resolve_dimension(text)

    def resolve_entity(self, text: str) -> str | None:
        """Convenience: extract best entity_id from text."""
        if self.embedding_resolver.is_embedding_active:
            eid = self.embedding_resolver.resolve_entity(text)
            if eid:
                return eid
        return self._resolver.resolve_entity(text)

    # === Embedding-based Resolution (lazy) ===

    @property
    def embedding_resolver(self):
        """Embedding-based ontology term resolver (lazy-loaded)."""
        if self._embedding_resolver is None:
            try:
                from backend.analytics.ontology_embedding_resolver import OntologyEmbeddingResolver
                self._embedding_resolver = OntologyEmbeddingResolver(self._catalog)
            except Exception:
                # Fallback: create a stub that always returns empty
                self._embedding_resolver = _NullEmbeddingResolver()
        return self._embedding_resolver

    def resolve_terms_hybrid(self, text: str, top_k: int = 10):
        """Hybrid resolve: string matching + embedding similarity.

        Returns a merged list of TermMatch and EmbeddingTermMatch objects.
        """
        return self.embedding_resolver.resolve_hybrid(text, top_k=top_k)

    # === Prompt Generation ===

    @cached_property
    def system_prompt_context(self) -> str:
        """Auto-generated system prompt context from ontology.

        Includes:
        - Business rules (approved constraints)
        - Metric glossary
        - Business vocabulary
        - Key entity relationships
        """
        return self._prompt.build_system_context()

    def build_prompt(self, *, max_chars: int = 4000) -> str:
        """Build system prompt context with custom size limit."""
        return self._prompt.build_system_context(max_chars=max_chars)

    def build_rag_prompt(self, query: str, *, max_chars: int = 3000) -> str:
        """Build query-specific ontology context using GraphRAG.

        Instead of injecting the full ontology, retrieves only the
        relevant subsets based on entities/metrics in the query.

        Falls back to full build_prompt() if RAG is unavailable.
        """
        rag = self.rag
        if not rag.is_available:
            return self.build_prompt(max_chars=max_chars)
        result = rag.retrieve(query, max_chars=max_chars)
        return result.assembled_context

    # === GraphRAG (lazy) ===

    @property
    def rag(self):
        """Graph-enhanced ontology context retriever (lazy-loaded)."""
        if self._rag is None:
            try:
                from backend.analytics.ontology_rag import OntologyRAG
                self._rag = OntologyRAG(
                    catalog=self._catalog,
                    graph=self._graph,
                    term_resolver=self._resolver,
                )
            except Exception:
                self._rag = _NullRAG()
        return self._rag

    def list_guardrail_rules(self) -> list[str]:
        """Human-readable list of active business rules."""
        return self._guardrail.list_active_rules()

    def list_available_actions(self) -> list[dict[str, Any]]:
        """List all approved agent actions."""
        return self._guardrail.list_available_actions()

    # === Graph Operations ===

    def explore_graph(self, entity_id: str, max_hops: int = 2) -> list[GraphPath]:
        """Multi-hop traversal from an entity.

        Example:
            engine.explore_graph("quality.defect", max_hops=3)
            → finds all entities reachable within 3 hops
        """
        return self._graph.neighbors(entity_id, max_hops=max_hops)

    def shortest_path(self, source: str, target: str) -> list[str] | None:
        """Shortest path between two entity types."""
        return self._graph.shortest_path(source, target)

    def explain_path(self, path: list[str]) -> str:
        """Human-readable path explanation."""
        return self._graph.explain_path(path)

    def graph_subgraph(self, entity_ids: list[str], radius: int = 1) -> dict:
        """Extract subgraph around given entities."""
        return self._graph.subgraph(entity_ids, radius=radius)

    def graph_to_mermaid(self, max_nodes: int = 30) -> str:
        """Generate Mermaid diagram for visualization."""
        return self._graph.to_mermaid(max_nodes=max_nodes)

    @property
    def entity_count(self) -> int:
        return self._graph.node_count

    @property
    def relationship_count(self) -> int:
        return self._graph.edge_count

    # === Guardrail ===

    def validate_query(
        self,
        metric_id: str,
        dimensions: list[str] | None = None,
        filters: dict | None = None,
    ) -> GuardrailResult:
        """Validate a query before execution.

        Checks metric exists, dimensions applicable, constraints satisfied.
        """
        return self._guardrail.validate_query(metric_id, dimensions, filters)

    def validate_action(self, action_id: str, params: dict | None = None) -> GuardrailResult:
        """Validate if an action is permitted."""
        return self._guardrail.validate_action(action_id, params)

    def check_metric_target(self, metric_id: str, value: float) -> GuardrailResult:
        """Check if a computed value meets the metric's target."""
        return self._guardrail.check_metric_target(metric_id, value)

    @property
    def constraint_count(self) -> int:
        return self._guardrail.constraint_count

    @property
    def action_count(self) -> int:
        return self._guardrail.action_count

    # === Schema Drift (lazy) ===

    def check_schema_drift(self):
        """Detect ontology vs database schema drift.

        Returns DriftReport. Requires db_path to be set.
        """
        if self._drift is None:
            from backend.analytics.ontology_drift import SchemaDriftDetector
            self._drift = SchemaDriftDetector(self._catalog, self._db_path)
        return self._drift.detect_drift()

    def suggest_column_mappings(self):
        """Suggest ontology property mappings for unmapped DB columns."""
        if self._drift is None:
            from backend.analytics.ontology_drift import SchemaDriftDetector
            self._drift = SchemaDriftDetector(self._catalog, self._db_path)
        return self._drift.suggest_mappings(self._drift.detect_drift())

    # === Discovery (lazy) ===

    def analyze_query_logs(self, logs: list[dict]):
        """Analyze query logs for ontology gaps.

        Returns DiscoveryReport with unresolved phrases and relationship candidates.
        """
        if self._discovery is None:
            from backend.analytics.ontology_discovery import OntologyDiscovery
            self._discovery = OntologyDiscovery(self._catalog)
        return self._discovery.analyze_query_logs(logs)

    # === Auto-Update (lazy) ===

    @property
    def auto_update(self):
        """Automated ontology discovery and proposal pipeline (lazy-loaded)."""
        if self._auto_update is None:
            try:
                from backend.analytics.ontology_auto_update import OntologyAutoUpdate
                self._auto_update = OntologyAutoUpdate(
                    catalog=self._catalog,
                    db_path=self._db_path,
                )
            except Exception:
                self._auto_update = _NullAutoUpdate()
        return self._auto_update

    def run_auto_analysis(self, query_logs: list[dict] | None = None):
        """Run automated ontology gap analysis.

        Returns a structured report with schema drift, vocab gaps,
        relationship candidates, and draft proposals.
        """
        if query_logs:
            from backend.analytics.ontology_auto_update import OntologyAutoUpdate
            self._auto_update = OntologyAutoUpdate(
                catalog=self._catalog,
                db_path=self._db_path,
                query_logs=query_logs,
            )
        return self.auto_update.generate_report()

    # === Summary ===

    def summary(self) -> dict[str, Any]:
        """One-glance status summary of the ontology engine."""
        emb_active = False
        try:
            emb_active = self.embedding_resolver.is_embedding_active
        except Exception:
            pass

        return {
            "available": self.is_available,
            "entities": self.entity_count,
            "relationships": self.relationship_count,
            "constraints": self.constraint_count,
            "actions": self.action_count,
            "vocab_terms": self._resolver.term_count,
            "guardrail_rules": len(self.list_guardrail_rules()),
            "prompt_context_chars": len(self.system_prompt_context),
            "embedding_active": emb_active,
            "embedding_phrases": self.embedding_resolver.phrase_count if emb_active else 0,
            "rag_available": self.rag.is_available,
        }


# ─── Null/stub implementations for graceful degradation ────────────────────


class _NullEmbeddingResolver:
    """Stub that reports embedding resolver as inactive."""

    is_embedding_active = False
    phrase_count = 0

    def resolve(self, *args, **kwargs):
        return []

    def resolve_hybrid(self, text, top_k=10):
        from backend.analytics.ontology_term_resolver import OntologyTermResolver
        resolver = OntologyTermResolver(None)
        return resolver.resolve(text)

    def resolve_metric(self, *args, **kwargs):
        return None

    def resolve_dimension(self, *args, **kwargs):
        return None

    def resolve_entity(self, *args, **kwargs):
        return None


class _NullRAG:
    """Stub that reports RAG as unavailable."""

    is_available = False

    def retrieve(self, *args, **kwargs):
        from backend.analytics.ontology_rag import RetrievalResult
        return RetrievalResult(query=args[0] if args else "")


class _NullAutoUpdate:
    """Stub that reports auto-update as unavailable."""

    def generate_report(self, *args, **kwargs):
        return {"error": "auto_update_unavailable"}
