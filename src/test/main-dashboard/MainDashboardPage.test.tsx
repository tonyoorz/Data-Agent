import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MainDashboardViewModel } from "@/components/dashboard/main-dashboard/mainDashboardTypes";
import Index from "@/pages/Index";

import { useMainDashboardData } from "@/components/dashboard/main-dashboard/useMainDashboardData";

vi.mock("@/components/dashboard/FilterPanel", () => ({
  default: () => <div>Filter Panel</div>,
}));

vi.mock("@/components/dashboard/KPICards", () => ({
  default: () => <div>KPI Cards</div>,
}));

vi.mock("@/components/dashboard/DefectTrendChart", () => ({
  default: () => <div>Defect Trend Chart</div>,
}));

vi.mock("@/components/dashboard/StatusDistributionChart", () => ({
  default: () => <div>Status Distribution Chart</div>,
}));

vi.mock("@/components/dashboard/TopIssueTable", () => ({
  default: () => <div>Top Issue Table</div>,
}));

vi.mock("@/components/dashboard/AIAssistant", () => ({
  default: () => <div>AI Assistant</div>,
}));

vi.mock("@/components/dashboard/main-dashboard/useMainDashboardData", () => ({
  useMainDashboardData: vi.fn(),
}));

vi.mock("@/components/dashboard/pages/ProjectAnalysis", () => ({
  default: () => <div>Project Analysis</div>,
}));

vi.mock("@/components/dashboard/pages/DefectHighFreq", () => ({
  default: () => <div>Defect High Frequency</div>,
}));

vi.mock("@/components/dashboard/pages/LongRunnerAnalysis", () => ({
  default: () => <div>Long Runner Analysis</div>,
}));

vi.mock("@/components/dashboard/pages/TestTeamAnalysis", () => ({
  default: () => <div>Test Team Analysis</div>,
}));

vi.mock("@/components/dashboard/pages/CoverageAnalysis", () => ({
  default: () => <div>Coverage Analysis</div>,
}));

vi.mock("@/components/dashboard/pages/TestStatusAnalysis", () => ({
  default: () => <div>Test Status Analysis</div>,
}));

vi.mock("@/components/dashboard/pages/DefectStatusAnalysis", () => ({
  default: () => <div>Defect Status Analysis</div>,
}));

vi.mock("@/components/dashboard/pages/AIChat", () => ({
  default: () => <div>AI Chat</div>,
}));

