import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import TestStatusAnalysis from "@/components/dashboard/pages/TestStatusAnalysis";

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

function renderTestStatusAnalysis() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <TestStatusAnalysis />
    </QueryClientProvider>,
  );
}

function createFetchMock() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "/api/testing/coverage-analysis/filters") {
      return createJsonResponse({
        years: ["2026"],
        projects: ["IDCEVO"],
        test_weeks: ["2026-CW21", "2026-CW22"],
        pus: ["PU1"],
        aidas: ["Use Speech operation [01.04.02.01.01.05]"],
        statuses: ["Passed", "Failed", "Blocked"],
        feature_regions: ["China Specific"],
        fvps: ["Voice Experience"],
        fvs: ["Speech"],
      });
    }

    if (url === "/api/testing/coverage-analysis/project-status?years=2026") {
      return createJsonResponse([
        {
          test_week: "2026-CW21",
          fv: "Speech",
          fvp: "Voice Experience",
          status: "Passed",
          count: 10,
        },
        {
          test_week: "2026-CW21",
          fv: "Speech",
          fvp: "Voice Experience",
          status: "Failed",
          count: 2,
        },
        {
          test_week: "2026-CW22",
          fv: "Speech",
          fvp: "Voice Experience",
          status: "Blocked",
          count: 1,
        },
      ]);
    }

    if (url === "/api/testing/coverage-analysis/aida-status?years=2026") {
      return createJsonResponse([
        {
          test_week: "2026-CW21",
          top_aida: "Use Speech operation [01.04.02.01.01.05]",
          status: "Passed",
          count: 8,
        },
        {
          test_week: "2026-CW22",
          top_aida: "Navigation Destination Input ASIA [01.04.03.01.02.03]",
          status: "Failed",
          count: 2,
        },
      ]);
    }

    if (url === "/api/testing/coverage-analysis/testcase-detail?years=2026&limit=500") {
      return createJsonResponse([
        {
          test_id: "T-1",
          test_name: "Wake word test",
          test_week: "2026-CW21",
          status: "Passed",
          top_aida: "Use Speech operation [01.04.02.01.01.05]",
          project: "IDCEVO",
          pu: "PU1",
          fvp: "Voice Experience",
          fv: "Speech",
          tester: "Tester A",
          count: 2,
        },
        {
          test_id: "T-2",
          test_name: "Navigation input test",
          test_week: "2026-CW22",
          status: "Failed",
          top_aida: "Navigation Destination Input ASIA [01.04.03.01.02.03]",
          project: "IDC",
          pu: "PU2",
          fvp: "Navigation",
          fv: "Guidance",
          tester: "Tester B",
          count: 1,
        },
      ]);
    }

    throw new Error(`Unhandled fetch URL: ${url}`);
  });
}

describe("TestStatusAnalysis page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses TPMDashboard-style coverage status rows for the current year", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderTestStatusAnalysis();

    await waitFor(() => {
      expect(screen.getByText("Passed (10)")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/testing/coverage-analysis/filters");
    expect(fetchMock).toHaveBeenCalledWith("/api/testing/coverage-analysis/project-status?years=2026");
  expect(fetchMock).toHaveBeenCalledWith("/api/testing/coverage-analysis/aida-status?years=2026");
  expect(fetchMock).toHaveBeenCalledWith("/api/testing/coverage-analysis/testcase-detail?years=2026&limit=500");
    expect(screen.queryByText("3,847")).not.toBeInTheDocument();
    expect(screen.queryByText("W10")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "执行总数" })).toHaveTextContent("13");
    expect(screen.getByRole("article", { name: "需关注" })).toHaveTextContent("3");
    expect(screen.getByRole("article", { name: "阻塞" })).toHaveTextContent("1");
    expect(screen.getByRole("article", { name: "通过率" })).toHaveTextContent("77%");
    expect(screen.getByText("Failed (2)")).toBeInTheDocument();
    expect(screen.getByText("Blocked (1)")).toBeInTheDocument();
    expect(screen.getByText("项目状态矩阵")).toBeInTheDocument();
    expect(screen.getByText("FV 状态矩阵")).toBeInTheDocument();
    expect(screen.getByText("FVP 状态矩阵")).toBeInTheDocument();
    expect(screen.getByText("Top AIDA 状态矩阵")).toBeInTheDocument();
    expect(screen.getByText("Tester 执行状态")).toBeInTheDocument();
    expect(screen.getByText("测试用例状态 Top 10")).toBeInTheDocument();
  });
});
