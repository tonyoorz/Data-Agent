"""Agent Tools - Core tool definitions for the ReAct loop

Each tool wraps a specific capability:
- QueryDefectsTool: NL→SQL defect querying
- QueryTrendTool: Time series trend analysis
- DistributionTool: Group-by distribution analysis
- RankingTool: TOP-N ranking queries
- SearchSimilarTool: BGE semantic search for similar defects
- DashboardTool: Summary metrics/KPIs
"""

import sqlite3
import json
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field
from pathlib import Path
from abc import ABC, abstractmethod

from agent.ontology import OntologyEngine, get_ontology_engine
from agent.sql_engine.generator import NL2SQLEngine, get_nl2sql_engine
from agent.understand.entity_extractor import ExtractionResult
from agent.understand.intent_detector import QueryIntent


@dataclass
class ToolParameter:
    """Parameter definition for a tool"""
    name: str
    type: str           # string, integer, boolean, array
    description: str
    required: bool = False
    default: Any = None
    enum: Optional[List[str]] = None


@dataclass
class ToolResult:
    """Result from tool execution"""
    success: bool
    data: Any = None           # The actual result data
    sql: str = ""              # SQL that was executed (if applicable)
    summary: str = ""          # Human-readable summary
    error: str = ""
    metadata: Dict = field(default_factory=dict)  # Extra info (row count, timing, etc.)


@dataclass
class AgentTool(ABC):
    """Base class for all agent tools"""
    name: str
    description: str
    parameters: List[ToolParameter] = field(default_factory=list)

    @abstractmethod
    def execute(self, **kwargs) -> ToolResult:
        """Execute the tool with given parameters"""
        pass

    def to_schema(self) -> Dict:
        """Convert to JSON schema for LLM function calling"""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": {
                "type": "object",
                "properties": {
                    p.name: {
                        "type": p.type,
                        "description": p.description,
                        **({"enum": p.enum} if p.enum else {}),
                        **({"default": p.default} if p.default is not None else {}),
                    }
                    for p in self.parameters
                },
                "required": [p.name for p in self.parameters if p.required],
            }
        }


class QueryDefectsTool(AgentTool):
    """
    Query defect data using natural language.
    Uses the NL→SQL engine to translate questions to SQL and execute.
    """

    def __init__(self, ontology: Optional[OntologyEngine] = None,
                 db_path: Optional[str] = None):
        self.name = "query_defects"
        self.description = (
            "查询缺陷数据。支持自然语言提问，自动生成SQL并执行。"
            "例如: 'IDCEVO 本月 Critical 缺陷有多少'"
        )
        self.parameters = [
            ToolParameter(
                name="question",
                type="string",
                description="自然语言查询问题",
                required=True
            ),
            ToolParameter(
                name="limit",
                type="integer",
                description="返回结果最大行数",
                default=50
            ),
        ]
        self.engine = NL2SQLEngine(ontology=ontology, db_path=db_path)

    def execute(self, question: str, limit: int = 50, **kwargs) -> ToolResult:
        """Execute NL→SQL query"""
        result = self.engine.query(question)

        if result.error:
            return ToolResult(
                success=False,
                error=result.error,
                sql=result.sql,
                summary=f"查询失败: {result.error}"
            )

        row_count = len(result.data)
        # Build summary
        if row_count == 0:
            summary = "查询结果为空"
        elif row_count == 1 and len(result.data[0]) == 1:
            # Single scalar value (like COUNT)
            val = list(result.data[0].values())[0]
            summary = f"结果: {val}"
        else:
            summary = f"返回 {row_count} 行数据"

        return ToolResult(
            success=True,
            data=result.data[:limit],
            sql=result.sql,
            summary=summary,
            metadata={
                "intent": result.intent,
                "row_count": row_count,
                "candidates_count": len(result.candidates),
            }
        )


