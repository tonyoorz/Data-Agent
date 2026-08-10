"""Tests for VizEngine — automatic visualisation engine.

Covers ChartTypeInferrer, all chart builders, VizModifier, and helper functions.
"""
from __future__ import annotations

import json

import pytest

from backend.analytics.viz_engine import (
    BarChartBuilder,
    ChartType,
    ChartTypeInferrer,
    ColorPalette,
    GaugeBuilder,
    GroupedBarBuilder,
    HeatmapBuilder,
    LineChartBuilder,
    PieChartBuilder,
    StackedBarBuilder,
    TableBuilder,
    TreemapBuilder,
    VizEngine,
    VizModifier,
    VizResult,
    calculate_pareto,
    detect_time_dimension,
    extract_numeric_values,
    is_all_same_value,
    is_percentage_metric,
    max_min_ratio,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

CATEGORY_DATA = [
    {"product.ecu": "APP_Mobile_2_0", "defect.count": 45},
    {"product.ecu": "IDC23", "defect.count": 28},
    {"product.ecu": "APP_Mobile_1_0", "defect.count": 15},
    {"product.ecu": "IDC17", "defect.count": 10},
]

TIME_DATA = [
    {"time.defect_creation_date": "2026-01", "defect.count": 30},
    {"time.defect_creation_date": "2026-02", "defect.count": 45},
    {"time.defect_creation_date": "2026-03", "defect.count": 22},
    {"time.defect_creation_date": "2026-04", "defect.count": 38},
    {"time.defect_creation_date": "2026-05", "defect.count": 50},
]

MULTI_DIM_DATA = [
    {"product.project": "IDC", "quality.phase": "T0", "defect.count": 15},
    {"product.project": "IDC", "quality.phase": "T1", "defect.count": 10},
    {"product.project": "APP", "quality.phase": "T0", "defect.count": 8},
    {"product.project": "APP", "quality.phase": "T1", "defect.count": 5},
]

SEVERITY_DATA = [
    {"quality.severity": "Critical", "defect.count": 12},
    {"quality.severity": "High", "defect.count": 25},
    {"quality.severity": "Medium", "defect.count": 40},
    {"quality.severity": "Low", "defect.count": 18},
]

SINGLE_ROW = [{"defect.pass_rate": 85.5}]

EMPTY_DATA: list[dict] = []

LARGE_DATA = [
    {"product.ecu": f"ECU_{i}", "defect.count": i * 10}
    for i in range(60)
]

SAME_VALUE_DATA = [
    {"product.ecu": "A", "defect.count": 50},
    {"product.ecu": "B", "defect.count": 50},
    {"product.ecu": "C", "defect.count": 50},
]

PARETO_DATA = [
    {"product.ecu": "Top1", "defect.count": 500},
    {"product.ecu": "Top2", "defect.count": 300},
    {"product.ecu": "Top3", "defect.count": 150},
    {"product.ecu": "Mid1", "defect.count": 30},
    {"product.ecu": "Mid2", "defect.count": 15},
    {"product.ecu": "Low1", "defect.count": 3},
    {"product.ecu": "Low2", "defect.count": 1},
    {"product.ecu": "Low3", "defect.count": 1},
]


# ===========================================================================
#  ChartTypeInferrer (12 tests)
# ===========================================================================

class TestChartTypeInferrer:
    inferrer = ChartTypeInferrer()

    def test_time_dimension_prefers_line(self):
        ct, conf, alts = self.inferrer.infer(
            TIME_DATA,
            dimension_ids=["time.defect_creation_date"],
            metric_ids=["defect.count"],
        )
        assert ct == ChartType.LINE
        assert conf > 0

    def test_category_dimension_prefers_bar(self):
        ct, conf, _ = self.inferrer.infer(
            CATEGORY_DATA,
            dimension_ids=["product.ecu"],
            metric_ids=["defect.count"],
        )
        assert ct == ChartType.BAR

    def test_empty_data_returns_table(self):
        ct, conf, alts = self.inferrer.infer(EMPTY_DATA)
        assert ct == ChartType.TABLE
        assert conf == 1.0
        assert alts == []

    def test_single_row_percentage_returns_gauge(self):
        ct, conf, _ = self.inferrer.infer(
            SINGLE_ROW,
            dimension_ids=[],
            metric_ids=["defect.pass_rate"],
        )
        assert ct == ChartType.GAUGE

    def test_single_row_non_percentage_returns_table(self):
        data = [{"defect.count": 42}]
        ct, _, _ = self.inferrer.infer(
            data, dimension_ids=[], metric_ids=["defect.count"]
        )
        assert ct == ChartType.TABLE

    def test_multi_dimension_prefers_stacked_or_grouped(self):
        ct, _, alts = self.inferrer.infer(
            MULTI_DIM_DATA,
            dimension_ids=["product.project", "quality.phase"],
            metric_ids=["defect.count"],
        )
        assert ct in (ChartType.STACKED_BAR, ChartType.GROUPED_BAR, ChartType.HEATMAP)

    def test_intent_trend_forces_line(self):
        ct, _, _ = self.inferrer.infer(
            CATEGORY_DATA,
            dimension_ids=["product.ecu"],
            metric_ids=["defect.count"],
            intent="trend",
        )
        assert ct == ChartType.LINE

    def test_intent_rank_forces_bar(self):
        ct, _, _ = self.inferrer.infer(
            CATEGORY_DATA,
            dimension_ids=["product.ecu"],
            metric_ids=["defect.count"],
            intent="rank",
        )
        assert ct == ChartType.BAR

    def test_intent_list_forces_table(self):
        ct, _, _ = self.inferrer.infer(
            CATEGORY_DATA,
            dimension_ids=["product.ecu"],
            metric_ids=["defect.count"],
            intent="list",
        )
        assert ct == ChartType.TABLE

    def test_all_same_value_returns_table(self):
        ct, _, _ = self.inferrer.infer(
            SAME_VALUE_DATA,
            dimension_ids=["product.ecu"],
            metric_ids=["defect.count"],
        )
        assert ct == ChartType.TABLE

    def test_large_data_returns_table(self):
        ct, _, _ = self.inferrer.infer(
            LARGE_DATA,
            dimension_ids=["product.ecu"],
            metric_ids=["defect.count"],
        )
        assert ct == ChartType.TABLE

    def test_pareto_data_boosts_bar(self):
        ct, _, _ = self.inferrer.infer(
            PARETO_DATA,
            dimension_ids=["product.ecu"],
            metric_ids=["defect.count"],
        )
        assert ct == ChartType.BAR

    def test_severity_dimension_boosts_bar(self):
        ct, _, _ = self.inferrer.infer(
            SEVERITY_DATA,
            dimension_ids=["quality.severity"],
            metric_ids=["defect.count"],
        )
        assert ct == ChartType.BAR

    def test_intent_distribution_forces_pie(self):
        ct, _, _ = self.inferrer.infer(
            CATEGORY_DATA,
            dimension_ids=["product.ecu"],
            metric_ids=["defect.count"],
            intent="distribution",
        )
        assert ct == ChartType.PIE


# ===========================================================================
#  Chart Builders (14 tests)
# ===========================================================================

class TestBarChartBuilder:
    def test_bar_output_structure(self):
        opt = BarChartBuilder().build(
            CATEGORY_DATA,
            dim_key="product.ecu",
            metric_key="defect.count",
            title="Defects by ECU",
        )
        assert opt["series"][0]["type"] == "bar"
        assert opt["xAxis"]["type"] == "category"
        assert opt["yAxis"]["type"] == "value"
        assert len(opt["series"][0]["data"]) == 4
        assert opt["title"]["text"] == "Defects by ECU"

    def test_bar_sort_desc(self):
        opt = BarChartBuilder().build(
            CATEGORY_DATA,
            dim_key="product.ecu",
            metric_key="defect.count",
            sort="desc",
        )
        vals = opt["series"][0]["data"]
        assert vals == sorted(vals, reverse=True)

    def test_bar_json_serializable(self):
        opt = BarChartBuilder().build(
            CATEGORY_DATA, dim_key="product.ecu", metric_key="defect.count"
        )
        json.dumps(opt)  # should not raise

    def test_bar_horizontal(self):
        opt = BarChartBuilder().build(
            CATEGORY_DATA,
            dim_key="product.ecu",
            metric_key="defect.count",
            horizontal=True,
        )
        # category axis should be on Y when horizontal
        assert opt["yAxis"]["type"] == "category"
        assert opt["xAxis"]["type"] == "value"


class TestLineChartBuilder:
    def test_line_output_with_markpoint(self):
        opt = LineChartBuilder().build(
            TIME_DATA,
            dim_key="time.defect_creation_date",
            metric_keys=["defect.count"],
            title="Defect Trend",
        )
        assert opt["series"][0]["type"] == "line"
        assert "markPoint" in opt["series"][0]
        assert len(opt["series"][0]["markPoint"]["data"]) == 2  # max + min

    def test_line_multi_series(self):
        data = [
            {"time.month": "2026-01", "defect.count": 10, "defect.fixed": 8},
            {"time.month": "2026-02", "defect.count": 15, "defect.fixed": 12},
            {"time.month": "2026-03", "defect.count": 20, "defect.fixed": 18},
        ]
        opt = LineChartBuilder().build(
            data,
            dim_key="time.month",
            metric_keys=["defect.count", "defect.fixed"],
        )
        assert len(opt["series"]) == 2

    def test_line_json_serializable(self):
        opt = LineChartBuilder().build(
            TIME_DATA, dim_key="time.defect_creation_date", metric_keys=["defect.count"]
        )
        json.dumps(opt)


class TestPieChartBuilder:
    def test_pie_output_structure(self):
        opt = PieChartBuilder().build(
            CATEGORY_DATA,
            dim_key="product.ecu",
            metric_key="defect.count",
            title="Defect Distribution",
        )
        assert opt["series"][0]["type"] == "pie"
        assert len(opt["series"][0]["data"]) == len(CATEGORY_DATA)

    def test_pie_small_slice_merge(self):
        # Add a tiny slice that should merge into "Other"
        data = CATEGORY_DATA + [
            {"product.ecu": "Tiny", "defect.count": 1},   # < 3% of total
        ]
        opt = PieChartBuilder().build(
            data, dim_key="product.ecu", metric_key="defect.count"
        )
        names = [d["name"] for d in opt["series"][0]["data"]]
        assert "Other" in names

    def test_pie_json_serializable(self):
        opt = PieChartBuilder().build(
            CATEGORY_DATA, dim_key="product.ecu", metric_key="defect.count"
        )
        json.dumps(opt)


class TestStackedBarBuilder:
    def test_stacked_output(self):
        opt = StackedBarBuilder().build(
            MULTI_DIM_DATA,
            primary_dim="product.project",
            secondary_dim="quality.phase",
            metric_key="defect.count",
        )
        assert all(s["stack"] for s in opt["series"])
        assert len(opt["series"]) >= 2  # at least 2 phases

    def test_stacked_percentage(self):
        opt = StackedBarBuilder().build(
            MULTI_DIM_DATA,
            primary_dim="product.project",
            secondary_dim="quality.phase",
            metric_key="defect.count",
            percentage_stack=True,
        )
        assert "%" in opt["yAxis"]["axisLabel"]["formatter"]

    def test_stacked_json_serializable(self):
        opt = StackedBarBuilder().build(
            MULTI_DIM_DATA,
            primary_dim="product.project",
            secondary_dim="quality.phase",
            metric_key="defect.count",
        )
        json.dumps(opt)


class TestGroupedBarBuilder:
    def test_grouped_output(self):
        opt = GroupedBarBuilder().build(
            MULTI_DIM_DATA,
            primary_dim="product.project",
            secondary_dim="quality.phase",
            metric_key="defect.count",
        )
        for s in opt["series"]:
            assert s["type"] == "bar"
            assert "stack" not in s  # grouped bars don't stack

    def test_grouped_json_serializable(self):
        opt = GroupedBarBuilder().build(
            MULTI_DIM_DATA,
            primary_dim="product.project",
            secondary_dim="quality.phase",
            metric_key="defect.count",
        )
        json.dumps(opt)


class TestHeatmapBuilder:
    def test_heatmap_visualmap(self):
        opt = HeatmapBuilder().build(
            MULTI_DIM_DATA,
            x_dim="product.project",
            y_dim="quality.phase",
            metric_key="defect.count",
        )
        assert opt["series"][0]["type"] == "heatmap"
        assert "visualMap" in opt
        assert "min" in opt["visualMap"]
        assert "max" in opt["visualMap"]
        assert "color" in opt["visualMap"]["inRange"]

    def test_heatmap_json_serializable(self):
        opt = HeatmapBuilder().build(
            MULTI_DIM_DATA,
            x_dim="product.project",
            y_dim="quality.phase",
            metric_key="defect.count",
        )
        json.dumps(opt)


class TestGaugeBuilder:
    def test_gauge_colour_bands(self):
        opt = GaugeBuilder().build(
            SINGLE_ROW, metric_key="defect.pass_rate", title="Pass Rate"
        )
        s = opt["series"][0]
        assert s["type"] == "gauge"
        colors = s["axisLine"]["lineStyle"]["color"]
        # 3 bands: red, yellow, green
        assert len(colors) == 3
        assert colors[0][1] == "#ee6666"
        assert colors[2][1] == "#91cc75"

    def test_gauge_json_serializable(self):
        opt = GaugeBuilder().build(SINGLE_ROW, metric_key="defect.pass_rate")
        json.dumps(opt)


class TestTableBuilder:
    def test_table_structure(self):
        opt = TableBuilder().build(CATEGORY_DATA, title="Data Table")
        assert opt["series"][0]["type"] == "table"
        assert len(opt["series"][0]["data"]) == len(CATEGORY_DATA)

    def test_table_empty_data(self):
        opt = TableBuilder().build(EMPTY_DATA)
        assert opt["series"] == []

    def test_table_json_serializable(self):
        opt = TableBuilder().build(CATEGORY_DATA)
        json.dumps(opt)


class TestTreemapBuilder:
    def test_treemap_structure(self):
        opt = TreemapBuilder().build(
            CATEGORY_DATA, dim_key="product.ecu", metric_key="defect.count"
        )
        assert opt["series"][0]["type"] == "treemap"
        assert len(opt["series"][0]["data"]) == 4


# ===========================================================================
#  VizEngine integration (4 tests)
# ===========================================================================

class TestVizEngine:
    engine = VizEngine()

    def test_generate_category_data(self):
        result = self.engine.generate(
            CATEGORY_DATA,
            dimension_ids=["product.ecu"],
            metric_ids=["defect.count"],
            natural_question="各ECU缺陷数量",
        )
        assert isinstance(result, VizResult)
        assert result.chart_type == ChartType.BAR
        assert result.title == "各ECU缺陷数量"
        assert result.confidence > 0
        assert len(result.echarts_option["series"]) > 0
        assert result.data_summary["row_count"] == 4

    def test_generate_time_data(self):
        result = self.engine.generate(
            TIME_DATA,
            dimension_ids=["time.defect_creation_date"],
            metric_ids=["defect.count"],
        )
        assert result.chart_type == ChartType.LINE

    def test_generate_empty_data(self):
        result = self.engine.generate(EMPTY_DATA)
        assert result.chart_type == ChartType.TABLE

    def test_generate_auto_detect(self):
        result = self.engine.generate(CATEGORY_DATA)
        assert isinstance(result, VizResult)
        # should auto-detect product.ecu as dimension and defect.count as metric
        assert "defect.count" in result.data_summary["metrics"]

    def test_to_dict_serializable(self):
        result = self.engine.generate(CATEGORY_DATA)
        d = result.to_dict()
        json.dumps(d)
        assert d["chart_type"] == "bar"


# ===========================================================================
#  VizModifier (8 tests)
# ===========================================================================

class TestVizModifier:
    modifier = VizModifier()
    engine = VizEngine()

    def _make_result(self, data=None, **kw) -> VizResult:
        data = data or CATEGORY_DATA
        return self.engine.generate(
            data,
            dimension_ids=kw.get("dimension_ids", ["product.ecu"]),
            metric_ids=kw.get("metric_ids", ["defect.count"]),
        )

    def test_change_chart_type(self):
        original = self._make_result()
        modified = self.modifier.modify(original, "换成折线图")
        assert modified.chart_type == ChartType.LINE
        assert modified.echarts_option["series"][0]["type"] == "line"
        # original should not change
        assert original.chart_type == ChartType.BAR

    def test_change_to_pie(self):
        original = self._make_result()
        modified = self.modifier.modify(original, "饼图")
        assert modified.chart_type == ChartType.PIE

    def test_change_to_table(self):
        original = self._make_result()
        modified = self.modifier.modify(original, "表格")
        assert modified.chart_type == ChartType.TABLE

    def test_switch_axis(self):
        original = self._make_result()
        # original is vertical bar (category on X)
        assert original.echarts_option["xAxis"]["type"] == "category"
        modified = self.modifier.modify(original, "横着")
        assert modified.echarts_option["yAxis"]["type"] == "category"
        assert modified.echarts_option["xAxis"]["type"] == "value"

    def test_show_values(self):
        original = self._make_result()
        modified = self.modifier.modify(original, "显示数值")
        for s in modified.echarts_option["series"]:
            assert s.get("label", {}).get("show") is True

    def test_sort_desc(self):
        original = self._make_result()
        modified = self.modifier.modify(original, "降序")
        vals = modified.echarts_option["series"][0]["data"]
        assert vals == sorted(vals, reverse=True)

    def test_top_n_filter(self):
        original = self._make_result()
        modified = self.modifier.modify(original, "只看前2")
        cats = modified.echarts_option["xAxis"]["data"]
        assert len(cats) == 2

    def test_unknown_instruction_no_change(self):
        original = self._make_result()
        modified = self.modifier.modify(original, "请翻译成英文")
        # should return the same object (unmodified)
        assert modified is original

    def test_hide_legend(self):
        original = self._make_result()
        modified = self.modifier.modify(original, "隐藏图例")
        assert modified.echarts_option["legend"]["show"] is False

    def test_color_change(self):
        original = self._make_result()
        modified = self.modifier.modify(original, "红色")
        assert modified.echarts_option["color"][0] == "#ee6666"


# ===========================================================================
#  Helper functions (6 tests)
# ===========================================================================

class TestHelpers:
    def test_extract_numeric_values(self):
        data = [{"a": 1}, {"a": 2.5}, {"a": "x"}, {"a": None}]
        vals = extract_numeric_values(data, "a")
        assert vals == [1.0, 2.5]

    def test_detect_time_dimension_found(self):
        assert detect_time_dimension(["product.ecu", "time.month"]) == "time.month"

    def test_detect_time_dimension_none(self):
        assert detect_time_dimension(["product.ecu", "org.team"]) is None

    def test_is_all_same_value_true(self):
        assert is_all_same_value(SAME_VALUE_DATA, "defect.count") is True

    def test_is_all_same_value_false(self):
        assert is_all_same_value(CATEGORY_DATA, "defect.count") is False

    def test_calculate_pareto_true(self):
        assert calculate_pareto(PARETO_DATA, "product.ecu", "defect.count") is True

    def test_calculate_pareto_false(self):
        # uniform data is not pareto
        assert calculate_pareto(SAME_VALUE_DATA, "product.ecu", "defect.count") is False

    def test_max_min_ratio(self):
        data = [{"x": 10}, {"x": 1}, {"x": 5}]
        assert max_min_ratio(data, "x") == 10.0

    def test_max_min_ratio_single(self):
        assert max_min_ratio([{"x": 5}], "x") == 1.0

    def test_is_percentage_metric_by_name(self):
        assert is_percentage_metric("defect.pass_rate") is True
        assert is_percentage_metric("defect.count") is False


# ===========================================================================
#  ColorPalette (2 tests)
# ===========================================================================

class TestColorPalette:
    def test_get_palette_default(self):
        pal = ColorPalette.get_palette()
        assert len(pal) == 8
        assert "#5470c6" in pal

    def test_color_for_value_severity(self):
        assert ColorPalette.color_for_value("Critical", "severity") == "#ee6666"
        assert ColorPalette.color_for_value("Passed", "status") == "#91cc75"

    def test_color_for_value_fallback(self):
        # unknown mapping falls back to hash-based colour
        c = ColorPalette.color_for_value("anything", "nonexistent")
        assert c.startswith("#")
