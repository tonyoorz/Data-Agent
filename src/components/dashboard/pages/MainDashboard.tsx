import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import MainDashboardFilters from "@/components/dashboard/main-dashboard/MainDashboardFilters";
import MainDashboardKpis from "@/components/dashboard/main-dashboard/MainDashboardKpis";
import MainDashboardToolbar from "@/components/dashboard/main-dashboard/MainDashboardToolbar";
import OutcomePanel from "@/components/dashboard/main-dashboard/OutcomePanel";
import TeamExpansionPanel from "@/components/dashboard/main-dashboard/TeamExpansionPanel";
import TicketDetailTable from "@/components/dashboard/main-dashboard/TicketDetailTable";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  applyMainDashboardFilters,
  selectTicketRowsForDrilldown,
} from "@/components/dashboard/main-dashboard/mainDashboardFiltering";
import type { MainDashboardDrilldownSelection } from "@/components/dashboard/main-dashboard/mainDashboardFiltering";
import type {
  MainDashboardFilters as MainDashboardFiltersType,
  MainDashboardOutcomeKey,
  MainDashboardViewModel,
} from "@/components/dashboard/main-dashboard/mainDashboardTypes";
import {
  mainDashboardFilterFieldMappings,
} from "@/components/dashboard/main-dashboard/mainDashboardTypes";
import { useMainDashboardData } from "@/components/dashboard/main-dashboard/useMainDashboardData";

function createEmptyFilters(): MainDashboardFiltersType {
  return Object.fromEntries(
    mainDashboardFilterFieldMappings.map(({ viewKey }) => [viewKey, []]),
  ) as MainDashboardFiltersType;
}

const emptyViewModel: MainDashboardViewModel = {
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
  ticketRows: [],
};

function createDefaultFilters(
  viewModel: MainDashboardViewModel | null | undefined,
): MainDashboardFiltersType {
  const emptyFilters = createEmptyFilters();

  if (!viewModel) {
    return emptyFilters;
  }

  return {
    ...emptyFilters,
    years: viewModel.generatedFrom.years,
  };
}

function getOutcomeLabel(outcomeKey?: MainDashboardOutcomeKey | null) {
  if (outcomeKey === "resolvedForward") {
    return "Resolved Forward (08 -> 06)";
  }

  if (outcomeKey === "rejectedDirectly") {
    return "Rejected Directly (01 -> 09)";
  }

  return null;
}

const MainDashboard = () => {
  const { data, error, isLoading } = useMainDashboardData();
  const viewModel = data ?? emptyViewModel;
  const [searchText, setSearchText] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [selectedFilters, setSelectedFilters] =
    useState<MainDashboardFiltersType>(() => createDefaultFilters(data));
  const [selection, setSelection] = useState<MainDashboardDrilldownSelection>({});

  useEffect(() => {
    setSearchText("");
    setSelectedFilters(createDefaultFilters(data));
    setSelection({});
  }, [data]);

  if (isLoading && !data) {
    return (
      <section className="workbench-panel p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading Full Picture data...</span>
        </div>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="workbench-panel p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to load Full Picture data.</AlertTitle>
          <AlertDescription>
            {error.message || "Check whether the Full Picture service is available."}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const filtered = applyMainDashboardFilters(viewModel, {
    searchText,
    filters: selectedFilters,
  });
  const drilldownRows = selectTicketRowsForDrilldown(filtered.ticketRows, selection);
  const selectedOutcomeLabel = getOutcomeLabel(selection.outcomeKey);

  const handleToggleValue = <K extends keyof MainDashboardFiltersType>(
    field: K,
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

  const handleReset = () => {
    setSearchText("");
    setSelectedFilters(createDefaultFilters(data));
    setSelection({});
  };

  const handleToggleOutcome = (outcomeKey: MainDashboardOutcomeKey) => {
    setSelection((current) => {
      if (current.outcomeKey === outcomeKey) {
        return {};
      }

      return {
        outcomeKey,
        team: null,
      };
    });
  };

  const handleSelectTeamOutcome = (
    team: string,
    outcomeKey: MainDashboardOutcomeKey,
  ) => {
    setSelection((current) => {
      if (current.team === team && current.outcomeKey === outcomeKey) {
        return {};
      }

      return {
        outcomeKey,
        team,
      };
    });
  };

  return (
    <section className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to refresh Full Picture data.</AlertTitle>
          <AlertDescription>
            Showing the latest cached dashboard snapshot.
            {error.message ? ` ${error.message}` : ""}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="workbench-panel overflow-hidden">
        <MainDashboardToolbar
          searchText={searchText}
          filtersOpen={filtersOpen}
          onSearchTextChange={setSearchText}
          onToggleFilters={() => setFiltersOpen((current) => !current)}
          onReset={handleReset}
        />
        {filtersOpen ? (
          <MainDashboardFilters
            availableFilters={viewModel.filters}
            selectedFilters={selectedFilters}
            onToggleValue={handleToggleValue}
          />
        ) : null}
      </div>
      <MainDashboardKpis
        overview={filtered.overview}
        teamCount={filtered.teamOutcomeRows.length}
      />
      <div data-testid="outcome-analysis-panels" className="space-y-4">
        <OutcomePanel
          outcomeSummary={filtered.outcomeSummary}
          selectedOutcomeKey={selection.outcomeKey}
          onToggleOutcome={handleToggleOutcome}
        />
        <TeamExpansionPanel
          teamOutcomeRows={filtered.teamOutcomeRows}
          selectedOutcomeKey={selection.outcomeKey}
          selectedTeam={selection.team}
          onSelectTeamOutcome={handleSelectTeamOutcome}
        />
      </div>
      <TicketDetailTable
        rows={drilldownRows}
        selection={selection}
        selectedOutcomeLabel={selectedOutcomeLabel}
        onClearSelection={() => setSelection({})}
      />
    </section>
  );
};

export default MainDashboard;