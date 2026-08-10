import type { ReactNode } from "react";

import {
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

const statusColors: Record<string, string> = {
  Passed: "#98ee99",
  Failed: "#a42c35",
  Blocked: "#f4b16e",
  "Requires Attention": "#f4b16e",
  "In Progress": "#55d3e8",
  Planned: "#cbd5e1",
  Skipped: "#d4d4d8",
  Unknown: "#94a3b8",
};

export type CoverageAnalysisChartDatum = {
  xValue: string;
  yValue: string;
  selectionValue: string;
  status: string;
  count: number;
  seriesLabel?: string;
  tooltipTitle?: string;
  tooltipFields?: Array<{
    label: string;
    value: string | number;
  }>;
};

type CoverageAnalysisChartCardProps = {
  title: string;
  description?: string;
  rows: CoverageAnalysisChartDatum[];
  statuses: string[];
  densityNote?: string;
  emptyMessage: string;
  onSelectValue?: (value: string) => void;
  actions?: ReactNode;
  variant?: "overview" | "detail";
  yAxisOrder?: string[];
  footer?: ReactNode;
};

function truncateTickLabel(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(maxLength - 1, 1))}...`;
}

function getChartHeight(rowCount: number, variant: "overview" | "detail") {
  if (variant === "detail") {
    return Math.min(Math.max(rowCount * 22 + 180, 640), 1280);
  }

  return Math.min(Math.max(rowCount * 34 + 140, 420), 840);
}

function parseTestWeekSortKey(testWeek: string) {
  const match = String(testWeek).trim().match(/^(\d{2,4})-CW(\d{2})$/i);
  if (!match) {
    return { year: Number.MAX_SAFE_INTEGER, week: Number.MAX_SAFE_INTEGER };
  }

  const rawYear = Number.parseInt(match[1], 10);
  const normalizedYear = rawYear < 100 ? rawYear + 2000 : rawYear;
  const week = Number.parseInt(match[2], 10);
  return { year: normalizedYear, week };
}

function compareTestWeek(left: string, right: string) {
  const leftKey = parseTestWeekSortKey(left);
  const rightKey = parseTestWeekSortKey(right);

  if (leftKey.year !== rightKey.year) {
    return leftKey.year - rightKey.year;
  }

  if (leftKey.week !== rightKey.week) {
    return leftKey.week - rightKey.week;
  }

  return left.localeCompare(right);
}

function resolveStatusColor(status: string) {
  return statusColors[status] ?? statusColors.Unknown;
}

type CoverageAnalysisScatterPoint = CoverageAnalysisChartDatum & {
  xIndex: number;
  yIndex: number;
};

type CoverageAnalysisAxisTickProps = {
  x?: number;
  y?: number;
  payload?: {
    value?: number;
  };
  fullLabel: string;
  truncatedLabel: string;
  fontSize: number;
};

function buildScatterRows(rows: CoverageAnalysisChartDatum[], yAxisOrder?: string[]) {
  const xValues = Array.from(new Set(rows.map((row) => row.xValue))).sort(compareTestWeek);
  const yValues = yAxisOrder?.length
    ? yAxisOrder.filter((value) => rows.some((row) => row.yValue === value))
    : (() => {
        const categoryTotals = new Map<string, number>();

        rows.forEach((row) => {
          categoryTotals.set(row.yValue, (categoryTotals.get(row.yValue) ?? 0) + row.count);
        });

        return Array.from(categoryTotals.entries())
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([category]) => category)
          .reverse();
      })();

  const xIndexMap = new Map(xValues.map((value, index) => [value, index]));
  const yIndexMap = new Map(yValues.map((value, index) => [value, index]));

  const scatterRows: CoverageAnalysisScatterPoint[] = rows.map((row) => ({
    ...row,
    xIndex: xIndexMap.get(row.xValue) ?? 0,
    yIndex: yIndexMap.get(row.yValue) ?? 0,
  }));

  return { scatterRows, xValues, yValues };
}

function CoverageAnalysisTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: CoverageAnalysisScatterPoint }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }

  return (
    <div className="rounded-xl border border-slate-300/90 bg-white px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-slate-900">{point.tooltipTitle ?? point.yValue}</div>
      <div className="mt-1 space-y-1 text-muted-foreground">
        <div>测试周: {point.xValue}</div>
        <div>状态: {point.status}</div>
        <div>数量: {point.count}</div>
        {point.tooltipFields?.map((field) => (
          <div key={`${field.label}-${field.value}`}>{field.label}: {field.value}</div>
        ))}
      </div>
    </div>
  );
}

function CoverageAnalysisYAxisTick({
  x = 0,
  y = 0,
  fullLabel,
  truncatedLabel,
  fontSize,
}: CoverageAnalysisAxisTickProps) {
  return (
    <g transform={`translate(${x},${y})`}>
      <title>{fullLabel}</title>
      <text
        x={0}
        y={0}
        dx={-10}
        dy={4}
        textAnchor="end"
        fill="#334155"
        fontSize={fontSize}
      >
        {truncatedLabel}
      </text>
    </g>
  );
}

const CoverageAnalysisChartCard = ({
  title,
  description,
  rows,
  statuses,
  densityNote,
  emptyMessage,
  onSelectValue,
  actions,
  variant = "overview",
  yAxisOrder,
  footer,
}: CoverageAnalysisChartCardProps) => {
  const { scatterRows, xValues, yValues } = buildScatterRows(rows, yAxisOrder);
  const chartHeight = getChartHeight(yValues.length || 1, variant);
  const yAxisWidth = variant === "detail" ? 300 : 220;
  const leftMargin = variant === "detail" ? 92 : 16;
  const bottomMargin = variant === "detail" ? 58 : 54;
  const zRange = variant === "detail" ? [40, 260] : [120, 520];
  const tickMaxLength = variant === "detail" ? 42 : 28;
  const yTickFontSize = variant === "detail" ? 10 : 11;
  const scrollClassName = variant === "detail" ? "max-h-[1280px]" : "max-h-[840px]";

  return (
    <section className="dashboard-card overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border/70 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description ? <p className="text-sm leading-6 text-muted-foreground">{description}</p> : null}
          {densityNote ? <p className="text-xs text-muted-foreground">{densityNote}</p> : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>

      {rows.length === 0 ? (
        <div className="m-5 flex h-48 items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/20 px-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div className={`overflow-y-auto px-5 py-4 pr-4 ${scrollClassName}`}>
          <div
            className="rounded-2xl border border-slate-200/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.9),rgba(241,245,249,0.92))] p-3"
            style={{ height: `${chartHeight}px` }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 20, right: 24, bottom: bottomMargin, left: leftMargin }}>
                <CartesianGrid stroke="rgba(148, 163, 184, 0.28)" />
                <XAxis
                  type="number"
                  dataKey="xIndex"
                  ticks={xValues.map((_, index) => index)}
                  domain={[-0.5, Math.max(xValues.length - 0.5, 0.5)]}
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  tickFormatter={(value: number) => xValues[value] ?? ""}
                  angle={-45}
                  textAnchor="end"
                  height={72}
                  tickLine={false}
                  axisLine={{ stroke: "rgba(148, 163, 184, 0.55)" }}
                />
                <YAxis
                  type="number"
                  dataKey="yIndex"
                  ticks={yValues.map((_, index) => index)}
                  domain={[-0.5, Math.max(yValues.length - 0.5, 0.5)]}
                  allowDecimals={false}
                  width={yAxisWidth}
                  tick={(tickProps) => {
                    const fullLabel = yValues[tickProps.payload?.value ?? 0] ?? "";
                    return (
                      <CoverageAnalysisYAxisTick
                        x={tickProps.x}
                        y={tickProps.y}
                        payload={tickProps.payload}
                        fullLabel={fullLabel}
                        truncatedLabel={truncateTickLabel(fullLabel, tickMaxLength)}
                        fontSize={yTickFontSize}
                      />
                    );
                  }}
                  tickLine={false}
                  axisLine={{ stroke: "rgba(148, 163, 184, 0.55)" }}
                />
                <ZAxis type="number" dataKey="count" range={zRange} />
                <Tooltip content={<CoverageAnalysisTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12, paddingBottom: 8 }} />
                {statuses.map((status, index) => (
                  <Scatter
                    key={status}
                    name={status}
                    data={scatterRows.filter((row) => row.status === status)}
                    fill={resolveStatusColor(status)}
                    stroke={index === 0 ? "rgba(15, 23, 42, 0.72)" : "rgba(15, 23, 42, 0.85)"}
                    strokeWidth={1}
                    fillOpacity={0.88}
                    cursor={onSelectValue ? "pointer" : "default"}
                    onClick={(data) => {
                      const selectionValue = (data as { payload?: { selectionValue?: string } } | undefined)?.payload?.selectionValue;
                      if (selectionValue) {
                        onSelectValue?.(selectionValue);
                      }
                    }}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {footer ? <div className="border-t border-border/70 px-5 py-3">{footer}</div> : null}
    </section>
  );
};

export default CoverageAnalysisChartCard;