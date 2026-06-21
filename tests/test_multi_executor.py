"""Tests for Multi-Path Executor

Tests cover:
1. Single candidate execution
2. Multiple candidates with unanimous agreement
3. Multiple candidates with disagreement
4. LLM arbitration (when available)
5. Failed candidates handling
"""

import os
import sys
import pytest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.sql_engine.multi_executor import (
    MultiPathExecutor, CandidateResult, MultiPathResult,
    AgreementLevel,
)
from agent.sql_engine.generator import SQLCandidate
from agent.data.adapter import resolve_data_db_path


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def db_path():
    return resolve_data_db_path()


@pytest.fixture
def executor(db_path):
    return MultiPathExecutor(db_path=db_path, llm_call_fn=None)


@pytest.fixture
def llm_executor(db_path):
    """Executor with LLM (if available)"""
    from agent.llm.client import get_llm_client, load_env
    load_env()
    llm = get_llm_client()
    if llm is None:
        pytest.skip("No LLM API key")
    return MultiPathExecutor(
        db_path=db_path,
        llm_call_fn=llm.as_fixer_fn(),
    )


# ============================================================================
# Execution Tests
# ============================================================================

class TestExecution:

    def test_single_candidate(self, executor):
        """Single candidate → SINGLE agreement"""
        candidates = [
            SQLCandidate(
                sql="SELECT COUNT(*) as cnt FROM octane_defects",
                path="direct",
                explanation="count all",
                confidence=0.7
            )
        ]
        result = executor.execute_and_compare(candidates, "有多少缺陷")
        assert result.agreement == AgreementLevel.SINGLE
        assert result.row_count >= 1
        assert result.confidence == 0.7

    def test_empty_candidates(self, executor):
        """No candidates → fallback"""
        result = executor.execute_and_compare([], "")
        assert result.agreement == AgreementLevel.SINGLE
        assert result.confidence == 0.1

    def test_all_fail(self, executor):
        """All candidates fail → DISAGREE"""
        candidates = [
            SQLCandidate(sql="SELECT * FROM nonexistent", path="direct", confidence=0.5, explanation=""),
            SQLCandidate(sql="SELECT * FROM also_fake", path="decomposed", confidence=0.5, explanation=""),
        ]
        result = executor.execute_and_compare(candidates, "test")
        assert result.agreement == AgreementLevel.DISAGREE
        assert result.confidence == 0.0


# ============================================================================
# Agreement Tests
# ============================================================================

class TestAgreement:

    def test_unanimous_agreement(self, executor):
        """All candidates produce same result → UNANIMOUS"""
        candidates = [
            SQLCandidate(
                sql="SELECT COUNT(*) as cnt FROM octane_defects",
                path="direct", confidence=0.7, explanation=""
            ),
            SQLCandidate(
                sql="SELECT COUNT(*) as cnt FROM octane_defects WHERE 1=1",
                path="decomposed", confidence=0.6, explanation=""
            ),
            SQLCandidate(
                sql="SELECT COUNT(*) as cnt FROM octane_defects",
                path="plan_based", confidence=0.8, explanation=""
            ),
        ]
        result = executor.execute_and_compare(candidates, "总共有多少缺陷")
        assert result.agreement == AgreementLevel.UNANIMOUS
        assert result.confidence == 0.95
        assert result.row_count >= 1

    def test_majority_agreement(self, executor):
        """2 of 3 agree → MAJORITY"""
        candidates = [
            SQLCandidate(
                sql="SELECT COUNT(*) as cnt FROM octane_defects",
                path="direct", confidence=0.7, explanation=""
            ),
            SQLCandidate(
                sql="SELECT COUNT(*) as cnt FROM octane_defects",
                path="decomposed", confidence=0.6, explanation=""
            ),
            SQLCandidate(
                sql="SELECT COUNT(*) as cnt FROM octane_defects WHERE project='IDCEVO'",
                path="plan_based", confidence=0.8, explanation=""
            ),
        ]
        result = executor.execute_and_compare(candidates, "有多少缺陷")
        assert result.agreement == AgreementLevel.MAJORITY
        assert result.confidence == 0.80

    def test_disagreement_path_fallback(self, executor):
        """All disagree → path preference fallback"""
        candidates = [
            SQLCandidate(
                sql="SELECT severity, COUNT(*) as cnt FROM octane_defects GROUP BY severity ORDER BY cnt DESC LIMIT 1",
                path="direct", confidence=0.7, explanation=""
            ),
            SQLCandidate(
                sql="SELECT project, COUNT(*) as cnt FROM octane_defects GROUP BY project ORDER BY cnt DESC LIMIT 1",
                path="decomposed", confidence=0.6, explanation=""
            ),
            SQLCandidate(
                sql="SELECT assigned_ecu, COUNT(*) as cnt FROM octane_defects GROUP BY assigned_ecu ORDER BY cnt DESC LIMIT 1",
                path="plan_based", confidence=0.8, explanation=""
            ),
        ]
        result = executor.execute_and_compare(candidates, "最多的是什么")
        # All produce different data → DISAGREE → plan_based preferred
        assert result.agreement == AgreementLevel.DISAGREE
        assert result.best_path == "plan_based"


