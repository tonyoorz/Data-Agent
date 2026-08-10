"""
VizEngine — Automatic visualization engine for Data-Agent.

Transforms query results into ECharts configurations using a rule-based
inference engine. Supports natural-language modifications.

Usage:
    engine = VizEngine()
    result = engine.generate(data, metric_ids=["defect.count"], dimension_ids=["product.ecu"])
    # result.echarts_option → ready for ECharts frontend
"""
from __future__ import annotations

import copy
import json
import math
import re
from collections import OrderedDict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Sequence

from backend.analytics.ontology import OntologyCatalog


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class ChartType(Enum):
    BAR = "bar"
    LINE = "line"
    PIE = "pie"
    SCATTER = "scatter"
    STACKED_BAR = "stacked_bar"
    GROUPED_BAR = "grouped_bar"
    HEATMAP = "heatmap"
    TABLE = "table"
    GAUGE = "gauge"
    TREEMAP = "treemap"


# ---------------------------------------------------------------------------
# Color palette
# ---------------------------------------------------------------------------

class ColorPalette:
    """Centralized colour system for all chart builders."""

    DEFAULT: list[str] = [
        "#5470c6", "#91cc75", "#fac858", "#ee6666",
        "#73c0de", "#3ba272", "#fc8452", "#9a60b4",
    ]
    SEVERITY: dict[str, str] = {
        "Critical": "#ee6666",
        "High": "#fac858",
        "Medium": "#5470c6",
        "Low": "#91cc75",
    }
    STATUS: dict[str, str] = {
        "Passed": "#91cc75",
        "Failed": "#ee6666",
        "N/A": "#cccccc",
        "Not Executed": "#999999",
    }
    TRAFFIC: dict[str, str] = {
        "green": "#91cc75",
        "yellow": "#fac858",
        "red": "#ee6666",
    }

    _NAMED_PALETTES: dict[str, list[str]] = {
        "default": DEFAULT,
        "warm": ["#ee6666", "#fac858", "#fc8452", "#9a60b4"],
        "cool": ["#5470c6", "#73c0de", "#3ba272", "#91cc75"],
    }

    _NAMED_MAPPINGS: dict[str, dict[str, str]] = {
        "severity": SEVERITY,
        "status": STATUS,
        "traffic": TRAFFIC,
    }

    @staticmethod
    def get_palette(name: str = "default") -> list[str]:
        """Return a named colour palette list."""
        return list(ColorPalette._NAMED_PALETTES.get(name, ColorPalette.DEFAULT))

    @staticmethod
    def color_for_value(value: str, mapping: str = "default") -> str:
        """Return a colour for *value* using a named mapping.

        Falls back to hashing the value into the default palette.
        """
        mapping_dict = ColorPalette._NAMED_MAPPINGS.get(mapping, {})
        if value in mapping_dict:
            return mapping_dict[value]
        # hash into default palette
        palette = ColorPalette.DEFAULT
        idx = abs(hash(value)) % len(palette)
        return palette[idx]


# ---------------------------------------------------------------------------
# VizResult dataclass
# ---------------------------------------------------------------------------

