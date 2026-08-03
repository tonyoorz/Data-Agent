import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyMainDashboardFilters } from "@/components/dashboard/main-dashboard/mainDashboardFiltering";
import type { MainDashboardFilters, MainDashboardViewModel } from "@/components/dashboard/main-dashboard/mainDashboardTypes";
import Index from "@/pages/Index";

import { useMainDashboardRefreshStatus } from "@/components/dashboard/main-dashboard/useMainDashboardRefreshStatus";
import { useMainDashboardSummary } from "@/components/dashboard/main-dashboard/useMainDashboardSummary";
import { useMainDashboardTickets } from "@/components/dashboard/main-dashboard/useMainDashboardTickets";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 0,
        retry: 0,
      },
    },
  });
}

function renderIndex(queryClient = createQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Index />
    </QueryClientProvider>,
  );
}

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

vi.mock("@/components/dashboard/main-dashboard/useMainDashboardRefreshStatus", () => ({
  useMainDashboardRefreshStatus: vi.fn(),
}));

vi.mock("@/components/dashboard/main-dashboard/useMainDashboardSummary", () => ({
  useMainDashboardSummary: vi.fn(),
}));

vi.mock("@/components/dashboard/main-dashboard/useMainDashboardTickets", () => ({
  useMainDashboardTickets: vi.fn(),
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
      months: ["2026-04", "2026-03", "2025-11"],
      creationTimeStart: "",
      creationTimeEnd: "",
      requirements: [],
      chinaScopes: ["China", "Global"],
      projects: ["G68", "U12"],
      assignedEcus: ["ECU-A", "ECU-B"],
      problemFinderTeams: ["DTSV_China", "[AT]W72-FIT"],
      aidas: ["Digital", "EE"],
      phases: ["01-New", "03-In Analysis", "04-In Progress", "05-Open"],
      solutionClusters: ["CoC", "Integration", "Speech CN"],
      pus: ["PU1", "PU2"],
      markets: ["CN", "EU"],
      leadModels: ["LM1", "LM2"],
      groups: ["Integration", "Q-Gate"],
    },
    filters: {
      years: ["2025", "2026"],
      months: ["2026-04", "2026-03", "2025-11"],
      creationTimeStart: "",
      creationTimeEnd: "",
      requirements: [],
      chinaScopes: ["China", "Global"],
      projects: ["G68", "U12"],
      assignedEcus: ["ECU-A", "ECU-B"],
      problemFinderTeams: ["DTSV_China", "[AT]W72-FIT"],
      aidas: ["Digital", "EE"],
      phases: ["01-New", "03-In Analysis", "04-In Progress", "05-Open"],
      solutionClusters: ["CoC", "Integration", "Speech CN"],
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
        creationTime: "2026-03-18",
        problemFinderTeam: "DTSV_China",
        group: "Integration",
        phase: "03-In Analysis",
        isResolvedForward: true,
        isRejectedDirectly: false,
        year: "2026",
        project: "G68",
        assignedEcu: "ECU-A",
        aida: "Digital",
        solutionCluster: "Integration",
        defectCategory: "",
        pu: "PU1",
        market: "CN",
        leadModel: "LM1",
      },
      {
        ticketId: "1002",
        ticketName: "Beta thermal flicker",
        status: "04-In Progress",
        creationTime: "2026-03-21T08:30:00Z",
        problemFinderTeam: "[AT]W72-FIT",
        group: "Q-Gate",
        phase: "04-In Progress",
        isResolvedForward: false,
        isRejectedDirectly: true,
        year: "2026",
        project: "U12",
        assignedEcu: "ECU-B",
        aida: "EE",
        solutionCluster: "CoC",
        defectCategory: "",
        pu: "PU2",
        market: "EU",
        leadModel: "LM2",
      },
      {
        ticketId: "1003",
        ticketName: "Gamma search match",
        status: "06-Delivered",
        creationTime: "2025-11-02",
        problemFinderTeam: "DTSV_China",
        group: "Integration",
        phase: "05-Open",
        isResolvedForward: true,
        isRejectedDirectly: false,
        year: "2025",
        project: "G68",
        assignedEcu: "ECU-A",
        aida: "Digital",
        solutionCluster: "Integration",
        defectCategory: "",
        pu: "PU1",
        market: "CN",
        leadModel: "LM1",
      },
      {
        ticketId: "1004",
        ticketName: "Delta gateway timeout",
        status: "01-New",
        creationTime: "2026-03-17",
        problemFinderTeam: "DTSV_China",
        group: "Integration",
        phase: "01-New",
        isResolvedForward: false,
        isRejectedDirectly: false,
        year: "2026",
        project: "G68",
        assignedEcu: "ECU-A",
        aida: "Digital",
        solutionCluster: "Integration",
        defectCategory: "",
        pu: "PU1",
        market: "CN",
        leadModel: "LM1",
      },
      {
        ticketId: "1005",
        ticketName: "Epsilon sensor desync",
        status: "04-In Progress",
        creationTime: "2026-04-05T14:45:00Z",
        problemFinderTeam: "[AT]W72-FIT",
        group: "Q-Gate",
        phase: "04-In Progress",
        isResolvedForward: true,
        isRejectedDirectly: false,
        year: "2026",
        project: "U12",
        assignedEcu: "ECU-B",
        aida: "EE",
        solutionCluster: "Speech CN",
        defectCategory: "",
        pu: "PU2",
        market: "EU",
        leadModel: "LM2",
      },
    ],
  };
}