class QueryTrendTool(AgentTool):
    """
    Time series trend analysis tool.
    Generates day/week/month trend data.
    """

    def __init__(self, ontology: Optional[OntologyEngine] = None,
                 db_path: Optional[str] = None):
        self.name = "query_trend"
        self.description = (
            "趋势分析工具。按天/周/月统计缺陷数量变化。"
            "例如: 'IDCEVO 近3个月缺陷趋势'"
        )
        self.parameters = [
            ToolParameter(
                name="question",
                type="string",
                description="趋势分析问题",
                required=True
            ),
            ToolParameter(
                name="granularity",
                type="string",
                description="时间粒度",
                enum=["day", "week", "month"],
                default="month"
            ),
        ]
        self.engine = NL2SQLEngine(ontology=ontology, db_path=db_path)
        self.ontology = ontology or get_ontology_engine()
        self.db_path = db_path

    def execute(self, question: str, granularity: str = "month", **kwargs) -> ToolResult:
        """Execute trend query with specified granularity"""
        table = self.ontology.get_object("Defect").source_table
        time_field = "creation_time"

        # Build granularity SQL
        if granularity == "day":
            date_expr = f"date({time_field})"
            date_label = "date"
        elif granularity == "week":
            date_expr = f"strftime('%Y-W%W', {time_field})"
            date_label = "week"
        else:  # month
            date_expr = f"strftime('%Y-%m', {time_field})"
            date_label = "month"

        # Use NL2SQL to get WHERE clause
        result = self.engine.query(question)

        # Extract WHERE from generated SQL
        where_match = result.sql.upper().find("WHERE")
        if where_match != -1:
            # Extract everything after WHERE up to GROUP BY/ORDER/LIMIT
            where_part = result.sql[where_match + 5:]
            for stopper in ["GROUP BY", "ORDER BY", "LIMIT"]:
                stop_pos = where_part.upper().find(stopper)
                if stop_pos != -1:
                    where_part = where_part[:stop_pos]
            where_clause = where_part.strip()
        else:
            where_clause = "1=1"

        sql = (
            f"SELECT {date_expr} as {date_label}, COUNT(*) as count "
            f"FROM {table} WHERE {where_clause} "
            f"GROUP BY {date_expr} ORDER BY {date_label}"
        )

        # Execute
        data = []
        error = None
        if self.db_path:
            try:
                conn = sqlite3.connect(self.db_path)
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute(sql)
                data = [dict(row) for row in cursor.fetchall()]
                conn.close()
            except Exception as e:
                error = str(e)

        if error:
            return ToolResult(success=False, error=error, sql=sql)

        # Compute trend direction
        if len(data) >= 2:
            last_val = data[-1]["count"]
            prev_val = data[-2]["count"]
            if last_val > prev_val:
                direction = "上升 ↑"
            elif last_val < prev_val:
                direction = "下降 ↓"
            else:
                direction = "持平 →"
            summary = f"趋势: {direction} (最近: {last_val}, 上一期: {prev_val})"
        elif len(data) == 1:
            summary = f"仅1期数据: {data[0]['count']}"
        else:
            summary = "无趋势数据"

        return ToolResult(
            success=True,
            data=data,
            sql=sql,
            summary=summary,
            metadata={"granularity": granularity, "periods": len(data)}
        )


class DistributionTool(AgentTool):
    """
    Distribution/breakdown analysis tool.
    Groups defects by a dimension and shows counts/percentages.
    """

    def __init__(self, ontology: Optional[OntologyEngine] = None,
                 db_path: Optional[str] = None):
        self.name = "get_distribution"
        self.description = (
            "分布分析工具。按指定维度分组统计缺陷数量和占比。"
            "例如: 按项目/严重度/ECU/团队分布"
        )
        self.parameters = [
            ToolParameter(
                name="group_by",
                type="string",
                description="分组维度: project, severity, assigned_ecu, team, status_phase, phase, top_aida",
                required=True,
                enum=["project", "severity", "assigned_ecu", "team",
                      "status_phase", "phase", "top_aida", "market"]
            ),
            ToolParameter(
                name="filters",
                type="string",
                description="过滤条件 (如: project=IDCEVO)",
                default=""
            ),
            ToolParameter(
                name="top_n",
                type="integer",
                description="只返回前N个分组",
                default=20
            ),
        ]
        self.ontology = ontology or get_ontology_engine()
        self.db_path = db_path

    def execute(self, group_by: str, filters: str = "",
                top_n: int = 20, **kwargs) -> ToolResult:
        """Execute distribution query"""
        table = self.ontology.get_object("Defect").source_table

        # Build WHERE from filters string
        where_clause = "1=1"
        if filters:
            # Simple key=value parsing
            parts = filters.split(",")
            conditions = []
            for part in parts:
                if "=" in part:
                    key, val = part.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip("'\"")
                    conditions.append(f"{key} = '{val}'")
            if conditions:
                where_clause = " AND ".join(conditions)

        # Check for category group
        prop = self.ontology.get_property("Defect", group_by)
        if prop and prop.category_groups:
            # Check if filters contains a category name for this field
            for group_name, group_values in prop.category_groups.items():
                if group_name.lower() in filters.lower():
                    values_str = ", ".join(f"'{v}'" for v in group_values)
                    where_clause += f" AND {group_by} IN ({values_str})"
                    break

        sql = (
            f"SELECT {group_by}, COUNT(*) as count, "
            f"ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM {table} WHERE {where_clause}), 1) as pct "
            f"FROM {table} WHERE {where_clause} "
            f"GROUP BY {group_by} ORDER BY count DESC LIMIT {top_n}"
        )

        data = []
        error = None
        if self.db_path:
            try:
                conn = sqlite3.connect(self.db_path)
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute(sql)
                data = [dict(row) for row in cursor.fetchall()]
                conn.close()
            except Exception as e:
                error = str(e)

        if error:
            return ToolResult(success=False, error=error, sql=sql)

        # Build summary
        if data:
            top_item = data[0]
            summary = f"共{len(data)}个分组, 最多: {top_item[group_by]} ({top_item['count']}个, {top_item['pct']}%)"
        else:
            summary = "无分布数据"

        return ToolResult(
            success=True,
            data=data,
            sql=sql,
            summary=summary,
            metadata={"group_by": group_by, "groups": len(data)}
        )


