import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Index from "@/pages/Index";

vi.mock("@/components/dashboard/pages/MainDashboard", () => ({
  default: () => <div>Main Dashboard Page</div>,
}));

vi.mock("@/components/dashboard/pages/TopIssueAnalysis", () => ({
  default: () => <div>Top Issue Analysis Page</div>,
}));

vi.mock("@/components/dashboard/pages/ProjectAnalysis", () => ({
  default: () => <div>Project Analysis Page</div>,
}));

vi.mock("@/components/dashboard/pages/DefectHighFreq", () => ({
  default: () => <div>Defect High Frequency Page</div>,
}));

vi.mock("@/components/dashboard/pages/LongRunnerAnalysis", () => ({
  default: () => <div>Long Runner Analysis Page</div>,
}));

vi.mock("@/components/dashboard/pages/TestTeamAnalysis", () => ({
  default: () => <div>Test Team Analysis Page</div>,
}));

vi.mock("@/components/dashboard/pages/CoverageAnalysis", () => ({
  default: () => <div>Coverage Analysis Page</div>,
}));

vi.mock("@/components/dashboard/pages/TraceabilityAnalysis", () => ({
  default: () => <div>Traceability Analysis Page</div>,
}));

vi.mock("@/components/dashboard/pages/TestStatusAnalysis", () => ({
  default: () => <div>Test Status Analysis Page</div>,
}));

vi.mock("@/components/dashboard/pages/DefectStatusAnalysis", () => ({
  default: () => <div>Defect Status Analysis Page</div>,
}));

vi.mock("@/components/dashboard/pages/QGateKpiReport", () => ({
  default: () => <div>QGate KPI Report Page</div>,
}));

vi.mock("@/components/dashboard/pages/QGateWeeklyReport", () => ({
  default: () => <div>QGate Weekly Report Page</div>,
}));

vi.mock("@/components/dashboard/pages/AIChat", () => ({
  default: () => <div>AI Chat Page</div>,
}));

describe("dashboard language switch", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("switches dashboard chrome between Chinese and English without changing page content", () => {
    render(<Index />);

    expect(screen.getByText("将 Full Picture 数据和交互方式融合到当前数据看板")).toBeInTheDocument();
    expect(screen.getByText("数据已同步 · 暂无日期")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByText("Combines Full Picture data and interactions in this dashboard")).toBeInTheDocument();
    expect(screen.getByText("Data synced · No date")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation")).getByRole("button", { name: /Project Analysis/i })).toBeInTheDocument();
    expect(screen.getByText("Main Dashboard Page")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "中文" }));

    expect(screen.getByText("将 Full Picture 数据和交互方式融合到当前数据看板")).toBeInTheDocument();
    expect(screen.getByText("数据已同步 · 暂无日期")).toBeInTheDocument();
  });
});