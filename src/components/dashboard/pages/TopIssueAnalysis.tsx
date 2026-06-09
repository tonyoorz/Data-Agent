import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import MainDashboardFilters from "@/components/dashboard/main-dashboard/MainDashboardFilters";
import DefectTrendChart from "@/components/dashboard/DefectTrendChart";
import StatusDistributionChart from "@/components/dashboard/StatusDistributionChart";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  getCoveredYearsForCreationTimeRange,
  parseTicketDateValue,
} from "@/components/dashboard/main-dashboard/mainDashboardDateUtils";
import type {
  MainDashboardFilters as MainDashboardFiltersType,
  MainDashboardMultiSelectFilterKey,
  MainDashboardSummaryViewModel,
} from "@/components/dashboard/main-dashboard/mainDashboardTypes";
import { useMainDashboardSummary } from "@/components/dashboard/main-dashboard/useMainDashboardSummary";
import TopIssueTable from "@/components/dashboard/TopIssueTable";
import { useTopIssueAnalysis } from "@/components/dashboard/top-issue/useTopIssueAnalysis";

function createEmptyFilters(): MainDashboardFiltersType {
  return {
    years: [],
    months: [],
    creationTimeStart: "",
    creationTimeEnd: "",
    requirements: [],
    chinaScopes: [],
    projects: [],
    assignedEcus: [],
    problemFinderTeams: [],
    aidas: [],
    phases: [],
    solutionClusters: [],
    pus: [],
    markets: [],
    leadModels: [],
    groups: [],
  };
}

function getDefaultYears(viewModel: MainDashboardSummaryViewModel) {
  if (viewModel.generatedFrom.years.length > 0) {
    return viewModel.generatedFrom.years;
  }

  return viewModel.filters.years.slice(0, 1);
}

function formatUtcDate(year: number, monthIndex: number, day: number) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function getDaysInUtcMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function shiftUtcDateByMonths(year: number, monthIndex: number, day: number, monthDelta: number) {
  const absoluteMonthIndex = year * 12 + monthIndex + monthDelta;
  const nextYear = Math.floor(absoluteMonthIndex / 12);
  const nextMonthIndex = absoluteMonthIndex % 12;
  const nextDay = Math.min(day, getDaysInUtcMonth(nextYear, nextMonthIndex));

  return {
    year: nextYear,
    monthIndex: nextMonthIndex,
    day: nextDay,
  };
}

function getRecentMonthCreationTimeRange(viewModel: MainDashboardSummaryViewModel) {
  const anchoredDate = parseTicketDateValue(viewModel.refreshMetadata.lastSuccessAt)?.label;
  let endDate = anchoredDate ?? "";

  if (!endDate) {
    const latestMonth = viewModel.filters.months[viewModel.filters.months.length - 1] ?? "";
    const [latestYear, latestMonthNumber] = latestMonth.split("-").map(Number);

    if (latestYear && latestMonthNumber) {
      const latestMonthIndex = latestMonthNumber - 1;
      endDate = formatUtcDate(
        latestYear,
        latestMonthIndex,
        getDaysInUtcMonth(latestYear, latestMonthIndex),
      );
    }
  }

  if (!endDate) {
    return {
      startDate: "",
      endDate: "",
    };
  }

  const [endYear, endMonthNumber, endDay] = endDate.split("-").map(Number);
  const shifted = shiftUtcDateByMonths(endYear, endMonthNumber - 1, endDay, -1);
  const startDateValue = new Date(Date.UTC(shifted.year, shifted.monthIndex, shifted.day));
  startDateValue.setUTCDate(startDateValue.getUTCDate() + 1);

  return {
    startDate: startDateValue.toISOString().slice(0, 10),
    endDate,
  };
}

function createDefaultFilters(
  viewModel: MainDashboardSummaryViewModel | null | undefined,
): MainDashboardFiltersType {
  const emptyFilters = createEmptyFilters();

  if (!viewModel) {
    return emptyFilters;
  }

  const defaultYears = getDefaultYears(viewModel);
  const creationTimeRange = getRecentMonthCreationTimeRange(viewModel);
  const coveredYears = getCoveredYearsForCreationTimeRange(
    creationTimeRange.startDate,
    creationTimeRange.endDate,
  );

  return {
    ...emptyFilters,
    years: coveredYears.length > 0 ? coveredYears : defaultYears,
    creationTimeStart: creationTimeRange.startDate,
    creationTimeEnd: creationTimeRange.endDate,
  };
}

