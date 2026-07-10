import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DashboardSidebar from "@/components/dashboard/DashboardSidebar";
import QGateKpiReport from "@/components/dashboard/pages/QGateKpiReport";

function stubQGateFetch(latest: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    return { ok: true, json: async () => latest };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("QGateKpiReport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an empty state when no dashboard report exists", async () => {
    stubQGateFetch({
      available: false,
      message: "No QGate KPI Dashboard report has been generated yet.",
    });

    render(<QGateKpiReport />);

    expect(await screen.findByText("No QGate KPI Dashboard report has been generated yet.")).toBeInTheDocument();
  });

  it("renders the latest dashboard report iframe", async () => {
    stubQGateFetch({
      available: true,
      run: "20260612_090000",
      fileName: "qgate_kpi_dashboard_20260612_090000.html",
      generatedAt: "2026-06-12T09:00:00.000Z",
      iframeUrl:
        "/api/qgate-reports/dashboard-html?run=20260612_090000&file=qgate_kpi_dashboard_20260612_090000.html",
    });

    render(<QGateKpiReport />);

    const frame = await screen.findByTitle("QGate KPI Dashboard report");
    expect(frame).toHaveAttribute(
      "src",
      "/api/qgate-reports/dashboard-html?run=20260612_090000&file=qgate_kpi_dashboard_20260612_090000.html",
    );
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
    expect(screen.queryByText("QGate KPI Dashboard")).not.toBeInTheDocument();
  });

  it("keeps the QGate KPI report page limited to the generated dashboard iframe", async () => {
    const fetchMock = stubQGateFetch({
      available: true,
      run: "20260612_090000",
      fileName: "qgate_kpi_dashboard_20260612_090000.html",
      generatedAt: "2026-06-12T09:00:00.000Z",
      iframeUrl:
        "/api/qgate-reports/dashboard-html?run=20260612_090000&file=qgate_kpi_dashboard_20260612_090000.html",
    });

    render(<QGateKpiReport />);

    expect(await screen.findByTitle("QGate KPI Dashboard report")).toBeInTheDocument();
    expect(screen.queryByText("Weekly report")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/qgate-reports/weekly-report");
  });
});

describe("DashboardSidebar", () => {
  it("places Weekly Report between QGate KPI Report and AI Chat", () => {
    render(<DashboardSidebar active="main-dashboard" onNavigate={() => {}} />);

    const qgateItem = screen.getByRole("button", { name: /QGate KPI Report/i });
    const weeklyItem = screen.getByRole("button", { name: /Weekly Report/i });
    const aiChatItem = screen.getByRole("button", { name: /AI Chat/i });
    const buttons = screen.getAllByRole("button");

    expect(buttons.indexOf(qgateItem)).toBeLessThan(buttons.indexOf(weeklyItem));
    expect(buttons.indexOf(weeklyItem)).toBeLessThan(buttons.indexOf(aiChatItem));
  });
});