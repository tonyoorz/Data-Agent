"""insight_engine 的完整测试套件 — 30+ 测试覆盖所有检测器和流程。"""
from __future__ import annotations

import pytest

from backend.analytics.insight_engine import (
    AnomalyDetector,
    ComparisonDetector,
    ConcentrationDetector,
    Insight,
    InsightDetector,
    InsightReport,
    InsightSeverity,
    InsightType,
    RiskDetector,
    ThresholdDetector,
    TrendDetector,
    generate_follow_up,
    generate_summary,
)


# ──────────────────────────────────────────────
# 测试数据工厂
# ──────────────────────────────────────────────


def make_defect_rows(
    n: int = 10,
    ecu: str = "ECU_A",
    severity: str = "Normal",
    team: str = "Team_A",
    project: str = "Proj_A",
) -> list[dict]:
    return [
        {
            "ticket_id": f"D-{i+1}",
            "assigned_ecu": ecu,
            "problem_severity": severity,
            "problem_finder_team": team,
            "project": project,
            "status": "Open",
            "creation_time": f"2026-08-{i+1:02d}",
            "defect_count": 1,
        }
        for i in range(n)
    ]


def make_time_series_rows(values: list[float], metric: str = "defect_count") -> list[dict]:
    return [
        {"test_week": f"2026-W{i+1}", metric: v}
        for i, v in enumerate(values)
    ]


# ══════════════════════════════════════════════
# 1. AnomalyDetector 测试 (4 cases)
# ══════════════════════════════════════════════


class TestAnomalyDetector:
    def setup_method(self):
        self.detector = AnomalyDetector()

    def test_normal_data_no_insight(self):
        """正常数据不触发洞察。"""
        rows = []
        for team in ["A", "B", "C", "D"]:
            for i in range(5):
                rows.append({"problem_finder_team": team, "defect_count": 5})
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["problem_finder_team"])
        assert len(insights) == 0

    def test_obvious_anomaly_triggers_insight(self):
        """明显异常触发洞察。"""
        rows = []
        for team, count in [("A", 5), ("B", 4), ("C", 6), ("D", 5), ("E", 50)]:
            rows.append({"problem_finder_team": team, "defect_count": count})
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["problem_finder_team"])
        assert len(insights) >= 1
        assert insights[0].type is InsightType.ANOMALY
        assert "E" in insights[0].description

    def test_single_row_no_insight(self):
        """单行数据不触发。"""
        rows = [{"problem_finder_team": "A", "defect_count": 10}]
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["problem_finder_team"])
        assert len(insights) == 0

    def test_all_same_values_no_insight(self):
        """所有值相同不触发异常。"""
        rows = [{"problem_finder_team": chr(65 + i), "defect_count": 10} for i in range(6)]
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["problem_finder_team"])
        assert len(insights) == 0


# ══════════════════════════════════════════════
# 2. TrendDetector 测试 (4 cases)
# ══════════════════════════════════════════════


class TestTrendDetector:
    def setup_method(self):
        self.detector = TrendDetector(min_periods=3, change_threshold=10.0)

    def test_continuous_increase_triggers_insight(self):
        """连续上升触发洞察。"""
        rows = make_time_series_rows([10, 20, 30, 40, 50])
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["test_week"])
        assert len(insights) >= 1
        trend_insights = [i for i in insights if i.type is InsightType.TREND]
        assert any("连续" in i.description or "环比" in i.description for i in trend_insights)

    def test_continuous_decrease_triggers_insight(self):
        """连续下降触发洞察。"""
        rows = make_time_series_rows([50, 40, 30, 20, 10])
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["test_week"])
        trend_insights = [i for i in insights if i.type is InsightType.TREND]
        assert len(trend_insights) >= 1

    def test_no_time_dimension_no_insight(self):
        """无时间维度不触发。"""
        rows = [
            {"problem_finder_team": "A", "defect_count": 10},
            {"problem_finder_team": "B", "defect_count": 20},
        ]
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["problem_finder_team"])
        assert len(insights) == 0

    def test_flat_series_no_insight(self):
        """平稳序列不触发趋势。"""
        rows = make_time_series_rows([10, 10, 10, 10, 10])
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["test_week"])
        # 平稳无趋势
        trend_streak = [i for i in insights if "连续" in i.description]
        assert len(trend_streak) == 0


