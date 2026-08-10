import { AlertTriangle, Bug, CheckCircle2, Clock, TrendingDown, TrendingUp } from "lucide-react";

const kpis = [
  {
    label: "总缺陷数",
    value: "1,284",
    change: "+12%",
    trend: "up" as const,
    icon: Bug,
    color: "primary",
  },
  {
    label: "已关闭",
    value: "847",
    change: "+8%",
    trend: "up" as const,
    icon: CheckCircle2,
    color: "success",
  },
  {
    label: "进行中",
    value: "312",
    change: "-5%",
    trend: "down" as const,
    icon: Clock,
    color: "warning",
  },
  {
    label: "关键问题",
    value: "125",
    change: "+3%",
    trend: "up" as const,
    icon: AlertTriangle,
    color: "destructive",
  },
];

const colorMap: Record<string, { bg: string; text: string; icon: string }> = {
  primary: {
    bg: "bg-primary/10",
    text: "text-primary",
    icon: "text-primary",
  },
  success: {
    bg: "bg-success/10",
    text: "text-success",
    icon: "text-success",
  },
  warning: {
    bg: "bg-warning/10",
    text: "text-warning",
    icon: "text-warning",
  },
  destructive: {
    bg: "bg-destructive/10",
    text: "text-destructive",
    icon: "text-destructive",
  },
};

const KPICards = () => {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {kpis.map((kpi, i) => {
        const colors = colorMap[kpi.color];
        const Icon = kpi.icon;
        const TrendIcon = kpi.trend === "up" ? TrendingUp : TrendingDown;
        return (
          <div
            key={kpi.label}
            className="dashboard-card p-5 animate-fade-in"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="kpi-label">{kpi.label}</p>
                <p className="kpi-value mt-1">{kpi.value}</p>
              </div>
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${colors.bg}`}>
                <Icon className={`h-5 w-5 ${colors.icon}`} />
              </div>
            </div>
            <div className="mt-3 flex items-center gap-1.5 text-xs">
              <TrendIcon className={`h-3.5 w-3.5 ${kpi.trend === "up" ? "text-success" : "text-destructive"}`} />
              <span className={kpi.trend === "up" ? "text-success" : "text-destructive"}>
                {kpi.change}
              </span>
              <span className="text-muted-foreground">较上月</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default KPICards;
