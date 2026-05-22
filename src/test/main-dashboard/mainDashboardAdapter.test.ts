import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adaptMainDashboardPayload } from "@/components/dashboard/main-dashboard/mainDashboardAdapter";
import {
  buildMainDashboardApiUrl,
  fetchMainDashboardData,
} from "@/components/dashboard/main-dashboard/mainDashboardApi";

describe("adaptMainDashboardPayload", () => {
  it("maps the TPMDashboard payload into local camelCase fields", () => {
    const viewModel = adaptMainDashboardPayload({
      generated_from: {
        defect_db_path: "defect.db",
        history_db_path: "history.db",
        years: ["2026"],
        projects: ["G68"],
        assigned_ecus: ["ECU-A"],
        problem_finder_teams: ["DTSV_China"],
        aidas: ["Digital"],
        phases: ["Validation"],
        solution_clusters: ["Integration"],
        pus: ["PU1"],
        markets: ["CN"],
        lead_models: ["LM1"],
        groups: ["Integration"],
      },
      filters: {
        years: ["2026"],
        projects: ["G68"],
        assigned_ecus: ["ECU-A"],
        problem_finder_teams: ["DTSV_China"],
        aidas: ["Digital"],
        phases: ["Validation"],
        solution_clusters: ["Integration"],
        pus: ["PU1"],
        markets: ["CN"],
        lead_models: ["LM1"],
        groups: ["Integration"],
      },
      overview: {
        ticket_count: 9,
        resolved_forward_count: 4,
        rejected_directly_count: 3,
        resolved_forward_percent: 44.4,
        rejected_directly_percent: 33.3,
      },
      outcome_summary: [
        {
          key: "resolved_forward",
          label: "Resolved Forward",
          count: 4,
          percent: 44.4,
          denominator: 9,
        },
        {
          key: "rejected_directly",
          label: "Rejected Directly",
          count: 3,
          percent: 33.3,
          denominator: 9,
        },
      ],
      team_outcome_rows: [
        {
          problem_finder_team: "DTSV_China",
          total_tickets: 3,
          resolved_forward_count: 2,
          rejected_directly_count: 1,
          resolved_forward_team_percent: 66.7,
          rejected_directly_team_percent: 33.3,
          team_denominator: 3,
        },
      ],
      ticket_rows: [
        {
          ticket_id: "2553006",
          ticket_name:
            "Navigation app reset after route recalculation under mixed market scope.",
          status: "03-In Analysis",
          problem_finder_team: "DTSV_China",
          group: "Integration",
          phase: "Validation",
          is_resolved_forward: true,
          is_rejected_directly: false,
          year: "2026",
          project: "G68",
          assigned_ecu: "ECU-A",
          aida: "Digital",
          solution_cluster: "Integration",
          pu: "PU1",
          market: "CN",
          lead_model: "LM1",
        },
      ],
    });

    expect(viewModel.generatedFrom).toEqual({
      defectDbPath: "defect.db",
      historyDbPath: "history.db",
      years: ["2026"],
      projects: ["G68"],
      assignedEcus: ["ECU-A"],
      problemFinderTeams: ["DTSV_China"],
      aidas: ["Digital"],
      phases: ["Validation"],
      solutionClusters: ["Integration"],
      pus: ["PU1"],
      markets: ["CN"],
      leadModels: ["LM1"],
      groups: ["Integration"],
    });
    expect(viewModel.overview.ticketCount).toBe(9);
    expect(viewModel.filters.problemFinderTeams).toEqual(["DTSV_China"]);
    expect(viewModel.outcomeSummary[0].key).toBe("resolvedForward");
    expect(viewModel.outcomeSummary[1].key).toBe("rejectedDirectly");
    expect(viewModel.teamOutcomeRows).toEqual([
      {
        problemFinderTeam: "DTSV_China",
        totalTickets: 3,
        resolvedForwardCount: 2,
        rejectedDirectlyCount: 1,
        resolvedForwardTeamPercent: 66.7,
        rejectedDirectlyTeamPercent: 33.3,
        teamDenominator: 3,
      },
    ]);
    expect(viewModel.ticketRows[0].ticketId).toBe("2553006");
    expect(viewModel.ticketRows[0].isResolvedForward).toBe(true);
  });

  it("throws when the backend sends an unknown outcome key", () => {
    expect(() =>
      adaptMainDashboardPayload({
        generated_from: {
          defect_db_path: "defect.db",
          history_db_path: "history.db",
          years: [],
          projects: [],
          assigned_ecus: [],
          problem_finder_teams: [],
          aidas: [],
          phases: [],
          solution_clusters: [],
          pus: [],
          markets: [],
          lead_models: [],
          groups: [],
        },
        filters: {
          years: [],
          projects: [],
          assigned_ecus: [],
          problem_finder_teams: [],
          aidas: [],
          phases: [],
          solution_clusters: [],
          pus: [],
          markets: [],
          lead_models: [],
          groups: [],
        },
        overview: {
          ticket_count: 0,
          resolved_forward_count: 0,
          rejected_directly_count: 0,
          resolved_forward_percent: 0,
          rejected_directly_percent: 0,
        },
        outcome_summary: [
          {
            key: "unexpected_outcome" as never,
            label: "Unexpected",
            count: 1,
            percent: 100,
            denominator: 1,
          },
        ],
        team_outcome_rows: [],
        ticket_rows: [],
      }),
    ).toThrow(/unknown outcome key/i);
  });

  it("throws when the backend sends a prototype outcome key", () => {
    expect(() =>
      adaptMainDashboardPayload({
        generated_from: {
          defect_db_path: "defect.db",
          history_db_path: "history.db",
          years: [],
          projects: [],
          assigned_ecus: [],
          problem_finder_teams: [],
          aidas: [],
          phases: [],
          solution_clusters: [],
          pus: [],
          markets: [],
          lead_models: [],
          groups: [],
        },
        filters: {
          years: [],
          projects: [],
          assigned_ecus: [],
          problem_finder_teams: [],
          aidas: [],
          phases: [],
          solution_clusters: [],
          pus: [],
          markets: [],
          lead_models: [],
          groups: [],
        },
        overview: {
          ticket_count: 0,
          resolved_forward_count: 0,
          rejected_directly_count: 0,
          resolved_forward_percent: 0,
          rejected_directly_percent: 0,
        },
        outcome_summary: [
          {
            key: "toString" as never,
            label: "Prototype Key",
            count: 1,
            percent: 100,
            denominator: 1,
          },
        ],
        team_outcome_rows: [],
        ticket_rows: [],
      }),
    ).toThrow(/unknown outcome key/i);
  });
});