# ══════════════════════════════════════════════
# 3. ConcentrationDetector 测试 (4 cases)
# ══════════════════════════════════════════════


class TestConcentrationDetector:
    def setup_method(self):
        self.detector = ConcentrationDetector()

    def test_single_dominance_triggers_insight(self):
        """单一分组占比超过 50% 触发。"""
        rows = []
        for i in range(20):
            rows.append({"assigned_ecu": "ECU_HOT", "defect_count": 1})
        for i in range(5):
            rows.append({"assigned_ecu": "ECU_OTHER", "defect_count": 1})
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["assigned_ecu"])
        assert len(insights) >= 1
        conc = [i for i in insights if i.type is InsightType.CONCENTRATION]
        assert any("ECU_HOT" in i.description for i in conc)

    def test_pareto_effect_triggers(self):
        """帕累托效应检测。"""
        rows = []
        # 2 groups with most values, 8 groups with few
        for ecu in ["A", "B"]:
            for _ in range(40):
                rows.append({"assigned_ecu": ecu, "defect_count": 1})
        for ecu in ["C", "D", "E", "F", "G", "H", "I", "J"]:
            for _ in range(2):
                rows.append({"assigned_ecu": ecu, "defect_count": 1})
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["assigned_ecu"])
        pareto = [i for i in insights if "帕累托" in i.description]
        assert len(pareto) >= 1

    def test_uniform_distribution_no_insight(self):
        """均匀分布不触发。"""
        rows = []
        for ecu in ["A", "B", "C", "D"]:
            for _ in range(10):
                rows.append({"assigned_ecu": ecu, "defect_count": 1})
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["assigned_ecu"])
        assert len(insights) == 0

    def test_empty_data_no_insight(self):
        """空数据不触发。"""
        insights = self.detector.detect([], metric="defect_count", dimensions=["assigned_ecu"])
        assert len(insights) == 0


# ══════════════════════════════════════════════
# 4. ComparisonDetector 测试 (4 cases)
# ══════════════════════════════════════════════


class TestComparisonDetector:
    def setup_method(self):
        self.detector = ComparisonDetector()

    def test_context_comparison_triggers_insight(self):
        """context 中有 comparison 数据触发。"""
        rows = [
            {"team": "A", "defect_count": 100},
            {"team": "B", "defect_count": 50},
        ]
        context = {
            "comparison": {
                "group_a": "A",
                "group_b": "B",
                "metric_a": 100,
                "metric_b": 50,
            }
        }
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["team"], context=context)
        assert len(insights) >= 1
        assert insights[0].type is InsightType.COMPARISON

    def test_no_context_no_insight(self):
        """无 context 不触发。"""
        rows = [{"team": "A", "defect_count": 10}]
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["team"])
        assert len(insights) == 0

    def test_small_difference_no_insight(self):
        """差异很小不触发。"""
        context = {
            "comparison": {
                "group_a": "A",
                "group_b": "B",
                "metric_a": 100,
                "metric_b": 99,
            }
        }
        rows = [{"team": "A"}, {"team": "B"}]
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["team"], context=context)
        assert len(insights) == 0

    def test_comparison_from_rows(self):
        """从 rows 中按 dimension 拆分对比。"""
        rows = [
            {"team": "A", "defect_count": 100},
            {"team": "A", "defect_count": 50},
            {"team": "B", "defect_count": 10},
            {"team": "B", "defect_count": 5},
        ]
        context = {
            "comparison": {
                "group_a": "A",
                "group_b": "B",
                "dimension": "team",
            }
        }
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["team"], context=context)
        assert len(insights) >= 1


# ══════════════════════════════════════════════
# 5. RiskDetector 测试 (4 cases)
# ══════════════════════════════════════════════


