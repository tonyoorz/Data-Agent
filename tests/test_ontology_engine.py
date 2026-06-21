"""Tests for Ontology Engine - Phase 1 Verification

Tests cover:
1. Loading YAML object definitions
2. Parsing properties, links, metrics
3. Resolving aliases
4. Finding calibration rules
5. Generating context
"""

import pytest
from pathlib import Path
import sys

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from agent.ontology import OntologyEngine, PropertyType


def test_ontology_engine_initialization():
    """Test that OntologyEngine can be initialized"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)

    # Check that objects were loaded
    objects = engine.get_all_objects()
    assert len(objects) > 0, "No objects loaded"

    # Check that expected objects exist
    assert "Defect" in objects
    assert "ManualRun" in objects
    assert "Project" in objects

    print(f"✓ Loaded {len(objects)} object types")


def test_defect_object():
    """Test Defect object definition"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)

    defect = engine.get_object("Defect")
    assert defect is not None
    assert defect.object_type == "Defect"
    assert defect.source_table == "octane_defects"
    assert defect.primary_key == "defect_id"

    # Check properties
    assert len(defect.properties) > 0
    assert "defect_id" in defect.properties
    assert "severity" in defect.properties
    assert "project" in defect.properties

    # Check property types
    assert defect.properties["defect_id"].type == PropertyType.STRING
    assert defect.properties["severity"].type == PropertyType.ENUM

    # Check enums
    severity_prop = defect.properties["severity"]
    assert severity_prop.values is not None
    assert "Critical" in severity_prop.values
    assert "Major" in severity_prop.values

    print("✓ Defect object loaded correctly")
    print(f"  - Properties: {len(defect.properties)}")
    print(f"  - Links: {len(defect.links)}")
    print(f"  - Metrics: {len(defect.metrics)}")
    print(f"  - Calibration rules: {len(defect.calibration_rules)}")


def test_project_aliases():
    """Test alias resolution for project names"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)

    # Test IDCEVO aliases
    assert engine.resolve_alias("Defect", "project", "idcevo") == "IDCEVO"
    assert engine.resolve_alias("Defect", "project", "cde") == "IDCEVO"
    assert engine.resolve_alias("Defect", "project", "entryevo") == "IDCEVO"

    # Test ECU aliases
    assert engine.resolve_alias("Defect", "assigned_ecu", "车身控制器") == "BCM"
    assert engine.resolve_alias("Defect", "assigned_ecu", "整车控制器") == "VCU"

    print("✓ Alias resolution works correctly")


def test_links():
    """Test link definitions"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)

    links = engine.get_links("Defect")
    assert len(links) > 0

    # Check for expected links
    link_names = [link.name for link in links]
    assert "has_history" in link_names
    assert "tested_in_manual_run" in link_names
    assert "belongs_to_project" in link_names

    # Get specific link
    history_link = engine.get_link("Defect", "has_history")
    assert history_link is not None
    assert history_link.target == "DefectHistory"
    assert history_link.type == "one-to-many"

    print(f"✓ Defect has {len(links)} links defined")


def test_metrics():
    """Test metric definitions"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)

    metrics = engine.get_metrics("Defect")
    assert len(metrics) > 0

    # Check for expected metrics
    assert "active_defect_count" in metrics
    assert "critical_defect_count" in metrics

    # Check metric definition
    active_metric = metrics["active_defect_count"]
    assert active_metric.meaning is not None
    assert "status_phase" in active_metric.definition

    print(f"✓ Defect has {len(metrics)} metrics defined")


def test_calibration_rules():
    """Test calibration rules"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)

    rules = engine.get_calibration_rules("Defect")
    assert len(rules) > 0

    # Check rule structure
    assert rules[0].id is not None
    assert len(rules[0].trigger) > 0
    assert rules[0].rule is not None

    # Test finding relevant rules
    relevant = engine.find_relevant_rules(["severity", "critical"])
    assert len(relevant) > 0
    assert any("cal_severity_not_matrix" in r.id for r in relevant)

    print(f"✓ Defect has {len(rules)} calibration rules")


def test_schema_context_generation():
    """Test generating schema context for LLM"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)

    context = engine.to_schema_context()

    # Check that key sections are present
    assert "# 数据库语义模型" in context
    assert "## Defect" in context
    assert "字段" in context
    assert "关系" in context
    assert "计算指标" in context
    assert "业务规则提醒" in context

    # Check specific content
    assert "octane_defects" in context
    assert "severity" in context
    assert "Critical" in context
    assert "status_phase" in context

    print("✓ Schema context generated successfully")
    print(f"  Context length: {len(context)} characters")


def test_manual_run_object():
    """Test ManualRun object definition"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)

    manual_run = engine.get_object("ManualRun")
    assert manual_run is not None
    assert manual_run.source_table == "octane_manual_runs"

    # Check that it links to Defect
    defect_link = engine.get_link("ManualRun", "finds_defect")
    assert defect_link is not None
    assert defect_link.target == "Defect"

    print("✓ ManualRun object loaded correctly")


def test_category_groups():
    """Test category group retrieval"""
    ontology_dir = project_root / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)

    # Get China projects
    china_projects = engine.get_category_group("Defect", "project", "china")
    assert china_projects is not None
    assert "IDCEVO" in china_projects
    assert "IDC" in china_projects
    assert "MGU" in china_projects

    # Get active status phases
    active_phases = engine.get_category_group("Defect", "status_phase", "active")
    assert active_phases is not None
    assert "New" in active_phases
    assert "Open" in active_phases

    print("✓ Category groups work correctly")


if __name__ == "__main__":
    print("=== Phase 1: Ontology Engine Tests ===\n")

    try:
        test_ontology_engine_initialization()
        test_defect_object()
        test_project_aliases()
        test_links()
        test_metrics()
        test_calibration_rules()
        test_schema_context_generation()
        test_manual_run_object()
        test_category_groups()

        print("\n=== All Tests Passed ✓ ===")

    except AssertionError as e:
        print(f"\n❌ Test failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)