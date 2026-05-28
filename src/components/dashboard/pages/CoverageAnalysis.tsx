import { useEffect, useMemo, useState } from "react";

import { AlertTriangle, Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import CoverageAnalysisChartCard, {
  type CoverageAnalysisChartDatum,
} from "../coverage-analysis/CoverageAnalysisChartCard";
import CoverageAnalysisEmptyState from "../coverage-analysis/CoverageAnalysisEmptyState";
import CoverageAnalysisFilters from "../coverage-analysis/CoverageAnalysisFilters";
import {
  CoverageAnalysisApiError,
  DEFAULT_TESTCASE_DETAIL_LIMIT,
} from "../coverage-analysis/coverageAnalysisApi";
import {
  applyAidaPointSelection,
  applyFvPointSelection,
} from "../coverage-analysis/coverageAnalysisSelection";
import type {
  CoverageAnalysisAidaStatusRow,
  CoverageAnalysisFilters as CoverageAnalysisFiltersType,
  CoverageAnalysisProjectStatusRow,
  CoverageAnalysisTestcaseDetailRow,
} from "../coverage-analysis/coverageAnalysisTypes";
import {
  useCoverageAnalysisOverviewData,
  useCoverageAnalysisTestcaseDetailData,
} from "../coverage-analysis/useCoverageAnalysisData";

function createEmptyFilters(): CoverageAnalysisFiltersType {
  return {
    years: [],
    projects: [],
    testWeeks: [],
    pus: [],
    aidas: [],
    statuses: [],
    featureRegions: [],
    fvps: [],
    fvs: [],
  };
}

function resolveDefaultYearSelection(years: string[]) {
  const currentYear = String(new Date().getFullYear());
  if (years.includes(currentYear)) {
    return [currentYear];
  }

  return [];
}

const MAX_SCATTER_WEEKS = 16;
const MAX_SCATTER_CATEGORIES = 12;

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

type ChartWindowResult<Row> = {
  rows: Row[];
  wasBounded: boolean;
};

function buildScatterWindow<Row extends { test_week: string; count: number }>(
  rows: Row[],
  categorySelector: (row: Row) => string,
): ChartWindowResult<Row> {
  const normalizedRows = rows.filter((row) => row.test_week.trim() && categorySelector(row).trim());
  if (normalizedRows.length === 0) {
    return { rows: [], wasBounded: false };
  }

  const orderedWeeks = Array.from(new Set(normalizedRows.map((row) => row.test_week))).sort(compareTestWeek);
  const visibleWeeks = orderedWeeks.slice(-MAX_SCATTER_WEEKS);
  const weekScopedRows = normalizedRows.filter((row) => visibleWeeks.includes(row.test_week));

  const categoryTotals = new Map<string, number>();
  weekScopedRows.forEach((row) => {
    const category = categorySelector(row).trim();
    categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + row.count);
  });

  const visibleCategories = Array.from(categoryTotals.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_SCATTER_CATEGORIES)
    .map(([category]) => category);

  const windowedRows = weekScopedRows.filter((row) => visibleCategories.includes(categorySelector(row).trim()));

  return {
    rows: windowedRows,
    wasBounded:
      orderedWeeks.length > visibleWeeks.length || categoryTotals.size > visibleCategories.length,
  };
}

function createDensityNote() {
  return `图表最多展示最近 ${MAX_SCATTER_WEEKS} 个测试周与当前筛选下的高频项，避免图表过密。`;
}

function buildProjectStatusChartRows(
  rows: CoverageAnalysisProjectStatusRow[],
): ChartWindowResult<CoverageAnalysisChartDatum> {
  const windowedRows = buildScatterWindow(rows, (row) => row.fv);

  return {
    rows: windowedRows.rows.map((row) => ({
      xValue: row.test_week,
      yValue: row.fv,
      selectionValue: row.fv,
      status: row.status,
      count: row.count,
      seriesLabel: row.fvp,
    })),
    wasBounded: windowedRows.wasBounded,
  };
}

function buildAidaStatusChartRows(
  rows: CoverageAnalysisAidaStatusRow[],
): ChartWindowResult<CoverageAnalysisChartDatum> {
  const windowedRows = buildScatterWindow(rows, (row) => row.top_aida);

  return {
    rows: windowedRows.rows.map((row) => ({
      xValue: row.test_week,
      yValue: row.top_aida,
      selectionValue: row.top_aida,
      status: row.status,
      count: row.count,
      seriesLabel: row.top_aida,
    })),
    wasBounded: windowedRows.wasBounded,
  };
}