class TestRiskDetector:
    def setup_method(self):
        self.detector = RiskDetector()

    def test_showstopper_concentration_triggers_critical(self):
        """Showstopper 缺陷聚集触发 CRITICAL。"""
        rows = []
        for i in range(5):
            rows.append({
                "ticket_id": f"D-S-{i}",
                "assigned_ecu": "ECU_X",
                "problem_severity": "Showstopper",
            })
        for i in range(3):
            rows.append({
                "ticket_id": f"D-S-{i+10}",
                "assigned_ecu": "ECU_Y",
                "problem_severity": "Showstopper",
            })
        insights = self.detector.detect(
            rows, metric="defect_count", dimensions=["assigned_ecu", "problem_severity"]
        )
        critical = [i for i in insights if i.severity is InsightSeverity.CRITICAL]
        assert len(critical) >= 1
        assert any("Showstopper" in i.description for i in critical)

    def test_top_issue_accumulation_triggers_warning(self):
        """Top Issue 大量聚集触发 WARNING。"""
        rows = [
            {"assigned_ecu": "ECU_A", "problem_severity": "Top Issue"}
            for _ in range(12)
        ]
        insights = self.detector.detect(
            rows, metric="defect_count", dimensions=["assigned_ecu", "problem_severity"]
        )
        warnings = [i for i in insights if "Top Issue" in i.description]
        assert len(warnings) >= 1

    def test_no_severity_field_no_insight(self):
        """无 severity 字段不触发。"""
        rows = [{"assigned_ecu": "ECU_A", "defect_count": 10}]
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["assigned_ecu"])
        assert len(insights) == 0

    def test_recurring_defects_triggers_warning(self):
        """同一 ECU 反复出现同类缺陷触发预警。"""
        rows = [
            {
                "assigned_ecu": "ECU_R",
                "solution_cluster": "Wake Issue",
                "defect_count": 1,
                "problem_severity": "Normal",
            }
            for _ in range(12)
        ]
        # 补充一些其他 ECU 的数据让 dimensions 被发现
        rows.extend([
            {"assigned_ecu": "ECU_O", "solution_cluster": "Other", "defect_count": 1, "problem_severity": "Normal"}
            for _ in range(3)
        ])
        insights = self.detector.detect(
            rows, metric="defect_count", dimensions=["assigned_ecu", "solution_cluster"]
        )
        recurring = [i for i in insights if "反复出现" in i.description]
        assert len(recurring) >= 1


# ══════════════════════════════════════════════
# 6. ThresholdDetector 测试 (4 cases)
# ══════════════════════════════════════════════


class TestThresholdDetector:
    def setup_method(self):
        self.detector = ThresholdDetector()

    def test_ddp_below_target_triggers(self):
        """DDP 低于目标触发。"""
        context = {
            "summary": {
                "metrics": {"ddp": 95.0},
            }
        }
        rows = [{"ddp": 95.0}]
        insights = self.detector.detect(rows, metric="ddp", dimensions=[], context=context)
        assert len(insights) >= 1
        assert insights[0].type is InsightType.THRESHOLD
        assert "低于" in insights[0].description

    def test_ddp_meets_target_no_insight(self):
        """DDP 达标不触发。"""
        context = {
            "summary": {"metrics": {"ddp": 99.5}}
        }
        rows = [{"ddp": 99.5}]
        insights = self.detector.detect(rows, metric="ddp", dimensions=[], context=context)
        assert len(insights) == 0

    def test_cwa_above_target_triggers(self):
        """CWA 高于目标触发。"""
        context = {
            "summary": {"metrics": {"cwa": 15.0}}
        }
        rows = [{"cwa": 15.0}]
        insights = self.detector.detect(rows, metric="cwa", dimensions=[], context=context)
        assert len(insights) >= 1

    def test_no_metrics_no_insight(self):
        """无 metric 数据不触发。"""
        rows = [{"team": "A"}]
        insights = self.detector.detect(rows, metric="defect_count", dimensions=["team"])
        assert len(insights) == 0


# ══════════════════════════════════════════════
# 7. Insight 排序测试
# ══════════════════════════════════════════════


