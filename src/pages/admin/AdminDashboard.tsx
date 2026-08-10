import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Clock,
  Database,
  MessageSquare,
  Search,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { adminApi, type OverviewData } from "@/lib/adminApi";
import { formatMs, formatNumber, formatTokens, shortDay } from "@/lib/adminFormat";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const PIE_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#8b5cf6", "#06b6d4"];

const AdminDashboard = () => {
  const [days, setDays] = useState(7);
  const { data, isLoading } = useQuery({
    queryKey: ["admin-overview", days],
    queryFn: () => adminApi.getOverview(days),
  });

  return (
    <div className="space-y-5">
      {/* Header with range selector */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-[hsl(var(--foreground))]">数据看板</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            Agent Chat 查询、查重与 Token 用量总览
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
        <DashboardSkeleton />
      ) : data ? (
        <>
          <KpiGrid data={data} />
          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <div className="mb-4 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-[hsl(var(--primary))]" />
                <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">
                  请求趋势
                </h3>
              </div>
              <TrendChart data={data} />
            </Card>
            <Card className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[hsl(var(--primary))]" />
                <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">
                  模型分布
                </h3>
              </div>
              <ModelPie data={data} />
            </Card>
          </div>
          <Card className="p-5">
            <div className="mb-4 flex items-center gap-2">
              <Database className="h-4 w-4 text-[hsl(var(--primary))]" />
              <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">
                每日 Token 用量（估算）
              </h3>
            </div>
            <TokenBarChart data={data} />
          </Card>
        </>
      ) : null}
    </div>
  );
};

function KpiGrid({ data }: { data: OverviewData }) {
  const errorRate =
    data.chat.total > 0 ? ((data.chat.errors ?? 0) / data.chat.total) * 100 : 0;
  const totalTokens = data.chat.inputTokens + data.chat.outputTokens;

  const cards = [
    {
      label: "查询总数",
      value: formatNumber(data.chat.total),
      sub: `成功 ${formatNumber(data.chat.success ?? 0)} · 失败 ${formatNumber(data.chat.errors ?? 0)}`,
      icon: MessageSquare,
      color: "text-blue-600 bg-blue-50",
    },
    {
      label: "查重次数",
      value: formatNumber(data.dedup.total),
      sub: `成功率 ${data.dedup.total > 0 ? Math.round(((data.dedup.success ?? 0) / data.dedup.total) * 100) : 0}%`,
      icon: Search,
      color: "text-emerald-600 bg-emerald-50",
    },
    {
      label: "Token 用量（估算）",
      value: formatTokens(totalTokens),
      sub: `输入 ${formatTokens(data.chat.inputTokens)} · 输出 ${formatTokens(data.chat.outputTokens)}`,
      icon: Sparkles,
      color: "text-violet-600 bg-violet-50",
    },
    {
      label: "平均响应时长",
      value: formatMs(data.chat.avgMs),
      sub: `查重均耗时 ${formatMs(data.dedup.avgMs)}`,
      icon: Clock,
      color: "text-amber-600 bg-amber-50",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <Card key={c.label} className="p-5">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
                  {c.label}
                </p>
                <p className="mt-2 text-2xl font-bold text-[hsl(var(--foreground))]">
                  {c.value}
                </p>
                <p className="mt-1 truncate text-xs text-[hsl(var(--muted-foreground))]">
                  {c.sub}
                </p>
              </div>
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${c.color}`}>
                <Icon className="h-5 w-5" />
              </div>
            </div>
          </Card>
        );
      })}
      {errorRate > 15 && (
        <Card className="border-amber-200 bg-amber-50 p-4 sm:col-span-2 xl:col-span-4">
          <div className="flex items-center gap-2 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              错误率达 {errorRate.toFixed(1)}%，建议检查模型配置或上游服务状态。
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}

function TrendChart({ data }: { data: OverviewData }) {
  const chartData = data.daily.map((d) => ({
    day: shortDay(d.day),
    查询: d.chat_count,
    查重: d.dedup_count,
  }));
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
        <defs>
          <linearGradient id="cQuery" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#2563eb" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="cDedup" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#16a34a" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis dataKey="day" tick={{ fontSize: 12, fill: "#64748b" }} />
        <YAxis tick={{ fontSize: 12, fill: "#64748b" }} allowDecimals={false} />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13 }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area
          type="monotone"
          dataKey="查询"
          stroke="#2563eb"
          strokeWidth={2}
          fill="url(#cQuery)"
        />
        <Area
          type="monotone"
          dataKey="查重"
          stroke="#16a34a"
          strokeWidth={2}
          fill="url(#cDedup)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ModelPie({ data }: { data: OverviewData }) {
  const pieData = data.modelDistribution.map((m) => ({
    name: m.model || "unknown",
    value: m.count,
  }));
  if (!pieData.length) {
    return (
      <div className="flex h-[280px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
        暂无数据
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={pieData}
          cx="50%"
          cy="45%"
          innerRadius={50}
          outerRadius={85}
          paddingAngle={2}
          dataKey="value"
        >
          {pieData.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13 }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function TokenBarChart({ data }: { data: OverviewData }) {
  const chartData = data.daily.map((d) => ({
    day: shortDay(d.day),
    tokens: d.tokens,
  }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis dataKey="day" tick={{ fontSize: 12, fill: "#64748b" }} />
        <YAxis tick={{ fontSize: 12, fill: "#64748b" }} />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13 }}
          formatter={(v: number) => [formatNumber(v), "Token"]}
        />
        <Bar dataKey="tokens" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[110px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-[340px] rounded-xl lg:col-span-2" />
        <Skeleton className="h-[340px] rounded-xl" />
      </div>
      <Skeleton className="h-[300px] rounded-xl" />
    </>
  );
}

export default AdminDashboard;
