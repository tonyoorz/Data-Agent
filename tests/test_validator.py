"""Tests for Result Validator (MARS-style)

Tests cover:
1. Rule-based checks (empty, large, uniform, pct sum, intent alignment)
2. LLM-based semantic validation
3. Integration with NL2SQLEngine (fixer + validator pipeline)
"""

import os
import sys
import pytest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.sql_engine.validator import (
    ResultValidator, ValidationLevel, ValidationVerdict, ValidationIssue,
    get_result_validator,
)


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def validator():
    """Pure rule-based validator (no LLM)"""
    return ResultValidator(llm_call_fn=None, enable_llm_validation=False)


@pytest.fixture
def llm_validator():
    """Validator with LLM (if available)"""
    from agent.llm.client import get_llm_client, load_env
    load_env()
    llm = get_llm_client()
    if llm is None:
        pytest.skip("No LLM API key")
    return ResultValidator(llm_call_fn=llm.as_fixer_fn(), enable_llm_validation=True)


# ============================================================================
# Empty Result Tests
# ============================================================================

class TestEmptyResult:
    """Test empty result detection"""

    def test_empty_data_expecting_question(self, validator):
        """Empty result for a data-expecting question = ERROR"""
        verdict = validator.validate(
            question="IDCEVO有多少Critical缺陷",
            sql="SELECT * FROM octane_defects WHERE project='FAKE'",
            rows=[],
            intent="detail_list"
        )
        assert not verdict.passed
        assert any(i.check == "empty_result" for i in verdict.issues)

    def test_empty_non_data_question(self, validator):
        """Empty result for non-data question = OK"""
        verdict = validator.validate(
            question="数据库里有什么表",
            sql="SELECT * FROM octane_defects WHERE 1=0",
            rows=[],
            intent="help"
        )
        assert verdict.passed

    def test_empty_count_query(self, validator):
        """Empty result for count intent = OK (count=0 is valid)"""
        verdict = validator.validate(
            question="有多少个XYZ项目的缺陷",
            sql="SELECT COUNT(*) FROM octane_defects WHERE project='XYZ'",
            rows=[],
            intent="count"
        )
        # Count queries with empty result might be OK (answer is 0)
        assert verdict.passed


# ============================================================================
# Large Result Tests
# ============================================================================

class TestLargeResult:
    """Test large result detection"""

    def test_large_result_no_where(self, validator):
        """Large result without WHERE = ERROR"""
        rows = [{"id": i} for i in range(15000)]
        verdict = validator.validate(
            question="显示所有缺陷",
            sql="SELECT * FROM octane_defects",
            rows=rows,
            intent="detail_list"
        )
        # Should flag either large_result_no_where or large_result
        large_issues = [i for i in verdict.issues if "large_result" in i.check]
        assert len(large_issues) > 0

    def test_large_result_with_where(self, validator):
        """Large result with WHERE = WARNING (not error)"""
        rows = [{"id": i} for i in range(15000)]
        verdict = validator.validate(
            question="显示所有IDCEVO缺陷",
            sql="SELECT * FROM octane_defects WHERE project='IDCEVO'",
            rows=rows,
            intent="detail_list"
        )
        # Should be WARNING, not ERROR
        issues_large = [i for i in verdict.issues if i.check == "large_result"]
        if issues_large:
            assert issues_large[0].level == ValidationLevel.WARNING


# ============================================================================
# Uniform Values Test
# ============================================================================

class TestUniformValues:
    """Test uniform values detection"""

    def test_uniform_values_warning(self, validator):
        """All same values in first column = WARNING"""
        rows = [{"project": "IDCEVO", "count": 10} for _ in range(5)]
        verdict = validator.validate(
            question="各项目缺陷分布",
            sql="SELECT project, COUNT(*) as count FROM octane_defects GROUP BY project",
            rows=rows,
            intent="distribution"
        )
        assert any(i.check == "uniform_values" for i in verdict.issues)

    def test_varied_values_ok(self, validator):
        """Varied values = OK"""
        rows = [
            {"project": "IDCEVO", "count": 100},
            {"project": "MGU", "count": 80},
            {"project": "IDC", "count": 60},
        ]
        verdict = validator.validate(
            question="各项目缺陷分布",
            sql="SELECT project, COUNT(*) as count FROM octane_defects GROUP BY project",
            rows=rows,
            intent="distribution"
        )
        assert not any(i.check == "uniform_values" for i in verdict.issues)


# ============================================================================
# Intent Alignment Tests
# ============================================================================

