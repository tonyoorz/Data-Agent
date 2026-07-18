import { useMemo } from "react";

import { AlertTriangle, BarChart3, FolderOpen, GitBranch, Loader2, Users } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

import { useMainDashboardData } from "../main-dashboard/useMainDashboardData";
import type { MainDashboardTicketRow } from "../main-dashboard/mainDashboardTypes";

const numberFormatter = new Intl.NumberFormat("en-US");
const DEFAULT_ANALYSIS_YEAR = "2026";

type ProjectSummaryRow = {
  name: string;
  defects: number;
  closed: number;
  pending: number;
  closureRate: number;
};

function toPercent(numerator: number, denominator: number) {
  if (denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 100);
}

function buildProjectRows(ticketRows: MainDashboardTicketRow[]): ProjectSummaryRow[] {
  const groupedRows = new Map<string, { defects: number; closed: number }>();

  ticketRows.forEach((ticket) => {
    const projectName = ticket.project.trim() || "未归类项目";
    const current = groupedRows.get(projectName) ?? { defects: 0, closed: 0 };
    current.defects += 1;
    if (ticket.isResolvedForward || ticket.isRejectedDirectly) {
      current.closed += 1;
    }
    groupedRows.set(projectName, current);
  });

  return Array.from(groupedRows.entries())
    .map(([name, row]) => ({
      name,
      defects: row.defects,
      closed: row.closed,
      pending: row.defects - row.closed,
      closureRate: toPercent(row.closed, row.defects),
    }))
    .sort((left, right) => right.defects - left.defects || left.name.localeCompare(right.name));
}

const ProjectAnalysis = () => {
  const { data, error, isLoading } = useMainDashboardData({ years: [DEFAULT_ANALYSIS_YEAR] });
  const ticketRows = useMemo(() => data?.ticketRows ?? [], [data?.ticketRows]);
  const projectData = useMemo(() => buildProjectRows(ticketRows), [ticketRows]);
  const closedCount = projectData.reduce((total, row) => total + row.closed, 0);
  const pendingCount = projectData.reduce((total, row) => total + row.pending, 0);
  const totalDefects = projectData.reduce((total, row) => total + row.defects, 0);
  const teamCount = useMemo(
    () => new Set(ticketRows.map((row) => row.problemFinderTeam.trim()).filter(Boolean)).size,
    [ticketRows],
  );
  const resolvedForwardCount = ticketRows.filter((row) => row.isResolvedForward).length;
  const rejectedDirectlyCount = ticketRows.filter((row) => row.isRejectedDirectly).length;
  const statusData = [
    { name: "正向解决", value: resolvedForwardCount, color: "hsl(152, 60%, 40%)" },
    { name: "直接拒绝", value: rejectedDirectlyCount, color: "hsl(38, 92%, 50%)" },
    { name: "处理中", value: pendingCount, color: "hsl(215, 70%, 48%)" },
  ];
  const kpis = [
    { label: "活跃项目", value: numberFormatter.format(projectData.length), icon: FolderOpen, color: "bg-primary/10 text-primary" },
    { label: "参与团队", value: numberFormatter.format(teamCount), icon: Users, color: "bg-success/10 text-success" },
    { label: "缺陷总数", value: numberFormatter.format(totalDefects), icon: BarChart3, color: "bg-warning/10 text-warning" },
    { label: "闭环率", value: `${toPercent(closedCount, totalDefects)}%`, icon: GitBranch, color: "bg-accent/10 text-accent" },
  ];

  if (isLoading && !data) {
    return (
      <section className="dashboard-card p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在加载真实项目数据...</span>
        </div>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="dashboard-card p-6">
        <div className="flex items-start gap-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-medium">项目分析数据加载失败</p>
            <p className="mt-1 text-muted-foreground">{error instanceof Error ? error.message : "请稍后重试"}</p>
          </div>
        </div>
      </section>
    );
  }

  if (projectData.length === 0) {
    return (
      <section className="dashboard-card p-6">
        <p className="text-sm font-medium text-foreground">暂无项目数据</p>
        <p className="mt-1 text-sm text-muted-foreground">Full Picture 当前范围内没有可聚合的缺陷记录。</p>
      </section>
    );
  }

  return (
  <div className="space-y-5">
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {kpis.map((k) => {
        const Icon = k.icon;
        return (
          <div key={k.label} className="dashboard-card p-5" role="article" aria-label={k.label}>
            <div className="flex items-start justify-between">
              <div>
                <p className="kpi-label">{k.label}</p>
                <p className="kpi-value mt-1">{k.value}</p>
              </div>
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${k.color}`}>
                <Icon className="h-5 w-5" />
              </div>
            </div>
          </div>
        );
      })}
    </div>

    <div className="grid gap-5 lg:grid-cols-5">
      <div className="dashboard-card p-5 lg:col-span-3">
        <h3 className="mb-4 text-sm font-semibold text-foreground">各项目缺陷闭环对比</h3>
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={projectData} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
              <Bar dataKey="closed" name="已闭环" fill="hsl(152, 60%, 40%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="pending" name="待处理" fill="hsl(38, 92%, 50%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="dashboard-card p-5 lg:col-span-2">
        <h3 className="mb-4 text-sm font-semibold text-foreground">项目结果分布</h3>
        <div className="h-[320px] flex items-center justify-center">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={statusData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value">
                {statusData.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex justify-center gap-4">
          {statusData.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {s.name} ({toPercent(s.value, totalDefects)}%)
            </div>
          ))}
        </div>
      </div>
    </div>

    <div className="dashboard-card">
      <div className="border-b border-border px-5 py-4">
        <h3 className="text-sm font-semibold text-foreground">项目详情</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-5 py-3 font-medium text-muted-foreground">项目名称</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">总缺陷</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">已闭环</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">待处理</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">闭环率</th>
            </tr>
          </thead>
          <tbody>
            {projectData.map((p) => (
              <tr key={p.name} className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-5 py-3 font-medium text-foreground">{p.name}</td>
                <td className="px-5 py-3 font-mono text-foreground">{p.defects}</td>
                <td className="px-5 py-3 font-mono text-success">{p.closed}</td>
                <td className="px-5 py-3 font-mono text-warning">{p.pending}</td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-success" style={{ width: `${p.closureRate}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground">{p.closureRate}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
  );
};

export default ProjectAnalysis;
