import { Badge } from "@/components/ui/badge";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TopIssueRow } from "@/components/dashboard/top-issue/topIssueTypes";

const severityStyles: Record<string, string> = {
  Showstopper: "bg-destructive/10 text-destructive border-0",
  Critical: "bg-warning/10 text-warning border-0",
  Major: "bg-primary/10 text-primary border-0",
};

const statusStyles: Record<string, string> = {
  "In Analysis": "bg-muted text-muted-foreground",
  "In Progress": "bg-primary/10 text-primary",
  "In Testing": "bg-success/10 text-success",
  New: "bg-warning/10 text-warning",
};

type TopIssueTableProps = {
  issues: TopIssueRow[];
  isLoading?: boolean;
};

const TopIssueTable = ({ issues, isLoading = false }: TopIssueTableProps) => {
  return (
    <div className="dashboard-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h3 className="text-base font-semibold text-foreground">Top Issue 列表</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">按严重程度和周期排序的关键问题</p>
        </div>
        <Button variant="outline" size="sm" className="gap-2">
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
      </div>
      <div className="overflow-x-auto">
        {isLoading ? (
          <div className="px-5 py-8 text-sm text-muted-foreground">正在加载 Top Issue 数据...</div>
        ) : issues.length === 0 ? (
          <div className="px-5 py-8 text-sm text-muted-foreground">当前筛选条件下暂无 Top Issue 数据。</div>
        ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">ID</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">问题描述</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">严重级别</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">项目</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">状态</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">天数</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue, i) => (
              <tr
                key={issue.ticketId}
                className="border-b border-border/50 transition-colors hover:bg-muted/30 animate-fade-in"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <td className="px-5 py-3.5 text-sm font-mono font-medium text-primary">{issue.ticketId}</td>
                <td className="px-5 py-3.5 text-sm text-foreground">{issue.ticketName}</td>
                <td className="px-5 py-3.5">
                  <Badge className={severityStyles[issue.severity] ?? "bg-muted text-muted-foreground border-0"}>{issue.severity || "Unknown"}</Badge>
                </td>
                <td className="px-5 py-3.5 text-sm text-muted-foreground">{issue.project || "-"}</td>
                <td className="px-5 py-3.5">
                  <Badge variant="secondary" className={statusStyles[issue.status] ?? "bg-muted text-muted-foreground"}>{issue.status || "Unknown"}</Badge>
                </td>
                <td className="px-5 py-3.5 text-right">
                  <span className={`text-sm font-semibold ${issue.ageDays > 30 ? "text-destructive" : issue.ageDays > 14 ? "text-warning" : "text-foreground"}`}>
                    {issue.ageDays}d
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>
    </div>
  );
};

export default TopIssueTable;
