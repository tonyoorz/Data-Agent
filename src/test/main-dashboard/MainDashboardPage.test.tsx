import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyMainDashboardFilters } from "@/components/dashboard/main-dashboard/mainDashboardFiltering";
import {
  mainDashboardFilterKeys,
  type MainDashboardFilters,
  type MainDashboardSummaryViewModel,
  type MainDashboardTicketsPage,
  type MainDashboardTicketsPageRequest,
  type MainDashboardViewModel,
} from "@/components/dashboard/main-dashboard/mainDashboardTypes";
import { useMainDashboardSummary } from "@/components/dashboard/main-dashboard/useMainDashboardSummary";
import { useMainDashboardTickets } from "@/components/dashboard/main-dashboard/useMainDashboardTickets";
import Index from "@/pages/Index";

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
      months: ["2025-11", "2026-03", "2026-04"],
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
      months: ["2025-11", "2026-03", "2026-04"],
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
        ticketDate: "2026-03-18",
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
        ticketDate: "2026-03-21T08:30:00Z",
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
        ticketDate: "2025-11-02",
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
        ticketDate: "2026-03-17",
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
        ticketDate: "2026-04-05T14:45:00Z",
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
        ticketDate: "2026-04-04T09:15:00Z",
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
  resolvedForward: string;
  rejectedDirectly: string;
  teams: string;
}) {
  const ticketsCard = screen.getByRole("article", { name: "Tickets in scope" });
  const resolvedForwardCard = screen.getByRole("article", { name: "Resolved Forward" });
  const rejectedDirectlyCard = screen.getByRole("article", { name: "Rejected Directly" });
  const teamsCard = screen.getByRole("article", { name: "Teams in scope" });

  expect(ticketsCard.querySelector(".kpi-value")).toHaveTextContent(values.tickets);
  expect(resolvedForwardCard.querySelector(".kpi-value")).toHaveTextContent(values.resolvedForward);
  expect(rejectedDirectlyCard.querySelector(".kpi-value")).toHaveTextContent(values.rejectedDirectly);
  expect(teamsCard.querySelector(".kpi-value")).toHaveTextContent(values.teams);
}

function expectTicketDetailRows(values: {
  count: string;
  present: string[];
  absent?: string[];
}) {
  const section = screen.getByText("Ticket Detail").closest("section");
  const table = screen.getByRole("table", { name: "Ticket detail table" });

  expect(section).not.toBeNull();
  expect(section as HTMLElement).toHaveTextContent(
    new RegExp(`${values.count}\\s+of\\s+\\d+\\s+tickets`),
  );

  values.present.forEach((value) => {
    expect(within(table).getByText(value)).toBeInTheDocument();
  });

  values.absent?.forEach((value) => {
    expect(within(table).queryByText(value)).not.toBeInTheDocument();
  });
}

function createEmptyFilters(): MainDashboardFilters {
  return Object.fromEntries(
    mainDashboardFilterKeys.map((filterKey) => [filterKey, []]),
  ) as MainDashboardFilters;
}

function hasActiveFilters(filters: Partial<MainDashboardFilters>) {
  return mainDashboardFilterKeys.some((filterKey) => (filters[filterKey] ?? []).length > 0);
}

function getDefaultFilters(viewModel: MainDashboardViewModel): MainDashboardFilters {
  const defaultYears =
    viewModel.generatedFrom.years.length > 0
      ? viewModel.generatedFrom.years
      : viewModel.filters.years.slice(0, 1);
  const defaultMonths = viewModel.filters.months.filter((month) =>
    defaultYears.some((year) => month.startsWith(`${year}-`)),
  );
  const visibleTeams = viewModel.filters.problemFinderTeams.filter(
    (team) => !team.trim().toLocaleLowerCase().includes("coc"),
  );

  return {
    ...createEmptyFilters(),
    years: defaultYears,
    months: defaultMonths.length > 0 ? [defaultMonths[defaultMonths.length - 1]] : [],
    chinaScopes: viewModel.filters.chinaScopes.includes("China") ? ["China"] : [],
    projects: viewModel.filters.projects.includes("IDCEVO") ? ["IDCEVO"] : [],
    phases: viewModel.filters.phases.filter((phase) => /^(03|04)(?=[^0-9]|$)/.test(phase)),
    problemFinderTeams:
      visibleTeams.length > 0 && visibleTeams.length < viewModel.filters.problemFinderTeams.length
        ? visibleTeams
        : [],
  };
}

