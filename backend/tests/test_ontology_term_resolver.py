"""Tests for OntologyTermResolver — term disambiguation engine."""
from __future__ import annotations

import pytest

from backend.analytics.ontology import load_ontology
from backend.analytics.ontology_term_resolver import OntologyTermResolver, TermMatch


@pytest.fixture(scope="module")
def resolver() -> OntologyTermResolver:
    return OntologyTermResolver()


# ─── Basic matching ──────────────────────────────────────────────

class TestExactMatch:
    def test_exact_match(self, resolver: OntologyTermResolver) -> None:
        matches = resolver.resolve("Top Issue")
        assert len(matches) >= 1
        m = matches[0]
        assert m.term_id == "concept.top_issue"
        assert m.resolution.get("metricId") == "defect.top_issue_count"

    def test_exact_match_returns_term_match_type(self, resolver: OntologyTermResolver) -> None:
        matches = resolver.resolve("Top Issue")
        assert isinstance(matches[0], TermMatch)


class TestCJKMatch:
    def test_cjk_match(self, resolver: OntologyTermResolver) -> None:
        matches = resolver.resolve("成熟度")
        assert len(matches) >= 1
        m = matches[0]
        assert m.term_id == "concept.maturity_grade"
        assert m.resolution.get("dimensionId") == "quality.maturity_grade"

    def test_cjk_in_longer_text(self, resolver: OntologyTermResolver) -> None:
        matches = resolver.resolve("当前的成熟度等级是多少")
        assert len(matches) >= 1
        assert matches[0].term_id == "concept.maturity_grade"


class TestCaseInsensitive:
    def test_case_insensitive(self, resolver: OntologyTermResolver) -> None:
        matches_lower = resolver.resolve("top issue")
        matches_upper = resolver.resolve("Top Issue")
        assert len(matches_lower) >= 1
        assert matches_lower[0].term_id == matches_upper[0].term_id


# ─── Overlap & priority ─────────────────────────────────────────

class TestLongestPhraseWins:
    def test_longest_phrase_wins(self, resolver: OntologyTermResolver) -> None:
        """If 'Top Issue' and a shorter substring phrase overlap, the longer wins."""
        # "Top Issue" contains "Issue" if it were a phrase — verify longest wins
        matches = resolver.resolve("Top Issue")
        # Should match concept.top_issue, not any shorter overlapping term
        term_ids = [m.term_id for m in matches]
        assert "concept.top_issue" in term_ids
        # Each position should only have the longest match
        positions = [(m.start, m.end) for m in matches]
        # No two matches should fully overlap the same start position
        # with different lengths — longest wins
        for i, (s1, e1) in enumerate(positions):
            for j, (s2, e2) in enumerate(positions):
                if i != j and s1 == s2:
                    # same start — only the longer one should remain
                    assert e1 == e2, f"Overlapping at pos {s1}: {e1} vs {e2}"


class TestOverlappingPhrases:
    def test_overlapping_phrases_keep_longest(self, resolver: OntologyTermResolver) -> None:
        """Longest phrase takes priority in overlapping scenarios."""
        text = "Q-Gate 检查"
        matches = resolver.resolve(text)
        assert len(matches) >= 1
        # Q-Gate should resolve to concept.qgate
        qgate_matches = [m for m in matches if m.term_id == "concept.qgate"]
        assert len(qgate_matches) >= 1


class TestPhraseWithWhitespace:
    def test_phrase_with_whitespace(self, resolver: OntologyTermResolver) -> None:
        """'Q-Gate' matches 'Q Gate' and 'qgate' (normalised forms)."""
        # Q-Gate
        m1 = resolver.resolve("Q-Gate")
        assert any(m.term_id == "concept.qgate" for m in m1)
        # Q Gate (space variant)
        m2 = resolver.resolve("Q Gate")
        assert any(m.term_id == "concept.qgate" for m in m2)
        # qgate (no separator)
        m3 = resolver.resolve("qgate")
        assert any(m.term_id == "concept.qgate" for m in m3)


# ─── Multiple matches & no match ────────────────────────────────

class TestMultipleMatches:
    def test_multiple_matches(self, resolver: OntologyTermResolver) -> None:
        text = "Top Issue 和 成熟度"
        matches = resolver.resolve(text)
        term_ids = {m.term_id for m in matches}
        assert "concept.top_issue" in term_ids
        assert "concept.maturity_grade" in term_ids

    def test_matches_sorted_by_position(self, resolver: OntologyTermResolver) -> None:
        text = "Top Issue 成熟度"
        matches = resolver.resolve(text)
        if len(matches) >= 2:
            assert matches[0].start < matches[1].start


class TestNoMatch:
    def test_no_match(self, resolver: OntologyTermResolver) -> None:
        matches = resolver.resolve("xyzzy_nomatch_text_12345")
        assert matches == []

    def test_empty_string(self, resolver: OntologyTermResolver) -> None:
        matches = resolver.resolve("")
        assert matches == []


# ─── Direct resolve helpers ─────────────────────────────────────

class TestResolveMetric:
    def test_resolve_metric(self, resolver: OntologyTermResolver) -> None:
        metric_id = resolver.resolve_metric("Top Issue")
        assert metric_id == "defect.top_issue_count"

    def test_resolve_metric_none(self, resolver: OntologyTermResolver) -> None:
        assert resolver.resolve_metric("xyzzy_no_match") is None


class TestResolveDimension:
    def test_resolve_dimension(self, resolver: OntologyTermResolver) -> None:
        dim_id = resolver.resolve_dimension("成熟度")
        assert dim_id == "quality.maturity_grade"

    def test_resolve_dimension_none(self, resolver: OntologyTermResolver) -> None:
        assert resolver.resolve_dimension("xyzzy_no_match") is None


class TestResolveEntity:
    def test_resolve_entity(self, resolver: OntologyTermResolver) -> None:
        entity_id = resolver.resolve_entity("Top Issue")
        assert entity_id == "quality.defect"

    def test_resolve_entity_none(self, resolver: OntologyTermResolver) -> None:
        assert resolver.resolve_entity("xyzzy_no_match") is None


# ─── Loader & utility ───────────────────────────────────────────

class TestLoadsFromCompiledBundle:
    def test_loads_from_compiled_bundle(self) -> None:
        """Resolver loads successfully via load_ontology()."""
        r = OntologyTermResolver()
        catalog = load_ontology()
        assert r.term_count == len(catalog.bundle.get("terms", []))

    def test_term_count_positive(self, resolver: OntologyTermResolver) -> None:
        assert resolver.term_count > 0

    def test_list_phrases_sorted_by_length_desc(self, resolver: OntologyTermResolver) -> None:
        phrases = resolver.list_phrases()
        assert len(phrases) > 0
        for i in range(len(phrases) - 1):
            assert len(phrases[i]) >= len(phrases[i + 1])


# ─── TermMatch dataclass ────────────────────────────────────────

class TestTermMatchFields:
    def test_term_match_has_all_fields(self, resolver: OntologyTermResolver) -> None:
        matches = resolver.resolve("Top Issue")
        m = matches[0]
        assert hasattr(m, "term_id")
        assert hasattr(m, "phrase")
        assert hasattr(m, "kind")
        assert hasattr(m, "resolution")
        assert hasattr(m, "start")
        assert hasattr(m, "end")
        assert hasattr(m, "score")
        assert m.start < m.end
        assert m.score > 0.0
