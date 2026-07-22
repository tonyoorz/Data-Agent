import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Pencil, Search, Trash2 } from "lucide-react";
import { adminApi, type DedupSearchRow } from "@/lib/adminApi";
import { formatDateTime, formatMs } from "@/lib/adminFormat";
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

const DedupSearchesPage = () => {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [success, setSuccess] = useState("all");
  const [editing, setEditing] = useState<DedupSearchRow | null>(null);
  const [deleting, setDeleting] = useState<DedupSearchRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-dedup-searches", page, search, success],
    queryFn: () =>
      adminApi.listDedupSearches({
        page,
        pageSize: PAGE_SIZE,
        search: search || undefined,
        success: success === "all" ? undefined : success,
      }),
  });

  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { notes?: string; isValid?: boolean } }) =>
      adminApi.updateDedupSearch(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-dedup-searches"] });
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
      toast.success("记录已更新");
      setEditing(null);
    },
    onError: (e) => toast.error(`更新失败：${e.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => adminApi.deleteDedupSearch(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-dedup-searches"] });
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
      toast.success("记录已删除");
      setDeleting(null);
    },
    onError: (e) => toast.error(`删除失败：${e.message}`),
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-[hsl(var(--foreground))]">查重记录</h2>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          缺陷查重（Duplicate Search）调用记录与管理
        </p>
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
            <Input
              placeholder="搜索查重 query 或备注…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setPage(1);
                  setSearch(searchInput.trim());
                }
              }}
              className="pl-9"
            />
          </div>
          <Select
            value={success}
            onValueChange={(v) => {
              setSuccess(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-[140px]">
              <SelectValue placeholder="结果" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="success">成功</SelectItem>
              <SelectItem value="error">失败</SelectItem>
            </SelectContent>
          </Select>
          <Button
            onClick={() => {
              setPage(1);
              setSearch(searchInput.trim());
            }}
          >
            <Search className="mr-1.5 h-4 w-4" />
            搜索
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-sm">
            <thead>
              <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-left">
                <th className="px-4 py-3 font-semibold text-[hsl(var(--muted-foreground))]">时间</th>
                <th className="px-4 py-3 font-semibold text-[hsl(var(--muted-foreground))]">查询内容</th>
                <th className="px-4 py-3 text-center font-semibold text-[hsl(var(--muted-foreground))]">TopK</th>
                <th className="px-4 py-3 text-center font-semibold text-[hsl(var(--muted-foreground))]">命中</th>
                <th className="px-4 py-3 font-semibold text-[hsl(var(--muted-foreground))]">摘要模型</th>
                <th className="px-4 py-3 font-semibold text-[hsl(var(--muted-foreground))]">状态</th>
                <th className="px-4 py-3 text-right font-semibold text-[hsl(var(--muted-foreground))]">耗时</th>
                <th className="px-4 py-3 text-center font-semibold text-[hsl(var(--muted-foreground))]">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-[hsl(var(--border))]">
                    <td colSpan={8} className="px-4 py-4">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              ) : data?.rows.length ? (
                data.rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-[hsl(var(--border))] transition-colors hover:bg-[hsl(var(--muted))]"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                      {formatDateTime(row.createdAt)}
                    </td>
                    <td className="max-w-[260px] px-4 py-3">
                      <p className="truncate text-[hsl(var(--foreground))]">
                        {row.queryText || "(空)"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-[hsl(var(--muted-foreground))]">
                      {row.topK}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="font-medium text-[hsl(var(--foreground))]">
                        {row.resultCount}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-[hsl(var(--muted-foreground))]">
                        {row.summaryModel || "-"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {row.success ? (
                        <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                          成功
                        </Badge>
                      ) : (
                        <Badge className="bg-red-100 text-red-700 hover:bg-red-100">失败</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-[hsl(var(--muted-foreground))]">
                      {formatMs(row.totalMs)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setEditing(row)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-500 hover:text-red-600"
                          onClick={() => setDeleting(row)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-[hsl(var(--muted-foreground))]">
                    暂无查重记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {data && data.total > 0 && (
          <div className="flex flex-col items-center justify-between gap-3 border-t border-[hsl(var(--border))] px-4 py-3 sm:flex-row">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              共 {data.total} 条，第 {page}/{totalPages} 页
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
      </Card>

      {editing && (
        <DedupEditDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSave={(body) => updateMutation.mutate({ id: editing.id, body })}
          saving={updateMutation.isPending}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该查重记录？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可撤销。将永久删除记录 #{deleting?.id}（{deleting?.queryText?.slice(0, 50)}…）。
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
    </div>
  );
};

function DedupEditDialog({
  row,
  onClose,
  onSave,
  saving,
}: {
  row: DedupSearchRow;
  onClose: () => void;
  onSave: (body: { notes?: string; isValid?: boolean }) => void;
  saving: boolean;
}) {
  const [notes, setNotes] = useState(row.notes || "");
  const [isValid, setIsValid] = useState(row.isValid);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑查重记录 #{row.id}</DialogTitle>
          <DialogDescription>修改备注与有效性</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))] p-3 text-xs">
            <div className="flex gap-2">
              <span className="w-20 shrink-0 text-[hsl(var(--muted-foreground))]">查询内容</span>
              <span className="flex-1 break-words text-[hsl(var(--foreground))]">
                {row.queryText}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="w-20 shrink-0 text-[hsl(var(--muted-foreground))]">TopK</span>
              <span className="text-[hsl(var(--foreground))]">{row.topK}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-20 shrink-0 text-[hsl(var(--muted-foreground))]">命中数</span>
              <span className="text-[hsl(var(--foreground))]">{row.resultCount}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-20 shrink-0 text-[hsl(var(--muted-foreground))]">摘要模型</span>
              <span className="font-mono text-[hsl(var(--foreground))]">{row.summaryModel || "-"}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-20 shrink-0 text-[hsl(var(--muted-foreground))]">耗时</span>
              <span className="text-[hsl(var(--foreground))]">{formatMs(row.totalMs)}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-20 shrink-0 text-[hsl(var(--muted-foreground))]">时间</span>
              <span className="text-[hsl(var(--foreground))]">{formatDateTime(row.createdAt)}</span>
            </div>
            {row.errorMessage && (
              <div className="flex gap-2">
                <span className="w-20 shrink-0 text-[hsl(var(--muted-foreground))]">错误</span>
                <span className="flex-1 break-words text-red-600">{row.errorMessage}</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[hsl(var(--border))] px-3 py-2.5">
            <Label htmlFor="dedup-valid" className="text-sm">
              标记为有效记录
            </Label>
            <Switch id="dedup-valid" checked={isValid} onCheckedChange={setIsValid} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="dedup-notes">备注</Label>
            <Textarea
              id="dedup-notes"
              placeholder="添加分析备注…"
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
          <Button onClick={() => onSave({ notes, isValid })} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default DedupSearchesPage;
