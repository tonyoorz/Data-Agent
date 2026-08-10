import { useMemo } from "react";

import { AlertTriangle, BarChart3, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, BarChart, Bar } from "recharts";

import { parseTicketDateValue } from "../main-dashboard/mainDashboardDateUtils";
import { useMainDashboardData } from "../main-dashboard/useMainDashboardData";
import type { MainDashboardTicketRow } from "../main-dashboard/mainDashboardTypes";

const numberFormatter = new Intl.NumberFormat("en-US");
const DEFAULT_ANALYSIS_YEAR = "2026";

type StatusPieRow = {
  name: string;
  value: number;
  color: string;
};

type FlowRow = {
  month: string;
  inflow: number;
  outflow: number;
  openBacklog: number;
};

type StatusBucket = "open" | "closed" | "rejected";

type StatusMixRow = {
  name: string;
  open: number;
  closed: number;
  rejected: number;
  total: number;
};

const statusPalette = [
  "hsl(215, 70%, 48%)",
  "hsl(38, 92%, 50%)",
  "hsl(280, 60%, 55%)",
  "hsl(180, 50%, 45%)",
  "hsl(152, 60%, 40%)",
  "hsl(220, 16%, 70%)",
  "hsl(0, 72%, 51%)",
  "hsl(260, 46%, 52%)",
];

function extractPhaseCode(value?: string | null) {
  return String(value ?? "").trim().match(/^(\d{2})/)?.[1] ?? "";
}

function isClosedTicket(row: MainDashboardTicketRow) {
  const phaseCode = extractPhaseCode(row.phase || row.status);
  return row.isResolvedForward || phaseCode === "06" || phaseCode === "08";
}

function isRejectedTicket(row: MainDashboardTicketRow) {
  const phaseCode = extractPhaseCode(row.phase || row.status);
  return row.isRejectedDirectly || phaseCode === "09";
}

function classifyStatusBucket(row: MainDashboardTicketRow): StatusBucket {
  if (isRejectedTicket(row)) {
    return "rejected";
  }

  if (isClosedTicket(row)) {
    return "closed";
  }

  return "open";
}

