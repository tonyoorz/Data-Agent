import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Coins, Cpu, TrendingUp } from "lucide-react";
import { adminApi, type TokenUsageData } from "@/lib/adminApi";
import { formatNumber, formatTokens, shortDay } from "@/lib/adminFormat";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const PIE_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#8b5cf6", "#06b6d4"];

const TokenUsagePage = () => {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ["admin-token-usage", days],
    queryFn: () => adminApi.getTokenUsage(days),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-[hsl(var(--foreground))]">Token 用量</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            Agent Chat 的 Token 消耗统计（基于字符/字节的启发式估算）
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-1">
          {[7, 14, 30].map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? "default" : "ghost"}
              onClick={() => setDays(d)}
              className="text-xs"
            >
              {d} 天
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <TokenSkeleton />
      ) : data ? (
        <TokenContent data={data} />
      ) : null}
    </div>
  );
};

function TokenContent({ data }: { data: TokenUsageData }) {
  const totalInput = data.byModel.reduce((s, m) => s + m.input_tokens, 0);
  const totalOutput = data.byModel.reduce((s, m) => s + m.output_tokens, 0);
  const totalAll = totalInput + totalOutput;

  const summary = [
    {
      label: "总 Token（估算）",
      value: formatTokens(totalAll),
      icon: Coins,
      color: "text-violet-600 bg-violet-50",
    },
    {
      label: "输入 Token",
      value: formatTokens(totalInput),
      icon: TrendingUp,
      color: "text-blue-600 bg-blue-50",
    },
    {
      label: "输出 Token",
      value: formatTokens(totalOutput),
      icon: Cpu,
      color: "text-emerald-600 bg-emerald-50",
    },
  ];

  const lineData = data.daily.map((d) => ({
    day: shortDay(d.day),
    输入: d.input_tokens,
    输出: d.output_tokens,
  }));

  const pieData = data.byModel.map((m) => ({
    name: m.model || "unknown",
    value: m.input_tokens + m.output_tokens,
  }));

  const totalReqs = data.byModel.reduce((s, m) => s + m.requests, 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {summary.map((s) => {
          const Icon = s.icon;
          return (
            <Card key={s.label} className="p-5">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${s.color}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">{s.label}</p>
                  <p className="text-xl font-bold text-[hsl(var(--foreground))]">{s.value}</p>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h3 className="mb-4 text-sm font-semibold text-[hsl(var(--foreground))]">
            每日输入/输出 Token 趋势
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={lineData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 12, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 12, fill: "#64748b" }} />
              <Tooltip
                contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13 }}
                formatter={(v: number) => formatNumber(v)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="输入"
                stroke="#2563eb"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
              <Line
                type="monotone"
                dataKey="输出"
                stroke="#16a34a"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold text-[hsl(var(--foreground))]">
            各模型 Token 占比
          </h3>
          {pieData.length ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="42%"
                  innerRadius={45}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13 }}
                  formatter={(v: number) => formatNumber(v)}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[300px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              暂无数据
            </div>
          )}
        </Card>
      </div>

      {/* Model breakdown table */}
      <Card className="overflow-hidden">
        <div className="border-b border-[hsl(var(--border))] px-5 py-3">
          <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">模型用量明细</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-left">
                <th className="px-4 py-3 font-semibold text-[hsl(var(--muted-foreground))]">模型</th>
                <th className="px-4 py-3 text-right font-semibold text-[hsl(var(--muted-foreground))]">请求数</th>
                <th className="px-4 py-3 text-right font-semibold text-[hsl(var(--muted-foreground))]">占比</th>
                <th className="px-4 py-3 text-right font-semibold text-[hsl(var(--muted-foreground))]">输入 Token</th>
                <th className="px-4 py-3 text-right font-semibold text-[hsl(var(--muted-foreground))]">输出 Token</th>
                <th className="px-4 py-3 text-right font-semibold text-[hsl(var(--muted-foreground))]">合计</th>
              </tr>
            </thead>
            <tbody>
              {data.byModel.length ? (
                data.byModel.map((m, i) => {
                  const sum = m.input_tokens + m.output_tokens;
                  return (
                    <tr
                      key={m.model}
                      className="border-b border-[hsl(var(--border))] transition-colors hover:bg-[hsl(var(--muted))]"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                          />
                          <span className="font-mono text-[hsl(var(--foreground))]">
                            {m.model}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-[hsl(var(--foreground))]">
                        {formatNumber(m.requests)}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-[hsl(var(--muted-foreground))]">
                        {totalReqs > 0 ? ((m.requests / totalReqs) * 100).toFixed(1) : 0}%
                      </td>
                      <td className="px-4 py-3 text-right text-[hsl(var(--foreground))]">
                        {formatNumber(m.input_tokens)}
                      </td>
                      <td className="px-4 py-3 text-right text-[hsl(var(--foreground))]">
                        {formatNumber(m.output_tokens)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-[hsl(var(--foreground))]">
                        {formatNumber(sum)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-[hsl(var(--muted-foreground))]">
                    暂无数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function TokenSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-[360px] rounded-xl lg:col-span-2" />
        <Skeleton className="h-[360px] rounded-xl" />
      </div>
      <Skeleton className="h-[240px] rounded-xl" />
    </>
  );
}

export default TokenUsagePage;
