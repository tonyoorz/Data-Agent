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

const chartPalette = [
  "hsl(210 70% 52%)",
  "hsl(152 60% 40%)",
  "hsl(32 92% 54%)",
  "hsl(350 78% 60%)",
  "hsl(262 65% 58%)",
  "hsl(188 72% 42%)",
];

export type CoverageAnalysisChartDatum = {
  xValue: string;
  yValue: string;
  selectionValue: string;
  status: string;
  count: number;
  seriesLabel?: string;
};

type CoverageAnalysisChartCardProps = {
  title: string;
  description?: string;
  rows: CoverageAnalysisChartDatum[];
  statuses: string[];
  densityNote?: string;
  emptyMessage: string;
  onSelectValue?: (value: string) => void;
};

function truncateTickLabel(value: string) {
  if (value.length <= 28) {
    return value;
  }

  return `${value.slice(0, 27)}...`;
}

function getChartHeight(rowCount: number) {
  return Math.min(Math.max(rowCount * 42, 320), 620);
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

type CoverageAnalysisScatterPoint = CoverageAnalysisChartDatum & {
  xIndex: number;
  yIndex: number;
};

function buildScatterRows(rows: CoverageAnalysisChartDatum[]) {
  const xValues = Array.from(new Set(rows.map((row) => row.xValue))).sort(compareTestWeek);
  const categoryTotals = new Map<string, number>();

  rows.forEach((row) => {
    categoryTotals.set(row.yValue, (categoryTotals.get(row.yValue) ?? 0) + row.count);
  });

  const yValues = Array.from(categoryTotals.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category]) => category)
    .reverse();

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
    <div className="rounded-xl border border-border/80 bg-background px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-foreground">{point.yValue}</div>
      <div className="mt-1 space-y-1 text-muted-foreground">
        <div>测试周: {point.xValue}</div>
        <div>状态: {point.status}</div>
        <div>数量: {point.count}</div>
      </div>
    </div>
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
}: CoverageAnalysisChartCardProps) => {
  const { scatterRows, xValues, yValues } = buildScatterRows(rows);
  const chartHeight = getChartHeight(yValues.length || 1);

  return (
    <section className="dashboard-card p-5">
      <div className="mb-4 space-y-1 border-b border-border/70 pb-4">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        {densityNote ? <p className="text-xs text-muted-foreground">{densityNote}</p> : null}
      </div>

      {rows.length === 0 ? (
        <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/20 px-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div className="max-h-[620px] overflow-y-auto pr-1">
          <div style={{ height: `${chartHeight}px` }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 12, right: 20, bottom: 48, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 16% 90%)" />
                <XAxis
                  type="number"
                  dataKey="xIndex"
                  ticks={xValues.map((_, index) => index)}
                  domain={[-0.5, Math.max(xValues.length - 0.5, 0.5)]}
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "hsl(220 10% 50%)" }}
                  tickFormatter={(value: number) => xValues[value] ?? ""}
                  angle={-32}
                  textAnchor="end"
                  height={64}
                />
                <YAxis
                  type="number"
                  dataKey="yIndex"
                  ticks={yValues.map((_, index) => index)}
                  domain={[-0.5, Math.max(yValues.length - 0.5, 0.5)]}
                  allowDecimals={false}
                  width={220}
                  tick={{ fontSize: 11, fill: "hsl(220 10% 50%)" }}
                  tickFormatter={(value: number) => truncateTickLabel(yValues[value] ?? "")}
                />
                <ZAxis type="number" dataKey="count" range={[120, 520]} />
                <Tooltip content={<CoverageAnalysisTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {statuses.map((status, index) => (
                  <Scatter
                    key={status}
                    name={status}
                    data={scatterRows.filter((row) => row.status === status)}
                    fill={chartPalette[index % chartPalette.length]}
                    fillOpacity={0.78}
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
    </section>
  );
};

export default CoverageAnalysisChartCard;