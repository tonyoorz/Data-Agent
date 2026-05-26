import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TicketDetailTable from "@/components/dashboard/main-dashboard/TicketDetailTable";
import type { MainDashboardTicketRow } from "@/components/dashboard/main-dashboard/mainDashboardTypes";

function createRows(count: number): MainDashboardTicketRow[] {
  return Array.from({ length: count }, (_value, index) => ({
    ticketId: `${1000 + index}`,
    ticketName: `Ticket ${index + 1}`,
    status: index % 2 === 0 ? "03-In Analysis" : "04-In Progress",
    ticketDate: `2026-04-${String((index % 28) + 1).padStart(2, "0")}`,
    problemFinderTeam: index % 2 === 0 ? "DTSV_China" : "[AT]W72-FIT",
    group: index % 2 === 0 ? "Integration" : "Q-Gate",
    phase: index % 2 === 0 ? "03-In Analysis" : "04-In Progress",
    isResolvedForward: index % 3 === 0,
    isRejectedDirectly: index % 3 === 1,
    year: "2026",
    project: index % 2 === 0 ? "G68" : "U12",
    assignedEcu: index % 2 === 0 ? "ECU-A" : "ECU-B",
    aida: index % 2 === 0 ? "Digital" : "EE",
    solutionCluster: index % 2 === 0 ? "Integration" : "CoC",
    pu: index % 2 === 0 ? "PU1" : "PU2",
    market: index % 2 === 0 ? "CN" : "EU",
    leadModel: index % 2 === 0 ? "LM1" : "LM2",
  }));
}

describe("TicketDetailTable", () => {
  it("defaults to 50 rows per page and supports 20/50/100 page sizes with paging", () => {
    render(
      <TicketDetailTable
        rows={createRows(120)}
        selection={{}}
        selectedOutcomeLabel={null}
        onClearSelection={vi.fn()}
      />,
    );

    const section = screen.getByText("Ticket Detail").closest("section");
    const table = screen.getByRole("table", { name: "Ticket detail table" });

    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByText("50 of 120 tickets")).toBeInTheDocument();
    expect(within(section as HTMLElement).getByLabelText("Rows per page")).toHaveValue("50");
    expect(within(section as HTMLElement).getByText("Page 1 of 3")).toBeInTheDocument();
    expect(within(table).getByText("1000")).toBeInTheDocument();
    expect(within(table).getByText("1049")).toBeInTheDocument();
    expect(within(table).queryByText("1050")).not.toBeInTheDocument();

    fireEvent.click(within(section as HTMLElement).getByRole("button", { name: "Next page" }));

    expect(within(section as HTMLElement).getByText("50 of 120 tickets")).toBeInTheDocument();
    expect(within(section as HTMLElement).getByText("Page 2 of 3")).toBeInTheDocument();
    expect(within(table).getByText("1050")).toBeInTheDocument();
    expect(within(table).queryByText("1000")).not.toBeInTheDocument();

    fireEvent.change(within(section as HTMLElement).getByLabelText("Rows per page"), {
      target: { value: "20" },
    });

    expect(within(section as HTMLElement).getByText("20 of 120 tickets")).toBeInTheDocument();
    expect(within(section as HTMLElement).getByText("Page 1 of 6")).toBeInTheDocument();
    expect(within(table).getByText("1000")).toBeInTheDocument();
    expect(within(table).getByText("1019")).toBeInTheDocument();
    expect(within(table).queryByText("1020")).not.toBeInTheDocument();

    fireEvent.change(within(section as HTMLElement).getByLabelText("Rows per page"), {
      target: { value: "100" },
    });

    expect(within(section as HTMLElement).getByText("100 of 120 tickets")).toBeInTheDocument();
    expect(within(section as HTMLElement).getByText("Page 1 of 2")).toBeInTheDocument();
    expect(within(table).getByText("1099")).toBeInTheDocument();
    expect(within(table).queryByText("1100")).not.toBeInTheDocument();
  });
});import { fireEvent, render, screen, within } from "@testing-library/react";
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
    defectCategory: "CN Speech",
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
    defectCategory: "Global Core",
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

  it("allows defect category to be shown as an optional visible column", () => {
    renderTicketDetailTable();

    expect(screen.queryByRole("columnheader", { name: "Defect Category" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Defect Category" }));

    const table = screen.getByRole("table", { name: "Ticket detail table" });
    expect(screen.getByRole("columnheader", { name: "Defect Category" })).toBeInTheDocument();
    expect(within(table).getByText("CN Speech")).toBeInTheDocument();
    expect(within(table).getByText("Global Core")).toBeInTheDocument();
  });
});