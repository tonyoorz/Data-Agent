import {
  mainDashboardUiFilterFieldMappings,
  type MainDashboardMultiSelectFilterKey,
  type MainDashboardFilters as MainDashboardFiltersType,
} from "./mainDashboardTypes";

import CreationTimeRangeFilterField from "./CreationTimeRangeFilterField";
import MultiSelectFilterField from "./MultiSelectFilterField";

type MainDashboardFiltersProps = {
  availableFilters: MainDashboardFiltersType;
  selectedFilters: MainDashboardFiltersType;
  onToggleValue: (
    field: MainDashboardMultiSelectFilterKey,
    value: string,
  ) => void;
  onCreationTimeRangeApply: (startDate: string, endDate: string) => void;
};

const MainDashboardFilters = ({
  availableFilters,
  selectedFilters,
  onToggleValue,
  onCreationTimeRangeApply,
}: MainDashboardFiltersProps) => {
  return (
    <div className="grid gap-3 px-4 py-4 md:grid-cols-2 md:px-5 xl:grid-cols-6">
      <CreationTimeRangeFilterField
        startDate={selectedFilters.creationTimeStart}
        endDate={selectedFilters.creationTimeEnd}
        onApply={onCreationTimeRangeApply}
      />
      {mainDashboardUiFilterFieldMappings.map(({ viewKey, label }) => (
        <MultiSelectFilterField
          key={viewKey}
          label={label}
          options={availableFilters[viewKey]}
          selectedValues={selectedFilters[viewKey]}
          onToggleValue={(value) => onToggleValue(viewKey, value)}
        />
      ))}
    </div>
  );
};

export default MainDashboardFilters;