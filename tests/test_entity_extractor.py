"""Tests for Entity Extractor

Tests entity extraction from natural language questions.
"""

import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from agent.understand.entity_extractor import EntityExtractor, get_entity_extractor
from agent.ontology import OntologyEngine


@pytest.fixture
def extractor():
    ontology_dir = Path(__file__).parent.parent / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)
    return EntityExtractor(engine)


class TestEntityExtraction:

    def test_extract_project(self, extractor):
        """Test project entity extraction"""
        result = extractor.extract("IDCEVO 本月 Critical 缺陷有多少")
        projects = result.get("project")
        assert len(projects) > 0
        assert projects[0].value == "IDCEVO"

    def test_extract_severity(self, extractor):
        """Test severity entity extraction"""
        result = extractor.extract("Critical 缺陷有多少")
        severities = result.get("severity")
        assert len(severities) > 0
        assert severities[0].value == "Critical"

    def test_extract_ecu(self, extractor):
        """Test ECU entity extraction"""
        result = extractor.extract("BCM 相关缺陷")
        ecus = result.get("ecu")
        assert len(ecus) > 0
        assert ecus[0].value == "BCM"

    def test_extract_time_range(self, extractor):
        """Test time range extraction"""
        result = extractor.extract("本月新增缺陷")
        time_ranges = result.get("time_range")
        assert len(time_ranges) > 0
        assert time_ranges[0].value == "this_month"

    def test_extract_multiple_entities(self, extractor):
        """Test multiple entity extraction from complex question"""
        result = extractor.extract("IDCEVO 本月 BCM Critical 缺陷有多少")
        assert result.has("project")
        assert result.has("ecu")
        assert result.has("severity")
        assert result.has("time_range")

    def test_extract_status_group(self, extractor):
        """Test status category group extraction"""
        result = extractor.extract("活跃缺陷有多少")
        statuses = result.get("status")
        assert len(statuses) > 0
        assert statuses[0].operator == "IN"
        assert "New" in statuses[0].values

    def test_extract_limit(self, extractor):
        """Test limit extraction"""
        result = extractor.extract("缺陷最多的 TOP 10 ECU")
        limits = result.get("limit")
        assert len(limits) > 0
        assert limits[0].value == "10"

    def test_extract_sort_desc(self, extractor):
        """Test sort direction extraction"""
        result = extractor.extract("缺陷最多的项目")
        sorts = result.get("sort")
        assert len(sorts) > 0
        assert sorts[0].value == "DESC"


class TestSQLFilterConversion:

    def test_simple_filter(self, extractor):
        """Test simple filter to SQL"""
        result = extractor.extract("IDCEVO Critical 缺陷")
        filters = extractor.to_sql_filters(result)
        assert any("project" in f and "IDCEVO" in f for f in filters)
        assert any("severity" in f and "Critical" in f for f in filters)

    def test_in_filter(self, extractor):
        """Test IN clause for category groups"""
        result = extractor.extract("活跃缺陷")
        filters = extractor.to_sql_filters(result)
        in_filters = [f for f in filters if "IN" in f]
        assert len(in_filters) > 0
        assert "New" in in_filters[0]
        assert "Open" in in_filters[0]
