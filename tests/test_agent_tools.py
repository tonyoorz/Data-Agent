"""Tests for Agent Tools

Tests the 6 core tools independently.
"""

import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from agent.ontology import OntologyEngine
from agent.agent_loop.tools import (
    QueryDefectsTool, QueryTrendTool, DistributionTool,
    RankingTool, SearchSimilarTool, DashboardTool,
    ToolResult, ToolParameter,
)


@pytest.fixture
def ontology():
    return OntologyEngine(Path(__file__).parent.parent / "agent" / "ontology")


@pytest.fixture
def tools(ontology):
    return {
        "query_defects": QueryDefectsTool(ontology=ontology),
        "query_trend": QueryTrendTool(ontology=ontology),
        "get_distribution": DistributionTool(ontology=ontology),
        "get_ranking": RankingTool(ontology=ontology),
        "search": SearchSimilarTool(ontology=ontology),
        "dashboard": DashboardTool(ontology=ontology),
    }


class TestToolSchemas:

    def test_all_tools_have_names(self, tools):
        for name, tool in tools.items():
            assert tool.name
            assert tool.description

    def test_all_tools_have_parameters(self, tools):
        for name, tool in tools.items():
            assert len(tool.parameters) > 0

    def test_required_params_marked(self, tools):
        """query_defects requires 'question'"""
        tool = tools["query_defects"]
        question_param = [p for p in tool.parameters if p.name == "question"][0]
        assert question_param.required

    def test_distribution_requires_group_by(self, tools):
        tool = tools["get_distribution"]
        gb_param = [p for p in tool.parameters if p.name == "group_by"][0]
        assert gb_param.required

    def test_to_schema(self, tools):
        """Test JSON schema generation"""
        schema = tools["query_defects"].to_schema()
        assert schema["name"] == "query_defects"
        assert "parameters" in schema
        assert "question" in schema["parameters"]["properties"]
        assert "question" in schema["parameters"]["required"]

    def test_ranking_has_enum(self, tools):
        """Test ranking tool rank_by has enum"""
        schema = tools["get_ranking"].to_schema()
        assert "enum" in schema["parameters"]["properties"]["rank_by"]


class TestToolExecution:

    def test_query_defects_no_db(self, tools):
        """Test query_defects without database (should still generate SQL)"""
        result = tools["query_defects"].execute(question="IDCEVO 有多少缺陷")
        # Without db, error will be set but SQL should be generated
        assert result.sql or result.data or result.error

    def test_distribution_no_db(self, tools):
        """Test distribution tool generates correct SQL"""
        result = tools["get_distribution"].execute(group_by="severity")
        assert "GROUP BY" in result.sql.upper()
        assert "severity" in result.sql

    def test_ranking_no_db(self, tools):
        """Test ranking tool generates correct SQL"""
        result = tools["get_ranking"].execute(rank_by="assigned_ecu", limit=5)
        assert "ORDER BY" in result.sql.upper()
        assert "LIMIT 5" in result.sql

    def test_dashboard_no_db(self, tools):
        """Test dashboard tool without database"""
        result = tools["dashboard"].execute()
        # Without db_path, should return error
        assert result.success is False or result.data is not None

    def test_search_no_db_no_fn(self, tools):
        """Test search_similar without database or function"""
        result = tools["search"].execute(query="BCM 蓝牙连接问题")
        assert result.success is False


class TestToolParameterDefaults:

    def test_distribution_defaults(self, tools):
        """Test distribution tool defaults"""
        tool = tools["get_distribution"]
        top_n = [p for p in tool.parameters if p.name == "top_n"][0]
        assert top_n.default == 20

    def test_ranking_defaults(self, tools):
        """Test ranking tool defaults"""
        tool = tools["get_ranking"]
        limit = [p for p in tool.parameters if p.name == "limit"][0]
        assert limit.default == 10
        order = [p for p in tool.parameters if p.name == "order"][0]
        assert order.default == "desc"

    def test_search_defaults(self, tools):
        """Test search tool defaults"""
        tool = tools["search"]
        top_k = [p for p in tool.parameters if p.name == "top_k"][0]
        assert top_k.default == 10
