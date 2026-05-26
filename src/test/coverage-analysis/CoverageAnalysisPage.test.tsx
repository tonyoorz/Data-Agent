import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CoverageAnalysis from "@/components/dashboard/pages/CoverageAnalysis";

vi.mock("recharts", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const ChartDataContext = React.createContext<Array<Record<string, unknown>>>([]);

  return {
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div data-testid="recharts-responsive-container">{children}</div>
    ),
    BarChart: ({
      children,
      data,
    }: {
      children: ReactNode;
      data?: Array<Record<string, unknown>>;
    }) => (
      <ChartDataContext.Provider value={data ?? []}>
        <div data-testid="recharts-bar-chart">{children}</div>
      </ChartDataContext.Provider>
    ),
    CartesianGrid: () => null,
    Legend: () => null,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Bar: ({
      dataKey,
      onClick,
    }: {
      dataKey: string;
      onClick?: (value: { payload?: { selectionValue?: string } }) => void;
    }) => {
      const rows = React.useContext(ChartDataContext);
      const firstRow = rows[0] as { selectionValue?: string } | undefined;

      if (!firstRow?.selectionValue) {
        return null;
      }

      return (
        <button
          type="button"
          onClick={() => onClick?.({ payload: { selectionValue: firstRow.selectionValue } })}
        >
          {`Select ${firstRow.selectionValue} for ${dataKey}`}
        </button>
      );
    },
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

function renderCoverageAnalysis() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <CoverageAnalysis />
    </QueryClientProvider>,
  );
}

function createCoverageAnalysisFetchMock() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/api/testing/coverage-analysis/filters")) {
      return createJsonResponse({
        years: ["2026"],
        projects: ["IDCEVO"],
        test_weeks: ["2026-CW21"],
        pus: ["PU1"],
        aidas: ["Use Speech operation [01.04.02.01.01.05]"],
        statuses: ["Passed"],
        feature_regions: ["China Specific"],
        fvps: ["Voice Experience"],
        fvs: ["Speech", "Media"],
      });
    }

    if (url.includes("/api/testing/coverage-analysis/project-status")) {
      return createJsonResponse([
        {
          test_week: "2026-CW21",
          fv: "Speech",
          fvp: "Voice Experience",
          status: "Passed",
          count: 12,
        },
        {
          test_week: "2026-CW21",
          fv: "Media",
          fvp: "Voice Experience",
          status: "Passed",
          count: 5,
        },
      ]);
    }

    if (url.includes("/api/testing/coverage-analysis/aida-status")) {
      return createJsonResponse([
        {
          test_week: "2026-CW21",
          top_aida: "Use Speech operation [01.04.02.01.01.05]",
          status: "Passed",
          count: 8,
        },
      ]);
    }

    if (url.includes("/api/testing/coverage-analysis/testcase-detail")) {
      return createJsonResponse([
        {
          test_id: "T-1",
          test_name: "Wake word test",
          test_week: "2026-CW21",
          status: "Passed",
          top_aida: "Use Speech operation [01.04.02.01.01.05]",
          project: "IDCEVO",
          pu: "PU1",
          tester: "Tester-A",
          count: 1,
        },
      ]);
    }

    throw new Error(`Unhandled fetch URL: ${url}`);
  });
}

describe("CoverageAnalysis page", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the filter bar and three live TAP section titles", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        createJsonResponse({
          years: ["2026"],
          projects: ["IDCEVO"],
          test_weeks: ["2026-CW21"],
          pus: ["PU1"],
          aidas: ["Use Speech operation [01.04.02.01.01.05]"],
          statuses: ["Passed"],
          feature_regions: ["China Specific"],
          fvps: ["Voice Experience"],
          fvs: ["Speech"],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse([
          {
            test_week: "2026-CW21",
            fv: "Speech",
            fvp: "Voice Experience",
            status: "Passed",
            count: 12,
          },
        ]),
      )
      .mockResolvedValueOnce(
        createJsonResponse([
          {
            test_week: "2026-CW21",
            top_aida: "Use Speech operation [01.04.02.01.01.05]",
            status: "Passed",
            count: 8,
          },
        ]),
      )
      .mockResolvedValueOnce(
        createJsonResponse([
          {
            test_id: "T-1",
            test_name: "Wake word test",
            test_week: "2026-CW21",
            status: "Passed",
            top_aida: "Use Speech operation [01.04.02.01.01.05]",
            project: "IDCEVO",
            pu: "PU1",
            tester: "Tester-A",
            count: 1,
          },
        ]),
      );

    renderCoverageAnalysis();

    expect(await screen.findByLabelText("Year filter")).toBeInTheDocument();
    expect(screen.getByLabelText("Project filter")).toBeInTheDocument();
    expect(screen.getByText("按周和功能分类的测试状态")).toBeInTheDocument();
    expect(screen.getByText("按 Top AIDA 和测试周分类的状态")).toBeInTheDocument();
    expect(screen.getByText("按测试用例和测试周分类的状态")).toBeInTheDocument();
  });

  it("shows a non-ready message with missing field detail", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            error: "testing coverage analysis data not ready",
            missing_fields: ["test_week", "top_aida"],
          },
          { status: 503, statusText: "Service Unavailable" },
        ),
      )
      .mockResolvedValueOnce(createJsonResponse([]))
      .mockResolvedValueOnce(createJsonResponse([]))
      .mockResolvedValueOnce(createJsonResponse([]));

    renderCoverageAnalysis();

    expect(
      await screen.findByText("Testing coverage analysis is not ready yet."),
    ).toBeInTheDocument();
    expect(screen.getByText("Missing fields: test_week, top_aida")).toBeInTheDocument();
  });

  it("narrows the FV filter and refetches after a project-status chart click", async () => {
    const fetchMock = createCoverageAnalysisFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderCoverageAnalysis();

    expect(await screen.findByLabelText("FV filter")).toHaveTextContent("Any");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fireEvent.click(screen.getByRole("button", { name: "Select Speech for Passed" }));

    await waitFor(() => {
      expect(screen.getByLabelText("FV filter")).toHaveTextContent("Speech");
      expect(fetchMock).toHaveBeenCalledTimes(8);
    });

    const refetchUrls = fetchMock.mock.calls.slice(-4).map(([url]) => String(url));
    refetchUrls.forEach((url) => {
      expect(url).toContain("fvs=Speech");
    });
  });
});