function getEffectiveFilters(
  viewModel: MainDashboardViewModel,
  filters: Partial<MainDashboardFilters>,
): MainDashboardFilters {
  if (!hasActiveFilters(filters)) {
    return getDefaultFilters(viewModel);
  }

  return {
    ...createEmptyFilters(),
    ...filters,
  };
}

function createRefreshMetadata(snapshotVersion: string) {
  return {
    activeSnapshotVersion: snapshotVersion,
    refreshStatus: "ready",
    lastSuccessAt: "2026-04-05T14:45:00Z",
  };
}

function createSummaryViewModel(
  viewModel: MainDashboardViewModel,
  snapshotVersion: string,
  filters: Partial<MainDashboardFilters>,
): MainDashboardSummaryViewModel {
  const filtered = applyMainDashboardFilters(viewModel, {
    searchText: "",
    filters: getEffectiveFilters(viewModel, filters),
  });

  return {
    snapshotVersion,
    refreshMetadata: createRefreshMetadata(snapshotVersion),
    generatedFrom: viewModel.generatedFrom,
    filters: viewModel.filters,
    overview: filtered.overview,
    outcomeSummary: filtered.outcomeSummary,
    teamOutcomeRows: filtered.teamOutcomeRows,
  };
}

function createTicketsPage(
  viewModel: MainDashboardViewModel,
  snapshotVersion: string,
  filters: Partial<MainDashboardFilters>,
  pageRequest: MainDashboardTicketsPageRequest,
): MainDashboardTicketsPage {
  const filtered = applyMainDashboardFilters(viewModel, {
    searchText: pageRequest.search,
    filters: getEffectiveFilters(viewModel, filters),
  });
  const totalRows = filtered.ticketRows.length;
  const startIndex = (pageRequest.page - 1) * pageRequest.pageSize;

  return {
    snapshotVersion,
    refreshMetadata: createRefreshMetadata(snapshotVersion),
    page: pageRequest.page,
    pageSize: pageRequest.pageSize,
    totalRows,
    totalPages: Math.max(1, Math.ceil(totalRows / pageRequest.pageSize)),
    rows: filtered.ticketRows.slice(startIndex, startIndex + pageRequest.pageSize),
  };
}

function renderIndexWithMockedData(initialData = createSampleViewModel()) {
  let currentData = initialData;
  let snapshotSequence = 1;

  vi.mocked(useMainDashboardSummary).mockImplementation((filters) => ({
    data: createSummaryViewModel(currentData, `snapshot-${snapshotSequence}`, filters),
    error: null,
    isLoading: false,
  }) as ReturnType<typeof useMainDashboardSummary>);

  vi.mocked(useMainDashboardTickets).mockImplementation((filters, pageRequest) => ({
    data: createTicketsPage(currentData, `snapshot-${snapshotSequence}`, filters, pageRequest),
    error: null,
    isLoading: false,
    isFetching: false,
  }) as ReturnType<typeof useMainDashboardTickets>);

  const rendered = render(<Index />);

  return {
    ...rendered,
    rerenderWithData(nextData: MainDashboardViewModel) {
      currentData = nextData;
      snapshotSequence += 1;
      rendered.rerender(<Index />);
    },
  };
}

