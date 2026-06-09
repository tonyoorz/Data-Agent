import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CoverageAnalysis from "@/components/dashboard/pages/CoverageAnalysis";

function createDeferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

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
    ScatterChart: ({
      children,
    }: {
      children: ReactNode;
    }) => <div data-testid="recharts-scatter-chart">{children}</div>,
    CartesianGrid: () => null,
    Legend: () => null,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
    ZAxis: () => null,
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
    Scatter: ({
      name,
      data,
      onClick,
    }: {
      name?: string;
      data?: Array<{ selectionValue?: string; tooltipTitle?: string }>;
      onClick?: (value: { payload?: { selectionValue?: string } }) => void;
    }) => {
      const firstRow = data?.[0];

      if (!firstRow?.selectionValue) {
        return null;
      }

      return (
        <button
          type="button"
          title={firstRow.tooltipTitle}
          onClick={() => onClick?.({ payload: { selectionValue: firstRow.selectionValue } })}
        >
          {`Select ${firstRow.selectionValue} for ${name ?? "scatter"}`}
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
          fvp: "Voice Experience",
          fv: "Speech",
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

  it("renders the TPMDashboard-style filter copy and chart titles", async () => {
    vi.stubGlobal("fetch", createCoverageAnalysisFetchMock());

    renderCoverageAnalysis();

    await waitFor(() => {
      expect(screen.getByLabelText("Year filter")).toHaveTextContent("2026");
    });

    expect(screen.getByText("筛选条件")).toBeInTheDocument();
    expect(screen.getByLabelText("Year filter")).toBeInTheDocument();
    expect(screen.getByText("图表 1: 按周和功能分类的测试状态")).toBeInTheDocument();
    expect(screen.getByText("图表 2: 按 Top AIDA 和测试周分类的状态")).toBeInTheDocument();
    expect(screen.getByText("图表 3: 按测试用例和测试周分类的状态")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset coverage filters" })).toHaveTextContent("清空筛选");
    expect(screen.getByTestId("coverage-analysis-filter-grid").className).toContain("lg:grid-cols-5");
    expect(screen.getAllByTestId("recharts-scatter-chart")).toHaveLength(3);
  });

  it("defaults the Year filter to the current TPMDashboard year when available", async () => {
    const fetchMock = createCoverageAnalysisFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderCoverageAnalysis();

    await waitFor(() => {
      expect(screen.getByLabelText("Year filter")).toHaveTextContent("2026");
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    const refetchUrls = fetchMock.mock.calls.slice(-4).map(([url]) => String(url));
    refetchUrls.forEach((url) => {
      expect(url).toContain("years=2026");
    });

    const testcaseDetailUrls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/api/testing/coverage-analysis/testcase-detail"));
    testcaseDetailUrls.forEach((url) => {
      expect(url).toContain("limit=500");
    });
  });

  it("defers filter refresh until the user applies multi-select changes", async () => {
    const fetchMock = createCoverageAnalysisFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderCoverageAnalysis();

    await waitFor(() => {
      expect(screen.getByLabelText("FV filter")).toHaveTextContent("全部");
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    fireEvent.click(screen.getByLabelText("FV filter"));
    fireEvent.click(await screen.findByLabelText("FV Media"));

    expect(fetchMock).toHaveBeenCalledTimes(5);

    fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));

    await waitFor(() => {
      expect(screen.getByLabelText("FV filter")).toHaveTextContent("Media");
      expect(fetchMock).toHaveBeenCalledTimes(9);
    });
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

    await waitFor(() => {
      expect(screen.getByLabelText("FV filter")).toHaveTextContent("全部");
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Select Speech for Passed" }));

    await waitFor(() => {
      expect(screen.getByLabelText("FV filter")).toHaveTextContent("Speech");
      expect(fetchMock).toHaveBeenCalledTimes(9);
    });

    const refetchUrls = fetchMock.mock.calls.slice(-4).map(([url]) => String(url));
    refetchUrls.forEach((url) => {
      expect(url).toContain("fvs=Speech");
    });
  });

  it("shows a density note for the bounded scatter window", async () => {
    const manyProjectRows = Array.from({ length: 18 }, (_, index) => ({
      test_week: `2026-CW${String(index + 1).padStart(2, "0")}`,
      fv: `FV-${index + 1}`,
      fvp: "Voice Experience",
      status: "Passed",
      count: index + 1,
    }));

    const manyAidaRows = Array.from({ length: 18 }, (_, index) => ({
      test_week: `2026-CW${String(index + 1).padStart(2, "0")}`,
      top_aida: `AIDA-${index + 1}`,
      status: "Passed",
      count: index + 1,
    }));

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/api/testing/coverage-analysis/filters")) {
        return createJsonResponse({
          years: ["2026"],
          projects: ["IDCEVO"],
          test_weeks: manyProjectRows.map((row) => row.test_week),
          pus: ["PU1"],
          aidas: manyAidaRows.map((row) => row.top_aida),
          statuses: ["Passed"],
          feature_regions: ["China Specific"],
          fvps: ["Voice Experience"],
          fvs: manyProjectRows.map((row) => row.fv),
        });
      }

      if (url.includes("/api/testing/coverage-analysis/project-status")) {
        return createJsonResponse(manyProjectRows);
      }

      if (url.includes("/api/testing/coverage-analysis/aida-status")) {
        return createJsonResponse(manyAidaRows);
      }

      if (url.includes("/api/testing/coverage-analysis/testcase-detail")) {
        return createJsonResponse([
          {
            test_id: "T-1",
            test_name: "Wake word test",
            test_week: "2026-CW18",
            status: "Passed",
            top_aida: "AIDA-18",
            project: "IDCEVO",
            pu: "PU1",
            tester: "Tester-A",
            count: 1,
          },
        ]);
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCoverageAnalysis();

    expect(
      await screen.findAllByText(/图表最多展示最近 .*测试周与当前筛选下的高频项/i),
    ).toHaveLength(2);
  });

  it("renders chart data before testcase detail finishes loading", async () => {
    const deferredDetail = createDeferredResponse();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
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
          fvs: ["Speech"],
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
        return deferredDetail.promise;
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCoverageAnalysis();

    await waitFor(() => {
      expect(screen.getByLabelText("Year filter")).toHaveTextContent("2026");
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    expect(screen.getByRole("button", { name: "Select Speech for Passed" })).toBeInTheDocument();
    expect(screen.getByText("Loading testcase detail rows...")).toBeInTheDocument();

    deferredDetail.resolve(
      createJsonResponse([
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
          tester: "Tester-A",
          count: 1,
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("recharts-scatter-chart")).toHaveLength(3);
    });
    expect(screen.getByRole("button", { name: "导出Excel" })).toBeInTheDocument();
  });

  it("renders chart 3 as a testcase bubble scatter without the legacy detail table", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      const longTestName =
        "Wake word test with an intentionally very long testcase name that should stay fully visible in hover";

      if (url.includes("/api/testing/coverage-analysis/filters")) {
        return createJsonResponse({
          years: ["2026"],
          projects: ["IDCEVO"],
          test_weeks: ["2026-CW20", "2026-CW21"],
          pus: ["PU1"],
          aidas: ["Use Speech operation [01.04.02.01.01.05]"],
          statuses: ["Passed", "Failed"],
          feature_regions: ["China Specific"],
          fvps: ["Voice Experience"],
          fvs: ["Speech"],
        });
      }

      if (url.includes("/api/testing/coverage-analysis/project-status")) {
        return createJsonResponse([
          {
            test_week: "2026-CW20",
            fv: "Speech",
            fvp: "Voice Experience",
            status: "Passed",
            count: 3,
          },
          {
            test_week: "2026-CW21",
            fv: "Speech",
            fvp: "Voice Experience",
            status: "Failed",
            count: 2,
          },
        ]);
      }

      if (url.includes("/api/testing/coverage-analysis/aida-status")) {
        return createJsonResponse([
          {
            test_week: "2026-CW20",
            top_aida: "Use Speech operation [01.04.02.01.01.05]",
            status: "Passed",
            count: 3,
          },
          {
            test_week: "2026-CW21",
            top_aida: "Use Speech operation [01.04.02.01.01.05]",
            status: "Failed",
            count: 2,
          },
        ]);
      }

      if (url.includes("/api/testing/coverage-analysis/testcase-detail")) {
        return createJsonResponse([
          {
            test_id: "T-1",
            test_name: longTestName,
            test_week: "2026-CW20",
            status: "Passed",
            top_aida: "Use Speech operation [01.04.02.01.01.05]",
            project: "IDCEVO",
            pu: "PU1",
            fvp: "Voice Experience",
            fv: "Speech",
            tester: "Tester-A",
            count: 1,
          },
          {
            test_id: "T-1",
            test_name: "Wake word test",
            test_week: "2026-CW21",
            status: "Failed",
            top_aida: "Use Speech operation [01.04.02.01.01.05]",
            project: "IDCEVO",
            pu: "PU1",
            fvp: "Voice Experience",
            fv: "Speech",
            tester: "Tester-A",
            count: 1,
          },
          {
            test_id: "T-2",
            test_name: "Noise suppression",
            test_week: "2026-CW21",
            status: "Passed",
            top_aida: "Use Speech operation [01.04.02.01.01.05]",
            project: "IDCEVO",
            pu: "PU1",
            fvp: "Voice Experience",
            fv: "Speech",
            tester: "Tester-B",
            count: 1,
          },
        ]);
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCoverageAnalysis();

    await waitFor(() => {
      expect(screen.getAllByTestId("recharts-scatter-chart")).toHaveLength(3);
    });

    expect(screen.queryByRole("columnheader", { name: "Test Frequency" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Pass Rate" })).not.toBeInTheDocument();
    expect(screen.queryByText("执行明细")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出Excel" })).toBeInTheDocument();
    expect(
      screen.getByTitle(/Wake word test with an intentionally very long testcase name that should stay fully visible in hover/),
    ).toBeInTheDocument();
  });

  it("paginates chart 3 testcase labels after 100 entries", async () => {
    const testcaseRows = Array.from({ length: 130 }, (_, index) => ({
      test_id: `T-${index + 1}`,
      test_name: `Testcase ${index + 1}`,
      test_week: "2026-CW21",
      status: index % 3 === 0 ? "Failed" : "Passed",
      top_aida: `AIDA-${(index % 5) + 1}`,
      project: "IDCEVO",
      pu: "PU1",
      fvp: "Voice Experience",
      fv: "Speech",
      tester: `Tester-${index + 1}`,
      count: 1,
    }));

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/api/testing/coverage-analysis/filters")) {
        return createJsonResponse({
          years: ["2026"],
          projects: ["IDCEVO"],
          test_weeks: ["2026-CW21"],
          pus: ["PU1"],
          aidas: ["AIDA-1", "AIDA-2", "AIDA-3", "AIDA-4", "AIDA-5"],
          statuses: ["Passed", "Failed"],
          feature_regions: ["China Specific"],
          fvps: ["Voice Experience"],
          fvs: ["Speech"],
        });
      }

      if (url.includes("/api/testing/coverage-analysis/project-status")) {
        return createJsonResponse([
          {
            test_week: "2026-CW21",
            fv: "Speech",
            fvp: "Voice Experience",
            status: "Passed",
            count: 130,
          },
        ]);
      }

      if (url.includes("/api/testing/coverage-analysis/aida-status")) {
        return createJsonResponse([
          {
            test_week: "2026-CW21",
            top_aida: "AIDA-1",
            status: "Passed",
            count: 26,
          },
        ]);
      }

      if (url.includes("/api/testing/coverage-analysis/testcase-detail")) {
        return createJsonResponse(testcaseRows);
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCoverageAnalysis();

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
  });
});