function createSampleViewModelWithCocTeam(): MainDashboardViewModel {
  const viewModel = createSampleViewModel();

  return {
    ...viewModel,
    generatedFrom: {
      ...viewModel.generatedFrom,
      problemFinderTeams: [
        ...viewModel.generatedFrom.problemFinderTeams,
        "[AT]CoC_EI_IuK",
      ],
    },
    filters: {
      ...viewModel.filters,
      problemFinderTeams: [
        ...viewModel.filters.problemFinderTeams,
        "[AT]CoC_EI_IuK",
      ],
    },
    teamOutcomeRows: [
      ...viewModel.teamOutcomeRows,
      {
        problemFinderTeam: "[AT]CoC_EI_IuK",
        totalTickets: 1,
        resolvedForwardCount: 1,
        rejectedDirectlyCount: 0,
        resolvedForwardTeamPercent: 100,
        rejectedDirectlyTeamPercent: 0,
        teamDenominator: 1,
      },
    ],
    ticketRows: [
      ...viewModel.ticketRows,
      {
        ticketId: "1006",
        ticketName: "Zeta dev-only sync issue",
        status: "04-In Progress",
        creationTime: "2026-04-04T09:15:00Z",
        problemFinderTeam: "[AT]CoC_EI_IuK",
        group: "Q-Gate",
        phase: "04-In Progress",
        isResolvedForward: true,
        isRejectedDirectly: false,
        year: "2026",
        project: "U12",
        assignedEcu: "ECU-B",
        aida: "EE",
        solutionCluster: "CoC",
        defectCategory: "Global",
        pu: "PU2",
        market: "EU",
        leadModel: "LM2",
      },
    ],
  };
}