function clearDefaultMonthFilter() {
  fireEvent.click(screen.getByRole("button", { name: "Month filter" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Month 2026-04" }));
}

function clearDefaultChinaScopeFilter() {
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
    vi.mocked(useMainDashboardSummary).mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
    } as ReturnType<typeof useMainDashboardSummary>);

    vi.mocked(useMainDashboardTickets).mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMainDashboardTickets>);

    render(<Index />);

    expect(screen.getByText("Loading Full Picture data...")).toBeInTheDocument();
    expect(screen.queryByText("Solution Outcome")).not.toBeInTheDocument();
  });

  it("shows an error panel when Full Picture data cannot be loaded", () => {
    vi.mocked(useMainDashboardSummary).mockReturnValue({
      data: undefined,
      error: new Error("Service unavailable"),
      isLoading: false,
    } as ReturnType<typeof useMainDashboardSummary>);

    vi.mocked(useMainDashboardTickets).mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
      isFetching: false,
    } as ReturnType<typeof useMainDashboardTickets>);

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
    expect(screen.getByRole("button", { name: "Month filter" })).toHaveTextContent("2026-04");
    expect(screen.getByRole("button", { name: "Phase filter" })).toHaveTextContent("03-In Analysis +1");
    expect(screen.getByRole("button", { name: "China/Global filter" })).toHaveTextContent("China");
    expect(screen.getByText("Year", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("Month", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("China/Global", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("Project", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.queryByText("Group", { selector: ".workbench-filter-label" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Tickets in scope" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Resolved Forward" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Rejected Directly" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Teams in scope" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveTextContent("数据已同步 · 2026-04-05");
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
    expect(screen.getByRole("button", { name: "Year filter" })).toHaveTextContent("2026");
    expect(screen.getByRole("button", { name: "Month filter" })).toHaveTextContent("2026-04");
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

    clearDefaultChinaScopeFilter();

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

  it("narrows the ticket detail rows when the search text changes without changing KPI output", () => {
    renderIndexWithMockedData();
    clearDefaultMonthFilter();
    clearDefaultChinaScopeFilter();
    clearDefaultPhaseFilter();

    expectKpiValues({
      tickets: "4",
      resolvedForward: "2",
      rejectedDirectly: "1",
      teams: "2",
    });

    fireEvent.change(screen.getByPlaceholderText("Search ticket ID or title"), {
      target: { value: "delta" },
    });

    expectTicketDetailRows({
      count: "1",
      present: ["1004", "Delta gateway timeout"],
      absent: ["1001", "1002", "1005", "Alpha power reset"],
    });
    expectKpiValues({
      tickets: "4",
      resolvedForward: "2",
      rejectedDirectly: "1",
      teams: "2",
    });
  });

  it("hides and shows the filter grid when the toolbar toggle changes", () => {
    renderIndexWithMockedData();

    const filtersToggle = screen.getByRole("button", { name: "Filters" });

    expect(screen.getByText("Year", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("Month", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    fireEvent.click(filtersToggle);
    expect(screen.queryByText("Year", { selector: ".workbench-filter-label" })).not.toBeInTheDocument();
    expect(screen.queryByText("Month", { selector: ".workbench-filter-label" })).not.toBeInTheDocument();
    fireEvent.click(filtersToggle);
    expect(screen.getByText("Year", { selector: ".workbench-filter-label" })).toBeInTheDocument();
    expect(screen.getByText("Month", { selector: ".workbench-filter-label" })).toBeInTheDocument();
  });

  it("resets search and restores default scoped KPI output", () => {
    renderIndexWithMockedData();
    clearDefaultMonthFilter();
    clearDefaultChinaScopeFilter();
    clearDefaultPhaseFilter();
    fireEvent.click(screen.getByRole("button", { name: "Project filter" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Project U12" }));

    expectKpiValues({
      tickets: "2",
      resolvedForward: "1",
      rejectedDirectly: "1",
      teams: "1",
    });

    fireEvent.change(screen.getByPlaceholderText("Search ticket ID or title"), {
      target: { value: "beta" },
    });

    expectTicketDetailRows({
      count: "1",
      present: ["1002", "Beta thermal flicker"],
      absent: ["1005", "Epsilon sensor desync"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.getByPlaceholderText("Search ticket ID or title")).toHaveValue("");
    expectKpiValues({
      tickets: "1",
      resolvedForward: "1",
      rejectedDirectly: "0",
      teams: "1",
    });
    expect(screen.getByRole("button", { name: "Year filter" })).toHaveTextContent("2026");
    expect(screen.getByRole("button", { name: "Month filter" })).toHaveTextContent("2026-04");
    expect(screen.getByRole("button", { name: "China/Global filter" })).toHaveTextContent("China");
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
      tickets: "1",
      resolvedForward: "1",
      rejectedDirectly: "0",
      teams: "1",
    });

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("button", { name: "Project filter" })).toHaveTextContent("Any");
    expect(screen.getByRole("button", { name: "Year filter" })).toHaveTextContent("2026");
    expect(screen.getByRole("button", { name: "Month filter" })).toHaveTextContent("2026-04");
  });

  it("renders each filter option as a single checkbox control", () => {
    renderIndexWithMockedData();

    fireEvent.click(screen.getByRole("button", { name: "Year filter" }));

    const option = screen.getByRole("checkbox", { name: "Year 2026" });

    expect(option.parentElement?.closest("button")).toBeNull();
  });

  it("narrows the ticket detail table from outcome and team drilldowns and can clear selection", () => {
    renderIndexWithMockedData();
    clearDefaultMonthFilter();
    clearDefaultChinaScopeFilter();
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
    clearDefaultChinaScopeFilter();

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
    clearDefaultChinaScopeFilter();

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