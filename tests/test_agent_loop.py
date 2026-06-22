"""Tests for ReAct Agent Loop

Tests the agent reasoning loop including tool selection, execution,
and answer formatting.
"""

import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from agent.ontology import OntologyEngine
from agent.agent_loop.loop import (
    ReActAgent, AgentStep, AgentResponse, StepType, get_agent
)
from agent.agent_loop.registry import ToolRegistry, build_default_registry
from agent.agent_loop.streaming import SSEEventStream


@pytest.fixture
def agent():
    ontology = OntologyEngine(Path(__file__).parent.parent / "agent" / "ontology")
    registry = build_default_registry(ontology=ontology)
    return ReActAgent(registry=registry, ontology=ontology)


class TestToolRegistry:

    def test_registry_has_all_tools(self):
        """Test default registry has all 6 tools"""
        ontology = OntologyEngine(Path(__file__).parent.parent / "agent" / "ontology")
        registry = build_default_registry(ontology=ontology)
        tools = registry.list_tools()
        assert "query_defects" in tools
        assert "query_trend" in tools
        assert "get_distribution" in tools
        assert "get_ranking" in tools
        assert "search_similar" in tools
        assert "get_dashboard" in tools

    def test_registry_get_schemas(self):
        """Test schema generation for all tools"""
        ontology = OntologyEngine(Path(__file__).parent.parent / "agent" / "ontology")
        registry = build_default_registry(ontology=ontology)
        schemas = registry.get_schemas()
        assert len(schemas) == 7  # query_defects, query_trend, get_distribution, get_ranking, search_similar, get_dashboard, analyze_data
        for s in schemas:
            assert "name" in s
            assert "description" in s
            assert "parameters" in s

    def test_registry_execute_unknown(self):
        """Test executing unknown tool"""
        ontology = OntologyEngine(Path(__file__).parent.parent / "agent" / "ontology")
        registry = build_default_registry(ontology=ontology)
        result = registry.execute("nonexistent_tool")
        assert result.success is False
        assert "Unknown tool" in result.error

    def test_registry_get_descriptions(self):
        """Test human-readable descriptions"""
        ontology = OntologyEngine(Path(__file__).parent.parent / "agent" / "ontology")
        registry = build_default_registry(ontology=ontology)
        desc = registry.get_descriptions()
        assert "query_defects" in desc
        assert "get_distribution" in desc


class TestAgentProcessing:

    def test_process_count_question(self, agent):
        """Test processing a count question"""
        response = agent.process("IDCEVO 有多少缺陷")
        assert response.answer
        assert len(response.steps) > 0
        assert any(s.step_type == StepType.THOUGHT for s in response.steps)
        assert any(s.step_type == StepType.FINAL for s in response.steps)

    def test_process_distribution_question(self, agent):
        """Test processing a distribution question"""
        response = agent.process("缺陷按项目分布")
        assert response.answer
        assert response.success
        # Should use distribution tool
        assert "get_distribution" in response.tools_used

    def test_process_trend_question(self, agent):
        """Test processing a trend question"""
        response = agent.process("近30天缺陷趋势")
        assert response.answer
        assert "query_trend" in response.tools_used

    def test_process_ranking_question(self, agent):
        """Test processing a ranking question"""
        response = agent.process("缺陷最多的 TOP 5 ECU")
        assert response.answer
        assert "get_ranking" in response.tools_used

    def test_process_summary_question(self, agent):
        """Test processing a summary/dashboard question"""
        response = agent.process("给我看下整体概况")
        assert response.answer
        assert "get_dashboard" in response.tools_used

    def test_steps_contain_thought_and_final(self, agent):
        """Test that processing always has thought and final steps"""
        response = agent.process("有多少 Critical 缺陷")
        types = [s.step_type for s in response.steps]
        assert StepType.THOUGHT in types
        assert StepType.FINAL in types

    def test_response_has_timing(self, agent):
        """Test response includes timing"""
        response = agent.process("IDCEVO 缺陷")
        assert response.total_time_ms > 0


class TestSSEStreaming:

    def test_stream_yields_events(self, agent):
        """Test SSE stream yields events"""
        stream = SSEEventStream(agent)
        events = list(stream.process("IDCEVO 有多少缺陷"))

        # Should have start, thought, action, observation, final, done
        assert len(events) >= 3

        # First event should be "start"
        parsed = SSEEventStream.parse_event(events[0])
        assert parsed["event"] == "start"
        assert "question" in parsed["data"]

        # Last event should be "done"
        parsed_last = SSEEventStream.parse_event(events[-1])
        assert parsed_last["event"] == "done"

    def test_stream_has_final_event(self, agent):
        """Test SSE stream includes final answer"""
        stream = SSEEventStream(agent)
        events = list(stream.process("缺陷按严重度分布"))

        final_events = [
            e for e in events if e.startswith("event: final")
        ]
        assert len(final_events) >= 1

    def test_sse_format(self, agent):
        """Test SSE format is correct"""
        stream = SSEEventStream(agent)
        events = list(stream.process("有多少缺陷"))

        for event in events:
            assert event.startswith("event: ")
            assert "data: " in event
            assert event.endswith("\n\n")
