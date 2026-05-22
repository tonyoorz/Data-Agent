import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TicketDetailTable from "@/components/dashboard/main-dashboard/TicketDetailTable";
import type { MainDashboardTicketRow } from "@/components/dashboard/main-dashboard/mainDashboardTypes";

const sampleRows: MainDashboardTicketRow[] = [
  {
    ticketId: "1001",
    ticketName: "Alpha power reset",
    status: "03-In Analysis",
    problemFinderTeam: "DTSV_China",
    group: "Integration",
    phase: "Validation",
    isResolvedForward: true,
    isRejectedDirectly: false,
    year: "2026",
    project: "G68",
    assignedEcu: "ECU-A",
    aida: "Digital",
    solutionCluster: "Integration",
    pu: "PU1",
    market: "CN",
    leadModel: "LM1",
  },
  {
    ticketId: "1002",
    ticketName: "Beta thermal flicker",
    status: "01-Rejected",
    problemFinderTeam: "[AT]W72-FIT",
    group: "Q-Gate",
    phase: "Analysis",
    isResolvedForward: false,
    isRejectedDirectly: true,
    year: "2026",
    project: "U12",
    assignedEcu: "ECU-B",
    aida: "EE",
    solutionCluster: "CoC",
    pu: "PU2",
    market: "EU",
    leadModel: "LM2",
  },
];

function renderTicketDetailTable() {
  return render(
    <TicketDetailTable
      rows={sampleRows}
      selection={{}}
      selectedOutcomeLabel={null}
      onClearSelection={vi.fn()}
    />,
  );
}

describe("TicketDetailTable data grid", () => {
  it("supports dense grid controls including search, column filters, and density switching", () => {
    renderTicketDetailTable();

    expect(screen.getByPlaceholderText("Search tickets, titles, teams, or status")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter Ticket ID column")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter Title column")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compact density" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Compact density" }));

    expect(screen.getByTestId("ticket-detail-grid")).toHaveAttribute("data-density", "compact");
  });

  it("filters rows through the global search and per-column filters", () => {
    renderTicketDetailTable();

    fireEvent.change(screen.getByPlaceholderText("Search tickets, titles, teams, or status"), {
      target: { value: "beta" },
    });

    let table = screen.getByRole("table", { name: "Ticket detail table" });
    expect(within(table).getByText("1002")).toBeInTheDocument();
    expect(within(table).queryByText("1001")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search tickets, titles, teams, or status"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Filter Status column"), {
      target: { value: "Rejected" },
    });

    table = screen.getByRole("table", { name: "Ticket detail table" });
    expect(within(table).getByText("1002")).toBeInTheDocument();
    expect(within(table).queryByText("1001")).not.toBeInTheDocument();
  });

  it("allows columns to be hidden from the grid", () => {
    renderTicketDetailTable();

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Status" }));

    expect(screen.queryByRole("columnheader", { name: "Status" })).not.toBeInTheDocument();
  });
});