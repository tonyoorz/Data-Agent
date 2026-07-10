import type { ReactNode } from "react";

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import QGateWeeklyReport from "@/components/dashboard/pages/QGateWeeklyReport";

vi.mock("recharts", async () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="recharts-responsive-container">{children}</div>
  ),
  BarChart: ({ children }: { children: ReactNode }) => <div data-testid="recharts-bar-chart">{children}</div>,
  Bar: ({ name }: { name?: string }) => <span>{name}</span>,
  CartesianGrid: () => null,
  Legend: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

describe("QGateWeeklyReport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the live weekly defect and test report as a standalone page", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        generated_from: { db_path: "test.db", year: "2026" },
        overview: {
          defect_total: 3,
          in_verification_total: 2,
          rejected_total: 1,
          manual_run_total: 6,
          planned_total: 2,
        },
        defect_quality_rows: [
          { project: "IDCEVO", lead_model: "G70", pmg: 1, shk: 1, total: 2 },
        ],
        defect_owner_rows: [
          { owner: "Alice", in_verification: 2, rejected: 0, total: 2 },
        ],
        rejected_reason_rows: [{ reason: "Not reproducible", count: 1 }],
        test_case_tendency_rows: [
          { test_week: "2026-CW24", test_cases: 2, manual_runs: 2 },
          { test_week: "2026-CW25", test_cases: 2, manual_runs: 2 },
        ],
        last_week_status_rows: [
          { project: "IDCEVO", passed: 1, failed: 0, requires_attention: 0, planned: 0, other: 0, total: 1 },
        ],
        test_effort_rows: [{ project: "IDCEVO", test_hours: 3, manual_runs: 1 }],
        incoming_test_case_rows: [{ project: "IDCEVO", pu: "26-11", planned: 1 }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<QGateWeeklyReport />);

    expect(await screen.findByText("Weekly report")).toBeInTheDocument();
    expect(screen.getByText("Defect quality status")).toBeInTheDocument();
    expect(screen.getByText("Total cases tendency")).toBeInTheDocument();
    expect(screen.getByText("Next week incoming test cases")).toBeInTheDocument();
    expect(screen.getAllByText("IDCEVO").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/qgate-reports/weekly-report");
    });
  });
});