import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  Database,
  Gauge,
  LayoutDashboard,
  Menu,
  Search,
  Coins,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "./ThemeProvider";
import { ThemeToggle } from "./ThemeToggle";

const navItems = [
  { to: "/admin", label: "数据看板", icon: LayoutDashboard, end: true },
  { to: "/admin/chat-queries", label: "查询记录", icon: Search },
  { to: "/admin/dedup-searches", label: "查重记录", icon: Database },
  { to: "/admin/token-usage", label: "Token 用量", icon: Coins },
  { to: "/admin/system", label: "系统监控", icon: Gauge },
];

const AdminLayout = () => {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (item: (typeof navItems)[number]) =>
    item.end ? location.pathname === item.to : location.pathname.startsWith(item.to);

  return (
    <ThemeProvider>
    <div className="flex h-screen overflow-hidden bg-[hsl(var(--background))]">
      {/* Desktop sidebar */}
      <aside className="hidden w-[240px] shrink-0 flex-col bg-[hsl(var(--sidebar-bg))] md:flex">
        <SidebarContent isActive={isActive} />
      </aside>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute left-0 top-0 flex h-full w-[240px] flex-col bg-[hsl(var(--sidebar-bg))]">
            <SidebarContent
              isActive={isActive}
              onNavigate={() => setMobileOpen(false)}
              showClose
              onClose={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3 md:px-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-[hsl(var(--primary))]" />
              <div>
                <h1 className="text-sm font-bold text-[hsl(var(--foreground))]">
                  Data Agent 后台管理
                </h1>
                <p className="hidden text-xs text-[hsl(var(--muted-foreground))] sm:block">
                  Agent Chat 统计与运维
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link
              to="/"
              className="rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))]"
            >
              返回主看板
            </Link>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </div>
      </main>
    </div>
    </ThemeProvider>
  );
};

function SidebarContent({
  isActive,
  onNavigate,
  showClose,
  onClose,
}: {
  isActive: (item: (typeof navItems)[number]) => boolean;
  onNavigate?: () => void;
  showClose?: boolean;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-5 py-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--sidebar-active))]">
            <Activity className="h-5 w-5 text-white" />
          </div>
          <div className="overflow-hidden">
            <p className="truncate text-sm font-bold text-white">Agent Admin</p>
            <p className="truncate text-xs text-[hsl(var(--sidebar-fg))]">后台管理系统</p>
          </div>
        </div>
        {showClose && (
          <Button variant="ghost" size="icon" onClick={onClose} className="text-white">
            <X className="h-5 w-5" />
          </Button>
        )}
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item);
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                active
                  ? "bg-[hsl(var(--sidebar-active))] font-medium text-white"
                  : "text-[hsl(var(--sidebar-fg))] hover:bg-[hsl(var(--sidebar-hover))] hover:text-white",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[hsl(var(--sidebar-border))] px-5 py-4">
        <p className="text-xs text-[hsl(var(--sidebar-fg))]">v1.0 · 实时数据</p>
        <p className="mt-1 text-xs text-[hsl(var(--sidebar-fg))] opacity-60">
          © 2026 DTSV Intelligence
        </p>
      </div>
    </>
  );
}

export default AdminLayout;