class RankingTool(AgentTool):
    """
    Ranking tool for TOP-N queries.
    """

    def __init__(self, ontology: Optional[OntologyEngine] = None,
                 db_path: Optional[str] = None):
        self.name = "get_ranking"
        self.description = (
            "排名查询工具。按指定维度排序，返回TOP N。"
            "例如: 缺陷最多的10个ECU"
        )
        self.parameters = [
            ToolParameter(
                name="rank_by",
                type="string",
                description="排名维度: project, severity, assigned_ecu, team, status_phase, phase, top_aida",
                required=True,
                enum=["project", "severity", "assigned_ecu", "team",
                      "status_phase", "phase", "top_aida"]
            ),
            ToolParameter(
                name="order",
                type="string",
                description="排序方向",
                enum=["desc", "asc"],
                default="desc"
            ),
            ToolParameter(
                name="limit",
                type="integer",
                description="返回行数",
                default=10
            ),
            ToolParameter(
                name="filters",
                type="string",
                description="过滤条件",
                default=""
            ),
        ]
        self.ontology = ontology or get_ontology_engine()
        self.db_path = db_path

    def execute(self, rank_by: str, order: str = "desc", limit: int = 10,
                filters: str = "", **kwargs) -> ToolResult:
        """Execute ranking query"""
        table = self.ontology.get_object("Defect").source_table

        where_clause = "1=1"
        if filters:
            parts = filters.split(",")
            conditions = []
            for part in parts:
                if "=" in part:
                    key, val = part.split("=", 1)
                    conditions.append(f"{key.strip()} = '{val.strip().strip(chr(39) + chr(34))}'")
            if conditions:
                where_clause = " AND ".join(conditions)

        sql_direction = "DESC" if order.lower() == "desc" else "ASC"
        sql = (
            f"SELECT {rank_by}, COUNT(*) as count "
            f"FROM {table} WHERE {where_clause} AND {rank_by} IS NOT NULL "
            f"GROUP BY {rank_by} ORDER BY count {sql_direction} LIMIT {limit}"
        )

        data = []
        if self.db_path:
            try:
                conn = sqlite3.connect(self.db_path)
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute(sql)
                data = [dict(row) for row in cursor.fetchall()]
                conn.close()
            except Exception as e:
                return ToolResult(success=False, error=str(e), sql=sql)

        if data:
            summary = f"TOP {len(data)}: 第1名 {data[0][rank_by]} ({data[0]['count']}个)"
        else:
            summary = "无排名数据"

        return ToolResult(
            success=True,
            data=data,
            sql=sql,
            summary=summary,
            metadata={"rank_by": rank_by, "limit": limit}
        )


