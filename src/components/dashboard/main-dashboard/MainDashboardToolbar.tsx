import { Filter, RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type MainDashboardToolbarProps = {
  searchText: string;
  filtersOpen: boolean;
  onSearchTextChange: (value: string) => void;
  onToggleFilters: () => void;
  onReset: () => void;
};

const MainDashboardToolbar = ({
  searchText,
  filtersOpen,
  onSearchTextChange,
  onToggleFilters,
  onReset,
}: MainDashboardToolbarProps) => {
  return (
    <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 md:px-5 lg:flex-row lg:items-center">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchText}
          onChange={(event) => onSearchTextChange(event.target.value)}
          placeholder="Search ticket ID or title"
          className="h-10 rounded-xl border-border/80 bg-background pl-10 shadow-sm"
        />
      </div>
      <div className="flex items-center gap-2 self-end lg:self-auto">
        <Button
          type="button"
          variant={filtersOpen ? "default" : "outline"}
          size="sm"
          onClick={onToggleFilters}
          aria-pressed={filtersOpen}
          className="h-10 rounded-xl px-4"
        >
          <Filter className="h-4 w-4" />
          Filters
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onReset}
          className="h-10 rounded-xl px-4"
        >
          <RotateCcw className="h-4 w-4" />
          Reset
        </Button>
      </div>
    </div>
  );
};

export default MainDashboardToolbar;