function collectStatuses(
  preferredStatuses: string[],
  groups: Array<CoverageAnalysisProjectStatusRow | CoverageAnalysisAidaStatusRow>,
) {
  const derivedStatuses = groups.reduce<string[]>((result, row) => {
    if (result.includes(row.status)) {
      return result;
    }

    return [...result, row.status];
  }, []);

  if (preferredStatuses.length === 0) {
    return derivedStatuses;
  }

  const nextStatuses = preferredStatuses.filter((status) => derivedStatuses.includes(status));
  return nextStatuses.length > 0 ? nextStatuses : derivedStatuses;
}

function toggleFilterValue(
  current: CoverageAnalysisFiltersType,
  field: keyof CoverageAnalysisFiltersType,
  value: string,
): CoverageAnalysisFiltersType {
  const values = current[field];
  const nextValues = values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];

  return {
    ...current,
    [field]: nextValues,
  };
}

function isNotReadyError(error: unknown): error is CoverageAnalysisApiError {
  return error instanceof CoverageAnalysisApiError && error.status === 503;
}

const CoverageAnalysis = () => {
  const [selectedFilters, setSelectedFilters] =
    useState<CoverageAnalysisFiltersType>(createEmptyFilters);
  const {
    data: overviewData,
    error: overviewError,
    isLoading: isOverviewLoading,
    isFetching: isOverviewFetching,
  } = useCoverageAnalysisOverviewData(selectedFilters);
  const shouldLoadTestcaseDetail =
    selectedFilters.years.length > 0 ||
    (overviewData !== undefined && overviewData.filterOptions.years.length === 0);
  const {
    data: testcaseDetailRowsData,
    error: testcaseDetailError,
    isLoading: isTestcaseDetailLoading,
    isFetching: isTestcaseDetailFetching,
  } = useCoverageAnalysisTestcaseDetailData(selectedFilters, {
    enabled: shouldLoadTestcaseDetail,
    limit: DEFAULT_TESTCASE_DETAIL_LIMIT,
  });

  const projectChartWindow = useMemo(
    () => buildProjectStatusChartRows(overviewData?.projectStatusRows ?? []),
    [overviewData?.projectStatusRows],
  );
  const aidaChartWindow = useMemo(
    () => buildAidaStatusChartRows(overviewData?.aidaStatusRows ?? []),
    [overviewData?.aidaStatusRows],
  );

  const projectChartRows = projectChartWindow.rows;
  const aidaChartRows = aidaChartWindow.rows;
  const projectStatuses = useMemo(
    () => collectStatuses(overviewData?.filterOptions.statuses ?? [], overviewData?.projectStatusRows ?? []),
    [overviewData?.filterOptions.statuses, overviewData?.projectStatusRows],
  );
  const aidaStatuses = useMemo(
    () => collectStatuses(overviewData?.filterOptions.statuses ?? [], overviewData?.aidaStatusRows ?? []),
    [overviewData?.filterOptions.statuses, overviewData?.aidaStatusRows],
  );
  const defaultYears = useMemo(
    () => resolveDefaultYearSelection(overviewData?.filterOptions.years ?? []),
    [overviewData?.filterOptions.years],
  );

  useEffect(() => {
    if (defaultYears.length === 0) {
      return;
    }

    setSelectedFilters((current) => {
      if (current.years.length > 0) {
        return current;
      }

      return {
        ...current,
        years: defaultYears,
      };
    });
  }, [defaultYears]);

  if (isOverviewLoading && !overviewData) {
    return (
      <section className="workbench-panel p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading testing coverage analysis...</span>
        </div>
      </section>
    );
  }

  if (overviewError && !overviewData && isNotReadyError(overviewError)) {
    return (
      <CoverageAnalysisEmptyState
        title="Testing coverage analysis is not ready yet."
        description="The analytics service is missing required TAP coverage fields for this page."
        missingFields={overviewError.missingFields}
      />
    );
  }

  if (overviewError && !overviewData) {
    return (
      <section className="workbench-panel p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to load testing coverage analysis.</AlertTitle>
          <AlertDescription>
            {overviewError.message || "Check whether the analytics service is available."}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const filterOptions = overviewData?.filterOptions ?? createEmptyFilters();
  const testcaseDetailRows = testcaseDetailRowsData ?? [];
  const hasRenderableData =
    projectChartRows.length > 0 || aidaChartRows.length > 0 || testcaseDetailRows.length > 0;

  return (
    <div className="space-y-5">
      {overviewError && overviewData ? (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to refresh testing coverage analysis.</AlertTitle>
          <AlertDescription>
            Showing the latest cached snapshot. {overviewError.message}
          </AlertDescription>
        </Alert>
      ) : null}

      <CoverageAnalysisFilters
        filterOptions={filterOptions}
        selectedFilters={selectedFilters}
        onToggleValue={(field, value) => {
          setSelectedFilters((current) => toggleFilterValue(current, field, value));
        }}
        onReset={() => setSelectedFilters(createEmptyFilters())}
        isRefreshing={(isOverviewFetching && !isOverviewLoading) || isTestcaseDetailFetching}
      />

      {!hasRenderableData ? (
        <CoverageAnalysisEmptyState
          title="No coverage rows match the current filters."
          description="Adjust the current selections to bring project status, AIDA status, and testcase detail rows back into scope."
        />
      ) : null}

      <CoverageAnalysisChartCard
        title="图表 1: 按周和功能分类的测试状态"
        description="横轴为测试周，纵轴为 FV；气泡大小代表数量，颜色代表状态。点击气泡可快速缩小 FV 筛选范围。"
        rows={projectChartRows}
        statuses={projectStatuses}
        densityNote={createDensityNote()}
        emptyMessage="当前筛选条件下暂无项目状态数据。"
        onSelectValue={(value) => {
          setSelectedFilters((current) => ({
            ...current,
            fvs: applyFvPointSelection(current.fvs, value),
          }));
        }}
      />

      <CoverageAnalysisChartCard
        title="图表 2: 按 Top AIDA 和测试周分类的状态"
        description="横轴为测试周，纵轴为 Top AIDA；气泡大小代表数量，颜色代表状态。点击气泡可快速缩小 Top AIDA 筛选范围。"
        rows={aidaChartRows}
        statuses={aidaStatuses}
        densityNote={createDensityNote()}
        emptyMessage="当前筛选条件下暂无 AIDA 状态数据。"
        onSelectValue={(value) => {
          setSelectedFilters((current) => ({
            ...current,
            aidas: applyAidaPointSelection(current.aidas, value),
          }));
        }}
      />

      <section className="dashboard-card">
        <div className="border-b border-border/70 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-foreground">图表 3: 按测试用例和测试周分类的状态</h2>
            <p className="text-sm text-muted-foreground">
              当前筛选范围内的测试用例明细，用于补充查看测试周、状态、AIDA 与执行人。
            </p>
          </div>
        </div>

        {isTestcaseDetailLoading && testcaseDetailRows.length === 0 ? (
          <div className="flex items-center gap-3 px-5 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading testcase detail rows...</span>
          </div>
        ) : testcaseDetailError ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            Unable to load testcase detail rows. {testcaseDetailError.message}
          </div>
        ) : testcaseDetailRows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            当前筛选条件下暂无测试用例明细数据。
          </div>
        ) : (
          <div className="overflow-x-auto">
            {testcaseDetailRows.length >= DEFAULT_TESTCASE_DETAIL_LIMIT ? (
              <div className="px-5 py-3 text-xs text-muted-foreground">
                Showing the first {DEFAULT_TESTCASE_DETAIL_LIMIT} testcase detail rows. Narrow the filters to inspect a smaller slice.
              </div>
            ) : null}
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 font-medium text-muted-foreground">Test ID</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Test Name</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Test Week</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Status</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Top AIDA</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Project</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">PU</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Tester</th>
                  <th className="px-5 py-3 text-right font-medium text-muted-foreground">Count</th>
                </tr>
              </thead>
              <tbody>
                {testcaseDetailRows.map((row: CoverageAnalysisTestcaseDetailRow) => (
                  <tr
                    key={`${row.test_id}-${row.test_week}-${row.status}-${row.top_aida}`}
                    className="border-b border-border/50 transition-colors last:border-0 hover:bg-muted/20"
                  >
                    <td className="px-5 py-3 font-medium text-foreground">{row.test_id}</td>
                    <td className="px-5 py-3 text-foreground">{row.test_name}</td>
                    <td className="px-5 py-3 text-muted-foreground">{row.test_week}</td>
                    <td className="px-5 py-3 text-foreground">{row.status}</td>
                    <td className="px-5 py-3 text-muted-foreground">{row.top_aida}</td>
                    <td className="px-5 py-3 text-muted-foreground">{row.project}</td>
                    <td className="px-5 py-3 text-muted-foreground">{row.pu}</td>
                    <td className="px-5 py-3 text-muted-foreground">{row.tester}</td>
                    <td className="px-5 py-3 text-right font-medium text-foreground">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default CoverageAnalysis;
