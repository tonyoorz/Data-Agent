"""OntologyTermResolver — maps free-text phrases to ontology terms.

Scans text for known ontology phrases (case-insensitive, CJK-aware),
resolves overlaps by longest-match-wins, and exposes typed accessors
for metricId / dimensionId / entityId resolution.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology


@dataclass(frozen=True)
class TermMatch:
    """A single phrase match within scanned text."""

    term_id: str
    phrase: str
    kind: str  # synonym, concept, derived_business_rule
    resolution: dict[str, Any]  # metricId, dimensionId, entityId
    start: int  # char position in text
    end: int
    score: float  # confidence in [0, 1]


def _normalise(text: str) -> str:
    """Lowercase and strip whitespace for case-insensitive comparison."""
    return text.lower()


def _whitespace_normalised(text: str) -> str:
    """Remove all whitespace and hyphens for fuzzy phrase comparison."""
    return re.sub(r"[\s\-_]+", "", text.lower())


class OntologyTermResolver:
    """Resolve free-text mentions to ontology terms via phrase matching."""

    def __init__(self, catalog: OntologyCatalog | None = None):
        try:
            self._catalog = catalog or load_ontology()
        except OntologyLoadError:
            self._catalog = None
            self._terms: list[dict[str, Any]] = []
            self._phrase_index: dict[str, list[dict[str, Any]]] = {}
            return
        self._terms = self._catalog.bundle.get("terms", [])
        self._phrase_index = self._build_phrase_index()

    # ─── Index construction ──────────────────────────────────────

    def _build_phrase_index(self) -> dict[str, list[dict[str, Any]]]:
        """Map lowercased phrase → list of term dicts.

        Each entry in the list is the full term dict so we can access
        id, kind, resolution, and original phrases at match time.
        """
        index: dict[str, list[dict[str, Any]]] = {}
        for term in self._terms:
            for phrase in term.get("phrases", []):
                key = _normalise(phrase)
                index.setdefault(key, []).append(term)
        return index

    # ─── Core resolve ────────────────────────────────────────────

    def resolve(self, text: str) -> list[TermMatch]:
        """Scan *text* for known phrases (case-insensitive).

        - Longest match wins for overlapping ranges at the same start.
        - Returns matches sorted by position, then by score descending.
        """
        if not text or not self._phrase_index:
            return []

        text_lower = text.lower()
        text_len = len(text)
        raw_matches: list[TermMatch] = []

        # Collect all phrase occurrences
        for phrase_lower, terms in self._phrase_index.items():
            if not phrase_lower:
                continue
            start = 0
            while True:
                pos = text_lower.find(phrase_lower, start)
                if pos == -1:
                    break
                end = pos + len(phrase_lower)
                original_phrase = text[pos:end]

                # Score: base = phrase_len / text_len, bonus for exact case
                base = len(phrase_lower) / text_len if text_len > 0 else 0.0
                case_bonus = 0.05 if original_phrase == phrase_lower else 0.0
                # Slight bonus for longer phrases (reduces noise from short generic terms)
                length_bonus = min(0.05, len(phrase_lower) / 200.0)
                score = min(1.0, base + case_bonus + length_bonus)

                for term in terms:
                    raw_matches.append(
                        TermMatch(
                            term_id=term["id"],
                            phrase=original_phrase,
                            kind=term.get("kind", "synonym"),
                            resolution=term.get("resolution", {}),
                            start=pos,
                            end=end,
                            score=score,
                        )
                    )
                start = pos + 1  # allow overlapping finds

        if not raw_matches:
            return []

        # Deduplicate: sort by (start asc, length desc, score desc) then pick best per start
        raw_matches.sort(key=lambda m: (m.start, -(m.end - m.start), -m.score))

        # Filter overlapping and deduplicate:
        # - If a match fully contains another, keep only the longest.
        # - If the same term_id matches at the same (start, end), keep only one.
        result: list[TermMatch] = []
        seen: set[tuple[str, int, int]] = set()
        for m in raw_matches:
            key = (m.term_id, m.start, m.end)
            if key in seen:
                continue
            dominated = False
            for kept in result:
                # If kept fully contains m and is strictly longer, drop m
                if kept.start <= m.start and kept.end >= m.end and (kept.start, kept.end) != (m.start, m.end):
                    dominated = True
                    break
                # If m fully contains kept (shouldn't happen after sort, but guard)
                if m.start <= kept.start and m.end >= kept.end and (m.start, m.end) != (kept.start, kept.end):
                    result.remove(kept)
            if not dominated:
                result.append(m)
                seen.add(key)

        # Final sort by position, then score desc
        result.sort(key=lambda m: (m.start, -m.score))
        return result

    # ─── Typed accessors ─────────────────────────────────────────

    def resolve_metric(self, text: str) -> str | None:
        """Return the best metricId from resolve() or None."""
        for m in self.resolve(text):
            metric_id = m.resolution.get("metricId")
            if metric_id:
                return metric_id
        return None

    def resolve_dimension(self, text: str) -> str | None:
        """Return the best dimensionId from resolve() or None."""
        for m in self.resolve(text):
            dim_id = m.resolution.get("dimensionId")
            if dim_id:
                return dim_id
        return None

    def resolve_entity(self, text: str) -> str | None:
        """Return the best entityId from resolve() or None."""
        for m in self.resolve(text):
            entity_id = m.resolution.get("entityId")
            if entity_id:
                return entity_id
        return None

    # ─── Utility ─────────────────────────────────────────────────

    @property
    def term_count(self) -> int:
        return len(self._terms)

    def list_phrases(self) -> list[str]:
        """All known phrases, sorted by length descending."""
        phrases: list[str] = []
        for term in self._terms:
            phrases.extend(term.get("phrases", []))
        phrases.sort(key=len, reverse=True)
        return phrases
