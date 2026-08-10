import { useMemo } from "react";

import { AlertTriangle, CheckCircle2, ListChecks, Loader2, PauseCircle, PlayCircle } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";

import {
  useCoverageAnalysisAidaStatusData,
  useCoverageAnalysisFilterOptionsData,
  useCoverageAnalysisProjectStatusData,
  useCoverageAnalysisTestcaseDetailData,
} from "../coverage-analysis/useCoverageAnalysisData";
import type {
  CoverageAnalysisAidaStatusRow,
  CoverageAnalysisProjectStatusRow,
  CoverageAnalysisTestcaseDetailRow,
} from "../coverage-analysis/coverageAnalysisTypes";

const numberFormatter = new Intl.NumberFormat("en-US");

type StatusCategory = "passed" | "failed" | "blocked" | "other";

type StatusPieRow = {
  name: string;
  value: number;
  color: string;
  category: StatusCategory;
};

type WeeklyStatusRow = {
  week: string;
  passed: number;
  failed: number;
  blocked: number;
  other: number;
};

type StatusMixRow = {
  name: string;
  passed: number;
  failed: number;
  blocked: number;
  other: number;
  total: number;
};

const statusColors: Record<StatusCategory, string> = {
  passed: "hsl(152, 60%, 40%)",
  failed: "hsl(0, 72%, 51%)",
  blocked: "hsl(38, 92%, 50%)",
  other: "hsl(220, 16%, 60%)",
};

function resolveDefaultYearSelection(years: string[]) {
  const currentYear = String(new Date().getFullYear());
  if (years.includes(currentYear)) {
    return [currentYear];
  }

  return [];
}

function classifyStatus(status: string): StatusCategory {
  const normalized = status.trim().toLocaleLowerCase();
  if (normalized.includes("pass") || normalized.includes("passed") || normalized.includes("success")) {
    return "passed";
  }
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "failed";
  }
  if (normalized.includes("block")) {
    return "blocked";
  }
  return "other";
}

function toPercent(numerator: number, denominator: number) {
  if (denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 100);
}

function buildStatusPieRows(rows: CoverageAnalysisProjectStatusRow[]): StatusPieRow[] {
  const groupedRows = new Map<string, { value: number; category: StatusCategory }>();

  rows.forEach((row) => {
    const statusName = row.status.trim() || "Unknown";
    const current = groupedRows.get(statusName) ?? {
      value: 0,
      category: classifyStatus(statusName),
    };
    current.value += row.count;
    groupedRows.set(statusName, current);
  });

  return Array.from(groupedRows.entries())
    .map(([name, row]) => ({
      name,
      value: row.value,
      color: statusColors[row.category],
      category: row.category,
    }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

function buildWeeklyRows(rows: CoverageAnalysisProjectStatusRow[]): WeeklyStatusRow[] {
  const groupedRows = new Map<string, WeeklyStatusRow>();

  rows.forEach((row) => {
    const week = row.test_week.trim() || "Unknown";
    const current = groupedRows.get(week) ?? {
      week,
      passed: 0,
      failed: 0,
      blocked: 0,
      other: 0,
    };
    current[classifyStatus(row.status)] += row.count;
    groupedRows.set(week, current);
  });

  return Array.from(groupedRows.values()).sort((left, right) => left.week.localeCompare(right.week));
}

function incrementStatusMix(row: StatusMixRow, status: string, count: number) {
  row[classifyStatus(status)] += count;
  row.total += count;
}

function buildProjectStatusRows(rows: CoverageAnalysisTestcaseDetailRow[]): StatusMixRow[] {
  return buildDetailStatusMixRows(rows, (row) => row.project, 8);
}

function buildTesterStatusRows(rows: CoverageAnalysisTestcaseDetailRow[]): StatusMixRow[] {
  return buildDetailStatusMixRows(rows, (row) => row.tester, 10);
}

function buildTestcaseStatusRows(rows: CoverageAnalysisTestcaseDetailRow[]): StatusMixRow[] {
  return buildDetailStatusMixRows(rows, (row) => `${row.test_id} - ${row.test_name}`, 10);
}

function buildDetailStatusMixRows(
  rows: CoverageAnalysisTestcaseDetailRow[],
  labelSelector: (row: CoverageAnalysisTestcaseDetailRow) => string,
  limit: number,
): StatusMixRow[] {
  const groupedRows = new Map<string, StatusMixRow>();

  rows.forEach((row) => {
    const name = labelSelector(row).trim() || "Unknown";
    const current = groupedRows.get(name) ?? { name, passed: 0, failed: 0, blocked: 0, other: 0, total: 0 };
    incrementStatusMix(current, row.status, row.count);
    groupedRows.set(name, current);
  });

  return Array.from(groupedRows.values())
    .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name))
    .slice(0, limit);
}

function buildFvStatusRows(rows: CoverageAnalysisProjectStatusRow[]): StatusMixRow[] {
  return buildProjectStatusMixRows(rows, (row) => row.fv, 10);
}

function buildFvpStatusRows(rows: CoverageAnalysisProjectStatusRow[]): StatusMixRow[] {
  return buildProjectStatusMixRows(rows, (row) => row.fvp, 10);
}

function buildProjectStatusMixRows(
  rows: CoverageAnalysisProjectStatusRow[],
  labelSelector: (row: CoverageAnalysisProjectStatusRow) => string,
  limit: number,
): StatusMixRow[] {
  const groupedRows = new Map<string, StatusMixRow>();

  rows.forEach((row) => {
    const name = labelSelector(row).trim() || "Unknown";
    const current = groupedRows.get(name) ?? { name, passed: 0, failed: 0, blocked: 0, other: 0, total: 0 };
    incrementStatusMix(current, row.status, row.count);
    groupedRows.set(name, current);
  });

  return Array.from(groupedRows.values())
    .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name))
    .slice(0, limit);
}