class SearchSimilarTool(AgentTool):
    """
    Semantic search for similar defects using BGE embeddings.
    Wraps the existing duplicate_issue_finder.py if available.
    """

    def __init__(self, ontology: Optional[OntologyEngine] = None,
                 db_path: Optional[str] = None,
                 embedding_search_fn=None):
        self.name = "search_similar"
        self.description = (
            "语义搜索相似缺陷。使用BGE embedding向量检索。"
            "输入缺陷描述或关键词，返回最相似的缺陷列表。"
        )
        self.parameters = [
            ToolParameter(
                name="query",
                type="string",
                description="搜索文本（缺陷描述、关键词等）",
                required=True
            ),
            ToolParameter(
                name="top_k",
                type="integer",
                description="返回结果数量",
                default=10
            ),
            ToolParameter(
                name="threshold",
                type="number",  # float
                description="相似度阈值 (0-1)",
                default=0.5
            ),
        ]
        self.ontology = ontology or get_ontology_engine()
        self.db_path = db_path
        self._search_fn = embedding_search_fn  # Injected dependency

    def execute(self, query: str, top_k: int = 10,
                threshold: float = 0.5, **kwargs) -> ToolResult:
        """Execute semantic search"""
        if self._search_fn:
            # Use injected search function (production)
            try:
                results = self._search_fn(query, top_k=top_k, threshold=threshold)
                summary = f"找到 {len(results)} 个相似缺陷"
                return ToolResult(
                    success=True,
                    data=results,
                    summary=summary,
                    metadata={"top_k": top_k, "threshold": threshold}
                )
            except Exception as e:
                return ToolResult(success=False, error=str(e))

        # Fallback: keyword-based search using SQL LIKE
        if self.db_path:
            table = self.ontology.get_object("Defect").source_table
            # Simple keyword search
            keywords = query.split()
            like_conditions = " OR ".join(
                f"name LIKE '%{kw}%' OR assigned_ecu LIKE '%{kw}%'"
                for kw in keywords[:3]  # Limit to 3 keywords
            )
            sql = (
                f"SELECT defect_id, name, project, severity, status_phase, "
                f"assigned_ecu, creation_time FROM {table} "
                f"WHERE {like_conditions} LIMIT {top_k}"
            )
            try:
                conn = sqlite3.connect(self.db_path)
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute(sql)
                data = [dict(row) for row in cursor.fetchall()]
                conn.close()
                summary = f"关键词搜索找到 {len(data)} 个相关缺陷"
                return ToolResult(
                    success=True,
                    data=data,
                    sql=sql,
                    summary=summary,
                    metadata={"mode": "keyword_fallback"}
                )
            except Exception as e:
                return ToolResult(success=False, error=str(e), sql=sql)

        return ToolResult(
            success=False,
            error="No search function or database available"
        )


class DashboardTool(AgentTool):
    """
    Dashboard summary tool - returns key metrics at a glance.
    """

    def __init__(self, ontology: Optional[OntologyEngine] = None,
                 db_path: Optional[str] = None):
        self.name = "get_dashboard"
        self.description = (
            "获取仪表盘汇总指标。一键返回: 总缺陷数、活跃缺陷数、"
            "Critical缺陷数、各项目分布等核心KPI。"
        )
        self.parameters = [
            ToolParameter(
                name="project",
                type="string",
                description="指定项目 (留空=全部项目)",
                default=""
            ),
        ]
        self.ontology = ontology or get_ontology_engine()
        self.db_path = db_path

    def execute(self, project: str = "", **kwargs) -> ToolResult:
        """Execute dashboard query"""
        if not self.db_path:
            return ToolResult(success=False, error="No database configured")

        table = self.ontology.get_object("Defect").source_table
        project_filter = f" AND project = '{project}'" if project else ""

        queries = {
            "total": f"SELECT COUNT(*) as val FROM {table} WHERE 1=1{project_filter}",
            "active": f"SELECT COUNT(*) as val FROM {table} WHERE status_phase IN ('New', 'Open', 'In Progress'){project_filter}",
            "critical": f"SELECT COUNT(*) as val FROM {table} WHERE severity = 'Critical' AND status_phase IN ('New', 'Open', 'In Progress'){project_filter}",
            "resolved": f"SELECT COUNT(*) as val FROM {table} WHERE status_phase IN ('Fixed', 'Closed'){project_filter}",
        }

        results = {}
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            for key, sql in queries.items():
                cursor.execute(sql)
                results[key] = cursor.fetchone()[0]

            # Project distribution
            cursor.execute(
                f"SELECT project, COUNT(*) as count FROM {table} "
                f"WHERE 1=1{project_filter} GROUP BY project ORDER BY count DESC LIMIT 10"
            )
            results["by_project"] = [dict(zip(["project", "count"], row))
                                    for row in cursor.fetchall()]

            # Severity distribution
            cursor.execute(
                f"SELECT severity, COUNT(*) as count FROM {table} "
                f"WHERE 1=1{project_filter} GROUP BY severity ORDER BY count DESC"
            )
            results["by_severity"] = [dict(zip(["severity", "count"], row))
                                      for row in cursor.fetchall()]

            conn.close()
        except Exception as e:
            return ToolResult(success=False, error=str(e))

        # Build summary
        summary_parts = [
            f"总缺陷: {results['total']}",
            f"活跃: {results['active']}",
            f"Critical: {results['critical']}",
            f"已解决: {results['resolved']}",
        ]
        summary = " | ".join(summary_parts)

        return ToolResult(
            success=True,
            data=results,
            summary=summary,
            metadata={"project": project or "ALL"}
        )