function expectKpiValues(values: {
  tickets: string;
  resolvedForward?: string;
  rejectedDirectly?: string;
  aidas?: string;
  solutionClusters?: string;
  teams: string;
}) {
  expect(
    within(screen.getByRole("article", { name: "Tickets in scope" })).getByText(values.tickets),
  ).toBeInTheDocument();
  expect(screen.getByRole("article", { name: "AIDA" })).toBeInTheDocument();
  expect(screen.getByRole("article", { name: "Solution Cluster" })).toBeInTheDocument();
  if (values.aidas) {
    expect(within(screen.getByRole("article", { name: "AIDA" })).getByText(values.aidas)).toBeInTheDocument();
  }
  if (values.solutionClusters) {
    expect(
      within(screen.getByRole("article", { name: "Solution Cluster" })).getByText(
        values.solutionClusters,
      ),
    ).toBeInTheDocument();
  }
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

function createRefreshMetadata(snapshotVersion = "snapshot-1") {
  return {
    activeSnapshotVersion: snapshotVersion,
    refreshStatus: "success",
    lastSuccessAt: "2026-04-05T14:45:00Z",
  };
}

function createSummaryData(
  viewModel: MainDashboardViewModel,
  filters: Partial<MainDashboardFilters> = {},
  snapshotVersion = "snapshot-1",
) {
  const filtered = applyMainDashboardFilters(viewModel, {
    searchText: "",
    filters: { ...viewModel.filters, ...filters },
  });
  const { ticketRows: _ticketRows, ...summaryData } = viewModel;
  return {
    ...summaryData,
    overview: filtered.overview,
    outcomeSummary: filtered.outcomeSummary,
    teamOutcomeRows: filtered.teamOutcomeRows,
    snapshotVersion,
    refreshMetadata: createRefreshMetadata(snapshotVersion),
  };
}

function createTicketsPageData(
  viewModel: MainDashboardViewModel,
  filters: Partial<MainDashboardFilters> = {},
  searchText = "",
  snapshotVersion = "snapshot-1",
) {
  const filtered = applyMainDashboardFilters(viewModel, {
    searchText,
    filters: { ...viewModel.filters, ...filters },
  });
  return {
    snapshotVersion,
    refreshMetadata: createRefreshMetadata(snapshotVersion),
    page: 1,
    pageSize: 50,
    totalRows: filtered.ticketRows.length,
    totalPages: 1,
    rows: filtered.ticketRows,
    priorityRows: [],
  };
}

function mockMainDashboardQueries(
  currentData: () => MainDashboardViewModel,
  currentSnapshotVersion: () => string,
) {
  vi.mocked(useMainDashboardRefreshStatus).mockReturnValue({
    data: null,
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  } as ReturnType<typeof useMainDashboardRefreshStatus>);
  vi.mocked(useMainDashboardSummary).mockImplementation((filters) => ({
    data: createSummaryData(currentData(), filters, currentSnapshotVersion()),
    error: null,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
  }) as ReturnType<typeof useMainDashboardSummary>);
  vi.mocked(useMainDashboardTickets).mockImplementation((filters, pageRequest) => ({
    data: createTicketsPageData(
      currentData(),
      filters,
      pageRequest.search,
      currentSnapshotVersion(),
    ),
    error: null,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
  }) as ReturnType<typeof useMainDashboardTickets>);
}

function renderIndexWithMockedData(initialData = createSampleViewModel()) {
  let currentData = initialData;
  let currentSnapshotVersion = "snapshot-1";

  mockMainDashboardQueries(() => currentData, () => currentSnapshotVersion);

  const queryClient = createQueryClient();
  const rendered = renderIndex(queryClient);

  return {
    ...rendered,
    rerenderWithData(nextData: MainDashboardViewModel, snapshotVersion = "snapshot-2") {
      currentData = nextData;
      currentSnapshotVersion = snapshotVersion;
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <Index />
        </QueryClientProvider>,
      );
    },
  };
}

