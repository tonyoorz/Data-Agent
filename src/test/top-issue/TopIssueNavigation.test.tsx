import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Index from "@/pages/Index";

vi.mock("@/components/dashboard/pages/MainDashboard", () => ({
  default: () => <div>Main Dashboard Page</div>,
}));

vi.mock("@/components/dashboard/pages/TopIssueAnalysis", () => ({
  default: () => <div>Top Issue Analysis Page</div>,
}));

vi.mock("@/components/dashboard/FilterPanel", () => ({
  default: () => <div>Legacy Filter Panel</div>,
}));

vi.mock("@/components/dashboard/KPICards", () => ({
  default: () => <div>Legacy KPI Cards</div>,
}));

vi.mock("@/components/dashboard/DefectTrendChart", () => ({
  default: () => <div>Legacy Defect Trend Chart</div>,
}));

vi.mock("@/components/dashboard/StatusDistributionChart", () => ({
  default: () => <div>Legacy Status Distribution Chart</div>,
}));

vi.mock("@/components/dashboard/TopIssueTable", () => ({
  default: () => <div>Legacy Top Issue Table</div>,
}));

describe("Top Issue navigation", () => {
  it("renders the Top Issue analysis page instead of the legacy fallback", () => {
    render(<Index />);

    fireEvent.click(screen.getByRole("button", { name: "Top Issue 分析" }));

    expect(screen.getByText("Top Issue Analysis Page")).toBeInTheDocument();
    expect(screen.queryByText("Legacy Top Issue Table")).not.toBeInTheDocument();
  });
});