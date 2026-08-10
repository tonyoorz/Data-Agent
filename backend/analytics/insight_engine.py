"""主动洞察引擎 — 自动检测查询结果中的异常、趋势、集中度、对比、风险和阈值。

从 ``query_result`` 中自动运行多个检测器，返回排序后的 :class:`Insight` 列表，
并可通过 :class:`InsightReport` 生成自然语言总结和建议行动。
"""
from __future__ import annotations

import math
import uuid
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Sequence

try:
    import numpy as np
except ImportError:  # pragma: no cover — numpy is a declared dependency
    np = None  # type: ignore[assignment]

from backend.analytics.ontology import OntologyCatalog, load_ontology


# ──────────────────────────────────────────────
# 枚举
# ──────────────────────────────────────────────


class InsightType(Enum):
    ANOMALY = "anomaly"
    TREND = "trend"
    CONCENTRATION = "concentration"
    COMPARISON = "comparison"
    RISK = "risk"
    THRESHOLD = "threshold"


class InsightSeverity(Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


_SEVERITY_ORDER = {
    InsightSeverity.CRITICAL: 3,
    InsightSeverity.WARNING: 2,
    InsightSeverity.INFO: 1,
}


# ──────────────────────────────────────────────
# 数据类
# ──────────────────────────────────────────────


@dataclass
class Insight:
    """单条洞察。"""

    id: str
    type: InsightType
    severity: InsightSeverity
    title: str
    description: str
    dimension: str
    metric: str
    data: dict[str, Any]
    confidence: float
    recommendation: str
    follow_up_query: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["type"] = self.type.value
        d["severity"] = self.severity.value
        return d


@dataclass
class InsightReport:
    """洞察报告 — 包含排序后的洞察列表和自然语言总结。"""

    query_context: dict[str, Any]
    insights: list[Insight]
    summary: str
    suggested_actions: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "query_context": self.query_context,
            "insights": [i.to_dict() for i in self.insights],
            "summary": self.summary,
            "suggested_actions": self.suggested_actions,
        }

    def has_critical(self) -> bool:
        return any(i.severity is InsightSeverity.CRITICAL for i in self.insights)

    def has_warning(self) -> bool:
        return any(i.severity is InsightSeverity.WARNING for i in self.insights)


# ──────────────────────────────────────────────
# 辅助函数
# ──────────────────────────────────────────────


_TIME_PREFIXES = ("time.", "date.", "week", "month", "year", "_time", "time_")

_TIME_KEYWORDS = ("time", "date", "week", "month", "year")

_NUMERIC_METRIC_FIELDS = (
    "count", "total", "sum", "avg", "mean", "rate", "ratio",
    "value", "amount", "ddp", "cwa",
)


def _is_time_dimension(dim_name: str) -> bool:
    lower = dim_name.lower()
    # 检查前缀和关键词
    return any(lower.startswith(p) for p in _TIME_PREFIXES) or any(kw in lower for kw in _TIME_KEYWORDS)


def _is_numeric(value: Any) -> bool:
    if value is None or isinstance(value, bool):
        return False
    return isinstance(value, (int, float))


def _safe_float(value: Any) -> float | None:
    if _is_numeric(value):
        return float(value)
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return None


def _extract_metric_fields(rows: list[dict[str, Any]]) -> list[str]:
    """启发式地找出可能包含 metric 数值的列。"""
    numeric_cols: set[str] = set()
    for row in rows[:50]:
        for k, v in row.items():
            if _is_numeric(v):
                numeric_cols.add(k)
    # 排除明显的 id 列
    return sorted(
        c
        for c in numeric_cols
        if not c.lower().endswith("_id") and c.lower() not in {"id", "mr_id", "ticket_id", "test_id"}
    )


def _extract_dimension_fields(rows: list[dict[str, Any]]) -> list[str]:
    """启发式地找出可能用作分组的维度列。"""
    if not rows:
        return []
    candidate_dims: set[str] = set()
    for row in rows[:50]:
        for k, v in row.items():
            if isinstance(v, str) and not k.lower().endswith("_id") and k.lower() != "id":
                candidate_dims.add(k)
    return sorted(candidate_dims)


def _group_by(rows: list[dict[str, Any]], dim: str) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        key = str(row.get(dim, ""))
        if key:
            groups[key].append(row)
    return dict(groups)


def _metric_values(groups: dict[str, list[dict[str, Any]]], metric: str) -> dict[str, float]:
    """从分组中提取每个组的 metric 聚合值（count 或 sum）。"""
    result: dict[str, float] = {}
    for key, rows_in_group in groups.items():
        vals = [_safe_float(r.get(metric)) for r in rows_in_group if _safe_float(r.get(metric)) is not None]
        if vals:
            result[key] = sum(vals)
        else:
            # 如果 metric 列不存在或全空，用行数做 count
            result[key] = float(len(rows_in_group))
    return result


def _uid() -> str:
    return uuid.uuid4().hex[:12]


# ──────────────────────────────────────────────
# 检测器基类
# ──────────────────────────────────────────────


