"""OntologyDiscovery — analyses query logs for gaps and relationship candidates."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class TermCandidate:
    """An unknown phrase discovered in query logs."""

    phrase: str
    frequency: int
    sample_queries: list[str]
    suggested_resolution: str | None = None  # entity/metric/dimension id


@dataclass
class RelCandidate:
    """Two entities that co-occur in queries but lack an ontology relationship."""

    entity_a: str
    entity_b: str
    co_occurrence_count: int
    existing_relationship: bool


@dataclass
class DiscoveryReport:
    """Aggregated discovery results."""

    unresolved_phrases: list[TermCandidate] = field(default_factory=list)
    relationship_candidates: list[RelCandidate] = field(default_factory=list)
    total_queries_analyzed: int = 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Tokens that are purely structural / SQL-ish and should never be "discovered".
_STOPWORDS: frozenset[str] = frozenset({
    "the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "by",
    "with", "from", "at", "is", "are", "was", "were", "be", "been",
    "show", "list", "get", "find", "count", "sum", "avg", "average",
    "group", "order", "where", "select", "having", "as", "how", "many",
    "per", "each", "all", "this", "that", "these", "those", "it",
    "we", "i", "me", "my", "our", "you", "your",
    "please", "can", "could", "would", "should", "do", "does",
    "what", "which", "who", "when", "why", "tell",
    "total", "number", "data", "query", "table",
})

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{1,}")


def _tokenise(query: str) -> list[str]:
    """Extract significant word tokens from *query*."""
    return [t for t in _TOKEN_RE.findall(query.lower()) if t not in _STOPWORDS and len(t) > 1]


# ---------------------------------------------------------------------------
# Discovery engine
# ---------------------------------------------------------------------------


class OntologyDiscovery:
    """Analyse query logs for unresolved terms and relationship gaps."""

    def __init__(self, catalog: OntologyCatalog | None = None) -> None:
        self._catalog = catalog or load_ontology()
        self._known_phrases: set[str] = set()
        self._entity_ids: set[str] = set()
        self._entity_aliases: dict[str, str] = {}  # lower alias -> entity id
        self._existing_rel_pairs: set[tuple[str, str]] = set()

        bundle = self._catalog.bundle
        # Known phrases from terms
        for term in bundle.get("terms", []):
            for phrase in term.get("phrases", []):
                self._known_phrases.add(phrase.lower().strip())
        # Entity ids + aliases (also register in known_phrases so they're
        # not flagged as unresolved terms, and add simple plural forms).
        for entity in bundle.get("entities", []):
            eid = entity.get("id", "")
            self._entity_ids.add(eid)
            self._known_phrases.add(eid.lower())
            self._register_alias(eid.lower(), eid)
            for alias in entity.get("aliases", []):
                alias_lower = alias.lower()
                self._known_phrases.add(alias_lower)
                self._register_alias(alias_lower, eid)
            # also match individual property ids
            for prop in entity.get("properties", []):
                pid = prop.get("id", "")
                if pid:
                    self._known_phrases.add(pid.lower())
        # Dimension/metric labels are also known phrases
        for dim in bundle.get("dimensions", []):
            if "id" in dim:
                self._known_phrases.add(dim["id"].lower())
        for metric in bundle.get("metrics", []):
            if "id" in metric:
                self._known_phrases.add(metric["id"].lower())
        # Existing relationships (normalised as frozenset pairs)
        for rel in bundle.get("relationships", []):
            src = rel.get("sourceEntity", "")
            tgt = rel.get("targetEntity", "")
            if src and tgt:
                self._existing_rel_pairs.add((src, tgt))
                self._existing_rel_pairs.add((tgt, src))

    def _register_alias(self, phrase: str, entity_id: str) -> None:
        """Register an alias and its simple plural (phrase + 's') to entity_id."""
        self._entity_aliases[phrase] = entity_id
        if not phrase.endswith("s"):
            self._entity_aliases[phrase + "s"] = entity_id
            self._known_phrases.add(phrase + "s")

    # -- public API ---------------------------------------------------------

    def analyse_query_logs(self, logs: list[dict]) -> DiscoveryReport:
        """Analyse query logs for unresolved terms and relationship gaps.

        Each log entry is expected to be::

            {"query": str, "timestamp": str, "user": str}
        """
        report = DiscoveryReport(total_queries_analyzed=len(logs))

        # --- unresolved phrases ---
        unknown_counter: Counter[str] = Counter()
        unknown_samples: dict[str, list[str]] = defaultdict(list)

        for entry in logs:
            query_text = entry.get("query", "")
            tokens = _tokenise(query_text)
            for token in tokens:
                if token not in self._known_phrases:
                    unknown_counter[token] += 1
                    if len(unknown_samples[token]) < 5:
                        unknown_samples[token].append(query_text)

        for phrase, freq in unknown_counter.most_common():
            report.unresolved_phrases.append(TermCandidate(
                phrase=phrase,
                frequency=freq,
                sample_queries=unknown_samples[phrase],
            ))

        # --- relationship candidates ---
        report.relationship_candidates = self.suggest_new_relationships(logs)

        return report

    # Keep the British spelling as an alias for the tests / external callers.
    def analyze_query_logs(self, logs: list[dict]) -> DiscoveryReport:
        return self.analyse_query_logs(logs)

    def suggest_new_terms(self, report: DiscoveryReport, top_n: int = 20) -> list[TermCandidate]:
        """Rank and return top candidates for new ontology terms."""
        return sorted(report.unresolved_phrases, key=lambda c: c.frequency, reverse=True)[:top_n]

    def suggest_new_relationships(self, logs: list[dict]) -> list[RelCandidate]:
        """Find entity pairs co-occurring in queries but not connected in ontology."""
        co_occurrence: Counter[tuple[str, str]] = Counter()

        for entry in logs:
            query_text = entry.get("query", "")
            tokens = _tokenise(query_text)
            found_entities: set[str] = set()
            for token in tokens:
                eid = self._entity_aliases.get(token)
                if eid:
                    found_entities.add(eid)
            # Also check multi-word entity ids (e.g. "quality.defect")
            query_lower = query_text.lower()
            for eid in self._entity_ids:
                if eid.lower() in query_lower:
                    found_entities.add(eid)

            found_list = sorted(found_entities)
            for i in range(len(found_list)):
                for j in range(i + 1, len(found_list)):
                    co_occurrence[(found_list[i], found_list[j])] += 1

        candidates: list[RelCandidate] = []
        for (ea, eb), count in co_occurrence.most_common():
            existing = (ea, eb) in self._existing_rel_pairs
            candidates.append(RelCandidate(
                entity_a=ea,
                entity_b=eb,
                co_occurrence_count=count,
                existing_relationship=existing,
            ))

        return candidates
