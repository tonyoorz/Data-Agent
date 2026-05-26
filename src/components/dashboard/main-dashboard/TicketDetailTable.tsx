import { useEffect, useMemo, useState } from "react";

import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  type VisibilityState,
  useReactTable,
} from "@tanstack/react-table";
import { Columns3, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { MainDashboardDrilldownSelection } from "./mainDashboardFiltering";
import type { MainDashboardTicketRow } from "./mainDashboardTypes";

type TicketDetailTableProps = {
  rows: MainDashboardTicketRow[];
  selection: MainDashboardDrilldownSelection;
  selectedOutcomeLabel?: string | null;
  onClearSelection: () => void;
};

type DensityMode = "compact" | "comfortable" | "spacious";

type TicketDetailColumnMeta = {
  label: string;
  filterPlaceholder: string;
};

const densityClassNames: Record<DensityMode, { cell: string; header: string }> = {
  compact: {
    cell: "px-2 py-1.5 text-[12px]",
    header: "h-10 px-2 py-1 text-[11px] uppercase tracking-[0.12em]",
  },
  comfortable: {
    cell: "px-2.5 py-2 text-[12px]",
    header: "h-11 px-2.5 py-1.5 text-[11px] uppercase tracking-[0.12em]",
  },
  spacious: {
    cell: "px-3 py-3 text-[13px]",
    header: "h-12 px-3 py-2 text-[11px] uppercase tracking-[0.12em]",
  },
};

const pageSizeOptions = [20, 50, 100] as const;

function getOutcomeLabel(row: MainDashboardTicketRow) {
  if (row.isResolvedForward) {
    return "Resolved Forward";
  }

  if (row.isRejectedDirectly) {
    return "Rejected Directly";
  }

  return "In Progress";
}

function createTicketDetailSearchIndex(row: MainDashboardTicketRow) {
  return [
    row.ticketId,
    row.ticketName,
    row.problemFinderTeam,
    row.status,
    row.phase,
    row.group,
    row.project,
    row.year,
    row.assignedEcu,
    row.aida,
    row.defectCategory ?? "",
    row.solutionCluster,
    row.pu,
    row.market,
    row.leadModel,
    getOutcomeLabel(row),
  ]
    .join(" ")
    .toLowerCase();
}

const TicketDetailTable = ({
  rows,
  selection,
  selectedOutcomeLabel,
  onClearSelection,
}: TicketDetailTableProps) => {
  const hasSelection = Boolean(selection.outcomeKey || selection.team);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    assignedEcu: false,
    aida: false,
    defectCategory: false,
    solutionCluster: false,
    pu: false,
    market: false,
    leadModel: false,
  });
  const [density, setDensity] = useState<DensityMode>("compact");
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 50,
  });
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({
    ticketId: 104,
    ticketName: 260,
    problemFinderTeam: 184,
    status: 172,
    phase: 132,
    group: 132,
    outcome: 164,
    project: 104,
    year: 88,
  });

  const columns = useMemo<ColumnDef<MainDashboardTicketRow>[]>(
    () => [
      {
        accessorKey: "ticketId",
        header: "Ticket ID",
        size: 104,
        minSize: 88,
        meta: {
          label: "Ticket ID",
          filterPlaceholder: "Filter Ticket ID column",
        } satisfies TicketDetailColumnMeta,
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">{row.original.ticketId}</span>
        ),
      },
      {
        accessorKey: "ticketName",
        header: "Title",
        size: 260,
        minSize: 160,
        meta: {
          label: "Title",
          filterPlaceholder: "Filter Title column",
        } satisfies TicketDetailColumnMeta,
        cell: ({ row }) => <span className="font-medium text-foreground">{row.original.ticketName}</span>,
      },
      {
        accessorKey: "problemFinderTeam",
        header: "Problem Finder Team",
        size: 184,
        minSize: 140,
        meta: {
          label: "Problem Finder Team",
          filterPlaceholder: "Filter Problem Finder Team column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "status",
        header: "Status",
        size: 172,
        minSize: 140,
        meta: {
          label: "Status",
          filterPlaceholder: "Filter Status column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "phase",
        header: "Phase",
        size: 132,
        minSize: 108,
        meta: {
          label: "Phase",
          filterPlaceholder: "Filter Phase column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "group",
        header: "Group",
        size: 132,
        minSize: 108,
        meta: {
          label: "Group",
          filterPlaceholder: "Filter Group column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        id: "outcome",
        accessorFn: (row) => getOutcomeLabel(row),
        header: "Outcome",
        size: 164,
        minSize: 132,
        meta: {
          label: "Outcome",
          filterPlaceholder: "Filter Outcome column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "project",
        header: "Project",
        size: 104,
        minSize: 88,
        meta: {
          label: "Project",
          filterPlaceholder: "Filter Project column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "year",
        header: "Year",
        size: 88,
        minSize: 76,
        meta: {
          label: "Year",
          filterPlaceholder: "Filter Year column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "assignedEcu",
        header: "Assigned ECU",
        size: 132,
        minSize: 108,
        meta: {
          label: "Assigned ECU",
          filterPlaceholder: "Filter Assigned ECU column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "aida",
        header: "AIDA",
        size: 96,
        minSize: 84,
        meta: {
          label: "AIDA",
          filterPlaceholder: "Filter AIDA column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "defectCategory",
        header: "Defect Category",
        size: 160,
        minSize: 132,
        meta: {
          label: "Defect Category",
          filterPlaceholder: "Filter Defect Category column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "solutionCluster",
        header: "Solution Cluster",
        size: 156,
        minSize: 124,
        meta: {
          label: "Solution Cluster",
          filterPlaceholder: "Filter Solution Cluster column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "pu",
        header: "PU",
        size: 96,
        minSize: 76,
        meta: {
          label: "PU",
          filterPlaceholder: "Filter PU column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "market",
        header: "Market",
        size: 96,
        minSize: 84,
        meta: {
          label: "Market",
          filterPlaceholder: "Filter Market column",
        } satisfies TicketDetailColumnMeta,
      },
      {
        accessorKey: "leadModel",
        header: "Lead Model",
        size: 128,
        minSize: 108,
        meta: {
          label: "Lead Model",
          filterPlaceholder: "Filter Lead Model column",
        } satisfies TicketDetailColumnMeta,
      },
    ],
    [],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: {
      globalFilter,
      columnFilters,
      columnVisibility,
      columnSizing,
      pagination,
    },
    columnResizeMode: "onChange",
    enableColumnFilters: true,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onPaginationChange: setPagination,
    globalFilterFn: (row, _columnId, filterValue) => {
      const searchValue = String(filterValue ?? "").trim().toLowerCase();

      if (!searchValue) {
        return true;
      }

      return createTicketDetailSearchIndex(row.original).includes(searchValue);
    },
    filterFns: {
      textIncludes: (row, columnId, filterValue) => {
        const cellValue = String(row.getValue(columnId) ?? "").toLowerCase();
        return cellValue.includes(String(filterValue ?? "").trim().toLowerCase());
      },
    },
    defaultColumn: {
      minSize: 80,
      size: 120,
      enableColumnFilter: true,
      filterFn: "textIncludes",
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  useEffect(() => {
    setPagination((current) => ({
      ...current,
      pageIndex: 0,
    }));
  }, [rows]);

  const visibleColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());
  const filteredRowCount = table.getFilteredRowModel().rows.length;
  const paginatedRows = table.getRowModel().rows;
  const paginatedRowCount = paginatedRows.length;
  const totalPages = Math.max(table.getPageCount(), 1);
  const densityClassName = densityClassNames[density];

  return (
    <section className="workbench-panel p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Ticket Detail</h2>
          <p className="text-sm text-muted-foreground">
            {paginatedRowCount} of {filteredRowCount} tickets
          </p>
        </div>

        {hasSelection ? (
          <div className="flex flex-wrap items-center gap-2">
            {selectedOutcomeLabel ? (
              <Badge
                variant="secondary"
                className="rounded-full bg-primary/10 px-3 py-1 text-primary"
              >
                Outcome: {selectedOutcomeLabel}
              </Badge>
            ) : null}
            {selection.team ? (
              <Badge
                variant="secondary"
                className="rounded-full bg-secondary px-3 py-1 text-secondary-foreground"
              >
                Team: {selection.team}
              </Badge>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClearSelection}
            >
              Clear selection
            </Button>
          </div>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-border/80 bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">
          No tickets match the current filtered and drilldown scope.
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-muted/20 p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1 lg:max-w-md">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={globalFilter}
                  onChange={(event) => {
                    setGlobalFilter(event.target.value);
                    setPagination((current) => ({
                      ...current,
                      pageIndex: 0,
                    }));
                  }}
                  placeholder="Search tickets, titles, teams, or status"
                  className="h-9 pl-8 text-sm"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setGlobalFilter("");
                  setColumnFilters([]);
                  setPagination((current) => ({
                    ...current,
                    pageIndex: 0,
                  }));
                }}
                className="justify-start"
              >
                <X className="h-4 w-4" />
                Clear filters
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Rows per page</span>
                <select
                  aria-label="Rows per page"
                  value={pagination.pageSize}
                  onChange={(event) => {
                    const nextPageSize = Number(event.target.value);
                    setPagination({
                      pageIndex: 0,
                      pageSize: nextPageSize,
                    });
                  }}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  {pageSizeOptions.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>

              <div className="inline-flex rounded-lg border border-border bg-background p-1">
                {(["compact", "comfortable", "spacious"] as const).map((mode) => (
                  <Button
                    key={mode}
                    type="button"
                    variant={density === mode ? "secondary" : "ghost"}
                    size="sm"
                    aria-label={`${mode.charAt(0).toUpperCase()}${mode.slice(1)} density`}
                    onClick={() => setDensity(mode)}
                    className="h-7 px-2.5 text-xs capitalize"
                  >
                    {mode}
                  </Button>
                ))}
              </div>

              <div className="relative">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-expanded={columnsMenuOpen}
                  onClick={() => setColumnsMenuOpen((current) => !current)}
                >
                  <Columns3 className="h-4 w-4" />
                  Columns
                </Button>
                {columnsMenuOpen ? (
                  <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg">
                    {visibleColumns.map((column) => {
                      const meta = column.columnDef.meta as TicketDetailColumnMeta | undefined;

                      return (
                        <button
                          key={column.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-label={meta?.label ?? column.id}
                          aria-checked={column.getIsVisible()}
                          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm text-left hover:bg-accent"
                          onClick={() => column.toggleVisibility(!column.getIsVisible())}
                        >
                          <span>{meta?.label ?? column.id}</span>
                          <span aria-hidden="true" className="text-xs text-muted-foreground">
                            {column.getIsVisible() ? "Visible" : "Hidden"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>
              Page {pagination.pageIndex + 1} of {totalPages}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                Previous page
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                Next page
              </Button>
            </div>
          </div>

          <div
            data-testid="ticket-detail-grid"
            data-density={density}
            className="rounded-2xl border border-border/70 bg-background"
          >
            <Table
              aria-label="Ticket detail table"
              className="min-w-[1100px] table-fixed border-separate border-spacing-0"
              style={{ width: table.getCenterTotalSize() }}
            >
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id} className="bg-muted/30 hover:bg-muted/30">
                    {headerGroup.headers.map((header) => {
                      const meta = header.column.columnDef.meta as TicketDetailColumnMeta | undefined;

                      return (
                        <TableHead
                          key={header.id}
                          className={`relative border-b border-border/70 bg-background/95 ${densityClassName.header}`}
                          style={{ width: header.getSize() }}
                        >
                          <div className="truncate pr-3 font-semibold text-foreground/80">
                            {header.isPlaceholder
                              ? null
                              : flexRender(header.column.columnDef.header, header.getContext())}
                          </div>
                          <button
                            type="button"
                            aria-label={`Resize ${meta?.label ?? header.column.id} column`}
                            onMouseDown={header.getResizeHandler()}
                            onTouchStart={header.getResizeHandler()}
                            className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-primary/20"
                          />
                        </TableHead>
                      );
                    })}
                  </TableRow>
                ))}
                <TableRow className="bg-muted/20 hover:bg-muted/20">
                  {table.getVisibleLeafColumns().map((column) => {
                    const meta = column.columnDef.meta as TicketDetailColumnMeta | undefined;

                    return (
                      <TableHead
                        key={`${column.id}-filter`}
                        className="border-b border-border/60 bg-muted/20 px-2 py-2"
                        style={{ width: column.getSize() }}
                      >
                        <Input
                          value={String(column.getFilterValue() ?? "")}
                          onChange={(event) => {
                            column.setFilterValue(event.target.value);
                            setPagination((current) => ({
                              ...current,
                              pageIndex: 0,
                            }));
                          }}
                          aria-label={meta?.filterPlaceholder ?? `Filter ${column.id} column`}
                          placeholder={meta?.filterPlaceholder ?? `Filter ${column.id}`}
                          className="h-8 text-xs"
                        />
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedRows.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={table.getVisibleLeafColumns().length} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      No tickets match the current table filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedRows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          className={`${densityClassName.cell} border-b border-border/50 last:border-r-0`}
                          style={{ width: cell.column.getSize() }}
                        >
                          <div className="truncate">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </section>
  );
};

export default TicketDetailTable;