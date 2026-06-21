"""Tests for Value Retriever

Tests cover:
1. Index building from database
2. Exact/alias/fuzzy matching
3. Question-level hint extraction
4. SQL WHERE enhancement
5. Multi-field retrieval
"""

import os
import sys
import pytest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.data.value_retriever import (
    ValueRetriever, ValueMatch, RetrievalResult,
    get_value_retriever,
)
from agent.data.adapter import resolve_data_db_path
from agent.ontology import OntologyEngine


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def ontology():
    ont_dir = PROJECT_ROOT / "agent" / "ontology"
    return OntologyEngine(ontology_dir=str(ont_dir))


@pytest.fixture
def vr(ontology):
    """ValueRetriever with real sample DB"""
    db_path = resolve_data_db_path()
    return ValueRetriever(db_path=db_path, ontology=ontology)


# ============================================================================
# Index Tests
# ============================================================================

class TestIndexBuilding:

    def test_index_built(self, vr):
        """Test that index is built from DB"""
        stats = vr.stats()
        assert stats["total_fields"] > 0
        assert stats["total_values"] > 0
        assert "project" in stats["fields"]
        assert "assigned_ecu" in stats["fields"]

    def test_project_values_indexed(self, vr):
        """Test project field has expected values"""
        stats = vr.stats()
        project_info = stats["fields"]["project"]
        assert project_info["values"] >= 5  # IDCEVO, MGU, IDC, App, RSU

    def test_aliases_loaded(self, vr):
        """Test ontology aliases are loaded"""
        stats = vr.stats()
        assert stats["total_aliases"] > 0
        # BCM should have aliases like "车身控制器"
        ecu_info = stats["fields"]["assigned_ecu"]
        assert ecu_info["aliases"] > 0


# ============================================================================
# Exact Match Tests
# ============================================================================

class TestExactMatch:

    def test_exact_project(self, vr):
        """Exact project match"""
        r = vr.retrieve("IDCEVO")
        assert r.best_match
        assert r.best_match.value == "IDCEVO"
        assert r.best_match.field == "project"
        assert r.best_match.source == "exact"
        assert r.best_match.score == 100.0

    def test_exact_case_insensitive(self, vr):
        """Case-insensitive exact match"""
        r = vr.retrieve("idcevo")
        assert r.best_match
        assert r.best_match.value == "IDCEVO"
        assert r.best_match.source == "exact"

    def test_exact_severity(self, vr):
        """Exact severity match"""
        r = vr.retrieve("Critical")
        assert r.best_match
        assert r.best_match.value == "Critical"
        assert r.best_match.field == "severity"

    def test_exact_ecu(self, vr):
        """Exact ECU match"""
        r = vr.retrieve("BCM")
        assert r.best_match
        assert r.best_match.value == "BCM"
        assert r.best_match.field == "assigned_ecu"

    def test_field_restricted_search(self, vr):
        """Search restricted to specific field"""
        r = vr.retrieve("IDCEVO", field="assigned_ecu")
        # IDCEVO is a project, not an ECU
        # Should not find exact match in assigned_ecu
        if r.matches:
            assert r.matches[0].source != "exact" or r.matches[0].field == "assigned_ecu"


# ============================================================================
# Alias Match Tests
# ============================================================================

class TestAliasMatch:

    def test_chinese_ecu_alias(self, vr):
        """Chinese alias → canonical ECU"""
        r = vr.retrieve("车身控制器")
        assert r.best_match
        assert r.best_match.value == "BCM"
        assert r.best_match.source == "alias"

    def test_english_ecu_alias(self, vr):
        """English alias → canonical ECU"""
        r = vr.retrieve("Body_Control_Module")
        assert r.best_match
        assert r.best_match.value == "BCM"

    def test_project_alias(self, vr):
        """Project alias match"""
        r = vr.retrieve("MGU22")
        assert r.best_match
        assert r.best_match.value == "MGU"

    def test_full_chinese_ecu_name(self, vr):
        """Full Chinese ECU name"""
        r = vr.retrieve("整车控制器")
        assert r.best_match
        assert r.best_match.value == "VCU"


# ============================================================================
# Fuzzy Match Tests
# ============================================================================

class TestFuzzyMatch:

    def test_partial_match(self, vr):
        """Partial string match"""
        r = vr.retrieve("CN Core")
        assert r.best_match
        assert "CN Core" in r.best_match.value

    def test_typo_tolerance(self, vr):
        """Typo tolerance via fuzzy matching"""
        r = vr.retrieve("IDCEV")  # Missing 'O'
        assert r.best_match
        assert r.best_match.value == "IDCEVO"
        assert r.best_match.score >= 65

    def test_no_match_for_garbage(self, vr):
        """Garbage input should not match"""
        r = vr.retrieve("xyzqwerty12345")
        assert len(r.matches) == 0 or r.best_match.score < 70


# ============================================================================
# Question Hints Tests
# ============================================================================

class TestQuestionHints:

    def test_hint_extraction_simple(self, vr):
        """Extract hints from simple question"""
        hints = vr.get_hints_for_question("IDCEVO有多少Critical缺陷")
        assert "project" in hints
        assert hints["project"]["best"] == "IDCEVO"
        assert "severity" in hints
        assert hints["severity"]["best"] == "Critical"

    def test_hint_extraction_alias(self, vr):
        """Extract hints using alias"""
        hints = vr.get_hints_for_question("车身控制器的严重问题")
        assert "assigned_ecu" in hints
        assert hints["assigned_ecu"]["best"] == "BCM"

    def test_hint_extraction_multi_field(self, vr):
        """Extract multiple field hints"""
        hints = vr.get_hints_for_question("CN Navigation团队的缺陷分布")
        # Should detect team and possibly market
        assert "problem_finder_team" in hints
        assert hints["problem_finder_team"]["best"] == "CN Navigation"

    def test_hint_no_false_positive(self, vr):
        """Common words shouldn't trigger false hints"""
        hints = vr.get_hints_for_question("有多少个缺陷")
        # Shouldn't falsely match any specific project/ECU
        assert "project" not in hints or hints["project"]["best"] in (
            "IDCEVO", "MGU", "IDC", "App", "RSU"
        )


# ============================================================================
# SQL Enhancement Tests
# ============================================================================

class TestSQLEnhancement:

    def test_enhance_where_clause(self, vr):
        """Test WHERE clause enhancement"""
        enhanced, hints = vr.enhance_sql_conditions(
            "IDCEVO有多少Critical缺陷"
        )
        assert "IDCEVO" in enhanced
        assert "Critical" in enhanced

    def test_enhance_with_base_clause(self, vr):
        """Test enhancement preserves base clause"""
        enhanced, hints = vr.enhance_sql_conditions(
            "车身控制器",
            base_where="year = 2026"
        )
        assert "year = 2026" in enhanced
        assert "BCM" in enhanced


# ============================================================================
# Singleton Test
# ============================================================================

class TestSingleton:

    def test_get_value_retriever(self):
        v1 = get_value_retriever()
        v2 = get_value_retriever()
        assert v1 is v2