function buildStatusPieRows(ticketRows: MainDashboardTicketRow[]): StatusPieRow[] {
  const groupedRows = new Map<string, number>();

  ticketRows.forEach((row) => {
    const statusName = row.phase.trim() || row.status.trim() || "Unknown";
    groupedRows.set(statusName, (groupedRows.get(statusName) ?? 0) + 1);
  });

  return Array.from(groupedRows.entries())
    .map(([name, value], index) => ({
      name,
      value,
      color: statusPalette[index % statusPalette.length],
    }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

function incrementMonth(rows: Map<string, FlowRow>, month: string, key: keyof Omit<FlowRow, "month">) {
  const current = rows.get(month) ?? { month, inflow: 0, outflow: 0, openBacklog: 0 };
  current[key] += 1;
  rows.set(month, current);
}

function buildFlowRows(ticketRows: MainDashboardTicketRow[]): FlowRow[] {
  const groupedRows = new Map<string, FlowRow>();

  ticketRows.forEach((row) => {
    const creationMonth = parseTicketDateValue(row.creationTime)?.monthLabel;
    const ticketMonth = parseTicketDateValue(row.ticketDate)?.monthLabel;

    if (creationMonth) {
      incrementMonth(groupedRows, creationMonth, "inflow");
    }

    if (ticketMonth && (isClosedTicket(row) || isRejectedTicket(row))) {
      incrementMonth(groupedRows, ticketMonth, "outflow");
    }

    if (ticketMonth && !isClosedTicket(row) && !isRejectedTicket(row)) {
      incrementMonth(groupedRows, ticketMonth, "openBacklog");
    }
  });

  return Array.from(groupedRows.values()).sort((left, right) => left.month.localeCompare(right.month));
}

function buildStatusMixRows(
  ticketRows: MainDashboardTicketRow[],
  labelSelector: (row: MainDashboardTicketRow) => string,
  limit = 8,
): StatusMixRow[] {
  const groupedRows = new Map<string, StatusMixRow>();

  ticketRows.forEach((row) => {
    const name = labelSelector(row).trim() || "Unknown";
    const current = groupedRows.get(name) ?? { name, open: 0, closed: 0, rejected: 0, total: 0 };
    current[classifyStatusBucket(row)] += 1;
    current.total += 1;
    groupedRows.set(name, current);
  });

  return Array.from(groupedRows.values())
    .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name))
    .slice(0, limit);
}

function calculateAgeDays(row: MainDashboardTicketRow) {
  const startDate = parseTicketDateValue(row.creationTime);
  const endDate = parseTicketDateValue(row.ticketDate);
  if (!startDate || !endDate) {
    return null;
  }

  return Math.max(0, Math.floor((endDate.sortValue - startDate.sortValue) / (24 * 60 * 60 * 1000)));
}

function buildAgeRows(ticketRows: MainDashboardTicketRow[]): StatusMixRow[] {
  const buckets = [
    { name: "0-7天", min: 0, max: 7 },
    { name: "8-14天", min: 8, max: 14 },
    { name: "15-30天", min: 15, max: 30 },
    { name: "31-60天", min: 31, max: 60 },
    { name: "60天+", min: 61, max: Number.POSITIVE_INFINITY },
  ];
  const rows = buckets.map((bucket) => ({ name: bucket.name, open: 0, closed: 0, rejected: 0, total: 0 }));

  ticketRows.forEach((row) => {
    const ageDays = calculateAgeDays(row);
    if (ageDays === null) {
      return;
    }

    const bucketIndex = buckets.findIndex((bucket) => ageDays >= bucket.min && ageDays <= bucket.max);
    if (bucketIndex < 0) {
      return;
    }

    rows[bucketIndex][classifyStatusBucket(row)] += 1;
    rows[bucketIndex].total += 1;
  });

  return rows;
}

function getSeverityLabel(row: MainDashboardTicketRow) {
  return row.problemSeverity?.trim() || row.classification?.trim() || "Unknown";
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
            <Bar dataKey="open" name="Open" stackId="status" fill="hsl(38, 92%, 50%)" />
            <Bar dataKey="closed" name="Closed" stackId="status" fill="hsl(152, 60%, 40%)" />
            <Bar dataKey="rejected" name="Rejected" stackId="status" fill="hsl(220, 16%, 60%)" radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const DefectStatusAnalysis = () => {
  const { data, error, isLoading } = useMainDashboardData({ years: [DEFAULT_ANALYSIS_YEAR] });
  const ticketRows = data?.ticketRows ?? [];
  const statusPie = useMemo(() => buildStatusPieRows(ticketRows), [ticketRows]);
  const flowData = useMemo(() => buildFlowRows(ticketRows), [ticketRows]);
  const projectStatusRows = useMemo(
    () => buildStatusMixRows(ticketRows, (row) => row.project, 8),
    [ticketRows],
  );
  const teamStatusRows = useMemo(
    () => buildStatusMixRows(ticketRows, (row) => row.problemFinderTeam, 8),
    [ticketRows],
  );
  const ageRows = useMemo(() => buildAgeRows(ticketRows), [ticketRows]);
  const severityRows = useMemo(
    () => buildStatusMixRows(ticketRows, getSeverityLabel, 8),
    [ticketRows],
  );
  const aidaRows = useMemo(
    () => buildStatusMixRows(ticketRows, (row) => row.aida, 10),
    [ticketRows],
  );
  const totalDefects = ticketRows.length;
  const closedCount = ticketRows.filter(isClosedTicket).length;
  const rejectedCount = ticketRows.filter(isRejectedTicket).length;
  const inProgressCount = totalDefects - closedCount - rejectedCount;
  const kpis = [
    { label: "总缺陷", value: numberFormatter.format(totalDefects), icon: BarChart3, color: "bg-primary/10 text-primary" },
    { label: "已关闭", value: numberFormatter.format(closedCount), icon: CheckCircle2, color: "bg-success/10 text-success" },
    { label: "处理中", value: numberFormatter.format(inProgressCount), icon: Clock, color: "bg-warning/10 text-warning" },
    { label: "已拒绝", value: numberFormatter.format(rejectedCount), icon: XCircle, color: "bg-muted text-muted-foreground" },
  ];

  if (isLoading && !data) {
    return (
      <section className="dashboard-card p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在加载 TPMDashboard 缺陷状态数据...</span>
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
            <p className="font-medium">缺陷状态数据加载失败</p>
            <p className="mt-1 text-muted-foreground">{error instanceof Error ? error.message : "请稍后重试"}</p>
          </div>
        </div>
      </section>
    );
  }

  if (statusPie.length === 0) {
    return (
      <section className="dashboard-card p-6">
        <p className="text-sm font-medium text-foreground">暂无缺陷状态数据</p>
        <p className="mt-1 text-sm text-muted-foreground">Full Picture 当前范围内没有可按 phase 聚合的缺陷记录。</p>
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
        <h3 className="mb-4 text-sm font-semibold text-foreground">缺陷状态分布</h3>
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={statusPie} cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={2} dataKey="value">
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
        <h3 className="mb-4 text-sm font-semibold text-foreground">缺陷流转趋势</h3>
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={flowData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
              <Area type="monotone" dataKey="inflow" name="Inflow" stroke="hsl(215, 70%, 48%)" fill="hsl(215, 70%, 48%)" fillOpacity={0.1} strokeWidth={2} />
              <Area type="monotone" dataKey="outflow" name="Outflow" stroke="hsl(152, 60%, 40%)" fill="hsl(152, 60%, 40%)" fillOpacity={0.1} strokeWidth={2} />
              <Area type="monotone" dataKey="openBacklog" name="Open Backlog" stroke="hsl(38, 92%, 50%)" fill="hsl(38, 92%, 50%)" fillOpacity={0.1} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>

    <div className="grid gap-5 lg:grid-cols-2">
      <StatusMixBarCard title="项目状态矩阵" data={projectStatusRows} vertical />
      <StatusMixBarCard title="团队状态矩阵" data={teamStatusRows} vertical />
    </div>

    <div className="grid gap-5 lg:grid-cols-3">
      <StatusMixBarCard title="缺陷年龄分布" data={ageRows} />
      <StatusMixBarCard title="严重度状态分布" data={severityRows} />
      <StatusMixBarCard title="Top AIDA 状态分布" data={aidaRows} vertical />
    </div>
  </div>
  );
};

export default DefectStatusAnalysis;
