import { useState } from "react";
import {
  BarChart3,
  Bug,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  LayoutDashboard,
  LineChart,
  ListChecks,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";

const navItems = [
  {
    id: "main-dashboard",
    label: "Main Dashboard",
    sublabel: "Full Picture 管理总览",
    icon: LayoutDashboard,
  },
  { id: "topissue", label: "Top Issue 分析", icon: TrendingUp },
  { id: "project", label: "项目分析", icon: LayoutDashboard },
  { id: "defect-high", label: "缺陷高频分析", icon: Bug },
  { id: "long-runner", label: "长周期分析", icon: LineChart },
  { id: "test-team", label: "测试团队分析", icon: Users },
  { id: "coverage", label: "测试覆盖率分析", icon: ShieldCheck },
  { id: "test-status", label: "测试状态分析", icon: ListChecks },
  { id: "defect-status", label: "缺陷状态分析", icon: BarChart3 },
  { id: "ai-chat", label: "AI Chat", icon: Sparkles, badge: "Beta" as const },
];

interface DashboardSidebarProps {
  active: string;
  onNavigate: (id: string) => void;
}

const DashboardSidebar = ({ active, onNavigate }: DashboardSidebarProps) => {
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
            <p className="truncate text-xs text-[hsl(var(--sidebar-fg))]">数据分析平台</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3">
        {navItems.map((item) => {
          const isActive = active === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`nav-item w-full ${isActive ? "nav-item-active" : "nav-item-inactive"}`}
              title={collapsed ? item.label : undefined}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              {!collapsed && (
                <>
                  <div className="flex flex-1 flex-col overflow-hidden text-left">
                    <span className="truncate">{item.label}</span>
                    {"sublabel" in item && item.sublabel && (
                      <span className="truncate text-[11px] text-[hsl(var(--sidebar-fg))]">
                        {item.sublabel}
                      </span>
                    )}
                  </div>
                  {"badge" in item && item.badge && (
                    <span className="rounded-md bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-primary">
                      {item.badge}
                    </span>
                  )}
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