const emptySummaryViewModel: MainDashboardSummaryViewModel = {
  snapshotVersion: "",
  refreshMetadata: {
    activeSnapshotVersion: "",
    refreshStatus: "missing",
  },
  generatedFrom: {
    defectDbPath: "",
    historyDbPath: "",
    ...createEmptyFilters(),
  },
  filters: createEmptyFilters(),
  overview: {
    ticketCount: 0,
    resolvedForwardCount: 0,
    rejectedDirectlyCount: 0,
    resolvedForwardPercent: 0,
    rejectedDirectlyPercent: 0,
  },
  outcomeSummary: [],
  teamOutcomeRows: [],
};

type TopIssueAnalysisProps = {
  onSyncDateChange?: (value: string | null) => void;
};

const TopIssueAnalysis = ({ onSyncDateChange }: TopIssueAnalysisProps) => {
  const [selectedFilters, setSelectedFilters] =
    useState<MainDashboardFiltersType>(createEmptyFilters);
  const [initializedSnapshotVersion, setInitializedSnapshotVersion] = useState("");

  const summaryQuery = useMainDashboardSummary(selectedFilters);
  const summaryData = summaryQuery.data ?? emptySummaryViewModel;
  const summarySnapshotVersion = summaryQuery.data?.snapshotVersion ?? "";
  const canLoadAnalysis = Boolean(summaryQuery.data)
    && initializedSnapshotVersion === (summarySnapshotVersion || "missing-snapshot")
    && !summaryQuery.isPlaceholderData;
  const analysisQuery = useTopIssueAnalysis(selectedFilters, { enabled: canLoadAnalysis });

  useEffect(() => {
    if (!summaryQuery.data) {
      return;
    }

    const snapshotVersion = summaryQuery.data.snapshotVersion || "missing-snapshot";
    if (initializedSnapshotVersion === snapshotVersion) {
      return;
    }

    setSelectedFilters(createDefaultFilters(summaryQuery.data));
    setInitializedSnapshotVersion(snapshotVersion);
  }, [initializedSnapshotVersion, summaryQuery.data]);

  useEffect(() => {
    onSyncDateChange?.(summaryData.refreshMetadata.lastSuccessAt ?? null);
  }, [onSyncDateChange, summaryData.refreshMetadata.lastSuccessAt]);

  const handleToggleValue = (
    field: MainDashboardMultiSelectFilterKey,
    value: string,
  ) => {
    setSelectedFilters((current) => {
      const values = current[field];
      const nextValues = values.includes(value)
        ? values.filter((candidate) => candidate !== value)
        : [...values, value];

      return {
        ...current,
        [field]: nextValues,
      };
    });
  };

  const handleCreationTimeRangeApply = (startDate: string, endDate: string) => {
    setSelectedFilters((current) => ({
      ...current,
      years: getCoveredYearsForCreationTimeRange(startDate, endDate),
      creationTimeStart: startDate,
      creationTimeEnd: endDate,
    }));
  };

  const handleReset = () => {
    setSelectedFilters(createDefaultFilters(summaryQuery.data));
  };

  if (summaryQuery.isLoading && !summaryQuery.data) {
    return (
      <section className="workbench-panel p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading Top Issue data...</span>
        </div>
      </section>
    );
  }

  if (summaryQuery.error && !summaryQuery.data) {
    return (
      <section className="workbench-panel p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to load Top Issue filters.</AlertTitle>
          <AlertDescription>
            {summaryQuery.error.message || "Check whether the Full Picture service is available."}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {analysisQuery.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to load Top Issue analysis.</AlertTitle>
          <AlertDescription>
            {analysisQuery.error.message || "Check whether the analytics service is available."}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="workbench-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5 md:px-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">筛选条件</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">复用 Main Dashboard 的真实缺陷筛选口径</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleReset}>
            重置筛选
          </Button>
        </div>
        <MainDashboardFilters
          availableFilters={summaryData.filters}
          selectedFilters={selectedFilters}
          onToggleValue={handleToggleValue}
          onCreationTimeRangeApply={handleCreationTimeRangeApply}
        />
      </div>

      {analysisQuery.isFetching ? (
        <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Refreshing Top Issue analysis...</span>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <DefectTrendChart data={analysisQuery.data?.defectTrend ?? []} />
        </div>
        <div className="lg:col-span-2">
          <StatusDistributionChart data={analysisQuery.data?.statusDistribution ?? []} />
        </div>
      </div>

      <TopIssueTable
        issues={analysisQuery.data?.topIssueRows ?? []}
        isLoading={analysisQuery.isLoading && !analysisQuery.data}
      />
    </section>
  );
};

export default TopIssueAnalysis;