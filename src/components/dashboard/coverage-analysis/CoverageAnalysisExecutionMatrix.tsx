import type { CoverageAnalysisTestcaseDetailRow } from "./coverageAnalysisTypes";

type CoverageAnalysisExecutionMatrixProps = {
  rows: CoverageAnalysisTestcaseDetailRow[];
  emptyMessage: string;
};

type ExecutionMatrixCell = {
  status: string;
  count: number;
};

type ExecutionMatrixRow = {
  testId: string;
  testName: string;
  topAida: string;
  project: string;
  pu: string;
  tester: string;
  weekCells: Map<string, ExecutionMatrixCell>;
  weeksWithResult: number;
  weeksPassed: number;
  testFrequency: number;
  passRate: number;
  totalCount: number;
};

const statusPriority: Record<string, number> = {
  Failed: 5,
  Blocked: 4,
  "Requires Attention": 4,
  "In Progress": 3,
  Planned: 2,
  Passed: 1,
  Skipped: 0,
};

function normalizeCoverageStatus(status: string) {
  const normalized = String(status).trim().toLowerCase();

  switch (normalized) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "requires attention":
      return "Requires Attention";
    case "planned":
      return "Planned";
    case "in progress":
    case "in_progress":
    case "not completed":
      return "In Progress";
    case "skipped":
      return "Skipped";
    default:
      return String(status).trim() || "Unknown";
  }
}

function parseTestWeekSortKey(testWeek: string) {
  const match = String(testWeek).trim().match(/^(\d{2,4})-CW(\d{2})$/i);
  if (!match) {
    return { year: Number.MAX_SAFE_INTEGER, week: Number.MAX_SAFE_INTEGER };
  }

  const rawYear = Number.parseInt(match[1], 10);
  const normalizedYear = rawYear < 100 ? rawYear + 2000 : rawYear;
  const week = Number.parseInt(match[2], 10);
  return { year: normalizedYear, week };
}

