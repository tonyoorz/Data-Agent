"""ReAct Agent Loop - Thought/Action/Observation reasoning cycle

Implements the ReAct pattern:
1. Thought: reason about what to do next
2. Action: call a tool
3. Observation: process the result
4. Repeat until final answer can be given

The loop supports both:
- Rule-based mode (deterministic tool selection)
- LLM-based mode (dynamic reasoning via function calling)
"""

import time
import json
from typing import Dict, List, Optional, Any, Callable, Generator
from dataclasses import dataclass, field
from enum import Enum

from agent.agent_loop.tools import AgentTool, ToolResult
from agent.agent_loop.registry import ToolRegistry, build_default_registry
from agent.ontology import OntologyEngine, get_ontology_engine
from agent.sql_engine.generator import NL2SQLEngine
from agent.understand.intent_detector import QueryIntent


class StepType(Enum):
    """Types of steps in the agent loop"""
    THOUGHT = "thought"
    ACTION = "action"
    OBSERVATION = "observation"
    FINAL = "final"
    ERROR = "error"


@dataclass
class AgentStep:
    """A single step in the agent loop"""
    step_type: StepType
    content: str                 # Human-readable content
    tool_name: str = ""          # Which tool was called (for ACTION)
    tool_input: Dict = field(default_factory=dict)  # Tool parameters
    tool_output: Optional[ToolResult] = None         # Tool result
    timestamp: float = field(default_factory=time.time)


@dataclass
class AgentResponse:
    """Final response from the agent"""
    answer: str                        # Final answer text
    steps: List[AgentStep] = field(default_factory=list)  # All steps taken
    tools_used: List[str] = field(default_factory=list)   # Tool names used
    sql_executed: List[str] = field(default_factory=list) # SQL queries run
    total_time_ms: float = 0.0
    success: bool = True
    error: str = ""


