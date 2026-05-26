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

const chartPalette = [
  "hsl(210 70% 52%)",
  "hsl(152 60% 40%)",
  "hsl(32 92% 54%)",
  "hsl(350 78% 60%)",
  "hsl(262 65% 58%)",
  "hsl(188 72% 42%)",
];

export type CoverageAnalysisChartDatum = {
  label: string;
  selectionValue: string;
  total: number;
  [status: string]: string | number;
};

type CoverageAnalysisChartCardProps = {
  title: string;
  description?: string;
  rows: CoverageAnalysisChartDatum[];
  statuses: string[];
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
  return Math.min(Math.max(rowCount * 56, 260), 540);
}

const CoverageAnalysisChartCard = ({
  title,
  description,
  rows,
  statuses,
  emptyMessage,
  onSelectValue,
}: CoverageAnalysisChartCardProps) => {
  const chartHeight = getChartHeight(rows.length || 1);

  return (
    <section className="dashboard-card p-5">
      <div className="mb-4 space-y-1 border-b border-border/70 pb-4">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>

      {rows.length === 0 ? (
        <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/20 px-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div className="max-h-[540px] overflow-y-auto pr-1">
          <div style={{ height: `${chartHeight}px` }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 16% 90%)" horizontal={false} />
                <XAxis
                  type="number"
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "hsl(220 10% 50%)" }}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={220}
                  tick={{ fontSize: 11, fill: "hsl(220 10% 50%)" }}
                  tickFormatter={truncateTickLabel}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid hsl(220 16% 90%)",
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {statuses.map((status, index) => (
                  <Bar
                    key={status}
                    dataKey={status}
                    stackId="coverage"
                    fill={chartPalette[index % chartPalette.length]}
                    radius={index === statuses.length - 1 ? [0, 4, 4, 0] : [0, 0, 0, 0]}
                    cursor={onSelectValue ? "pointer" : "default"}
                    onClick={(data) => {
                      const selectionValue = (data as { payload?: { selectionValue?: string } } | undefined)?.payload?.selectionValue;
                      if (selectionValue) {
                        onSelectValue?.(selectionValue);
                      }
                    }}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
};

export default CoverageAnalysisChartCard;