// Generic analysis-result chart for the agent chat surface (task 29).
//
// The backend emits a structured `analysis-result` event (from
// buildAnalysisResultEvent in langGraphChatRuntime.mjs) carrying the governed
// semantic payload's columns/rows/metrics plus the analysisPlanner.visualization
// profile. This component renders that payload by visualization profile instead
// of forcing every answer through markdown. recharts is used for bar/line and
// plain HTML for table/kpi to keep the bundle small and stay consistent with the
// existing dashboard cards (DefectTrendChart/StatusDistributionChart).
//
// Column derivation: a column is a "metric" series when its id appears in the
// metrics summary; everything else is treated as a dimension. The first
// dimension is the chart x-axis. If no axis can be derived we fall back to the
// table view, so a misshaped payload never renders a broken chart.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type AnalysisVisualization =
  | "none"
  | "kpi"
  | "line"
  | "bar"
  | "grouped_bar"
  | "table";

export interface AnalysisResultColumn {
  id: string;
  label: string;
}

export interface AnalysisResultPayload {
  visualization: AnalysisVisualization;
  columns: AnalysisResultColumn[];
  rows: Record<string, unknown>[];
  metrics: Record<string, number>;
  analysisRef?: string;
}

interface Props {
  result: AnalysisResultPayload;
}

const SERIES_COLORS = [
  "hsl(215, 70%, 48%)",
  "hsl(152, 60%, 40%)",
  "hsl(38, 92%, 50%)",
  "hsl(262, 60%, 55%)",
  "hsl(0, 70%, 55%)",
];

const TOOLTIP_STYLE = {
  background: "hsl(0, 0%, 100%)",
  border: "1px solid hsl(220, 16%, 90%)",
  borderRadius: "10px",
  boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
  fontSize: "13px",
} as const;

function isNumeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toLocaleString("en-US");
    return value.toFixed(2);
  }
  return String(value);
}

function splitAxes(result: AnalysisResultPayload): { dimensionId: string | null; metricIds: string[] } {
  const metricSet = new Set(Object.keys(result.metrics || {}));
  const metricIds: string[] = [];
  const dimensions: string[] = [];
  for (const column of result.columns) {
    if (metricSet.has(column.id)) {
      metricIds.push(column.id);
    } else {
      dimensions.push(column.id);
    }
  }
  // If the summary did not flag any metric, treat numeric columns (other than the
  // first) as series so a single-payload rank/compare still charts.
  if (metricIds.length === 0 && result.rows.length) {
    const keys = Object.keys(result.rows[0] || {});
    for (const key of keys) {
      if (result.rows.some((row) => isNumeric(row[key]))) metricIds.push(key);
    }
  }
  return { dimensionId: dimensions[0] ?? null, metricIds };
}

function KpiCards({ metrics }: { metrics: Record<string, number> }) {
  const entries = Object.entries(metrics || {});
  if (!entries.length) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {entries.map(([id, value], index) => (
        <div key={id} className="dashboard-card p-4">
          <p className="truncate text-xs text-muted-foreground" title={id}>
            {id}
          </p>
          <p className="mt-1 text-2xl font-semibold text-foreground" style={{ color: SERIES_COLORS[index % SERIES_COLORS.length] }}>
            {formatCell(value)}
          </p>
        </div>
      ))}
    </div>
  );
}

function TableView({ result }: { result: AnalysisResultPayload }) {
  const { columns, rows } = result;
  if (!columns.length) return null;
  return (
    <div className="dashboard-card overflow-hidden p-0">
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted/70 backdrop-blur">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.id}
                  className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted-foreground"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-border">
                {columns.map((column) => (
                  <td key={column.id} className="whitespace-nowrap px-3 py-2 text-foreground">
                    {formatCell(row[column.id])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SeriesChart({
  result,
  variant,
}: {
  result: AnalysisResultPayload;
  variant: "bar" | "line";
}) {
  const { dimensionId, metricIds } = splitAxes(result);
  if (!dimensionId || !metricIds.length) {
    return <TableView result={result} />;
  }
  const data = result.rows.map((row) => {
    const point: Record<string, unknown> = { x: formatCell(row[dimensionId]) };
    for (const metricId of metricIds) {
      const value = row[metricId];
      point[metricId] = isNumeric(value) ? value : 0;
    }
    return point;
  });
  const Chart = variant === "line" ? LineChart : BarChart;
  const showLegend = metricIds.length > 1;
  return (
    <div className="dashboard-card p-4">
      <ResponsiveContainer width="100%" height={300}>
        <Chart data={data} barGap={2}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" vertical={false} />
          <XAxis
            dataKey="x"
            tick={{ fontSize: 12, fill: "hsl(220, 10%, 50%)" }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={12}
          />
          <YAxis
            tick={{ fontSize: 12, fill: "hsl(220, 10%, 50%)" }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "hsl(220, 16%, 95%)" }} />
          {showLegend ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
          {metricIds.map((metricId, index) => {
            const color = SERIES_COLORS[index % SERIES_COLORS.length];
            return variant === "line" ? (
              <Line
                key={metricId}
                type="monotone"
                dataKey={metricId}
                stroke={color}
                strokeWidth={2}
                dot={{ r: 3, fill: color }}
                activeDot={{ r: 5 }}
              />
            ) : (
              <Bar key={metricId} dataKey={metricId} fill={color} radius={[4, 4, 0, 0]} />
            );
          })}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

export default function AnalysisResultChart({ result }: Props) {
  if (!result) return null;
  const { visualization, columns, metrics } = result;
  const hasColumns = Array.isArray(columns) && columns.length > 0;
  const hasMetrics = metrics && typeof metrics === "object" && Object.keys(metrics).length > 0;
  if (!hasColumns && !hasMetrics) return null;

  switch (visualization) {
    case "none":
      return null;
    case "kpi":
      return <KpiCards metrics={metrics} />;
    case "table":
      return <TableView result={result} />;
    case "line":
      return <SeriesChart result={result} variant="line" />;
    case "bar":
    case "grouped_bar":
      return <SeriesChart result={result} variant="bar" />;
    default:
      return <TableView result={result} />;
  }
}
