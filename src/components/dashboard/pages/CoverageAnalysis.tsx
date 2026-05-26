import { useMemo, useState } from "react";

import { AlertTriangle, Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import CoverageAnalysisChartCard, {
  type CoverageAnalysisChartDatum,
} from "../coverage-analysis/CoverageAnalysisChartCard";
import CoverageAnalysisEmptyState from "../coverage-analysis/CoverageAnalysisEmptyState";
import CoverageAnalysisFilters from "../coverage-analysis/CoverageAnalysisFilters";
import {
  CoverageAnalysisApiError,
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
import { useCoverageAnalysisData } from "../coverage-analysis/useCoverageAnalysisData";

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

function buildProjectStatusChartRows(
  rows: CoverageAnalysisProjectStatusRow[],
): CoverageAnalysisChartDatum[] {
  const grouped = new Map<string, CoverageAnalysisChartDatum & { sortOrder: number }>();

  rows.forEach((row, index) => {
    const key = `${row.test_week}::${row.fv}`;
    const existing = grouped.get(key);

    if (existing) {
      existing[row.status] = Number(existing[row.status] ?? 0) + row.count;
      existing.total += row.count;
      return;
    }

    grouped.set(key, {
      label: `${row.test_week} · ${row.fv}`,
      selectionValue: row.fv,
      total: row.count,
      [row.status]: row.count,
      sortOrder: index,
    });
  });

  return Array.from(grouped.values())
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map(({ sortOrder: _sortOrder, ...datum }) => datum);
}

function buildAidaStatusChartRows(
  rows: CoverageAnalysisAidaStatusRow[],
): CoverageAnalysisChartDatum[] {
  const grouped = new Map<string, CoverageAnalysisChartDatum & { sortOrder: number }>();

  rows.forEach((row, index) => {
    const key = `${row.test_week}::${row.top_aida}`;
    const existing = grouped.get(key);

    if (existing) {
      existing[row.status] = Number(existing[row.status] ?? 0) + row.count;
      existing.total += row.count;
      return;
    }

    grouped.set(key, {
      label: `${row.test_week} · ${row.top_aida}`,
      selectionValue: row.top_aida,
      total: row.count,
      [row.status]: row.count,
      sortOrder: index,
    });
  });

  return Array.from(grouped.values())
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map(({ sortOrder: _sortOrder, ...datum }) => datum);
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
  const { data, error, isLoading, isFetching } = useCoverageAnalysisData(selectedFilters);

  const projectChartRows = useMemo(
    () => buildProjectStatusChartRows(data?.projectStatusRows ?? []),
    [data?.projectStatusRows],
  );
  const aidaChartRows = useMemo(
    () => buildAidaStatusChartRows(data?.aidaStatusRows ?? []),
    [data?.aidaStatusRows],
  );
  const projectStatuses = useMemo(
    () => collectStatuses(data?.filterOptions.statuses ?? [], data?.projectStatusRows ?? []),
    [data?.filterOptions.statuses, data?.projectStatusRows],
  );
  const aidaStatuses = useMemo(
    () => collectStatuses(data?.filterOptions.statuses ?? [], data?.aidaStatusRows ?? []),
    [data?.filterOptions.statuses, data?.aidaStatusRows],
  );

  if (isLoading && !data) {
    return (
      <section className="workbench-panel p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading testing coverage analysis...</span>
        </div>
      </section>
    );
  }

  if (error && !data && isNotReadyError(error)) {
    return (
      <CoverageAnalysisEmptyState
        title="Testing coverage analysis is not ready yet."
        description="The analytics service is missing required TAP coverage fields for this page."
        missingFields={error.missingFields}
      />
    );
  }

  if (error && !data) {
    return (
      <section className="workbench-panel p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to load testing coverage analysis.</AlertTitle>
          <AlertDescription>
            {error.message || "Check whether the analytics service is available."}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const filterOptions = data?.filterOptions ?? createEmptyFilters();
  const testcaseDetailRows = data?.testcaseDetailRows ?? [];
  const hasRenderableData =
    projectChartRows.length > 0 || aidaChartRows.length > 0 || testcaseDetailRows.length > 0;

  return (
    <div className="space-y-5">
      {error && data ? (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to refresh testing coverage analysis.</AlertTitle>
          <AlertDescription>
            Showing the latest cached snapshot. {error.message}
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
        isRefreshing={isFetching && !isLoading}
      />

      {!hasRenderableData ? (
        <CoverageAnalysisEmptyState
          title="No coverage rows match the current filters."
          description="Adjust the current selections to bring project status, AIDA status, and testcase detail rows back into scope."
        />
      ) : null}

      <CoverageAnalysisChartCard
        title="按周和功能分类的测试状态"
        description="Grouped execution counts by test week and FV. Click a row segment to narrow the FV selection."
        rows={projectChartRows}
        statuses={projectStatuses}
        emptyMessage="No project-status rows match the current filters."
        onSelectValue={(value) => {
          setSelectedFilters((current) => ({
            ...current,
            fvs: applyFvPointSelection(current.fvs, value),
          }));
        }}
      />

      <CoverageAnalysisChartCard
        title="按 Top AIDA 和测试周分类的状态"
        description="Grouped execution counts by Top AIDA and test week. Click a row segment to narrow the Top AIDA selection."
        rows={aidaChartRows}
        statuses={aidaStatuses}
        emptyMessage="No AIDA-status rows match the current filters."
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
            <h2 className="text-sm font-semibold text-foreground">按测试用例和测试周分类的状态</h2>
            <p className="text-sm text-muted-foreground">
              Detailed testcase execution rows within the current TAP coverage scope.
            </p>
          </div>
        </div>

        {testcaseDetailRows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            No testcase-detail rows match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
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
