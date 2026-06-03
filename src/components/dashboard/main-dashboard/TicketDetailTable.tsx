import { useEffect, useMemo, useState } from "react";

import {
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  flexRender,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getCoreRowModel,
  getFilteredRowModel,
  type VisibilityState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, Filter, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { MainDashboardDrilldownSelection } from "./mainDashboardFiltering";
import type { MainDashboardTicketRow, MainDashboardTicketSortOrder } from "./mainDashboardTypes";

type TicketDetailTableProps = {
  rows: MainDashboardTicketRow[];
  totalRows: number;
  totalPages?: number;
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: MainDashboardTicketSortOrder;
  selection: MainDashboardDrilldownSelection;
  selectedOutcomeLabel?: string | null;
  pinnedTopTopicCount?: number;
  onClearSelection: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onSearchChange: (search: string) => void;
  onSortChange: (sortBy: string, sortOrder: MainDashboardTicketSortOrder) => void;
};

type DensityMode = "compact" | "comfortable" | "spacious";

type TicketDetailColumnMeta = {
  label: string;
  filterPlaceholder: string;
  sortBy?: string;
  supportsMenuFilter?: boolean;
};

type TicketDetailSetFilterValue = {
  mode: "set";
  values: string[];
};

const EMPTY_FILTER_TOKEN = "__ticket_detail_blank__";

const ticketDetailColumnSortKeys = {
  ticketId: "ticket_id",
  creationTime: "creation_time",
  ticketName: "ticket_name",
  problemFinderTeam: "problem_finder_team",
  classification: "classification",
  requirement: "requirement",
  problemSeverity: "problem_severity",
  phase: "phase",
  group: "group",
  project: "project",
  year: "year",
  assignedEcu: "assigned_ecu",
  aida: "aida",
  defectCategory: "defect_category",
  solutionCluster: "solution_cluster",
  pu: "pu",
  market: "market",
  leadModel: "lead_model",
} as const satisfies Record<string, string>;

function createSortingState(
  sortBy: string,
  sortOrder: MainDashboardTicketSortOrder,
): SortingState {
  const matchingEntry = Object.entries(ticketDetailColumnSortKeys).find(
    ([, sortKey]) => sortKey === sortBy,
  );

  if (!matchingEntry) {
    return [];
  }

  const [columnId] = matchingEntry;
  return [{ id: columnId, desc: sortOrder === "desc" }];
}

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
const autoExpandColumnId = "ticketName";
const OCTANE_WORK_ITEM_URL_BASE =
  "https://octane-prod.bmwgroup.net/ui/entity-navigation?p=1002/2001&entityType=work_item&id=";

function buildOctaneWorkItemUrl(ticketId: string) {
  return `${OCTANE_WORK_ITEM_URL_BASE}${encodeURIComponent(ticketId)}`;
}

function getColumnWidthStyle(
  column: Column<MainDashboardTicketRow, unknown>,
  columnSizing: Record<string, number>,
) {
  if (column.id === autoExpandColumnId && !(column.id in columnSizing)) {
    return undefined;
  }

  return { width: column.getSize() };
}

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
    row.creationTime ?? "",
    row.ticketName,
    row.problemFinderTeam,
    row.classification ?? "",
    row.requirement ?? "",
    row.problemSeverity ?? "",
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

function isSetFilterValue(value: unknown): value is TicketDetailSetFilterValue {
  return typeof value === "object" && value !== null && "mode" in value && (value as { mode?: string }).mode === "set";
}

function normalizeMenuFilterValue(value: unknown) {
  const normalizedValue = String(value ?? "").trim();
  return normalizedValue.length ? normalizedValue : EMPTY_FILTER_TOKEN;
}

function formatMenuFilterValue(value: string) {
  return value === EMPTY_FILTER_TOKEN ? "(Blank)" : value;
}

function getColumnMenuFilterOptions(column: Column<MainDashboardTicketRow, unknown>) {
  return Array.from(column.getFacetedUniqueValues().keys())
    .map((value) => normalizeMenuFilterValue(value))
    .sort((left, right) => {
      if (left === EMPTY_FILTER_TOKEN) {
        return 1;
      }

      if (right === EMPTY_FILTER_TOKEN) {
        return -1;
      }

      return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
    });
}

const TicketDetailTable = ({
  rows,
  totalRows,
  totalPages,
  page,
  pageSize,
  sortBy,
  sortOrder,
  selection,
  selectedOutcomeLabel,
  pinnedTopTopicCount = 0,
  onClearSelection,
  onPageChange,
  onPageSizeChange,
  onSearchChange,
  onSortChange,
}: TicketDetailTableProps) => {
  const hasSelection = Boolean(selection.outcomeKey || selection.team);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [sorting, setSorting] = useState<SortingState>(() => createSortingState(sortBy, sortOrder));
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    phase: false,
    group: false,
    outcome: false,
    project: false,
    year: false,
    assignedEcu: false,
    aida: false,
    solutionCluster: false,
    pu: false,
    market: false,
    leadModel: false,
  });
  const [density, setDensity] = useState<DensityMode>("compact");
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("1");
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({
    ticketId: 104,
    creationTime: 172,
    problemFinderTeam: 184,
    classification: 180,
    requirement: 208,
    problemSeverity: 164,
    phase: 132,
    group: 132,
    outcome: 164,
    project: 104,
    year: 88,
  });

  useEffect(() => {
    setSorting(createSortingState(sortBy, sortOrder));
  }, [sortBy, sortOrder]);

  const handleHeaderSort = (columnId: string, nextSortBy: string) => {
    const currentSort = sorting[0];
    const nextSortOrder: MainDashboardTicketSortOrder =
      currentSort?.id === columnId && !currentSort.desc ? "desc" : "asc";

    setSorting([{ id: columnId, desc: nextSortOrder === "desc" }]);
    onSortChange(nextSortBy, nextSortOrder);
  };

  const applyColumnSetFilter = (
    column: Column<MainDashboardTicketRow, unknown>,
    nextValues: string[],
    allValues: string[],
  ) => {
    const dedupedValues = Array.from(new Set(nextValues));

    if (dedupedValues.length === allValues.length) {
      column.setFilterValue("");
      return;
    }

    column.setFilterValue({ mode: "set", values: dedupedValues } satisfies TicketDetailSetFilterValue);
  };

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
          sortBy: "ticket_id",
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
        cell: ({ row }) => (
          <a
            href={buildOctaneWorkItemUrl(row.original.ticketId)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-primary underline-offset-2 hover:underline"
          >
            {row.original.ticketId}
          </a>
        ),
      },
      {
        accessorKey: "creationTime",
        header: "Creation Time",
        size: 172,
        minSize: 144,
        meta: {
          label: "Creation Time",
          filterPlaceholder: "Filter Creation Time column",
          sortBy: "creation_time",
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
        cell: ({ row }) => <span>{row.original.creationTime || "-"}</span>,
      },
      {
        accessorKey: "ticketName",
        header: "Title",
        size: 260,
        minSize: 160,
        meta: {
          label: "Title",
          filterPlaceholder: "Filter Title column",
          sortBy: "ticket_name",
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
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
          sortBy: "problem_finder_team",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
      },
      {
        accessorKey: "classification",
        header: "Classification",
        size: 180,
        minSize: 148,
        meta: {
          label: "Classification",
          filterPlaceholder: "Filter Classification column",
          sortBy: "classification",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
        cell: ({ row }) => <span>{row.original.classification || "-"}</span>,
      },
      {
        accessorKey: "phase",
        header: "Phase",
        size: 132,
        minSize: 108,
        meta: {
          label: "Phase",
          filterPlaceholder: "Filter Phase column",
          sortBy: "phase",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
      },
      {
        accessorKey: "problemSeverity",
        header: "Problem Severity",
        size: 164,
        minSize: 144,
        meta: {
          label: "Problem Severity",
          filterPlaceholder: "Filter Problem Severity column",
          sortBy: "problem_severity",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
        cell: ({ row }) => <span>{row.original.problemSeverity || "-"}</span>,
      },
      {
        accessorKey: "requirement",
        header: "Requirement",
        size: 208,
        minSize: 160,
        meta: {
          label: "Requirement",
          filterPlaceholder: "Filter Requirement column",
          sortBy: "requirement",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
        cell: ({ row }) => <span>{row.original.requirement || "-"}</span>,
      },
      {
        accessorKey: "group",
        header: "Group",
        size: 132,
        minSize: 108,
        meta: {
          label: "Group",
          filterPlaceholder: "Filter Group column",
          sortBy: "group",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
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
          supportsMenuFilter: true,
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
          sortBy: "project",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
      },
      {
        accessorKey: "year",
        header: "Year",
        size: 88,
        minSize: 76,
        meta: {
          label: "Year",
          filterPlaceholder: "Filter Year column",
          sortBy: "year",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
      },
      {
        accessorKey: "assignedEcu",
        header: "Assigned ECU",
        size: 132,
        minSize: 108,
        meta: {
          label: "Assigned ECU",
          filterPlaceholder: "Filter Assigned ECU column",
          sortBy: "assigned_ecu",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
      },
      {
        accessorKey: "aida",
        header: "AIDA",
        size: 96,
        minSize: 84,
        meta: {
          label: "AIDA",
          filterPlaceholder: "Filter AIDA column",
          sortBy: "aida",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
      },
      {
        accessorKey: "defectCategory",
        header: "Defect Category",
        size: 160,
        minSize: 132,
        meta: {
          label: "Defect Category",
          filterPlaceholder: "Filter Defect Category column",
          sortBy: "defect_category",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
      },
      {
        accessorKey: "solutionCluster",
        header: "Solution Cluster",
        size: 156,
        minSize: 124,
        meta: {
          label: "Solution Cluster",
          filterPlaceholder: "Filter Solution Cluster column",
          sortBy: "solution_cluster",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
      },
      {
        accessorKey: "pu",
        header: "PU",
        size: 96,
        minSize: 76,
        meta: {
          label: "PU",
          filterPlaceholder: "Filter PU column",
          sortBy: "pu",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
      },
      {
        accessorKey: "market",
        header: "Market",
        size: 96,
        minSize: 84,
        meta: {
          label: "Market",
          filterPlaceholder: "Filter Market column",
          sortBy: "market",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
      },
      {
        accessorKey: "leadModel",
        header: "Lead Model",
        size: 128,
        minSize: 108,
        meta: {
          label: "Lead Model",
          filterPlaceholder: "Filter Lead Model column",
          sortBy: "lead_model",
          supportsMenuFilter: true,
        } satisfies TicketDetailColumnMeta,
        enableSorting: true,
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
      sorting,
    },
    columnResizeMode: "onChange",
    enableColumnFilters: true,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onSortingChange: setSorting,
    globalFilterFn: (row, _columnId, filterValue) => {
      const searchValue = String(filterValue ?? "").trim().toLowerCase();

      if (!searchValue) {
        return true;
      }

      return createTicketDetailSearchIndex(row.original).includes(searchValue);
    },
    filterFns: {
      textIncludes: (row, columnId, filterValue) => {
        const rawCellValue = row.getValue(columnId);

        if (isSetFilterValue(filterValue)) {
          if (!filterValue.values.length) {
            return false;
          }

          return filterValue.values.includes(normalizeMenuFilterValue(rawCellValue));
        }

        const cellValue = String(rawCellValue ?? "").toLowerCase();
        return cellValue.includes(String(filterValue ?? "").trim().toLowerCase());
      },
    },
    defaultColumn: {
      minSize: 80,
      size: 120,
      enableColumnFilter: true,
      enableSorting: false,
      filterFn: "textIncludes",
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  const visibleColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());
  const visibleRows = table.getRowModel().rows;
  const resolvedTotalPages = totalPages ?? Math.max(Math.ceil(totalRows / pageSize), 1);
  const densityClassName = densityClassNames[density];

  useEffect(() => {
    setPageJumpValue(String(Math.min(page, resolvedTotalPages)));
  }, [page, resolvedTotalPages]);

  const commitPageJump = () => {
    const trimmedPage = pageJumpValue.trim();

    if (!trimmedPage) {
      setPageJumpValue(String(page));
      return;
    }

    const parsedPage = Number(trimmedPage);

    if (!Number.isFinite(parsedPage)) {
      setPageJumpValue(String(page));
      return;
    }

    const nextPage = Math.min(Math.max(Math.trunc(parsedPage), 1), resolvedTotalPages);
    onPageChange(nextPage);
    setPageJumpValue(String(nextPage));
  };

  return (
    <section className="workbench-panel p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Ticket Detail</h2>
          <p className="text-sm text-muted-foreground">
            {rows.length} of {totalRows} tickets
          </p>
          {pinnedTopTopicCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {pinnedTopTopicCount} Top Topic {pinnedTopTopicCount === 1 ? "ticket is" : "tickets are"} pinned above current Creation Time / Problem Finder Team scope.
            </p>
          ) : null}
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
                    const nextValue = event.target.value;
                    setGlobalFilter(nextValue);
                    onSearchChange(nextValue);
                  }}
                  placeholder="Search tickets, titles, teams, requirement, or phase"
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
                  onSearchChange("");
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
                  value={pageSize}
                  onChange={(event) => {
                    const nextPageSize = Number(event.target.value);
                    onPageSizeChange(nextPageSize);
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
              Page {page} of {resolvedTotalPages}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                <span>Go to page</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={resolvedTotalPages}
                  value={pageJumpValue}
                  onChange={(event) => setPageJumpValue(event.target.value)}
                  onBlur={commitPageJump}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      commitPageJump();
                    }
                  }}
                  aria-label="Go to page"
                  className="h-8 w-20"
                />
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onPageChange(Math.max(page - 1, 1))}
                disabled={page <= 1}
              >
                Previous page
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onPageChange(Math.min(page + 1, resolvedTotalPages))}
                disabled={page >= resolvedTotalPages}
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
              style={{ width: "100%", minWidth: table.getCenterTotalSize() }}
            >
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id} className="bg-muted/30 hover:bg-muted/30">
                    {headerGroup.headers.map((header) => {
                      const meta = header.column.columnDef.meta as TicketDetailColumnMeta | undefined;
                      const sortedState = header.column.getIsSorted();
                      const ariaSort =
                        sortedState === "asc"
                          ? "ascending"
                          : sortedState === "desc"
                            ? "descending"
                            : "none";
                      const sortIcon =
                        sortedState === "asc" ? (
                          <ArrowUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : sortedState === "desc" ? (
                          <ArrowDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        );
                      const menuFilterOptions = meta?.supportsMenuFilter
                        ? getColumnMenuFilterOptions(header.column)
                        : [];
                      const activeSetFilter = isSetFilterValue(header.column.getFilterValue())
                        ? header.column.getFilterValue()
                        : null;
                      const selectedMenuValues = activeSetFilter?.values ?? menuFilterOptions;
                      const hasActiveMenuFilter = Boolean(
                        meta?.supportsMenuFilter
                        && activeSetFilter
                        && selectedMenuValues.length !== menuFilterOptions.length,
                      );

                      return (
                        <TableHead
                          key={header.id}
                          aria-sort={ariaSort}
                          className={`relative border-b border-border/70 bg-background/95 ${densityClassNames[density].header}`}
                          style={getColumnWidthStyle(header.column, columnSizing)}
                        >
                          {meta?.sortBy && !header.isPlaceholder ? (
                            <div className="flex items-start gap-1 pr-3">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={`Sort by ${meta.label}`}
                                onClick={() => handleHeaderSort(header.column.id, meta.sortBy as string)}
                                className="h-auto min-w-0 flex-1 justify-between gap-2 px-0 py-0 text-left font-semibold text-foreground/80 hover:bg-transparent"
                              >
                                <span className="truncate">
                                  {flexRender(header.column.columnDef.header, header.getContext())}
                                </span>
                                {sortIcon}
                              </Button>
                              {meta.supportsMenuFilter ? (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <Button
                                      type="button"
                                      variant={hasActiveMenuFilter ? "secondary" : "ghost"}
                                      size="icon"
                                      aria-label={`Filter ${meta.label}`}
                                      className="h-6 w-6 shrink-0 rounded-md"
                                    >
                                      <Filter className="h-3.5 w-3.5" />
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent align="start" className="w-64 p-3">
                                    <div className="flex items-center justify-between gap-2">
                                      <div>
                                        <p className="text-sm font-semibold text-foreground">{meta.label}</p>
                                        <p className="text-xs text-muted-foreground">
                                          {selectedMenuValues.length} of {menuFilterOptions.length} selected
                                        </p>
                                      </div>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 px-2 text-xs"
                                        onClick={() => header.column.setFilterValue("")}
                                      >
                                        Clear
                                      </Button>
                                    </div>
                                    <div className="mt-3 flex items-center justify-between gap-2">
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-7 px-2 text-xs"
                                        onClick={() => header.column.setFilterValue("")}
                                      >
                                        Select all
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-7 px-2 text-xs"
                                        onClick={() =>
                                          header.column.setFilterValue({
                                            mode: "set",
                                            values: [],
                                          } satisfies TicketDetailSetFilterValue)
                                        }
                                      >
                                        Select none
                                      </Button>
                                    </div>
                                    <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
                                      {menuFilterOptions.map((optionValue) => {
                                        const isChecked = selectedMenuValues.includes(optionValue);

                                        return (
                                          <label
                                            key={optionValue}
                                            className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/40"
                                          >
                                            <Checkbox
                                              checked={isChecked}
                                              aria-label={formatMenuFilterValue(optionValue)}
                                              onCheckedChange={() => {
                                                const nextValues = isChecked
                                                  ? selectedMenuValues.filter((value) => value !== optionValue)
                                                  : [...selectedMenuValues, optionValue];

                                                applyColumnSetFilter(header.column, nextValues, menuFilterOptions);
                                              }}
                                            />
                                            <span className="truncate text-foreground">
                                              {formatMenuFilterValue(optionValue)}
                                            </span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              ) : null}
                            </div>
                          ) : (
                            <div className="truncate pr-3 font-semibold text-foreground/80">
                              {header.isPlaceholder
                                ? null
                                : flexRender(header.column.columnDef.header, header.getContext())}
                            </div>
                          )}
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
                    const currentColumnFilter = column.getFilterValue();
                    const selectedValueCount = isSetFilterValue(currentColumnFilter)
                      ? currentColumnFilter.values.length
                      : null;

                    return (
                      <TableHead
                        key={`${column.id}-filter`}
                        className="border-b border-border/60 bg-muted/20 px-2 py-2"
                        style={getColumnWidthStyle(column, columnSizing)}
                      >
                        {selectedValueCount !== null ? (
                          <div className="mb-1 text-[11px] text-muted-foreground">{selectedValueCount} selected</div>
                        ) : null}
                        <Input
                          value={isSetFilterValue(currentColumnFilter) ? "" : String(currentColumnFilter ?? "")}
                          onChange={(event) => {
                            column.setFilterValue(event.target.value);
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
                {visibleRows.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={table.getVisibleLeafColumns().length} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      No tickets match the current table filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  visibleRows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          className={`${densityClassName.cell} border-b border-border/50 last:border-r-0`}
                          style={getColumnWidthStyle(cell.column, columnSizing)}
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
