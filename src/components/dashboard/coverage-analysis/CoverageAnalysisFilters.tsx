import MultiSelectFilterField from "@/components/dashboard/main-dashboard/MultiSelectFilterField";

import type {
  CoverageAnalysisFilterKey,
  CoverageAnalysisFilterOptions,
  CoverageAnalysisFilters,
} from "./coverageAnalysisTypes";

const coverageAnalysisFilterFields: Array<{
  key: CoverageAnalysisFilterKey;
  label: string;
  triggerAriaLabel: string;
}> = [
  { key: "years", label: "年份", triggerAriaLabel: "Year filter" },
  { key: "projects", label: "项目", triggerAriaLabel: "Project filter" },
  { key: "testWeeks", label: "测试周", triggerAriaLabel: "Test Week filter" },
  { key: "pus", label: "PU", triggerAriaLabel: "PU filter" },
  { key: "aidas", label: "Top AIDA", triggerAriaLabel: "Top AIDA filter" },
  { key: "statuses", label: "状态", triggerAriaLabel: "Status filter" },
  { key: "featureRegions", label: "Feature Region", triggerAriaLabel: "Feature Region filter" },
  { key: "fvps", label: "FVP", triggerAriaLabel: "FVP filter" },
  { key: "fvs", label: "FV", triggerAriaLabel: "FV filter" },
];

type CoverageAnalysisFiltersProps = {
  filterOptions: CoverageAnalysisFilterOptions;
  selectedFilters: CoverageAnalysisFilters;
  onToggleValue: (field: CoverageAnalysisFilterKey, value: string) => void;
  onReset: () => void;
  isRefreshing?: boolean;
};

function countActiveFilters(filters: CoverageAnalysisFilters) {
  return Object.values(filters).reduce((total, values) => total + values.length, 0);
}

const CoverageAnalysisFilters = ({
  filterOptions,
  selectedFilters,
  onToggleValue,
  onReset,
  isRefreshing = false,
}: CoverageAnalysisFiltersProps) => {
  const activeFilterCount = countActiveFilters(selectedFilters);

  return (
    <section className="dashboard-card p-5">
      <div className="mb-4 flex flex-col gap-3 border-b border-border/70 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">筛选条件</p>
          <p className="text-sm text-muted-foreground">
            按年份、项目、测试周、AIDA 和执行状态缩小测试覆盖率视图范围。
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{activeFilterCount} 个已选条件</span>
          {isRefreshing ? (
            <span className="rounded-full border border-border/80 bg-muted/40 px-2 py-1 font-medium text-foreground">
              刷新中...
            </span>
          ) : null}
          <button
            type="button"
            onClick={onReset}
            aria-label="Reset coverage filters"
            className="rounded-lg border border-border/80 px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-muted/40"
          >
            清空筛选
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {coverageAnalysisFilterFields.map(({ key, label, triggerAriaLabel }) => (
          <MultiSelectFilterField
            key={key}
            label={label}
            options={filterOptions[key]}
            selectedValues={selectedFilters[key]}
            onToggleValue={(value) => onToggleValue(key, value)}
            triggerAriaLabel={triggerAriaLabel}
            anyLabel="全部"
            noValuesLabel="暂无可选值"
            availableValuesLabel="个可选值"
          />
        ))}
      </div>
    </section>
  );
};

export default CoverageAnalysisFilters;