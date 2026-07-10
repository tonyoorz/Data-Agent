import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DefectStatusAnalysis from "@/components/dashboard/pages/DefectStatusAnalysis";

vi.mock("recharts", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div data-testid="recharts-responsive-container">{children}</div>
    ),
    PieChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-pie-chart">{children}</div>,
    Pie: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Cell: () => null,
    Tooltip: () => null,
    AreaChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-area-chart">{children}</div>,
    Area: ({ name }: { name?: string }) => <span>{name}</span>,
    BarChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-bar-chart">{children}</div>,
    Bar: ({ name }: { name?: string }) => <span>{name}</span>,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
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

function renderDefectStatusAnalysis() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <DefectStatusAnalysis />
    </QueryClientProvider>,
  );
}

function createFullPicturePayload() {
  const baseTicket = {
    problem_finder_team: "DTSV_China",
    group: "Integration",
    requirement: "Top Topic",
    year: "2026",
    project: "IDCEVO",
    assigned_ecu: "ECU-A",
    aida: "Digital",
    classification: "Normal",
    problem_severity: "03-medium",
    defect_category: "CN Speech",
    solution_cluster: "Integration",
    pu: "PU1",
    market: "CN",
    lead_model: "LM1",
  };

  return {
    generated_from: {
      defect_db_path: "defect.db",
      history_db_path: "history.db",
      years: ["2026"],
      projects: ["IDCEVO"],
      assigned_ecus: ["ECU-A"],
      problem_finder_teams: ["DTSV_China"],
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
      projects: ["IDCEVO"],
      assigned_ecus: ["ECU-A"],
      problem_finder_teams: ["DTSV_China"],
      aidas: [],
      phases: [],
      solution_clusters: [],
      pus: [],
      markets: [],
      lead_models: [],
      groups: [],
    },
    overview: {
      ticket_count: 5,
      resolved_forward_count: 1,
      rejected_directly_count: 1,
      resolved_forward_percent: 20,
      rejected_directly_percent: 20,
    },
    outcome_summary: [
      {
        key: "resolved_forward",
        label: "Resolved Forward",
        count: 1,
        percent: 20,
        denominator: 5,
      },
      {
        key: "rejected_directly",
        label: "Rejected Directly",
        count: 1,
        percent: 20,
        denominator: 5,
      },
    ],
    team_outcome_rows: [],
    ticket_rows: [
      {
        ...baseTicket,
        ticket_id: "3001",
        ticket_name: "Alpha new",
        status: "01-New",
        phase: "01-New",
        creation_time: "2026-03-01T00:00:00Z",
        ticket_date: "2026-03-02T00:00:00Z",
        is_resolved_forward: false,
        is_rejected_directly: false,
      },
      {
        ...baseTicket,
        ticket_id: "3002",
        ticket_name: "Beta analysis",
        status: "03-In Analysis",
        phase: "03-In Analysis",
        creation_time: "2026-03-03T00:00:00Z",
        ticket_date: "2026-03-10T00:00:00Z",
        is_resolved_forward: false,
        is_rejected_directly: false,
      },
      {
        ...baseTicket,
        ticket_id: "3003",
        ticket_name: "Gamma progress",
        status: "04-In Progress",
        phase: "04-In Progress",
        creation_time: "2026-04-01T00:00:00Z",
        ticket_date: "2026-04-08T00:00:00Z",
        project: "IDC",
        problem_finder_team: "[AT]W72-FIT",
        aida: "Navigation",
        problem_severity: "04-major",
        is_resolved_forward: false,
        is_rejected_directly: false,
      },
      {
        ...baseTicket,
        ticket_id: "3004",
        ticket_name: "Delta closed",
        status: "06-Concluded",
        phase: "06-Concluded",
        creation_time: "2026-04-02T00:00:00Z",
        ticket_date: "2026-04-20T00:00:00Z",
        project: "IDC",
        problem_severity: "05-unsatisfactory",
        is_resolved_forward: true,
        is_rejected_directly: false,
      },
      {
        ...baseTicket,
        ticket_id: "3005",
        ticket_name: "Epsilon rejected",
        status: "09-Concluded without action",
        phase: "09-Concluded without action",
        creation_time: "2026-04-05T00:00:00Z",
        ticket_date: "2026-04-12T00:00:00Z",
        is_resolved_forward: false,
        is_rejected_directly: true,
      },
    ],
  };
}

describe("DefectStatusAnalysis page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Full Picture phase data for TPMDashboard-style defect status distribution and flow", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("/api/full-picture/dashboard?years=2026");
      return createJsonResponse(createFullPicturePayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDefectStatusAnalysis();

    await waitFor(() => {
      expect(screen.getByText("03-In Analysis (1)")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("1,446")).not.toBeInTheDocument();
    expect(screen.queryByText("10月")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "总缺陷" })).toHaveTextContent("5");
    expect(screen.getByRole("article", { name: "已关闭" })).toHaveTextContent("1");
    expect(screen.getByRole("article", { name: "处理中" })).toHaveTextContent("3");
    expect(screen.getByRole("article", { name: "已拒绝" })).toHaveTextContent("1");
    expect(screen.getByText("01-New (1)")).toBeInTheDocument();
    expect(screen.getByText("04-In Progress (1)")).toBeInTheDocument();
    expect(screen.getByText("06-Concluded (1)")).toBeInTheDocument();
    expect(screen.getByText("09-Concluded without action (1)")).toBeInTheDocument();
    expect(screen.getByText("Inflow")).toBeInTheDocument();
    expect(screen.getByText("Outflow")).toBeInTheDocument();
    expect(screen.getByText("Open Backlog")).toBeInTheDocument();
    expect(screen.getByText("项目状态矩阵")).toBeInTheDocument();
    expect(screen.getByText("团队状态矩阵")).toBeInTheDocument();
    expect(screen.getByText("缺陷年龄分布")).toBeInTheDocument();
    expect(screen.getByText("严重度状态分布")).toBeInTheDocument();
    expect(screen.getByText("Top AIDA 状态分布")).toBeInTheDocument();
  });
});
