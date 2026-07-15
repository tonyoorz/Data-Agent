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
    creationTime: `2026-03-${String((index % 28) + 1).padStart(2, "0")}T08:00:00Z`,
    problemFinderTeam: index % 2 === 0 ? "DTSV_China" : "[AT]W72-FIT",
    classification: index % 2 === 0 ? "Showstopper_Candidate" : "Field Observation",
    problemSeverity: index % 2 === 0 ? "05-unsatisfactory" : "04-deficient",
    requirement: index % 2 === 0 ? "DOC_PreCon_A | DOC_PreCon_B" : "DOC_PreCon_C",
    group: index % 2 === 0 ? "Integration" : "Q-Gate",
    phase: index % 2 === 0 ? "03-In Analysis" : "04-In Progress",
    isResolvedForward: index % 3 === 0,
    isRejectedDirectly: index % 3 === 1,
    year: "2026",
    project: index % 2 === 0 ? "G68" : "U12",
    assignedEcu: index % 2 === 0 ? "ECU-A" : "ECU-B",
    aida: index % 2 === 0 ? "Digital" : "EE",
    defectCategory: index % 2 === 0 ? "CN Speech" : "Global Core",
    solutionCluster: index % 2 === 0 ? "Integration" : "CoC",
    pu: index % 2 === 0 ? "PU1" : "PU2",
    market: index % 2 === 0 ? "CN" : "EU",
    leadModel: index % 2 === 0 ? "LM1" : "LM2",
  }));
}

function renderTicketDetailTable(
  rows = createRows(2),
  overrides: Record<string, unknown> = {},
) {
  const onPageChange = vi.fn();
  const onPageSizeChange = vi.fn();
  const onSearchChange = vi.fn();
  const onSortChange = vi.fn();

  const props: any = {
    rows,
    totalRows: 120,
    page: 1,
    pageSize: 50,
    selection: {},
    selectedOutcomeLabel: null,
    onClearSelection: vi.fn(),
    onPageChange,
    onPageSizeChange,
    onSearchChange,
    onSortChange,
    sortBy: "ticket_id",
    sortOrder: "asc",
    ...overrides,
  };

  render(
    <TicketDetailTable {...props} />,
  );

  return { onPageChange, onPageSizeChange, onSearchChange, onSortChange };
}

describe("TicketDetailTable", () => {
  it("renders Ticket ID values as Octane hyperlinks", () => {
    renderTicketDetailTable();

    const ticketLink = screen.getByRole("link", { name: "1000" });

    expect(ticketLink).toHaveAttribute(
      "href",
      "https://octane-prod.bmwgroup.net/ui/entity-navigation?p=1002/2001&entityType=work_item&id=1000",
    );
    expect(ticketLink).toHaveAttribute("target", "_blank");
    expect(ticketLink).toHaveAttribute("rel", "noreferrer");
  });

  it("lets the Title column absorb remaining table width by default", () => {
    renderTicketDetailTable();

    const titleHeader = screen.getByRole("columnheader", { name: "Title" });
    const titleFilterCell = screen.getByLabelText("Filter Title column").closest("th");
    const ticketIdHeader = screen.getByRole("columnheader", { name: "Ticket ID" });

    expect(titleHeader.getAttribute("style") ?? "").not.toContain("width");
    expect(titleFilterCell?.getAttribute("style") ?? "").not.toContain("width");
    expect(ticketIdHeader.getAttribute("style") ?? "").toContain("width");
  });

  it("delegates page changes and page-size changes to the parent", () => {
    const { onPageChange, onPageSizeChange } = renderTicketDetailTable(createRows(50));

    const section = screen.getByText("Ticket Detail").closest("section");

    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByText("50 of 120 tickets")).toBeInTheDocument();
    expect(within(section as HTMLElement).getByText("Page 1 of 3")).toBeInTheDocument();

    fireEvent.click(within(section as HTMLElement).getByRole("button", { name: "Next page" }));
    fireEvent.change(within(section as HTMLElement).getByLabelText("Rows per page"), {
      target: { value: "20" },
    });

    const pageInput = within(section as HTMLElement).getByLabelText("Go to page");
    fireEvent.change(pageInput, { target: { value: "3" } });
    fireEvent.keyDown(pageInput, { key: "Enter", code: "Enter", charCode: 13 });

    expect(onPageChange).toHaveBeenNthCalledWith(1, 2);
    expect(onPageSizeChange).toHaveBeenCalledWith(20);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 3);
  });

  it("keeps dense grid controls, local search filtering, and column toggles", () => {
    const { onSearchChange } = renderTicketDetailTable();

    expect(screen.getByPlaceholderText("Search tickets, titles, teams, requirement, or phase")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter Ticket ID column")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter Title column")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compact density" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Defect Category" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Creation Time" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Classification" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Requirement" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Problem Severity" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Phase" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Outcome" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Year" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search tickets, titles, teams, requirement, or phase"), {
      target: { value: "ticket 2" },
    });

    const table = screen.getByRole("table", { name: "Ticket detail table" });
    expect(within(table).getByText("1001")).toBeInTheDocument();
    expect(within(table).queryByText("1000")).not.toBeInTheDocument();
    expect(onSearchChange).toHaveBeenCalledWith("ticket 2");

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.queryByRole("menuitemcheckbox", { name: "Status" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Group" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Outcome" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Phase" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemcheckbox", { name: "Requirement" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Project" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Year" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Compact density" }));
    expect(screen.getByTestId("ticket-detail-grid")).toHaveAttribute("data-density", "compact");
  }, 10_000);

  it("delegates header sorting to the parent in ascending and descending order", () => {
    const { onSortChange } = renderTicketDetailTable(createRows(3), {
      sortBy: "ticket_id",
      sortOrder: "asc",
    });

    fireEvent.click(screen.getByRole("button", { name: "Sort by Ticket ID" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort by Ticket ID" }));
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Phase" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort by Phase" }));

    expect(onSortChange).toHaveBeenNthCalledWith(1, "ticket_id", "desc");
    expect(onSortChange).toHaveBeenNthCalledWith(2, "ticket_id", "asc");
    expect(onSortChange).toHaveBeenNthCalledWith(3, "phase", "asc");
  });

  it("reflects descending classification as the default active sort", () => {
    renderTicketDetailTable(createRows(3), {
      sortBy: "classification",
      sortOrder: "desc",
    });

    expect(screen.getByRole("columnheader", { name: "Classification" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(screen.getByRole("columnheader", { name: "Ticket ID" })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  });

  it("filters visible rows from a column filter menu", () => {
    renderTicketDetailTable(createRows(4));

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Phase" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter Phase" }));
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "04-In Progress" }));

    const table = screen.getByRole("table", { name: "Ticket detail table" });
    expect(within(table).getByText("1001")).toBeInTheDocument();
    expect(within(table).getByText("1003")).toBeInTheDocument();
    expect(within(table).queryByText("1000")).not.toBeInTheDocument();
    expect(within(table).queryByText("1002")).not.toBeInTheDocument();
  });
});
