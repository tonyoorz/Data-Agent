import { useEffect, useMemo, useState } from "react";

import { AlertTriangle, Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import CoverageAnalysisChartCard, {
  type CoverageAnalysisChartDatum,
} from "../coverage-analysis/CoverageAnalysisChartCard";
import { downloadChart3Workbook } from "../coverage-analysis/coverageAnalysisChart3Export";
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
  useCoverageAnalysisAidaStatusData,
  useCoverageAnalysisFilterOptionsData,
  useCoverageAnalysisProjectStatusData,
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
const CHART3_PAGE_SIZE = 100;

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

type TestcaseChartResult = {
  rows: CoverageAnalysisChartDatum[];
  orderedLabels: string[];
};

function buildTestcaseDetailChartRows(
  rows: CoverageAnalysisTestcaseDetailRow[],
): TestcaseChartResult {
  const normalizedRows = rows
    .filter((row) => row.test_week.trim() && row.test_id.trim())
    .slice()
    .sort((left, right) => {
      const weekComparison = compareTestWeek(left.test_week, right.test_week);
      if (weekComparison !== 0) {
        return weekComparison;
      }

      const leftNumericId = Number.parseInt(left.test_id, 10);
      const rightNumericId = Number.parseInt(right.test_id, 10);
      const bothNumeric = Number.isFinite(leftNumericId) && Number.isFinite(rightNumericId);

      if (bothNumeric && leftNumericId !== rightNumericId) {
        return leftNumericId - rightNumericId;
      }

      return left.test_id.localeCompare(right.test_id);
    });

  const labelsInOrder: string[] = [];
  const labelSet = new Set<string>();
  normalizedRows.forEach((row) => {
    const nextLabel = `${row.test_id} - ${row.test_name}`;
    if (!labelSet.has(nextLabel)) {
      labelSet.add(nextLabel);
      labelsInOrder.push(nextLabel);
    }
  });

  const groupedRows = new Map<
    string,
    {
      xValue: string;
      yValue: string;
      selectionValue: string;
      status: string;
      count: number;
      testName: string;
      project: string;
      pu: string;
      fvp: string;
      fv: string;
      testers: Set<string>;
    }
  >();

  normalizedRows.forEach((row) => {
    const yValue = `${row.test_id} - ${row.test_name}`;
    const groupKey = [row.test_week, row.test_id, row.status, row.top_aida].join("||");
    const current =
      groupedRows.get(groupKey) ??
      {
        xValue: row.test_week,
        yValue,
        selectionValue: row.top_aida,
        status: row.status,
        count: 0,
        testName: row.test_name,
        project: row.project,
        pu: row.pu,
        fvp: row.fvp,
        fv: row.fv,
        testers: new Set<string>(),
      };

    current.count += row.count;
    if (row.tester.trim()) {
      current.testers.add(row.tester.trim());
    }
    groupedRows.set(groupKey, current);
  });

  return {
    rows: Array.from(groupedRows.values()).map((row) => ({
      xValue: row.xValue,
      yValue: row.yValue,
      selectionValue: row.selectionValue,
      status: row.status,
      count: row.count,
      tooltipTitle: `${row.yValue} - ${row.status}`,
      tooltipFields: [
        { label: "Test Case", value: row.testName || "-" },
        { label: "Top AIDA", value: row.selectionValue || "-" },
        { label: "FVP", value: row.fvp || "-" },
        { label: "FV", value: row.fv || "-" },
        { label: "Project", value: row.project || "-" },
        { label: "PU", value: row.pu || "-" },
        { label: "Tester", value: Array.from(row.testers).join(", ") || "-" },
      ],
    })),
    orderedLabels: labelsInOrder,
  };
}

function collectStatuses(
  preferredStatuses: string[],
  groups: Array<{ status: string }>,
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

function isNotReadyError(error: unknown): error is CoverageAnalysisApiError {
  return error instanceof CoverageAnalysisApiError && error.status === 503;
}

const CoverageAnalysis = () => {
  const [selectedFilters, setSelectedFilters] =
    useState<CoverageAnalysisFiltersType>(createEmptyFilters);
  const [chart3Page, setChart3Page] = useState(1);
  const {
    data: filterOptionsData,
    error: filterOptionsError,
    isLoading: isFilterOptionsLoading,
    isFetching: isFilterOptionsFetching,
  } = useCoverageAnalysisFilterOptionsData(selectedFilters);
  const shouldLoadOverview =
    selectedFilters.years.length > 0 ||
    (filterOptionsData !== undefined && filterOptionsData.years.length === 0);
  const {
    data: projectStatusRowsData,
    error: projectStatusError,
    isLoading: isProjectStatusLoading,
    isFetching: isProjectStatusFetching,
  } = useCoverageAnalysisProjectStatusData(selectedFilters, {
    enabled: shouldLoadOverview,
  });
  const {
    data: aidaStatusRowsData,
    error: aidaStatusError,
    isLoading: isAidaStatusLoading,
    isFetching: isAidaStatusFetching,
  } = useCoverageAnalysisAidaStatusData(selectedFilters, {
    enabled: shouldLoadOverview,
  });
  const shouldLoadTestcaseDetail =
    selectedFilters.years.length > 0 ||
    (filterOptionsData !== undefined && filterOptionsData.years.length === 0);
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
    () => buildProjectStatusChartRows(projectStatusRowsData ?? []),
    [projectStatusRowsData],
  );
  const aidaChartWindow = useMemo(
    () => buildAidaStatusChartRows(aidaStatusRowsData ?? []),
    [aidaStatusRowsData],
  );
  const testcaseChartModel = useMemo(
    () => buildTestcaseDetailChartRows(testcaseDetailRowsData ?? []),
    [testcaseDetailRowsData],
  );

  const projectChartRows = projectChartWindow.rows;
  const aidaChartRows = aidaChartWindow.rows;
  const chart3TotalPages = Math.max(
    Math.ceil(testcaseChartModel.orderedLabels.length / CHART3_PAGE_SIZE),
    1,
  );
  const visibleChart3Labels = useMemo(
    () =>
      testcaseChartModel.orderedLabels.slice(
        (chart3Page - 1) * CHART3_PAGE_SIZE,
        chart3Page * CHART3_PAGE_SIZE,
      ),
    [chart3Page, testcaseChartModel.orderedLabels],
  );
  const testcaseChartRows = useMemo(() => {
    const visibleLabelSet = new Set(visibleChart3Labels);
    return testcaseChartModel.rows.filter((row) => visibleLabelSet.has(row.yValue));
  }, [testcaseChartModel.rows, visibleChart3Labels]);
  const projectStatuses = useMemo(
    () => collectStatuses(filterOptionsData?.statuses ?? [], projectStatusRowsData ?? []),
    [filterOptionsData?.statuses, projectStatusRowsData],
  );
  const aidaStatuses = useMemo(
    () => collectStatuses(filterOptionsData?.statuses ?? [], aidaStatusRowsData ?? []),
    [filterOptionsData?.statuses, aidaStatusRowsData],
  );
  const testcaseStatuses = useMemo(
    () => collectStatuses(filterOptionsData?.statuses ?? [], testcaseDetailRowsData ?? []),
    [filterOptionsData?.statuses, testcaseDetailRowsData],
  );
  const defaultYears = useMemo(
    () => resolveDefaultYearSelection(filterOptionsData?.years ?? []),
    [filterOptionsData?.years],
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

  useEffect(() => {
    setChart3Page(1);
  }, [testcaseDetailRowsData]);

  useEffect(() => {
    setChart3Page((current) => Math.min(current, chart3TotalPages));
  }, [chart3TotalPages]);

  if (isFilterOptionsLoading && !filterOptionsData) {
    return (
      <section className="workbench-panel p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading testing coverage analysis...</span>
        </div>
      </section>
    );
  }

  if (filterOptionsError && !filterOptionsData && isNotReadyError(filterOptionsError)) {
    return (
      <CoverageAnalysisEmptyState
        title="Testing coverage analysis is not ready yet."
        description="The analytics service is missing required TAP coverage fields for this page."
        missingFields={filterOptionsError.missingFields}
      />
    );
  }

  if (filterOptionsError && !filterOptionsData) {
    return (
      <section className="workbench-panel p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to load testing coverage analysis.</AlertTitle>
          <AlertDescription>
            {filterOptionsError.message || "Check whether the analytics service is available."}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const filterOptions = filterOptionsData ?? createEmptyFilters();
  const testcaseDetailRows = testcaseDetailRowsData ?? [];
  const hasRenderableData =
    projectChartRows.length > 0 || aidaChartRows.length > 0 || testcaseChartRows.length > 0;
  const hasRefreshError = Boolean(
    filterOptionsData &&
      (filterOptionsError || projectStatusError || aidaStatusError || testcaseDetailError),
  );

  return (
    <div className="space-y-5">
      {hasRefreshError ? (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to refresh testing coverage analysis.</AlertTitle>
          <AlertDescription>
            Showing the latest cached snapshot. {(filterOptionsError ?? projectStatusError ?? aidaStatusError ?? testcaseDetailError)?.message}
          </AlertDescription>
        </Alert>
      ) : null}

      <CoverageAnalysisFilters
        filterOptions={filterOptions}
        selectedFilters={selectedFilters}
        onApplyValues={(field, values) => {
          setSelectedFilters((current) => ({
            ...current,
            [field]: values,
          }));
        }}
        onReset={() => setSelectedFilters(createEmptyFilters())}
        isRefreshing={
          (isFilterOptionsFetching && !isFilterOptionsLoading) ||
          isProjectStatusFetching ||
          isAidaStatusFetching ||
          isTestcaseDetailFetching
        }
      />

      {!hasRenderableData &&
      !isProjectStatusLoading &&
      !isAidaStatusLoading &&
      !isTestcaseDetailLoading ? (
        <CoverageAnalysisEmptyState
          title="No coverage rows match the current filters."
          description="Adjust the current selections to bring project status, AIDA status, and testcase detail rows back into scope."
        />
      ) : null}

      {isProjectStatusLoading && projectChartRows.length === 0 ? (
        <section className="dashboard-card p-5">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading project status chart...</span>
          </div>
        </section>
      ) : (
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
      )}

      {isAidaStatusLoading && aidaChartRows.length === 0 ? (
        <section className="dashboard-card p-5">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading AIDA status chart...</span>
          </div>
        </section>
      ) : (
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
      )}

      {isTestcaseDetailLoading && testcaseChartRows.length === 0 ? (
        <section className="dashboard-card p-5">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading testcase detail rows...</span>
          </div>
        </section>
      ) : (
        <CoverageAnalysisChartCard
          title="图表 3: 按测试用例和测试周分类的状态"
          description="横轴为测试周，纵轴为测试用例；气泡大小代表执行次数，颜色代表状态。点击气泡可快速缩小 Top AIDA 筛选范围。"
          rows={testcaseChartRows}
          statuses={testcaseStatuses}
          densityNote={
            chart3TotalPages > 1
              ? `图表 3 共 ${testcaseChartModel.orderedLabels.length} 个测试用例，当前按每页 ${CHART3_PAGE_SIZE} 个分页展示。`
              : undefined
          }
          emptyMessage="当前筛选条件下暂无测试用例气泡图数据。"
          variant="detail"
          yAxisOrder={visibleChart3Labels}
          actions={
            testcaseDetailRows.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  void downloadChart3Workbook(testcaseDetailRows);
                }}
                className="rounded-lg border border-slate-900 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-100"
              >
                导出Excel
              </button>
            ) : null
          }
          footer={
            chart3TotalPages > 1 ? (
              <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <p>
                  Page {chart3Page} of {chart3TotalPages}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setChart3Page((current) => Math.max(current - 1, 1))}
                    disabled={chart3Page <= 1}
                  >
                    Previous page
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setChart3Page((current) => Math.min(current + 1, chart3TotalPages))}
                    disabled={chart3Page >= chart3TotalPages}
                  >
                    Next page
                  </Button>
                </div>
              </div>
            ) : null
          }
          onSelectValue={(value) => {
            setSelectedFilters((current) => ({
              ...current,
              aidas: applyAidaPointSelection(current.aidas, value),
            }));
          }}
        />
      )}

    </div>
  );
};

export default CoverageAnalysis;
