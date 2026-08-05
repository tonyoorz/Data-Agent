import { useState } from "react";
import { useTranslation } from "react-i18next";
import DashboardSidebar from "@/components/dashboard/DashboardSidebar";
import LanguageSwitcher from "@/components/dashboard/LanguageSwitcher";
import ProjectAnalysis from "@/components/dashboard/pages/ProjectAnalysis";
import DefectHighFreq from "@/components/dashboard/pages/DefectHighFreq";
import LongRunnerAnalysis from "@/components/dashboard/pages/LongRunnerAnalysis";
import TestTeamAnalysis from "@/components/dashboard/pages/TestTeamAnalysis";
import CoverageAnalysis from "@/components/dashboard/pages/CoverageAnalysis";
import TraceabilityAnalysis from "@/components/dashboard/pages/TraceabilityAnalysis";
import TestStatusAnalysis from "@/components/dashboard/pages/TestStatusAnalysis";
import DefectStatusAnalysis from "@/components/dashboard/pages/DefectStatusAnalysis";
import AIChat from "@/components/dashboard/pages/AIChat";
import MainDashboard from "@/components/dashboard/pages/MainDashboard";
import TopIssueAnalysis from "@/components/dashboard/pages/TopIssueAnalysis";
import QGateKpiReport from "@/components/dashboard/pages/QGateKpiReport";
import QGateWeeklyReport from "@/components/dashboard/pages/QGateWeeklyReport";
import AgentOperations from "@/components/dashboard/pages/AgentOperations";
import { formatSyncTimestamp } from "@/lib/formatSyncTimestamp";

import "@/i18n";

const pageTitleKeys: Record<string, { titleKey: string; subtitleKey: string }> = {
  "main-dashboard": {
    titleKey: "mainDashboard.title",
    subtitleKey: "mainDashboard.subtitle",
  },
  topissue: { titleKey: "topIssue.title", subtitleKey: "topIssue.subtitle" },
  project: { titleKey: "project.title", subtitleKey: "project.subtitle" },
  "defect-high": { titleKey: "defectHigh.title", subtitleKey: "defectHigh.subtitle" },
  "long-runner": { titleKey: "longRunner.title", subtitleKey: "longRunner.subtitle" },
  "test-team": { titleKey: "testTeam.title", subtitleKey: "testTeam.subtitle" },
  coverage: { titleKey: "coverage.title", subtitleKey: "coverage.subtitle" },
  traceability: { titleKey: "traceability.title", subtitleKey: "traceability.subtitle" },
  "test-status": { titleKey: "testStatus.title", subtitleKey: "testStatus.subtitle" },
  "defect-status": { titleKey: "defectStatus.title", subtitleKey: "defectStatus.subtitle" },
  "qgate-kpi-report": { titleKey: "qgateKpiReport.title", subtitleKey: "qgateKpiReport.subtitle" },
  "qgate-weekly-report": { titleKey: "qgateWeeklyReport.title", subtitleKey: "qgateWeeklyReport.subtitle" },
  "ai-chat": { titleKey: "aiChat.title", subtitleKey: "aiChat.subtitle" },
  "agent-operations": { titleKey: "agentOperations.title", subtitleKey: "agentOperations.subtitle" },
};

const Index = () => {
  const { t } = useTranslation(["common", "pages"]);
  const [activeNav, setActiveNav] = useState("main-dashboard");
  const [mainDashboardSyncDate, setMainDashboardSyncDate] = useState<string | null>(null);
  const info = pageTitleKeys[activeNav] || pageTitleKeys["main-dashboard"];
  const pageTitle = t(info.titleKey, { ns: "pages" });
  const formattedMainDashboardSyncDate = formatSyncTimestamp(mainDashboardSyncDate);

  const renderContent = () => {
    switch (activeNav) {
      case "main-dashboard":
        return <MainDashboard onSyncDateChange={setMainDashboardSyncDate} />;
      case "topissue":
        return <TopIssueAnalysis onSyncDateChange={setMainDashboardSyncDate} />;
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
      case "traceability":
        return <TraceabilityAnalysis />;
      case "test-status":
        return <TestStatusAnalysis />;
      case "defect-status":
        return <DefectStatusAnalysis />;
      case "qgate-kpi-report":
        return <QGateKpiReport />;
      case "qgate-weekly-report":
        return <QGateWeeklyReport />;
      case "ai-chat":
        return <AIChat moduleKey={activeNav} moduleLabel={pageTitle} />;
      case "agent-operations":
        return <AgentOperations />;
      default:
        return <MainDashboard onSyncDateChange={setMainDashboardSyncDate} />;
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <DashboardSidebar active={activeNav} onNavigate={setActiveNav} />

      <main className="min-h-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-background/80 backdrop-blur-md px-6 py-3.5">
          <div>
            <h1 className="text-lg font-bold text-foreground">{pageTitle}</h1>
            <p className="text-xs text-muted-foreground">{t(info.subtitleKey, { ns: "pages" })}</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <LanguageSwitcher />
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-success" />
              {`${t("sync.synced")} · ${formattedMainDashboardSyncDate ?? t("sync.noDate")}`}
            </div>
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
