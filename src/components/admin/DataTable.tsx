import { useState } from "react";
import {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronsUpDown,
  Eye,
  X,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** Row selection callback — receives selected row objects */
  onSelectionChange?: (selectedRows: TData[]) => void;
  /** Whether to show the row-selection checkbox column */
  enableSelection?: boolean;
  /** Optional toolbar content rendered above the table (e.g. bulk actions) */
  toolbar?: React.ReactNode;
  /** Empty-state message */
  emptyMessage?: string;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  onSelectionChange,
  enableSelection = false,
  toolbar,
  emptyMessage = "暂无数据",
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});

  // Inject selection column if enabled
  const allColumns: ColumnDef<TData, TValue>[] = enableSelection
    ? [
        {
          id: "select",
          header: ({ table }) => (
            <Checkbox
              checked={table.getIsAllPageRowsSelected()}
              onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
              aria-label="全选"
            />
          ),
          cell: ({ row }) => (
            <Checkbox
              checked={row.getIsSelected()}
              onCheckedChange={(value) => row.toggleSelected(!!value)}
              aria-label="选择行"
            />
          ),
          enableSorting: false,
          enableHiding: false,
          size: 40,
        },
        ...columns,
      ]
    : columns;

  const table = useReactTable({
    data,
    columns: allColumns,
    state: { sorting, columnVisibility, rowSelection },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: (updater) => {
      setRowSelection(updater);
      // Notify parent of selected rows
      const next = typeof updater === "function" ? updater(rowSelection) : updater;
      if (onSelectionChange) {
        const selectedIndices = Object.keys(next).filter((k) => next[k]);
        onSelectionChange(selectedIndices.map((i) => data[Number(i)]).filter(Boolean));
      }
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const selectedCount = Object.values(rowSelection).filter(Boolean).length;

  return (
    <div className="space-y-3">
      {/* Toolbar: column visibility + bulk actions */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {selectedCount > 0 && toolbar}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto">
              <Eye className="mr-1.5 h-4 w-4" />
              列显示
              <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>切换列显示</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table
              .getAllColumns()
              .filter((col) => typeof col.getCanHide === "function" && col.getCanHide())
              .map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="capitalize"
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {column.columnDef.meta?.headerLabel || column.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-[hsl(var(--border))]">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="bg-[hsl(var(--muted))]">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}>
                    {header.isPlaceholder
                      ? null
                      : header.column.getCanSort()
                        ? (
                          <button
                            className="inline-flex items-center gap-1 font-semibold text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--foreground))]"
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            <SortIcon direction={header.column.getIsSorted()} />
                          </button>
                        )
                        : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  className="transition-colors hover:bg-[hsl(var(--muted))]"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={allColumns.length} className="h-24 text-center text-[hsl(var(--muted-foreground))]">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Selection count indicator */}
      {enableSelection && selectedCount > 0 && (
        <div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
          <span className="rounded-md bg-[hsl(var(--primary))] px-2 py-0.5 font-medium text-white">
            {selectedCount}
          </span>
          行已选中
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setRowSelection({})}>
            <X className="mr-1 h-3 w-3" />
            清除
          </Button>
        </div>
      )}
    </div>
  );
}

function SortIcon({ direction }: { direction: false | "asc" | "desc" }) {
  if (direction === "asc") return <ArrowUp className="h-3.5 w-3.5" />;
  if (direction === "desc") return <ArrowDown className="h-3.5 w-3.5" />;
  return <ChevronsUpDown className="h-3 w-3 opacity-40" />;
}

// Augment ColumnMeta to support custom header labels for the visibility menu
declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    headerLabel?: string;
  }
}
