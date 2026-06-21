"""Tests for Term Resolver

Tests alias resolution, category expansion, numeric/time pattern matching.
"""

import pytest
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from agent.understand.term_resolver import TermResolver, get_term_resolver


@pytest.fixture
def resolver():
    """Create TermResolver with ontology from agent/ontology/objects/"""
    ontology_dir = Path(__file__).parent.parent / "agent" / "ontology"
    from agent.ontology import OntologyEngine
    engine = OntologyEngine(ontology_dir)
    return TermResolver(engine)


class TestAliasResolution:

    def test_project_alias_idcevo(self, resolver):
        """Test: 'idcevo' resolves to 'IDCEVO'"""
        terms = resolver.resolve("IDCEVO 本月缺陷", "Defect")
        project_terms = [t for t in terms if t.field == "project"]
        assert len(project_terms) > 0
        assert any(t.value == "IDCEVO" for t in project_terms)

    def test_project_alias_cde(self, resolver):
        """Test: 'CDE' resolves to 'IDCEVO'"""
        terms = resolver.resolve("CDE 项目有多少缺陷", "Defect")
        project_terms = [t for t in terms if t.field == "project"]
        assert any(t.value == "IDCEVO" for t in project_terms)

    def test_ecu_alias_chinese(self, resolver):
        """Test: '车身控制器' resolves to 'BCM'"""
        terms = resolver.resolve("车身控制器的缺陷", "Defect")
        ecu_terms = [t for t in terms if t.field == "assigned_ecu"]
        assert any(t.value == "BCM" for t in ecu_terms)

    def test_severity_synonym_严重(self, resolver):
        """Test: '严重' resolves to 'Critical'"""
        terms = resolver.resolve("严重的缺陷", "Defect")
        severity_terms = [t for t in terms if t.field == "severity"]
        assert any(t.value == "Critical" for t in severity_terms)


class TestCategoryGroups:

    def test_active_status(self, resolver):
        """Test: '活跃' resolves to active status group"""
        terms = resolver.resolve("活跃缺陷有多少", "Defect")
        status_terms = [t for t in terms if t.field == "status_phase" and t.operator == "IN"]
        assert any(t.canonical == "active" for t in status_terms)

    def test_china_projects(self, resolver):
        """Test: 'china' category resolves to IDCEVO+IDC+MGU"""
        terms = resolver.resolve("china 缺陷", "Defect")
        project_terms = [t for t in terms if t.field == "project" and t.operator == "IN"]
        assert any(t.canonical == "china" for t in project_terms)


class TestNumericPatterns:

    def test_exceed_pattern(self, resolver):
        """Test: '超过5个' resolves to >5"""
        terms = resolver.resolve("超过5个缺陷", "Defect")
        numeric_terms = [t for t in terms if t.field == "__count__"]
        assert len(numeric_terms) > 0
        assert numeric_terms[0].operator == ">"
        assert numeric_terms[0].value == "5"

    def test_top_pattern(self, resolver):
        """Test: 'TOP 10' resolves to LIMIT 10"""
        terms = resolver.resolve("缺陷最多的 TOP 10 ECU", "Defect")
        limit_terms = [t for t in terms if t.field == "__limit__"]
        assert len(limit_terms) > 0
        assert limit_terms[0].value == "10"

    def test_at_least_pattern(self, resolver):
        """Test: '至少3个' resolves to >=3"""
        terms = resolver.resolve("至少3个Critical", "Defect")
        numeric_terms = [t for t in terms if t.field == "__count__"]
        assert len(numeric_terms) > 0
        assert numeric_terms[0].operator == ">="


class TestTimePatterns:

    def test_this_month(self, resolver):
        """Test: '本月' resolves to this_month"""
        terms = resolver.resolve("本月新增缺陷", "Defect")
        time_terms = [t for t in terms if t.field == "creation_time"]
        assert any(t.value == "this_month" for t in time_terms)

    def test_recent_days(self, resolver):
        """Test: '近30天' resolves to recent_days"""
        terms = resolver.resolve("近30天趋势", "Defect")
        time_terms = [t for t in terms if t.field == "creation_time"]
        assert any(t.value == "recent_days" for t in time_terms)

    def test_last_year(self, resolver):
        """Test: '去年' resolves to last_year"""
        terms = resolver.resolve("去年的缺陷数据", "Defect")
        time_terms = [t for t in terms if t.field == "creation_time"]
        assert any(t.value == "last_year" for t in time_terms)