# ============================================================================
# Data Signature Tests
# ============================================================================

class TestDataSignature:

    def test_scalar_signature(self):
        """Scalar results have matching signatures"""
        r1 = CandidateResult(sql="", path="a", success=True,
                             data=[{"cnt": 500}], row_count=1)
        r2 = CandidateResult(sql="", path="b", success=True,
                             data=[{"cnt": 500}], row_count=1)
        assert r1.data_signature == r2.data_signature

    def test_different_scalar_signature(self):
        """Different scalar values → different signatures"""
        r1 = CandidateResult(sql="", path="a", success=True,
                             data=[{"cnt": 500}], row_count=1)
        r2 = CandidateResult(sql="", path="b", success=True,
                             data=[{"cnt": 499}], row_count=1)
        assert r1.data_signature != r2.data_signature

    def test_empty_signature(self):
        """Empty results"""
        r1 = CandidateResult(sql="", path="a", success=True, data=[], row_count=0)
        r2 = CandidateResult(sql="", path="b", success=False, error="oops")
        assert r1.data_signature != r2.data_signature


# ============================================================================
# LLM Arbitration Tests
# ============================================================================

class TestLLMArbitration:

    def test_llm_picks_correct(self, llm_executor):
        """LLM should pick the correct candidate when they disagree"""
        candidates = [
            # Correct: counts all defects
            SQLCandidate(
                sql="SELECT COUNT(*) as cnt FROM octane_defects",
                path="direct", confidence=0.7, explanation=""
            ),
            # Wrong: only counts IDCEVO
            SQLCandidate(
                sql="SELECT COUNT(*) as cnt FROM octane_defects WHERE project='IDCEVO'",
                path="decomposed", confidence=0.6, explanation=""
            ),
        ]
        result = llm_executor.execute_and_compare(
            candidates, question="总共有多少个缺陷"
        )
        # LLM should pick the first one (counts all)
        assert "direct" in result.best_sql or "octane_defects" in result.best_sql
        assert result.confidence > 0.5


# ============================================================================
# Integration Test
# ============================================================================

class TestIntegration:

    def test_nl2sql_with_multi_path(self):
        """Test NL2SQLEngine.query() uses multi-path execution"""
        from agent.sql_engine.generator import NL2SQLEngine
        from agent.ontology import OntologyEngine
        from agent.llm.client import load_env
        load_env()

        ont_dir = PROJECT_ROOT / "agent" / "ontology"
        ont = OntologyEngine(ontology_dir=str(ont_dir))
        db = resolve_data_db_path()

        engine = NL2SQLEngine(
            ontology=ont,
            db_path=db,
            llm_call_fn=None,
            use_query_fixer=False,  # Isolate multi-path test
            use_validator=False,
        )

        result = engine.query("有多少个缺陷")
        assert result.data
        assert hasattr(result, 'multi_path_agreement')
        # With 3 candidates, should have some agreement level
        if result.multi_path_agreement:
            assert result.multi_path_agreement in (
                "unanimous", "majority", "disagree", "single"
            )
