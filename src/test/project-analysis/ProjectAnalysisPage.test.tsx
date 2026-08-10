import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProjectAnalysis from "@/components/dashboard/pages/ProjectAnalysis";

vi.mock("recharts", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div data-testid="recharts-responsive-container">{children}</div>
    ),
    BarChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-bar-chart">{children}</div>,
    PieChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-pie-chart">{children}</div>,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Bar: ({ name }: { name?: string }) => <span>{name}</span>,
    Pie: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Cell: () => null,
  };
});

function createJsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

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

function renderProjectAnalysis() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ProjectAnalysis />
    </QueryClientProvider>,
  );
}

function createFullPicturePayload() {
  return {
    generated_from: {
      defect_db_path: "defect.db",
      history_db_path: "history.db",
      years: ["2026"],
      projects: ["G68", "U12"],
      assigned_ecus: [],
      problem_finder_teams: ["DTSV_China", "[AT]W72-FIT"],
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
      projects: ["G68", "U12"],
      assigned_ecus: [],
      problem_finder_teams: ["DTSV_China", "[AT]W72-FIT"],
      aidas: [],
      phases: [],
      solution_clusters: [],
      pus: [],
      markets: [],
      lead_models: [],
      groups: [],
    },
    overview: {
      ticket_count: 4,
      resolved_forward_count: 2,
      rejected_directly_count: 1,
      resolved_forward_percent: 50,
      rejected_directly_percent: 25,
    },
    outcome_summary: [
      {
        key: "resolved_forward",
        label: "Resolved Forward",
        count: 2,
        percent: 50,
        denominator: 4,
      },
      {
        key: "rejected_directly",
        label: "Rejected Directly",
        count: 1,
        percent: 25,
        denominator: 4,
      },
    ],
    team_outcome_rows: [
      {
        problem_finder_team: "DTSV_China",
        total_tickets: 3,
        resolved_forward_count: 2,
        rejected_directly_count: 0,
        resolved_forward_team_percent: 66.67,
        rejected_directly_team_percent: 0,
        team_denominator: 3,
      },
      {
        problem_finder_team: "[AT]W72-FIT",
        total_tickets: 1,
        resolved_forward_count: 0,
        rejected_directly_count: 1,
        resolved_forward_team_percent: 0,
        rejected_directly_team_percent: 100,
        team_denominator: 1,
      },
    ],
    ticket_rows: [
      {
        ticket_id: "1001",
        ticket_name: "Alpha reset",
        status: "06-Delivered",
        creation_time: "2026-03-18T09:30:00Z",
        problem_finder_team: "DTSV_China",
        group: "Integration",
        phase: "06-Delivered",
        requirement: "Top Topic",
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
      {
        ticket_id: "1002",
        ticket_name: "Beta timeout",
        status: "03-In Analysis",
        creation_time: "2026-03-20T09:30:00Z",
        problem_finder_team: "DTSV_China",
        group: "Integration",
        phase: "03-In Analysis",
        requirement: "Top Topic",
        is_resolved_forward: false,
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
      {
        ticket_id: "1003",
        ticket_name: "Gamma flicker",
        status: "09-Rejected",
        creation_time: "2026-03-22T09:30:00Z",
        problem_finder_team: "[AT]W72-FIT",
        group: "Q-Gate",
        phase: "09-Rejected",
        requirement: "Top Topic",
        is_resolved_forward: false,
        is_rejected_directly: true,
        year: "2026",
        project: "U12",
        assigned_ecu: "ECU-B",
        aida: "EE",
        solution_cluster: "CoC",
        pu: "PU2",
        market: "EU",
        lead_model: "LM2",
      },
      {
        ticket_id: "1004",
        ticket_name: "Delta delivered",
        status: "06-Delivered",
        creation_time: "2026-03-24T09:30:00Z",
        problem_finder_team: "DTSV_China",
        group: "Integration",
        phase: "06-Delivered",
        requirement: "Top Topic",
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
  };
}

describe("ProjectAnalysis page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aggregates project statistics from the Full Picture dashboard payload", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("/api/full-picture/dashboard?years=2026");
      return createJsonResponse(createFullPicturePayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    renderProjectAnalysis();

    await waitFor(() => {
      expect(screen.getByText("G68")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("MEB-Platform")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "活跃项目" })).toHaveTextContent("2");
    expect(screen.getByRole("article", { name: "参与团队" })).toHaveTextContent("2");
    expect(screen.getByRole("article", { name: "缺陷总数" })).toHaveTextContent("4");
    expect(screen.getByRole("article", { name: "闭环率" })).toHaveTextContent("75%");

    const g68Row = screen.getByRole("row", { name: /G68/ });
    expect(within(g68Row).getByText("3")).toBeInTheDocument();
    expect(within(g68Row).getByText("2")).toBeInTheDocument();
    expect(within(g68Row).getByText("1")).toBeInTheDocument();
    expect(within(g68Row).getByText("67%")).toBeInTheDocument();
  });
});
