import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DashboardSidebar from "@/components/dashboard/DashboardSidebar";
import QGateKpiReport from "@/components/dashboard/pages/QGateKpiReport";

describe("QGateKpiReport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an empty state when no dashboard report exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          available: false,
          message: "No QGate KPI Dashboard report has been generated yet.",
        }),
      }),
    );

    render(<QGateKpiReport />);

    expect(await screen.findByText("No QGate KPI Dashboard report has been generated yet.")).toBeInTheDocument();
  });

  it("renders the latest dashboard report iframe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          available: true,
          run: "20260612_090000",
          fileName: "qgate_kpi_dashboard_20260612_090000.html",
          generatedAt: "2026-06-12T09:00:00.000Z",
          iframeUrl:
            "/api/qgate-reports/dashboard-html?run=20260612_090000&file=qgate_kpi_dashboard_20260612_090000.html",
        }),
      }),
    );

    render(<QGateKpiReport />);

    const frame = await screen.findByTitle("QGate KPI Dashboard report");
    expect(frame).toHaveAttribute(
      "src",
      "/api/qgate-reports/dashboard-html?run=20260612_090000&file=qgate_kpi_dashboard_20260612_090000.html",
    );
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
    expect(screen.queryByText("QGate KPI Dashboard")).not.toBeInTheDocument();
  });
});

describe("DashboardSidebar", () => {
  it("exposes QGate KPI Report navigation", () => {
    render(<DashboardSidebar active="main-dashboard" onNavigate={() => {}} />);

    expect(screen.getByText("QGate KPI Report")).toBeInTheDocument();
  });
});