import { useState } from "react";
import DashboardSidebar from "@/components/dashboard/DashboardSidebar";
import FilterPanel from "@/components/dashboard/FilterPanel";
import KPICards from "@/components/dashboard/KPICards";
import DefectTrendChart from "@/components/dashboard/DefectTrendChart";
import StatusDistributionChart from "@/components/dashboard/StatusDistributionChart";
import TopIssueTable from "@/components/dashboard/TopIssueTable";
import ProjectAnalysis from "@/components/dashboard/pages/ProjectAnalysis";
import DefectHighFreq from "@/components/dashboard/pages/DefectHighFreq";
import LongRunnerAnalysis from "@/components/dashboard/pages/LongRunnerAnalysis";
import TestTeamAnalysis from "@/components/dashboard/pages/TestTeamAnalysis";
import CoverageAnalysis from "@/components/dashboard/pages/CoverageAnalysis";
import TestStatusAnalysis from "@/components/dashboard/pages/TestStatusAnalysis";
import DefectStatusAnalysis from "@/components/dashboard/pages/DefectStatusAnalysis";
import AIChat from "@/components/dashboard/pages/AIChat";
import MainDashboard from "@/components/dashboard/pages/MainDashboard";
import { formatSyncTimestamp } from "@/lib/formatSyncTimestamp";

const pageTitles: Record<string, { title: string; subtitle: string }> = {
  "main-dashboard": {
    title: "Main Dashboard",
    subtitle: "将 Full Picture 数据和交互方式融合到当前数据看板",
  },
  topissue: { title: "Top Issue 分析", subtitle: "关键问题追踪与趋势分析" },
  project: { title: "项目分析", subtitle: "多项目缺陷对比与进度总览" },
  "defect-high": { title: "缺陷高频分析", subtitle: "高频缺陷模块识别与根因定位" },
  "long-runner": { title: "长周期分析", subtitle: "超期缺陷追踪与周期优化" },
  "test-team": { title: "测试团队分析", subtitle: "团队绩效与能力评估" },
  coverage: { title: "测试覆盖率分析", subtitle: "模块覆盖率监控与提升" },
  "test-status": { title: "测试状态分析", subtitle: "用例执行状态与通过率" },
  "defect-status": { title: "缺陷状态分析", subtitle: "缺陷生命周期与流转趋势" },
  "ai-chat": { title: "AI Chat", subtitle: "与 DTSV 智能体对话，获取分析洞察" },
};

const Index = () => {
  const [activeNav, setActiveNav] = useState("main-dashboard");
  const [mainDashboardSyncDate, setMainDashboardSyncDate] = useState<string | null>(null);
  const info = pageTitles[activeNav] || pageTitles["main-dashboard"];
  const formattedMainDashboardSyncDate = formatSyncTimestamp(mainDashboardSyncDate);

  const renderContent = () => {
    switch (activeNav) {
      case "main-dashboard":
        return <MainDashboard onSyncDateChange={setMainDashboardSyncDate} />;
      case "project":
        return <ProjectAnalysis />;
      case "defect-high":
        return <DefectHighFreq />;
      case "long-runner":
        return <LongRunnerAnalysis />;
      case "test-team":
        return <TestTeamAnalysis />;
      case "coverage":
        return <CoverageAnalysis />;
      case "test-status":
        return <TestStatusAnalysis />;
      case "defect-status":
        return <DefectStatusAnalysis />;
      case "ai-chat":
        return <AIChat moduleKey={activeNav} moduleLabel={info.title} />;
      default:
        return (
          <>
            <FilterPanel />
            <KPICards />
            <div className="grid gap-5 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <DefectTrendChart />
              </div>
              <div className="lg:col-span-2">
                <StatusDistributionChart />
              </div>
            </div>
            <TopIssueTable />
          </>
        );
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <DashboardSidebar active={activeNav} onNavigate={setActiveNav} />

      <main className="min-h-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-background/80 backdrop-blur-md px-6 py-3.5">
          <div>
            <h1 className="text-lg font-bold text-foreground">{info.title}</h1>
            <p className="text-xs text-muted-foreground">{info.subtitle}</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex h-2 w-2 rounded-full bg-success" />
            {`数据已同步 · ${formattedMainDashboardSyncDate ?? "暂无日期"}`}
          </div>
        </header>

        <div className="space-y-5 p-6">
          {renderContent()}
        </div>
      </main>
    </div>
  );
};

export default Index;