class TestIntentAlignment:
    """Test SQL-intent alignment checks"""

    def test_count_without_count(self, validator):
        """Count intent but no COUNT() = WARNING"""
        verdict = validator.validate(
            question="有多少缺陷",
            sql="SELECT * FROM octane_defects",
            rows=[{"id": 1}],
            intent="count"
        )
        assert any(i.check == "intent_alignment" for i in verdict.issues)

    def test_ranking_without_orderby(self, validator):
        """Ranking intent but no ORDER BY = WARNING"""
        verdict = validator.validate(
            question="缺陷最多的ECU排名",
            sql="SELECT assigned_ecu, COUNT(*) as count FROM octane_defects GROUP BY assigned_ecu",
            rows=[{"assigned_ecu": "BCM", "count": 50}],
            intent="ranking"
        )
        assert any(i.check == "intent_alignment" for i in verdict.issues)

    def test_correct_alignment(self, validator):
        """Correct SQL for intent = no issues"""
        verdict = validator.validate(
            question="有多少缺陷",
            sql="SELECT COUNT(*) FROM octane_defects",
            rows=[{"COUNT(*)": 500}],
            intent="count"
        )
        assert not any(i.check == "intent_alignment" for i in verdict.issues)


# ============================================================================
# Distribution Consistency Tests
# ============================================================================

class TestDistributionConsistency:
    """Test percentage sum check"""

    def test_valid_pct_sum(self, validator):
        """Percentages summing to ~100% = OK"""
        rows = [
            {"severity": "Critical", "count": 100, "pct": 20.0},
            {"severity": "Major", "count": 250, "pct": 50.0},
            {"severity": "Minor", "count": 100, "pct": 20.0},
            {"severity": "Cosmetic", "count": 50, "pct": 10.0},
        ]
        verdict = validator.validate(
            question="按严重度分布",
            sql="SELECT severity, COUNT(*), ROUND(...) as pct FROM ... GROUP BY severity",
            rows=rows,
            intent="distribution"
        )
        assert not any(i.check == "pct_sum" for i in verdict.issues)

    def test_bad_pct_sum(self, validator):
        """Percentages not summing to 100% = WARNING"""
        rows = [
            {"severity": "Critical", "count": 100, "pct": 5.0},
            {"severity": "Major", "count": 250, "pct": 10.0},
        ]
        verdict = validator.validate(
            question="按严重度分布",
            sql="SELECT severity, COUNT(*), ROUND(...) as pct FROM ... GROUP BY severity",
            rows=rows,
            intent="distribution"
        )
        assert any(i.check == "pct_sum" for i in verdict.issues)


# ============================================================================
# LLM Validation Tests
# ============================================================================

class TestLLMValidation:
    """Test LLM-based semantic validation"""

    def test_llm_passes_correct_result(self, llm_validator):
        """LLM should validate a correct result"""
        verdict = llm_validator.validate(
            question="IDCEVO有多少Critical缺陷",
            sql="SELECT COUNT(*) as cnt FROM octane_defects WHERE project='IDCEVO' AND severity='Critical'",
            rows=[{"cnt": 23}],
            intent="count",
        )
        assert verdict.llm_verified
        assert verdict.passed

    def test_llm_flags_wrong_result(self, llm_validator):
        """LLM should flag obviously wrong results"""
        # Question asks for count, but SQL returns a list of names
        verdict = llm_validator.validate(
            question="IDCEVO有多少Critical缺陷",
            sql="SELECT name FROM octane_defects WHERE project='IDCEVO'",
            rows=[{"name": "defect1"}, {"name": "defect2"}],
            intent="count",
        )
        # Either rule-based or LLM should flag this
        assert not verdict.passed or len(verdict.issues) > 0


# ============================================================================
# Integration Test
# ============================================================================

class TestNL2SQLIntegration:
    """Test fixer + validator in NL2SQL pipeline"""

    def test_pipeline_with_validation(self):
        """Test that NL2SQLEngine.query() includes validation"""
        from agent.sql_engine.generator import NL2SQLEngine
        from agent.ontology import OntologyEngine
        from agent.llm.client import load_env
        load_env()

        from agent.data.adapter import resolve_data_db_path
        db_path = resolve_data_db_path()
        ont_dir = Path(PROJECT_ROOT) / "agent" / "ontology"
        ont = OntologyEngine(ontology_dir=str(ont_dir))

        engine = NL2SQLEngine(
            ontology=ont,
            db_path=db_path,
            use_query_fixer=False,
            use_validator=True,
        )

        result = engine.query("各项目的缺陷数量")
        assert result.data
        assert hasattr(result, 'validation_issues')
        assert hasattr(result, 'validation_llm_verified')


# ============================================================================
# Singleton Test
# ============================================================================

class TestSingleton:

    def test_get_result_validator(self):
        v1 = get_result_validator(llm_call_fn=None, enable_llm=False)
        v2 = get_result_validator()
        assert v1 is v2
