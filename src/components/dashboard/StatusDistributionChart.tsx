import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import type { TopIssueStatusDistributionRow } from "@/components/dashboard/top-issue/topIssueTypes";

const fallbackPalette = [
  "hsl(152, 60%, 40%)",
  "hsl(215, 70%, 48%)",
  "hsl(38, 92%, 50%)",
  "hsl(0, 72%, 51%)",
  "hsl(271, 81%, 56%)",
  "hsl(195, 85%, 41%)",
];

type StatusDistributionChartProps = {
  data: TopIssueStatusDistributionRow[];
};

const StatusDistributionChart = ({ data }: StatusDistributionChartProps) => {
  const chartData = data.map((item, index) => ({
    name: item.status,
    value: item.count,
    color: fallbackPalette[index % fallbackPalette.length],
  }));
  const total = chartData.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="dashboard-card p-5">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-foreground">状态分布</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">缺陷当前状态占比</p>
      </div>
      {chartData.length === 0 ? (
        <div className="flex h-[180px] items-center justify-center text-sm text-muted-foreground">
          当前筛选条件下暂无状态分布数据。
        </div>
      ) : (
      <div className="flex items-center gap-6">
        <ResponsiveContainer width={180} height={180}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={80}
              paddingAngle={3}
              dataKey="value"
              stroke="none"
            >
              {chartData.map((entry, index) => (
                <Cell key={index} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: "hsl(0, 0%, 100%)",
                border: "1px solid hsl(220, 16%, 90%)",
                borderRadius: "10px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                fontSize: "13px",
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="flex-1 space-y-3">
          {chartData.map((item) => (
            <div key={item.name} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                <span className="text-sm text-foreground">{item.name}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-foreground">{item.value}</span>
                <span className="text-xs text-muted-foreground w-10 text-right">
                  {((item.value / total) * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      )}
    </div>
  );
};

export default StatusDistributionChart;
