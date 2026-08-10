import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Pencil,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { adminApi, type ChatQueryRow } from "@/lib/adminApi";
import {
  formatDateTime,
  formatMs,
  formatNumber,
  formatTokens,
} from "@/lib/adminFormat";
import { exportToCsv } from "@/lib/csvExport";
import { DataTable } from "@/components/admin/DataTable";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

const PAGE_SIZE = 10;

const columns: ColumnDef<ChatQueryRow>[] = [
  {
    accessorKey: "createdAt",
    header: "时间",
    meta: { headerLabel: "时间" },
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-xs text-[hsl(var(--muted-foreground))]">
        {formatDateTime(row.original.createdAt)}
      </span>
    ),
  },
  {
    accessorKey: "model",
    header: "模型",
    meta: { headerLabel: "模型" },
    cell: ({ row }) => (
      <span className="font-mono text-xs text-[hsl(var(--foreground))]">
        {row.original.model || "-"}
      </span>
    ),
  },
  {
    accessorKey: "queryPreview",
    header: "查询内容",
    meta: { headerLabel: "查询内容" },
    cell: ({ row }) => (
      <div className="max-w-[280px]">
        <p className="truncate text-[hsl(var(--foreground))]">
          {row.original.queryPreview || "(空查询)"}
        </p>
        {row.original.contextEnabled && (
          <span className="text-xs text-blue-500">带缺陷上下文</span>
        )}
      </div>
    ),
  },
  {
    accessorKey: "status",
    header: "状态",
    meta: { headerLabel: "状态" },
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "estimatedInputTokens",
    header: "Token",
    meta: { headerLabel: "Token" },
    cell: ({ row }) => (
      <span className="text-xs text-[hsl(var(--muted-foreground))]">
        {formatTokens(
          row.original.estimatedInputTokens + row.original.estimatedOutputTokens,
        )}
      </span>
    ),
  },
  {
    accessorKey: "totalMs",
    header: "耗时",
    meta: { headerLabel: "耗时" },
    cell: ({ row }) => (
      <span className="text-xs text-[hsl(var(--muted-foreground))]">
        {formatMs(row.original.totalMs)}
      </span>
    ),
  },
  {
    id: "actions",
    header: "操作",
    meta: { headerLabel: "操作" },
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex items-center justify-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setEditingRef?.(row.original)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-red-500 hover:text-red-600"
          onClick={() => setDeletingRef?.(row.original)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    ),
  },
];

// Module-level refs for column action callbacks (set by the page component)
let setEditingRef: ((row: ChatQueryRow) => void) | null = null;
let setDeletingRef: ((row: ChatQueryRow) => void) | null = null;

