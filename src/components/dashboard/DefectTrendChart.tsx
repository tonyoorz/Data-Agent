import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { TopIssueTrendRow } from "@/components/dashboard/top-issue/topIssueTypes";

type DefectTrendChartProps = {
  data: TopIssueTrendRow[];
};

const DefectTrendChart = ({ data }: DefectTrendChartProps) => {
  const chartData = data.map((row) => ({
    month: row.month,
    新增: row.newCount,
    关闭: row.closedCount,
    进行中: row.inProgressCount,
  }));

  return (
    <div className="dashboard-card p-5">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">缺陷趋势</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">日度新增、关闭与进行中缺陷数</p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-primary" />
            新增
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-success" />
            关闭
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-warning" />
            进行中
          </span>
        </div>
      </div>
      {chartData.length === 0 ? (
        <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
          当前筛选条件下暂无趋势数据。
        </div>
      ) : (
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="colorNew" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(215, 70%, 48%)" stopOpacity={0.15} />
              <stop offset="95%" stopColor="hsl(215, 70%, 48%)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorClosed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(152, 60%, 40%)" stopOpacity={0.15} />
              <stop offset="95%" stopColor="hsl(152, 60%, 40%)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" vertical={false} />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 12, fill: "hsl(220, 10%, 50%)" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 12, fill: "hsl(220, 10%, 50%)" }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(0, 0%, 100%)",
              border: "1px solid hsl(220, 16%, 90%)",
              borderRadius: "10px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
              fontSize: "13px",
            }}
          />
          <Area
            type="monotone"
            dataKey="新增"
            stroke="hsl(215, 70%, 48%)"
            strokeWidth={2}
            fill="url(#colorNew)"
          />
          <Area
            type="monotone"
            dataKey="关闭"
            stroke="hsl(152, 60%, 40%)"
            strokeWidth={2}
            fill="url(#colorClosed)"
          />
          <Area
            type="monotone"
            dataKey="进行中"
            stroke="hsl(38, 92%, 50%)"
            strokeWidth={2}
            fill="transparent"
            strokeDasharray="5 3"
          />
        </AreaChart>
      </ResponsiveContainer>
      )}
    </div>
  );
};

export default DefectTrendChart;