function compareTestWeek(left: string, right: string) {
  const leftKey = parseTestWeekSortKey(left);
  const rightKey = parseTestWeekSortKey(right);

  if (leftKey.year !== rightKey.year) {
    return leftKey.year - rightKey.year;
  }

  if (leftKey.week !== rightKey.week) {
    return leftKey.week - rightKey.week;
  }

  return left.localeCompare(right);
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function resolveCellClassName(status: string) {
  switch (status) {
    case "Passed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "Failed":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "Blocked":
    case "Requires Attention":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "In Progress":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "Planned":
      return "border-slate-200 bg-slate-50 text-slate-700";
    case "Skipped":
      return "border-zinc-200 bg-zinc-100 text-zinc-700";
    default:
      return "border-border/70 bg-muted/30 text-muted-foreground";
  }
}

function buildExecutionMatrix(rows: CoverageAnalysisTestcaseDetailRow[]) {
  const orderedWeeks = Array.from(
    new Set(rows.map((row) => row.test_week.trim()).filter((testWeek) => testWeek.length > 0)),
  ).sort(compareTestWeek);

  const groupedRows = new Map<string, ExecutionMatrixRow>();

  rows.forEach((row) => {
    const testId = row.test_id.trim();
    const week = row.test_week.trim();
    if (!testId || !week) {
      return;
    }

    const groupKey = testId;
    const normalizedStatus = normalizeCoverageStatus(row.status);
    const count = Number.isFinite(row.count) ? row.count : 0;
    const currentGroup =
      groupedRows.get(groupKey) ??
      {
        testId,
        testName: row.test_name,
        topAida: row.top_aida,
        project: row.project,
        pu: row.pu,
        tester: row.tester,
        weekCells: new Map<string, ExecutionMatrixCell>(),
        weeksWithResult: 0,
        weeksPassed: 0,
        testFrequency: 0,
        passRate: 0,
        totalCount: 0,
      };

    const currentCell = currentGroup.weekCells.get(week);
    if (!currentCell) {
      currentGroup.weekCells.set(week, {
        status: normalizedStatus,
        count,
      });
    } else {
      const shouldReplaceStatus =
        (statusPriority[normalizedStatus] ?? -1) > (statusPriority[currentCell.status] ?? -1);
      currentGroup.weekCells.set(week, {
        status: shouldReplaceStatus ? normalizedStatus : currentCell.status,
        count: currentCell.count + count,
      });
    }

    currentGroup.totalCount += count;
    groupedRows.set(groupKey, currentGroup);
  });

  const matrixRows = Array.from(groupedRows.values()).map((row) => {
    const weeksWithResult = row.weekCells.size;
    const weeksPassed = Array.from(row.weekCells.values()).filter((cell) => cell.status === "Passed").length;

    return {
      ...row,
      weeksWithResult,
      weeksPassed,
      testFrequency: orderedWeeks.length === 0 ? 0 : weeksWithResult / orderedWeeks.length,
      passRate: weeksWithResult === 0 ? 0 : weeksPassed / weeksWithResult,
    };
  });

  matrixRows.sort((left, right) => {
    if (right.weeksWithResult !== left.weeksWithResult) {
      return right.weeksWithResult - left.weeksWithResult;
    }

    if (left.passRate !== right.passRate) {
      return left.passRate - right.passRate;
    }

    if (right.totalCount !== left.totalCount) {
      return right.totalCount - left.totalCount;
    }

    return left.testId.localeCompare(right.testId);
  });

  return { orderedWeeks, matrixRows };
}

const CoverageAnalysisExecutionMatrix = ({
  rows,
  emptyMessage,
}: CoverageAnalysisExecutionMatrixProps) => {
  const { orderedWeeks, matrixRows } = buildExecutionMatrix(rows);

  if (matrixRows.length === 0 || orderedWeeks.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/20 px-6 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border-b border-border/70">
      <table className="w-full min-w-[1100px] text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/20 text-left">
            <th className="sticky left-0 z-20 bg-background px-5 py-3 font-medium text-muted-foreground">
              Test ID
            </th>
            <th className="sticky left-[120px] z-20 bg-background px-5 py-3 font-medium text-muted-foreground">
              Test Name
            </th>
            {orderedWeeks.map((week) => (
              <th key={week} className="px-3 py-3 text-center font-medium text-muted-foreground">
                {week}
              </th>
            ))}
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">Test Frequency</th>
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">Pass Rate</th>
          </tr>
        </thead>
        <tbody>
          {matrixRows.map((row) => (
            <tr key={row.testId} className="border-b border-border/50 align-top last:border-0">
              <td className="sticky left-0 z-10 bg-background px-5 py-4 font-medium text-foreground">
                {row.testId}
              </td>
              <td className="sticky left-[120px] z-10 bg-background px-5 py-4 text-foreground">
                <div className="space-y-1">
                  <div className="font-medium text-foreground">{row.testName}</div>
                  <div className="text-xs text-muted-foreground">
                    {[row.topAida, row.project, row.pu, row.tester].filter(Boolean).join(" / ")}
                  </div>
                </div>
              </td>
              {orderedWeeks.map((week) => {
                const cell = row.weekCells.get(week);

                return (
                  <td key={`${row.testId}-${week}`} className="px-3 py-4 text-center">
                    {cell ? (
                      <div
                        className={`inline-flex min-w-[88px] items-center justify-center rounded-full border px-2.5 py-1 text-xs font-medium ${resolveCellClassName(cell.status)}`}
                        title={`${cell.status} (${cell.count})`}
                      >
                        {cell.status}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </td>
                );
              })}
              <td className="px-4 py-4 text-right font-medium text-foreground">
                {formatPercent(row.testFrequency)}
              </td>
              <td className="px-4 py-4 text-right font-medium text-foreground">
                {formatPercent(row.passRate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default CoverageAnalysisExecutionMatrix;