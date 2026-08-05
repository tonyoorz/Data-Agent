import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export const languageStorageKey = "vizion.dashboard.language";

export const supportedLanguages = ["zh-CN", "en-US"] as const;
export type AppLanguage = (typeof supportedLanguages)[number];

const resources = {
  "zh-CN": {
    common: {
      language: {
        chinese: "中文",
        english: "English",
      },
      sync: {
        synced: "数据已同步",
        noDate: "暂无日期",
      },
    },
    navigation: {
      productSubtitle: "数据分析平台",
      mainDashboard: {
        label: "Main Dashboard",
        sublabel: "Full Picture 管理总览",
      },
      topIssue: "Top Issue 分析",
      project: "项目分析",
      defectHigh: "缺陷高频分析",
      longRunner: "长周期分析",
      testTeam: "测试团队分析",
      coverage: "测试覆盖率分析",
      traceability: "追溯分析",
      testStatus: "测试状态分析",
      defectStatus: "缺陷状态分析",
      qgateKpiReport: "QGate KPI Report",
      qgateWeeklyReport: "Weekly Report",
      aiChat: "AI Chat",
      agentOperations: "Agent Operations",
      beta: "Beta",
    },
    pages: {
      mainDashboard: {
        title: "Main Dashboard",
        subtitle: "将 Full Picture 数据和交互方式融合到当前数据看板",
      },
      topIssue: {
        title: "Top Issue 分析",
        subtitle: "关键问题追踪与趋势分析",
      },
      project: {
        title: "项目分析",
        subtitle: "多项目缺陷对比与进度总览",
      },
      defectHigh: {
        title: "缺陷高频分析",
        subtitle: "高频缺陷模块识别与根因定位",
      },
      longRunner: {
        title: "长周期分析",
        subtitle: "超期缺陷追踪与周期优化",
      },
      testTeam: {
        title: "测试团队分析",
        subtitle: "团队绩效与能力评估",
      },
      coverage: {
        title: "测试覆盖率分析",
        subtitle: "模块覆盖率监控与提升",
      },
      traceability: {
        title: "追溯分析",
        subtitle: "测试用例覆盖与追溯关系分析",
      },
      testStatus: {
        title: "测试状态分析",
        subtitle: "用例执行状态与通过率",
      },
      defectStatus: {
        title: "缺陷状态分析",
        subtitle: "缺陷生命周期与流转趋势",
      },
      qgateKpiReport: {
        title: "QGate KPI Report",
        subtitle: "QGate KPI Dashboard 迁移视图",
      },
      qgateWeeklyReport: {
        title: "Weekly Report",
        subtitle: "QGate 周报数据视图",
      },
      aiChat: {
        title: "AI Chat",
        subtitle: "与 DTSV 智能体对话，获取分析洞察",
      },
      agentOperations: {
        title: "Agent Operations",
        subtitle: "已脱敏的智能体运行、恢复与证据状态",
      },
    },
  },
  "en-US": {
    common: {
      language: {
        chinese: "中文",
        english: "English",
      },
      sync: {
        synced: "Data synced",
        noDate: "No date",
      },
    },
    navigation: {
      productSubtitle: "Data analytics platform",
      mainDashboard: {
        label: "Main Dashboard",
        sublabel: "Full Picture overview",
      },
      topIssue: "Top Issue Analysis",
      project: "Project Analysis",
      defectHigh: "Defect Frequency Analysis",
      longRunner: "Long Runner Analysis",
      testTeam: "Test Team Analysis",
      coverage: "Testing Coverage Analysis",
      traceability: "Traceability Analysis",
      testStatus: "Test Status Analysis",
      defectStatus: "Defect Status Analysis",
      qgateKpiReport: "QGate KPI Report",
      qgateWeeklyReport: "Weekly Report",
      aiChat: "AI Chat",
      agentOperations: "Agent Operations",
      beta: "Beta",
    },
    pages: {
      mainDashboard: {
        title: "Main Dashboard",
        subtitle: "Combines Full Picture data and interactions in this dashboard",
      },
      topIssue: {
        title: "Top Issue Analysis",
        subtitle: "Track key issues and trend changes",
      },
      project: {
        title: "Project Analysis",
        subtitle: "Compare defects and progress across projects",
      },
      defectHigh: {
        title: "Defect Frequency Analysis",
        subtitle: "Identify recurring defect modules and root causes",
      },
      longRunner: {
        title: "Long Runner Analysis",
        subtitle: "Track overdue defects and optimize cycle time",
      },
      testTeam: {
        title: "Test Team Analysis",
        subtitle: "Evaluate team performance and capability",
      },
      coverage: {
        title: "Testing Coverage Analysis",
        subtitle: "Monitor and improve module coverage",
      },
      traceability: {
        title: "Traceability Analysis",
        subtitle: "Analyze testcase coverage and traceability relations",
      },
      testStatus: {
        title: "Test Status Analysis",
        subtitle: "Review testcase execution status and pass rate",
      },
      defectStatus: {
        title: "Defect Status Analysis",
        subtitle: "Analyze defect lifecycle and status flow",
      },
      qgateKpiReport: {
        title: "QGate KPI Report",
        subtitle: "Migrated QGate KPI Dashboard view",
      },
      qgateWeeklyReport: {
        title: "Weekly Report",
        subtitle: "QGate weekly report data view",
      },
      aiChat: {
        title: "AI Chat",
        subtitle: "Chat with the DTSV agent for analytical insights",
      },
      agentOperations: {
        title: "Agent Operations",
        subtitle: "Sanitized agent runtime, recovery, and evidence status",
      },
    },
  },
} as const;

function isSupportedLanguage(value: string | null | undefined): value is AppLanguage {
  return supportedLanguages.includes(value as AppLanguage);
}

function getStoredLanguage(): AppLanguage {
  if (typeof window === "undefined") {
    return "zh-CN";
  }

  const storedLanguage = window.localStorage.getItem(languageStorageKey);
  return isSupportedLanguage(storedLanguage) ? storedLanguage : "zh-CN";
}

if (!i18n.isInitialized) {
  void i18n
    .use(initReactI18next)
    .init({
      resources,
      lng: getStoredLanguage(),
      fallbackLng: "zh-CN",
      defaultNS: "common",
      ns: ["common", "navigation", "pages"],
      interpolation: {
        escapeValue: false,
      },
      react: {
        useSuspense: false,
      },
    });
}

export default i18n;