const ChatQueriesPage = () => {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<ChatQueryRow | null>(null);
  const [deleting, setDeleting] = useState<ChatQueryRow | null>(null);
  const [selectedRows, setSelectedRows] = useState<ChatQueryRow[]>([]);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);

  // Wire up column action callbacks
  setEditingRef = setEditing;
  setDeletingRef = setDeleting;

  const { data, isLoading } = useQuery({
    queryKey: ["admin-chat-queries", page, search, status],
    queryFn: () =>
      adminApi.listChatQueries({
        page,
        pageSize: PAGE_SIZE,
        search: search || undefined,
        status: status === "all" ? undefined : status,
      }),
  });

  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<ChatQueryRow> }) =>
      adminApi.updateChatQuery(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-chat-queries"] });
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
      toast.success("记录已更新");
      setEditing(null);
    },
    onError: (e) => toast.error(`更新失败：${e.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => adminApi.deleteChatQuery(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-chat-queries"] });
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
      toast.success("记录已删除");
      setDeleting(null);
    },
    onError: (e) => toast.error(`删除失败：${e.message}`),
  });

  const batchDeleteMutation = useMutation({
    mutationFn: (ids: number[]) => adminApi.batchChatQuery({ ids, action: "delete" }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["admin-chat-queries"] });
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
      toast.success(`已批量删除 ${res.affected} 条记录`);
      setSelectedRows([]);
      setBatchDeleteOpen(false);
    },
    onError: (e) => toast.error(`批量删除失败：${e.message}`),
  });

  const batchValidMutation = useMutation({
    mutationFn: (ids: number[]) =>
      adminApi.batchChatQuery({ ids, action: "setValid", isValid: false }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["admin-chat-queries"] });
      toast.success(`已标记 ${res.affected} 条为无效`);
      setSelectedRows([]);
    },
    onError: (e) => toast.error(`操作失败：${e.message}`),
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  const handleSearch = () => {
    setPage(1);
    setSearch(searchInput.trim());
  };

  const handleExport = () => {
    if (!data?.rows.length) {
      toast.error("没有可导出的数据");
      return;
    }
    exportToCsv(`chat-queries-${new Date().toISOString().slice(0, 10)}`, data.rows, [
      { header: "时间", accessor: (r) => formatDateTime(r.createdAt) },
      { header: "Request ID", accessor: (r) => r.requestId },
      { header: "模型", accessor: (r) => r.model },
      { header: "查询内容", accessor: (r) => r.queryPreview },
      { header: "状态", accessor: (r) => r.status },
      { header: "输入Token", accessor: (r) => r.estimatedInputTokens },
      { header: "输出Token", accessor: (r) => r.estimatedOutputTokens },
      { header: "耗时(ms)", accessor: (r) => r.totalMs },
      { header: "首字节(ms)", accessor: (r) => r.firstChunkMs },
      { header: "是否有效", accessor: (r) => (r.isValid ? "是" : "否") },
      { header: "备注", accessor: (r) => r.notes },
    ]);
    toast.success("CSV 已导出");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-[hsl(var(--foreground))]">查询记录</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            所有 Agent Chat 请求的详细记录 · 支持排序、批量操作、导出
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="mr-1.5 h-4 w-4" />
          导出 CSV
        </Button>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
            <Input
              placeholder="搜索查询内容、Request ID 或备注…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="pl-9"
            />
          </div>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-[140px]">
              <SelectValue placeholder="状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="success">成功</SelectItem>
              <SelectItem value="error">失败</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={handleSearch} size="default">
            <Search className="mr-1.5 h-4 w-4" />
            搜索
          </Button>
        </div>
      </Card>

      {/* Data table with sorting, selection, column visibility */}
      <Card className="p-4">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={data?.rows || []}
            enableSelection
            onSelectionChange={setSelectedRows}
            emptyMessage="暂无查询记录"
            toolbar={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setBatchDeleteOpen(true)}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  批量删除 ({selectedRows.length})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    batchValidMutation.mutate(selectedRows.map((r) => r.id))
                  }
                  disabled={batchValidMutation.isPending}
                >
                  <XCircle className="mr-1.5 h-3.5 w-3.5" />
                  标记无效
                </Button>
              </div>
            }
          />
        )}
      </Card>

      {/* Pagination */}
      {data && data.total > 0 && (
        <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            共 {formatNumber(data.total)} 条，第 {page}/{totalPages} 页
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Edit dialog */}
      {editing && (
        <EditDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSave={(body) => updateMutation.mutate({ id: editing.id, body })}
          saving={updateMutation.isPending}
        />
      )}

      {/* Single delete confirm */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该记录？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可撤销。将永久删除查询记录 #{deleting?.id}（{deleting?.queryPreview?.slice(0, 50)}…）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 hover:bg-red-600"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Batch delete confirm */}
      <AlertDialog open={batchDeleteOpen} onOpenChange={setBatchDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认批量删除 {selectedRows.length} 条记录？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可撤销。将永久删除选中的 {selectedRows.length} 条查询记录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 hover:bg-red-600"
              onClick={() =>
                batchDeleteMutation.mutate(selectedRows.map((r) => r.id))
              }
              disabled={batchDeleteMutation.isPending}
            >
              {batchDeleteMutation.isPending ? "删除中…" : "确认批量删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

function StatusBadge({ status }: { status: string }) {
  if (status === "success") {
    return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">成功</Badge>;
  }
  return <Badge className="bg-red-100 text-red-700 hover:bg-red-100">失败</Badge>;
}

function EditDialog({
  row,
  onClose,
  onSave,
  saving,
}: {
  row: ChatQueryRow;
  onClose: () => void;
  onSave: (body: { notes?: string; isValid?: boolean; status?: string }) => void;
  saving: boolean;
}) {
  const [notes, setNotes] = useState(row.notes || "");
  const [isValid, setIsValid] = useState(row.isValid);
  const [status, setStatus] = useState(row.status);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑查询记录 #{row.id}</DialogTitle>
          <DialogDescription>修改备注、有效性与状态</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))] p-3 text-xs">
            <DetailRow label="Request ID" value={row.requestId} />
            <DetailRow label="模型" value={row.model} />
            <DetailRow label="查询内容" value={row.queryPreview} />
            <DetailRow
              label="Token"
              value={`输入 ${formatNumber(row.estimatedInputTokens)} / 输出 ${formatNumber(row.estimatedOutputTokens)}`}
            />
            <DetailRow label="耗时" value={formatMs(row.totalMs)} />
            <DetailRow label="首字节" value={formatMs(row.firstChunkMs)} />
            <DetailRow label="时间" value={formatDateTime(row.createdAt)} />
            {row.errorMessage && (
              <DetailRow label="错误" value={row.errorMessage} highlight />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="status-select">状态标记</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="status-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="success">成功</SelectItem>
                <SelectItem value="error">失败</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[hsl(var(--border))] px-3 py-2.5">
            <Label htmlFor="valid-switch" className="text-sm">
              标记为有效记录
            </Label>
            <Switch id="valid-switch" checked={isValid} onCheckedChange={setIsValid} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes-area">备注</Label>
            <Textarea
              id="notes-area"
              placeholder="添加分析备注、问题说明…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => onSave({ notes, isValid, status })}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-[hsl(var(--muted-foreground))]">{label}</span>
      <span
        className={`flex-1 break-words ${
          highlight ? "text-red-600" : "text-[hsl(var(--foreground))]"
        }`}
      >
        {value || "-"}
      </span>
    </div>
  );
}

export default ChatQueriesPage;