class ReActAgent:
    """
    ReAct Agent - reasons and acts in a loop.

    In rule-based mode, the agent uses deterministic logic to:
    1. Understand the question (intent + entities)
    2. Select the right tool
    3. Execute and collect results
    4. Format the final answer

    In LLM mode (when llm_call_fn is provided), the agent uses
    LLM reasoning for tool selection and answer generation.
    """

    MAX_STEPS = 8  # Safety limit

    def __init__(
        self,
        registry: Optional[ToolRegistry] = None,
        ontology: Optional[OntologyEngine] = None,
        db_path: Optional[str] = None,
        llm_call_fn: Optional[Callable] = None,
    ):
        self.ontology = ontology or get_ontology_engine()
        self.db_path = db_path
        self.llm_call_fn = llm_call_fn  # Optional: fn(messages, tools) -> response

        if registry:
            self.registry = registry
        else:
            # Get fixer_fn for NL2SQL self-correction
            fixer_fn = None
            if llm_call_fn:
                # Adapt agent_fn to fixer_fn format (str -> str)
                from agent.llm import get_llm_client
                llm = get_llm_client()
                if llm:
                    fixer_fn = llm.as_fixer_fn()

            self.registry = build_default_registry(
                ontology=self.ontology,
                db_path=db_path,
                llm_call_fn=fixer_fn,
            )

        self.nl2sql = NL2SQLEngine(ontology=ontology, db_path=db_path)

    def process(self, question: str) -> AgentResponse:
        """
        Process a user question through the ReAct loop.

        Args:
            question: User's natural language question

        Returns:
            AgentResponse with answer, steps, and metadata
        """
        start_time = time.time()
        steps: List[AgentStep] = []
        tools_used: List[str] = []
        sql_executed: List[str] = []

        try:
            if self.llm_call_fn:
                # LLM-based mode
                response = self._process_with_llm(question, steps, tools_used, sql_executed)
            else:
                # Rule-based mode
                response = self._process_rule_based(question, steps, tools_used, sql_executed)
        except Exception as e:
            response = AgentResponse(
                answer=f"处理问题时发生错误: {str(e)}",
                steps=steps,
                tools_used=tools_used,
                sql_executed=sql_executed,
                success=False,
                error=str(e),
            )

        elapsed = (time.time() - start_time) * 1000
        response.steps = steps
        response.tools_used = tools_used
        response.sql_executed = sql_executed
        response.total_time_ms = elapsed

        return response

    def process_stream(self, question: str) -> Generator[AgentStep, None, None]:
        """
        Process question and yield steps as they happen (for SSE streaming).

        Yields AgentStep objects that can be converted to SSE events.
        """
        try:
            if self.llm_call_fn:
                steps_gen = self._stream_with_llm(question)
            else:
                steps_gen = self._stream_rule_based(question)

            for step in steps_gen:
                yield step
        except Exception as e:
            yield AgentStep(
                step_type=StepType.ERROR,
                content=f"错误: {str(e)}"
            )

    # ==================== Rule-Based Mode ====================

    def _process_rule_based(
        self,
        question: str,
        steps: List[AgentStep],
        tools_used: List[str],
        sql_executed: List[str],
    ) -> AgentResponse:
        """Rule-based processing: deterministic tool selection"""
        from agent.understand.entity_extractor import get_entity_extractor
        from agent.understand.intent_detector import get_intent_detector, QueryIntent

        # Step 1: Analyze question
        extractor = get_entity_extractor(self.ontology)
        entities = extractor.extract(question)
        intent = get_intent_detector().detect(question, entities)

        steps.append(AgentStep(
            step_type=StepType.THOUGHT,
            content=(
                f"分析问题: 意图={intent.primary.value}, 置信度={intent.confidence:.1%}\n"
                f"提取实体: {self._format_entities(entities)}\n"
                f"选择工具: {self._select_tool_name(intent.primary)}"
            )
        ))

        # Step 2: Select and execute tool
        tool_name = self._select_tool_name(intent.primary)
        tool = self.registry.get(tool_name)

        if not tool:
            steps.append(AgentStep(
                step_type=StepType.ERROR,
                content=f"工具未找到: {tool_name}"
            ))
            return AgentResponse(
                answer=f"无法处理意图类型: {intent.primary.value}",
                success=False,
            )

        # Execute tool
        result = self._execute_tool_for_intent(
            tool_name, tool, question, intent, entities
        )

        tools_used.append(tool_name)
        if result.sql:
            sql_executed.append(result.sql)

        steps.append(AgentStep(
            step_type=StepType.ACTION,
            content=f"调用工具: {tool_name}",
            tool_name=tool_name,
            tool_input={"question": question},
        ))

        steps.append(AgentStep(
            step_type=StepType.OBSERVATION,
            content=result.summary,
            tool_output=result,
        ))

        # Step 3: Determine if we need a follow-up tool
        if intent.primary == QueryIntent.SUMMARY:
            # For summaries, also get distribution
            dist_result = self.registry.execute(
                "get_distribution", group_by="severity"
            )
            if dist_result.success:
                tools_used.append("get_distribution")
                steps.append(AgentStep(
                    step_type=StepType.OBSERVATION,
                    content=f"补充数据 - 严重度分布: {dist_result.summary}",
                    tool_output=dist_result,
                ))

        # Step 4: Generate final answer
        answer = self._format_answer(question, intent, result, steps)

        steps.append(AgentStep(
            step_type=StepType.FINAL,
            content=answer
        ))

        return AgentResponse(answer=answer, success=True)

    def _select_tool_name(self, intent) -> str:
        """Map intent to tool name"""
        mapping = {
            QueryIntent.COUNT: "query_defects",
            QueryIntent.TREND: "query_trend",
            QueryIntent.RANKING: "get_ranking",
            QueryIntent.DISTRIBUTION: "get_distribution",
            QueryIntent.COMPARISON: "get_distribution",
            QueryIntent.DETAIL_LIST: "query_defects",
            QueryIntent.SEARCH_SIMILAR: "search_similar",
            QueryIntent.RISK_ANALYSIS: "query_defects",
            QueryIntent.SUMMARY: "get_dashboard",
            QueryIntent.ROOT_CAUSE: "query_defects",
            QueryIntent.STATUS_CHECK: "query_defects",
        }
        return mapping.get(intent, "query_defects")

    def _execute_tool_for_intent(self, tool_name: str, tool: AgentTool,
                                  question: str, intent, entities) -> ToolResult:
        """Execute the selected tool with appropriate parameters"""
        if tool_name == "query_defects":
            return self.registry.execute("query_defects", question=question)

        elif tool_name == "query_trend":
            return self.registry.execute("query_trend", question=question)

        elif tool_name == "get_ranking":
            rank_by = "assigned_ecu"
            for e in entities.entities:
                if e.entity_type in ("project", "ecu", "team", "severity"):
                    rank_by = e.field
                    break
            limit = 10
            limit_entity = entities.get_first("limit")
            if limit_entity:
                limit = int(limit_entity.value)
            return self.registry.execute("get_ranking", rank_by=rank_by, limit=limit)

        elif tool_name == "get_distribution":
            group_by = "project"
            for e in entities.entities:
                if e.entity_type in ("project", "ecu", "severity", "status",
                                     "team", "test_phase", "aida"):
                    group_by = e.field
                    break
            # Check question for dimension hints
            dim_hints = {
                "项目": "project", "ECU": "assigned_ecu", "严重": "severity",
                "状态": "status_phase", "团队": "team", "阶段": "phase",
            }
            for keyword, field_name in dim_hints.items():
                if keyword in question:
                    group_by = field_name
                    break
            return self.registry.execute("get_distribution", group_by=group_by)

        elif tool_name == "search_similar":
            return self.registry.execute("search_similar", query=question)

        elif tool_name == "get_dashboard":
            project = ""
            for e in entities.entities:
                if e.entity_type == "project":
                    project = e.value
                    break
            return self.registry.execute("get_dashboard", project=project)

        return self.registry.execute("query_defects", question=question)

    # ==================== LLM-Based Mode ====================

    def _process_with_llm(
        self,
        question: str,
        steps: List[AgentStep],
        tools_used: List[str],
        sql_executed: List[str],
    ) -> AgentResponse:
        """LLM-based processing: dynamic tool selection via function calling"""
        messages = [
            {
                "role": "system",
                "content": self._build_system_prompt()
            },
            {
                "role": "user",
                "content": question
            }
        ]

        tool_schemas = self.registry.get_schemas()

        for _ in range(self.MAX_STEPS):
            # Call LLM
            llm_response = self.llm_call_fn(messages, tool_schemas)

            if llm_response.get("tool_calls"):
                # LLM wants to call tools
                for tool_call in llm_response["tool_calls"]:
                    tool_name = tool_call["name"]
                    tool_args = tool_call["arguments"]

                    steps.append(AgentStep(
                        step_type=StepType.THOUGHT,
                        content=tool_call.get("thought", f"使用 {tool_name}")
                    ))
                    steps.append(AgentStep(
                        step_type=StepType.ACTION,
                        content=f"调用 {tool_name}({tool_args})",
                        tool_name=tool_name,
                        tool_input=tool_args,
                    ))

                    result = self.registry.execute(tool_name, **tool_args)
                    tools_used.append(tool_name)
                    if result.sql:
                        sql_executed.append(result.sql)

                    steps.append(AgentStep(
                        step_type=StepType.OBSERVATION,
                        content=result.summary,
                        tool_output=result,
                    ))

                    # Add to conversation
                    messages.append({
                        "role": "tool",
                        "name": tool_name,
                        "content": json.dumps({
                            "success": result.success,
                            "summary": result.summary,
                            "data": result.data[:10] if isinstance(result.data, list) else result.data,
                        }, ensure_ascii=False, default=str)
                    })
            else:
                # LLM gives final answer
                answer = llm_response.get("content", "")
                steps.append(AgentStep(
                    step_type=StepType.FINAL,
                    content=answer
                ))
                return AgentResponse(answer=answer, success=True)

        # Max steps reached
        steps.append(AgentStep(
            step_type=StepType.FINAL,
            content="达到最大步数限制，基于已有信息生成回答"
        ))
        return AgentResponse(
            answer="基于已有信息: " + steps[-2].content if len(steps) >= 2 else "无法回答",
            success=True,
        )

    # ==================== Streaming ====================

    def _stream_rule_based(self, question: str) -> Generator[AgentStep, None, None]:
        """Stream rule-based processing"""
        from agent.understand.entity_extractor import get_entity_extractor
        from agent.understand.intent_detector import get_intent_detector

        entities = get_entity_extractor(self.ontology).extract(question)
        intent = get_intent_detector().detect(question, entities)

        yield AgentStep(
            step_type=StepType.THOUGHT,
            content=f"🤔 意图: {intent.primary.value} | 实体: {self._format_entities(entities)}"
        )

        tool_name = self._select_tool_name(intent.primary)
        result = self._execute_tool_for_intent(
            tool_name, self.registry.get(tool_name), question, intent, entities
        )

        yield AgentStep(
            step_type=StepType.ACTION,
            content=f"🔧 调用 {tool_name}",
            tool_name=tool_name,
        )

        yield AgentStep(
            step_type=StepType.OBSERVATION,
            content=f"📊 {result.summary}",
            tool_output=result,
        )

        answer = self._format_answer(question, intent, result, [])
        yield AgentStep(
            step_type=StepType.FINAL,
            content=answer
        )

    def _stream_with_llm(self, question: str) -> Generator[AgentStep, None, None]:
        """Stream LLM-based processing"""
        # Similar to _process_with_llm but yields steps
        messages = [
            {"role": "system", "content": self._build_system_prompt()},
            {"role": "user", "content": question}
        ]
        tool_schemas = self.registry.get_schemas()

        for _ in range(self.MAX_STEPS):
            llm_response = self.llm_call_fn(messages, tool_schemas)

            if llm_response.get("tool_calls"):
                for tool_call in llm_response["tool_calls"]:
                    tool_name = tool_call["name"]
                    tool_args = tool_call["arguments"]

                    yield AgentStep(
                        step_type=StepType.THOUGHT,
                        content=tool_call.get("thought", f"使用 {tool_name}")
                    )

                    result = self.registry.execute(tool_name, **tool_args)

                    yield AgentStep(
                        step_type=StepType.ACTION,
                        content=f"🔧 {tool_name}({json.dumps(tool_args, ensure_ascii=False)})",
                        tool_name=tool_name,
                        tool_input=tool_args,
                        tool_output=result,
                    )

                    messages.append({
                        "role": "tool",
                        "name": tool_name,
                        "content": json.dumps({
                            "success": result.success,
                            "summary": result.summary,
                            "data": result.data[:10] if isinstance(result.data, list) else result.data,
                        }, ensure_ascii=False, default=str)
                    })
            else:
                answer = llm_response.get("content", "")
                yield AgentStep(
                    step_type=StepType.FINAL,
                    content=answer
                )
                return

    # ==================== Helpers ====================

    def _build_system_prompt(self) -> str:
        """Build system prompt for LLM mode"""
        tool_desc = self.registry.get_descriptions()
        schema_context = self.ontology.to_schema_context()[:2000]

        return f"""你是一个汽车测试缺陷数据分析 Agent。

你可以使用以下工具来回答用户的问题:
{tool_desc}

数据库语义:
{schema_context}

规则:
1. 先理解用户意图，选择最合适的工具
2. 一个问题可能需要多步: 先查总数，再查分布，最后总结
3. 用中文回答，数据要精确
4. 对于趋势问题，说明上升/下降趋势
5. 对于分布问题，说明TOP3
"""

    def _format_entities(self, entities) -> str:
        """Format entities for display"""
        parts = []
        for e in entities.entities:
            if e.values:
                parts.append(f"{e.entity_type}={e.original}({e.value})→IN")
            else:
                parts.append(f"{e.entity_type}={e.original}({e.value})")
        return ", ".join(parts) if parts else "(无)"

    def _format_answer(self, question: str, intent, result: ToolResult,
                       steps: List[AgentStep]) -> str:
        """Format the final answer based on intent and results"""
        if not result.success:
            return f"查询失败: {result.error}"

        data = result.data
        intent_val = intent.primary.value

        if intent_val == "count":
            if isinstance(data, list) and len(data) == 1 and len(data[0]) == 1:
                val = list(data[0].values())[0]
                return f"根据查询结果，{question}的答案是: **{val}**"
            elif isinstance(data, list) and len(data) == 1:
                # Single row
                parts = [f"  - {k}: {v}" for k, v in data[0].items()]
                return f"查询结果:\n" + "\n".join(parts)
            elif isinstance(data, list):
                return f"共找到 **{len(data)}** 条记录"
            else:
                return result.summary

        elif intent_val == "trend":
            if isinstance(data, list) and len(data) >= 2:
                last = data[-1]
                prev = data[-2]
                count_key = "count"
                label_key = list(last.keys())[0]
                direction = "上升" if last[count_key] > prev[count_key] else "下降"
                return (
                    f"趋势分析结果（共{len(data)}期）:\n"
                    f"- 最近一期: {last[label_key]} = {last[count_key]}\n"
                    f"- 上一期: {prev[label_key]} = {prev[count_key]}\n"
                    f"- 趋势: **{direction}**\n"
                    f"- 变化量: {last[count_key] - prev[count_key]}"
                )
            return result.summary

        elif intent_val in ("distribution", "comparison"):
            if isinstance(data, list) and data:
                lines = [f"分布分析（共{len(data)}个分组）:"]
                for i, row in enumerate(data[:5]):
                    group_val = row.get(list(row.keys())[0], "?")
                    count = row.get("count", 0)
                    pct = row.get("pct", "")
                    pct_str = f" ({pct}%)" if pct else ""
                    lines.append(f"  {i+1}. {group_val}: {count}{pct_str}")
                if len(data) > 5:
                    lines.append(f"  ... 共{len(data)}个分组")
                return "\n".join(lines)
            return result.summary

        elif intent_val == "ranking":
            if isinstance(data, list) and data:
                lines = [f"排名结果（TOP {len(data)}）:"]
                for i, row in enumerate(data):
                    rank_val = row.get(list(row.keys())[0], "?")
                    count = row.get("count", 0)
                    lines.append(f"  {i+1}. {rank_val}: {count}")
                return "\n".join(lines)
            return result.summary

        elif intent_val == "summary":
            if isinstance(data, dict):
                lines = ["📊 仪表盘概览:"]
                lines.append(f"- 总缺陷数: {data.get('total', 'N/A')}")
                lines.append(f"- 活跃缺陷: {data.get('active', 'N/A')}")
                lines.append(f"- Critical: {data.get('critical', 'N/A')}")
                lines.append(f"- 已解决: {data.get('resolved', 'N/A')}")
                return "\n".join(lines)
            return result.summary

        elif intent_val == "detail_list" or intent_val == "status_check":
            if isinstance(data, list) and data:
                lines = [f"共 {len(data)} 条记录，前5条:"]
                for row in data[:5]:
                    defect_id = row.get("defect_id", "")
                    name = row.get("name", "")[:40]
                    severity = row.get("severity", "")
                    lines.append(f"  - [{defect_id}] {severity}: {name}")
                return "\n".join(lines)
            return result.summary

        elif intent_val == "search_similar":
            if isinstance(data, list):
                return f"找到 {len(data)} 个相似缺陷"
            return result.summary

        return result.summary or "查询完成"


# Singleton
_agent: Optional[ReActAgent] = None


def get_agent(
    ontology: Optional[OntologyEngine] = None,
    db_path: Optional[str] = None,
    llm_call_fn: Optional[Callable] = None,
) -> ReActAgent:
    global _agent
    if _agent is None:
        _agent = ReActAgent(
            ontology=ontology,
            db_path=db_path,
            llm_call_fn=llm_call_fn,
        )
    return _agent
