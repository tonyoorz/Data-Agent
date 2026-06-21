"""Tool Registry - Central tool registration and discovery

Manages all available agent tools, their schemas, and execution.
"""

from typing import Dict, List, Optional, Any
from dataclasses import dataclass

from agent.agent_loop.tools import AgentTool, ToolResult
from agent.ontology import OntologyEngine, get_ontology_engine


class ToolRegistry:
    """
    Central registry for all agent tools.

    Tools are registered here and can be discovered by name,
    listed for LLM function calling, and executed on demand.
    """

    def __init__(self):
        self._tools: Dict[str, AgentTool] = {}

    def register(self, tool: AgentTool):
        """Register a tool"""
        if tool.name in self._tools:
            raise ValueError(f"Tool '{tool.name}' already registered")
        self._tools[tool.name] = tool

    def unregister(self, name: str):
        """Unregister a tool"""
        self._tools.pop(name, None)

    def get(self, name: str) -> Optional[AgentTool]:
        """Get a tool by name"""
        return self._tools.get(name)

    def list_tools(self) -> List[str]:
        """List all registered tool names"""
        return list(self._tools.keys())

    def get_schemas(self) -> List[Dict]:
        """Get JSON schemas for all tools (for LLM function calling)"""
        return [tool.to_schema() for tool in self._tools.values()]

    def execute(self, name: str, **kwargs) -> ToolResult:
        """Execute a tool by name"""
        tool = self.get(name)
        if not tool:
            return ToolResult(
                success=False,
                error=f"Unknown tool: {name}. Available: {self.list_tools()}"
            )

        # Validate required parameters
        for param in tool.parameters:
            if param.required and param.name not in kwargs:
                return ToolResult(
                    success=False,
                    error=f"Missing required parameter '{param.name}' for tool '{name}'"
                )

        # Fill defaults
        for param in tool.parameters:
            if param.name not in kwargs and param.default is not None:
                kwargs[param.name] = param.default

        return tool.execute(**kwargs)

    def get_descriptions(self) -> str:
        """Get human-readable description of all tools"""
        lines = []
        for name, tool in self._tools.items():
            params = ", ".join(
                f"{p.name}{'*' if p.required else ''}: {p.type}"
                for p in tool.parameters
            )
            lines.append(f"- **{name}**({params}): {tool.description}")
        return "\n".join(lines)


def build_default_registry(
    ontology: Optional[OntologyEngine] = None,
    db_path: Optional[str] = None,
    embedding_search_fn=None,
    llm_call_fn=None,
) -> ToolRegistry:
    """
    Build the default tool registry with all 6 core tools.

    Args:
        ontology: Ontology engine instance
        db_path: Path to SQLite database
        embedding_search_fn: Optional BGE embedding search function
        llm_call_fn: Optional LLM callable for SQL fix/validate

    Returns:
        Configured ToolRegistry with all tools registered
    """
    from agent.agent_loop.tools import (
        QueryDefectsTool, QueryTrendTool, DistributionTool,
        RankingTool, SearchSimilarTool, DashboardTool
    )

    ont = ontology or get_ontology_engine()

    registry = ToolRegistry()
    registry.register(QueryDefectsTool(ontology=ont, db_path=db_path, llm_call_fn=llm_call_fn))
    registry.register(QueryTrendTool(ontology=ont, db_path=db_path))
    registry.register(DistributionTool(ontology=ont, db_path=db_path))
    registry.register(RankingTool(ontology=ont, db_path=db_path))
    registry.register(SearchSimilarTool(
        ontology=ont, db_path=db_path, embedding_search_fn=embedding_search_fn
    ))
    registry.register(DashboardTool(ontology=ont, db_path=db_path))

    return registry
