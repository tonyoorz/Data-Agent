"""Tests for NL→SQL Engine

Tests multi-path SQL generation, candidate selection, and overall pipeline.
"""

import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from agent.sql_engine.generator import NL2SQLEngine, SQLCandidate, get_nl2sql_engine
from agent.sql_engine.selector import SQLSelector
from agent.sql_engine.examples import get_all_examples, get_example_count, get_examples_by_intent
from agent.ontology import OntologyEngine


@pytest.fixture
def engine():
    ontology_dir = Path(__file__).parent.parent / "agent" / "ontology"
    ont = OntologyEngine(ontology_dir)
    return NL2SQLEngine(ontology=ont)


@pytest.fixture
def selector():
    return SQLSelector()


class TestFewShotExamples:

    def test_example_count(self):
        """Test we have 30+ examples"""
        assert get_example_count() >= 30

    def test_all_examples_have_required_fields(self):
        """Test all examples have question, sql, intent, explanation"""
        examples = get_all_examples()
        for ex in examples:
            assert "question" in ex
            assert "sql" in ex
            assert "intent" in ex
            assert "explanation" in ex

    def test_examples_by_intent(self):
        """Test filtering examples by intent"""
        count_examples = get_examples_by_intent("count", top_k=5)
        assert len(count_examples) > 0
        assert all(ex["intent"] == "count" for ex in count_examples)


class TestSQLGeneration:

    def test_generate_candidates_count_query(self, engine):
        """Test 3 candidates generated for count query"""
        candidates = engine.generate_candidates("IDCEVO 有多少缺陷")
        assert len(candidates) >= 2  # At least 2 of 3 should succeed
        for c in candidates:
            assert c.sql
            assert c.path in ("direct", "decomposed", "plan_based")

    def test_generate_candidates_trend_query(self, engine):
        """Test candidates for trend query"""
        candidates = engine.generate_candidates("近30天缺陷趋势")
        assert len(candidates) >= 2
        # At least one should have GROUP BY time
        has_time_grouping = any(
            "strftime" in c.sql.lower() or "date(" in c.sql.lower()
            for c in candidates
        )
        assert has_time_grouping

    def test_generate_candidates_distribution(self, engine):
        """Test candidates for distribution query"""
        candidates = engine.generate_candidates("缺陷按项目分布")
        assert len(candidates) >= 2
        # Should have GROUP BY
        has_group_by = any("group by" in c.sql.lower() for c in candidates)
        assert has_group_by

    def test_select_best(self, engine, selector):
        """Test best candidate selection"""
        question = "IDCEVO 本月 Critical 缺陷有多少"
        entities, intent, _ = engine.direct_gen.analyze_question(question)
        candidates = engine.generate_candidates(question)

        result = selector.select(candidates, question, entities, intent)
        assert result.best
        assert result.best.sql
        assert result.scores

    def test_full_query_pipeline(self, engine):
        """Test full NL→SQL pipeline"""
        result = engine.query("IDCEVO 有多少 Critical 缺陷")
        assert result.sql
        assert result.intent
        assert len(result.candidates) >= 2
        assert result.question == "IDCEVO 有多少 Critical 缺陷"


class TestSQLValidation:

    def test_valid_sql_passes(self, selector):
        """Test valid SQL passes validation"""
        sql = "SELECT COUNT(*) FROM octane_defects WHERE project = 'IDCEVO'"
        ok, err = selector.validate(sql)
        assert ok
        assert err is None

    def test_drop_blocked(self, selector):
        """Test DROP is blocked"""
        sql = "DROP TABLE octane_defects"
        ok, err = selector.validate(sql)
        assert not ok
        assert "Forbidden" in err

    def test_update_blocked(self, selector):
        """Test UPDATE is blocked"""
        sql = "UPDATE octane_defects SET severity = 'Low'"
        ok, err = selector.validate(sql)
        assert not ok

    def test_missing_from(self, selector):
        """Test missing FROM clause"""
        sql = "SELECT COUNT(*)"
        ok, err = selector.validate(sql)
        assert not ok


class TestSpecificQueries:

    def test_count_with_filters(self, engine):
        """Test count query with multiple filters"""
        result = engine.query("IDCEVO BCM Critical 缺陷有多少")
        assert "COUNT" in result.sql.upper() or "count" in result.sql.lower()
        assert "IDCEVO" in result.sql
        assert "BCM" in result.sql or "assigned_ecu" in result.sql.lower()

    def test_ranking_query(self, engine):
        """Test ranking query has ORDER BY and LIMIT"""
        result = engine.query("缺陷最多的 TOP 5 ECU")
        assert "ORDER BY" in result.sql.upper() or "order by" in result.sql.lower()
        assert "LIMIT" in result.sql.upper() or "limit" in result.sql.lower()

    def test_distribution_query(self, engine):
        """Test distribution query has GROUP BY"""
        result = engine.query("缺陷按严重度分布")
        assert "GROUP BY" in result.sql.upper() or "group by" in result.sql.lower()
