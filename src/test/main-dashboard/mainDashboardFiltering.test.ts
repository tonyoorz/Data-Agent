import { describe, expect, it } from "vitest";

import type {
  MainDashboardFilters,
  MainDashboardViewModel,
} from "@/components/dashboard/main-dashboard/mainDashboardTypes";
import {
  applyMainDashboardFilters,
  selectTicketRowsForDrilldown,
} from "@/components/dashboard/main-dashboard/mainDashboardFiltering";

function createEmptyFilters(): MainDashboardFilters {
  return {
    years: [],
    months: [],
    chinaScopes: [],
    projects: [],
    assignedEcus: [],
    problemFinderTeams: [],
    aidas: [],
    phases: [],
    solutionClusters: [],
    pus: [],
    markets: [],
    leadModels: [],
    groups: [],
  };
}

const viewModel: MainDashboardViewModel = {
  generatedFrom: {
    defectDbPath: "defect.db",
    historyDbPath: "history.db",
    ...createEmptyFilters(),
  },
  filters: {
    years: ["2025", "2026"],
    projects: ["G68", "U12", "NA6"],
    assignedEcus: ["ECU-A", "ECU-B", "ECU-C"],
    problemFinderTeams: ["DTSV_China", "[AT]W72-FIT"],
    aidas: ["Digital", "EE"],
    phases: ["Validation", "Analysis"],
    solutionClusters: ["Integration", "CoC"],
    pus: ["PU1", "PU2", "PU3"],
    markets: ["CN", "EU"],
    leadModels: ["LM1", "LM2", "LM3"],
    groups: ["Integration", "Q-Gate"],
  },
  overview: {
    ticketCount: 5,
    resolvedForwardCount: 3,
    rejectedDirectlyCount: 2,
    resolvedForwardPercent: 60,
    rejectedDirectlyPercent: 40,
  },
  outcomeSummary: [],
  teamOutcomeRows: [],
  ticketRows: [
    {
      ticketId: "1001",
      ticketName: "Alpha power reset",
      status: "03-In Analysis",
      ticketDate: "2026-03-18",
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
      ticketDate: "2026-03-21T08:30:00Z",
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
      ticketName: "Gamma Search Match",
      status: "05-Open",
      ticketDate: "2025-11-02",
      problemFinderTeam: "DTSV_China",
      group: "Integration",
      phase: "Validation",
      isResolvedForward: true,
      isRejectedDirectly: false,
      year: "2025",
      project: "NA6",
      assignedEcu: "ECU-C",
      aida: "Digital",
      solutionCluster: "Integration",
      pu: "PU3",
      market: "CN",
      leadModel: "LM3",
    },
    {
      ticketId: "1004",
      ticketName: "Delta gateway timeout",
      status: "06-Delivered",
      ticketDate: "2026-04-01",
      problemFinderTeam: "DTSV_China",
      group: "Integration",
      phase: "Validation",
      isResolvedForward: false,
      isRejectedDirectly: true,
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
      ticketId: "2005",
      ticketName: "Omega lane assist fault",
      status: "07-Queued",
      ticketDate: "2026-04-05T14:45:00Z",
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

describe("applyMainDashboardFilters", () => {
  it("composes case-insensitive search text with multi-select filters", () => {
    const filtered = applyMainDashboardFilters(viewModel, {
      searchText: "gamma",
      filters: {
        ...createEmptyFilters(),
        years: ["2025"],
        projects: ["NA6"],
        assignedEcus: ["ECU-C"],
        problemFinderTeams: ["DTSV_China"],
        aidas: ["Digital"],
        phases: ["Validation"],
        solutionClusters: ["Integration"],
        pus: ["PU3"],
        markets: ["CN"],
        leadModels: ["LM3"],
        groups: ["Integration"],
      },
    });

    expect(filtered.ticketRows.map((row) => row.ticketId)).toEqual(["1003"]);
  });

  it("treats empty filter arrays as all rows and matches ticket ids in search", () => {
    const filtered = applyMainDashboardFilters(viewModel, {
      searchText: "2005",
      filters: createEmptyFilters(),
    });

    expect(filtered.ticketRows.map((row) => row.ticketId)).toEqual(["2005"]);
  });

  it("recomputes overview, outcome summary, and team rows from the filtered scope", () => {
    const filtered = applyMainDashboardFilters(viewModel, {
      searchText: "",
      filters: {
        ...createEmptyFilters(),
        years: ["2026"],
      },
    });

    expect(filtered.ticketRows.map((row) => row.ticketId)).toEqual([
      "1001",
      "1002",
      "1004",
      "2005",
    ]);
    expect(filtered.overview).toEqual({
      ticketCount: 4,
      resolvedForwardCount: 2,
      rejectedDirectlyCount: 2,
      resolvedForwardPercent: 50,
      rejectedDirectlyPercent: 50,
    });
    expect(filtered.outcomeSummary).toEqual([
      {
        key: "resolvedForward",
        label: "Resolved Forward (08 -> 06)",
        count: 2,
        percent: 50,
        denominator: 4,
      },
      {
        key: "rejectedDirectly",
        label: "Rejected Directly (01 -> 09)",
        count: 2,
        percent: 50,
        denominator: 4,
      },
    ]);
    expect(filtered.teamOutcomeRows).toEqual([
      {
        problemFinderTeam: "[AT]W72-FIT",
        totalTickets: 2,
        resolvedForwardCount: 1,
        rejectedDirectlyCount: 1,
        resolvedForwardTeamPercent: 50,
        rejectedDirectlyTeamPercent: 50,
        teamDenominator: 2,
      },
      {
        problemFinderTeam: "DTSV_China",
        totalTickets: 2,
        resolvedForwardCount: 1,
        rejectedDirectlyCount: 1,
        resolvedForwardTeamPercent: 50,
        rejectedDirectlyTeamPercent: 50,
        teamDenominator: 2,
      },
    ]);
  });

  it("supports derived month filters using creationTime", () => {
    const filtered = applyMainDashboardFilters(
      {
        ...viewModel,
        ticketRows: viewModel.ticketRows.map((row) =>
          row.ticketId === "1004" || row.ticketId === "2005"
            ? {
                ...row,
                creationTime: row.ticketDate,
              }
            : row,
        ),
      },
      {
        searchText: "",
        filters: {
          ...createEmptyFilters(),
          years: ["2026"],
          months: ["2026-04"],
        },
      },
    );

    expect(filtered.ticketRows.map((row) => row.ticketId)).toEqual([
      "1004",
      "2005",
    ]);
    expect(filtered.overview).toEqual({
      ticketCount: 2,
      resolvedForwardCount: 1,
      rejectedDirectlyCount: 1,
      resolvedForwardPercent: 50,
      rejectedDirectlyPercent: 50,
    });
  });

  it("filters creation-time months from creationTime instead of ticketDate", () => {
    const filtered = applyMainDashboardFilters(
      {
        ...viewModel,
        ticketRows: viewModel.ticketRows.map((row) =>
          row.ticketId === "1004"
            ? {
                ...row,
                creationTime: "2026-02-20",
                ticketDate: "2026-04-01",
              }
            : row,
        ),
      },
      {
        searchText: "",
        filters: {
          ...createEmptyFilters(),
          months: ["2026-02"],
        },
      },
    );

    expect(filtered.ticketRows.map((row) => row.ticketId)).toEqual(["1004"]);
  });

  it("supports China/Global filtering from solution cluster with defect category fallback", () => {
    const chinaViewModel: MainDashboardViewModel = {
      ...viewModel,
      ticketRows: [
        ...viewModel.ticketRows,
        {
          ticketId: "3001",
          ticketName: "China by solution cluster",
          status: "03-In Analysis",
          ticketDate: "2026-03-20",
          problemFinderTeam: "DTSV_China",
          group: "Integration",
          phase: "03-In Analysis",
          isResolvedForward: false,
          isRejectedDirectly: false,
          year: "2026",
          project: "G68",
          assignedEcu: "ECU-A",
          aida: "Digital",
          solutionCluster: "Speech CN",
          defectCategory: "",
          pu: "PU1",
          market: "CN",
          leadModel: "LM1",
        },
        {
          ticketId: "3002",
          ticketName: "China by defect category fallback",
          status: "04-In Progress",
          ticketDate: "2026-03-22",
          problemFinderTeam: "DTSV_China",
          group: "Integration",
          phase: "04-In Progress",
          isResolvedForward: false,
          isRejectedDirectly: false,
          year: "2026",
          project: "G68",
          assignedEcu: "ECU-A",
          aida: "Digital",
          solutionCluster: "",
          defectCategory: "CN Speech",
          pu: "PU1",
          market: "CN",
          leadModel: "LM1",
        },
        {
          ticketId: "3003",
          ticketName: "Global despite China defect category",
          status: "04-In Progress",
          ticketDate: "2026-03-23",
          problemFinderTeam: "DTSV_China",
          group: "Integration",
          phase: "04-In Progress",
          isResolvedForward: false,
          isRejectedDirectly: false,
          year: "2026",
          project: "G68",
          assignedEcu: "ECU-A",
          aida: "Digital",
          solutionCluster: "Integration",
          defectCategory: "CN Speech",
          pu: "PU1",
          market: "CN",
          leadModel: "LM1",
        },
      ],
    };

    const filtered = applyMainDashboardFilters(chinaViewModel, {
      searchText: "",
      filters: {
        ...createEmptyFilters(),
        chinaScopes: ["China"],
      },
    });

    expect(filtered.ticketRows.map((row) => row.ticketId)).toEqual([
      "3001",
      "3002",
    ]);
  });

  it("keeps team-local denominators when only one team remains in scope", () => {
    const filtered = applyMainDashboardFilters(viewModel, {
      searchText: "",
      filters: {
        ...createEmptyFilters(),
        problemFinderTeams: ["DTSV_China"],
      },
    });

    expect(filtered.overview).toEqual({
      ticketCount: 3,
      resolvedForwardCount: 2,
      rejectedDirectlyCount: 1,
      resolvedForwardPercent: 66.67,
      rejectedDirectlyPercent: 33.33,
    });
    expect(filtered.teamOutcomeRows).toEqual([
      {
        problemFinderTeam: "DTSV_China",
        totalTickets: 3,
        resolvedForwardCount: 2,
        rejectedDirectlyCount: 1,
        resolvedForwardTeamPercent: 66.67,
        rejectedDirectlyTeamPercent: 33.33,
        teamDenominator: 3,
      },
    ]);
  });

  it("canonicalizes whitespace-variant team names for filtering and aggregation", () => {
    const whitespaceVariantViewModel: MainDashboardViewModel = {
      ...viewModel,
      ticketRows: [
        ...viewModel.ticketRows,
        {
          ticketId: "3001",
          ticketName: "Whitespace variant defect",
          status: "03-In Analysis",
          problemFinderTeam: " DTSV_China ",
          group: "Integration",
          phase: "Validation",
          isResolvedForward: false,
          isRejectedDirectly: true,
          year: "2024",
          project: "G68",
          assignedEcu: "ECU-A",
          aida: "Digital",
          solutionCluster: "Integration",
          pu: "PU1",
          market: "CN",
          leadModel: "LM1",
        },
      ],
    };

    const filtered = applyMainDashboardFilters(whitespaceVariantViewModel, {
      searchText: "",
      filters: {
        ...createEmptyFilters(),
        problemFinderTeams: ["DTSV_China"],
      },
    });

    expect(filtered.ticketRows.map((row) => row.ticketId)).toEqual([
      "1001",
      "1003",
      "1004",
      "3001",
    ]);
    expect(filtered.teamOutcomeRows).toEqual([
      {
        problemFinderTeam: "DTSV_China",
        totalTickets: 4,
        resolvedForwardCount: 2,
        rejectedDirectlyCount: 2,
        resolvedForwardTeamPercent: 50,
        rejectedDirectlyTeamPercent: 50,
        teamDenominator: 4,
      },
    ]);
  });

  it("keeps zero-match filtered scope metrics well-defined", () => {
    const filtered = applyMainDashboardFilters(viewModel, {
      searchText: "no matching ticket",
      filters: createEmptyFilters(),
    });

    expect(filtered.ticketRows).toEqual([]);
    expect(filtered.overview).toEqual({
      ticketCount: 0,
      resolvedForwardCount: 0,
      rejectedDirectlyCount: 0,
      resolvedForwardPercent: 0,
      rejectedDirectlyPercent: 0,
    });
    expect(filtered.outcomeSummary).toEqual([
      {
        key: "resolvedForward",
        label: "Resolved Forward (08 -> 06)",
        count: 0,
        percent: 0,
        denominator: 0,
      },
      {
        key: "rejectedDirectly",
        label: "Rejected Directly (01 -> 09)",
        count: 0,
        percent: 0,
        denominator: 0,
      },
    ]);
    expect(filtered.teamOutcomeRows).toEqual([]);
  });
});

describe("selectTicketRowsForDrilldown", () => {
  it("narrows rows by outcome and team selection", () => {
    const rows = selectTicketRowsForDrilldown(viewModel.ticketRows, {
      outcomeKey: "resolvedForward",
      team: "DTSV_China",
    });

    expect(rows.map((row) => row.ticketId)).toEqual(["1001", "1003"]);
  });

  it("supports team-only and outcome-only drilldowns", () => {
    const teamRows = selectTicketRowsForDrilldown(viewModel.ticketRows, {
      team: "[AT]W72-FIT",
    });
    const outcomeRows = selectTicketRowsForDrilldown(viewModel.ticketRows, {
      outcomeKey: "rejectedDirectly",
    });

    expect(teamRows.map((row) => row.ticketId)).toEqual(["1002", "2005"]);
    expect(outcomeRows.map((row) => row.ticketId)).toEqual(["1002", "1004"]);
  });

  it("canonicalizes whitespace-variant team names for drilldown matching", () => {
    const rows = selectTicketRowsForDrilldown(
      [
        ...viewModel.ticketRows,
        {
          ticketId: "3001",
          ticketName: "Whitespace variant defect",
          status: "03-In Analysis",
          problemFinderTeam: " DTSV_China ",
          group: "Integration",
          phase: "Validation",
          isResolvedForward: true,
          isRejectedDirectly: false,
          year: "2024",
          project: "G68",
          assignedEcu: "ECU-A",
          aida: "Digital",
          solutionCluster: "Integration",
          pu: "PU1",
          market: "CN",
          leadModel: "LM1",
        },
      ],
      {
        outcomeKey: "resolvedForward",
        team: " DTSV_China ",
      },
    );

    expect(rows.map((row) => row.ticketId)).toEqual(["1001", "1003", "3001"]);
  });
});