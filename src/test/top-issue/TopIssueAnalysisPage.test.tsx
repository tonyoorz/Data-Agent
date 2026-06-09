import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TopIssueAnalysis from "@/components/dashboard/pages/TopIssueAnalysis";
import type { MainDashboardSummaryViewModel } from "@/components/dashboard/main-dashboard/mainDashboardTypes";

import { useMainDashboardSummary } from "@/components/dashboard/main-dashboard/useMainDashboardSummary";
import { useTopIssueAnalysis } from "@/components/dashboard/top-issue/useTopIssueAnalysis";

vi.mock("@/components/dashboard/DefectTrendChart", () => ({
  default: () => <div>Defect Trend Chart</div>,
}));

vi.mock("@/components/dashboard/StatusDistributionChart", () => ({
  default: () => <div>Status Distribution Chart</div>,
}));

vi.mock("@/components/dashboard/main-dashboard/useMainDashboardSummary", () => ({
  useMainDashboardSummary: vi.fn(),
}));

vi.mock("@/components/dashboard/top-issue/useTopIssueAnalysis", () => ({
  useTopIssueAnalysis: vi.fn(),
}));

function createSummaryData(): MainDashboardSummaryViewModel {
  return {
    snapshotVersion: "snapshot-1",
    refreshMetadata: {
      activeSnapshotVersion: "snapshot-1",
      refreshStatus: "ready",
      lastSuccessAt: "2026-05-31T00:00:00Z",
    },
    generatedFrom: {
      defectDbPath: "defect.db",
      historyDbPath: "history.db",
      years: ["2026"],
      months: ["2026-05"],
      creationTimeStart: "",
      creationTimeEnd: "",
      requirements: [],
      chinaScopes: ["China", "Global"],
      projects: ["IDCEVO"],
      assignedEcus: [],
      problemFinderTeams: ["DTSV_China"],
      aidas: ["Speech"],
      phases: ["03-In Analysis", "04-In Progress"],
      solutionClusters: ["Integration"],
      pus: ["PU1"],
      markets: ["CN"],
      leadModels: ["NA5"],
      groups: ["Integration"],
    },
    filters: {
      years: ["2026"],
      months: ["2026-05"],
      creationTimeStart: "",
      creationTimeEnd: "",
      requirements: [],
      chinaScopes: ["China", "Global"],
      projects: ["IDCEVO"],
      assignedEcus: [],
      problemFinderTeams: ["DTSV_China"],
      aidas: ["Speech"],
      phases: ["03-In Analysis", "04-In Progress"],
      solutionClusters: ["Integration"],
      pus: ["PU1"],
      markets: ["CN"],
      leadModels: ["NA5"],
      groups: ["Integration"],
    },
    overview: {
      ticketCount: 1,
      resolvedForwardCount: 0,
      rejectedDirectlyCount: 0,
      resolvedForwardPercent: 0,
      rejectedDirectlyPercent: 0,
    },
    outcomeSummary: [],
    teamOutcomeRows: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useMainDashboardSummary).mockReturnValue({
    data: createSummaryData(),
    error: null,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
  } as ReturnType<typeof useMainDashboardSummary>);
  vi.mocked(useTopIssueAnalysis).mockReturnValue({
    data: {
      snapshotVersion: "snapshot-1",
      topIssueRows: [
        {
          ticketId: "D-1",
          ticketName: "Wakeup issue",
          severity: "Critical",
          project: "IDCEVO",
          status: "03-In Analysis",
          ageDays: 12,
          creationTime: "2026-05-01T00:00:00Z",
          ticketDate: "2026-05-13T00:00:00Z",
          classification: "Functional",
        },
      ],
      statusDistribution: [
        { status: "03-In Analysis", count: 1 },
      ],
      defectTrend: [
        { month: "2026-05", newCount: 1, closedCount: 0, inProgressCount: 1 },
      ],
    },
    error: null,
    isLoading: false,
    isFetching: false,
  } as ReturnType<typeof useTopIssueAnalysis>);
});

describe("TopIssueAnalysis page", () => {
  it("renders charts and only presets the recent-month time filter", async () => {
    render(<TopIssueAnalysis />);

    expect(await screen.findByText("Top Issue 列表")).toBeInTheDocument();
    expect(screen.getByText("Wakeup issue")).toBeInTheDocument();
    expect(screen.getByText("Project", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("Defect Trend Chart")).toBeInTheDocument();
    expect(screen.getByText("Status Distribution Chart")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Creation Time filter" })).toHaveTextContent(
      "2026-05-01 to 2026-05-31",
    );
    expect(screen.getByRole("button", { name: "China/Global filter" })).toHaveTextContent("Any");
    expect(screen.getByRole("button", { name: "Project filter" })).toHaveTextContent("Any");
    expect(screen.getByRole("button", { name: "Problem Finder Team filter" })).toHaveTextContent("Any");
    expect(screen.getByRole("button", { name: "Phase filter" })).toHaveTextContent("Any");
  });
});