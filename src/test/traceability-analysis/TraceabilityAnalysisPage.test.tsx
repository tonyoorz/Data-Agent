import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import TraceabilityAnalysis from "@/components/dashboard/pages/TraceabilityAnalysis";

vi.mock("recharts", async () => {
  return {
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div data-testid="recharts-responsive-container">{children}</div>
    ),
    BarChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-bar-chart">{children}</div>,
    Bar: ({ name }: { name?: string }) => <span>{name}</span>,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
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

function renderTraceabilityAnalysis() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <TraceabilityAnalysis />
    </QueryClientProvider>,
  );
}

function createTraceabilityPayload() {
  return {
    summary: {
      total_runs: 50,
      traced_runs: 45,
      total_testcases: 18,
      traced_testcases: 16,
      traceability_rate: 90,
      feature_count: 12,
      story_count: 24,
      defect_count: 5,
      relation_rows: 86,
    },
    filter_options: {
      years: ["2026"],
      teams: ["DTSV_China"],
      releases: ["R-26-06", "R-26-07"],
      weeks: ["2026-CW26", "2026-CW27", "2026-CW28", "2026-CW29"],
      statuses: ["Passed", "Failed"],
      relation_types: ["feature", "story", "defect"],
    },
    relation_type_rows: [],
    status_rows: [],
    top_related_items: [],
    traceability_chain_rows: [],
    testcase_rows: [],
    gap_rows: [],
  };
}

