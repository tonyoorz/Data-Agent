import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DefectHighFreq from "@/components/dashboard/pages/DefectHighFreq";

vi.mock("recharts", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div data-testid="recharts-responsive-container">{children}</div>
    ),
    BarChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-bar-chart">{children}</div>,
    ScatterChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-scatter-chart">{children}</div>,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    ZAxis: () => null,
    Bar: ({ name }: { name?: string }) => <span>{name}</span>,
    Scatter: () => null,
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

function renderDefectHighFreq() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <DefectHighFreq />
    </QueryClientProvider>,
  );
}

function createHighFrequencyPayload() {
  return {
    snapshot_version: "snapshot-1",
    generated_from: {},
    refresh_metadata: {},
    overview: {
      module_count: 2,
      repeat_rate: 75,
      critical_count: 1,
      total_count: 4,
    },
    frequency_rows: [
      { module: "ECU-A", count: 3, severity: "Critical" },
      { module: "ECU-B", count: 1, severity: "Medium" },
    ],
  };
}

describe("DefectHighFreq page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aggregates high-frequency defect modules from Full Picture assigned ECU data", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("/api/full-picture/defect-high-frequency-analysis?years=2026&limit=12");
      return createJsonResponse(createHighFrequencyPayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDefectHighFreq();

    await waitFor(() => {
      expect(screen.getByText("ECU-A")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalledWith("/api/full-picture/dashboard");
    expect(screen.queryByText("HMI Display")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "高频模块" })).toHaveTextContent("2");
    expect(screen.getByRole("article", { name: "重复缺陷率" })).toHaveTextContent("75%");
    expect(screen.getByRole("article", { name: "关键缺陷" })).toHaveTextContent("1");

    const ecuARow = screen.getByRole("row", { name: /ECU-A/ });
    expect(within(ecuARow).getByText("3")).toBeInTheDocument();
    expect(within(ecuARow).getByText("Critical")).toBeInTheDocument();
  });
});
