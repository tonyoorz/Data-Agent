"""
DataStoryteller — 数据故事化引擎

把冰冷的数字变成有业务含义的故事。

核心能力:
1. 数字解读 — "42 个 Critical" → "42 个安全相关缺陷，需要立即处理"
2. 趋势分析 — 数据走势 → 上升/下降/平稳 + 可能原因
3. 对比洞察 — 分布数据 → TOP1 vs 平均水平 / 集中度分析
4. 行动建议 — 基于数据特征给出推荐行动

设计原则:
- 数据驱动，不做无依据推测
- 中文表达，符合汽车测试行业用语
- 简洁有力，不啰嗦
- 带数字引用，方便验证
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, List, Dict, Any, Tuple
from enum import Enum


class StoryType(str, Enum):
    COUNT = "count"           # 计数结果解读
    TREND = "trend"           # 趋势解读
    DISTRIBUTION = "distribution"  # 分布解读
    RANKING = "ranking"       # 排名解读
    COMPARISON = "comparison"  # 对比解读
    SUMMARY = "summary"       # 汇总解读


@dataclass
class StoryResult:
    """数据故事结果"""
    headline: str = ""        # 核心结论（一句话）
    body: str = ""            # 详细解读
    insights: List[str] = None  # 关键洞察列表
    recommendation: str = ""  # 行动建议
    story_type: str = ""

    def __post_init__(self):
        if self.insights is None:
            self.insights = []

    def to_dict(self) -> dict:
        return {
            "headline": self.headline,
            "body": self.body,
            "insights": self.insights,
            "recommendation": self.recommendation,
            "story_type": self.story_type,
        }

    def to_markdown(self) -> str:
        """渲染为 Markdown 格式"""
        parts = [f"### {self.headline}"]
        
        if self.body:
            parts.append(self.body)
        
        if self.insights:
            parts.append("**关键洞察：**")
            for i, insight in enumerate(self.insights, 1):
                parts.append(f"{i}. {insight}")
        
        if self.recommendation:
            parts.append(f"💡 **建议：** {self.recommendation}")
        
        return "\n\n".join(parts)


class DataStoryteller:
    """
    数据故事化引擎
    
    输入: 查询结果数据（行/列/统计量）
    输出: 有业务含义的故事化文本
    """

    # 严重度业务含义
    SEVERITY_MEANING = {
        "Critical": "安全相关/法规不满足，需要立即处理",
        "Major": "功能降级，影响用户使用",
        "Minor": "外观/体验问题，不影响核心功能",
    }

    # 状态业务含义
    STATUS_MEANING = {
        "New": "新建未分配",
        "Open": "已分配待处理",
        "In Progress": "正在修复中",
        "Fixed": "已修复待验证",
        "Closed": "已验证关闭",
        "Rejected": "已拒绝（非缺陷）",
        "Deferred": "延后处理",
    }

    # 活跃状态
    ACTIVE_STATUSES = {"New", "Open", "In Progress"}
    RESOLVED_STATUSES = {"Fixed", "Closed"}

    def tell_count(
        self,
        count: int,
        question: str = "",
        context: Optional[Dict[str, Any]] = None,
    ) -> StoryResult:
        """
        解读计数查询结果
        
        Args:
            count: 缺陷数量
            question: 原始问题
            context: 额外上下文（severity, project, ecu 等）
        """
        ctx = context or {}
        severity = ctx.get("severity", "")
        project = ctx.get("project", "")
        ecu = ctx.get("ecu", "")
        time_range = ctx.get("time_range", "")
        
        # 构建标题
        conditions = []
        if project:
            conditions.append(project)
        if severity:
            conditions.append(severity)
        if ecu:
            conditions.append(f"{ecu}相关")
        if time_range:
            conditions.append(time_range)
        
        prefix = "、".join(conditions) if conditions else "查询范围内"
        
        # 严重度解读
        severity_note = ""
        if severity and severity in self.SEVERITY_MEANING:
            severity_note = f"（{self.SEVERITY_MEANING[severity]}）"
        
        headline = f"{prefix}共有 **{count}** 个缺陷{severity_note}"
        
        # 正文
        body_parts = []
        body_parts.append(f"根据查询条件，符合条件的缺陷共 {count} 个。")
        
        insights = []
        
        # 数量级别解读
        if count == 0:
            insights.append("✅ 零缺陷 — 当前条件范围内表现良好")
        elif count <= 5:
            insights.append(f"数量较少（{count}个），处于可控范围")
        elif count <= 20:
            insights.append(f"数量中等（{count}个），建议关注")
        elif count <= 50:
            insights.append(f"数量偏多（{count}个），建议优先处理")
        else:
            insights.append(f"⚠️ 数量较多（{count}个），需要重点关注")
        
        # 行动建议
        recommendation = ""
        if severity == "Critical" and count > 0:
            recommendation = f"Critical 缺陷需立即分配责任人，建议 24h 内响应"
        elif count > 20:
            recommendation = "建议按优先级排序，集中处理 TOP 问题"
        elif count == 0:
            recommendation = "继续保持，定期复查"
        
        return StoryResult(
            headline=headline,
            body=" ".join(body_parts),
            insights=insights,
            recommendation=recommendation,
            story_type=StoryType.COUNT.value,
        )

    def tell_trend(
        self,
        data: List[Dict[str, Any]],
        time_field: str = "period",
        value_field: str = "count",
        question: str = "",
    ) -> StoryResult:
        """
        解读趋势查询结果
        
        Args:
            data: 时间序列数据 [{period: "2026-01", count: 30}, ...]
        """
        if not data:
            return StoryResult(
                headline="暂无趋势数据",
                story_type=StoryType.TREND.value,
            )
        
        values = [row.get(value_field, 0) for row in data]
        periods = [row.get(time_field, "") for row in data]
        
        total = sum(values)
        avg = total / len(values) if values else 0
        latest = values[-1] if values else 0
        first = values[0] if values else 0
        
        # 趋势方向
        if len(values) >= 2:
            change_pct = ((latest - first) / first * 100) if first > 0 else 0
            if latest > first * 1.15:
                direction = "上升"
                arrow = "📈"
            elif latest < first * 0.85:
                direction = "下降"
                arrow = "📉"
            else:
                direction = "平稳"
                arrow = "➡️"
        else:
            change_pct = 0
            direction = "数据不足"
            arrow = ""
        
        headline = f"趋势分析：{arrow} {direction}趋势，共 {total} 个缺陷，月均 {avg:.1f} 个"
        
        insights = []
        
        # 趋势解读
        if direction == "上升":
            insights.append(f"⚠️ 缺陷数量呈上升趋势（{periods[0]}: {first} → {periods[-1]}: {latest}，增幅 {change_pct:+.1f}%）")
        elif direction == "下降":
            insights.append(f"✅ 缺陷数量呈下降趋势（{periods[0]}: {first} → {periods[-1]}: {latest}，降幅 {change_pct:+.1f}%）")
        else:
            insights.append(f"缺陷数量保持平稳，月均 {avg:.1f} 个")
        
        # 峰值
        if len(values) > 1:
            max_val = max(values)
            max_idx = values.index(max_val)
            min_val = min(values)
            min_idx = values.index(min_val)
            
            if max_val != min_val:
                insights.append(f"峰值出现在 {periods[max_idx]}（{max_val}个），低谷在 {periods[min_idx]}（{min_val}个）")
        
        # 波动
        if len(values) >= 3:
            import statistics
            stdev = statistics.stdev(values)
            cv = stdev / avg if avg > 0 else 0
            if cv > 0.5:
                insights.append(f"波动较大（标准差 {stdev:.1f}），建议分析异常月份的原因")
        
        recommendation = ""
        if direction == "上升" and latest > avg:
            recommendation = "趋势恶化，建议排查最近变更（新功能/新版本），加强测试覆盖"
        elif direction == "下降":
            recommendation = "趋势改善，总结当前做法经验，继续保持"
        elif avg > 30:
            recommendation = "月均数量偏高，建议从TOP问题入手进行根因分析"
        
        return StoryResult(
            headline=headline,
            insights=insights,
            recommendation=recommendation,
            story_type=StoryType.TREND.value,
        )

    def tell_distribution(
        self,
        data: List[Dict[str, Any]],
        label_field: str = "label",
        value_field: str = "count",
        dimension: str = "",
        question: str = "",
    ) -> StoryResult:
        """
        解读分布查询结果
        
        Args:
            data: 分布数据 [{label: "Critical", count: 30}, ...]
            dimension: 分布维度名（severity/project/ecu 等）
        """
        if not data:
            return StoryResult(
                headline=f"按{dimension}分布分析：暂无数据",
                story_type=StoryType.DISTRIBUTION.value,
            )
        
        total = sum(row.get(value_field, 0) for row in data)
        sorted_data = sorted(data, key=lambda x: x.get(value_field, 0), reverse=True)
        
        top = sorted_data[0]
        top_label = top.get(label_field, "")
        top_count = top.get(value_field, 0)
        top_pct = top_count / total * 100 if total > 0 else 0
        
        headline = f"按{dimension}分布：共 {len(data)} 个分组，{top_label} 占比最高（{top_count}/{total}，{top_pct:.1f}%）"
        
        insights = []
        
        # TOP 3
        top3 = sorted_data[:3]
        top3_count = sum(r.get(value_field, 0) for r in top3)
        top3_pct = top3_count / total * 100 if total > 0 else 0
        insights.append(f"TOP3 占 {top3_pct:.1f}%（{top3_count}/{total}）")
        
        # 集中度
        if top_pct > 50:
            insights.append(f"📊 高度集中：{top_label} 超过总量一半（{top_pct:.1f}%），建议优先关注")
        elif top_pct < 25 and len(data) > 3:
            insights.append(f"📊 较为分散：最大分组仅 {top_pct:.1f}%，问题分布均匀")
        
        # 零值检测
        zero_groups = [r for r in data if r.get(value_field, 0) == 0]
        if zero_groups:
            zero_labels = [r.get(label_field, "") for r in zero_groups]
            insights.append(f"零缺陷分组：{', '.join(zero_labels)}")
        
        # 严重度特殊解读
        if dimension.lower() == "severity":
            critical = next((r for r in data if r.get(label_field) == "Critical"), None)
            if critical and critical.get(value_field, 0) > 0:
                insights.append(f"🔴 Critical {critical[value_field]}个 — 安全/法规风险，需立即处理")
        
        recommendation = ""
        if top_pct > 50:
            recommendation = f"集中解决 {top_label} 的问题可以大幅降低总量"
        elif len(data) > 5:
            recommendation = "问题分散在多个维度，建议按模块逐一排查"
        
        body = "分布明细：\n"
        for r in top3:
            label = r.get(label_field, "")
            count = r.get(value_field, 0)
            pct = count / total * 100 if total > 0 else 0
            body += f"  - {label}: {count} ({pct:.1f}%)\n"
        
        return StoryResult(
            headline=headline,
            body=body,
            insights=insights,
            recommendation=recommendation,
            story_type=StoryType.DISTRIBUTION.value,
        )

    def tell_ranking(
        self,
        data: List[Dict[str, Any]],
        label_field: str = "label",
        value_field: str = "count",
        rank_by: str = "",
        question: str = "",
    ) -> StoryResult:
        """
        解读排名查询结果
        """
        if not data:
            return StoryResult(
                headline=f"按{rank_by}排名：暂无数据",
                story_type=StoryType.RANKING.value,
            )
        
        total = sum(row.get(value_field, 0) for row in data)
        top = data[0]
        top_label = top.get(label_field, "")
        top_count = top.get(value_field, 0)
        
        headline = f"TOP {len(data)} 排名：第一是 {top_label}（{top_count}个）"
        
        insights = []
        
        # TOP vs 平均
        avg = total / len(data) if data else 0
        if top_count > avg * 2:
            insights.append(f"🔴 {top_label} 远超平均水平（{top_count} vs 均值 {avg:.1f}），是突出热点")
        
        # 差距分析
        if len(data) >= 2:
            second = data[1]
            gap = top_count - second.get(value_field, 0)
            if gap > top_count * 0.3:
                insights.append(f"第一名与第二名差距明显（{gap}个），问题高度集中在 {top_label}")
        
        # 逐条列出
        body = "排名明细：\n"
        for i, r in enumerate(data, 1):
            label = r.get(label_field, "")
            count = r.get(value_field, 0)
            pct = count / total * 100 if total > 0 else 0
            body += f"  {i}. {label}: {count} ({pct:.1f}%)\n"
        
        recommendation = f"建议优先处理 {top_label} 的问题"
        
        return StoryResult(
            headline=headline,
            body=body,
            insights=insights,
            recommendation=recommendation,
            story_type=StoryType.RANKING.value,
        )

    def tell_summary(
        self,
        stats: Dict[str, Any],
        question: str = "",
    ) -> StoryResult:
        """
        解读仪表盘汇总数据
        
        Args:
            stats: {total, active, critical, resolved, ...}
        """
        total = stats.get("total", 0)
        active = stats.get("active", 0)
        critical = stats.get("critical", 0)
        resolved = stats.get("resolved", 0)
        
        resolve_rate = resolved / total * 100 if total > 0 else 0
        active_rate = active / total * 100 if total > 0 else 0
        critical_rate = critical / total * 100 if total > 0 else 0
        
        headline = f"仪表盘：共 {total} 个缺陷，活跃 {active}（{active_rate:.1f}%），Critical {critical}，已解决 {resolved}（{resolve_rate:.1f}%）"
        
        insights = []
        
        if critical > 0:
            insights.append(f"🔴 {critical} 个未关闭 Critical 缺陷需立即关注")
        
        if resolve_rate >= 80:
            insights.append(f"✅ 解决率 {resolve_rate:.1f}%，整体进展良好")
        elif resolve_rate >= 50:
            insights.append(f"⏳ 解决率 {resolve_rate:.1f}%，仍有较多待处理")
        else:
            insights.append(f"⚠️ 解决率仅 {resolve_rate:.1f}%，积压较多")
        
        if active_rate > 50:
            insights.append(f"活跃缺陷占比 {active_rate:.1f}%，处理速度可能跟不上新增速度")
        
        recommendation = ""
        if critical > 0:
            recommendation = "优先关闭 Critical 缺陷，建议 24h 内分配责任人"
        elif active_rate > 60:
            recommendation = "增加人力投入或调整优先级，减少积压"
        elif resolve_rate >= 80:
            recommendation = "保持当前节奏，持续监控新增缺陷趋势"
        
        return StoryResult(
            headline=headline,
            insights=insights,
            recommendation=recommendation,
            story_type=StoryType.SUMMARY.value,
        )

    def tell(
        self,
        story_type: str,
        data: Any,
        **kwargs,
    ) -> StoryResult:
        """
        统一入口，根据类型分发到对应方法
        """
        if story_type == StoryType.COUNT.value:
            return self.tell_count(data, **kwargs)
        elif story_type == StoryType.TREND.value:
            return self.tell_trend(data, **kwargs)
        elif story_type == StoryType.DISTRIBUTION.value:
            return self.tell_distribution(data, **kwargs)
        elif story_type == StoryType.RANKING.value:
            return self.tell_ranking(data, **kwargs)
        elif story_type == StoryType.SUMMARY.value:
            return self.tell_summary(data, **kwargs)
        else:
            return StoryResult(
                headline=str(data),
                story_type="unknown",
            )
