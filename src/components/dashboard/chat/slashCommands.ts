import { BarChart3, Bug, Compass, FileBarChart, GaugeCircle, LineChart, TrendingUp, type LucideIcon } from "lucide-react";

export interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  prompt: string;
  icon: LucideIcon;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "top-issue", label: "/Top Issue 诊断", hint: "近三月上升最快的问题模块 + 根因假设", prompt: "请基于近三个月的 Top Issue 数据，识别上升最快的三个问题模块并给出根因假设。", icon: TrendingUp },
  { id: "coverage", label: "/覆盖率风险面", hint: "低于阈值的模块 + 补测顺序", prompt: "覆盖率低于 70% 的模块有哪些？请按业务影响排序，并建议本周补测顺序。", icon: GaugeCircle },
  { id: "defect-freq", label: "/高频缺陷根因", hint: "最近一周新增缺陷的 ECU 聚类与回归关联", prompt: "在缺陷高频分析里，最近一周新增缺陷集中在哪些 ECU？是否与某次回归提交相关？", icon: Bug },
  { id: "team", label: "/团队产能复盘", hint: "各小组执行效率与缺陷发现率对比", prompt: "对比各测试小组的执行效率与缺陷发现率，输出一份本周复盘要点。", icon: Compass },
  { id: "weekly", label: "/生成周报", hint: "本周质量摘要（KPI / 风险 / 建议）", prompt: "请基于本周仪表盘数据生成一份精炼周报，包含 KPI 摘要、3 个核心风险与建议下一步。", icon: FileBarChart },
  { id: "trend", label: "/趋势预测", hint: "缺陷趋势外推 2 周", prompt: "基于过去 8 周的缺陷与解决趋势，预测未来 2 周可能的走势并指出最大不确定性。", icon: LineChart },
  { id: "explain-chart", label: "/解释当前图表", hint: "总结当前页可视化的关键洞察", prompt: "请总结我当前所在页面图表的关键洞察，3 条以内。", icon: BarChart3 },
];