function clearDefaultMonthFilter() {
  fireEvent.click(screen.getByRole("button", { name: "Creation Time filter" }));
  fireEvent.change(screen.getByLabelText("Creation Time start"), { target: { value: "2026-01-01" } });
  fireEvent.change(screen.getByLabelText("Creation Time end"), { target: { value: "2026-12-31" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply Creation Time filter" }));
  fireEvent.click(screen.getByRole("button", { name: "China/Global filter" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "China/Global China" }));
}

function clearDefaultPhaseFilter() {
  fireEvent.click(screen.getByRole("button", { name: "Phase filter" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Phase 03-In Analysis" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Phase 04-In Progress" }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Index main dashboard integration", () => {
  it("shows a loading state while Full Picture data is fetching", () => {
    vi.mocked(useMainDashboardRefreshStatus).mockReturnValue({
      data: null,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    } as ReturnType<typeof useMainDashboardRefreshStatus>);
    vi.mocked(useMainDashboardSummary).mockReturnValue({
      data: null,
      error: null,
      isLoading: true,
      isFetching: true,
      isPlaceholderData: false,
    } as ReturnType<typeof useMainDashboardSummary>);
    vi.mocked(useMainDashboardTickets).mockReturnValue({
      data: null,
      error: null,
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMainDashboardTickets>);

    renderIndex();

    expect(screen.getByText("Loading Full Picture data...")).toBeInTheDocument();
    expect(screen.queryByText("Solution Outcome")).not.toBeInTheDocument();
  });

  it("shows an error panel when Full Picture data cannot be loaded", () => {
    vi.mocked(useMainDashboardRefreshStatus).mockReturnValue({
      data: null,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    } as ReturnType<typeof useMainDashboardRefreshStatus>);
    vi.mocked(useMainDashboardSummary).mockReturnValue({
      data: null,
      error: new Error("Service unavailable"),
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
    } as ReturnType<typeof useMainDashboardSummary>);
    vi.mocked(useMainDashboardTickets).mockReturnValue({
      data: null,
      error: null,
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMainDashboardTickets>);

    renderIndex();

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load Full Picture data.");
    expect(screen.getByRole("alert")).toHaveTextContent("Service unavailable");
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("将 Full Picture 数据和交互方式融合到当前数据看板")).toBeInTheDocument();
  });

  it("shows Main Dashboard in the sidebar and renders Task 4 controls from loaded data", async () => {
    renderIndexWithMockedData();

    const navButtons = within(screen.getByRole("navigation")).getAllByRole("button");

    expect(navButtons[0]).toHaveTextContent("Main Dashboard");
    expect(navButtons[0]).toHaveTextContent("Full Picture 管理总览");
    expect(navButtons[1]).toHaveTextContent("Top Issue 分析");
    expect(screen.getByPlaceholderText("Search ticket ID or title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Requirement filter" })).toHaveTextContent("No values");
    expect(screen.getByRole("button", { name: "Creation Time filter" })).toHaveTextContent("2026-04");
    expect(screen.getByRole("button", { name: "Phase filter" })).toHaveTextContent("03-In Analysis +1");
    expect(screen.getByRole("button", { name: "China/Global filter" })).toHaveTextContent("China");
    expect(screen.getByText("Requirement", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("Creation Time", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("China/Global", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("Project", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Tickets in scope" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "AIDA" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Solution Cluster" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Teams in scope" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("数据已同步 · 2026-04-05 22:45:00")).toBeInTheDocument();
    });
    expectKpiValues({
      tickets: "1",
      resolvedForward: "1",
      rejectedDirectly: "0",
      teams: "1",
    });
  });

  it("does not render the floating AI assistant overlay", () => {
    renderIndexWithMockedData();

    expect(screen.queryByText("AI Assistant")).not.toBeInTheDocument();
  });

  it("uses generated-from year defaults to scope KPI output on first render", () => {
    renderIndexWithMockedData();

    expectKpiValues({
      tickets: "1",
      resolvedForward: "1",
      rejectedDirectly: "0",
      teams: "1",
    });
    expect(screen.getByRole("button", { name: "Creation Time filter" })).toHaveTextContent("2026-04");
    expect(screen.getByRole("button", { name: "Phase filter" })).toHaveTextContent("03-In Analysis +1");
  });

  it("defaults the team filter to exclude CoC teams from the first view", () => {
    renderIndexWithMockedData(createSampleViewModelWithCocTeam());

    expectKpiValues({
      tickets: "1",
      resolvedForward: "1",
      rejectedDirectly: "0",
      teams: "1",
    });
    expect(
      screen.getByRole("button", { name: "Problem Finder Team filter" }),
    ).not.toHaveTextContent("[AT]CoC_EI_IuK");

    fireEvent.click(screen.getByRole("button", { name: "China/Global filter" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "China/Global China" }));
    fireEvent.click(screen.getByRole("button", { name: "Problem Finder Team filter" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Problem Finder Team [AT]CoC_EI_IuK" }),
    );

    expectKpiValues({
      tickets: "2",
      resolvedForward: "2",
      rejectedDirectly: "0",
      teams: "2",
    });
  });

  it("updates KPI output when the search text changes", () => {
    renderIndexWithMockedData();
    clearDefaultMonthFilter();
    clearDefaultPhaseFilter();

    fireEvent.change(screen.getByPlaceholderText("Search ticket ID or title"), {
      target: { value: "delta" },
    });

    expectTicketDetailRows({
      count: "1",
      present: ["1004", "Delta gateway timeout"],
      absent: ["1001", "1002", "1005"],
    });
  });

  it("hides and shows the filter grid when the toolbar toggle changes", () => {
    renderIndexWithMockedData();

    const filtersToggle = screen.getByRole("button", { name: "Filters" });

    expect(screen.getByText("Requirement", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("Creation Time", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    fireEvent.click(filtersToggle);
    expect(screen.queryByText("Requirement", { selector: ".workbench-filter-label" })).not.toBeInTheDocument();
    expect(screen.queryByText("Creation Time", { selector: ".workbench-filter-label" })).not.toBeInTheDocument();
    fireEvent.click(filtersToggle);
    expect(screen.getByText("Requirement", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("Creation Time", { selector: ".workbench-filter-label" })).toBeInTheDocument();
  });

  it("resets search and restores default scoped KPI output", () => {
    renderIndexWithMockedData();
    clearDefaultMonthFilter();
    clearDefaultPhaseFilter();

    fireEvent.change(screen.getByPlaceholderText("Search ticket ID or title"), {
      target: { value: "delta" },
    });
    expectTicketDetailRows({
      count: "1",
      present: ["1004", "Delta gateway timeout"],
      absent: ["1001", "1002", "1005"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.getByPlaceholderText("Search ticket ID or title")).toHaveValue("");
    expectKpiValues({
      tickets: "1",
      resolvedForward: "1",
      rejectedDirectly: "0",
      teams: "1",
    });
    expect(screen.getByRole("button", { name: "Creation Time filter" })).toHaveTextContent("2026-04");
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
    expect(screen.queryByText("Requirement", { selector: ".workbench-filter-label" })).not.toBeInTheDocument();
    expectKpiValues({
      tickets: "1",
      resolvedForward: "1",
      rejectedDirectly: "0",
      teams: "1",
    });

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("button", { name: "Project filter" })).toHaveTextContent("Any");
    expect(screen.getByRole("button", { name: "Requirement filter" })).toHaveTextContent("No values");
    expect(screen.getByRole("button", { name: "Creation Time filter" })).toHaveTextContent("2026-04");
  });

  it("renders each filter option as a single checkbox control", () => {
    renderIndexWithMockedData();

    fireEvent.click(screen.getByRole("button", { name: "Phase filter" }));

    const option = screen.getByRole("checkbox", { name: "Phase 03-In Analysis" });

    expect(option.parentElement?.closest("button")).toBeNull();
  });

  it("narrows the ticket detail table from outcome and team drilldowns and can clear selection", () => {
    renderIndexWithMockedData();
    clearDefaultMonthFilter();
    clearDefaultPhaseFilter();

    const solutionOutcomeHeading = screen.getByText("Solution Outcome");
    const teamExpansionHeading = screen.getByText("Team Expansion");
    const ticketDetailHeading = screen.getByText("Ticket Detail");

    expect(solutionOutcomeHeading).toBeInTheDocument();
    expect(teamExpansionHeading).toBeInTheDocument();
    expect(ticketDetailHeading).toBeInTheDocument();
    expect(
      ticketDetailHeading.compareDocumentPosition(teamExpansionHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId("outcome-analysis-panels")).toHaveClass(
      "grid",
      "lg:grid-cols-[360px_minmax(0,1fr)]",
    );
    expect(screen.getByTestId("outcome-card-stack")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("outcome-card-stack")).getAllByRole("button"),
    ).toHaveLength(2);
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
    clearDefaultMonthFilter();

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
    clearDefaultMonthFilter();

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
