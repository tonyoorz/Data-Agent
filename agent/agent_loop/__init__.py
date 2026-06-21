"""Agent Loop - ReAct Tool Calling + SSE Streaming

Core modules:
- loop.py: ReAct reasoning loop (rule-based + LLM-based)
- tools.py: 6 core agent tools
- registry.py: Tool registration and discovery
- streaming.py: SSE event stream for real-time output
"""

from agent.agent_loop.loop import (
    ReActAgent, AgentStep, AgentResponse, StepType, get_agent
)
from agent.agent_loop.tools import (
    AgentTool, ToolResult, ToolParameter,
    QueryDefectsTool, QueryTrendTool, DistributionTool,
    RankingTool, SearchSimilarTool, DashboardTool,
)
from agent.agent_loop.registry import ToolRegistry, build_default_registry
from agent.agent_loop.streaming import SSEEventStream

__all__ = [
    "ReActAgent", "AgentStep", "AgentResponse", "StepType", "get_agent",
    "AgentTool", "ToolResult", "ToolParameter",
    "QueryDefectsTool", "QueryTrendTool", "DistributionTool",
    "RankingTool", "SearchSimilarTool", "DashboardTool",
    "ToolRegistry", "build_default_registry",
    "SSEEventStream",
]
