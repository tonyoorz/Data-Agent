import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Award, Loader2, Target, Users, Zap } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis } from "recharts";

const TEST_TEAM_NAME = "DTSV_China";
const DEFAULT_ANALYSIS_YEAR = "2026";
const numberFormatter = new Intl.NumberFormat("en-US");

type TestTeamAnalysisRowResponse = {
  tester: string;
  total_runs: number;
  passed_runs: number;
  linked_defects: number;
  pass_rate: number;
};

type TestTeamAnalysisResponse = {
  team: string;
  rows: TestTeamAnalysisRowResponse[];
};

type TestTeamRow = {
  name: string;
  totalRuns: number;
  passedRuns: number;
  linkedDefects: number;
  passRate: number;
};

async function fetchTestTeamAnalysis(): Promise<TestTeamAnalysisResponse> {
  const response = await fetch(`/api/testing/team-analysis?team=${encodeURIComponent(TEST_TEAM_NAME)}&years=${DEFAULT_ANALYSIS_YEAR}`);
  if (!response.ok) {
    throw new Error(`Testing team analysis request failed (${response.status} ${response.statusText})`);
  }

  return response.json() as Promise<TestTeamAnalysisResponse>;
}

function toPercent(numerator: number, denominator: number) {
  if (denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 100);
}

function formatAverage(value: number) {
  return value.toFixed(1).replace(/\.0$/, "");
}

function normalizeRows(rows: TestTeamAnalysisRowResponse[]): TestTeamRow[] {
  return rows
    .filter((row) => row.tester.trim())
    .map((row) => ({
      name: row.tester.trim(),
      totalRuns: Number(row.total_runs) || 0,
      passedRuns: Number(row.passed_runs) || 0,
      linkedDefects: Number(row.linked_defects) || 0,
      passRate: Math.round(Number(row.pass_rate) || 0),
    }))
    .sort((left, right) => right.totalRuns - left.totalRuns || left.name.localeCompare(right.name));
}

const TestTeamAnalysis = () => {
  const { data, error, isLoading } = useQuery({
    queryKey: ["test-team-analysis", TEST_TEAM_NAME],
    queryFn: fetchTestTeamAnalysis,
    staleTime: 60_000,
    retry: 0,
  });
  const teamData = useMemo(() => normalizeRows(data?.rows ?? []), [data?.rows]);
  const totalRuns = teamData.reduce((total, row) => total + row.totalRuns, 0);
  const passedRuns = teamData.reduce((total, row) => total + row.passedRuns, 0);
  const linkedDefects = teamData.reduce((total, row) => total + row.linkedDefects, 0);
  const teamPassRate = toPercent(passedRuns, totalRuns);
  const bestPassRate = Math.max(0, ...teamData.map((row) => row.passRate));
  const averageRuns = teamData.length > 0 ? totalRuns / teamData.length : 0;
  const radarData = [
    { metric: "通过率", DTSV: teamPassRate },
    { metric: "关联缺陷", DTSV: toPercent(linkedDefects, totalRuns) },
    { metric: "成员覆盖", DTSV: Math.min(teamData.length * 10, 100) },
    { metric: "最佳表现", DTSV: bestPassRate },
  ];
  const kpis = [
    { label: "团队成员", value: numberFormatter.format(teamData.length), icon: Users, color: "bg-primary/10 text-primary" },
    { label: "人均执行", value: formatAverage(averageRuns), icon: Target, color: "bg-success/10 text-success" },
    { label: "最佳通过率", value: `${bestPassRate}%`, icon: Award, color: "bg-warning/10 text-warning" },
    { label: "团队通过率", value: `${teamPassRate}%`, icon: Zap, color: "bg-accent/10 text-accent" },
  ];

  if (isLoading && !data) {
    return (
      <section className="dashboard-card p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在加载 DTSV_China 测试成员数据...</span>
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
            <p className="font-medium">测试团队数据加载失败</p>
            <p className="mt-1 text-muted-foreground">{error instanceof Error ? error.message : "请稍后重试"}</p>
          </div>
        </div>
      </section>
    );
  }

  if (teamData.length === 0) {
    return (
      <section className="dashboard-card p-6">
        <p className="text-sm font-medium text-foreground">暂无 DTSV_China 测试成员数据</p>
        <p className="mt-1 text-sm text-muted-foreground">当前测试运行数据中没有可聚合的 tester 记录。</p>
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
        <h3 className="mb-4 text-sm font-semibold text-foreground">DTSV_China 测试成员执行量</h3>
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={teamData} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
              <Bar dataKey="totalRuns" name="执行" fill="hsl(215, 70%, 48%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="passedRuns" name="通过" fill="hsl(152, 60%, 40%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="dashboard-card p-5 lg:col-span-2">
        <h3 className="mb-4 text-sm font-semibold text-foreground">DTSV_China 测试能力雷达图</h3>
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData}>
              <PolarGrid stroke="hsl(220, 16%, 90%)" />
              <PolarAngleAxis dataKey="metric" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <PolarRadiusAxis tick={{ fontSize: 10 }} />
              <Radar name="DTSV_China" dataKey="DTSV" stroke="hsl(215, 70%, 48%)" fill="hsl(215, 70%, 48%)" fillOpacity={0.2} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>

    <div className="dashboard-card">
      <div className="border-b border-border px-5 py-4">
        <h3 className="text-sm font-semibold text-foreground">DTSV_China 成员执行明细</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-5 py-3 font-medium text-muted-foreground">成员</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">执行数</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">通过数</th>
              <th className="px-5 py-3 font-medium text-muted-foreground">通过率</th>
            </tr>
          </thead>
          <tbody>
            {teamData.map((t) => (
              <tr key={t.name} className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-5 py-3 font-medium text-foreground">{t.name}</td>
                <td className="px-5 py-3 font-mono text-foreground">{t.totalRuns}</td>
                <td className="px-5 py-3 font-mono text-success">{t.passedRuns}</td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-16 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${t.passRate}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground">{t.passRate}%</span>
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

export default TestTeamAnalysis;
