import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart3,
  Activity,
  Bug,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  LayoutDashboard,
  LineChart,
  ListChecks,
  Network,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";

import "@/i18n";

const navItems = [
  {
    id: "main-dashboard",
    labelKey: "mainDashboard.label",
    sublabelKey: "mainDashboard.sublabel",
    icon: LayoutDashboard,
  },
  { id: "topissue", labelKey: "topIssue", icon: TrendingUp },
  { id: "project", labelKey: "project", icon: LayoutDashboard },
  { id: "defect-high", labelKey: "defectHigh", icon: Bug },
  { id: "long-runner", labelKey: "longRunner", icon: LineChart },
  { id: "test-team", labelKey: "testTeam", icon: Users },
  { id: "coverage", labelKey: "coverage", icon: ShieldCheck },
  { id: "traceability", labelKey: "traceability", icon: Network },
  { id: "test-status", labelKey: "testStatus", icon: ListChecks },
  { id: "defect-status", labelKey: "defectStatus", icon: BarChart3 },
  { id: "qgate-kpi-report", labelKey: "qgateKpiReport", icon: BarChart3 },
  { id: "qgate-weekly-report", labelKey: "qgateWeeklyReport", icon: CalendarDays },
  { id: "ai-chat", labelKey: "aiChat", icon: Sparkles, badgeKey: "beta" },
  { id: "agent-operations", labelKey: "agentOperations", icon: Activity },
];

interface DashboardSidebarProps {
  active: string;
  onNavigate: (id: string) => void;
}

const DashboardSidebar = ({ active, onNavigate }: DashboardSidebarProps) => {
  const { t } = useTranslation("navigation");
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={`relative flex flex-col bg-[hsl(var(--sidebar-bg))] transition-all duration-300 ${
        collapsed ? "w-[68px]" : "w-[240px]"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-6">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary">
          <FlaskConical className="h-5 w-5 text-primary-foreground" />
        </div>
        {!collapsed && (
          <div className="overflow-hidden">
            <h1 className="truncate text-sm font-bold text-[hsl(0,0%,95%)]">DTSV</h1>
            <p className="truncate text-xs text-[hsl(var(--sidebar-fg))]">{t("productSubtitle")}</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3">
        {navItems.map((item) => {
          const isActive = active === item.id;
          const Icon = item.icon;
          const label = t(item.labelKey);
          const sublabel = "sublabelKey" in item && item.sublabelKey ? t(item.sublabelKey) : "";
          const badge = "badgeKey" in item && item.badgeKey ? t(item.badgeKey) : "";
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`nav-item w-full ${isActive ? "nav-item-active" : "nav-item-inactive"}`}
              title={collapsed ? label : undefined}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              {!collapsed && (
                <>
                  <div className="flex flex-1 flex-col overflow-hidden text-left">
                    <span className="truncate">{label}</span>
                    {sublabel ? (
                      <span className="truncate text-[11px] text-[hsl(var(--sidebar-fg))]">
                        {sublabel}
                      </span>
                    ) : null}
                  </div>
                  {badge ? (
                    <span className="rounded-md bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-primary">
                      {badge}
                    </span>
                  ) : null}
                </>
              )}
            </button>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-20 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card shadow-sm hover:bg-secondary transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronLeft className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
    </aside>
  );
};

export default DashboardSidebar;