class BaseDetector:
    """检测器基类。"""

    def detect(
        self,
        rows: list[dict[str, Any]],
        *,
        metric: str,
        dimensions: list[str],
        context: dict[str, Any] | None = None,
    ) -> list[Insight]:
        raise NotImplementedError


# ──────────────────────────────────────────────
# a) AnomalyDetector
# ──────────────────────────────────────────────


class AnomalyDetector(BaseDetector):
    """异常值检测 — Z-score + IQR 双重检验。"""

    def __init__(self, *, z_threshold: float = 2.0, iqr_multiplier: float = 1.5):
        self.z_threshold = z_threshold
        self.iqr_multiplier = iqr_multiplier

    def detect(
        self,
        rows: list[dict[str, Any]],
        *,
        metric: str,
        dimensions: list[str],
        context: dict[str, Any] | None = None,
    ) -> list[Insight]:
        if len(rows) < 4:
            return []
        insights: list[Insight] = []
        for dim in dimensions:
            groups = _group_by(rows, dim)
            if len(groups) < 3:
                continue
            metric_map = _metric_values(groups, metric)
            values = list(metric_map.values())
            if len(values) < 3:
                continue
            arr = np.array(values, dtype=float) if np else values
            mean = float(np.mean(arr)) if np else sum(values) / len(values)
            std = float(np.std(arr)) if np else (sum((v - mean) ** 2 for v in values) / len(values)) ** 0.5
            sorted_vals = sorted(values)
            n = len(sorted_vals)
            q1 = sorted_vals[n // 4]
            q3 = sorted_vals[(3 * n) // 4]
            iqr = q3 - q1

            for group_key, val in metric_map.items():
                # Z-score
                z_score = (val - mean) / std if std > 0 else 0.0
                # IQR
                iqr_outlier = (
                    val < q1 - self.iqr_multiplier * iqr
                    or val > q3 + self.iqr_multiplier * iqr
                ) if iqr > 0 else False

                if abs(z_score) > self.z_threshold or iqr_outlier:
                    direction = "高于" if val > mean else "低于"
                    severity = (
                        InsightSeverity.CRITICAL
                        if abs(z_score) > 3
                        else InsightSeverity.WARNING
                    )
                    confidence = min(abs(z_score) / 4.0, 1.0) if z_score else 0.7
                    title = f"⚠️ {group_key} 的 {metric} 异常偏离"
                    description = (
                        f"⚠️ {group_key} 的 {metric} 为 {val:.1f}，"
                        f"显著{direction}平均值 {mean:.1f}"
                        f"（Z-score={z_score:.1f}）"
                    )
                    insights.append(
                        Insight(
                            id=_uid(),
                            type=InsightType.ANOMALY,
                            severity=severity,
                            title=title,
                            description=description,
                            dimension=dim,
                            metric=metric,
                            data={
                                "group_key": group_key,
                                "value": val,
                                "mean": mean,
                                "std": std,
                                "z_score": round(z_score, 2),
                                "q1": q1,
                                "q3": q3,
                                "iqr": iqr,
                            },
                            confidence=confidence,
                            recommendation=f"建议深入调查 {group_key} 的 {metric} 异常原因",
                            follow_up_query=generate_follow_up(
                                Insight(
                                    id="",
                                    type=InsightType.ANOMALY,
                                    severity=severity,
                                    title=title,
                                    description=description,
                                    dimension=dim,
                                    metric=metric,
                                    data={"group_key": group_key},
                                    confidence=confidence,
                                    recommendation="",
                                )
                            ),
                        )
                    )
        return insights


# ──────────────────────────────────────────────
# b) TrendDetector
# ──────────────────────────────────────────────


class TrendDetector(BaseDetector):
    """趋势变化检测 — 环比、连续上升/下降、移动平均线交叉。"""

    def __init__(self, *, min_periods: int = 3, change_threshold: float = 10.0):
        self.min_periods = min_periods
        self.change_threshold = change_threshold

    def detect(
        self,
        rows: list[dict[str, Any]],
        *,
        metric: str,
        dimensions: list[str],
        context: dict[str, Any] | None = None,
    ) -> list[Insight]:
        if len(rows) < 3:
            return []
        time_dims = [d for d in dimensions if _is_time_dimension(d)]
        if not time_dims:
            return []
        insights: list[Insight] = []
        for time_dim in time_dims:
            # 按 time_dim 排序
            sorted_rows = sorted(rows, key=lambda r: str(r.get(time_dim, "")))
            groups = _group_by(sorted_rows, time_dim)
            sorted_keys = sorted(groups.keys())
            if len(sorted_keys) < self.min_periods:
                continue
            metric_series = [(_metric_values({k: groups[k]}, metric).get(k, 0.0)) for k in sorted_keys]

            # — 连续上升/下降检测 —
            streak = 1
            direction: str | None = None
            for i in range(1, len(metric_series)):
                diff = metric_series[i] - metric_series[i - 1]
                cur_dir = "up" if diff > 0 else "down" if diff < 0 else "flat"
                if direction and cur_dir == direction:
                    streak += 1
                else:
                    direction = cur_dir
                    streak = 1
            if direction in ("up", "down") and streak >= self.min_periods:
                total_change = metric_series[-1] - metric_series[-streak]
                base = metric_series[-streak] if metric_series[-streak] != 0 else 1
                rate = (total_change / abs(base)) * 100
                if abs(rate) >= self.change_threshold:
                    cn_dir = "上升" if direction == "up" else "下降"
                    latest_val = metric_series[-1]
                    severity = InsightSeverity.WARNING if abs(rate) > 50 else InsightSeverity.INFO
                    title = f"📈 {metric} 连续 {streak} 期{cn_dir}"
                    description = (
                        f"📈 {metric} 在 {time_dim} 上连续 {streak} 期{cn_dir}，"
                        f"变化率 {rate:.1f}%（当前值 {latest_val:.1f}）"
                    )
                    insights.append(
                        Insight(
                            id=_uid(),
                            type=InsightType.TREND,
                            severity=severity,
                            title=title,
                            description=description,
                            dimension=time_dim,
                            metric=metric,
                            data={
                                "series": metric_series,
                                "labels": sorted_keys,
                                "streak": streak,
                                "direction": direction,
                                "change_rate": round(rate, 2),
                            },
                            confidence=min(streak / 6.0, 1.0),
                            recommendation=f"关注 {metric} 的{cn_dir}趋势是否持续",
                            follow_up_query=f"对比 {time_dim} 上 {metric} 的环比变化",
                        )
                    )

            # — 移动平均线交叉 —
            if len(metric_series) >= 5:
                window = min(3, len(metric_series) // 2)
                if window >= 2:
                    ma_short = self._moving_average(metric_series, window)
                    ma_long = self._moving_average(metric_series, window + 1) if len(metric_series) > window + 1 else None
                    if ma_long and len(ma_short) > 1 and len(ma_long) > 1:
                        # 检查最近一次交叉
                        for j in range(min(len(ma_short), len(ma_long)) - 1, 0, -1):
                            prev_diff = (ma_short[j - 1] if j - 1 < len(ma_short) else 0) - (
                                ma_long[j - 1] if j - 1 < len(ma_long) else 0
                            )
                            cur_diff = (ma_short[j] if j < len(ma_short) else 0) - (
                                ma_long[j] if j < len(ma_long) else 0
                            )
                            if prev_diff * cur_diff < 0:
                                cross_type = "金叉" if cur_diff > 0 else "死叉"
                                insights.append(
                                    Insight(
                                        id=_uid(),
                                        type=InsightType.TREND,
                                        severity=InsightSeverity.INFO,
                                        title=f"📈 {metric} 移动平均线出现{cross_type}",
                                        description=(
                                            f"📈 {metric} 的短期({window}期)和长期({window + 1}期)"
                                            f"移动平均线在 {sorted_keys[min(j, len(sorted_keys) - 1)]} "
                                            f"附近出现{cross_type}"
                                        ),
                                        dimension=time_dim,
                                        metric=metric,
                                        data={
                                            "ma_short": ma_short,
                                            "ma_long": ma_long,
                                            "cross_type": cross_type,
                                        },
                                        confidence=0.6,
                                        recommendation=f"关注 {cross_type}后的趋势确认",
                                        follow_up_query=f"查看 {time_dim} 上 {metric} 的移动平均趋势",
                                    )
                                )
                                break

            # — 环比变化检测 —
            if len(metric_series) >= 2:
                prev_val = metric_series[-2]
                curr_val = metric_series[-1]
                if prev_val != 0:
                    change_pct = ((curr_val - prev_val) / abs(prev_val)) * 100
                    if abs(change_pct) >= self.change_threshold:
                        direction_cn = "增长" if change_pct > 0 else "下降"
                        insights.append(
                            Insight(
                                id=_uid(),
                                type=InsightType.TREND,
                                severity=InsightSeverity.WARNING if abs(change_pct) > 30 else InsightSeverity.INFO,
                                title=f"📈 {metric} 环比{direction_cn} {abs(change_pct):.1f}%",
                                description=(
                                    f"📈 {metric} 从 {prev_val:.1f} 变为 {curr_val:.1f}，"
                                    f"环比{direction_cn} {abs(change_pct):.1f}%"
                                ),
                                dimension=time_dim,
                                metric=metric,
                                data={
                                    "previous": prev_val,
                                    "current": curr_val,
                                    "change_pct": round(change_pct, 2),
                                },
                                confidence=0.75,
                                recommendation="关注环比变化是否在预期范围内",
                                follow_up_query=f"对比 {time_dim} 上 {metric} 的环比变化",
                            )
                        )

        return insights

    @staticmethod
    def _moving_average(data: list[float], window: int) -> list[float]:
        if len(data) < window:
            return []
        if np:
            arr = np.array(data, dtype=float)
            cumsum = np.cumsum(arr)
            cumsum[window:] = cumsum[window:] - cumsum[:-window]
            return (cumsum[window - 1:] / window).tolist()
        result: list[float] = []
        for i in range(len(data) - window + 1):
            result.append(sum(data[i : i + window]) / window)
        return result


# ──────────────────────────────────────────────
# c) ConcentrationDetector
# ──────────────────────────────────────────────


class ConcentrationDetector(BaseDetector):
    """集中度 / 帕累托检测。"""

    PARETO_THRESHOLD = 0.8  # 80%
    SINGLE_DOMINANCE = 0.5  # 50%

    def detect(
        self,
        rows: list[dict[str, Any]],
        *,
        metric: str,
        dimensions: list[str],
        context: dict[str, Any] | None = None,
    ) -> list[Insight]:
        if len(rows) < 3:
            return []
        insights: list[Insight] = []
        for dim in dimensions:
            groups = _group_by(rows, dim)
            if len(groups) < 2:
                continue
            metric_map = _metric_values(groups, metric)
            total = sum(metric_map.values())
            if total <= 0:
                continue

            sorted_items = sorted(metric_map.items(), key=lambda x: x[1], reverse=True)

            # 单一主导检测
            top_key, top_val = sorted_items[0]
            top_pct = top_val / total
            if top_pct >= self.SINGLE_DOMINANCE:
                severity = InsightSeverity.WARNING if top_pct >= 0.7 else InsightSeverity.INFO
                insights.append(
                    Insight(
                        id=_uid(),
                        type=InsightType.CONCENTRATION,
                        severity=severity,
                        title=f"🎯 {top_key} 贡献了 {top_pct * 100:.1f}% 的 {metric}",
                        description=(
                            f"🎯 {top_key} 贡献了 {top_pct * 100:.1f}% 的 {metric}"
                            f"（{top_val:.1f} / {total:.1f}），存在显著集中度"
                        ),
                        dimension=dim,
                        metric=metric,
                        data={
                            "top_key": top_key,
                            "top_value": top_val,
                            "total": total,
                            "percentage": round(top_pct * 100, 2),
                            "distribution": {k: v for k, v in sorted_items[:10]},
                        },
                        confidence=min(top_pct + 0.1, 1.0),
                        recommendation=f"分析 {top_key} 占比过高的根因，考虑资源均衡分配",
                        follow_up_query=f"分析 {top_key} 的根因",
                    )
                )

            # 帕累托检测 — top 20% 分组贡献 >= 80%
            n_groups = len(sorted_items)
            top_20_pct_n = max(1, math.ceil(n_groups * 0.2))
            top_20_contribution = sum(v for _, v in sorted_items[:top_20_pct_n]) / total
            if top_20_contribution >= self.PARETO_THRESHOLD and n_groups >= 5:
                top_names = [k for k, _ in sorted_items[:top_20_pct_n]]
                insights.append(
                    Insight(
                        id=_uid(),
                        type=InsightType.CONCENTRATION,
                        severity=InsightSeverity.INFO,
                        title=f"🎯 帕累托效应：前 {top_20_pct_n} 个 {dim} 贡献了 {top_20_contribution * 100:.1f}% 的 {metric}",
                        description=(
                            f"🎯 前 {top_20_pct_n} 个 {dim}（{', '.join(top_names[:3])}"
                            f"{'...' if len(top_names) > 3 else ''}）"
                            f"贡献了 {top_20_contribution * 100:.1f}% 的 {metric}，"
                            f"符合帕累托 80/20 分布"
                        ),
                        dimension=dim,
                        metric=metric,
                        data={
                            "top_groups": top_names,
                            "top_20_pct_count": top_20_pct_n,
                            "total_groups": n_groups,
                            "concentration_ratio": round(top_20_contribution, 4),
                            "distribution": {k: v for k, v in sorted_items[:10]},
                        },
                        confidence=0.7,
                        recommendation="集中资源解决头部问题可最大化效果",
                        follow_up_query=f"分析 {top_names[0]} 的根因",
                    )
                )
        return insights


# ──────────────────────────────────────────────
# d) ComparisonDetector
# ──────────────────────────────────────────────


class ComparisonDetector(BaseDetector):
    """对比差异检测 — 当 context 中有 comparison 数据时触发。"""

    def detect(
        self,
        rows: list[dict[str, Any]],
        *,
        metric: str,
        dimensions: list[str],
        context: dict[str, Any] | None = None,
    ) -> list[Insight]:
        if not context:
            return []
        comparison = context.get("comparison")
        if not comparison or not isinstance(comparison, dict):
            return []
        group_a = comparison.get("group_a") or comparison.get("a")
        group_b = comparison.get("group_b") or comparison.get("b")
        values_a = comparison.get("values_a") or comparison.get("a_values") or []
        values_b = comparison.get("values_b") or comparison.get("b_values") or []
        if not group_a or not group_b:
            return []
        insights: list[Insight] = []

        # 尝试从 comparison 数据中提取 metric 值
        val_a = comparison.get("metric_a") or comparison.get("a_metric")
        val_b = comparison.get("metric_b") or comparison.get("b_metric")
        if val_a is None and isinstance(values_a, list) and values_a:
            numeric_vals = [_safe_float(v) for v in values_a if _safe_float(v) is not None]
            val_a = sum(numeric_vals) if numeric_vals else None
        if val_b is None and isinstance(values_b, list) and values_b:
            numeric_vals = [_safe_float(v) for v in values_b if _safe_float(v) is not None]
            val_b = sum(numeric_vals) if numeric_vals else None

        # 也支持从 rows 中按 comparison dimension 拆分
        compare_dim = comparison.get("dimension")
        if val_a is None and val_b is None and compare_dim:
            groups = _group_by(rows, compare_dim)
            metric_map = _metric_values(groups, metric)
            val_a = metric_map.get(str(group_a))
            val_b = metric_map.get(str(group_b))

        if val_a is None or val_b is None:
            return []

        val_a = float(val_a)
        val_b = float(val_b)
        diff = abs(val_a - val_b)
        base = max(abs(val_a), abs(val_b), 1)
        diff_pct = (diff / base) * 100

        if diff_pct >= 5.0:
            severity = (
                InsightSeverity.CRITICAL
                if diff_pct > 50
                else InsightSeverity.WARNING
                if diff_pct > 20
                else InsightSeverity.INFO
            )
            direction = "高于" if val_a > val_b else "低于"
            insights.append(
                Insight(
                    id=_uid(),
                    type=InsightType.COMPARISON,
                    severity=severity,
                    title=f"🔍 {group_a} vs {group_b}: {metric} 差异 {diff_pct:.1f}%",
                    description=(
                        f"🔍 {group_a} vs {group_b}: {metric} 差异 {diff_pct:.1f}%"
                        f"（{val_a:.1f} vs {val_b:.1f}），{group_a} {direction} {group_b}"
                    ),
                    dimension=compare_dim or "comparison",
                    metric=metric,
                    data={
                        "group_a": group_a,
                        "group_b": group_b,
                        "value_a": val_a,
                        "value_b": val_b,
                        "diff": diff,
                        "diff_pct": round(diff_pct, 2),
                    },
                    confidence=min(diff_pct / 50.0, 1.0),
                    recommendation=f"调查 {group_a} 和 {group_b} 之间 {metric} 差异的原因",
                    follow_up_query=f"对比 {group_a} 和 {group_b} 的 {metric} 详细分布",
                )
            )
        return insights


# ──────────────────────────────────────────────
# e) RiskDetector
# ──────────────────────────────────────────────


class RiskDetector(BaseDetector):
    """风险预警检测 — 基于汽车测试领域知识。"""

    SHOWSTOPPER_SEVERITIES = {"showstopper", "1-showstopper", "critical", "s1"}
    TOP_ISSUE_SEVERITIES = {"top issue", "2-top issue", "high", "s2"}
    RISK_FIELDS = ("problem_severity", "severity", "defect_category", "solution_cluster")

    def detect(
        self,
        rows: list[dict[str, Any]],
        *,
        metric: str,
        dimensions: list[str],
        context: dict[str, Any] | None = None,
    ) -> list[Insight]:
        if not rows:
            return []
        insights: list[Insight] = []

        # — Showstopper 缺陷聚集检测 —
        insights.extend(self._detect_severity_concentration(rows, dimensions))

        # — 同一 ECU / Module 反复出现缺陷 —
        insights.extend(self._detect_recurring_defects(rows, dimensions))

        return insights

    def _detect_severity_concentration(
        self, rows: list[dict[str, Any]], dimensions: list[str]
    ) -> list[Insight]:
        insights: list[Insight] = []
        severity_field = next(
            (f for f in self.RISK_FIELDS if rows and f in rows[0]),
            None,
        )
        if not severity_field:
            return insights

        # 按 ECU/Module 分组，统计 Showstopper 数量
        ecu_dim = next(
            (d for d in dimensions if "ecu" in d.lower() or "module" in d.lower() or "assigned" in d.lower()),
            None,
        )

        showstopper_rows = [
            r for r in rows
            if str(r.get(severity_field, "")).strip().lower() in self.SHOWSTOPPER_SEVERITIES
        ]

        if ecu_dim and showstopper_rows:
            ecu_groups = _group_by(showstopper_rows, ecu_dim)
            for ecu_name, ecu_rows in ecu_groups.items():
                count = len(ecu_rows)
                if count >= 3:
                    insights.append(
                        Insight(
                            id=_uid(),
                            type=InsightType.RISK,
                            severity=InsightSeverity.CRITICAL,
                            title=f"🚨 {ecu_name} 上发现 {count} 个 Showstopper 缺陷",
                            description=(
                                f"🚨 {ecu_name} 上发现 {count} 个 Showstopper 缺陷，"
                                f"占总 Showstopper 的 {count / len(showstopper_rows) * 100:.1f}%，"
                                f"建议优先处理"
                            ),
                            dimension=ecu_dim,
                            metric="showstopper_count",
                            data={
                                "ecu_name": ecu_name,
                                "count": count,
                                "total_showstoppers": len(showstopper_rows),
                            },
                            confidence=min(count / 10.0, 1.0),
                            recommendation=f"立即组织 {ecu_name} 团队进行 Showstopper 缺陷攻关",
                            follow_up_query=f"查看 {ecu_name} 的所有缺陷详情",
                        )
                    )
        elif showstopper_rows:
            total = len(showstopper_rows)
            if total >= 5:
                insights.append(
                    Insight(
                        id=_uid(),
                        type=InsightType.RISK,
                        severity=InsightSeverity.CRITICAL,
                        title=f"🚨 共发现 {total} 个 Showstopper 缺陷",
                        description=f"🚨 本次查询共发现 {total} 个 Showstopper 缺陷，建议优先处理",
                        dimension=severity_field,
                        metric="showstopper_count",
                        data={"total_showstoppers": total},
                        confidence=0.9,
                        recommendation="优先排查所有 Showstopper 级别缺陷",
                        follow_up_query="查看所有 Showstopper 缺陷详情",
                    )
                )

        # — Top Issue 检测 —
        top_rows = [
            r for r in rows
            if str(r.get(severity_field, "")).strip().lower() in self.TOP_ISSUE_SEVERITIES
        ]
        if len(top_rows) >= 10:
            insights.append(
                Insight(
                    id=_uid(),
                    type=InsightType.RISK,
                    severity=InsightSeverity.WARNING,
                    title=f"🚨 发现 {len(top_rows)} 个 Top Issue 级别缺陷",
                    description=(
                        f"🚨 本次查询共发现 {len(top_rows)} 个 Top Issue 级别缺陷，"
                        f"建议在当前迭代中重点关注"
                    ),
                    dimension=severity_field,
                    metric="top_issue_count",
                    data={"count": len(top_rows)},
                    confidence=0.8,
                    recommendation="将 Top Issue 纳入迭代计划优先处理",
                    follow_up_query="查看所有 Top Issue 缺陷列表",
                )
            )
        return insights

    def _detect_recurring_defects(
        self, rows: list[dict[str, Any]], dimensions: list[str]
    ) -> list[Insight]:
        insights: list[Insight] = []
        # 在同一 ECU/Module 上反复出现的缺陷
        ecu_candidates = [d for d in dimensions if "ecu" in d.lower() or "module" in d.lower() or "assigned" in d.lower()]
        for ecu_dim in ecu_candidates:
            groups = _group_by(rows, ecu_dim)
            for ecu_name, ecu_rows in groups.items():
                if len(ecu_rows) >= 10:
                    # 检查是否有相同的 solution_cluster 或 defect_category 反复出现
                    cluster_field = next(
                        (f for f in ("solution_cluster", "defect_category") if ecu_rows and f in ecu_rows[0]),
                        None,
                    )
                    if cluster_field:
                        cluster_counts = Counter(str(r.get(cluster_field, "")) for r in ecu_rows)
                        top_cluster, top_count = cluster_counts.most_common(1)[0]
                        if top_count >= 5 and top_cluster:
                            insights.append(
                                Insight(
                                    id=_uid(),
                                    type=InsightType.RISK,
                                    severity=InsightSeverity.WARNING,
                                    title=f"🚨 {ecu_name} 反复出现 {top_cluster} 类问题（{top_count}次）",
                                    description=(
                                        f"🚨 {ecu_name} 上反复出现 {top_cluster} 类型的缺陷 "
                                        f"（共 {top_count} 次），可能存在系统性问题"
                                    ),
                                    dimension=ecu_dim,
                                    metric="recurring_count",
                                    data={
                                        "ecu_name": ecu_name,
                                        "cluster": top_cluster,
                                        "count": top_count,
                                        "total": len(ecu_rows),
                                    },
                                    confidence=min(top_count / 10.0, 1.0),
                                    recommendation=f"建议对 {ecu_name} 的 {top_cluster} 问题进行根因分析",
                                    follow_up_query=f"查看 {ecu_name} 的 {top_cluster} 缺陷详情",
                                )
                            )
        return insights


# ──────────────────────────────────────────────
# f) ThresholdDetector
# ──────────────────────────────────────────────


class ThresholdDetector(BaseDetector):
    """阈值 / SLA 检测 — 对比 metric 与本体中定义的目标。"""

    # 从业务知识构建的默认阈值表
    DEFAULT_THRESHOLDS: dict[str, dict[str, Any]] = {
        "ddp": {"target": 99.0, "operator": ">=", "unit": "%", "label": "DDP 缺陷检测率"},
        "cwa": {"target": 10.0, "operator": "<=", "unit": "%", "label": "CWA 缺陷拒收率"},
        "defect.rejection_rate": {"target": 10.0, "operator": "<=", "unit": "%", "label": "缺陷拒收率"},
        "defect.resolve_rate": {"target": 90.0, "operator": ">=", "unit": "%", "label": "缺陷解决率"},
        "pass_rate": {"target": 95.0, "operator": ">=", "unit": "%", "label": "测试通过率"},
        "test_pass_rate": {"target": 95.0, "operator": ">=", "unit": "%", "label": "测试通过率"},
    }

    def __init__(self, catalog: OntologyCatalog | None = None):
        self._catalog = catalog
        self._thresholds = self._load_thresholds(catalog)

    def _load_thresholds(self, catalog: OntologyCatalog | None) -> dict[str, dict[str, Any]]:
        thresholds = dict(self.DEFAULT_THRESHOLDS)
        if not catalog:
            return thresholds
        # 从 ontology constraints 中加载业务规则阈值
        for constraint in catalog.bundle.get("constraints", []):
            params = constraint.get("parameters", {})
            target = params.get("targetValue")
            if target is None:
                continue
            cid = constraint.get("id", "")
            action = constraint.get("action", "")
            operator = ">=" if "below" in action else "<=" if "exceeded" in action else ">="
            unit = params.get("unit", "")
            label = constraint.get("description", cid)
            # 提取短名称
            short = cid.replace("rule.", "")
            thresholds[short.lower()] = {
                "target": float(target),
                "operator": operator,
                "unit": unit,
                "label": label,
            }
        return thresholds

    def detect(
        self,
        rows: list[dict[str, Any]],
        *,
        metric: str,
        dimensions: list[str],
        context: dict[str, Any] | None = None,
    ) -> list[Insight]:
        insights: list[Insight] = []
        if not rows:
            return insights

        metric_lower = metric.lower()

        # 1) 直接从 context 的 summary.metrics 中检查
        summary = (context or {}).get("summary") or {}
        metrics_map = summary.get("metrics", {}) if isinstance(summary, dict) else {}

        check_targets: list[tuple[str, float]] = []

        # 从 summary metrics 中提取
        if metrics_map:
            for m_key, m_val in metrics_map.items():
                m_lower = m_key.lower()
                for thresh_key, thresh in self._thresholds.items():
                    if thresh_key in m_lower:
                        val = _safe_float(m_val)
                        if val is not None:
                            check_targets.append((thresh_key, val))

        # 2) 从 rows 中直接检查 metric 列
        if not check_targets:
            for thresh_key, thresh in self._thresholds.items():
                if thresh_key in metric_lower:
                    vals = [_safe_float(r.get(metric)) for r in rows if _safe_float(r.get(metric)) is not None]
                    if vals:
                        avg_val = sum(vals) / len(vals)
                        check_targets.append((thresh_key, avg_val))

        for thresh_key, val in check_targets:
            thresh = self._thresholds[thresh_key]
            target = thresh["target"]
            operator = thresh["operator"]
            unit = thresh.get("unit", "")
            label = thresh.get("label", thresh_key)

            violated = False
            if operator == ">=" and val < target:
                violated = True
            elif operator == "<=" and val > target:
                violated = True

            if violated:
                direction = "低于" if operator == ">=" else "高于"
                severity = (
                    InsightSeverity.CRITICAL
                    if abs(val - target) / target > 0.1
                    else InsightSeverity.WARNING
                )
                insights.append(
                    Insight(
                        id=_uid(),
                        type=InsightType.THRESHOLD,
                        severity=severity,
                        title=f"📊 {label} 当前值 {val:.1f}{unit}，{direction}目标 {target}{unit}",
                        description=(
                            f"📊 {label} 当前值 {val:.1f}{unit}，"
                            f"{direction}目标 {target}{unit}（差距 {abs(val - target):.1f}{unit}）"
                        ),
                        dimension="",
                        metric=thresh_key,
                        data={
                            "current": val,
                            "target": target,
                            "operator": operator,
                            "unit": unit,
                            "gap": round(abs(val - target), 2),
                        },
                        confidence=0.9,
                        recommendation=f"制定改进计划，将 {label} 提升至目标值 {target}{unit}",
                        follow_up_query=f"查看 {thresh_key} 的历史趋势",
                    )
                )
        return insights


# ──────────────────────────────────────────────
# NL Generator
# ──────────────────────────────────────────────


def generate_summary(insights: list[Insight], context: dict[str, Any] | None = None) -> str:
    """将洞察列表转成自然语言段落（模板化，不使用 LLM）。"""
    if not insights:
        return "本次查询未发现需要特别关注的数据模式。"

    question = ""
    if context:
        question = context.get("natural_question", "")

    critical_count = sum(1 for i in insights if i.severity is InsightSeverity.CRITICAL)
    warning_count = sum(1 for i in insights if i.severity is InsightSeverity.WARNING)
    info_count = sum(1 for i in insights if i.severity is InsightSeverity.INFO)

    parts: list[str] = []
    if question:
        parts.append(f"针对「{question}」的分析结果，")
    parts.append(f"本次查询共发现 {len(insights)} 条值得关注的数据模式：")

    summaries: list[str] = []
    for ins in insights:
        summaries.append(ins.description)

    parts.append("；".join(summaries) + "。")

    if critical_count:
        parts.append(f"\n⚠ 其中 {critical_count} 条为严重级别，建议立即处理。")
    elif warning_count:
        parts.append(f"\n其中 {warning_count} 条为警告级别，建议关注。")

    return "".join(parts)


# ──────────────────────────────────────────────
# Follow-up Query Generator
# ──────────────────────────────────────────────


def generate_follow_up(insight: Insight) -> str | None:
    """根据洞察类型生成追问建议。"""
    t = insight.type
    if t is InsightType.ANOMALY:
        group_key = insight.data.get("group_key", "")
        return f"查看 {group_key} 的详细缺陷列表"
    elif t is InsightType.TREND:
        time_dim = insight.dimension or "时间"
        metric = insight.metric
        return f"对比 {time_dim} 上 {metric} 的环比变化"
    elif t is InsightType.CONCENTRATION:
        top = insight.data.get("top_key") or insight.data.get("top_groups", ["未知"])
        if isinstance(top, list):
            top = top[0] if top else "未知"
        return f"分析 {top} 的根因"
    elif t is InsightType.COMPARISON:
        group_a = insight.data.get("group_a", "组A")
        group_b = insight.data.get("group_b", "组B")
        metric = insight.metric
        return f"对比 {group_a} 和 {group_b} 的 {metric} 详细分布"
    elif t is InsightType.RISK:
        ecu = insight.data.get("ecu_name", "")
        return f"查看 {ecu} 的所有缺陷详情" if ecu else "查看相关缺陷详情"
    elif t is InsightType.THRESHOLD:
        metric = insight.metric
        return f"查看 {metric} 的历史趋势"
    return None


# ──────────────────────────────────────────────
# 主引擎
# ──────────────────────────────────────────────


class InsightDetector:
    """主动洞察引擎 — 接收查询结果，自动运行所有检测器。"""

    def __init__(self, catalog: OntologyCatalog | None = None):
        self.catalog = catalog
        self.detectors: list[BaseDetector] = [
            AnomalyDetector(),
            TrendDetector(),
            ConcentrationDetector(),
            ComparisonDetector(),
            RiskDetector(),
            ThresholdDetector(catalog=catalog),
        ]

    def detect(
        self,
        query_result: dict[str, Any],
        *,
        context: dict[str, Any] | None = None,
    ) -> list[Insight]:
        """对查询结果自动运行所有检测器，返回排序后的洞察列表。"""
        ctx = context or {}
        rows = query_result.get("data", [])
        if not rows:
            return []

        # 确定 metric 和 dimensions
        metric_ids = ctx.get("metric_ids") or []
        dimension_ids = ctx.get("dimension_ids") or []

        # 启发式提取
        auto_metrics = _extract_metric_fields(rows)
        auto_dims = _extract_dimension_fields(rows)

        metrics_to_check = metric_ids if metric_ids else auto_metrics
        dims_to_check = dimension_ids if dimension_ids else auto_dims

        # 如果没有明确的 metric，用行数做 count
        if not metrics_to_check:
            metrics_to_check = ["count"]
        if not dims_to_check:
            dims_to_check = auto_dims or ["_all"]

        all_insights: list[Insight] = []
        for metric in metrics_to_check[:5]:  # 限制 metric 数量避免性能问题
            for detector in self.detectors:
                try:
                    all_insights.extend(
                        detector.detect(rows, metric=metric, dimensions=dims_to_check, context=ctx)
                    )
                except Exception:
                    # 单个检测器失败不应影响其他检测器
                    continue

        # 排序：severity 降序 → confidence 降序
        all_insights.sort(
            key=lambda i: (_SEVERITY_ORDER[i.severity], i.confidence),
            reverse=True,
        )

        # 去重：同 type + dimension + metric 只保留最高 severity 的
        seen: set[tuple] = set()
        deduped: list[Insight] = []
        for ins in all_insights:
            key = (ins.type, ins.dimension, ins.metric, tuple(sorted(ins.data.get("group_key", "").split()) if isinstance(ins.data.get("group_key"), str) else ()))
            # 用更简单的去重：type + title
            simple_key = (ins.type, ins.title)
            if simple_key not in seen:
                seen.add(simple_key)
                deduped.append(ins)

        return deduped

    def build_report(
        self,
        query_result: dict[str, Any],
        *,
        context: dict[str, Any] | None = None,
        max_insights: int = 5,
    ) -> InsightReport:
        """完整流程：query_result → detect → InsightReport。"""
        ctx = dict(context or {})
        insights = self.detect(query_result, context=ctx)
        top_insights = insights[:max_insights]

        summary = generate_summary(top_insights, ctx)
        suggested_actions: list[str] = []
        for ins in top_insights:
            if ins.recommendation:
                suggested_actions.append(ins.recommendation)

        return InsightReport(
            query_context={
                "natural_question": ctx.get("natural_question", ""),
                "metric_ids": ctx.get("metric_ids", []),
                "dimension_ids": ctx.get("dimension_ids", []),
                "time_range": ctx.get("time_range"),
                "row_count": len(query_result.get("data", [])),
            },
            insights=top_insights,
            summary=summary,
            suggested_actions=suggested_actions,
        )
