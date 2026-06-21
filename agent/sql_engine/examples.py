"""Few-shot examples for NL→SQL generation

30+ business query examples covering:
- Count queries
- Trend analysis
- Distribution / breakdown
- Ranking
- Comparison
- Detail listing
- Status checks
- Multi-condition filtering
"""

from typing import List, Dict, Optional
from dataclasses import dataclass


@dataclass
class FewShotExample:
    """A few-shot NL→SQL example"""
    question: str
    sql: str
    intent: str
    explanation: str  # Why this SQL is correct


# Note: Using plain dict for simplicity
EXAMPLES: List[Dict] = [
    # === Count Queries (6) ===
    {
        "question": "IDCEVO 本月 Critical 缺陷有多少",
        "sql": "SELECT COUNT(*) FROM octane_defects WHERE project = 'IDCEVO' AND severity = 'Critical' AND creation_time >= date('now', 'start of month')",
        "intent": "count",
        "explanation": "按项目+严重度+时间范围过滤计数"
    },
    {
        "question": "活跃缺陷总数",
        "sql": "SELECT COUNT(*) FROM octane_defects WHERE status_phase IN ('New', 'Open', 'In Progress')",
        "intent": "count",
        "explanation": "活跃=status_phase IN (New, Open, In Progress)"
    },
    {
        "question": "中国项目有多少未关闭的缺陷",
        "sql": "SELECT COUNT(*) FROM octane_defects WHERE project IN ('IDCEVO', 'IDC', 'MGU') AND status_phase IN ('New', 'Open', 'In Progress')",
        "intent": "count",
        "explanation": "中国项目=IDCEVO+IDC+MGU, 未关闭=active状态"
    },
    {
        "question": "BCM 相关的 Critical 缺陷有几个",
        "sql": "SELECT COUNT(*) FROM octane_defects WHERE assigned_ecu = 'BCM' AND severity = 'Critical'",
        "intent": "count",
        "explanation": "按ECU和严重度过滤"
    },
    {
        "question": "本周新增了多少缺陷",
        "sql": "SELECT COUNT(*) FROM octane_defects WHERE creation_time >= date('now', 'weekday 0', 'start of week')",
        "intent": "count",
        "explanation": "本周=从本周一开始"
    },
    {
        "question": "Q-Gate阶段有多少Major以上缺陷",
        "sql": "SELECT COUNT(*) FROM octane_defects WHERE phase IN ('02', '07') AND severity IN ('Critical', 'Major')",
        "intent": "count",
        "explanation": "Q-Gate: phase 02,07; Major以上: Critical+Major"
    },

    # === Trend Analysis (4) ===
    {
        "question": "IDCEVO 近30天缺陷趋势",
        "sql": "SELECT date(creation_time) as date, COUNT(*) as count FROM octane_defects WHERE project = 'IDCEVO' AND creation_time >= date('now', '-30 days') GROUP BY date(creation_time) ORDER BY date",
        "intent": "trend",
        "explanation": "按创建时间的天数分组"
    },
    {
        "question": "每月新增缺陷变化",
        "sql": "SELECT strftime('%Y-%m', creation_time) as month, COUNT(*) as count FROM octane_defects GROUP BY strftime('%Y-%m', creation_time) ORDER BY month",
        "intent": "trend",
        "explanation": "按月分组，creation_time做时间维度"
    },
    {
        "question": "Critical缺陷最近3个月的走势",
        "sql": "SELECT strftime('%Y-%m', creation_time) as month, COUNT(*) as count FROM octane_defects WHERE severity = 'Critical' AND creation_time >= date('now', '-3 months') GROUP BY strftime('%Y-%m', creation_time) ORDER BY month",
        "intent": "trend",
        "explanation": "按月分组+严重度过滤"
    },
    {
        "question": "各项目每周缺陷数量变化",
        "sql": "SELECT strftime('%Y-W%W', creation_time) as week, project, COUNT(*) as count FROM octane_defects WHERE creation_time >= date('now', '-12 weeks') GROUP BY week, project ORDER BY week, project",
        "intent": "trend",
        "explanation": "双维度分组: 周+项目"
    },

    # === Distribution / Breakdown (5) ===
    {
        "question": "缺陷按项目分布",
        "sql": "SELECT project, COUNT(*) as count FROM octane_defects GROUP BY project ORDER BY count DESC",
        "intent": "distribution",
        "explanation": "按项目分组计数"
    },
    {
        "question": "缺陷按严重度占比",
        "sql": "SELECT severity, COUNT(*) as count, ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM octane_defects), 1) as percentage FROM octane_defects GROUP BY severity ORDER BY count DESC",
        "intent": "distribution",
        "explanation": "按严重度分组+百分比"
    },
    {
        "question": "各ECU的缺陷数量分别多少",
        "sql": "SELECT assigned_ecu, COUNT(*) as count FROM octane_defects WHERE assigned_ecu IS NOT NULL GROUP BY assigned_ecu ORDER BY count DESC",
        "intent": "distribution",
        "explanation": "按ECU分组, 排除NULL"
    },
    {
        "question": "缺陷按测试阶段分布",
        "sql": "SELECT phase, COUNT(*) as count FROM octane_defects GROUP BY phase ORDER BY count DESC",
        "intent": "distribution",
        "explanation": "按测试阶段分组"
    },
    {
        "question": "各团队的活跃缺陷分别有多少",
        "sql": "SELECT team, COUNT(*) as count FROM octane_defects WHERE status_phase IN ('New', 'Open', 'In Progress') GROUP BY team ORDER BY count DESC",
        "intent": "distribution",
        "explanation": "按团队分组+活跃状态过滤"
    },

    # === Ranking (4) ===
    {
        "question": "缺陷最多的TOP 10 ECU",
        "sql": "SELECT assigned_ecu, COUNT(*) as count FROM octane_defects WHERE assigned_ecu IS NOT NULL GROUP BY assigned_ecu ORDER BY count DESC LIMIT 10",
        "intent": "ranking",
        "explanation": "按ECU分组计数+倒序+LIMIT 10"
    },
    {
        "question": "IDCEVO 最严重的5个缺陷",
        "sql": "SELECT defect_id, name, severity, status_phase FROM octane_defects WHERE project = 'IDCEVO' AND severity = 'Critical' ORDER BY creation_time DESC LIMIT 5",
        "intent": "ranking",
        "explanation": "Critical=最严重, 按时间倒序"
    },
    {
        "question": "缺陷最多的3个团队",
        "sql": "SELECT team, COUNT(*) as count FROM octane_defects GROUP BY team ORDER BY count DESC LIMIT 3",
        "intent": "ranking",
        "explanation": "按团队分组+倒序+LIMIT 3"
    },
    {
        "question": "解决问题最快的团队排名",
        "sql": "SELECT team, AVG(julianday(last_modified) - julianday(creation_time)) as avg_days FROM octane_defects WHERE status_phase = 'Closed' GROUP BY team ORDER BY avg_days ASC LIMIT 10",
        "intent": "ranking",
        "explanation": "平均解决时间=last_modified-creation_time, 升序"
    },

    # === Comparison (3) ===
    {
        "question": "IDCEVO 和 IDC 的缺陷对比",
        "sql": "SELECT project, severity, COUNT(*) as count FROM octane_defects WHERE project IN ('IDCEVO', 'IDC') GROUP BY project, severity ORDER BY project, severity",
        "intent": "comparison",
        "explanation": "双维度分组: 项目+严重度"
    },
    {
        "question": "本月和上月缺陷数量对比",
        "sql": "SELECT strftime('%Y-%m', creation_time) as month, COUNT(*) as count FROM octane_defects WHERE creation_time >= date('now', '-2 months', 'start of month') GROUP BY strftime('%Y-%m', creation_time) ORDER BY month",
        "intent": "comparison",
        "explanation": "按月分组, 限定近2个月"
    },
    {
        "question": "中国项目和全球项目缺陷率比较",
        "sql": "SELECT CASE WHEN project IN ('IDCEVO', 'IDC', 'MGU') THEN 'China' ELSE 'Global' END as region, COUNT(*) as count FROM octane_defects GROUP BY CASE WHEN project IN ('IDCEVO', 'IDC', 'MGU') THEN 'China' ELSE 'Global' END",
        "intent": "comparison",
        "explanation": "用CASE WHEN做区域分组"
    },

    # === Detail Listing (3) ===
    {
        "question": "列出所有未关闭的Critical缺陷",
        "sql": "SELECT defect_id, name, project, severity, status_phase, assigned_ecu, creation_time FROM octane_defects WHERE severity = 'Critical' AND status_phase IN ('New', 'Open', 'In Progress') ORDER BY creation_time DESC",
        "intent": "detail_list",
        "explanation": "选择关键字段+严重度和状态过滤"
    },
    {
        "question": "BCM相关的所有活跃缺陷",
        "sql": "SELECT defect_id, name, severity, status_phase, team FROM octane_defects WHERE assigned_ecu = 'BCM' AND status_phase IN ('New', 'Open', 'In Progress') ORDER BY severity, creation_time DESC",
        "intent": "detail_list",
        "explanation": "ECU+状态过滤+严重度排序"
    },
    {
        "question": "本周新增缺陷明细",
        "sql": "SELECT defect_id, name, project, severity, assigned_ecu, creation_time FROM octane_defects WHERE creation_time >= date('now', 'weekday 0', 'start of week') ORDER BY creation_time DESC",
        "intent": "detail_list",
        "explanation": "本周=从周一开始, 按时间倒序"
    },

    # === Status Checks (2) ===
    {
        "question": "DEF-2026-0001 的当前状态",
        "sql": "SELECT defect_id, name, status_phase, severity, last_modified FROM octane_defects WHERE defect_id = 'DEF-2026-0001'",
        "intent": "status_check",
        "explanation": "按defect_id精确查询"
    },
    {
        "question": "哪些缺陷超过7天没有更新",
        "sql": "SELECT defect_id, name, status_phase, last_modified FROM octane_defects WHERE status_phase IN ('New', 'Open', 'In Progress') AND last_modified < date('now', '-7 days') ORDER BY last_modified",
        "intent": "status_check",
        "explanation": "活跃状态+超时未更新"
    },

    # === Complex Multi-Condition (3) ===
    {
        "question": "IDCEVO项目中BCM相关的Critical和Major缺陷，按状态分布",
        "sql": "SELECT status_phase, severity, COUNT(*) as count FROM octane_defects WHERE project = 'IDCEVO' AND assigned_ecu = 'BCM' AND severity IN ('Critical', 'Major') GROUP BY status_phase, severity ORDER BY status_phase, severity",
        "intent": "distribution",
        "explanation": "多条件过滤+双维度分组"
    },
    {
        "question": "导航相关的缺陷近3个月每月新增多少",
        "sql": "SELECT strftime('%Y-%m', creation_time) as month, COUNT(*) as count FROM octane_defects WHERE top_aida = 'cn_navigation' AND creation_time >= date('now', '-3 months') GROUP BY strftime('%Y-%m', creation_time) ORDER BY month",
        "intent": "trend",
        "explanation": "AIDA域=cn_navigation, 按月分组"
    },
    {
        "question": "各阶段Critical缺陷的团队分布",
        "sql": "SELECT phase, team, COUNT(*) as count FROM octane_defects WHERE severity = 'Critical' GROUP BY phase, team ORDER BY phase, count DESC",
        "intent": "distribution",
        "explanation": "双维度分组: 阶段×团队"
    },
]


def get_examples_by_intent(intent: str, top_k: int = 3) -> List[Dict]:
    """Get few-shot examples for a specific intent"""
    matching = [ex for ex in EXAMPLES if ex["intent"] == intent]
    return matching[:top_k]


def get_similar_examples(question: str, top_k: int = 5) -> List[Dict]:
    """
    Find similar examples using keyword overlap.
    Production would use BGE embedding similarity.
    """
    question_words = set(question.lower().split())
    scored = []

    for ex in EXAMPLES:
        ex_words = set(ex["question"].lower().split())
        overlap = len(question_words & ex_words)
        scored.append((overlap, ex))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [ex for _, ex in scored[:top_k]]


def get_all_examples() -> List[Dict]:
    """Get all few-shot examples"""
    return EXAMPLES


def get_example_count() -> int:
    return len(EXAMPLES)
