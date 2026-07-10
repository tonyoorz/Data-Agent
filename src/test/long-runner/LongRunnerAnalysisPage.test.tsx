import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import LongRunnerAnalysis from "@/components/dashboard/pages/LongRunnerAnalysis";

vi.mock("recharts", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div data-testid="recharts-responsive-container">{children}</div>
    ),
    LineChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-line-chart">{children}</div>,
    BarChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-bar-chart">{children}</div>,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Line: ({ name }: { name?: string }) => <span>{name}</span>,
    Bar: ({ name }: { name?: string }) => <span>{name}</span>,
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

function renderLongRunnerAnalysis() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LongRunnerAnalysis />
    </QueryClientProvider>,
  );
}

function createLongRunnerPayload() {
  return {
    snapshot_version: "snapshot-1",
    generated_from: {},
    refresh_metadata: {},
    overview: {
      average_days: 32.3,
      overdue_count: 2,
      severe_overdue_count: 1,
      total_count: 4,
    },
    trend: [
      { month: "2026-03", avg_days: 32.3, max_days: 65 },
    ],
    distribution: [
      { range: "0-7天", count: 0 },
      { range: "8-14天", count: 1 },
      { range: "15-30天", count: 1 },
      { range: "31-60天", count: 1 },
      { range: "60天+", count: 1 },
    ],
    long_runner_rows: [
      {
        ticket_id: "2001",
        ticket_name: "Alpha long runner",
        age_days: 65,
        project: "IDCEVO",
        status: "03-In Analysis",
      },
      {
        ticket_id: "2002",
        ticket_name: "Beta overdue",
        age_days: 39,
        project: "IDC",
        status: "04-In Progress",
      },
    ],
  };
}

describe("LongRunnerAnalysis page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("derives long-running defect durations from Full Picture creation and ticket dates", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("/api/full-picture/long-runner-analysis?years=2026&limit=12");
      return createJsonResponse(createLongRunnerPayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    renderLongRunnerAnalysis();

    await waitFor(() => {
      expect(screen.getByText("2001")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/full-picture/dashboard");
    expect(screen.queryByText("DEF-1089")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "平均解决周期" })).toHaveTextContent("32.3天");
    expect(screen.getByRole("article", { name: "超期缺陷" })).toHaveTextContent("2");
    expect(screen.getByRole("article", { name: "严重超期" })).toHaveTextContent("1");

    const longRunnerRow = screen.getByRole("row", { name: /2001/ });
    expect(within(longRunnerRow).getByText("Alpha long runner")).toBeInTheDocument();
    expect(within(longRunnerRow).getByText("65天")).toBeInTheDocument();
    expect(within(longRunnerRow).getByText("IDCEVO")).toBeInTheDocument();
    expect(within(longRunnerRow).getByText("03-In Analysis")).toBeInTheDocument();
  });
});
