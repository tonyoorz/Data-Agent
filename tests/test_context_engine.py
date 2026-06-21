"""Tests for Context Engine - Phase 1 Verification

Tests cover:
1. Building structural context
2. Building semantic context
3. Building business context
4. Building operational context
5. Building behavioral context
6. Full 5-layer context generation
"""

import pytest
from pathlib import Path
import sys

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from agent.context import ContextEngine, get_context_engine
from agent.ontology import get_ontology_engine, OntologyEngine


def _make_engine():
    ontology_dir = project_root / "agent" / "ontology"
    return ContextEngine(ontology=OntologyEngine(ontology_dir))


def test_context_engine_initialization():
    """Test that ContextEngine can be initialized"""
    engine = _make_engine()

    assert engine.ontology is not None

    print("✓ ContextEngine initialized")


def test_structural_layer():
    """Test Layer 1 - Structural context"""
    engine = _make_engine()

    context = engine.structural_layer("Defect")

    assert "## 结构层 - Defect" in context
    assert "octane_defects" in context
    assert "defect_id" in context
    assert "字段结构" in context

    print("✓ Structural layer works")


def test_semantic_layer():
    """Test Layer 2 - Semantic context"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = _make_engine()

    context = engine.semantic_layer("Defect")

    assert "## 语义层 - Defect" in context

    # Check for specific property semantic info
    if "severity" in context:
        assert "含义" in context or "取值" in context

    print("✓ Semantic layer works")


def test_business_layer():
    """Test Layer 3 - Business context"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = _make_engine()

    context = engine.business_layer("Defect", "IDCEVO Critical 缺陷趋势")

    assert "## 业务层 - Defect" in context

    # Check for metrics
    if "active_defect_count" in context:
        assert "计算" in context

    print("✓ Business layer works")


def test_operational_layer():
    """Test Layer 4 - Operational context"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = _make_engine()

    context = engine.operational_layer("Defect")

    assert "## 操作层 - Defect" in context

    # Check for governance info
    if "禁止的操作" in context:
        print("✓ Governance info present")

    # Check for join paths
    if "安全的 JOIN 路径" in context:
        print("✓ Join paths present")

    print("✓ Operational layer works")


def test_behavioral_layer():
    """Test Layer 5 - Behavioral context"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = _make_engine()

    # Add some query history
    engine.add_to_history(
        question="IDCEVO 有多少缺陷",
        sql="SELECT COUNT(*) FROM octane_defects WHERE project = 'IDCEVO'",
        object_type="Defect",
        success=True
    )

    context = engine.behavioral_layer("Defect", "IDCEVO 缺陷数")

    assert "## 行为层 - Defect" in context

    print("✓ Behavioral layer works")


def test_full_context():
    """Test full 5-layer context generation"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = _make_engine()

    context = engine.build_context(
        object_type="Defect",
        question="IDCEVO 本月 Critical 缺陷趋势",
        include_layers=[1, 2, 3, 4, 5]
    )

    # Check all layers are present
    assert "## 结构层" in context
    assert "## 语义层" in context
    assert "## 业务层" in context
    assert "## 操作层" in context
    assert "## 行为层" in context

    # Check for relevant business rules
    if "业务规则提醒" in context:
        print("✓ Business rules included")

    # Check length
    print(f"✓ Full context length: {len(context)} characters")

    # Save context for inspection
    (project_root / "tests" / "sample_context.md").write_text(context, encoding="utf-8")
    print("✓ Sample context saved to tests/sample_context.md")


def test_layer_selection():
    """Test selective layer building"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = _make_engine()

    # Only structural and semantic layers
    context = engine.build_context(
        object_type="Defect",
        include_layers=[1, 2]
    )

    assert "## 结构层" in context
    assert "## 语义层" in context
    assert "## 业务层" not in context

    print("✓ Layer selection works")


def test_query_history():
    """Test query history storage and retrieval"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = _make_engine()

    # Add multiple queries
    engine.add_to_history("IDCEVO 有多少缺陷", "SELECT COUNT(*)...", "Defect", True)
    engine.add_to_history("BCM 相关缺陷", "SELECT * WHERE...", "Defect", True)
    engine.add_to_history("Critical 缺陷趋势", "SELECT ...", "Defect", False)

    # Check history size
    assert len(engine.query_history) == 3

    # Find similar queries
    similar = engine._find_similar_queries("IDCEVO 缺陷", "Defect")
    assert len(similar) > 0

    print("✓ Query history works")


if __name__ == "__main__":
    print("=== Phase 1: Context Engine Tests ===\n")

    try:
        test_context_engine_initialization()
        test_structural_layer()
        test_semantic_layer()
        test_business_layer()
        test_operational_layer()
        test_behavioral_layer()
        test_full_context()
        test_layer_selection()
        test_query_history()

        print("\n=== All Tests Passed ✓ ===")

    except AssertionError as e:
        print(f"\n❌ Test failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)