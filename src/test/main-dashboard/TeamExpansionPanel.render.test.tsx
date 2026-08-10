import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TeamExpansionPanel from "@/components/dashboard/main-dashboard/TeamExpansionPanel";

describe("TeamExpansionPanel rendering", () => {
  it("shows team outcome percentages above the bars without helper copy", () => {
    render(
      <TeamExpansionPanel
        teamOutcomeRows={[
          {
            problemFinderTeam: "DTSV_China",
            totalTickets: 2572,
            resolvedForwardCount: 796,
            rejectedDirectlyCount: 1272,
            resolvedForwardTeamPercent: 30.95,
            rejectedDirectlyTeamPercent: 49.46,
            teamDenominator: 2572,
          },
        ]}
        selectedOutcomeKey={null}
        selectedTeam={null}
        onSelectTeamOutcome={vi.fn()}
      />,
    );

    expect(screen.getByText("30.95%")).toBeInTheDocument();
    expect(screen.getByText("49.46%")).toBeInTheDocument();
    expect(screen.queryByText("Y-axis shows ticket count so teams can be compared by volume.")).not.toBeInTheDocument();
    expect(screen.queryByText("Click a bar to drill into one team outcome.")).not.toBeInTheDocument();
  });
});