class TestInsightSorting:
    def test_critical_before_warning_before_info(self):
        """CRITICAL > WARNING > INFO 排序。"""
        detector = InsightDetector()
        rows = []
        # 构造触发多种洞察的数据
        for i in range(20):
            rows.append({
                "ticket_id": f"D-{i}",
                "assigned_ecu": "ECU_HOT" if i < 15 else "ECU_OTHER",
                "problem_severity": "Showstopper" if i < 5 else "Normal",
                "problem_finder_team": "Team_A" if i < 18 else "Team_B",
                "defect_count": 10 if i < 18 else 100,
            })
        insights = detector.detect({"data": rows}, context={})
        if len(insights) >= 2:
            for j in range(len(insights) - 1):
                curr_sev = insights[j].severity.value
                next_sev = insights[j + 1].severity.value
                # severity 应该是非递增的
                assert (
                    {"critical": 3, "warning": 2, "info": 1}[curr_sev]
                    >= {"critical": 3, "warning": 2, "info": 1}[next_sev]
                )

    def test_same_severity_sorted_by_confidence(self):
        """同 severity 内按 confidence 降序。"""
        detector = InsightDetector()
        rows = []
        for team, count in [("A", 5), ("B", 4), ("C", 6), ("D", 5), ("E", 50), ("F", 1)]:
            rows.append({"problem_finder_team": team, "defect_count": count})
        insights = detector.detect({"data": rows}, context={})
        # 同 severity 的 insight，confidence 应该递减
        for j in range(len(insights) - 1):
            if insights[j].severity == insights[j + 1].severity:
                assert insights[j].confidence >= insights[j + 1].confidence


# ══════════════════════════════════════════════
# 8. InsightReport 测试
# ══════════════════════════════════════════════


class TestInsightReport:
    def test_report_generation(self):
        """报告生成测试。"""
        detector = InsightDetector()
        rows = make_defect_rows(20, ecu="ECU_A")
        for i in range(5):
            rows[i]["problem_severity"] = "Showstopper"
        report = detector.build_report({"data": rows}, context={"natural_question": "测试问题"})
        assert isinstance(report, InsightReport)
        assert report.query_context["natural_question"] == "测试问题"
        assert len(report.insights) >= 1
        assert isinstance(report.summary, str)
        assert len(report.summary) > 0
        assert len(report.suggested_actions) >= 1

    def test_report_to_dict(self):
        """报告序列化。"""
        detector = InsightDetector()
        rows = make_defect_rows(10)
        report = detector.build_report({"data": rows})
        d = report.to_dict()
        assert "insights" in d
        assert "summary" in d
        assert "suggested_actions" in d
        assert "query_context" in d
        assert isinstance(d["insights"], list)

    def test_has_critical(self):
        """has_critical 方法。"""
        report = InsightReport(
            query_context={},
            insights=[
                Insight(
                    id="1",
                    type=InsightType.RISK,
                    severity=InsightSeverity.CRITICAL,
                    title="test",
                    description="test",
                    dimension="d",
                    metric="m",
                    data={},
                    confidence=0.9,
                    recommendation="r",
                )
            ],
            summary="test",
            suggested_actions=["a"],
        )
        assert report.has_critical()
        assert report.has_warning() is False

    def test_has_warning(self):
        """has_warning 方法。"""
        report = InsightReport(
            query_context={},
            insights=[
                Insight(
                    id="1",
                    type=InsightType.ANOMALY,
                    severity=InsightSeverity.WARNING,
                    title="test",
                    description="test",
                    dimension="d",
                    metric="m",
                    data={},
                    confidence=0.9,
                    recommendation="r",
                )
            ],
            summary="test",
            suggested_actions=["a"],
        )
        assert report.has_warning()
        assert report.has_critical() is False

    def test_empty_report(self):
        """空结果报告。"""
        detector = InsightDetector()
        report = detector.build_report({"data": []})
        assert len(report.insights) == 0
        assert "未发现" in report.summary


# ══════════════════════════════════════════════
# 9. NL Generator 测试
# ══════════════════════════════════════════════