function createSampleViewModel(): MainDashboardViewModel {
  return {
    generatedFrom: {
      defectDbPath: "defect.db",
      historyDbPath: "history.db",
      years: ["2026"],
      projects: ["G68", "U12"],
      assignedEcus: ["ECU-A", "ECU-B"],
      problemFinderTeams: ["DTSV_China", "[AT]W72-FIT"],
      aidas: ["Digital", "EE"],
      phases: ["Validation", "Analysis"],
      solutionClusters: ["Integration", "CoC"],
      pus: ["PU1", "PU2"],
      markets: ["CN", "EU"],
      leadModels: ["LM1", "LM2"],
      groups: ["Integration", "Q-Gate"],
    },
    filters: {
      years: ["2025", "2026"],
      projects: ["G68", "U12"],
      assignedEcus: ["ECU-A", "ECU-B"],
      problemFinderTeams: ["DTSV_China", "[AT]W72-FIT"],
      aidas: ["Digital", "EE"],
      phases: ["Validation", "Analysis"],
      solutionClusters: ["Integration", "CoC"],
      pus: ["PU1", "PU2"],
      markets: ["CN", "EU"],
      leadModels: ["LM1", "LM2"],
      groups: ["Integration", "Q-Gate"],
    },
    overview: {
      ticketCount: 5,
      resolvedForwardCount: 3,
      rejectedDirectlyCount: 1,
      resolvedForwardPercent: 60,
      rejectedDirectlyPercent: 20,
    },
    outcomeSummary: [
      {
        key: "resolvedForward",
        label: "Resolved Forward (08 -> 06)",
        count: 3,
        percent: 60,
        denominator: 5,
      },
      {
        key: "rejectedDirectly",
        label: "Rejected Directly (01 -> 09)",
        count: 1,
        percent: 20,
        denominator: 5,
      },
    ],
    teamOutcomeRows: [
      {
        problemFinderTeam: "DTSV_China",
        totalTickets: 3,
        resolvedForwardCount: 2,
        rejectedDirectlyCount: 1,
        resolvedForwardTeamPercent: 66.67,
        rejectedDirectlyTeamPercent: 33.33,
        teamDenominator: 3,
      },
      {
        problemFinderTeam: "[AT]W72-FIT",
        totalTickets: 2,
        resolvedForwardCount: 1,
        rejectedDirectlyCount: 1,
        resolvedForwardTeamPercent: 50,
        rejectedDirectlyTeamPercent: 50,
        teamDenominator: 2,
      },
    ],
    ticketRows: [
      {
        ticketId: "1001",
        ticketName: "Alpha power reset",
        status: "03-In Analysis",
        problemFinderTeam: "DTSV_China",
        group: "Integration",
        phase: "Validation",
        isResolvedForward: true,
        isRejectedDirectly: false,
        year: "2026",
        project: "G68",
        assignedEcu: "ECU-A",
        aida: "Digital",
        solutionCluster: "Integration",
        pu: "PU1",
        market: "CN",
        leadModel: "LM1",
      },
      {
        ticketId: "1002",
        ticketName: "Beta thermal flicker",
        status: "04-In Progress",
        problemFinderTeam: "[AT]W72-FIT",
        group: "Q-Gate",
        phase: "Analysis",
        isResolvedForward: false,
        isRejectedDirectly: true,
        year: "2026",
        project: "U12",
        assignedEcu: "ECU-B",
        aida: "EE",
        solutionCluster: "CoC",
        pu: "PU2",
        market: "EU",
        leadModel: "LM2",
      },
      {
        ticketId: "1003",
        ticketName: "Gamma search match",
        status: "06-Delivered",
        problemFinderTeam: "DTSV_China",
        group: "Integration",
        phase: "Validation",
        isResolvedForward: true,
        isRejectedDirectly: false,
        year: "2025",
        project: "G68",
        assignedEcu: "ECU-A",
        aida: "Digital",
        solutionCluster: "Integration",
        pu: "PU1",
        market: "CN",
        leadModel: "LM1",
      },
      {
        ticketId: "1004",
        ticketName: "Delta gateway timeout",
        status: "01-New",
        problemFinderTeam: "DTSV_China",
        group: "Integration",
        phase: "Validation",
        isResolvedForward: false,
        isRejectedDirectly: false,
        year: "2026",
        project: "G68",
        assignedEcu: "ECU-A",
        aida: "Digital",
        solutionCluster: "Integration",
        pu: "PU1",
        market: "CN",
        leadModel: "LM1",
      },
      {
        ticketId: "1005",
        ticketName: "Epsilon sensor desync",
        status: "08-Resolved",
        problemFinderTeam: "[AT]W72-FIT",
        group: "Q-Gate",
        phase: "Analysis",
        isResolvedForward: true,
        isRejectedDirectly: false,
        year: "2026",
        project: "U12",
        assignedEcu: "ECU-B",
        aida: "EE",
        solutionCluster: "CoC",
        pu: "PU2",
        market: "EU",
        leadModel: "LM2",
      },
    ],
  };
}

function expectKpiValues(values: {
  tickets: string;
  resolvedForward: string;
  rejectedDirectly: string;
  teams: string;
}) {
  expect(
    within(screen.getByRole("article", { name: "Tickets in scope" })).getByText(values.tickets),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("article", { name: "Resolved Forward" })).getByText(
      values.resolvedForward,
    ),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("article", { name: "Rejected Directly" })).getByText(
      values.rejectedDirectly,
    ),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("article", { name: "Teams in scope" })).getByText(values.teams),
  ).toBeInTheDocument();
}

function expectTicketDetailRows(values: {
  count: string;
  present: string[];
  absent?: string[];
}) {
  const section = screen.getByText("Ticket Detail").closest("section");
  const table = screen.getByRole("table", { name: "Ticket detail table" });

  expect(section).not.toBeNull();
  expect(
    within(section as HTMLElement).getByText(new RegExp(`^${values.count}( of \\d+)? tickets$`)),
  ).toBeInTheDocument();

  values.present.forEach((value) => {
    expect(within(table).getByText(value)).toBeInTheDocument();
  });

  values.absent?.forEach((value) => {
    expect(within(table).queryByText(value)).not.toBeInTheDocument();
  });
}

