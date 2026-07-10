import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type WeeklyReportPayload = {
  generated_from: {
    db_path: string;
    year: string;
  };
  overview: {
    defect_total: number;
    in_verification_total: number;
    rejected_total: number;
    manual_run_total: number;
    planned_total: number;
  };
  defect_quality_rows: Array<{
    project: string;
    lead_model: string;
    pmg: number;
    shk: number;
    total: number;
  }>;
  defect_owner_rows: Array<{
    owner: string;
    in_verification: number;
    rejected: number;
    total: number;
  }>;
  rejected_reason_rows: Array<{
    reason: string;
    count: number;
  }>;
  test_case_tendency_rows: Array<{
    test_week: string;
    test_cases: number;
    manual_runs: number;
  }>;
  last_week_status_rows: Array<{
    project: string;
    passed: number;
    failed: number;
    requires_attention: number;
    planned: number;
    other: number;
    total: number;
  }>;
  test_effort_rows: Array<{
    project: string;
    test_hours: number;
    manual_runs: number;
  }>;
  incoming_test_case_rows: Array<{
    project: string;
    pu: string;
    planned: number;
  }>;
};

const numberFormatter = new Intl.NumberFormat("en-US");

async function fetchWeeklyReport(): Promise<WeeklyReportPayload> {
  const response = await fetch("/api/qgate-reports/weekly-report");
  if (!response.ok) {
    throw new Error("Failed to load QGate weekly report data.");
  }

  return response.json() as Promise<WeeklyReportPayload>;
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dashboard-card p-5">
      <h3 className="mb-4 text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function WeeklyReportContent({ weekly }: { weekly: WeeklyReportPayload }) {
  const defectQualityRows = useMemo(
    () =>
      weekly.defect_quality_rows.map((row) => ({
        ...row,
        name: `${row.project} ${row.lead_model}`.trim(),
      })),
    [weekly.defect_quality_rows],
  );
  const incomingRows = useMemo(
    () =>
      weekly.incoming_test_case_rows.map((row) => ({
        ...row,
        name: `${row.project} ${row.pu}`.trim(),
      })),
    [weekly.incoming_test_case_rows],
  );
  const hasRows =
    weekly.defect_quality_rows.length > 0 ||
    weekly.defect_owner_rows.length > 0 ||
    weekly.test_case_tendency_rows.length > 0 ||
    weekly.incoming_test_case_rows.length > 0;

  if (!hasRows) {
    return (
      <section className="dashboard-card p-6">
        <h2 className="text-base font-semibold text-foreground">Weekly report</h2>
        <p className="mt-2 text-sm text-muted-foreground">No weekly report data is available for the current source.</p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Weekly report</h2>
          <p className="text-xs text-muted-foreground">Source year: {weekly.generated_from.year || "latest"}</p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div className="rounded-md border border-border bg-white px-3 py-2">
            <p className="text-[11px] text-muted-foreground">Defects</p>
            <p className="text-lg font-semibold text-foreground">{numberFormatter.format(weekly.overview.defect_total)}</p>
          </div>
          <div className="rounded-md border border-border bg-white px-3 py-2">
            <p className="text-[11px] text-muted-foreground">In verification</p>
            <p className="text-lg font-semibold text-foreground">{numberFormatter.format(weekly.overview.in_verification_total)}</p>
          </div>
          <div className="rounded-md border border-border bg-white px-3 py-2">
            <p className="text-[11px] text-muted-foreground">Rejected</p>
            <p className="text-lg font-semibold text-foreground">{numberFormatter.format(weekly.overview.rejected_total)}</p>
          </div>
          <div className="rounded-md border border-border bg-white px-3 py-2">
            <p className="text-[11px] text-muted-foreground">Manual runs</p>
            <p className="text-lg font-semibold text-foreground">{numberFormatter.format(weekly.overview.manual_run_total)}</p>
          </div>
          <div className="rounded-md border border-border bg-white px-3 py-2">
            <p className="text-[11px] text-muted-foreground">Incoming</p>
            <p className="text-lg font-semibold text-foreground">{numberFormatter.format(weekly.overview.planned_total)}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <ChartCard title="Defect quality status">
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <BarChart data={defectQualityRows} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} interval={0} angle={-20} textAnchor="end" height={72} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="pmg" name="PMG" fill="hsl(42, 92%, 52%)" />
                <Bar dataKey="shk" name="SHK" fill="hsl(0, 76%, 45%)" />
                <Bar dataKey="total" name="Total" fill="hsl(178, 48%, 34%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Defect verification and rejection owners">
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <BarChart data={weekly.defect_owner_rows} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
                <XAxis dataKey="owner" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} interval={0} angle={-20} textAnchor="end" height={72} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="in_verification" name="08 In verification" stackId="status" fill="hsl(202, 82%, 48%)" />
                <Bar dataKey="rejected" name="09 Rejected" stackId="status" fill="hsl(0, 76%, 45%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <ChartCard title="Total cases tendency">
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <BarChart data={weekly.test_case_tendency_rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
                <XAxis dataKey="test_week" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="test_cases" name="Test cases" fill="hsl(219, 24%, 46%)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="manual_runs" name="Manual runs" fill="hsl(214, 36%, 68%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Last week case quality track">
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <BarChart data={weekly.last_week_status_rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
                <XAxis dataKey="project" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="passed" name="Passed" stackId="status" fill="hsl(152, 60%, 40%)" />
                <Bar dataKey="failed" name="Failed" stackId="status" fill="hsl(0, 76%, 45%)" />
                <Bar dataKey="requires_attention" name="Requires attention" stackId="status" fill="hsl(42, 92%, 52%)" />
                <Bar dataKey="other" name="Other" stackId="status" fill="hsl(220, 16%, 60%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <ChartCard title="Test execution effort">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-3 py-2 font-medium text-muted-foreground">Project</th>
                  <th className="px-3 py-2 font-medium text-muted-foreground">Test hours</th>
                  <th className="px-3 py-2 font-medium text-muted-foreground">Manual runs</th>
                </tr>
              </thead>
              <tbody>
                {weekly.test_effort_rows.map((row) => (
                  <tr key={row.project} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-medium text-foreground">{row.project}</td>
                    <td className="px-3 py-2 font-mono text-foreground">{numberFormatter.format(row.test_hours)}</td>
                    <td className="px-3 py-2 font-mono text-foreground">{numberFormatter.format(row.manual_runs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>

        <ChartCard title="Next week incoming test cases">
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <BarChart data={incomingRows}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} interval={0} angle={-20} textAnchor="end" height={72} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(220,16%,90%)", fontSize: 12 }} />
                <Bar dataKey="planned" name="Planned" fill="hsl(219, 24%, 46%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>
    </div>
  );
}

const QGateWeeklyReport = () => {
  const [weeklyReport, setWeeklyReport] = useState<WeeklyReportPayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadWeeklyReport() {
      setError("");
      try {
        const payload = await fetchWeeklyReport();
        if (!cancelled) {
          setWeeklyReport(payload);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load QGate weekly report data.");
          setWeeklyReport(null);
        }
      }
    }

    void loadWeeklyReport();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <section className="dashboard-card p-6 text-sm text-destructive">{error}</section>;
  }

  if (!weeklyReport) {
    return <section className="dashboard-card p-6 text-sm text-muted-foreground">Loading weekly report...</section>;
  }

  return <WeeklyReportContent weekly={weeklyReport} />;
};

export default QGateWeeklyReport;
