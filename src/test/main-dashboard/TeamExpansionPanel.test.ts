import { describe, expect, it } from "vitest";

import { createTeamExpansionChartData } from "@/components/dashboard/main-dashboard/TeamExpansionPanel";

describe("TeamExpansionPanel chart data", () => {
  it("uses team outcome ticket counts for the plotted bar values", () => {
    const chartData = createTeamExpansionChartData([
      {
        problemFinderTeam: "DTSV_China",
        totalTickets: 2572,
        resolvedForwardCount: 796,
        rejectedDirectlyCount: 1272,
        resolvedForwardTeamPercent: 30.95,
        rejectedDirectlyTeamPercent: 49.46,
        teamDenominator: 2572,
      },
      {
        problemFinderTeam: "Spotlight_DTSV_C",
        totalTickets: 3,
        resolvedForwardCount: 0,
        rejectedDirectlyCount: 3,
        resolvedForwardTeamPercent: 0,
        rejectedDirectlyTeamPercent: 100,
        teamDenominator: 3,
      },
    ]);

    expect(chartData.rows).toEqual([
      expect.objectContaining({
        team: "DTSV_China",
        resolvedForwardValue: 796,
        rejectedDirectlyValue: 1272,
      }),
      expect.objectContaining({
        team: "Spotlight_DTSV_C",
        resolvedForwardValue: 0,
        rejectedDirectlyValue: 3,
      }),
    ]);
    expect(chartData.maxTicketCount).toBe(1272);
  });
});