describe("TraceabilityAnalysis page", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("loads traceability rows for the current year and renders coverage KPIs", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (
        url === "/api/testing/traceability-analysis?years=2026" ||
        url === "/api/testing/traceability-analysis?years=2026&releases=R-26-06" ||
        url === "/api/testing/traceability-analysis?years=2026&releases=R-26-06&weeks=2026-CW28" ||
        url === "/api/testing/traceability-analysis?years=2026&releases=R-26-05"
      ) {
        return createJsonResponse({
          summary: {
            total_runs: 50,
            traced_runs: 45,
            total_testcases: 18,
            traced_testcases: 16,
            traceability_rate: 90,
            feature_count: 12,
            story_count: 24,
            defect_count: 5,
            relation_rows: 86,
          },
          filter_options: {
            years: ["2026"],
            teams: ["DTSV_China"],
            releases: ["R-26-05", "R-26-06"],
            weeks: ["2026-CW28", "2026-CW29"],
            statuses: ["Passed", "Failed"],
            relation_types: ["feature", "story", "defect"],
          },
          relation_type_rows: [
            { relation_type: "feature", run_count: 45, testcase_count: 16, related_count: 12 },
            { relation_type: "story", run_count: 45, testcase_count: 16, related_count: 24 },
            { relation_type: "defect", run_count: 8, testcase_count: 5, related_count: 5 },
          ],
          status_rows: [
            { status: "Passed", total_runs: 38, traced_runs: 36 },
            { status: "Failed", total_runs: 12, traced_runs: 9 },
          ],
          top_related_items: [
            {
              relation_type: "story",
              related_id: "S-1",
              related_name: "Wake story",
              parent_name: "Wake feature",
              run_count: 20,
              testcase_count: 7,
              failed_runs: 3,
              passed_runs: 17,
            },
          ],
          traceability_chain_rows: [
            {
              epic_ids: "E-1",
              epic_names: "Wake epic",
              feature_ids: "F-1",
              feature_names: "Wake feature",
              story_ids: "S-1",
              story_names: "Wake story",
              defect_ids: "D-1",
              defect_names: "Wake defect",
              test_id: "T-1",
              test_name: "Wake trace test",
              run_id: "MR-1",
              run_status: "Failed",
              scope_team: "DTSV_China",
              scope_release: "R-26-06",
            },
          ],
          testcase_rows: [
            {
              test_id: "T-1",
              test_name: "Wake trace test",
              run_count: 10,
              relation_count: 16,
              feature_count: 2,
              story_count: 4,
              defect_count: 1,
            },
          ],
          gap_rows: [
            {
              test_id: "T-GAP",
              test_name: "Untraced test",
              run_count: 2,
              latest_status: "Planned",
              project: "IDCEVO",
              team: "DTSV_China",
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderTraceabilityAnalysis();

    await waitFor(() => {
      expect(screen.getByRole("article", { name: "Traceability rate" })).toHaveTextContent("90%");
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/testing/traceability-analysis?years=2026&releases=R-26-06");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/testing/traceability-analysis?years=2026");
    expect(screen.getByLabelText("Release filter")).toHaveValue("R-26-06");
    expect(screen.getByLabelText("CW filter")).toHaveValue("");
    expect(screen.getByRole("article", { name: "Traced runs" })).toHaveTextContent("45");
    expect(screen.getByRole("article", { name: "Traced testcases" })).toHaveTextContent("16");
    expect(screen.getByRole("article", { name: "Feature / Story / Defect" })).toHaveTextContent("1 / 1 / 1");
    expect(screen.getByText("关系类型覆盖")).toBeInTheDocument();
    expect(screen.getAllByText("Wake story").length).toBeGreaterThan(0);
    expect(screen.getByText("多层追溯图")).toBeInTheDocument();
    expect(screen.getByText(/显示 1 \/ 1 条链路/)).toBeInTheDocument();
    expect(screen.queryByText("Top 追溯对象")).not.toBeInTheDocument();
    expect(screen.queryByText("完整追溯记录")).not.toBeInTheDocument();
    expect(screen.queryByText("测试用例追溯明细")).not.toBeInTheDocument();
    expect(screen.queryByText("未追溯测试用例")).not.toBeInTheDocument();
    expect(screen.getByTestId("traceability-graph")).toBeInTheDocument();
    expect(screen.getByTestId("traceability-graph-layer-epic")).toHaveTextContent("Epic");
    expect(screen.getByTestId("traceability-graph-layer-feature")).toHaveTextContent("Feature");
    expect(screen.getByTestId("traceability-graph-layer-story")).toHaveTextContent("Story");
    expect(screen.getByTestId("traceability-graph-layer-testcase")).toHaveTextContent("Testcase");
    expect(screen.getByTestId("traceability-graph-layer-manual_run")).toHaveTextContent("Manual Run");
    expect(screen.getByTestId("traceability-graph-layer-defect")).toHaveTextContent("Defect");
    const epicNode = screen.getByTestId("traceability-graph-node-epic:E-1");
    expect(epicNode).toHaveTextContent("Wake epic");
    expect(within(epicNode).queryByText("E-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("traceability-graph-node-story:S-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("traceability-graph-node-testcase:T-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("traceability-graph-node-manual_run:MR-1")).not.toBeInTheDocument();
    const featureStoryGroup = screen.getByTestId("traceability-graph-node-story_group:feature:F-1");
    expect(featureStoryGroup).toHaveTextContent("Wake story");
    expect(featureStoryGroup).toHaveAttribute("title", expect.stringContaining("Stories: 1"));
    expect(featureStoryGroup).not.toHaveAttribute("title", expect.stringContaining("Testcases: 1"));
    const featureTestcaseGroup = screen.getByTestId("traceability-graph-node-testcase_group:feature:F-1");
    expect(featureTestcaseGroup).toHaveTextContent("Wake trace test");
    expect(featureTestcaseGroup).toHaveAttribute("title", expect.stringContaining("Testcases: 1"));
    expect(featureTestcaseGroup).toHaveAttribute("title", expect.stringContaining("Wake trace test (Failed: 1)"));
    expect(featureTestcaseGroup).not.toHaveAttribute("title", expect.stringContaining("Stories: 1"));

    fireEvent.click(featureStoryGroup);

    expect(screen.getByTestId("traceability-graph-node-story:S-1")).toBeInTheDocument();
    expect(screen.getByTestId("traceability-graph-node-testcase_group:story:S-1")).toHaveTextContent("Wake trace test");
    expect(screen.getByTestId("traceability-graph-node-manual_run_group:story:S-1")).toHaveTextContent("Wake trace test");

    fireEvent.click(screen.getByTestId("traceability-graph-node-testcase_group:story:S-1"));

    const manualRunNode = screen.getByTestId("traceability-graph-node-manual_run:MR-1");
    expect(manualRunNode).toHaveTextContent("Wake trace test");
    expect(within(manualRunNode).queryByText("MR-1")).not.toBeInTheDocument();
    expect(within(manualRunNode).queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复聚合" })).toBeInTheDocument();
    expect(screen.getByTestId("traceability-graph-edge-testcase:T-1->manual_run:MR-1")).toBeInTheDocument();
    expect(screen.getByTestId("traceability-graph-edge-manual_run:MR-1->defect:D-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "恢复聚合" }));

    expect(screen.queryByTestId("traceability-graph-node-manual_run:MR-1")).not.toBeInTheDocument();
  expect(screen.getByTestId("traceability-graph-node-story_group:feature:F-1")).toBeInTheDocument();

  fireEvent.click(screen.getByTestId("traceability-graph-node-story_group:feature:F-1"));
  fireEvent.click(screen.getByTestId("traceability-graph-node-testcase_group:story:S-1"));

    fireEvent.click(screen.getByTestId("traceability-graph-node-feature:F-1"));

    expect(screen.getByTestId("traceability-graph-collapse-marker-feature:F-1")).toHaveTextContent("+");
    expect(screen.queryByTestId("traceability-graph-node-story:S-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("traceability-graph-node-testcase:T-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("traceability-graph-node-manual_run:MR-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));

    expect(screen.getByTestId("traceability-graph-node-story:S-1")).toBeInTheDocument();
    expect(screen.getByTestId("traceability-graph-node-manual_run:MR-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("traceability-graph-node-feature:F-1"));

    fireEvent.click(screen.getByTestId("traceability-graph-node-feature:F-1"));

    expect(screen.getByTestId("traceability-graph-node-story:S-1")).toBeInTheDocument();
    expect(screen.getByTestId("traceability-graph-node-manual_run:MR-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("traceability-graph-node-testcase:T-1"));

    expect(screen.queryByTestId("traceability-graph-node-manual_run:MR-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("traceability-graph-node-defect:D-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("traceability-graph-node-testcase:T-1"));

    expect(screen.getByTestId("traceability-graph-node-manual_run:MR-1")).toBeInTheDocument();
    expect(screen.getByTestId("traceability-graph-node-defect:D-1")).toBeInTheDocument();
    expect(screen.getAllByText("Wake epic").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Wake feature").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Wake trace test").length).toBeGreaterThan(0);
    expect(screen.queryByText("Untraced test")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Release filter"), { target: { value: "R-26-05" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/testing/traceability-analysis?years=2026&releases=R-26-05");
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Release filter")).toHaveValue("R-26-05");
    });

    fireEvent.change(screen.getByLabelText("Release filter"), { target: { value: "R-26-06" } });

    await waitFor(() => {
      expect(screen.getByLabelText("Release filter")).toHaveValue("R-26-06");
    });

    fireEvent.change(screen.getByLabelText("CW filter"), { target: { value: "2026-CW28" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/testing/traceability-analysis?years=2026&releases=R-26-06&weeks=2026-CW28");
    });
  });

  it("restores the selected release and CW filter after a page refresh", async () => {
    window.localStorage.setItem(
      "vizion.traceability.filters",
      JSON.stringify({ release: "R-26-07", week: "2026-CW28" }),
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/testing/traceability-analysis?years=2026&releases=R-26-07&weeks=2026-CW28") {
        return createJsonResponse(createTraceabilityPayload());
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderTraceabilityAnalysis();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/testing/traceability-analysis?years=2026&releases=R-26-07&weeks=2026-CW28",
      );
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Release filter")).toHaveValue("R-26-07");
    });
    expect(screen.getByLabelText("CW filter")).toHaveValue("2026-CW28");
  });

  it("keeps the current page visible while a CW filter request is loading", async () => {
    window.localStorage.setItem("vizion.traceability.filters", JSON.stringify({ release: "R-26-07", week: "" }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/testing/traceability-analysis?years=2026&releases=R-26-07") {
        return createJsonResponse(createTraceabilityPayload());
      }
      if (url === "/api/testing/traceability-analysis?years=2026&releases=R-26-07&weeks=2026-CW28") {
        return new Promise<Response>(() => {});
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderTraceabilityAnalysis();

    await waitFor(() => {
      expect(screen.getByLabelText("CW filter")).toHaveValue("");
    });

    fireEvent.change(screen.getByLabelText("CW filter"), { target: { value: "2026-CW28" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/testing/traceability-analysis?years=2026&releases=R-26-07&weeks=2026-CW28",
      );
    });
    expect(screen.queryByText("正在加载测试追溯关系数据...")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Traceability rate" })).toHaveTextContent("90%");
  });
});