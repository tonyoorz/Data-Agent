import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import DashboardSidebar from "@/components/dashboard/DashboardSidebar";

describe("DashboardSidebar traceability navigation", () => {
  it("places Traceability Analysis between coverage and test status", () => {
    render(<DashboardSidebar active="main-dashboard" onNavigate={vi.fn()} />);

    const coverageItem = screen.getByRole("button", { name: /测试覆盖率分析/i });
    const traceabilityItem = screen.getByRole("button", { name: /追溯分析|Traceability Analysis/i });
    const testStatusItem = screen.getByRole("button", { name: /测试状态分析/i });
    const buttons = screen.getAllByRole("button");

    expect(buttons.indexOf(coverageItem)).toBeLessThan(buttons.indexOf(traceabilityItem));
    expect(buttons.indexOf(traceabilityItem)).toBeLessThan(buttons.indexOf(testStatusItem));
  });
});