function buildAidaStatusRows(rows: CoverageAnalysisAidaStatusRow[]): StatusMixRow[] {
  const groupedRows = new Map<string, StatusMixRow>();

  rows.forEach((row) => {
    const name = row.top_aida.trim() || "Unknown";
    const current = groupedRows.get(name) ?? { name, passed: 0, failed: 0, blocked: 0, other: 0, total: 0 };
    incrementStatusMix(current, row.status, row.count);
    groupedRows.set(name, current);
  });

  return Array.from(groupedRows.values())
    .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name))
    .slice(0, 10);
}

function StatusMixBarCard({
  title,
  data,
  vertical = false,
}: {
  title: string;
  data: StatusMixRow[];
  vertical?: boolean;
}) {
  return (
    <div className="dashboard-card p-5">
      <h3 className="mb-4 text-sm font-semibold text-foreground">{title}</h3>
      <div className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout={vertical ? "vertical" : "horizontal"} barGap={2}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
            {vertical ? (
              <>
                <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <YAxis dataKey="name" type="category" width={132} tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              </>
            ) : (
              <>
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              </>
            )}
            <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
            <Bar dataKey="passed" name="Passed" stackId="status" fill={statusColors.passed} />
            <Bar dataKey="failed" name="Failed" stackId="status" fill={statusColors.failed} />
            <Bar dataKey="blocked" name="Blocked" stackId="status" fill={statusColors.blocked} />
            <Bar dataKey="other" name="Other" stackId="status" fill={statusColors.other} radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const TestStatusAnalysis = () => {
  const {
    data: filterOptionsData,
    error: filterOptionsError,
    isLoading: isFilterOptionsLoading,
  } = useCoverageAnalysisFilterOptionsData();
  const selectedYears = useMemo(
    () => resolveDefaultYearSelection(filterOptionsData?.years ?? []),
    [filterOptionsData?.years],
  );
  const shouldLoadStatusRows = filterOptionsData !== undefined;
  const {
    data: statusRowsData,
    error: statusRowsError,
    isLoading: isStatusRowsLoading,
  } = useCoverageAnalysisProjectStatusData(
    { years: selectedYears },
    { enabled: shouldLoadStatusRows },
  );
  const {
    data: aidaStatusRowsData,
    error: aidaStatusError,
    isLoading: isAidaStatusLoading,
  } = useCoverageAnalysisAidaStatusData(
    { years: selectedYears },
    { enabled: shouldLoadStatusRows },
  );
  const {
    data: testcaseDetailRowsData,
    error: testcaseDetailError,
    isLoading: isTestcaseDetailLoading,
  } = useCoverageAnalysisTestcaseDetailData(
    { years: selectedYears },
    { enabled: shouldLoadStatusRows },
  );
  const statusRows = statusRowsData ?? [];
  const aidaStatusRows = aidaStatusRowsData ?? [];
  const testcaseDetailRows = testcaseDetailRowsData ?? [];
  const statusPie = useMemo(() => buildStatusPieRows(statusRows), [statusRows]);
  const weeklyData = useMemo(() => buildWeeklyRows(statusRows), [statusRows]);
  const projectRows = useMemo(() => buildProjectStatusRows(testcaseDetailRows), [testcaseDetailRows]);
  const fvRows = useMemo(() => buildFvStatusRows(statusRows), [statusRows]);
  const fvpRows = useMemo(() => buildFvpStatusRows(statusRows), [statusRows]);
  const aidaRows = useMemo(() => buildAidaStatusRows(aidaStatusRows), [aidaStatusRows]);
  const testerRows = useMemo(() => buildTesterStatusRows(testcaseDetailRows), [testcaseDetailRows]);
  const testcaseRows = useMemo(() => buildTestcaseStatusRows(testcaseDetailRows), [testcaseDetailRows]);
  const totalCount = statusPie.reduce((total, row) => total + row.value, 0);
  const passedCount = statusPie
    .filter((row) => row.category === "passed")
    .reduce((total, row) => total + row.value, 0);
  const blockedCount = statusPie
    .filter((row) => row.category === "blocked")
    .reduce((total, row) => total + row.value, 0);
  const attentionCount = totalCount - passedCount;
  const kpis = [
    { label: "执行总数", value: numberFormatter.format(totalCount), icon: ListChecks, color: "bg-primary/10 text-primary" },
    { label: "需关注", value: numberFormatter.format(attentionCount), icon: PlayCircle, color: "bg-warning/10 text-warning" },
    { label: "阻塞", value: numberFormatter.format(blockedCount), icon: PauseCircle, color: "bg-destructive/10 text-destructive" },
    { label: "通过率", value: `${toPercent(passedCount, totalCount)}%`, icon: CheckCircle2, color: "bg-success/10 text-success" },
  ];

  if (
    (isFilterOptionsLoading && !filterOptionsData) ||
    (isStatusRowsLoading && !statusRowsData) ||
    (isAidaStatusLoading && !aidaStatusRowsData) ||
    (isTestcaseDetailLoading && !testcaseDetailRowsData)
  ) {
    return (
      <section className="dashboard-card p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在加载 TPMDashboard 测试状态数据...</span>
        </div>
      </section>
    );
  }

  const error = filterOptionsError ?? statusRowsError ?? aidaStatusError ?? testcaseDetailError;
  if (error && !filterOptionsData && !statusRowsData && !aidaStatusRowsData && !testcaseDetailRowsData) {
    return (
      <section className="dashboard-card p-6">
        <div className="flex items-start gap-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-medium">测试状态数据加载失败</p>
            <p className="mt-1 text-muted-foreground">{error instanceof Error ? error.message : "请稍后重试"}</p>
          </div>
        </div>
      </section>
    );
  }

  if (statusRows.length === 0) {
    return (
      <section className="dashboard-card p-6">
        <p className="text-sm font-medium text-foreground">暂无测试状态数据</p>
        <p className="mt-1 text-sm text-muted-foreground">当前年份没有可按测试周和状态聚合的覆盖率记录。</p>
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
      <div className="dashboard-card p-5 lg:col-span-2">
        <h3 className="mb-4 text-sm font-semibold text-foreground">测试状态分布</h3>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={statusPie} cx="50%" cy="50%" innerRadius={55} outerRadius={95} paddingAngle={3} dataKey="value">
                {statusPie.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap justify-center gap-3 mt-2">
          {statusPie.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {s.name} ({s.value})
            </div>
          ))}
        </div>
      </div>

      <div className="dashboard-card p-5 lg:col-span-3">
        <h3 className="mb-4 text-sm font-semibold text-foreground">每周执行趋势</h3>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weeklyData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
              <XAxis dataKey="week" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
              <Bar dataKey="passed" name="Passed" stackId="a" fill={statusColors.passed} />
              <Bar dataKey="failed" name="Failed" stackId="a" fill={statusColors.failed} />
              <Bar dataKey="blocked" name="Blocked" stackId="a" fill={statusColors.blocked} />
              <Bar dataKey="other" name="Other" stackId="a" fill={statusColors.other} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>

    <div className="grid gap-5 lg:grid-cols-2">
      <StatusMixBarCard title="项目状态矩阵" data={projectRows} vertical />
      <StatusMixBarCard title="FV 状态矩阵" data={fvRows} vertical />
    </div>

    <div className="grid gap-5 lg:grid-cols-2">
      <StatusMixBarCard title="FVP 状态矩阵" data={fvpRows} vertical />
      <StatusMixBarCard title="Top AIDA 状态矩阵" data={aidaRows} vertical />
    </div>

    <div className="grid gap-5 lg:grid-cols-2">
      <StatusMixBarCard title="Tester 执行状态" data={testerRows} vertical />
      <StatusMixBarCard title="测试用例状态 Top 10" data={testcaseRows} vertical />
    </div>
  </div>
  );
};

export default TestStatusAnalysis;