class TestNLGenerator:
    def test_empty_insights(self):
        """空洞察列表生成默认文本。"""
        summary = generate_summary([])
        assert "未发现" in summary

    def test_with_insights(self):
        """有洞察时生成总结。"""
        insights = [
            Insight(
                id="1",
                type=InsightType.ANOMALY,
                severity=InsightSeverity.WARNING,
                title="测试异常",
                description="⚠️ ECU_A 的缺陷数异常",
                dimension="ecu",
                metric="count",
                data={},
                confidence=0.9,
                recommendation="调查原因",
            )
        ]
        summary = generate_summary(insights, context={"natural_question": "哪些ECU缺陷最多？"})
        assert "1 条" in summary
        assert "ECU_A" in summary

    def test_critical_count_in_summary(self):
        """CRITICAL 数量在总结中显示。"""
        insights = [
            Insight(
                id="1",
                type=InsightType.RISK,
                severity=InsightSeverity.CRITICAL,
                title="严重风险",
                description="🚨 严重问题",
                dimension="d",
                metric="m",
                data={},
                confidence=0.95,
                recommendation="立即处理",
            )
        ]
        summary = generate_summary(insights)
        assert "1 条为严重级别" in summary


# ══════════════════════════════════════════════
# 10. Follow-up Query 测试
# ══════════════════════════════════════════════


class TestFollowUpQuery:
    def test_anomaly_follow_up(self):
        insight = Insight(
            id="1",
            type=InsightType.ANOMALY,
            severity=InsightSeverity.WARNING,
            title="t",
            description="d",
            dimension="d",
            metric="m",
            data={"group_key": "ECU_X"},
            confidence=0.9,
            recommendation="r",
        )
        result = generate_follow_up(insight)
        assert result is not None
        assert "ECU_X" in result

    def test_trend_follow_up(self):
        insight = Insight(
            id="1",
            type=InsightType.TREND,
            severity=InsightSeverity.INFO,
            title="t",
            description="d",
            dimension="test_week",
            metric="defect_count",
            data={},
            confidence=0.8,
            recommendation="r",
        )
        result = generate_follow_up(insight)
        assert result is not None
        assert "test_week" in result

    def test_concentration_follow_up(self):
        insight = Insight(
            id="1",
            type=InsightType.CONCENTRATION,
            severity=InsightSeverity.WARNING,
            title="t",
            description="d",
            dimension="d",
            metric="m",
            data={"top_key": "ECU_HOT"},
            confidence=0.9,
            recommendation="r",
        )
        result = generate_follow_up(insight)
        assert result is not None
        assert "ECU_HOT" in result

    def test_risk_follow_up(self):
        insight = Insight(
            id="1",
            type=InsightType.RISK,
            severity=InsightSeverity.CRITICAL,
            title="t",
            description="d",
            dimension="d",
            metric="m",
            data={"ecu_name": "ECU_Z"},
            confidence=0.95,
            recommendation="r",
        )
        result = generate_follow_up(insight)
        assert result is not None
        assert "ECU_Z" in result

    def test_threshold_follow_up(self):
        insight = Insight(
            id="1",
            type=InsightType.THRESHOLD,
            severity=InsightSeverity.WARNING,
            title="t",
            description="d",
            dimension="",
            metric="ddp",
            data={},
            confidence=0.9,
            recommendation="r",
        )
        result = generate_follow_up(insight)
        assert result is not None
        assert "ddp" in result


# ══════════════════════════════════════════════
# 11. 完整流程测试
# ══════════════════════════════════════════════


