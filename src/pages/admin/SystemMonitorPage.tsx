import type { ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  Cpu,
  Database,
  HardDrive,
  Server,
} from "lucide-react";
import { adminApi } from "@/lib/adminApi";
import { formatMs, formatNumber, formatTokens } from "@/lib/adminFormat";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const SystemMonitorPage = () => {
  const { data: overview, isLoading } = useQuery({
    queryKey: ["admin-overview-system", 30],
    queryFn: () => adminApi.getOverview(30),
  });

  const { data: tokenUsage } = useQuery({
    queryKey: ["admin-token-usage-system", 30],
    queryFn: () => adminApi.getTokenUsage(30),
  });

  const services = [
    { name: "Vizion API (3004)", url: "/health", status: "online" },
    { name: "Agent Chat 接口", url: "/api/ai/chat", status: "online" },
    { name: "查重检索接口", url: "/api/duplicate-search", status: "online" },
    { name: "Admin Stats API", url: "/api/admin/stats/overview", status: "online" },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-[hsl(var(--foreground))]">系统监控</h2>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          服务健康状态与近 30 天运营指标
        </p>
      </div>

      {/* Service health */}
      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <Server className="h-4 w-4 text-[hsl(var(--primary))]" />
          <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">服务健康</h3>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {services.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between rounded-lg border border-[hsl(var(--border))] px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[hsl(var(--foreground))]">
                  {s.name}
                </p>
                <p className="truncate font-mono text-xs text-[hsl(var(--muted-foreground))]">
                  {s.url}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-xs text-emerald-600">在线</span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Operational metrics */}
      {isLoading ? (
        <Skeleton className="h-[200px] rounded-xl" />
      ) : overview ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricCard
            icon={Activity}
            label="近30天查询"
            value={formatNumber(overview.chat.total)}
            sub={`成功 ${formatNumber(overview.chat.success ?? 0)}`}
            color="text-blue-600 bg-blue-50"
          />
          <MetricCard
            icon={Database}
            label="近30天查重"
            value={formatNumber(overview.dedup.total)}
            sub={`成功率 ${overview.dedup.total > 0 ? Math.round(((overview.dedup.success ?? 0) / overview.dedup.total) * 100) : 0}%`}
            color="text-emerald-600 bg-emerald-50"
          />
          <MetricCard
            icon={Cpu}
            label="Token 总量"
            value={formatTokens(overview.chat.inputTokens + overview.chat.outputTokens)}
            sub={`输入 ${formatTokens(overview.chat.inputTokens)}`}
            color="text-violet-600 bg-violet-50"
          />
          <MetricCard
            icon={HardDrive}
            label="平均响应"
            value={formatMs(overview.chat.avgMs)}
            sub={`查重 ${formatMs(overview.dedup.avgMs)}`}
            color="text-amber-600 bg-amber-50"
          />
        </div>
      ) : null}

      {/* Model performance */}
      {tokenUsage ? (
        <Card className="overflow-hidden">
          <div className="border-b border-[hsl(var(--border))] px-5 py-3">
            <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">
              各模型调用情况（近 30 天）
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[500px] text-sm">
              <thead>
                <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-left">
                  <th className="px-4 py-3 font-semibold text-[hsl(var(--muted-foreground))]">模型</th>
                  <th className="px-4 py-3 text-right font-semibold text-[hsl(var(--muted-foreground))]">请求数</th>
                  <th className="px-4 py-3 text-right font-semibold text-[hsl(var(--muted-foreground))]">Token/请求</th>
                  <th className="px-4 py-3 text-right font-semibold text-[hsl(var(--muted-foreground))]">总 Token</th>
                </tr>
              </thead>
              <tbody>
                {tokenUsage.byModel.map((m) => {
                  const sum = m.input_tokens + m.output_tokens;
                  const perReq = m.requests > 0 ? Math.round(sum / m.requests) : 0;
                  return (
                    <tr
                      key={m.model}
                      className="border-b border-[hsl(var(--border))] transition-colors hover:bg-[hsl(var(--muted))]"
                    >
                      <td className="px-4 py-3 font-mono text-[hsl(var(--foreground))]">{m.model}</td>
                      <td className="px-4 py-3 text-right text-[hsl(var(--foreground))]">
                        {formatNumber(m.requests)}
                      </td>
                      <td className="px-4 py-3 text-right text-[hsl(var(--muted-foreground))]">
                        {formatNumber(perReq)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-[hsl(var(--foreground))]">
                        {formatNumber(sum)}
                      </td>
                    </tr>
                  );
                })}
                {!tokenUsage.byModel.length && (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-[hsl(var(--muted-foreground))]">
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* Notes */}
      <Card className="p-5">
        <div className="flex items-start gap-2 text-sm text-[hsl(var(--muted-foreground))]">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          <div className="space-y-1">
            <p>
              <strong className="text-[hsl(var(--foreground))]">数据来源：</strong>
              所有统计数据来自 <code className="rounded bg-[hsl(var(--muted))] px-1 py-0.5 text-xs">chat_stats.db</code>，由 server/index.mjs 在每次 chat 请求和查重请求时实时写入。
            </p>
            <p>
              <strong className="text-[hsl(var(--foreground))]">Token 估算：</strong>
              输入 Token 基于消息字符数估算（≈ 字符数 / 3），输出 Token 基于流字节数估算（≈ 字节数 / 8），仅供参考。
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
};

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <Card className="p-4">
      <div className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg ${color}`}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">{label}</p>
      <p className="mt-1 text-xl font-bold text-[hsl(var(--foreground))]">{value}</p>
      <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">{sub}</p>
    </Card>
  );
}

export default SystemMonitorPage;
