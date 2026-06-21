"""Intent Detector - Classify user query intent

Identifies what kind of analysis the user wants:
- count_query: "有多少缺陷"
- trend_analysis: "趋势怎样"
- ranking: "TOP 10"
- distribution: "按项目分布"
- comparison: "IDCEVO vs IDC"
- detail_list: "列出所有Critical"
- search_similar: "有没有类似的"
- risk_analysis: "风险评估"
- summary: "概况"
"""

import re
from typing import List, Optional, Tuple
from dataclasses import dataclass
from enum import Enum

from agent.understand.entity_extractor import ExtractionResult


class QueryIntent(Enum):
    """Primary query intents"""
    COUNT = "count"                    # 多少/数量
    TREND = "trend"                    # 趋势/走势/变化
    RANKING = "ranking"                # TOP N / 排名
    DISTRIBUTION = "distribution"      # 分布/占比/分组
    COMPARISON = "comparison"          # 对比/比较
    DETAIL_LIST = "detail_list"        # 列表/明细
    SEARCH_SIMILAR = "search_similar"  # 相似/重复
    RISK_ANALYSIS = "risk_analysis"    # 风险
    SUMMARY = "summary"               # 概况/总览
    ROOT_CAUSE = "root_cause"          # 为什么/根因
    STATUS_CHECK = "status_check"      # 状态查询


@dataclass
class IntentResult:
    """Intent detection result"""
    primary: QueryIntent
    secondary: List[QueryIntent]
    confidence: float
    sql_template: str        # Hint for SQL generation
    needs_aggregation: bool
    needs_grouping: bool
    needs_timeseries: bool
    needs_join: bool
    description: str


# Intent detection rules: (intent, patterns, sql_hint, flags)
INTENT_RULES = [
    (
        QueryIntent.COUNT, [
            r"多少|数量|总数|几个|count",
            r"统计.*?(?:缺陷|问题|bug)",
        ],
        "SELECT COUNT(*) FROM {table} WHERE {filters}",
        True, False, False, False, "计数查询"
    ),
    (
        QueryIntent.TREND, [
            r"趋势|走势|变化|增长|下降|trend|时间线",
            r"近.*?(?:天|月|周).*?(?:变化|趋势)",
            r"按.*?(?:月|周|天).*?(?:统计|分组)",
        ],
        "SELECT date({time_field}) as date, COUNT(*) as count FROM {table} WHERE {filters} GROUP BY date({time_field}) ORDER BY date",
        True, False, True, False, "趋势分析"
    ),
    (
        QueryIntent.RANKING, [
            r"top\s*\d+|前\s*\d+|排名|最高|最多|最大|最低|最少",
            r"排.*?第",
            r"最.*?(?:多|少|高|低|严重)",
        ],
        "SELECT {group_field}, COUNT(*) as count FROM {table} WHERE {filters} GROUP BY {group_field} ORDER BY count DESC LIMIT {limit}",
        True, True, False, False, "排名查询"
    ),
    (
        QueryIntent.DISTRIBUTION, [
            r"分布|占比|比例|百分比|构成|breakdown",
            r"按.*?(?:项目|团队|ECU|严重度|阶段).*?(?:统计|分布|分组)",
            r"哪个.*?(?:最多|最高)",
            r"分别.*?(?:多少|几个)",
        ],
        "SELECT {group_field}, COUNT(*) as count FROM {table} WHERE {filters} GROUP BY {group_field} ORDER BY count DESC",
        True, True, False, False, "分布分析"
    ),
    (
        QueryIntent.COMPARISON, [
            r"对比|比较|vs|versus|同比|环比|差异",
            r"和.*?(?:相比|对比|哪个)",
        ],
        "SELECT {group_field}, COUNT(*) as count FROM {table} WHERE {filters} GROUP BY {group_field}",
        True, True, False, False, "对比分析"
    ),
    (
        QueryIntent.DETAIL_LIST, [
            r"列出|列表|明细|清单|详情|list|哪些",
            r"显示.*?(?:缺陷|问题|bug)",
            r"查看.*?(?:缺陷|问题)",
        ],
        "SELECT * FROM {table} WHERE {filters} LIMIT {limit}",
        False, False, False, False, "明细列表"
    ),
    (
        QueryIntent.SEARCH_SIMILAR, [
            r"类似|相似|重复|一样的|相同|duplicate|same",
            r"有没有.*?(?:同样|类似|一样)",
            r".*?是否.*?(?:出现过|遇到过)",
        ],
        "-- Uses BGE embedding search, not SQL",
        False, False, False, False, "相似搜索"
    ),
    (
        QueryIntent.RISK_ANALYSIS, [
            r"风险|risk|危险|严重.*?(?:程度|等级)",
            r"最.*?(?:严重|危险|高风险)",
        ],
        "SELECT * FROM {table} WHERE {filters} ORDER BY risk_score DESC LIMIT {limit}",
        False, False, False, False, "风险分析"
    ),
    (
        QueryIntent.SUMMARY, [
            r"概况|总览|概览|summary|dashboard|仪表",
            r"整体.*?(?:情况|状态)",
            r"汇总",
        ],
        "SELECT COUNT(*), COUNT(DISTINCT {group_field}) FROM {table} WHERE {filters}",
        True, False, False, False, "总览摘要"
    ),
    (
        QueryIntent.ROOT_CAUSE, [
            r"为什么|原因|根因|why|root cause",
            r"什么.*?(?:导致|引起|造成)",
        ],
        "-- Requires multi-step analysis",
        False, False, False, True, "根因分析"
    ),
    (
        QueryIntent.STATUS_CHECK, [
            r"状态|进度|怎么样了|什么状态|进展",
            r"还没.*?(?:解决|关闭|修复)",
            r"是否.*?(?:解决|关闭|修复)",
        ],
        "SELECT {id_field}, status_phase, severity, name FROM {table} WHERE {filters}",
        False, False, False, False, "状态查询"
    ),
]