class TestEndToEnd:
    def test_full_pipeline_with_various_data(self):
        """完整流程: query_result → detect → InsightReport。"""
        detector = InsightDetector()
        rows = []
        # 添加异常数据
        for i in range(10):
            rows.append({
                "ticket_id": f"D-{i}",
                "assigned_ecu": "ECU_A",
                "problem_severity": "Showstopper" if i < 5 else "Normal",
                "problem_finder_team": "Team_A",
                "project": "Proj_X",
                "defect_count": 50,
            })
        for i in range(5):
            rows.append({
                "ticket_id": f"D-{i+20}",
                "assigned_ecu": "ECU_B",
                "problem_severity": "Normal",
                "problem_finder_team": "Team_B",
                "project": "Proj_Y",
                "defect_count": 5,
            })
        query_result = {"data": rows, "summary": {"rowCount": len(rows)}}
        context = {
            "natural_question": "哪个ECU的缺陷最多？",
            "metric_ids": ["defect_count"],
            "dimension_ids": ["assigned_ecu"],
        }
        report = detector.build_report(query_result, context=context)
        assert isinstance(report, InsightReport)
        assert report.query_context["natural_question"] == "哪个ECU的缺陷最多？"
        assert len(report.insights) >= 1
        assert len(report.summary) > 10

    def test_multiple_detectors_triggered(self):
        """多检测器同时触发。"""
        detector = InsightDetector()
        rows = []
        # 构造能同时触发异常+集中度+风险的数据
        for i in range(20):
            rows.append({
                "ticket_id": f"D-{i}",
                "assigned_ecu": "ECU_HOT",
                "problem_severity": "Showstopper",
                "problem_finder_team": "Team_A",
                "defect_count": 1,
            })
        for i in range(5):
            rows.append({
                "ticket_id": f"D-{i+30}",
                "assigned_ecu": f"ECU_{chr(66+i)}",
                "problem_severity": "Normal",
                "problem_finder_team": f"Team_{chr(66+i)}",
                "defect_count": 1,
            })
        insights = detector.detect({"data": rows})
        types_found = {i.type for i in insights}
        assert len(types_found) >= 2  # 至少 2 种类型的洞察

    def test_empty_data(self):
        """空数据不产生洞察。"""
        detector = InsightDetector()
        insights = detector.detect({"data": []})
        assert len(insights) == 0

    def test_insight_to_dict(self):
        """Insight 序列化。"""
        ins = Insight(
            id="test-1",
            type=InsightType.ANOMALY,
            severity=InsightSeverity.WARNING,
            title="Test",
            description="Test desc",
            dimension="dim",
            metric="met",
            data={"a": 1},
            confidence=0.8,
            recommendation="rec",
            follow_up_query="follow",
        )
        d = ins.to_dict()
        assert d["type"] == "anomaly"
        assert d["severity"] == "warning"
        assert d["id"] == "test-1"
        assert d["data"] == {"a": 1}
        assert d["follow_up_query"] == "follow"


# ══════════════════════════════════════════════
# 12. 边界条件测试
# ══════════════════════════════════════════════


class TestEdgeCases:
    def test_single_row_data(self):
        """单行数据不崩溃。"""
        detector = InsightDetector()
        rows = [{"team": "A", "defect_count": 10}]
        insights = detector.detect({"data": rows})
        assert isinstance(insights, list)

    def test_two_groups_normal(self):
        """两个分组正常数据不触发异常。"""
        detector = InsightDetector()
        rows = [
            {"team": "A", "defect_count": 10},
            {"team": "B", "defect_count": 8},
        ]
        insights = detector.detect({"data": rows})
        anomaly = [i for i in insights if i.type is InsightType.ANOMALY]
        assert len(anomaly) == 0

    def test_max_insights_limit(self):
        """max_insights 限制返回数量。"""
        detector = InsightDetector()
        rows = []
        for team, count in [("A", 5), ("B", 4), ("C", 6), ("D", 5), ("E", 100), ("F", 1)]:
            rows.append({"problem_finder_team": team, "defect_count": count})
        for i in range(10):
            rows.append({"assigned_ecu": "ECU_X", "problem_severity": "Showstopper"})
        report = detector.build_report({"data": rows}, max_insights=2)
        assert len(report.insights) <= 2

    def test_time_dimension_detection(self):
        """时间维度自动识别。"""
        from backend.analytics.insight_engine import _is_time_dimension
        assert _is_time_dimension("time.defect_creation_date")
        assert _is_time_dimension("test_week")
        assert _is_time_dimension("creation_time")
        assert not _is_time_dimension("team")
        assert not _is_time_dimension("assigned_ecu")
