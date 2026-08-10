import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Repeat, TrendingUp } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ScatterChart, Scatter, ZAxis } from "recharts";

const numberFormatter = new Intl.NumberFormat("en-US");
const MAX_HIGH_FREQUENCY_ROWS = 12;
const DEFAULT_ANALYSIS_YEAR = "2026";

const severityColor: Record<string, string> = {
  Critical: "bg-destructive/10 text-destructive",
  High: "bg-warning/10 text-warning",
  Medium: "bg-primary/10 text-primary",
  Low: "bg-muted text-muted-foreground",
};

const severityRank: Record<string, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

type DefectFrequencyRow = {
  module: string;
  count: number;
  severity: keyof typeof severityRank;
};

type DefectHighFrequencyPayload = {
  overview: {
    module_count: number;
    repeat_rate: number;
    critical_count: number;
    total_count: number;
  };
  frequency_rows: DefectFrequencyRow[];
};

async function fetchDefectHighFrequencyAnalysis(): Promise<DefectHighFrequencyPayload> {
  const response = await fetch(`/api/full-picture/defect-high-frequency-analysis?years=${DEFAULT_ANALYSIS_YEAR}&limit=${MAX_HIGH_FREQUENCY_ROWS}`);
  if (!response.ok) {
    throw new Error(`Defect high-frequency request failed (${response.status} ${response.statusText})`);
  }

  return response.json() as Promise<DefectHighFrequencyPayload>;
}

function toPercent(numerator: number, denominator: number) {
  if (denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 100);
}

const DefectHighFreq = () => {
  const { data, error, isLoading } = useQuery({
    queryKey: ["defect-high-frequency-analysis", MAX_HIGH_FREQUENCY_ROWS],
    queryFn: fetchDefectHighFrequencyAnalysis,
    staleTime: 60_000,
    retry: 0,
  });
  const freqData = useMemo(() => data?.frequency_rows ?? [], [data?.frequency_rows]);
  const visibleFreqData = freqData.slice(0, MAX_HIGH_FREQUENCY_ROWS);
  const repeatData = visibleFreqData.map((row, index) => ({
    x: index + 1,
    y: row.count,
    z: Math.max(row.count - 1, 1),
    name: row.module,
  }));
  const kpis = [
    { label: "高频模块", value: numberFormatter.format(data?.overview.module_count ?? 0), icon: Repeat, color: "bg-destructive/10 text-destructive" },
    { label: "重复缺陷率", value: `${data?.overview.repeat_rate ?? 0}%`, icon: TrendingUp, color: "bg-warning/10 text-warning" },
    { label: "关键缺陷", value: numberFormatter.format(data?.overview.critical_count ?? 0), icon: AlertTriangle, color: "bg-primary/10 text-primary" },
  ];

  if (isLoading && !data) {
    return (
      <section className="dashboard-card p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在加载真实高频缺陷数据...</span>
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
            <p className="font-medium">缺陷高频数据加载失败</p>
            <p className="mt-1 text-muted-foreground">{error instanceof Error ? error.message : "请稍后重试"}</p>
          </div>
        </div>
      </section>
    );
  }

  if (freqData.length === 0) {
    return (
      <section className="dashboard-card p-6">
        <p className="text-sm font-medium text-foreground">暂无高频缺陷数据</p>
        <p className="mt-1 text-sm text-muted-foreground">Full Picture 当前范围内没有可按 ECU 聚合的缺陷记录。</p>
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
        <h3 className="mb-4 text-sm font-semibold text-foreground">缺陷高频模块排名</h3>
        <div className="h-[340px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={visibleFreqData} layout="vertical" barSize={18}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <YAxis dataKey="module" type="category" width={90} tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
              <Bar dataKey="count" name="缺陷数" fill="hsl(0, 72%, 51%)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="dashboard-card p-5">
        <h3 className="mb-4 text-sm font-semibold text-foreground">缺陷频次与重复率气泡图</h3>
        <div className="h-[340px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
              <XAxis dataKey="x" name="模块" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <YAxis dataKey="y" name="缺陷数" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <ZAxis dataKey="z" range={[100, 600]} name="重复次数" />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
              <Scatter data={repeatData} fill="hsl(215, 70%, 48%)" fillOpacity={0.7} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>

    <div className="dashboard-card">
      <div className="border-b border-border px-5 py-4">
        <h3 className="text-sm font-semibold text-foreground">高频缺陷详情</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-5 py-3 font-medium text-muted-foreground">模块</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">缺陷数</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">严重程度</th>
            </tr>
          </thead>
          <tbody>
            {visibleFreqData.map((d) => (
              <tr key={d.module} className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-5 py-3 font-medium text-foreground">{d.module}</td>
                <td className="px-5 py-3 font-mono text-foreground">{d.count}</td>
                <td className="px-5 py-3">
                  <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${severityColor[d.severity]}`}>
                    {d.severity}
                  </span>
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

export default DefectHighFreq;