function renderIndexWithMockedData(initialData = createSampleViewModel()) {
  let currentData = initialData;

  vi.mocked(useMainDashboardData).mockImplementation(() => ({
    data: currentData,
    error: null,
    isLoading: false,
  }));

  const rendered = render(<Index />);

  return {
    ...rendered,
    rerenderWithData(nextData: MainDashboardViewModel) {
      currentData = nextData;
      rendered.rerender(<Index />);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Index main dashboard integration", () => {
  it("shows a loading state while Full Picture data is fetching", () => {
    vi.mocked(useMainDashboardData).mockReturnValue({
      data: null,
      error: null,
      isLoading: true,
    } as ReturnType<typeof useMainDashboardData>);

    render(<Index />);

    expect(screen.getByText("Loading Full Picture data...")).toBeInTheDocument();
    expect(screen.queryByText("Solution Outcome")).not.toBeInTheDocument();
  });

  it("shows an error panel when Full Picture data cannot be loaded", () => {
    vi.mocked(useMainDashboardData).mockReturnValue({
      data: null,
      error: new Error("Service unavailable"),
      isLoading: false,
    } as ReturnType<typeof useMainDashboardData>);

    render(<Index />);

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load Full Picture data.");
    expect(screen.getByRole("alert")).toHaveTextContent("Service unavailable");
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("将 Full Picture 数据和交互方式融合到当前数据看板")).toBeInTheDocument();
  });

  it("shows Main Dashboard in the sidebar and renders Task 4 controls from loaded data", () => {
    renderIndexWithMockedData();

    const navButtons = within(screen.getByRole("navigation")).getAllByRole("button");

    expect(navButtons[0]).toHaveTextContent("Main Dashboard");
    expect(navButtons[0]).toHaveTextContent("Full Picture 管理总览");
    expect(navButtons[1]).toHaveTextContent("Top Issue 分析");
    expect(screen.getByPlaceholderText("Search ticket ID or title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Year filter" })).toHaveTextContent("2026");
    expect(screen.getByText("Year", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("Project", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Tickets in scope" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Resolved Forward" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Rejected Directly" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Teams in scope" })).toBeInTheDocument();
    expectKpiValues({
      tickets: "4",
      resolvedForward: "2",
      rejectedDirectly: "1",
      teams: "2",
    });
  });

  it("uses generated-from year defaults to scope KPI output on first render", () => {
    renderIndexWithMockedData();

    expectKpiValues({
      tickets: "4",
      resolvedForward: "2",
      rejectedDirectly: "1",
      teams: "2",
    });
    expect(screen.getByRole("button", { name: "Year filter" })).toHaveTextContent("2026");
  });

  it("updates KPI output when the search text changes", () => {
    renderIndexWithMockedData();

    fireEvent.change(screen.getByPlaceholderText("Search ticket ID or title"), {
      target: { value: "delta" },
    });

    expectKpiValues({
      tickets: "1",
      resolvedForward: "0",
      rejectedDirectly: "0",
      teams: "1",
    });
  });

  it("hides and shows the filter grid when the toolbar toggle changes", () => {
    renderIndexWithMockedData();

    const filtersToggle = screen.getByRole("button", { name: "Filters" });

    expect(screen.getByText("Year", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    fireEvent.click(filtersToggle);
    expect(screen.queryByText("Year", { selector: ".workbench-filter-label" })).not.toBeInTheDocument();
    fireEvent.click(filtersToggle);
    expect(screen.getByText("Year", { selector: ".workbench-filter-label" })).toBeInTheDocument();
  });

  it("resets search and restores default scoped KPI output", () => {
    renderIndexWithMockedData();

    fireEvent.change(screen.getByPlaceholderText("Search ticket ID or title"), {
      target: { value: "delta" },
    });
    expectKpiValues({
      tickets: "1",
      resolvedForward: "0",
      rejectedDirectly: "0",
      teams: "1",
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.getByPlaceholderText("Search ticket ID or title")).toHaveValue("");
    expectKpiValues({
      tickets: "4",
      resolvedForward: "2",
      rejectedDirectly: "1",
      teams: "2",
    });
    expect(screen.getByRole("button", { name: "Year filter" })).toHaveTextContent("2026");
  });

  it("resets search and selected filters on data refresh while preserving filtersOpen", () => {
    const { rerenderWithData } = renderIndexWithMockedData();

    fireEvent.change(screen.getByPlaceholderText("Search ticket ID or title"), {
      target: { value: "beta" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Project filter" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Project U12" }));
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    rerenderWithData(createSampleViewModel());

    expect(screen.getByPlaceholderText("Search ticket ID or title")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Filters" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Year", { selector: ".workbench-filter-label" })).not.toBeInTheDocument();
    expectKpiValues({
      tickets: "4",
      resolvedForward: "2",
      rejectedDirectly: "1",
      teams: "2",
    });

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("button", { name: "Project filter" })).toHaveTextContent("Any");
    expect(screen.getByRole("button", { name: "Year filter" })).toHaveTextContent("2026");
  });

  it("renders each filter option as a single checkbox control", () => {
    renderIndexWithMockedData();

    fireEvent.click(screen.getByRole("button", { name: "Year filter" }));

    const option = screen.getByRole("checkbox", { name: "Year 2026" });

    expect(option.parentElement?.closest("button")).toBeNull();
  });

  it("narrows the ticket detail table from outcome and team drilldowns and can clear selection", () => {
    renderIndexWithMockedData();

    expect(screen.getByText("Solution Outcome")).toBeInTheDocument();
    expect(screen.getByText("Team Expansion")).toBeInTheDocument();
    expect(screen.getByText("Ticket Detail")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-analysis-panels")).toHaveClass("space-y-4");
    expect(screen.getByTestId("team-expansion-chart")).toBeInTheDocument();

    expectTicketDetailRows({
      count: "4",
      present: ["1001", "1002", "1004", "1005"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Resolved Forward (08 -> 06)" }));

    expect(screen.getByText("Outcome: Resolved Forward (08 -> 06)")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "[AT]W72-FIT Rejected Directly (01 -> 09)",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expectTicketDetailRows({
      count: "2",
      present: ["1001", "1005"],
      absent: ["1002", "1004", "Beta thermal flicker", "Delta gateway timeout"],
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "[AT]W72-FIT Resolved Forward (08 -> 06)",
      }),
    );

    expect(screen.getByText("Team: [AT]W72-FIT")).toBeInTheDocument();
    expectTicketDetailRows({
      count: "1",
      present: ["1005", "Epsilon sensor desync"],
      absent: ["1001", "1002", "1004", "Alpha power reset"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Resolved Forward (08 -> 06)" }));

    expect(screen.queryByText("Outcome: Resolved Forward (08 -> 06)")).not.toBeInTheDocument();
    expect(screen.queryByText("Team: [AT]W72-FIT")).not.toBeInTheDocument();
    expectTicketDetailRows({
      count: "4",
      present: ["1001", "1002", "1004", "1005"],
      absent: ["1003", "Gamma search match"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Resolved Forward (08 -> 06)" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "[AT]W72-FIT Resolved Forward (08 -> 06)",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));

    expect(screen.queryByText("Outcome: Resolved Forward (08 -> 06)")).not.toBeInTheDocument();
    expect(screen.queryByText("Team: [AT]W72-FIT")).not.toBeInTheDocument();
    expectTicketDetailRows({
      count: "4",
      present: ["1001", "1002", "1004", "1005"],
      absent: ["1003", "Gamma search match"],
    });
  });

  it("clears drilldown without resetting the broader filter scope", () => {
    renderIndexWithMockedData();

    fireEvent.click(screen.getByRole("button", { name: "Project filter" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Project U12" }));

    expect(screen.getByRole("button", { name: "Project filter" })).toHaveTextContent("U12");
    expectTicketDetailRows({
      count: "2",
      present: ["1002", "1005"],
      absent: ["1001", "1004", "1003"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Resolved Forward (08 -> 06)" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "[AT]W72-FIT Resolved Forward (08 -> 06)",
      }),
    );

    expectTicketDetailRows({
      count: "1",
      present: ["1005"],
      absent: ["1002", "1001", "1004"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));

    expect(screen.getByRole("button", { name: "Project filter" })).toHaveTextContent("U12");
    expectTicketDetailRows({
      count: "2",
      present: ["1002", "1005"],
      absent: ["1001", "1004", "1003"],
    });
  });

  it("allows drilling into a team outcome directly from the team panel", () => {
    renderIndexWithMockedData();

    fireEvent.click(
      screen.getByRole("button", {
        name: "[AT]W72-FIT Rejected Directly (01 -> 09)",
      }),
    );

    expect(screen.getByText("Outcome: Rejected Directly (01 -> 09)")).toBeInTheDocument();
    expect(screen.getByText("Team: [AT]W72-FIT")).toBeInTheDocument();
    expectTicketDetailRows({
      count: "1",
      present: ["1002", "Beta thermal flicker"],
      absent: ["1001", "1004", "1005", "Epsilon sensor desync"],
    });
  });
});