describe("buildMainDashboardApiUrl", () => {
  it("preserves the TPMDashboard query parameter names", () => {
    const url = buildMainDashboardApiUrl("/api/full-picture/dashboard", {
      years: ["2026"],
      projects: ["G68", "U12"],
      assignedEcus: ["ECU-A"],
      problemFinderTeams: ["DTSV_China"],
      aidas: ["Digital"],
      phases: ["Validation"],
      solutionClusters: ["Integration"],
      pus: ["PU1"],
      markets: ["CN"],
      leadModels: ["LM1"],
      groups: ["Integration"],
    });

    expect(url).toContain("years=2026");
    expect(url).toContain("projects=G68%2CU12");
    expect(url).toContain("assigned_ecus=ECU-A");
    expect(url).toContain("problem_finder_teams=DTSV_China");
    expect(url).toContain("aidas=Digital");
    expect(url).toContain("phases=Validation");
    expect(url).toContain("solution_clusters=Integration");
    expect(url).toContain("pus=PU1");
    expect(url).toContain("markets=CN");
    expect(url).toContain("lead_models=LM1");
    expect(url).toContain("groups=Integration");
  });

  it("returns the base path when no filters are provided", () => {
    expect(buildMainDashboardApiUrl("/api/full-picture/dashboard", {})).toBe(
      "/api/full-picture/dashboard",
    );
  });
});

describe("fetchMainDashboardData", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and adapts the dashboard payload", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        generated_from: {
          defect_db_path: "defect.db",
          history_db_path: "history.db",
          years: ["2026"],
          projects: ["G68"],
          assigned_ecus: [],
          problem_finder_teams: [],
          aidas: [],
          phases: [],
          solution_clusters: [],
          pus: [],
          markets: [],
          lead_models: [],
          groups: [],
        },
        filters: {
          years: ["2026"],
          projects: ["G68"],
          assigned_ecus: [],
          problem_finder_teams: [],
          aidas: [],
          phases: [],
          solution_clusters: [],
          pus: [],
          markets: [],
          lead_models: [],
          groups: [],
        },
        overview: {
          ticket_count: 1,
          resolved_forward_count: 1,
          rejected_directly_count: 0,
          resolved_forward_percent: 100,
          rejected_directly_percent: 0,
        },
        outcome_summary: [
          {
            key: "resolved_forward",
            label: "Resolved Forward",
            count: 1,
            percent: 100,
            denominator: 1,
          },
        ],
        team_outcome_rows: [],
        ticket_rows: [
          {
            ticket_id: "1001",
            ticket_name: "Alpha power reset",
            status: "03-In Analysis",
            problem_finder_team: "DTSV_China",
            group: "Integration",
            phase: "Validation",
            is_resolved_forward: true,
            is_rejected_directly: false,
            year: "2026",
            project: "G68",
            assigned_ecu: "ECU-A",
            aida: "Digital",
            solution_cluster: "Integration",
            pu: "PU1",
            market: "CN",
            lead_model: "LM1",
          },
        ],
      }),
    } as Response);

    const viewModel = await fetchMainDashboardData({ years: ["2026"] });

    expect(fetch).toHaveBeenCalledWith("/api/full-picture/dashboard?years=2026");
    expect(viewModel.generatedFrom.years).toEqual(["2026"]);
    expect(viewModel.ticketRows[0].ticketId).toBe("1001");
  });

  it("throws when the dashboard request fails", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    } as Response);

    await expect(fetchMainDashboardData()).rejects.toThrow(
      "Full Picture request failed (503 Service Unavailable)",
    );
  });
});