@dataclass
class VizResult:
    """Fully serialisable result of the visualisation engine."""

    chart_type: ChartType
    echarts_option: dict[str, Any]
    title: str
    subtitle: str
    confidence: float
    alternative_types: list[ChartType] = field(default_factory=list)
    data_summary: dict[str, Any] = field(default_factory=dict)
    modifiable: bool = True

    # internal payload used by VizModifier (not exposed to ECharts)
    _meta: dict[str, Any] = field(default_factory=dict, repr=False)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serialisable representation."""
        return {
            "chart_type": self.chart_type.value,
            "echarts_option": self.echarts_option,
            "title": self.title,
            "subtitle": self.subtitle,
            "confidence": self.confidence,
            "alternative_types": [ct.value for ct in self.alternative_types],
            "data_summary": self.data_summary,
            "modifiable": self.modifiable,
        }


# ---------------------------------------------------------------------------
# Helper / utility functions
# ---------------------------------------------------------------------------

def extract_numeric_values(data: list[dict], key: str) -> list[float]:
    """Extract numeric values for *key* from each row, skipping non-numeric."""
    result: list[float] = []
    for row in data:
        val = row.get(key)
        if val is None:
            continue
        try:
            result.append(float(val))
        except (TypeError, ValueError):
            pass
    return result


def detect_time_dimension(dimension_ids: list[str]) -> str | None:
    """Return the first dimension that looks like a time axis."""
    for dim in dimension_ids:
        if dim.startswith("time."):
            return dim
    return None


def is_percentage_metric(metric_id: str, catalog: OntologyCatalog | None = None) -> bool:
    """Heuristically detect if a metric is a percentage (0–100 or 0–1)."""
    if catalog is not None:
        try:
            metric = catalog.get_metric(metric_id)
            unit = (metric.get("unit") or "").lower()
            if "percent" in unit or "%" in unit or "ratio" in unit:
                return True
        except Exception:
            pass
    lower_id = metric_id.lower()
    if any(kw in lower_id for kw in ("rate", "ratio", "percentage", "pct", "pass_rate", "coverage")):
        return True
    return False


def is_all_same_value(data: list[dict], key: str) -> bool:
    """True when every row has the same numeric value for *key*."""
    values = extract_numeric_values(data, key)
    if len(values) <= 1:
        return True
    first = values[0]
    return all(abs(v - first) < 1e-9 for v in values)


def calculate_pareto(data: list[dict], dim_key: str, metric_key: str) -> bool:
    """Return True if the data roughly follows the 80/20 rule.

    Sorts descending by *metric_key* and checks whether the top ~20 % of
    categories account for ≥ 75 % of the total.
    """
    if not data:
        return False
    pairs: list[tuple[str, float]] = []
    for row in data:
        val = row.get(metric_key)
        try:
            pairs.append((str(row.get(dim_key, "")), float(val)))
        except (TypeError, ValueError):
            pass
    if len(pairs) < 4:
        return False
    pairs.sort(key=lambda p: p[1], reverse=True)
    total = sum(v for _, v in pairs)
    if total <= 0:
        return False
    top_count = max(1, math.ceil(len(pairs) * 0.2))
    top_sum = sum(v for _, v in pairs[:top_count])
    return (top_sum / total) >= 0.75


def max_min_ratio(data: list[dict], key: str) -> float:
    """Return max/min ratio for numeric values of *key*."""
    values = extract_numeric_values(data, key)
    if len(values) < 2:
        return 1.0
    mn, mx = min(values), max(values)
    if mn == 0:
        return float("inf") if mx > 0 else 1.0
    return mx / mn


def _split_dims_metrics(columns: list[str]) -> tuple[list[str], list[str]]:
    """Split column names into (dimensions, metrics).

    Heuristic: any column containing a dot that doesn't start with known
    metric prefixes is treated as a dimension.  Metric columns typically
    contain ``count``, ``rate``, ``ratio``, ``avg``, ``sum``, ``total``.
    """
    metric_keywords = ("count", "rate", "ratio", "avg", "sum", "total", "score", "duration", "percentage", "pct")
    dims: list[str] = []
    metrics: list[str] = []
    for col in columns:
        lower = col.lower()
        if any(kw in lower for kw in metric_keywords):
            metrics.append(col)
        else:
            dims.append(col)
    return dims, metrics


def _humanise_column(col: str) -> str:
    """Make a column ID human-readable: ``product.ecu`` → ``Product ECU``."""
    part = col.split(".")[-1].replace("_", " ")
    return part.title()


# ---------------------------------------------------------------------------
# Chart builders
# ---------------------------------------------------------------------------

class _BaseBuilder:
    """Common helpers shared by all chart builders."""

    @staticmethod
    def _base_option(title: str, subtitle: str = "") -> dict[str, Any]:
        return {
            "title": {"text": title, "subtext": subtitle, "left": "center"},
            "tooltip": {"trigger": "item"},
            "toolbox": {
                "feature": {
                    "saveAsImage": {},
                    "dataView": {"readOnly": True},
                }
            },
        }

    @staticmethod
    def _extract_categories(data: list[dict], dim_key: str) -> list[str]:
        seen: list[str] = []
        for row in data:
            val = str(row.get(dim_key, ""))
            if val not in seen:
                seen.append(val)
        return seen

    @staticmethod
    def _series_values(data: list[dict], dim_key: str, metric_key: str) -> list[float]:
        cat_map: dict[str, float] = {}
        for row in data:
            cat = str(row.get(dim_key, ""))
            try:
                cat_map[cat] = cat_map.get(cat, 0.0) + float(row.get(metric_key, 0))
            except (TypeError, ValueError):
                pass
        return [cat_map.get(c, 0.0) for c in _BaseBuilder._extract_categories(data, dim_key)]


class BarChartBuilder(_BaseBuilder):
    """Build vertical or horizontal bar chart ECharts options."""

    def build(
        self,
        data: list[dict],
        *,
        dim_key: str,
        metric_key: str,
        title: str = "",
        subtitle: str = "",
        horizontal: bool = False,
        sort: str | None = None,           # "asc" | "desc" | None
        color_map: dict[str, str] | None = None,
        show_label: bool = True,
    ) -> dict[str, Any]:
        option = self._base_option(title, subtitle)
        categories = self._extract_categories(data, dim_key)
        values = self._series_values(data, dim_key, metric_key)

        # sorting
        if sort in ("asc", "desc"):
            paired = sorted(zip(categories, values), key=lambda p: p[1], reverse=(sort == "desc"))
            categories = [p[0] for p in paired]
            values = [p[1] for p in paired]

        # per-bar colours
        item_style: dict[str, Any] = {}
        if color_map:
            item_style = {"color": None}
            option["color"] = [color_map.get(cat, ColorPalette.DEFAULT[0]) for cat in categories]
        else:
            option["color"] = ColorPalette.DEFAULT

        x_axis = {"type": "category", "data": categories, "axisLabel": {"interval": 0, "rotate": 0}}
        y_axis = {"type": "value"}

        if horizontal:
            option["xAxis"] = y_axis
            option["yAxis"] = x_axis
        else:
            option["xAxis"] = x_axis
            option["yAxis"] = y_axis

        option["tooltip"] = {"trigger": "axis", "axisPointer": {"type": "shadow"}}

        series: dict[str, Any] = {
            "name": _humanise_column(metric_key),
            "type": "bar",
            "data": values,
            "itemStyle": item_style if item_style else None,
        }
        if show_label:
            series["label"] = {"show": True, "position": "right" if horizontal else "top"}

        # clean None in itemStyle
        if series["itemStyle"] is None:
            series.pop("itemStyle")

        option["series"] = [series]
        option["grid"] = {"left": "3%", "right": "4%", "bottom": "3%", "containLabel": True}
        return option


class LineChartBuilder(_BaseBuilder):
    """Build line chart options with markPoint & area support."""

    def build(
        self,
        data: list[dict],
        *,
        dim_key: str,
        metric_keys: list[str],
        title: str = "",
        subtitle: str = "",
        smooth: bool = True,
        area: bool = False,
        show_markpoint: bool = True,
    ) -> dict[str, Any]:
        option = self._base_option(title, subtitle)
        categories = self._extract_categories(data, dim_key)

        # Try to sort by time if dim looks temporal
        if dim_key.startswith("time."):
            categories = sorted(categories)

        option["xAxis"] = {"type": "category", "boundaryGap": False, "data": categories}
        option["yAxis"] = {"type": "value"}
        option["tooltip"] = {"trigger": "axis"}
        option["color"] = ColorPalette.DEFAULT

        series_list: list[dict[str, Any]] = []
        for idx, mk in enumerate(metric_keys):
            values = []
            for cat in categories:
                row = next((r for r in data if str(r.get(dim_key, "")) == cat), None)
                try:
                    values.append(float(row.get(mk, 0)) if row else 0)
                except (TypeError, ValueError):
                    values.append(0)

            s: dict[str, Any] = {
                "name": _humanise_column(mk),
                "type": "line",
                "data": values,
                "smooth": smooth,
            }
            if area:
                s["areaStyle"] = {"opacity": 0.3}

            if show_markpoint and len(values) > 1:
                s["markPoint"] = {
                    "data": [
                        {"type": "max", "name": "Max"},
                        {"type": "min", "name": "Min"},
                    ]
                }
            series_list.append(s)

        option["series"] = series_list
        if len(metric_keys) > 1:
            option["legend"] = {"top": "bottom", "data": [_humanise_column(mk) for mk in metric_keys]}

        option["grid"] = {"left": "3%", "right": "4%", "bottom": "3%", "containLabel": True}
        return option


class PieChartBuilder(_BaseBuilder):
    """Build pie / rose chart options."""

    def build(
        self,
        data: list[dict],
        *,
        dim_key: str,
        metric_key: str,
        title: str = "",
        subtitle: str = "",
        rose: bool = False,
        merge_threshold: float = 0.03,
        inner_radius: str = "0%",
    ) -> dict[str, Any]:
        option = self._base_option(title, subtitle)
        categories = self._extract_categories(data, dim_key)
        values = self._series_values(data, dim_key, metric_key)
        total = sum(values) if values else 1

        # merge small slices into "Other"
        pie_data: list[dict[str, Any]] = []
        other_sum = 0.0
        for cat, val in zip(categories, values):
            ratio = val / total if total > 0 else 0
            if ratio < merge_threshold:
                other_sum += val
            else:
                pie_data.append({"name": cat, "value": val})
        if other_sum > 0:
            pie_data.append({"name": "Other", "value": other_sum})

        option["tooltip"] = {"trigger": "item", "formatter": "{b}: {c} ({d}%)"}
        option["legend"] = {"orient": "vertical", "left": "left", "data": [d["name"] for d in pie_data]}
        option["color"] = ColorPalette.DEFAULT

        series: dict[str, Any] = {
            "name": _humanise_column(metric_key),
            "type": "pie",
            "radius": [inner_radius, "70%"],
            "data": pie_data,
            "label": {"formatter": "{b}: {c} ({d}%)"},
            "emphasis": {"itemStyle": {"shadowBlur": 10, "shadowOffsetX": 0, "shadowColor": "rgba(0,0,0,0.5)"}},
        }
        if rose:
            series["roseType"] = "radius"

        option["series"] = [series]
        return option


class StackedBarBuilder(_BaseBuilder):
    """Build stacked bar chart (2 dimensions × 1 metric)."""

    def build(
        self,
        data: list[dict],
        *,
        primary_dim: str,
        secondary_dim: str,
        metric_key: str,
        title: str = "",
        subtitle: str = "",
        percentage_stack: bool = False,
    ) -> dict[str, Any]:
        option = self._base_option(title, subtitle)
        x_cats = self._extract_categories(data, primary_dim)
        series_keys = self._extract_categories(data, secondary_dim)

        option["tooltip"] = {"trigger": "axis", "axisPointer": {"type": "shadow"}}
        option["legend"] = {"top": "bottom", "data": series_keys}
        option["xAxis"] = {"type": "category", "data": x_cats}
        option["yAxis"] = {"type": "value"}
        option["color"] = ColorPalette.DEFAULT

        stack_id = "total"
        series_list: list[dict[str, Any]] = []
        for sk in series_keys:
            vals: list[float] = []
            for xc in x_cats:
                row = next(
                    (r for r in data if str(r.get(primary_dim, "")) == xc and str(r.get(secondary_dim, "")) == sk),
                    None,
                )
                try:
                    vals.append(float(row.get(metric_key, 0)) if row else 0)
                except (TypeError, ValueError):
                    vals.append(0)
            series_list.append({
                "name": sk,
                "type": "bar",
                "stack": stack_id,
                "emphasis": {"focus": "series"},
                "data": vals,
            })

        if percentage_stack:
            for s in series_list:
                s["label"] = {"show": True, "formatter": "{c}%"}
            # ECharts 5 percentage stack
            for s in series_list:
                s["stack"] = "percent"
            option["yAxis"] = {"type": "value", "axisLabel": {"formatter": "{value}%"}}

        option["series"] = series_list
        option["grid"] = {"left": "3%", "right": "4%", "bottom": "3%", "containLabel": True}
        return option


class GroupedBarBuilder(_BaseBuilder):
    """Build grouped (clustered) bar chart (2 dimensions × 1 metric)."""

    def build(
        self,
        data: list[dict],
        *,
        primary_dim: str,
        secondary_dim: str,
        metric_key: str,
        title: str = "",
        subtitle: str = "",
        horizontal: bool = False,
    ) -> dict[str, Any]:
        option = self._base_option(title, subtitle)
        x_cats = self._extract_categories(data, primary_dim)
        series_keys = self._extract_categories(data, secondary_dim)

        option["tooltip"] = {"trigger": "axis", "axisPointer": {"type": "shadow"}}
        option["legend"] = {"top": "bottom", "data": series_keys}
        option["color"] = ColorPalette.DEFAULT

        cat_axis = {"type": "category", "data": x_cats}
        val_axis = {"type": "value"}
        if horizontal:
            option["xAxis"] = val_axis
            option["yAxis"] = cat_axis
        else:
            option["xAxis"] = cat_axis
            option["yAxis"] = val_axis

        series_list: list[dict[str, Any]] = []
        for sk in series_keys:
            vals: list[float] = []
            for xc in x_cats:
                row = next(
                    (r for r in data if str(r.get(primary_dim, "")) == xc and str(r.get(secondary_dim, "")) == sk),
                    None,
                )
                try:
                    vals.append(float(row.get(metric_key, 0)) if row else 0)
                except (TypeError, ValueError):
                    vals.append(0)
            series_list.append({
                "name": sk,
                "type": "bar",
                "data": vals,
                "label": {"show": True},
            })

        option["series"] = series_list
        option["grid"] = {"left": "3%", "right": "4%", "bottom": "3%", "containLabel": True}
        return option


class HeatmapBuilder(_BaseBuilder):
    """Build heatmap (2 dimensions × metric)."""

    HEAT_COLORS: list[str] = [
        "#313695", "#4575b4", "#74add1", "#abd9e9",
        "#e0f3f8", "#fee090", "#fdae61", "#f46d43", "#d73027",
    ]

    def build(
        self,
        data: list[dict],
        *,
        x_dim: str,
        y_dim: str,
        metric_key: str,
        title: str = "",
        subtitle: str = "",
    ) -> dict[str, Any]:
        option = self._base_option(title, subtitle)
        x_cats = self._extract_categories(data, x_dim)
        y_cats = self._extract_categories(data, y_dim)

        points: list[list[Any]] = []
        all_vals: list[float] = []
        for xi, xv in enumerate(x_cats):
            for yi, yv in enumerate(y_cats):
                row = next(
                    (r for r in data if str(r.get(x_dim, "")) == xv and str(r.get(y_dim, "")) == yv),
                    None,
                )
                val = 0.0
                if row:
                    try:
                        val = float(row.get(metric_key, 0))
                    except (TypeError, ValueError):
                        pass
                points.append([xi, yi, val])
                all_vals.append(val)

        min_val = min(all_vals) if all_vals else 0
        max_val = max(all_vals) if all_vals else 100

        option["tooltip"] = {"position": "top"}
        option["grid"] = {"left": "15%", "right": "10%", "top": "10%", "bottom": "15%"}
        option["xAxis"] = {"type": "category", "data": x_cats, "splitArea": {"show": True}}
        option["yAxis"] = {"type": "category", "data": y_cats, "splitArea": {"show": True}}
        option["visualMap"] = {
            "min": min_val,
            "max": max_val,
            "calculable": True,
            "orient": "horizontal",
            "left": "center",
            "bottom": "0%",
            "inRange": {"color": self.HEAT_COLORS},
        }

        option["series"] = [{
            "name": _humanise_column(metric_key),
            "type": "heatmap",
            "data": points,
            "label": {"show": True},
            "emphasis": {"itemStyle": {"shadowBlur": 10, "shadowColor": "rgba(0,0,0,0.5)"}},
        }]
        return option


class GaugeBuilder(_BaseBuilder):
    """Build gauge chart for single-value percentage metrics."""

    def build(
        self,
        data: list[dict],
        *,
        metric_key: str,
        title: str = "",
        subtitle: str = "",
        target: float | None = None,
    ) -> dict[str, Any]:
        option = self._base_option(title, subtitle)
        value = 0.0
        if data:
            try:
                value = float(data[0].get(metric_key, 0))
            except (TypeError, ValueError):
                pass

        option["tooltip"] = {"formatter": "{a} <br/>{b} : {c}%"}

        series: dict[str, Any] = {
            "name": _humanise_column(metric_key),
            "type": "gauge",
            "radius": "65%",
            "detail": {"formatter": "{value}%"},
            "data": [{"value": value, "name": _humanise_column(metric_key)}],
            "axisLine": {
                "lineStyle": {
                    "width": 20,
                    "color": [
                        [0.3, "#ee6666"],
                        [0.7, "#fac858"],
                        [1, "#91cc75"],
                    ],
                }
            },
        }
        if target is not None:
            series["markPoint"] = {
                "data": [{"yAxis": target, "name": "Target"}]
            }

        option["series"] = [series]
        return option


class TableBuilder(_BaseBuilder):
    """Build enhanced table configuration (ECharts table-like)."""

    def build(
        self,
        data: list[dict],
        *,
        columns: list[str] | None = None,
        title: str = "",
        subtitle: str = "",
        conditional_col: str | None = None,
        thresholds: tuple[float, float] | None = None,  # (yellow_below, red_below)
    ) -> dict[str, Any]:
        option = self._base_option(title, subtitle)
        if not data:
            option["series"] = []
            return option

        cols = columns or list(data[0].keys())
        headers = [_humanise_column(c) for c in cols]

        rows: list[list[Any]] = []
        for row in data:
            r: list[Any] = []
            for col in cols:
                val = row.get(col, "")
                if isinstance(val, (int, float)):
                    r.append(val)
                else:
                    r.append(str(val))
            rows.append(r)

        cell_style: dict[str, Any] = {}
        if conditional_col and thresholds and conditional_col in cols:
            col_idx = cols.index(conditional_col)
            yellow_t, red_t = thresholds
            cell_rules: list[dict[str, Any]] = []
            for ri, row in enumerate(data):
                try:
                    val = float(row.get(conditional_col, 0))
                except (TypeError, ValueError):
                    continue
                color = "#91cc75" if val >= yellow_t else ("#fac858" if val >= red_t else "#ee6666")
                cell_rules.append({
                    "row": ri,
                    "col": col_idx,
                    "backgroundColor": color,
                    "color": "#fff",
                })
            cell_style = {"cellStyleRules": cell_rules}

        option["dataset"] = {
            "source": [headers] + rows,
        }
        option["tooltip"] = {"trigger": "item"}
        option["series"] = [{
            "type": "table",
            "data": rows,
            "columns": [{"prop": c, "label": h} for c, h in zip(cols, headers)],
            "border": True,
            "stripe": True,
            **cell_style,
        }]
        return option


class TreemapBuilder(_BaseBuilder):
    """Build a simple treemap for hierarchical / category-size data."""

    def build(
        self,
        data: list[dict],
        *,
        dim_key: str,
        metric_key: str,
        title: str = "",
        subtitle: str = "",
    ) -> dict[str, Any]:
        option = self._base_option(title, subtitle)
        categories = self._extract_categories(data, dim_key)
        values = self._series_values(data, dim_key, metric_key)

        tree_data = [
            {"name": cat, "value": val}
            for cat, val in zip(categories, values)
        ]
        option["tooltip"] = {"formatter": "{b}: {c}"}
        option["series"] = [{
            "type": "treemap",
            "data": tree_data,
            "label": {"show": True, "formatter": "{b}\n{c}"},
            "levels": [{"itemStyle": {"borderWidth": 2, "borderColor": "#fff"}}],
        }]
        return option


# ---------------------------------------------------------------------------
# ChartTypeInferrer
# ---------------------------------------------------------------------------

_SEVERITY_ORDER: dict[str, int] = {
    "Critical": 0, "High": 1, "Medium": 2, "Low": 3,
}


class ChartTypeInferrer:
    """Rule-based inference engine that picks the best ChartType."""

    def infer(
        self,
        data: list[dict],
        *,
        dimension_ids: list[str] | None = None,
        metric_ids: list[str] | None = None,
        intent: str | None = None,
    ) -> tuple[ChartType, float, list[ChartType]]:
        """Return ``(best_chart, confidence, alternatives)``."""

        candidates: dict[ChartType, float] = {}

        # -- auto-detect dims & metrics if not provided --
        if data:
            all_cols = list(data[0].keys())
        else:
            all_cols = []
        if dimension_ids is None:
            dimension_ids, _auto_metrics = _split_dims_metrics(all_cols)
        if metric_ids is None:
            _, metric_ids = _split_dims_metrics(all_cols)
            if not metric_ids and all_cols:
                # fallback: last column is metric
                metric_ids = [all_cols[-1]]
                dimension_ids = [c for c in all_cols if c != metric_ids[0]]

        num_rows = len(data)
        num_dims = len(dimension_ids)
        num_metrics = len(metric_ids)

        # ---- Rule: empty data ----
        if num_rows == 0:
            return ChartType.TABLE, 1.0, []

        # ---- Rule: single row ----
        if num_rows == 1:
            if metric_ids and is_percentage_metric(metric_ids[0]):
                candidates[ChartType.GAUGE] = 0.8
            candidates[ChartType.TABLE] = 0.7

        # ---- Row count rules ----
        if 2 <= num_rows <= 10:
            candidates[ChartType.BAR] = candidates.get(ChartType.BAR, 0.0) + 0.3
            candidates[ChartType.PIE] = candidates.get(ChartType.PIE, 0.0) + 0.2
        elif 11 <= num_rows <= 50:
            candidates[ChartType.BAR] = candidates.get(ChartType.BAR, 0.0) + 0.25
            candidates[ChartType.LINE] = candidates.get(ChartType.LINE, 0.0) + 0.2
        elif num_rows > 50:
            candidates[ChartType.TABLE] = candidates.get(ChartType.TABLE, 0.0) + 0.5

        # ---- Time dimension → LINE ----
        time_dim = detect_time_dimension(dimension_ids)
        if time_dim:
            candidates[ChartType.LINE] = candidates.get(ChartType.LINE, 0.0) + 0.35

        # ---- product.* dimension → BAR ----
        if any(d.startswith("product.") for d in dimension_ids):
            candidates[ChartType.BAR] = candidates.get(ChartType.BAR, 0.0) + 0.15

        # ---- org.* dimension → BAR / TREEMAP ----
        if any(d.startswith("org.") for d in dimension_ids):
            candidates[ChartType.BAR] = candidates.get(ChartType.BAR, 0.0) + 0.1
            candidates[ChartType.TREEMAP] = candidates.get(ChartType.TREEMAP, 0.0) + 0.1

        # ---- quality.severity → custom BAR ----
        if any("severity" in d for d in dimension_ids):
            candidates[ChartType.BAR] = candidates.get(ChartType.BAR, 0.0) + 0.2

        # ---- Dimension count rules ----
        if num_dims >= 3:
            candidates[ChartType.TABLE] = candidates.get(ChartType.TABLE, 0.0) + 0.4
        elif num_dims == 2:
            candidates[ChartType.STACKED_BAR] = candidates.get(ChartType.STACKED_BAR, 0.0) + 0.5
            candidates[ChartType.GROUPED_BAR] = candidates.get(ChartType.GROUPED_BAR, 0.0) + 0.5
            candidates[ChartType.HEATMAP] = candidates.get(ChartType.HEATMAP, 0.0) + 0.35
            # demote plain bar when multiple dims present
            candidates[ChartType.BAR] = max(candidates.get(ChartType.BAR, 0) - 0.2, 0.0)
            candidates[ChartType.PIE] = max(candidates.get(ChartType.PIE, 0) - 0.1, 0.0)

        # ---- Metric count rules ----
        if num_metrics >= 2:
            candidates[ChartType.GROUPED_BAR] = candidates.get(ChartType.GROUPED_BAR, 0.0) + 0.2

        # ---- Intent override ----
        intent_map: dict[str, ChartType] = {
            "aggregate": ChartType.BAR,
            "trend": ChartType.LINE,
            "compare": ChartType.GROUPED_BAR,
            "rank": ChartType.BAR,
            "list": ChartType.TABLE,
            "distribution": ChartType.PIE,
            "drilldown": ChartType.TABLE,
        }
        if intent and intent in intent_map:
            ct = intent_map[intent]
            candidates[ct] = candidates.get(ct, 0.0) + 0.6

        # ---- Data characteristic rules ----
        if metric_ids:
            metric_key = metric_ids[0]

            # all same value
            if num_rows > 1 and is_all_same_value(data, metric_key):
                candidates[ChartType.TABLE] = candidates.get(ChartType.TABLE, 0.0) + 0.5

            # max/min ratio
            ratio = max_min_ratio(data, metric_key)
            if ratio > 10:
                # huge variance — demote pie (unreadable), prefer table or bar
                candidates[ChartType.PIE] = max(candidates.get(ChartType.PIE, 0) - 0.3, 0.0)
                candidates[ChartType.TABLE] = candidates.get(ChartType.TABLE, 0.0) + 0.1

            # percentage metric → GAUGE (single row)
            if num_rows == 1 and is_percentage_metric(metric_key):
                candidates[ChartType.GAUGE] = candidates.get(ChartType.GAUGE, 0.0) + 0.3

            # pareto detection → BAR + LINE combo → we'll pick BAR as primary
            if num_dims == 1 and calculate_pareto(data, dimension_ids[0], metric_key):
                candidates[ChartType.BAR] = candidates.get(ChartType.BAR, 0.0) + 0.15

        # ---- Pick best ----
        if not candidates:
            candidates[ChartType.TABLE] = 0.3

        ranked = sorted(candidates.items(), key=lambda x: x[1], reverse=True)
        best_type, best_score = ranked[0]
        alternatives = [ct for ct, _ in ranked[1:] if _ >= best_score * 0.6]

        # cap confidence
        confidence = min(best_score, 1.0)
        return best_type, round(confidence, 3), alternatives


# ---------------------------------------------------------------------------
# VizEngine — main entry point
# ---------------------------------------------------------------------------

class VizEngine:
    """Auto-generate ECharts visualisations from query result data."""

    def __init__(self, catalog: OntologyCatalog | None = None):
        self.catalog = catalog
        self._inferrer = ChartTypeInferrer()
        self._modifier = VizModifier()

    # -- public API --

    def generate(
        self,
        data: list[dict],
        *,
        metric_ids: list[str] | None = None,
        dimension_ids: list[str] | None = None,
        intent: str | None = None,
        natural_question: str | None = None,
    ) -> VizResult:
        """Produce a :class:`VizResult` from raw query rows."""
        # auto-detect dims/metrics
        if data:
            all_cols = list(data[0].keys())
        else:
            all_cols = []
        if dimension_ids is None or metric_ids is None:
            auto_dims, auto_metrics = _split_dims_metrics(all_cols)
            if dimension_ids is None:
                dimension_ids = auto_dims
            if metric_ids is None:
                metric_ids = auto_metrics
                if not metric_ids and all_cols:
                    metric_ids = [all_cols[-1]]
                    dimension_ids = [c for c in all_cols if c not in metric_ids]

        chart_type, confidence, alternatives = self._inferrer.infer(
            data,
            dimension_ids=dimension_ids,
            metric_ids=metric_ids,
            intent=intent,
        )

        title = natural_question or "查询结果可视化"
        subtitle = self._build_subtitle(data, dimension_ids, metric_ids, chart_type)
        echarts_option = self._build_option(
            chart_type, data, dimension_ids, metric_ids, title, subtitle, intent
        )

        data_summary = {
            "row_count": len(data),
            "column_count": len(all_cols),
            "dimensions": dimension_ids,
            "metrics": metric_ids,
        }
        # add value range for first metric
        if metric_ids and data:
            vals = extract_numeric_values(data, metric_ids[0])
            if vals:
                data_summary["value_range"] = {"min": min(vals), "max": max(vals)}

        return VizResult(
            chart_type=chart_type,
            echarts_option=echarts_option,
            title=title,
            subtitle=subtitle,
            confidence=confidence,
            alternative_types=alternatives,
            data_summary=data_summary,
            modifiable=True,
            _meta={
                "dimension_ids": dimension_ids,
                "metric_ids": metric_ids,
                "intent": intent,
                "data": data,
            },
        )

    def modify(self, viz_result: VizResult, instruction: str) -> VizResult:
        """Apply a natural-language *instruction* to an existing result."""
        return self._modifier.modify(viz_result, instruction)

    # -- internal --

    @staticmethod
    def _build_subtitle(
        data: list[dict],
        dims: list[str],
        metrics: list[str],
        chart_type: ChartType,
    ) -> str:
        parts: list[str] = []
        if dims:
            parts.append("维度: " + ", ".join(_humanise_column(d) for d in dims))
        if metrics:
            parts.append("指标: " + ", ".join(_humanise_column(m) for m in metrics))
        parts.append(f"{len(data)} 行数据")
        ct_names = {
            ChartType.BAR: "柱状图",
            ChartType.LINE: "折线图",
            ChartType.PIE: "饼图",
            ChartType.SCATTER: "散点图",
            ChartType.STACKED_BAR: "堆叠柱状图",
            ChartType.GROUPED_BAR: "分组柱状图",
            ChartType.HEATMAP: "热力图",
            ChartType.TABLE: "表格",
            ChartType.GAUGE: "仪表盘",
            ChartType.TREEMAP: "矩形树图",
        }
        parts.append(ct_names.get(chart_type, str(chart_type)))
        return " | ".join(parts)

    def _build_option(
        self,
        chart_type: ChartType,
        data: list[dict],
        dims: list[str],
        metrics: list[str],
        title: str,
        subtitle: str,
        intent: str | None,
    ) -> dict[str, Any]:
        if not data:
            return TableBuilder().build(data, title=title, subtitle=subtitle)

        primary_dim = dims[0] if dims else list(data[0].keys())[0]
        metric_key = metrics[0] if metrics else list(data[0].keys())[-1]

        if chart_type == ChartType.BAR:
            sort = "desc" if intent == "rank" else None
            color_map = self._maybe_color_map(dims)
            return BarChartBuilder().build(
                data, dim_key=primary_dim, metric_key=metric_key,
                title=title, subtitle=subtitle, sort=sort, color_map=color_map,
            )

        if chart_type == ChartType.LINE:
            return LineChartBuilder().build(
                data, dim_key=primary_dim, metric_keys=metrics,
                title=title, subtitle=subtitle,
            )

        if chart_type == ChartType.PIE:
            return PieChartBuilder().build(
                data, dim_key=primary_dim, metric_key=metric_key,
                title=title, subtitle=subtitle,
            )

        if chart_type == ChartType.STACKED_BAR:
            secondary = dims[1] if len(dims) >= 2 else list(data[0].keys())[1]
            return StackedBarBuilder().build(
                data, primary_dim=primary_dim, secondary_dim=secondary,
                metric_key=metric_key, title=title, subtitle=subtitle,
            )

        if chart_type == ChartType.GROUPED_BAR:
            secondary = dims[1] if len(dims) >= 2 else list(data[0].keys())[1]
            return GroupedBarBuilder().build(
                data, primary_dim=primary_dim, secondary_dim=secondary,
                metric_key=metric_key, title=title, subtitle=subtitle,
            )

        if chart_type == ChartType.HEATMAP:
            secondary = dims[1] if len(dims) >= 2 else list(data[0].keys())[1]
            return HeatmapBuilder().build(
                data, x_dim=primary_dim, y_dim=secondary,
                metric_key=metric_key, title=title, subtitle=subtitle,
            )

        if chart_type == ChartType.GAUGE:
            return GaugeBuilder().build(
                data, metric_key=metric_key,
                title=title, subtitle=subtitle,
            )

        if chart_type == ChartType.TREEMAP:
            return TreemapBuilder().build(
                data, dim_key=primary_dim, metric_key=metric_key,
                title=title, subtitle=subtitle,
            )

        # default: TABLE
        return TableBuilder().build(
            data, title=title, subtitle=subtitle,
            conditional_col=metric_key if metrics else None,
            thresholds=(0.8, 0.5) if metrics and is_percentage_metric(metric_key) else None,
        )

    @staticmethod
    def _maybe_color_map(dims: list[str]) -> dict[str, str] | None:
        """Return a severity colour map if a severity dimension exists."""
        for d in dims:
            if "severity" in d:
                return dict(ColorPalette.SEVERITY)
        return None


# ---------------------------------------------------------------------------
# VizModifier — NL instruction based modification
# ---------------------------------------------------------------------------

class VizModifier:
    """Apply natural-language modifications to an existing VizResult."""

    # keyword → ChartType
    _TYPE_KEYWORDS: list[tuple[list[str], ChartType]] = [
        (["折线", "line", "趋势图"], ChartType.LINE),
        (["柱状", "bar", "条形"], ChartType.BAR),
        (["饼图", "pie", "占比"], ChartType.PIE),
        (["热力", "heatmap"], ChartType.HEATMAP),
        (["表格", "table", "列表"], ChartType.TABLE),
        (["仪表", "gauge"], ChartType.GAUGE),
        (["堆叠", "stack"], ChartType.STACKED_BAR),
        (["分组", "group"], ChartType.GROUPED_BAR),
        (["矩形树", "treemap"], ChartType.TREEMAP),
    ]

    _COLOR_KEYWORDS: dict[str, list[str]] = {
        "red": ["红色", "red"],
        "green": ["绿色", "green"],
        "yellow": ["黄色", "yellow"],
        "blue": ["蓝色", "blue"],
        "orange": ["橙色", "orange"],
    }

    _COLOR_HEX: dict[str, str] = {
        "red": "#ee6666",
        "green": "#91cc75",
        "yellow": "#fac858",
        "blue": "#5470c6",
        "orange": "#fc8452",
    }

    def modify(self, result: VizResult, instruction: str) -> VizResult:
        """Return a **new** VizResult with the modification applied."""
        inst_lower = instruction.lower().strip()

        # 1. Chart type change
        new_type = self._match_chart_type(inst_lower)
        if new_type is not None and new_type != result.chart_type:
            return self._rebuild_with_type(result, new_type)

        # Work on a deep copy of the ECharts option
        new_option = copy.deepcopy(result.echarts_option)
        modified = False

        # 2. Switch axes
        if any(kw in inst_lower for kw in ["横着", "水平", "horizontal", "交换xy", "交换轴", "横向"]):
            new_option = self._swap_axes(new_option)
            modified = True
        if any(kw in inst_lower for kw in ["竖着", "垂直", "vertical", "纵向"]):
            new_option = self._swap_axes(new_option, force_vertical=True)
            modified = True

        # 3. Colour changes
        for colour_name, keywords in self._COLOR_KEYWORDS.items():
            if any(kw in inst_lower for kw in keywords):
                new_option["color"] = [self._COLOR_HEX[colour_name]]
                # also apply to existing series
                for s in new_option.get("series", []):
                    s["itemStyle"] = {"color": self._COLOR_HEX[colour_name]}
                modified = True
                break

        if any(kw in inst_lower for kw in ["严重度", "severity", "severity颜色"]):
            new_option["color"] = list(ColorPalette.SEVERITY.values())
            modified = True

        if any(kw in inst_lower for kw in ["彩色", "默认色", "default color", "恢复颜色"]):
            new_option["color"] = ColorPalette.DEFAULT[:]
            modified = True

        # 4. Sorting
        if any(kw in inst_lower for kw in ["降序", "desc", "从大到小"]):
            new_option = self._sort_data(new_option, descending=True)
            modified = True
        if any(kw in inst_lower for kw in ["升序", "asc", "从小到大"]):
            new_option = self._sort_data(new_option, descending=False)
            modified = True

        # 5. Show / hide labels
        if any(kw in inst_lower for kw in ["显示数值", "显示标签", "show label", "show value", "数据标签"]):
            for s in new_option.get("series", []):
                s["label"] = {"show": True}
            modified = True
        if any(kw in inst_lower for kw in ["隐藏数值", "隐藏标签", "hide label", "hide value"]):
            for s in new_option.get("series", []):
                s["label"] = {"show": False}
            modified = True

        # 6. Legend show / hide
        if any(kw in inst_lower for kw in ["隐藏图例", "hide legend"]):
            new_option["legend"] = {"show": False}
            modified = True
        if any(kw in inst_lower for kw in ["显示图例", "show legend"]):
            if "legend" in new_option:
                new_option["legend"]["show"] = True
            else:
                new_option["legend"] = {"show": True}
            modified = True

        # 7. Show percentage on pie
        if any(kw in inst_lower for kw in ["显示百分比", "百分比", "show percentage"]):
            for s in new_option.get("series", []):
                if s.get("type") == "pie":
                    s["label"] = {"formatter": "{b}: {d}%"}
            modified = True

        # 8. Filter top N
        n_match = re.search(r"前\s*(\d+)", inst_lower)
        if not n_match:
            n_match = re.search(r"top\s*(\d+)", inst_lower)
        if n_match:
            n = int(n_match.group(1))
            new_option = self._filter_top_n(new_option, n)
            modified = True

        # 9. Filter by value keyword (skip if a top-N filter was already applied)
        if not n_match:
            severity_filter = re.search(r"只看\s*([A-Za-z\u4e00-\u9fff]+)|only\s+([A-Za-z\u4e00-\u9fff]+)", inst_lower)
            if severity_filter:
                keyword_val = severity_filter.group(1) or severity_filter.group(2)
                new_option = self._filter_by_keyword(new_option, keyword_val)
                modified = True

        # 10. Area on/off for line charts
        if any(kw in inst_lower for kw in ["面积图", "填充", "area"]):
            for s in new_option.get("series", []):
                if s.get("type") == "line":
                    s["areaStyle"] = {"opacity": 0.3}
            modified = True

        if not modified:
            # unknown instruction — return original unchanged
            return result

        # Return new VizResult (shallow copy with replaced option)
        new_result = VizResult(
            chart_type=result.chart_type,
            echarts_option=new_option,
            title=result.title,
            subtitle=result.subtitle,
            confidence=result.confidence,
            alternative_types=list(result.alternative_types),
            data_summary=dict(result.data_summary),
            modifiable=result.modifiable,
            _meta=dict(result._meta),
        )
        return new_result

    # -- helpers --

    def _match_chart_type(self, text: str) -> ChartType | None:
        for keywords, ct in self._TYPE_KEYWORDS:
            if any(kw in text for kw in keywords):
                return ct
        return None

    def _rebuild_with_type(self, result: VizResult, new_type: ChartType) -> VizResult:
        """Re-build the ECharts option using the same data but a different chart type."""
        data = result._meta.get("data", [])
        dims = result._meta.get("dimension_ids", [])
        metrics = result._meta.get("metric_ids", [])
        intent = result._meta.get("intent")

        engine = VizEngine()
        new_option = engine._build_option(
            new_type, data, dims, metrics, result.title, result.subtitle, intent
        )
        return VizResult(
            chart_type=new_type,
            echarts_option=new_option,
            title=result.title,
            subtitle=result.subtitle,
            confidence=result.confidence,
            alternative_types=list(result.alternative_types),
            data_summary=dict(result.data_summary),
            modifiable=result.modifiable,
            _meta=dict(result._meta),
        )

    @staticmethod
    def _swap_axes(option: dict[str, Any], *, force_vertical: bool = False) -> dict[str, Any]:
        """Swap X and Y axes (toggle horizontal/vertical)."""
        xa = option.get("xAxis")
        ya = option.get("yAxis")
        if xa and ya:
            if force_vertical:
                # ensure category on X, value on Y
                if xa.get("type") == "value":
                    option["xAxis"], option["yAxis"] = ya, xa
            else:
                option["xAxis"], option["yAxis"] = ya, xa

        # update label positions for bar charts
        for s in option.get("series", []):
            if s.get("type") == "bar":
                horizontal = option.get("yAxis", {}).get("type") == "category"
                if "label" in s:
                    s["label"]["position"] = "right" if horizontal else "top"
        return option

    @staticmethod
    def _sort_data(option: dict[str, Any], *, descending: bool) -> dict[str, Any]:
        """Sort categorical data in axis by series values."""
        xa = option.get("xAxis") or option.get("yAxis")
        if not xa or xa.get("type") != "category":
            return option
        cats = xa.get("data", [])
        if not cats:
            return option
        series_list = option.get("series", [])
        if not series_list:
            return option

        values = series_list[0].get("data", [])
        if len(values) != len(cats):
            return option

        paired = sorted(zip(cats, values), key=lambda p: p[1] if isinstance(p[1], (int, float)) else 0, reverse=descending)
        new_cats = [p[0] for p in paired]
        new_vals = [p[1] for p in paired]

        xa["data"] = new_cats
        series_list[0]["data"] = new_vals
        return option

    @staticmethod
    def _filter_top_n(option: dict[str, Any], n: int) -> dict[str, Any]:
        """Keep only the top-N categories by first series values."""
        xa = option.get("xAxis") or option.get("yAxis")
        if not xa or xa.get("type") != "category":
            return option
        cats: list = xa.get("data", [])
        series_list = option.get("series", [])
        if not cats or not series_list:
            return option
        values = series_list[0].get("data", [])
        paired = list(zip(cats, values))
        paired.sort(key=lambda p: p[1] if isinstance(p[1], (int, float)) else 0, reverse=True)
        paired = paired[:n]
        new_cats = [p[0] for p in paired]
        new_vals = [p[1] for p in paired]

        xa["data"] = new_cats
        for s in series_list:
            s_data = s.get("data", [])
            if len(s_data) == len(cats):
                # re-filter each series by remaining cats
                cat_to_idx = {c: i for i, c in enumerate(new_cats)}
                old_cats = cats
                s["data"] = [s_data[old_cats.index(c)] for c in new_cats if c in old_cats]
        return option

    @staticmethod
    def _filter_by_keyword(option: dict[str, Any], keyword: str) -> dict[str, Any]:
        """Keep only categories whose name contains *keyword*."""
        xa = option.get("xAxis") or option.get("yAxis")
        if not xa or xa.get("type") != "category":
            return option
        cats: list = xa.get("data", [])
        keep_indices = [i for i, c in enumerate(cats) if keyword.lower() in str(c).lower()]
        new_cats = [cats[i] for i in keep_indices]
        xa["data"] = new_cats
        for s in option.get("series", []):
            s_data = s.get("data", [])
            if len(s_data) == len(cats):
                s["data"] = [s_data[i] for i in keep_indices]
        if "legend" in option and "data" in option["legend"]:
            option["legend"]["data"] = [
                d for d in option["legend"]["data"]
                if keyword.lower() in str(d).lower()
            ]
        return option
