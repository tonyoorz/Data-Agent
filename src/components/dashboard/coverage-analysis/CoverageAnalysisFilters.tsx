import MultiSelectFilterField from "@/components/dashboard/main-dashboard/MultiSelectFilterField";

import type {
  CoverageAnalysisFilterKey,
  CoverageAnalysisFilterOptions,
  CoverageAnalysisFilters,
} from "./coverageAnalysisTypes";

const coverageAnalysisFilterFields: Array<{
  key: CoverageAnalysisFilterKey;
  label: string;
}> = [
  { key: "years", label: "Year" },
  { key: "projects", label: "Project" },
  { key: "testWeeks", label: "Test Week" },
  { key: "pus", label: "PU" },
  { key: "aidas", label: "Top AIDA" },
  { key: "statuses", label: "Status" },
  { key: "featureRegions", label: "Feature Region" },
  { key: "fvps", label: "FVP" },
  { key: "fvs", label: "FV" },
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
          <p className="text-sm font-semibold text-foreground">Coverage Filters</p>
          <p className="text-sm text-muted-foreground">
            Narrow the TAP testing coverage view across week, domain, and execution status.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{activeFilterCount} active selections</span>
          {isRefreshing ? (
            <span className="rounded-full border border-border/80 bg-muted/40 px-2 py-1 font-medium text-foreground">
              Refreshing...
            </span>
          ) : null}
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg border border-border/80 px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-muted/40"
          >
            Clear filters
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {coverageAnalysisFilterFields.map(({ key, label }) => (
          <MultiSelectFilterField
            key={key}
            label={label}
            options={filterOptions[key]}
            selectedValues={selectedFilters[key]}
            onToggleValue={(value) => onToggleValue(key, value)}
          />
        ))}
      </div>
    </section>
  );
};

export default CoverageAnalysisFilters;