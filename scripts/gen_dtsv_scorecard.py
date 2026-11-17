#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate the DTSV (Deep Task-Specific Verification) main-agent scorecard task bank.

Output:
  evals/scorecard/tasks/dtsv-scorecard-tasks-v1.json   (machine-readable)
  evals/scorecard/tasks/dtsv-scorecard-tasks-v1.md     (human-readable table)

Tasks are grounded in the real Data-Agent ontology (ontology/v1):
  - 31 metrics (defect.count, testing.pass_rate, kpi.defect_detection_ratio, ...)
  - 51 dimensions (quality.severity, product.release, vehicle.model_series, ...)
  - real tool names + intent labels observed in evals/scorecard/fixtures
All dimension scales align with evals/scorecard/metrics.mjs (six runtime metrics).
"""

import json
import os
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "evals", "scorecard", "tasks")
os.makedirs(OUT_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# 1. Dimension specification (shared, six axes)
# ---------------------------------------------------------------------------
DIMENSION_SPEC = {
    "accuracy": {
        "label_zh": "准确率",
        "definition": "最终答案与金标准(golden)在数值、单位、粒度、时间窗、过滤条件上的一致性；"
                      "对 SQL/语义类任务还包括语义计划可执行且结果正确。",
        "scale": "ratio 0.00–1.00（等价百分制 0–100）",
        "rubric": {
            "1.00": "完全正确：数值/单位/粒度/时间窗/过滤全部一致，且引用可校验",
            "0.85-0.99": "数值正确，仅次要表述差异（四舍五入、措辞）",
            "0.70-0.84": "主指标正确但维度/口径偏差（如少一个过滤条件）",
            "0.40-0.69": "检索到正确实体/方向，但计算或聚合错误",
            "0.10-0.39": "返回了数据但严重错误或部分幻觉",
            "0.00": "完全错误 / 无结果 / 编造",
        },
        "source": "对齐 metrics.mjs 的 citation_pass_rate 与 P2-1 结果集不变量校验",
    },
    "strategy": {
        "label_zh": "策略",
        "definition": "完成任务所需规划/推理复杂度，以及 agent 是否采用恰当的多步策略"
                      "（实体消歧、多跳、聚合、时序对比、假设澄清、工具编排）。",
        "scale": "ordinal 1–5（复杂度等级；评分=策略恰当度，同尺度）",
        "rubric": {
            "1": "单跳：一个语义指标直接查询（如『本月缺陷数』）",
            "2": "单实体多维/简单过滤（1–2 个维度过滤）",
            "3": "多跳/跨实体：需 join 或本体关系推理（缺陷→特性→故事）",
            "4": "时序/对比/假设澄清：同比环比、A/B、需向用户澄清歧义",
            "5": "复合规划：多子问题分解、聚合后再过滤、跨 release 趋势+根因推测",
        },
        "source": "对齐 GOAL §5 P3（plan_query 分解、关系推理）",
    },
    "evidence": {
        "label_zh": "证据",
        "definition": "答案是否携带可程序化校验的引用链（执行语义计划/SQL、行级来源、"
                      "ontology 版本、snapshot id）。",
        "scale": "ordinal 1–5（证据强度要求）",
        "rubric": {
            "1": "无需强证据（纯知识/路由类）",
            "2": "需给出数据来源系统/接口名",
            "3": "需给出执行的语义指标 id + 过滤维度",
            "4": "需行级来源（具体 defect_id/test_id/run_id）+ citation 校验 pass",
            "5": "完整证据包：语义计划+行级 id+ontologyVersion+snapshotId，citation=pass",
        },
        "source": "对齐 metrics.mjs citation_pass_rate 与 mainAgentEvidence.mjs",
    },
    "recovery": {
        "label_zh": "恢复",
        "definition": "遇到歧义、空结果、上游超时/限流、工具拒绝、schema 不匹配时的自愈能力。",
        "scale": "ordinal 1–5（恢复能力要求/预期）",
        "rubric": {
            "1": "无恢复需求（直路成功）",
            "2": "空结果/无数据给出兜底说明而非报错",
            "3": "歧义主动澄清(ask_clarification)或切换 fallback 工具",
            "4": "重试/退避/熔断后恢复（上游 5xx→fallback 模型/工具）",
            "5": "多步恢复+审计留痕（失败 100% 写 audit、停止原因明确、不泄漏内部错误）",
        },
        "source": "对齐 metrics.mjs recovery_success_rate_pct 与 GOAL P0-1/P0-3",
    },
    "latency": {
        "label_zh": "延迟",
        "definition": "端到端响应耗时（接收 query → 返回最终答案），含 LLM + 工具调用。",
        "scale": "秒（分位 p50/p95/max）",
        "rubric": "在 budget_seconds(p95 上限)内为达标；超出按比例扣分。"
                  "基准：L1≤4s, L2≤8s, L3≤15s。",
        "source": "对齐 metrics.mjs latency_ms(p50/p95/max)",
    },
    "cost": {
        "label_zh": "成本",
        "definition": "单次任务消耗 LLM token 与折算人民币（基于 BMW 内部端点 "
                      "deepseek-v4-flash / qwen3.5 / glm-5 计费估算）。",
        "scale": "token 数 / ¥（估算：¥2 / 1M 输出 token，含输入）",
        "rubric": "在 budget_tokens / budget_cny 内为达标；超出按比例扣分。"
                  "基准：L1≤3000 tok/¥0.006, L2≤6000/¥0.012, L3≤12000/¥0.024。",
        "source": "对齐 GOAL §6 可观测性（延迟与成本可度量）",
    },
}

# ---------------------------------------------------------------------------
# 2. Difficulty → default dimension targets
# ---------------------------------------------------------------------------
BASE = {
    "L1": {"acc": 0.97, "cx": 1, "ev": 3, "rc": 2, "lat": 4, "tok": 3000, "cny": 0.006},
    "L2": {"acc": 0.95, "cx": 3, "ev": 4, "rc": 3, "lat": 8, "tok": 6000, "cny": 0.012},
    "L3": {"acc": 0.90, "cx": 4, "ev": 5, "rc": 4, "lat": 15, "tok": 12000, "cny": 0.024},
}
TOK_PRICE = 0.000002  # ¥ per token (estimate)

# ---------------------------------------------------------------------------
# 3. Task bank — 80 tasks (10 domains x 8)
#    each: id, domain, difficulty, intent, query, tools, gold_hint,
#          verification, refs, override
# ---------------------------------------------------------------------------
T = []


def add(domain, diff, intent, query, tools, gold_hint, verification, refs,
        ov=None):
    T.append({
        "domain": domain, "difficulty": diff, "intent": intent,
        "query": query, "expected_tools": tools, "gold_hint": gold_hint,
        "verification": verification, "references": refs, "override": ov or {},
    })


# --- Domain 1: 缺陷度量查询 (metric_query) ---
add("缺陷度量查询", "L1", "metric_query",
    "本发布 R-22-02 中国区新建了多少个缺陷？",
    ["query_semantic_metrics"],
    "defect.created_count WHERE detected_in_release='R-22-02' AND china_scope='Y'",
    "返回值==golden count（±0 容差，整数）；evidence 含执行的指标 id",
    ["ontology/v1/metrics.json#defect.created_count", "ontology/v1/dimensions.json#quality.china_scope", "ontology/v1/dimensions.json#product.release"])
add("缺陷度量查询", "L1", "metric_query",
    "当前还有几个未关闭(open)缺陷？",
    ["query_semantic_metrics"],
    "defect.open_count WHERE status='Open'",
    "返回值==golden；断言 status 过滤生效",
    ["ontology/v1/metrics.json#defect.open_count", "ontology/v1/dimensions.json#quality.status"])
add("缺陷度量查询", "L2", "metric_query",
    "R-22-02 中严重(severe)缺陷有多少个？",
    ["query_semantic_metrics"],
    "defect.severe_count WHERE detected_in_release='R-22-02' AND severity 严重",
    "返回值==golden；断言 severity 维度过滤正确",
    ["ontology/v1/metrics.json#defect.severe_count", "ontology/v1/dimensions.json#quality.severity"])
add("缺陷度量查询", "L2", "metric_query",
    "Showstopper 缺陷数量是多少？",
    ["query_semantic_metrics"],
    "defect.showstopper_count WHERE detected_in_release='R-22-02'",
    "返回值==golden；Showstopper 为 severity 最高级",
    ["ontology/v1/metrics.json#defect.showstopper_count", "ontology/v1/dimensions.json#quality.severity"])
add("缺陷度量查询", "L2", "metric_query",
    "R-22-02 的缺陷解决率是多少？",
    ["query_semantic_metrics"],
    "defect.resolve_rate = resolved_count/created_count（比率，0–1）",
    "比值误差≤0.02；evidence 含分子分母来源",
    ["ontology/v1/metrics.json#defect.resolve_rate", "ontology/v1/metrics.json#defect.resolved_count"])
add("缺陷度量查询", "L3", "metric_query",
    "R-22-02 相较 R-22-01，严重缺陷数变化了多少？",
    ["query_semantic_metrics", "query_analytics"],
    "Δ = severe(R-22-02) − severe(R-22-01)，需两次 release 查询后相减",
    "差值符号与量级正确；evidence 含两次 release 的行级来源",
    ["ontology/v1/metrics.json#defect.severe_count", "ontology/v1/dimensions.json#product.release"],
    ov={"cx": 4, "ev": 5, "rc": 3})
add("缺陷度量查询", "L2", "metric_query",
    "按严重程度(severity)分布，各等级缺陷数是多少？",
    ["query_semantic_metrics"],
    "GROUP BY quality.severity 返回各等级计数",
    "各桶计数之和==总缺陷数；维度枚举完整",
    ["ontology/v1/dimensions.json#quality.severity", "ontology/v1/dimensions.json#quality.phase_enum"])
add("缺陷度量查询", "L3", "metric_query",
    "本月新建缺陷中，属于 solution_cluster='DiPS' 的比例是多少？",
    ["query_semantic_metrics", "resolve_business_terms"],
    "ratio = count(solution_cluster='DiPS') / created_count，本月窗",
    "比率误差≤0.03；solution_cluster 消歧正确",
    ["ontology/v1/metrics.json#defect.created_count", "ontology/v1/dimensions.json#quality.solution_cluster"],
    ov={"ev": 5})

# --- Domain 2: 缺陷根因/分布分析 (high_frequency / business_risk) ---
add("缺陷根因分析", "L2", "high_frequency",
    "哪些 defect_category 出现频率最高（Top 5）？",
    ["query_defect_high_frequency_analysis"],
    "按 defect_category 计数降序取前 5",
    "Top5 集合与 golden 一致（顺序允许并列）；evidence 含计数",
    ["ontology/v1/dimensions.json#quality.defect_category", "server/ontology/queryPlanner.mjs"])
add("缺陷根因分析", "L2", "metric_query",
    "重复缺陷率(repeat_rate)是多少？",
    ["query_semantic_metrics"],
    "defect.repeat_rate = repeat_count / total",
    "比率误差≤0.02",
    ["ontology/v1/metrics.json#defect.repeat_rate"])
add("缺陷根因分析", "L3", "business_risk_assessment",
    "长期未解决(long_runner)缺陷有哪些，按年龄排序前 10？",
    ["query_semantic_metrics", "query_analytics"],
    "defect.long_runner_count + defect.age_days 降序 Top10（defect_id 列表）",
    "返回 defect_id 列表与 age_days；行级来源可追溯",
    ["ontology/v1/metrics.json#defect.long_runner_count", "ontology/v1/metrics.json#defect.age_days"],
    ov={"ev": 5, "rc": 3})
add("缺陷根因分析", "L3", "business_risk_assessment",
    "识别 R-22-02 中高 risk_score 且未关闭的缺陷，给出根因聚类。",
    ["query_semantic_metrics", "query_analytics"],
    "WHERE risk_score 高 AND status='Open' GROUP BY solution_cluster",
    "聚类集合与 golden 一致；evidence 含 defect_id + solution_cluster",
    ["ontology/v1/entities.json#risk_score", "ontology/v1/dimensions.json#quality.solution_cluster"],
    ov={"ev": 5})
add("缺陷根因分析", "L2", "metric_query",
    "缺陷拒绝率(rejection_rate)与 CWA 拒收率(kpi.defect_rejection_rate)差异？",
    ["query_semantic_metrics"],
    "对比 defect.rejection_rate 与 kpi.defect_rejection_rate 两值",
    "两值各自误差≤0.02，差异表述正确",
    ["ontology/v1/metrics.json#defect.rejection_rate", "ontology/v1/metrics.json#kpi.defect_rejection_rate"])
add("缺陷根因分析", "L3", "business_risk_assessment",
    "哪些 PU 的缺陷密度(defect_density)最高？",
    ["query_semantic_metrics", "query_analytics"],
    "quality.defect_density GROUP BY product.pu 降序",
    "PU 排名与 golden 一致；密度计算口径正确",
    ["ontology/v1/metrics.json#quality.defect_density", "ontology/v1/dimensions.json#product.pu"],
    ov={"ev": 4})
add("缺陷根因分析", "L2", "metric_query",
    "Top Issue 缺陷数是多少？",
    ["query_semantic_metrics"],
    "defect.top_issue_count WHERE detected_in_release='R-22-02'",
    "返回值==golden",
    ["ontology/v1/metrics.json#defect.top_issue_count"])
add("缺陷根因分析", "L3", "business_risk_assessment",
    "对比 R-22-01 与 R-22-02 的缺陷类别分布漂移。",
    ["query_defect_high_frequency_analysis", "query_analytics"],
    "两 release 的 defect_category 分布，计算 KL/Δ",
    "分布集合一致；漂移方向与量级正确",
    ["ontology/v1/dimensions.json#quality.defect_category", "ontology/v1/dimensions.json#product.release"],
    ov={"cx": 4, "ev": 5})

# --- Domain 3: 测试覆盖率 (coverage_query) ---
add("测试覆盖率", "L1", "coverage_query",
    "R-22-02 整体需求覆盖率(requirement_coverage_rate)是多少？",
    ["query_testing_coverage_project_status"],
    "testing.requirement_coverage_rate WHERE release='R-22-02'",
    "比率误差≤0.02",
    ["ontology/v1/metrics.json#testing.requirement_coverage_rate"])
add("测试覆盖率", "L2", "coverage_query",
    "AIDA 功能覆盖率(kpi.function_coverage)是多少？",
    ["query_testing_coverage_aida_status"],
    "kpi.function_coverage = covered_aida / total_aida",
    "比率误差≤0.02；evidence 含 aida 维度",
    ["ontology/v1/metrics.json#kpi.function_coverage", "ontology/v1/dimensions.json#requirements.aida"])
add("测试覆盖率", "L2", "coverage_query",
    "回归测试覆盖率(kpi.regression_coverage)是多少？",
    ["query_testing_coverage_project_status"],
    "kpi.regression_coverage",
    "比率误差≤0.02",
    ["ontology/v1/metrics.json#kpi.regression_coverage"])
add("测试覆盖率", "L2", "coverage_query",
    "配置覆盖率（车型, kpi.config_coverage_models）是多少？",
    ["query_testing_coverage_project_status"],
    "kpi.config_coverage_models",
    "比率误差≤0.02",
    ["ontology/v1/metrics.json#kpi.config_coverage_models", "ontology/v1/dimensions.json#vehicle.model_series"])
add("测试覆盖率", "L3", "coverage_query",
    "哪些 AIDA 需求尚未被任何测试用例覆盖（覆盖缺口）？",
    ["query_traceability", "query_testing_coverage_aida_status"],
    "AIDA 需求 − 已关联 testcase 的 AIDA，返回缺口列表",
    "缺口集合与 golden 一致；多跳可追溯",
    ["ontology/v1/dimensions.json#requirements.aida", "ontology/v1/metrics.json#testing.traceability_rate"],
    ov={"cx": 3, "ev": 5})
add("测试覆盖率", "L2", "coverage_query",
    "按车型系列(model_series)维度，各车型的覆盖率差异？",
    ["query_testing_coverage_project_status"],
    "GROUP BY vehicle.model_series 返回覆盖率",
    "各车型覆盖率误差≤0.03",
    ["ontology/v1/dimensions.json#vehicle.model_series"])
add("测试覆盖率", "L3", "coverage_query",
    "SET_23-03 下各功能组(function_group)的覆盖率如何？",
    ["query_testing_coverage_project_status", "query_analytics"],
    "WHERE project='SET_23-03' GROUP BY quality.function_group",
    "功能组集合正确；覆盖率误差≤0.03",
    ["ontology/v1/dimensions.json#quality.function_group", "ontology/v1/dimensions.json#product.project"],
    ov={"cx": 3})
add("测试覆盖率", "L1", "coverage_query",
    "当前项目共有多少个测试用例？",
    ["query_testing_coverage_project_status"],
    "testing.testcase_count WHERE release='R-22-02'",
    "返回值==golden 整数",
    ["ontology/v1/metrics.json#testing.testcase_count"])

# --- Domain 4: 测试执行与通过率 (metric_query / coverage_query) ---
add("测试执行与通过率", "L1", "metric_query",
    "本月测试通过率(pass_rate)是多少？",
    ["query_semantic_metrics"],
    "testing.pass_rate = passed_run_count / run_count",
    "比率误差≤0.02",
    ["ontology/v1/metrics.json#testing.pass_rate"])
add("测试执行与通过率", "L2", "metric_query",
    "R-22-02 失败测试执行数(failed_run_count)是多少？",
    ["query_semantic_metrics"],
    "testing.failed_run_count WHERE release='R-22-02'",
    "返回值==golden",
    ["ontology/v1/metrics.json#testing.failed_run_count"])
add("测试执行与通过率", "L2", "metric_query",
    "按测试域(testing.domain)的通过率对比？",
    ["query_semantic_metrics"],
    "GROUP BY testing.domain 返回 pass_rate",
    "各域通过率误差≤0.03",
    ["ontology/v1/dimensions.json#testing.domain", "ontology/v1/metrics.json#testing.pass_rate"])
add("测试执行与通过率", "L3", "metric_query",
    "某车型系列下失败率最高的测试项 Top 10？",
    ["query_semantic_metrics", "query_analytics"],
    "WHERE vehicle.model_series=X GROUP BY testcase ORDER BY fail_rate DESC Top10",
    "Top10 集合与 golden 一致；行级 test_id 可追溯",
    ["ontology/v1/dimensions.json#vehicle.model_series", "ontology/v1/metrics.json#testing.fail_rate"],
    ov={"ev": 5})
add("测试执行与通过率", "L2", "metric_query",
    "测试执行总数与通过/失败/阻塞分布？",
    ["query_semantic_metrics"],
    "testing.run_count + run_status 分布(Passed/Failed/Blocked)",
    "分布之和==run_count",
    ["ontology/v1/metrics.json#testing.run_count", "ontology/v1/dimensions.json#testing.run_status"])
add("测试执行与通过率", "L3", "metric_query",
    "按测试周(time.test_week)的通过率趋势？",
    ["query_semantic_metrics", "query_analytics"],
    "GROUP BY time.test_week 返回 pass_rate 序列",
    "序列长度与周数一致；趋势方向正确",
    ["ontology/v1/dimensions.json#time.test_week", "ontology/v1/metrics.json#testing.pass_rate"],
    ov={"cx": 4})
add("测试执行与通过率", "L2", "metric_query",
    "可追溯率(traceability_rate)是多少？",
    ["query_semantic_metrics"],
    "testing.traceability_rate",
    "比率误差≤0.02",
    ["ontology/v1/metrics.json#testing.traceability_rate"])
add("测试执行与通过率", "L3", "metric_query",
    "对比 DV 与 PV 阶段的测试通过率差异？",
    ["query_semantic_metrics", "query_analytics"],
    "pass_rate WHERE testing.test_phase='DV' vs 'PV'",
    "两阶段值误差≤0.02，差异表述正确",
    ["ontology/v1/dimensions.json#testing.test_phase", "ontology/v1/metrics.json#testing.pass_rate"],
    ov={"cx": 4})

# --- Domain 5: 供应商与团队质量 (business_risk_assessment) ---
add("供应商与团队质量", "L2", "business_risk_assessment",
    "各执行团队(org.team)的缺陷发现效率如何排名？",
    ["query_semantic_metrics", "query_analytics"],
    "team.discovery_efficiency GROUP BY org.team 降序",
    "排名与 golden 一致；口径正确",
    ["ontology/v1/metrics.json#team.discovery_efficiency", "ontology/v1/dimensions.json#org.team"])
add("供应商与团队质量", "L2", "business_risk_assessment",
    "问题发现团队(problem_finder_team)发现缺陷 Top 排名？",
    ["query_semantic_metrics"],
    "team.defect_discovery_count GROUP BY org.problem_finder_team",
    "排名与 golden 一致",
    ["ontology/v1/metrics.json#team.defect_discovery_count", "ontology/v1/dimensions.json#org.problem_finder_team"])
add("供应商与团队质量", "L3", "business_risk_assessment",
    "供应商相关 PU 的缺陷检测率(DDP, kpi.defect_detection_ratio)是否达标(≥0.85)？",
    ["query_semantic_metrics", "query_analytics"],
    "kpi.defect_detection_ratio GROUP BY product.pu，与阈值 0.85 比较",
    "每 PU 达标判定正确；evidence 含阈值比较依据",
    ["ontology/v1/metrics.json#kpi.defect_detection_ratio", "ontology/v1/dimensions.json#product.pu"],
    ov={"ev": 5})
add("供应商与团队质量", "L3", "business_risk_assessment",
    "哪个 team 的 open 缺陷最多且年龄最长（综合风险最高）？",
    ["query_semantic_metrics", "query_analytics"],
    "聚合 team.execution_count/open 缺陷数/age_days 求风险最高团队",
    "选中团队与 golden 一致；多指标聚合正确",
    ["ontology/v1/dimensions.json#org.team", "ontology/v1/metrics.json#defect.age_days"],
    ov={"cx": 4, "ev": 5})
add("供应商与团队质量", "L2", "business_risk_assessment",
    "团队测试执行数(team.execution_count)排名？",
    ["query_semantic_metrics"],
    "team.execution_count GROUP BY org.team 降序",
    "排名与 golden 一致",
    ["ontology/v1/metrics.json#team.execution_count"])
add("供应商与团队质量", "L3", "business_risk_assessment",
    "跨团队的缺陷泄漏（在后期 phase 才被发现）分析？",
    ["query_semantic_metrics", "query_analytics"],
    "缺陷按 detected phase 分布，识别'早期发现应捕获却后期才发现'的泄漏",
    "泄漏判定与 golden 一致；phase 维度正确",
    ["ontology/v1/dimensions.json#quality.phase", "ontology/v1/dimensions.json#quality.phase_enum"],
    ov={"cx": 4})
add("供应商与团队质量", "L2", "business_risk_assessment",
    "China Scope=Y 的缺陷占比是多少？",
    ["query_semantic_metrics"],
    "ratio = count(china_scope='Y') / total",
    "比率误差≤0.02",
    ["ontology/v1/dimensions.json#quality.china_scope"])
add("供应商与团队质量", "L3", "business_risk_assessment",
    "ECU/模块(product.ecu)维度的缺陷密度排名？",
    ["query_semantic_metrics", "query_analytics"],
    "quality.defect_density GROUP BY product.ecu 降序",
    "ECU 排名与 golden 一致",
    ["ontology/v1/metrics.json#quality.defect_density", "ontology/v1/dimensions.json#product.ecu"],
    ov={"ev": 4})

# --- Domain 6: 时间序列与趋势 (metric_query temporal) ---
add("时间序列与趋势", "L2", "metric_query",
    "最近 8 周新建缺陷数趋势？",
    ["query_semantic_metrics", "query_analytics"],
    "defect.created_count GROUP BY week(creation_date) 最近 8 周",
    "序列长度==8；每周值误差≤2",
    ["ontology/v1/metrics.json#defect.created_count", "ontology/v1/dimensions.json#time.defect_creation_date"])
add("时间序列与趋势", "L3", "metric_query",
    "缺陷解决时长(defect.age_days)的月度中位数趋势？",
    ["query_semantic_metrics", "query_analytics"],
    "median(age_days) GROUP BY month(resolution_date)",
    "中位数序列正确；时序方向合理",
    ["ontology/v1/metrics.json#defect.age_days", "ontology/v1/dimensions.json#time.defect_resolution_date"],
    ov={"cx": 4})
add("时间序列与趋势", "L2", "metric_query",
    "本月 vs 上月缺陷解决率(resolve_rate)环比？",
    ["query_semantic_metrics"],
    "Δ = resolve_rate(本月) − resolve_rate(上月)",
    "差值符号与量级正确",
    ["ontology/v1/metrics.json#defect.resolve_rate", "ontology/v1/dimensions.json#time.defect_resolution_date"])
add("时间序列与趋势", "L3", "metric_query",
    "缺陷创建到解决时长按 severity 分布的对比？",
    ["query_semantic_metrics", "query_analytics"],
    "age_days 分组统计 by quality.severity（均值/中位数）",
    "各 severity 统计与 golden 一致",
    ["ontology/v1/metrics.json#defect.age_days", "ontology/v1/dimensions.json#quality.severity"],
    ov={"cx": 4})
add("时间序列与趋势", "L2", "metric_query",
    "今年各月测试通过率趋势？",
    ["query_semantic_metrics"],
    "testing.pass_rate GROUP BY month(test_finished_date)",
    "序列与月份数一致；趋势方向正确",
    ["ontology/v1/metrics.json#testing.pass_rate", "ontology/v1/dimensions.json#time.test_finished_date"])
add("时间序列与趋势", "L3", "metric_query",
    "识别缺陷数异常的周（超过均值+2σ）？",
    ["query_semantic_metrics", "query_analytics"],
    "weekly count 序列，标注 count > mean+2σ 的周",
    "异常周集合与 golden 一致",
    ["ontology/v1/metrics.json#defect.created_count", "ontology/v1/dimensions.json#time.test_week"],
    ov={"cx": 4, "ev": 4})
add("时间序列与趋势", "L2", "metric_query",
    "Release 维度的缺陷数演进？",
    ["query_semantic_metrics"],
    "defect.count GROUP BY product.release 降序",
    "各 release 计数与 golden 一致",
    ["ontology/v1/metrics.json#defect.count", "ontology/v1/dimensions.json#product.release"])
add("时间序列与趋势", "L3", "metric_query",
    "基于近 6 月趋势外推，预测下月严重缺陷数（标注不确定性）？",
    ["query_semantic_metrics", "query_analytics"],
    "对 severe_count 月度序列做线性外推，返回预测值+置信区间",
    "预测在区间内；必须显式声明不确定性（不编造精确值）",
    ["ontology/v1/metrics.json#defect.severe_count", "ontology/v1/dimensions.json#time.defect_creation_date"],
    ov={"cx": 5, "ev": 5, "acc": 0.80})

# --- Domain 7: 可追溯性与配置覆盖 (record_query / traceability) ---
add("可追溯性", "L1", "testcase_context",
    "测试项 532211 的上下文是什么？",
    ["get_test_case_context"],
    "返回 test_name/subtype/run 状态/关联 feature/story",
    "test_id=532211 的上下文字段完整准确",
    ["testcase/dtsv_testcases_R-22-02.json#532211", "server/ontology/queryPlanner.mjs"])
add("可追溯性", "L2", "record_query",
    "缺陷 920669 关联到哪些特性(feature)与故事(story)？",
    ["query_traceability", "query_semantic_records"],
    "defect 920669 → feature_links(896016) + story_links(892994)",
    "关联 id 集合与 golden 一致；多跳正确",
    ["testcase/dtsv_testcases_R-22-02.json#920669", "ontology/v1/relationships.json"])
add("可追溯性", "L2", "record_query",
    "AIDA 需求 aida_id 的需求追溯状态(trace_status)？",
    ["query_traceability", "query_semantic_records"],
    "testing.trace_status WHERE aida=aida_id",
    "状态值与 golden 一致",
    ["ontology/v1/dimensions.json#testing.trace_status", "ontology/v1/dimensions.json#requirements.aida"])
add("可追溯性", "L3", "record_query",
    "从 story 892994 反向追溯其下所有缺陷？",
    ["query_traceability", "query_semantic_records"],
    "story 892994 → feature → testcase → defect 反向链路",
    "反向缺陷集合与 golden 一致",
    ["ontology/v1/relationships.json", "ontology/v1/dimensions.json#requirements.aida"],
    ov={"cx": 3, "ev": 5})
add("可追溯性", "L2", "record_query",
    "测试项 532211 的 run 状态分布？",
    ["query_semantic_records", "get_test_case_context"],
    "run_status_distribution(Passed/Failed/Blocked) for test_id 532211",
    "分布与 golden 一致",
    ["testcase/dtsv_testcases_R-22-02.json#532211"])
add("可追溯性", "L3", "coverage_query",
    "配置覆盖率（硬件变体, kpi.config_coverage_variants）缺口分析？",
    ["query_testing_coverage_project_status", "query_analytics"],
    "kpi.config_coverage_variants 缺口 = 1 − 覆盖率，列出未覆盖变体",
    "缺口集合与 golden 一致",
    ["ontology/v1/metrics.json#kpi.config_coverage_variants", "ontology/v1/dimensions.json#product.i_step"],
    ov={"cx": 3})
add("可追溯性", "L2", "record_query",
    "成熟度等级(maturity_grade, RG)分布？",
    ["query_semantic_records"],
    "GROUP BY quality.maturity_grade 计数",
    "各 RG 等级计数与 golden 一致",
    ["ontology/v1/dimensions.json#quality.maturity_grade"])
add("可追溯性", "L3", "record_query",
    "Q-Gate 类型(qgate_type)各阶段的通过情况？",
    ["query_semantic_records", "query_analytics"],
    "GROUP BY quality.qgate_type 统计通过/未通过",
    "Q-Gate 集合与判定正确",
    ["ontology/v1/dimensions.json#quality.qgate_type"],
    ov={"cx": 3})

# --- Domain 8: 多跳关系推理 (testcase_context / traceability) ---
add("多跳关系推理", "L3", "testcase_context",
    "IDC23 自动服务呼叫相关测试项失败，根因缺陷属于哪个 PU/ECU？",
    ["query_traceability", "query_semantic_metrics", "query_analytics"],
    "test('IDC23 Automatic Service Call') → failed run → defect 920669 → product.pu / product.ecu",
    "PU/ECU 归因与 golden 一致；3 跳链路正确",
    ["testcase/dtsv_testcases_R-22-02.json", "ontology/v1/relationships.json"],
    ov={"cx": 4, "ev": 5})
add("多跳关系推理", "L3", "testcase_context",
    "HU-MGU 故事下所有测试项的失败率？",
    ["query_traceability", "query_semantic_metrics"],
    "story('HU-MGU') → feature → testcases → runs 计算 fail_rate",
    "失败率与 golden 一致；多跳聚合正确",
    ["ontology/v1/relationships.json", "ontology/v1/metrics.json#testing.fail_rate"],
    ov={"cx": 4, "ev": 5})
add("多跳关系推理", "L3", "record_query",
    "feature 896016 下缺陷的严重程度分布与解决状态？",
    ["query_traceability", "query_semantic_metrics"],
    "feature 896016 → defects GROUP BY severity × status",
    "分布与 golden 一致",
    ["ontology/v1/relationships.json", "ontology/v1/dimensions.json#quality.severity"],
    ov={"cx": 4, "ev": 5})
add("多跳关系推理", "L3", "record_query",
    "找出既影响 DV 又影响 PV 阶段的同一缺陷（父子关系）？",
    ["query_traceability", "query_semantic_records"],
    "WHERE parent_child_type 关联 AND phase 跨 DV/PV",
    "父子缺陷集合与 golden 一致",
    ["ontology/v1/dimensions.json#quality.parent_child_type", "ontology/v1/dimensions.json#quality.phase"],
    ov={"cx": 4, "ev": 5})
add("多跳关系推理", "L2", "record_query",
    "缺陷类别为 DiPS 的缺陷集中在哪些车型？",
    ["query_semantic_metrics", "query_analytics"],
    "WHERE defect_category='DiPS' GROUP BY vehicle.model_series",
    "车型集合与 golden 一致",
    ["ontology/v1/dimensions.json#quality.defect_category", "ontology/v1/dimensions.json#vehicle.model_series"])
add("多跳关系推理", "L3", "record_query",
    "跨 release 同一 solution_cluster 的复发缺陷？",
    ["query_traceability", "query_semantic_records"],
    "同 solution_cluster 且 detected_in_release 跨多 release 的缺陷",
    "复发集合与 golden 一致",
    ["ontology/v1/dimensions.json#quality.solution_cluster", "ontology/v1/dimensions.json#product.release"],
    ov={"cx": 4, "ev": 5})
add("多跳关系推理", "L3", "record_query",
    "从 ECU 反查相关测试用例与需求覆盖？",
    ["query_traceability", "query_testing_coverage_aida_status"],
    "product.ecu → testcase → aida 覆盖状态",
    "反查集合与 golden 一致",
    ["ontology/v1/dimensions.json#product.ecu", "ontology/v1/dimensions.json#requirements.aida"],
    ov={"cx": 4, "ev": 5})
add("多跳关系推理", "L2", "duplicate_search",
    "检测与缺陷 920669 重复的缺陷（search_duplicates）？",
    ["search_duplicates"],
    "返回与 920669 语义/字段重复 candidate 列表",
    "重复候选集合与 golden 一致",
    ["ontology/v1/entities.json#defect_id", "server/ontology/queryPlanner.mjs"])

# --- Domain 9: 异常检测与告警/恢复 (dashboard_fallback / high_frequency) ---
add("异常检测与恢复", "L2", "dashboard_fallback",
    "当 dashboard 底层数据为空时，agent 应如何兜底？",
    ["diagnose_analytics_empty", "query_full_picture_module"],
    "返回『数据为空』说明 + 全貌模块，而非报错/幻觉",
    "outcome=completed 且 evidence 合理；无幻觉值",
    ["evals/scorecard/fixtures/sample-run-summaries.jsonl#run-eval-018", "server/mainAgentToolRecovery.mjs"],
    ov={"rc": 4, "ev": 3})
add("异常检测与恢复", "L3", "dashboard_fallback",
    "上游 analytics 不可用时，能否切换到 fallback 并完成查询？",
    ["query_analytics", "query_analytics_fallback"],
    "上游 5xx → fallback 工具恢复，返回结果 + recoveryOutcomes=['recovered']",
    "recovery_success=真；审计含 failureCode + stoppedReason",
    ["evals/scorecard/fixtures/sample-run-summaries.jsonl#run-eval-013", "server/companyChat.mjs"],
    ov={"rc": 5, "ev": 4})
add("异常检测与恢复", "L3", "dashboard_fallback",
    "query 返回空结果时，agent 是否主动澄清或给出全貌？",
    ["diagnose_analytics_empty", "query_full_picture_module"],
    "空结果 → 澄清或全貌兜底，不得编造",
    "outcome 合理；无幻觉",
    ["server/mainAgentToolRecovery.mjs", "server/mainAgentToolLoop/Recovery.mjs"],
    ov={"rc": 3, "ev": 3})
add("异常检测与恢复", "L2", "high_frequency",
    "检测到严重缺陷突增时，应给出怎样的告警话术？",
    ["query_defect_high_frequency_analysis"],
    "返回突增说明 + 量级 + 建议（不泄漏内部错误）",
    "话术含真实量级；不暴露堆栈",
    ["ontology/v1/metrics.json#defect.severe_count", "server/answerValidator.mjs"])
add("异常检测与恢复", "L3", "metric_query",
    "歧义 query（『上个月的数据』跨 release 上下文）能否澄清？",
    ["ask_clarification", "resolve_business_terms"],
    "低置信度 → ask_clarification 反问明确时间窗，而非硬猜",
    "outcome=needs_clarification；未返回错误答案",
    ["evals/scorecard/fixtures/sample-run-summaries.jsonl#run-eval-011", "server/mainAgentIntentRouter.mjs"],
    ov={"rc": 3, "cx": 4, "ev": 2})
add("异常检测与恢复", "L3", "metric_query",
    "actor scope 拒绝访问时，返回 denied 而非内部报错？",
    ["query_analytics"],
    "scope 不匹配 → outcome=denied, failureCode=ACTOR_CAPABILITY_SCOPE_DENIED",
    "返回 denied 且 failureCode 正确；不泄漏权限细节",
    ["evals/scorecard/fixtures/sample-run-summaries.jsonl#run-eval-014", "server/agentAuth.mjs"],
    ov={"rc": 5, "ev": 2, "acc": 0.98})
add("异常检测与恢复", "L2", "metric_query",
    "工具超时后是否重试并恢复结果？",
    ["query_analytics", "query_analytics_fallback"],
    "timeout → 指数退避重试 → 恢复",
    "recoveryOutcomes 含 recovered；延迟在预算内",
    ["server/companyChat.mjs", "server/mainAgentToolRecovery.mjs"],
    ov={"rc": 4})
add("异常检测与恢复", "L3", "dashboard_fallback",
    "多步工具编排中一步失败，能否回退并仍给出部分答案？",
    ["query_semantic_metrics", "query_analytics", "query_analytics_fallback"],
    "部分工具失败 → 返回已完成部分 + 说明缺失",
    "部分答案正确；明确标注缺失项",
    ["server/mainAgentToolOrchestrator.mjs", "server/mainAgentToolLoop/Planning.mjs"],
    ov={"rc": 5, "cx": 4, "ev": 4})

# --- Domain 10: 报告与可视化叙事 (metric_query / coverage_query + narrative) ---
add("报告与可视化叙事", "L2", "metric_query",
    "生成 R-22-02 质量周报的 KPI 摘要？",
    ["query_semantic_metrics", "query_testing_coverage_project_status"],
    "汇总 defect.count/resolve_rate/pass_rate/coverage 等核心 KPI",
    "KPI 集合与 golden 一致；数值误差≤0.02",
    ["ontology/v1/metrics.json", "server/analysisPlanner.mjs"])
add("报告与可视化叙事", "L3", "metric_query",
    "用图表展示各 severity 缺陷分布（kpi/line/bar）？",
    ["query_semantic_metrics", "analysisPlanner"],
    "返回 severity 分布 + 推荐图表类型(kpi/line/bar)",
    "图表类型推荐合理；数据正确",
    ["server/ontology/analysisPlanner.mjs", "ontology/v1/dimensions.json#quality.severity"],
    ov={"cx": 4, "ev": 4, "lat": 12})
add("报告与可视化叙事", "L3", "metric_query",
    "给出缺陷趋势的洞察叙述，并标注异常点？",
    ["query_semantic_metrics", "query_analytics"],
    "趋势描述 + 异常周标注 + 根因假设",
    "洞察与数据一致；异常点正确；假设明确标注",
    ["server/analysisPlanner.mjs", "ontology/v1/metrics.json#defect.created_count"],
    ov={"cx": 5, "ev": 5})
add("报告与可视化叙事", "L2", "business_risk_assessment",
    "对比两个团队的质量评分卡？",
    ["query_semantic_metrics", "query_analytics"],
    "两 team 的多 KPI 并排对比表",
    "两团队 KPI 各自误差≤0.02",
    ["ontology/v1/metrics.json#team.discovery_efficiency", "ontology/v1/dimensions.json#org.team"])
add("报告与可视化叙事", "L3", "coverage_query",
    "输出可分享的覆盖率差距报告（含证据链接）？",
    ["query_testing_coverage_aida_status", "query_traceability"],
    "覆盖率缺口 + 缺口 aida 列表 + 证据链接(defect_id/test_id)",
    "缺口集合与 golden 一致；证据齐全",
    ["ontology/v1/metrics.json#kpi.function_coverage", "server/mainAgentEvidence.mjs"],
    ov={"ev": 5})
add("报告与可视化叙事", "L2", "metric_query",
    "按市场(market)维度拆分缺陷？",
    ["query_semantic_metrics"],
    "defect.count GROUP BY quality.market",
    "各市场计数与 golden 一致",
    ["ontology/v1/dimensions.json#quality.market"])
add("报告与可视化叙事", "L3", "metric_query",
    "综合多 KPI 的健康度评分（0–100）？",
    ["query_semantic_metrics", "query_analytics", "analysisPlanner"],
    "加权多 KPI → 健康度分；需声明权重口径",
    "评分与口径一致；权重可解释",
    ["server/analysisPlanner.mjs", "ontology/v1/metrics.json"],
    ov={"cx": 5, "ev": 5})
add("报告与可视化叙事", "L1", "general",
    "闲聊/越界问题（如『今天天气如何』）应被正确路由，不触发数据查询？",
    ["ask_clarification"],
    "intent=general/out_of_scope，outcome=completed(模板化)，不调用数据工具",
    "误路由率<5%；未触发 query_* 工具",
    ["evals/scorecard/fixtures/sample-run-summaries.jsonl#run-eval-017", "server/mainAgentIntentRouter.mjs"],
    ov={"acc": 0.98, "cx": 1, "ev": 1, "rc": 1, "lat": 2, "tok": 1500, "cny": 0.003})


# --- 补充：8 个单跳 L1 锚点任务（平衡难度分布） ---
add("缺陷度量查询", "L1", "metric_query",
    "本月新建缺陷数是多少（不限 release）？",
    ["query_semantic_metrics"],
    "defect.created_count（本月时间窗）",
    "返回值==golden 整数",
    ["ontology/v1/metrics.json#defect.created_count", "ontology/v1/dimensions.json#time.defect_creation_date"])
add("缺陷度量查询", "L1", "metric_query",
    "当前缺陷总数(defect.count)是多少？",
    ["query_semantic_metrics"],
    "defect.count（全量）",
    "返回值==golden 整数",
    ["ontology/v1/metrics.json#defect.count"])
add("缺陷度量查询", "L1", "metric_query",
    "缺陷状态为 Blocked 的有多少个？",
    ["query_semantic_metrics"],
    "defect.count WHERE status='Blocked'",
    "返回值==golden；status 过滤生效",
    ["ontology/v1/metrics.json#defect.count", "ontology/v1/dimensions.json#quality.status"])
add("缺陷度量查询", "L1", "metric_query",
    "R-22-02 的缺陷拒绝数(rejected_count)是多少？",
    ["query_semantic_metrics"],
    "defect.rejected_count WHERE detected_in_release='R-22-02'",
    "返回值==golden 整数",
    ["ontology/v1/metrics.json#defect.rejected_count"])
add("测试执行与通过率", "L1", "metric_query",
    "R-22-02 的测试执行总数(run_count)是多少？",
    ["query_semantic_metrics"],
    "testing.run_count WHERE release='R-22-02'",
    "返回值==golden 整数",
    ["ontology/v1/metrics.json#testing.run_count"])
add("测试覆盖率", "L1", "coverage_query",
    "SET_23-03 的需求覆盖率是多少？",
    ["query_testing_coverage_project_status"],
    "testing.requirement_coverage_rate WHERE project='SET_23-03'",
    "比率误差≤0.02",
    ["ontology/v1/metrics.json#testing.requirement_coverage_rate", "ontology/v1/dimensions.json#product.project"])
add("可追溯性", "L1", "testcase_context",
    "测试项 690490 的测试结果是什么？",
    ["get_test_case_context"],
    "返回 test_id=690490 的 run 状态分布",
    "上下文与 golden 一致",
    ["testcase/dtsv_testcases_R-22-02.json#690490"])
add("供应商与团队质量", "L1", "business_risk_assessment",
    "本执行团队(org.team)本月的测试执行数？",
    ["query_semantic_metrics"],
    "team.execution_count WHERE org.team=当前团队",
    "返回值==golden",
    ["ontology/v1/metrics.json#team.execution_count", "ontology/v1/dimensions.json#org.team"])

# ---------------------------------------------------------------------------
# 4. Build dataset
# ---------------------------------------------------------------------------
def build_dimensions(diff, ov):
    b = dict(BASE[diff])
    b.update(ov)
    return {
        "accuracy": {
            "target": b["acc"], "scale": "ratio 0-1",
            "rubric_ref": "见 dimension_spec.accuracy",
        },
        "strategy": {
            "complexity": b["cx"], "scale": "ordinal 1-5",
            "rubric_ref": "见 dimension_spec.strategy",
        },
        "evidence": {
            "requirement": b["ev"], "scale": "ordinal 1-5",
            "rubric_ref": "见 dimension_spec.evidence",
        },
        "recovery": {
            "requirement": b["rc"], "scale": "ordinal 1-5",
            "rubric_ref": "见 dimension_spec.recovery",
        },
        "latency": {
            "budget_seconds": b["lat"], "scale": "seconds (p95 上限)",
            "rubric_ref": "见 dimension_spec.latency",
        },
        "cost": {
            "budget_tokens": b["tok"],
            "budget_cny": round(b["tok"] * TOK_PRICE, 4),
            "scale": "tokens / ¥",
            "rubric_ref": "见 dimension_spec.cost",
        },
    }


tasks = []
for i, t in enumerate(T, start=1):
    tid = f"DTSV-{i:03d}"
    tasks.append({
        "id": tid,
        "domain": t["domain"],
        "difficulty": t["difficulty"],
        "intent": t["intent"],
        "query": t["query"],
        "expected_tools": t["expected_tools"],
        "gold_hint": t["gold_hint"],
        "verification": t["verification"],
        "references": t["references"],
        "dimensions": build_dimensions(t["difficulty"], t["override"]),
    })

dataset = {
    "schemaVersion": "1.0",
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "title": "DTSV main-agent scorecard task bank (60-100 tasks)",
    "description": "面向 Data-Agent 的 Deep Task-Specific Verification 评分卡任务库，"
                  "覆盖缺陷度量/根因/覆盖/执行/团队/时序/追溯/多跳/恢复/报告十域，"
                  "每任务含六维目标值(accuracy/strategy/evidence/recovery/latency/cost)。",
    "grounding": {
        "ontology_metrics": "ontology/v1/metrics.json (31 metrics)",
        "ontology_dimensions": "ontology/v1/dimensions.json (51 dimensions)",
        "real_testcases": "testcase/dtsv_testcases_R-22-02.json (DTSV_China / R-22-02)",
        "runtime_metrics_alignment": "evals/scorecard/metrics.mjs (六运行指标)",
        "tool_names": ["resolve_business_terms", "query_analytics", "query_analytics_fallback",
                       "query_semantic_metrics", "query_testing_coverage_project_status",
                       "query_testing_coverage_aida_status", "query_defect_high_frequency_analysis",
                       "query_semantic_records", "query_traceability", "search_duplicates",
                       "get_test_case_context", "ask_clarification", "query_full_picture_module",
                       "diagnose_analytics_empty"],
    },
    "dimension_spec": DIMENSION_SPEC,
    "difficulty_defaults": BASE,
    "task_count": len(tasks),
    "tasks": tasks,
}

json_path = os.path.join(OUT_DIR, "dtsv-scorecard-tasks-v1.json")
with open(json_path, "w", encoding="utf-8") as f:
    json.dump(dataset, f, ensure_ascii=False, indent=2)

# ---------------------------------------------------------------------------
# 5. Markdown report (dimension spec + full table)
# ---------------------------------------------------------------------------
def diff_counts():
    c = {"L1": 0, "L2": 0, "L3": 0}
    for t in tasks:
        c[t["difficulty"]] += 1
    return c

dc = diff_counts()
dom_counts = {}
for t in tasks:
    dom_counts[t["domain"]] = dom_counts.get(t["domain"], 0) + 1

md = []
md.append("# DTSV 智能问数 Agent 评分卡任务库（v1）\n")
md.append(f"> 生成时间：{dataset['generated_at']}  ·  任务数：**{len(tasks)}**（满足 60–100 区间）\n")
md.append("> 落盘：`evals/scorecard/tasks/dtsv-scorecard-tasks-v1.json`（机器可读）\n")
md.append("> 数据来源：真实本体 `ontology/v1`（31 指标 / 51 维度）+ 真实测试用例 `testcase/dtsv_testcases_R-22-02.json`（DTSV_China / R-22-02）+ 运行指标 `evals/scorecard/metrics.mjs`\n")

md.append("\n## 一、六维评分标准（定义 / 取值范围 / 评分）\n")
md.append("| 维度 | 定义 | 取值范围 | 关键评分标准 |")
md.append("|------|------|----------|--------------|")
md.append("| **准确率 accuracy** | 答案与 golden 在值/单位/粒度/时间窗/过滤上一致；SQL/语义计划可执行 | ratio 0–1 | 1.00 全对；0.85–0.99 次要差异；0.70–0.84 口径偏差；0.40–0.69 计算错；0.10–0.39 严重错；0.00 幻觉 |")
md.append("| **策略 strategy** | 规划/推理复杂度与策略恰当度（消歧/多跳/聚合/时序/澄清/编排） | ordinal 1–5 | 1 单跳；2 单实体多过滤；3 跨实体多跳；4 时序/对比/澄清；5 复合分解规划 |")
md.append("| **证据 evidence** | 可程序化校验的引用链（语义计划/SQL、行级来源、ontology 版本、snapshot） | ordinal 1–5 | 1 无需；2 来源系统名；3 指标 id+维度；4 行级 id+citation pass；5 完整证据包+citation pass |")
md.append("| **恢复 recovery** | 歧义/空结果/超时/限流/拒绝/schema 不匹配的自愈 | ordinal 1–5 | 1 直路；2 空结果兜底；3 澄清/fallback；4 重试退避熔断；5 多步恢复+审计留痕 |")
md.append("| **延迟 latency** | 端到端响应耗时（含 LLM+工具） | 秒（p50/p95/max） | L1≤4s / L2≤8s / L3≤15s 为达标，超出按比例扣分 |")
md.append("| **成本 cost** | 单次 LLM token 与折算 ¥（BMW 内部端点估算） | token / ¥ | L1≤3000tok/¥0.006 / L2≤6000/¥0.012 / L3≤12000/¥0.024 为达标 |")
md.append("\n> 评分口径与 `evals/scorecard/metrics.mjs` 六运行指标对齐：evidence≈citation_pass_rate，recovery≈recovery_success_rate，latency≈latency_ms，accuracy/strategy/cost 为任务级预期目标。\n")

md.append("## 二、任务分布\n")
md.append(f"- 难度：L1={dc['L1']}，L2={dc['L2']}，L3={dc['L3']}")
md.append("- 领域：")
for d, n in dom_counts.items():
    md.append(f"  - {d}：{n}")

md.append("\n## 三、完整任务表（80 条）\n")
md.append("| # | ID | 领域 | 难度 | 意图 | 自然语言任务 | 期望工具 | 准确率目标 | 策略等级 | 证据要求 | 恢复要求 | 延迟预算(s) | 成本预算(¥) |")
md.append("|---|----|------|------|------|--------------|----------|-----------|----------|----------|----------|-------------|-------------|")
for t in tasks:
    d = t["dimensions"]
    tools = ", ".join(t["expected_tools"])
    q = t["query"].replace("|", "/")
    md.append(
        f"| {t['id'][-3:]} | {t['id']} | {t['domain']} | {t['difficulty']} | {t['intent']} | {q} | {tools} | "
        f"{d['accuracy']['target']} | {d['strategy']['complexity']} | {d['evidence']['requirement']} | "
        f"{d['recovery']['requirement']} | {d['latency']['budget_seconds']} | {d['cost']['budget_cny']} |"
    )

md.append("\n## 四、每个任务的 gold 提示与验证方法\n")
for t in tasks:
    d = t["dimensions"]
    md.append(f"### {t['id']} · {t['query']}")
    md.append(f"- **领域/难度/意图**：{t['domain']} / {t['difficulty']} / {t['intent']}")
    md.append(f"- **期望工具**：{', '.join(t['expected_tools'])}")
    md.append(f"- **gold 提示**：{t['gold_hint']}")
    md.append(f"- **验证方法**：{t['verification']}")
    md.append(f"- **六维目标**：acc={d['accuracy']['target']} | strategy={d['strategy']['complexity']} | "
              f"evidence={d['evidence']['requirement']} | recovery={d['recovery']['requirement']} | "
              f"latency≤{d['latency']['budget_seconds']}s | cost≤¥{d['cost']['budget_cny']}")
    md.append(f"- **引用来源**：{'; '.join(t['references'])}")
    md.append("")

md.append("\n## 五、使用方式\n")
md.append("1. 将本库与 `evals/main-agent/target/agent-golden.jsonl` 的路由用例结合，作为 P2 评测飞轮的 golden 任务集。")
md.append("2. 运行 agent 后，将结果回填到每个任务的 `dimensions` 实际得分，按六维聚合即可得评分卡（对齐 `scripts/runScorecard.mjs`）。")
md.append("3. `accuracy` 需 golden 值/不变量校验；`evidence`/`recovery` 取自首运行 `run-summaries.jsonl` 的 citationValidation / recoveryOutcomes；`latency`/`cost` 取自 latencyMs 与 token 计量。")
md.append("4. CI（`.github/workflows/eval.yml`）可在 PR 自动回归：新增功能若无对应 scorecard 任务则不过审。")

md_path = os.path.join(OUT_DIR, "dtsv-scorecard-tasks-v1.md")
with open(md_path, "w", encoding="utf-8") as f:
    f.write("\n".join(md))

print(f"Wrote {json_path}")
print(f"Wrote {md_path}")
print(f"task_count={len(tasks)}  difficulty={dc}  domains={len(dom_counts)}")
