import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import TestTeamAnalysis from "@/components/dashboard/pages/TestTeamAnalysis";

vi.mock("recharts", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div data-testid="recharts-responsive-container">{children}</div>
    ),
    BarChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-bar-chart">{children}</div>,
    RadarChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-radar-chart">{children}</div>,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Bar: ({ name }: { name?: string }) => <span>{name}</span>,
    Radar: ({ name }: { name?: string }) => <span>{name}</span>,
    PolarGrid: () => null,
    PolarAngleAxis: () => null,
    PolarRadiusAxis: () => null,
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

function renderTestTeamAnalysis() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <TestTeamAnalysis />
    </QueryClientProvider>,
  );
}

describe("TestTeamAnalysis page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads only DTSV_China tester performance from the testing team-analysis endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("/api/testing/team-analysis?team=DTSV_China&years=2026");
      return createJsonResponse({
        team: "DTSV_China",
        rows: [
          {
            tester: "Tester A",
            total_runs: 2,
            passed_runs: 1,
            linked_defects: 2,
            pass_rate: 50,
          },
          {
            tester: "Tester B",
            total_runs: 1,
            passed_runs: 1,
            linked_defects: 0,
            pass_rate: 100,
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderTestTeamAnalysis();

    await waitFor(() => {
      expect(screen.getByText("Tester A")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("张三")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "团队成员" })).toHaveTextContent("2");
    expect(screen.getByRole("article", { name: "人均执行" })).toHaveTextContent("1.5");
    expect(screen.getByRole("article", { name: "最佳通过率" })).toHaveTextContent("100%");
    expect(screen.getByRole("article", { name: "团队通过率" })).toHaveTextContent("67%");

    const testerRow = screen.getByRole("row", { name: /Tester A/ });
    expect(within(testerRow).getByText("2")).toBeInTheDocument();
    expect(within(testerRow).getByText("1")).toBeInTheDocument();
    expect(within(testerRow).getByText("50%")).toBeInTheDocument();
  });
});
