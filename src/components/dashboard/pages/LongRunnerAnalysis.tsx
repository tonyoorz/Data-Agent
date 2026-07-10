import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, Clock, Loader2, Timer } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";

const LONG_RUNNER_LIMIT = 12;
const DEFAULT_ANALYSIS_YEAR = "2026";

type LongRunnerItem = {
  id: string;
  title: string;
  days: number;
  project: string;
  status: string;
  month: string;
};

type LongRunnerApiPayload = {
  overview: {
    average_days: number;
    overdue_count: number;
    severe_overdue_count: number;
    total_count: number;
  };
  trend: Array<{
    month: string;
    avg_days: number;
    max_days: number;
  }>;
  distribution: Array<{
    range: string;
    count: number;
  }>;
  long_runner_rows: Array<{
    ticket_id: string;
    ticket_name: string;
    age_days: number;
    project: string;
    status: string;
  }>;
};

async function fetchLongRunnerAnalysis(): Promise<LongRunnerApiPayload> {
  const response = await fetch(`/api/full-picture/long-runner-analysis?years=${DEFAULT_ANALYSIS_YEAR}&limit=${LONG_RUNNER_LIMIT}`);
  if (!response.ok) {
    throw new Error(`Long runner analysis request failed (${response.status} ${response.statusText})`);
  }

  return response.json() as Promise<LongRunnerApiPayload>;
}

function formatAverageDays(value: number) {
  return `${value.toFixed(1)}天`;
}

const LongRunnerAnalysis = () => {
  const { data, error, isLoading } = useQuery({
    queryKey: ["long-runner-analysis", LONG_RUNNER_LIMIT],
    queryFn: fetchLongRunnerAnalysis,
    staleTime: 60_000,
    retry: 0,
  });
  const longItems = useMemo<LongRunnerItem[]>(() => {
    return (data?.long_runner_rows ?? []).map((row) => ({
      id: row.ticket_id,
      title: row.ticket_name,
      days: row.age_days,
      project: row.project || "-",
      status: row.status || "-",
      month: "",
    }));
  }, [data?.long_runner_rows]);
  const trendData = useMemo(() => {
    return (data?.trend ?? []).map((row) => ({
      month: row.month,
      avg: row.avg_days,
      max: row.max_days,
    }));
  }, [data?.trend]);
  const distributionData = data?.distribution ?? [];
  const averageDays = data?.overview.average_days ?? 0;
  const overdueCount = data?.overview.overdue_count ?? 0;
  const severeOverdueCount = data?.overview.severe_overdue_count ?? 0;
  const kpis = [
    { label: "平均解决周期", value: formatAverageDays(averageDays), icon: Clock, color: "bg-primary/10 text-primary" },
    { label: "超期缺陷", value: String(overdueCount), icon: Timer, color: "bg-warning/10 text-warning" },
    { label: "严重超期", value: String(severeOverdueCount), icon: AlertCircle, color: "bg-destructive/10 text-destructive" },
  ];

  if (isLoading && !data) {
    return (
      <section className="dashboard-card p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在加载真实长周期数据...</span>
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
            <p className="font-medium">长周期数据加载失败</p>
            <p className="mt-1 text-muted-foreground">{error instanceof Error ? error.message : "请稍后重试"}</p>
          </div>
        </div>
      </section>
    );
  }

  if (longItems.length === 0) {
    return (
      <section className="dashboard-card p-6">
        <p className="text-sm font-medium text-foreground">暂无长周期数据</p>
        <p className="mt-1 text-sm text-muted-foreground">Full Picture 当前范围内没有同时具备创建时间和最近票据日期的缺陷记录。</p>
      </section>
    );
  }

  return (
  <div className="space-y-5">
    <div className="grid grid-cols-3 gap-4">
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

    <div className="grid gap-5 lg:grid-cols-2">
      <div className="dashboard-card p-5">
        <h3 className="mb-4 text-sm font-semibold text-foreground">解决周期趋势</h3>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
              <Line type="monotone" dataKey="avg" name="平均天数" stroke="hsl(215, 70%, 48%)" strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="max" name="最大天数" stroke="hsl(0, 72%, 51%)" strokeWidth={2} dot={{ r: 3 }} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="dashboard-card p-5">
        <h3 className="mb-4 text-sm font-semibold text-foreground">周期分布</h3>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={distributionData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
              <XAxis dataKey="range" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
              <Bar dataKey="count" name="缺陷数" fill="hsl(215, 70%, 48%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>

    <div className="dashboard-card">
      <div className="border-b border-border px-5 py-4">
        <h3 className="text-sm font-semibold text-foreground">长周期缺陷列表</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-5 py-3 font-medium text-muted-foreground">缺陷ID</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">标题</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">持续天数</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">项目</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">状态</th>
            </tr>
          </thead>
          <tbody>
            {longItems.map((item) => (
              <tr key={item.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-5 py-3 font-mono text-primary">{item.id}</td>
                <td className="px-5 py-3 font-medium text-foreground">{item.title}</td>
                <td className="px-5 py-3">
                  <span className={`font-mono ${item.days > 50 ? "text-destructive" : item.days > 30 ? "text-warning" : "text-foreground"}`}>
                    {item.days}天
                  </span>
                </td>
                <td className="px-5 py-3 text-muted-foreground">{item.project}</td>
                <td className="px-5 py-3">
                  <span className="inline-flex rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{item.status}</span>
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

export default LongRunnerAnalysis;
