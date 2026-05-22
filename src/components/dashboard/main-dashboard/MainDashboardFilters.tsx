import {
  mainDashboardFilterFieldMappings,
  type MainDashboardFilters as MainDashboardFiltersType,
} from "./mainDashboardTypes";

import MultiSelectFilterField from "./MultiSelectFilterField";

type MainDashboardFiltersProps = {
  availableFilters: MainDashboardFiltersType;
  selectedFilters: MainDashboardFiltersType;
  onToggleValue: <K extends keyof MainDashboardFiltersType>(
    field: K,
    value: string,
  ) => void;
};

const MainDashboardFilters = ({
  availableFilters,
  selectedFilters,
  onToggleValue,
}: MainDashboardFiltersProps) => {
  return (
    <div className="grid gap-3 px-4 py-4 md:grid-cols-2 md:px-5 xl:grid-cols-4">
      {mainDashboardFilterFieldMappings.map(({ viewKey, label }) => (
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