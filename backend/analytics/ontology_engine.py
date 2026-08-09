"""
OntologyEngine — one-stop ontology reasoning engine.

Wires all ontology modules together into a single entry point:
- TermResolver: natural language → ontology concepts
- PromptBuilder: ontology → system prompt context
- Graph: entity relationship traversal
- Guardrail: pre-execution validation
- DriftDetector: schema integrity monitoring
- Discovery: automated gap detection
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
        return self._resolver.resolve_metric(text)

    def resolve_dimension(self, text: str) -> str | None:
        """Convenience: extract best dimension_id from text."""
        return self._resolver.resolve_dimension(text)

    def resolve_entity(self, text: str) -> str | None:
        """Convenience: extract best entity_id from text."""
        return self._resolver.resolve_entity(text)

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

    # === Summary ===

    def summary(self) -> dict[str, Any]:
        """One-glance status summary of the ontology engine."""
        return {
            "available": self.is_available,
            "entities": self.entity_count,
            "relationships": self.relationship_count,
            "constraints": self.constraint_count,
            "actions": self.action_count,
            "vocab_terms": self._resolver.term_count,
            "guardrail_rules": len(self.list_guardrail_rules()),
            "prompt_context_chars": len(self.system_prompt_context),
        }