class IntentDetector:
    """
    Detects primary and secondary intents from user questions.
    """

    def __init__(self):
        self._compiled_rules = []
        for intent, patterns, sql_hint, agg, group, ts, join, desc in INTENT_RULES:
            compiled = [(intent, re.compile(p, re.IGNORECASE), sql_hint, agg, group, ts, join, desc)
                       for p in patterns]
            self._compiled_rules.extend(compiled)

    def detect(self, question: str, extraction: Optional[ExtractionResult] = None) -> IntentResult:
        """
        Detect intent from question.

        Args:
            question: User's question
            extraction: Pre-extracted entities (optional, helps disambiguate)

        Returns:
            IntentResult with primary intent and metadata
        """
        scores = {}  # intent -> (score, sql_hint, flags)

        for intent, pattern, sql_hint, agg, group, ts, join, desc in self._compiled_rules:
            match = pattern.search(question)
            if match:
                current = scores.get(intent, (0, sql_hint, agg, group, ts, join, desc))
                scores[intent] = (current[0] + 1, sql_hint, agg, group, ts, join, desc)

        # Also use extraction hints
        if extraction:
            agg_entity = extraction.get_first("aggregation")
            if agg_entity:
                agg_map = {
                    "count": QueryIntent.COUNT,
                    "trend": QueryIntent.TREND,
                    "ranking": QueryIntent.RANKING,
                    "distribution": QueryIntent.DISTRIBUTION,
                    "comparison": QueryIntent.COMPARISON,
                    "list": QueryIntent.DETAIL_LIST,
                    "average": QueryIntent.DISTRIBUTION,
                }
                mapped = agg_map.get(agg_entity.value)
                if mapped:
                    current = scores.get(mapped, (0, "", False, False, False, False, ""))
                    scores[mapped] = (current[0] + 2, current[1], current[2], current[3],
                                      current[4], current[5], current[6])

        if not scores:
            # Default to count
            return IntentResult(
                primary=QueryIntent.COUNT,
                secondary=[],
                confidence=0.5,
                sql_template="SELECT COUNT(*) FROM {table} WHERE {filters}",
                needs_aggregation=True,
                needs_grouping=False,
                needs_timeseries=False,
                needs_join=False,
                description="计数查询(默认)"
            )

        # Sort by score
        sorted_intents = sorted(scores.items(), key=lambda x: x[1][0], reverse=True)
        primary_intent = sorted_intents[0][0]
        primary_data = sorted_intents[0][1]

        secondary = [item[0] for item in sorted_intents[1:3]]

        # Confidence: normalize score
        max_score = primary_data[0]
        confidence = min(max_score / 3.0, 1.0)  # Cap at 1.0

        return IntentResult(
            primary=primary_intent,
            secondary=secondary,
            confidence=confidence,
            sql_template=primary_data[1],
            needs_aggregation=primary_data[2],
            needs_grouping=primary_data[3],
            needs_timeseries=primary_data[4],
            needs_join=primary_data[5],
            description=primary_data[6]
        )


# Singleton
_detector: Optional[IntentDetector] = None


def get_intent_detector() -> IntentDetector:
    global _detector
    if _detector is None:
        _detector = IntentDetector()
    return _detector
